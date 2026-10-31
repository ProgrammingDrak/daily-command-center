// Journal task pages against real PostgreSQL (PGlite in memory or a localhost DB),
// through the real block writer, journal store and Express routes.
// Run: DCC_PGLITE_MODULE=/abs/path/@electric-sql/pglite node --test journal-postgres.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { createJournalStore } = require("./journal-store");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);

const ink = (n = 1) => ({ v: 1, w: 1275, h: 1650, strokes: Array.from({ length: n }, (_, i) => ({ tool: "ballpoint", color: "#1b1b2f", size: 2.6, pts: [10 + i, 20, 0.5, 30 + i, 40, 0.7] })) });

test("journal task pages: ownership, revisions, pinning, retention and private HTTP boundary", { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  const store = createJournalStore(ctx), owner = { userId: 1, workspaceId: "ws-1" };
  const { blockDB } = ctx;
  let task;

  await t.test("creating a Journal stamps a stable journalId and forces private", async () => {
    task = await blockDB.createBlock({ id: "jt-1", type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1",
      properties: { title: "Evening pages", type: "journal", local_id: "jt-1", publicVisibility: "public" } });
    assert.match(task.properties.journalId, /^jr_[a-z0-9-]{8,64}$/i);
    assert.equal(task.properties.publicVisibility, "private");
    const keep = await blockDB.createBlock({ id: "jt-keep", type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1",
      properties: { title: "Client id", type: "journal", journalId: "jr_client-minted-1" } });
    assert.equal(keep.properties.journalId, "jr_client-minted-1", "a valid client id survives offline creation");
  });

  await t.test("first open is an empty page at revision 0; content never lands in the block", async () => {
    const got = await store.get("jt-1", owner);
    assert.equal(got.revision, 0); assert.equal(got.ink, null); assert.equal(got.journalId, task.properties.journalId);
    const saved = await store.save("jt-1", { journalId: task.properties.journalId, ink: ink(2), body: "typed", expectedRevision: 0, mutationId: "mut-1" }, owner);
    assert.equal(saved.revision, 1); assert.equal(saved.ink.strokes.length, 2); assert.equal(saved.body, "typed");
    const block = await blockDB.getBlock("jt-1");
    assert.equal(block.properties.ink, undefined); assert.equal(block.properties.body, undefined);
    assert.doesNotMatch(JSON.stringify(block.properties), /strokes|typed/);
  });

  await t.test("stale revisions conflict, replays are idempotent, reused ids with new data are rejected", async () => {
    const jid = task.properties.journalId;
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: ink(5), expectedRevision: 0, mutationId: "mut-x" }, owner), { statusCode: 409, publicCode: "JOURNAL_CONFLICT" });
    const replay = await store.save("jt-1", { journalId: jid, ink: ink(2), body: "typed", expectedRevision: 0, mutationId: "mut-1" }, owner);
    assert.equal(replay.revision, 1, "lost-response retry returns the accepted revision, not a conflict");
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: ink(3), body: "typed", expectedRevision: 0, mutationId: "mut-1" }, owner), { statusCode: 409 });
    const concurrent = await Promise.allSettled([
      store.save("jt-1", { journalId: jid, ink: ink(3), expectedRevision: 1, mutationId: "c-1" }, owner),
      store.save("jt-1", { journalId: jid, ink: ink(4), expectedRevision: 1, mutationId: "c-2" }, owner),
    ]);
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(concurrent.find(r => r.status === "rejected").reason.statusCode, 409);
    const undone = await store.undo("jt-1", { expectedRevision: 2 }, owner);
    assert.equal(undone.revision, 3); assert.equal(undone.ink.strokes.length, 2);
  });

  await t.test("validation: bad ink, oversize text, wrong journal id and non-journal tasks", async () => {
    const jid = task.properties.journalId;
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: { v: 1, w: 10, h: 10, strokes: [{ tool: "pen", color: "#111", size: 2, pts: [1, 2, 9] }] }, expectedRevision: 3 }, owner), { statusCode: 400, message: /invalid point/ });
    await assert.rejects(store.save("jt-1", { journalId: jid, body: "x".repeat(20001), expectedRevision: 3 }, owner), { statusCode: 400 });
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: { v: 2, w: 10, h: 10, strokes: [] }, expectedRevision: 3 }, owner), { statusCode: 400, message: /version 1 stroke format/ });
    const huge = ink(1); huge.strokes[0].pts = Array.from({ length: 450000 }, () => 123.45);
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: huge, expectedRevision: 3 }, owner), { statusCode: 413 });
    await assert.rejects(store.save("jt-1", { journalId: "jr_someone-elses", ink: ink(), expectedRevision: 3 }, owner), { statusCode: 409 });
    await assert.rejects(store.save("jt-1", { journalId: "nope", expectedRevision: 3 }, owner), { statusCode: 400 });
    await blockDB.createBlock({ id: "plain-1", type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1", properties: { title: "Plain", type: "task" } });
    await assert.rejects(store.get("plain-1", owner), { statusCode: 404 });
    await assert.rejects(store.save("plain-1", { journalId: "jr_forged-0001", ink: ink(), expectedRevision: 0 }, owner), { statusCode: 409 });
  });

  await t.test("cross-account: another owner, same-workspace user and forged ids see 404 and cannot write", async () => {
    const jid = task.properties.journalId;
    for (const attacker of [{ userId: 2, workspaceId: "ws-2" }, { userId: 2, workspaceId: "ws-1" }]) {
      await assert.rejects(store.get("jt-1", attacker), { statusCode: 404 });
      await assert.rejects(store.save("jt-1", { journalId: jid, ink: ink(9), expectedRevision: 3 }, attacker), { statusCode: 404 });
      await assert.rejects(store.undo("jt-1", { expectedRevision: 3 }, attacker), { statusCode: 404 });
    }
    assert.equal((await store.get("jt-1", owner)).ink.strokes.length, 2);
  });

  await t.test("stale generic writes and moves cannot detach the type, journal id or privacy", async () => {
    const jid = task.properties.journalId;
    const updated = await blockDB.updateBlock("jt-1", { properties: { title: "Renamed", type: "task", publicVisibility: "public", journalId: "jr_hijack-0001" } });
    assert.equal(updated.properties.type, "journal"); assert.equal(updated.properties.journalId, jid);
    assert.equal(updated.properties.publicVisibility, "private"); assert.equal(updated.properties.title, "Renamed");
    const fresh = await blockDB.getBlock("jt-1");
    await blockDB.rescheduleBlocks([{ id: "jt-1", date: "2026-11-02", properties: { ...fresh.properties, type: "task", journalId: null, publicVisibility: "public" } }], []);
    const moved = await blockDB.getBlock("jt-1");
    assert.equal(String(moved.date instanceof Date ? moved.date.toISOString() : moved.date).slice(0, 10), "2026-11-02");
    assert.equal(moved.properties.type, "journal"); assert.equal(moved.properties.journalId, jid); assert.equal(moved.properties.publicVisibility, "private");
    assert.equal((await store.get("jt-1", owner)).ink.strokes.length, 2, "same page after a date move");
  });

  await t.test("completion keeps the page; a copied journal gets its own id; deletion retains the page", async () => {
    const jid = task.properties.journalId;
    await blockDB.updateBlock("jt-1", { properties: { ...(await blockDB.getBlock("jt-1")).properties, status: "done", completedAt: "2026-10-31T20:00:00.000Z" } });
    assert.equal((await store.get("jt-1", owner)).ink.strokes.length, 2);
    const copy = await blockDB.createBlock({ id: "jt-copy", type: "block", date: "2026-11-01", user_id: 1, workspace_id: "ws-1", properties: { title: "Copy", type: "journal", journalId: jid } });
    assert.notEqual(copy.properties.journalId, jid, "repeat/template copies never share a page");
    const retried = await blockDB.createBlock({ id: "jt-1", type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1", properties: { title: "Retry", type: "journal", journalId: jid } }).catch(() => null);
    if (retried) assert.equal(retried.properties.journalId, jid, "a retried create of the same task keeps its id");
    await ctx.pool.query("UPDATE blocks SET deleted_at='2020-01-01' WHERE id=$1", ["jt-1"]);
    await blockDB.purgeSoftDeleted(30);
    assert.ok(await blockDB.getBlockIncludingDeleted("jt-1"), "tombstone purge keeps tasks that own a journal page");
    await assert.rejects(store.save("jt-1", { journalId: jid, ink: ink(1), expectedRevision: 3 }, owner), { statusCode: 409 });
    await assert.rejects(store.undo("jt-1", { expectedRevision: 3 }, owner), { statusCode: 409, message: /Restore the removed task/ });
    await blockDB.undeleteBlock("jt-1");
    assert.equal((await store.get("jt-1", owner)).ink.strokes.length, 2);
  });

  await t.test("HTTP: no session, service bearer, viewer and other owners are rejected; responses are private", async () => {
    const app = express(); app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => { const user = Number(req.headers["x-test-session"]); if (user) { req.session = { userId: user }; req.workspaceId = user === 2 ? "ws-2" : "ws-1"; } next(); });
    require("./routes/journal")(app, ctx);
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const base = "http://127.0.0.1:" + server.address().port, path = "/api/journal/tasks/jt-1";
      for (const [headers, status] of [[{}, 401], [{ "x-user-id": "1", "x-workspace-id": "ws-1", Authorization: "Bearer fake-service" }, 401], [{ "x-test-session": "3" }, 403], [{ "x-test-session": "2" }, 404]]) {
        const r = await fetch(base + path, { headers });
        assert.equal(r.status, status, JSON.stringify(headers));
        assert.equal(r.headers.get("cache-control"), "private, no-store");
        assert.doesNotMatch(await r.text(), /strokes|typed/);
        const w = await fetch(base + path, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ journalId: task.properties.journalId, ink: ink(9), expectedRevision: 3 }) });
        assert.equal(w.status, status);
      }
      const mine = await fetch(base + path, { headers: { "x-test-session": "1" } });
      assert.equal(mine.status, 200); assert.equal((await mine.json()).ink.strokes.length, 2);
      const stale = await fetch(base + path, { method: "PUT", headers: { "x-test-session": "1", "Content-Type": "application/json" }, body: JSON.stringify({ journalId: task.properties.journalId, ink: ink(1), expectedRevision: 0 }) });
      assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "JOURNAL_CONFLICT");
      assert.equal((await store.get("jt-1", owner)).ink.strokes.length, 2, "nothing written by any rejected request");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
