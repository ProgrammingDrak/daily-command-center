"use strict";

// Phase B7: the global graph view. Coverage for
//   (1) VaultStore.graphAll — node/edge shape, degree, typed edges, generated
//       flag, orphan count;
//   (2) the LOSSLESS identity: edges + danglingLinks + hiddenEdges === the
//       store's own totalEdges. This is the load-bearing assertion — a graph
//       that quietly drops edges is worse than no graph, and the three buckets
//       are the only places an outlink is allowed to land;
//   (3) dangling resolution matching renderWikilinks() exactly (exact slug only,
//       NO basename fallback), with sources attached so a ghost is actionable;
//   (4) sensitive gating — nodes dropped not redacted, their edges suppressed
//       into hiddenEdges, and no sensitive slug leaking through ghosts;
//   (5) routes — GET /api/vault/graph shape, per-node color, and that it does not
//       shadow the pre-existing GET /api/vault/graph/* per-slug route.
// The in-browser force layout, zoom, drag and local-hop UI are live QA.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");

const VaultStore = require("./vault-store");
const routeMod = require("./routes/vault");

// ── Fixtures (same harness shape as vault-b5/b6.test.js) ──
async function writeNode(dir, rel, fm, body = "") {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const y = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await fsp.writeFile(abs, `---\n${y}\n---\n${body}`);
  return abs;
}
async function makeVault(nodes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb7-"));
  for (const [rel, fm, body = ""] of nodes) await writeNode(dir, rel, fm, body);
  const store = new VaultStore({ vaultDir: dir, indexFile: null });
  await store.init();
  return { dir, store };
}
async function cleanup(dir, store) {
  try { if (store) await store.close(); } catch { /* ignore */ }
  await fsp.rm(dir, { recursive: true, force: true });
}
function mountRoutes(store) {
  const rm = {};
  const app = {
    get: (p, ...h) => { rm["GET " + p] = h[h.length - 1]; },
    post: (p, ...h) => { rm["POST " + p] = h[h.length - 1]; },
    put: (p, ...h) => { rm["PUT " + p] = h[h.length - 1]; },
    delete: (p, ...h) => { rm["DELETE " + p] = h[h.length - 1]; },
  };
  const ctx = { VAULT_REPO_URL: null, VAULT_SENSITIVE_PIN: "1234", syncMgr: { notifyChange() {} }, vault: store };
  routeMod(app, ctx);
  return rm;
}
function call(handler, { query = {}, body = {}, unlocked = false, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = { query, body, params, headers: {}, session: unlocked ? { vaultUnlockedUntil: Date.now() + 60000 } : {} };
    let code = 200;
    const res = { status: (c) => { code = c; return res; }, json: (o) => { resolve({ code, body: o }); return res; } };
    Promise.resolve(handler(req, res));
  });
}

// The one identity everything else hangs off: every outlink the store knows about
// lands in exactly one of the three buckets the graph reports.
function assertLossless(store, g, label) {
  const total = store.indexSummary().totalEdges;
  const sum = g.counts.edges + g.counts.danglingLinks + g.counts.hiddenEdges;
  assert.strictEqual(sum, total,
    `${label}: edges(${g.counts.edges}) + dangling(${g.counts.danglingLinks}) + hidden(${g.counts.hiddenEdges}) = ${sum}, store totalEdges = ${total}`);
}

// ── graphAll: shape, degree, typed edges ──
test("graphAll: nodes carry type/date/tags/degree; edges carry their field type", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", tags: ["coding"], date: "2026-01-02" }, "sees [[notes/b]]"],
    ["notes/b.md", { type: "note", title: "B", tags: ["reading"], date: "2026-01-03" }, "plain body"],
    ["dnd/camp.md", { type: "campaign", title: "Camp", players: ["[[people/p]]"], date: "2026-01-04" }, ""],
    ["people/p.md", { type: "person", title: "P", date: "2026-01-05" }, ""],
  ]);
  try {
    const g = store.graphAll();

    const a = g.nodes.find((n) => n.slug === "notes/a");
    assert.strictEqual(a.type, "note");
    assert.strictEqual(a.title, "A");
    assert.strictEqual(a.date, "2026-01-02");
    assert.deepStrictEqual(a.tags, ["coding"]);
    assert.strictEqual(a.generated, false);
    assert.strictEqual(a.sensitive, false);

    // Degree counts both directions.
    assert.strictEqual(a.deg, 1);
    assert.strictEqual(g.nodes.find((n) => n.slug === "notes/b").deg, 1);

    // A body link is typed "body"; a frontmatter link is typed by its FIELD name.
    // This is the distinction the view draws that Obsidian cannot.
    const body = g.edges.find((e) => e.s === "notes/a" && e.t === "notes/b");
    assert.strictEqual(body.type, "body");
    const typed = g.edges.find((e) => e.s === "dnd/camp" && e.t === "people/p");
    assert.strictEqual(typed.type, "players");

    assert.strictEqual(g.counts.nodes, 4);
    assert.strictEqual(g.counts.edges, 2);
    assert.strictEqual(g.counts.orphans, 0);
    assertLossless(store, g, "typed-edge vault");
  } finally { await cleanup(dir, store); }
});

test("graphAll: orphans are nodes with no edges in or out", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "sees [[notes/b]]"],
    ["notes/b.md", { type: "note", title: "B" }, ""],
    ["notes/lonely.md", { type: "note", title: "Lonely" }, "no links at all"],
  ]);
  try {
    const g = store.graphAll();
    assert.strictEqual(g.counts.orphans, 1);
    assert.strictEqual(g.nodes.find((n) => n.slug === "notes/lonely").deg, 0);
    assertLossless(store, g, "orphan vault");
  } finally { await cleanup(dir, store); }
});

// ── Dangling resolution ──
test("graphAll: dangling = exact-slug miss, NO basename fallback, sources attached", async () => {
  const { dir, store } = await makeVault([
    ["people/collins-quaintance.md", { type: "person", title: "Collins" }, ""],
    ["notes/a.md", { type: "note", title: "A" }, "[[collins-quaintance]] and [[people/collins]]"],
    ["notes/b.md", { type: "note", title: "B" }, "[[people/collins]] again [[people/collins]]"],
  ]);
  try {
    const g = store.graphAll();

    // DCC resolves an exact slug only. `[[collins-quaintance]]` is a BASENAME of a
    // real node, and the MCP server would resolve it -- DCC deliberately does not,
    // and renderWikilinks() dims it as dangling. The graph must agree with the note.
    assert.strictEqual(g.counts.edges, 0, "no edge should resolve by basename");

    const byTarget = new Map(g.ghosts.map((x) => [x.target, x]));
    assert.ok(byTarget.has("collins-quaintance"), "basename miss is dangling");
    assert.ok(byTarget.has("people/collins"), "wrong-slug miss is dangling");

    const collins = byTarget.get("people/collins");
    // inbound = DISTINCT notes; links = raw occurrences (b links to it twice).
    assert.strictEqual(collins.inbound, 2);
    assert.strictEqual(collins.links, 3);
    assert.deepStrictEqual(collins.sources, ["notes/a", "notes/b"]);
    assert.strictEqual(collins.sources.length, collins.inbound);

    // Ghosts never enter the node list -- they have no file, so no type/date/tags.
    assert.ok(!g.nodes.some((n) => n.slug === "people/collins"));

    assertLossless(store, g, "dangling vault");
  } finally { await cleanup(dir, store); }
});

// ── Generated (weekly-review) flag ──
test("graphAll: weekly-review notes are flagged generated so the client can hide them", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, ""],
    ["notes/reviews/2026-W31.md", { type: "note", title: "Weekly review", tags: ["review"] }, "surfaced [[notes/a]]"],
  ]);
  try {
    const g = store.graphAll();
    assert.strictEqual(g.nodes.find((n) => n.slug === "notes/reviews/2026-W31").generated, true);
    assert.strictEqual(g.nodes.find((n) => n.slug === "notes/a").generated, false);
    assertLossless(store, g, "generated vault");
  } finally { await cleanup(dir, store); }
});

// ── Sensitive gating ──
test("graphAll: sensitive nodes are DROPPED (not redacted) and their edges suppressed", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "mentions [[health/therapy/s1]]"],
    ["health/therapy/s1.md", { type: "therapy", title: "Session One", visibility: "private" }, "links out to [[notes/a]]"],
  ]);
  try {
    const locked = store.graphAll({ includeSensitive: false });

    // Dropped entirely: no node, no anonymous placeholder, no slug anywhere.
    assert.strictEqual(locked.nodes.length, 1);
    assert.strictEqual(locked.nodes[0].slug, "notes/a");
    assert.strictEqual(locked.counts.hidden, 1);
    assert.strictEqual(locked.counts.edges, 0);

    // The sensitive slug must not leak via ghosts either: it RESOLVES, it is just
    // hidden, so it is not decay and must not be reported as a dangling target.
    const leaked = JSON.stringify(locked.ghosts);
    assert.ok(!leaked.includes("therapy"), `sensitive slug leaked through ghosts: ${leaked}`);
    assert.strictEqual(locked.ghosts.length, 0);

    // BOTH directions must land in hiddenEdges: a->s1 (target hidden) and s1->a
    // (source hidden). Counting only the first is the bug the identity caught.
    assert.strictEqual(locked.counts.hiddenEdges, 2, "both a->s1 and s1->a accounted");
    assertLossless(store, locked, "locked sensitive vault");

    // Unlocked: the node and both edges come back.
    const open = store.graphAll({ includeSensitive: true });
    assert.strictEqual(open.nodes.length, 2);
    assert.strictEqual(open.counts.hidden, 0);
    assert.strictEqual(open.counts.edges, 2);
    assert.strictEqual(open.counts.hiddenEdges, 0);
    assertLossless(store, open, "unlocked sensitive vault");
  } finally { await cleanup(dir, store); }
});

// ── Routes ──
test("GET /api/vault/graph: colored nodes, counts, and sensitive gating by session", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", tags: ["coding"] }, "[[notes/b]] [[nope]]"],
    ["notes/b.md", { type: "note", title: "B" }, ""],
    ["health/therapy/s1.md", { type: "therapy", title: "S1" }, ""],
  ]);
  try {
    const rm = mountRoutes(store);
    const h = rm["GET /api/vault/graph"];
    assert.ok(h, "GET /api/vault/graph must be registered");

    const locked = await call(h);
    assert.strictEqual(locked.code, 200);
    assert.strictEqual(locked.body.counts.nodes, 2);
    assert.strictEqual(locked.body.counts.hidden, 1);
    assert.strictEqual(locked.body.counts.edges, 1);
    assert.strictEqual(locked.body.counts.ghosts, 1);
    // Every node ships a color so the client never re-implements the ontology.
    for (const n of locked.body.nodes) assert.ok(n.color, `node ${n.slug} missing color`);
    assert.ok(locked.body.unmapped, "unmapped fallback color present");
    assert.ok(!JSON.stringify(locked.body).includes("therapy"));

    const open = await call(h, { unlocked: true });
    assert.strictEqual(open.body.counts.nodes, 3);
    assert.strictEqual(open.body.counts.hidden, 0);
  } finally { await cleanup(dir, store); }
});

test("GET /api/vault/graph does not shadow the per-slug GET /api/vault/graph/*", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "[[notes/b]]"],
    ["notes/b.md", { type: "note", title: "B" }, ""],
  ]);
  try {
    const rm = mountRoutes(store);
    // Both must exist independently: the corpus route and the 1-hop route the
    // reading pane's Linked-mentions panel has always used.
    assert.ok(rm["GET /api/vault/graph"], "corpus route missing");
    assert.ok(rm["GET /api/vault/graph/*"], "per-slug route missing");

    const one = await call(rm["GET /api/vault/graph/*"], { params: { 0: "notes/b" } });
    assert.strictEqual(one.body.slug, "notes/b");
    assert.deepStrictEqual(one.body.backlinks, [{ source: "notes/a", type: "body" }]);
    assert.deepStrictEqual(one.body.neighbors, ["notes/a"]);

    const all = await call(rm["GET /api/vault/graph"]);
    assert.strictEqual(all.body.counts.nodes, 2);
    assert.ok(Array.isArray(all.body.edges));
  } finally { await cleanup(dir, store); }
});

// ── Ignore rule ──
test("_isIgnored: node_modules is skipped so dependency READMEs are not vault nodes", async () => {
  const { dir, store } = await makeVault([
    ["notes/real.md", { type: "note", title: "Real" }, ""],
    ["tools/mcp-server/node_modules/cors/README.md", { }, "# cors\nnot a note"],
    ["tools/mcp-server/node_modules/deep/nested/pkg/CHANGELOG.md", { }, "# changelog"],
    ["docs/legit.md", { type: "doc", title: "Legit doc" }, ""],
  ]);
  try {
    // A doc under tools/ or docs/ is still a legitimate (untyped or typed) node --
    // only node_modules is excluded, at any depth.
    const slugs = store.list().map((n) => n.slug);
    assert.ok(slugs.includes("notes/real"));
    assert.ok(slugs.includes("docs/legit"));
    assert.ok(!slugs.some((s) => s.includes("node_modules")), `node_modules leaked: ${slugs.join(", ")}`);

    const g = store.graphAll();
    assert.strictEqual(g.counts.nodes, 2);
    assert.ok(!JSON.stringify(g).includes("node_modules"));
    assertLossless(store, g, "node_modules vault");
  } finally { await cleanup(dir, store); }
});
