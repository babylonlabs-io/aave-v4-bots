#!/usr/bin/env tsx
import "dotenv/config";
import { createStateStore } from "@repo/persistence";
import { createSecrets } from "@repo/secrets";
import {
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  createPublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config";
import * as ops from "./operations";
import { type OperatorSigner, createEoaOperatorSigner, createSafeOperatorSigner } from "./signer";

// `operator-cli` — review, sign, and broadcast MANUAL proposals a keyless bot persisted. One command
// per invocation; see `usage` below. Wires the store + chain + operator signer, then dispatches to
// the (unit-tested) operations in `./operations`.

const USAGE = `usage: operator-cli <command> [id] [flags]
  list [--action <a>]        proposals awaiting an operator
  show <id>                  verify + render a proposal (read-only)
  claim <id>                 claim it (fixes the Safe envelope); prints the hash to sign
  broadcast <id>             claim (if needed) + sign + send + record  [needs keys]
  confirm <id> --tx <hash>   record an externally-signed tx (claim it first) after verifying it matches
  release <id>               revert a claim back to proposed
  fail <id> [--reason <r>]   give up on an intent, reviving its subject`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function requireId(args: string[]): string {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new Error("this command requires an <id>");
  return id;
}

function localChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: "operator",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

async function buildSigner(
  config: ReturnType<typeof loadConfig>,
  secrets: ReturnType<typeof createSecrets>,
  publicClient: PublicClient,
  chain: Chain,
  transport: Transport,
  chainId: number
): Promise<OperatorSigner> {
  const account = async (ref: string) => privateKeyToAccount((await secrets.get(ref)) as Hex);

  if (config.executorKind === "eoa") {
    // Keyless (the production/confirm flow): no key here, so `send`/`broadcast` is unavailable — the
    // operator signs externally and reports back via `confirm`. `address` is the executor the operator
    // signs as. With a key, the full local-signing `broadcast` path is available.
    if (!config.operatorKeyRef) {
      return {
        address: config.executorAddress,
        buildEnvelope: async () => undefined,
        send: async () => {
          throw new Error(
            "no OPERATOR_KEY_REF configured — sign externally and record with `confirm --tx`"
          );
        },
      };
    }
    return createEoaOperatorSigner({
      account: await account(config.operatorKeyRef),
      chain,
      transport,
    });
  }

  // Safe: owner keys are optional — claim/confirm are keyless; only broadcast needs them.
  const owners = await Promise.all(config.safeOwnerKeyRefs.map(account));
  return createSafeOperatorSigner({
    safe: config.executorAddress,
    owners,
    relayer: owners[0],
    publicClient,
    chain,
    transport,
    chainId,
    safeVersion: config.safeVersion,
  });
}

async function dispatch(command: string, args: string[], ctx: ops.OperatorContext): Promise<void> {
  switch (command) {
    case "list": {
      const rows = await ops.listProposals(ctx, flag(args, "--action"));
      if (rows.length === 0) {
        console.log("No proposals awaiting an operator.");
        return;
      }
      for (const r of rows) {
        console.log(
          `${r.id}  [${r.status}]  ${r.action}  subject=${r.subject}  hash=${r.payloadHash}`
        );
      }
      return;
    }
    case "show":
      console.log(JSON.stringify(await ops.showProposal(ctx, requireId(args)), null, 2));
      return;
    case "claim": {
      const result = await ops.claimProposal(ctx, requireId(args));
      if (!result.claimed) {
        console.error(`claim refused: ${result.reason}`);
        process.exitCode = 1;
        return;
      }
      const hash = result.row.safeEnvelope?.safeTxHash;
      console.log(`claimed ${result.row.id}${hash ? ` — sign safeTxHash ${hash}` : ""}`);
      return;
    }
    case "broadcast": {
      const { txHash } = await ops.broadcastProposal(ctx, requireId(args));
      console.log(`broadcast → ${txHash}`);
      return;
    }
    case "confirm": {
      const tx = flag(args, "--tx");
      if (!tx) throw new Error("confirm requires --tx <hash>");
      await ops.confirmProposal(ctx, requireId(args), tx as Hex);
      console.log(`confirmed ← ${tx}`);
      return;
    }
    case "release":
      await ops.releaseProposal(ctx, requireId(args));
      console.log("released");
      return;
    case "fail":
      await ops.failProposal(ctx, requireId(args), flag(args, "--reason"));
      console.log("failed");
      return;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const secrets = createSecrets(config.secrets);
  const transport = http(config.rpcUrl);
  const chainId = await createPublicClient({ transport }).getChainId();
  const chain = localChain(chainId, config.rpcUrl);
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const store = createStateStore(config.persistence);

  try {
    const signer = await buildSigner(config, secrets, publicClient, chain, transport, chainId);
    const ctx: ops.OperatorContext = {
      store,
      signer,
      publicClient,
      executorAddress: config.executorAddress,
      executorKind: config.executorKind,
      chainId,
      now: Date.now,
    };
    await dispatch(command, args, ctx);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
