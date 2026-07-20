#!/usr/bin/env tsx
// Stand-in for the operator's OWN signing tool (a hardware wallet / the Safe UI) in the MANUAL e2e's
// confirm flow. In production operator-cli NEVER signs or broadcasts — the key lives in the operator's
// tooling, and operator-cli only hands over what to sign (`claim`/`show`) and re-verifies the result
// (`confirm --tx`). This is that tooling: deliberately viem-only + a one-function ABI, sharing NO code
// with operator-cli's signer, so `confirm` is proven against a tx it did not produce. Prints the hash.
//
// It lives under `services/operator-cli/scripts/` (not `test/e2e/`) only so it resolves `viem` from the
// package; it is not part of the CLI. Run: `pnpm --filter @services/operator-cli exec tsx
// scripts/e2e-external-sign.ts <eoa|safe> <to> <data> [safeTxHash]`.
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [mode, to, data, safeTxHash] = process.argv.slice(2) as [string, Address, Hex, Hex];
const rpc = process.env.CLIENT_RPC_URL ?? "http://127.0.0.1:8545";
const safe = process.env.MANUAL_EXECUTOR_ADDRESS as Address;
const account = privateKeyToAccount(process.env.SIGN_KEY as Hex);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const execTransactionAbi = [
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
] as const;

const publicClient = createPublicClient({ transport: http(rpc) });
const chainId = await publicClient.getChainId();
const chain = {
  id: chainId,
  name: "e2e",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
};
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

let txHash: Hex;
if (mode === "safe") {
  // The owner signs the raw SafeTx digest (an EIP-712 hash — no extra hashing), then execTransaction
  // is submitted with a zero-gas/refund policy (matching what operator-cli fixed at claim).
  const signature = await account.sign({ hash: safeTxHash });
  const calldata = encodeFunctionData({
    abi: execTransactionAbi,
    functionName: "execTransaction",
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature],
  });
  txHash = await wallet.sendTransaction({ to: safe, data: calldata, value: 0n });
} else {
  txHash = await wallet.sendTransaction({ to, data, value: 0n });
}
process.stdout.write(txHash);
