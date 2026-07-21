#!/usr/bin/env bash
# Production-flow drive for the MANUAL e2e. operator-cli NEVER signs or broadcasts here — that is the
# whole point of MANUAL. For each proposal the bot makes, the operator:
#   1. `operator-cli claim <id>`   — fixes the (Safe) envelope + surfaces what to sign; the fence.
#   2. signs + broadcasts in their OWN tool (operator-sign.ts, standing in for a hardware wallet /
#      the Safe UI) — the key lives only there, never in operator-cli.
#   3. `operator-cli confirm <id> --tx <hash>` — operator-cli re-fetches the on-chain tx, verifies it
#      IS exactly the claimed proposal, and records it.
# operator-cli itself runs KEYLESS. `MANUAL_EXECUTOR_KIND` (from the caller) selects EOA vs Safe.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

export CLIENT_RPC_URL="${E2E_RPC_URL:-http://127.0.0.1:8545}"
export DATABASE_URL="postgresql://ponder:ponder@localhost:5432/ponder_liquidator"
export SECRETS_PROVIDER=env
export MANUAL_EXECUTOR_KIND="${MANUAL_EXECUTOR_KIND:-eoa}"

# The operator's own key — used ONLY by the external signing tool, never by operator-cli.
export SIGN_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" # LIQUIDATOR
if [[ "$MANUAL_EXECUTOR_KIND" == "safe" ]]; then
  export MANUAL_EXECUTOR_ADDRESS="$(cat .e2e-safe-address)" # the deployed Safe (1-of-1, owner=LIQUIDATOR)
else
  export MANUAL_EXECUTOR_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" # LIQUIDATOR
fi
echo "▸ confirm flow ($MANUAL_EXECUTOR_KIND), keyless operator-cli, executor $MANUAL_EXECUTOR_ADDRESS"

# Invoke tsx directly (not via `pnpm exec`) — ~2x faster per call, which matters across the many CLI
# invocations the serialized Safe flow makes while the liquidatable position must stay indexed.
cli() { node_modules/.bin/tsx services/operator-cli/src/index.ts "$@"; }
# The external signing tool lives under the operator-cli package (for `viem` resolution) but is a
# separate program from the CLI — it holds `SIGN_KEY`; operator-cli never sees a key here.
sign() { node_modules/.bin/tsx services/operator-cli/scripts/e2e-external-sign.ts "$@"; }

deadline=$((SECONDS + 360))
while ((SECONDS < deadline)); do
  # First proposed row: "<id>  [proposed]  <action>  subject=<s>  hash=<h>"
  line="$(cli list 2>/dev/null | awk '$2=="[proposed]"{print; exit}')" || line=""
  if [[ -z "$line" ]]; then
    sleep 3
    continue
  fi
  id="$(awk '{print $1}' <<<"$line")"
  action="$(awk '{print $3}' <<<"$line")"

  # 1) claim — Safe: fails while a prior SafeTx is still in flight (one live claim at a time); wait.
  if ! cli claim "$id" >/dev/null 2>&1; then
    sleep 3
    continue
  fi

  # 2) external signing tool (the operator's wallet) signs + broadcasts.
  info="$(cli show "$id")"
  to="$(jq -r .call.to <<<"$info")"
  data="$(jq -r .call.data <<<"$info")"
  safetxhash="$(jq -r '.safeTxHash // empty' <<<"$info")"
  txhash="$(sign "$MANUAL_EXECUTOR_KIND" "$to" "$data" "$safetxhash")"

  # 3) report it back — operator-cli verifies the on-chain tx matches, then records it.
  cli confirm "$id" --tx "$txhash"
  echo "▸ confirmed $action  $id  ($txhash)"
  [[ "$action" == "liquidation" ]] && {
    echo "✓ liquidation confirmed on-chain"
    exit 0
  }
done

echo "✗ timed out waiting to confirm the liquidation" >&2
exit 1
