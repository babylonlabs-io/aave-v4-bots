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
                    "name": "wbtcAssetId_",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "APPLICATION_ADMIN",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "stateMutability": "pure"
        },
        {
            "type": "function",
            "name": "APPLICATION_PAUSING_GUARDIAN",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "stateMutability": "pure"
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
            "name": "DEFAULT_ADMIN_ROLE",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
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
                    "internalType": "contract ITBVAaveHub"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "TIMELOCK_UPGRADER",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "UPGRADE_INTERFACE_VERSION",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "string",
                    "internalType": "string"
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
            "name": "applicationFeeRecipient",
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
            "name": "discountCommissionBps",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "uint128",
                    "internalType": "uint128"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "emergencyRepayVault",
            "inputs": [
                {
                    "name": "vaultId",
                    "type": "bytes32",
                    "internalType": "bytes32"
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
            "name": "fullPause",
            "inputs": [],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "getRoleAdmin",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "grantRole",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "hasRole",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "internalType": "address"
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
            "name": "initialize",
            "inputs": [
                {
                    "name": "initialTBVAdmin",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "sellDiscountBps_",
                    "type": "uint128",
                    "internalType": "uint128"
                },
                {
                    "name": "discountCommissionBps_",
                    "type": "uint128",
                    "internalType": "uint128"
                },
                {
                    "name": "applicationFeeRecipient_",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
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
            "name": "pauseState",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "uint8",
                    "internalType": "enum ITBVPausable.PauseState"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "previewEscrowedVaults",
            "inputs": [
                {
                    "name": "_escrowedVaults",
                    "type": "bytes32[]",
                    "internalType": "bytes32[]"
                }
            ],
            "outputs": [
                {
                    "name": "vaults",
                    "type": "tuple[]",
                    "internalType": "struct IVaultSwap.EscrowedVaultPreviewResult[]",
                    "components": [
                        {
                            "name": "vaultId",
                            "type": "bytes32",
                            "internalType": "bytes32"
                        },
                        {
                            "name": "amountVault",
                            "type": "uint256",
                            "internalType": "uint256"
                        },
                        {
                            "name": "amountDebt",
                            "type": "uint256",
                            "internalType": "uint256"
                        },
                        {
                            "name": "amountFee",
                            "type": "uint256",
                            "internalType": "uint256"
                        },
                        {
                            "name": "amountWbtcToAcquire",
                            "type": "uint256",
                            "internalType": "uint256"
                        },
                        {
                            "name": "isProfitable",
                            "type": "bool",
                            "internalType": "bool"
                        }
                    ]
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "proxiableUUID",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "bytes32",
                    "internalType": "bytes32"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "renounceRole",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "revokeRole",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "sellDiscountBps",
            "inputs": [],
            "outputs": [
                {
                    "name": "",
                    "type": "uint128",
                    "internalType": "uint128"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "setApplicationFeeRecipient",
            "inputs": [
                {
                    "name": "applicationFeeRecipient_",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "setSwapFeeBps",
            "inputs": [
                {
                    "name": "_sellDiscountBps",
                    "type": "uint128",
                    "internalType": "uint128"
                },
                {
                    "name": "_discountCommissionBps",
                    "type": "uint128",
                    "internalType": "uint128"
                }
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "softPause",
            "inputs": [],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "supportsInterface",
            "inputs": [
                {
                    "name": "interfaceId",
                    "type": "bytes4",
                    "internalType": "bytes4"
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
            "name": "swapVaultsForWbtc",
            "inputs": [
                {
                    "name": "vaultIds",
                    "type": "bytes32[]",
                    "internalType": "bytes32[]"
                },
                {
                    "name": "liquidator",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [
                {
                    "name": "totalWbtcOut",
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
                    "name": "amountWbtcIn",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "swapWbtcForVaultOnBehalf",
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
                },
                {
                    "name": "onBehalfOf",
                    "type": "address",
                    "internalType": "address"
                }
            ],
            "outputs": [
                {
                    "name": "amountWbtcIn",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "unpause",
            "inputs": [],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "upgradeToAndCall",
            "inputs": [
                {
                    "name": "newImplementation",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "data",
                    "type": "bytes",
                    "internalType": "bytes"
                }
            ],
            "outputs": [],
            "stateMutability": "payable"
        },
        {
            "type": "event",
            "name": "AddedVault",
            "inputs": [
                {
                    "name": "vaultId",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "Initialized",
            "inputs": [
                {
                    "name": "version",
                    "type": "uint8",
                    "indexed": false,
                    "internalType": "uint8"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "PausedWith",
            "inputs": [
                {
                    "name": "state",
                    "type": "uint8",
                    "indexed": true,
                    "internalType": "enum ITBVPausable.PauseState"
                },
                {
                    "name": "pauser",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "RemovedVault",
            "inputs": [
                {
                    "name": "vaultId",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "RoleAdminChanged",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                },
                {
                    "name": "previousAdminRole",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                },
                {
                    "name": "newAdminRole",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "RoleGranted",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                },
                {
                    "name": "sender",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "RoleRevoked",
            "inputs": [
                {
                    "name": "role",
                    "type": "bytes32",
                    "indexed": true,
                    "internalType": "bytes32"
                },
                {
                    "name": "account",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                },
                {
                    "name": "sender",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "SwapApplicationFeeRecipientUpdated",
            "inputs": [
                {
                    "name": "applicationFeeRecipient",
                    "type": "address",
                    "indexed": false,
                    "internalType": "address"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "SwapFeeBpsUpdated",
            "inputs": [
                {
                    "name": "_sellDiscountBps",
                    "type": "uint128",
                    "indexed": false,
                    "internalType": "uint128"
                },
                {
                    "name": "_discountCommissionBps",
                    "type": "uint128",
                    "indexed": false,
                    "internalType": "uint128"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "Unpaused",
            "inputs": [
                {
                    "name": "pauser",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                }
            ],
            "anonymous": false
        },
        {
            "type": "event",
            "name": "Upgraded",
            "inputs": [
                {
                    "name": "implementation",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
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
            "name": "WbtcSwappedForVault",
            "inputs": [
                {
                    "name": "payer",
                    "type": "address",
                    "indexed": true,
                    "internalType": "address"
                },
                {
                    "name": "onBehalfOf",
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
            "name": "AddressEmptyCode",
            "inputs": [
                {
                    "name": "target",
                    "type": "address",
                    "internalType": "address"
                }
            ]
        },
        {
            "type": "error",
            "name": "ERC1967InvalidImplementation",
            "inputs": [
                {
                    "name": "implementation",
                    "type": "address",
                    "internalType": "address"
                }
            ]
        },
        {
            "type": "error",
            "name": "ERC1967NonPayable",
            "inputs": []
        },
        {
            "type": "error",
            "name": "FailedCall",
            "inputs": []
        },
        {
            "type": "error",
            "name": "InvalidFeeConfiguration",
            "inputs": []
        },
        {
            "type": "error",
            "name": "InvalidOraclePrice",
            "inputs": []
        },
        {
            "type": "error",
            "name": "SafeCastOverflowedUintDowncast",
            "inputs": [
                {
                    "name": "bits",
                    "type": "uint8",
                    "internalType": "uint8"
                },
                {
                    "name": "value",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ]
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
            "name": "TBV_AlreadyPaused",
            "inputs": []
        },
        {
            "type": "error",
            "name": "TBV_NotPaused",
            "inputs": []
        },
        {
            "type": "error",
            "name": "TBV_Paused",
            "inputs": []
        },
        {
            "type": "error",
            "name": "TBV_Unauthorized",
            "inputs": []
        },
        {
            "type": "error",
            "name": "UUPSUnauthorizedCallContext",
            "inputs": []
        },
        {
            "type": "error",
            "name": "UUPSUnsupportedProxiableUUID",
            "inputs": [
                {
                    "name": "slot",
                    "type": "bytes32",
                    "internalType": "bytes32"
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
            "name": "VaultStillProfitable",
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
    ]