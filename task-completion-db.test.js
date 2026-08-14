const test = require("node:test");
const assert = require("node:assert/strict");

function loadDb(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

function row(id, properties = {}, extra = {}) {
  return {
    id, type: "block", date: "2026-08-10", parent_id: null, workspace_id: "ws-1",
    user_id: 7, properties, sort_order: 1000, created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z", deleted_at: null, ...extra,
  };
}

function makePool(initialRows, { failUpdateId = null } = {}) {
  const committed = new Map(initialRows.map(item => [item.id, structuredClone(item)]));
  const log = [];
  return {
    connect: async () => {
      let staged = new Map([...committed].map(([id, value]) => [id, structuredClone(value)]));
      const query = async (sql, params = []) => {
        const text = String(sql).replace(/\s+/g, " ").trim();
        log.push({ text, params });
        if (text === "BEGIN") return { rows: [] };
        if (text === "COMMIT") {
          committed.clear();
          for (const [id, value] of staged) committed.set(id, structuredClone(value));
          return { rows: [] };
        }
        if (text === "ROLLBACK") {
          staged = new Map([...committed].map(([id, value]) => [id, structuredClone(value)]));
          return { rows: [] };
        }
        if (text.includes("properties->>'local_id' = $1")) {
          const [localId, ws, date] = params;
          return { rows: [...staged.values()].filter(item =>
            !item.deleted_at && (item.workspace_id || null) === (ws || null)
            && String((item.properties || {}).local_id) === String(localId)
            && (date === undefined || item.date === date)).map(item => structuredClone(item)) };
        }
        if (text.includes("date IS NOT DISTINCT FROM $2::date")) {
          const [ws, date] = params;
          return { rows: [...staged.values()].filter(item =>
            !item.deleted_at && (item.workspace_id || null) === (ws || null)
            && (item.date || null) === (date || null)).map(item => structuredClone(item)) };
        }
        if (text.includes("type = 'day_root' AND date = $1")) {
          const [date, ws] = params;
          return { rows: [...staged.values()].filter(item => item.type === "day_root"
            && item.date === date && !item.deleted_at
            && (item.workspace_id || null) === (ws || null)).map(item => structuredClone(item)) };
        }
        if (text.startsWith("SELECT id FROM blocks WHERE id = $1")) {
          const item = staged.get(params[0]);
          return { rows: item ? [{ id: item.id }] : [] };
        }
        if (text.startsWith("SELECT * FROM blocks") && text.includes("id = $1")) {
          const item = staged.get(params[0]);
          if (!item) return { rows: [] };
          if (text.includes("workspace_id IS NOT DISTINCT FROM $2")
              && (item.workspace_id || null) !== (params[1] || null)) return { rows: [] };
          return { rows: [structuredClone(item)] };
        }
        if (text.startsWith("UPDATE blocks SET properties = $1, date = $2")) {
          const id = params[3];
          if (id === failUpdateId) throw new Error("injected child failure");
          const current = staged.get(id);
          const next = { ...current, properties: structuredClone(params[0]), date: params[1], updated_at: params[2] };
          staged.set(id, next);
          return { rows: [structuredClone(next)] };
        }
        if (text.startsWith("UPDATE blocks SET properties = $1, updated_at = $2")) {
          const current = staged.get(params[2]);
          const next = { ...current, properties: structuredClone(params[0]), updated_at: params[1] };
          staged.set(params[2], next);
          return { rows: [] };
        }
        if (text.startsWith("INSERT INTO operations")) return { rows: [] };
        throw new Error("Unhandled SQL: " + text);
      };
      return { query, release() {} };
    },
    query: async () => ({ rows: [] }),
    _rows: committed,
    _log: log,
  };
}

const input = (overrides = {}) => ({
  taskRef: "parent", completed: true, completedAt: "2026-08-10T15:00:00Z",
  taskDate: "2026-08-10", mutationId: "mutation-1", expectedRevision: null,
  userId: 7, workspaceId: "ws-1", ...overrides,
});

test("completion preserves unrelated properties and commits subtask descendants atomically", async () => {
  const parent = row("parent", { local_id: "p", title: "Keep title", detail: "Keep detail", status: "open" });
  const child = row("child", { local_id: "c", subtaskOf: "p", title: "Step", status: "open" });
  const rider = row("rider", { local_id: "r", wrapId: "p", title: "Independent", status: "open" });
  const artifact = row("artifact", { kind: "meeting_summary", title: "Artifact", status: "placed" }, { parent_id: "parent" });
  const pool = makePool([parent, child, rider, artifact]);
  const db = loadDb(pool);

  const result = await db.setTaskCompletion(input());

  assert.equal(pool._rows.get("parent").properties.status, "done");
  assert.equal(pool._rows.get("parent").properties.title, "Keep title");
  assert.equal(pool._rows.get("parent").properties.detail, "Keep detail");
  assert.equal(pool._rows.get("child").properties.status, "done");
  assert.equal(pool._rows.get("rider").properties.status, "open");
  assert.equal(pool._rows.get("artifact").properties.status, "placed");
  assert.deepEqual(result.affectedTasks.map(item => item.id), ["parent", "child"]);
});

test("the same mutation id is idempotent and a stale different mutation conflicts", async () => {
  const pool = makePool([row("parent", { local_id: "p", title: "T", status: "open" })]);
  const db = loadDb(pool);
  const first = await db.setTaskCompletion(input());
  const revision = first.revision;
  const duplicate = await db.setTaskCompletion(input({ expectedRevision: null }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, revision);
  await assert.rejects(
    db.setTaskCompletion(input({ mutationId: "mutation-2", expectedRevision: null })),
    error => error.statusCode === 409 && error.publicCode === "COMPLETION_CONFLICT" && error.currentTask.id === "parent"
  );
});

test("a duplicate completion returns the full descendant set for timing repair", async () => {
  const parent = row("parent", { local_id: "p", title: "Parent", status: "open" });
  const child = row("child", { local_id: "c", subtaskOf: "p", title: "Step", status: "open" });
  const pool = makePool([parent, child]);
  const db = loadDb(pool);

  await db.setTaskCompletion(input());
  const duplicate = await db.setTaskCompletion(input());

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.affectedTasks.map(item => item.id), ["parent", "child"]);
  assert.deepEqual(duplicate.broadcastIds, ["parent", "child"]);
});

test("a completion older than the current work state is rejected", async () => {
  const parent = row("parent", {
    local_id: "p", title: "Active", status: "open",
    startedAt: "2026-08-10T16:00:00.000Z",
    workStateChangedAt: "2026-08-10T16:00:00.000Z",
  });
  const pool = makePool([parent]);
  const db = loadDb(pool);

  await assert.rejects(
    db.setTaskCompletion(input({ completedAt: "2026-08-10T15:00:00.000Z" })),
    error => error.statusCode === 409 && error.publicCode === "COMPLETION_WORK_STATE_CONFLICT"
  );
  assert.equal(pool._rows.get("parent").properties.status, "open");
  assert.equal(pool._rows.get("parent").properties.startedAt, "2026-08-10T16:00:00.000Z");
});

test("a parent completion older than a descendant work state is rejected atomically", async () => {
  const parent = row("parent", { local_id: "p", title: "Parent", status: "open" });
  const child = row("child", {
    local_id: "c", subtaskOf: "p", title: "Active step", status: "open",
    startedAt: "2026-08-10T16:00:00.000Z",
    workStateChangedAt: "2026-08-10T16:00:00.000Z",
  });
  const pool = makePool([parent, child]);
  const db = loadDb(pool);

  await assert.rejects(
    db.setTaskCompletion(input({ completedAt: "2026-08-10T15:00:00.000Z" })),
    error => error.statusCode === 409 && error.publicCode === "COMPLETION_WORK_STATE_CONFLICT"
      && error.currentTask.id === "child"
  );
  assert.equal(pool._rows.get("parent").properties.status, "open");
  assert.equal(pool._rows.get("child").properties.status, "open");
  assert.equal(pool._rows.get("child").properties.startedAt, "2026-08-10T16:00:00.000Z");
});

test("reopen clears row completion and the matching legacy overlay in one commit", async () => {
  const task = row("parent", {
    local_id: "p", title: "T", status: "done", done: true,
    completedAt: "2026-08-10T15:00:00Z", completedBy: "7", _completionRevision: "rev-1",
  });
  const root = row("root", { date: "2026-08-10", _done: {
    ids: ["p", "parent", "keep"], at: { p: "x", parent: "x", keep: "y" },
  } }, { type: "day_root", sort_order: 0 });
  const pool = makePool([task, root]);
  const db = loadDb(pool);

  await db.setTaskCompletion(input({ completed: false, completedAt: null, mutationId: "reopen-1", expectedRevision: "rev-1" }));

  const props = pool._rows.get("parent").properties;
  assert.equal(props.status, "open");
  for (const key of ["done", "completedAt", "completedBy"]) assert.equal(key in props, false);
  assert.deepEqual(pool._rows.get("root").properties._done.ids, ["keep"]);
  assert.deepEqual(pool._rows.get("root").properties._done.at, { keep: "y" });
});

test("a dateless backlog completion is reversible", async () => {
  const task = row("parent", { local_id: "p", title: "Backlog", kind: "backlog", status: "open" }, { date: null });
  const pool = makePool([task]);
  const db = loadDb(pool);
  const done = await db.setTaskCompletion(input());
  assert.equal(pool._rows.get("parent").date, "2026-08-10");
  assert.equal(pool._rows.get("parent").properties._wasBacklog, true);
  await db.setTaskCompletion(input({
    completed: false, completedAt: null, mutationId: "reopen-1", expectedRevision: done.revision,
  }));
  assert.equal(pool._rows.get("parent").date, null);
  assert.equal(pool._rows.get("parent").properties.kind, "backlog");
});

test("meeting completion uses the planned end and records when it was checked", async () => {
  const task = row("parent", {
    local_id: "p", title: "Weekly meeting", type: "meeting", status: "open",
    plannedStartAt: "2026-08-10T13:00:00.000Z",
    plannedEndAt: "2026-08-10T13:30:00.000Z",
  });
  const pool = makePool([task]);
  const db = loadDb(pool);

  await db.setTaskCompletion(input({ completedAt: "2026-08-12T18:45:00.000Z" }));

  const props = pool._rows.get("parent").properties;
  assert.equal(props.completedAt, "2026-08-10T13:30:00.000Z");
  assert.equal(props.doneAt, "2026-08-10T13:30:00.000Z");
  assert.equal(props.completionRecordedAt, "2026-08-12T18:45:00.000Z");
});

test("a rowless historical task persists through the legacy overlay", async () => {
  const root = row("day-root-ws-1-2026-08-10", { date: "2026-08-10" }, { type: "day_root", sort_order: 0 });
  const pool = makePool([root]);
  const db = loadDb(pool);
  const result = await db.setTaskCompletion(input({ taskRef: "legacy-id" }));
  assert.equal(result.persistenceTarget, "legacy_overlay");
  assert.deepEqual(pool._rows.get(root.id).properties._done.ids, ["legacy-id"]);
  assert.equal(result.task.properties.status, "done");
});

test("a child failure rolls the entire completion tree back", async () => {
  const parent = row("parent", { local_id: "p", status: "open" });
  const child = row("child", { local_id: "c", subtaskOf: "p", status: "open" });
  const pool = makePool([parent, child], { failUpdateId: "child" });
  const db = loadDb(pool);
  await assert.rejects(db.setTaskCompletion(input()), /injected child failure/);
  assert.equal(pool._rows.get("parent").properties.status, "open");
  assert.equal(pool._rows.get("child").properties.status, "open");
});
