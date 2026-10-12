import { type Address, getAddress } from "viem";
import { VenueSelectionError } from "../venues";
import { type ParsedVenue, type RegisteredVenue, VENUE_DEFINITIONS } from "./definitions";
import { VENUE_KIND } from "./flashDatas";
import type { SourceDeps, VenueSource } from "./types";

/** One `FLASH_VENUES` entry, split on ":". */
export interface FlashVenueEntry {
  tag: string;
  args: readonly string[];
  /** The entry as written, for error messages. */
  entry: string;
}

/** `FLASH_VENUES` — comma-separated `tag:args` — split into entries. Each definition validates its own. */
export function parseFlashVenues(spec: string): FlashVenueEntry[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const [tag, ...args] = entry.split(":");
      return { tag, args, entry };
    });
}

export interface VenueSources {
  /** Every source, grouped by checksummed token, each list in configuration order. */
  readonly byToken: ReadonlyMap<Address, readonly VenueSource[]>;
  /** Boot-time reads that check the configured venues agree with each other. Sends nothing. */
  prepare(): Promise<void>;
}

/**
 * Builds a source for every entry, and refuses a configuration the router could not settle.
 *
 * Everything checkable without the chain is checked here, at boot, rather than on the first
 * liquidatable position:
 *
 * - I1 for every entry: a flash loan lends WBTC, a flash swap lends anything but WBTC;
 * - each definition's own argument checks, including I3 for pools;
 * - that each source emits exactly the venue type and kind its definition declares;
 * - one source per id, and at least one WBTC source (I4).
 *
 * @param definitions The venue table. Injectable so tests can exercise definitions that misbehave.
 */
export function createVenueSources(
  entries: readonly FlashVenueEntry[],
  deps: SourceDeps,
  definitions: Readonly<Record<string, RegisteredVenue>> = VENUE_DEFINITIONS
): VenueSources {
  const wbtc = getAddress(deps.wbtc);
  const byToken = new Map<Address, VenueSource[]>();
  const ids = new Set<string>();
  const parsedEntries: ParsedVenue[] = [];

  for (const { tag, args, entry } of entries) {
    const definition = Object.hasOwn(definitions, tag) ? definitions[tag] : undefined;
    if (definition === undefined) {
      throw new Error(
        `FLASH_VENUES entry "${entry}": unknown venue type "${tag}"; known types are ${Object.keys(definitions).join(", ")}`
      );
    }

    // The fixed venue-type→kind map is the router's view; a definition that disagrees with it
    // would pass every kind-based check below while the router dispatches it as the other kind.
    const dispatchedAs = VENUE_KIND.get(definition.venueType);
    if (dispatchedAs !== definition.kind) {
      throw new Error(
        `venue type "${tag}" declares ${definition.kind}, but the router dispatches venue type ${definition.venueType} as ${dispatchedAs ?? "nothing"}`
      );
    }

    let parsed: ParsedVenue;
    try {
      parsed = definition.parse(args, wbtc);
    } catch (error) {
      // Rewrapped in both branches so the error names the entry; a selection error keeps its
      // invariant, which callers and tests key on.
      if (error instanceof VenueSelectionError) {
        throw new VenueSelectionError(
          error.invariant,
          `FLASH_VENUES entry "${entry}": ${error.message.slice(`${error.invariant}: `.length)}`
        );
      }
      throw new Error(
        `FLASH_VENUES entry "${entry}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const { token } = parsed;

    // I1 — every venue debt must land in WBTC, because no swap is built to buy anything else.
    if (definition.kind === "flashLoan" && token !== wbtc) {
      throw new VenueSelectionError(
        "I1",
        `FLASH_VENUES entry "${entry}": a flash loan of ${token} wants ${token} back, which would require a swap into it`
      );
    }
    if (definition.kind === "flashSwap" && token === wbtc) {
      throw new VenueSelectionError(
        "I1",
        `FLASH_VENUES entry "${entry}": WBTC must be funded by a flash loan; a WBTC/x pool would leave a debt in x`
      );
    }

    const sources = byToken.get(token) ?? [];
    const source = parsed.create(sources.length, deps);
    assertBound(source, definition, token, entry);

    if (ids.has(source.id)) {
      throw new Error(`FLASH_VENUES entry "${entry}" repeats venue ${source.id}`);
    }
    ids.add(source.id);

    sources.push(source);
    byToken.set(token, sources);
    parsedEntries.push(parsed);
  }

  // I4 — the router approves the adapter for the fairness payment whether or not a WBTC venue is
  // present, so a route without one spends whatever WBTC the router holds.
  if (!byToken.has(wbtc)) {
    throw new VenueSelectionError("I4", "FLASH_VENUES configures no WBTC flash-loan venue");
  }

  return {
    byToken,
    async prepare() {
      const used = [...new Set(parsedEntries.map((p) => p.definition))];
      await Promise.all(
        used.map((d) =>
          d.prepare(
            parsedEntries.filter((p) => p.definition === d),
            deps
          )
        )
      );
    },
  };
}

/**
 * Dispatch on-chain follows the emitted venue type alone, so a definition's declarations are only
 * worth checking if its sources emit exactly what it declares.
 */
function assertBound(
  source: VenueSource,
  definition: RegisteredVenue,
  token: Address,
  entry: string
): void {
  const flashData = source.flashData();
  const problems: string[] = [];
  if (source.kind !== definition.kind) {
    problems.push(`declares ${source.kind} where its type declares ${definition.kind}`);
  }
  if (flashData.venueType !== definition.venueType) {
    problems.push(
      `emits venue type ${flashData.venueType} where its type declares ${definition.venueType}`
    );
  }
  if (getAddress(source.token) !== token || getAddress(flashData.token) !== token) {
    problems.push(
      `lends ${getAddress(source.token)} and emits ${getAddress(flashData.token)} where the entry names ${token}`
    );
  }
  if (problems.length > 0) {
    throw new Error(`FLASH_VENUES entry "${entry}": venue ${source.id} ${problems.join("; ")}`);
  }
}
