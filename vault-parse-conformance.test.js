"use strict";

// Parser conformance guard (Track B consumer side).
//
// mycelium-mind-map ships ONE shared parser (.mycelium/lib/parse.js) and a
// golden fixture (expected-edges.json). DCC's VaultStore has its own link
// extractor that MUST stay byte-identical to that parser, or the vault tab and
// the MCP server would compute different graphs. This test pins it:
//
//   1. Run the vendored fixtures through DCC's VaultStore and assert the edges
//      equal the golden file. (Hermetic — always runs, incl. CI.)
//   2. If the shared parse.js is resolvable (a local mycelium clone or VAULT_DIR),
//      also assert parse.js and VaultStore produce identical edges.
//
// If parse.js ever changes, Track A updates the fixtures + the golden file and
// coordinates re-syncing this vendored copy (see the Coordination log).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const VaultStore = require("./vault-store");

const FIX_DIR = path.join(__dirname, "test", "vault-fixtures");
const GOLDEN = path.join(FIX_DIR, "expected-edges.json");

function fixtureFiles() {
  return fs
    .readdirSync(FIX_DIR)
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .sort();
}

// Edges as DCC's VaultStore computes them, via its real _ingest path.
function vaultStoreEdges() {
  const vs = new VaultStore({ vaultDir: FIX_DIR });
  const edges = {};
  for (const name of fixtureFiles()) {
    const full = path.join(FIX_DIR, name);
    const raw = fs.readFileSync(full, "utf8");
    const stat = fs.statSync(full);
    const slug = vs._slugFromPath(full);
    vs._ingest(slug, full, raw, stat);
    edges[slug] = vs.outlinks.get(slug);
  }
  return edges;
}

function resolveSharedParser() {
  const candidates = [
    process.env.VAULT_DIR && path.join(process.env.VAULT_DIR, ".mycelium", "lib", "parse.js"),
    path.join(__dirname, "..", "..", "mycelium-mind-map", ".mycelium", "lib", "parse.js"),
    path.join(__dirname, "vault", ".mycelium", "lib", "parse.js"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { return { mod: require(c), at: c }; } catch { /* gray-matter not resolvable there */ }
    }
  }
  return null;
}

test("VaultStore edges match the golden fixture (expected-edges.json)", () => {
  assert.ok(fs.existsSync(GOLDEN), "golden fixture must exist");
  const expected = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  const actual = vaultStoreEdges();
  assert.deepStrictEqual(actual, expected);
});

// This cross-check runs locally / pre-push where a mycelium clone (or VAULT_DIR)
// exists; it SKIPS in CI by design (vault/ is gitignored, no sibling clone). CI
// coverage is the hermetic golden test above. The vendored golden is kept in
// sync with parse.js by Track A's process: any parse.js change ships with a
// green fixture in BOTH consumers (see the mycelium Coordination log).
test("shared parse.js and VaultStore produce identical edges (when parser is resolvable)", (t) => {
  const parser = resolveSharedParser();
  if (!parser) {
    t.skip("shared parse.js not resolvable here (no local mycelium clone / VAULT_DIR) — CI relies on the golden test above");
    return;
  }
  const parse = parser.mod;
  const vsEdges = vaultStoreEdges();
  for (const name of fixtureFiles()) {
    const full = path.join(FIX_DIR, name);
    const raw = fs.readFileSync(full, "utf8");
    const slug = parse.slugFromPath(full, FIX_DIR);
    assert.deepStrictEqual(
      parse.parseNode(raw).outlinks,
      vsEdges[slug],
      `parse.js diverged from VaultStore on ${slug} (parser at ${parser.at})`
    );
  }
});
