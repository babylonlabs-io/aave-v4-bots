# Design-020 — `operator-cli` v1 (close the MANUAL loop, EOA + Safe)

Status: **complete** (unit-tested, codex-reviewed, EOA + Safe MANUAL e2e green)
Issue: #20a · Depends on: #9 (done) · Boundary: #17 (LiquidationRelayer batches) — deferred
Design source: `docs/design-009-execution-modes-and-notifications.md`, `docs/design-009b-executor-seam.md`

This reflects the code as built. Where the implementation diverged from the earlier plan, the
divergence is called out; where a planned item was deferred, it is listed under **Deferred**.

## Goal

The smallest `services/operator-cli` that closes the MANUAL loop **end-to-end** and delivers MANUAL's
security value — a human signing on real custody, no hot key in an automated process. v1 supports
**two operator identities behind one seam**:

- **EOA** — an externally-owned account. Signed by a local key (dev/e2e/CI, the automatable path) or,
  in production, on a hardware wallet in the operator's own tooling and reported back via `confirm`.
- **Safe** — a Safe{Wallet} multisig. The production custody target: N-of-M owner approvals, on-chain
  and auditable. This is why v1 exists rather than "AUTO with extra steps."

```
bot (keyless, MANUAL)          operator-cli                                        chain
  propose ──▶ StateStore
                 proposed ──▶ list / show (verify inner hash; Safe: preview safeTxHash)
                          ──▶ claim  (proposed→claimed; Safe: allocate nonce,
                                      persist envelope incl. safeTxHash)
                                 claimed ──▶ EOA:  sign + send direct tx  ─────────▶ tx
                                        ──▶ Safe: owners sign + execTransaction ───▶ tx
                                 markBroadcast (claimed→submitted, +tx hash) ────▶ submitted
  reconcile ◀── EOA:  receipt status  ◀────────────────────────────────────────────── confirmed
              Safe: ExecutionSuccess/Failure event (by Safe addr + safeTxHash) ◀──── / failed
```

## The `claimed` status — the one deliberate divergence

The plan was to reuse `pending` for the claim. **We added a dedicated `claimed` status instead**,
because a claimed-but-not-yet-broadcast proposal has no on-chain tx, yet `pending` is a member of
`IN_FLIGHT_ON_CHAIN` — so reusing it would put a claim into the reconcile work-list. `claimed` is in
`LIVE_FOR_DEDUP` (blocks a re-propose) and **out** of `IN_FLIGHT_ON_CHAIN` (reconcile never sees it),
which is exactly the semantics the claim needs. `pending` stays purely AUTO.

## AUTO is unchanged — the hard bar

AUTO never claims, calls `markBroadcast`, or writes a `safe_envelope`. The Safe reconcile path is
routed **per-intent** by the presence of a `safeEnvelope` (set only by the Safe claim path), so AUTO
and MANUAL+EOA intents (`safeEnvelope === null`) run today's receipt path, byte-for-byte. Locked by
regression tests: AUTO needs no `MANUAL_EXECUTOR_KIND`, AUTO reconcile still confirms by receipt
status, and every existing AUTO test runs unmodified.

## Identity model — the operator declares their custody, in config

Custody is a deployment-wide config field both processes read: `MANUAL_EXECUTOR_KIND = eoa | safe`,
**required in MANUAL** (`buildExecutionConfig` throws without it — a silent `eoa` default would
mis-confirm a Safe deployment). It becomes `executorKind` on the MANUAL `ExecutionSettings`.

`MANUAL_EXECUTOR_ADDRESS` is the account the engine simulates from; in `safe` custody it **is the
Safe** (the Safe is `msg.sender` of the inner call). Boot **probes the address to confirm the
declaration** (`@repo/runtime` `assertCustody`): `safe` calls `getThreshold()` + `nonce()` (a non-Safe
contract fails this); `eoa` asserts zero code. A mismatch stops startup.

## What v1 reuses / adds across packages

- `@repo/execution` — `hashPayload` (the inner-call content hash, unchanged) **plus** the new Safe
  pure functions (below).
- `@repo/abis` — `safeAbi` (the `Execution*` events, `execTransaction`, `getTransactionHash`, and the
  `nonce`/`getThreshold`/`getOwners`/`VERSION` views), reused by reconcile, the CLI, and the boot probe.
- `@repo/persistence` — the `claimed` status and the new store methods (below).
- `@repo/secrets` (key/owner-key *references*), viem for reads + signing.

## `@repo/execution` — Safe pure functions

Chain-free, hand-rolled on viem (`hashTypedData` + ABI codecs), reused by the CLI and reconcile-side
tests. **Supported Safe versions: v1.3.0+** (their EIP-712 domain is `{chainId, verifyingContract}`).

- `SafeTxParams` / `SafeExecution` — the SafeTx fields (JSON-serializable) and the built execution
  (params + `safeVersion` + `safeTxHash`).
- `defaultSafeTxParams(nonce)` — the v1 policy: `operation = CALL`, all gas/refund fields zero.
- `safeTxTypedData(...)` — the EIP-712 typed data, the single source for both signing and hashing.
- `computeSafeTxHash(...)` / `buildSafeExecution(...)` — the `safeTxHash` and the full envelope.
- `encodeSafeSignatures(...)` — owner sigs concatenated in ascending owner order.
- `encodeExecTransaction(...)` / `decodeExecTransaction(...)` — the broadcast calldata and the decode
  `confirm` verifies against.

A unit test cross-checks `computeSafeTxHash` against an **independent** canonical
`keccak256(0x1901 ++ domainSeparator ++ structHash)` computation, so the EIP-712 layout cannot drift
offline; the on-chain `getTransactionHash` equality is the e2e's job.

## Persistence additions (`@repo/persistence`)

- **`claimed`** status: in `LIVE_FOR_DEDUP`, out of `IN_FLIGHT_ON_CHAIN` (see above).
- **`proposals(action?)`** — the operator work-list: `proposed` + `claimed` rows carrying a
  `payloadHash` (so an AUTO `pending` never leaks in), oldest first.
- **`getIntent(id)`** — single-row read, the one the CLI acts on.
- **`claimProposal(id, expectedPayloadHash, envelope?) → ClaimResult`** — CAS `proposed → claimed`,
  guarded on `payloadHash`; persists the `SafeEnvelope` for `safe` custody. `ClaimResult` is
  `{ claimed: true; intent } | { claimed: false; reason: "not-found"|"not-proposed"|"hash-mismatch"; existing }`.
- **`markBroadcast(id, txHash, expectedPayloadHash)`** — retargeted CAS **`claimed → submitted`**.
- **`release(id, expectedPayloadHash)`** — CAS `claimed → proposed`, clears the envelope.
- **`fail(id, error?)`** — mark a live (`proposed`/`claimed`/`pending`/`submitted`) intent `failed`.
- **One `safe_envelope jsonb` column** (with an additive migration) — holds the whole envelope
  including `safeTxHash`. (Simplified from the plan's separate `safe_tx_hash` column: reconcile
  already holds the intent row, so no queryable hash column is needed.)

The `SafeEnvelope` type: `{ safeNonce, operation, safeTxGas, baseGas, gasPrice, gasToken,
refundReceiver, safeVersion, safeTxHash }`.

## Reconcile change (`@repo/engine/reconcile.ts`)

Routed **per-intent** by `safeEnvelope` (not config-threaded — self-describing and impossible to
drift). AUTO/EOA (`null`) take the unchanged receipt path; a `safeEnvelope` routes to the Safe ladder
via `ChainReader.getSafeExecution` (`SafeExecutionOutcome`):

- no receipt → `stillInFlight`;
- receipt `status = 0` (outer `execTransaction` reverted) → `failed`;
- `status = 1` + `ExecutionSuccess` → `confirmed`;
- `status = 1` + `ExecutionFailure` → `failed`;
- `status = 1` + **no matching event** → `failed` + a loud `warn` (safe: the engine's fresh simulation
  guards re-execution; never confirm-blind, never loop forever).

Event matching validates the emitting **Safe address** and the decoded **`safeTxHash`**, not just the
topic. `reconcilePending` was refactored to route→apply: three small resolvers
(`resolveSafeIntent` / `resolveBroadcastIntent` / `resolveUnbroadcastIntent`) return a `Resolution`,
and the loop owns the single `transition`/`warn`/counter.

## Stuck-intent recovery

- **Detection** — `MANUAL_INTENT_STUCK_MS` (default 1h, `0` disables) → `intentStuckMs`. Each reconcile
  cycle the manual executor emits **`intent-stuck`** for a `claimed`/`submitted` intent older than the
  threshold, **once per intent** (an in-memory set re-derived to the currently-stuck ids, so it neither
  spams nor grows unbounded). This is the emission site #9c deferred.
- **Recovery commands** — `confirm <id> --tx <hash>` (it landed under some hash: verify + attach),
  `release <id>` (it didn't: revert to `proposed`, guarded — for Safe, refuse if the Safe `nonce()`
  passed the reserved `safeNonce`), `fail <id>` (give up).

## `services/operator-cli`

Env: `CLIENT_RPC_URL`, `DATABASE_URL`, `PERSISTENCE_SCHEMA?`, `SECRETS_PROVIDER`, `AWS_REGION?`,
`MANUAL_EXECUTOR_ADDRESS`, `MANUAL_EXECUTOR_KIND`, and per mode `OPERATOR_KEY_REF` (eoa) or
`SAFE_OWNER_KEY_REFS` + `SAFE_VERSION` (safe). Owner keys are **optional** for Safe — claim/confirm are
keyless; only `broadcast` needs them.

Commands (thin dispatch over the unit-tested `operations.ts`; every command verifies the inner hash +
chain id first):

- `list [--action a]` — the `proposals()` work-list.
- `show <id>` — verify + render the decoded call and age; Safe: preview the `safeTxHash`.
- `claim <id>` — `proposed → claimed`, fixing + persisting the Safe envelope; prints the hash to sign.
- `broadcast <id>` — the automatable path: claim → sign + send → `markBroadcast`. **The `proposed →
  claimed` CAS is the broadcast lease** — `broadcast` only sends on a row it claims from `proposed`, so
  two operators can't both send and a retried broadcast never double-sends; an already-`claimed` row is
  refused (use `confirm --tx` if it was sent, or `release`).
- `confirm <id> --tx <hash>` — verify the on-chain tx *is* the claimed proposal, then record it.
- `release <id>` / `fail <id> [--reason r]` — recovery (both verify the row is one of our MANUAL proposals).

`confirm` verification — **EOA**: `from`/`to`/`value`/`data` match the executor + payload. **Safe**:
`to == Safe`; decode `execTransaction`; inner `(to,value,data)` match the payload, `operation == CALL`,
**all** gas/refund fields zero (`safeTxGas`/`baseGas`/`gasPrice`/`gasToken`/`refundReceiver` — a nonzero
refund drains the Safe), and the recomputed `safeTxHash` equals the persisted envelope's.

**Concurrency (v1):** a Safe claim reads `Safe.nonce()` independently, so v1 **handles one live Safe
claim at a time** — a second concurrent Safe claim is refused (`confirm`/`release`/`fail` the first).
Store-level nonce allocation (multiple queued SafeTxs with distinct nonces) is deferred. EOA custody
is unaffected. This closes the codex-flagged nonce-collision race; without it the loser's SafeTx would
revert and self-heal via reconcile (no fund loss, but wasted).

## Signer seam (`OperatorSigner`) — hand-rolled, not protocol-kit

Two methods: `buildEnvelope(inner)` (Safe: read `nonce()`, `buildSafeExecution`; EOA: `undefined`) and
`send(inner, envelope)`. Two adapters:

- `createEoaOperatorSigner` — the operator account sends the inner call directly.
- `createSafeOperatorSigner` — owners `signTypedData` the SafeTx, `encodeSafeSignatures`,
  `encodeExecTransaction`, and a relayer submits it. Owners/relayer may be empty (claim/confirm only);
  `send` throws if asked to broadcast without them.

Chosen over `@safe-global/protocol-kit`: v1 would use ~5% of that SDK, and since `confirm` needs the
envelope/hash pure functions independently anyway, hand-rolling *is* the layer, not an extra one — and
keeps the dependency graph lean. The `getTransactionHash` cross-check covers the correctness risk.

## Deferred (not in this slice)

- **`--simulate` dry-run** on `show`, and re-fetching Safe `owners`/`threshold` at broadcast time.
- **A hardware-wallet `OperatorSigner` adapter** (production HW-EOA uses `confirm` today).
- **`@safe-global/api-kit` / Safe Transaction Service** integration for the Safe-UI approval flow.
- **MultiSend batching + relayer-canonical rendering** — gated on #17 (this is #20b).

## Security invariants (all enforced)

Keyless bot; Safe/HW operator holds no key beyond owner-key *references*. Mandatory inner-hash
re-verification before signing. Claim before sign (a superseded/expired proposal fails the CAS before
anything hits the chain). `from`/Safe == `MANUAL_EXECUTOR_ADDRESS` and chainId checked. Safe: whole
envelope verified (nonce/operation/zero refund). Safe success is the inner event, never the outer
receipt. `markBroadcast` CAS is the final anti-double-broadcast fence; the claim is the first.

## MANUAL e2e — the **confirm flow** (the production path)

The e2e drives the real production flow, not the local-key `broadcast` shortcut: operator-cli runs
**keyless** and never signs or broadcasts. Per proposal the drive (`test/e2e/scripts/operator-confirm.sh`):
`operator-cli claim` → an **external** tool (`services/operator-cli/scripts/e2e-external-sign.ts`,
viem-only, standing in for a hardware wallet / Safe UI, holding the key) signs + broadcasts →
`operator-cli confirm --tx <hash>` re-verifies the on-chain tx IS the proposal and records it. This is
what proves the keyless flow — the CLI verifies a tx it did not produce. `SUITE=manual-liquidator`
(EOA) / `manual-safe-liquidator` (Safe, deploying a faithful `E2ESafe` double + `execTransaction`).

- **EOA confirm flow — green + reliable.** Keyless bot proposes 2 approvals + a liquidation; the
  external tool signs each with the operator key and broadcasts; `confirm` records each; bot reconciles
  to `confirmed`; position liquidated, executor spends USDC + receives WBTC. All `[PASS]`.
- **Safe confirm flow — the Safe signing + `confirm` verification is proven** (both Safe
  `execTransaction` approvals sign externally, verify, and reconcile via `ExecutionSuccess` every run),
  and a full Safe run reached `confirmed` on all three intents (2 approvals + liquidation) with the
  position liquidated on-chain. The intermittent failures where the liquidation never got proposed were
  root-caused to a **test-isolation artifact, not a MANUAL/Safe defect**: a leftover AUTO (keyed)
  liquidator bot from an earlier local `SUITE=liquidator` run kept running and — because the e2e
  deploys contracts at deterministic CREATE2 addresses on each fresh anvil — **auto-liquidated the
  borrower position**, which deletes its row from the indexer (`LiquidationCall` → 0 shares →
  `db.delete(position)`), so the bot then saw "No liquidatable positions" and never proposed its own
  liquidation. The tell: a run logged a `LiquidationCall` while the operator had only ever confirmed
  approvals, so a keyed third party did the liquidation. The slower Safe flow loses that race more
  often than the fast EOA/AUTO flows. The price does NOT recover (`MockPriceFeed.simulatePriceDrop`
  sets a fixed price) — that earlier guess was wrong. The real fix is process hygiene: the e2e cleanup
  patterns now match the actual bot/ponder cmdlines (`tsx services/…/index.ts`, `ponder dev`) so bots
  no longer leak across runs; CI runs in a fresh environment per job, so no leftover bot exists there.

## Acceptance status

- [x] `MANUAL_EXECUTOR_KIND` required + `MANUAL_INTENT_STUCK_MS`; boot Safe-interface probe. Tests.
- [x] `StateStore`: `claimed` status, `claimProposal`/envelope, `proposals`, `getIntent`,
      `markBroadcast` `claimed → submitted`, `release`/`fail`, `safe_envelope` column. Tests on both adapters.
- [x] Reconcile Safe ladder with event address+hash validation; AUTO/EOA path unchanged (regression tests).
- [x] `@repo/execution` Safe pure funcs + independent EIP-712 cross-check; `@repo/abis` `safeAbi`.
- [x] `operator-cli` list/show/claim/broadcast/confirm/release/fail + `OperatorSigner` (EOA + Safe). Tests:
      hash/chain/from mismatch refuse; `confirm` rejects wrong inner-call/refund; claim-before-sign; recovery.
- [x] `intent-stuck` emitted for aged claimed/submitted (once per intent); `release` nonce-guarded.
- [x] **MANUAL e2e drives the keyless confirm flow** (claim → external sign → `confirm --tx`). EOA
      suite green + reliable; Safe suite proves the `execTransaction` signing + `confirm` + reconcile
      (via the approvals), with the final liquidation gated by a ponder-on-anvil indexing flake (above).
- [x] `pnpm typecheck && pnpm test && npx biome check packages services` green (495 tests).

### Two bugs the Safe e2e surfaced (both fixed)

- **Non-concurrency-safe schema init** — `CREATE SCHEMA IF NOT EXISTS` races on Postgres' `pg_namespace`
  index between backends sharing the DB; the bot crashed on its first `propose`. `@repo/persistence`
  now retries the idempotent init DDL once on the duplicate-key codes (`23505`/`42P06`/`42P07`).
- **Action-scoped MANUAL reconcile left approvals unconfirmed** — `approval` intents belong to no
  engine's action, so scoping `reconcilePending` to `"liquidation"` left operator-broadcast approvals
  `submitted` forever (which wedged the one-live-Safe-claim guard). A keyless MANUAL bot has no
  per-signer nonce fence, so its reconcile now runs **unscoped** across all in-flight intents (matching
  the already-unscoped expiry sweep). AUTO reconcile stays action-scoped (unchanged).
