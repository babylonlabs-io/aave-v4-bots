#!/bin/bash
set -e

echo "Updating ABIs from compiled contracts..."

# Check if contracts are built, if not build them
if [ ! -d "contracts/out" ]; then
    echo "contracts/out not found. Building contracts..."
    echo "Initializing submodules..."
    git submodule update --init --recursive
    echo "Building contracts with forge..."
    cd contracts && forge build && cd ..
fi

# Extract ABIs from compiled contracts
echo "Extracting ABIs from contracts..."
jq '.abi' contracts/out/VaultSwap.sol/VaultSwap.json > /tmp/VaultSwap.abi.json
jq '.abi' contracts/out/AaveIntegrationController.sol/AaveIntegrationController.json > /tmp/AaveIntegrationController.abi.json
jq '.abi' contracts/out/SpokeInstance.sol/SpokeInstance.json > /tmp/Spoke.abi.json
jq '.abi' contracts/out/MockUSDC.sol/MockUSDC.json > /tmp/ERC20.abi.json
jq '.abi' contracts/out/BTCVaultsManager.sol/BTCVaultsManager.json > /tmp/BTCVaultsManager.abi.json

# Update Liquidator Service ABIs
echo "Updating Liquidator service ABIs..."

# Liquidator Client ABIs
echo "export const vaultSwapAbi = $(cat /tmp/VaultSwap.abi.json) as const;" > services/liquidator/client/src/abis/VaultSwap.ts

cat > services/liquidator/client/src/abis/AaveIntegrationController.ts << EOF
export const aaveIntegrationControllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;

export const spokeAbi = $(cat /tmp/Spoke.abi.json) as const;

export const erc20Abi = $(cat /tmp/ERC20.abi.json) as const;
EOF

# Liquidator Ponder ABIs
echo "export const spokeAbi = $(cat /tmp/Spoke.abi.json) as const;" > services/liquidator/ponder/abis/Spoke.ts
echo "export const controllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;" > services/liquidator/ponder/abis/Controller.ts

# Update Arbitrageur Service ABIs
echo "Updating Arbitrageur service ABIs..."

# Arbitrageur Client ABIs
echo "export const vaultSwapAbi = $(cat /tmp/VaultSwap.abi.json) as const;" > services/arbitrageur/client/src/abis/VaultSwap.ts

cat > services/arbitrageur/client/src/abis/AaveIntegrationController.ts << EOF
export const aaveIntegrationControllerAbi = $(cat /tmp/AaveIntegrationController.abi.json) as const;

export const spokeAbi = $(cat /tmp/Spoke.abi.json) as const;

export const erc20Abi = $(cat /tmp/ERC20.abi.json) as const;
EOF

# Arbitrageur Ponder ABIs
echo "export const vaultSwapAbi = $(cat /tmp/VaultSwap.abi.json) as const;" > services/arbitrageur/ponder/abis/VaultSwap.ts
echo "export const btcVaultsManagerAbi = $(cat /tmp/BTCVaultsManager.abi.json) as const;" > services/arbitrageur/ponder/abis/BTCVaultsManager.ts

# Cleanup
rm -f /tmp/*.abi.json

echo "✓ ABIs updated successfully!"
echo ""
echo "Updated files:"
echo "  Liquidator:"
echo "    - services/liquidator/client/src/abis/VaultSwap.ts"
echo "    - services/liquidator/client/src/abis/AaveIntegrationController.ts"
echo "    - services/liquidator/ponder/abis/Spoke.ts"
echo "    - services/liquidator/ponder/abis/Controller.ts"
echo "  Arbitrageur:"
echo "    - services/arbitrageur/client/src/abis/VaultSwap.ts"
echo "    - services/arbitrageur/client/src/abis/AaveIntegrationController.ts"
echo "    - services/arbitrageur/ponder/abis/VaultSwap.ts"
echo "    - services/arbitrageur/ponder/abis/BTCVaultsManager.ts"
