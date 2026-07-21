# RFC-001 Addendum (proposed diffs) — multi-venue flash funding

> Diffs that generalize `LiquidatorRouter`'s flash funding from **Aave-only** to **two
> operator-selected modes**, operationalizing the `FlashLoanProvider` seam the
> architecture proposal deferred (§5.3 / §12). Not yet applied to
> [rfc-001](./rfc-001-liquidation-contracts.md).
>
> - **Flash loan** — borrow `debtAsset` from a **singleton** lender (Aave / Balancer /
>   Morpho), repay the *same token* + a bounded premium; a separate aggregator
>   `repaySwap` converts the WBTC proceeds back to debt.
> - **Flash swap** — borrow `debtAsset` from a **Uniswap V3 WBTC/`debtAsset` pool** and
>   repay in **WBTC**, fusing the borrow and the repay leg (no `repaySwap`).
>
> **Pattern (inspired by morpho-blue-liquidation-bot `liquidity-venues`):** pluggable
> sources behind a uniform interface, **selected at runtime** by the planner — but only
> the *off-chain* layer is uniform. The *on-chain* layer is **mode-native**.

## Review outcome (codex / gpt-5.5 — verdict: RETHINK → revised)

The first draft proposed a single on-chain `IFlashLoanVenue` interface. That was
**rejected as leaky**: Aave / Balancer / Morpho / UniV3 differ in callback selector,
repay mechanics (approve-back vs transfer-back), lender identity, and fee model — a
uniform external adapter hides exactly the differences that carry the risk. The
revised design below:

- **on-chain = router-native per-venue callbacks** + a shared `_runFlashLiquidation`
  core, gated by a stored **active-flash context** every callback must match;
- **no separate premium param** — the flash-loan premium is paid in debt, flows into the
  WBTC profit delta, and is backstopped by the profit guard + `repaySwap` bounds +
  repay-or-revert; a `maxPremium` cap is redundant with the guard and was dropped. (The
  flash *swap* keeps `maxWbtcRepay` — that's its swap slippage bound, not a premium cap.)
- **v1 venue set = singletons {Aave, Balancer, Morpho}** — UniV3 dropped (pool
  selection / fee-tier / fake-pool auth is large surface for a rarely-better source);
  this removes opaque `venueData` entirely (a venue **enum** over immutable lender
  addresses suffices);
- **native, not adapter** — borrowed funds land in the router, never an adapter (no
  custody/approval hole).

**Flash swap added back as a distinct *mode* (not a venue).** The review dropped UniV3
as a flash-*loan* venue, and that holds. The **flash-swap** mode is added separately
because it fuses borrow + repay (repays in WBTC, the trade we make anyway), but it is
per-pool, so it carries the review's full hard-constraint set: the pool is **derived
on-chain** from a canonical factory + an allowed fee tier (never a raw pool address),
`borrowToken == debtAsset`, and the callback authenticates `msg.sender == derived pool`.
It is locked to one pool's price (no aggregator routing), so the planner picks it only
when that pool is the cheapest source for the size.

**Unchanged:** the profit guard, debt-spend bound, fairness/swap legs, and the relayer.
The guard is the backstop, but — per the review — allowlisting a venue is an admin
*trust* decision, not a proof, so the callback authentication below is load-bearing.

---

## Diff 1 — §1 Summary (LiquidatorRouter bullet)

```diff
 - **`LiquidatorRouter`** — permissionless-liquidator-only. Batches
   `liquidateWithLLP` across many positions in one tx, optionally Aave-flash-funded,
-  guarded by a single WBTC-delta profit floor plus an on-chain debt-spend bound.
+  optionally flash-funded through an **operator-selected mode** — a flash *loan* from a
+  singleton lender (Aave / Balancer / Morpho) or a flash *swap* from a Uniswap V3
+  WBTC/debt pool — guarded by a single WBTC-delta profit floor plus an on-chain
+  debt-spend bound.
```

## Diff 2 — §2 Constraints (replace the Aave-flash bullet)

```diff
-- Aave v4 provides the flash loan (debt token). `liquidate` (direct redemption) is
-  keeper-gated and out of scope — the arbitrageur batches via sequenced txs.
+- Flash loans differ by **venue**: premium (0% Balancer/Morpho, ~0.05% Aave),
+  callback selector, and repay mechanics (approve-back vs transfer-back) all differ.
+  v1 supports the **singleton** lenders {Aave, Balancer, Morpho}; the operator selects
+  one, the off-chain planner ranks them by premium + liquidity, and the on-chain side
+  runs a **router-native** callback per venue against a bounded premium (§3.3). A second
+  mode, the **flash swap**, sources `debtAsset` from a Uniswap V3 WBTC/`debtAsset` pool
+  and repays in WBTC — fusing the borrow and the repay swap, at the cost of single-pool
+  (non-aggregated) pricing (§3.3). `liquidate` (direct redemption) is keeper-gated and
+  out of scope — the arbitrageur batches via sequenced txs.
```

## Diff 3 — §3.1 Configuration (replace the single `aavePool` immutable)

```diff
-| `aaveAdapter`, `btcVaultSwap` (llp), `aavePool`, `wbtc` | immutable | the protocol surface the router calls; that `llp`/`wbtc` are config is why they aren't per-item inputs |
+| `aaveAdapter`, `btcVaultSwap` (llp), `wbtc` | immutable | the protocol surface the router calls; that `llp`/`wbtc` are config is why they aren't per-item inputs |
+| `aavePool`, `balancerVault`, `morphoSingleton` | immutable | the flash-loan lender singletons; the active one is authenticated as `msg.sender` in its callback (§3.3) |
+| `univ3Factory` | immutable | canonical Uniswap V3 factory; the flash-swap pool is **derived** from it, never passed in (§3.3) |
 | `owner` (Safe) | immutable / 2-step | rescue, approval management, allowlist updates |
 | `operator` | owner | the bot signer authorized to call `batchLiquidate` / `flashLiquidate` / `flashSwapLiquidate` |
 | `assetAllowlist` | owner | debt tokens the router may fund; fee-on-transfer / rebasing tokens excluded |
+| `flashModesEnabled` | owner | which flash-loan venues and which flash-swap fee tiers the operator may select (per-mode kill-switch) |
 | `venueAllowlist` | owner | swap venues a `SwapParams.venue` may name |
 | `approvalCaps` | owner | per-token allowance ceilings to {adapter, venue, active flash lender} — capped, never infinite |
```

## Diff 4 — §3.2 Entry points (venue enum + bounded premium + native callbacks)

```diff
-- `flashLiquidate(debtAsset, orders, allowFailure, profitGuard, fairnessSwap, repaySwap)`
+- `flashLiquidate(debtAsset, venue, orders, allowFailure, profitGuard, fairnessSwap, repaySwap)`
   — the flash token is `debtAsset`; the borrow **amount** is **derived** (not a
   param) as `sum(order.repayAmount) + fairnessSwap.maxIn`. It borrows that, pre-swaps
   a bounded slice to WBTC for the fairness payment, runs the batch, swaps WBTC back to
   repay loan + premium, keeps the residual. `fairnessSwap` and `repaySwap` are
   validated to reference `debtAsset`; `orders` must be non-empty.
+  `venue` is an enum over the **enabled singleton lenders** ({Aave, Balancer, Morpho}).
+  There is **no `maxPremium`**: the premium is paid in debt and flows into the WBTC
+  profit delta, so the profit guard (plus `repaySwap.minOut`, sized off-chain to cover
+  `amount + expected premium`, and repay-or-revert) is the backstop.
+- `flashSwapLiquidate(debtAsset, feeTier, maxWbtcRepay, orders, allowFailure, profitGuard, fairnessSwap)`
+  — the **flash-swap** mode. Same flow minus the `repaySwap`: it derives the pool as
+  `univ3Factory.getPool(WBTC, debtAsset, feeTier)` (reverts if zero or the tier isn't
+  enabled), flash-swaps `sum(order.repayAmount) + fairnessSwap.maxIn` of `debtAsset`
+  out, runs `fairnessSwap` + the batch **inside the pool callback**, then repays the
+  pool in **WBTC** — the owed WBTC (`amountIn`) must be ≤ `maxWbtcRepay` (the swap
+  slippage ceiling for the pool repay). No `repaySwap`; `fairnessSwap` is still required.
```

```diff
-- `executeOperation(asset, amount, premium, initiator, params)` — the Aave callback;
-  callable only by the pool and only while the router's own flash loan is active.
-  `params` is the ABI-encoded batch (orders, guard, swaps).
+- the **per-mode flash callbacks** — `executeOperation` (Aave), `receiveFlashLoan`
+  (Balancer), `onMorphoFlashLoan` (Morpho), and `uniswapV3SwapCallback` (flash swap) —
+  each authenticates against the stored active-flash context (§3.3) and dispatches into
+  one shared `_runFlashLiquidation` core, then repays via that mode's mechanism
+  (approve-back / transfer-back / pay-pool-in-WBTC). `params` is the ABI-encoded batch
+  (orders, guard, swaps), round-tripped through the lender (or held in transient storage).
```

## Diff 5 — new §3.3 Flash funding (insert after Entry points; renumber 3.3→3.4 … 3.6→3.7)

```diff
+### 3.3 Flash funding
+
+Two modes. A **flash loan** from a singleton lender (Aave, Balancer, Morpho — selected
+by the `venue` enum), and a **flash swap** from a Uniswap V3 WBTC/`debtAsset` pool. Both
+run inside the lender's callback; the difference is the repay leg.
+
+**On-chain — router-native, not a uniform adapter.** Each mode has its own native
+callback (different selector, fee model, and repay mechanic), all funnelling into one
+shared `_runFlashLiquidation` core (fairness pre-swap → batch → repay → guard).
+
+**Active-flash context** — a single transient `activeLender` address. `flashLiquidate` /
+`flashSwapLiquidate` require it to be zero, set it to the chosen lender (a configured
+singleton, or the factory-derived flash-swap pool) before borrowing, and clear it after —
+so it doubles as the single-flash / reentrancy guard. The flash callback then
+authenticates with the one check `msg.sender == activeLender` (zero ⇒ no flash open ⇒ a
+stray callback reverts); the batch it executes is carried in the lender's round-tripped
+`data` (or transient storage), not the context. (Aave's `initiator == address(this)` and a
+`keccak(params)` hash are optional defense-in-depth, not load-bearing.) Allowlisting a
+venue is an admin *trust* decision, not a proof — the router is robust against an
+accidentally wrong source, and funds never leave it (no adapter custody, no approvals
+beyond the exact repay).
+
+**Flash-swap pool authentication.** The pool is **derived** as
+`univ3Factory.getPool(WBTC, debtAsset, feeTier)` from the immutable `univ3Factory` —
+never passed as a raw address — with `feeTier` from the enabled set and `borrowToken ==
+debtAsset`. The callback then requires `msg.sender == that derived pool`, which closes
+the fake-pool vector. The repay is the WBTC `amountIn` the pool computes, asserted ≤
+`maxWbtcRepay`; there is no separate `repaySwap`, so the flash swap is locked to that
+single pool's price (the planner only picks it when that pool is the cheapest source).
+
+**Off-chain — `flash-venues` package** (inspired by morpho's `liquidity-venues`): one
+module per source implementing `quote(asset, amount) → { available, costBps, liquidity }`
+— a flash-loan venue's premium, or a flash-swap pool's price impact; a factory registers
+them and the `domain` route planner ranks by lowest all-in cost meeting the size, emitting
+`(venue)` for a flash loan or `(feeTier, maxWbtcRepay)` for a flash swap. The off-chain
+figure is a **quote only** — the on-chain profit guard (and, for a flash swap,
+`maxWbtcRepay`) is the authority.
```

## Diff 6 — §3.6 Invariants (generalize off Aave's callback; add premium bound)

```diff
-- Loan + premium is always fully repaid before settlement; never partial.
-- `executeOperation` is enterable only as the router's own active flash callback.
-- No approval outside the three addresses above; none infinite.
+- The source is always fully repaid before settlement, never partial: a flash loan as
+  `amount + premium` (an unrepayable premium reverts; the premium itself is backstopped
+  by the profit guard); a flash swap as the pool-computed WBTC `amountIn` ≤ `maxWbtcRepay`.
+- A flash callback executes only when the single active-flash context is open and
+  `msg.sender == lender` — where for a flash swap `lender` is the **factory-derived**
+  pool, not a passed address.
+- At most one active-flash context; no nesting, no mode switch, no owner/rescue while
+  open.
+- No approval outside {adapter, swap venue, the active flash lender}; none infinite;
+  any flash-loan approval is exactly the repay amount and is reset after (a flash swap
+  repays by transfer, no approval).
```

## Diff 7 — §5 Threat model (add a venue-integration bullet)

```diff
+- **Flash-source integration** — flash loans and the flash swap differ in callback and
+  repay model, so each is a native handler, not a normalized one. The router is built to
+  be safe against an **accidentally wrong** source: callbacks authenticate
+  `msg.sender == lender` (or, for a flash swap, the **factory-derived** pool — closing
+  the fake-pool vector), the repay is bounded (`repaySwap` slippage / `maxWbtcRepay`) and
+  the premium backstopped by the profit guard, funds are
+  never held by an adapter, and approvals are only the exact repay. A **fully malicious**
+  allowlisted lender that receives custody cannot be defended — hence native callbacks
+  and per-source audited handlers. The profit guard remains the economic backstop
+  regardless of source.
```

## Diff 8 — §7 Open items (replace the Aave-premium item; add venue items)

```diff
-- Aave v4 flash-loan premium specifics (token, rounding, fee-change handling,
-  insufficient-post-swap-debt path).
+- Per-venue flash specifics for {Aave, Balancer, Morpho}: exact callback signature,
+  fee read, repay mechanic (Aave/Morpho approve-back, Balancer transfer-back), and the
+  insufficient-post-swap-debt path. (Native callbacks vs external adapters is
+  **resolved: native** — adapters add a custody/approval hole.)
+- UniV3 flash *loan* (`pool.flash`, repaying the *same* token) is **not** added — the
+  flash-*swap* mode already covers Uniswap as a source and repays in WBTC, which is the
+  trade we make anyway, so a same-token UniV3 flash loan would be redundant.
+- Flash-swap specifics to pin down: V3 exact-output `swap` vs `flash` semantics, the
+  `feeTier` enabled set, and behavior when the WBTC/`debtAsset` pool is too thin (the
+  `maxWbtcRepay` bound reverts, but the planner should avoid selecting it).
```

## Diff 9 — §8 Method & data reference (flashLiquidate params + flashSwapLiquidate)

```diff
-| `flashLiquidate` | `address debtAsset`, `Order[] orders`, `bool allowFailure`, `ProfitGuard guard`, `SwapParams fairnessSwap`, `SwapParams repaySwap` (borrow amount derived from `orders`) |
+| `flashLiquidate` | `address debtAsset`, `Venue venue`, `Order[] orders`, `bool allowFailure`, `ProfitGuard guard`, `SwapParams fairnessSwap`, `SwapParams repaySwap` (borrow amount derived from `orders`; premium backstopped by the profit guard, no `maxPremium`) |
+| `flashSwapLiquidate` | `address debtAsset`, `uint24 feeTier`, `uint256 maxWbtcRepay`, `Order[] orders`, `bool allowFailure`, `ProfitGuard guard`, `SwapParams fairnessSwap` (no `repaySwap`; pool derived from `univ3Factory`; WBTC repay bounded by `maxWbtcRepay`) |
```

```diff
+| `Venue` | enum `{ Aave, Balancer, Morpho }` — selects a configured singleton lender (no opaque `venueData`) |
```

---

## Why these are *all* the touch points

| RFC location | Change | Kind |
|--------------|--------|------|
| §1 / §2 | Aave-only → two operator-selected modes (flash loan / flash swap) | framing |
| §3.1 | lender singletons + `univ3Factory` + `flashModesEnabled` | config |
| §3.2 | `flashLiquidate` gains `venue` (no `maxPremium`); new `flashSwapLiquidate`; native callbacks | signature |
| §3.3 (new) | router-native callbacks + active-flash context + pool derivation + off-chain selector | **new abstraction** |
| §3.6 | invariants: callback `== lender`/derived-pool, repay bounded, single context | invariants |
| §5 / §7 | mode-integration threat; per-mode open items | risk |
| §8 | `flashLiquidate` + `flashSwapLiquidate` params, `Venue` enum | reference |

Each source is authenticated on-chain (`msg.sender == lender`, or the factory-derived
pool); the flash swap is slippage-bounded by `maxWbtcRepay`, and the profit guard is the
economic backstop for both modes (which is why the flash loan needs no `maxPremium`). The off-chain selector stays uniform and pluggable; the on-chain side stays
explicit and mode-native.
