import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIndexingModes } from "../src/indexingModes";

const A = "0xadapter";
const S = "0xspoke";
const V = "0xvaultswap";

describe("resolveIndexingModes", () => {
  it("enables liquidation only when adapter + spoke are both set", () => {
    assert.deepEqual(resolveIndexingModes({ ADAPTER_ADDRESS: A, SPOKE_ADDRESS: S }), {
      indexLiquidation: true,
      indexArbitrage: false,
    });
  });

  it("enables arbitrage when the vault swap address is set", () => {
    assert.deepEqual(resolveIndexingModes({ VAULT_SWAP_ADDRESS: V }), {
      indexLiquidation: false,
      indexArbitrage: true,
    });
  });

  it("enables both modes for a shared instance", () => {
    assert.deepEqual(
      resolveIndexingModes({ ADAPTER_ADDRESS: A, SPOKE_ADDRESS: S, VAULT_SWAP_ADDRESS: V }),
      { indexLiquidation: true, indexArbitrage: true }
    );
  });

  it("throws when liquidation is half-configured (spoke without adapter)", () => {
    assert.throws(
      () => resolveIndexingModes({ SPOKE_ADDRESS: S }),
      /BOTH SPOKE_ADDRESS and ADAPTER_ADDRESS/
    );
  });

  it("throws when liquidation is half-configured (adapter without spoke)", () => {
    assert.throws(
      () => resolveIndexingModes({ ADAPTER_ADDRESS: A }),
      /BOTH SPOKE_ADDRESS and ADAPTER_ADDRESS/
    );
  });

  it("throws when no index mode is enabled", () => {
    assert.throws(() => resolveIndexingModes({}), /Enable at least one index mode/);
  });

  it("half-configured liquidation throws even when arbitrage would be enabled", () => {
    // The half-config guard fires before arbitrage is considered, so a typo in the
    // liquidation addresses can't be masked by a valid arbitrage setup.
    assert.throws(
      () => resolveIndexingModes({ SPOKE_ADDRESS: S, VAULT_SWAP_ADDRESS: V }),
      /BOTH SPOKE_ADDRESS/
    );
  });
});
