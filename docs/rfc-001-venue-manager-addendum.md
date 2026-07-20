# RFC-001 Addendum (proposed diffs) — extract flash funding into `VenueManager`

> Layers on the [multi-venue flash-funding addendum](./rfc-001-flash-venues-addendum.md).
> That addendum made the router multi-venue but left **all** the flash plumbing inside
> `LiquidatorRouter`: four venue callbacks (`executeOperation`, `receiveFlashLoan`,
> `onMorphoFlashLoan`, `uniswapV3SwapCallback`), the lender/pool immutables, the
> active-flash context, the UniV3 pool derivation, and four repay mechanics — all mixed
> with the router's actual job (batch liquidation + profit guard). The router now does
> two unrelated things: **sourcing funds** and **using them**.
>
> This addendum extracts the *sourcing* into a dedicated **`VenueManager`** that
> implements solely the flash-funding logic, leaving `LiquidatorRouter` to the
> liquidation batch + guard. Not yet applied to
> [rfc-001](./rfc-001-liquidation-contracts.md).

## Review outcome (codex / gpt-5.5 — verdict: REVISE → applied below)

The core decision (abstract base, standalone rejected) was **confirmed sound**. The
seam was tightened per the review:

- **The base owns the repay obligation, not the hook.** The lender/pool defines
  `owed`; the base computes and enforces it. `_onFlashFunds` **returns nothing** — it
  only uses the funds and must leave `≥ owed` of the repay asset; the base then asserts
  `balanceOf(repayAsset) >= owed` and repays exactly `owed`. (Was: hook returns
  `(debtRepay|wbtcRepay)` — rejected as inviting wrong-leg / under-repay.)
- **Profit guard runs *after* repayment** (or explicitly net of `owed`), never before.
- **Active-flash context binds the whole operation** — `{kind, lenderOrPool,
  borrowAsset, amount, repayAsset, owed, dataHash?}` — not just `activeLender`.
- **Router gating is unchanged, not replaced** — `activeLender` stops *nested flash*
  only; the router's `nonReentrant` / active-execution lockout on entry points, rescue,
  approvals and owner actions (base RFC §3.5) still stands.
- Softened "zero attack surface" → "no new **custody** boundary"; single UniV3 auth
  rule (store the derived pool *as* `activeLender`); `data` round-tripped by default,
  transient storage for the compact context only. Naming (`FlashFunderBase`?) left as an
  open item.

## The clog, concretely

Everything the flash-venues addendum added lands in one file:

| In the router today (post flash-venues) | Concern |
|---|---|
| `Venue` enum; `aavePool` / `balancerVault` / `morphoSingleton` / `univ3Factory` immutables; `flashModesEnabled` | fund sourcing |
| active-flash context (`activeLender`) + single-flash/reentrancy guard | fund sourcing |
| `executeOperation` / `receiveFlashLoan` / `onMorphoFlashLoan` / `uniswapV3SwapCallback` | fund sourcing |
| UniV3 pool derivation + fee-tier check; per-venue repay (approve-back / transfer-back / pay-WBTC) | fund sourcing |
| `batchLiquidate`, order → adapter calldata, fairness/repay swaps, `ProfitGuard`, allowlists | **liquidation** |

Four of five rows are *how we borrow*, not *what we liquidate*. They belong behind a seam.

## Design — `VenueManager` as an abstract base, `LiquidatorRouter is VenueManager`

**`VenueManager` (abstract) owns fund-sourcing, and nothing else:**
- venue config: the `Venue` enum, the lender singletons, `univ3Factory`, `flashModesEnabled`, the enabled fee tiers;
- the **active-flash context** (single `activeLender`) — set on borrow, cleared after, doubling as the one-flash reentrancy guard;
- the **four native callbacks**, each authenticating `msg.sender == activeLender` (or, for the flash swap, the factory-**derived** pool), decoding the round-tripped batch `data`, invoking the hook, then repaying via that venue's native mechanic;
- the UniV3 pool derivation (`getPool(WBTC, debtAsset, feeTier)`);
- two internal initiators the router calls: `_flashLoan(venue, asset, amount, data)` and `_flashSwap(feeTier, asset, amount, maxWbtcRepay, data)`.

**`LiquidatorRouter is VenueManager` — now only the liquidation:**
- `batchLiquidate` (self-funded), plus `flashLiquidate` / `flashSwapLiquidate` reduced to *validate → derive amount → call the initiator*;
- one hook, `_onFlashFunds(...)`, which the base calls once the borrowed funds are in hand: fairness pre-swap → batch (`liquidateWithLLP` loop) → (loan mode) `repaySwap`. It **leaves ≥ `owed` of the repay asset** in the contract and **returns nothing** — the base (which owns the lender relationship) computes `owed`, asserts the balance, repays, and only then is the profit guard evaluated;
- orders → adapter calldata, `ProfitGuard`, allowlists, approvals, rescue, config admin.

The obligation flows **lender → base**, never through the hook: the base knows `kind`,
`asset`, and the lender-computed `owed`, so it must not trust a hook-supplied amount
(that would allow a wrong-leg or under-repay). The hook's only contract is "use the
funds, leave enough."

The router file no longer mentions a single venue callback or lender — it reads as
"batch these liquidations under a profit guard, funded by *some* flash source the base
provides."

## Why a base contract, **not** a separately-deployed `VenueManager`

This is the load-bearing decision, and it follows directly from the flash-venues
addendum's own hard constraint: *"borrowed funds land in the router, never an adapter
(no custody/approval hole)"* and *"funds never leave it."*

A flash lender **calls back the address that initiated the loan, and the borrowed funds
land there.** So if `VenueManager` were a separate deployed contract that initiates the
borrow, the funds would land in `VenueManager`, and to run the batch it would have to
either (a) hold the funds and call back into the router — custody + a fresh
cross-contract reentrancy surface — or (b) forward the funds to the router under an
approval — an approval hole. **Both are exactly the adapter pattern the review
rejected.** A separately-deployed manager cannot host the callbacks without becoming a
custody boundary.

An **abstract base contract** avoids all of it: `LiquidatorRouter is VenueManager` is
**one deployed contract**. `address(this)` in every callback *is* the router; the
borrowed funds stay in the router; there are no new approvals, no cross-contract auth,
no reentrancy seam. The extraction is purely **source-level** — the venue callbacks live
in `VenueManager.sol`, the deployed bytecode and the security model are unchanged. This
is the standard Solidity idiom for separating a callback-driven concern without adding a
trust boundary (cf. base-contract mixins in Morpho's bundler, OpenZeppelin bases).

> **Lower-abstraction alternative — router-initiates + stateless venue libraries.**
> Keep the flash *initiation* and the four *external callbacks* on the router (they must
> live on the final deployed contract regardless), but factor the venue-specific
> *pure/stateless* parts — pool derivation, calldata encoding, per-venue `owed`/repay
> math — into `internal`/`library` helpers (`AaveVenue`, `BalancerVenue`, …). This also
> declutters the router and adds no boundary, but it leaves the callback *shells* on the
> router, so the router file still carries four `external` entry points. The base-contract
> split is preferred because it moves the callbacks off the router entirely; the library
> cut is the fallback if inheritance depth becomes a concern.
>
> **Alternative, if independent deploy/upgrade of venues is a hard requirement:** a
> standalone `VenueManager` is possible only by accepting the custody boundary and
> pinning it shut — `VenueManager` callable only by the router, its callbacks re-checking
> the router as the sole initiator, funds swept back atomically within the same tx, and a
> re-audit of the two-contract reentrancy graph. That reintroduces the surface this RFC
> spent its threat model closing, for the sole benefit of swapping venues without
> redeploying the router. **Not recommended.** The base-contract split already isolates
> the venue code; adding a venue is a router redeploy either way (immutables), which the
> Safe-owned lifecycle already assumes.

## The seam (representative Solidity)

```solidity
// VenueManager.sol  (abstract) — sourcing only
abstract contract VenueManager {
    enum Venue { Aave, Balancer, Morpho }          // singleton flash-LOAN lenders
    enum FlashKind { Loan, Swap }

    // The whole active operation, in transient storage — authenticates *what* is being
    // completed, not just who called. Compact: the batch payload rides the lender `data`.
    struct Flash { FlashKind kind; address lenderOrPool; address borrowAsset;
                   uint256 amount; address repayAsset; uint256 owed; bytes32 dataHash; }
    Flash private transient active;                 // zero ⇒ no flash open (also the nested-flash guard)

    // immutables: aavePool, balancerVault, morphoSingleton, univ3Factory, wbtc
    // called by the router's entry points: set `active`, borrow, clear after.
    function _flashLoan(Venue v, address asset, uint256 amount, bytes memory data) internal { … }
    function _flashSwap(uint24 feeTier, address asset, uint256 amount, uint256 maxWbtcRepay, bytes memory data) internal { … }

    // the four native callbacks — each: require(msg.sender == active.lenderOrPool) and the
    // rest of `active` matches; decode `data` (hash-checked); call the hook; then the BASE
    // computes/asserts `owed` and repays via this venue's mechanic; guard runs after.
    function executeOperation(...) external { … }        // Aave  → approve-back
    function receiveFlashLoan(...) external { … }        // Balancer → transfer-back
    function onMorphoFlashLoan(...) external { … }       // Morpho → approve-back
    function uniswapV3SwapCallback(...) external { … }   // flash swap → pay pool in WBTC

    // implemented by the router: USE the funds and leave ≥ `owed` of `repayAsset`.
    // Returns nothing — the base owns the obligation and the repay.
    function _onFlashFunds(FlashKind kind, address borrowAsset, uint256 borrowed,
                           address repayAsset, uint256 owed, bytes memory data) internal virtual;
}

// LiquidatorRouter.sol — liquidation only
contract LiquidatorRouter is VenueManager {
    function flashLiquidate(address debtAsset, Venue venue, Order[] calldata orders, …) external onlyOperator nonReentrant {
        // validate; amount = sum(repayAmount) + fairnessSwap.maxIn
        _flashLoan(venue, debtAsset, amount, abi.encode(orders, guard, fairnessSwap, repaySwap));
    }
    function flashSwapLiquidate(address debtAsset, uint24 feeTier, uint256 maxWbtcRepay, Order[] calldata orders, …) external onlyOperator nonReentrant {
        _flashSwap(feeTier, debtAsset, amount, maxWbtcRepay, abi.encode(orders, guard, fairnessSwap));
    }
    function _onFlashFunds(FlashKind kind, address borrowAsset, uint256 borrowed,
                           address repayAsset, uint256 owed, bytes memory data) internal override
    { /* fairness pre-swap → batch → (Loan) repaySwap; leave ≥ owed of repayAsset. */ }
}
```

Control flow inside a callback: authenticate `active` → call `_onFlashFunds` (hook uses
funds, leaves `≥ owed`) → base asserts `balanceOf(repayAsset) >= owed` and repays exactly
`owed` → base evaluates the profit guard (WBTC delta, now *net* of the repayment) → clear
`active`. The base never touches liquidation; the router never touches a lender or defines
the obligation. One contract, funds never move.

---

## Diff A — §1 Summary (name the two contracts)

```diff
 - **`LiquidatorRouter`** — permissionless-liquidator-only. Batches
   `liquidateWithLLP` across many positions in one tx, optionally flash-funded through an
   operator-selected mode … guarded by a single WBTC-delta profit floor plus an on-chain
-  debt-spend bound.
+  debt-spend bound. Flash **sourcing** (per-venue borrow + callback + repay) is factored
+  into an abstract **`VenueManager`** base the router inherits, so the router carries only
+  the liquidation batch + guard (§3.3).
```

## Diff B — §3.1 Configuration (split ownership across the base and the router)

```diff
+**`VenueManager` (base) config — fund sourcing:**
+
+| Config | Set by | Purpose |
+|--------|--------|---------|
+| `aavePool`, `balancerVault`, `morphoSingleton` | immutable | flash-loan lender singletons; the active one is authenticated as `msg.sender` in its callback |
+| `univ3Factory`, `wbtc` | immutable | flash-swap pool is **derived** from the factory; WBTC is the swap repay asset |
+| `flashModesEnabled` | owner | enabled flash-loan venues + flash-swap fee tiers (per-mode kill-switch) |
+
+**`LiquidatorRouter` config — liquidation:**
+
 | `aaveAdapter`, `btcVaultSwap` (llp), `wbtc` | immutable | the protocol surface the router calls |
 | `owner` (Safe) | immutable / 2-step | rescue, approval management, allowlist updates |
 | `operator` | owner | the bot signer authorized to call `batchLiquidate` / `flashLiquidate` / `flashSwapLiquidate` |
 | `assetAllowlist` | owner | debt tokens the router may fund |
 | `venueAllowlist` | owner | swap venues a `SwapParams.venue` may name |
 | `approvalCaps` | owner | per-token allowance ceilings to {adapter, swap venue, active flash lender} — capped, never infinite |
```

## Diff C — §3.2 Entry points (router entry points get thin; callbacks leave)

```diff
 - `flashLiquidate(debtAsset, venue, orders, allowFailure, profitGuard, fairnessSwap, repaySwap)`
-  — … runs the batch, swaps WBTC back to repay loan + premium, keeps the residual.
+  — validates, derives the borrow amount (`sum(order.repayAmount) + fairnessSwap.maxIn`),
+  and calls the base `_flashLoan(venue, debtAsset, amount, data)`. The batch + swaps + guard
+  run in the router's `_onFlashFunds` hook the base invokes once funds land; the base repays.
 - `flashSwapLiquidate(debtAsset, feeTier, maxWbtcRepay, orders, allowFailure, profitGuard, fairnessSwap)`
-  — … repays the pool in WBTC …
+  — same shape via the base `_flashSwap(...)`; the WBTC pool repay (≤ `maxWbtcRepay`) is the
+  base's job, the batch is the hook's.
-- the **per-mode flash callbacks** — `executeOperation` (Aave), `receiveFlashLoan`
-  (Balancer), `onMorphoFlashLoan` (Morpho), and `uniswapV3SwapCallback` (flash swap) —
-  each authenticates … and dispatches into one shared `_runFlashLiquidation` core …
+- the **per-mode flash callbacks** live on the **`VenueManager` base**, not the router
+  (§3.3): each authenticates the active-flash context, calls the router's `_onFlashFunds`
+  hook, then repays via that venue's native mechanic. The router implements the hook; it
+  never sees a lender or a selector.
```

## Diff D — replace the flash-venues §3.3 "Flash funding" with §3.3 "`VenueManager` (flash funding)"

```diff
-### 3.3 Flash funding
-…router-native callbacks funnelling into one shared `_runFlashLiquidation` core…
+### 3.3 `VenueManager` — flash funding (abstract base)
+
+All fund-sourcing lives in an abstract **`VenueManager`** that `LiquidatorRouter`
+**inherits** — one deployed contract, so borrowed funds stay in the router and no
+custody/approval boundary is introduced (a *separately deployed* manager would receive
+the loan and become the adapter the review rejected — see the addendum's rationale).
+
+**The base owns:** the `Venue` enum, the lender singletons + `univ3Factory`, the
+`activeLender` transient context (also the single-flash reentrancy guard), the four
+native callbacks (Aave/Balancer/Morpho + UniV3 flash swap), UniV3 pool derivation, and
+the per-venue repay mechanic (approve-back / transfer-back / pay-pool-in-WBTC). It
+exposes `_flashLoan` / `_flashSwap` initiators and calls the router back through one
+`_onFlashFunds` hook.
+
+**The router owns:** `_onFlashFunds` (fairness pre-swap → batch → repaySwap for the loan
+mode), which uses the funds and **leaves ≥ `owed` of the repay asset** — it returns
+nothing. The **base** computes `owed` from the lender/pool, asserts the balance, repays,
+**then** evaluates the profit guard (WBTC delta net of the repayment). The base holds the
+lender relationship and the obligation; the router holds the swaps + liquidation. Neither
+reaches into the other's concern, and a hook can never define its own repay.
+
+**Active-flash context** now binds the whole operation — `{kind, lenderOrPool,
+borrowAsset, amount, repayAsset, owed, dataHash}` in transient storage — so a callback
+authenticates *what* it is completing, not just the caller. **Pool authentication** is one
+rule: `_flashSwap` derives the pool and stores it *as* `lenderOrPool`, and the callback
+requires `msg.sender == active.lenderOrPool` (no "or derived pool" special case). The
+off-chain `flash-venues` selector is unchanged; it simply now feeds the base.
```

## Diff E — §3.6 Invariants (add the base/router boundary)

```diff
+- Flash **sourcing** is confined to the `VenueManager` base and flash **use** to the
+  router; the only interface between them is the internal `_onFlashFunds` hook and the
+  `_flashLoan`/`_flashSwap` initiators — no external call, no token custody boundary
+  (they are the same deployed contract).
+- The **repay obligation is base-owned**: `owed` is computed by the base from the
+  lender/pool, never supplied by the hook; the base asserts `balanceOf(repayAsset) >=
+  owed` and repays exactly `owed`. The hook only leaves sufficient balance.
+- The **profit guard is evaluated after repayment** (WBTC delta net of `owed`), so a
+  batch can never appear profitable on funds still owed to the lender.
+- Every venue callback is reachable only while the base's active-flash context is open
+  and `msg.sender == active.lenderOrPool` (the configured singleton, or the
+  factory-derived pool stored as `lenderOrPool`), with the rest of `active` matching; the
+  hook it calls cannot itself open a second flash (single-context invariant). This is
+  *in addition to* the router's existing `nonReentrant` / active-execution lockout on
+  entry points, rescue, approvals and owner actions (base RFC §3.5) — the active-flash
+  context does not replace it.
 - No approval outside {adapter, swap venue, the active flash lender}; none infinite;
   any flash-loan approval is exactly the repay amount and is reset after.
```

## Diff F — §5 Threat model (the split adds no surface)

```diff
+- **Router/VenueManager split** — the extraction is by **inheritance**, not deployment:
+  one contract, one storage, funds never cross a contract boundary, so it adds **no new
+  custody boundary** over the flash-venues design while removing the venue callbacks from
+  the router's file. (It is not "zero surface" in the abstract — a source split can still
+  introduce storage-layout, `override`, or missing-modifier mistakes; those are covered by
+  the base/router invariants and the audit, not by the split itself.) A separately-deployed
+  manager was rejected precisely because it would receive the borrowed funds and become a
+  custody/approval boundary (the adapter pattern the venue authentication is built to avoid).
```

## Diff G — §8 Method & data reference (note the base)

```diff
+| `VenueManager` (abstract base) | `_flashLoan(Venue, asset, amount, data)`, `_flashSwap(feeTier, asset, amount, maxWbtcRepay, data)`, the four venue callbacks, `_onFlashFunds(kind, borrowAsset, borrowed, repayAsset, owed, data)` (implemented by the router; **no return** — the base computes/asserts `owed` and repays). Owns lender/factory immutables + `flashModesEnabled` + the active-flash context. |
+| `LiquidatorRouter is VenueManager` | the liquidation entry points, order→calldata, `ProfitGuard`, allowlists, approvals, rescue — implements `_onFlashFunds`. |
```

---

## Contract layout

```
contracts/
  VenueManager.sol       # abstract: venue enum, lender/factory immutables, active-flash
                         #   context, 4 native callbacks, pool derivation, per-venue repay,
                         #   _flashLoan/_flashSwap initiators, abstract _onFlashFunds hook
  LiquidatorRouter.sol   # is VenueManager: batch + orders + ProfitGuard + allowlists +
                         #   approvals + rescue; implements _onFlashFunds
```

## Open items

- **Hook shape — resolved (per review):** one `_onFlashFunds(kind, borrowAsset, borrowed,
  repayAsset, owed, data)` that **returns nothing**; the base owns `owed` and the repay.
  Two hooks (`_onFlashLoanFunds`/`_onFlashSwapFunds`) were considered but the single
  `FlashKind`-tagged hook keeps the callback bodies uniform without any return to misuse.
- **Guard timing — resolved (per review):** the profit guard runs in the base **after**
  repayment (WBTC delta net of `owed`), not inside the hook before it.
- **Transient vs round-tripped `data`:** the compact active-flash context lives in
  transient storage; the **batch payload rides the lender's `data`** (Aave/Morpho/Balancer
  round-trip it; the flash-swap `data` carries it natively). Transient storage for the
  payload only if a venue drops `data` — a per-venue implementation concern, not the
  default.
- **Naming (open):** codex flags `VenueManager` as reading administrative — the base is
  pure mechanism (allowlists/kill-switch stay owner-controlled on the router). Candidates:
  `FlashFunderBase` / `FlashFundingBase` / `FlashVenueBase`. **Decision for the contracts
  RFC** — kept as `VenueManager` here pending your call.
- **Lower-abstraction fallback:** if inheritance depth is a concern, keep the callbacks on
  the router and factor only the stateless venue helpers (pool derivation, encoding,
  `owed`/repay math) into `internal`/`library` code (see "Why a base contract").
- Everything the flash-venues addendum left open (per-venue callback signatures, repay
  mechanics, flash-swap V3 semantics) is **unchanged** — this addendum relocates that
  logic, it does not alter it.
```
