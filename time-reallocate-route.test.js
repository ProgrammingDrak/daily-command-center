// POST /api/time-entries/:id/reallocate — the HTTP half of "tracked time is
// transferrable and splittable".
//
// The store half is pinned in time-reallocation.test.js. Everything the ROUTE
// owns is invisible from there and every branch of it is a way to lose or
// misattribute time: which rows count as a legal destination, the
// tombstone-inclusive getBlock trap, creating the destination task from a typed
// title, and the replay guard. routes/blocks.js is an (app, ctx) factory, so it
// mounts on a bare express app with fake stores — same harness as
// tasks-open-route.test.js, with req.workspaceId / req.session injected the way
// server middleware supplies them.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-08-21";

function harness({ rows = [] } = {}) {
  const store = rows.slice();
  const created = [];
  const broadcasts = [];
  const find = (id) => store.find((row) => row.id === id) || null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const ctx = {
    blockDB: {
      getBlock: async (id) => find(id),
      getBlockIncludingDeleted: async (id) => find(id),
      updateBlock: async (id, patch) => {
        const row = find(id);
        if (!row) throw new Error("missing " + id);
        if (patch.properties !== undefined) row.properties = patch.properties;
        return row;
      },
      createBlock: async (input) => {
        const row = { deleted_at: null, ...input, properties: input.properties || {} };
        store.push(row);
        return row;
      },
      deleteBlock: async (id) => { const row = find(id); if (row) row.deleted_at = new Date().toISOString(); return { id }; },
      undeleteBlock: async (id) => { const row = find(id); if (row) row.deleted_at = null; return row; },
      ensureDayRoot: async (date) => `day-root-${date}`,
      createItineraryTask: async ({ date, properties, userId, workspaceId }) => {
        const row = {
          id: `made-${created.length + 1}`, type: "block", date, properties,
          user_id: userId, workspace_id: workspaceId, deleted_at: null,
        };
        created.push(row);
        store.push(row);
        return row;
      },
      getTaskTimeEntries: async (blockId, workspaceId, opts = {}) => store.filter((row) => row.type === "time_entry"
        && (row.properties || {}).blockId === blockId
        && row.workspace_id === workspaceId
        && (opts.includeDeleted || !row.deleted_at)),
      // Unused by this route, present so the module mounts.
      getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
      batchOp: async () => ({ batchId: "b", blocks: [] }),
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getDelegatedItems: async () => [],
      getRescheduleSubtreePool: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
    },
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (b) => b,
    getScheduleBlocks: async () => [],
    getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)),
    pool: { query: async () => ({ rows: [] }) },
    APP_TIME_ZONE: "America/New_York",
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, store, created, broadcasts, find };
}

async function post(app, id, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/time-entries/${encodeURIComponent(id)}/reallocate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function task(id, extra = {}, props = {}) {
  return {
    id, type: "block", date: "2026-08-20",
    // `kind: "task"` is what makes the row addressable as an itinerary ev, which
    // is exactly what isWorkTaskRow demands of a landing spot.
    properties: { title: id, type: "task", kind: "task", status: "open", start: "09:00", end: "10:00", ...props },
    user_id: 1, workspace_id: MINE, deleted_at: null, ...extra,
  };
}

function segment(id, blockId, durSec = 3600, extra = {}) {
  return {
    id, type: "time_entry", date: "2026-08-20",
    properties: {
      blockId, taskTitle: blockId, durSec, source: "work-session",
      startedAt: "2026-08-20T13:00:00.000Z", endedAt: "2026-08-20T14:00:00.000Z",
      start: "09:00", end: "10:00", workSessionId: "ws-abc",
    },
    user_id: 1, workspace_id: MINE, deleted_at: null, ...extra,
  };
}

const live = (h, taskId) => h.store.filter((row) => row.type === "time_entry"
  && (row.properties || {}).blockId === taskId && !row.deleted_at);

// ── what counts as a segment ─────────────────────────────────────────────────

test("only a live time_entry can be reallocated", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("gone", "a", 3600, { deleted_at: "2026-08-20T15:00:00Z" })] });
  assert.equal((await post(h.app, "nope", { parts: [{ taskId: "b" }] })).status, 404);
  assert.equal((await post(h.app, "gone", { parts: [{ taskId: "b" }] })).status, 404, "a tombstoned segment is not found");
  // A task row is not a segment, and must not be treated as one.
  assert.equal((await post(h.app, "a", { parts: [{ taskId: "b" }] })).status, 404);
});

test("a cross-workspace segment reads as absent", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600, { workspace_id: "ws-other" })] });
  const { status } = await post(h.app, "seg", { parts: [{ taskId: "b" }] });
  assert.equal(status, 404);
});

// ── what counts as a destination ─────────────────────────────────────────────

test("a destination must exist, be ours, be live, and be a task", async () => {
  const h = harness({
    rows: [
      task("a"), segment("seg", "a"),
      task("theirs", { workspace_id: "ws-other" }),
      task("dead", { deleted_at: "2026-08-20T15:00:00Z" }),
      // A day_root is neither a task nor trackable work.
      { id: "day-root-2026-08-20", type: "day_root", date: "2026-08-20", properties: {}, workspace_id: MINE, deleted_at: null },
    ],
  });
  assert.equal((await post(h.app, "seg", { parts: [{ taskId: "missing" }] })).status, 404);
  assert.equal((await post(h.app, "seg", { parts: [{ taskId: "theirs" }] })).status, 404, "no cross-tenant landing spot");
  // getBlock is tombstone-inclusive, so this is the branch that would otherwise
  // file real time onto a row nothing renders.
  assert.equal((await post(h.app, "seg", { parts: [{ taskId: "dead" }] })).status, 404);
  const notTask = await post(h.app, "seg", { parts: [{ taskId: "day-root-2026-08-20" }] });
  assert.equal(notTask.status, 400);
  assert.equal(notTask.body.code, "WORK_NOT_TRACKABLE");
  assert.equal(live(h, "a").length, 1, "every refusal left the segment where it was");
});

test("a piece with no destination at all is refused", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a")] });
  const blank = await post(h.app, "seg", { parts: [{}] });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, "TIME_ALLOCATION_INVALID");
  assert.equal((await post(h.app, "seg", { parts: [{ newTask: { title: "   " } }] })).status, 400);
  assert.equal((await post(h.app, "seg", { parts: [] })).status, 400, "no pieces");
});

test("moving time onto the task it is already on is a no-op, not a write", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a")] });
  const same = await post(h.app, "seg", { parts: [{ taskId: "a" }] });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, "TIME_ALLOCATION_NOOP");
});

// ── the plan ─────────────────────────────────────────────────────────────────

test("a plan that would not conserve the tracked time is refused whole", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const over = await post(h.app, "seg", { parts: [{ minutes: 90, taskId: "b" }, { taskId: "a" }] });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, "TIME_ALLOCATION_INVALID");
  assert.equal(live(h, "a")[0].properties.durSec, 3600, "the segment is untouched");
  assert.equal(h.created.length, 0, "and no task was created for a plan that never ran");
});

test("a split lands the pieces and updates both tasks", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const { status, body } = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }] });
  assert.equal(status, 200);
  assert.equal(body.changed, true);
  assert.equal(live(h, "b")[0].properties.durSec, 1200);
  assert.equal(live(h, "a")[0].properties.durSec, 2400);
  assert.equal(h.find("a").properties.actualMinutes, 40);
  assert.equal(h.find("b").properties.actualMinutes, 20);
  const event = h.broadcasts.find((entry) => entry.payload.action === "time-reallocate");
  assert.ok(event, "the change is broadcast");
  assert.deepEqual(event.payload.blockIds.sort(), ["a", "b"]);
  assert.equal(event.payload.date, "2026-08-20");
});

// ── creating the destination from a typed title ──────────────────────────────

test("a typed title becomes a real task on the segment's own day", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a", 1800)] });
  const { status, body } = await post(h.app, "seg", { parts: [{ newTask: { title: "Unplanned firefight" } }] });
  assert.equal(status, 200);
  assert.equal(h.created.length, 1);
  const made = h.created[0];
  assert.equal(made.date, "2026-08-20", "the day the work happened, not today");
  assert.equal(made.properties.title, "Unplanned firefight");
  assert.equal(made.properties.status, "open");
  assert.equal(made.properties.estimatedMinutes, 30, "the estimate matches the time being filed onto it");
  assert.equal(made.workspace_id, MINE);
  assert.deepEqual(body.createdTasks, [{ id: made.id, title: "Unplanned firefight" }]);
  assert.equal(live(h, made.id).length, 1);
  assert.equal(h.find(made.id).properties.actualMinutes, 30);
  assert.equal(live(h, "a").length, 0);
});

test("a split can keep part and send the rest to a brand new task", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a", 3600)] });
  const { status } = await post(h.app, "seg", {
    parts: [{ minutes: 45, taskId: "a" }, { newTask: { title: "Slack rabbit hole" } }],
  });
  assert.equal(status, 200);
  assert.equal(h.find("a").properties.actualMinutes, 45);
  assert.equal(h.find(h.created[0].id).properties.actualMinutes, 15);
});

test("an absurd title is refused before anything is written", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a")] });
  const { status } = await post(h.app, "seg", { parts: [{ newTask: { title: "x".repeat(201) } }] });
  assert.equal(status, 400);
  assert.equal(h.created.length, 0);
  assert.equal(live(h, "a").length, 1);
});

// ── replay ───────────────────────────────────────────────────────────────────

test("a replayed submission is answered, not applied a second time", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const first = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }], actionId: "submit-1" });
  assert.equal(first.body.changed, true);
  const replay = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }], actionId: "submit-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.changed, false);
  assert.equal(replay.body.reason, "duplicate");
  assert.equal(h.find("a").properties.actualMinutes, 40, "no second slice came off");
  assert.equal(h.find("b").properties.actualMinutes, 20);
});

test("a malformed action id is rejected rather than stored", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a")] });
  const { status } = await post(h.app, "seg", { parts: [{ taskId: "b" }], actionId: "bad id!" });
  assert.equal(status, 400);
  assert.equal(live(h, "a").length, 1);
});
