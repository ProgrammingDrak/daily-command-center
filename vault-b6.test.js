"use strict";

// Phase B6: resurfacing engine + inbox review + weekly digest. Coverage for
//   (1) VaultStore.resurface — deterministic per dayKey, excludes fleeting/inbox/
//       reviews, sensitive gated, favors orphans/age/on-this-day, reasons attached;
//   (2) VaultStore.threadNeighbors — co-facet neighbors, self + sensitive gated;
//   (3) VaultStore.inbox — oldest-first + excerpt;
//   (4) isoWeek + renderDigestMarkdown pure helpers;
//   (5) routes — /resurface (shape + sensitive gate), /inbox (order + escape),
//       POST /digest (saves notes/reviews/<week>.md, sensitive content excluded,
//       idempotent), GET /digest (live + saved flag).
// The in-browser Review panel (promote/merge/archive) is exercised in live QA.

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const VaultStore = require("./vault-store");
const routeMod = require("./routes/vault");
const { isoWeek, renderDigestMarkdown } = routeMod;

// ── Fixtures (same harness shape as vault-b5.test.js) ──
async function writeNode(dir, rel, fm, body = "") {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const y = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
  await fsp.writeFile(abs, `---\n${y}\n---\n${body}`);
  return abs;
}
async function makeVault(nodes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb6-"));
  for (const [rel, fm, body = ""] of nodes) await writeNode(dir, rel, fm, body);
  const store = new VaultStore({ vaultDir: dir, indexFile: null });
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
  const ctx = { VAULT_REPO_URL: null, VAULT_SENSITIVE_PIN: "1234", syncMgr: sync || { notifyChange() {} }, vault: store };
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

// ── isoWeek ──
test("isoWeek: ISO-8601 week labels + prior-year rollover", () => {
  assert.strictEqual(isoWeek("2026-01-01"), "2026-W01");   // Thu of W1
  assert.strictEqual(isoWeek("2026-07-24"), "2026-W30");
  assert.strictEqual(isoWeek("2027-01-04"), "2027-W01");   // Monday of W1
  // Early-January dates that belong to the PRIOR ISO year (the Thursday-shift
  // year logic) — a wrong label here would misfile/overwrite the wrong review.
  assert.strictEqual(isoWeek("2022-01-01"), "2021-W52");
  assert.strictEqual(isoWeek("2021-01-01"), "2020-W53");   // 53-week year
  assert.strictEqual(isoWeek("garbage"), "unknown");
});

// ── resurface: determinism, exclusions, gating ──
test("resurface: deterministic per dayKey; excludes fleeting/inbox/reviews", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "alpha"],
    ["notes/b.md", { type: "note", title: "B" }, "beta"],
    ["ideas/c.md", { type: "idea", title: "C" }, "gamma"],
    ["inbox/scratch.md", { type: "fleeting", created: "2026-07-01" }, "ignore"],
    ["notes/reviews/2026-W29.md", { type: "note", title: "Weekly review 2026-W29" }, "last week"],
  ]);
  const r1 = store.resurface({ n: 5, dayKey: "2026-07-24" });
  const r2 = store.resurface({ n: 5, dayKey: "2026-07-24" });
  assert.deepStrictEqual(r1.picks.map((p) => p.slug), r2.picks.map((p) => p.slug), "same dayKey → identical order");
  const slugs = r1.picks.map((p) => p.slug);
  assert.ok(!slugs.includes("inbox/scratch"), "fleeting/inbox excluded");
  assert.ok(!slugs.includes("notes/reviews/2026-W29"), "prior digests excluded");
  assert.strictEqual(r1.pool, 3, "pool = the 3 real notes");
  await cleanup(dir, store);
});

test("resurface: sensitive notes only when includeSensitive", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "x"],
    ["health/therapy/s.md", { type: "therapy", title: "S" }, "secret"],
  ]);
  const locked = store.resurface({ n: 10, dayKey: "2026-07-24", includeSensitive: false });
  assert.ok(!locked.picks.some((p) => p.slug === "health/therapy/s"), "sensitive hidden while locked");
  const unlocked = store.resurface({ n: 10, dayKey: "2026-07-24", includeSensitive: true });
  assert.ok(unlocked.picks.some((p) => p.slug === "health/therapy/s"), "sensitive surfaces when unlocked");
  await cleanup(dir, store);
});

test("resurface: reasons attach for orphan + on-this-day + age + unlinked", async () => {
  const { dir, store } = await makeVault([
    ["journal/2019/old.md", { type: "journal", title: "Old", date: "2019-07-24" }, "years ago"],
    // A nameable target named-without-a-link in another note -> unlinked reason.
    ["people/zephyrine.md", { type: "person", title: "Zephyrine" }, "a friend"],
    ["notes/mention.md", { type: "note", title: "Mention" }, "had lunch with Zephyrine today"],
    // A stale note (mtime far in the past) -> age reason.
    ["notes/dusty.md", { type: "note", title: "Dusty" }, "[[notes/mention]] keeps this non-orphan"],
  ]);
  const now = Date.parse("2026-07-24T00:00:00Z");
  store.nodes.get("notes/dusty").mtime = now - 60 * 86400000; // 60d old (> ageStaleDays 45)
  // n=pool so every candidate is returned; then inspect reasons.
  const r = store.resurface({ n: 99, dayKey: "2026-07-24", now });
  const byslug = Object.fromEntries(r.picks.map((p) => [p.slug, p]));
  const old = byslug["journal/2019/old"];
  assert.ok(old.reasons.some((x) => x.kind === "onthisday" && x.year === "2019"), "on-this-day reason");
  assert.ok(old.reasons.some((x) => x.kind === "orphan"), "old journal is also an orphan");
  assert.ok(byslug["notes/dusty"].reasons.some((x) => x.kind === "age" && x.days >= 45), "age reason for a stale note");
  assert.ok(byslug["people/zephyrine"].reasons.some((x) => x.kind === "unlinked"), "unlinked-mention reason (bounded shortlist scan)");
  await cleanup(dir, store);
});

test("resurface: strong signals win the draw (orphan + ancient) across seeds", async () => {
  const { dir, store } = await makeVault([
    ["notes/ancient.md", { type: "note", title: "Ancient orphan" }, "forgotten"],
    ["notes/x.md", { type: "note", title: "X" }, "[[notes/y]]"],
    ["notes/y.md", { type: "note", title: "Y" }, "[[notes/x]]"],  // x,y link each other (not orphans)
    ["notes/z.md", { type: "note", title: "Z" }, "[[notes/x]]"],
  ]);
  // Force the orphan very old; the linked cluster stays "now".
  store.nodes.get("notes/ancient").mtime = 0;                       // 1970
  const now = Date.parse("2026-07-24T00:00:00Z");
  let wins = 0;
  const days = ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28",
                "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"];
  for (const d of days) {
    const top = store.resurface({ n: 1, dayKey: d, now }).picks[0];
    if (top && top.slug === "notes/ancient") wins++;
  }
  assert.ok(wins >= 6, `ancient orphan wins the n=1 draw in a strong majority (got ${wins}/10)`);
  await cleanup(dir, store);
});

// ── threadNeighbors ──
test("threadNeighbors: co-facet neighbors, self + sensitive gated", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A", tags: ["dnd"] }, "x"],
    ["notes/b.md", { type: "note", title: "B", tags: ["dnd"] }, "y"],
    ["people/c.md", { type: "person", title: "C", tags: ["work"] }, "z"],
    ["health/therapy/s.md", { type: "therapy", title: "S", tags: ["dnd"] }, "secret"],
  ]);
  const nb = store.threadNeighbors("notes/a", { includeSensitive: false });
  const slugs = nb.map((n) => n.slug);
  assert.ok(slugs.includes("notes/b"), "shares the dnd tag");
  assert.ok(!slugs.includes("notes/a"), "self excluded");
  assert.ok(!slugs.includes("health/therapy/s"), "sensitive neighbor hidden while locked");
  assert.ok(!slugs.includes("people/c"), "different tag, not a neighbor");
  assert.strictEqual(nb.find((n) => n.slug === "notes/b").via.value, "dnd");
  const withSens = store.threadNeighbors("notes/a", { includeSensitive: true });
  assert.ok(withSens.some((n) => n.slug === "health/therapy/s"), "sensitive neighbor shows when unlocked");
  await cleanup(dir, store);
});

// ── orphans: review notes must not de-orphan ──
test("orphans: a note linked ONLY by a weekly review note is still an orphan", async () => {
  const { dir, store } = await makeVault([
    ["notes/lonely.md", { type: "note", title: "Lonely" }, "no real links"],
    ["notes/reviews/2026-W30.md", { type: "note", title: "Weekly review 2026-W30" }, "resurfaced [[notes/lonely]]"],
  ]);
  // The saved review auto-links every orphan it lists; that backlink must NOT
  // count, or the orphan set silently shrinks with zero real curation.
  assert.ok(store.orphans().some((o) => o.slug === "notes/lonely"), "review-sourced backlink ignored for orphan status");
  // A backlink from a NON-review note does de-orphan (sanity: the filter is scoped).
  await store.write("notes/hub", { frontmatter: { type: "note", title: "Hub" }, body: "[[notes/lonely]]" });
  assert.ok(!store.orphans().some((o) => o.slug === "notes/lonely"), "a real note's backlink still de-orphans");
  await cleanup(dir, store);
});

// ── inbox ──
test("inbox: oldest-first with excerpt", async () => {
  const { dir, store } = await makeVault([
    ["inbox/new.md", { type: "fleeting", created: "2026-07-20T10:00:00Z" }, "newer thought"],
    ["inbox/old.md", { type: "fleeting", created: "2026-07-01T10:00:00Z" }, "older thought that has been rotting"],
    ["notes/keep.md", { type: "note", title: "Keep" }, "not inbox"],
  ]);
  const inbox = store.inbox();
  assert.deepStrictEqual(inbox.map((i) => i.slug), ["inbox/old", "inbox/new"], "oldest first");
  assert.match(inbox[0].excerpt, /older thought/);
  assert.ok(!inbox.some((i) => i.slug === "notes/keep"), "non-inbox excluded");
  await cleanup(dir, store);
});

test("inbox: sorts by epoch across MIXED created formats + mtime fallback", async () => {
  // The whole reason inbox() parses created to epoch (not a lexical compare):
  // `created` arrives ISO from capture but Date.toString() from some tool writes.
  // "Wed Jul 01…" sorts AFTER "2026-07-20…" lexically ('W' > '2') but is OLDER —
  // a string compare would mis-order it. A lexical revert must fail this test.
  const { dir, store } = await makeVault([
    ["inbox/iso.md", { type: "fleeting", created: "2026-07-20T10:00:00Z" }, "iso newer"],
    ["inbox/legacy.md", { type: "fleeting", created: "Wed Jul 01 2026 10:00:00 GMT+0000" }, "legacy older"],
    ["inbox/weird.md", { type: "fleeting", created: "soon" }, "unparseable created -> mtime fallback"],
  ]);
  const order = store.inbox().map((i) => i.slug);
  // legacy (Jul 1) < iso (Jul 20) < weird (created unparseable -> mtime ~now, newest).
  assert.deepStrictEqual(order.slice(0, 2), ["inbox/legacy", "inbox/iso"], "non-ISO older sorts before ISO newer");
  assert.ok(order.includes("inbox/weird"), "unparseable-created note still listed (mtime fallback, no throw)");
  await cleanup(dir, store);
});

// ── renderDigestMarkdown (pure) ──
test("renderDigestMarkdown: sections + wikilinks + empty states", () => {
  const md = renderDigestMarkdown({
    week: "2026-W30", generatedAt: "2026-07-24T12:00:00Z",
    resurfaced: [{ slug: "notes/a", title: "A", reasons: [{ note: "412d untouched" }], excerpt: "hi", neighbors: [{ slug: "notes/b", title: "B" }] }],
    orphans: { count: 2, top: [{ slug: "notes/o", title: "O" }] },
    unlinked: [{ target: { slug: "people/c", title: "C" }, source: { slug: "notes/s", title: "S" }, term: "C", snippet: "saw C" }],
    inboxBacklog: 3,
  });
  assert.match(md, /# Weekly review — 2026-W30/);
  assert.match(md, /\[\[notes\/a\|A\]\]/, "resurfaced wikilink");
  assert.match(md, /412d untouched/);
  assert.match(md, /connects to \[\[notes\/b\|B\]\]/, "neighbor link");
  assert.match(md, /## Orphans \(2\)/);
  assert.match(md, /\[\[people\/c\|C\]\]\*\* mentioned in \[\[notes\/s\|S\]\]/);
  assert.match(md, /3 fleeting notes/);

  const empty = renderDigestMarkdown({ week: "2026-W31", generatedAt: "2026-08-01", resurfaced: [], orphans: { count: 0, top: [] }, unlinked: [], inboxBacklog: 0 });
  assert.match(empty, /every note is connected/);
  assert.match(empty, /Inbox zero/);
});

// ── routes ──
test("GET /api/vault/resurface: shape + sensitive gate + escaped excerpt", async () => {
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "Alpha" }, "hello <b>world</b>"],
    ["health/therapy/s.md", { type: "therapy", title: "Secret" }, "hush"],
  ]);
  const rm = mountRoutes(store);
  const locked = await call(rm["GET /api/vault/resurface"], { query: { n: "10" } });
  assert.ok(!locked.body.picks.some((p) => p.slug === "health/therapy/s"), "sensitive hidden while locked");
  const a = locked.body.picks.find((p) => p.slug === "notes/a");
  assert.match(a.excerpt, /&lt;b&gt;/, "excerpt HTML-escaped");
  const unlocked = await call(rm["GET /api/vault/resurface"], { query: { n: "10" }, unlocked: true });
  assert.ok(unlocked.body.picks.some((p) => p.slug === "health/therapy/s"), "sensitive surfaces when unlocked");
  await cleanup(dir, store);
});

test("GET /api/vault/inbox: oldest-first + escaped excerpt", async () => {
  const { dir, store } = await makeVault([
    ["inbox/a.md", { type: "fleeting", created: "2026-07-05T00:00:00Z" }, "second <i>x</i>"],
    ["inbox/b.md", { type: "fleeting", created: "2026-07-01T00:00:00Z" }, "first"],
  ]);
  const rm = mountRoutes(store);
  const r = await call(rm["GET /api/vault/inbox"]);
  assert.strictEqual(r.body.count, 2);
  assert.deepStrictEqual(r.body.items.map((i) => i.slug), ["inbox/b", "inbox/a"]);
  const a = r.body.items.find((i) => i.slug === "inbox/a");
  assert.match(a.excerpt, /&lt;i&gt;/, "excerpt escaped");
  await cleanup(dir, store);
});

test("POST /api/vault/digest: saves notes/reviews/<week>.md, sensitive content excluded, idempotent", async () => {
  const notified = [];
  const { dir, store } = await makeVault([
    ["notes/a.md", { type: "note", title: "A" }, "public note"],
    ["ideas/orphan.md", { type: "idea", title: "Public orphan" }, "lonely public"],
    ["health/therapy/sec.md", { type: "therapy", title: "Sensitive orphan" }, "must not leak"],
  ]);
  const rm = mountRoutes(store, { notifyChange: (c) => notified.push(c) });
  // Even an UNLOCKED session must never persist sensitive content into the digest.
  const first = await call(rm["POST /api/vault/digest"], { unlocked: true });
  assert.strictEqual(first.code, 201);
  const week = first.body.week;
  const slug = `notes/reviews/${week}`;
  assert.strictEqual(first.body.slug, slug);
  assert.ok(fs.existsSync(path.join(dir, slug + ".md")), "review node written to disk");
  assert.ok(store.has(slug), "review node indexed");
  assert.ok(notified.some((n) => n.slug === slug), "sync notified");
  // Sensitive orphan must not appear anywhere in the digest.
  const blob = JSON.stringify(first.body);
  assert.ok(!blob.includes("health/therapy/sec"), "sensitive slug absent from digest");
  assert.ok(!first.body.orphans.top.some((o) => o.slug === "health/therapy/sec"), "sensitive orphan not surfaced");
  assert.match(first.body.markdown, /# Weekly review/);
  // Idempotent: regenerating the same week overwrites, no -2 variant.
  const second = await call(rm["POST /api/vault/digest"], { unlocked: true });
  assert.strictEqual(second.body.slug, slug, "same slug on re-POST");
  assert.ok(!store.has(slug + "-2"), "no duplicate variant created");
  await cleanup(dir, store);
});

test("GET /api/vault/digest: unlinked snippet HTML-escaped at the boundary (markdown stays raw)", async () => {
  const { dir, store } = await makeVault([
    ["people/target.md", { type: "person", title: "Targetname" }, "a person"],
    ["notes/src.md", { type: "note", title: "Src" }, "met Targetname <img src=x onerror=alert(1)> today"],
  ]);
  const rm = mountRoutes(store);
  const g = await call(rm["GET /api/vault/digest"]);
  const sug = (g.body.unlinked || []).find((s) => s.target.slug === "people/target");
  assert.ok(sug, "unlinked suggestion present");
  assert.ok(!/<img/.test(sug.snippet), "raw <img> not injected via the snippet");
  assert.match(sug.snippet, /&lt;img/, "snippet is HTML-escaped in the JSON response");
  // The saved markdown keeps the RAW text — a .md is not HTML, and DOMPurify
  // guards it when the review note is later rendered in the reading pane.
  assert.match(g.body.markdown, /<img src=x/, "markdown carries the unescaped source text");
  await cleanup(dir, store);
});

test("GET /api/vault/digest: live compute + saved flag reflects POST", async () => {
  const { dir, store } = await makeVault([["notes/a.md", { type: "note", title: "A" }, "x"]]);
  const rm = mountRoutes(store);
  const before = await call(rm["GET /api/vault/digest"]);
  assert.strictEqual(before.body.saved, false, "not saved yet");
  assert.ok(before.body.markdown.includes("# Weekly review"));
  assert.ok(Array.isArray(before.body.resurfaced));
  await call(rm["POST /api/vault/digest"], {});
  const after = await call(rm["GET /api/vault/digest"]);
  assert.strictEqual(after.body.saved, true, "saved flag flips after POST");
  await cleanup(dir, store);
});
