import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type SubmitterEnv,
  buildExecutionConfig,
  buildSubmitterConfig,
  runtimeEnvFields,
} from "./runtime";

// Guards on `SUBMITTER`. Every case here is one where a bot that *booted* would do something the
// operator did not ask for — which is the whole point of validating at config time rather than
// discovering it from a mempool.

const env = (overrides: Partial<SubmitterEnv> = {}): SubmitterEnv => ({
  SUBMITTER: "public",
  FLASHBOTS_STATUS_URL: "https://protect.flashbots.net",
  PRIVATE_RELAY_HORIZON_BLOCKS: "25",
  PRIVATE_RECLAIM_MARGIN_BLOCKS: "3",
  PRIVATE_SUBMIT_TIMEOUT_MS: "8000",
  PRIVATE_STATUS_TIMEOUT_MS: "2000",
  ...overrides,
});

const privateEnv = (overrides: Partial<SubmitterEnv> = {}): SubmitterEnv =>
  env({
    SUBMITTER: "flashbots-protect",
    FLASHBOTS_PROTECT_URL: "https://rpc.flashbots.net/fast",
    PRIVATE_MIN_PRIORITY_FEE_WEI: "2000000000",
    DATABASE_URL: "postgres://localhost/bot",
    ...overrides,
  });

describe("buildSubmitterConfig", () => {
  it("defaults to the public mempool — an operator who configures nothing is unaffected", () => {
    expect(buildSubmitterConfig(env())).toEqual({ mode: "public" });
  });

  // The dangerous direction. The bot runs, broadcasts every liquidation publicly, and the operator
  // believes the relay config they wrote is in effect. Nothing downstream would ever say otherwise.
  it.each(["FLASHBOTS_PROTECT_URL", "PRIVATE_MIN_PRIORITY_FEE_WEI"] as const)(
    "refuses %s without the mode, rather than silently broadcasting in public",
    (key) => {
      expect(() => buildSubmitterConfig(env({ [key]: "1" } as Partial<SubmitterEnv>))).toThrow(
        /would go to the PUBLIC mempool/
      );
    }
  );

  it("names every relay variable that is missing, not just the first", () => {
    expect(() =>
      buildSubmitterConfig(
        privateEnv({ FLASHBOTS_PROTECT_URL: undefined, PRIVATE_MIN_PRIORITY_FEE_WEI: undefined })
      )
    ).toThrow(/requires FLASHBOTS_PROTECT_URL, PRIVATE_MIN_PRIORITY_FEE_WEI/);
  });

  // §4.2: a private tx is invisible to our own node, so the persisted intents are the only thing
  // left holding the nonce. Without a store this is not a degraded mode, it is nonce reuse.
  it("refuses private submission without a store to fence the nonce", () => {
    expect(() => buildSubmitterConfig(privateEnv({ DATABASE_URL: undefined }))).toThrow(
      /requires DATABASE_URL/
    );
  });

  // §4.3: the failure this prevents is silent — protection that never lands a transaction.
  it("refuses private submission without a priority-fee floor", () => {
    expect(() =>
      buildSubmitterConfig(privateEnv({ PRIVATE_MIN_PRIORITY_FEE_WEI: undefined }))
    ).toThrow(/requires PRIVATE_MIN_PRIORITY_FEE_WEI/);
  });

  it("carries everything the private mode needs, so the composition root re-checks nothing", () => {
    expect(buildSubmitterConfig(privateEnv())).toEqual({
      mode: "flashbots-protect",
      rpcUrl: "https://rpc.flashbots.net/fast",
      statusUrl: "https://protect.flashbots.net",
      minPriorityFeeWei: 2_000_000_000n,
      relayHorizonBlocks: 25,
      reclaimMarginBlocks: 3,
      submitTimeoutMs: 8_000,
      statusTimeoutMs: 2_000,
    });
  });

  it("takes the operator's deadlines when they set them", () => {
    expect(
      buildSubmitterConfig(
        privateEnv({ PRIVATE_SUBMIT_TIMEOUT_MS: "4000", PRIVATE_STATUS_TIMEOUT_MS: "500" })
      )
    ).toMatchObject({ submitTimeoutMs: 4_000, statusTimeoutMs: 500 });
  });

  // The deadlines carry defaults, so they are always present in the env — unlike the URL and the
  // fee floor, whose presence is what proves the operator meant to submit privately. Listing them
  // as relay-only would make every public deployment fail to boot.
  it("does not read its own defaulted deadlines as a misconfigured public setup", () => {
    expect(buildSubmitterConfig(env())).toEqual({ mode: "public" });
    expect(buildSubmitterConfig(env({ PRIVATE_SUBMIT_TIMEOUT_MS: "4000" }))).toEqual({
      mode: "public",
    });
  });

  // Wei exceeds Number.MAX_SAFE_INTEGER for large values; the fee must survive as a bigint rather
  // than round through a float on its way to the transaction.
  it("keeps the fee floor exact", () => {
    const settings = buildSubmitterConfig(
      privateEnv({ PRIVATE_MIN_PRIORITY_FEE_WEI: "9007199254740993" })
    );
    expect(settings).toMatchObject({ minPriorityFeeWei: 9_007_199_254_740_993n });
  });
});

// Submission only means something when the BOT broadcasts. MANUAL is keyless — an operator signs and
// sends with their own wallet — so a relay configured there protects nothing, and the operator would
// have no way to notice: the bot boots, builds a relay submitter, and never sends a byte through it.
// Nesting `submitter` on the AUTO arm makes the pairing unrepresentable; this proves the env layer
// refuses it too, since env is where an operator actually makes the mistake.
describe("submission is an AUTO-only decision", () => {
  const execEnv = (overrides: Record<string, string | undefined> = {}) =>
    ({
      EXECUTION_MODE: "MANUAL",
      MANUAL_EXECUTOR_ADDRESS: "0x1234567890123456789012345678901234567890",
      MANUAL_EXECUTOR_KIND: "eoa",
      MANUAL_INTENT_TTL_MS: "10800000",
      MANUAL_INTENT_STUCK_MS: "3600000",
      DATABASE_URL: "postgres://x",
      SIGNER_SOURCE: "local",
      SUBMITTER: "public",
      FLASHBOTS_STATUS_URL: "https://protect.flashbots.net",
      PRIVATE_RELAY_HORIZON_BLOCKS: "25",
      PRIVATE_RECLAIM_MARGIN_BLOCKS: "3",
      PRIVATE_SUBMIT_TIMEOUT_MS: "8000",
      PRIVATE_STATUS_TIMEOUT_MS: "2000",
      ...overrides,
    }) as Parameters<typeof buildExecutionConfig>[0];

  it("refuses a private relay under MANUAL, which would protect nothing", () => {
    expect(() =>
      buildExecutionConfig(
        execEnv({
          SUBMITTER: "flashbots-protect",
          FLASHBOTS_PROTECT_URL: "https://rpc.flashbots.net/fast",
          PRIVATE_MIN_PRIORITY_FEE_WEI: "2000000000",
        })
      )
    ).toThrow(/does not broadcast/);
  });

  // The quiet direction, and the one an operator actually reaches: `SUBMITTER` left at its default
  // while the relay variables beside it are set. MANUAL never builds a submitter, so nothing else in
  // the process ever looks at those variables again — boot is the last chance to say so.
  it.each([
    ["FLASHBOTS_PROTECT_URL", "https://rpc.flashbots.net/fast"],
    ["PRIVATE_MIN_PRIORITY_FEE_WEI", "2000000000"],
  ])("refuses %s under MANUAL even with SUBMITTER left public", (key, value) => {
    expect(() => buildExecutionConfig(execEnv({ [key]: value }))).toThrow(/does not broadcast/);
    expect(() => buildExecutionConfig(execEnv({ [key]: value }))).toThrow(new RegExp(key));
    expect(() => buildExecutionConfig(execEnv({ [key]: value, SUBMITTER: undefined }))).toThrow(
      /does not broadcast/
    );
  });

  it("still accepts a MANUAL setup that configures no relay", () => {
    expect(buildExecutionConfig(execEnv())).toMatchObject({ mode: "MANUAL" });
  });

  // The AUTO arm carries it, so the composition root reads `execution.submitter` with no re-check
  // and there is no separate optional field left to forget to thread.
  it("carries the submitter on the AUTO arm", () => {
    expect(
      buildExecutionConfig(
        execEnv({
          EXECUTION_MODE: "AUTO",
          MANUAL_EXECUTOR_ADDRESS: undefined,
          SUBMITTER: "flashbots-protect",
          FLASHBOTS_PROTECT_URL: "https://rpc.flashbots.net/fast",
          PRIVATE_MIN_PRIORITY_FEE_WEI: "2000000000",
        })
      )
    ).toMatchObject({
      mode: "AUTO",
      submitter: { mode: "flashbots-protect", minPriorityFeeWei: 2_000_000_000n },
    });
  });
});

// The declared window is the only thing fencing a nonce when the relay says nothing about a
// transaction's own deadline — a probe that fails, answers UNKNOWN, or under-reports leaves it
// carrying the whole weight. Too long only delays reclaiming a nonce nobody will spend; too short
// hands one out while the relay can still spend it, which is the failure the fence exists for.
describe("the declared relay window, where the relay is known", () => {
  const PROTECT_STATUS = "https://protect.flashbots.net";

  it("refuses a window shorter than Protect's, when reading status from Protect", () => {
    expect(() =>
      buildSubmitterConfig(
        privateEnv({ FLASHBOTS_STATUS_URL: PROTECT_STATUS, PRIVATE_RELAY_HORIZON_BLOCKS: "24" })
      )
    ).toThrow(/below the ~25 blocks Flashbots Protect keeps offering/);
  });

  // The check recognises a relay, so a trailing slash is still Protect. Matching on the exact
  // string would let a shade of spelling turn the floor off without changing anything real.
  it.each(["https://protect.flashbots.net/", "https://Protect.Flashbots.net"])(
    "recognises %s as Protect",
    (statusUrl) => {
      expect(() =>
        buildSubmitterConfig(
          privateEnv({ FLASHBOTS_STATUS_URL: statusUrl, PRIVATE_RELAY_HORIZON_BLOCKS: "4" })
        )
      ).toThrow(/below the ~25 blocks/);
    }
  );

  it("accepts Protect's own window, and anything longer", () => {
    for (const blocks of ["25", "50"]) {
      expect(
        buildSubmitterConfig(
          privateEnv({ FLASHBOTS_STATUS_URL: PROTECT_STATUS, PRIVATE_RELAY_HORIZON_BLOCKS: blocks })
        )
      ).toMatchObject({ relayHorizonBlocks: Number(blocks) });
    }
  });

  // A relay this bot knows nothing about: its window is a fact only its operator has, and a bot
  // that guessed Protect's number for it would be asserting something it cannot know. The e2e's
  // fake relay is exactly this — a genuine 4-block window, declared honestly.
  it("leaves a custom relay's window to the operator who named it", () => {
    expect(
      buildSubmitterConfig(
        privateEnv({
          FLASHBOTS_PROTECT_URL: "http://127.0.0.1:8555",
          FLASHBOTS_STATUS_URL: "http://127.0.0.1:8555",
          PRIVATE_RELAY_HORIZON_BLOCKS: "4",
        })
      )
    ).toMatchObject({ relayHorizonBlocks: 4 });
  });
});

// The nonce fence is the only thing that ever frees the nonce of a privately-submitted transaction
// the relay has dropped, so every input to it is bounded at the env layer — where an unbounded one
// reads as a plain large number, and everywhere after as a nonce that never comes back.
describe("private-submission fence bounds", () => {
  const parse = (env: Record<string, string>) => z.object(runtimeEnvFields).safeParse(env);

  it.each([
    ["PRIVATE_RELAY_HORIZON_BLOCKS", "25"],
    ["PRIVATE_RECLAIM_MARGIN_BLOCKS", "3"],
    ["PRIVATE_SUBMIT_TIMEOUT_MS", "8000"],
    ["PRIVATE_STATUS_TIMEOUT_MS", "2000"],
  ])("accepts a realistic %s", (key, value) => {
    expect(parse({ [key]: value }).success).toBe(true);
  });

  it.each([
    ["PRIVATE_RELAY_HORIZON_BLOCKS", "7201"],
    ["PRIVATE_RECLAIM_MARGIN_BLOCKS", "7201"],
    ["PRIVATE_SUBMIT_TIMEOUT_MS", "120001"],
    ["PRIVATE_STATUS_TIMEOUT_MS", "120001"],
  ])("rejects an out-of-range %s", (key, value) => {
    expect(parse({ [key]: value }).success).toBe(false);
  });

  // `Number.parseInt` turns this into `Infinity`: a fence that never expires and a timeout that
  // never fires, both of which boot cleanly and look like nothing at all.
  it.each([
    "PRIVATE_RELAY_HORIZON_BLOCKS",
    "PRIVATE_RECLAIM_MARGIN_BLOCKS",
    "PRIVATE_SUBMIT_TIMEOUT_MS",
    "PRIVATE_STATUS_TIMEOUT_MS",
    "MANUAL_INTENT_TTL_MS",
    "MANUAL_INTENT_STUCK_MS",
  ])("rejects a several-hundred-digit %s", (key) => {
    expect(parse({ [key]: "9".repeat(400) }).success).toBe(false);
    expect(parse({ [key]: "9007199254740993" }).success).toBe(false);
  });

  // The fee floor is the exception, and the reason the integer schemas are split by destination:
  // it lands in a `bigint`, and any wei amount above ~0.009 ETH is past MAX_SAFE_INTEGER already.
  it("accepts a wei fee floor beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parse({ PRIVATE_MIN_PRIORITY_FEE_WEI: "20000000000000000000" }).success).toBe(true);
    expect(
      buildSubmitterConfig(privateEnv({ PRIVATE_MIN_PRIORITY_FEE_WEI: "20000000000000000000" }))
    ).toMatchObject({ minPriorityFeeWei: 20_000_000_000_000_000_000n });
  });
});
