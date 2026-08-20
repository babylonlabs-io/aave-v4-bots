import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LENS_HEALTHY_POSITION_REVERT, lensAbi, vaultSwapAbi } from "@repo/abis";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
} from "viem";
import {
  FaultTally,
  describeRevert,
  isHealthyPositionRevert,
  isVaultGoneRevert,
} from "../src/probeFaults";

const ERROR_STRING_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] },
] as const;

/** A `require(false, "…")` revert, decoded the way viem decodes one off the wire. */
const stringRevert = (reason: string) =>
  new ContractFunctionRevertedError({
    abi: lensAbi,
    data: encodeErrorResult({ abi: ERROR_STRING_ABI, errorName: "Error", args: [reason] }),
    functionName: "estimateLiquidation",
  });

/** A custom error with no arguments, e.g. `revert AdapterErrors.InvalidOraclePrice()`. */
const customRevert = (abi: typeof lensAbi | typeof vaultSwapAbi, name: string) =>
  new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName: name }),
    functionName: "estimateLiquidation",
  });

/** No revert data at all — an empty `revert()`, or a call into an address that is not the lens. */
const emptyRevert = () =>
  new ContractFunctionRevertedError({
    abi: lensAbi,
    data: "0x",
    functionName: "estimateLiquidation",
  });

/**
 * viem hands the caller a `ContractFunctionExecutionError` whose `.cause` is the revert, so nothing
 * downstream ever sees the revert directly. Every classifier has to walk the chain to find it.
 */
const asThrown = (revert: ContractFunctionRevertedError) =>
  new ContractFunctionExecutionError(revert, {
    abi: lensAbi,
    functionName: "estimateLiquidation",
    args: ["0x1234567890123456789012345678901234567890", false],
  });

describe("isHealthyPositionRevert", () => {
  it("recognises the lens's healthy-position revert, wrapped or bare", () => {
    const revert = stringRevert(LENS_HEALTHY_POSITION_REVERT);
    assert.equal(isHealthyPositionRevert(revert), true);
    assert.equal(isHealthyPositionRevert(asThrown(revert)), true);
  });

  // The finding this classifier exists for. A reserve whose oracle reads zero reverts every probe
  // in the deployment; classified as "healthy" it produces an empty candidate list with a 200 and
  // a fresh timestamp, which is indistinguishable from a market in which nobody is liquidatable.
  it("does not accept a protocol error as a healthy position", () => {
    const revert = customRevert(lensAbi, "InvalidOraclePrice");
    assert.equal(isHealthyPositionRevert(revert), false);
    assert.equal(isHealthyPositionRevert(asThrown(revert)), false);
  });

  // A lens address pointing at the wrong contract, or a dependency that reverts without a reason.
  it("does not accept a revert with no data", () => {
    assert.equal(isHealthyPositionRevert(emptyRevert()), false);
    assert.equal(isHealthyPositionRevert(asThrown(emptyRevert())), false);
  });

  // Neighbouring `require` in the same function, and a genuinely different condition: a position
  // too far underwater for this call to restore. Worth surfacing, so it must not be swallowed.
  it("does not accept the lens's other revert string", () => {
    assert.equal(
      isHealthyPositionRevert(stringRevert("Position must be healthy after liquidation")),
      false
    );
  });

  it("does not accept a transport failure", () => {
    assert.equal(isHealthyPositionRevert(new Error("HTTP request failed")), false);
    assert.equal(isHealthyPositionRevert(undefined), false);
  });
});

describe("isVaultGoneRevert", () => {
  it("recognises a vault that has left escrow", () => {
    for (const name of ["VaultNotAcquirable", "InvalidEscrowedVaultStatus"]) {
      assert.equal(isVaultGoneRevert(asThrown(customRevert(vaultSwapAbi, name))), true);
    }
  });

  it("does not accept an unrelated protocol error", () => {
    assert.equal(isVaultGoneRevert(asThrown(customRevert(vaultSwapAbi, "AmountMismatch"))), false);
    assert.equal(isVaultGoneRevert(asThrown(emptyRevert())), false);
  });
});

describe("describeRevert", () => {
  it("names a custom error by its name", () => {
    assert.equal(
      describeRevert(asThrown(customRevert(lensAbi, "InvalidOraclePrice"))),
      "InvalidOraclePrice"
    );
  });

  it("names a require revert by its string", () => {
    assert.equal(describeRevert(asThrown(stringRevert("nope"))), "nope");
  });

  it("says so when there is no revert data to name", () => {
    assert.equal(describeRevert(asThrown(emptyRevert())), "revert with no data");
  });

  it("falls back to the first line of a non-contract error", () => {
    assert.equal(describeRevert(new Error("timed out\n  at fetch (…)")), "timed out");
  });
});

describe("FaultTally", () => {
  it("groups by cause, commonest first", () => {
    const tally = new FaultTally();
    tally.record(asThrown(emptyRevert()));
    for (let i = 0; i < 3; i++) tally.record(asThrown(customRevert(lensAbi, "InvalidOraclePrice")));

    assert.equal(tally.count, 4);
    assert.equal(tally.summary(), "3× InvalidOraclePrice; 1× revert with no data");
  });

  it("counts nothing until something fails", () => {
    const tally = new FaultTally();
    assert.equal(tally.count, 0);
    assert.equal(tally.summary(), "");
  });
});
