// Journal identity under concurrency, on real PostgreSQL (PGlite or a localhost
// DB) through the real block writer, journal store and routes.
// Run: DCC_PGLITE_MODULE=/abs/path/@electric-sql/pglite node --test journal-concurrency.test.js
//
// Review repro this pins: two concurrent blockDB.createBlock calls for DIFFERENT
// tasks carrying the SAME journalId both succeeded with that one id
// (distinctJournalIds = 1), because a preflight SELECT then INSERT is not atomic.
const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { createJournalStore, SCHEMA_SQL, claimJournalId } = require("./journal-store");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
const ink = (x = 10) => ({ v: 1, w: 1275, h: 1650, strokes: [{ tool: "ballpoint", color: "#1b1b2f", size: 2.6, pts: [x, 20, 0.5, x + 20, 40, 0.7] }] });
const journalTask = (id, i, journalId, extra = {}) => ({ id, type: "block", date: "2026-10-31", sort_order: i * 1000, user_id: 1, workspace_id: "ws-1",
  properties: Object.assign({ title: "Synthetic collision " + i, type: "journal", journalId }, extra) });

test("journal identity is claimed atomically on every path that assigns one", { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  const { blockDB, pool } = ctx;
  const store = createJournalStore(ctx), owner = { userId: 1, workspaceId: "ws-1" };
  const claimOf = async id => (await pool.query("SELECT task_id FROM task_journal_claims WHERE journal_id=$1", [id])).rows[0]?.task_id || null;

  await t.test("reviewer repro: two concurrent creates with one journalId end with two distinct, claimed ids", async () => {
    const made = await Promise.all([1, 2].map(i => blockDB.createBlock(journalTask("collision-" + i, i, "jr_concurrency-review"))));
    const ids = made.map(b => b.properties.journalId);
    assert.equal(new Set(ids).size, 2, "distinctJournalIds must be 2, got " + JSON.stringify(ids));
    assert.equal(ids.filter(id => id === "jr_concurrency-review").length, 1, "exactly one task keeps the requested id");
    for (const b of made) assert.equal(await claimOf(b.properties.journalId), b.id, "each task owns its own id");
    const stored = await Promise.all(made.map(b => blockDB.getBlock(b.id)));
    assert.deepEqual(stored.map(b => b.properties.journalId), ids, "what was returned is what was stored");
  });

  await t.test("five concurrent creates with one id: five distinct ids, one claim each", async () => {
    const made = await Promise.all([1, 2, 3, 4, 5].map(i => blockDB.createBlock(journalTask("burst-" + i, i, "jr_burst-shared-id"))));
    assert.equal(new Set(made.map(b => b.properties.journalId)).size, 5);
  });

  await t.test("two creates inside ONE transaction (batch) see each other's claim", async () => {
    const c = await pool.connect();
    let a, b;
    try {
      await c.query("BEGIN");
      a = await blockDB.createBlock(journalTask("batch-1", 1, "jr_batch-shared-id"), c);
      b = await blockDB.createBlock(journalTask("batch-2", 2, "jr_batch-shared-id"), c);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    assert.notEqual(a.properties.journalId, b.properties.journalId);
    assert.equal(await claimOf(a.properties.journalId), "batch-1"); assert.equal(await claimOf(b.properties.journalId), "batch-2");
  });

  await t.test("a retry of the SAME task keeps its id; a sequential copy gets a fresh one", async () => {
    const first = await blockDB.createBlock(journalTask("retry-1", 1, "jr_retry-same-task"));
    assert.equal(first.properties.journalId, "jr_retry-same-task");
    const again = await claimJournalId(pool, { type: "journal", journalId: "jr_retry-same-task" }, "retry-1", "ws-1");
    assert.equal(again.journalId, "jr_retry-same-task", "same task re-claiming keeps it");
    // The actual create replay (a lost-ack WAL retry of the SAME task) must
    // succeed and keep the id -- not error, not re-mint.
    const replay = await blockDB.createBlock(journalTask("retry-1", 1, "jr_retry-same-task"));
    assert.equal(replay.id, "retry-1"); assert.equal(replay.properties.journalId, "jr_retry-same-task");
    const concurrentReplays = await Promise.all([1, 2].map(() => blockDB.createBlock(journalTask("retry-1", 1, "jr_retry-same-task"))));
    assert.deepEqual(concurrentReplays.map(b => b.properties.journalId), ["jr_retry-same-task", "jr_retry-same-task"]);
    assert.equal((await blockDB.getBlock("retry-1")).properties.journalId, "jr_retry-same-task");
    assert.equal(await claimOf("jr_retry-same-task"), "retry-1");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM blocks WHERE id='retry-1'")).rows[0].n, 1);
    const copy = await blockDB.createBlock(journalTask("copy-1", 2, "jr_retry-same-task"));
    assert.notEqual(copy.properties.journalId, "jr_retry-same-task");
  });

  await t.test("converting a task into a Journal claims; a held id is re-minted, concurrently too", async () => {
    await blockDB.createBlock(journalTask("held-1", 1, "jr_held-by-another"));
    for (const id of ["plain-1", "plain-2", "plain-3"]) {
      await blockDB.createBlock({ id, type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1", properties: { title: id, type: "task" } });
    }
    const conv = await blockDB.updateBlock("plain-1", { properties: { title: "plain-1", type: "journal", journalId: "jr_held-by-another" } });
    assert.equal(conv.properties.type, "journal"); assert.notEqual(conv.properties.journalId, "jr_held-by-another");
    assert.equal(await claimOf(conv.properties.journalId), "plain-1");
    const both = await Promise.all(["plain-2", "plain-3"].map(id => blockDB.updateBlock(id, { properties: { title: id, type: "journal", journalId: "jr_concurrent-convert" } })));
    assert.equal(new Set(both.map(b => b.properties.journalId)).size, 2, "concurrent converts get distinct ids");
    // An unrelated edit of an existing Journal keeps its id and claim.
    const kept = await blockDB.updateBlock("held-1", { properties: { title: "renamed", type: "journal", journalId: "jr_held-by-another" } });
    assert.equal(kept.properties.journalId, "jr_held-by-another"); assert.equal(await claimOf("jr_held-by-another"), "held-1");
  });

  await t.test("a move carrying a stale conversion to a held id is re-minted too", async () => {
    await blockDB.createBlock({ id: "move-1", type: "block", date: "2026-10-31", user_id: 1, workspace_id: "ws-1", properties: { title: "move", type: "task" } });
    const fresh = await blockDB.getBlock("move-1");
    await blockDB.rescheduleBlocks([{ id: "move-1", date: "2026-11-01", properties: { ...fresh.properties, type: "journal", journalId: "jr_held-by-another" } }], []);
    const moved = await blockDB.getBlock("move-1");
    assert.equal(moved.properties.type, "journal"); assert.notEqual(moved.properties.journalId, "jr_held-by-another");
    assert.equal(await claimOf(moved.properties.journalId), "move-1");
  });

  let owner1, legacy;
  await t.test("legacy duplicate rows (written before claims) are refused visibly; the owner is untouched", async () => {
    owner1 = await blockDB.createBlock(journalTask("owner-1", 1, "jr_legacy-shared"));
    await store.save("owner-1", { journalId: "jr_legacy-shared", ink: ink(10), body: "owner page", expectedRevision: 0, mutationId: "o-1" }, owner);
    // A pre-claims duplicate, inserted directly as an old server could have.
    await pool.query(`INSERT INTO blocks (id,type,parent_id,date,properties,sort_order,user_id,workspace_id,created_at,updated_at)
      VALUES ('legacy-dup','block',NULL,'2026-10-31',$1,9000,1,'ws-1',NOW(),NOW())`, [{ title: "Legacy duplicate", type: "journal", journalId: "jr_legacy-shared", publicVisibility: "private" }]);
    legacy = "legacy-dup";
    await assert.rejects(store.get(legacy, owner), { statusCode: 409, publicCode: "JOURNAL_AMBIGUOUS" });
    await assert.rejects(store.save(legacy, { journalId: "jr_legacy-shared", ink: ink(99), body: "intruder", expectedRevision: 0 }, owner), { statusCode: 409, publicCode: "JOURNAL_AMBIGUOUS" });
    await assert.rejects(store.save(legacy, { journalId: "jr_legacy-shared", ink: ink(99), body: "intruder", expectedRevision: 1 }, owner), { statusCode: 409, publicCode: "JOURNAL_AMBIGUOUS" });
    const mine = await store.get("owner-1", owner);
    assert.equal(mine.body, "owner page"); assert.equal(mine.ink.strokes[0].pts[0], 10); assert.equal(mine.revision, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_journal_pages WHERE journal_id='jr_legacy-shared'")).rows[0].n, 1);
  });

  await t.test("backfill: the task already holding the page wins over an earlier duplicate block", async () => {
    await pool.query(`INSERT INTO blocks (id,type,parent_id,date,properties,sort_order,user_id,workspace_id,created_at,updated_at) VALUES
      ('bf-early','block',NULL,'2026-10-31',$1,9100,1,'ws-1','2026-01-01','2026-01-01'),
      ('bf-page','block',NULL,'2026-10-31',$1,9200,1,'ws-1','2026-02-01','2026-02-01')`, [{ title: "bf", type: "journal", journalId: "jr_backfill-shared" }]);
    await pool.query(`INSERT INTO task_journal_pages (task_id,journal_id,workspace_id,owner_user_id,ink,body) VALUES ('bf-page','jr_backfill-shared','ws-1',1,NULL,'page')`);
    await pool.query("DELETE FROM task_journal_claims WHERE journal_id='jr_backfill-shared'");
    await pool.query(SCHEMA_SQL);   // startup re-runs the idempotent DDL + backfill
    assert.equal(await claimOf("jr_backfill-shared"), "bf-page");
    await assert.rejects(store.get("bf-early", owner), { publicCode: "JOURNAL_AMBIGUOUS" });
    assert.equal((await store.get("bf-page", owner)).body, "page");
  });

  await t.test("HTTP: the legacy duplicate gets 409 JOURNAL_AMBIGUOUS and no page content", async () => {
    const app = express(); app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => { req.session = { userId: 1 }; req.workspaceId = "ws-1"; next(); });
    require("./routes/journal")(app, ctx);
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const base = "http://127.0.0.1:" + server.address().port;
      const r = await fetch(base + "/api/journal/tasks/" + legacy);
      assert.equal(r.status, 409); const body = await r.json();
      assert.equal(body.code, "JOURNAL_AMBIGUOUS"); assert.doesNotMatch(JSON.stringify(body), /owner page|strokes/);
      const w = await fetch(base + "/api/journal/tasks/" + legacy, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journalId: "jr_legacy-shared", ink: ink(77), body: "intruder", expectedRevision: 1 }) });
      assert.equal(w.status, 409);
      assert.equal((await store.get(owner1.id, owner)).body, "owner page");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
