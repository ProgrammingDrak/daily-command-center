const test = require("node:test");
const assert = require("node:assert/strict");

function makeDb(initialBlocks) {
  const blocks = new Map(initialBlocks.map(block => [block.id, { ...block, properties: { ...(block.properties || {}) } }]));
  const operations = [];

  async function query(sql, params = []) {
    const compact = String(sql).replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) return { rows: [], rowCount: 0 };
    if (compact.startsWith("SELECT * FROM blocks WHERE id = $1 FOR UPDATE")) {
      const row = blocks.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (compact.startsWith("SELECT * FROM blocks WHERE date = $1 AND workspace_id = $2")) {
      const rows = [...blocks.values()].filter(b => b.date === params[0] && b.workspace_id === params[1] && !b.deleted_at);
      return { rows, rowCount: rows.length };
    }
    if (compact.startsWith("SELECT * FROM blocks WHERE date = $1 AND deleted_at IS NULL")) {
      const rows = [...blocks.values()].filter(b => b.date === params[0] && !b.deleted_at);
      return { rows, rowCount: rows.length };
    }
    if (compact.includes("WHERE date IS NULL") && compact.includes("workspace_id = $1")) {
      const rows = [...blocks.values()].filter(b => !b.date && b.workspace_id === params[0] && !b.deleted_at && (b.properties.subtaskOf || b.properties.wrapId));
      return { rows, rowCount: rows.length };
    }
    if (compact.includes("WHERE date IS NULL") && compact.includes("type = 'block'")) {
      const rows = [...blocks.values()].filter(b => !b.date && !b.deleted_at && (b.properties.subtaskOf || b.properties.wrapId));
      return { rows, rowCount: rows.length };
    }
    if (compact.startsWith("UPDATE blocks SET properties = $1, updated_at = $2 WHERE id = $3")) {
      const row = blocks.get(params[2]);
      row.properties = params[0]; row.updated_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith("UPDATE blocks SET properties = $1, date = $2, updated_at = $3 WHERE id = $4")) {
      const row = blocks.get(params[3]);
      row.properties = params[0]; row.date = params[1]; row.updated_at = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith("INSERT INTO blocks")) {
      const [id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at] = params;
      blocks.set(id, { id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at, deleted_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith("INSERT INTO operations")) {
      operations.push({ sql: compact, params });
      return { rows: [], rowCount: 1 };
    }
    throw new Error("Unexpected SQL in fake pool: " + compact);
  }

  const client = { query, release() {} };
  const fakePool = { connect: async () => client, query };
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  const previousPool = require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool, children: [], paths: [] };
  const db = require("./db");
  return {
    db, blocks, operations,
    restore() {
      delete require.cache[dbPath];
      if (previousPool) require.cache[poolPath] = previousPool;
      else delete require.cache[poolPath];
    }
  };
}

test("database completion merge preserves other root state and rejects delayed intents", async t => {
  const harness = makeDb([{ id: "root", type: "day_root", date: "2026-08-08", properties: { date: "2026-08-08", note: "keep", _done: {} }, sort_order: 0 }]);
  t.after(() => harness.restore());
  await harness.db.updateTaskCompletions("root", [{ id: "task", completed: true, version: 20 }]);
  await harness.db.updateTaskCompletions("root", [{ id: "task", completed: false, version: 30 }]);
  await harness.db.updateTaskCompletions("root", [{ id: "task", completed: true, version: 20 }]);
  await harness.db.patchBlockProperties("root", { _pomoState: { running: true } });
  const root = harness.blocks.get("root");
  assert.equal(root.properties.note, "keep");
  assert.equal(root.properties._pomoState.running, true);
  assert.deepEqual(root.properties._done.ids, []);
  assert.equal(root.properties._done.mutations.task, 30);
});

test("database reschedule serializes the whole subtree and newest destination wins", async t => {
  const common = { type: "block", workspace_id: "ws-1", user_id: 1, sort_order: 0, deleted_at: null };
  const harness = makeDb([
    { ...common, id: "parent", date: "2026-08-08", properties: { local_id: "p", title: "Parent" } },
    { ...common, id: "child", date: "2026-08-08", properties: { local_id: "c", subtaskOf: "p" } },
    { ...common, id: "other", date: "2026-08-08", properties: { local_id: "o" } },
  ]);
  t.after(() => harness.restore());

  const first = await harness.db.rescheduleTask({ parentId: "parent", targetDate: "2026-08-10", fromDate: "2026-08-08", mutationVersion: 200 });
  assert.deepEqual(new Set(first.moved), new Set(["parent", "child"]));
  assert.equal(harness.blocks.get("other").date, "2026-08-08");

  const stale = await harness.db.rescheduleTask({ parentId: "parent", targetDate: "2026-08-09", fromDate: "2026-08-08", mutationVersion: 100 });
  assert.equal(stale.stale, true);
  assert.equal(harness.blocks.get("parent").date, "2026-08-10");
  assert.equal(harness.blocks.get("child").date, "2026-08-10");

  await harness.db.rescheduleTask({ parentId: "parent", targetDate: "2026-08-11", fromDate: "2026-08-08", mutationVersion: 300 });
  assert.equal(harness.blocks.get("parent").date, "2026-08-11");
  assert.equal(harness.blocks.get("child").date, "2026-08-11", "child discovery uses the locked parent's current date");
  const tombstones = [...harness.blocks.values()].filter(b => b.properties.kind === "reschedule_tombstone");
  assert.equal(tombstones.length, 2, "one origin marker per actual move");
});
