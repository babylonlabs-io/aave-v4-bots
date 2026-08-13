#!/usr/bin/env bash
# Phase driver for the dual-engine nonce stress suite. Setup leaves every position HEALTHY; this
# script owns every transition after that:
#
#   0  start the bot (setup defers it until forge has flushed every deploy)
#   1  switch anvil to interval mining, so the bot's sends actually queue
#   2  wave #1 — price drop #1, cohort A becomes liquidatable
#   3  wave #1 chaos: evict an UNMINED tx, then assert (i) its nonce is not reissued inside the
#      grace window and (ii) work continues past it once the window expires
#   4  quiesce — wave #1 fully drained
#   5  wave #2 — price drop #2, cohort B becomes liquidatable
#   6  wave #2 chaos: kill -9 mid-flight, restart, let reconcile resolve the live intents
#   7  restore automine for verification
#
# One chaos event per wave, and BOTH gate on `wait_for_backlog` rather than on elapsed time — a
# crash with nothing in flight exercises no recovery, and an eviction with nothing unmined has
# nothing to evict. Earlier revisions ran the eviction after the crash and then after wave #2's
# drop; in both positions every candidate had already mined and the phase could only skip.
#
# Everything it observes is written to .e2e-stress-report.json for the verify script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

RPC="${E2E_RPC_URL:-http://127.0.0.1:8545}"
DB_URL="postgresql://ponder:ponder@localhost:5432/ponder_arbitrageur"
PG="docker exec -e PGPASSWORD=ponder e2e-pg psql -U ponder -d ponder_arbitrageur -tAc"
ADMIN_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
SIGNER="0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"   # ARBITRAGEUR / APP_OPERATOR_0
# 8s, not the 2s the spike used. A backlog only forms if the bot can issue several sends within one
# block interval, and each send costs a gas estimate, a simulation, a risk-gate slot and a store
# write — measured at roughly 1-2s, so 2s blocks mined each tx before the next was ready (observed
# peak backlog: 1). Wider blocks are what make the queue, which is the whole point of the suite.
BLOCK_TIME="${E2E_STRESS_BLOCK_TIME:-8}"
GRACE_MS=30000                                          # UNKNOWN_TX_GRACE_MS in @repo/engine

PRICE_FEED="$(cat .e2e-stress-pricefeed)"

log()  { printf "\n▸ %s\n" "$*"; }
ok()   { printf "✓ %s\n" "$*"; }
fail() { printf "✗ %s\n" "$*" >&2; exit 1; }

n_latest()  { cast nonce "$SIGNER" --rpc-url "$RPC"; }
n_pending() { cast nonce "$SIGNER" --rpc-url "$RPC" --block pending; }
sql()       { $PG "$1" 2>/dev/null | tr -d ' \r'; }

# Live intents = those the bot still considers in flight. `submitted`/`pending` carry a nonce.
live_intents() { sql "SELECT COUNT(*) FROM bot.tx_intents WHERE status IN ('pending','submitted');"; }

# The indexer both bots read from. `live_intents` only answers "is THIS bot idle", which under racing
# goes to 0 the instant its slots settle — including the ones it lost. These answer the questions the
# suite actually cares about: is the cascade cleared, and has the escrow it produced been bought.
PONDER="http://localhost:42070"
jlen() { curl -s --max-time 5 "$PONDER/$1" 2>/dev/null | jq "(.$2 // []) | length" 2>/dev/null || echo ""; }
remaining_escrow()       { jlen "escrowed-vaults" "vaults"; }
confirmed_acquisitions() { sql "SELECT COUNT(*) FROM bot.tx_intents WHERE action='vault-acquisition' AND status='confirmed';"; }
now_s() { date +%s; }

# How many vaults the cascade actually put into escrow, counted from BTCVaultSwap's own AddedVault
# events. This is the only honest target for the drain: the liquidation count is not, because not
# every liquidation escrows a vault (the competitor liquidator's own target is liquidated and
# counted, but produces no AddedVault). `AddedVault` is cumulative history, so acquisitions removing
# vaults from escrow do not shrink it.
VAULT_SWAP="$(jq -r '.addresses.BTCVaultSwap // empty' deployments/local.json 2>/dev/null || true)"
escrowed_vaults() {
  [[ -z "$VAULT_SWAP" ]] && { echo ""; return; }
  cast logs --rpc-url "$RPC" --from-block 0 --address "$VAULT_SWAP" "AddedVault(bytes32)" 2>/dev/null \
    | grep -c 'transactionHash:' || true
}

# Cohort sizes, from the files setup wrote. Needed by the drains below, not just the report.
COHORT_A_N="$(tr ',' '\n' < .e2e-stress-cohort-a 2>/dev/null | grep -c . || true)"; COHORT_A_N="${COHORT_A_N:-0}"
COHORT_B_N="$(tr ',' '\n' < .e2e-stress-cohort-b 2>/dev/null | grep -c . || true)"; COHORT_B_N="${COHORT_B_N:-0}"
LIQ_TOTAL_N=$(( COHORT_A_N + COHORT_B_N ))

# Confirmed liquidations across BOTH bots — the arbitrageur's own store plus the competitor's log.
# This is the ground truth the completion checks use. The indexer's remaining-work view cannot serve:
# it reads 0 both before it has caught up with a price drop AND after the cascade is cleared, so a
# drain to zero proves nothing on its own. A count only ever goes up.
liquidations_done() {
  local arb comp
  arb="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE action='liquidation' AND status='confirmed';")"
  comp="$(grep -c 'Liquidation confirmed in block' /tmp/liq-bot.log 2>/dev/null || true)"
  echo $(( ${arb:-0} + ${comp:-0} ))
}

# Wait for a count to REACH a target. Echoes "<count> <elapsed_s>".
wait_for_count() {
  local label="$1" reader="$2" target="$3" timeout="$4" start n=0
  start="$(now_s)"
  for (( i = 0; i < timeout; i++ )); do
    n="$($reader)"
    (( i % 10 == 0 )) && printf "  [%3ss] %s: %s/%s\n" "$i" "$label" "${n:-0}" "$target" >&2
    [[ "${n:-0}" -ge "$target" ]] && break
    sleep 1
  done
  # A timeout returns the last count rather than failing — verify decides. Say so, or the caller's
  # "settled" line reads as completion when the target was never reached.
  [[ "${n:-0}" -ge "$target" ]] || printf "! %s timed out at %s/%s\n" "$label" "${n:-0}" "$target" >&2
  printf '%s %s\n' "${n:-0}" "$(( $(now_s) - start ))"
}

drop_price() {
  cast send --private-key "$ADMIN_KEY" --rpc-url "$RPC" \
    "$PRICE_FEED" "simulatePriceDrop(uint256)" "$1" >/dev/null
}

# The cohort split guard runs in forge, not here: it needs a position's proxy, and `getPosition`
# returns a struct whose first member is a `bytes32[]`. Decoding that in bash gave a false
# "not liquidatable" result; `StressCohortCheck` reads it as a typed struct instead.
cohort_check() {
  local out rc
  out="$(STRESS_PHASE="$1" forge script test/e2e/StressCohortCheck.s.sol:StressCohortCheck \
          --rpc-url "$RPC" --ffi 2>&1)"
  rc=$?
  printf '%s\n' "$out" | grep -E "\[PASS\]|revert|Error" | sed 's/^/  /' || true
  return $rc
}

# Block until the bot genuinely has durable work at risk: live intents the store must reconcile AND
# transactions actually sitting in the mempool. Both chaos events gate on this, because both are
# meaningless otherwise — a crash with nothing in flight tests no recovery, and an eviction with
# nothing unmined has nothing to evict.
wait_for_backlog() {
  local label="$1" best_li=0 best_depth=0 li lat pen depth
  log "Waiting for durable in-flight work before ${label} (live intents >= 2 AND backlog >= 2)"
  for i in $(seq 1 180); do
    li="$(live_intents || echo 0)"; lat="$(n_latest)"; pen="$(n_pending)"
    depth=$(( pen - lat ))
    (( li > best_li )) && best_li=$li
    (( depth > best_depth )) && best_depth=$depth
    (( i % 10 == 0 )) && printf "  [%2ss] live intents=%s backlog=%s (peak %s/%s)\n" "$i" "$li" "$depth" "$best_li" "$best_depth"
    if [[ "${li:-0}" -ge 2 && "$depth" -ge 2 ]]; then
      printf "  live intents=%s backlog=%s -> %s\n" "$li" "$depth" "$label"
      return 0
    fi
    sleep 1
  done
  printf "! never reached the threshold (peak live intents=%s, peak backlog=%s)\n" "$best_li" "$best_depth" >&2
  tail -20 /tmp/arb-bot.log >&2 2>/dev/null || true
  return 1
}

# ── 0. start the bot ─────────────────────────────────────────────────────────
# Deferred out of setup: forge flushes its broadcasts only after the script body returns, so the
# Lens deploy lands too late for the base class's bounded wait. By now forge has exited and every
# contract is on chain.
# ── 0a. private submission (STRESS_PRIVATE) ──────────────────────────────────
# Put a stand-in Flashbots Protect between the bot and anvil, so the bot's transactions become
# invisible to its own node — which is the whole premise of the private-submission liveness work
# and the one condition a public mempool cannot produce.
#
# Note which URL changes: `CLIENT_RPC_URL` still points at anvil. That asymmetry IS the hazard —
# the bot reads the chain from a node that cannot see what it sent.
RELAY_PID=""
# The relay's retry window and the reorg headroom past it, in blocks — the two numbers the whole
# private phase is measured in. The fake relay stamps every transaction with the first, and the bot
# is told both, so "fenced" and "released" are read off the same deadline rather than a duration
# that happens to work.
RELAY_HORIZON_BLOCKS=4
RECLAIM_MARGIN_BLOCKS=2
if [[ -n "${STRESS_PRIVATE:-}" ]]; then
  # A relay leaked from an earlier run is worse than none: it answers on the same port with the
  # PREVIOUS run's withheld hashes, so this run reads a transaction that its own fresh database has
  # never heard of and the phase fails for a reason that has nothing to do with the bot.
  if curl -s --max-time 2 "http://127.0.0.1:8555/__seen" >/dev/null 2>&1; then
    fail "something is already listening on :8555 — a fake relay leaked from an earlier run; kill it first"
  fi
  # Reap it however this script exits, including `fail`, so the next run starts clean.
  trap '[[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true' EXIT
  log "Private submission: starting the fake relay on :8555"
  FAKE_RELAY_PORT=8555 FAKE_RELAY_UPSTREAM="$RPC" FAKE_RELAY_HORIZON_BLOCKS="$RELAY_HORIZON_BLOCKS" \
    node test/e2e/scripts/fake-relay.mjs >/tmp/fake-relay.log 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 30); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8555/tx/0x00" || echo 000)" == "200" ]] && break
    sleep 1
  done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8555/tx/0x00" || echo 000)" == "200" ]] \
    || fail "fake relay never came up — see /tmp/fake-relay.log"
  # The bot's declared horizon matches the relay's actual one, so the phase observes recovery
  # *after* the deadline the relay stated rather than before it. Both are compressed far below
  # Protect's ~25 blocks: at this harness's block time the relay's window plus the reorg margin is
  # about a minute, which is what keeps the run short without making the assertion a lie.
  #
  # `TX_RECEIPT_TIMEOUT_MS` is cut from its 120s default because a withheld transaction is one whose
  # receipt never arrives: the engine blocks for the whole budget before it can even begin to
  # recover. That is real behaviour rather than a test artifact — it is just far longer than this
  # phase should wait to observe the recovery that follows it.
  cat >> ./.env.arbitrageur <<PRIVENV
SUBMITTER=flashbots-protect
FLASHBOTS_PROTECT_URL=http://127.0.0.1:8555
FLASHBOTS_STATUS_URL=http://127.0.0.1:8555
PRIVATE_MIN_PRIORITY_FEE_WEI=1000000000
PRIVATE_RELAY_HORIZON_BLOCKS=$RELAY_HORIZON_BLOCKS
PRIVATE_RECLAIM_MARGIN_BLOCKS=$RECLAIM_MARGIN_BLOCKS
TX_RECEIPT_TIMEOUT_MS=25000
PRIVENV
  ok "relay up; bot configured for private submission"
fi

BOT_READY=0
log "Starting the bot (setup deferred it until all deploys landed)"
# Subshell so `.env.arbitrageur` stays contained — sourcing it into the parent would leak the arb's
# DATABASE_URL, RISK_CONTROL_* and code-hash vars into the racing liquidator we start below, which
# then crashes trying to bind the arb's already-held control port.
( set -a; . ./.env.arbitrageur; set +a; exec pnpm arbitrageur:run ) >/tmp/arb-bot.log 2>&1 &
for _ in $(seq 1 90); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9091/health || echo 000)" == "200" ]] && BOT_READY=1 && break
  sleep 1
done
# Falling out of the loop is not readiness. Without this the run continues against a bot that never
# came up and every later phase fails obscurely instead of here.
[[ "${BOT_READY:-0}" == "1" ]] || fail "bot never became healthy on :9091 — see /tmp/arb-bot.log"
grep -q "Risk gate HALTED" /tmp/arb-bot.log 2>/dev/null && fail "bot booted HALTED — check the code-hash guard"
ok "bot running"

# Which phases this run does.
#
# The nonce-chaos phases (eviction, crash, acquisition gap) need a durable backlog the bot will
# still add to. Two modes cannot give them that, for opposite reasons:
#
#   RACING  the competing liquidator wins most liquidations, so the arbitrageur never builds one.
#   ROUTER  each acquisition costs an extra block read, a chain-id read and a signature, so by the
#           time a nonce is burned every remaining vault already has a live intent. The bot
#           correctly issues nothing new — and a burned nonce is reclaimed by the *next* send, not
#           by reconcile — so the queue behind it never drains and the run stalls. The world here
#           is seven positions; in production new opportunities keep arriving and fill the gap.
#
# Both keep the invariants they exist to test: RACING observes competitive degradation, ROUTER
# observes what happens when someone else executes our own authorization.
CHAOS=1
if [[ -n "${STRESS_RACING:-}" || -n "${STRESS_ROUTER:-}" || -n "${STRESS_PRIVATE:-}" ]]; then CHAOS=""; fi

# STRESS_RACING: a standalone liquidator racing the arbitrageur's own liquidation engine. Its env
# (.env.liquidator) was written by the setup script and points at the arbitrageur's indexer, so both
# bots see the same liquidatable feed. It runs AUTO on the LIQUIDATOR signer — independent nonces, so
# this is about competitive degradation, not nonce sharing.
if [[ -n "${STRESS_RACING:-}" ]]; then
  LIQ_READY=0
  log "Starting the competing standalone liquidator (racing)"
  ( set -a; . ./.env.liquidator; set +a; exec pnpm liquidator:run ) >/tmp/liq-bot.log 2>&1 &
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9090/health || echo 000)" == "200" ]] && LIQ_READY=1 && break
    sleep 1
  done
  [[ "${LIQ_READY:-0}" == "1" ]] || fail "racing liquidator never became healthy on :9090 — see /tmp/liq-bot.log"
  grep -q "Risk gate HALTED" /tmp/liq-bot.log 2>/dev/null && fail "racing liquidator booted HALTED"
  ok "racing liquidator running (metrics :9090)"
fi

# ── 1. interval mining ───────────────────────────────────────────────────────
# Only for the nonce-stress run. Interval mining exists to build a single-signer backlog for the
# crash/eviction phases — both skipped under racing. Keeping it there only hurts: with the loser
# taking a whole wave's vaults at once, the arbitrageur's acquisition queue outgrows the receipt
# timeout and sticks. So racing stays on automine — the two bots still contend (through the indexer
# feed's lag) and every acquisition settles immediately.
if [[ -z "${STRESS_RACING:-}" ]]; then
  # Kept under ROUTER even though its chaos phases are off: leaving transactions unmined for a
  # block interval is exactly what gives the front-run phase a batch to copy.
  log "Switching to interval mining (${BLOCK_TIME}s blocks)"
  cast rpc evm_setIntervalMining "$BLOCK_TIME" --rpc-url "$RPC" >/dev/null \
    || fail "evm_setIntervalMining not supported"
  ok "queueing enabled"
else
  log "Racing: staying on automine (nonce chaos is skipped; interval mining would starve acquisitions)"
fi

# ── 2. wave #1 ───────────────────────────────────────────────────────────────
log "Wave #1: price drop -40% (cohort A becomes liquidatable)"
drop_price 40
ok "drop applied"

# The calibration guard. If cohort B flips here too, both waves collapse into one and the rest of
# the suite would still pass — a strictly weaker test that looks identical to a passing one. Assert
# the split is real before anything else runs.
log "Verifying cohort split (A liquidatable, B still healthy)"
cohort_check 1 || fail "cohort split wrong after drop #1 — see the revert above"
ok "split holds"

# Halting the chain takes BOTH flags. `evm_setIntervalMining 0` only turns the interval off — anvil
# then falls back to automine and mines on every transaction, which is the opposite of frozen.
freeze_chain() {
  cast rpc evm_setAutomine false --rpc-url "$RPC" >/dev/null 2>&1 || true
  cast rpc evm_setIntervalMining 0 --rpc-url "$RPC" >/dev/null 2>&1 || true
}
thaw_chain() {
  cast rpc evm_setIntervalMining "$BLOCK_TIME" --rpc-url "$RPC" >/dev/null 2>&1 || true
}

# ── 2c. front-run our own authorization (STRESS_ROUTER) ──────────────────────
# The one hazard permissionless relaying introduces, reproduced against the running bot.
#
# Under router funding an acquisition is a signed `relay(message, signature)` batch. The signature
# carries no nonce and is not bound to a submitter, so anyone holding the calldata can execute it —
# and the calldata is visible before we broadcast, because gas estimation puts it in front of an RPC
# first. Here a separate account lifts an unmined batch of ours and submits it with a higher gas
# price. It wins; our own transaction then reverts on a vault that is already gone.
#
# From the receipt alone that is indistinguishable from losing a race. The difference is decisive
# for the ledger: the treasury's WBTC *did* leave, under our own signature, so releasing the
# reservation would let the next acquisition spend money that is already spent. The bot is expected
# to see the router's `SwapWbtcToVault` event and settle `spent`, which A13 asserts.
FRONTRUN_RESULT="skipped"; FRONTRUN_VAULT=""
if [[ -n "${STRESS_ROUTER:-}" ]]; then
  ROUTER_ADDR="$(cat .e2e-arbitrage-router 2>/dev/null || true)"
  FRONTRUNNER_KEY="$(cast --to-uint256 1001)"
  if [[ ! "$ROUTER_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    printf "! no router address recorded; front-run phase skipped\n" >&2
  else
    log "Front-run: waiting for an unmined relay batch to copy"
    # Freeze at the moment a target is found. Freezing first would deadlock — the bot needs blocks
    # to produce the batch — and freezing after reading the calldata loses the race to our own
    # transaction. So: find one, freeze, confirm it is still unmined, thaw and retry if not.
    FR_HASH=""
    for _ in $(seq 1 180); do
      cand="$(sql "SELECT tx_hash FROM bot.tx_intents WHERE action='vault-acquisition' AND status IN ('pending','submitted') AND tx_hash IS NOT NULL ORDER BY nonce ASC LIMIT 1;")"
      if [[ ! "$cand" =~ ^0x[0-9a-fA-F]{64}$ ]]; then sleep 1; continue; fi
      if [[ "$(cast rpc eth_getTransactionReceipt "$cand" --rpc-url "$RPC" 2>/dev/null)" != "null" ]]; then
        sleep 1; continue
      fi
      freeze_chain
      if [[ "$(cast rpc eth_getTransactionReceipt "$cand" --rpc-url "$RPC" 2>/dev/null)" == "null" ]]; then
        FR_HASH="$cand"; break
      fi
      thaw_chain; sleep 1
    done

    if [[ -z "$FR_HASH" ]]; then
      thaw_chain
      printf "! never saw an unmined acquisition; front-run phase skipped\n" >&2
    else
      FR_DATA="$(cast tx "$FR_HASH" input --rpc-url "$RPC" 2>/dev/null || true)"
      FRONTRUN_VAULT="$(sql "SELECT subject FROM bot.tx_intents WHERE tx_hash='$FR_HASH' LIMIT 1;")"
      if [[ -z "$FR_DATA" || "$FR_DATA" == "0x" ]]; then
        thaw_chain
        printf "! could not read calldata for %s; front-run phase skipped\n" "$FR_HASH" >&2
      else
        printf "  copying %s (vault %s) as the front-runner\n" "$FR_HASH" "$FRONTRUN_VAULT"
        # `--gas-limit` is load-bearing: it suppresses estimation. Estimation runs against the
        # PENDING block, which already holds the bot's own queued relay for this vault, so it
        # reverts `VaultNotAcquirable` on a state that has already applied the transaction we are
        # racing. `--legacy` because `--gas-price` alone yields a 1559 tx whose priority fee
        # exceeds its max fee. `--async` returns the hash so both can share one block, which is why
        # the receipt below — not the send — decides whether this actually executed.
        FR_OUT="$(cast send "$ROUTER_ADDR" --data "$FR_DATA" \
             --private-key "$FRONTRUNNER_KEY" --async --gas-limit 3000000 \
             --legacy --gas-price 50000000000 --rpc-url "$RPC" 2>&1 | tail -1)" && FR_SENT=1 || FR_SENT=0
        cast rpc evm_mine --rpc-url "$RPC" >/dev/null 2>&1 || true
        thaw_chain

        if [[ "$FR_SENT" != "1" || ! "$FR_OUT" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
          FRONTRUN_RESULT="rejected"
          printf "! front-runner submission failed: %s\n" "$FR_OUT" >&2
        else
          FR_STATUS="$(cast receipt "$FR_OUT" status --rpc-url "$RPC" 2>/dev/null || echo "")"
          if [[ "$FR_STATUS" == "true" || "$FR_STATUS" == "1" || "$FR_STATUS" == "success" ]]; then
            FRONTRUN_RESULT="executed"
            ok "front-runner executed our authorization ($FR_OUT)"
          else
            FRONTRUN_RESULT="reverted"
            printf "! front-runner tx %s reverted (status %s)\n" "$FR_OUT" "${FR_STATUS:-unknown}" >&2
          fi
        fi
      fi
    fi
  fi
fi

# Declared unconditionally: the report reads them on every path, and the eviction phase that sets
# them for real is skipped in the modes that turn chaos off.
FENCE_RESULT="skipped"; RECOVERY_RESULT="skipped"; DROP_HASH=""; DROP_NONCE=""

# ── 2d. a privately-submitted transaction the relay never lands (STRESS_PRIVATE) ──
# The outcome no public mempool can produce, and the one the whole liveness seam exists for.
#
# The relay accepts a transaction, returns its hash, and never forwards it. Our own node therefore
# never hears of it: `isKnown` says no and the pending count omits it. Two things must then hold,
# and they pull in opposite directions:
#
#   BEFORE the horizon  the nonce stays fenced. Reissuing it would sign a second transaction over
#                       one the relay may still land — and reconcile must not declare the intent
#                       dead either, or the engine re-drives the same action.
#   AFTER  the horizon  the nonce is released. Nonces are consumed in order, so a permanently
#                       fenced one leaves every later transaction unmineable behind the gap: not a
#                       degraded bot, a dead one.
#
# The line between them is the relay's own deadline for THIS transaction (`maxBlockNumber`), which
# the bot records at submission — so the phase reads both halves off the same number the relay
# stated, rather than off a duration chosen to fall between them.
PRIVATE_RESULT="skipped"; PRIVATE_NONCE=""
if [[ -n "${STRESS_PRIVATE:-}" ]]; then
  log "Private submission: withholding the next transaction at the relay"
  curl -s -X POST "http://127.0.0.1:8555/__withhold?count=1" >/dev/null || fail "relay control unreachable"

  # Wait for the bot to send one and for the relay to confirm it swallowed it.
  WITHHELD=""
  for _ in $(seq 1 120); do
    WITHHELD="$(curl -s http://127.0.0.1:8555/__seen | python3 -c 'import sys,json; w=json.load(sys.stdin)["withheld"]; print(w[0] if w else "")' 2>/dev/null || true)"
    [[ -n "$WITHHELD" ]] && break
    sleep 1
  done

  if [[ -z "$WITHHELD" ]]; then
    printf "! bot sent nothing while withholding was armed; private phase skipped\n" >&2
  else
    # The bot persisted this hash BEFORE broadcasting, so the intent is findable by it — which also
    # proves the relay returned the same hash the bot derived locally.
    PRIVATE_NONCE="$(sql "SELECT nonce FROM bot.tx_intents WHERE tx_hash='$WITHHELD';")"
    [[ "$PRIVATE_NONCE" =~ ^[0-9]+$ ]] || fail "withheld tx $WITHHELD has no persisted intent — the relay's hash and the bot's disagree"
    ok "withheld $WITHHELD at nonce $PRIVATE_NONCE (invisible to our own node)"

    cast tx "$WITHHELD" --rpc-url "$RPC" >/dev/null 2>&1 \
      && fail "the withheld tx reached anvil — the relay forwarded what it should have swallowed"

    # The relay's stated deadline, and the bot's record of it. Recording it is what makes the fence
    # releasable at all: the relay-aware reader answers "live" to everything, so a missing horizon
    # means this nonce is fenced forever. It may exceed the relay's (the bot reads its own head a
    # moment later) but must never fall short of it, which would free a nonce the relay may spend.
    RELAY_MAX="$(curl -s "http://127.0.0.1:8555/tx/$WITHHELD" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["maxBlockNumber"])')"
    # Polled, not read once: the horizon is written on the transition that follows the send, so it
    # can trail the relay's acknowledgement by a moment.
    PERSISTED_MAX=""
    for _ in $(seq 1 15); do
      PERSISTED_MAX="$(sql "SELECT relay_max_block FROM bot.tx_intents WHERE tx_hash='$WITHHELD';")"
      [[ "$PERSISTED_MAX" =~ ^[0-9]+$ ]] && break
      sleep 1
    done
    [[ "$PERSISTED_MAX" =~ ^[0-9]+$ ]] \
      || fail "withheld tx $WITHHELD has no recorded relay horizon — its nonce can never be released"
    [[ "$PERSISTED_MAX" -ge "$RELAY_MAX" ]] \
      || fail "recorded horizon $PERSISTED_MAX is shorter than the relay's $RELAY_MAX — the nonce would be freed while the relay can still land it"
    ok "horizon recorded: block $PERSISTED_MAX (relay stated $RELAY_MAX)"

    # (i) fenced. Sample until the chain reaches the relay's stated deadline; any *other* intent
    # taking this nonce inside that window is a reuse of a nonce the relay may still spend. The
    # window has to still be open when we get here, or the loop below asserts over nothing.
    [[ "$(cast block-number --rpc-url "$RPC")" -le "$RELAY_MAX" ]] \
      || fail "horizon $RELAY_MAX already passed before the fence could be observed — raise RELAY_HORIZON_BLOCKS"
    while [[ "$(cast block-number --rpc-url "$RPC")" -le "$RELAY_MAX" ]]; do
      dupes="$(sql "SELECT count(*) FROM bot.tx_intents WHERE nonce=$PRIVATE_NONCE AND tx_hash<>'$WITHHELD';")"
      [[ "$dupes" == "0" ]] || fail "nonce $PRIVATE_NONCE reissued at block $(cast block-number --rpc-url "$RPC"), before the relay's horizon $RELAY_MAX"
      sleep 2
    done
    ok "nonce $PRIVATE_NONCE held to block $RELAY_MAX while the relay still reported it live"

    # (ii) released. Past the recorded horizon plus its reorg margin the bot must be able to land
    # transactions again — either by refilling the gap at this nonce or by moving past it. A stall
    # shows up as neither happening.
    BEFORE_CONFIRMED="$(sql "SELECT count(*) FROM bot.tx_intents WHERE status='confirmed';")"
    PRIVATE_RESULT="stalled"
    for _ in $(seq 1 150); do
      now_confirmed="$(sql "SELECT count(*) FROM bot.tx_intents WHERE status='confirmed';")"
      if [[ "${now_confirmed:-0}" -gt "${BEFORE_CONFIRMED:-0}" ]]; then PRIVATE_RESULT="recovered"; break; fi
      sleep 1
    done
    [[ "$PRIVATE_RESULT" == "recovered" ]] \
      || fail "no transaction confirmed in 150s past horizon $PERSISTED_MAX (+$RECLAIM_MARGIN_BLOCKS) — the signer is stalled behind nonce $PRIVATE_NONCE"
    ok "bot resumed landing transactions after the reclaim horizon"
  fi
fi

# ── 3. wave #1 chaos: forced mempool eviction (the nonce fence) ──────────────
# Gated on a CONFIRMED backlog rather than on elapsed time. Earlier revisions ran this after the
# crash, and later after wave #2's drop; both times every candidate tx had already mined and the
# phase could only skip. The backlog wait is the one moment we know transactions are in the mempool.
#
# Skipped under racing: the competing liquidator wins most liquidations, so the arbitrageur never
# builds a durable backlog to evict against. The nonce fence is proven by the non-racing run; the
# racing run's job is the competitive-degradation observation (§6c), not re-proving the invariants.
if [[ -n "$CHAOS" ]]; then
wait_for_backlog "eviction" || fail "no durable in-flight work — nothing to evict"

# Only meaningful against an intent carrying BOTH a nonce and a tx hash — `liveNonceFloor` filters
# on exactly that, so anything else would make the fence trivially disengaged and 4a pass for the
# wrong reason.
log "Phase 2b: waiting for an UNMINED live intent to evict"
DROP_HASH=""; DROP_NONCE=""; DROP_SUBJECT=""
for _ in $(seq 1 90); do
  # Comma-delimited, NOT space: `sql()` runs `tr -d ' '`, which would eat a space separator and
  # leave hash and nonce concatenated into one unusable token.
  row="$(sql "SELECT tx_hash||','||nonce||','||subject FROM bot.tx_intents WHERE status IN ('pending','submitted') AND tx_hash IS NOT NULL AND nonce IS NOT NULL ORDER BY updated_at DESC LIMIT 1;")"
  if [[ -n "$row" ]]; then
    cand_hash="${row%%,*}"
    # Only a tx still sitting in the mempool can be evicted. One that already mined would leave
    # `pending` unchanged, and the fence would never be asked anything — so keep looking.
    #
    # Ask for the receipt over raw RPC, NOT via `cast receipt`: that command *waits* for the tx to
    # be mined (measured: it blocks for the whole block interval and then reports success), so it
    # can never answer "still pending" and this loop could only ever skip. `eth_getTransactionReceipt`
    # returns `null` immediately for an unmined tx.
    if [[ "$(cast rpc eth_getTransactionReceipt "$cand_hash" --rpc-url "$RPC" 2>/dev/null)" == "null" ]]; then
      IFS="," read -r DROP_HASH DROP_NONCE DROP_SUBJECT <<< "$row"; break
    fi
  fi
  sleep 1
done

FENCE_RESULT="skipped"; RECOVERY_RESULT="skipped"
if [[ -z "$DROP_HASH" ]]; then
  printf "! no droppable intent observed; phase 2b skipped\n" >&2
else
  # Both fields must look like what they are. A malformed nonce would make every SQL predicate below
  # error out, return empty, and read as "no reuse" — a fence result that passes without testing
  # anything.
  [[ "$DROP_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "parsed tx hash is malformed: '$DROP_HASH'"
  [[ "$DROP_NONCE" =~ ^[0-9]+$ ]] || fail "parsed nonce is malformed: '$DROP_NONCE'"
  printf "  dropping %s (nonce %s)\n" "$DROP_HASH" "$DROP_NONCE"

  before_pending="$(n_pending)"
  cast rpc anvil_dropTransaction "$DROP_HASH" --rpc-url "$RPC" >/dev/null 2>&1 || true
  after_pending="$(n_pending)"
  printf "  chain pending: %s -> %s\n" "$before_pending" "$after_pending"

  if [[ "$after_pending" -ge "$before_pending" ]]; then
    # Nothing was evicted (already mined, or the node declined), so `pending` never rewound and the
    # fence was never asked to do anything. Reporting "held" here would be a pass for the wrong
    # reason — the exact false positive this phase exists to avoid.
    FENCE_RESULT="not-evicted"
    printf "! tx was not evicted (pending %s -> %s); fence not exercised\n" "$before_pending" "$after_pending" >&2
  else
    # 4a — inside the 30s grace window the intent is presumed live, so the allocator must NOT hand
    # nonce DROP_NONCE to anyone else. Observable consequence: no *other* tx hash appears at it.
    sleep 5
    reuse="$(sql "SELECT COUNT(DISTINCT tx_hash) FROM bot.tx_intents WHERE nonce = ${DROP_NONCE} AND tx_hash IS NOT NULL;")"
    if [[ "${reuse:-0}" -eq 1 ]]; then FENCE_RESULT="held"; ok "fence held inside grace (nonce ${DROP_NONCE} not reissued)"
    elif [[ "${reuse:-0}" -gt 1 ]]; then FENCE_RESULT="violated"; printf "✗ nonce %s reissued while presumed live\n" "$DROP_NONCE" >&2
    else FENCE_RESULT="no-data"; printf "! no intent rows at nonce %s\n" "$DROP_NONCE" >&2; fi
  fi

  # 4b — past the grace window the node's "unknown" is believed, the fence releases, and reconcile
  # must fail the old intent and re-drive its subject under a FRESH nonce.
  # Past the grace window the node's "unknown" is believed, the fence releases, and reconcile must
  # fail the old intent so its subject can be re-driven under a FRESH nonce.
  #
  # Assert on THAT subject, not on "any intent with a higher nonce": other engines are working
  # concurrently, so a higher nonce elsewhere proves nothing about the dropped action recovering.
  # And poll rather than sampling once — reconcile only re-drives on its next cycle, which lands
  # some unpredictable interval after the window expires.
  # The invariant is that the dropped action RECOVERS — not that it recovers on a higher nonce.
  # Once the grace window expires the node's "unknown" is believed, the fence releases, and the
  # allocator is free to hand nonce ${DROP_NONCE} straight back out: nothing occupies it, so reusing
  # it is correct and leaves no gap. An earlier version of this check demanded a *higher* nonce and
  # reported a stall on a run where `latest == pending` proved the sequence had fully drained.
  log "Phase 2b-ii: waiting out the ${GRACE_MS}ms grace window, then for ${DROP_SUBJECT} to resolve"
  sleep $(( GRACE_MS / 1000 + 5 ))
  for _ in $(seq 1 60); do
    recovered="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE subject = '${DROP_SUBJECT}' AND status = 'confirmed';")"
    if [[ "${recovered:-0}" -ge 1 ]]; then break; fi
    sleep 2
  done
  # Evidence, so the mechanism is on the record rather than inferred: every intent row for the
  # dropped subject, with the nonce it ultimately used.
  printf "  intents for %s:\n" "$DROP_SUBJECT"
  # Pipe-separated, not spaced: `sql()` strips spaces, which would run the columns together.
  sql "SELECT status||'|nonce='||COALESCE(nonce::text,'-')||'|tx='||COALESCE(substring(tx_hash,1,12),'-') FROM bot.tx_intents WHERE subject='${DROP_SUBJECT}' ORDER BY updated_at;" | sed 's/^/    /' || true
  if [[ "${recovered:-0}" -ge 1 ]]; then RECOVERY_RESULT="recovered"; ok "dropped subject recovered and confirmed"
  else RECOVERY_RESULT="stalled"; printf "! subject %s never reached confirmed\n" "$DROP_SUBJECT" >&2; fi
fi


sleep 60   # let both engines work the second wave


else
  log "Chaos phases off for this mode: skipping eviction"
fi

# ── 4. quiesce ───────────────────────────────────────────────────────────────
# Drain on the CASCADE being cleared, not on the bot going idle. `live_intents == 0` is satisfied the
# moment this bot's slots settle — under racing that includes every race it lost — so it returned
# instantly and the run advanced with most of the cohort still liquidatable.
log "Draining wave #1 (waiting for every cohort A position to be liquidated)"
read -r W1_DONE W1_SECS <<< "$(wait_for_count "liquidations" liquidations_done "$COHORT_A_N" 300)"
for _ in $(seq 1 30); do [[ "$(live_intents || echo 0)" == "0" ]] && break; sleep 1; done
ok "wave #1 settled in ${W1_SECS}s (${W1_DONE}/${COHORT_A_N} liquidated, live intents: $(live_intents))"

# ── 5. wave #2 ───────────────────────────────────────────────────────────────
log "Wave #2: price drop -35% (cohort B becomes liquidatable)"
drop_price 35
ok "drop applied"

# Symmetric to the drop-#1 guard: confirm the second wave actually has work in it. Checked
# immediately, before the bot can clear the cohort — a cleared position also reverts the Lens and
# would read as "healthy", making a late check useless.
cohort_check 2 || fail "cohort B not liquidatable after drop #2 — wave #2 has no work"
ok "wave #2 has work"

# ── 5b. a competitor buys a vault out from under us (STRESS_ROUTER) ──────────
# The other side of the same classification, and the one that must NOT report a spend.
#
# A separate account acquires a vault with its OWN WBTC, straight through the LLP — only
# `onBehalfOf` must be a registered keeper, so a non-keeper may pay. Our transaction then reverts on
# a vault that is gone, exactly as in the front-run case. The difference is invisible in the receipt
# and decisive for the ledger: no `SwapWbtcToVault` came from OUR router, so our treasury paid
# nothing and the reservation must be released. Reporting a spend here would strand capacity every
# time we simply lost a race.
COMPETITOR_RESULT="skipped"; COMPETITOR_VAULT=""; COMPETITOR_RACED=0
if [[ -n "${STRESS_ROUTER:-}" ]]; then
  COMP_KEY="$(cast --to-uint256 1001)"
  log "Competitor: buying an escrowed vault with its own WBTC"
  COMP_VAULT=""
  for _ in $(seq 1 180); do
    COMP_VAULT="$(curl -s --max-time 5 "$PONDER/escrowed-vaults" 2>/dev/null | jq -r '.vaults[0].vaultId // empty' 2>/dev/null || true)"
    [[ "$COMP_VAULT" =~ ^0x[0-9a-fA-F]{64}$ ]] && break
    COMP_VAULT=""; sleep 1
  done
  if [[ -z "$COMP_VAULT" ]]; then
    printf "! no escrowed vault to contest; competitor phase skipped\n" >&2
  else
    COMPETITOR_VAULT="$COMP_VAULT"
    # Wait for the bot to actually reach this vault before taking it. Losing a race requires being
    # in one: with a cascade of vaults the bot works through them in order, and a competitor that
    # buys one the bot has not got to yet produces no race at all — the bot simply never sees it,
    # and A14 would then flunk it for behaving correctly. The bot's own log is the witness, because
    # an attempt that dies at gas estimation (exactly the case A14 is about) never reaches `commit`
    # and so writes no intent row to query.
    COMPETITOR_RACED=0
    for _ in $(seq 1 90); do
      grep -q "$COMP_VAULT" /tmp/arb-bot.log 2>/dev/null && { COMPETITOR_RACED=1; break; }
      sleep 1
    done
    [[ "$COMPETITOR_RACED" == "1" ]] \
      || printf "! bot never reached %s in 90s; taking it anyway, but there is no race to lose\n" \
           "$COMP_VAULT" >&2
    freeze_chain
    COMP_OUT="$(cast send "$VAULT_SWAP" 'swapWbtcForVaultOnBehalf(bytes32,uint256,address)' \
         "$COMP_VAULT" 100000000000 "$SIGNER" --async --gas-limit 3000000 \
         --private-key "$COMP_KEY" --legacy --gas-price 60000000000 --rpc-url "$RPC" 2>&1 | tail -1)" \
      && COMP_SENT=1 || COMP_SENT=0
    cast rpc evm_mine --rpc-url "$RPC" >/dev/null 2>&1 || true
    thaw_chain

    if [[ "$COMP_SENT" != "1" || ! "$COMP_OUT" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
      COMPETITOR_RESULT="lost"
      printf "! competitor's submission failed: %s\n" "$COMP_OUT" >&2
    else
      COMP_STATUS="$(cast receipt "$COMP_OUT" status --rpc-url "$RPC" 2>/dev/null || echo "")"
      if [[ "$COMP_STATUS" == "true" || "$COMP_STATUS" == "1" || "$COMP_STATUS" == "success" ]]; then
        COMPETITOR_RESULT="won"
        ok "competitor acquired ${COMP_VAULT} with its own funds"
      else
        COMPETITOR_RESULT="lost"
        printf "! competitor tx %s reverted (status %s) - our bot got there first\n" "$COMP_OUT" "${COMP_STATUS:-unknown}" >&2
      fi
    fi
  fi
fi

# ── 6. wave #2 chaos: crash with durable work at risk ────────────────────────
# Same gate. A crash while the bot is merely receipt-waiting would exercise no recovery; this one
# lands with intents the store must reconcile and transactions the chain has not yet mined.
# Skipped under racing for the same reason as §3 — the arb has no reliable backlog to crash on.
if [[ -n "$CHAOS" ]]; then
  wait_for_backlog "crash" || fail "no durable in-flight work — nothing to crash-test"
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
  pkill -9 -f "services/arbitrageur/src/index.ts" 2>/dev/null || true
  ok "bot killed mid-flight"

  sleep 3
  log "Restarting the bot (reconcile must resolve the live intents)"
  ( set -a; . ./.env.arbitrageur; set +a; exec pnpm arbitrageur:run ) >>/tmp/arb-bot.log 2>&1 &
  sleep 8
  ok "bot restarted"
else
  log "Chaos phases off for this mode: skipping crash; waves + observation only"
fi

log "Draining wave #2 (waiting for every cohort B position to be liquidated)"
read -r W2_DONE W2_SECS <<< "$(wait_for_count "liquidations" liquidations_done "$LIQ_TOTAL_N" 300)"
for _ in $(seq 1 30); do [[ "$(live_intents || echo 0)" == "0" ]] && break; sleep 1; done
ok "wave #2 settled in ${W2_SECS}s (${W2_DONE}/${LIQ_TOTAL_N} liquidated, live intents: $(live_intents))"

# ── 6a. acquisition nonce-gap recovery ───────────────────────────────────────
# Reproduces, deliberately and against the running bot, the wedge a batched run hit for real: a
# burned nonce left every already-broadcast acquisition behind it sitting in the mempool as
# `queued` (never `pending`), so no receipt ever arrived for any of them. Counting those as
# failures halted the gate — which made the wedge permanent, because `run()` returns before
# reconcile + resync when HALTED, and that is the only thing that reclaims the gap.
#
# Evicting the OLDEST unmined acquisition puts every later one behind a missing nonce, which is
# exactly that state. Recovery is asserted by the escrow drain below completing at all, plus A12.
# Mocks cannot stand in for this: what is under test is real mempool/nonce behaviour.
ACQ_GAP_RESULT="skipped"; ACQ_GAP_NONCE=""; ACQ_GAP_STRANDED=0
if [[ -n "$CHAOS" ]]; then
  log "Acquisition gap: waiting for >=2 unmined acquisitions to strand behind one nonce"
  ACQ_HASH=""; ACQ_NONCE=""
  for _ in $(seq 1 150); do
    n_live="$(sql "SELECT COUNT(*) FROM bot.tx_intents WHERE action='vault-acquisition' AND status IN ('pending','submitted') AND tx_hash IS NOT NULL AND nonce IS NOT NULL;")"
    if [[ "${n_live:-0}" -ge 2 ]]; then
      # Lowest nonce = the one everything else queues behind.
      row="$(sql "SELECT tx_hash||','||nonce FROM bot.tx_intents WHERE action='vault-acquisition' AND status IN ('pending','submitted') AND tx_hash IS NOT NULL AND nonce IS NOT NULL ORDER BY nonce ASC LIMIT 1;")"
      if [[ -n "$row" ]]; then
        cand="${row%%,*}"
        # Only an UNMINED tx can be evicted. Dropping a mined one leaves `pending` untouched and the
        # phase would report success having created no gap at all.
        if [[ "$(cast rpc eth_getTransactionReceipt "$cand" --rpc-url "$RPC" 2>/dev/null)" == "null" ]]; then
          IFS="," read -r ACQ_HASH ACQ_NONCE <<< "$row"
          ACQ_GAP_STRANDED="$n_live"
          break
        fi
      fi
    fi
    sleep 1
  done

  if [[ -z "$ACQ_HASH" ]]; then
    printf "! never saw >=2 unmined acquisitions; gap phase skipped\n" >&2
  else
    [[ "$ACQ_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "malformed acquisition tx hash: '$ACQ_HASH'"
    [[ "$ACQ_NONCE" =~ ^[0-9]+$ ]] || fail "malformed acquisition nonce: '$ACQ_NONCE'"
    before_pending="$(n_pending)"
    cast rpc anvil_dropTransaction "$ACQ_HASH" --rpc-url "$RPC" >/dev/null 2>&1 || true
    after_pending="$(n_pending)"
    printf "  dropped acquisition %s (nonce %s); %s acquisition(s) in flight; pending %s -> %s\n" \
      "$ACQ_HASH" "$ACQ_NONCE" "$ACQ_GAP_STRANDED" "$before_pending" "$after_pending"
    if [[ "$after_pending" -ge "$before_pending" ]]; then
      ACQ_GAP_RESULT="not-evicted"
      printf "! acquisition was not evicted; no gap created, recovery not exercised\n" >&2
    else
      ACQ_GAP_NONCE="$ACQ_NONCE"; ACQ_GAP_RESULT="injected"
      ok "nonce gap injected at ${ACQ_NONCE} — acquisitions behind it are stranded"
    fi
  fi
fi

# ── 6b. drain the escrow ─────────────────────────────────────────────────────
# Until now the run tore down ~10s after the last liquidation — less than escrow -> index -> poll ->
# acquire — so the arbitrage engine never got to buy any of it and A4 could only be skipped. Hold
# the run open until the escrow is actually consumed.
log "Draining escrow (waiting for the arbitrage engine to buy every vault the cascade produced)"
# Count the vaults escrowed, not the liquidations. These differ: `liquidations_done` also counts the
# competitor liquidator's own target, whose liquidation escrows nothing, so a liquidation-derived
# target is one too high and the drain below can never reach it — it burns the full timeout and
# then fails A11 for a vault that never existed.
ESCROW_TARGET="$(escrowed_vaults)"
ESCROW_TARGET="${ESCROW_TARGET:-0}"
read -r ACQ_TOTAL ESCROW_SECS <<< "$(wait_for_count "acquisitions" confirmed_acquisitions "$ESCROW_TARGET" 420)"
ESCROW_LEFT="$(remaining_escrow)"
for _ in $(seq 1 30); do [[ "$(live_intents || echo 0)" == "0" ]] && break; sleep 1; done
ok "escrow drained in ${ESCROW_SECS}s (${ACQ_TOTAL}/${ESCROW_TARGET} acquired, indexer still shows: ${ESCROW_LEFT:-?})"

# ── 6b2. efficiency ──────────────────────────────────────────────────────────
# Throughput, and where the wall-clock actually went. The point is not a pass/fail number but to see
# whether the time is spent on chain or waiting on the bot's own pacing.
rate() { awk -v n="$1" -v s="$2" 'BEGIN{ if (s+0 <= 0) print "n/a"; else printf "%.2f", n/s }'; }

# Dead time between the cascade clearing and the first vault becoming buyable: escrow -> indexer ->
# poll. Pure latency the arbitrage engine cannot act inside, and the reason a short run sees none.
FIRST_ACQ_LAG="$(awk '
  /Liquidation confirmed in block/ && !lq { lq = NR }
  /Sent vault acquisition|Acquiring vault|Found [0-9]+ escrowed vault/ && lq && !ac { ac = NR }
  END { print (lq && ac) ? "yes" : "no" }' /tmp/arb-bot.log 2>/dev/null || echo "no")"

log "Efficiency"
printf "  wave #1: %s positions in %ss (%s pos/s)\n" "$COHORT_A_N" "$W1_SECS" "$(rate "$COHORT_A_N" "$W1_SECS")"
printf "  wave #2: %s positions in %ss (%s pos/s)\n" "$COHORT_B_N" "$W2_SECS" "$(rate "$COHORT_B_N" "$W2_SECS")"
printf "  escrow:  %s acquisitions in %ss (%s vault/s)\n" "$ACQ_TOTAL" "$ESCROW_SECS" "$(rate "$ACQ_TOTAL" "$ESCROW_SECS")"
printf "  arbitrage engine reached the escrow: %s\n" "$FIRST_ACQ_LAG"
printf "  pacing: POLLING_INTERVAL_MS=1000, VAULT_PROCESSING_DELAY_MS=%s\n" "${VAULT_PROCESSING_DELAY_MS:-0}"

# ── 6c. racing observation ───────────────────────────────────────────────────
# Competitive degradation, not nonce integrity. Each contested liquidation produces one loser whose
# tx lands second in the block and finds the position already cleared. The classifier now splits that
# outcome in two: a "lost race" (position/vault taken by a competitor) is BENIGN — settled
# `contended`, breaker-exempt — while a "reverted" is a genuine failure that still feeds the breaker.
# The proof the fix works: after it, the loser's genuine reverts fall to ~0 and the same losses show
# up as breaker-exempt lost races instead.
LIQ_WINS=0; LIQ_REVERTS=0; LIQ_RACES=0; LIQ_HALTED=0
ARBLIQ_WINS=0; ARBLIQ_REVERTS=0; ARBLIQ_RACES=0; ARBLIQ_HALTED=0; MAX_CONSEC=0
RACING_JSON=false
if [[ -n "${STRESS_RACING:-}" ]]; then
  RACING_JSON=true
  # The standalone liquidator is a separate process the drain loop above doesn't track. Wait until it
  # has resolved every tx it sent (each "Sent liquidation for" is answered by a confirmed/reverted/
  # lost-race line) before counting — otherwise the grep snapshots it mid-receipt and undercounts.
  # Bounded so a genuinely stuck competitor can't hang the whole run.
  for _ in $(seq 1 20); do
    _sent="$(grep -c 'Sent liquidation for' /tmp/liq-bot.log 2>/dev/null || true)"
    _done="$(grep -cE 'Liquidation confirmed in block|Liquidation reverted|already liquidated by another bot' /tmp/liq-bot.log 2>/dev/null || true)"
    [[ "${_done:-0}" -ge "${_sent:-0}" ]] && break
    sleep 1
  done
  # grep -c prints "0" on no match but exits 1 — the `|| true` *inside* the substitution keeps that
  # non-zero exit from tripping `set -e` (an outer `|| echo 0` would instead double the output).
  cnt() { local n; n="$(grep -c "$1" "$2" 2>/dev/null || true)"; echo "${n:-0}"; }
  LIQ_WINS="$(cnt 'Liquidation confirmed in block' /tmp/liq-bot.log)"
  LIQ_REVERTS="$(cnt 'Liquidation reverted' /tmp/liq-bot.log)"          # genuine failures (feed breaker)
  LIQ_RACES="$(cnt 'already liquidated by another bot' /tmp/liq-bot.log)" # benign lost races (exempt)
  LIQ_HALTED="$(cnt 'HALTED — skipping liquidation' /tmp/liq-bot.log)"
  ARBLIQ_WINS="$(cnt 'Liquidation confirmed in block' /tmp/arb-bot.log)"
  ARBLIQ_REVERTS="$(cnt 'Liquidation reverted' /tmp/arb-bot.log)"
  ARBLIQ_RACES="$(cnt 'already liquidated by another bot' /tmp/arb-bot.log)"
  ARBLIQ_HALTED="$(cnt 'HALTED — skipping liquidation' /tmp/arb-bot.log)"
  # Longest run of consecutive GENUINE reverts on the standalone liquidator — the number that would
  # trip a breaker set below it. Lost races are excluded (they no longer feed the breaker).
  # `|| true` swallows grep's exit-1-on-no-match *before* the pipe so pipefail can't trip on it. This
  # matters most in the success case: a healthy loser has zero reverts, so grep finds nothing — that
  # must yield MAX_CONSEC=0, not kill the drive.
  MAX_CONSEC="$({ grep -oE 'Liquidation (confirmed in block|reverted)' /tmp/liq-bot.log 2>/dev/null || true; } \
    | awk '/reverted/{c++; if(c>m)m=c} /confirmed/{c=0} END{print m+0}')"
  log "Racing outcome (reverts = breaker-feeding failures; races = benign, breaker-exempt)"
  printf "  standalone liquidator: wins=%s reverts=%s races=%s halted=%s (max consecutive reverts=%s)\n" \
    "$LIQ_WINS" "$LIQ_REVERTS" "$LIQ_RACES" "$LIQ_HALTED" "$MAX_CONSEC"
  printf "  arbitrageur liq engine: wins=%s reverts=%s races=%s halted=%s\n" \
    "$ARBLIQ_WINS" "$ARBLIQ_REVERTS" "$ARBLIQ_RACES" "$ARBLIQ_HALTED"
fi

# ── 7. restore automine for verification ─────────────────────────────────────
log "Restoring automine"
cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null 2>&1 || true

# Any occurrence at all means the breaker tripped at some point — the condition A12 rejects.
ARB_HALTED_LOGS="$(grep -c 'Risk gate is HALTED' /tmp/arb-bot.log 2>/dev/null || true)"
ARB_HALTED_LOGS="${ARB_HALTED_LOGS:-0}"

cat > .e2e-stress-report.json <<EOF
{
  "signer": "$SIGNER",
  "droppedTxHash": "${DROP_HASH:-}",
  "droppedNonce": "${DROP_NONCE:-}",
  "fence": "$FENCE_RESULT",
  "recovery": "$RECOVERY_RESULT",
  "finalLatestNonce": "$(n_latest)",
  "finalPendingNonce": "$(n_pending)",
  "racing": $RACING_JSON,
  "frontrunResult": "$FRONTRUN_RESULT", "frontrunVault": "${FRONTRUN_VAULT:-}",
  "competitorResult": "$COMPETITOR_RESULT", "competitorVault": "${COMPETITOR_VAULT:-}",
  "competitorRaced": ${COMPETITOR_RACED:-0},
  "acqGapResult": "$ACQ_GAP_RESULT", "acqGapNonce": "${ACQ_GAP_NONCE:-}",
  "privateResult": "$PRIVATE_RESULT", "privateNonce": "${PRIVATE_NONCE:-}",
  "acqGapStranded": ${ACQ_GAP_STRANDED:-0}, "arbHaltedLogs": ${ARB_HALTED_LOGS:-0},
  "cohortA": $COHORT_A_N, "cohortB": $COHORT_B_N, "positionsTotal": $LIQ_TOTAL_N,
  "liquidatedWave1": $W1_DONE, "liquidatedWave2": $W2_DONE,
  "escrowTarget": $ESCROW_TARGET, "escrowRemaining": "${ESCROW_LEFT:-unknown}",
  "acquisitionsConfirmed": ${ACQ_TOTAL:-0},
  "wave1Secs": $W1_SECS, "wave2Secs": $W2_SECS, "escrowSecs": $ESCROW_SECS,
  "liqWins": $LIQ_WINS, "liqReverts": $LIQ_REVERTS, "liqRaces": $LIQ_RACES, "liqHalted": $LIQ_HALTED,
  "liqMaxConsecutiveReverts": $MAX_CONSEC,
  "arbLiqWins": $ARBLIQ_WINS, "arbLiqReverts": $ARBLIQ_REVERTS, "arbLiqRaces": $ARBLIQ_RACES, "arbLiqHalted": $ARBLIQ_HALTED
}
EOF
ok "report written (.e2e-stress-report.json)"
