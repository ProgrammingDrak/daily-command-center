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
// C6a: the sliced code derives its task sets through DCC.TaskModel; install the real
// module INSIDE the context so it resolves this harness's isDone/isDeleted stubs.
const { installTaskModel } = require("./task-model-vm.js");

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
  mustMatch(STATE_SRC, /async function restoreRescheduledAway\(tombBlockId\)\{[\s\S]*?\n\}/, "restoreRescheduledAway"),
  // pushTask is a one-liner now, so it has no `\n}` of its own -- a `[\s\S]*?\n\}`
  // pattern would silently run past it into the next function and slice invalid JS.
  mustMatch(STATE_SRC, /function pushTask\(id\)\{[^\n]*\}/, "pushTask"),
].join("\n");

const TODAY = "2026-07-31";
const TOMORROW = "2026-08-01";

// `rows` maps ev id -> the cached block row backing it. An ev with no entry is a
// day-state-only task: rendered from the day's JSON with no row to move.
function load({ scheduled, rows = {}, rescheduleFails = null, failMaterializeFor = [] } = {}) {
  const calls = { reschedule: [], created: [], deleted: [], toasts: [], logs: [], reslot: [], fetched: [], slotFor: [] };
  const deletedSet = new Set();
  const addedTasks = [];
  // What saveDeletedState persisted into the day_root `_deleted` overlay, i.e. what
  // survives a reload. Kept separate from the live set so the reload can be modelled.
  let savedDeleted = [];
  const createdBlocks = [];
  let materializeCount = 0;
  let pinMap = {};
  const lockSet = new Set();
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
    saveDeletedState: () => { savedDeleted = [...deletedSet]; },
    saveTaskOrder: () => {},
    syncAddedTaskTimes: () => {},
    saveDoneState: () => {},
    loadAddedTasks: () => addedTasks.slice(),
    saveAddedTasks: (t) => { addedTasks.length = 0; addedTasks.push(...t); },
    loadPinnedStarts: () => ({ ...pinMap }),
    savePinnedStarts: (m) => { pinMap = { ...m }; },
    loadLockedSet: () => [...lockSet],
    saveLockedSet: (a) => { lockSet.clear(); (a||[]).forEach((x) => lockSet.add(x)); },
    parentIdOf: (e) => (e && (e.wrapId || e.subtaskOf)) || null,
    // C6a: `childrenOf` was NOT stubbed here and the sliced mover now calls it. Wired
    // to the real TaskModel rather than hand-rolled: this harness's `parentIdOf` fake
    // already predates the unified-edge order, and a second narrower copy is how a
    // harness ends up gentler than production.
    childrenOf: (id, pool) => context.DCC.TaskModel.childrenOf(id, pool),
    dur: (e) => 30,
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    pt: (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; },
    f12: (s) => s,
    _prettyDateLabel: (d) => d,
    _resolvedTodayDate: () => TODAY,
    _resolvedTomorrowDate: () => TOMORROW,
    _computeRescheduleSlot: async (evArg) => { calls.slotFor.push(evArg && { id: evArg.id, start: evArg.start, end: evArg.end }); return { start: "10:00", end: "10:30", duration: 30 }; },
    // FAITHFUL, not a no-op: the real one deletes the ev fields AND the entries in the
    // persisted pinned-starts / locked maps (state.js). Stubbed to nothing, a row spliced out
    // and pushed back kept its pin for free, so the restore logic that exists to save it was
    // untestable — a stub more benign than reality hides the fix, same as the deterministic-id
    // stub did earlier in this file.
    _clearTaskPinAndLock: (evArg) => {
      if (!evArg) return;
      if (evArg._pinnedStart) { delete evArg._pinnedStart; delete pinMap[evArg.id]; }
      if (evArg._locked) { delete evArg._locked; lockSet.delete(evArg.id); }
    },
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
    // A FRESH row id per call, like the real one: blockStore.createBlock mints a UUID, so
    // two materializes of the same task produce two different block ids. A deterministic
    // "new-<localId>" stub silently made them identical, which let the tombstone dedupe pass
    // while keyed on movedBlockId — the exact drift-between-mock-and-reality that hides a
    // dead guard. The counter keeps ids predictable for assertions without making them
    // stable across calls.
    persistAddedTask: async (item, date) => {
      if (failMaterializeFor.includes(item.id)) throw new Error("create refused");
      const b = { id: "new-" + item.id + (materializeCount ? "-" + materializeCount : ""), date, properties: { local_id: item.id, title: item.title } };
      materializeCount++;
      createdBlocks.push(b); calls.created.push({ item, date, block: b }); return b;
    },
    showToast: (msg, kind) => calls.toasts.push({ msg, kind }),
    reloadPersistedEdits: () => {
      // The real one rebuilds deletedSet from the day_root `_deleted` overlay. Modelled,
      // not stubbed to nothing: restoreRescheduledAway runs AFTER it, and a no-op stub
      // would hide the bug where the restored row is put straight back into deletedSet.
      const persisted = [...savedDeleted];
      deletedSet.clear();
      persisted.forEach((sid) => deletedSet.add(sid));
    },
    // A DISTINCT id from the tombstone's movedBlockId, and real properties. Sharing
    // "new-notion-1" with movedBlockId let the restore assertion pass off EITHER source, so a
    // version that stopped using the tombstone's id still looked correct; and `properties: {}`
    // meant restore's whole ev reconstruction fell through to defaults, pinning none of the
    // fields it actually reads.
    fetch: async (url) => {
      calls.fetched.push(String(url));
      return { ok: true, json: async () => ({ id: "not-the-moved-row",
        properties: { local_id: "notion-1", title: "Task notion-1", start: "14:00", duration: 45 } }) };
    },
    window: {
      blockStore: {
        // Backed by what createBlock actually recorded, so the tombstone dedupe guard is
        // reachable. `() => []` made `already` permanently undefined and the guard dead.
        getByType: () => createdBlocks.slice(),
        get: (bid) => createdBlocks.find((b) => b.id === bid) || null,
        rescheduleBlock: async (blockId, targetDate, opts) => {
          calls.reschedule.push({ blockId, targetDate, opts });
          if (rescheduleFails) { const e = new Error(rescheduleFails.message); e.status = rescheduleFails.status; e.permanent = rescheduleFails.status === 400 || rescheduleFails.status === 404; throw e; }
          return { moved: [blockId], parentId: blockId, targetDate };
        },
        createBlock: async (type, props, opts) => { const b = { id: "created-" + (props.local_id || "x"), type, date: opts && opts.date, properties: props }; createdBlocks.push(b); calls.created.push({ item: props, date: opts && opts.date, block: b }); return b; },
        deleteBlock: async (id) => { calls.deleted.push(id); const i = createdBlocks.findIndex((b) => b.id === id); if (i >= 0) createdBlocks.splice(i, 1); },
        // Was missing entirely, so the tombstone-refresh path threw into its own catch and
        // silently did nothing -- the test read the stale destination and looked like a
        // production bug. A stub that is absent is not a neutral stub.
        updateBlock: async (id, props) => {
          calls.updated = calls.updated || [];
          calls.updated.push({ id, props });
          const b = createdBlocks.find((x) => x.id === id);
          if (b) b.properties = { ...props };
          return b || { id, properties: props };
        },
        loadDay: async () => {},
      },
    },
  };
  vm.createContext(context);
  installTaskModel(context);
  vm.runInContext(MOVER_SRC, context);
  // moveTaskToTomorrow is defined elsewhere in state.js; wire the real one-liner so
  // pushTask's delegation is exercised rather than stubbed away.
  vm.runInContext("function moveTaskToTomorrow(id){return rescheduleTaskToDate(id,_resolvedTomorrowDate())}", context);
  return { context, calls, deletedSet, addedTasks, createdBlocks, savedDeletedRef: () => savedDeleted };
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

// ── The paths that hid real bugs, all three found by review rather than by me ──────────

test("restoring a materialized move leaves the task VISIBLE, not hidden on both days", async () => {
  // The blocking bug. _materializeTaskOnDate hides the origin-day copy by putting its id in
  // deletedSet and persisting that into the day_root `_deleted` overlay. restoreRescheduledAway
  // moved the row back, deleted the tombstone, then called reloadPersistedEdits — which
  // rebuilds deletedSet FROM that overlay, so the id went straight back in. The restored row
  // folded in with isDeleted(ev) true and rendered nowhere: on the origin day, visible on none.
  //
  // Note this became reachable only because C3 started writing movedBlockId. Before that the
  // Restore button was inert, so the fix that made it work is what exposed this.
  const { context, calls, deletedSet } = load({ scheduled: [ev("notion-1")], rows: {} });
  // A real day's hide set is not just the moved task. Seeded so the assertion can tell
  // "un-hid the restored task" from "un-hid everything" -- `deletedSet.clear()` would read
  // identically without this, while resurrecting every task the user deleted on this day.
  vm.runInContext('deletedSet.add("user-deleted-this"); saveDeletedState();', context);
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.ok(deletedSet.has("notion-1"), "hidden on the origin day by the move");
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  assert.ok(tomb, "a tombstone was written");
  await vm.runInContext(`restoreRescheduledAway("${tomb.block.id}")`, context);
  assert.equal(deletedSet.has("notion-1"), false,
    "restore must un-hide the origin-day copy, or the task is on one day and visible on none");
  assert.ok(deletedSet.has("user-deleted-this"),
    "and ONLY that one -- a restore must not resurrect the day's other deletes");
  assert.deepEqual(calls.deleted, [tomb.block.id], "and the amber entry is cleared");
});

test("restore moves the row that now holds the task back to the origin day", async () => {
  const { context, calls } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  const before = calls.reschedule.length;
  await vm.runInContext(`restoreRescheduledAway("${tomb.block.id}")`, context);
  assert.deepEqual(calls.reschedule.slice(before).map((c) => [c.blockId, c.targetDate]), [["new-notion-1", TODAY]],
    "it moves the materialized row, which is what movedBlockId records");
});

test("a subtask that cannot follow its parent is reported, not silently stranded", async () => {
  // The catch used to be a bare console.warn while the success toast fired unconditionally:
  // parent materialized on the target date, origin copy hidden, subtask left behind under a
  // parent that is gone — verbatim the bug this phase exists to delete, behind a green toast.
  const { context, calls } = load({
    scheduled: [ev("notion-1"), ev("s1", { subtaskOf: "notion-1" })],
    rows: { s1: row("s1") },
    rescheduleFails: { status: 400, message: "Block is deleted" },
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.equal(calls.reschedule.length, 1, "it tried to move the child");
  const toast = calls.toasts[calls.toasts.length - 1];
  assert.match(toast.msg, /stayed behind/i, "a half-move must not read as a clean one, got: " + JSON.stringify(calls.toasts));
  assert.notEqual(toast.kind, "success");
});

test("a day-state-only child with no row of its own is hidden with its parent", async () => {
  // It cannot be moved (nothing to re-date), so the only honest outcome is to hide it.
  // Left visible it renders as an orphaned top-level row on the origin day forever, because
  // flattenSchedule treats a row whose parent is absent as a root.
  const { context, deletedSet } = load({
    scheduled: [ev("notion-1"), ev("ds-kid", { subtaskOf: "notion-1" })],
    rows: {},
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.ok(deletedSet.has("ds-kid"), "a row-less child must not be left behind visible");
});

test("the materialized move drops the whole subtree from the origin day's view", async () => {
  // The true move calls _removeSubtreeFromScheduled; this path did not, so children whose
  // rows had just been re-dated stayed in `scheduled` and rendered as live open roots on the
  // origin day, still counting toward its points.
  const { context } = load({
    scheduled: [ev("notion-1"), ev("s1", { subtaskOf: "notion-1" }), ev("other")],
    rows: { s1: row("s1") },
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  assert.deepEqual([...vm.runInContext("scheduled.map(e=>e.id)", context)], ["other"],
    "parent and children both leave this day's view");
});

test("a permanent rejection resolves FALSE so a caller cannot bank a completion on it", async () => {
  // toggleDone's done-on-date flow commits a completion after the move resolves. Marking a
  // task done on a date it never reached patches that day's _done overlay and banks points
  // while the row sits unchecked where it actually is.
  const { context } = load({
    scheduled: [ev("t1")], rows: { t1: row("t1") },
    rescheduleFails: { status: 400, message: "Block is deleted" },
  });
  const result = await vm.runInContext(`rescheduleTaskToDate("t1","${TOMORROW}")`, context);
  assert.equal(result, false, "false = did not move and never will; undefined = queued, will land");
});

test("a second materialize off the same origin day reuses the tombstone", async () => {
  // The dedupe guard keys on sourceLocalId, not movedBlockId: every materialize mints a
  // fresh row, so a movedBlockId key could never match its own second run.
  const { context, calls } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  vm.runInContext('deletedSet.delete("notion-1"); scheduled.push({id:"notion-1",title:"Task notion-1",start:"09:00",end:"09:30",source:"manual"})', context);
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tombs = calls.created.filter((c) => c.item.kind === "reschedule_tombstone");
  assert.equal(tombs.length, 1, "one tombstone per (moved task, origin day), not one per move");
});

test("no file in public/js still reads the deleted pushed subsystem", async () => {
  // The previous version of this guard only grepped state.js, while isPushed was CALLED from
  // nine other files with no typeof guard (drag.js, triage.js, schedule.js, pet-home.js …).
  // A single missed call site is a hard ReferenceError in the browser and that test stayed green.
  const path = require("node:path");
  const dir = path.join(__dirname, "public", "js");
  const syms = ["isPushed", "pushedSet", "pushedAt", "savePushedState", "unpushTask",
    "schedulePushedOnDate", "schedulePushedOnTomorrow", "unschedulePushedFromTomorrow",
    "loadDeferred", "saveDeferred", "_cloneTaskForReschedule", "_rescheduledTaskId",
    "_hideSourceTaskForReschedule", "_rescheduleSubtaskSubtree", "_unfProgress", "_scheduleTaskOnDate"];
  // ANY reference, not `sym(`. Most of these were never functions: `pushedSet` and `pushedAt`
  // were module state read as `pushedSet.has(id)` / `pushedAt[id]`, with no paren after the
  // name, and read cross-file so a definition check does not help either. A `sym\s*\(` sweep
  // also misses `isPushed?.(ev)` and `window["isPushed"](ev)`. Every one of those is a hard
  // ReferenceError in the browser now.
  //
  // tabs.js has an unrelated local `const isPushed` for the meeting-doc "Push to Doc" button,
  // so that ONE file is exempt for that ONE symbol — rather than stripping
  // `const isPushed = ...` out of every file, which would erase a genuine reintroduction.
  const EXEMPT = { "tabs.js": new Set(["isPushed"]) };
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")     // block comments describe the deletion on purpose
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");  // line AND trailing comments; \s keeps http:// intact
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = strip(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const sym of syms) {
      if (EXEMPT[f] && EXEMPT[f].has(sym)) continue;
      assert.equal(new RegExp("\\b" + sym + "\\b").test(src), false, f + " still references " + sym);
    }
  }
});

test("restore reads the row movedBlockId names, and slots it with that row's real duration", async () => {
  const { context, calls } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  const slotsBefore = calls.slotFor.length;
  await vm.runInContext(`restoreRescheduledAway("${tomb.block.id}")`, context);
  assert.deepEqual(calls.fetched, ["/api/blocks/" + tomb.item.movedBlockId],
    "it fetches the row the tombstone names, not something it inferred");
  const slotEv = calls.slotFor[slotsBefore];
  assert.equal(slotEv.start, "14:00", "the slot is computed from the FETCHED row's start");
  assert.equal(slotEv.end, "00:45", "and its real duration, not a 30-minute default");
});

test("a row-less child is MATERIALIZED on the target date, not just hidden", async () => {
  // The regression round 2 caught. Hiding a day-state-only child without giving it a row on
  // the target date removed it from every day: its only representation was the origin day's
  // JSON, and once that id is in `_deleted` nothing renders it and nothing can un-hide it.
  const { context, calls, deletedSet } = load({
    scheduled: [ev("notion-1"), ev("ds-kid", { subtaskOf: "notion-1" })],
    rows: {},
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const kidCreate = calls.created.find((c) => (c.item.id || c.item.local_id) === "ds-kid");
  assert.ok(kidCreate, "the child gets a row on the target date: " + JSON.stringify(calls.created.map((c) => c.item.id || c.item.local_id)));
  assert.equal(kidCreate.date, TOMORROW);
  assert.equal(kidCreate.item.subtaskOf, "notion-1", "and keeps its nesting edge");
  assert.ok(deletedSet.has("ds-kid"), "the origin day's day-state copy is still hidden");
});

test("Restore un-hides the row-less children too, not just the parent", async () => {
  // Un-hiding only sourceLocalId left those ids in `_deleted` forever, because nothing else
  // removes an id from that overlay for a task with no visible row.
  const { context, calls, deletedSet } = load({
    scheduled: [ev("notion-1"), ev("ds-kid", { subtaskOf: "notion-1" })],
    rows: {},
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  assert.deepEqual([...tomb.item.hiddenLocalIds], ["ds-kid"], "the tombstone records what the move hid");
  await vm.runInContext(`restoreRescheduledAway("${tomb.block.id}")`, context);
  assert.equal(deletedSet.has("notion-1"), false, "parent un-hidden");
  assert.equal(deletedSet.has("ds-kid"), false, "and its row-less child, or the subtask is lost for good");
});

test("a parent cycle among row-less children terminates AND mints no duplicate row", async () => {
  // `scheduled` carries real parent cycles (see _subtreeIdsOf). The recursion only fires on
  // row-less children, so this is the shape that reaches it.
  //
  // The row-count assertion is the load-bearing half, and asserting only that the walk
  // terminated passed with a duplicate present. `_seen` guarded the recursion but not the
  // CREATE: the walk comes back onto the root, whose brand-new row is on the TARGET date, so
  // _findTaskBlockForDate refuses it (it will not return a row from another date) and a SECOND
  // row with the same local_id was minted. The fold dedupes by ev id, so that twin renders
  // nowhere while both rows exist -- one task, two rows, neither authoritative.
  const { context, calls, deletedSet } = load({
    scheduled: [ev("A", { subtaskOf: "B" }), ev("B", { subtaskOf: "A" })],
    rows: {},
  });
  await vm.runInContext(`rescheduleTaskToDate("A","${TOMORROW}")`, context);
  assert.ok(deletedSet.has("B"), "the cycle's other end was reached and the walk returned");
  const rowsForA = calls.created.filter((c) => (c.item.id || c.item.local_id) === "A" && c.item.kind !== "reschedule_tombstone");
  assert.equal(rowsForA.length, 1, "one row per task per move, not two sharing a local_id");
});

test("a subtask that failed to materialize stays VISIBLE on the origin day", async () => {
  // It did not move, so it must not be hidden -- and it must not be spliced out of the view
  // either. _removeSubtreeFromScheduled walks the whole subtree, so without re-inserting it
  // the row vanishes for one render and comes back as an orphaned root on the next reload.
  const { context, deletedSet } = load({
    scheduled: [ev("notion-1"), ev("ds-kid", { subtaskOf: "notion-1" }), ev("other")],
    rows: {},
    failMaterializeFor: ["ds-kid"],
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const left = [...vm.runInContext("scheduled.map(e=>e.id)", context)];
  assert.ok(left.includes("ds-kid"), "the child that could not move stays on this day: " + JSON.stringify(left));
  assert.equal(deletedSet.has("ds-kid"), false, "and is NOT hidden, because it did not move");
  assert.equal(left.includes("notion-1"), false, "while the parent, which did move, is gone");
});

test("a half-move is reported even when the caller asked for silence", async () => {
  // The silent caller is toggleDone's done-on-date flow, which goes on to mark the task
  // complete. "Some of this task stayed on another day" is exactly what it must not swallow.
  const { context, calls } = load({
    scheduled: [ev("notion-1"), ev("ds-kid", { subtaskOf: "notion-1" })],
    rows: {},
    failMaterializeFor: ["ds-kid"],
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}",{silent:true})`, context);
  assert.ok(calls.toasts.some((t) => /stayed behind/i.test(t.msg)),
    "a partial move speaks up regardless of opts.silent, got: " + JSON.stringify(calls.toasts));
  assert.equal(calls.toasts.some((t) => t.kind === "success"), false, "but the clean-move toast stays suppressed");
});

test("a second move off the same day to a DIFFERENT date refreshes the amber destination", async () => {
  // The dedupe key (sourceLocalId) is also the key the SERVER writes, so this guard can match
  // a tombstone left by a true move of the same task off the same day. Returning blind then
  // leaves the amber row naming an older destination and its Restore pointing at the wrong row.
  const LATER = "2026-08-05";
  const { context, calls } = load({ scheduled: [ev("notion-1")], rows: {} });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const tomb = calls.created.find((c) => c.item.kind === "reschedule_tombstone");
  vm.runInContext('deletedSet.delete("notion-1"); scheduled.push({id:"notion-1",title:"Task notion-1",start:"09:00",end:"09:30",source:"manual"})', context);
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${LATER}")`, context);
  const tombs = calls.created.filter((c) => c.item.kind === "reschedule_tombstone");
  assert.equal(tombs.length, 1, "still one tombstone per (task, origin day)");
  const live = vm.runInContext("window.blockStore.get(" + JSON.stringify(tomb.block.id) + ")", context);
  const p = live && live.properties;
  assert.equal(p.rescheduledTo, LATER, "the amber row must name where the task actually went");
  assert.notEqual(p.movedBlockId, tomb.item.movedBlockId, "and Restore must point at the row that now holds it");
});

test("a failed child keeps its WHOLE subtree on the origin day", async () => {
  // Fixed for the child but not its descendants: descending after a refused create
  // materialized the grandchild on the target date, where its subtaskOf resolves to nothing
  // and flattenSchedule renders it at depth 0 -- a subtask promoted to a top-level task on
  // another day. Nothing under a row that stayed may be moved.
  const { context, calls, deletedSet } = load({
    scheduled: [ev("notion-1"), ev("C", { subtaskOf: "notion-1" }), ev("G", { subtaskOf: "C" })],
    rows: {},
    failMaterializeFor: ["C"],
  });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const left = [...vm.runInContext("scheduled.map(e=>e.id)", context)];
  assert.ok(left.includes("C") && left.includes("G"), "the failed child AND its child stay: " + JSON.stringify(left));
  assert.equal(deletedSet.has("G"), false, "the grandchild is not hidden either");
  assert.equal(calls.created.some((c) => (c.item.id || c.item.local_id) === "G"), false,
    "and it was never created on the target date under a parent that is not there");
});

test("a pinned start survives on a row that stayed behind", async () => {
  // _removeSubtreeFromScheduled clears pin/lock on everything it splices, including the
  // persisted maps, so a task that never moved would silently lose a start the user pinned.
  const kid = ev("ds-kid", { subtaskOf: "notion-1" });
  kid._pinnedStart = "11:30";
  const { context } = load({ scheduled: [ev("notion-1"), kid], rows: {}, failMaterializeFor: ["ds-kid"] });
  await vm.runInContext(`rescheduleTaskToDate("notion-1","${TOMORROW}")`, context);
  const back = vm.runInContext('scheduled.find(e=>e.id==="ds-kid")', context);
  assert.ok(back, "it stayed");
  assert.equal(back._pinnedStart, "11:30", "and kept the pin the user set");
  assert.equal(vm.runInContext("loadPinnedStarts()", context)["ds-kid"], "11:30",
    "including in the persisted map, which persistence.js rehydrates from on reload");
});
