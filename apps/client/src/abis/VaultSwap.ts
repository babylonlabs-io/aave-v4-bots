// Contract commit: 6a83427a55774f08722e388989ebc12ccfb7e1d0

export const vaultSwapAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "hub_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wbtc_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "btcVaultsManager_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "controller_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "appRegistry_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "vaultParams_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wbtcAssetId_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "APP_REGISTRY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IApplicationRegistry"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "BTC_VAULTS_MANAGER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IBTCVaultsManager"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CONTROLLER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "HUB",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IHubBase"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VAULT_PARAMS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IVaultParams"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "WBTC",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "WBTC_ASSET_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "clearResidualDebt",
    "inputs": [],
    "outputs": [
      {
        "name": "amountRestored",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "emergencyRepayVault",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "payer",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "wbtcRepaid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getEscrowedVaults",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEscrowedVaultsInfo",
    "inputs": [],
    "outputs": [
      {
        "name": "vaults",
        "type": "tuple[]",
        "internalType": "struct IVaultSwap.EscrowedVaultInfo[]",
        "components": [
          {
            "name": "vaultId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "btcAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "hubDebt",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "protocolFee",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isVaultEscrowed",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewWbtcToAcquireVault",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "wbtcNeeded",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "previewWbtcToAcquireVaultWithFees",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "wbtcNeeded",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "principal",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "interest",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "protocolFee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "swapVaultForWbtc",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "wbtcOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "swapWbtcForVault",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "maxWbtcIn",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "wbtcPaid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "ResidualDebtCleared",
    "inputs": [
      {
        "name": "amountRestored",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultEmergencyRepaid",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "payer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "wbtcRepaid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultSwappedForWbtc",
    "inputs": [
      {
        "name": "seller",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "vaultId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "wbtcAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "WbtcSwappedForVault",
    "inputs": [
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "vaultId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "wbtcAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "EscrowNotEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SlippageExceeded",
    "inputs": [
      {
        "name": "minOut",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "actualOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultAlreadyEscrowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultKeeperNotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "VaultNotEscrowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
