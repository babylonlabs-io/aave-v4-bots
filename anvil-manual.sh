#!/bin/bash
# Alternative Anvil configuration with manual mining for maximum determinism

# Start Anvil with manual mining
anvil \
    --silent \
    --host 127.0.0.1 \
    --port 8545 \
    --no-mining \
    --gas-limit 30000000 \
    --base-fee 0 \
    --gas-price 0 \
    --order fifo \
    --no-rate-limit \
    --disable-default-create2-deployer &

ANVIL_PID=$!
echo "Anvil started with PID: $ANVIL_PID"

# Helper function to mine blocks manually
mine_blocks() {
    local count=${1:-1}
    cast rpc anvil_mine $count --rpc-url http://127.0.0.1:8545
    echo "Mined $count block(s)"
}

# Export the function so it can be used in scripts
export -f mine_blocks

echo "Use 'mine_blocks [count]' to manually mine blocks"
echo "Example: mine_blocks 5"

# Keep the script running
wait $ANVIL_PID