// The server half of the delete contract: what a tombstone means to each route.
//
// #253 made deletion durable; B1 (#256) made the client delete immediately and undo by
// calling the server. A2 is the server side of that: a tombstone is GONE to a reader,
// still VISIBLE to a mutator (so a repeat delete stays idempotent and authorization
// cannot be dodged by deleting a row first), restorable through /undelete, and never a
// thing a materializer re-creates.
//
// routes/blocks.js is an (app, ctx) factory, so it mounts on a bare express app with
// fake stores — the same harness as blocks-batch-authz.test.js. req.workspaceId and
// req.session come from server middleware in the real app, so they are injected here.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const FOREIGN = "ws-someone-else";
const TOMB = "2026-07-29T10:00:00Z";

function makeBlocks() {
  return {
    "live-1": { id: "live-1", type: "block", date: "2026-07-30", workspace_id: MINE, properties: { title: "Alive" }, deleted_at: null },
    "gone-1": { id: "gone-1", type: "block", date: "2026-07-30", workspace_id: MINE, properties: { title: "Deleted" }, deleted_at: TOMB },
    "theirs-gone": { id: "theirs-gone", type: "block", date: "2026-07-30", workspace_id: FOREIGN, properties: { title: "Theirs" }, deleted_at: TOMB },
    "ph-gone": { id: "ph-gone", type: "block", date: "2026-07-30", workspace_id: MINE, properties: { kind: "placeholder_task", isPlaceholder: true, local_id: "ph-1", start: "09:00", duration: 30 }, deleted_at: TOMB },
    // A preset group with two items, for the double-book guard below.
    "grp-1": { id: "grp-1", type: "block", date: null, workspace_id: MINE, deleted_at: null, properties: {
      kind: "task_group", title: "Morning routine",
      items: [{ local_id: "i1", title: "Inbox zero", duration: 30 }, { local_id: "i2", title: "Standup prep", duration: 15 }],
    } },
  };
}

// A row the group already put on the day. `deletedAt` makes it the tombstone case.
function groupTask(id, deletedAt = null) {
  return { id, type: "block", date: "2026-07-30", workspace_id: MINE, deleted_at: deletedAt,
    properties: { title: "Inbox zero", taskGroupId: "grp-1", local_id: "tg-task-x", start: "09:00", end: "09:30" } };
}

function mountApp(extraBlocks = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const blocks = { ...makeBlocks(), ...extraBlocks };
  const calls = { undelete: [], created: [], deleted: [], getBlock: [], dayLoads: [] };
  const broadcasts = [];

  const ctx = {
    blockDB: {
      getBlockIncludingDeleted: async (id) => blocks[id] || null,
      // FAITHFUL to db.js:523 — the real getBlock is `SELECT * FROM blocks WHERE id = $1`
      // with NO deleted_at filter, so it serves tombstones. Modelling it as live-only
      // would be a fake stricter than reality, and it would silently defeat the read
      // tests below: a revert of GET /:id back to `getBlock() -> if (!block) 404` would
      // 404 in the harness (fake returned null) while serving the tombstone with a 200 in
      // production. The call is recorded instead, so the read routes assert the contract
      // directly. responsibility-store's getKindedBlock/getResponsibilityBlock are built
      // from this same fake and do still call getBlock, which is the other reason it has
      // to behave like the real one.
      getBlock: async (id) => { calls.getBlock.push(id); return blocks[id] || null; },
      undeleteBlock: async (id) => {
        calls.undelete.push(id);
        const row = blocks[id];
        if (!row) throw new Error(`Block not found: ${id}`);
        if (!row.deleted_at) return row;             // idempotent, same as db.js
        blocks[id] = { ...row, deleted_at: null };
        return blocks[id];
      },
      deleteBlock: async (id) => { calls.deleted.push(id); blocks[id] = { ...blocks[id], deleted_at: TOMB }; return { id, deleted_at: TOMB }; },
      updateBlock: async (id, patch) => {
        const row = blocks[id];
        if (!row) throw new Error(`Block not found: ${id}`);
        if (row.deleted_at) throw new Error(`Block is deleted: ${id}`);   // db.js raises this
        blocks[id] = { ...row, properties: patch.properties || row.properties };
        return blocks[id];
      },
      getChildren: async () => [],
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByDateIncludingDeleted: async (date, workspaceId) => {
        // Counted: the route feeds ONE of these loads to both the dedupe guard and the
        // slotting context. Without a counter, reverting to two separate loads passes
        // every test, and the whole point of the shape is that the query is an
        // unindexed sequential scan.
        calls.dayLoads.push(date);
        return Object.values(blocks).filter(b => b.date === date && b.workspace_id === workspaceId);
      },
      createItineraryTask: async (b) => { calls.created.push(b); return { id: "created-" + calls.created.length, ...b }; },
      // A3 moved the task-group create loop onto the transactional batch primitive, so
      // a losing racer rolls back to nothing instead of leaving the items it had
      // already committed. Same per-item bookkeeping, so calls.created still counts rows.
      createItineraryTasks: async (items) => items.map((it) => { calls.created.push(it); return { id: "created-" + calls.created.length, ...it }; }),
      isIdempotencyConflict: (err) => !!(err && err.code === "23505" && err.constraint === "idx_blocks_idem_unique"),
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = Object.values(blocks).filter(b => (b.properties || {}).idempotency_key === key && b.workspace_id === workspaceId);
        return hits.find(b => !b.deleted_at) || hits[0] || null;
      },
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
    getTodayStr: () => "2026-07-30",
    isAllowedSweepBlockItem: () => true,
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, blocks, calls, broadcasts };
}

async function call(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

// ── Read contract: a tombstone is gone ──

test("GET /api/blocks/:id 404s on a tombstone", async () => {
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "GET", "/api/blocks/gone-1");
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found", "asserted so an unmounted route cannot pass this test");
  // The fake serves tombstones exactly like the real getBlock, so the 404 above can
  // only come from the route's own deleted_at check. This pins WHICH fetch it used:
  // a revert to getBlock would serve the row with a 200 in production.
  assert.deepEqual(calls.getBlock, [], "read routes must use getBlockIncludingDeleted + an explicit deleted_at check");
});

test("GET /api/blocks/:id still serves a live block", async () => {
  const { app } = mountApp();
  const { status, json } = await call(app, "GET", "/api/blocks/live-1");
  assert.equal(status, 200);
  assert.equal(json.id, "live-1");
});

test("GET /api/blocks/:id/children 404s when the PARENT is a tombstone", async () => {
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "GET", "/api/blocks/gone-1/children");
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.deepEqual(calls.getBlock, [], "same read contract as GET /:id");
});

// ── Mutation contract: a tombstone is still visible, on purpose ──

test("a repeat DELETE of a tombstoned block stays idempotent, not 404", async () => {
  // The regression this guards: switching DELETE to a live-only fetch turns the second
  // delete into a 404, and the client's WAL replay treats a 404 as permanent failure.
  const { app, calls } = mountApp();
  const { status } = await call(app, "DELETE", "/api/blocks/gone-1");
  assert.equal(status, 200);
  assert.deepEqual(calls.deleted, ["gone-1"]);
});

test("PATCH on a tombstone reports 'Block is deleted', not 'Block not found'", async () => {
  // Two different facts. A 404 says the id never existed; the caller needs to know the
  // row is there and dead, which is what makes /undelete the obvious next call.
  const { app } = mountApp();
  const { status, json } = await call(app, "PATCH", "/api/blocks/gone-1", { properties: { title: "Resurrected" } });
  assert.match(String(json.error), /Block is deleted/);
  // Pinned deliberately at the CURRENT value rather than silently implied. db.updateBlock
  // throws a plain Error, and lib/route-helpers route() maps a status-less throw to 500.
  // This is pre-existing (the old getBlock fetch also served the tombstone straight into
  // updateBlock), but it has a live consequence worth someone's attention: block-store's
  // isPermanentReplayFailure treats 400 and update/delete 404 as permanent and everything
  // else as transient, so a WAL-queued PATCH against a row the user deleted retries
  // forever instead of dead-lettering. Changing the code to 409/400 is replay-semantics
  // work and belongs to Track B's B2, which owns that function. Flagged in the handoff.
  assert.equal(status, 500, "current shape; see the comment before changing it");
});

test("PATCH requires a completion base revision for browser transitions", async () => {
  const { app } = mountApp();
  const rejected = await call(app, "PATCH", "/api/blocks/live-1", {
    properties: { title: "Alive", status: "done", done: true },
    completionIntent: "complete",
    completionMutationId: "old-offline-write",
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.code, "COMPLETION_BASE_REQUIRED");

  const accepted = await call(app, "PATCH", "/api/blocks/live-1", {
    properties: { title: "Alive", status: "done", done: true },
    completionIntent: "complete",
    completionMutationId: "current-write",
    completionBaseRevision: null,
  });
  assert.equal(accepted.status, 200, "null is the valid base for a row with no prior transition");
});

test("deleting a row does not let it dodge the ownership check", async () => {
  // If a mutation route fetched live-only, a foreign TOMBSTONE would read as "not
  // found" before authorization ran — the right status by luck, and the wrong reason.
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "DELETE", "/api/blocks/theirs-gone");
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.deepEqual(calls.deleted, [], "and it must never reach deleteBlock");
});

// ── /undelete ──

test("POST /api/blocks/:id/undelete restores a tombstoned block", async () => {
  const { app, blocks, calls } = mountApp();
  const { status, json } = await call(app, "POST", "/api/blocks/gone-1/undelete", {});
  assert.equal(status, 200);
  assert.equal(json.id, "gone-1");
  assert.equal(json.deleted_at, null);
  assert.deepEqual(calls.undelete, ["gone-1"]);
  assert.equal(blocks["gone-1"].deleted_at, null);
});

test("undelete round-trips: GET 404s, undelete, GET serves it again", async () => {
  const { app } = mountApp();
  assert.equal((await call(app, "GET", "/api/blocks/gone-1")).status, 404);
  assert.equal((await call(app, "POST", "/api/blocks/gone-1/undelete", {})).status, 200);
  const after = await call(app, "GET", "/api/blocks/gone-1");
  assert.equal(after.status, 200, "the read contract must follow the row back to life");
  assert.equal(after.json.id, "gone-1");
});

test("undelete broadcasts undeletedIds so another tab can clear its tombstone", async () => {
  // B1 added a client-side _tombstones set that makes handleBlocksChanged SKIP
  // re-fetching an id it believes is deleted. Without an explicit signal, a restore
  // performed elsewhere stays invisible in this tab until a reload.
  const { app, broadcasts } = mountApp();
  await call(app, "POST", "/api/blocks/gone-1/undelete", { _clientId: "tab-a" });
  const evt = broadcasts.find(b => b.payload && b.payload.action === "undelete");
  assert.ok(evt, "an undelete must broadcast");
  assert.deepEqual(evt.payload.undeletedIds, ["gone-1"]);
  assert.deepEqual(evt.payload.blockIds, ["gone-1"]);
  assert.equal(evt.payload.clientId, "tab-a", "so the acting tab can ignore its own echo");
});

test("undelete refuses another workspace's tombstone", async () => {
  // db.undeleteBlock takes no workspaceId and does no tenant check, so this route's
  // assertBlockOwnership is the ONLY thing between a caller and any row anywhere.
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "POST", "/api/blocks/theirs-gone/undelete", {});
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.deepEqual(calls.undelete, [], "and it must never reach undeleteBlock");
});

test("undelete of a live block is a no-op, not an error", async () => {
  const { app } = mountApp();
  const { status, json } = await call(app, "POST", "/api/blocks/live-1/undelete", {});
  assert.equal(status, 200);
  assert.equal(json.id, "live-1");
  assert.equal(json.deleted_at, null);
});

test("undelete of an unknown id is a 404", async () => {
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "POST", "/api/blocks/no-such-id/undelete", {});
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.deepEqual(calls.undelete, []);
});

// ── Resurrection through the side door ──

// ── Task groups: the path #253 left with no guard at all ──

test("scheduling a task group onto an empty day still creates its items", async () => {
  const { app, calls } = mountApp();
  const { status, json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });
  assert.equal(status, 200);
  assert.equal(json.created.length, 2, "both items land");
  assert.equal(calls.created.length, 2);
  assert.equal(calls.dayLoads.length, 1, "the guard and the slotting context share ONE tombstone-inclusive day load");
});

test("re-running the schedule route creates nothing", async () => {
  // The double-book: every item gets a fresh local_id and a fresh free slot, so before
  // this guard a double-click or a client retry planted the whole group twice.
  const { app, calls } = mountApp({ "tg-live": groupTask("tg-live") });
  const { status, json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });
  assert.equal(status, 200);
  assert.deepEqual(json.created, []);
  assert.equal(json.duplicate, true, "the repo's established 'already there' shape");
  assert.equal(json.deleted, false, "a live duplicate, not a tombstone");
  assert.equal(json.task.id, "tg-live", "the row comes back under a named key, like every sibling route");
  assert.equal(calls.created.length, 0, "and nothing reaches createItineraryTask");
  assert.equal(calls.dayLoads.length, 1, "the skip path loads the day once, not twice");
});

test("a group whose tasks were DELETED does not silently come back", async () => {
  const { app, calls } = mountApp({ "tg-gone": groupTask("tg-gone", TOMB) });
  const { json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });
  assert.equal(json.duplicate, true);
  assert.equal(json.deleted, true, "the tombstone is named, not hidden as a dup — the client needs it to offer a re-add");
  assert.equal(calls.created.length, 0);
});

test("force: true is the deliberate re-add and gets through", async () => {
  // The guard blocks the accident, not the intent. Without this, deleting a group's
  // tasks would make the group permanently un-re-addable to that day.
  const { app, calls } = mountApp({ "tg-gone": groupTask("tg-gone", TOMB) });
  const { json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30", force: true });
  assert.equal(json.created.length, 2);
  assert.equal(calls.created.length, 2);
});

test("the guard is scoped to the DAY and to the GROUP", async () => {
  // A group scheduled yesterday must not block scheduling it today, and another
  // group's rows on this day must not block this one.
  const other = { ...groupTask("other-grp"), properties: { title: "x", taskGroupId: "grp-99" } };
  const yesterday = { ...groupTask("tg-yesterday"), date: "2026-07-29" };
  const { app, calls } = mountApp({ "other-grp": other, "tg-yesterday": yesterday });
  const { json } = await call(app, "POST", "/api/task-groups/grp-1/schedule", { date: "2026-07-30" });
  assert.equal(json.created.length, 2, "neither neighbour is a match");
  assert.equal(calls.created.length, 2);
});

test("resolve-placeholder refuses a DELETED placeholder", async () => {
  // It rewrites the row's properties in place, so resolving a tombstone would turn a
  // task the user deleted back into a live-looking responsibility task. getBlock served
  // the dead row silently, so this was reachable.
  const { app } = mountApp();
  const { status, json } = await call(app, "POST", "/api/task-groups/resolve-placeholder", {
    placeholderBlockId: "ph-gone", responsibilityId: "resp-1",
  });
  assert.equal(status, 404);
  assert.match(String(json.error), /Placeholder not found/);
});

// ── routes/dcc.js: the ingest gate and the three keyed writers ──

function mountDcc(rows = []) {
  const app = express();
  app.use(express.json());
  const materializeCalls = [];
  const created = [];
  const credits = [];
  const saved = [];

  const ctx = {
    DAY_STATE_FILE: "/dev/null/day-state.json",
    DATA_DIR: "/dev/null",
    addMinutesHHMM: (hhmm, mins) => {
      const [h, m] = hhmm.split(":").map(Number);
      const t = h * 60 + m + mins;
      return String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    },
    blockDB: {
      findByIdempotencyKey: async (workspaceId, key) => {
        const hits = rows.filter(r => (r.properties || {}).idempotency_key === key && r.workspace_id === workspaceId);
        return hits.find(r => !r.deleted_at) || hits[0] || null;
      },
      getBlocksByDateIncludingDeleted: async () => rows,
      // C5b: the six mutation handlers read Postgres as their BASE state (blocker 3), so the
      // fake needs the read. Returning null models "no row yet for this day", which sends the
      // handler down the file-mirror ladder exactly as a fresh Railway container would.
      getDccState: async () => null,
      createItineraryTask: async (b) => { created.push(b); return { id: "created-" + created.length, ...b }; },
      saveDccState: async (date, state) => { saved.push({ date, state }); },
    },
    broadcast: () => {},
    buildSkeletonState: (d) => ({ date: d }),
    // MIRRORS PRODUCTION, including the throw. server.js getDayFilePath rejects a
    // non-ISO date (C5) because path.join normalizes `../` and the date is caller-
    // supplied. A stub that is total where production throws is the "harness gentler
    // than reality" shape: it made an unguarded caller in routes/dcc.js — an async
    // handler with no try, where an unhandled rejection EXITS the process on node >=20 —
    // untestable and invisible.
    getDayFilePath: (d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error(`invalid day date: ${d}`);
      return `/dev/null/${d}.json`;
    },
    getTodayStr: () => "2026-07-30",
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")),
    meetingIdentity: (m) => m && m.id,
    meetingMaterializer: {
      materializeMeetings: async (args) => { materializeCalls.push(args); return { created: 0, updated: 0, cancelled: 0, blockIds: [] }; },
    },
    previousDateStr: (d) => d,
    readJSON: (_p, fallback) => (fallback === null ? null : (fallback || {})),
    // C5b: routes/dcc.js takes the file-mirror ladder off ctx now, so `readDccDayState` and
    // `server.js dayStateUnavailable` share one implementation of the "legacy file counts only
    // if it IS about this date" gate. Reproduced faithfully rather than stubbed to a constant:
    // a fake that always returned a day would hide the throw the ingest handler must answer 503 for.
    readDayStateMirror: (dateStr) => null,
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: MINE }),
    resolveOwnerStrict: async () => ({ userId: 1, workspaceId: MINE }),
    slotStore: { earnTaskCredit: async (_ws, _u, payload) => { credits.push(payload); return { awarded: true, credits: 10 }; } },
    writeJSON: () => {},
  };
  require("./routes/dcc.js")(app, ctx);
  return { app, materializeCalls, created, credits, saved };
}

async function postDcc(app, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

test("ingest WITHOUT a meetings key does not re-materialize meetings", async () => {
  // public/js/triage.js POSTs the whole client __state, so deleting a triage item was
  // re-running a full create/reconcile/cancel pass over whatever meetings happened to
  // be in the STORED day state — possibly day-old data the client never sent.
  const { app, materializeCalls, saved } = mountDcc();
  const { status } = await postDcc(app, "/api/ingest/day-state", { date: "2026-07-30", triage: { open_items: [] } });
  assert.equal(status, 200);
  assert.deepEqual(materializeCalls, [], "the materializer must not run at all");
  assert.equal(saved.length, 1, "and the load-bearing state write still happens");
});

test("ingest WITH a meetings key still materializes", async () => {
  const { app, materializeCalls } = mountDcc();
  await postDcc(app, "/api/ingest/day-state", { date: "2026-07-30", meetings: [{ id: "evt-1" }] });
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0].hasMeetingsKey, true);
});

test("an EMPTY meetings array still materializes, so cancellation keeps working", async () => {
  // The distinction the gate has to preserve: "no meetings key" means the caller is not
  // talking about meetings; "meetings: []" means the calendar is genuinely empty and
  // stale blocks should be cancelled.
  const { app, materializeCalls } = mountDcc();
  await postDcc(app, "/api/ingest/day-state", { date: "2026-07-30", meetings: [] });
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0].hasMeetingsKey, true);
});

test("quick-task reports a tombstone as skipped_deleted and creates nothing", async () => {
  const rows = [{ id: "qt-gone", workspace_id: MINE, deleted_at: TOMB, properties: { idempotency_key: "k1", title: "Deleted task" } }];
  const { app, created } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/quick-task", { title: "Deleted task", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(json.status, "skipped_deleted");
  assert.equal(created.length, 0);
});

test("quick-task finds a tombstone recorded on a DIFFERENT day", async () => {
  // The widening: the old lookup carried `WHERE date = $1`, so an agent retrying on a
  // later day found nothing and recreated the task the user had deleted.
  const rows = [{ id: "qt-gone", workspace_id: MINE, date: "2026-07-28", deleted_at: TOMB, properties: { idempotency_key: "k1" } }];
  const { app, created } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/quick-task", { title: "Retry", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(json.status, "skipped_deleted");
  assert.equal(created.length, 0);
});

test("brief log-done does NOT credit points against a tombstoned task", async () => {
  // The riskiest of the status changes: previously a deleted match fell through as a
  // plain duplicate and still ran earnTaskCredit on the dead row's id, which awards real
  // points for a task the user removed whenever it had not been credited before.
  const rows = [{ id: "ld-gone", workspace_id: MINE, deleted_at: TOMB, properties: { idempotency_key: "k1" } }];
  const { app, created, credits } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/brief/log-done", { title: "Deleted", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(json.status, "skipped_deleted");
  assert.equal(json.credit, null);
  assert.deepEqual(credits, [], "no ledger write at all");
  assert.equal(created.length, 0);
});

test("brief log-done still credits a LIVE duplicate, unchanged", async () => {
  const rows = [{ id: "ld-live", workspace_id: MINE, date: "2026-07-30", deleted_at: null, properties: { idempotency_key: "k1" } }];
  const { app, created, credits } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/brief/log-done", { title: "Dup", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(json.status, "skipped_duplicate");
  assert.equal(credits.length, 1, "the credit is idempotent server-side and must still fire");
  assert.equal(credits[0].source_key, "2026-07-30:ld-live");
  assert.equal(created.length, 0);
});

test("brief log-done keys the credit to the ROW's date, not the posted one", async () => {
  // The lookup is date-blind, so a live match can sit on another day (the sibling
  // quick-task test proves that path is reachable). Keying the ledger off the REQUEST
  // date would mint a second credit row for a block already credited under its own
  // date. The broadcast and the response follow the row for the same reason: naming
  // the posted day tells every tab to reconcile a day the block is not on.
  const rows = [{ id: "ld-live", workspace_id: MINE, date: "2026-07-28", deleted_at: null, properties: { idempotency_key: "k1" } }];
  const { app, credits } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/brief/log-done", { title: "Dup", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(json.status, "skipped_duplicate");
  assert.equal(credits[0].source_key, "2026-07-28:ld-live", "the ledger key follows the row");
  assert.equal(json.date, "2026-07-28", "and so does the date handed back to the caller");
});

test("brief log-done falls back to the posted date for an UNDATED row", async () => {
  // An undated block must not key the ledger `null:<id>` or `undefined:<id>`.
  const rows = [{ id: "ld-undated", workspace_id: MINE, date: null, deleted_at: null, properties: { idempotency_key: "k1" } }];
  const { app, credits } = mountDcc(rows);
  const { json } = await postDcc(app, "/api/dcc/brief/log-done", { title: "Dup", idempotency_key: "k1", date: "2026-07-30" });
  assert.equal(credits[0].source_key, "2026-07-30:ld-undated");
  assert.equal(json.date, "2026-07-30");
});

test("brief push-next distinguishes a tombstone from a duplicate", async () => {
  const gone = [{ id: "pn-gone", workspace_id: MINE, deleted_at: TOMB, properties: { idempotency_key: "k1" } }];
  const live = [{ id: "pn-live", workspace_id: MINE, deleted_at: null, properties: { idempotency_key: "k1" } }];
  const a = await postDcc(mountDcc(gone).app, "/api/dcc/brief/push-next", { title: "x", idempotency_key: "k1", date: "2026-07-31" });
  assert.equal(a.json.status, "skipped_deleted");
  const b = await postDcc(mountDcc(live).app, "/api/dcc/brief/push-next", { title: "x", idempotency_key: "k1", date: "2026-07-31" });
  assert.equal(b.json.status, "skipped_duplicate");
});
