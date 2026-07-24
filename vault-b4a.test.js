"use strict";

// Phase B4a: the signature timeline. Coverage for
//   (1) VaultStore inverted facet indexes (tag/person/event -> slugs) maintained
//       incrementally at build/write/edit/delete, incl. wikilink normalization;
//   (2) VaultStore.timeline() — dated-node selection, thread derivation (>=2
//       in-range members, date-ordered), range/type/tag/person filters;
//   (3) the GET /api/vault/timeline route — sensitive gating (locked dots +
//       thread member drop), density cap, colors;
//   (4) the pure color helpers (gapHueColor/nodeColor/threadColor).
// The in-browser render (dots/arcs/zoom/legend/on-this-day) is exercised in live
// local QA per the phase plan.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fsp = require("fs/promises");
const path = require("path");

const VaultStore = require("./vault-store");
const { facetValues, nodeDate } = require("./vault-store");
const routes = require("./routes/vault");
const { gapHueColor, nodeColor, threadColor } = routes;

// ── Fixture helpers ──
async function makeVault(nodes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb4a-"));
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
const setOf = (map, key) => Array.from(map.get(key) || []).sort();

function mountRoutes(store) {
  const routeMap = {};
  const app = { get: (p, ...h) => { routeMap["GET " + p] = h[h.length - 1]; }, post: () => {}, put: () => {}, delete: () => {} };
  const ctx = { VAULT_REPO_URL: null, syncMgr: null, vault: store };
  routes(app, ctx);
  return routeMap;
}
function callTimeline(routeMap, { query = {}, unlocked = false } = {}) {
  const req = { query, headers: {}, session: unlocked ? { vaultUnlockedUntil: Date.now() + 60000 } : {} };
  let body = null, code = 200;
  const res = { status: (c) => { code = c; return res; }, json: (o) => { body = o; return res; } };
  routeMap["GET /api/vault/timeline"](req, res);
  return { code, body };
}

// ── facetValues / nodeDate (pure) ──
test("facetValues: scalar/array, wikilink collapse, de-dupe, non-strings dropped", () => {
  assert.deepStrictEqual(facetValues("family").sort(), ["family"]);
  assert.deepStrictEqual(facetValues(["a", "b", "a"]).sort(), ["a", "b"]);
  assert.deepStrictEqual(facetValues("[[people/collins]]"), ["people/collins"]);
  assert.deepStrictEqual(facetValues(["[[people/collins]]", "people/collins"]), ["people/collins"], "wikilink == bare");
  assert.deepStrictEqual(facetValues("[[trips/nashville-2026|Nashville]]"), ["trips/nashville-2026"], "alias stripped");
  assert.deepStrictEqual(facetValues([null, 3, "", "x"]), ["x"]);
  assert.deepStrictEqual(facetValues(null), []);
});

test("nodeDate: date>created>scheduled_at, Date objects, bad input -> null", () => {
  assert.strictEqual(nodeDate({ date: "2026-03-04" }), "2026-03-04");
  assert.strictEqual(nodeDate({ created: "2026-03-04T10:00:00Z" }), "2026-03-04");
  assert.strictEqual(nodeDate({ scheduled_at: "2026-03-04" }), "2026-03-04");
  assert.strictEqual(nodeDate({ date: "2026-01-01", created: "2020-01-01" }), "2026-01-01", "date wins");
  assert.strictEqual(nodeDate({ date: new Date(Date.UTC(2026, 2, 4)) }), "2026-03-04", "js-yaml Date");
  assert.strictEqual(nodeDate({}), null);
  assert.strictEqual(nodeDate({ date: "not-a-date" }), null);
});

// ── Inverted indexes maintained at build/write/edit/delete ──
test("inverted indexes: built from disk, wikilinks normalized", async () => {
  const { dir, store } = await makeVault([
    ["journal/2026/2026-01-05.md", { type: "journal", title: "A", date: "2026-01-05", tags: ["family", "running"], people: ["[[people/collins]]"] }],
    ["journal/2026/2026-03-12.md", { type: "journal", title: "B", date: "2026-03-12", tags: ["family"], people: ["people/collins"] }],
    ["notes/idea.md", { type: "idea", title: "C", date: "2026-02-01", tags: ["coding"], event: "launch" }],
  ]);
  try {
    assert.deepStrictEqual(setOf(store.tagIndex, "family"), ["journal/2026/2026-01-05", "journal/2026/2026-03-12"]);
    assert.deepStrictEqual(setOf(store.tagIndex, "running"), ["journal/2026/2026-01-05"]);
    assert.deepStrictEqual(setOf(store.personIndex, "people/collins"), ["journal/2026/2026-01-05", "journal/2026/2026-03-12"], "[[..]] and bare grouped");
    assert.deepStrictEqual(setOf(store.eventIndex, "launch"), ["notes/idea"]);
  } finally { await cleanup(dir, store); }
});

test("inverted indexes: write adds, edit reshuffles, delete removes", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", date: "2026-01-01", tags: ["x"] }],
  ]);
  try {
    // write a new node
    await store.write("notes/b", { frontmatter: { type: "note", title: "B", date: "2026-01-02", tags: ["x", "y"] }, body: "" });
    assert.deepStrictEqual(setOf(store.tagIndex, "x"), ["notes/a", "notes/b"]);
    assert.deepStrictEqual(setOf(store.tagIndex, "y"), ["notes/b"]);

    // edit b: drop x, add z, add a person
    await store.write("notes/b", { frontmatter: { type: "note", title: "B", date: "2026-01-02", tags: ["y", "z"], people: ["[[people/mike]]"] }, body: "" });
    assert.deepStrictEqual(setOf(store.tagIndex, "x"), ["notes/a"], "x dropped from b");
    assert.deepStrictEqual(setOf(store.tagIndex, "z"), ["notes/b"], "z added");
    assert.deepStrictEqual(setOf(store.personIndex, "people/mike"), ["notes/b"]);

    // delete a: x posting empties -> the key is removed entirely
    await store.delete("notes/a");
    assert.strictEqual(store.tagIndex.has("x"), false, "empty posting pruned");
    assert.deepStrictEqual(setOf(store.tagIndex, "y"), ["notes/b"]);
  } finally { await cleanup(dir, store); }
});

// ── timeline(): selection + thread derivation ──
test("timeline: one tag across months = one thread through its dots (date-ordered)", async () => {
  const { dir, store } = await makeVault([
    ["journal/2026/2026-01-05.md", { type: "journal", title: "Jan", date: "2026-01-05", tags: ["family"] }],
    ["journal/2026/2026-03-12.md", { type: "journal", title: "Mar", date: "2026-03-12", tags: ["family"] }],
    ["journal/2026/2026-02-10.md", { type: "journal", title: "Feb", date: "2026-02-10", tags: ["family"] }],
    ["notes/lonely.md", { type: "note", title: "Lonely", date: "2026-02-01", tags: ["solo"] }],
    ["notes/nodate.md", { type: "note", title: "NoDate", tags: ["family"] }],
  ]);
  try {
    const { nodes, threads } = store.timeline({});
    assert.strictEqual(nodes.length, 4, "the undated node is excluded");
    const fam = threads.filter((t) => t.key === "tag:family");
    assert.strictEqual(fam.length, 1, "exactly one family thread");
    assert.deepStrictEqual(fam[0].members, ["journal/2026/2026-01-05", "journal/2026/2026-02-10", "journal/2026/2026-03-12"], "members in date order; undated excluded");
    assert.strictEqual(threads.some((t) => t.key === "tag:solo"), false, "a singleton tag is not a thread");
  } finally { await cleanup(dir, store); }
});

test("timeline: from/to range + type/tag/person filters", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", date: "2026-01-10", tags: ["t1"], people: ["p/x"] }],
    ["notes/b.md", { type: "note", title: "B", date: "2026-06-10", tags: ["t1"], people: ["p/x"] }],
    ["notes/c.md", { type: "idea", title: "C", date: "2026-06-20", tags: ["t1"] }],
  ]);
  try {
    assert.strictEqual(store.timeline({ from: "2026-05-01" }).nodes.length, 2, "from filter");
    assert.strictEqual(store.timeline({ to: "2026-02-01" }).nodes.length, 1, "to filter");
    assert.deepStrictEqual(store.timeline({ types: ["idea"] }).nodes.map((n) => n.slug), ["notes/c"], "type filter");
    // person filter narrows to p/x nodes; the t1 thread among them still forms.
    const byPerson = store.timeline({ people: ["p/x"] });
    assert.deepStrictEqual(byPerson.nodes.map((n) => n.slug).sort(), ["notes/a", "notes/b"]);
    assert.ok(byPerson.threads.some((t) => t.key === "tag:t1" && t.members.length === 2));
  } finally { await cleanup(dir, store); }
});

test("timeline: threads ranked most-connected first", async () => {
  const { dir, store } = await makeVault([
    ["n/a.md", { type: "note", title: "A", date: "2026-01-01", tags: ["big", "small"] }],
    ["n/b.md", { type: "note", title: "B", date: "2026-01-02", tags: ["big", "small"] }],
    ["n/c.md", { type: "note", title: "C", date: "2026-01-03", tags: ["big"] }],
  ]);
  try {
    const { threads } = store.timeline({});
    assert.strictEqual(threads[0].key, "tag:big", "3-member thread ranks first");
    assert.strictEqual(threads[0].members.length, 3);
  } finally { await cleanup(dir, store); }
});

// ── Endpoint: sensitive gating ──
test("timeline route: locked session gets sensitive nodes as date-only locked dots, out of threads", async () => {
  const { dir, store } = await makeVault([
    ["journal/2026/2026-01-05.md", { type: "journal", title: "Pub1", date: "2026-01-05", tags: ["family"] }],
    ["journal/2026/2026-03-12.md", { type: "journal", title: "Pub2", date: "2026-03-12", tags: ["family"] }],
    ["health/therapy/s1.md", { type: "therapy", title: "SECRET", date: "2026-02-20", tags: ["family"] }],
  ]);
  try {
    const routeMap = mountRoutes(store);

    const locked = callTimeline(routeMap, { unlocked: false }).body;
    assert.strictEqual(locked.counts.locked, 1);
    const lockedNode = locked.nodes.find((n) => n.sensitive);
    assert.ok(lockedNode, "a locked dot is present");
    assert.strictEqual(lockedNode.slug, undefined, "no slug leaks");
    assert.strictEqual(lockedNode.title, undefined, "no title leaks");
    assert.strictEqual(lockedNode.date, "2026-02-20", "date-only dot");
    const famLocked = locked.threads.find((t) => t.key === "tag:family");
    assert.strictEqual(famLocked.members.length, 2, "therapy dropped from the thread");
    assert.ok(!famLocked.members.some((s) => s.startsWith("health/")), "no sensitive slug in thread members");

    const open = callTimeline(routeMap, { unlocked: true }).body;
    assert.strictEqual(open.counts.locked, 0);
    const famOpen = open.threads.find((t) => t.key === "tag:family");
    assert.strictEqual(famOpen.members.length, 3, "therapy included when unlocked");
    assert.ok(open.nodes.some((n) => n.slug === "health/therapy/s1" && n.title === "SECRET"));
  } finally { await cleanup(dir, store); }
});

test("timeline route: a thread that drops below 2 members when locked disappears", async () => {
  const { dir, store } = await makeVault([
    ["notes/pub.md", { type: "note", title: "Pub", date: "2026-01-01", tags: ["secretpair"] }],
    ["health/therapy/s.md", { type: "therapy", title: "S", date: "2026-02-01", tags: ["secretpair"] }],
  ]);
  try {
    const routeMap = mountRoutes(store);
    const locked = callTimeline(routeMap, { unlocked: false }).body;
    assert.strictEqual(locked.threads.some((t) => t.key === "tag:secretpair"), false, "1 public + 1 sensitive -> no thread while locked");
    const open = callTimeline(routeMap, { unlocked: true }).body;
    assert.ok(open.threads.some((t) => t.key === "tag:secretpair"), "thread returns when unlocked");
  } finally { await cleanup(dir, store); }
});

// ── Endpoint: density cap ──
test("timeline route: density cap limits threads shown, reports the total", async () => {
  const nodes = [];
  for (let i = 0; i < 45; i++) {
    const tag = `t${String(i).padStart(2, "0")}`;
    nodes.push([`n/a${i}.md`, { type: "note", title: `A${i}`, date: `2026-01-${String((i % 27) + 1).padStart(2, "0")}`, tags: [tag] }]);
    nodes.push([`n/b${i}.md`, { type: "note", title: `B${i}`, date: `2026-02-${String((i % 27) + 1).padStart(2, "0")}`, tags: [tag] }]);
  }
  const { dir, store } = await makeVault(nodes);
  try {
    const routeMap = mountRoutes(store);
    const def = callTimeline(routeMap, {}).body;
    assert.strictEqual(def.counts.threads, 45, "45 total threads");
    assert.strictEqual(def.counts.threadsShown, 40, "capped at 40 by default");
    assert.strictEqual(def.threads.length, 40);
    const raised = callTimeline(routeMap, { query: { cap: "100" } }).body;
    assert.strictEqual(raised.threads.length, 45, "cap param raises the ceiling");
  } finally { await cleanup(dir, store); }
});

// ── Pure color helpers ──
test("gapHueColor: deterministic, hue drawn from the gap set, varies by input", () => {
  const GAP = [20, 60, 110, 170, 225, 282, 320, 352];
  const c = gapHueColor("person:people/collins");
  assert.strictEqual(c, gapHueColor("person:people/collins"), "stable");
  const hue = Number(/hsl\((\d+)/.exec(c)[1]);
  assert.ok(GAP.includes(hue), "hue sits in a category gap");
  const hues = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((s) => gapHueColor(s)));
  assert.ok(hues.size >= 4, "hashes spread across gap hues");
});

test("nodeColor/threadColor: degrade to unmapped without a parser; person/event hash", () => {
  assert.strictEqual(nodeColor(["family"], null, null, "#gray"), "#gray", "no parser -> unmapped");
  assert.strictEqual(nodeColor([], {}, { colorForTags: () => ({ hex: "#f00" }) }, "#gray"), "#gray", "tagless -> unmapped");
  assert.strictEqual(nodeColor(["family"], {}, { colorForTags: () => ({ hex: "#abc" }) }, "#gray"), "#abc");
  assert.strictEqual(threadColor("tag", "family", null, null, "#gray"), "#gray", "tag thread uses ontology (here degraded)");
  assert.match(threadColor("person", "people/x", null, null, "#gray"), /^hsl\(/, "person thread hashes a gap hue");
  assert.match(threadColor("event", "launch", null, null, "#gray"), /^hsl\(/);
});

// ── Watcher-driven facet maintenance + git-crypt re-lock cleanup ──
test("inverted indexes: watcher add, git-crypt re-lock prunes postings, unlink drops key", async () => {
  const { dir, store } = await makeVault([]);
  try {
    if (store.watcher) await store.watcher.close(); // drive events by hand, no chokidar timing
    const abs = await writeNode(dir, "notes/w.md", { type: "note", title: "W", date: "2026-01-01", tags: ["wtag"], people: ["[[people/z]]"] });
    await store._onWatcherEvent("add", abs);
    assert.ok(store.nodes.has("notes/w"), "watcher add indexed the node");
    assert.deepStrictEqual(setOf(store.tagIndex, "wtag"), ["notes/w"]);
    assert.deepStrictEqual(setOf(store.personIndex, "people/z"), ["notes/w"]);

    // Re-lock: overwrite with git-crypt ciphertext. The change event's _ingest hits
    // the GITCRYPT_MAGIC branch (deletes the node); the wrapping facet snapshot must
    // then prune it from the facet maps — the highest-risk untested branch.
    await fsp.writeFile(abs, String.fromCharCode(0) + "GITCRYPT" + String.fromCharCode(0) + "x".repeat(40)); // git-crypt magic header
    await store._onWatcherEvent("change", abs);
    assert.strictEqual(store.nodes.has("notes/w"), false, "re-locked node removed from index");
    assert.strictEqual(store.tagIndex.has("wtag"), false, "tag posting pruned on re-lock");
    assert.strictEqual(store.personIndex.has("people/z"), false, "person posting pruned on re-lock");

    // A plaintext note added then unlinked drops its sole-carried tag key entirely.
    const abs2 = await writeNode(dir, "notes/u.md", { type: "note", title: "U", date: "2026-02-01", tags: ["utag"] });
    await store._onWatcherEvent("add", abs2);
    assert.deepStrictEqual(setOf(store.tagIndex, "utag"), ["notes/u"]);
    await store._onWatcherEvent("unlink", abs2);
    assert.strictEqual(store.tagIndex.has("utag"), false, "empty posting pruned on watcher unlink");
  } finally { await cleanup(dir, store); }
});

// ── timeline(): person AND event threads (not just tag) form + color correctly ──
test("timeline: event and person threads form, date-ordered, with the right label/color", async () => {
  const { dir, store } = await makeVault([
    ["notes/e1.md", { type: "note", title: "E1", date: "2026-01-01", event: "launch" }],
    ["notes/e2.md", { type: "note", title: "E2", date: "2026-02-01", event: "[[launch]]" }],
    ["notes/p1.md", { type: "note", title: "P1", date: "2026-01-10", people: ["[[people/collins]]"] }],
    ["notes/p2.md", { type: "note", title: "P2", date: "2026-03-10", people: ["people/collins"] }],
  ]);
  try {
    const { threads } = store.timeline({});
    const ev = threads.find((t) => t.key === "event:launch");
    assert.ok(ev && ev.kind === "event", "event thread formed");
    assert.deepStrictEqual(ev.members, ["notes/e1", "notes/e2"], "event members date-ordered ([[launch]]==launch)");
    const pe = threads.find((t) => t.key === "person:people/collins");
    assert.ok(pe && pe.kind === "person", "person thread formed");
    assert.deepStrictEqual(pe.members, ["notes/p1", "notes/p2"]);

    // Route: person label is the last path segment; person/event arcs use gap hues.
    const body = callTimeline(mountRoutes(store), { unlocked: true }).body;
    const pt = body.threads.find((t) => t.key === "person:people/collins");
    assert.strictEqual(pt.label, "collins", "person thread label is the last path segment");
    assert.match(pt.color, /^hsl\(/, "person thread color is a hashed gap hue");
    assert.match(body.threads.find((t) => t.key === "event:launch").color, /^hsl\(/);
  } finally { await cleanup(dir, store); }
});
