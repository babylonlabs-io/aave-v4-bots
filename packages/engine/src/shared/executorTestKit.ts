import { type TxSender, createNonceAllocator, createNonceLease } from "@repo/execution";

import { createCrashSafety } from "./crashSafety";
import { type AutoExecutor, type AutoExecutorDeps, createAutoExecutor } from "./executor";
import { createChainReader } from "./liveness";

// **Test support, not production wiring.** Nothing outside this package's tests should import it.
//
// It exists because `createAutoExecutorFromWallet` deliberately offers no way to inject a
// `TxSender`: a pre-built sender already decides where it broadcasts, so accepting one alongside a
// `submission` would let the two contradict each other. Tests still need that injection — they
// drive engines with a scripted sender — but they also want the crash-safety plumbing built for
// them rather than re-threaded at every call site. This is that combination in one place, so the
// production factory keeps a single honest input shape.

/** The production wiring, minus the submission it replaces, plus the sender it brings instead. */
export type TestExecutorDeps = Omit<AutoExecutorDeps, "submission"> & { sender: TxSender };

export function createAutoExecutorWithSender(deps: TestExecutorDeps): AutoExecutor {
  const crash = createCrashSafety({
    store: deps.store,
    nonces: deps.nonces ?? createNonceAllocator(createNonceLease(), deps.sender.identity.from),
    reader: createChainReader(deps.publicClient),
    signer: deps.sender.identity.from,
    logger: deps.logger,
  });
  return createAutoExecutor({
    crash,
    sender: deps.sender,
    publicClient: deps.publicClient,
    walletClient: deps.walletClient,
    txReceiptTimeoutMs: deps.txReceiptTimeoutMs,
    logger: deps.logger,
  });
}
