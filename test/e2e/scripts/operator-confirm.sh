#!/usr/bin/env bash
# Production-flow drive for the MANUAL arbitrageur e2e. operator-cli NEVER signs or broadcasts here
# — that is the whole point of MANUAL. For each proposal the bot makes, the operator:
#   1. `operator-cli claim <id>`   — fixes the (Safe) envelope + surfaces what to sign; the fence.
#   2. signs + broadcasts in their OWN tool (e2e-external-sign.ts, standing in for a hardware wallet
#      / the Safe UI) — the key lives only there, never in operator-cli.
#   3. `operator-cli confirm <id> --tx <hash>` — operator-cli re-fetches the on-chain tx, verifies it
#      IS exactly the claimed proposal, and records it.
# operator-cli itself runs KEYLESS. `MANUAL_EXECUTOR_KIND` (from the caller) selects EOA vs Safe.
#
# The bot runs BOTH engines, so it proposes a stream of actions: token approvals, then the
# `liquidation` (which escrows a vault), then the `vault-acquisition` that buys it back. We drive
# every proposal as it appears and finish on the acquisition — the last leg, which can only happen
# if the liquidation before it succeeded.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

export CLIENT_RPC_URL="${E2E_RPC_URL:-http://127.0.0.1:8545}"
export DATABASE_URL="postgresql://ponder:ponder@localhost:5432/ponder_arbitrageur"
export SECRETS_PROVIDER=env
export MANUAL_EXECUTOR_KIND="${MANUAL_EXECUTOR_KIND:-eoa}"

# The operator's own key — used ONLY by the external signing tool, never by operator-cli.
#
# The two custody models sign as different identities on purpose:
#   eoa  — the executor IS the registered keeper (ARBITRAGEUR / APP_OPERATOR_0), so it signs.
#   safe — the executor is the Safe, whose owner (SAFE_OWNER, Anvil account[2]) signs. That owner
#          is NOT the keeper: the Safe pays and ARBITRAGEUR receives the vault, so this flow never
#          touches the keeper's key at all.
if [[ "$MANUAL_EXECUTOR_KIND" == "safe" ]]; then
  export SIGN_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" # SAFE_OWNER
  export MANUAL_EXECUTOR_ADDRESS="$(cat .e2e-safe-address)" # the deployed Safe (1-of-1)
else
  export SIGN_KEY="0x0000000000000000000000000000000000000000000000000000000000000001" # ARBITRAGEUR
  export MANUAL_EXECUTOR_ADDRESS="0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" # ARBITRAGEUR
fi
echo "▸ confirm flow ($MANUAL_EXECUTOR_KIND), keyless operator-cli, executor $MANUAL_EXECUTOR_ADDRESS"

# Invoke tsx directly (not via `pnpm exec`) — ~2x faster per call, which matters across the many CLI
# invocations the serialized Safe flow makes while the liquidatable position must stay indexed.
cli() { node_modules/.bin/tsx services/operator-cli/src/index.ts "$@"; }
# The external signing tool lives under the operator-cli package (for `viem` resolution) but is a
# separate program from the CLI — it holds `SIGN_KEY`; operator-cli never sees a key here.
sign() { node_modules/.bin/tsx services/operator-cli/scripts/e2e-external-sign.ts "$@"; }

# Both legs plus their approvals have to clear, and each one waits on a full claim/sign/confirm
# round-trip, so this budget is deliberately larger than a single-leg suite would need.
deadline=$((SECONDS + 600))
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
  [[ "$action" == "vault-acquisition" ]] && {
    echo "✓ vault acquisition confirmed on-chain (the liquidation leg produced the vault it bought)"
    exit 0
  }
done

echo "✗ timed out waiting to confirm the vault acquisition" >&2
exit 1
