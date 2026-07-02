import { resolveIndexingModes } from "./indexingModes";

// Which index modes this instance runs, derived from which contract addresses
// are configured. An operator can run a single shared instance (both modes) or
// one instance per service (set only that service's addresses).
//
// The SAME predicates gate the contracts in ponder.config.ts and the handler
// registration in src/*.ts, so config inclusion and `ponder.on(...)` always
// agree. Validation (fail-fast on a half-configured/empty setup) lives in
// resolveIndexingModes and runs here, when this module is first imported.
const modes = resolveIndexingModes(process.env);

export const INDEX_LIQUIDATION = modes.indexLiquidation;

export const INDEX_ARBITRAGE = modes.indexArbitrage;
