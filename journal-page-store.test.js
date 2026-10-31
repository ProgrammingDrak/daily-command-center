// Journal task pages: on-device store semantics (public/js/journal-task/page-store.js).
// The IndexedDB adapter itself is exercised in the browser check; here a
// transactional in-memory backend with failure injection pins the record rules.
// Two Store instances over ONE backend model two tabs sharing one IndexedDB.
const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("./public/js/journal-task/page-store.js");

function memoryBackend() {
  const rows = new Map();
  const backend = {
    rows, failNext: 0,
    async read(key) { return rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null; },
    async list() { return [...rows.values()].map(r => JSON.parse(JSON.stringify(r))); },
    async update(key, fn) {
      const cur = rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null;
      const next = fn(cur);
      // A failed transaction commits NOTHING (IndexedDB abort semantics).
      if (backend.failNext > 0) { backend.failNext--; throw new Error("QuotaExceededError"); }
      if (next) rows.set(key, JSON.parse(JSON.stringify(next)));
      return next || cur;
    },
  };
  return backend;
}
// Each stroke is distinguishable by its first x coordinate (its "name").
const stroke = name => ({ tool: "ballpoint", color: "#111111", size: 2, pts: [name, 2, 0.5, name + 1, 4, 0.5] });
const page = (...names) => ({ v: 1, w: 100, h: 100, strokes: names.map(stroke) });
const pageN = n => page(...Array.from({ length: n }, (_, i) => i + 1));
const names = rec => rec.ink.strokes.map(s => s.pts[0]);
const ACCOUNT = { userId: 1, workspaceId: "ws-1" };
function make(backend = memoryBackend(), account = ACCOUNT, prefix = "m") {
  let id = 0;
  const store = Store.create({ backend, account, makeId: () => prefix + (++id), now: () => "2026-10-31T12:00:00.000Z" });
  return { backend, store };
}
// An editor that is up to date saves against the version it just read.
async function edit(store, journalId, e) {
  const cur = await store.load(journalId);
  const out = await store.saveEdit(journalId, e, cur ? cur.localRev : 0);
  assert.equal(out.stale, false);
  return out.record;
}

test("account namespace: database name is per workspace AND user, and an account is required", () => {
  const a = Store.dbName({ userId: 1, workspaceId: "ws-1" });
  assert.notEqual(a, Store.dbName({ userId: 2, workspaceId: "ws-1" }));
  assert.notEqual(a, Store.dbName({ userId: 1, workspaceId: "ws-2" }));
  assert.equal(a, Store.dbName({ userId: 1, workspaceId: "ws-1" }));
  assert.throws(() => Store.dbName(null), /signed-in account/);
  assert.throws(() => Store.create({ account: { userId: "1", workspaceId: "ws-1" }, indexedDB: {} }), /signed-in account/);
  assert.throws(() => Store.create({ backend: memoryBackend() }), /signed-in account/, "a test backend cannot skip the owner either");
  assert.match(Store.newJournalId(), /^jr_[a-z0-9-]{8,64}$/i);
});

// Regression: the first namespace was a 32-bit FNV hash, and these two synthetic
// sequential accounts both mapped to "dcc-journal-n9bfh4" (found in review).
test("account namespace is injective: the reviewed hash-collision pair gets two databases", () => {
  const a = { userId: 72191, workspaceId: "ws-72191" }, b = { userId: 78715, workspaceId: "ws-78715" };
  assert.notEqual(Store.dbName(a), Store.dbName(b));
  // Separator/encoding ambiguity cannot merge accounts either.
  assert.notEqual(Store.dbName({ userId: 1, workspaceId: "2:ws" }), Store.dbName({ userId: 12, workspaceId: "ws" }));
  assert.notEqual(Store.ownerKey({ userId: 1, workspaceId: "ws:u2" }), Store.ownerKey({ userId: 1, workspaceId: "ws" }) + ":u2");
  // Injective by construction, not by luck: the name decodes back to exactly one
  // account, so no hash (of any width) can quietly come back.
  const decode = name => { const m = /^dcc-journal:v1:u(\d+):([^:]*)$/.exec(name); assert.ok(m, name); return { userId: Number(m[1]), workspaceId: decodeURIComponent(m[2]) }; };
  for (const acct of [a, b, { userId: 1, workspaceId: "2:ws" }, { userId: 0, workspaceId: "ws with spaces/%" }, { userId: 12, workspaceId: "ws" }]) {
    assert.deepEqual(decode(Store.dbName(acct)), acct);
  }
});

test("records are stamped with their owner; another account's record is never read, listed or overwritten", async () => {
  const shared = memoryBackend();   // simulates a database that somehow holds both
  const mine = make(shared, { userId: 72191, workspaceId: "ws-72191" }).store;
  const theirs = make(shared, { userId: 78715, workspaceId: "ws-78715" }).store;
  const saved = await edit(mine, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(1), body: "private" });
  assert.equal(saved.owner, Store.ownerKey({ userId: 72191, workspaceId: "ws-72191" }));
  await assert.rejects(theirs.load("jr_aaaaaaaa"), { code: "OWNER_MISMATCH" });
  await assert.rejects(theirs.saveEdit("jr_aaaaaaaa", { taskId: "t1", ink: pageN(3) }, 1), { code: "OWNER_MISMATCH" });
  assert.deepEqual(await theirs.listDirty(), []);
  assert.equal((await mine.load("jr_aaaaaaaa")).ink.strokes.length, 1);
});

test("unknown stroke-format versions, oversized pages and unversioned saves fail locally and visibly", async () => {
  const { store } = make();
  await assert.rejects(store.saveEdit("jr_aaaaaaaa", { taskId: "t1", ink: { v: 2, w: 1, h: 1, strokes: [] } }, 0), { code: "INK_VERSION" });
  const huge = pageN(1); huge.strokes[0].pts = Array.from({ length: 450000 }, () => 123.45);
  await assert.rejects(store.saveEdit("jr_aaaaaaaa", { taskId: "t1", ink: huge }, 0), { code: "INK_TOO_LARGE" });
  await assert.rejects(store.saveEdit("jr_aaaaaaaa", { taskId: "t1", ink: pageN(1) }), /content version is required/);
  assert.equal(await store.load("jr_aaaaaaaa"), null, "nothing half-written");
});

test("an edit writes content, dirty, a new content version and a fresh mutation id in one transaction", async () => {
  const { store } = make();
  const r1 = await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(1), body: "hi" });
  assert.equal(r1.dirty, true); assert.equal(r1.mutationId, "m1"); assert.equal(r1.localRev, 1); assert.equal(r1.baseRevision, 0);
  const r2 = await edit(store, "jr_aaaaaaaa", { ink: pageN(2) });
  assert.equal(r2.mutationId, "m2"); assert.equal(r2.localRev, 2); assert.equal(r2.taskId, "t1"); assert.equal(r2.body, "hi");
});

test("a failed local transaction rejects and leaves the previous durable copy intact", async () => {
  const { store, backend } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(1) });
  backend.failNext = 1;
  await assert.rejects(store.saveEdit("jr_aaaaaaaa", { ink: pageN(5) }, 1), /QuotaExceeded/);
  const kept = await store.load("jr_aaaaaaaa");
  assert.equal(kept.ink.strokes.length, 1); assert.equal(kept.mutationId, "m1"); assert.equal(kept.localRev, 1);
});

test("acknowledging only clears dirty when the accepted content is still the latest, and never changes the content version", async () => {
  const { store } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(1) });           // m1
  await edit(store, "jr_aaaaaaaa", { ink: pageN(2) });                          // m2, drawn while m1 in flight
  const after = await store.acknowledge("jr_aaaaaaaa", "m1", 1);
  assert.equal(after.dirty, true, "newer strokes stay queued");
  assert.equal(after.baseRevision, 1, "next send builds on the accepted revision");
  assert.equal(after.localRev, 2, "an ack is not new content; an open editor stays current");
  const clean = await store.acknowledge("jr_aaaaaaaa", "m2", 2);
  assert.equal(clean.dirty, false); assert.equal(clean.baseRevision, 2); assert.equal(clean.mutationId, null);
  assert.equal((await store.acknowledge("jr_aaaaaaaa", "m1", 1)).baseRevision, 2, "late duplicate ack never moves back");
});

test("a server fetch never overwrites unsynced strokes; the same revision changes nothing; a newer one is a new version", async () => {
  const { store } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(3) });
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 9, ink: pageN(1), body: "" });
  assert.equal((await store.load("jr_aaaaaaaa")).ink.strokes.length, 3);
  await store.acknowledge("jr_aaaaaaaa", "m1", 10);
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 9, ink: pageN(1), body: "" });
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 10, ink: pageN(1), body: "" });
  const same = await store.load("jr_aaaaaaaa");
  assert.equal(same.ink.strokes.length, 3, "older or equal server copy ignored");
  assert.equal(same.localRev, 1, "an equal revision does not invalidate an open editor");
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 11, ink: pageN(4), body: "remote" });
  const now = await store.load("jr_aaaaaaaa");
  assert.equal(now.ink.strokes.length, 4); assert.equal(now.baseRevision, 11); assert.equal(now.dirty, false);
  assert.equal(now.localRev, 2, "newer server content is a new content version");
});

// ── Review finding 1: stale whole-page snapshots ───────────────────────────
test("two tabs on one IndexedDB: a stale tab's save becomes a draft and never inherits the newer base", async () => {
  const shared = memoryBackend();
  const tabA = make(shared, ACCOUNT, "a").store, tabB = make(shared, ACCOUNT, "b").store;
  await tabA.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(10), body: "initial" });
  const opened = (await tabA.load("jr_aaaaaaaa")).localRev;        // both tabs display this version
  const a = await tabA.saveEdit("jr_aaaaaaaa", { ink: page(10, 20), body: "initial" }, opened);
  assert.equal(a.stale, false);
  await tabA.acknowledge("jr_aaaaaaaa", a.record.mutationId, 2);   // server accepted A as rev 2
  // Tab B still displays rev 1 and saves its whole page.
  const b = await tabB.saveEdit("jr_aaaaaaaa", { ink: page(10, 30), body: "initial plus B" }, opened, "draft-B");
  assert.equal(b.stale, true, "B's snapshot is older than the stored content");
  const rec = await tabB.load("jr_aaaaaaaa");
  assert.deepEqual(names(rec), [10, 20], "A's stroke is still the content");
  assert.equal(rec.baseRevision, 2); assert.equal(rec.dirty, false, "nothing queued that would overwrite A on the server");
  assert.equal(rec.drafts.length, 1); assert.deepEqual(rec.drafts[0].ink.strokes.map(s => s.pts[0]), [10, 30]);
  assert.equal(rec.drafts[0].body, "initial plus B"); assert.equal(rec.drafts[0].basedOn, opened);
  // B keeps writing while stale: same draft slot, still not the content.
  const b2 = await tabB.saveEdit("jr_aaaaaaaa", { ink: page(10, 30, 31), body: "initial plus B" }, opened, "draft-B");
  assert.equal(b2.stale, true); assert.equal(b2.record.drafts.length, 1); assert.deepEqual(names(b2.record), [10, 20]);
});

test("same tab: a newer server copy seeded while the pen is down turns the in-progress save into a draft", async () => {
  const { store } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(10), body: "" });
  const shown = (await store.load("jr_aaaaaaaa")).localRev;          // editor displays rev 1
  // Background refresh lands rev 2 while a stroke is under the pen (editor not repainted).
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 2, ink: page(10, 40), body: "" });
  const out = await store.saveEdit("jr_aaaaaaaa", { ink: page(10, 50), body: "" }, shown, "draft-pen");
  assert.equal(out.stale, true);
  assert.deepEqual(names(out.record), [10, 40], "remote stroke kept"); assert.equal(out.record.baseRevision, 2);
  assert.deepEqual(out.record.drafts[0].ink.strokes.map(s => s.pts[0]), [10, 50], "the pen stroke kept as a draft");
});

test("same tab: typed text pending when a newer server copy arrives is kept as a draft, not written over it", async () => {
  const { store } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(10), body: "older typed text" });
  const shown = (await store.load("jr_aaaaaaaa")).localRev;
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 2, ink: page(10), body: "remote" });
  const out = await store.saveEdit("jr_aaaaaaaa", { ink: page(10), body: "latest unsaved typed text" }, shown, "draft-typing");
  assert.equal(out.stale, true);
  assert.equal(out.record.body, "remote");
  assert.equal(out.record.drafts[0].body, "latest unsaved typed text");
});

test("resolving a draft: 'mine' replaces content and keeps the other as recovery; 'theirs' keeps content and the draft as recovery", async () => {
  for (const choice of ["mine", "theirs"]) {
    const { store } = make();
    await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 2, ink: page(10, 20), body: "A" });
    await store.saveEdit("jr_aaaaaaaa", { ink: page(10, 30), body: "B" }, 0, "draft-B");
    const cur = await store.load("jr_aaaaaaaa");
    const next = await store.resolveDraft("jr_aaaaaaaa", "draft-B", choice, cur.localRev);
    assert.equal(next.drafts.length, 0);
    if (choice === "mine") {
      assert.deepEqual(names(next), [10, 30]); assert.equal(next.body, "B"); assert.equal(next.dirty, true);
      assert.equal(next.baseRevision, 2, "explicitly replaces rev 2; the server keeps rev 2 in previous");
      assert.deepEqual(next.recoveries[0].ink.strokes.map(s => s.pts[0]), [10, 20]); assert.equal(next.recoveries[0].body, "A");
    } else {
      assert.deepEqual(names(next), [10, 20]); assert.equal(next.dirty, false);
      assert.deepEqual(next.recoveries[0].ink.strokes.map(s => s.pts[0]), [10, 30]); assert.equal(next.recoveries[0].body, "B");
    }
  }
});

test("draft resolution and recovery restore are compare-and-set on the content version", async () => {
  const { store } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 2, ink: page(10, 20), body: "A" });
  await store.saveEdit("jr_aaaaaaaa", { ink: page(10, 30), body: "B" }, 0, "draft-B");
  const seen = (await store.load("jr_aaaaaaaa")).localRev;
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 3, ink: page(10, 20, 21), body: "A2" }); // moved on meanwhile
  await assert.rejects(store.resolveDraft("jr_aaaaaaaa", "draft-B", "mine", seen), { code: "STALE_DRAFT" });
  assert.equal((await store.load("jr_aaaaaaaa")).drafts.length, 1, "draft still there");
  const theirs = await store.resolveDraft("jr_aaaaaaaa", "draft-B", "theirs", (await store.load("jr_aaaaaaaa")).localRev);
  const back = await store.restoreRecovery("jr_aaaaaaaa", theirs.recoveries[0].id, theirs.localRev);
  assert.deepEqual(names(back), [10, 30]); assert.equal(back.body, "B");
  assert.deepEqual(back.recoveries[0].ink.strokes.map(s => s.pts[0]), [10, 20, 21], "restoring is itself reversible");
  await assert.rejects(store.restoreRecovery("jr_aaaaaaaa", back.recoveries[0].id, theirs.localRev), { code: "STALE_DRAFT" });
});

test("a failed save retried after a closed editor uses its own old version: it becomes a draft, not an overwrite", async () => {
  const shared = memoryBackend();
  const tab = make(shared, ACCOUNT, "x").store, other = make(shared, ACCOUNT, "y").store;
  await tab.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(10), body: "" });
  const stash = { content: { ink: page(10, 60), body: "" }, localRev: (await tab.load("jr_aaaaaaaa")).localRev, draftId: "draft-closed" };
  await edit(other, "jr_aaaaaaaa", { ink: page(10, 70), body: "" });      // another tab moved on
  const out = await tab.saveEdit("jr_aaaaaaaa", stash.content, stash.localRev, stash.draftId);
  assert.equal(out.stale, true); assert.deepEqual(names(out.record), [10, 70]);
  assert.deepEqual(out.record.drafts[0].ink.strokes.map(s => s.pts[0]), [10, 60]);
});

test("server conflict choices keep both pages and refuse a stale editor", async () => {
  const { store } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: page(1, 2), body: "mine" });
  await store.markConflict("jr_aaaaaaaa", { revision: 4, ink: page(7), body: "theirs" });
  const v = (await store.load("jr_aaaaaaaa")).localRev;
  await assert.rejects(store.keepLocal("jr_aaaaaaaa", v - 1), { code: "STALE_DRAFT" });
  const kept = await store.keepLocal("jr_aaaaaaaa", v);
  assert.equal(kept.baseRevision, 4); assert.equal(kept.dirty, true); assert.equal(kept.conflict, null);
  assert.deepEqual(names(kept), [1, 2]); assert.equal(kept.localRev, v, "content unchanged, version unchanged");
  assert.equal(kept.recoveries[0].body, "theirs", "the overwritten server copy is kept here too");

  await store.markConflict("jr_aaaaaaaa", { revision: 6, ink: page(7), body: "theirs" });
  await assert.rejects(store.useServer("jr_aaaaaaaa", v - 1), { code: "STALE_DRAFT" });
  const used = await store.useServer("jr_aaaaaaaa", v);
  assert.deepEqual(names(used), [7]); assert.equal(used.body, "theirs"); assert.equal(used.dirty, false);
  assert.equal(used.localRev, v + 1);
  assert.deepEqual(used.recoveries[0].ink.strokes.map(s => s.pts[0]), [1, 2]); assert.equal(used.recoveries[0].body, "mine");
});

// Regression (review): a .slice(0, 5) retention cap silently evicted unresolved
// drafts; d1 vanished from the record after six stale saves. Raising the cap only
// moves the loss (the 21st), so there is no cap: 25 here, all kept.
test("unresolved drafts are never evicted: 25 stale sessions all survive, each by id and content", async () => {
  const { store } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(1), body: "" });
  const v1 = (await store.load("jr_aaaaaaaa")).localRev;
  await store.saveEdit("jr_aaaaaaaa", { ink: page(1, 2), body: "main" }, v1);           // main moves on
  for (let i = 1; i <= 25; i++) {
    // Unique, in-bounds x per draft (the page is 100 wide; clampInk caps x at 200).
    const out = await store.saveEdit("jr_aaaaaaaa", { ink: page(1, 150 + i), body: "draft " + i }, v1, "d" + i);
    assert.equal(out.stale, true);
  }
  const rec = await store.load("jr_aaaaaaaa");
  assert.equal(rec.drafts.length, 25);
  for (let i = 1; i <= 25; i++) {
    const d = rec.drafts.find(x => x.id === "d" + i);
    assert.ok(d, "draft d" + i + " kept");
    assert.equal(d.body, "draft " + i); assert.equal(d.ink.strokes[1].pts[0], 150 + i);
  }
  assert.deepEqual(names(rec), [1, 2]); assert.equal(rec.body, "main", "content untouched by any draft");
  // The same session saving again replaces only its own draft.
  await store.saveEdit("jr_aaaaaaaa", { ink: page(1, 199), body: "draft 1 updated" }, v1, "d1");
  const again = await store.load("jr_aaaaaaaa");
  assert.equal(again.drafts.length, 25); assert.equal(again.drafts.find(x => x.id === "d1").body, "draft 1 updated");
});

test("recovery copies are never evicted; only an explicit delete removes exactly one", async () => {
  const { store } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(1), body: "" });
  for (let i = 1; i <= 25; i++) {
    await store.saveEdit("jr_aaaaaaaa", { ink: page(100 + i), body: "copy " + i }, 0, "r" + i);
    const cur = await store.load("jr_aaaaaaaa");
    await store.resolveDraft("jr_aaaaaaaa", "r" + i, "theirs", cur.localRev);
  }
  const rec = await store.load("jr_aaaaaaaa");
  assert.equal(rec.recoveries.length, 25); assert.equal(rec.drafts.length, 0);
  for (let i = 1; i <= 25; i++) assert.ok(rec.recoveries.some(r => r.body === "copy " + i), "recovery copy " + i + " kept");
  const target = rec.recoveries.find(r => r.body === "copy 1");
  const after = await store.dismissRecovery("jr_aaaaaaaa", target.id);
  assert.equal(after.recoveries.length, 24);
  assert.ok(!after.recoveries.some(r => r.id === target.id)); assert.ok(after.recoveries.some(r => r.body === "copy 2"));
});

test("a quota failure while keeping a draft rejects visibly and loses nothing already kept", async () => {
  const { store, backend } = make();
  await store.seed("jr_aaaaaaaa", { taskId: "t1", revision: 1, ink: page(1), body: "" });
  await store.saveEdit("jr_aaaaaaaa", { ink: page(1, 2), body: "" }, 1);
  await store.saveEdit("jr_aaaaaaaa", { ink: page(1, 3), body: "kept" }, 1, "d1");
  backend.failNext = 1;
  await assert.rejects(store.saveEdit("jr_aaaaaaaa", { ink: page(1, 4), body: "" }, 1, "d2"), /QuotaExceeded/);
  const rec = await store.load("jr_aaaaaaaa");
  assert.deepEqual(rec.drafts.map(d => d.id), ["d1"]); assert.equal(rec.drafts[0].body, "kept");
});

test("content in an unknown stroke format is never adopted by a choice; nothing changes", async () => {
  const { store, backend } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: page(1, 2), body: "mine" });
  await store.markConflict("jr_aaaaaaaa", { revision: 4, ink: { v: 2, w: 1, h: 1, strokes: [] }, body: "future" });
  const v = (await store.load("jr_aaaaaaaa")).localRev;
  await assert.rejects(store.useServer("jr_aaaaaaaa", v), { code: "INK_VERSION" });
  const still = await store.load("jr_aaaaaaaa");
  assert.deepEqual(names(still), [1, 2]); assert.equal(still.body, "mine"); assert.ok(still.conflict); assert.equal(still.localRev, v);
  // A recovery copy in an unknown format (e.g. written by a newer build) is refused too.
  const row = backend.rows.get("jr_aaaaaaaa");
  row.recoveries = [{ id: "future-copy", ink: { v: 2, w: 1, h: 1, strokes: [] }, body: "future", savedAt: "x" }];
  await assert.rejects(store.restoreRecovery("jr_aaaaaaaa", "future-copy", v), { code: "INK_VERSION" });
  const after = await store.load("jr_aaaaaaaa");
  assert.deepEqual(names(after), [1, 2]); assert.equal(after.recoveries.length, 1);
});

test("off-page tails of a captured pointer are clamped to what the server accepts", () => {
  const out = Store.clampInk({ v: 1, w: 100, h: 50, strokes: [{ tool: "ballpoint", color: "#111", size: 2, pts: [-500, 10, 0.5, 900, 400, 0.4, 50, 25, 0.3] }] });
  assert.deepEqual(out.strokes[0].pts, [-100, 10, 0.5, 200, 100, 0.4, 50, 25, 0.3]);
});

test("listDirty reports only pages that still need the server", async () => {
  const { store } = make();
  await edit(store, "jr_aaaaaaaa", { taskId: "t1", ink: pageN(1) });
  await edit(store, "jr_bbbbbbbb", { taskId: "t2", ink: pageN(1) });
  await store.acknowledge("jr_bbbbbbbb", "m2", 1);
  assert.deepEqual((await store.listDirty()).map(r => r.journalId), ["jr_aaaaaaaa"]);
});
