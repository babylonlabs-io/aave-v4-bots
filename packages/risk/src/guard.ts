import type { CodeHashReader, RiskGate } from "./types";

export interface CodeHashGuardConfig {
  risk: RiskGate;
  reader: CodeHashReader;
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
 * Probe failures (RPC blips) are treated **differently at boot than afterwards**:
 *
 * - At boot, an unverifiable target has never been verified, so the bot HALTS. Failing open here
 *   would defeat the whole guarantee — the very first tx could hit upgraded code.
 * - Afterwards, the target was verified at least once and a blip is not evidence of compromise,
 *   so the bot keeps trading and the next tick retries. Halting on every RPC hiccup would make
 *   the guard an availability bug.
 *
 * Returns a stop function. A no-op (and no timer) when no hashes are pinned.
 */
export async function startCodeHashGuard(config: CodeHashGuardConfig): Promise<() => void> {
  const { risk, reader, intervalMs, onProbeError } = config;

  const verify = async (isBoot: boolean) => {
    try {
      await risk.verifyCode(reader);
    } catch (error) {
      onProbeError(error);
      if (isBoot) {
        // Fail closed: nothing has ever been verified. An operator resumes once RPC is healthy.
        risk.halt("could not verify pinned contract bytecode at boot");
      }
    }
  };

  // Boot check: runs before the poll loops start, so a compromised target never sees a tx.
  await verify(true);

  const timer = setInterval(() => void verify(false), intervalMs);
  timer.unref?.(); // never keep the process alive on this timer alone
  return () => clearInterval(timer);
}
