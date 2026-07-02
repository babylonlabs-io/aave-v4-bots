// Pure domain logic — opportunity shaping, profitability, route/amount decisions.
// No IO, no viem clients; unit-tested in isolation.

export {
  bufferAmounts,
  sequentialPriorityOrder,
  RESERVE_FLAG,
  isBorrowableReserve,
} from "./liquidation";
export { maxWbtcInWithSlippage } from "./arbitrage";
