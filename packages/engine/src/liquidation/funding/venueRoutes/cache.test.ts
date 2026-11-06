import { describe, expect, it, vi } from "vitest";
import { createReadCache } from "./cache";

describe("createReadCache", () => {
  it("shares one in-flight read between concurrent callers", async () => {
    const cache = createReadCache();
    const load = vi.fn(async () => 42n);

    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);

    expect([a, b]).toEqual([42n, 42n]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps separate keys separate", async () => {
    const cache = createReadCache();
    await cache.get("a", async () => 1);
    const load = vi.fn(async () => 2);

    await expect(cache.get("b", load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected read, so the next caller retries", async () => {
    // One transient RPC failure must not fail every later quote in the cycle.
    const cache = createReadCache();
    await expect(
      cache.get("k", async () => {
        throw new Error("rpc down");
      })
    ).rejects.toThrow("rpc down");

    await expect(cache.get("k", async () => 7)).resolves.toBe(7);
  });
});
