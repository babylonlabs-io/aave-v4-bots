#!/usr/bin/env bash
# Assertions for the dual-engine nonce stress suite.
#
# These run in bash rather than forge because the strongest evidence is in the bot's StateStore —
# every intent carries `nonce` + `tx_hash` + `subject` + `status`, which is what makes "no nonce
# reuse" checkable directly instead of inferred from log greps. Position/vault outcomes are read
# from the chain with `cast`.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

RPC="${E2E_RPC_URL:-http://127.0.0.1:8545}"
PG="docker exec -e PGPASSWORD=ponder e2e-pg psql -U ponder -d ponder_arbitrageur -tAc"
SIGNER="0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"

sql() { $PG "$1" 2>/dev/null | tr -d ' \r'; }

# One counter sample from the live bot. An absent series means the path never ran, which for a
# counter is the same as zero.
ARB_METRICS="http://127.0.0.1:${E2E_ARB_METRICS_PORT:-9091}/metrics"
metric_value() {
  curl -fsS --max-time 5 "$ARB_METRICS" 2>/dev/null \
    | awk -v k="$1" '$0 ~ k && $0 !~ /^#/ { v=$NF } END { print (v == "" ? 0 : v) }' \
    | cut -d. -f1
}

FAILED=0
pass() { printf "[PASS] %s\n" "$*"; }
flunk() { printf "[FAIL] %s\n" "$*" >&2; FAILED=1; }

printf "\n=== E2E Stress Verification (dual-engine nonce) ===\n"

# ── A1: no nonce reuse ───────────────────────────────────────────────────────
# The direct, non-inferred form: a nonce carrying two DISTINCT tx hashes means the allocator handed
# the same nonce out twice. This is also the observable consequence of a broken resync fence, which
# is why it stands in for A2 (the allocator's internal lease is not exposed).
dupes="$(sql "SELECT COUNT(*) FROM (SELECT nonce FROM bot.tx_intents WHERE nonce IS NOT NULL AND tx_hash IS NOT NULL GROUP BY nonce HAVING COUNT(DISTINCT tx_hash) > 1) d;")"
if [[ "${dupes:-1}" == "0" ]]; then pass "A1 no nonce reuse (no nonce maps to 2+ distinct tx hashes)"
else flunk "A1 nonce reuse: ${dupes} nonce(s) carry multiple distinct tx hashes"; fi

# ── A3: no burned nonce left stalling the queue ──────────────────────────────
# Every nonce the bot recorded must be at or below what the chain has actually mined; one sitting
# above `latest` with nothing after it means the sequence stalled behind a gap.
max_used="$(sql "SELECT COALESCE(MAX(nonce), -1) FROM bot.tx_intents WHERE nonce IS NOT NULL;")"
latest="$(cast nonce "$SIGNER" --rpc-url "$RPC")"
pending="$(cast nonce "$SIGNER" --rpc-url "$RPC" --block pending)"
printf "  max recorded nonce=%s  chain latest=%s  chain pending=%s\n" "$max_used" "$latest" "$pending"
if [[ "$latest" != "$pending" ]]; then
  flunk "A3 chain still has queued work: latest=$latest pending=$pending"
elif [[ "${max_used:--1}" -gt "$latest" ]]; then
  # A recorded nonce above what the chain mined means the bot believes it sent something the chain
  # never took. `latest == pending` alone cannot see that — the mempool is empty either way.
  flunk "A3 recorded nonce ${max_used} exceeds mined ${latest} — a reserved nonce never landed"
else
  pass "A3 sequence drained (no gap holding the queue; max recorded ${max_used} <= mined ${latest})"
fi

# ── A5: idempotency — one successful effect per action identity ──────────────
# Grouped by the same tuple `idempotencyKey` uses (`target, action, subject`), not by `subject`
# alone. A bare subject is not an identity: an approval's subject is the *spender*, so approving two
# different tokens for one spender is two legitimate effects that share it. Grouping by subject read
# that as a double-execute.
multi="$(sql "SELECT COUNT(*) FROM (SELECT target, action, subject FROM bot.tx_intents WHERE status='confirmed' GROUP BY target, action, subject HAVING COUNT(*) > 1) d;")"
if [[ "${multi:-1}" == "0" ]]; then pass "A5 one confirmed intent per action identity (no double-execute)"
else flunk "A5 ${multi} action identity/identities confirmed more than once"; fi

# ── A4: both waves completed ─────────────────────────────────────────────────
# `confirmed` is written from a receipt, so these counts are chain-derived rather than the bot's
# opinion. Cohort A is 4 positions and cohort B is 3, so fewer than 5 confirmed liquidations means
# one of the two waves did not complete.
#
# Under racing (STRESS_RACING) the standalone liquidator wins some of those liquidations, so the
# arbitrageur's store undercounts — the positions are still liquidated, just not all by the bot we
# can SQL. Add the competitor's wins (from its log, captured in the report) so the floor reflects
# every liquidation that landed, by either bot.
liq_count="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE action='liquidation' AND status='confirmed';")"
acq_count="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE action='vault-acquisition' AND status='confirmed';")"
competitor_wins=0
racing=false
if [[ -f .e2e-stress-report.json ]] && [[ "$(jq -r '.racing' .e2e-stress-report.json)" == "true" ]]; then
  racing=true
  competitor_wins="$(jq -r '.liqWins' .e2e-stress-report.json)"
fi
total_liq=$(( ${liq_count:-0} + competitor_wins ))
printf "  liquidations: arb-store=%s competitor=%s total=%s | acquisitions=%s\n" \
  "$liq_count" "$competitor_wins" "$total_liq" "$acq_count"
# The liquidation count is asserted exactly by A10 against the real cohort size; a hardcoded floor
# here would only be weaker (and passes a 40-position run after 5 liquidations).
if [[ "${acq_count:-0}" -ge 1 ]]; then pass "A4 arbitrage engine also traded (${acq_count} acquisitions)"
else flunk "A4 no vault acquisitions — the second engine never traded"; fi

# ── A10/A11: the cascade is actually finished ────────────────────────────────
# `live intents == 0` only says this bot is idle; under racing it hits 0 the moment the races it lost
# settle. These assert the work itself is done: every position liquidated (by either bot) and every
# vault the cascade escrowed subsequently bought.
if [[ -f .e2e-stress-report.json ]]; then
  w1_done="$(jq -r '.liquidatedWave1 // 0' .e2e-stress-report.json)"
  w2_done="$(jq -r '.liquidatedWave2 // 0' .e2e-stress-report.json)"
  pos_total="$(jq -r '.positionsTotal // 0' .e2e-stress-report.json)"
  esc_target="$(jq -r '.escrowTarget // 0' .e2e-stress-report.json)"
  esc_left="$(jq -r '.escrowRemaining // "unknown"' .e2e-stress-report.json)"

  # Counts, not the indexer's remaining-work view: that reads 0 both before it has caught up with a
  # price drop and after the cascade is cleared, so "nothing left" is not evidence of completion.
  # `w2_done` is cumulative across both waves, so it is the total.
  if [[ "$pos_total" -eq 0 ]]; then
    printf "[SKIP] A10 no cohort sizes recorded\n"
  elif [[ "$w2_done" -ge "$pos_total" ]]; then
    pass "A10 every position liquidated (${w2_done}/${pos_total}; wave1 ${w1_done}/${pos_total})"
  else
    flunk "A10 only ${w2_done} of ${pos_total} positions liquidated across both bots"
  fi

  # Vaults taken by this run's own antagonists are not the bot's to acquire. The front-run phase
  # executes OUR authorization from another account, and the competitor buys with its own WBTC —
  # both leave the escrow legitimately empty by one, so the target has to come down to match or the
  # assertion punishes the bot for a race the harness deliberately made it lose.
  taken=0
  [[ "$(jq -r '.frontrunResult // ""' .e2e-stress-report.json)" == "executed" ]] && taken=$((taken + 1))
  [[ "$(jq -r '.competitorResult // ""' .e2e-stress-report.json)" == "won" ]] && taken=$((taken + 1))
  esc_expected=$((esc_target - taken))

  if [[ "$esc_target" -eq 0 ]]; then
    printf "[SKIP] A11 no vaults escrowed to acquire\n"
  elif [[ "${acq_count:-0}" -ge "$esc_expected" ]]; then
    if [[ "$taken" -gt 0 ]]; then
      pass "A11 every escrowed vault arbitraged (${acq_count}/${esc_expected}; ${taken} taken by this run's competitors, indexer shows ${esc_left} left)"
    else
      pass "A11 every escrowed vault arbitraged (${acq_count}/${esc_target}, indexer shows ${esc_left} left)"
    fi
  else
    flunk "A11 only ${acq_count} of ${esc_expected} escrowed vaults acquired (${taken} taken by competitors; indexer shows ${esc_left} left)"
  fi
fi

# ── A12: a stranded acquisition batch recovers ───────────────────────────────
# Only meaningful when a gap was actually injected (the tx really left the mempool). The bot must
# clear it WITHOUT halting: a halted gate returns before reconcile + resync, so the burned nonce
# would never be reclaimed and every acquisition behind it would stay stuck forever.
if [[ -f .e2e-stress-report.json ]]; then
  acq_gap="$(jq -r '.acqGapResult // "skipped"' .e2e-stress-report.json)"
  gap_nonce="$(jq -r '.acqGapNonce // ""' .e2e-stress-report.json)"
  gap_stranded="$(jq -r '.acqGapStranded // 0' .e2e-stress-report.json)"
  halted="$(jq -r '.arbHaltedLogs // 0' .e2e-stress-report.json)"
  esc_target2="$(jq -r '.escrowTarget // 0' .e2e-stress-report.json)"
  case "$acq_gap" in
    injected)
      if [[ "${halted:-0}" -gt 0 ]]; then
        flunk "A12 bot HALTED after the acquisition gap — reconcile/resync unreachable, batch stuck"
      elif [[ "${acq_count:-0}" -lt "$esc_target2" ]]; then
        flunk "A12 stranded batch never recovered: ${acq_count}/${esc_target2} acquired after a gap at nonce ${gap_nonce}"
      else
        pass "A12 stranded acquisition batch recovered (${gap_stranded} in flight behind nonce ${gap_nonce}; ${acq_count}/${esc_target2} acquired, never halted)"
      fi
      ;;
    *) printf "[SKIP] A12 acquisition gap not injected (%s)\n" "$acq_gap" ;;
  esac
fi

# ── A13: a front-run authorization is settled as spent, not as a lost race ───
# Our batch executed, but from someone else's transaction, so ours reverted on a vault already gone.
# By receipt alone that is an ordinary lost race — and treating it as one releases a reservation for
# money that has already left the treasury, letting the next acquisition overdraw it.
if [[ -f .e2e-stress-report.json ]]; then
  frontrun="$(jq -r '.frontrunResult // "skipped"' .e2e-stress-report.json)"
  fr_vault="$(jq -r '.frontrunVault // ""' .e2e-stress-report.json)"
  case "$frontrun" in
    executed)
      elsewhere="$(metric_value 'arbitrageur_errors_total{type="relay_executed_elsewhere"}')"
      if [[ "${elsewhere:-0}" -lt 1 ]]; then
        flunk "A13 our authorization was executed by another submitter (vault ${fr_vault}) but the bot never recorded relay_executed_elsewhere — it released a spend that already happened"
      else
        pass "A13 front-run authorization settled as spent, not as a lost race (${elsewhere} occurrence(s))"
      fi
      ;;
    *) printf "[SKIP] A13 no authorization was front-run (%s)\n" "$frontrun" ;;
  esac
fi

# ── A15: a privately-submitted tx the relay dropped neither reuses its nonce nor stalls ──
# The two failure modes private submission introduces, and they pull opposite ways. Reusing the
# nonce early signs over a transaction the relay may still land; never releasing it leaves every
# later transaction unmineable behind the gap. The drive phase asserts the first inline (it can
# only be observed while the horizon is open); this records the second, which is the one that
# would otherwise look like a healthy-but-idle bot.
if [[ -f .e2e-stress-report.json ]]; then
  priv="$(jq -r '.privateResult // "skipped"' .e2e-stress-report.json)"
  priv_nonce="$(jq -r '.privateNonce // "?"' .e2e-stress-report.json)"
  case "$priv" in
    recovered)
      pass "A15 signer recovered after the relay dropped a transaction (nonce ${priv_nonce})" ;;
    stalled)
      flunk "A15 the signer never landed another transaction after the reclaim horizon — every later send is queued behind dropped nonce ${priv_nonce}" ;;
    *) printf "[SKIP] A15 private submission not exercised (%s)\n" "$priv" ;;
  esac
fi

# ── A14: a competitor's own-funded win is NOT reported as our spend ──────────
# The mirror of A13. Same observable revert, opposite ledger consequence: nothing of ours moved, so
# the reservation must be released. A false positive here strands capacity on every lost race.
if [[ -f .e2e-stress-report.json ]]; then
  competitor="$(jq -r '.competitorResult // "skipped"' .e2e-stress-report.json)"
  case "$competitor" in
    won)
      # Losing a race requires having been in one. The drive script now waits for the bot to reach
      # this vault before taking it, and records whether it managed to — so this reads that fact
      # rather than inferring it. Deliberately NOT from `tx_intents`: an attempt that dies at gas
      # estimation is exactly the case this assertion is about, and it returns before `commit`
      # writes any intent, so the table cannot see it.
      comp_vault="$(jq -r '.competitorVault // ""' .e2e-stress-report.json)"
      if [[ "$(jq -r '.competitorRaced // 0' .e2e-stress-report.json)" != "1" ]]; then
        printf "[SKIP] A14 competitor took %s before the bot ever reached it (no race to lose)\n" \
          "${comp_vault:0:10}…"
      elif [[ "$(metric_value 'arbitrageur_errors_total{type="race_lost"}')" -lt 1 ]]; then
        flunk "A14 the bot attempted ${comp_vault:0:10}…, a competitor took it, but no race_lost was recorded"
      else
        races="$(metric_value 'arbitrageur_errors_total{type="race_lost"}')"
        pass "A14 competitor's own-funded win settled as a lost race (${races} occurrence(s))"
      fi
      ;;
    *) printf "[SKIP] A14 no competitor acquisition (%s)\n" "$competitor" ;;
  esac
fi

# ── A6/A7: fence + recovery, as observed by the drive script ─────────────────
if [[ -f .e2e-stress-report.json ]]; then
  fence="$(jq -r .fence .e2e-stress-report.json)"
  recovery="$(jq -r .recovery .e2e-stress-report.json)"
  case "$fence" in
    held)     pass "A6 nonce fence held inside the grace window" ;;
    violated) flunk "A6 fence violated — dropped nonce was reissued while presumed live" ;;
    *)        printf "[SKIP] A6 fence not exercised (%s)\n" "$fence" ;;
  esac
  case "$recovery" in
    recovered) pass "A7 dropped subject recovered and confirmed after the grace window" ;;
    stalled)   flunk "A7 dropped subject never confirmed — the eviction stalled it permanently" ;;
    *)         printf "[SKIP] A7 recovery not exercised (%s)\n" "$recovery" ;;
  esac
else
  flunk "no .e2e-stress-report.json — the drive script did not complete"
fi

# ── A9: no wedge ─────────────────────────────────────────────────────────────
inflight="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE status IN ('pending','submitted');")"
if [[ "${inflight:-1}" == "0" ]]; then pass "A9 nothing left in flight"
else flunk "A9 ${inflight} intent(s) still in flight"; fi

health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9091/health" || echo 000)"
if [[ "$health" == "200" ]]; then pass "A9 bot healthy (/health 200)"
else flunk "A9 /health returned $health"; fi

printf "\n"
if [[ "$FAILED" == "0" ]]; then printf "=== E2E Stress Test PASSED ===\n\n"; exit 0
else printf "=== E2E Stress Test FAILED ===\n\n"; exit 1; fi
