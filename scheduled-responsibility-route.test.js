const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const TODAY = "2026-07-11";
const WORKSPACE = "ws-1";

function scheduledDefinition() {
  return {
    id: "series-1", type: "block", date: null, workspace_id: WORKSPACE,
    properties: {
      kind: "responsibility_item", repeatType: "scheduled", status: "active",
      title: "Hydrate", estimatedMinutes: 5,
      scheduleRule: {
        version: 1, patternType: "calendar", timeZone: "America/New_York",
        startDate: TODAY, frequency: "daily", interval: 1,
        times: ["09:00", "17:00"], end: { type: "never" },
      },
    },
  };
}

function mount() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = WORKSPACE; req.session = { userId: 1 }; next(); });
  const definition = scheduledDefinition();
  const rows = [];
  const calls = { ensure: [], create: [], batch: [] };
  const blockDB = {
    VALID_TYPES: new Set(["block"]),
    async ensureDayRoot(date) { calls.ensure.push(date); return `day-root-${date}`; },
    async getResponsibilityBlocks() { return [definition]; },
    async getBlocksByIdempotencyKeys(_ws, keys) { return rows.filter((row) => keys.includes((row.properties || {}).idempotency_key)); },
    async createItineraryTasks(items) {
      calls.create.push(items);
      const created = items.map((item) => ({ ...item, type: "block", workspace_id: WORKSPACE }));
      rows.push(...created);
      return created;
    },
    isIdempotencyConflict() { return false; },
    async getBlocksByDate(date) { return rows.filter((row) => row.date === date && !row.deleted_at); },
    async getBlocksByTypes() { return []; },
    async getBlocksByDateRange() { return []; },
    async getBlock(id) { return id === definition.id ? definition : rows.find((row) => row.id === id) || null; },
    async getRepeatSeriesBlocks(seriesId) { return rows.filter((row) => (row.properties || {}).repeatSeriesId === seriesId && !row.deleted_at); },
    async batchOp(ops) {
      calls.batch.push(ops);
      for (const op of ops) {
        const row = rows.find((item) => item.id === op.id);
        if (row && op.op === "delete") row.deleted_at = new Date().toISOString();
        if (row && op.op === "update") { row.properties = op.properties || row.properties; row.date = op.date || row.date; }
      }
      return { batchId: "batch-1", blocks: ops.map((op) => ({ id: op.id })) };
    },
    async updateBlock(id, fields) { const row = id === definition.id ? definition : rows.find((item) => item.id === id); if (row) Object.assign(row, fields); return row; },
    async getBlockIncludingDeleted(id) { return id === definition.id ? definition : rows.find((row) => row.id === id) || null; },
    async deleteBlock(id) {
      const row = id === definition.id ? definition : rows.find((item) => item.id === id);
      if (row) row.deleted_at = new Date().toISOString();
      return row;
    },
    async getDelegatedItems() { return []; },
    async getBlocksByKind() { return []; },
    async getRescheduleSubtreePool() { return []; },
    async batchOpWithIdempotency() { return { batchId: "b", blocks: [] }; },
  };
  require("./routes/blocks.js")(app, {
    blockDB, broadcast() {}, crypto: require("node:crypto"), filterLegacyGcalBlocks: (value) => value,
    getScheduleBlocks: async () => [], getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    isValidDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)),
    pool: { query: async () => ({ rows: [] }) }, APP_TIME_ZONE: "America/New_York",
  });
  return { app, rows, calls };
}

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/blocks?date materializes scheduled occurrences before returning the day", async () => {
  const { app, calls } = mount();
  const response = await request(app, "GET", `/api/blocks?date=${TODAY}`);
  assert.equal(response.status, 200);
  const repeats = response.body.filter((row) => (row.properties || {}).idempotency_key);
  assert.equal(repeats.length, 2);
  assert.deepEqual(repeats.map((row) => row.properties.start), ["09:00", "17:00"]);
  assert.equal(calls.create.length, 1);
});

test("opening a past day still catches scheduled series up through today", async () => {
  const { app, calls } = mount();
  const response = await request(app, "GET", "/api/blocks?date=2026-07-10");
  assert.equal(response.status, 200);
  assert.equal(calls.create.length, 1);
  assert.ok(calls.create[0].every((row) => row.date === TODAY));
});

test("preview endpoint returns normalized summary and five future occurrences", async () => {
  const { app } = mount();
  const response = await request(app, "POST", "/api/responsibilities/preview", {
    scheduleRule: scheduledDefinition().properties.scheduleRule,
  });
  assert.equal(response.status, 200);
  assert.match(response.body.summary, /^Every day at 09:00, 17:00/);
  assert.equal(response.body.nextOccurrences.length, 5);
});

test("series-change occurrence delete soft-deletes the selected generated occurrence", async () => {
  const { app, rows, calls } = mount();
  await request(app, "GET", `/api/blocks?date=${TODAY}`);
  const target = rows.find((row) => row.properties.idempotency_key && row.properties.repeatOccurrenceKey === `${TODAY}T09:00`);
  const response = await request(app, "POST", "/api/responsibilities/series-1/series-change", {
    action: "delete", scope: "occurrence", occurrenceKey: `${TODAY}T09:00`, blockId: target.id,
  });
  assert.equal(response.status, 200);
  assert.ok(calls.batch.at(-1).some((op) => op.op === "delete" && op.id === target.id));
});

test("generic block deletion routes a scheduled definition through series cleanup", async () => {
  const { app, rows, calls } = mount();
  await request(app, "GET", `/api/blocks?date=${TODAY}`);
  const response = await request(app, "DELETE", "/api/blocks/series-1");
  assert.equal(response.status, 200);
  assert.ok(calls.batch.at(-1).some((op) => op.op === "delete" && op.id === "series-1"));
  assert.ok(rows.filter((row) => (row.properties || {}).idempotency_key)
    .every((row) => row.deleted_at), "open generated occurrences are removed with the series");
});
