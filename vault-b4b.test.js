"use strict";

// Phase B4b: the focused thread canvas's server contract — POST /api/vault/nodes/bodies.
// Coverage for
//   (1) batch fetch: one request returns rendered body + media map + card-header
//       fields (title/type/tags) for a list of slugs;
//   (2) the ONE shared render path — the batch body renders byte-identical to the
//       single-node GET /api/vault/node/* (both go through renderNodeForClient);
//   (3) media embeds rewritten to placeholders + a media map keyed by hash;
//   (4) sensitive gate parity with the single-node route: a locked session gets
//       { locked:true } and NO body for a sensitive slug; unlocked gets the body;
//   (5) slugs normalized BEFORE the gate (a `..` segment can't smuggle a read into
//       a sensitive dir), unknown slugs -> { missing:true }, de-dupe, cap/truncate,
//       and a non-array `slugs` -> 400.
// The in-browser canvas (drag, windowing, zoom, drawer) is exercised in live local QA.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");

const VaultStore = require("./vault-store");
const routes = require("./routes/vault");

// ── Fixture helpers (same shape as vault-b4a.test.js) ──
async function makeVault(nodes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb4b-"));
  for (const [rel, fm, body = ""] of nodes) await writeNode(dir, rel, fm, body);
  const store = new VaultStore({ vaultDir: dir, indexFile: null });
  await store.init();
  return { dir, store };
}
async function writeNode(dir, rel, fm, body = "") {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const y = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await fsp.writeFile(abs, `---\n${y}\n---\n${body}`);
  return abs;
}
async function cleanup(dir, store) {
  try { if (store) await store.close(); } catch { /* ignore */ }
  await fsp.rm(dir, { recursive: true, force: true });
}

function mountRoutes(store) {
  const routeMap = {};
  const reg = (m) => (p, ...h) => { routeMap[m + " " + p] = h[h.length - 1]; };
  const app = { get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE") };
  const ctx = { VAULT_REPO_URL: null, syncMgr: null, vault: store };
  routes(app, ctx);
  return routeMap;
}
async function call(handler, { params = {}, query = {}, body = {}, unlocked = false } = {}) {
  const req = { params, query, body, headers: {}, session: unlocked ? { vaultUnlockedUntil: Date.now() + 60000 } : {} };
  let out = null, code = 200;
  const res = { status: (c) => { code = c; return res; }, json: (o) => { out = o; return res; } };
  await handler(req, res);
  return { code, body: out };
}
const callBodies = (rm, slugs, opts = {}) => call(rm["POST /api/vault/nodes/bodies"], { body: { slugs }, ...opts });
const callGetNode = (rm, slug, opts = {}) => call(rm["GET /api/vault/node/*"], { params: { 0: slug }, ...opts });

// ── Batch fetch: fields + one request for many slugs ──
test("bodies: one request returns card fields + rendered body for each slug", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "Alpha", date: "2026-01-01", tags: ["family", "trip"] }, "Body of **A**."],
    ["notes/b.md", { type: "idea", title: "Beta", date: "2026-02-01", tags: "solo" }, "Body of B."],
  ]);
  try {
    const rm = mountRoutes(store);
    const { code, body } = await callBodies(rm, ["notes/a", "notes/b"]);
    assert.strictEqual(code, 200);
    assert.strictEqual(body.count, 2);
    const a = body.bodies["notes/a"];
    assert.strictEqual(a.title, "Alpha");
    assert.strictEqual(a.type, "note");
    assert.deepStrictEqual(a.tags, ["family", "trip"]);
    assert.strictEqual(a.sensitive, false);
    assert.match(a.renderedBody, /Body of/);
    // A scalar tag is normalized to an array for the card's pill row.
    assert.deepStrictEqual(body.bodies["notes/b"].tags, ["solo"]);
    // Lean payload: no backlinks/outlinks/hash on the card path.
    assert.strictEqual(a.backlinks, undefined);
    assert.strictEqual(a.hash, undefined);
  } finally { await cleanup(dir, store); }
});

// ── Shared render path: batch === single-node GET ──
// NB: makeVault builds a bare tmpdir with no .mycelium/lib/parse.js, so loadParse
// returns null and renderNodeForClient's wikilink rewrite is skipped in-test (a
// literal [[..]] would pass through unchanged). This fixture therefore exercises
// the parser-INDEPENDENT half — the media-ref rewrite — where the two endpoints
// could realistically diverge. Wikilink linkification is covered by vault-b1's
// conformance test; the strictEqual below still guards that the batch route never
// forks away from the single-node render path.
test("bodies: renderedBody is byte-identical to GET /api/vault/node/* (one shared renderer)", async () => {
  const { dir, store } = await makeVault([
    ["notes/m.md", { type: "note", title: "M", date: "2026-01-01" },
      "Text before.\n\n![a cover](media:sha256:abcdef012345)\n\nText after."],
  ]);
  try {
    const rm = mountRoutes(store);
    const single = (await callGetNode(rm, "notes/m")).body;
    const batch = (await callBodies(rm, ["notes/m"])).body.bodies["notes/m"];
    assert.strictEqual(batch.renderedBody, single.renderedBody, "same render path -> same body");
    // The media embed became a client-upgradeable placeholder in both.
    assert.match(batch.renderedBody, /class="vault-media" data-media-hash="abcdef012345"/);
    // Media map is keyed by hash; the manifest is absent in the fixture -> missing.
    assert.ok(batch.media && batch.media["abcdef012345"], "media map carries the embed hash");
    assert.strictEqual(batch.media["abcdef012345"].missing, true);
  } finally { await cleanup(dir, store); }
});

// ── Sensitive gate parity ──
test("bodies: a sensitive slug is locked (no body) while locked, served when unlocked", async () => {
  const { dir, store } = await makeVault([
    ["notes/pub.md", { type: "note", title: "Pub", date: "2026-01-01" }, "public body"],
    ["health/therapy/s1.md", { type: "therapy", title: "Secret", date: "2026-02-01" }, "SECRET BODY"],
  ]);
  try {
    const rm = mountRoutes(store);

    const locked = (await callBodies(rm, ["notes/pub", "health/therapy/s1"], { unlocked: false })).body.bodies;
    assert.strictEqual(locked["notes/pub"].renderedBody, "public body");
    assert.strictEqual(locked["health/therapy/s1"].locked, true);
    assert.strictEqual(locked["health/therapy/s1"].renderedBody, undefined, "no sensitive body leaks");
    assert.strictEqual(locked["health/therapy/s1"].title, undefined, "no sensitive title leaks");

    const open = (await callBodies(rm, ["health/therapy/s1"], { unlocked: true })).body.bodies;
    assert.strictEqual(open["health/therapy/s1"].locked, undefined);
    assert.strictEqual(open["health/therapy/s1"].renderedBody, "SECRET BODY", "served when unlocked");
    assert.strictEqual(open["health/therapy/s1"].sensitive, true);
  } finally { await cleanup(dir, store); }
});

test("bodies: a `..` slug can't smuggle a read into a sensitive dir (normalize-before-gate)", async () => {
  const { dir, store } = await makeVault([
    ["health/therapy/s1.md", { type: "therapy", title: "Secret", date: "2026-02-01" }, "SECRET BODY"],
  ]);
  try {
    const rm = mountRoutes(store);
    // "health/the..rapy/s1" normalizes (drop "..") to "health/therapy/s1" -> gated.
    const { body } = await callBodies(rm, ["health/the..rapy/s1"], { unlocked: false });
    const entry = body.bodies["health/therapy/s1"];
    assert.ok(entry, "response is keyed by the NORMALIZED slug");
    assert.strictEqual(entry.locked, true, "gate fires on the normalized slug, not the raw one");
    assert.strictEqual(entry.renderedBody, undefined);
  } finally { await cleanup(dir, store); }
});

// ── Unknown, de-dupe, cap, bad input ──
test("bodies: unknown slug -> missing; duplicates collapse", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", date: "2026-01-01" }, "a"],
  ]);
  try {
    const rm = mountRoutes(store);
    const { body } = await callBodies(rm, ["notes/a", "notes/a", "notes/ghost"]);
    assert.strictEqual(body.count, 2, "duplicate collapsed");
    assert.strictEqual(body.bodies["notes/ghost"].missing, true);
    assert.ok(body.bodies["notes/a"].renderedBody);
  } finally { await cleanup(dir, store); }
});

test("bodies: caps the slug list and reports truncated", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", date: "2026-01-01" }, "a"],
  ]);
  try {
    const rm = mountRoutes(store);
    const many = [];
    for (let i = 0; i < 600; i++) many.push(`notes/n${i}`);
    const { body } = await callBodies(rm, many);
    assert.strictEqual(body.count, body.cap, "count clamped to the cap");
    assert.strictEqual(body.cap, 500);
    assert.strictEqual(body.truncated, true);
  } finally { await cleanup(dir, store); }
});

test("bodies: a non-array `slugs` is a 400", async () => {
  const { dir, store } = await makeVault([]);
  try {
    const rm = mountRoutes(store);
    const { code } = await call(rm["POST /api/vault/nodes/bodies"], { body: { slugs: "notes/a" } });
    assert.strictEqual(code, 400);
  } finally { await cleanup(dir, store); }
});
