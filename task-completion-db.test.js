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
        if (text.includes("properties->>'local_id'") && text.includes("$1")) {
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
        if (text.includes("properties->>'blockerType' = 'task'")
            && text.includes("properties->>'blockerBlockId' = $1")) {
          const [blockerId, status, workspaceId] = params;
          const statuses = Array.isArray(status) ? status : [status];
          return { rows: [...staged.values()].filter(item => {
            const props = item.properties || {};
            return item.type === "block" && !item.deleted_at
              && props.kind === "delegated_item" && props.blockerType === "task"
              && String(props.blockerBlockId) === String(blockerId)
              && statuses.includes(props.status || "open")
              && (item.workspace_id || null) === (workspaceId || null);
          }).map(item => structuredClone(item)) };
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
        if (text.startsWith("SELECT * FROM blocks") && text.includes("id = ANY($1::text[])")) {
          const [ids, workspaceId] = params;
          return { rows: [...staged.values()].filter(item => {
            const props = item.properties || {};
            return ids.map(String).includes(String(item.id)) && !item.deleted_at
              && props.kind === "delegated_item" && props.blockerType === "task"
              && (props.status || "open") === "open"
              && (item.workspace_id || null) === (workspaceId || null);
          }).map(item => structuredClone(item)) };
        }
        if (text.startsWith("SELECT * FROM blocks") && text.includes("id=$1")) {
          const item = staged.get(params[0]);
          if (!item || item.deleted_at) return { rows: [] };
          if (text.includes("workspace_id IS NOT DISTINCT FROM $2")
              && (item.workspace_id || null) !== (params[1] || null)) return { rows: [] };
          return { rows: [structuredClone(item)] };
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
        if (text.startsWith("UPDATE blocks SET properties = $1, sort_order = $2, parent_id = $3, date = $4")) {
          const id = params[5];
          if (id === failUpdateId) throw new Error("injected child failure");
          const current = staged.get(id);
          const next = {
            ...current,
            properties: structuredClone(params[0]),
            sort_order: params[1],
            parent_id: params[2],
            date: params[3],
            updated_at: params[4],
          };
          staged.set(id, next);
          return { rows: [{ properties: structuredClone(next.properties) }] };
        }
        if (text.startsWith("UPDATE blocks SET properties = $1, updated_at = $2")) {
          if (params[2] === failUpdateId) throw new Error("injected child failure");
          const current = staged.get(params[2]);
          const next = { ...current, properties: structuredClone(params[0]), updated_at: params[1] };
          staged.set(params[2], next);
          return { rows: [structuredClone(next)] };
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

test("completing and reopening a prerequisite transitions its dependency", async () => {
  const blocker = row("parent", { local_id: "p", title: "Buy fixture", status: "open" });
  const dependency = row("dependency", {
    kind: "delegated_item",
    blockerType: "task",
    blockerBlockId: "parent",
    linkedBlockId: "install-fixture",
    title: "Buy fixture",
    myTask: "Install fixture",
    status: "open",
  }, { date: null });
  const pool = makePool([blocker, dependency]);
  const db = loadDb(pool);

  const done = await db.setTaskCompletion(input());
  assert.equal(pool._rows.get("dependency").properties.status, "ready");
  assert.equal(pool._rows.get("dependency").properties.readyAt, "2026-08-10T15:00:00Z");
  assert.deepEqual(done.dependencyTransitions, [{
    id: "dependency",
    linkedBlockId: "install-fixture",
    blockerBlockId: "parent",
    title: "Install fixture",
    status: "ready",
  }]);
  assert.ok(done.broadcastIds.includes("dependency"));
  assert.ok(done.broadcastIds.includes("install-fixture"));

  const reopened = await db.setTaskCompletion(input({
    completed: false,
    completedAt: null,
    mutationId: "reopen-dependency",
    expectedRevision: done.revision,
  }));
  assert.equal(pool._rows.get("dependency").properties.status, "open");
  assert.equal("readyAt" in pool._rows.get("dependency").properties, false);
  assert.equal(reopened.dependencyTransitions[0].status, "open");
});

test("a dependency transition failure rolls back prerequisite completion", async () => {
  const blocker = row("parent", { local_id: "p", title: "Buy fixture", status: "open" });
  const dependency = row("dependency", {
    kind: "delegated_item", blockerType: "task", blockerBlockId: "parent",
    linkedBlockId: "install-fixture", title: "Buy fixture", myTask: "Install fixture", status: "open",
  }, { date: null });
  const pool = makePool([blocker, dependency], { failUpdateId: "dependency" });
  const db = loadDb(pool);

  await assert.rejects(db.setTaskCompletion(input()), /injected child failure/);
  assert.equal(pool._rows.get("parent").properties.status, "open");
  assert.equal(pool._rows.get("dependency").properties.status, "open");
});

test("a blocked dependent cannot be completed outside its release transaction", async () => {
  const dependent = row("parent", {
    local_id: "install", title: "Install fixture", status: "open",
    dependencyWaitingItemIds: ["dependency"], dependencyWaitingItemId: "dependency",
  });
  const dependency = row("dependency", {
    kind: "delegated_item", blockerType: "task", blockerBlockId: "buy-fixture",
    linkedBlockId: "parent", title: "Buy fixture", myTask: "Install fixture", status: "open",
  }, { date: null });
  const pool = makePool([dependent, dependency]);
  const db = loadDb(pool);

  await assert.rejects(
    db.setTaskCompletion(input()),
    error => error.statusCode === 409 && error.publicCode === "TASK_DEPENDENCY_BLOCKED"
  );
  assert.equal(pool._rows.get("parent").properties.status, "open");
});

test("completing a ready dependent closes its relation and clears the restore marker", async () => {
  const dependent = row("parent", {
    local_id: "install", title: "Install fixture", status: "open",
    dependencyWaitingItemIds: ["dependency"], dependencyWaitingItemId: "dependency",
  }, { date: null });
  const dependency = row("dependency", {
    kind: "delegated_item", blockerType: "task", blockerBlockId: "buy-fixture",
    linkedBlockId: "parent", title: "Buy fixture", myTask: "Install fixture", status: "ready",
  }, { date: null });
  const pool = makePool([dependent, dependency]);
  const db = loadDb(pool);
  const closed = { ...dependency.properties, status: "done", completedAt: "2026-08-12T18:45:00.000Z" };

  await db.setTaskCompletion(input({
    companionUpdates: [{ id: "dependency", properties: closed, expectedUpdatedAt: dependency.updated_at }],
  }));

  assert.equal(pool._rows.get("parent").properties.status, "done");
  assert.equal("dependencyWaitingItemId" in pool._rows.get("parent").properties, false);
  assert.equal("dependencyWaitingItemIds" in pool._rows.get("parent").properties, false);
  assert.equal(pool._rows.get("dependency").properties.status, "done");
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

test("a companion Waiting update commits and rolls back with task completion", async () => {
  const parent = row("parent", { local_id: "p", status: "open" });
  const waiting = row("waiting", { kind: "delegated_item", status: "open", linkedBlockId: "parent" }, { date: null });
  const completedWaiting = { ...waiting.properties, status: "done", completedAt: "2026-08-10T15:00:00Z" };
  const pool = makePool([parent, waiting]);
  const db = loadDb(pool);

  const result = await db.setTaskCompletion(input({
    companionUpdates: [{ id: waiting.id, properties: completedWaiting, expectedUpdatedAt: waiting.updated_at }],
  }));

  assert.equal(pool._rows.get("parent").properties.status, "done");
  assert.equal(pool._rows.get("waiting").properties.status, "done");
  assert.equal(result.companionBlocks[0].id, "waiting");
  assert.deepEqual(result.broadcastIds.sort(), ["parent", "waiting"]);

  const failingPool = makePool([parent, waiting], { failUpdateId: "waiting" });
  const failingDb = loadDb(failingPool);
  await assert.rejects(failingDb.setTaskCompletion(input({
    companionUpdates: [{ id: waiting.id, properties: completedWaiting }],
  })), /injected child failure/);
  assert.equal(failingPool._rows.get("parent").properties.status, "open");
  assert.equal(failingPool._rows.get("waiting").properties.status, "open");

  const conflictingPool = makePool([parent, waiting]);
  const conflictingDb = loadDb(conflictingPool);
  await assert.rejects(conflictingDb.setTaskCompletion(input({
    companionUpdates: [{ id: waiting.id, properties: completedWaiting, expectedUpdatedAt: "2026-08-02T00:00:00Z" }],
  })), error => error.statusCode === 409 && error.publicCode === "COMPLETION_COMPANION_CONFLICT");
  assert.equal(conflictingPool._rows.get("parent").properties.status, "open");
  assert.equal(conflictingPool._rows.get("waiting").properties.status, "open");
});
