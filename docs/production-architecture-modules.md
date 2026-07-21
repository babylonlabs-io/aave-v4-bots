# Modules — capabilities & characteristics

> **Drop-in replacement for §5 (Required-feature designs), §6 (Transaction
> lifecycle) and §7 (Capital, risk & accounting) of the
> [Production Architecture Proposal](./production-architecture-proposal.md).**
> Same content, reorganized **by module** so each package's responsibilities are
> in one place. Package list and dependency direction are in §3.2–§3.3.
>
> **How to read this:** every module leads with a 2–3 line summary — *what it owns
> and why it's risky*. Skimming those is enough to follow the architecture. The
> implementation-grade specifics are folded into **collapsed `Detail` blocks**;
> expand them only when a decision needs scrutiny.

Modules, grouped by their place in the one-way dependency graph (`↓`):

1. **Core** — `domain` (pure), `engine` (orchestration; ports only)
2. **Capability packages** — `chain`, `execution`, `capital`, `risk`,
   `observability`, `config`
3. **Integration packages** (one external seam each: port + adapters) —
   `secrets`, `signer`, `notifications`, `indexer`, `persistence`
4. **Contracts** — `LiquidatorRouter`

---

## 5.1 `domain` — opportunity models & decision policies (pure, no IO)

The decision core: pure functions of inputs supplied by the `engine`, no IO.
Owns *what is worth acting on* — opportunity models, prioritization, the
profitability gate (after gas + fees), the **bad-debt policy**, and the
**SelfFunded-vs-FlashLoan route choice**. Getting these wrong means acting on
unprofitable or money-losing opportunities.

<details><summary>Detail — policies</summary>

- **Bad-debt policy** — widens the candidate filter to `HF<1` positions where
  **collateral < debt** (protocol-protective, often unprofitable). **Off by
  default**, separate exposure limits, typically routed to MANUAL.
- **Route planner** — chooses SelfFunded vs FlashLoan from config + live balance +
  **post-swap, post-premium** profitability. (Execution lives in
  `contracts`/`execution`; the *choice* is pure.)
</details>

## 5.2 `engine` — orchestration (imports port interfaces only)

Drives the pipeline **Detect → Evaluate → Plan → Execute → Confirm** by composing
capability modules through ports; holds no adapter code. A shared
`LiquidationEngine` serves both services (parameterized by `liquidateWithLLP` vs
`liquidate`); the `arbitrageur` also runs `ArbitrageEngine`. Route-specific state
machines (LLP, direct-redemption, vault-acquisition) keep their own validated
transitions inside `Plan`/`Execute` — the engine coordinates, it doesn't flatten
them.

## 5.3 `chain` — RPC, simulation, oracle health, event watch

On-chain truth and liveness. Owns the **RPC pool** (health-gated failover, ≥2
*independent* providers, quorum reads for critical pre-broadcast state), the
liveness guards, and the rule that matters most: **always re-simulate at the
latest block immediately before broadcast** — on-chain Lens/preview is the final
truth, the indexer never is.

<details><summary>Detail — liveness guards & simulation</summary>

- Direct event/log subscriptions for the low-latency hot path, alongside Ponder.
- Guards: indexed-head-vs-chain-head lag, stale-oracle, RPC-disagreement, **reorg
  policy by action type** (shallow depth for liquidations vs the multi-day BTC
  redemption lifecycle), candidate invalidation keyed by block number, watchdog
  heartbeat.
- Re-simulate the fully-assembled batch, not just individual items.
- Maintains the oracle dependency map consumed by `risk` (source, heartbeat,
  deviation, freeze behavior).
</details>

## 5.4 `execution` — tx assembly, submission & the transaction lifecycle

**Not a thin port — a subsystem**, and the one most likely to silently lose money
if treated as one. Owns operating modes (AUTO/MANUAL), the persisted tx-lifecycle
state machine, nonce leasing, batching, and public/private submission (MEV). The
load-bearing guarantees: **nonce leases** so restarts/concurrency never collide,
**block-bound validity** so an intent can't execute against drifted state, and a
**chain-event reconciliation loop** so a crash never double-submits.

<details><summary>Detail — operating modes (AUTO / MANUAL)</summary>

Two modes only, **selectable per strategy** (no `DISABLED` — "don't run" is
`strategy.enabled = false`; "stop now" is the `risk` kill-switch / `HALTED`):

- **AUTO** — the bot signs and broadcasts (the time-sensitive path).
- **MANUAL (semi-automated)** — bot detects/evaluates/simulates and builds a
  fully-specified `TxIntent`; a human signs & submits. Primarily for the
  **arbitrageur**, which custodies WBTC.
  - **Canonical intent lives in `StateStore`** (content hash), surfaced via
    `operator-cli`. The **`Notifier` sends only a notification + reference/hash** —
    never the signable payload as source of truth. Operator verifies the hash in
    `operator-cli` before signing.
  - **Signing paths:** hardware wallet (signs the rendered intent) and Safe
    (multisig proposal); both abstracted by `signer/manual`.
  - Intents **expire** (deadline block) and are **re-simulated immediately before
    broadcast**.
</details>

<details><summary>Detail — transaction lifecycle</summary>

A persisted state machine (`persistence`/`StateStore`) keyed by idempotency tuple
`chain · block · account · collateral · debt · route`:

```
PLANNED → RESERVED(nonce,capital) → SIGNED → SUBMITTED → {MINED|REVERTED|REPLACED|EXPIRED|ORPHANED} → RECONCILED
                                          │
                              MANUAL: → AWAITING_SIGNATURE → (operator signs/submits) → SUBMITTED
```

- **Nonce leases** (not naive increment) — concurrent strategies and restarts
  never collide or strand the sequence.
- **Block-bound validity** — deadline block, max base/priority fee, post-sim
  **route hash**.
- **Replacement / escalation** for stuck txs; cancel logic.
- **Reconciliation loop** rebuilds in-flight state **from chain events** on
  startup/interval — no double-submit after a crash; catches txs mined while down.
- **Manual intents are first-class rows** — a restart never loses an
  awaiting-signature tx.
</details>

<details><summary>Detail — batching</summary>

- **Self-funded atomic batch** via the `LiquidatorRouter` contract (§5.14) — the
  `AaveAdapter` pulls from `msg.sender`, so a thin router holding approvals is
  required; plain Multicall3 can't carry the liquidator's funds.
- **`allowFailure` must not silently erode profit** — router enforces an aggregate
  min-profit / max-loss guard in the same tx; execution surfaces per-item events.
- **Arbitrageur batches via sequenced submission** (nonce leases, idempotent) —
  keeper-gating makes a contract router not worth the risk for a days-locked,
  non-competitive action.
- **Read batching via Multicall3**; **re-simulate the assembled batch** before
  submit.
</details>

<details><summary>Detail — submission & MEV (the `Submitter` adapter)</summary>

A cost/benefit ladder; the cheapest rung is near-free on mainnet (Phase 1).

- **L0 — private submission + profit-capped fees (Phase 1).** Route
  `eth_sendRawTransaction` through a private endpoint (Flashbots Protect,
  MEV-Blocker, builder RPC) — an alternate transport URL behind the `Submitter`
  port, not a rewrite. Removes mempool visibility (kills copy/front-run +
  swap-leg sandwiching) and gives **revert protection** (no gas on stale
  liquidations). Public submission stays a configurable fallback.
- **L1 — bundle + builder payment (Phase 2–3).** For atomic batches / flash-loan
  route: bundles, builder payment sized to profit, multi-builder fan-out,
  all-or-nothing inclusion. Warranted once value-per-tx is high enough.
- **L2 — searcher-grade (deferred, §12).** MEV-Share backruns, per-block
  repricing, orderflow auctions, multi-relay. Same `Submitter` port — no refactor.
</details>

## 5.5 `capital` — balances, inventory, reservation & PnL

Tracks what the bot owns and what it has committed. Owns per-asset balances and
inventory, the **allowance model** (capped, not infinite), **capital reservation**
so two opportunities can't double-spend the same WBTC/debt token,
**operator-configurable exposure limits**, and **PnL reconciled against chain
events**. Broken accounting (double-reserve, running dry, ignoring locked
capital) is the #2 way these bots lose money.

<details><summary>Detail — controls & accounting</summary>

- **Allowance model:** per-router + per-token caps, **no infinite approvals unless
  explicitly accepted**, separate approvals for self-funded vs flash-loan paths,
  allowance monitor, emergency-revoke procedure.
- **Exposure limits:** each arbitrageur operator sets working-capital size, max
  per-position size, max concurrent locked capital.
- **Locked-capital accounting** across the ~3-day escrow/redemption window.
- **PnL:** realized vs unrealized, gas, failed-tx costs, BTC redemption proceeds,
  inventory marks — reconciled against chain events, not only local receipts.
</details>

## 5.6 `risk` — circuit breakers, guards & kill switch

Produces the `HALTED` runtime safety state (distinct from operating modes in
`execution`). Trips to `HALTED` on stale data, code-hash/registry mismatch,
abnormal revert rate, gas/profit thresholds, reorg depth or inventory imbalance;
also owns the **token guard**, **route guard** and a **remote kill switch** that
disables AUTO execution without redeploy.

<details><summary>Detail — breaker conditions & guards</summary>

- **Breakers → `HALTED`:** stale indexer / RPC / oracle (per the oracle dependency
  map), abnormal revert rate, **unexpected contract code hash / address registry
  mismatch**, profit-below-threshold, gas-above-ceiling, reorg depth, inventory
  imbalance.
- **Token guard:** decimals, non-standard ERC-20 returns, fee-on-transfer denial,
  approval-reset behavior.
- **Route guard:** validates the planned route against on-chain reality before
  hand-off to `execution`.
</details>

## 5.7 `observability` — logs, metrics, health

Structured logging, Prometheus metrics, `/health` + `/ready` (absorbs today's
`shared` server + health). Severity-routed alerts originate here and are delivered
through `notifications`.

## 5.8 `config` — typed, layered, fail-fast configuration

Zod schemas + env/secret loading (unifies today's Zod-vs-hand-rolled split).
Layered precedence (defaults → file → env → resolved secret refs), fail-fast on
any invalid value, **secrets as references never literals**, scoped
shared → per-service → per-strategy. Full schema in §8.

---

## 5.9 `secrets` — `SecretsProvider` port (AWS first, decoupled)

`SecretsProvider` port with `./aws` and `./env` (dev/local only) adapters; `./gcp`
later, no core changes. Protects secret **storage**, not key **use at runtime** —
which is why the signing key is **not** here (see `signer`).

## 5.10 `signer` — `Signer` port (KMS in prod)

The signing key is special and lives here, not in `secrets`. Production uses an
**AWS KMS secp256k1 key** — the private key never leaves the HSM (digest in,
signature out); a raw key in process memory is exfiltratable. `./manual` covers
the notify-to-sign HW-wallet / Safe paths used by MANUAL mode.

<details><summary>Detail — KMS hot-path specifics & least privilege</summary>

- **Commonly under-done:** `MessageType=DIGEST` signing, DER signature decoding,
  recovery-id derivation, **low-s normalization** (EIP-2), a bounded signing
  queue, explicit behavior on KMS latency spikes (replacements still need fast
  signing).
- `./local` (raw key) is dev/test/emergency only.
- Least privilege: separate IAM roles + KMS keys per service; rotation;
  allowance/approval changes gated.
</details>

## 5.11 `notifications` — `Notifier` port (Slack first, decoupled)

`Notifier` port; `./slack` first, pluggable (`./telegram`, `./pagerduty` later).
**Severity routing matters more than the channel** — page on stuck funds / tripped
breaker / kill-switch / inventory imbalance / pending manual tx; don't alert on
every opportunity. Doubles as the manual-mode signal, but the canonical intent
lives in `StateStore` — Slack is never the source of truth.

## 5.12 `indexer` — `OpportunitySource` port (Ponder)

`OpportunitySource` port; `./ponder` adapter. **A candidate source, not truth** —
Ponder for discovery/history/backfill + dashboards; the hot-path subscriptions
(in `chain`) and on-chain Lens/preview carry low-latency and final truth.
Staleness is guarded by the head-lag check in `chain`.

## 5.13 `persistence` — `StateStore` port (Postgres)

`StateStore` port; `./postgres` adapter. Backs the tx-lifecycle state machine
(§5.4): tx-intents, nonce leases, PnL. **Canonical store for MANUAL intents**
(content-hashed, first-class rows) so a restart never loses an awaiting-signature
tx; surfaced to operators via `operator-cli`.

---

## 5.14 `contracts/LiquidatorRouter` — batch + Aave flash loan (one audit)

Permissionless-liquidator-only. **One audited contract** carrying both batching
and the Aave flash-loan route, so the same router isn't audited twice or mutated
under live approvals. Atomic: a revert leaves no exposure. A `KeeperRouter` is
intentionally **not** built — the arbitrageur batches via sequenced txs (§5.4).

<details><summary>Detail — interface, flow & hardening</summary>

- **`batchLiquidate(orders[], allowFailure, AggregateGuard)`** (self-funded) plus a
  **flash-loan entrypoint** wrapping the same batch; one flash loan funds an
  entire batch.
- **Flash-loan flow:** borrow debt token from the Aave v4 pool → `liquidateWithLLP`
  → receive WBTC at the sell discount → swap WBTC→debt token (slippage-bounded) →
  repay loan + premium → keep residual. Aave only for now; a generic
  `FlashLoanProvider` seam (Balancer/Morpho) is not built until the Aave route
  works (§12).
- **Aggregate profit/loss guard** in the same tx so `allowFailure` per-item
  isolation can't turn a profitable batch into a loss; per-item result events.
- **Hardened:** fork- and invariant-tested, minimal approvals, rescue path.
</details>

---

## 5.15 `operator-cli` — manual tx-intent review / sign / submit (tooling)

A service / composition root (not a library package), and the human end of MANUAL
mode (§5.4). It reads the **canonical `TxIntent` from `StateStore`**, **renders it
for review, verifies the content hash**, then drives signing to a **hardware
wallet** or posts a **Safe** multisig proposal — never trusting the Slack
notification as the payload. The operator's last line of defense against signing a
stale or tampered intent.

<details><summary>Detail — responsibilities</summary>

- **Hash verification before signing** — recompute and compare against the
  `StateStore` content hash; the `Notifier` reference/hash is only a pointer.
- **Two signing backends** via `signer/manual`: HW wallet (sign the rendered
  intent locally) and Safe (post as a proposal for multisig approval).
- **Re-simulation gate** — surfaces the immediate-before-broadcast re-sim result
  (§5.3) and the intent's deadline block so an expired/toxic intent is rejected,
  not signed.
- Lists awaiting-signature intents (first-class `StateStore` rows, §5.13) so a
  restart or operator handoff never loses a pending tx.
</details>
