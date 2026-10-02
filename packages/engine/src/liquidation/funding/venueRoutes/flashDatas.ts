import { type FlashData, type PoolKey, VenueType, poolKeyAbiParameters } from "@repo/abis";
import { type Address, decodeAbiParameters, getAddress } from "viem";
import { VenueSelectionError, assertWbtcPairedWith } from "../venues";
import { byPriority } from "./planner";
import type { PlannedLeg, VenueKind, VenueSource } from "./types";

/**
 * Which kind of source each on-chain venue type is.
 *
 * `VenueManager._flashLoan` dispatches on `FlashData.venueType` alone, so this is what ties a
 * source's declared `kind` to the calldata it actually emits — a source that says "flash loan" but
 * emits a swap type would otherwise pass every check keyed on `kind`. `UniswapV4FlashLoan` is absent
 * because `_flashLoan` has no branch for it: an entry of that type reverts.
 */
export const VENUE_KIND: ReadonlyMap<number, VenueKind> = new Map<number, VenueKind>([
  [VenueType.AaveV3, "flashLoan"],
  [VenueType.Morpho, "flashLoan"],
  [VenueType.UniswapV4FlashSwap, "flashSwap"],
]);

/**
 * The `flashDatas` for a planned route.
 *
 * Every configured token gets an entry, not only the owed ones: a planned token uses its planned
 * source, every other token its first-priority source. The router skips an entry whose token owes
 * nothing, so an extra entry costs a loop iteration — whereas a token the sizing missed would be left
 * unfunded, and the probe would reject a liquidation that was fundable.
 *
 * WBTC goes last, where the fairness payment rides the WBTC borrow.
 *
 * @param sourcesByToken Every configured source, grouped by token. Keys are compared checksummed.
 * @throws VenueSelectionError on a result that breaks an invariant the contracts do not check.
 */
export function buildRankedFlashDatas(
  legs: readonly PlannedLeg[],
  sourcesByToken: ReadonlyMap<Address, readonly VenueSource[]>,
  wbtc: Address
): FlashData[] {
  const wbtcKey = getAddress(wbtc);

  const configured = new Map<string, readonly VenueSource[]>();
  const chosen = new Map<string, VenueSource>();
  for (const [token, sources] of sourcesByToken) {
    const key = getAddress(token);
    if (chosen.has(key)) throw new VenueSelectionError("I2", `sources for ${key} are keyed twice`);
    const [first] = [...sources].sort(byPriority);
    if (first === undefined) throw new VenueSelectionError("I1", `no venue configured for ${key}`);
    configured.set(key, sources);
    chosen.set(key, first);
  }

  const planned = new Set<string>();
  for (const leg of legs) {
    const key = getAddress(leg.token);
    if (planned.has(key)) throw new VenueSelectionError("I2", `token ${key} is planned twice`);
    planned.add(key);
    // Only a source configured for this token may be chosen for it. Sources are validated where
    // they are built from configuration, so a leg carrying a source from anywhere else would route
    // around that validation and still produce calldata the router accepts.
    if (!configured.get(key)?.includes(leg.source)) {
      throw new VenueSelectionError(
        "I1",
        `planned venue ${leg.source.id} is not configured for ${key}`
      );
    }
    chosen.set(key, leg.source);
  }

  // I4 — the router approves the adapter for the fairness payment whether or not a WBTC venue is
  // present, so a route without one does not revert: it spends whatever WBTC the router holds.
  const wbtcSource = chosen.get(wbtcKey);
  if (wbtcSource === undefined) {
    throw new VenueSelectionError("I4", "no WBTC flash-loan venue configured");
  }
  chosen.delete(wbtcKey);

  return [...chosen, [wbtcKey, wbtcSource] as const].map(([token, source]) =>
    toFlashData(token, source, wbtcKey)
  );
}

function toFlashData(token: string, source: VenueSource, wbtc: string): FlashData {
  const flashData = source.flashData();

  // I2 — the router sizes each borrow by the entry's token, so an entry naming a token other than
  // the one it was chosen for borrows that other token's debt a second time.
  if (getAddress(flashData.token) !== token) {
    throw new VenueSelectionError(
      "I2",
      `venue ${source.id} was chosen for ${token} but emits an entry for ${getAddress(flashData.token)}`
    );
  }

  const kind = VENUE_KIND.get(flashData.venueType);
  if (kind === undefined) {
    throw new VenueSelectionError(
      "I1",
      `venue ${source.id} emits venue type ${flashData.venueType}, which the router does not dispatch`
    );
  }
  if (kind !== source.kind) {
    throw new VenueSelectionError(
      "I1",
      `venue ${source.id} declares ${source.kind} but emits a ${kind} venue type`
    );
  }

  // I1 — every venue debt must land in WBTC, because no `swapDatas` is built to buy anything else.
  if (token === wbtc && kind !== "flashLoan") {
    throw new VenueSelectionError(
      "I1",
      `WBTC must be funded by a flash loan, not by ${source.id}: a WBTC/x pool would leave a debt in x`
    );
  }
  if (token !== wbtc && kind !== "flashSwap") {
    throw new VenueSelectionError(
      "I1",
      `${token} must be funded by a flash swap, not by ${source.id}: a flash loan wants ${token} back, which would require a swap into it`
    );
  }

  // I3 — the swap venue returns whichever side of the pool was not borrowed as the debt, and never
  // checks that it is WBTC.
  if (kind === "flashSwap") {
    let poolKey: PoolKey;
    try {
      [poolKey] = decodeAbiParameters(poolKeyAbiParameters, flashData.swapData);
    } catch {
      throw new VenueSelectionError(
        "I3",
        `venue ${source.id} emits swapData that is not an encoded pool key`
      );
    }
    assertWbtcPairedWith(poolKey, getAddress(token), getAddress(wbtc));
  }

  return { ...flashData, token: getAddress(token) };
}
