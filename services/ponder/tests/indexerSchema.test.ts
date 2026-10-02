import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_ENV_KEYS,
  indexerSchema,
  isPackageSource,
  readSources,
} from "../scripts/indexerSchema.mjs";

const base = {
  sources: [
    { path: "ponder.config.ts", contents: "config" },
    { path: "src/Spoke.ts", contents: "handler" },
  ],
  ponderVersion: "0.13.16",
  env: { CHAIN_ID: "1", VAULT_SWAP_ADDRESS: "0xvaultswap" },
};

describe("indexerSchema", () => {
  it("is stable for the same build and config", () => {
    assert.equal(
      indexerSchema(base),
      indexerSchema({ ...base, sources: [...base.sources].reverse() })
    );
  });

  it("is a valid unquoted Postgres identifier", () => {
    assert.match(indexerSchema(base), /^ponder_[0-9a-f]{12}$/);
  });

  it("changes when a source file changes", () => {
    const sources = [base.sources[0], { path: "src/Spoke.ts", contents: "handler v2" }];
    assert.notEqual(indexerSchema({ ...base, sources }), indexerSchema(base));
  });

  it("changes when the Ponder version changes", () => {
    assert.notEqual(indexerSchema({ ...base, ponderVersion: "0.14.0" }), indexerSchema(base));
  });

  for (const key of SCHEMA_ENV_KEYS) {
    it(`changes when ${key} changes`, () => {
      assert.notEqual(
        indexerSchema({ ...base, env: { ...base.env, [key]: "changed" } }),
        indexerSchema(base)
      );
    });
  }

  it("ignores env values that do not feed the config contracts", () => {
    assert.equal(
      indexerSchema({ ...base, env: { ...base.env, PONDER_RPC_URL: "http://other" } }),
      indexerSchema(base)
    );
  });
});

describe("readSources", () => {
  const sources = readSources(fileURLToPath(new URL("..", import.meta.url)));
  const paths = sources.map((s) => s.path);

  it("reads the config, the schema, the indexing source and the ABIs", () => {
    for (const path of ["ponder.config.ts", "ponder.schema.ts", "src/Spoke.ts"]) {
      assert.ok(paths.includes(path), path);
    }
    assert.ok(paths.some((p) => p.startsWith("../../packages/abis/src/")));
  });

  it("skips package tests", () => {
    assert.ok(!paths.some((p) => p.startsWith("../../packages/") && p.endsWith(".test.ts")));
  });
});

describe("isPackageSource", () => {
  for (const path of ["src/a.ts", "src/a.js", "src/a.mjs", "src/a.mts"]) {
    it(`hashes ${path}, as Ponder does`, () => assert.ok(isPackageSource(path)));
  }
  for (const path of ["src/a.test.ts", "src/a.spec.mjs", "src/README.md"]) {
    it(`skips ${path}`, () => assert.ok(!isPackageSource(path)));
  }
});
