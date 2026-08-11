import { describe, expect, it } from "vitest";
import { createFlashbotsProtectSubmitter } from "./flashbots";
import { SubmitRejectedError } from "./index";

// The relay is scripted, never reached. The response bodies here are the shapes the live API
// actually returns — the status body is copied from a real probe against mainnet, including
// `simError`, which is the field that proves acceptance does not imply viability.

const TX = "0xdeadbeef" as const;
const HASH = "0xa3c7d0775838d2397e588c1bf121ba20345f87347cf115c72d77021edc24b911";

const reply = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const badJson = (status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  }) as unknown as Response;

const submitter = (respond: () => Response | Promise<Response>) =>
  createFlashbotsProtectSubmitter({
    rpcUrl: "https://rpc.example/fast",
    statusUrl: "https://status.example",
    fetch: async () => respond(),
  });

describe("createFlashbotsProtectSubmitter — send", () => {
  it("returns the relay's hash on acceptance", async () => {
    const s = submitter(() => reply({ jsonrpc: "2.0", id: 1, result: HASH }));
    await expect(s.send(TX)).resolves.toBe(HASH);
  });

  it("sends the raw transaction to the configured RPC as eth_sendRawTransaction", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const s = createFlashbotsProtectSubmitter({
      rpcUrl: "https://rpc.example/fast",
      statusUrl: "https://status.example",
      fetch: async (url, init) => {
        seen.push({ url, body: String(init?.body) });
        return reply({ result: HASH });
      },
    });
    await s.send(TX);
    expect(seen[0].url).toBe("https://rpc.example/fast");
    expect(JSON.parse(seen[0].body)).toMatchObject({
      method: "eth_sendRawTransaction",
      params: [TX],
    });
  });

  // The whole point of the typed error: the send path may free the nonce and skip the breaker.
  it("declares a structured rejection clean, so the caller can abandon without a breaker hit", async () => {
    const s = submitter(() => reply({ error: { code: -32000, message: "invalid transaction" } }));
    await expect(s.send(TX)).rejects.toBeInstanceOf(SubmitRejectedError);
  });

  // …but not these. Both say a transaction at this nonce exists somewhere, so calling them clean
  // would free a nonce that is spoken for — the same reason the public path excludes `nonce too low`.
  it.each(["already known", "nonce too low", "replacement transaction underpriced"])(
    "keeps %s ambiguous — a nonce is spoken for",
    async (message) => {
      const s = submitter(() => reply({ error: { code: -32000, message } }));
      const error = await s.send(TX).catch((e) => e);
      expect(error).not.toBeInstanceOf(SubmitRejectedError);
      expect(error.message).toMatch(message);
    }
  );

  // Everything below is the conservative default: we cannot prove nothing was broadcast, so the
  // nonce stays reserved. A 502 can sit in front of a relay that accepted the transaction.
  it.each([429, 500, 502, 503])("keeps HTTP %i ambiguous", async (status) => {
    const s = submitter(() => reply({}, status));
    await expect(s.send(TX)).rejects.not.toBeInstanceOf(SubmitRejectedError);
  });

  it("keeps a malformed body ambiguous", async () => {
    const s = submitter(() => badJson());
    await expect(s.send(TX)).rejects.toThrow(/malformed/);
  });

  it("keeps a transport failure ambiguous", async () => {
    const s = createFlashbotsProtectSubmitter({
      rpcUrl: "https://rpc.example/fast",
      statusUrl: "https://status.example",
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(s.send(TX)).rejects.not.toBeInstanceOf(SubmitRejectedError);
  });

  it("keeps a response with neither hash nor error ambiguous", async () => {
    const s = submitter(() => reply({ jsonrpc: "2.0", id: 1 }));
    await expect(s.send(TX)).rejects.not.toBeInstanceOf(SubmitRejectedError);
  });
});

describe("createFlashbotsProtectSubmitter — status", () => {
  // Verbatim from a live mainnet probe. `simError` alongside `status: PENDING` is the case that
  // matters: the relay accepted and hashed a transaction it had already simulated as unviable.
  const LIVE = {
    status: "PENDING",
    hash: HASH,
    maxBlockNumber: 25_725_873,
    fastMode: true,
    seenInMempool: false,
    simError: "InsufficientFunds",
    isRevert: false,
  };

  it("reads the relay's horizon and simulation verdict", async () => {
    const s = submitter(() => reply(LIVE));
    await expect(s.status(HASH)).resolves.toMatchObject({
      status: "PENDING",
      maxBlockNumber: 25_725_873,
      simError: "InsufficientFunds",
      isRevert: false,
      seenInMempool: false,
    });
  });

  it("queries {statusUrl}/tx/{hash}", async () => {
    const seen: string[] = [];
    const s = createFlashbotsProtectSubmitter({
      rpcUrl: "https://rpc.example/fast",
      statusUrl: "https://status.example",
      fetch: async (url) => {
        seen.push(url);
        return reply(LIVE);
      },
    });
    await s.status(HASH);
    expect(seen[0]).toBe(`https://status.example/tx/${HASH}`);
  });

  // A status probe that throws must reach the caller: §4.6 decides what "unknown" means, and it is
  // the liveness reader's job to fail closed, not this adapter's to invent an answer.
  it("propagates a failed probe rather than reporting a status", async () => {
    const s = submitter(() => reply({}, 503));
    await expect(s.status(HASH)).rejects.toThrow(/HTTP 503/);
  });
});

// The counter an operator watches to tell "the relay is refusing us" from "the relay accepts and
// nothing lands" — two states that look identical from outside and need opposite responses.
describe("createFlashbotsProtectSubmitter — reports how each broadcast was answered", () => {
  const withReporter = (respond: () => Response) => {
    const seen: string[] = [];
    const s = createFlashbotsProtectSubmitter({
      rpcUrl: "https://rpc.example/fast",
      statusUrl: "https://status.example",
      fetch: async () => respond(),
      onResult: (r) => seen.push(r),
    });
    return { s, seen };
  };

  it("reports an accepted broadcast exactly once", async () => {
    const { s, seen } = withReporter(() => reply({ result: HASH }));
    await s.send(TX);
    expect(seen).toEqual(["accepted"]);
  });

  it("reports a clean rejection as rejected", async () => {
    const { s, seen } = withReporter(() => reply({ error: { message: "invalid transaction" } }));
    await s.send(TX).catch(() => {});
    expect(seen).toEqual(["rejected"]);
  });

  it.each([
    ["a 5xx", () => reply({}, 502)],
    ["a nonce-too-low rejection", () => reply({ error: { message: "nonce too low" } })],
    ["a response with neither hash nor error", () => reply({ jsonrpc: "2.0", id: 1 })],
  ])("reports %s as ambiguous", async (_label, respond) => {
    const { s, seen } = withReporter(respond as () => Response);
    await s.send(TX).catch(() => {});
    expect(seen).toEqual(["ambiguous"]);
  });
});
