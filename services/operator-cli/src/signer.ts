import { safeAbi } from "@repo/abis";
import {
  type ProposalPayload,
  buildSafeExecution,
  encodeExecTransaction,
  encodeSafeSignatures,
  safeTxTypedData,
} from "@repo/execution";
import type { SafeEnvelope } from "@repo/persistence";
import {
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  createWalletClient,
} from "viem";

// The operator's signing seam — the one place EOA and Safe custody differ. Everything upstream
// (verify, claim, markBroadcast) is identical; only building the envelope and turning a proposal into
// an on-chain tx changes. A hardware-wallet / Safe-UI operator does not use this at all — they sign in
// their own tooling and report the tx back via `confirm`; this seam is for the automatable local-key
// path (dev, e2e, and a simple EOA deployment).

export interface OperatorSigner {
  /** The account/Safe that will be `msg.sender` — operations asserts this equals the executor address. */
  readonly address: Address;
  /**
   * The Safe envelope to persist at claim (`safe` custody), or `undefined` (`eoa`). For a Safe this
   * allocates the on-chain nonce and fixes the SafeTx — after this the `safeTxHash` is settled.
   */
  buildEnvelope(inner: ProposalPayload): Promise<SafeEnvelope | undefined>;
  /** Sign + broadcast the claimed proposal; returns the on-chain tx hash. */
  send(inner: ProposalPayload, envelope: SafeEnvelope | undefined): Promise<Hex>;
}

/** EOA custody: the operator's account signs + sends the inner call directly. */
export function createEoaOperatorSigner(deps: {
  account: LocalAccount;
  chain: Chain;
  transport: Transport;
}): OperatorSigner {
  const wallet = createWalletClient({
    account: deps.account,
    chain: deps.chain,
    transport: deps.transport,
  });
  return {
    address: deps.account.address,
    async buildEnvelope() {
      return undefined; // EOA has no SafeTx wrapper.
    },
    async send(inner) {
      return wallet.sendTransaction({
        account: deps.account,
        chain: deps.chain,
        to: inner.to,
        data: inner.data,
        value: BigInt(inner.value),
      });
    },
  };
}

/**
 * Safe custody: build the SafeTx, collect owner signatures to threshold, execute `execTransaction`.
 * `owners`/`relayer` may be omitted (empty) — the Safe-UI / hardware-wallet flow uses only
 * `buildEnvelope` (a keyless chain read) at claim and reports the tx back via `confirm`; only the
 * automatable `send` needs keys, and it throws if none were configured.
 */
export function createSafeOperatorSigner(deps: {
  safe: Address;
  /** Owner accounts that will sign (>= threshold). Empty ⇒ `send` is unavailable (claim/confirm only). */
  owners: LocalAccount[];
  /** Account that submits `execTransaction` and pays gas (any funded EOA; typically an owner). */
  relayer?: LocalAccount;
  publicClient: PublicClient;
  chain: Chain;
  transport: Transport;
  chainId: number;
  safeVersion: string;
}): OperatorSigner {
  return {
    address: deps.safe,

    async buildEnvelope(inner) {
      const safeNonce = await deps.publicClient.readContract({
        address: deps.safe,
        abi: safeAbi,
        functionName: "nonce",
      });
      return buildSafeExecution({
        inner,
        safe: deps.safe,
        chainId: deps.chainId,
        safeNonce: Number(safeNonce),
        safeVersion: deps.safeVersion,
      });
    },

    async send(inner, envelope) {
      if (!envelope) throw new Error("safe custody requires a persisted envelope to broadcast");
      if (deps.owners.length === 0 || !deps.relayer) {
        throw new Error(
          "no Safe owner keys configured — set SAFE_OWNER_KEY_REFS to broadcast, or sign in the Safe UI and use `confirm --tx`"
        );
      }
      const relayer = deps.relayer;
      const wallet = createWalletClient({
        account: relayer,
        chain: deps.chain,
        transport: deps.transport,
      });
      // Each owner signs the SafeTx's EIP-712 hash (via the same typed-data used to compute it), then
      // the sigs are concatenated in ascending owner order — the shape `execTransaction` verifies.
      const typedData = safeTxTypedData({
        inner,
        params: envelope,
        safe: deps.safe,
        chainId: deps.chainId,
      });
      const signatures = encodeSafeSignatures(
        await Promise.all(
          deps.owners.map(async (owner) => ({
            owner: owner.address,
            signature: await owner.signTypedData(typedData),
          }))
        )
      );
      const data = encodeExecTransaction({ inner, params: envelope, signatures });
      return wallet.sendTransaction({
        account: relayer,
        chain: deps.chain,
        to: deps.safe,
        data,
        value: 0n,
      });
    },
  };
}
