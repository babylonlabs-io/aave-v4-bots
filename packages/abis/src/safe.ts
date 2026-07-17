// Safe{Wallet} (Gnosis Safe) ABI — the surface the MANUAL `safe`-custody path uses:
//   - `ExecutionSuccess` / `ExecutionFailure` events: how the bot's reconcile judges a SafeTx's
//     INNER call (a Safe catches an inner revert and emits `ExecutionFailure` while the outer
//     `execTransaction` still succeeds, so the outer receipt status cannot be trusted).
//   - `execTransaction`: what the operator-cli encodes to broadcast, and decodes in `confirm` to
//     prove the on-chain tx wraps exactly the proposed inner call.
//   - `getTransactionHash`: on-chain SafeTx-hash, an optional cross-check of the off-chain EIP-712.
//   - `nonce` / `getThreshold` / `getOwners` / `VERSION`: envelope nonce allocation, the execute-time
//     threshold re-fetch, and the boot probe that confirms `MANUAL_EXECUTOR_ADDRESS` really is a Safe.
// Compatible across Safe v1.3.0 / v1.4.1 for these members.

export const safeAbi = [
  {
    type: "event",
    name: "ExecutionSuccess",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ExecutionFailure",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "getTransactionHash",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
