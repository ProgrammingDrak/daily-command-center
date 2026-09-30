const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });
  const rows = {
    "task-1": {
      id: "task-1", type: "block", date: "2026-08-14", user_id: 1, workspace_id: MINE, deleted_at: null,
      properties: { title: "Answer the thread", status: "open", triageId: "slack:dm:D1:1", triageKey: "slack|D1:1" },
    },
  };
  let nextId = 1;
  const slackSync = [];
  const blockDB = {
    VALID_TYPES: new Set(["block"]),
    getBlockIncludingDeleted: async id => rows[id] || null,
    getBlock: async id => rows[id] || null,
    setTaskCompletion: async ({ taskRef, completed, completedAt }) => {
      const row = rows[taskRef];
      row.properties = {
        ...row.properties,
        status: completed ? "done" : "open",
        done: !!completed,
        completedAt: completed ? (completedAt || "2026-08-14T14:00:00Z") : null,
      };
      return { task: row, affectedTasks: [], revision: 2, persistenceTarget: "block", broadcastIds: [row.id] };
    },
    updateBlock: async (id, patch) => {
      rows[id] = { ...rows[id], ...patch, properties: patch.properties || rows[id].properties };
      return rows[id];
    },
    deleteBlock: async id => {
      rows[id] = { ...rows[id], deleted_at: "2026-08-14T14:05:00Z" };
      return rows[id];
    },
    undeleteBlock: async id => {
      rows[id] = { ...rows[id], deleted_at: null };
      return rows[id];
    },
    batchOp: async operations => {
      const blocks = [];
      for (const operation of operations) if (operation.op === "delete") blocks.push(await blockDB.deleteBlock(operation.id));
      return { batchId: "batch-1", blocks };
    },
    isIdempotencyConflict: () => false,
    createBlock: async row => {
      const id = row.id || `suppression-${nextId++}`;
      rows[id] = { id, deleted_at: null, ...row };
      return rows[id];
    },
    getBlocksByKind: async (kind, workspaceId) => Object.values(rows).filter(row =>
      !row.deleted_at && row.workspace_id === workspaceId && (row.properties || {}).kind === kind),
    getDelegatedItems: async () => [],
    findByIdempotencyKey: async (workspaceId, key) => Object.values(rows).find(row =>
      row.workspace_id === workspaceId && (row.properties || {}).idempotency_key === key) || null,
    createItineraryTask: async ({ date, properties, userId, workspaceId }) => {
      const existing = await blockDB.findByIdempotencyKey(workspaceId, properties.idempotency_key);
      if (existing) return existing;
      const id = `task-${nextId++}`;
      const row = { id, type: "block", date, properties, user_id: userId, workspace_id: workspaceId };
      rows[id] = row;
      return row;
    },
  };
  const ctx = {
    blockDB,
    broadcast: () => {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: value => value,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-08-14",
    isAllowedSweepBlockItem: () => true,
    isValidDate: () => true,
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    },
    syncSlackTaskReactions: async row => { slackSync.push(row.id); return true; },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, rows, slackSync, ctx };
}

async function request(app, path, options = {}) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally { server.close(); }
}

function completion(app, completed) {
  return request(app, "/api/tasks/task-1/completion", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ completed, completedAt: completed ? "2026-08-14T14:00:00Z" : null, mutationId: `completion-${completed}` }),
  });
}

test("a published Slack finding becomes a task and gets one bookmark projection", async () => {
  const { ctx, rows, slackSync } = mountApp();
  const item = {
    id: "slack:mention:C123:1786622400.100000", type: "slack", title: "Review the report",
    priority: "normal", channel_id: "C123", message_ts: "1786622400.100000",
    thread_id: "1786622400.100000", source_ref: "https://example.slack.com/archives/C123/p1786622400100000",
  };
  await ctx.materializeScrapedSlackItems({ items: [item], userId: 1, workspaceId: MINE });
  await ctx.materializeScrapedSlackItems({ items: [item], userId: 1, workspaceId: MINE });
  const task = Object.values(rows).find(row => (row.properties || {}).source === "slack-bookmark");
  assert.ok(task);
  assert.equal(task.properties.idempotency_key, "slack-bookmark:C123:1786622400.100000");
  assert.equal(task.properties.triageId, item.id);
  assert.deepEqual(slackSync, [task.id]);
  assert.equal(Object.values(rows).filter(row => (row.properties || {}).source === "slack-bookmark").length, 1);
});

test("linked triage follows task completion, reopen, deletion, and undo", async () => {
  const { app, rows } = mountApp();
  assert.equal((await completion(app, true)).status, 200);
  let suppression = Object.values(rows).find(row => (row.properties || {}).kind === "triage_suppression");
  assert.ok(suppression);
  assert.equal(suppression.properties.reason, "done");

  assert.equal((await completion(app, false)).status, 200);
  suppression = Object.values(rows).find(row => (row.properties || {}).kind === "triage_suppression");
  assert.equal(suppression.properties.reason, "scheduled");
  assert.equal(Object.values(rows).filter(row => (row.properties || {}).kind === "triage_suppression").length, 1);

  const deleted = await request(app, "/api/blocks/batch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations: [{ op: "delete", id: "task-1" }] }),
  });
  assert.equal(deleted.status, 200);
  suppression = Object.values(rows).find(row => (row.properties || {}).kind === "triage_suppression");
  assert.equal(suppression.properties.active, false, "deleting unfinished scheduled work releases it back to triage");

  const restored = await request(app, "/api/blocks/task-1/undelete", { method: "POST" });
  assert.equal(restored.status, 200);
  const active = Object.values(rows).filter(row => (row.properties || {}).kind === "triage_suppression" && row.properties.active !== false);
  assert.equal(active.length, 1);
  assert.equal(active[0].properties.reason, "scheduled");
});


test("deleting a Triage task suppresses its source, and ordinary Undo restores the link", async () => {
  const {app,rows}=mountApp();
  rows["task-1"].properties.triageBlock=true;
  const deleted=await request(app,"/api/blocks/task-1",{method:"DELETE"});
  assert.equal(deleted.status,200);
  const suppression=Object.values(rows).find(row=>(row.properties||{}).kind==="triage_suppression");
  assert.equal(suppression.properties.reason,"deleted");
  assert.equal(suppression.properties.active,true);
  const restored=await request(app,"/api/blocks/task-1/undelete",{method:"POST"});
  assert.equal(restored.status,200);
  const active=Object.values(rows).filter(row=>(row.properties||{}).kind==="triage_suppression"&&row.properties.active!==false);
  assert.equal(active.length,1);
  assert.equal(active[0].properties.reason,"scheduled");
});
