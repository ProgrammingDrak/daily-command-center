// C3's one product behavior change: "Push to tomorrow" is a real MOVE.
//
// Before this, pushTask flagged the id in `pushedSet`, left the row on today under a
// greyed "Pushed to Tomorrow" divider, AND created a second block on tomorrow with the
// same local_id — two rows for one task, neither authoritative. Drake approved deleting
// that outright (2026-07-31): "I think we can get rid of the pushed system and behavior
// in favor of truly something moving."
//
// So what has to be true, and is asserted below: pushing issues a RESCHEDULE of the
// existing row, never a create; the origin row leaves today; and nothing writes a pushed
// flag anywhere, because the flag no longer exists.
//
// It also pins the deletion of the clone fallback. The old code answered a permanent
// server rejection by cloning the task to the target date under a NEW id
// (`<id>-resched-<date>`) with a tombstone that omitted movedBlockId — so the amber
// Restore button could never work, and every 400 ("Already on that date", "Block is
// deleted", …) minted a duplicate. A permanent rejection now surfaces the server's own
// message and changes nothing.
//
// Harness: source sliced out of public/js/state.js into a node:vm context, as in
// delete-subtree.test.js (state.js has DOM side effects at load).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");

function mustMatch(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error("push-is-a-move.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

// The mover region: _subtreeIdsOf / _removeSubtreeFromScheduled / the tombstone writer /
// rescheduleTaskToDate / restoreRescheduledAway / pushTask.
const MOVER_SRC = [
  mustMatch(STATE_SRC, /function _subtreeIdsOf\(rootId\)\{[\s\S]*?\n\}/, "_subtreeIdsOf"),
  mustMatch(STATE_SRC, /function _removeSubtreeFromScheduled\(rootId\)\{[\s\S]*?\n\}/, "_removeSubtreeFromScheduled"),
  mustMatch(STATE_SRC, /async function _materializeTaskOnDate\([\s\S]*?\n\}/, "_materializeTaskOnDate"),
  mustMatch(STATE_SRC, /async function _moveOriginDayChildrenTo\([\s\S]*?\n\}/, "_moveOriginDayChildrenTo"),
  mustMatch(STATE_SRC, /async function _writeRescheduleTombstone\([\s\S]*?\n\}/, "_writeRescheduleTombstone"),
  mustMatch(STATE_SRC, /async function rescheduleTaskToDate\(id,targetDate,opts\)\{[\s\S]*?\n\}/, "rescheduleTaskToDate"),
  // pushTask is a one-liner now, so it has no `\n}` of its own -- a `[\s\S]*?\n\}`
  // pattern would silently run past it into the next function and slice invalid JS.
  mustMatch(STATE_SRC, /function pushTask\(id\)\{[^\n]*\}/, "pushTask"),
].join("\n");

const TODAY = "2026-07-31";
const TOMORROW = "2026-08-01";

// `rows` maps ev id -> the cached block row backing it. An ev with no entry is a
// day-state-only task: rendered from the day's JSON with no row to move.
function load({ scheduled, rows = {}, rescheduleFails = null } = {}) {
  const calls = { reschedule: [], created: [], deleted: [], toasts: [], logs: [], reslot: [] };
  const deletedSet = new Set();
  const addedTasks = [];
  const context = {
    console,
    scheduled,
    deletedSet,
    viewDate: TODAY,
    __state: { date: TODAY },
    __todayDate: TODAY,
    __tomorrowDate: TOMORROW,
    manualDone: new Set(),
    isDone: () => false,
    log: (kind, id, msg) => calls.logs.push({ kind, id, msg }),
    render: () => {},
    recalcTimes: () => {},
    saveDeletedState: () => {},
    saveTaskOrder: () => {},
    syncAddedTaskTimes: () => {},
    saveDoneState: () => {},
    loadAddedTasks: () => addedTasks.slice(),
    saveAddedTasks: (t) => { addedTasks.length = 0; addedTasks.push(...t); },
    loadPinnedStarts: () => ({}),
    savePinnedStarts: () => {},
    loadLockedSet: () => [],
    saveLockedSet: () => {},
    parentIdOf: (e) => (e && (e.wrapId || e.subtaskOf)) || null,
    dur: (e) => 30,
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    pt: (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; },
    f12: (s) => s,
    _prettyDateLabel: (d) => d,
    _resolvedTodayDate: () => TODAY,
    _resolvedTomorrowDate: () => TOMORROW,
    _computeRescheduleSlot: async () => ({ start: "10:00", end: "10:30", duration: 30 }),
    _clearTaskPinAndLock: () => {},
    // The same-day re-slot branch. Recorded, not no-ops: a same-day "move" must take
    // this path and must never reach the cross-date mover.
    _placeTaskAtNextTodaySlot: (id) => { calls.reslot.push({ id, kind: "today" }); return scheduled.find((e) => e.id === id); },
    _placeTaskAtEarliestCurrentDateSlot: (id) => { calls.reslot.push({ id, kind: "earliest" }); return scheduled.find((e) => e.id === id); },
    pinStartTime: (id, t) => calls.reslot.push({ id, kind: "pin", t }),
    _findTaskBlockForDate: (id, dateStr) => {
      const hit = rows[id];
      if (!hit) return null;
      if (dateStr && hit.date && hit.date !== dateStr) return null;
      return hit;
    },
    persistAddedTask: async (item, date) => { const b = { id: "new-" + item.id, date, properties: { local_id: item.id, title: item.title } }; calls.created.push({ item, date, block: b }); return b; },
    showToast: (msg, kind) => calls.toasts.push({ msg, kind }),
    window: {
      blockStore: {
        getByType: () => [],
        rescheduleBlock: async (blockId, targetDate, opts) => {
          calls.reschedule.push({ blockId, targetDate, opts });
          if (rescheduleFails) { const e = new Error(rescheduleFails.message); e.status = rescheduleFails.status; e.permanent = rescheduleFails.status === 400 || rescheduleFails.status === 404; throw e; }
          return { moved: [blockId], parentId: blockId, targetDate };
        },
        createBlock: async (type, props, opts) => { const b = { id: "created-" + (props.local_id || "x"), type, date: opts && opts.date, properties: props }; calls.created.push({ item: props, date: opts && opts.date, block: b }); return b; },
        deleteBlock: async (id) => { calls.deleted.push(id); },
        loadDay: async () => {},
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(MOVER_SRC, context);
  // moveTaskToTomorrow is defined elsewhere in state.js; wire the real one-liner so
  // pushTask's delegation is exercised rather than stubbed away.
  vm.runInContext("function moveTaskToTomorrow(id){return rescheduleTaskToDate(id,_resolvedTomorrowDate())}", context);
  return { context, calls, deletedSet, addedTasks };
}

const ev = (id, extra = {}) => ({ id, title: "Task " + id, start: "09:00", end: "09:30", source: "manual", ...extra });
const row = (id, date = TODAY) => ({ id: "blk-" + id, type: "block", date, properties: { local_id: id, title: "Task " + id } });

test("pushTask RESCHEDULES the existing row to tomorrow and creates nothing", async () => {
  const { context, calls } = load({ scheduled: [ev("t1")], rows: { t1: row("t1") } });
  await vm.runInContext('pushTask("t1")', context);
  assert.deepEqual(calls.reschedule.map((c) => [c.blockId, c.targetDate]), [["blk-t1", TOMORROW]]);
  assert.equal(calls.created.length, 0, "a push must not write a second copy of the task");
});

test("pushTask removes the task from today, so it is on exactly one day", async () => {
  const { context, calls } = load({ scheduled: [ev("t1"), ev("t2")], rows: { t1: row("t1"), t2: row("t2") } });
  await vm.runInContext('pushTask("t1")', context);
  const left = vm.runInContext("scheduled.map(e=>e.id)", context);
  assert.deepEqual([...left], ["t2"], "the pushed row leaves today");
  assert.ok(calls.toasts.some((t) => t.kind === "success"));
});

test("pushing a parent takes its subtree off today with it", async () => {
  const { context } = load({
    scheduled: [ev("t1"), ev("s1", { subtaskOf: "t1" }), ev("s2", { subtaskOf: "s1" }), ev("t9")],
    rows: { t1: row("t1"), s1: row("s1"), s2: row("s2"), t9: row("t9") },
  });
  await vm.runInContext('pushTask("t1")', context);
  assert.deepEqual([...vm.runInContext("scheduled.map(e=>e.id)", context)], ["t9"],
    "the whole visible subtree goes; a subtask left behind is what resurfaces as orphaned work");
});

test("nothing writes a pushed flag any more -- the subsystem is gone", () => {
  for (const sym of ["pushedSet", "pushedAt", "savePushedState", "isPushed", "unpushTask", "schedulePushedOnTomorrow", "loadDeferred", "_cloneTaskForReschedule", "_rescheduledTaskId", "_hideSourceTaskForReschedule", "_rescheduleSubtaskSubtree"]) {
    assert.equal(new RegExp("(function|let|const|var)\\s+" + sym + "\\b").test(STATE_SRC), false,
      sym + " is still defined in state.js");
  }
  assert.equal(/_pushed\s*:/.test(STATE_SRC), false, "state.js still writes a _pushed overlay");
});

test("a PERMANENT rejection reports the server's reason and does NOT clone the task", async () => {
  const { context, calls, deletedSet } = load({
    scheduled: [ev("t1")], rows: { t1: row("t1") },
    rescheduleFails: { status: 400, message: "Block is deleted" },
  });
  await vm.runInContext(`rescheduleTaskToDate("t1","${TOMORROW}")`, context);
  assert.equal(calls.created.length, 0, "the clone fallback is deleted; a 400 must not mint a second task");
  assert.deepEqual([...vm.runInContext("scheduled.map(e=>e.id)", context)], ["t1"], "the task stays where it was");
  assert.equal(deletedSet.size, 0, "and is not hidden");
  const err = calls.toasts.find((t) => t.kind === "error");
  assert.ok(err && /Block is deleted/.test(err.msg), "the user sees the server's own reason, got: " + JSON.stringify(calls.toasts));
});

test("a TRANSIENT failure leaves the task alone and says it is queued", async () => {
  const { context, calls, deletedSet } = load({
    scheduled: [ev("t1")], rows: { t1: row("t1") },
    rescheduleFails: { status: 503, message: "gateway" },
  });
  await vm.runInContext(`rescheduleTaskToDate("t1","${TOMORROW}")`, context);
  assert.equal(calls.created.length, 0, "cloning here would race the WAL replay into a duplicate");
  assert.deepEqual([...vm.runInContext("scheduled.map(e=>e.id)", context)], ["t1"]);
  assert.equal(deletedSet.size, 0);
  assert.ok(calls.toasts.some((t) => /queued/i.test(t.msg)));
});

test("a day-state-only task is MATERIALIZED on the target date under its own id", async () => {
  // No row on the origin day, so there is no :id to move. It gets a row on the target
  // date carrying the SAME local_id -- same identity, not a clone with a minted id.
  const { context, calls, deletedSet } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.equal(calls.reschedule.length, 0, "there is no row to reschedule");
  const created = calls.created.filter((c) => c.item.local_id !== undefined || c.item.id !== undefined);
  const task = created.find((c) => (c.item.id || c.item.local_id) === "notion-1");
  assert.ok(task, "the task is materialized: " + JSON.stringify(created.map((c) => c.item.id || c.item.local_id)));
  assert.equal(task.date, TOMORROW);
  assert.ok(deletedSet.has("notion-1"), "the day-state copy is hidden on the origin day");
});

test("the materialized move leaves a tombstone that CAN be restored", async () => {
  // The clone move's tombstone omitted movedBlockId, so restoreRescheduledAway had
  // nothing to move back -- the amber Restore button never worked from this path.
  const { context, calls } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  assert.ok(tomb, "a tombstone is written on the origin day");
  assert.equal(tomb.date, TODAY);
  assert.ok(tomb.item.movedBlockId, "movedBlockId is what Restore needs");
  assert.equal(tomb.item.movedBlockId, "new-notion-1", "and it points at the row that now holds the task");
  assert.equal(tomb.item.rescheduledTo, TOMORROW);
});

test("a day-state-only parent's block-backed subtasks follow it", async () => {
  // The plan asserted a day-state-only task cannot have subtasks. It can: BOTH subtask
  // creation paths (tabs.js addSubtask and the legacy-store migration) create a block for
  // the subtask whether or not the PARENT has one. Leaving them would strand them on the
  // origin day under a parent that is gone -- the bug this phase exists to delete.
  const { context, calls } = load({
    scheduled: [ev("notion-1"), ev("s1", { subtaskOf: "notion-1" })],
    rows: { s1: row("s1") },
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.deepEqual(calls.reschedule.map((c) => [c.blockId, c.targetDate]), [["blk-s1", TOMORROW]],
    "the subtask's real row is moved by the real mover");
});

test("a same-day 'move' with no time is a re-slot, not a cross-date move", async () => {
  const { context, calls } = load({ scheduled: [ev("t1")], rows: { t1: row("t1") } });
  await vm.runInContext(`rescheduleTaskToDate("t1","${TODAY}")`, context);
  assert.equal(calls.reschedule.length, 0, "no server move for a same-day re-slot");
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.reslot.map((r) => r.kind), ["today"], "it re-slots in place instead");
});
