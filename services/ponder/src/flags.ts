// Which index modes this instance runs, derived from which contract addresses
// are configured. An operator can run a single shared instance (both modes) or
// one instance per service (set only that service's addresses).
//
// The SAME predicates gate the contracts in ponder.config.ts and the handler
// registration in src/*.ts, so config inclusion and `ponder.on(...)` always agree.
export const INDEX_LIQUIDATION = !!process.env.ADAPTER_ADDRESS && !!process.env.SPOKE_ADDRESS;

export const INDEX_ARBITRAGE = !!process.env.VAULT_SWAP_ADDRESS;
