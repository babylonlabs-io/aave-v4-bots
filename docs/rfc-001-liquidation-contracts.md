# RFC-001 — Liquidation contracts: `LiquidatorRouter` & `LiquidationRelayer`

> Status: Draft. Pins down the two custody-critical contracts deferred from the
> [architecture proposal](./production-architecture-proposal.md) §5.3/§5.4 and the
> [relayer addendum](./production-architecture-relayer-addendum.md) §5.16.

## 1. Summary

Two contracts, audited as one body of work because they share an approval surface
and a single accounting core:

- **`LiquidatorRouter`** — permissionless-liquidator-only. Batches
  `liquidateWithLLP` across many positions in one tx, optionally Aave-flash-funded,
  guarded by a single WBTC-delta profit floor plus an on-chain debt-spend bound.
- **`LiquidationRelayer`** — third-party capital via an on-chain policy + allowance
  (Model A). **Custody-safe, not economically-trustless**: a leaked relayer key
  cannot steal, redirect, over-pull, or fund off-policy assets, but can force
  policy-compliant low-value executions. Ships operator-run; a genuinely external
  relayer escalates to per-intent provider signatures (Model B).

## 2. Constraints that drive the design

- `AaveAdapter.liquidateWithLLP` repays debt (pulling exactly `amounts[i]` per
  reserve from `msg.sender`) and routes the seized vault to `BTCVaultSwap`, which has
  the Hub draw WBTC **directly to the caller** at a sell discount. It separately
  pulls a **WBTC fairness payment** from `msg.sender` (paid to the borrower to
  compensate excess seized BTC) — **conditional**: non-zero only when the liquidation
  leaves excess fair value, so it can be 0. That payment is **not** a call argument,
  so it can't be capped by a parameter — bound it by measuring the caller's WBTC
  balance delta around each item. *(Verified against `vault-contracts-aave-v4`.)*
- The LLP path is therefore **not** purely WBTC-positive: when a fairness payment is
  due, the caller needs both the debt token (repay) and WBTC. Profit, premium, and
  fairness payment span multiple assets — single-token accounting mismeasures it.
- The adapter pulls from `msg.sender`, so batching needs a funded router; Multicall3
  cannot carry the caller's funds.
- Liquidation can be partial/incremental, so a stale item may seize fewer shares
  than estimated yet still not revert.
- Aave v4 provides the flash loan (debt token). `liquidate` (direct redemption) is
  keeper-gated and out of scope — the arbitrageur batches via sequenced txs.

## 3. `LiquidatorRouter`

### 3.1 Configuration

Set at deploy (immutable) or by the owner; never passed per call.

| Config | Set by | Purpose |
|--------|--------|---------|
| `aaveAdapter`, `btcVaultSwap` (llp), `aavePool`, `wbtc` | immutable | the protocol surface the router calls; that `llp`/`wbtc` are config is why they aren't per-item inputs |
| `owner` (Safe) | immutable / 2-step | rescue, approval management, allowlist updates |
| `operator` | owner | the bot signer authorized to call `batchLiquidate` / `flashLiquidate` |
| `assetAllowlist` | owner | debt tokens the router may fund; fee-on-transfer / rebasing tokens excluded |
| `venueAllowlist` | owner | swap venues a `SwapParams.venue` may name |
| `approvalCaps` | owner | per-token allowance ceilings to {adapter, venue, pool} — capped, never infinite |

### 3.2 Entry points

- `batchLiquidate(debtAsset, orders, allowFailure, profitGuard)` — self-funded;
  the router already holds/approves `debtAsset` and a WBTC working float.
- `flashLiquidate(debtAsset, orders, allowFailure, profitGuard, fairnessSwap, repaySwap)`
  — the flash token is `debtAsset`; the borrow **amount** is **derived** (not a
  param) as `sum(order.repayAmount) + fairnessSwap.maxIn`. It borrows that, pre-swaps
  a bounded slice to WBTC for the fairness payment, runs the batch, swaps WBTC back to
  repay loan + premium, keeps the residual. `fairnessSwap` and `repaySwap` are
  validated to reference `debtAsset`; `orders` must be non-empty.

Both router batches are **single-token** — one `debtAsset` per call; a cycle
spanning multiple debt tokens is emitted as one batch per token by the off-chain
planner (there is no need for cross-token atomic netting). The relayer differs: its
`liquidate(intents)` takes *independent* intents, so the asset is per-intent (§4.5).
- `executeOperation(asset, amount, premium, initiator, params)` — the Aave callback;
  callable only by the pool and only while the router's own flash loan is active.
  `params` is the ABI-encoded batch (orders, guard, swaps).

Both user entry points are `onlyOperator` and `nonReentrant`.

`llp` and reserve ordering are **contract config, not inputs**: `llp` is an
immutable `BTCVaultSwap`, the payout is always WBTC (enforced by measuring WBTC
received), and ordering is identity, derived on-chain. `debtAsset` is a batch-level
param and the order carries a scalar `repayAmount`; the router builds the adapter's
positional `amounts` / `priorityOrder` calldata internally, so **no anonymous
per-reserve array is ever passed in**.

### 3.3 Per-item order fields

| Field | Purpose |
|-------|---------|
| `borrower` | the position |
| `repayAmount` | amount of the batch's `debtAsset` to repay; the router constructs the adapter's per-reserve calldata from it |
| `maxFairnessWbtc` | per-item ceiling on the WBTC fairness payment (measured balance delta) — caps gross WBTC exposure |
| `minWbtcOut` | per-item floor on WBTC received — the partial-fill guard |

The two WBTC fields exist **only** to make `allowFailure` useful — they isolate a
bad-but-non-reverting item; with an always-atomic batch they'd be redundant with
the guard. (A single net-WBTC floor — `received − topUp` — was considered; two
explicit fields read clearer and separate gross-exposure from fill-quality.)

The flash path's two swaps (`fairnessSwap`: debt→WBTC, funds the fairness payment;
`repaySwap`: WBTC→debt, repays the loan) take `SwapParams`:

| Field | Purpose |
|-------|---------|
| `venue` | the DEX/router to call — must be on the `venueAllowlist` (§3.1) |
| `swapData` | venue-specific route / calldata, computed off-chain |
| `maxIn` | input ceiling — enforced by the router's measured balance delta, not the venue |
| `minOut` | output floor — enforced by the router's measured balance delta, not the venue |

### 3.4 Profit guard

Both paths share one guard, **`ProfitGuard { minWbtcProfit }`**, which reverts a
batch that settles unprofitably (off-chain simulation is not a guarantee against
landing in a different state). It is enforced as the realized **WBTC balance delta**
— snapshot before/after, excluding pre-existing inventory — which must be ≥
`minWbtcProfit`. On the self-funded path that delta doesn't price the debt spent from
inventory, so `minWbtcProfit` is set off-chain to `value(debt spent) + margin`, held
sound by the on-chain debt-spend bound (§3.6).

### 3.5 Approvals & access

Approvals follow `approvalCaps` (§3.1) — only to {adapter, venue, pool}, capped,
never infinite, with an allowance manager and emergency revoke. Entry points are
`operator`-gated; rescue and any owner action are **locked out during active
execution** (a flash loan or batch in flight).

### 3.6 Invariants

- A reverting batch leaves router balances unchanged (modulo gas).
- On success, the WBTC balance delta ≥ `minWbtcProfit`, excluding pre-existing
  inventory.
- The `debtAsset` consumed by a batch ≤ `sum(order.repayAmount)`, and no other token
  is pulled (the over-pull guard the single-token profit floor depends on).
- Loan + premium is always fully repaid before settlement; never partial.
- `executeOperation` is enterable only as the router's own active flash callback.
- No approval outside the three addresses above; none infinite.
- Every funded asset is on the allowlist; fee-on-transfer and rebasing tokens are
  rejected.

## 4. `LiquidationRelayer` (Model A)

### 4.1 Configuration

| Config | Set by | Purpose |
|--------|--------|---------|
| `aaveAdapter`, `btcVaultSwap` (llp), `wbtc` | immutable | the protocol surface; `wbtc` is the proceeds / profit numeraire |
| `owner` (Safe) | immutable / 2-step | thin admin — the relayer custodies nothing |
| `assetAllowlist` | owner | debt tokens that may be funded; fee-on-transfer / rebasing excluded |
| `liquidateOpen` | owner | whether `liquidate` is callable by anyone or `operator`-gated — custody is safe either way |

The relayer is intentionally thin: it holds no user funds, so its config is just
the protocol addresses + the funded-asset allowlist. **Per-provider limits are not
config** — providers register them per asset via `setPolicy` (§4.4).

### 4.2 Entry points

- `setPolicy(asset, policy)` / `revokePolicy(asset)` — the provider registers or
  clears their own per-`asset` policy (§4.4).
- `liquidate(intents)` — `nonReentrant`; pulls capital from each intent's provider,
  runs `liquidateWithLLP`, and routes **100% of proceeds back to the provider** (no
  relayer tip). Intents are atomic per-intent (no `allowFailure`). Per `liquidateOpen`
  (§4.1) it is callable by anyone or `operator`-gated — custody is safe either way.

### 4.3 Property

- **Custody-safe (guaranteed):** a leaked relayer key cannot steal funds, redirect
  proceeds, exceed caps, fund off-policy assets, or act past a revoked/expired
  policy.
- **Not economically-trustless:** the key can force policy-compliant, low-value
  liquidations — consuming allowance, locking capital, imposing the provider's
  opportunity cost and inventory risk. The contract cannot know the provider's
  better alternatives.
- **Damage is bounded on-chain** by the policy below and, above all, by the
  **ERC-20 allowance** the provider sizes to a working budget and can revoke
  instantly — off-chain reservation is not a bound (a leaked key bypasses it).
- **Operating policy:** the relayer route submits through the private relay (§5.7
  L0); public-mempool submission violates operating policy (it reopens the
  repay-swap sandwich vector) but cannot be proven on-chain.
- **Operator-run vs external:** the default operator-run case treats a leaked relayer
  key as an operator hot-key leak, bounded as above. An economically-airtight
  guarantee for a genuinely external relayer requires Model B (per-intent provider
  signatures) — the documented escalation.

### 4.4 Provider policy — keyed per asset

`setPolicy(asset, policy)` / `revokePolicy(asset)`, called by the provider for
their own address. Keying policy by `(provider, asset)` makes every cap live in
that asset's own units — no cross-token scalar ambiguity — and removes a separate
`approvedAssets` list: an asset is fundable iff it has a policy **and** a non-zero
allowance.

`AssetPolicy`:

| Field | Purpose |
|-------|---------|
| `maxPerPosition` | cap on capital pulled per liquidation, in the asset's units |
| `minWbtcProfit` | **absolute**, in WBTC, net of expected gas — not just bps |
| `maxFeePerGas` | gas ceiling |
| `expiry` | auto-expiry; `revokePolicy(asset)` is the kill-switch |

The **cap and rate control are both the ERC-20 allowance** the provider grants for
`asset` — sized to a working budget and refreshed on their own cadence (the refresh
cadence is the de-facto epoch), so there is no `totalCap` or on-chain
epoch/rate-limit field. An automated on-chain rate limit is only needed for a
**passive** external provider who wants to set-and-forget a large allowance — part
of the institutional / Model-B escalation, not v1.

### 4.5 Intent fields & enforcement

`Intent`:

| Field | Purpose |
|-------|---------|
| `provider` | whose policy and capital fund the liquidation |
| `borrower` | the position to liquidate |
| `debtAsset` | the debt token repaid; selects the `(provider, debtAsset)` policy + allowance |
| `repayAmount` | amount of `debtAsset` to repay |
| `deadlineBlock` | block-based expiry — a stale / toxic intent reverts |

`llp`, payout token, and ordering are contract config as in the router; the profit
floor lives in the policy, not the intent.

Per intent the contract enforces: an active/unexpired policy exists for
`(provider, debtAsset)`; `block.number ≤ deadlineBlock`; gas ceiling; pulled
capital ≤ `maxPerPosition` and ≤ remaining allowance for `debtAsset`; and absolute
`minWbtcProfit` on the measured provider balance delta.

### 4.6 Cap & reservation

The ERC-20 allowance is the final standing authority and is consumed as pulled
(standard semantics) — the provider re-ups on their cadence. The off-chain
`capital` module reserves against the remaining allowance only to avoid wasted gas;
it is **not** a bound (a leaked key bypasses it), which is why the allowance, not
the reservation, is the on-chain cap.

### 4.7 Safe-module variant

Implement as a Safe module when the provider is institutional and already on Safe
(smaller custody novelty, audited base) — with explicit audit scope for module
reentrancy, fallback handlers, guard compatibility, and owner front-running of
policy changes mid-execution. Do not ship a generic bespoke allowance relayer for
unknown external relayers unless intents are signed (Model B).

### 4.8 Invariants

- Proceeds of every executed intent land at the intent's provider; the relayer's
  balance never increases.
- Cumulative capital pulled ≤ the ERC-20 allowance for that asset.
- An intent with no active policy for `(provider, debtAsset)`, below
  `minWbtcProfit`, past `deadlineBlock`, or over the gas ceiling, reverts.
- A revoked or expired policy funds nothing.

## 5. Threat model

- **Stale / partial liquidations** — atomicity is not safety; the on-chain bounds
  (`minWbtcOut`, `maxFairnessWbtc`, `minWbtcProfit`) must revert rather than lose.
  Off-chain re-simulation is secondary.
- **Multi-asset mismeasurement** — the single biggest correctness risk; one shared,
  audited accounting core.
- **Reentrancy** — the LLP swap and Aave callback are reentrancy surfaces:
  `nonReentrant`, checks-effects-interactions, no rescue/owner action during active
  execution.
- **Token weirdness** — allowlist funded assets; reject fee-on-transfer and rebasing;
  measure actual amounts received.
- **Swap manipulation / MEV** — `maxIn`/`minOut` enforced by the router's own
  balance delta on every swap; private-relay submission; optional oracle sanity
  bound on the venue.
- **Gas-policy abuse (relayer)** — `maxFeePerGas` bounds the gas price but not an
  explicit builder bribe / coinbase transfer; that residual must be enforced in the
  submitter stack.
- **Provider inventory risk (relayer)** — even profitable liquidations can leave the
  provider holding unwanted exposure; acceptable for operator-run Model A only as an
  explicit policy choice (a per-`asset` policy + that asset's allowance + absolute
  `minWbtcProfit`).

## 6. Testing

- Fork tests against mainnet state for every route and revert path, including
  partial fills and fee-on-transfer rejection.
- Invariant tests over the multi-asset ledger as the core property.
- Bundle/trace simulation (not just `eth_call`) before broadcast.

## 7. Open items

- The gas-cost basis for `minWbtcProfit` (the contract can't see real gas — needs a
  conservative off-chain figure plus meaningful on-chain gas bounds).
- Aave v4 flash-loan premium specifics (token, rounding, fee-change handling,
  insufficient-post-swap-debt path).
- **Adapter debt-pull semantics — the guard collapse depends on this.** The
  single-token profit floor (§3.4) is sound only if the adapter pulls **at most**
  `sum(order.repayAmount)` of `debtAsset` and **no other token**. Confirm
  `liquidateWithLLP` cannot pull more than the constructed `amounts`, and confirm how
  a multi-debt-reserve position maps to the scalar `repayAmount` — if partial
  multi-reserve repayment is required, the order needs a small `(reserve, amount)[]`
  and the over-pull invariant must sum across them.

## 8. Method & data reference

The minimal, polished parameter set (no anonymous positional arrays; profit always
WBTC-denominated; policy keyed per asset).

**`LiquidatorRouter`**

| Method | Parameters |
|--------|-----------|
| `batchLiquidate` | `address debtAsset`, `Order[] orders`, `bool allowFailure`, `ProfitGuard guard` |
| `flashLiquidate` | `address debtAsset`, `Order[] orders`, `bool allowFailure`, `ProfitGuard guard`, `SwapParams fairnessSwap`, `SwapParams repaySwap` (borrow amount derived from `orders`) |
| `executeOperation` | `address asset`, `uint256 amount`, `uint256 premium`, `address initiator`, `bytes params` (pool-only callback) |

**`LiquidationRelayer`**

| Method | Parameters |
|--------|-----------|
| `setPolicy` | `address asset`, `AssetPolicy policy` |
| `revokePolicy` | `address asset` |
| `liquidate` | `Intent[] intents` |

**Structs**

| Struct | Fields |
|--------|--------|
| `Order` | `borrower`, `repayAmount`, `maxFairnessWbtc`, `minWbtcOut` |
| `Intent` | `provider`, `borrower`, `debtAsset`, `repayAmount`, `deadlineBlock` |
| `AssetPolicy` | `maxPerPosition`, `minWbtcProfit`, `maxFeePerGas`, `expiry` |
| `ProfitGuard` | `minWbtcProfit` |
| `SwapParams` | `venue`, `swapData`, `maxIn`, `minOut` (`venue` allowlisted; `maxIn`/`minOut` enforced by the router's own balance delta) |
