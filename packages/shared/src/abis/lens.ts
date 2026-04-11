// AaveIntegrationLens ABI - read-only helper for estimating liquidation inputs

export const lensAbi = [
        {
            "type": "constructor",
            "inputs": [
                {
                    "name": "_registry",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "_adapter",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "_spoke",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "_vaultBtcReserveId",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "DUST_LIQUIDATION_THRESHOLD",
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
            "name": "INF_DEBT_TO_LIQUIDATE",
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
            "name": "adapter",
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
            "name": "estimateLiquidation",
            "inputs": [
                {
                    "name": "borrowerProxy",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "isDirectRedemption",
                    "type": "bool",
                    "internalType": "bool"
                }
            ],
            "outputs": [
                {
                    "name": "amounts",
                    "type": "uint256[]",
                    "internalType": "uint256[]"
                },
                {
                    "name": "vaults",
                    "type": "bytes32[]",
                    "internalType": "bytes32[]"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "estimateLiquidationWithPriority",
            "inputs": [
                {
                    "name": "borrowerProxy",
                    "type": "address",
                    "internalType": "address"
                },
                {
                    "name": "priorityLoanTokenIds",
                    "type": "uint256[]",
                    "internalType": "uint256[]"
                },
                {
                    "name": "isDirectRedemption",
                    "type": "bool",
                    "internalType": "bool"
                }
            ],
            "outputs": [
                {
                    "name": "amounts",
                    "type": "uint256[]",
                    "internalType": "uint256[]"
                },
                {
                    "name": "vaults",
                    "type": "bytes32[]",
                    "internalType": "bytes32[]"
                }
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "registry",
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
            "name": "spoke",
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
            "name": "spokeOracle",
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
            "name": "vaultBtcReserveId",
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
            "type": "error",
            "name": "PrefixLengthExceedsArray",
            "inputs": []
        },
        {
            "type": "error",
            "name": "SafeCastOverflowedIntToUint",
            "inputs": [
                {
                    "name": "value",
                    "type": "int256",
                    "internalType": "int256"
                }
            ]
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
            "name": "SafeCastOverflowedUintToInt",
            "inputs": [
                {
                    "name": "value",
                    "type": "uint256",
                    "internalType": "uint256"
                }
            ]
        },
        {
            "type": "error",
            "name": "ZeroAddress",
            "inputs": []
        }
    ] as const;
