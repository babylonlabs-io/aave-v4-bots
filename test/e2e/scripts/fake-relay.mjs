#!/usr/bin/env node
// A stand-in for Flashbots Protect, so the private-submission path can be driven against a real
// chain and a real bot.
//
// Unit tests can prove the adapter parses a scripted response; they cannot prove the thing that
// actually matters, which is a *lifecycle*: a transaction the relay accepts, never forwards, and
// eventually forgets — and a bot that must neither reuse its nonce too early nor stall behind it
// forever. That needs a running bot, a real nonce sequence, and a chain that keeps producing
// blocks. Hence a process rather than a mock.
//
// It speaks the two halves of the protocol the bot uses, and nothing else:
//
//   POST /                    JSON-RPC. `eth_sendRawTransaction` is intercepted; everything else is
//                             proxied to anvil untouched, so the bot can use one URL for both.
//   GET  /tx/{hash}           Protect's status shape, including `maxBlockNumber` and `simError`.
//   POST /__withhold          test control: accept the next N transactions but do NOT forward them.
//   GET  /__seen              test control: what it has been asked to send, and what it withheld.
//
// Withholding is the whole point. It reproduces the one outcome a public mempool cannot: a
// transaction that is genuinely accepted, genuinely invisible to our node, and genuinely never
// mined — which is what Protect does to any transaction it fails to land inside its retry window.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

// A transaction hash is keccak256 of the signed bytes. `cast` supplies it rather than a JS library:
// under pnpm's strict layout nothing is resolvable from this directory, and foundry is already a
// hard dependency of every e2e run — so this keeps the harness dependency-free.
const txHash = (raw) => execFileSync("cast", ["keccak", raw], { encoding: "utf8" }).trim();

const PORT = Number(process.env.FAKE_RELAY_PORT ?? 8555);
const UPSTREAM = process.env.FAKE_RELAY_UPSTREAM ?? "http://127.0.0.1:8545";
/** Blocks a withheld transaction is claimed to be retried for, mirroring Protect's ~25. */
const HORIZON_BLOCKS = Number(process.env.FAKE_RELAY_HORIZON_BLOCKS ?? 25);

/** hash -> { status, maxBlockNumber, withheld, simError } */
const seen = new Map();
let withholdRemaining = 0;

const rpc = async (method, params) => {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const blockNumber = async () => Number((await rpc("eth_blockNumber", [])).result ?? "0x0");

/**
 * Accept a raw transaction, and decide whether the chain ever hears about it.
 *
 * A forwarded transaction gets its hash from anvil. A withheld one cannot — asking would broadcast
 * it, which is the whole thing being prevented — so its hash is computed from the signed bytes
 * directly. The two must agree exactly with what the bot derived locally, because that is the hash
 * it persisted before broadcasting and the one it will later ask about by name.
 */
async function sendRawTransaction(raw) {
  const withheld = withholdRemaining > 0;
  const maxBlockNumber = (await blockNumber()) + HORIZON_BLOCKS;

  if (!withheld) {
    const out = await rpc("eth_sendRawTransaction", [raw]);
    if (out.result) {
      seen.set(out.result, { status: "PENDING", maxBlockNumber, withheld: false });
    }
    return out;
  }

  withholdRemaining -= 1;
  // Hash the signed bytes ourselves: forwarding to derive it would defeat the withholding.
  const hash = txHash(raw);
  seen.set(hash, {
    status: "PENDING",
    maxBlockNumber,
    withheld: true,
    simError: process.env.FAKE_RELAY_SIM_ERROR || undefined,
  });
  return { jsonrpc: "2.0", id: 1, result: hash };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname.startsWith("/tx/")) {
      const hash = url.pathname.slice("/tx/".length);
      const rec = seen.get(hash);
      if (!rec) {
        // Exactly Protect's answer for a hash it does not know — the ambiguous case the bot must
        // treat as "still in flight" rather than "gone".
        return json(res, 200, {
          status: "UNKNOWN",
          hash: "",
          maxBlockNumber: 0,
          isRevert: false,
          seenInMempool: false,
        });
      }
      // A forwarded transaction becomes ordinary chain state once mined; report that faithfully so
      // the bot's own node and the relay do not disagree.
      let status = rec.status;
      if (!rec.withheld) {
        const receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt.result) status = receipt.result.status === "0x1" ? "INCLUDED" : "FAILED";
      } else if ((await blockNumber()) > rec.maxBlockNumber) {
        status = "FAILED"; // dropped: past its retry horizon, never offered to a builder again
      }
      return json(res, 200, {
        status,
        hash,
        maxBlockNumber: rec.maxBlockNumber,
        isRevert: false,
        seenInMempool: false,
        ...(rec.simError ? { simError: rec.simError } : {}),
      });
    }

    if (req.method === "POST" && url.pathname === "/__withhold") {
      withholdRemaining = Number(new URL(url).searchParams.get("count") ?? 1);
      return json(res, 200, { withholdRemaining });
    }

    if (req.method === "GET" && url.pathname === "/__seen") {
      return json(res, 200, {
        total: seen.size,
        withheld: [...seen.entries()].filter(([, v]) => v.withheld).map(([h]) => h),
      });
    }

    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.method === "eth_sendRawTransaction") {
        const out = await sendRawTransaction(body.params[0]);
        return json(res, 200, { ...out, id: body.id });
      }
      // Everything else is a plain read — proxy it so one URL serves the whole client.
      const out = await rpc(body.method, body.params ?? []);
      return json(res, 200, { ...out, id: body.id });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`fake-relay listening on :${PORT} -> ${UPSTREAM}\n`);
});
