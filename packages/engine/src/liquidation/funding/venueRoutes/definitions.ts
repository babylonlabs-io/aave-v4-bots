import { VenueType, type VenueTypeValue } from "@repo/abis";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { type AaveV3Config, assertWbtcListed, createAaveV3Source } from "../flashVenues/aaveV3";
import { type MorphoConfig, createMorphoSource } from "../flashVenues/morpho";
import {
  type UniswapV4PoolConfig,
  assertSharedPoolManager,
  createUniswapV4Source,
} from "../liquidityVenues/uniswapV4";
import { assertWbtcPairedWith } from "../venues";
import type { SourceDeps, VenueKind, VenueSource } from "./types";

/**
 * How one venue type is configured and built.
 *
 * Another instance of a type is configuration: one more `FLASH_VENUES` entry. Another type is one
 * more definition — but only once the router can dispatch it. `VenueManager` accepts a fixed set of
 * venue types and reverts on any other, and a test pins every definition to that set.
 */
export interface VenueDefinition<C> {
  /** The `FLASH_VENUES` tag, e.g. `morpho`. */
  readonly tag: string;
  readonly kind: VenueKind;
  /** The on-chain venue type this definition's sources emit. */
  readonly venueType: VenueTypeValue;
  /** An entry's arguments after the tag. Throws on anything malformed. */
  parse(args: readonly string[], wbtc: Address): C;
  /** The token the entry lends. */
  token(config: C, wbtc: Address): Address;
  create(config: C, priority: number, deps: SourceDeps): VenueSource;
  /** Boot-time reads across every entry of this type. Sends nothing. */
  prepare?(configs: readonly C[], deps: SourceDeps): Promise<void>;
}

/** One entry parsed by its definition, with the config it produced kept out of sight. */
export interface ParsedVenue {
  readonly definition: RegisteredVenue;
  readonly token: Address;
  create(priority: number, deps: SourceDeps): VenueSource;
}

/**
 * A definition with its config type erased, so definitions of different types share one table.
 * `prepare` only ever sees the configs this definition parsed itself.
 */
export interface RegisteredVenue {
  readonly tag: string;
  readonly kind: VenueKind;
  readonly venueType: VenueTypeValue;
  parse(args: readonly string[], wbtc: Address): ParsedVenue;
  prepare(parsed: readonly ParsedVenue[], deps: SourceDeps): Promise<void>;
}

export function defineVenue<C>(definition: VenueDefinition<C>): RegisteredVenue {
  const configs = new WeakMap<ParsedVenue, C>();
  const registered: RegisteredVenue = {
    tag: definition.tag,
    kind: definition.kind,
    venueType: definition.venueType,
    parse(args, wbtc) {
      const config = definition.parse(args, wbtc);
      const parsed: ParsedVenue = {
        definition: registered,
        token: getAddress(definition.token(config, wbtc)),
        create: (priority, deps) => definition.create(config, priority, deps),
      };
      configs.set(parsed, config);
      return parsed;
    },
    async prepare(parsed, deps) {
      if (definition.prepare === undefined) return;
      const own = parsed.flatMap((p) => (configs.has(p) ? [configs.get(p) as C] : []));
      if (own.length > 0) await definition.prepare(own, deps);
    },
  };
  return registered;
}

function expectArgs(args: readonly string[], min: number, max: number, shape: string): void {
  if (args.length < min || args.length > max) {
    throw new Error(`expected ${shape}, got ${args.length} argument(s)`);
  }
}

function parseAddress(value: string, name: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${name} "${value}" is not an address`);
  return getAddress(value);
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  const n = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} "${value}" must be an integer in [${min}, ${max}]`);
  }
  return n;
}

const morpho = defineVenue<MorphoConfig>({
  tag: "morpho",
  kind: "flashLoan",
  venueType: VenueType.Morpho,
  parse(args) {
    expectArgs(args, 1, 1, "morpho:<morpho>");
    return { morpho: parseAddress(args[0], "morpho") };
  },
  token: (_config, wbtc) => wbtc,
  create: createMorphoSource,
});

const aavev3 = defineVenue<AaveV3Config>({
  tag: "aavev3",
  kind: "flashLoan",
  venueType: VenueType.AaveV3,
  parse(args) {
    expectArgs(args, 1, 1, "aavev3:<pool>");
    return { pool: parseAddress(args[0], "pool") };
  },
  token: (_config, wbtc) => wbtc,
  create: createAaveV3Source,
  prepare: (configs, deps) =>
    assertWbtcListed(
      configs.map((c) => c.pool),
      deps
    ),
});

const univ4 = defineVenue<UniswapV4PoolConfig>({
  tag: "univ4",
  kind: "flashSwap",
  venueType: VenueType.UniswapV4FlashSwap,
  parse(args, wbtc) {
    expectArgs(
      args,
      6,
      7,
      "univ4:<venueAddress>:<token>:<currency0>:<currency1>:<fee>:<tickSpacing>[:hooks]"
    );
    const [venueAddress, token, currency0, currency1, fee, tickSpacing, hooks] = args;
    const config: UniswapV4PoolConfig = {
      venueAddress: parseAddress(venueAddress, "venueAddress"),
      token: parseAddress(token, "token"),
      poolKey: {
        currency0: parseAddress(currency0, "currency0"),
        currency1: parseAddress(currency1, "currency1"),
        // uint24, which includes the dynamic-fee flag.
        fee: parseInteger(fee, "fee", 0, 0xffffff),
        // The pool manager's own bounds on tick spacing.
        tickSpacing: parseInteger(tickSpacing, "tickSpacing", 1, 32_767),
        hooks: hooks === undefined ? zeroAddress : parseAddress(hooks, "hooks"),
      },
    };
    // The pool manager only initialises a key whose currency0 sorts below its currency1, so a key in
    // the other order names a pool that cannot exist. Every quote for it would fail as unknown,
    // which the planner treats as an outage rather than a verdict; refusing it here names the
    // mistake at boot instead.
    const { currency0: c0, currency1: c1 } = config.poolKey;
    if (BigInt(c0) >= BigInt(c1)) {
      throw new Error(`currency0 ${c0} must sort below currency1 ${c1}`);
    }
    // I3 at parse time, so a mis-paired pool fails at boot with its entry named.
    assertWbtcPairedWith(config.poolKey, config.token, getAddress(wbtc));
    return config;
  },
  token: (config) => config.token,
  create: createUniswapV4Source,
  prepare: (configs, deps) =>
    assertSharedPoolManager(
      configs.map((c) => c.venueAddress),
      deps
    ),
});

/** Every venue type `FLASH_VENUES` can name, by tag. */
export const VENUE_DEFINITIONS: Readonly<Record<string, RegisteredVenue>> = {
  morpho,
  aavev3,
  univ4,
};
