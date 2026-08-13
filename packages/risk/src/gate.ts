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
 * How far ahead of this process's clock a source timestamp may sit before it is unusable.
 *
 * Not the operator's staleness bound, and deliberately a separate quantity: staleness measures how
 * old the data is, while this measures whether the two clocks agree enough for that measurement to
 * mean anything. The source stamp is a *chain block* timestamp, which legitimately runs a few
 * seconds ahead of a correct local clock, so a small lead is normal and is treated as fresh.
 * Reusing `maxDataStalenessMs` here would make a tight freshness setting reject a healthy chain.
 *
 * Past this, the clocks genuinely disagree and every age derived from them is meaningless — which
 * matters because the error is silent and one-directional: a source running ahead makes every age
 * negative, and a guard that only asks "is the age too large" then admits data of *any* age.
 */
export const MAX_SOURCE_CLOCK_SKEW_MS = 30_000;

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
  // The one halt cause an operator may not clear by hand, tracked apart from `haltReason` because
  // that string is overwritten by whichever halt came last. Without it, a code-hash halt landing on
  // an already-HALTED gate is indistinguishable from the manual halt it replaced.
  let codeHashHalt = false;
  let everVerified = false;

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

  /**
   * @param fromCodeHash the halt came from the code-hash guard, so `resume` must refuse it. Not
   *        inferred from the reason string: that would make a safety decision out of prose.
   */
  const haltWith = (reason: string, fromCodeHash: boolean) => {
    // Emit on the RUNNING → HALTED *transition* only. The code-hash guard re-halts on every tick
    // while a mismatch persists, and an operator does not need that alert once a minute, forever.
    //
    // Deliberate consequence: a *reason change* while already HALTED is silent — e.g. a code-hash
    // mismatch after a manual kill-switch halt updates `haltReason` but does not re-alert. Trading
    // is already stopped, so this is informational drift, not a safety event; the reason is visible
    // via `GET /status`, and a code-hash cause landing here makes `resume` refuse whether or not
    // anyone was told. Re-alerting on every reason change would re-introduce the breaker's own
    // per-trip spam (its reason carries an incrementing failure count).
    const wasRunning = state === "RUNNING";
    state = "HALTED";
    haltReason = reason;
    if (fromCodeHash) codeHashHalt = true;
    if (wasRunning) emit({ kind: "halted", reason });
  };

  const halt = (reason: string) => haltWith(reason, false);

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
    //
    // The value is judged before it is used, not after. The stamp crosses an unauthenticated wire
    // — the indexer response is cast to its type, never parsed — and arithmetic launders a bad one
    // into a pass: `now() - "nonsense"` is `NaN`, and every comparison against `NaN` is false, so
    // the guard admits exactly what it exists to block. Checking the input rather than the result
    // is what states the contract in the direction it is meant to hold.
    if (config.maxDataStalenessMs !== undefined) {
      const stamp = action.dataTimestampMs;
      if (stamp === undefined) {
        return `missing source timestamp for ${action.subject}`;
      }
      // One check for every way a wire value can fail to be an instant: a string, an object, NaN,
      // ±Infinity, a fraction, or a magnitude past 2**53 where ms arithmetic stops being exact.
      if (!Number.isSafeInteger(stamp)) {
        return `unusable source timestamp for ${action.subject}: ${JSON.stringify(stamp)}`;
      }
      const age = now() - stamp;
      if (age > config.maxDataStalenessMs) {
        return `stale source data for ${action.subject}`;
      }
      if (-age > MAX_SOURCE_CLOCK_SKEW_MS) {
        return `source timestamp for ${action.subject} is ${-age}ms in the future; its clock and ours disagree, so its age cannot be judged`;
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

    haltReason: () => haltReason,
    everVerified: () => everVerified,

    resume() {
      // Refused, not merely ineffective: the caller reports it, so an operator learns their resume
      // did nothing rather than believing trading restarted. The cause outlives this call — only a
      // clean `verifyCode` clears it — so the answer is stable until the guard proves otherwise.
      if (codeHashHalt) return false;
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
      return true;
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
          // moved anyway, and `spendUnknown` says we could not find out — which is accounted the
          // same way and for the same reason. Anything else (pre-broadcast, or a revert, which
          // transfers nothing) released the tokens untouched.
          const spent =
            outcome.ok ||
            outcome.unresolved === true ||
            outcome.spent === true ||
            outcome.spendUnknown === true;
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
          haltWith(`no code at ${address} (expected ${want})`, true);
          return;
        }
        if (got.toLowerCase() !== want.toLowerCase()) {
          haltWith(`code hash mismatch at ${address}: got ${got}, expected ${want}`, true);
          return;
        }
      }

      // Pass 2: nothing is compromised among the addresses we read. A probe failure always throws,
      // so the caller can log it and retry — but whether it also *halts* depends on whether this
      // gate has ever verified anything. Never having read a target is not a blip: there is no
      // earlier success to fall back on, so an unreadable target is indistinguishable from an
      // unverified one and the bot must not trade against it. Once one clean pass exists, a later
      // blip is exactly that, and halting on it would make the guard an availability bug.
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") {
        if (!everVerified) {
          haltWith("pinned contract bytecode has never been verified (probe failed)", true);
        }
        throw failed.reason;
      }

      // Every pinned address read cleanly. That is the only evidence that retires a code-hash halt
      // — an operator cannot assert it, and the state the periodic guard's fail-open rests on is
      // now actually true. The gate stays HALTED: proving the target is sound is not the same as
      // deciding to trade again, and that decision stays with the operator.
      codeHashHalt = false;
      everVerified = true;
    },
  };
}
