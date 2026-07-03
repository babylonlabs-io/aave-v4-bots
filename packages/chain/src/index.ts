// RPC plumbing (seed of the chain package; readers / lens / simulation / rpc-pool
// land here as bot.ts is decomposed — docs/refactor-001-repo-reorg-plan.md Phase 5–6).

export { type RetryConfig, withRetry, fetchWithRetry } from "./retry";
export { type RpcCallObserver, instrumentedHttp } from "./instrumentedTransport";
