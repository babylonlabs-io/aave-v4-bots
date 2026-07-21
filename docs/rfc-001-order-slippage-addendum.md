# RFC-001 Addendum (proposed diffs) — `repayAmount` → `maxRepayAmount` (debt-spend slippage bound)

> Turns the per-item `repayAmount` — on **both** the router's `Order` (§3.3) and the
> relayer's `Intent` (§4.5) — from a **trusted off-chain amount** into a **ceiling** whose
> actual value is **resolved on-chain** as `min(currentDebt, maxRepayAmount)`. On the
> router this is a real slippage / exposure control (symmetric with the per-item WBTC
> bounds); on the relayer it is freshness + payer protection (the standing exposure cap is
> already `AssetPolicy.maxPerPosition`). Either way a batch/intent fully clears a position
> whose debt accrued since the off-chain estimate, and it lets the engine **retire its
> off-chain `bufferAmounts` (+1%) hack** — freshness now comes from the chain. Not yet
> applied to [rfc-001](./rfc-001-liquidation-contracts.md).

## Why

Between the bot's Lens read and on-chain landing, a position's debt moves (interest
accrual; a third-party partial liquidation; a manipulated/odd state). Today the router
repays the exact number the caller passed, and the engine buffers it +1% off-chain to
cover accrual. Instead: pass a **ceiling**, resolve the **current** debt on-chain, and
repay `min(currentDebt, maxRepayAmount)`. A caller estimate that runs high can't
over-draw; one that runs low can't force a partial liquidation. `maxRepayAmount` is the
debt-side analogue of `maxFairnessWbtc` / `minWbtcOut`, so `allowFailure` can now isolate
a debt-side blowup too.

**Mechanism (open — see below):** the clamp is either **native to the adapter** (if
`liquidateWithLLP` already repays `min(amount, currentDebt)`, passing `maxRepayAmount`
gets it for free, no extra read) or **enforced by the router** via an on-chain
Lens/Spoke debt read before the adapter call (N reads/batch). The diffs below specify the
**behavior**; the mechanism is pinned in the contracts RFC once the adapter semantics are
confirmed against `vault-contracts-aave-v4`.

---

## Diff 1 — §3.2 Entry points (resolve on-chain; derive the flash borrow off the ceiling)

```diff
 - `batchLiquidate(debtAsset, orders, allowFailure, profitGuard)` — self-funded;
   the router already holds/approves `debtAsset` and a WBTC working float.
+  Per position the router repays `min(currentDebt, order.maxRepayAmount)` — the amount is
+  resolved **on-chain**, never trusted from the caller (§3.6).
 - `flashLiquidate(debtAsset, orders, allowFailure, profitGuard, fairnessSwap, repaySwap)`
   — the flash token is `debtAsset`; the borrow **amount** is **derived** (not a
-  param) as `sum(order.repayAmount) + fairnessSwap.maxIn`. It borrows that, pre-swaps
+  param) as `sum(order.maxRepayAmount) + fairnessSwap.maxIn` — the worst-case draw. It
+  borrows that, pre-swaps
   a bounded slice to WBTC for the fairness payment, runs the batch, swaps WBTC back to
   repay loan + premium, keeps the residual. `fairnessSwap` and `repaySwap` are
-  validated to reference `debtAsset`; `orders` must be non-empty.
+  validated to reference `debtAsset`; `orders` must be non-empty. Each position still
+  repays only `min(currentDebt, order.maxRepayAmount)`, so the `debtAsset` actually drawn
+  is ≤ the borrowed sum; any unborrowed-but-owed shortfall reduces the `repaySwap` leg.
```

## Diff 2 — §3.3 Per-item order fields (rename + clamp semantics + extend the allowFailure note)

```diff
 | Field | Purpose |
 |-------|---------|
 | `borrower` | the position |
-| `repayAmount` | amount of the batch's `debtAsset` to repay; the router constructs the adapter's per-reserve calldata from it |
+| `maxRepayAmount` | **ceiling** on the batch's `debtAsset` spent on this position. The amount repaid is the **current on-chain debt clamped to this max** — `min(currentDebt, maxRepayAmount)` — so a stale/low estimate can't under-liquidate and an unexpectedly high debt can't over-spend. The router builds the adapter's per-reserve calldata from the clamped amount. |
 | `maxFairnessWbtc` | per-item ceiling on the WBTC fairness payment (measured balance delta) — caps gross WBTC exposure |
 | `minWbtcOut` | per-item floor on WBTC received — the partial-fill guard |
```

```diff
-The two WBTC fields exist **only** to make `allowFailure` useful — they isolate a
-bad-but-non-reverting item; with an always-atomic batch they'd be redundant with
-the guard. (A single net-WBTC floor — `received − topUp` — was considered; two
-explicit fields read clearer and separate gross-exposure from fill-quality.)
+The three per-item bounds — `maxRepayAmount` (debt spent), `maxFairnessWbtc` (WBTC in),
+`minWbtcOut` (WBTC out) — exist to make `allowFailure` useful: they isolate a
+bad-but-non-reverting item on **both** legs; with an always-atomic batch they'd be
+redundant with the guard. `maxRepayAmount` additionally serves as the **debt-spend
+slippage bound** — the amount is resolved on-chain (§3.2/§3.6), so the debt leg no longer
+trusts a caller number, and the engine's off-chain `bufferAmounts` (+1% accrual pad)
+becomes unnecessary. (A single net-WBTC floor — `received − topUp` — was considered; two
+explicit WBTC fields read clearer and separate gross-exposure from fill-quality.)
```

## Diff 3 — §3.6 Invariants (restate the debt-spend bound against the ceiling + the clamp)

```diff
-- The `debtAsset` consumed by a batch ≤ `sum(order.repayAmount)`, and no other token
-  is pulled (the over-pull guard the single-token profit floor depends on).
+- Per position the `debtAsset` repaid is `min(currentDebt, order.maxRepayAmount)`,
+  resolved on-chain; so the `debtAsset` consumed by a batch ≤ `sum(order.maxRepayAmount)`,
+  and no other token is pulled (the over-pull guard the single-token profit floor depends
+  on). `maxRepayAmount` is thus the per-item debt-spend slippage bound: a caller estimate
+  that runs high can never over-draw, and one that runs low can't force a partial
+  liquidation.
```

## Diff 4 — §8 Method & data reference (propagate the field name)

```diff
+| `Order` | `{ borrower, maxRepayAmount, maxFairnessWbtc, minWbtcOut }` — `maxRepayAmount` is a **ceiling**; the router repays `min(currentDebt, maxRepayAmount)` resolved on-chain |
```

> **Propagation:** the flash-venues and venue-manager addenda both derive the borrow
> amount as `sum(order.repayAmount) + fairnessSwap.maxIn`; those references become
> `sum(order.maxRepayAmount) + …` under this change (behaviour unchanged — it was already
> the per-item spend ceiling).

---

## Also — `LiquidationRelayer.Intent` (§4.5)

Same change, different *why*. The router's `Order` has no other per-item bound, so
`maxRepayAmount` there is both freshness **and** the exposure ceiling. The relayer already
has a standing per-position cap (`AssetPolicy.maxPerPosition`, §4.4) and the allowance, so
on the intent the change is **freshness + payer protection**: the provider's capital is
pulled for the *current* debt, never a stale over-estimate. It layers under the existing
caps — `pulled = min(currentDebt, maxRepayAmount) ≤ maxPerPosition ≤ allowance` — and is
friendly to a signed intent (authorizing "up to max" beats an exact figure).

## Diff 5 — §4.5 Intent fields (rename + clamp)

```diff
 | Field | Purpose |
 |-------|---------|
 | `provider` | whose policy and capital fund the liquidation |
 | `borrower` | the position to liquidate |
 | `debtAsset` | the debt token repaid; selects the `(provider, debtAsset)` policy + allowance |
-| `repayAmount` | amount of `debtAsset` to repay |
+| `maxRepayAmount` | **ceiling** on `debtAsset` to repay; the contract repays `min(currentDebt, maxRepayAmount)` resolved on-chain — clears the current debt and protects the provider from a stale over-estimate |
 | `deadlineBlock` | block-based expiry — a stale / toxic intent reverts |
```

## Diff 6 — §4.5 enforcement (clamp before the policy/allowance caps)

```diff
-Per intent the contract enforces: an active/unexpired policy exists for
-`(provider, debtAsset)`; `block.number ≤ deadlineBlock`; gas ceiling; pulled
-capital ≤ `maxPerPosition` and ≤ remaining allowance for `debtAsset`; and absolute
-`minWbtcProfit` on the measured provider balance delta.
+Per intent the contract enforces: an active/unexpired policy exists for
+`(provider, debtAsset)`; `block.number ≤ deadlineBlock`; gas ceiling; the repaid amount
+is `min(currentDebt, maxRepayAmount)` (resolved on-chain), and the pulled capital is then
+≤ `maxPerPosition` and ≤ remaining allowance for `debtAsset`; and absolute `minWbtcProfit`
+on the measured provider balance delta.
```

## Diff 7 — §4.8 Invariants (add the clamp)

```diff
+- Per intent, capital pulled for a position = `min(currentDebt, maxRepayAmount)`, then
+  bounded by `maxPerPosition` and the standing allowance — a stale intent over-estimate
+  can never pull more than the current debt.
```

---

## Open items

- **Clamp mechanism — the deciding question.** Does `aaveAdapter.liquidateWithLLP`
  already repay `min(amount, currentDebt)`?
  - **Yes** → pass `maxRepayAmount` straight through; the clamp is adapter-native, **no
    extra read**. Add an on-chain debt read only if the *exact consumed* figure is needed
    for the profit accounting / an event.
  - **No** → the router reads current debt on-chain (Lens `estimateLiquidation`, or a
    cheaper direct Spoke debt read) and clamps before the adapter call — **N reads/batch**.
  Confirm against `vault-contracts-aave-v4` before pinning.
- **Flash borrow sizing.** Deriving the borrow as `sum(maxRepayAmount)` over-borrows when
  actual debt is lower, paying premium on the excess (loan mode). The premium-efficient
  alternative is to resolve the per-item actuals on-chain **first** and borrow
  `sum(min(debt, max))` — at the cost of the debt reads happening before the borrow.
  Trade gas/premium vs simplicity; default to `sum(maxRepayAmount)` unless the excess
  premium is material.
- **Gas.** If the router-side clamp is needed, it adds a read per position; weigh against
  the freshness + bound. A direct debt read is likely cheaper than a full Lens estimate.
- **Naming.** `maxRepayAmount` chosen over `repayAmountCap` for symmetry with
  `maxFairnessWbtc`.
```
