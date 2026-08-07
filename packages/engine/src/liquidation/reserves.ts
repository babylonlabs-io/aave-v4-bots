import { adapterAbi, spokeAbi } from "@repo/abis";
import type { Logger } from "@repo/logger";
import type { Address, PublicClient } from "viem";
import { isBorrowableReserve } from "./domain";

/**
 * Enumerate the Spoke's **borrowable** reserves — the tokens a borrower can owe, and therefore the
 * ones an inventory-funded liquidator must hold and approve.
 *
 * Boot-time chain discovery, not engine policy, so it reads as a function rather than a method.
 *
 * A caveat that matters to callers: the result is the *borrowable* subset, in Spoke order. It is
 * **not** the index space of `AaveAdapterLens.estimateLiquidation`, which is indexed by *every*
 * reserve — `LiquidationRouter` reads it that way (`_getReserves()`). The two coincide only while
 * the non-borrowable reserves sort last. Anything that needs a token list matched to the Lens
 * amounts must not derive it from here — build it from the venue registry instead.
 */
export async function discoverBorrowableReserves(deps: {
  publicClient: PublicClient;
  adapterAddress: Address;
  logger: Logger;
  /** Resolved per reserve purely so the log names the token rather than an address. */
  tokenSymbol: (token: Address) => Promise<string>;
}): Promise<Address[]> {
  const { publicClient, adapterAddress, logger, tokenSymbol } = deps;
  logger.info("Discovering debt tokens from Spoke...");

  const spokeAddress = await publicClient.readContract({
    address: adapterAddress,
    abi: adapterAbi,
    functionName: "BTC_VAULT_CORE_SPOKE",
  });
  logger.info(`Spoke address: ${spokeAddress}`);

  const reserveCount = await publicClient.readContract({
    address: spokeAddress,
    abi: spokeAbi,
    functionName: "getReserveCount",
  });
  logger.info(`Found ${reserveCount} reserve(s)`);

  const discovered: Address[] = [];
  for (let i = 0n; i < reserveCount; i++) {
    const reserve = await publicClient.readContract({
      address: spokeAddress,
      abi: spokeAbi,
      functionName: "getReserve",
      args: [i],
    });

    if (isBorrowableReserve(reserve.flags)) {
      discovered.push(reserve.underlying);
      logger.info(
        `  Reserve ${i}: ${await tokenSymbol(reserve.underlying)} (${reserve.underlying}) - borrowable`
      );
    }
  }

  if (discovered.length === 0) {
    logger.warn("No borrowable reserves found on Spoke");
  }
  return discovered;
}
