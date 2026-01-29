#!/bin/bash
set -e

echo "Updating ABIs from compiled contracts..."

# Check if contracts are built
if [ ! -d "contracts/out" ]; then
    echo "Error: contracts/out directory not found. Run 'forge build' first."
    exit 1
fi

# Extract VaultSwap ABI
echo "Extracting VaultSwap ABI..."
jq '.abi' contracts/out/VaultSwap.sol/VaultSwap.json > /tmp/VaultSwap.abi.json

# Convert to TypeScript format for client
echo "export const VaultSwapAbi = $(cat /tmp/VaultSwap.abi.json) as const;" > apps/client/src/abis/VaultSwap.ts

# Extract AaveIntegrationController ABI
echo "Extracting AaveIntegrationController ABI..."
jq '.abi' contracts/out/AaveIntegrationController.sol/AaveIntegrationController.json > /tmp/AaveIntegrationController.abi.json

# Convert to TypeScript format for client
echo "export const AaveIntegrationControllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;" > apps/client/src/abis/AaveIntegrationController.ts

# Extract Spoke ABI for Ponder
echo "Extracting Spoke ABI..."
jq '.abi' contracts/out/SpokeInstance.sol/SpokeInstance.json > /tmp/Spoke.abi.json

# Convert to TypeScript format for ponder
echo "export const SpokeAbi = $(cat /tmp/Spoke.abi.json) as const;" > apps/ponder/abis/Spoke.ts

# Extract Controller ABI for Ponder (using AaveIntegrationController)
echo "Extracting Controller ABI for Ponder..."
echo "export const ControllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;" > apps/ponder/abis/Controller.ts

# Cleanup
rm -f /tmp/*.abi.json

echo "✓ ABIs updated successfully!"
echo ""
echo "Updated files:"
echo "  - apps/client/src/abis/VaultSwap.ts"
echo "  - apps/client/src/abis/AaveIntegrationController.ts"
echo "  - apps/ponder/abis/Spoke.ts"
echo "  - apps/ponder/abis/Controller.ts"
