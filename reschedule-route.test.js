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
  properties: { local_id: localId, title: "T " + id, subtaskOf: extra.subtaskOf || null, wrapId: extra.wrapId || null, kind: extra.kind || null, ...(extra.properties || {}) }
});

function mountApp({ parent, pool: poolRows = [], existingTomb = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const calls = { poolFor: [], tombFor: [], reschedule: [] };
  const ctx = {
    blockDB: {
      getBlockIncludingDeleted: async () => parent || null,
      // Recorded so the test can prove the route makes exactly ONE pool call with the
      // origin date -- it used to concatenate getBlocksByDate + getUndatedTaskBlocks.
      getRescheduleSubtreePool: async (fromDate, ws) => { calls.poolFor.push({ fromDate, ws }); return poolRows; },
      // Its own lookup, not a scan of the pool: a tombstone is not a task row, so the
      // dedupe must not depend on the pool's task predicate admitting one.
      // Keys on its argument, so the lookup key is load-bearing in every test that uses it
      // rather than only in the one asserting on calls.tombFor.
      getRescheduleTombstone: async (fromDate, movedBlockId, ws) => { calls.tombFor.push({ fromDate, movedBlockId, ws }); return (existingTomb && (existingTomb.properties||{}).movedBlockId === movedBlockId) ? existingTomb : null; },
      rescheduleBlocks: async (moves, creates) => {
        calls.reschedule.push({ moves, creates });
        return { blocks: [...moves.map((m) => ({ type: "block", ...m })), ...creates.map((c, i) => ({ id: "tomb-" + i, ...c }))] };
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
  assert.equal(moves[1].properties.start, undefined, "a timeless subtask keeps no time fields");
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
  const { app, calls } = mountApp({ parent, pool: [parent], existingTomb: tomb });
  await post(app, "B1", { targetDate: TO });
  assert.equal(calls.reschedule[0].creates.length, 0);
  assert.deepEqual(calls.tombFor, [{ fromDate: FROM, movedBlockId: "B1", ws: MINE }],
    "asked for the origin day's tombstone by the moved row's id");
});

test("a tombstone sitting in the POOL is not the dedupe source any more", async () => {
  // The dedupe used to scan `dayBlocks`, which only worked because a tombstone carries a
  // local_id and so slipped through the pool's task filter — while reschedule_tombstone is in
  // NON_TASK_KINDS. Tightening that predicate would have silently restarted the pile-up.
  //
  // So: put a matching tombstone in the POOL and none in the dedupe lookup. The route must
  // ignore the pool copy and write a tombstone. (An exact-fixture rerun of the test above
  // could only fail when that one already had, which is what this replaces.)
  const parent = blk("B1", "t1");
  const poolTomb = { id: "tomb-in-pool", type: "block", date: FROM, workspace_id: MINE,
    properties: { local_id: "resched-tomb-B1", kind: "reschedule_tombstone", movedBlockId: "B1" } };
  const { app, calls } = mountApp({ parent, pool: [parent, poolTomb], existingTomb: null });
  await post(app, "B1", { targetDate: TO });
  assert.equal(calls.reschedule[0].creates.length, 1, "the pool is not consulted for the dedupe");
  assert.equal(calls.reschedule[0].moves.length, 1, "and a tombstone in the pool is not itself moved");
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

test("same-day exact placement updates time without a tombstone", async () => {
  const parent = blk("B1", "t1", { properties: { start: "09:00", end: "09:30" } });
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status, body } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "timed", start: "11:15", end: "12:00" },
  });
  assert.equal(status, 200);
  assert.equal(calls.reschedule[0].moves[0].properties.start, "11:15");
  assert.equal(calls.reschedule[0].moves[0].properties.end, "12:00");
  assert.equal(calls.reschedule[0].creates.length, 0);
  assert.equal(body.blocks[0].properties.start, "11:15");
});

test("timed placement shifts descendant times and preserves relative descendant dates", async () => {
  const parent = blk("B1", "t1", { properties: { start: "09:00", end: "10:00" } });
  const kid = { ...blk("B2", "t2", { subtaskOf: "t1", properties: { start: "09:30", end: "09:45" } }), date: "2026-07-31" };
  const { app, calls } = mountApp({ parent, pool: [parent, kid] });
  const { status } = await post(app, "B1", {
    targetDate: "2026-08-01",
    placement: { kind: "timed", start: "10:00", end: "11:00" },
  });
  assert.equal(status, 200);
  const movedKid = calls.reschedule[0].moves.find(m => m.id === "B2");
  assert.equal(movedKid.date, "2026-08-02");
  assert.equal(movedKid.properties.start, "10:30");
  assert.equal(movedKid.properties.end, "10:45");
});

test("★ userSetStart marks the start as user-chosen; an auto-slotted move clears it", async () => {
  // A timed placement alone cannot say a HUMAN picked the time: the client sends
  // parentStart for an auto-slotted cross-day move too. Only the explicit flag does,
  // and it is what stops the client cascade re-timing the task on the next drag.
  const parent = blk("B1", "t1", { properties: { start: "09:00", end: "10:00" } });
  const chosen = mountApp({ parent, pool: [parent] });
  const a = await post(chosen.app, "B1", { targetDate: TO, parentStart: "07:15", parentEnd: "08:15", userSetStart: true });
  assert.equal(a.status, 200);
  assert.equal(chosen.calls.reschedule[0].moves[0].properties.userSetStart, true);
  assert.equal(chosen.calls.reschedule[0].moves[0].properties._pinnedStart, "07:15");

  // Absence is the only value that has ever meant "not user-set", and a row that was
  // hand-placed once must stop resisting reflow after the scheduler re-slots it.
  const auto = mountApp({ parent: blk("B1", "t1", { properties: { start: "09:00", end: "10:00", userSetStart: true } }), pool: [parent] });
  const b = await post(auto.app, "B1", { targetDate: TO, parentStart: "13:00", parentEnd: "14:00" });
  assert.equal(b.status, 200);
  const props = auto.calls.reschedule[0].moves[0].properties;
  assert.equal("userSetStart" in props, false, "the key is deleted, not set falsy");
});

test("a non-boolean userSetStart is refused rather than written to the row", async () => {
  const parent = blk("B1", "t1", { properties: { start: "09:00", end: "10:00" } });
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status, body } = await post(app, "B1", { targetDate: TO, parentStart: "07:15", parentEnd: "08:15", userSetStart: "yes" });
  assert.equal(status, 400);
  assert.match(body.error, /userSetStart/);
  assert.equal(calls.reschedule.length, 0);
});

test("all-day placement uses an exclusive end and strips timed fields", async () => {
  const parent = blk("B1", "t1", { properties: { start: "09:00", end: "10:00" } });
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "all_day", endDate: "2026-08-02" },
  });
  assert.equal(status, 200);
  const props = calls.reschedule[0].moves[0].properties;
  assert.equal(props.all_day, true);
  assert.equal(props.all_day_start, FROM);
  assert.equal(props.all_day_end, "2026-08-02");
  assert.equal(props.start, undefined);
  assert.equal("userSetStart" in props, false); // the flag goes with the start it describes
  assert.equal(calls.reschedule[0].creates.length, 0);
});

test("calendar-owned meetings reject placement before any move", async () => {
  const parent = blk("B1", "m1", { properties: { source: "calendar", type: "meeting", start: "09:00", end: "10:00" } });
  const { app, calls } = mountApp({ parent, pool: [parent] });
  const { status, body } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "timed", start: "10:00", end: "11:00" },
  });
  assert.equal(status, 409);
  assert.match(body.error, /source calendar/i);
  assert.equal(calls.reschedule.length, 0);
});

test("legacy gcal and calendar-id meetings retain source placement authority", async () => {
  for (const properties of [
    { source: "gcal", type: "meeting", start: "09:00", end: "10:00" },
    { source: "manual", type: "meeting", calendar_id: "primary", start: "09:00", end: "10:00" },
  ]) {
    const parent = blk("B1", "m1", { properties });
    const { app, calls } = mountApp({ parent, pool: [parent] });
    const { status } = await post(app, "B1", {
      targetDate: FROM,
      placement: { kind: "timed", start: "10:00", end: "11:00" },
    });
    assert.equal(status, 409);
    assert.equal(calls.reschedule.length, 0);
  }
});

test("placement that pushes a timed child outside the day rolls back before the transaction", async () => {
  const parent = blk("B1", "t1", { properties: { start: "22:00", end: "23:00" } });
  const kid = blk("B2", "t2", { subtaskOf: "t1", properties: { start: "23:00", end: "23:45" } });
  const { app, calls } = mountApp({ parent, pool: [parent, kid] });
  const { status, body } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "timed", start: "23:00", end: "23:45" },
  });
  assert.equal(status, 400);
  assert.match(body.error, /outside the day/i);
  assert.equal(calls.reschedule.length, 0);
});

test("shell duration is child-derived and cannot be resized", async () => {
  const parent = blk("B1", "shell", { properties: { type: "shell", kind: "shell", start: "09:00", end: "11:00" } });
  const kid = blk("B2", "step", { subtaskOf: "shell", properties: { start: "09:30", end: "10:00" } });
  const { app, calls } = mountApp({ parent, pool: [parent, kid] });
  const { status, body } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "timed", start: "09:00", end: "10:30" },
  });
  assert.equal(status, 400);
  assert.match(body.error, /derived from its children/i);
  assert.equal(calls.reschedule.length, 0);
});

test("a wrap cannot shrink before its latest shifted child", async () => {
  const parent = blk("B1", "wrap", { properties: { type: "wrap", kind: "wrap", isWrap: true, start: "09:00", end: "11:00" } });
  const kid = blk("B2", "rider", { wrapId: "wrap", properties: { start: "10:00", end: "10:45" } });
  const { app, calls } = mountApp({ parent, pool: [parent, kid] });
  const { status, body } = await post(app, "B1", {
    targetDate: FROM,
    placement: { kind: "timed", start: "09:00", end: "10:30" },
  });
  assert.equal(status, 400);
  assert.match(body.error, /latest timed child/i);
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
