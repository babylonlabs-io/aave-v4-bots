export const controllerAbi = [
  {
    type: "event",
    name: "VaultOwnershipChanged",
    inputs: [
      {
        name: "vaultId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
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
  {
    type: "event",
    name: "UserProxyCreated",
    inputs: [
      {
        name: "user",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "proxy",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
] as const;
