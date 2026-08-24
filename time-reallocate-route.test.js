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
  const createCalls = [];
  const broadcasts = [];
  const dayRootCalls = [];
  const find = (id) => store.find((row) => row.id === id) || null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const ctx = {
    blockDB: {
      getBlock: async (id, _client) => find(id),
      // The real one folds `deleted_at IS NULL` and `workspace_id IS NOT DISTINCT FROM`
      // into the query and falls back to properties->>'local_id'. Modelling only the id
      // lookup would hide the local_id path the picker actually exercises.
      findUniqueLiveBlockByReference: async (ref, workspaceId) => {
        const live = store.filter((row) => !row.deleted_at
          && (row.workspace_id == null || workspaceId == null || row.workspace_id === workspaceId));
        const direct = live.find((row) => row.id === ref);
        if (direct) return direct;
        const byLocal = live.filter((row) => (row.properties || {}).local_id === ref);
        if (byLocal.length > 1) { const e = new Error("Task reference is ambiguous"); e.statusCode = 409; throw e; }
        return byLocal[0] || null;
      },
      getBlockIncludingDeleted: async (id, _client, _forUpdate) => find(id),
      updateBlock: async (id, patch, _client) => {
        const row = find(id);
        if (!row) throw new Error("missing " + id);
        if (patch.properties !== undefined) row.properties = patch.properties;
        return row;
      },
      createBlock: async (input, _client) => {
        const row = { deleted_at: null, ...input, properties: input.properties || {} };
        store.push(row);
        return row;
      },
      deleteBlock: async (id, _client) => { const row = find(id); if (row) row.deleted_at = new Date().toISOString(); return { id }; },
      undeleteBlock: async (id, _client) => { const row = find(id); if (row) row.deleted_at = null; return row; },
      ensureDayRoot: async (date, _userId, _workspaceId, _client) => { dayRootCalls.push(date); return `day-root-${date}`; },
      createItineraryTask: async (args) => {
        const row = {
          id: `made-${created.length + 1}`, type: "block", date: args.date,
          properties: { kind: "task", type: "task", status: "open", ...(args.properties || {}) },
          user_id: args.userId, workspace_id: args.workspaceId, deleted_at: null,
        };
        created.push(row);
        createCalls.push(args);
        store.push(row);
        return row;
      },
      getTaskTimeEntries: async (blockId, workspaceId, opts = {}, _client) => store.filter((row) => row.type === "time_entry"
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
    // reallocateTimeEntry owns a BEGIN/COMMIT, so the ctx pool has to supply a client.
    // Rollback is exercised properly in time-reallocation.test.js; here the route's own
    // validation ordering is what matters, so the client just passes writes through.
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    },
    APP_TIME_ZONE: "America/New_York",
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, store, created, createCalls, dayRootCalls, broadcasts, find };
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
  // The route asks for scoring and the real createItineraryTask acts on it. Without
  // this the flag could be dropped and every creation test would still pass, shipping
  // 0-point tasks into a points-driven itinerary.
  assert.equal(h.createCalls[0].score, true, "a task minted to hold real time still earns its points");
  assert.ok(h.createCalls[0].client, "created inside the mover's transaction, so a rollback takes it with it");
  assert.equal(h.createCalls[0].ensureRoot, false,
    "and its day root is ensured through that client, because createItineraryTask does not pass one on");
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

// ── the regressions the five-lane review found ───────────────────────────────

test("a replayed WHOLE move is answered, not 404'd", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const first = await post(h.app, "seg", { parts: [{ taskId: "b" }], actionId: "submit-1" });
  assert.equal(first.body.changed, true);
  assert.equal(live(h, "a").length, 0, "the source row is gone after a whole move");

  // The source is a tombstone now, so a naive order would 404 the retry and tell a
  // client whose write landed that its time went missing.
  const replay = await post(h.app, "seg", { parts: [{ taskId: "b" }], actionId: "submit-1" });
  assert.equal(replay.status, 200, "a retry of a completed move is not an error");
  assert.equal(replay.body.changed, false);
  assert.equal(replay.body.reason, "duplicate");
  assert.equal(h.find("b").properties.actualMinutes, 60, "and b did not gain a second hour");
});

test("a destination picked by local_id resolves instead of 404ing", async () => {
  // TaskModel.fromBlock sets a task's id to `local_id || block.id`, and the picker sends
  // `task._blockId || task.id`, so for any row carrying a local_id the client sends one.
  const dest = task("b", {}, { local_id: "ev-b-1" });
  const h = harness({ rows: [task("a"), dest, segment("seg", "a", 3600)] });
  const { status, body } = await post(h.app, "seg", { parts: [{ taskId: "ev-b-1" }] });
  assert.equal(status, 200, "a validly picked destination is not missing");
  assert.equal(body.changed, true);
  assert.equal(h.find("b").properties.actualMinutes, 60);
});

test("a segment whose blockId names another workspace's task is refused", async () => {
  const foreign = task("theirs", { workspace_id: "ws-other" }, { title: "Their work" });
  foreign.properties.actualMinutes = 90;
  const h = harness({ rows: [task("mine"), foreign, segment("seg", "theirs", 3600)] });
  // The segment itself is ours, so assertBlockOwnership on it passes; the ORIGIN is the
  // foreign row, and db.updateBlock has no tenant predicate.
  const { status } = await post(h.app, "seg", { parts: [{ taskId: "mine" }] });
  assert.equal(status, 404);
  assert.equal(h.find("theirs").properties.actualMinutes, 90, "their minutes are untouched");
  assert.equal(live(h, "theirs").length, 1, "and the segment never moved");
});

test("day-root lookups do not grow with the number of pieces", async () => {
  // Two layers each ensure once for the one date involved (the route for the tasks it
  // creates, the store for the segment rows), so the absolute count is 2. The invariant
  // worth pinning is that it is FLAT: it was previously one lookup per piece and per
  // created task, against db.createItineraryTasks' own ensure-each-date-once rule.
  async function lookupsFor(parts, rows) {
    const h = harness({ rows });
    const { status } = await post(h.app, "seg", { parts });
    assert.equal(status, 200);
    return { count: h.dayRootCalls.length, dates: [...new Set(h.dayRootCalls)], created: h.created.length };
  }
  const small = await lookupsFor(
    [{ minutes: 20, newTask: { title: "First" } }, { taskId: "a" }],
    [task("a"), segment("seg", "a", 3600)],
  );
  const big = await lookupsFor(
    [
      { minutes: 10, newTask: { title: "First" } },
      { minutes: 10, newTask: { title: "Second" } },
      { minutes: 10, newTask: { title: "Third" } },
      { taskId: "a" },
    ],
    [task("a"), segment("seg", "a", 3600)],
  );
  assert.equal(small.created, 1);
  assert.equal(big.created, 3);
  assert.deepEqual(small.dates, ["2026-08-20"], "only the segment's own day");
  assert.deepEqual(big.dates, ["2026-08-20"]);
  assert.equal(big.count, small.count, "four pieces cost the same lookups as two");
});

test("over the part ceiling is refused before any task is created", async () => {
  const h = harness({ rows: [task("a"), segment("seg", "a", 3600)] });
  const parts = new Array(13).fill(null).map(() => ({ minutes: 1, newTask: { title: "x" } }));
  const { status, body } = await post(h.app, "seg", { parts });
  assert.equal(status, 400);
  assert.equal(body.code, "TIME_ALLOCATION_INVALID");
  assert.equal(h.created.length, 0, "the ceiling is enforced before the first side effect");
});

// ── iteration 2 of the review ────────────────────────────────────────────────

test("an absurdly long segment is refused before it can fan out", async () => {
  // The PIECE count was capped but the SOURCE LENGTH was not, and per-piece midnight
  // splitting multiplies them: splitSessionByLocalDay emits one row per local day up to
  // its 370-day guard, and the guard TRUNCATES, so time is silently lost as well.
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 4440 * 24 * 3600)] });
  const { status, body } = await post(h.app, "seg", { parts: [{ taskId: "b" }] });
  assert.equal(status, 400);
  assert.equal(body.code, "TIME_ALLOCATION_INVALID");
  assert.equal(live(h, "a").length, 1, "nothing was written");
  // A long-but-plausible segment still moves: 16h is reconcileTiming's own ceiling.
  const ok = harness({ rows: [task("a"), task("b"), segment("seg", "a", 16 * 3600)] });
  assert.equal((await post(ok.app, "seg", { parts: [{ taskId: "b" }] })).status, 200);
});

test("a committed operation is answered without writing anything", async () => {
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const first = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }], actionId: "submit-1" });
  assert.equal(first.body.changed, true);
  const snapshot = JSON.stringify(h.store);

  // The stamp is written in the same transaction as the work, so it means COMMITTED.
  // There is no half-applied state to resume and nothing for a replay to repair.
  const replay = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }], actionId: "submit-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.changed, false);
  assert.equal(replay.body.reason, "duplicate");
  assert.equal(JSON.stringify(h.store), snapshot, "a replay writes nothing");
});

test("a forged resume stamp has nothing left to steer", async () => {
  // The previous design stamped its resume state (touched ids, prior totals) into a
  // time_entry's properties, which PATCH /api/blocks/:id writes verbatim. A forged list
  // drove one request into thousands of write transactions. Those fields are gone, and
  // the only stamp left is compared for equality and never iterated.
  const h = harness({ rows: [task("a"), task("b"), segment("seg", "a", 3600)] });
  const source = h.find("seg");
  source.properties.reallocationTouchedIds = new Array(500).fill("a");
  source.properties.reallocationPriorTotals = { a: -1000000 };
  source.properties.reallocationSettledAt = "2020-01-01T00:00:00.000Z";

  const { status, body } = await post(h.app, "seg", { parts: [{ minutes: 20, taskId: "b" }, { taskId: "a" }], actionId: "fresh-1" });
  assert.equal(status, 200);
  assert.equal(body.changed, true);
  assert.equal(h.find("a").properties.actualMinutes, 40, "the forged prior totals did not inflate anything");
  assert.equal(h.find("b").properties.actualMinutes, 20);
  // And the forged bookkeeping is not carried onto the rows this operation wrote.
  for (const row of h.store.filter((r) => r.type === "time_entry" && !r.deleted_at)) {
    assert.equal(row.properties.reallocationTouchedIds, undefined);
    assert.equal(row.properties.reallocationPriorTotals, undefined);
    assert.equal(row.properties.reallocationSettledAt, undefined);
  }
});
