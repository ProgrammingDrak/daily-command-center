const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-08-14";

function waitingRow() {
  return {
    id: "waiting-1",
    type: "block",
    date: null,
    workspace_id: MINE,
    user_id: 1,
    created_at: "2026-08-07T12:00:00.000Z",
    properties: {
      kind: "delegated_item",
      myTask: "Launch plan",
      title: "Legal approval",
      waitingReason: "blocked",
      delegatee: { name: "Alex", kind: "person" },
      contact: { channel: "gmail", address: "alex@example.com", sourceRef: "https://mail.google.com/thread/1" },
      checkInDate: TODAY,
      checkInDays: 7,
      status: "open",
    },
  };
}

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });
  const waiting = waitingRow();
  const task = {
    id: "task-1", type: "block", date: TODAY, workspace_id: MINE, user_id: 1,
    properties: { kind: "task", title: "Launch plan", local_id: "launch-plan" },
  };
  const rows = new Map([[waiting.id, waiting], [task.id, task]]);
  const updates = [];
  const ctx = {
    blockDB: {
      getDelegatedItems: async () => [waiting].filter(row => !row.deleted_at),
      getBlockIncludingDeleted: async id => rows.get(id) || null,
      getBlock: async id => rows.get(id) || null,
      updateBlock: async (id, patch) => {
        const row = rows.get(id);
        if (patch.properties) row.properties = patch.properties;
        updates.push({ id, patch });
        return row;
      },
      createBlock: async () => null,
      deleteBlock: async id => ({ id }),
      getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
      batchOp: async () => ({ batchId: "b", blocks: [] }),
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getRescheduleSubtreePool: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
    },
    broadcast: () => {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: rows => rows,
    getScheduleBlocks: async () => [],
    getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
    APP_TIME_ZONE: "America/New_York",
    waitingItems: require("./waiting-items"),
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, waiting, task, updates };
}

async function request(app, path, method = "GET", body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("attention returns one stable internal draft for a due Waiting cycle", async () => {
  const { app } = mountApp();
  const result = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].attentionScore, 100);
  assert.equal(result.body.draft_items[0].id, "waiting-checkin:waiting-1:" + TODAY);
  assert.equal(result.body.draft_items[0].draft_type, "internal");
  assert.match(result.body.draft_items[0].draft_preview, /Hi Alex/);
  assert.equal(result.body.draft_items[0].waiting_item_id, "waiting-1");
});

test("snooze removes Waiting from attention until the chosen day", async () => {
  const { app, waiting } = mountApp();
  const snoozed = await request(app, "/api/waiting-items/waiting-1/snooze", "POST", { until: "2026-08-16" });
  assert.equal(snoozed.status, 200);
  assert.equal(waiting.properties.snoozedUntil, "2026-08-16");
  const attention = await request(app, "/api/waiting-items/attention?date=" + TODAY);
  assert.deepEqual(attention.body.items, []);
});

test("scheduling a check-in ties the cadence to a real 15-minute task date", async () => {
  const { app, waiting, task } = mountApp();
  task.date = "2026-08-15";
  const wrong = await request(app, "/api/waiting-items/waiting-1/check-ins/schedule", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(wrong.status, 400);
  task.date = TODAY;
  const scheduled = await request(app, "/api/waiting-items/waiting-1/check-ins/schedule", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(scheduled.status, 200);
  assert.equal(waiting.properties.checkInTaskId, task.id);
  assert.equal(waiting.properties.checkInDate, TODAY);
});

test("completing a check-in rejects an invalid timestamp without losing the next reminder", async () => {
  const { app, waiting, updates } = mountApp();
  const result = await request(app, "/api/waiting-items/waiting-1/check-ins/complete", "POST", {
    cycleKey: "waiting:waiting-1:" + TODAY,
    completedAt: "not-a-time",
  });
  assert.equal(result.status, 400);
  assert.equal(waiting.properties.checkInDate, TODAY);
  assert.equal(updates.length, 0);
});

test("unblock only closes Waiting after its underlying task is on the requested day", async () => {
  const { app, waiting, task } = mountApp();
  task.date = "2026-08-15";
  const refused = await request(app, "/api/waiting-items/waiting-1/unblock", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(refused.status, 400);
  assert.equal(waiting.properties.status, "open");
  task.date = TODAY;
  const result = await request(app, "/api/waiting-items/waiting-1/unblock", "POST", { date: TODAY, taskBlockId: task.id });
  assert.equal(result.status, 200);
  assert.equal(waiting.properties.status, "unblocked");
  assert.equal(waiting.properties.unblockedTaskId, task.id);
});
