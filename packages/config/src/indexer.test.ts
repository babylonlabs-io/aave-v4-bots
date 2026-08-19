import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildIndexerConfig, indexerEnvFields } from "./indexer";

const parse = (env: Record<string, string>) => z.object(indexerEnvFields).safeParse(env);
const parsed = (env: Record<string, string>) => z.object(indexerEnvFields).parse(env);

describe("@repo/config indexer env", () => {
  it("leaves the guard off when nothing is set", () => {
    const { indexer } = buildIndexerConfig(parsed({}));
    expect(indexer).toEqual({
      maxLagBlocks: undefined,
      haltAfterMs: 60_000,
      readyTimeoutMs: undefined,
    });
  });

  it("projects the thresholds it is given", () => {
    const { indexer } = buildIndexerConfig(
      parsed({
        INDEXER_MAX_LAG_BLOCKS: "10",
        INDEXER_MAX_LAG_HALT_MS: "30000",
        INDEXER_READY_TIMEOUT_MS: "120000",
      })
    );
    expect(indexer).toEqual({ maxLagBlocks: 10n, haltAfterMs: 30_000, readyTimeoutMs: 120_000 });
  });

  // Both durations end up in a `number`, where a value this size is `Infinity` or a rounded
  // neighbour of what was written — an indexer that is never late enough to halt, and a boot probe
  // that waits forever, neither of which reports anything unusual.
  it.each(["INDEXER_MAX_LAG_HALT_MS", "INDEXER_READY_TIMEOUT_MS"])(
    "rejects a %s that does not survive as a JS number",
    (key) => {
      expect(parse({ [key]: "9".repeat(400) }).success).toBe(false);
      expect(parse({ [key]: "9007199254740993" }).success).toBe(false);
      expect(parse({ [key]: "60000" }).success).toBe(true);
    }
  );

  // The lag threshold is compared against block numbers as a `bigint`, so it has no such ceiling.
  it("carries a block threshold past Number.MAX_SAFE_INTEGER exactly", () => {
    const { indexer } = buildIndexerConfig(parsed({ INDEXER_MAX_LAG_BLOCKS: "9007199254740993" }));
    expect(indexer.maxLagBlocks).toBe(9007199254740993n);
  });
});
