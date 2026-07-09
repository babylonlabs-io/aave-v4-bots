import { createChainReader } from "@repo/chain";
import { type NonceAllocator, nextNonce } from "@repo/execution";
import type { Logger } from "@repo/logger";
import {
  type IntentInput,
  type IntentStatus,
  type StateStore,
  type TransitionMeta,
  reconcilePending,
} from "@repo/persistence";
import type { RiskSlot } from "@repo/risk";
import type { Address, Hex, PublicClient } from "viem";

// Shared crash-safety / nonce plumbing used by both engines (they run the same intent +
// shared-nonce-allocator dance around their sends). Free functions rather than a base class so
// each engine keeps its own pipeline; these just remove the duplicated boilerplate.

/**
 * Resolve one `action`'s in-flight intents against the chain (crash- and ambiguous-send
 * safety). No-op without a store.
 */
export async function reconcileIntents(
  store: StateStore | undefined,
  publicClient: PublicClient,
  signer: Address,
  action: string,
  logger: Logger
): Promise<void> {
  if (!store) return;
  await reconcilePending({
    store,
    reader: createChainReader(publicClient),
    signer,
    action,
    logger,
  });
}

/**
 * Re-seed the shared nonce lease from the chain's `pending` count (reclaims a not-broadcast
 * nonce; advances if the chain moved ahead). No-op without an allocator.
 */
export function resyncNonces(
  nonces: NonceAllocator | undefined,
  publicClient: PublicClient,
  signer: Address
): Promise<void> {
  return nonces ? nonces.resync(() => nextNonce(publicClient, signer)) : Promise.resolve();
}

/**
 * Broadcast through the shared nonce allocator when present (so the two engines never collide
 * on a nonce), else let viem pick the nonce. `send` receives the reserved nonce, or `undefined`
 * when there is no allocator (viem auto-nonce).
 */
export function sendMaybeAllocated(
  nonces: NonceAllocator | undefined,
  send: (nonce?: number) => Promise<Hex>
): Promise<Hex> {
  return nonces ? nonces.withNonce((nonce) => send(nonce)) : send();
}

/**
 * Intent transition that must not throw — a bookkeeping failure is logged, never propagated
 * (the on-chain tx is the source of truth; reconcile resolves any drift). No-op without a store.
 */
export async function bestEffortTransition(
  store: StateStore | undefined,
  logger: Logger,
  id: string,
  to: IntentStatus,
  meta?: TransitionMeta
): Promise<void> {
  if (!store) return;
  try {
    await store.transition(id, to, meta);
  } catch (error) {
    logger.error(`Failed to persist intent ${id} → ${to}:`, error);
  }
}

/**
 * Claim the right to perform `input`, refusing a duplicate that is already live (pending or
 * submitted) on chain. On refusal the risk slot is released as `abandoned` — nothing was
 * broadcast, so it is not evidence the chain is rejecting us — and the caller skips the action.
 *
 * Without a store there is no idempotency to enforce: the claim always succeeds with no intent id.
 */
export async function claimIntent(
  store: StateStore | undefined,
  logger: Logger,
  slot: RiskSlot,
  input: IntentInput
): Promise<{ claimed: boolean; intentId?: string }> {
  if (!store) return { claimed: true };

  const record = await store.recordIntent(input);
  if (!record.recorded) {
    logger.warn(`Skipping ${input.subject}: intent already ${record.existing.status}`);
    slot.settle({ ok: false, abandoned: true });
    return { claimed: false };
  }
  return { claimed: true, intentId: record.id };
}
