# Design — #9: `AUTO` / `MANUAL` execution modes + `@repo/notifications`

Status: **proposal, revised after adversarial review.** Implements issue #9 (RFC-021 §Phase E).
Split into three issues — see §11.

**Scope:** an `execution` mode from service config. `AUTO` = today's sign→record→broadcast path,
unchanged. `MANUAL` = persist a canonical, content-hashed intent + notify an operator, and
**broadcast nothing**. Plus `@repo/notifications` (`Notifier` port + `./slack`) and risk alerts.

---

## 1. The decision that shapes everything: MANUAL is **keyless**

A MANUAL bot never signs. It needs **no private key, no KMS, no `@repo/signer`, no `WalletClient`,
no nonce, and no `TxSender`.** It watches the chain, decides what *should* happen, writes that down,
and tells a human. The operator signs and broadcasts with their own wallet.

This is most of the value: a MANUAL deployment has **no hot key to steal**. It is the only
configuration in which a compromised bot process cannot move funds.

It is therefore not a flag on the send path. It is a **separate lifecycle** that shares the store,
the risk gate, and the opportunity-finding half of each engine — and nothing else.

### What actually needs a key (audited)

`walletClient` is used for four things. Only the last needs a key:

| Use | Sites | Needs a key? |
|---|---|---|
| `.account.address` — allowance/balance owner, reconcile signer | `arbitrage:434,488`, `liquidation:550,592` | **No** — an address |
| `.chain.id` — the intent's `chainId` | `arbitrage:312`, `liquidation:375` | **No** — a number |
| `account:` on `simulateContract` / `estimateContractGas` | `arbitrage:298`, `liquidation:300,307` | **No** — an address |
| `approveMax(...)` and the action tx | `arbitrage:450`, `liquidation:573`, `capital:75` | **Yes** |

Three of four collapse to `{ from, chainId }`. Hence:

```ts
/** Who the transactions will come from. No key — an address and a chain. */
export interface ExecutionIdentity {
  /** The bot's signer (AUTO) or the operator's wallet (MANUAL). */
  from: Address;
  chainId: number;
}

export type ExecutionMode = "AUTO" | "MANUAL";

export interface Executor {
  readonly mode: ExecutionMode;
  readonly identity: ExecutionIdentity;
  /** AUTO: sign → record → broadcast. MANUAL: persist a proposal + notify. Never both. */
  execute(call: ContractCall, intentId?: string): Promise<ExecuteResult>;
}

export type ExecuteResult =
  | { kind: "broadcast"; hash: Hex }   // AUTO — the engine awaits the receipt
  | { kind: "proposed" };              // MANUAL — done with this subject this cycle
```

`createAutoExecutor({ walletClient, sender, crash })` owns everything key-shaped. `createManualExecutor({ store, notifier, identity })` owns none of it. **In MANUAL the composition root
never resolves a signing key** — `SIGNER_SOURCE` / `<SERVICE>_PRIVATE_KEY` / KMS are not read.

`from` in MANUAL comes from config (`MANUAL_EXECUTOR_ADDRESS`): the address that will actually
broadcast. It is the account whose balances and allowances the engine reads and whose `from` the
simulation uses. Simulating from the wrong address yields a proposal that reverts for whoever signs
it. An address is public — this costs nothing in security terms, which is the whole point.

### The full keyless work-list

Review surfaced that the keyless path reaches further than the two engines:

- `@repo/capital`'s `approveMax(walletClient, …)` (`capital/src/index.ts:75`) — needs a read-only
  allowance path; the *send* becomes a proposal (§2).
- `createCrashSafety` requires `signer: Address` (`crashSafety.ts:28`) — fine (an address), but a
  MANUAL bot needs no `NonceAllocator` at all, so `resyncNonces`/`send`/`markPending` must be inert.
- `reconcilePending` requires `signer` and **eagerly** reads `getNonce(latest|pending)`
  (`reconcile.ts:140-143`) — see §3.
- Both services unconditionally resolve a signer, build a `WalletClient`, and seed a nonce allocator
  (`liquidator:30,59,71`; `arbitrageur:72,101,113`).

---

## 2. The approval gap

`ensureApproval` **broadcasts** — in both engines. A keyless bot cannot.

**Approvals become proposals**, with two corrections review caught:

- **Key shape.** The idempotency key is `chainId:target:action:subject` (`utils.ts:8`). With
  `target = token`, the liquidator's WBTC→adapter approval and the arbitrageur's WBTC→VaultSwap
  approval collapse into **one key** — one approval for two different spenders. It must be
  **`target = spender`, `subject = token`**, `action = "approval"`.
- **Ordering.** `arbitrage/engine.ts:272` opens the risk slot *before* `ensureApproval` at `:285`.
  "Propose an approval and stop" would leak that slot. **Move the approval check before
  `openSlot`** — it is a precondition, not part of the acquisition.

---

## 3. Lifecycle

MANUAL is **nonce-free**. It tracks one thing: *was this broadcast, and what came of it?*

```
  proposed ──markBroadcast(hash)──► submitted ──receipt──► confirmed
     │                                                  └─► failed
     ├──► superseded   (a better/changed payload for the same subject)
     └──► expired      (cleanup — see §5)
```

```ts
export type IntentStatus =
  | "proposed"     // MANUAL: awaiting an operator. No tx, no nonce, not on chain.
  | "pending"      // AUTO: nonce + hash recorded, pre-broadcast
  | "submitted"    // broadcast attempted (AUTO) — or operator-reported (MANUAL)
  | "confirmed"
  | "failed"
  | "superseded"   // terminal: replaced by a fresher proposal for the same subject
  | "expired";     // terminal: cleanup
```

**Reconcile needs no new branches.** Once `markBroadcast` sets `status=submitted, tx_hash=…` with
`nonce` still `NULL`, the existing loop resolves it: `nonce !== null` guards both nonce branches
(`reconcile.ts:156,159`), so it falls straight through to *receipt → `confirmed`/`failed`*, else
`stillInFlight`. The bot picks up the result of a transaction it never sent, for free.

The one change it does need: **make the signer nonce reads lazy** (`reconcile.ts:140-143`) — fetch
`latest`/`pending` only if some in-flight intent has `nonce !== null`. A MANUAL bot then never calls
`getTransactionCount`.

> Correction from review: an earlier draft claimed a nonce-bearing proposal would loop via the
> grace/`isKnown` branch. Wrong route — a proposal has no `txHash`, so it would take the *hash-less*
> "not broadcast (reconciled)" branch (`reconcile.ts:178+`) and fail immediately, re-proposing every
> cycle. Same loop, different branch. The conclusion stands: **proposals carry no nonce.**

### The one set that must split

A proposal must be **live for idempotency** (or every cycle re-proposes the same subject — a
notification storm) yet **invisible to reconcile** (it has no tx). Today those are the *same* set —
`["pending","submitted"]`, shared by `recordIntent` and `reconcile()` in both adapters.

```ts
const LIVE_FOR_DEDUP     = ["proposed", "pending", "submitted"];  // blocks a second recordIntent
const IN_FLIGHT_ON_CHAIN = ["pending", "submitted"];              // the reconcile work-list
const TERMINAL           = ["confirmed", "failed", "expired", "superseded"]; // revivable
```

Because *both* `reconcilePending` and the nonce fence (`liveNonceFloor`, `crashSafety.ts:122`) read
`store.reconcile()`, this single split keeps proposals out of both. No other change to the
crash-safety machinery.

**Do not miss the SQL.** `postgres.ts:129` hardcodes the revive set as
`WHERE t.status IN ('confirmed','failed')`. Add `expired` and `superseded`; **do not** add
`proposed` (proposals would stop deduping and be silently overwritten). Omitting `expired` means an
expired proposal can never be revived — the subject is blocked forever, defeating the point of
expiry entirely.

---

## 4. The payload, the hash, and its real threat model

```ts
export interface ProposedTx {
  chainId: number;
  to: Address;
  data: Hex;          // encoded calldata
  value: bigint;      // 0n today
  gasLimit?: bigint;  // HINT ONLY — the operator decides at submission
}
payload_hash: Hex;    // keccak256 over a canonical, versioned encoding
```

New `tx_intents` columns: `payload jsonb`, `payload_hash TEXT` (null for AUTO rows). Extending the
intents table rather than adding a `proposals` one — this *is* its use case, and one table means one
idempotency key, which is what makes dedup work.

**Be honest about what the hash buys.** If `payload` and `payload_hash` live in the same mutable
row, an attacker who can rewrite one can rewrite the other. The hash is *not* self-defending. What
makes it tamper-evident is the **independent channel**: the notification carries the hash, so the
operator compares what `operator-cli` recomputes from the persisted payload against the hash they
saw in Slack. The out-of-band delivery is the security property; the column is just the artifact.

Deliberately absent: `nonce`, `maxFeePerGas` — they belong to whoever signs. Calldata is encoded via
a shared `encodeCall(call)` exported from `@repo/execution` (the encoder `signContractCall` already
uses), so a proposal and a signature can never disagree about what a `ContractCall` means.

### `markBroadcast` must be guarded

A naive `markBroadcast(id, hash)` built on the unconditional `transition` (`postgres.ts:142`) would
let any DB writer attach any hash to any proposal — reconcile would then `confirm` an intent from an
unrelated transaction. Two guards:

1. **Compare-and-set:** `WHERE id = $1 AND status = 'proposed' AND tx_hash IS NULL AND payload_hash = $expected`.
2. **Verify against the chain** before accepting: fetch the tx and check `chainId`/`to`/`data`/
   `value` match the payload. A hash that doesn't match the proposal is rejected, not recorded.

And a third hazard, which neither the original design nor the reviewer listed: **a bogus hash that
never mines leaves the intent `stillInFlight` forever** — and being live-for-dedup, its subject is
blocked permanently. Hence `intent-stuck` escalation (§6) is not optional.

---

## 5. Liveness: supersede first, TTL as cleanup

A stale proposal is **safe** — if the position was already liquidated, the tx simply reverts. Safety
comes from the revert, not from us. The problem is **liveness**: being live-for-dedup, an un-actioned
proposal blocks its own subject from ever being re-proposed with fresh numbers.

A fixed TTL is a crude fix (a stale proposal blocks until the clock runs out; a good one dies
because it elapsed). Primary mechanism is **supersede-on-change**: if a new cycle computes a
materially different canonical payload for the same idempotency key, mark the old one `superseded`
and propose the new one. `MANUAL_INTENT_TTL_MS` remains as cleanup/escalation for proposals nobody
ever actions (default **3 hrs**; `0` disables).

---

## 6. `@repo/notifications`

```ts
export type NotificationEvent =
  | { kind: "manual-intent"; intentId: string; action: string; subject: string;
      target: Address; payloadHash: Hex; expiresAt?: number }   // hash travels out-of-band (§4)
  | { kind: "risk-halted"; reason: string }
  | { kind: "risk-resumed" }
  | { kind: "intent-stuck"; intentId: string; subject: string; ageMs: number };

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}
```

Adapters: `./slack` (incoming webhook; URL is a **secret reference** resolved via `@repo/secrets`,
like `RISK_CONTROL_TOKEN_REF`) and `./noop` (default).

**Every event is logged first, then delivered.** The log is the guaranteed channel; Slack is a
convenience. A `notify` failure is logged and swallowed — never propagated into the cycle — because
the persisted intent is the source of truth. A dropped message degrades to "the operator reads the
queue", not "the bot stops".

### Risk alerts

`@repo/risk` stays dependency-free — a plain callback, as it already takes `read: CodeHashReader`:

```ts
// RiskConfig
onEvent?: (e: { kind: "halted"; reason: string } | { kind: "resumed" }) => void;
```

`halt()`/`resume()` fire it, covering breaker trips, kill-switch halts and the code-hash guard's boot
halt. `startRiskRuntime` wires it to the service's `Notifier`.

---

## 7. The risk gate in MANUAL

MANUAL is **not** a risk bypass: the gate, the simulation and the guards all run *before* a proposal
is written. A HALTED gate proposes nothing; we never propose a tx we already know reverts.

But a proposal is not in-flight exposure. So in MANUAL the gate is a **proposal-time filter**: open
the slot, use the verdict, and settle `{ ok: false, abandoned: true }` **immediately** once the
proposal is durable. `abandoned` releases the exposure without feeding the breaker (nothing was
broadcast, so it is not evidence the chain is rejecting us). Holding the slot until a human acts
would wedge `maxInFlight` on the first proposal and stop the bot.

Consequence: risk limits no longer bound how many proposals an operator may sign later. Hence
`MAX_OPEN_PROPOSALS` (a queue cap), and `operator-cli` (#20) should re-run simulation + risk checks
immediately before signing — the bot's checks are minutes old by then.

---

## 8. Safe operators — explicitly deferred

If the operator executes through a Safe, the recorded hash is an `execTransaction`, and a
**successful outer receipt does not mean the inner call succeeded** — so reconciling on receipt
status alone would mark such an intent `confirmed` incorrectly. Simulating `from = Safe, to =
adapter` also models only the inner call, not signature/guard/module behavior.

**v1 targets an EOA operator.** Safe support needs `{ executorType, safe, innerTo, innerData }` on
the payload and reconciliation by inner-call outcome, not receipt status. Tracked separately rather
than half-supported.

---

## 9. Config

| Env | Default | Meaning |
|---|---|---|
| `EXECUTION_MODE` | `AUTO` | `AUTO` \| `MANUAL` — **service-level** |
| `MANUAL_EXECUTOR_ADDRESS` | — | required in MANUAL: the EOA that will broadcast |
| `MANUAL_INTENT_TTL_MS` | `10800000` | proposal cleanup; `0` = never expire |
| `MAX_OPEN_PROPOSALS` | — | cap on un-actioned proposals |
| `NOTIFIER` | `none` | `none` \| `slack` |
| `SLACK_WEBHOOK_REF` | — | secret *reference*, via `@repo/secrets` |

Boot validation: MANUAL **requires** `MANUAL_EXECUTOR_ADDRESS` + a `StateStore`, and **must not**
resolve a signing key (reject if signer vars are set — we promised not to hold one). AUTO unchanged.

Mode is **per service**. An operator wanting AUTO liquidations + MANUAL arbitrage runs two
processes, each with one engine.

---

## 10. Acceptance

- **Keyless boot:** a MANUAL service starts with no key configured; no `WalletClient` / `TxSender` /
  `NonceAllocator` is ever constructed, and no `getTransactionCount` is ever called.
- MANUAL: persists `proposed` + payload + hash, notifies once, broadcasts nothing, settles the risk
  slot `abandoned` (breaker unmoved, `inFlight` back to 0).
- Dedup: two cycles, one subject → **one** proposal, **one** notification.
- `markBroadcast` with a mismatched hash/payload or a non-`proposed` row is **rejected**.
- `markBroadcast` (valid) → `submitted`; next reconcile resolves it by receipt, issuing **no** nonce
  reads.
- Supersede: a materially changed payload → old `superseded`, new `proposed`.
- Expiry: past TTL → `expired`, and the subject is re-proposable (proves the SQL revive fix).
- A HALTED gate proposes nothing.
- Notifier throws → intent still `proposed`, cycle completes, error logged.
- Approval shortfall in MANUAL → an `approval` proposal (`target=spender`), and **no leaked risk
  slot** in arbitrage.
- **AUTO: every existing engine / crash-safety test passes unchanged.** The regression bar.

---

## 11. Issue split

The original #9 is too big to land safely in one piece. Three issues:

### #9a — feat(persistence): the proposal lifecycle
No engine changes; fully unit-testable.
- `proposed` / `superseded` / `expired` statuses; `payload` + `payload_hash` columns.
- Split `LIVE_FOR_DEDUP` / `IN_FLIGHT_ON_CHAIN` / `TERMINAL`; **fix `postgres.ts:129`**.
- Guarded `markBroadcast` (compare-and-set + payload match); `supersede`; `expire`.
- **Acceptance:** dedup blocks a second proposal; expired/superseded revive; `markBroadcast` rejects
  a mismatched hash; reconcile's work-list excludes proposals.

### #9b — feat(engine,services): keyless MANUAL execution
Depends on #9a. The load-bearing one.
- `ExecutionIdentity` replaces the `walletClient.account.address` / `.chain.id` uses; `Executor`
  seam (`createAutoExecutor` / `createManualExecutor`).
- Approvals-as-proposals (`target=spender`); move the approval check **before** `openSlot`.
- Lazy nonce reads in `reconcilePending`; inert nonce path in `CrashSafety` under MANUAL.
- Services boot keyless in MANUAL; `EXECUTION_MODE` + `MANUAL_EXECUTOR_ADDRESS` config.
- Stage it: identity first → liquidation engine → arbitrage engine.
- **Acceptance:** the keyless-boot + MANUAL + AUTO-regression bars above.

### #9c — feat(notifications): `@repo/notifications` + risk alerts
Independent of both; **can land first** and is useful on its own (breaker / kill-switch alerts have
value in AUTO today).
- `Notifier` port, `./slack`, `./noop`; log-always discipline; `RiskConfig.onEvent` + runtime wiring.
- **Acceptance:** a halt emits an alert; a notifier failure never breaks a cycle; unset ⇒ no-op.

Deferred, tracked separately: Safe operators (§8), `operator-cli` (#20).
