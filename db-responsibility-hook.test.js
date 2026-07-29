// db.js's updateBlock -> responsibility completion hook (dcc-canonical-task-model D1).
//
// This is the EAGER half of the one-open-instance invariant: when a block carrying
// properties.responsibilityId crosses the done line, the responsibility
// definition's cadence resets in the same call, so no UI path has to remember to
// tell the server. It is new branching logic in the app's hottest write path, and
// every one of its guards has a reason someone will be tempted to remove:
//
//   - the transaction guard (a cadence stamp must never abort a caller's tx)
//   - the transition detection (done -> done must not re-stamp)
//   - the tenancy check (responsibilityId is client-supplied)
//   - the kind check
//   - never throwing (a broken definition must not block marking a task done)
//
// Harness: the same transaction-faithful mock pool injected via require.cache that
// batchop-tx.test.js uses.
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
  function makeExec(tag, staged) {
    async function query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ tag, text, params });
      if (text === "BEGIN") return { rows: [] };
      if (text === "COMMIT") {
        for (const [k, v] of staged) { if (v === null) committed.delete(k); else committed.set(k, v); }
        staged.clear();
        return { rows: [] };
      }
      if (text === "ROLLBACK") { staged.clear(); return { rows: [] }; }
      const view = (id) => (staged && staged.has(id)) ? staged.get(id) : (committed.has(id) ? committed.get(id) : null);
      const put = (id, r) => { if (staged) staged.set(id, r); else if (r === null) committed.delete(id); else committed.set(id, r); };
      if (/^SELECT \* FROM blocks WHERE id/.test(text)) {
        const r = view(params[0]);
        return { rows: r ? [{ ...r }] : [] };
      }
      if (/^UPDATE blocks SET properties/.test(text)) {
        const cur = view(params[5]);
        if (cur) put(params[5], { ...cur, properties: params[0], sort_order: params[1], parent_id: params[2], date: params[3], updated_at: params[4] });
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

const TASK_DATE = "2026-07-29";
function taskRow(props, extra = {}) {
  return {
    id: "t1", type: "block", parent_id: null, date: TASK_DATE, properties: props,
    sort_order: 0, user_id: 1, workspace_id: "ws-1", created_at: "t0", updated_at: "t0", deleted_at: null, ...extra,
  };
}
function defRow(props, extra = {}) {
  return {
    id: "r1", type: "block", parent_id: null, date: null, properties: { kind: "responsibility_item", cadence: "weekly", ...props },
    sort_order: 0, user_id: 1, workspace_id: "ws-1", created_at: "t0", updated_at: "t0", deleted_at: null, ...extra,
  };
}
const def = (pool) => pool._committed.get("r1").properties;

test("a task flipping to done resets its responsibility definition's cadence, with no API call involved", async () => {
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1" }),
    defRow({ lastCompletedAt: "2026-06-01T00:00:00Z", openInstanceBlockId: "t1", openInstanceDate: TASK_DATE }),
  ]);
  const db = loadDbWithMock(pool);
  await db.updateBlock("t1", { properties: { responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" } });
  assert.equal(def(pool).lastCompletedAt, "2026-07-29T12:00:00Z");
  assert.equal(def(pool).previousCompletedAt, "2026-06-01T00:00:00Z", "so un-checking can revert");
  assert.equal(def(pool).openInstanceBlockId, undefined, "completing releases the pause");
});

test("un-checking the same task restores the previous clock and puts the instance back in flight", async () => {
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" }),
    defRow({ lastCompletedAt: "2026-07-29T12:00:00Z", previousCompletedAt: "2026-06-01T00:00:00Z", lastCompletedTaskId: "t1" }),
  ]);
  const db = loadDbWithMock(pool);
  await db.updateBlock("t1", { properties: { responsibilityId: "r1", local_id: "l1" } });
  assert.equal(def(pool).lastCompletedAt, "2026-06-01T00:00:00Z");
  assert.equal(def(pool).openInstanceBlockId, "t1");
  // The date must come from the block's date COLUMN. Reading it off properties
  // (where it does not live) left openInstanceDate null, which disabled both the
  // day-overlay lookup and the past-dated safety valve and made the restored pause
  // unexpirable.
  assert.equal(def(pool).openInstanceDate, TASK_DATE, "openInstanceDate comes from the row's date column");
});

test("done -> done writes nothing: the hook fires on the TRANSITION, not on every save", async () => {
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" }),
    defRow({ lastCompletedAt: "2026-07-29T12:00:00Z" }),
  ]);
  const db = loadDbWithMock(pool);
  await db.updateBlock("t1", { properties: { responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z", title: "renamed" } });
  const defWrites = pool._log.filter(l => /^UPDATE blocks SET properties/.test(l.text) && l.params[5] === "r1");
  assert.equal(defWrites.length, 0, "an already-done task being edited must not re-stamp the definition");
});

test("a block with no responsibilityId costs zero extra queries (this is the hottest write path)", async () => {
  const pool = makeMockPool([taskRow({ local_id: "l1", title: "ordinary task" })]);
  const db = loadDbWithMock(pool);
  const before = pool._log.length;
  await db.updateBlock("t1", { properties: { local_id: "l1", title: "renamed" } });
  const queries = pool._log.slice(before).map(l => l.text.slice(0, 30));
  // SELECT the row, UPDATE it, INSERT the operation. Nothing more.
  assert.equal(queries.length, 3, `expected 3 queries, got ${JSON.stringify(queries)}`);
});

test("TENANCY: the hook refuses to touch a definition in another workspace", async () => {
  // responsibilityId is client-supplied on PATCH /api/blocks/:id. Without this
  // check a caller could forge a completion on someone else's responsibility, or
  // stamp an instance they control onto it -- which the reconciler would then keep
  // reading as "open", permanently suppressing another user's recurring work.
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1" }, { workspace_id: "ws-7" }),
    defRow({ lastCompletedAt: "2026-06-01T00:00:00Z" }, { workspace_id: "ws-3" }),
  ]);
  const db = loadDbWithMock(pool);
  await db.updateBlock("t1", { properties: { responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" } });
  assert.equal(def(pool).lastCompletedAt, "2026-06-01T00:00:00Z", "a foreign definition is left alone");
});

test("a responsibilityId pointing at something that is not a responsibility_item is ignored", async () => {
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1" }),
    defRow({ lastCompletedAt: "2026-06-01T00:00:00Z" }, { properties: { kind: "task_menu", title: "not a responsibility" } }),
  ]);
  const db = loadDbWithMock(pool);
  await db.updateBlock("t1", { properties: { responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" } });
  assert.equal(pool._committed.get("r1").properties.kind, "task_menu");
  assert.equal(pool._committed.get("r1").properties.lastCompletedAt, undefined);
});

test("a missing definition is a no-op, and the task write still succeeds", async () => {
  const pool = makeMockPool([taskRow({ responsibilityId: "gone", local_id: "l1" })]);
  const db = loadDbWithMock(pool);
  const out = await db.updateBlock("t1", { properties: { responsibilityId: "gone", local_id: "l1", status: "done" } });
  assert.equal(out.properties.status, "done", "a dangling responsibilityId must not block marking the task done");
});

test("inside a caller's transaction the hook is SKIPPED, so it can never abort that tx", async () => {
  // A failure here would roll back the caller's whole batch and block a task write
  // over a cadence stamp, which is the wrong trade. The reconciler settles these on
  // the next responsibilities read instead.
  const pool = makeMockPool([
    taskRow({ responsibilityId: "r1", local_id: "l1" }),
    defRow({ lastCompletedAt: "2026-06-01T00:00:00Z" }),
  ]);
  const db = loadDbWithMock(pool);
  await db.batchOp([{ op: "update", id: "t1", properties: { responsibilityId: "r1", local_id: "l1", status: "done", completedAt: "2026-07-29T12:00:00Z" } }]);
  assert.equal(pool._committed.get("t1").properties.status, "done", "the batch itself commits");
  assert.equal(def(pool).lastCompletedAt, "2026-06-01T00:00:00Z", "the definition is deliberately left for the reconciler");
});
