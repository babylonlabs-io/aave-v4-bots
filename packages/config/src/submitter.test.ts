import { describe, expect, it } from "vitest";
import { type SubmitterEnv, buildExecutionConfig, buildSubmitterConfig } from "./runtime";

// Guards on `SUBMITTER`. Every case here is one where a bot that *booted* would do something the
// operator did not ask for — which is the whole point of validating at config time rather than
// discovering it from a mempool.

const env = (overrides: Partial<SubmitterEnv> = {}): SubmitterEnv => ({
  SUBMITTER: "public",
  FLASHBOTS_STATUS_URL: "https://protect.flashbots.net",
  PRIVATE_RELAY_HORIZON_BLOCKS: "25",
  PRIVATE_RECLAIM_MARGIN_BLOCKS: "3",
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
