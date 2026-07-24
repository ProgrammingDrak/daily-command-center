"use strict";

// Phase B5: saved views, search, discovery, scale guards. Coverage for
//   (1) splitBody byte-identity vs gray-matter + the boot cache (v2) reusing
//       unchanged files with an identical body;
//   (2) VaultStore.search — two-index sensitivity gate (locked hides sensitive),
//       snippets, mode:"title", incremental add/remove/sensitivity-flip, sidecar;
//   (3) VaultStore.orphans + unlinked (index-driven, edge-aware, gated);
//   (4) the routes — /search (gate + escape + pagination), /orphans, /unlinked
//       (403 on a locked target), /views round-trip + sanitize + sync-notify,
//       /nodes pagination envelope, /status scale sentinel.
// The in-browser search box / ⌘K switcher / chips are exercised in live local QA.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const matter = require("gray-matter");

const VaultStore = require("./vault-store");
const { splitBody, isSensitivePath } = require("./vault-store");

// ── Fixtures ──
async function writeNode(dir, rel, fm, body = "") {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const y = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await fsp.writeFile(abs, `---\n${y}\n---\n${body}`);
  return abs;
}
async function makeVault(nodes, { indexFile = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb5-"));
  for (const [rel, fm, body = ""] of nodes) await writeNode(dir, rel, fm, body);
  const store = new VaultStore({ vaultDir: dir, indexFile: indexFile ? path.join(dir, indexFile) : null });
  await store.init();
  return { dir, store };
}
async function cleanup(dir, store) {
  try { if (store) await store.close(); } catch { /* ignore */ }
  await fsp.rm(dir, { recursive: true, force: true });
}

function mountRoutes(store, sync) {
  const rm = {};
  const app = {
    get: (p, ...h) => { rm["GET " + p] = h[h.length - 1]; },
    post: (p, ...h) => { rm["POST " + p] = h[h.length - 1]; },
    put: (p, ...h) => { rm["PUT " + p] = h[h.length - 1]; },
    delete: (p, ...h) => { rm["DELETE " + p] = h[h.length - 1]; },
  };
  const ctx = { VAULT_REPO_URL: null, VAULT_SENSITIVE_PIN: "1234", syncMgr: sync || null, vault: store };
  require("./routes/vault")(app, ctx);
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

// ── splitBody + boot cache ──
test("splitBody byte-identical to gray-matter (frontmatter, none, rule-in-body)", () => {
  const a = "---\ntype: note\ntitle: X\n---\nhello\n\n---\n\nworld";
  assert.strictEqual(splitBody(a), matter(a).content);
  const b = "no frontmatter here\njust text";
  assert.strictEqual(splitBody(b), matter(b).content);
  const c = "---\ntype: note\n---\n";
  assert.strictEqual(splitBody(c), matter(c).content);
});

test("boot cache (v2): unchanged files reconstructed via _ingestCached, body identical, edges intact", async () => {
  const { dir, store } = await makeVault([
    ["people/collins.md", { type: "person", title: "Collins" }, "coworker"],
    ["notes/n1.md", { type: "note", title: "N1" }, "links to [[people/collins]] here"],
  ], { indexFile: ".idx.json" });
  await store.close(); // persists v2 index (frontmatter + outlinks per node)
  const store2 = new VaultStore({ vaultDir: dir, indexFile: path.join(dir, ".idx.json") });
  // Spy: a body-only assertion can't tell a cache HIT from a MISS (splitBody is
  // byte-identical to matter().content), so prove the cache path actually fired.
  let cached = 0;
  const orig = store2._ingestCached.bind(store2);
  store2._ingestCached = (...a) => { cached++; return orig(...a); };
  await store2.init();
  assert.ok(cached >= 1, "at least one unchanged node was reconstructed from cache (_ingestCached ran)");
  const raw = await fsp.readFile(path.join(dir, "people/collins.md"), "utf8");
  assert.strictEqual(store2.get("people/collins").body, matter(raw).content, "cached body byte-identical to fresh parse");
  assert.deepStrictEqual(store2.get("people/collins").backlinks.map((b) => b.source), ["notes/n1"], "backlinks reconstructed from cached outlinks");
  await cleanup(dir, store2);
});

test("boot cache: a parse-error node is NOT cache-reused (whole-raw body preserved)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb5-"));
  const p = path.join(dir, "notes/broken.md");
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, "---\nbad: [unclosed\ntitle: X\n---\nHello body");
  const idx = path.join(dir, ".idx.json");
  const s1 = new VaultStore({ vaultDir: dir, indexFile: idx });
  await s1.init();
  assert.ok(s1.get("notes/broken").body.includes("bad: [unclosed"), "parse-error node keeps the whole raw as body (gray-matter fallback)");
  await s1.close();
  const s2 = new VaultStore({ vaultDir: dir, indexFile: idx });
  await s2.init();
  // If the _parseError guard regressed, _ingestCached would splitBody() this and
  // the body would be just "Hello body" (frontmatter stripped) — diverging from disk.
  assert.ok(s2.get("notes/broken").body.includes("bad: [unclosed"), "reopened: parse-error node re-parsed (cache skipped), body still whole-raw");
  await cleanup(dir, s2);
});

// ── search: sensitivity, snippet, mode, incremental ──
test("search: sensitive nodes only when includeSensitive; snippet around hit", async () => {
  const { dir, store } = await makeVault([
    ["journal/2026/j1.md", { type: "journal", title: "Nashville", date: "2026-07-01" }, "quick brown fox with Collins"],
    ["health/therapy/s1.md", { type: "therapy", title: "Session" }, "the codeword banana appears"],
  ]);
  assert.deepStrictEqual(store.search("fox").results.map((r) => r.slug), ["journal/2026/j1"]);
  assert.match(store.search("fox").results[0].snippet, /fox/);
  assert.deepStrictEqual(store.search("banana").results.map((r) => r.slug), [], "banana hidden when locked");
  assert.deepStrictEqual(
    store.search("banana", { includeSensitive: true }).results.map((r) => r.slug),
    ["health/therapy/s1"], "banana surfaces when unlocked");
  await cleanup(dir, store);
});

test("search mode:title restricts to title/alias; body-only terms don't match", async () => {
  const { dir, store } = await makeVault([
    ["people/collins.md", { type: "person", title: "Collins", aliases: ["Coll"] }, "mentions nashville in body"],
  ]);
  assert.deepStrictEqual(store.search("coll", { mode: "title" }).results.map((r) => r.slug), ["people/collins"]);
  assert.deepStrictEqual(store.search("nashville", { mode: "title" }).results.map((r) => r.slug), [], "body term not matched in title mode");
  await cleanup(dir, store);
});

test("search incremental: write adds to main, delete removes, a new sensitive write is gated to the sensitive index", async () => {
  const { dir, store } = await makeVault([["notes/a.md", { type: "note", title: "Apple" }, "granny smith"]]);
  assert.deepStrictEqual(store.search("granny").results.map((r) => r.slug), ["notes/a"]);
  // new node via write()
  await store.write("notes/b.md".replace(/\.md$/, ""), { frontmatter: { type: "note", title: "Banana split" }, body: "yummy" });
  assert.deepStrictEqual(store.search("banana", { mode: "title" }).results.map((r) => r.slug), ["notes/b"]);
  // delete
  await store.delete("notes/a");
  assert.deepStrictEqual(store.search("granny").results.map((r) => r.slug), []);
  // A newly written sensitive-dir node lands in the sensitive index only: hidden
  // while locked, found when unlocked. (Sensitivity is path-derived, so a fixed
  // slug can't flip in place; a cross-dir move is a watcher delete+add.)
  await store.write("journal/private/secret", { frontmatter: { type: "journal", title: "Hidden" }, body: "xyzzy marker" });
  assert.deepStrictEqual(store.search("xyzzy").results.map((r) => r.slug), [], "sensitive body hidden locked");
  assert.deepStrictEqual(store.search("xyzzy", { includeSensitive: true }).results.map((r) => r.slug), ["journal/private/secret"]);
  await cleanup(dir, store);
});

test("search indexes media text_sidecar of embedded media", async () => {
  const { dir, store } = await makeVault([
    ["notes/scan.md", { type: "note", title: "Scan" }, "see the doc ![scan](media:sha256:abcdef012345)"],
  ]);
  // Sidecar term is NOT in the body — only findable if the sidecar is indexed.
  assert.deepStrictEqual(store.search("zephyrine").results.map((r) => r.slug), []);
  await fsp.mkdir(path.join(dir, "media/manifests/2026"), { recursive: true });
  await fsp.writeFile(path.join(dir, "media/manifests/2026/abcdef012345.txt"), "invoice total zephyrine ltd");
  await store.buildSearchIndex();
  assert.deepStrictEqual(store.search("zephyrine").results.map((r) => r.slug), ["notes/scan"]);
  await cleanup(dir, store);
});

// ── orphans + unlinked ──
test("orphans: zero-edge nodes, excluding inbox/fleeting; sensitive gated", async () => {
  const { dir, store } = await makeVault([
    ["ideas/lonely.md", { type: "idea", title: "Lonely" }, "no links"],
    ["inbox/scratch.md", { type: "fleeting", created: "2026-07-01" }, "ignore me"],
    ["notes/x.md", { type: "note", title: "X" }, "[[ideas/lonely]]"], // gives lonely a backlink
    ["notes/y.md", { type: "note", title: "Y" }, "islanded"],          // orphan
    ["health/therapy/s.md", { type: "therapy", title: "S" }, "orphan but sensitive"],
  ]);
  assert.deepStrictEqual(store.orphans().map((o) => o.slug), ["notes/y"], "lonely has a backlink; inbox+sensitive excluded");
  assert.ok(store.orphans({ includeSensitive: true }).some((o) => o.slug === "health/therapy/s"));
  await cleanup(dir, store);
});

test("unlinked: mentions by title with no edge; clears after linking", async () => {
  const { dir, store } = await makeVault([
    ["people/collins.md", { type: "person", title: "Collins" }, "coworker"],
    ["journal/2026/j.md", { type: "journal", title: "Trip", date: "2026-07-01" }, "went with Collins to the show"],
    ["journal/2026/k.md", { type: "journal", title: "Linked", date: "2026-07-02" }, "saw [[people/collins]] again"],
  ]);
  const u = store.unlinked("people/collins");
  assert.deepStrictEqual(u.map((m) => m.slug), ["journal/2026/j"], "k already links, j is the unlinked mention");
  assert.strictEqual(u[0].term, "Collins");
  // link it: j now references collins -> no longer unlinked
  const j = store.get("journal/2026/j");
  await store.write("journal/2026/j", { frontmatter: j.frontmatter, body: j.body + " [[people/collins]]", expectedHash: j.hash });
  assert.deepStrictEqual(store.unlinked("people/collins").map((m) => m.slug), []);
  await cleanup(dir, store);
});

// ── routes ──
test("GET /api/vault/search: gate + snippet escaped + pagination envelope", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "Alpha" }, "hello <script>x</script> world"],
    ["health/therapy/s.md", { type: "therapy", title: "Secret" }, "hello secret"],
  ]);
  const rm = mountRoutes(store);
  const locked = await call(rm["GET /api/vault/search"], { query: { q: "hello" } });
  assert.strictEqual(locked.body.results.length, 1, "only the non-sensitive hit while locked");
  assert.match(locked.body.results[0].snippet, /&lt;script&gt;/, "snippet is HTML-escaped");
  assert.ok(typeof locked.body.tookMs === "number");
  const unlocked = await call(rm["GET /api/vault/search"], { query: { q: "hello" }, unlocked: true });
  assert.strictEqual(unlocked.body.results.length, 2, "sensitive hit joins when unlocked");
  const paged = await call(rm["GET /api/vault/search"], { query: { q: "hello", limit: "1", offset: "1" }, unlocked: true });
  assert.strictEqual(paged.body.total, 2);
  assert.strictEqual(paged.body.results.length, 1);
  await cleanup(dir, store);
});

test("GET /api/vault/unlinked: 403 for a locked sensitive target", async () => {
  const { dir, store } = await makeVault([["health/therapy/s.md", { type: "therapy", title: "S" }, "x"]]);
  const rm = mountRoutes(store);
  const locked = await call(rm["GET /api/vault/unlinked"], { query: { slug: "health/therapy/s" } });
  assert.strictEqual(locked.code, 403);
  const ok = await call(rm["GET /api/vault/unlinked"], { query: { slug: "health/therapy/s" }, unlocked: true });
  assert.strictEqual(ok.code, 200);
  await cleanup(dir, store);
});

test("GET/PUT /api/vault/views: round-trip, sanitize, sync-notify", async () => {
  const { dir, store } = await makeVault([["notes/a.md", { type: "note", title: "A" }, "x"]]);
  const notified = [];
  const rm = mountRoutes(store, { notifyChange: (c) => notified.push(c) });
  const empty = await call(rm["GET /api/vault/views"]);
  assert.deepStrictEqual(empty.body.views, []);
  const put = await call(rm["PUT /api/vault/views"], { body: { views: [
    { name: "Projects", icon: "🗂️", surface: "explorer", query: { type: "project" } },
    { name: "", surface: "explorer" },              // dropped (no name)
    { name: "Bad surface", surface: "graph" },      // surface coerced to explorer
  ] } });
  assert.strictEqual(put.body.views.length, 2, "nameless view dropped");
  assert.strictEqual(put.body.views[0].name, "Projects");
  assert.ok(put.body.views[0].id, "id assigned");
  assert.strictEqual(put.body.views[1].surface, "explorer", "bad surface coerced");
  assert.ok(notified.some((n) => n.slug === ".mycelium/views.json"), "sync notified");
  // persisted to the repo, not DATA_DIR
  assert.ok(fs.existsSync(path.join(dir, ".mycelium", "views.json")));
  const reread = await call(rm["GET /api/vault/views"]);
  assert.strictEqual(reread.body.views.length, 2);
  await cleanup(dir, store);
});

test("GET /api/vault/nodes: bare array by default, paged envelope with limit", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, ""],
    ["notes/b.md", { type: "note", title: "B" }, ""],
    ["notes/c.md", { type: "note", title: "C" }, ""],
  ]);
  const rm = mountRoutes(store);
  const bare = await call(rm["GET /api/vault/nodes"], {});
  assert.ok(Array.isArray(bare.body), "no limit -> bare array (back-compat)");
  const paged = await call(rm["GET /api/vault/nodes"], { query: { limit: "2", offset: "1" } });
  assert.strictEqual(paged.body.total, 3);
  assert.strictEqual(paged.body.nodes.length, 2);
  assert.strictEqual(paged.body.offset, 1);
  await cleanup(dir, store);
});

test("GET /api/vault/recent: sensitive-gated list + shape (Today+recent default)", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "Apple" }, "x"],
    ["health/therapy/s.md", { type: "therapy", title: "Session" }, "x"],
  ]);
  const rm = mountRoutes(store);
  const locked = await call(rm["GET /api/vault/recent"]);
  assert.deepStrictEqual(locked.body.results.map((r) => r.slug), ["notes/a"], "sensitive excluded while locked");
  assert.strictEqual(locked.body.results[0].title, "Apple");
  const unlocked = await call(rm["GET /api/vault/recent"], { unlocked: true });
  assert.strictEqual(unlocked.body.total, 2);
  assert.ok(unlocked.body.results.some((r) => r.slug === "health/therapy/s"));
  const paged = await call(rm["GET /api/vault/recent"], { query: { limit: "1", offset: "1" }, unlocked: true });
  assert.strictEqual(paged.body.results.length, 1);
  await cleanup(dir, store);
});

test("GET /api/vault/status: scale sentinel present + warn thresholds", async () => {
  const { dir, store } = await makeVault([["notes/a.md", { type: "note", title: "A" }, "x"]]);
  const rm = mountRoutes(store);
  const st = await call(rm["GET /api/vault/status"]);
  assert.ok(st.body.scale, "scale block present");
  assert.strictEqual(st.body.scale.warn, false);
  assert.strictEqual(typeof st.body.scale.initMs, "number");
  // Disk-bytes threshold (>3 GB).
  store.diskBytes = 4 * 1024 * 1024 * 1024;
  const diskWarn = store.scaleStatus();
  assert.strictEqual(diskWarn.warn, true);
  assert.ok(diskWarn.warnReasons.some((r) => /GB/.test(r)));
  store.diskBytes = 0;
  // Node-count threshold (>20k). scaleStatus reads only nodes.size, so stub it.
  const realNodes = store.nodes;
  store.nodes = { size: 20001 };
  const nodeWarn = store.scaleStatus();
  store.nodes = realNodes;
  assert.strictEqual(nodeWarn.warn, true);
  assert.ok(nodeWarn.warnReasons.some((r) => /nodes/.test(r)));
  await cleanup(dir, store);
});

// ── sensitivity predicate parity (all four dirs, security-relevant) ──
test("isSensitivePath matches all four sensitive dirs (and not lookalikes)", () => {
  assert.ok(isSensitivePath("health/therapy/x"));
  assert.ok(isSensitivePath("health/moments/x"));
  assert.ok(isSensitivePath("health/medical/x"));
  assert.ok(isSensitivePath("journal/private/2026/x"));
  assert.ok(!isSensitivePath("health/notes/x"));
  assert.ok(!isSensitivePath("health/med/x"));
  assert.ok(!isSensitivePath("journal/2026/x"));
});
