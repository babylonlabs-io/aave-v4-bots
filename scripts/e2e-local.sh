#!/usr/bin/env bash
# Local replica of .github/workflows/e2e-tests.yml.
# Boots dependencies, runs the three forge scripts, tears everything down on exit.
#
# Usage:
#   scripts/e2e-local.sh                  # full run from cold state
#   KEEP_DEPS=1 scripts/e2e-local.sh      # reuse already-running postgres / btc / anvil
#   SKIP_VERIFY=1 scripts/e2e-local.sh    # stop after setup (debug mid-flow)
#   E2E_RPC_URL=http://...:8545 ...       # override anvil RPC URL
#
# Requires: foundry, node 20, pnpm 9, docker, postgresql-client (psql), python3.
# Python `base58` and `coincurve` are installed automatically in a venv at
# .venv-e2e/. Run once-per-clone:
#     git submodule update --init --recursive
#     pnpm install
#     npm ci --prefix contracts/test/utils
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
REQUIRED=(forge cast anvil node pnpm jq curl python3 psql docker)
missing=()
for tool in "${REQUIRED[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  log_err "missing required tools: ${missing[*]}"
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
SERVICE_PATTERNS=(
  'liquidator:indexer'
  'liquidator:run'
  'arbitrageur:indexer'
  'arbitrageur:run'
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
    docker compose -f contracts/docker-compose.e2e.yml down -v --remove-orphans 2>/dev/null || true
    docker rm -f "$PG_CONTAINER" 2>/dev/null || true
  else
    log_warn "KEEP_DEPS=1 set; leaving postgres + bitcoin running"
  fi

  rm -f .env.liquidator .env.arbitrageur .e2e-vault-id .e2e-initial-arb-wbtc \
        .e2e-initial-liq-wbtc .e2e-block-number 2>/dev/null || true
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

log "Creating ponder databases (idempotent)"
for db in ponder_liquidator ponder_arbitrageur; do
  PGPASSWORD=ponder psql -h localhost -U ponder -d ponder -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null \
    | grep -q 1 \
    || PGPASSWORD=ponder psql -h localhost -U ponder -d ponder \
        -c "CREATE DATABASE $db;" >/dev/null
done

# ── Bitcoin regtest ──────────────────────────────────────────────────────────
# Always reset volumes when starting fresh — stale chain state across runs has
# silently produced wrong block counts and broken peg-ins.
if [[ -z "${KEEP_DEPS:-}" ]]; then
  log "Resetting bitcoin-regtest volumes"
  docker compose -f contracts/docker-compose.e2e.yml down -v --remove-orphans 2>/dev/null || true
fi

log "Starting bitcoin-regtest"
docker compose -f contracts/docker-compose.e2e.yml up -d bitcoin-regtest >/dev/null

log "Waiting for bitcoin-regtest node RPC"
chmod +x contracts/test/e2e/scripts/btc-helper.sh
for i in {1..30}; do
  if USE_DOCKER=true contracts/test/e2e/scripts/btc-helper.sh wait >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 30 ]]; then
    docker compose -f contracts/docker-compose.e2e.yml logs bitcoin-regtest
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
( cd contracts && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh wallet test_wallet && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh mine 2020 && \
  USE_DOCKER=true ./test/e2e/scripts/btc-helper.sh info ) >/dev/null

# ── test/utils symlink (PopHelpers FFI scripts expect this path) ─────────────
if [[ ! -e test/utils ]]; then
  log "Creating test/utils symlink"
  ln -s ../contracts/test/utils test/utils
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
  log "Starting anvil (log: $ANVIL_LOG)"
  anvil --silent --host 127.0.0.1 --port 8545 >"$ANVIL_LOG" 2>&1 &
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
log "Deploy CreateX factory + initialise anvil"
( cd contracts && \
  forge script script/deployment/AnvilSetUp.s.sol:AnvilSetUp \
    --rpc-url "$RPC_URL" --broadcast --skip-simulation )

log "Deploy + setup environment"
( cd contracts && \
  forge script script/e2e/SetupEnvironment.s.sol:SetupEnvironment "${COMMON_FLAGS[@]}" )

log "Setup unhealthy position + start bots/ponders"
forge script test/e2e/LiquidationE2ESetup.s.sol:LiquidationE2ESetup --ffi "${COMMON_FLAGS[@]}"

if [[ -n "${SKIP_VERIFY:-}" ]]; then
  log "SKIP_VERIFY=1 set; stopping before verification"
  log_warn "Bots/ponders are still running; press Ctrl-C to clean up. Logs at /tmp/{liq,arb}-{ponder,bot}.log"
  while true; do sleep 60; done
fi

log "Verify liquidation"
forge script test/e2e/LiquidationE2EVerify.s.sol:LiquidationE2EVerify --ffi "${COMMON_FLAGS[@]}"

log "Verify arbitrageur"
forge script test/e2e/ArbitrageurE2EVerify.s.sol:ArbitrageurE2EVerify --ffi "${COMMON_FLAGS[@]}"

log_ok "PASS"
