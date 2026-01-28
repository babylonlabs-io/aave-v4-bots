export const controllerAbi = [
  {
    type: "event",
    name: "VaultOwnershipTransferred",
    inputs: [
      {
        name: "vaultId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
] as const;
