# Design — #9b: the keyless `Executor` seam (implementation note)

Companion to `docs/design-009-execution-modes-and-notifications.md` §1/§11. This pins **how** the two
engines get a MANUAL mode without a hot key in a MANUAL process. #9a (persistence: `propose`/
`markBroadcast`/`supersede`/`expire`, the status split) is landed. The hard bar: **AUTO behavior
byte-for-byte unchanged.**

> **Revised after adversarial review.** The first draft proposed a fat `commit(call, claim, slot)`.
> Review (see below, "Debate outcome") rejected it: it drew the seam through risk-slot lifetime,
> nonce sequencing, and intent persistence at once. The accepted shape is in §2–§7; the original
> sits in git history. Headline changes: **the executor never touches the risk slot** (the engine
> settles all exposure); **nonce sequencing moves *into* `AutoExecutor` as per-cycle state** (it is a
> deliberate rewrite of that logic, not a "move"); the **receipt/propose branch stays visible** at
> the call site (real control flow); the **payload hash is over structured fields, not JSON**;
> **approval-as-proposal covers both engines**; and **per-service mode forces the arbitrageur's two
> engines to the same mode**.

---

## 1. What the engine's send path does today (AUTO)

Both engines, per candidate, run the same shape:

```
risk.openSlot → (arb: ensureApproval) → simulate/estimate gas
  → crash.claim(slot, input)               // recordIntent(pending); dup ⇒ skip, settle abandoned
  → hash = crash.send(nonce =>             // nonce lock (allocator) OR viem/local nonce
        sender.send(call, onSigned))       //   onSigned = crash.markPending(id, nonce, hash) pre-broadcast
  → crash.transition(id, submitted, {hash})
  → [liquidation batches: sent.push; later Promise.allSettled(waitForReceipt)]
  → on receipt: slot.settle({ok}); transition(confirmed/failed)
```

Four things here need a key or a nonce, and MANUAL has neither: `claim`→`recordIntent`,
`send`→sign+broadcast, `markPending`→nonce, and `ensureApproval`→a broadcast. Everything *above*
`claim` (risk gate, simulate, gas estimate) is keyless already — it only reads.

## 2. The seam: `Executor` owns "commit this call", the engine owns risk + receipts

```ts
export interface ExecutionIdentity { from: Address; chainId: number; }

export type Committed =
  | { kind: "broadcast"; intentId?: string; hash: Hex }  // AUTO: on chain (or ambiguously so)
  | { kind: "proposed"; intentId: string }               // MANUAL: written down + notified
  | { kind: "duplicate"; existing: TxIntent }            // a live intent already exists
  | { kind: "aborted"; broadcastAttempted: boolean; stopCycle: boolean };  // AUTO send failed

export interface Executor {
  readonly mode: "AUTO" | "MANUAL";
  readonly identity: ExecutionIdentity;

  /**
   * Cycle-start hook. AUTO: reconcile in-flight intents + resync/seed the nonce sequence for this
   * run. MANUAL: reconcile only (operator-broadcast intents still resolve by receipt) — no nonce.
   */
  prepareCycle(action: string): Promise<void>;

  /**
   * Claim + commit one call. AUTO: recordIntent → nonce+sign+broadcast → markPending → submitted.
   * MANUAL: propose(payload) → notify. Never both. **Does not touch the risk slot** — the engine
   * owns all `slot.settle(...)`. Returns the outcome; the engine settles from it.
   */
  commit(call: ContractCall, claim: IntentInput): Promise<Committed>;
}
```

The engine loop reads the outcome and settles, keeping risk + receipts:

```
risk.openSlot → ensureAllowance(executor) → simulate/estimate
  → const out = await executor.commit(call, claimInput)
  → switch (out.kind):
       "duplicate": slot.settle({ok:false, abandoned:true}); metrics; continue
       "aborted":   slot.settle({ok:false, abandoned:!out.broadcastAttempted});
                    metrics; if (out.stopCycle) break; else continue
       "proposed":  slot.settle({ok:false, abandoned:true}); metrics.recordProposed(); continue
       "broadcast": sent.push({hash, intentId, slot})   // AUTO only — MANUAL never returns this
  → [broadcast outcomes only] wait receipt(s) → slot.settle({ok}); transition(confirmed/failed)
```

**What changed from the first draft, and why.**

- **The slot is not passed in.** Settling exposure is the engine's job everywhere; folding
  "settle abandoned on dup/abort" into the executor would extend the one ownership leak we already
  have (`CrashSafety.claim` settling internally). The engine now settles *every* slot, reading the
  `Committed` kind. `commit` records and sends; it never settles.
- **Nonce sequencing moves into `AutoExecutor`.** The liquidation loop's `localNonce` init, the
  legacy re-sync on send failure, the increment, and the allocator-vs-local branch are per-run
  *state*, not per-call — a per-call `commit` cannot own them "verbatim". So `AutoExecutor` holds
  that state across `prepareCycle` + successive `commit` calls. This is an honest **rewrite** of the
  nonce loop into the executor; the regression bar is the existing engine tests, plus the dual-engine
  nonce-safety test, passing unchanged.
- **`aborted` carries `stopCycle`.** Today the allocator path does a bare `break` on a send failure
  (stop the cycle; resync reclaims the nonce). Rather than smuggle that into the executor, `commit`
  reports `stopCycle` and the engine breaks — the control-flow decision stays visible at the call
  site.
- **The receipt branch is a visible switch, not "free".** MANUAL never returns `broadcast`, so it
  contributes nothing to receipt-waiting — but arbitrage waits *inline* (not via a `sent[]` batch),
  so the engine still branches on `out.kind === "broadcast"` before waiting. That branch is real
  business flow (propose vs. await), so it is explicit, like `crash.allocated` is today.

## 3. `createAutoExecutor` — behavior-preserving

Wraps today's `crash` + `sender`. `commit` is literally the current claim→send→markPending→submitted
block moved verbatim, returning `Committed` instead of falling through. AUTO keeps its `crash`,
`sender`, `NonceAllocator`, `PreBroadcastError` handling — all of it. This is a **move, not a
rewrite**; the regression bar is that the existing engine tests pass with the block relocated.

```ts
createAutoExecutor({ crash, sender, identity })   // identity.from = walletClient.account.address
```

## 4. `createManualExecutor` — keyless

```ts
createManualExecutor({ store, notifier, identity, encodeCall, hashPayload })
```

`commit`:
1. `propose(claim, payload, payloadHash)` where `payload = {chainId, ...encodeCall(call), value:"0"}`
   and `payloadHash = hashPayload(payload)`. On refusal: settle slot `abandoned`, return `duplicate`
   — but first, compare `existing.payloadHash`: if it differs, `supersede` + re-propose (the
   payload changed); if equal, leave it (true dedup).
2. `notifier.notify({kind:"manual-intent", intentId, action, subject, target, payloadHash})`.
3. return `{kind:"proposed", intentId}`. **Never touches a nonce, a signer, or `crash.send`.**

`encodeCall(call) → {to, data}` reuses `@repo/execution`'s existing `encodeFunctionData` path (the
one `signContractCall` uses).

**`hashPayload` is over structured fields, not JSON.** Sorted-key JSON is reproducible but a poor
transaction identity, and it is brittle to the jsonb round-trip (key reorder, absent-vs-null
`gasLimit`, address casing). Instead hash a fixed byte layout of the semantic fields:

```
keccak256(abiEncode(
  ["string","uint256","address","bytes","uint256","uint256"],
  [VERSION, chainId, getAddress(to), data, BigInt(value), BigInt(gasLimit ?? 0)]))
```

`to` is normalized (`getAddress`), `value`/`gasLimit` parsed from their decimal strings, absent
`gasLimit` collapses to `0` (its documented sentinel), and `VERSION` lets the encoding evolve. This
reproduces identically whether computed from the freshly-built `ProposedTx` or from one read back out
of jsonb. Lives in `@repo/execution` next to `ContractCall`/`signContractCall`; `operator-cli` (#20)
imports the same function so proposal and verification cannot diverge.

## 5. The approval gap — **both** engines broadcast approvals

Two sites broadcast an approval via `approveMax(walletClient…)`, and MANUAL can do neither:
- **arbitrage** `ensureApproval` (mid-cycle, per acquisition), *after* `risk.openSlot`.
- **liquidation** `ensureApproval` (once at boot, called by the service before the poll loop).

A shared helper `ensureAllowance(executor, {owner, token, spender, required}) → "ok" | "pending"`:
reads allowance (keyless); if short, **commits an approval through the executor** —

- AUTO: broadcasts + waits (today's behavior; returns `"ok"` once mined).
- MANUAL: proposes one — `action:"approval"`, **`target = spender`, `subject = token`** (not
  `target = token`, which would collide the two engines' approvals per #9a review) — and returns
  `"pending"`. The engine then **skips the dependent action this cycle**: a liquidation/acquisition
  proposal against an unapproved allowance would simulate-revert anyway.

Ordering fix (arbitrage): **move the allowance check before `risk.openSlot`**, so a proposed approval
never strands an acquisition slot. Approval is a precondition, not part of the acquisition.

## 6. Identity: drop `WalletClient` from the engine's non-send surface

Replace, in both engines:
- `walletClient.account.address` (allowance/balance owner, reconcile signer) → `identity.from`
- `walletClient.chain.id` (intent chainId) → `identity.chainId`
- `account: walletClient.account` on `simulateContract`/`estimateContractGas` → `account: identity.from`
  (viem accepts a bare address for a read; no key needed)

The engine keeps `publicClient` (reads) and gains `executor` + `identity`. It no longer holds a
`WalletClient` at all — the `AutoExecutor` does, behind the seam. **A MANUAL engine is constructed
with no `WalletClient` anywhere in its object graph.**

## 7. Reconcile: lazy nonce reads

`reconcilePending` eagerly does `getNonce(signer, latest|pending)` up front. A keyless MANUAL bot
has no signer nonce to read (and its in-flight intents — operator-broadcast — have `nonce === null`).
Make the two reads **lazy**: skip them unless some in-flight intent has `nonce !== null`. A MANUAL bot
then issues zero `getTransactionCount`. (Also makes `signer` optional/unused in the pure-MANUAL path.)

## 8. Config + keyless boot

- `EXECUTION_MODE = AUTO | MANUAL` (default AUTO); `MANUAL_EXECUTOR_ADDRESS` (required in MANUAL).
- Composition root: in MANUAL, **do not** `resolveSigner` / build a `WalletClient` / seed a
  `NonceAllocator`; build a `ManualExecutor{store, notifier, identity:{from:MANUAL_EXECUTOR_ADDRESS,
  chainId}}`. In AUTO, build an `AutoExecutor` exactly as today.
- Boot validation: MANUAL requires `MANUAL_EXECUTOR_ADDRESS` + a `StateStore` + a notifier; MANUAL
  must **reject** a configured signing key (we promised not to hold one).
- **Arbitrageur runs both engines off one signer**, so mode is per-*process*: a MANUAL arbitrageur
  runs *both* the arbitrage and the (optional) liquidation engine in MANUAL, sharing one
  `ManualExecutor` identity. Mixed modes = two single-engine services (the design already supports
  this via the arbitrageur/liquidator split). The composition root builds one executor and injects
  it into every engine it constructs, exactly as it does the one risk gate today.

## 9. Staging (each step ships green, AUTO tests passing)

Re-ordered after review to front-load the pure refactors (no behavior change) before the seam:

1. **`ExecutionIdentity`** — replace `walletClient.account.address` / `.chain.id` / simulate-`account`
   uses in both engines with an injected identity. Pure refactor, AUTO unchanged, independently green.
2. **Lazy nonce reads** in `reconcilePending` (self-contained; tiny).
3. **`hashPayload`/`encodeCall`** in `@repo/execution` + unit tests (round-trip reproducibility) —
   no consumer yet, but the canonical contract lands and is tested in isolation.
4. **`Executor` interface + `createAutoExecutor`** (owns the nonce sequence via `prepareCycle`);
   refactor **liquidation** to `executor.commit`. The regression bar: existing engine + dual-engine
   nonce tests pass unchanged.
5. **`createManualExecutor`** + MANUAL liquidation tests (keyless boot, propose+notify, zero nonce
   reads).
6. **`ensureAllowance` helper** (both engines, approval-as-proposal) + **arbitrage** refactor + the
   allowance-before-`openSlot` ordering fix.
7. **Config + services**: `EXECUTION_MODE`, `MANUAL_EXECUTOR_ADDRESS`, keyless boot, boot validation,
   arbitrageur both-engines-one-mode.

---

## Debate outcome (accepted / rejected)

**Accepted** (all from the review): drop `slot` from `commit` — engine settles all exposure; nonce
sequencing moves into `AutoExecutor` as per-cycle state (`prepareCycle`), acknowledged as a rewrite
not a move; `aborted` carries `stopCycle` instead of a smuggled `break`; the propose-vs-receipt
branch stays visible (arbitrage waits inline, so `sent[]` isn't the only coupling); approval-as-
proposal covers **both** engines (liquidation approves at boot too) via a shared `ensureAllowance`,
and a MANUAL approval blocks the dependent action that cycle; the payload hash is a structured ABI
encoding, not sorted JSON, with `to` normalized; per-process mode forces the arbitrageur's two
engines to one mode.

**Rejected / not adopted:** the "thin `IntentCoordinator` + `ExecutionSender`, engine keeps the whole
loop" alternative. It keeps more mode branches inline in the engine loop (claim-vs-propose,
send-vs-skip, wait-vs-skip) than the `Executor` seam, which collapses them to one `commit` +
one outcome switch. The `Executor` still removes wallet/nonce from MANUAL and no longer passes the
slot, which were the alternative's two real wins — so we take those fixes without fragmenting the
send path across four objects.

**Still open, deferred to implementation:** whether `AutoExecutor` also owns `reconcile`/`resync`
(via `prepareCycle`) or those stay separate — leaning `prepareCycle` owns them, since that is exactly
the cycle-start nonce work MANUAL must skip.

---

## Open questions for debate

1. **Is `commit(call, claim, slot)` the right seam, or too much in one method?** It folds claim +
   send + markPending + (propose/notify) behind one call. The alternative is a thinner
   `executor.send(call): Committed` with the engine keeping `claim`— but then `claim` itself is
   mode-dependent (recordIntent vs propose), so the split leaks back into the engine. Is one fat
   `commit` better than a mode-aware `claim` + a thin `send`?
2. **Does `Committed` need `duplicate` AND `aborted` as distinct kinds**, or can the engine
   distinguish via the slot? They differ in AUTO nonce-gap handling (abort may need `break` to stop
   the cycle; duplicate is `continue`). Keeping them distinct seems right — confirm.
3. **Where do `encodeCall`/`hashPayload` live?** `@repo/execution` (has viem, owns `ContractCall`)
   or a new `@repo/domain` helper? They're needed by both `ManualExecutor` and `operator-cli` (#20).
   `@repo/execution` seems right, but it drags `operator-cli` into depending on the execution pkg.
4. **Should `AutoExecutor` swallow the identity of `crash`?** Today the engine calls `crash.reconcile`
   / `crash.resyncNonces` directly (cycle start), separate from sends. The executor owns sends; does
   it also own reconcile/resync, or do those stay on `crash` injected alongside? Leaning: reconcile/
   resync stay engine-visible (they're cycle-level, not per-call), executor owns only `commit`.
5. **MANUAL + the liquidation batch loop.** Liquidation builds `validCandidates`, then loops sending.
   In MANUAL every candidate proposes independently — no nonce sequence, no `break`-on-nonce-gap. The
   loop still works (each `commit` returns `proposed`), but the `localNonce`/`crash.allocated`
   branching is dead in MANUAL. Is it enough that it's simply never exercised (AutoExecutor-only), or
   should the nonce-sequence logic move *into* AutoExecutor so the engine loop has none of it?
