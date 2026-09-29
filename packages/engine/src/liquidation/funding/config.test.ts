import { describe, expect, it } from "vitest";
import { buildFundingParams } from "./config";

const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MORPHO = "0x2222222222222222222222222222222222222222";
const VENUE = "0x1111111111111111111111111111111111111111";
const QUOTER = "0x7777777777777777777777777777777777777777";
const STATE_VIEW = "0x8888888888888888888888888888888888888888";

// What every mode is given. No flash-only variable carries a schema default, so each one is absent
// here and set only by the mode that reads it.
const defaults = {
  LIQUIDATION_FUNDING: "inventory",
  WBTC_ADDRESS: WBTC,
};

const flash = {
  ...defaults,
  LIQUIDATION_FUNDING: "flash",
  LIQUIDATION_ROUTER_ADDRESS: "0x9999999999999999999999999999999999999999",
  FLASH_MAX_SLIPPAGE_BPS: "2000",
};

const fixed = {
  ...flash,
  FLASH_SWAP_VENUE_ADDRESS: VENUE,
  FLASH_SWAP_POOLS: `${USDC}:${WBTC}:${USDC}:3000:60`,
  WBTC_FLASH_LOAN_ADDRESS: MORPHO,
  WBTC_FLASH_LOAN_VENUE: "morpho",
};

const pool = `univ4:${VENUE}:${USDC}:${WBTC}:${USDC}:3000:60`;

const ranked = {
  ...flash,
  FLASH_VENUE_RANKING: "true",
  FLASH_VENUES: `morpho:${MORPHO},${pool}`,
  UNISWAP_V4_QUOTER_ADDRESS: QUOTER,
  UNISWAP_V4_STATE_VIEW_ADDRESS: STATE_VIEW,
};

describe("buildFundingParams", () => {
  describe("outside flash mode", () => {
    it("accepts FLASH_VENUE_RANKING unset or false, which ask for nothing", () => {
      expect(buildFundingParams(defaults)).toEqual({ mode: "inventory" });
      expect(buildFundingParams({ ...defaults, FLASH_VENUE_RANKING: "false" })).toEqual({
        mode: "inventory",
      });
    });

    it("refuses FLASH_VENUE_RANKING=true and every ranked venue variable", () => {
      expect(() => buildFundingParams({ ...defaults, FLASH_VENUE_RANKING: "true" })).toThrow(
        /FLASH_VENUE_RANKING is set but LIQUIDATION_FUNDING is "inventory"/
      );
      expect(() => buildFundingParams({ ...defaults, FLASH_VENUES: `morpho:${MORPHO}` })).toThrow(
        /FLASH_VENUES is set/
      );
      expect(() =>
        buildFundingParams({
          ...defaults,
          UNISWAP_V4_QUOTER_ADDRESS: QUOTER,
          UNISWAP_V4_STATE_VIEW_ADDRESS: STATE_VIEW,
        })
      ).toThrow(/UNISWAP_V4_QUOTER_ADDRESS, UNISWAP_V4_STATE_VIEW_ADDRESS are set/);
    });

    it("refuses the slippage bound and the WBTC venue, which only flash mode reads", () => {
      expect(() => buildFundingParams({ ...defaults, FLASH_MAX_SLIPPAGE_BPS: "2000" })).toThrow(
        /FLASH_MAX_SLIPPAGE_BPS is set/
      );
      expect(() => buildFundingParams({ ...defaults, WBTC_FLASH_LOAN_VENUE: "morpho" })).toThrow(
        /WBTC_FLASH_LOAN_VENUE is set/
      );
    });
  });

  describe("flash mode with ranking off", () => {
    it("builds the fixed venue registry, as without ranking at all", () => {
      const params = buildFundingParams(fixed);

      expect(params).toMatchObject({ mode: "flash", maxSlippageBps: 2000 });
      if (params.mode !== "flash") throw new Error("expected flash");
      expect(params.ranking).toBeUndefined();
      expect(params.venues?.flashSwaps).toHaveLength(1);
      expect(buildFundingParams({ ...fixed, FLASH_VENUE_RANKING: "false" })).toEqual(params);
    });

    it("refuses ranked venue variables the flag says nothing reads", () => {
      // The dangerous direction: a complete ranked setup would be ignored, and every token would
      // quietly use its one fixed venue.
      expect(() => buildFundingParams({ ...fixed, FLASH_VENUES: `morpho:${MORPHO}` })).toThrow(
        /FLASH_VENUES is set but FLASH_VENUE_RANKING is not "true"/
      );
      expect(() => buildFundingParams({ ...fixed, UNISWAP_V4_QUOTER_ADDRESS: QUOTER })).toThrow(
        /UNISWAP_V4_QUOTER_ADDRESS is set/
      );
    });

    it("still requires every fixed venue variable, the WBTC venue among them", () => {
      expect(() => buildFundingParams({ ...fixed, FLASH_SWAP_POOLS: undefined })).toThrow(
        /requires FLASH_SWAP_POOLS/
      );
      expect(() => buildFundingParams({ ...fixed, WBTC_FLASH_LOAN_VENUE: undefined })).toThrow(
        /requires WBTC_FLASH_LOAN_VENUE/
      );
    });

    it("requires the slippage bound, which has no default to fall back on", () => {
      expect(() => buildFundingParams({ ...fixed, FLASH_MAX_SLIPPAGE_BPS: undefined })).toThrow(
        /requires FLASH_MAX_SLIPPAGE_BPS/
      );
    });
  });

  describe("flash mode with ranking on", () => {
    it("carries the parsed entries and the quoter addresses, and no fixed registry", () => {
      const params = buildFundingParams(ranked);

      if (params.mode !== "flash") throw new Error("expected flash");
      expect(params.venues).toBeUndefined();
      expect(params.ranking?.entries.map((e) => e.tag)).toEqual(["morpho", "univ4"]);
      expect(params.ranking).toMatchObject({ quoter: QUOTER, stateView: STATE_VIEW });
    });

    it("refuses a fixed venue variable left beside FLASH_VENUES", () => {
      // Ranking reads FLASH_VENUES only, so this would be a second list of venues nobody reads.
      expect(() => buildFundingParams({ ...ranked, WBTC_FLASH_LOAN_ADDRESS: MORPHO })).toThrow(
        /WBTC_FLASH_LOAN_ADDRESS is set but FLASH_VENUE_RANKING=true reads venues from FLASH_VENUES only/
      );
    });

    it("refuses WBTC_FLASH_LOAN_VENUE, since each FLASH_VENUES entry names its own protocol", () => {
      expect(() => buildFundingParams({ ...ranked, WBTC_FLASH_LOAN_VENUE: "aavev3" })).toThrow(
        /WBTC_FLASH_LOAN_VENUE is set but FLASH_VENUE_RANKING=true/
      );
    });

    it("requires FLASH_VENUES and the router, and refuses an empty list", () => {
      expect(() => buildFundingParams({ ...ranked, FLASH_VENUES: undefined })).toThrow(
        /FLASH_VENUE_RANKING=true requires FLASH_VENUES/
      );
      expect(() =>
        buildFundingParams({ ...ranked, LIQUIDATION_ROUTER_ADDRESS: undefined })
      ).toThrow(/requires LIQUIDATION_ROUTER_ADDRESS/);
      expect(() => buildFundingParams({ ...ranked, FLASH_MAX_SLIPPAGE_BPS: undefined })).toThrow(
        /requires FLASH_MAX_SLIPPAGE_BPS/
      );
      expect(() => buildFundingParams({ ...ranked, FLASH_VENUES: " , " })).toThrow(
        /lists no venues/
      );
    });

    it("requires the quoter and StateView only when a univ4 pool is listed", () => {
      expect(() =>
        buildFundingParams({ ...ranked, UNISWAP_V4_STATE_VIEW_ADDRESS: undefined })
      ).toThrow(/univ4 pool, which requires UNISWAP_V4_STATE_VIEW_ADDRESS/);
      expect(() =>
        buildFundingParams({
          ...ranked,
          FLASH_VENUES: `morpho:${MORPHO},aavev3:${VENUE}`,
          UNISWAP_V4_QUOTER_ADDRESS: undefined,
          UNISWAP_V4_STATE_VIEW_ADDRESS: undefined,
        })
      ).not.toThrow();
    });
  });
});
