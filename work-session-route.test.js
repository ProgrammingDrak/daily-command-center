const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function mountApp(startedAt) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = "ws-1";
    req.session = { userId: 7 };
    next();
  });
  const rows = [];
  let task = {
    id: "row-1",
    type: "block",
    date: "2026-09-28",
    user_id: 7,
    workspace_id: "ws-1",
    deleted_at: null,
    properties: {
      local_id: "timer-1",
      type: "task",
      title: "Tracked work",
      status: "open",
      startedAt,
      activeWorkSessionId: "ws-active",
      startedBy: "dcc:7",
      workStateChangedAt: startedAt,
    },
  };
  const blockDB = {
    getBlockIncludingDeleted: async id => id === task.id ? task : null,
    getBlock: async id => id === task.id && !task.deleted_at ? task : null,
    updateBlock: async (_id, patch) => {
      task = { ...task, ...patch, properties: patch.properties === undefined ? task.properties : patch.properties };
      return task;
    },
    getTaskTimeEntries: async blockId => rows.filter(row => row.properties.blockId === blockId && !row.deleted_at),
    createBlock: async input => {
      const row = { ...input, id: input.id || `time-${rows.length + 1}`, deleted_at: null };
      rows.push(row);
      return row;
    },
    ensureDayRoot: async date => `day-root-${date}`,
    getBlocksByDate: async () => [],
    getBlocksByTypes: async () => [],
    getDelegatedItems: async () => [],
    getBlocksByDateRange: async () => [],
    getResponsibilityBlocks: async () => [],
    getBlocksByKind: async () => [],
  };
  require("./routes/blocks")(app, {
    APP_TIME_ZONE: "America/New_York",
    blockDB,
    broadcast() {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: value => value,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-09-28",
    isAllowedSweepBlockItem: () => true,
    isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    pool: { query: async () => ({ rows: [] }) },
  });
  return { app, getTask: () => task, rows };
}

async function post(app, body) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/blocks/row-1/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("continue acknowledges an active timer through the work route", async () => {
  const startedAt = "2026-09-28T13:00:00.000Z";
  const { app, getTask, rows } = mountApp(startedAt);
  const result = await post(app, {
    action: "continue",
    at: "2026-09-28T13:25:00.000Z",
    actionId: "check-in-1",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.changed, true);
  assert.equal(getTask().properties.startedAt, startedAt);
  assert.equal(getTask().properties.workCheckInAt, "2026-09-28T13:25:00.000Z");
  assert.equal(getTask().properties.workCheckInCount, 1);
  assert.equal(rows.length, 0);
});

test("auto-pause closes at the supplied safety cutoff", async () => {
  const { app, getTask, rows } = mountApp("2026-09-29T03:40:00.000Z");
  const result = await post(app, {
    action: "auto-pause",
    at: "2026-09-29T04:30:00.000Z",
    actionId: "work-checkin-auto-pause:timer-1:cutoff",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.changed, true);
  assert.equal(getTask().properties.startedAt, undefined);
  assert.equal(getTask().properties.actualMinutes, 50);
  assert.equal(getTask().properties.workAutoPauseReason, "two-missed-check-ins");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.properties.durSec), [1200, 1800]);
});
