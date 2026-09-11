import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VAULT_GONE_ERRORS, vaultSwapAbi } from "@repo/abis";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { previewInChunks } from "../src/previewVaults";

/** A vault-gone revert, decoded the way viem decodes one off the wire. */
const goneRevert = () =>
  new ContractFunctionRevertedError({
    abi: vaultSwapAbi,
    data: encodeErrorResult({ abi: vaultSwapAbi, errorName: VAULT_GONE_ERRORS[0] }),
    functionName: "previewEscrowedVaults",
  });

/**
 * A fake `previewEscrowedVaults`. Like the contract, it reverts a call that names any gone vault,
 * and it records every call and the peak number in flight.
 */
function fakeChain(gone: ReadonlySet<string>, broken: ReadonlySet<string> = new Set()) {
  const calls: string[][] = [];
  let active = 0;
  let peak = 0;
  const preview = async (ids: readonly string[]) => {
    calls.push([...ids]);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active--;
    if (ids.some((id) => gone.has(id))) throw goneRevert();
    if (ids.some((id) => broken.has(id))) throw new Error("rpc down");
    return ids.map((id) => ({ id }));
  };
  return { preview, calls, peak: () => peak };
}

const vaultIds = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);

describe("previewInChunks", () => {
  it("reads a clean list in one call per chunk", async () => {
    const ids = vaultIds(60);
    const chain = fakeChain(new Set());

    const out = await previewInChunks(ids, chain.preview, 25);

    assert.deepEqual(
      chain.calls.map((c) => c.length),
      [25, 25, 10]
    );
    assert.deepEqual(
      out.previews.map((p) => p.id),
      ids
    );
    assert.equal(out.gone, 0);
    assert.deepEqual(out.failures, []);
    assert.equal(out.batchError, undefined);
  });

  // The routine case: the indexer still lists a vault acquired a moment ago.
  it("limits a gone vault's cost to its own chunk", async () => {
    const ids = vaultIds(100);
    const chain = fakeChain(new Set(["v30"]));

    const out = await previewInChunks(ids, chain.preview, 25);

    // Four chunk calls, then one call per vault of the chunk that holds v30.
    assert.equal(chain.calls.length, 4 + 25);
    assert.deepEqual(
      out.previews.map((p) => p.id),
      ids.filter((id) => id !== "v30")
    );
    assert.equal(out.gone, 1);
    assert.deepEqual(out.failures, []);
    assert.ok(out.batchError instanceof ContractFunctionRevertedError);
  });

  it("keeps per-vault reads within one chunk when every chunk fails", async () => {
    const ids = vaultIds(1000);
    const chain = fakeChain(new Set(ids.filter((_, i) => i % 25 === 0)));

    const out = await previewInChunks(ids, chain.preview, 25);

    assert.ok(chain.peak() <= 25, `peak ${chain.peak()} reads in flight`);
    assert.equal(out.gone, 40);
    assert.equal(out.previews.length, 960);
    assert.deepEqual(out.failures, []);
  });

  it("reports a vault that fails for a reason other than leaving escrow", async () => {
    const ids = vaultIds(10);
    const chain = fakeChain(new Set(["v2"]), new Set(["v7"]));

    const out = await previewInChunks(ids, chain.preview, 25);

    assert.equal(out.gone, 1);
    assert.deepEqual(
      out.failures.map((f) => f.vaultId),
      ["v7"]
    );
    assert.equal(out.previews.length, 8);
  });

  it("reads a chunk again one vault at a time when the batch comes back short", async () => {
    const ids = vaultIds(5);
    const out = await previewInChunks(ids, async (chunk) =>
      chunk.length > 1 ? [] : chunk.map((id) => ({ id }))
    );

    assert.deepEqual(
      out.previews.map((p) => p.id),
      ids
    );
    assert.deepEqual(out.failures, []);
  });

  it("counts an empty single-vault answer as a failure", async () => {
    const out = await previewInChunks(vaultIds(2), async () => []);

    assert.deepEqual(
      out.failures.map((f) => [f.vaultId, f.error]),
      [
        ["v0", "empty response"],
        ["v1", "empty response"],
      ]
    );
    assert.deepEqual(out.previews, []);
  });
});
