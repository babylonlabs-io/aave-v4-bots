#!/usr/bin/env bash
# Local replica of .github/workflows/e2e-tests.yml.
# Boots dependencies, runs the three forge scripts, tears everything down on exit.
#
# Usage:
#   E2E_FORK_URL=https://sepolia.drpc.org scripts/e2e-local.sh   # SUITE=liquidator (needs a fork)
#   SUITE=arbitrageur scripts/e2e-local.sh # run the arbitrageur suite (one bot, both engines)
#
# The liquidator suite is flash-funded and borrows from the REAL UniswapV4 and Morpho deployments,
# so it only runs against a fork — hence `E2E_FORK_URL`. Every other suite is inventory-funded and
# runs on a bare chain. The fork block is pinned, so after the first run foundry serves it from
# ~/.foundry/cache/rpc and the RPC is not called again.
#
# MANUAL (keyless) suites — the arb bot proposes, an operator drives the proposals through
# operator-cli. Both engines are on, so each run confirms a liquidation AND an acquisition:
#   SUITE=manual-arbitrageur scripts/e2e-local.sh      # executor = ARBITRAGEUR (a vault keeper)
#   SUITE=manual-safe-arbitrageur scripts/e2e-local.sh # executor = a Safe, paying on behalf of it
#   KEEP_DEPS=1 scripts/e2e-local.sh      # reuse already-running postgres / btc / anvil
#   SKIP_VERIFY=1 scripts/e2e-local.sh    # stop after setup (debug mid-flow)
#   E2E_PRICE_DROP_PCT=30 ...             # liquidator suite: how far the BTC price falls. Sets the
#                                         # debt-to-collateral ratio at liquidation, and so whether
#                                         # the seized vault leaves excess -> an LLP fairness
#                                         # payment. Too deep and there is none, and the WBTC
#                                         # flash-loan leg goes untested.
#   E2E_RPC_URL=http://...:8545 ...       # override anvil RPC URL
#
# Sign the arbitrageur bot's txs with AWS KMS instead of a local key (SUITE=arbitrageur):
#   set -a; . ./.env.test; set +a          # KMS_E2E_KEY_ID, AWS_REGION (+ AWS creds/profile)
#   export E2E_SIGNER_SOURCE=aws KMS_KEY_ID="$KMS_E2E_KEY_ID"
#   export E2E_ARB_ADDRESS=0x…             # the KMS key's derived address (gets funded)
#   SUITE=arbitrageur scripts/e2e-local.sh
#
# Requires: foundry, node 20, pnpm 9, docker, postgresql-client (psql), python3.
# Python `base58` and `coincurve` are installed automatically in a venv at
# .venv-e2e/. Run once-per-clone:
#     git submodule update --init --recursive
#     pnpm install
#     npm ci --prefix lib/tbv-contracts/test/utils
#
# On failure, /tmp/{liq,arb}-{ponder,bot}.log are copied to
# /tmp/e2e-fail-<timestamp>/ before cleanup, so you can inspect what each
# spawned process was doing when the run died.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Logging ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_BLUE=$'\033[1;36m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi
log()      { printf "\n%s▸ %s%s\n" "$C_BLUE" "$*" "$C_OFF"; }
log_ok()   { printf "%s✓ %s%s\n" "$C_GREEN" "$*" "$C_OFF"; }
log_warn() { printf "%s! %s%s\n" "$C_YELLOW" "$*" "$C_OFF" >&2; }
log_err()  { printf "%s✗ %s%s\n" "$C_RED" "$*" "$C_OFF" >&2; }

# ── Tool preflight ───────────────────────────────────────────────────────────
# psql is NOT required on the host — DB creation runs inside the postgres container.
REQUIRED=(forge cast anvil node pnpm jq curl python3 docker)
missing=()
for tool in "${REQUIRED[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  log_err "missing required tools: ${missing[*]}"
  exit 1
fi

# Which suite to run (matches the CI matrix). Resolved here, with the rest of the preflight, so a
# bad combination fails before docker, anvil and the protocol deploy have cost a minute of setup.
SUITE="${SUITE:-liquidator}"

# The liquidator suite is flash-funded, and its venues are the *real* UniswapV4 and Morpho
# deployments rather than mocks. On a bare chain those addresses hold no code, so the setup fails
# somewhere inside a pool call with nothing pointing back at the cause. Say it here instead.
if [[ "$SUITE" == "liquidator" && -z "${E2E_FORK_URL:-}" ]]; then
  log_err "SUITE=liquidator needs E2E_FORK_URL: it flash-funds through the real UniswapV4 and"
  log_err "Morpho deployments, which exist only on a fork. For example:"
  log_err "  E2E_FORK_URL=https://sepolia.drpc.org SUITE=liquidator scripts/e2e-local.sh"
  log_err "The inventory-funded path is covered by SUITE=arbitrageur, which needs no fork."
  exit 1
fi

# ── Python venv for btc-helper.sh ────────────────────────────────────────────
# btc-helper.sh shells out to `python3` and needs `base58` + `coincurve`.
# Modern macOS Python blocks `pip install --user` (PEP 668), so we maintain a
# project-local venv and prepend it to PATH so all FFI subprocesses inherit it.
#
# Python 3.14 is intentionally avoided — coincurve has no prebuilt wheel for
# it yet and its source build is broken (see github.com/ofek/coincurve issues).
# We prefer 3.13/3.12/3.11/3.10 in that order. If none are installed:
#   brew install python@3.12
VENV_DIR="$REPO_ROOT/.venv-e2e"
PY_BIN=""
for v in 3.13 3.12 3.11 3.10; do
  if command -v "python$v" >/dev/null 2>&1; then
    PY_BIN="python$v"
    break
  fi
done
if [[ -z "$PY_BIN" ]]; then
  log_err "need python 3.10–3.13 for coincurve; found only $(python3 --version 2>&1)"
  log_err "       install with:  brew install python@3.12"
  exit 1
fi
# Treat a venv without pip as broken (Homebrew Python sometimes creates one).
if [[ -d "$VENV_DIR" && ! -x "$VENV_DIR/bin/pip" ]]; then
  log_warn "existing venv at $VENV_DIR has no pip; recreating"
  rm -rf "$VENV_DIR"
fi
if [[ ! -d "$VENV_DIR" ]]; then
  log "Creating Python venv at $VENV_DIR ($("$PY_BIN" --version))"
  "$PY_BIN" -m venv --upgrade-deps "$VENV_DIR"
  if [[ ! -x "$VENV_DIR/bin/pip" ]]; then
    "$VENV_DIR/bin/python3" -m ensurepip --upgrade
  fi
  "$VENV_DIR/bin/pip" install --quiet --upgrade pip
  "$VENV_DIR/bin/pip" install --quiet base58 coincurve
fi
if ! "$VENV_DIR/bin/python3" -c "import base58, coincurve" 2>/dev/null; then
  "$VENV_DIR/bin/pip" install --quiet --force-reinstall base58 coincurve
fi
export PATH="$VENV_DIR/bin:$PATH"

# ── Config matching .github/workflows/e2e-tests.yml ──────────────────────────
export FOUNDRY_PROFILE=e2e
export DEPLOYER_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export DEPLOYER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

export BTC_INIT_BLOCK_HEIGHT="2017"
export BTC_INIT_EXPECTED_TARGET="0x207fffff"
export BTC_NETWORK_TYPE="regtest"
export BTC_ADMIN="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export BTC_RPC_URL="http://localhost:18443"
export BTC_RPC_USER="btcuser"
export BTC_RPC_PASSWORD="btcpassword"

export NUM_UNIVERSAL_CHALLENGERS="1"
export UC_0_ETH_ADDRESS="0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69"
export UC_0_BTC_PUBLIC_KEY="0x7962d45b38e8bcf82fa8efa8432a01f20c9a53e24c7d3f11df197cb8e70926da"

export APPLICATION_NAME="Aave v4"
export NUM_APP_OPERATORS="2"
export APP_OPERATOR_0_ETH_ADDRESS="0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
export APP_OPERATOR_0_BTC_PUBLIC_KEY="0x9ac20335eb38768d2052be1dbbc3c8f6178407458e51e6b4ad22f1d91758895b"
export APP_OPERATOR_1_ETH_ADDRESS="0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF"
export APP_OPERATOR_1_BTC_PUBLIC_KEY="0x466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"

export USE_REAL_REGISTRATION="true"
export VAULT_PROVIDER_PRIVATE_KEY="0x000000000000000000000000000000000000000000000000000000000000000a"
export VAULT_PROVIDER_ADDRESS="0x4CCeBa2d7D2B4fdcE4304d3e09a1fea9fbEb1528"
export VAULT_PROVIDER_BTCPUBKEY="0x4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"

export GOV_MULTISIG="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export EMERGENCY_COUNCIL="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export PROTOCOL_PAUSER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export APP_PAUSER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export AUTOMATED_RISK_STEWARD="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
export PROTOCOL_FEE_RECIPIENT="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

# ── Local-only state ─────────────────────────────────────────────────────────
RPC_URL="${E2E_RPC_URL:-http://127.0.0.1:8545}"
PG_CONTAINER="e2e-pg"
BTC_CONTAINER="btc-regtest-e2e"
ANVIL_PID=""
ANVIL_LOG=""
BOT_LOG_PATTERNS=(/tmp/liq-ponder.log /tmp/liq-bot.log /tmp/arb-ponder.log /tmp/arb-bot.log)

# Process patterns spawned by LiquidationE2ESetup via FFI. The PIDs printed by
# the setup script come from `echo $!` but get reinterpreted as uint256 in
# Solidity — so they're useless for kill. Match by command line instead.
#
# The `pnpm <script>` parent carries the `*:run`/`*:indexer` name, but its real child (a `tsx
# services/.../index.ts` bot, or `ponder dev`) re-parents to init and KEEPS THE PORT once the parent
# is killed — so matching only the parent leaks a process holding 9095/42069 into the next run. Match
# the children too.
SERVICE_PATTERNS=(
  'liquidator:indexer'
  'liquidator:run'
  'arbitrageur:indexer'
  'arbitrageur:run'
  'services/liquidator/src/index.ts'
  'services/arbitrageur/src/index.ts'
  # The `*:indexer` patterns above only match the pnpm wrapper. The indexer itself is that
  # wrapper's grandchild and outlives it, running as `node .../ponder.js dev --port <p>` — note
  # `ponder.js dev`, so a 'ponder dev' pattern never matches it. Left alive it keeps holding
  # 42069/42070, and the NEXT run's indexer quietly binds a different port ("Port 42070 was in
  # use, trying port 42071") while the bot still polls the original one and sees nothing.
  'ponder.js dev'
)

cleanup() {
  local rc=$?
  log "Cleanup"

  # Save logs from spawned bots/ponders if anything failed.
  if [[ "$rc" -ne 0 ]]; then
    local fail_dir="/tmp/e2e-fail-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$fail_dir"
    for f in "${BOT_LOG_PATTERNS[@]}"; do
      [[ -f "$f" ]] && cp "$f" "$fail_dir/" 2>/dev/null || true
    done
    [[ -n "$ANVIL_LOG" && -f "$ANVIL_LOG" ]] && cp "$ANVIL_LOG" "$fail_dir/" 2>/dev/null || true
    log_warn "logs saved to $fail_dir"
  fi

  # Soft-kill, brief grace, then force-kill.
  for pat in "${SERVICE_PATTERNS[@]}"; do
    pkill -f "$pat" 2>/dev/null || true
  done
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
  sleep 1
  for pat in "${SERVICE_PATTERNS[@]}"; do
    pkill -9 -f "$pat" 2>/dev/null || true
  done
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill -9 "$ANVIL_PID" 2>/dev/null || true
  fi

  if [[ -z "${KEEP_DEPS:-}" ]]; then
    docker compose -f lib/tbv-contracts/docker-compose.e2e.yml down -v --remove-orphans 2>/dev/null || true
    docker rm -f "$PG_CONTAINER" 2>/dev/null || true
  else
    log_warn "KEEP_DEPS=1 set; leaving postgres + bitcoin running"
  fi

  rm -f .env.liquidator .env.arbitrageur .e2e-vault-id .e2e-initial-arb-wbtc \
        .e2e-initial-liq-wbtc .e2e-initial-liq-usdc .e2e-block-number \
        .e2e-safe-address .e2e-initial-safe-wbtc .e2e-initial-safe-usdc 2>/dev/null || true
  [[ -n "$ANVIL_LOG" && -f "$ANVIL_LOG" ]] && rm -f "$ANVIL_LOG"

  exit "$rc"
}
trap cleanup EXIT INT TERM HUP

# ── Postgres ─────────────────────────────────────────────────────────────────
if [[ -z "${KEEP_DEPS:-}" ]] || ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  log "Starting postgres ($PG_CONTAINER)"
  docker rm -f "$PG_CONTAINER" 2>/dev/null || true
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=ponder -e POSTGRES_PASSWORD=ponder -e POSTGRES_DB=ponder \
    -p 5432:5432 postgres:17 >/dev/null

  log "Waiting for postgres to accept connections"
  for _ in {1..30}; do
    if docker exec "$PG_CONTAINER" pg_isready -U ponder >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# Recreate from scratch, for the same reason the bitcoin volumes are reset below: Ponder persists
# indexed state keyed to the PREVIOUS run's block hashes, and every fresh anvil restarts at block 0
# with different ones. Reusing that database makes Ponder see the new chain as an "unrecoverable
# reorg beyond finalized block N" — it then retries forever, never serves /liquidatable-positions,
# and the bot sits at "No liquidatable positions found" until the suite times out. That failure
# looks exactly like a broken bot, so it is worth the two seconds to avoid. `WITH (FORCE)` evicts
# a previous run's lingering connections. KEEP_DEPS opts out (you asked to reuse the deps).
if [[ -z "${KEEP_DEPS:-}" ]]; then
  log "Recreating ponder databases (dropping stale chain state)"
  for db in ponder_liquidator ponder_arbitrageur; do
    docker exec -e PGPASSWORD=ponder "$PG_CONTAINER" \
      psql -U ponder -d ponder -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" >/dev/null
    docker exec -e PGPASSWORD=ponder "$PG_CONTAINER" \
      psql -U ponder -d ponder -c "CREATE DATABASE $db;" >/dev/null
  done
else
  log "Creating ponder databases (idempotent; KEEP_DEPS keeps existing state)"
  for db in ponder_liquidator ponder_arbitrageur; do
    docker exec -e PGPASSWORD=ponder "$PG_CONTAINER" \
      psql -U ponder -d ponder -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null \
      | grep -q 1 \
      || docker exec -e PGPASSWORD=ponder "$PG_CONTAINER" \
          psql -U ponder -d ponder -c "CREATE DATABASE $db;" >/dev/null
  done
fi

# ── Bitcoin regtest ──────────────────────────────────────────────────────────
# Always reset volumes when starting fresh — stale chain state across runs has
# silently produced wrong block counts and broken peg-ins.
if [[ -z "${KEEP_DEPS:-}" ]]; then
  log "Resetting bitcoin-regtest volumes"
  docker compose -f lib/tbv-contracts/docker-compose.e2e.yml down -v --remove-orphans 2>/dev/null || true
fi

log "Starting bitcoin-regtest"
docker compose -f lib/tbv-contracts/docker-compose.e2e.yml up -d bitcoin-regtest >/dev/null

log "Waiting for bitcoin-regtest node RPC"
chmod +x lib/tbv-contracts/test/e2e/scripts/btc-helper.sh
for i in {1..30}; do
  if USE_DOCKER=true lib/tbv-contracts/test/e2e/scripts/btc-helper.sh wait >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    docker compose -f lib/tbv-contracts/docker-compose.e2e.yml logs bitcoin-regtest
    log_err "bitcoin-regtest node RPC failed to start"
    exit 1
  fi
  sleep 2
done

log "Waiting for bitcoin wallet RPC"
for i in {1..30}; do
  if docker exec "$BTC_CONTAINER" bitcoin-cli -regtest \
      -rpcuser="$BTC_RPC_USER" -rpcpassword="$BTC_RPC_PASSWORD" \
      listwallets >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    log_err "bitcoin wallet RPC failed to come up"
    exit 1
  fi
  sleep 1
done

# Sanity-check fresh state.
current_blocks=$(docker exec "$BTC_CONTAINER" bitcoin-cli -regtest \
  -rpcuser="$BTC_RPC_USER" -rpcpassword="$BTC_RPC_PASSWORD" \
  getblockcount 2>/dev/null || echo "0")
if [[ -z "${KEEP_DEPS:-}" && "$current_blocks" -gt 10 ]]; then
  log_warn "block count $current_blocks is unexpectedly high; bitcoin volume may not have reset cleanly"
fi

log "Initialising bitcoin wallet and mining 2020 blocks"
( cd lib/tbv-contracts && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh wallet test_wallet && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh mine 2020 && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh info ) >/dev/null

# ── test/utils symlink (PopHelpers FFI scripts expect this path) ─────────────
if [[ ! -e test/utils ]]; then
  log "Creating test/utils symlink"
  ln -s ../lib/tbv-contracts/test/utils test/utils
fi

# ── Anvil ────────────────────────────────────────────────────────────────────
# AnvilSetUp.s.sol (run below) calls anvil_setNextBlockBaseFeePerGas 0x0 so the
# deployment scripts get cheap blocks. We deliberately do NOT pass
# --gas-price 0 --block-base-fee-per-gas 0 --disable-min-priority-fee here,
# even though the contracts CI does — those flags break viem's auto-fee
# estimation in the bot client (TipAboveFeeCap), causing the liquidator bot
# to crash on its first tx.
if cast chain-id --rpc-url "$RPC_URL" --rpc-timeout 5 >/dev/null 2>&1; then
  log "Anvil already running at $RPC_URL"
else
  ANVIL_LOG="$(mktemp -t anvil-e2e.XXXXXX.log)"
  # Default (unset) is anvil's automine: every tx is mined instantly in its own block, so nothing is
  # ever pending. `E2E_ANVIL_BLOCK_TIME=<seconds>` switches to interval mining, which is what lets a
  # backlog of pending txs build up from one signer — the only condition under which the nonce
  # allocator's resync/in-flight fence is actually exercised. Opt-in, so the existing suites keep
  # their current timing.
  ANVIL_MINING_ARGS=()
  if [[ -n "${E2E_ANVIL_BLOCK_TIME:-}" ]]; then
    ANVIL_MINING_ARGS=(--block-time "$E2E_ANVIL_BLOCK_TIME")
    log_warn "interval mining: --block-time ${E2E_ANVIL_BLOCK_TIME}s (txs will queue; setup is slower)"
  fi

  # `E2E_FORK_URL` runs the suite on a fork instead of a bare chain, which is how the flash-funded
  # suite gets *real* venues — UniswapV4's PoolManager/PositionManager, Permit2, Morpho — without
  # deploying any of them. Everything else is unchanged: the protocol is still deployed fresh (so we
  # keep admin over the price feed, vault providers and the mintable tokens), and Ponder still starts
  # at the current block, so there is no history to replay.
  #
  # The fork keeps chain id 31337 rather than the forked chain's. That looks wrong and is not: the
  # protocol's proof-of-possession messages bind `block.chainid`
  # (`BTCProofOfPossession.buildMessage`), and the test-side signer that produces them hardcodes
  # 31337 (`lib/tbv-contracts/test/utils/PopHelpers.sol`). Run on any other id and every peg-in fails
  # with `InvalidBIP322Signature`. Fixing that belongs in the contracts repo; until then the id has
  # to stay put, which also keeps every other 31337 assumption in the suite honest.
  ANVIL_FORK_ARGS=()
  if [[ -n "${E2E_FORK_URL:-}" ]]; then
    # The block is pinned, and that is not incidental. Foundry caches forked state per block under
    # ~/.foundry/cache/rpc, so a pinned block is served from disk on every run after the first —
    # measured at 45s cold vs 1.6s warm on the fork suite. An unpinned fork resolves to `latest`,
    # which differs every run, so the cache never hits and CI pays the full fetch each time.
    # Shared with the fork tests (test/fork/base/TestSuites.sol) so both warm the same cache entry.
    : "${E2E_FORK_BLOCK:=11141103}"
    ANVIL_FORK_ARGS=(--fork-url "$E2E_FORK_URL" --chain-id 31337 --fork-block-number "$E2E_FORK_BLOCK")
    log_warn "fork mode: $E2E_FORK_URL @ $E2E_FORK_BLOCK (chain id pinned to 31337)"
  fi

  log "Starting anvil (log: $ANVIL_LOG)"
  anvil --silent --host 127.0.0.1 --port 8545 "${ANVIL_MINING_ARGS[@]}" "${ANVIL_FORK_ARGS[@]}" >"$ANVIL_LOG" 2>&1 &
  ANVIL_PID=$!
  sleep 2
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
    log_err "anvil exited immediately"
    tail -n 40 "$ANVIL_LOG" 2>/dev/null || true
    exit 1
  fi
  for i in {1..30}; do
    if cast chain-id --rpc-url "$RPC_URL" --rpc-timeout 5 >/dev/null 2>&1; then
      log_ok "anvil ready"
      break
    fi
    if [[ $i -eq 30 ]]; then
      log_err "anvil failed to become ready"
      tail -n 40 "$ANVIL_LOG" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
fi

# ── Forge scripts ────────────────────────────────────────────────────────────
COMMON_FLAGS=(--rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" --skip-simulation --slow)

# CreateX factory + base-fee zeroing + DEPLOYER/VAULT_PROVIDER funding.
# Required by the new CreateX-based deployment scripts. No private key needed —
# the script funds its own ephemeral deployer via anvil_setBalance and broadcasts
# the canonical CreateX deploy tx via `cast publish`.
# On a fork the CreateX deploy in `AnvilSetUp.s.sol` cannot be replayed, so that script is skipped
# and its other effects are applied by the shared init the CI workflow also calls.
if [[ -n "${E2E_FORK_URL:-}" ]]; then
  log "Initialise fork (CreateX inherited; applying the rest of AnvilSetUp)"
  RPC_URL="$RPC_URL" ./test/e2e/scripts/fork-init.sh "$DEPLOYER_ADDRESS" "$VAULT_PROVIDER_ADDRESS"
else
  log "Deploy CreateX factory + initialise anvil"
  ( cd lib/tbv-contracts && \
    forge script script/deployment/AnvilSetUp.s.sol:AnvilSetUp \
      --rpc-url "$RPC_URL" --broadcast --skip-simulation )
fi

log "Deploy + setup environment"
( cd lib/tbv-contracts && \
  forge script script/e2e/SetupEnvironment.s.sol:SetupEnvironment "${COMMON_FLAGS[@]}" )

# `DRIVE` (optional) runs between setup and verify — the MANUAL suites use it to play the operator.
DRIVE=""
case "$SUITE" in
  arbitrageur) SETUP="ArbitrageurE2ESetup"; VERIFY="ArbitrageurE2EVerify" ;;
  liquidator)  SETUP="LiquidationE2ESetup"; VERIFY="LiquidationE2EVerify" ;;
  manual-arbitrageur)
    SETUP="ManualArbitrageurE2ESetup"; VERIFY="ArbitrageurE2EVerify"
    DRIVE="test/e2e/scripts/operator-confirm.sh"; DRIVE_KIND="eoa" ;;
  manual-safe-arbitrageur)
    SETUP="ManualSafeArbitrageurE2ESetup"; VERIFY="ManualSafeArbitrageurE2EVerify"
    DRIVE="test/e2e/scripts/operator-confirm.sh"; DRIVE_KIND="safe" ;;
  # Nonce stress. Its verification lives in bash, not forge: the strongest evidence is the bot's
  # StateStore (nonce + tx_hash per intent), which SQL reads directly and a forge script cannot.
  stress-arbitrageur)
    SETUP="StressArbitrageurE2ESetup"; VERIFY=""
    DRIVE="test/e2e/scripts/stress-drive.sh"
    BASH_VERIFY="test/e2e/scripts/stress-verify.sh" ;;
  *) log_err "unknown SUITE '$SUITE' (expected: arbitrageur | liquidator | manual-arbitrageur | manual-safe-arbitrageur | stress-arbitrageur)"; exit 1 ;;
esac

if [[ "${E2E_SIGNER_SOURCE:-local}" == "aws" ]]; then
  log_warn "Signer: AWS KMS (KMS_KEY_ID=${KMS_KEY_ID:-<unset>}, arb addr=${E2E_ARB_ADDRESS:-<unset>})"
fi

log "Setup ($SUITE) + start bots/ponders"
forge script "test/e2e/${SETUP}.s.sol:${SETUP}" --ffi "${COMMON_FLAGS[@]}"

# Between setup and verify. The MANUAL suites use this to play the operator; the stress suite uses
# it to own every phase transition (mining mode, the two price drops, the crash, the tx eviction).
if [[ -n "$DRIVE" ]]; then
  log "Drive ($SUITE)"
  E2E_RPC_URL="$RPC_URL" MANUAL_EXECUTOR_KIND="${DRIVE_KIND:-eoa}" bash "$DRIVE"
fi

if [[ -n "${SKIP_VERIFY:-}" ]]; then
  log "SKIP_VERIFY=1 set; stopping before verification"
  log_warn "Bots/ponders are still running; press Ctrl-C to clean up. Logs at /tmp/{liq,arb}-{ponder,bot}.log"
  while true; do sleep 60; done
fi

log "Verify ($SUITE)"
if [[ -n "${BASH_VERIFY:-}" ]]; then
  E2E_RPC_URL="$RPC_URL" bash "$BASH_VERIFY"
else
  forge script "test/e2e/${VERIFY}.s.sol:${VERIFY}" --ffi "${COMMON_FLAGS[@]}"
fi
log_ok "PASS ($SUITE)"
