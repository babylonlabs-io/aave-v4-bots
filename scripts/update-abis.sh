#!/bin/bash
set -e

echo "Updating ABIs from compiled contracts..."

# Check if contracts are built, if not build them
if [ ! -d "contracts/out" ]; then
    echo "contracts/out not found. Building contracts..."
    echo "Initializing submodules..."
    git submodule update --init --recursive
    echo "Building contracts with forge..."
    forge build
fi

# Extract VaultSwap ABI
echo "Extracting VaultSwap ABI..."
jq '.abi' contracts/out/VaultSwap.sol/VaultSwap.json > /tmp/VaultSwap.abi.json

# Convert to TypeScript format for client (camelCase)
echo "export const vaultSwapAbi = $(cat /tmp/VaultSwap.abi.json) as const;" > apps/client/src/abis/VaultSwap.ts

# Extract AaveIntegrationController ABI
echo "Extracting AaveIntegrationController ABI..."
jq '.abi' contracts/out/AaveIntegrationController.sol/AaveIntegrationController.json > /tmp/AaveIntegrationController.abi.json

# Extract Spoke ABI
echo "Extracting Spoke ABI..."
jq '.abi' contracts/out/SpokeInstance.sol/SpokeInstance.json > /tmp/Spoke.abi.json

# Extract ERC20 ABI (from MockUSDC or MockWBTC)
echo "Extracting ERC20 ABI..."
jq '.abi' contracts/out/MockUSDC.sol/MockUSDC.json > /tmp/ERC20.abi.json

# Convert to TypeScript format for client (camelCase, all exports in one file)
cat > apps/client/src/abis/AaveIntegrationController.ts << EOF
export const aaveIntegrationControllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;

export const spokeAbi = $(cat /tmp/Spoke.abi.json) as const;

export const erc20Abi = $(cat /tmp/ERC20.abi.json) as const;
EOF

# Convert to TypeScript format for ponder (camelCase)
echo "export const spokeAbi = $(cat /tmp/Spoke.abi.json) as const;" > apps/ponder/abis/Spoke.ts

# Extract Controller ABI for Ponder (using AaveIntegrationController)
echo "Extracting Controller ABI for Ponder..."
echo "export const controllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;" > apps/ponder/abis/Controller.ts

# Cleanup
rm -f /tmp/*.abi.json

echo "✓ ABIs updated successfully!"
echo ""
echo "Updated files:"
echo "  - apps/client/src/abis/VaultSwap.ts"
echo "  - apps/client/src/abis/AaveIntegrationController.ts"
echo "  - apps/ponder/abis/Spoke.ts"
echo "  - apps/ponder/abis/Controller.ts"
