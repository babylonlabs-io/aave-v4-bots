import type { CodeHashReader, RiskGate } from "./types";

export interface CodeHashGuardConfig {
  risk: RiskGate;
  /** Reads deployed-bytecode hashes for the addresses the gate has pinned. */
  read: CodeHashReader;
  /** How often to re-verify after the boot check. */
  intervalMs: number;
  /** Called when a probe *fails* (RPC blip) — not when it detects a mismatch (that halts). */
  onProbeError: (error: unknown) => void;
}

/**
 * Verify the pinned bytecode once at boot, then on an interval, halting the gate the moment a
 * target contract's code changes underneath the bot (proxy upgrade, self-destruct, wrong
 * address). Re-checking periodically — not only at boot — is the point: a long-running bot that
 * only checked at startup would keep trading against an upgraded contract for its whole lifetime.
 *
 * A probe failure (RPC blip) is not evidence of compromise, so it is logged and retried rather
 * than halting — *unless nothing has ever verified*, which `verifyCode` decides for itself. This
 * loop therefore has no boot/steady-state branch of its own: "is this the first check?" was only
 * ever a proxy for "has anything been verified?", and the two part company the moment an operator
 * resumes a never-verified gate.
 *
 * Returns a stop function that clears the interval. Only call this when hashes are actually
 * pinned — `startRiskRuntime` does — otherwise you get a timer that verifies nothing forever.
 */
export async function startCodeHashGuard(config: CodeHashGuardConfig): Promise<() => void> {
  const { risk, read, intervalMs, onProbeError } = config;

  const verify = async () => {
    try {
      await risk.verifyCode(read);
    } catch (error) {
      onProbeError(error);
    }
  };

  // Boot check: runs before the poll loops start, so a compromised target never sees a tx.
  await verify();

  const timer = setInterval(() => void verify(), intervalMs);
  timer.unref?.(); // never keep the process alive on this timer alone
  return () => clearInterval(timer);
}
