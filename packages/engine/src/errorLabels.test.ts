import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `*_errors_total{type=...}` is the metric operators alert on, and its label set exists only as
// string literals scattered through the engines. Adding a `recordError("...")` costs nothing and
// breaks nothing, so an undocumented label is invisible until someone is paged by it and has
// nowhere to look up what it means. This pins each engine's emitted labels to its metrics doc.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "..", "..", "docs");

/** Every `recordError("literal")` in a file, or under a directory recursively. */
function emittedLabels(path: string): Set<string> {
  const labels = new Set<string>();
  if (statSync(path).isFile()) {
    for (const [, label] of readFileSync(path, "utf8").matchAll(/recordError\("([^"]+)"\)/g)) {
      labels.add(label);
    }
    return labels;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory() || (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))) {
      for (const label of emittedLabels(child)) labels.add(label);
    }
  }
  return labels;
}

/** The `| \`label\` | …` rows of the doc's "Error Types" table. */
function documentedLabels(docFile: string): Set<string> {
  const doc = readFileSync(join(DOCS, docFile), "utf8");
  const section = doc.slice(doc.indexOf("## Error Types"));
  return new Set([...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, label]) => label));
}

// `BaseEngine.run()` records through whichever subclass's metrics it was constructed with, so what
// the shared cycle emits lands in *both* `liquidator_errors_total` and `arbitrageur_errors_total`.
const SHARED = join(HERE, "shared", "engine.ts");

describe.each([
  { engine: "liquidation", doc: "liquidator-metrics.md" },
  { engine: "arbitrage", doc: "arbitrageur-metrics.md" },
])("$engine error labels", ({ engine, doc }) => {
  const emitted = [
    ...new Set([...emittedLabels(join(HERE, engine)), ...emittedLabels(SHARED)]),
  ].sort();
  const documented = [...documentedLabels(doc)].sort();

  it("are all documented", () => {
    expect(emitted.filter((label) => !documented.includes(label))).toEqual([]);
  });

  // The other direction: a label deleted from the code leaves a doc row describing a metric that
  // can never fire, which reads as "this never happens" rather than "this is gone".
  it("cover every documented label", () => {
    expect(documented.filter((label) => !emitted.includes(label))).toEqual([]);
  });
});
