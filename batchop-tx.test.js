// P2 transaction hardening: proves db.js batchOp() is genuinely atomic — its
// update/delete/reorder branches run on the tx CLIENT (not the pool), wrapped
// by one BEGIN/COMMIT, and a mid-sequence throw ROLLBACKs with no partial
// state. Before this fix, updateBlock/deleteBlock/reorderBlocks hardcoded the
// pool, so those branches escaped the "transaction" entirely. routes/blocks.js
// apply-forward and task-menu delete both funnel their multi-writes through
// batchOp, so this is the atomicity guard for "no half-applied forward days"
// and "no menu deleted with dangling refs" too.
//
// Harness: inject a transaction-faithful mock pool into require.cache before
// loading db.js (same trick as budget-store.test.js). The client stages writes
// in an overlay Map and only merges them into the committed store on COMMIT;
// ROLLBACK discards the overlay — so "committed" reflects exactly what a real
// Postgres tx would leave behind.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadDbWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

function makeMockPool(initialRows = []) {
  const committed = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const log = [];

  // staged: a Map overlay for a tx client; null for the pool (autocommit).
  function makeExec(tag, staged) {
    async function query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ tag, text });
      if (text === "BEGIN") return { rows: [] };
      if (text === "COMMIT") {
        for (const [k, v] of staged) { if (v === null) committed.delete(k); else committed.set(k, v); }
        staged.clear();
        return { rows: [] };
      }
      if (text === "ROLLBACK") { staged.clear(); return { rows: [] }; }

      const view = (id) => (staged && staged.has(id)) ? staged.get(id) : (committed.has(id) ? committed.get(id) : null);
      const put = (id, row) => { if (staged) staged.set(id, row); else if (row === null) committed.delete(id); else committed.set(id, row); };

      if (/^SELECT \* FROM blocks WHERE id/.test(text)) {
        const row = view(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^INSERT INTO blocks/.test(text)) {
        put(params[0], {
          id: params[0], type: params[1], parent_id: params[2], date: params[3],
          properties: params[4], sort_order: params[5], user_id: params[6],
          workspace_id: params[7], created_at: params[8], updated_at: params[9], deleted_at: null,
        });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET deleted_at/.test(text)) {
        const cur = view(params[2]);
        if (cur) put(params[2], { ...cur, deleted_at: params[0], updated_at: params[1] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET properties/.test(text)) {
        const cur = view(params[5]);
        if (cur) put(params[5], { ...cur, properties: params[0], sort_order: params[1], parent_id: params[2], date: params[3], updated_at: params[4] });
        return { rows: [] };
      }
      if (/^UPDATE blocks SET sort_order/.test(text)) {
        const cur = view(params[2]);
        if (cur) put(params[2], { ...cur, sort_order: params[0], updated_at: params[1] });
        return { rows: [] };
      }
      if (/^INSERT INTO operations/.test(text)) return { rows: [] };
      throw new Error("Unhandled mock query: " + text.slice(0, 60));
    }
    return { query };
  }

  return {
    query: (sql, params) => makeExec("pool", null).query(sql, params),
    connect: async () => {
      const staged = new Map();
      const { query } = makeExec("client", staged);
      return { query, release() {} };
    },
    _committed: committed,
    _log: log,
  };
}

function row(id, name) {
  return { id, type: "block", parent_id: null, date: "2026-07-11", properties: { name }, sort_order: 0, created_at: "t0", updated_at: "t0", deleted_at: null };
}

test("batchOp: update + delete + create commit together, all on the tx client (never the pool)", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  const res = await db.batchOp([
    { op: "update", id: "b1", properties: { name: "A2" } },
    { op: "delete", id: "b2" },
    { op: "create", type: "block", parent_id: null, date: "2026-07-11", properties: { name: "C" }, sort_order: 10, user_id: null, workspace_id: null, id: "b3" },
  ]);
  assert.equal(res.blocks.length, 3);

  // Committed store reflects every op.
  assert.equal(pool._committed.get("b1").properties.name, "A2");
  assert.ok(pool._committed.get("b2").deleted_at, "b2 soft-deleted");
  assert.equal(pool._committed.get("b3").properties.name, "C");

  // The whole batch ran on ONE client, wrapped by BEGIN..COMMIT, nothing on the pool.
  const client = pool._log.filter((l) => l.tag === "client");
  assert.equal(client[0].text, "BEGIN");
  assert.equal(client[client.length - 1].text, "COMMIT");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET properties")), "update ran on client");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET deleted_at")), "delete ran on client");
  assert.ok(!pool._log.some((l) => l.tag === "pool"), "no write escaped to the pool (the pre-fix bug)");
});

test("batchOp: reorder runs on the tx client too (client threaded through reorderBlocks)", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  // Well-separated sort_orders => no collision => no rebalance SELECT, so this
  // isolates the client-threading of the plain reorder writes.
  await db.batchOp([
    { op: "reorder", items: [{ id: "b1", sort_order: 100 }, { id: "b2", sort_order: 200 }] },
  ]);
  assert.equal(pool._committed.get("b1").sort_order, 100);
  assert.equal(pool._committed.get("b2").sort_order, 200);

  const client = pool._log.filter((l) => l.tag === "client");
  assert.equal(client[0].text, "BEGIN");
  assert.ok(client.some((l) => l.text.startsWith("UPDATE blocks SET sort_order")), "reorder wrote on the client");
  assert.ok(client.some((l) => l.text === "COMMIT"));
  assert.ok(!pool._log.some((l) => l.tag === "pool"), "no reorder write escaped to the pool");
});

test("batchOp: a throw mid-sequence rolls everything back — no partial state", async () => {
  const pool = makeMockPool([row("b1", "A"), row("b2", "B")]);
  const db = loadDbWithMock(pool);

  await assert.rejects(
    () => db.batchOp([
      { op: "update", id: "b1", properties: { name: "A2" } }, // staged
      { op: "update", id: "ghost", properties: { name: "X" } }, // Block not found -> throws
      { op: "delete", id: "b2" }, // never reached
    ]),
    /Block not found/
  );

  // The earlier, "successful" update was staged then discarded on ROLLBACK.
  assert.equal(pool._committed.get("b1").properties.name, "A", "b1 unchanged");
  assert.ok(!pool._committed.get("b2").deleted_at, "b2 not deleted");
  const client = pool._log.filter((l) => l.tag === "client");
  assert.ok(client.some((l) => l.text === "ROLLBACK"), "rolled back");
  assert.ok(!client.some((l) => l.text === "COMMIT"), "never committed");
});
