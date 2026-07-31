// POST /api/blocks/:id/reschedule — the HTTP half of C3's one mover.
//
// The pure walk is pinned in reschedule-subtree.test.js and the client side in
// completion-date-choice.test.js / push-is-a-move.test.js. The route owns branching
// neither of those can see: the day_root refusal, the single pool call that replaced a
// concatenated pair, which entry of `moves` gets parentStart/parentEnd, and the
// tombstone's movedBlockId (without which the amber Restore button cannot work).
//
// Harness: routes/blocks.js is an (app, ctx) factory, mounted on a bare express app with
// fake stores — same as tasks-open-route.test.js / blocks-batch-authz.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const FROM = "2026-07-30";
const TO = "2026-07-31";

const blk = (id, localId, extra = {}) => ({
  id, type: "block", date: FROM, parent_id: extra.parent_id || null, workspace_id: MINE, user_id: 1,
  properties: { local_id: localId, title: "T " + id, subtaskOf: extra.subtaskOf || null, wrapId: extra.wrapId || null, kind: extra.kind || null }
});

function mountApp({ parent, pool: poolRows = [] } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const calls = { poolFor: [], reschedule: [] };
  const ctx = {
    blockDB: {
      getBlockIncludingDeleted: async () => parent || null,
      // Recorded so the test can prove the route makes exactly ONE pool call with the
      // origin date -- it used to concatenate getBlocksByDate + getUndatedTaskBlocks.
      getRescheduleSubtreePool: async (fromDate, ws) => { calls.poolFor.push({ fromDate, ws }); return poolRows; },
      rescheduleBlocks: async (moves, creates) => {
        calls.reschedule.push({ moves, creates });
        return { blocks: [...moves.map((m) => ({ id: m.id })), ...creates.map((c, i) => ({ id: "tomb-" + i, ...c }))] };
      },
      getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
      getBlock: async () => null, updateBlock: async (id, p) => ({ id, properties: p }),
      batchOp: async () => ({ batchId: "b", blocks: [] }), reorderBlocks: async () => {},
      getBlocksByDate: async () => [], getBlocksByTypes: async () => [], getDelegatedItems: async () => [],
      getBlocksByDateRange: async () => [], getResponsibilityBlocks: async () => [], getBlocksByKind: async () => [],
    },
    broadcast: () => {}, crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (b) => b, getScheduleBlocks: async () => [], getTodayStr: () => TO,
    isAllowedSweepBlockItem: () => true,
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)),
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
    APP_TIME_ZONE: "America/Chicago",
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, calls };
}

async function post(app, id, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/blocks/${id}/reschedule`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("a day container cannot be rescheduled", async () => {
  // The walk now reads parent_id, and a day_root's parent_id children are EVERY task on
  // that date (1328 such edges on the prod restore). Without this refusal, one call
  // would re-date the whole day. The walk refuses to propagate out of a day_root too;
  // both are deliberate, because an invariant enforced at one call site and merely
  // commented at the other is this repo's most repeated bug.
  const root = { id: "day-root-ws-1-2026-07-30", type: "day_root", date: FROM, workspace_id: MINE, properties: {} };
  const { app, calls } = mountApp({ parent: root, pool: [blk("B1", "t1"), blk("B2", "t2")] });
  const { status, body } = await post(app, root.id, { targetDate: TO });
  assert.equal(status, 400);
  assert.match(body.error, /day container/i);
  assert.equal(calls.reschedule.length, 0, "nothing is moved");
});

test("the origin day's pool is fetched ONCE, for the origin date", async () => {
  const parent = blk("B1", "t1");
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status } = await post(app, "B1", { targetDate: TO });
  assert.equal(status, 200);
  assert.deepEqual(calls.poolFor, [{ fromDate: FROM, ws: MINE }]);
});

test("the parent carries the pinned times; its subtree just changes date", async () => {
  const parent = blk("B1", "t1");
  const kid = blk("B2", "t2", { subtaskOf: "t1" });
  const { app, calls } = mountApp({ parent, pool: [parent, kid] });
  const { status, body } = await post(app, "B1", { targetDate: TO, parentStart: "09:15", parentEnd: "09:45" });
  assert.equal(status, 200);
  const { moves } = calls.reschedule[0];
  assert.deepEqual(moves.map((m) => m.id), ["B1", "B2"], "parent first, then the subtree");
  assert.equal(moves[0].properties.start, "09:15");
  assert.equal(moves[0].properties._pinnedStart, "09:15");
  assert.equal(moves[0].properties.end, "09:45");
  assert.equal(moves[0].properties.rescheduledFrom.date, FROM);
  assert.equal(moves[1].properties, undefined, "a subtask keeps its own times");
  assert.equal(moves[1].date, TO);
  assert.deepEqual(body.moved, ["B1", "B2"]);
});

test("the origin day gets ONE tombstone, and it records movedBlockId", async () => {
  // movedBlockId is what restoreRescheduledAway needs. The clone move never wrote it,
  // which is why the amber Restore button never worked from that path.
  const parent = blk("B1", "t1");
  const { app, calls } = mountApp({ parent, pool: [parent] });
  await post(app, "B1", { targetDate: TO });
  const { creates } = calls.reschedule[0];
  assert.equal(creates.length, 1);
  assert.equal(creates[0].date, FROM, "the tombstone stays on the origin day");
  assert.equal(creates[0].properties.movedBlockId, "B1");
  assert.equal(creates[0].properties.kind, "reschedule_tombstone");
  assert.equal(creates[0].properties.rescheduledTo, TO);
});

test("moving off the same day twice reuses the tombstone instead of piling them up", async () => {
  const parent = blk("B1", "t1");
  const tomb = { id: "tomb-old", type: "block", date: FROM, workspace_id: MINE,
    properties: { local_id: "resched-tomb-B1", kind: "reschedule_tombstone", movedBlockId: "B1" } };
  const { app, calls } = mountApp({ parent, pool: [parent, tomb] });
  await post(app, "B1", { targetDate: TO });
  assert.equal(calls.reschedule[0].creates.length, 0);
});

test("a bogus parentStart is refused rather than written into the task's times", async () => {
  const parent = blk("B1", "t1");
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status } = await post(app, "B1", { targetDate: TO, parentStart: "9am" });
  assert.equal(status, 400);
  assert.equal(calls.reschedule.length, 0);
});

test("a move to the date it is already on is refused", async () => {
  const parent = blk("B1", "t1");
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status, body } = await post(app, "B1", { targetDate: FROM });
  assert.equal(status, 400);
  assert.match(body.error, /Already on that date/);
  assert.equal(calls.reschedule.length, 0);
});

test("an undated row moves using the caller's fromDate", async () => {
  // task-bar pending_tasks live on a day only via day-state, so the row itself has no
  // date and the client supplies the viewed day.
  const parent = { ...blk("B1", "t1"), date: null };
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status } = await post(app, "B1", { targetDate: TO, fromDate: FROM });
  assert.equal(status, 200);
  assert.deepEqual(calls.poolFor, [{ fromDate: FROM, ws: MINE }]);
  assert.equal(calls.reschedule[0].creates[0].date, FROM);
});

test("an undated row with no fromDate is refused, not moved from nowhere", async () => {
  const parent = { ...blk("B1", "t1"), date: null };
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status, body } = await post(app, "B1", { targetDate: TO });
  assert.equal(status, 400);
  assert.match(body.error, /no source date/i);
  assert.equal(calls.reschedule.length, 0);
});
