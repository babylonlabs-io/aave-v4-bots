import type { RiskSlot } from "./types";

/**
 * Backstop for a `finally`: release every slot no exit path settled. Marked `abandoned`, so a
 * bookkeeping miss can never trip the consecutive-failure breaker on its own. `settle()` is
 * idempotent, so slots already settled with a real outcome keep it.
 */
export function settleUnfinished(slots: readonly RiskSlot[]): void {
  for (const slot of slots) slot.settle({ ok: false, abandoned: true });
}
