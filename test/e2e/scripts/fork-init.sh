#!/usr/bin/env bash
# Prepare a forked anvil so the e2e suites can run against real flash venues.
#
# The flash-funded liquidator suite needs a real UniswapV4 to swap through, which bare anvil does not
# have. Forking a chain that does gives us the venues; the protocol itself is still deployed fresh on
# top, so the suite keeps admin over the price feed, the vault providers and its own mintable tokens,
# and the indexer still starts at the current block with no history to replay.
#
# Called by both `scripts/e2e-local.sh` and the CI workflow, which otherwise describe the same run
# twice and would drift on exactly the fiddly parts below.
#
#   RPC_URL=http://127.0.0.1:8545 ./test/e2e/scripts/fork-init.sh <deployer> <vault-provider>
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DEPLOYER="${1:?deployer address required}"
VAULT_PROVIDER="${2:?vault provider address required}"

# `AnvilSetUp.s.sol` does all of this, but only when `block.chainid == 31337`, and its CreateX step
# publishes a canonical *pre-signed nonce-0* transaction. On a fork that cannot be replayed: the
# factory is already deployed (the reason we fork) and its deployer's nonce is long past 0, so the
# publish fails with `nonce too low`. Blanking the factory's code does not help — the nonce lives on
# the deployer account. So the script is skipped on a fork and its other effects are applied here.
cast rpc anvil_setNextBlockBaseFeePerGas 0x0 --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

for who in "$DEPLOYER" "$VAULT_PROVIDER"; do
  cast rpc anvil_setBalance "$who" 0xDE0B6B3A7640000000 --rpc-url "$RPC_URL" >/dev/null
done

# The suite's accounts are the standard anvil test keys, whose private keys are public — so on a real
# chain anyone can, and someone has, EIP-7702-delegated them: their code reads `0xef0100…`. Forking
# inherits that, and the delegated code then runs on a plain `.transfer()`, blowing the 2300-gas
# stipend. Clear it so they behave as the EOAs the suite assumes.
for who in "$DEPLOYER" "$VAULT_PROVIDER" \
  0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf \
  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  0xDbc23AE43a150ff8884B02Cea117b22D1c3b9796; do
  if [[ "$(cast code "$who" --rpc-url "$RPC_URL")" != "0x" ]]; then
    cast rpc anvil_setCode "$who" 0x --rpc-url "$RPC_URL" >/dev/null
    echo "  cleared inherited code (EIP-7702 delegation) on $who"
  fi
done

echo "fork initialised: base fee zeroed, accounts funded and de-delegated"
