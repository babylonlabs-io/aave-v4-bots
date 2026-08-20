import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertProfitFloorEnforceable,
  buildRiskConfig,
  codeHashMapSchema,
  riskEnvFields,
} from "./risk";

const ADAPTER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

const parse = (env: Record<string, string>) => z.object(riskEnvFields).parse(env);

describe("@repo/config risk env", () => {
  // The whole point of the defaults: adding the risk gate must not change how a deployment that
  // sets none of these variables behaves.
  it("leaves every guard unconfigured when no RISK_* vars are set", () => {
    const { risk, controlTokenRef } = buildRiskConfig(parse({}));
    expect(risk).toEqual({
      maxConsecutiveFailures: undefined,
      minProfit: undefined,
      maxDataStalenessMs: undefined,
      maxInFlight: undefined,
      expectedCodeHashes: undefined,
      startHalted: false,
    });
    expect(controlTokenRef).toBeUndefined();
  });

  // `RISK_MIN_PROFIT` is denominated in 8-decimal sats and lands in a `bigint`, so it is one of the
  // few knobs for which a value past `Number.MAX_SAFE_INTEGER` is a number and not a typo.
  it("carries a profit floor larger than Number.MAX_SAFE_INTEGER exactly", () => {
    const huge = "9007199254740993";
    const { risk } = buildRiskConfig(parse({ RISK_MIN_PROFIT: huge }));
    expect(risk.minProfit).toBe(BigInt(huge));
  });

  // Every one of these lands in a `number`. At this size `Number.parseInt` yields `Infinity` or a
  // rounded neighbour, so a failure counter never trips, a staleness bound never bites, and an
  // in-flight cap never fills — each one a guard the operator believes is armed.
  it.each([
    "RISK_MAX_CONSECUTIVE_FAILURES",
    "RISK_MAX_DATA_STALENESS_MS",
    "RISK_MAX_IN_FLIGHT",
    "RISK_CODE_CHECK_INTERVAL_MS",
    "RISK_CONTROL_PORT",
  ])("rejects a %s that does not survive as a JS number", (key) => {
    const check = (v: string) => z.object(riskEnvFields).safeParse({ [key]: v }).success;
    expect(check("9".repeat(400))).toBe(false);
    expect(check("9007199254740993")).toBe(false);
  });

  it("projects the numeric thresholds", () => {
    const { risk, codeCheckIntervalMs } = buildRiskConfig(
      parse({
        RISK_MAX_CONSECUTIVE_FAILURES: "5",
        RISK_MAX_DATA_STALENESS_MS: "30000",
        RISK_MAX_IN_FLIGHT: "3",
        RISK_CODE_CHECK_INTERVAL_MS: "60000",
      })
    );
    expect(risk.maxConsecutiveFailures).toBe(5);
    expect(risk.maxDataStalenessMs).toBe(30_000);
    expect(risk.maxInFlight).toBe(3);
    expect(codeCheckIntervalMs).toBe(60_000);
  });

  it("defaults the code-check interval to 5 minutes", () => {
    expect(buildRiskConfig(parse({})).codeCheckIntervalMs).toBe(300_000);
  });

  it("parses minProfit as a bigint, including zero", () => {
    expect(buildRiskConfig(parse({ RISK_MIN_PROFIT: "12345" })).risk.minProfit).toBe(12345n);
    expect(buildRiskConfig(parse({ RISK_MIN_PROFIT: "0" })).risk.minProfit).toBe(0n);
  });

  describe("RISK_START_HALTED", () => {
    it("does not start halted on 'false' or when unset", () => {
      expect(buildRiskConfig(parse({ RISK_START_HALTED: "false" })).risk.startHalted).toBe(false);
      expect(buildRiskConfig(parse({})).risk.startHalted).toBe(false);
    });

    // A safety switch must not fail open on a typo: `True` would otherwise parse to false and
    // the bot would trade when the operator asked it not to.
    it.each(["True", "TRUE", "1", "yes"])("rejects %s rather than failing open", (value) => {
      expect(() => parse({ RISK_START_HALTED: value })).toThrow();
    });

    // Booting HALTED with no way to resume bricks the bot: every restart halts again. Unlike a
    // breaker trip or a boot-probe halt, a restart is not a recovery path here.
    it("refuses startHalted without a control token (no resume path)", () => {
      expect(() => buildRiskConfig(parse({ RISK_START_HALTED: "true" }))).toThrow(
        /requires RISK_CONTROL_TOKEN_REF/
      );
    });

    it("allows startHalted when the kill-switch endpoint is configured", () => {
      const settings = buildRiskConfig(
        parse({ RISK_START_HALTED: "true", RISK_CONTROL_TOKEN_REF: "BOT_CONTROL_TOKEN" })
      );
      expect(settings.risk.startHalted).toBe(true);
      expect(settings.controlTokenRef).toBe("BOT_CONTROL_TOKEN");
    });
  });

  it("carries the control token *reference*, never a token value", () => {
    const settings = buildRiskConfig(parse({ RISK_CONTROL_TOKEN_REF: "BOT_CONTROL_TOKEN" }));
    expect(settings.controlTokenRef).toBe("BOT_CONTROL_TOKEN");
  });

  describe("code-hash map", () => {
    it("parses address=hash pairs", () => {
      expect(codeHashMapSchema.parse(`${ADAPTER}=${HASH}`)).toEqual({ [ADAPTER]: HASH });
    });

    it("parses several pairs and tolerates whitespace and trailing commas", () => {
      const raw = ` ${ADAPTER} = ${HASH} , `;
      expect(codeHashMapSchema.parse(raw)).toEqual({ [ADAPTER]: HASH });
    });

    it("rejects a pair with no '='", () => {
      expect(() => codeHashMapSchema.parse(ADAPTER)).toThrow(/address=hash/);
    });

    it("rejects a bad address", () => {
      expect(() => codeHashMapSchema.parse(`0xnope=${HASH}`)).toThrow();
    });

    it("rejects a hash that is not 32 bytes", () => {
      expect(() => codeHashMapSchema.parse(`${ADAPTER}=0xabc`)).toThrow();
    });

    // A set variable that pins nothing looks, from every angle an operator can see, exactly like a
    // working guard: boot succeeds, the checker runs on its interval, and it compares no contracts.
    it.each([",", " ", " , , "])("rejects %j — set, but names no contract", (raw) => {
      expect(() => codeHashMapSchema.parse(raw)).toThrow(/at least one address=hash/);
    });
  });

  describe("assertProfitFloorEnforceable", () => {
    const withFloor = (minProfit?: bigint) =>
      ({
        risk: { minProfit },
        codeCheckIntervalMs: 0,
        controlPort: 0,
        controlHost: "",
      }) as Parameters<typeof assertProfitFloorEnforceable>[0];

    it("rejects a profit floor when the liquidation engine runs", () => {
      // The floor cannot bite on liquidations, so allowing this would leave every liquidation
      // ungated while RISK_MIN_PROFIT looked enabled.
      expect(() => assertProfitFloorEnforceable(withFloor(1000n), true)).toThrow(/RISK_MIN_PROFIT/);
    });

    it("allows a profit floor when only the arbitrage engine runs", () => {
      // Arbitrage supplies an exact expectedProfit, so the floor is fully enforceable here — this
      // is the case the guard must NOT break.
      expect(() => assertProfitFloorEnforceable(withFloor(1000n), false)).not.toThrow();
    });

    it("allows the liquidation engine when no floor is configured", () => {
      expect(() => assertProfitFloorEnforceable(withFloor(undefined), true)).not.toThrow();
    });

    it("treats a zero floor as configured, not absent", () => {
      // 0n is a real floor ("never take a loss"), and `undefined` is the only "unset".
      expect(() => assertProfitFloorEnforceable(withFloor(0n), true)).toThrow(/RISK_MIN_PROFIT/);
    });
  });
});
