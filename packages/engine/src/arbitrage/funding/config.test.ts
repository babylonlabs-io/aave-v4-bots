import { describe, expect, it } from "vitest";
import { createArbitrageFunding } from ".";
import { buildArbitrageFundingParams } from "./config";

const ROUTER = "0xrouter00000000000000000000000000000000a1";
const KEEPER = "0xkeeper00000000000000000000000000000000b2";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  ARBITRAGE_FUNDING: "inventory",
  ARBITRAGE_RELAY_DEADLINE_SECONDS: "120",
  ...overrides,
});

describe("buildArbitrageFundingParams", () => {
  it("defaults to the signer paying for itself", () => {
    expect(buildArbitrageFundingParams(env())).toEqual({ mode: "inventory" });
  });

  // The dangerous direction: the bot would run and acquire vaults from the SIGNER's balance while
  // the operator believed a treasury was funding it. Silence here is a wrong-account spend.
  it("refuses router variables without the router mode", () => {
    expect(() => buildArbitrageFundingParams(env({ ARBITRAGE_ROUTER_ADDRESS: ROUTER }))).toThrow(
      /ARBITRAGE_ROUTER_ADDRESS is set but ARBITRAGE_FUNDING is "inventory"/
    );
  });

  it("refuses the router mode without a router", () => {
    expect(() => buildArbitrageFundingParams(env({ ARBITRAGE_FUNDING: "router" }))).toThrow(
      /requires ARBITRAGE_ROUTER_ADDRESS/
    );
  });

  // No nonce in `SelfCallRelayer`, so the deadline is the only thing retiring a signature.
  it.each(["0", "-1", "301", "notanumber"])("rejects a %s-second deadline", (seconds) => {
    expect(() =>
      buildArbitrageFundingParams(
        env({
          ARBITRAGE_FUNDING: "router",
          ARBITRAGE_ROUTER_ADDRESS: ROUTER,
          VAULT_KEEPER_ADDRESS: KEEPER,
          ARBITRAGE_RELAY_DEADLINE_SECONDS: seconds,
        })
      )
    ).toThrow(/must be between 1 and 300/);
  });

  it("builds router params from a complete configuration", () => {
    expect(
      buildArbitrageFundingParams(
        env({
          ARBITRAGE_FUNDING: "router",
          ARBITRAGE_ROUTER_ADDRESS: ROUTER,
          VAULT_KEEPER_ADDRESS: KEEPER,
          ARBITRAGE_RELAY_DEADLINE_SECONDS: "90",
        })
      )
    ).toEqual({ mode: "router", routerAddress: ROUTER, deadlineSeconds: 90 });
  });
});

describe("createArbitrageFunding", () => {
  const context = (
    mode: "AUTO" | "MANUAL",
    vaultKeeperAddress?: `0x${string}`,
    funding?: ReturnType<typeof buildArbitrageFundingParams>
  ) => ({
    publicClient: {} as never,
    risk: {} as never,
    metrics: { recordFundingCapacity: () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    executor: { mode, identity: { from: "0x1", chainId: 1 }, account: {} } as never,
    wbtcAddress: "0x2" as const,
    vaultSwapAddress: "0x3" as const,
    maxSlippageBps: 100,
    vaultKeeperAddress,
    funding,
  });

  // No `funding` at all is what a deployment that configures nothing has, and it must still build.
  it("defaults to inventory funding on either executor", () => {
    expect(createArbitrageFunding(context("MANUAL")).mode).toBe("inventory");
  });

  const routerParams = {
    mode: "router",
    routerAddress: ROUTER as `0x${string}`,
    deadlineSeconds: 120,
  } as const;

  it("authorizes with the executor's own account", () => {
    expect(
      createArbitrageFunding(context("AUTO", KEEPER as `0x${string}`, routerParams)).mode
    ).toBe("router");
  });

  // Both of these are rejected here rather than at the env layer, which never sees an executor and
  // for which the keeper is optional — the other mode may run without one.
  it("refuses router funding on a keyless executor", () => {
    expect(() =>
      createArbitrageFunding(context("MANUAL", KEEPER as `0x${string}`, routerParams))
    ).toThrow(/cannot run with EXECUTION_MODE=MANUAL/);
  });

  it("refuses router funding without a keeper to redeem to", () => {
    expect(() => createArbitrageFunding(context("AUTO", undefined, routerParams))).toThrow(
      /requires VAULT_KEEPER_ADDRESS/
    );
  });
});
