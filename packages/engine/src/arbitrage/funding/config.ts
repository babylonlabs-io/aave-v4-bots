import type { Address } from "viem";
import type { FundingParams } from "./types";

/**
 * Project the arbitrage funding variables into the params the engine takes, refusing every
 * combination that would trade differently from what the operator wrote.
 *
 * Guards both directions, as `LIQUIDATION_FUNDING` does. A router variable set without the mode is
 * the dangerous one: the bot would run, acquire vaults, and pay out of the *signer's* balance while
 * the operator believed a treasury was funding it.
 */
export function buildArbitrageFundingParams(env: {
  ARBITRAGE_FUNDING: string;
  ARBITRAGE_ROUTER_ADDRESS?: string;
  ARBITRAGE_RELAY_DEADLINE_SECONDS: string;
}): FundingParams {
  const routerOnly = [["ARBITRAGE_ROUTER_ADDRESS", env.ARBITRAGE_ROUTER_ADDRESS]] as const;
  const isSet = ([, value]: (typeof routerOnly)[number]) => value !== undefined && value.length > 0;

  if (env.ARBITRAGE_FUNDING !== "router") {
    const stray = routerOnly.filter(isSet).map(([name]) => name);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} set but ARBITRAGE_FUNDING is "${env.ARBITRAGE_FUNDING}", so the router configuration would be ignored and this bot would acquire vaults from its own WBTC. Set ARBITRAGE_FUNDING=router, or remove the router-only variables.`
      );
    }
    return { mode: "inventory" };
  }

  // Only what this function produces. `VAULT_KEEPER_ADDRESS` is router-mandatory too, but it
  // reaches the engine on its own params and is checked where it is consumed —
  // `createArbitrageFunding` — so it is not restated here.
  const missing = routerOnly.filter((entry) => !isSet(entry)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`ARBITRAGE_FUNDING=router requires ${missing.join(", ")}`);
  }

  const deadlineSeconds = Number.parseInt(env.ARBITRAGE_RELAY_DEADLINE_SECONDS, 10);
  // `SelfCallRelayer` has no nonce, so a signed batch is replayable by anyone until it expires.
  // Once we stop waiting for its receipt the authorization is of no further use to us, so a long
  // window is a standing authorization sitting in a public mempool for no benefit.
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0 || deadlineSeconds > 300) {
    throw new Error(
      `ARBITRAGE_RELAY_DEADLINE_SECONDS must be between 1 and 300, got "${env.ARBITRAGE_RELAY_DEADLINE_SECONDS}"`
    );
  }

  return {
    mode: "router",
    routerAddress: env.ARBITRAGE_ROUTER_ADDRESS as Address,
    deadlineSeconds,
  };
}
