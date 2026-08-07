import type {
  ActionOutcome,
  RiskAction,
  RiskConfig,
  RiskEvent,
  RiskGate,
  RiskSlot,
  RiskState,
  TokenAccount,
} from "./types";

/**
 * Create an in-memory risk gate. With an empty config it is **permissive** — it never blocks and
 * never auto-halts — reproducing the ungated behavior; each threshold enables one guard.
 */
export function createRiskGate(config: RiskConfig = {}): RiskGate {
  const now = config.now ?? (() => Date.now());
  let state: RiskState = config.startHalted ? "HALTED" : "RUNNING";
  let haltReason = config.startHalted ? "started halted (kill-switch)" : "";
  let consecutiveFailures = 0;
  let inFlight = 0;

  // Token ledger. Spendable capacity for one `(owner, token)` is
  // `available - spentSinceRefresh - reserved`:
  //   available          last balance the gate was told, from a chain read (authoritative)
  //   spentSinceRefresh   outflows counted against it since then, not yet visible in that figure
  //   reserved            declared spend of actions currently in flight
  //
  // Keyed by the paying account as well as the token, because two engines in one process do not
  // necessarily spend the same balance sheet: a router-funded engine draws on a treasury while
  // another still draws on the signer. Netting those into one entry would let a reservation against
  // money one engine cannot touch starve the other — or admit a spend the payer cannot cover.
  // Where both engines DO share an account the entry is shared, which is the cross-engine
  // overdraw protection this ledger exists for.
  //
  // Addresses are case-normalised so the same account or token spelled two ways is one entry.
  const available = new Map<string, bigint>();
  const spentSinceRefresh = new Map<string, bigint>();
  const reserved = new Map<string, bigint>();
  const key = ({ owner, token }: TokenAccount) => `${owner.toLowerCase()}|${token.toLowerCase()}`;
  const get = (m: Map<string, bigint>, k: string) => m.get(k) ?? 0n;
  const capacity = (k: string) => get(available, k) - get(spentSinceRefresh, k) - get(reserved, k);

  /**
   * Alerting is advisory: a throwing sink must never be able to stop the kill-switch from halting,
   * so its failures die here. The sink's contract is `void`, but a caller could hand us an `async`
   * one (TS erases the return); `Promise.resolve` absorbs a rejected one too, so neither a sync
   * throw nor an async rejection can escape.
   */
  const emit = (event: RiskEvent) => {
    try {
      const returned = config.onEvent?.(event) as unknown;
      if (returned instanceof Promise) returned.catch(() => {});
    } catch {
      // ignored — see above
    }
  };

  const halt = (reason: string) => {
    // Emit on the RUNNING → HALTED *transition* only. The code-hash guard re-halts on every tick
    // while a mismatch persists, and an operator does not need that alert once a minute, forever.
    //
    // Deliberate consequence: a *reason change* while already HALTED is silent — e.g. a code-hash
    // mismatch after a manual kill-switch halt updates `haltReason` but does not re-alert. Trading
    // is already stopped, so this is informational drift, not a safety event; the reason is visible
    // via `GET /status`. Re-alerting on every reason change would re-introduce the breaker's own
    // per-trip spam (its reason carries an incrementing failure count).
    const wasRunning = state === "RUNNING";
    state = "HALTED";
    haltReason = reason;
    if (wasRunning) emit({ kind: "halted", reason });
  };

  /** A blocked slot reserved nothing, so it starts settled and `settle()` is a no-op. */
  const blockedSlot = (reason: string): RiskSlot => ({ allowed: false, reason, settle: () => {} });

  /** The guards, in order. Returns a block reason, or `undefined` to allow. Reserves nothing. */
  const evaluate = (action: RiskAction): string | undefined => {
    if (state === "HALTED") return `halted (${haltReason})`;

    // Exposure cap — bound how many actions may be in flight at once.
    if (config.maxInFlight !== undefined && inFlight >= config.maxInFlight) {
      return `exposure cap reached (${inFlight}/${config.maxInFlight} in flight)`;
    }

    // Inventory — can the signer still afford what this action authorises? Checked here and
    // reserved in `openSlot` with no `await` between, which is what makes it safe for two engines
    // sharing one signer: without that atomicity both could pass against the same balance and
    // collectively overdraw it. Every token is validated before any is reserved.
    for (const spend of action.spend ?? []) {
      const { owner, token, amount } = spend;
      const k = key(spend);
      // Fail closed. An account/token the gate was never told about has unknown capacity, and
      // treating unknown as unlimited is exactly the overdraw this guard exists to prevent.
      if (!available.has(k)) return `no known balance for ${token} held by ${owner}`;
      if (amount > capacity(k)) {
        return `insufficient ${token} held by ${owner}: needs ${amount}, ${capacity(k)} spendable`;
      }
    }

    // Profit floor. A missing `expectedProfit` **skips** the guard rather than blocking:
    // liquidation profit is not derivable off-chain today, so fail-closing here would silently
    // disable every liquidation the moment an operator sets a floor. The arbitrage engine
    // always supplies it. (Asymmetric with freshness below — deliberately.)
    if (
      config.minProfit !== undefined &&
      action.expectedProfit !== undefined &&
      action.expectedProfit < config.minProfit
    ) {
      return `below profit floor for ${action.subject}`;
    }

    // Freshness. Fail-closed: opting into a staleness bound and then being unable to evaluate
    // it would mean trading on data of unknown age. A current indexer always supplies the
    // timestamp, so its absence is an anomaly (stale deployment, or a failed block probe).
    if (config.maxDataStalenessMs !== undefined) {
      if (action.dataTimestampMs === undefined) {
        return `missing source timestamp for ${action.subject}`;
      }
      if (now() - action.dataTimestampMs > config.maxDataStalenessMs) {
        return `stale source data for ${action.subject}`;
      }
    }

    return undefined;
  };

  /** Release one reserved slot and feed the breaker. Called at most once per slot. */
  const release = (outcome: ActionOutcome) => {
    inFlight--;

    // Neither of these is evidence the chain is rejecting *us*, so all three release the slot
    // without touching the breaker (and, deliberately, without resetting the streak — a lost race
    // must not mask a run of genuine failures). `abandoned`: no tx went out. `contended`: a tx
    // reverted, but because a competitor already took the subject. `unresolved`: a tx went out and
    // we never learned its fate.
    if (outcome.abandoned || outcome.contended || outcome.unresolved) return;

    if (outcome.ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    if (config.maxConsecutiveFailures && consecutiveFailures >= config.maxConsecutiveFailures) {
      halt(`${consecutiveFailures} consecutive failures`);
    }
  };

  return {
    state: () => state,
    inFlight: () => inFlight,
    minProfit: () => config.minProfit,

    halt,

    resume() {
      const wasHalted = state === "HALTED";
      state = "RUNNING";
      haltReason = "";
      consecutiveFailures = 0;
      if (wasHalted) emit({ kind: "resumed" });
      // `inFlight` is deliberately NOT cleared. Halting does not land the txs already in the
      // mempool, so zeroing here would let an operator bypass the cap: halt + resume while a
      // liquidation awaits its receipt, and the arbitrage engine sharing this gate could send
      // beyond `maxInFlight`. The engines settle every reserved slot on every exit path — see
      // `RiskSlot` and its `finally` backstop — so the count drains on its own and cannot leak.
    },

    setAvailable(account, amount) {
      const k = key(account);
      available.set(k, amount);
      // The fresh read already reflects everything that has landed, so what we had been counting
      // separately is now double-counting. Reservations survive: those are still in flight and are
      // by definition not yet in that balance.
      spentSinceRefresh.set(k, 0n);
    },

    reserved: (account) => get(reserved, key(account)),

    openSlot(action) {
      const blocked = evaluate(action);
      if (blocked) return blockedSlot(blocked);

      // Allowed — reserve the exposure slot. The returned slot is the only way to release it.
      inFlight++;
      // Reserve every declared spend. `evaluate` validated all of them above and nothing has
      // awaited since, so this cannot partially apply.
      const spend = action.spend ?? [];
      for (const entry of spend) {
        const k = key(entry);
        reserved.set(k, get(reserved, k) + entry.amount);
      }

      let settled = false;
      return {
        allowed: true,
        reason: "",
        settle(outcome: ActionOutcome) {
          if (settled) return; // idempotent: the precise exit path wins over the `finally`
          settled = true;

          // Release the reservation, and decide whether the tokens actually left. A confirmed tx
          // spent them. An `unresolved` one may still: counting it as spent under-reports capacity
          // until the next refresh, which merely skips affordable work — the opposite error
          // overdraws the signer and reverts. `spent` says so outright, for a failure whose funds
          // moved anyway. Anything else (pre-broadcast, or a revert, which transfers nothing)
          // released the tokens untouched.
          const spent = outcome.ok || outcome.unresolved === true || outcome.spent === true;
          for (const entry of spend) {
            const k = key(entry);
            reserved.set(k, get(reserved, k) - entry.amount);
            if (spent) spentSinceRefresh.set(k, get(spentSinceRefresh, k) + entry.amount);
          }

          release(outcome);
        },
      };
    },

    async verifyCode(read) {
      const expected = config.expectedCodeHashes;
      if (!expected) return;

      const addresses = Object.keys(expected);
      // Read every address independently. `Promise.all` would reject on the first RPC blip and
      // discard the results that DID come back — so an upgraded contract could hide behind an
      // unrelated address being briefly unreadable, and periodic checks never halt on a probe
      // failure. Definite compromise must outrank transient failure.
      const results = await Promise.allSettled(addresses.map((address) => read(address)));

      // Pass 1: judge everything we could actually read.
      for (const [i, address] of addresses.entries()) {
        const result = results[i];
        if (result.status === "rejected") continue;

        const want = expected[address];
        const got = result.value;
        if (got === undefined) {
          halt(`no code at ${address} (expected ${want})`);
          return;
        }
        if (got.toLowerCase() !== want.toLowerCase()) {
          halt(`code hash mismatch at ${address}: got ${got}, expected ${want}`);
          return;
        }
      }

      // Pass 2: nothing is compromised among the addresses we read. Surface any probe failure so
      // the caller can decide (fail closed at boot; retry on later ticks).
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
