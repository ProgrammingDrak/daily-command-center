const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function mountApp({ setTaskCompletion } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = "ws-1";
    req.session = { userId: 7 };
    next();
  });
  const broadcasts = [];
  let existing = {
    id: "row-1", type: "block", date: "2026-08-10", workspace_id: "ws-1",
    properties: { local_id: "task-1", title: "Keep", status: "open", _completionRevision: "rev-1" },
  };
  const blockDB = {
    setTaskCompletion: setTaskCompletion || (async (input) => ({
      task: { ...existing, properties: { ...existing.properties, status: input.completed ? "done" : "open", done: input.completed, _completionRevision: "rev-2" } },
      affectedTasks: [], revision: "rev-2", persistenceTarget: "task_row",
      duplicate: false, broadcastIds: ["row-1"],
    })),
    getBlockIncludingDeleted: async () => existing,
    getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
    getBlock: async () => null,
    updateBlock: async (_id, input = {}) => {
      existing = {
        ...existing,
        ...input,
        properties: input.properties === undefined ? existing.properties : input.properties,
      };
      return existing;
    },
    batchOp: async () => ({ batchId: "b", blocks: [] }),
    reorderBlocks: async () => {},
    getBlocksByDate: async () => [],
    getBlocksByTypes: async () => [],
    getDelegatedItems: async () => [],
    getBlocksByDateRange: async () => [],
    getResponsibilityBlocks: async () => [],
    getBlocksByKind: async () => [],
  };
  require("./routes/blocks")(app, {
    blockDB,
    broadcast: (event, payload, workspaceId) => broadcasts.push({ event, payload, workspaceId }),
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: value => value,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-08-10",
    isAllowedSweepBlockItem: () => true,
    isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    pool: { query: async () => ({ rows: [] }) },
    APP_TIME_ZONE: "America/New_York",
  });
  return { app, broadcasts };
}

async function request(app, path, method, body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("dedicated completion route returns an authoritative acknowledged task", async () => {
  const inputs = [];
  const { app, broadcasts } = mountApp({ setTaskCompletion: async input => {
    inputs.push(input);
    return {
      task: { id: "row-1", type: "block", date: input.taskDate, properties: { title: "Keep", status: "done", done: true, _completionRevision: "rev-2" } },
      affectedTasks: [], revision: "rev-2", persistenceTarget: "task_row",
      duplicate: false, broadcastIds: ["row-1"],
    };
  } });
  const response = await request(app, "/api/tasks/row-1/completion", "POST", {
    completed: true, completedAt: "2026-08-10T15:00:00Z", taskDate: "2026-08-10",
    mutationId: "mutation-1", expectedRevision: "rev-1", _clientId: "tab-1",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.task.properties.title, "Keep");
  assert.equal(response.body.task.properties.status, "done");
  assert.ok(response.body.requestId);
  assert.ok(response.headers.get("x-request-id"));
  assert.deepEqual(inputs[0], {
    taskRef: "row-1", completed: true, completedAt: "2026-08-10T15:00:00Z",
    taskDate: "2026-08-10", mutationId: "mutation-1", expectedRevision: "rev-1",
    userId: 7, workspaceId: "ws-1",
  });
  assert.deepEqual(broadcasts[0].payload.blockIds, ["row-1"]);
});

test("completion errors expose code, retryability, request id, and current task", async () => {
  const currentTask = { id: "row-1", properties: { status: "open", _completionRevision: "newer" } };
  const { app } = mountApp({ setTaskCompletion: async () => {
    const error = new Error("Task completion changed since this edit was created");
    error.statusCode = 409;
    error.publicCode = "COMPLETION_CONFLICT";
    error.currentTask = currentTask;
    throw error;
  } });
  const response = await request(app, "/api/tasks/row-1/completion", "POST", {
    completed: true, taskDate: "2026-08-10", mutationId: "mutation-1", expectedRevision: "old",
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "COMPLETION_CONFLICT");
  assert.equal(response.body.retryable, false);
  assert.deepEqual(response.body.currentTask, currentTask);
  assert.ok(response.body.requestId);
});

test("legacy PATCH completion delegates to the narrow completion service", async () => {
  const inputs = [];
  const { app } = mountApp({ setTaskCompletion: async input => {
    inputs.push(input);
    return {
      task: { id: "row-1", type: "block", date: "2026-08-10", properties: { title: "Keep", status: "done", done: true, _completionRevision: "rev-2" } },
      affectedTasks: [], revision: "rev-2", persistenceTarget: "task_row", broadcastIds: ["row-1"],
    };
  } });
  const response = await request(app, "/api/blocks/row-1", "PATCH", {
    properties: { title: "Stale title", status: "done", done: true, completedAt: "2026-08-10T15:00:00Z" },
    completionIntent: "complete", completionMutationId: "legacy-1", completionBaseRevision: "rev-1",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.properties.title, "Keep", "stale full properties were not applied");
  assert.equal(inputs[0].completed, true);
  assert.equal(inputs[0].expectedRevision, "rev-1");
});
