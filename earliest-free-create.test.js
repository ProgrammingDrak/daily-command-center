// Contract tests for "⚡ Earliest free" in the CREATE half of the 2-step schedule
// picker (public/js/schedule.js).
//
// The chip existed but was gated behind placement mode, so every create surface --
// Triage most visibly -- had no way to say "whenever fits", and the create commit
// refused a null time outright. Three things about the fix are invisible from the
// server tests and each one is a real regression if it silently flips back:
//
//   * the GATE. Re-adding `if(_schedPickerOnPlace)` around the chip block removes
//     the whole feature from six callers and breaks nothing else, so nothing else
//     would fail.
//   * `_userSetStart`. drag.js _holdsTime holds a user-set row unconditionally, even
//     under orderWins. Stamping it on a slot the ENGINE chose (not Drake) would make
//     every earliest-free task undraggable-past for the rest of the day, which looks
//     like a drag bug three surfaces away from this file.
//   * `onScheduled`. It is the callback that clears the Triage row
//     (triage.js -> recordTriageScheduled). A create path that skips it leaves an
//     unclearable row and a modal that can never auto-close -- exactly the failure
//     scheduleTriageOnDate's comment already documents.
//
// Harness follows the two idioms this repo uses for public/js: slice the real source
// with a must-match guard, then run it in a node:vm with stubs
// (triage-suppression-client.test.js, completion-date-choice.test.js,
// launcher-urgent-menu.test.js for the fake document). The slot engine and the
// serializer are the REAL modules running in the context -- a hand-written findSlot
// would be a different program, and the point of the feature is that create and
// move now resolve through ONE engine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installDayContext } = require("./task-model-vm-fixture");
const serialize = require("./public/js/task-serialize");

const SRC = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  return m[0];
}

// ── the sliced regions ──────────────────────────────────────────────────────
const PRESETS = mustSlice(SRC, /^const SCHED_TIME_PRESETS_KEY[\s\S]*?^}/m, "loadSchedTimePresets");
const TIME_LABEL = mustSlice(SRC, /^function _schedTimeLabel\(hhmm\)\{[\s\S]*?\n\}/m, "_schedTimeLabel");
const PICKER_STATE = mustSlice(SRC, /^let _schedPickerTitle=[\s\S]*?_schedPickerVerb="";$/m, "picker module state");
const CLOSE = mustSlice(SRC, /^function closeSchedulePicker\(\)\{[\s\S]*?\n\}/m, "closeSchedulePicker");
const RENDER_AFTER = mustSlice(SRC, /^async function _renderSchedAfterStep\(dateStr\)\{[\s\S]*?\n\}/m, "_renderSchedAfterStep");
const DAY_TASKS = mustSlice(SRC, /^async function _schedDayTasks\(dateStr\)\{[\s\S]*?\n\}/m, "_schedDayTasks");
const EARLIEST = mustSlice(SRC, /^async function _schedEarliestFree\(dateStr,durMin\)\{[\s\S]*?\n\}/m, "_schedEarliestFree");
const BUSY = mustSlice(SRC, /^function _schedSetAfterBusy\(busy\)\{[\s\S]*?\n\}/m, "_schedSetAfterBusy");
const COMMIT = mustSlice(SRC, /^let _schedCommitting=false;\nasync function _schedCommit\(dateStr,timeStr\)\{[\s\S]*?\n\}/m, "_schedCommit");
const FIELDS = mustSlice(SRC, /^function schedulePickerFields\(durMin,options\)\{[\s\S]*?\n\}/m, "schedulePickerFields");
const COMMIT_TASK = mustSlice(SRC, /^function commitScheduledTask\(title,durMin,dateStr,timeStr,options,placement\)\{[\s\S]*?\n\}/m, "commitScheduledTask");

// pt/fmt/ms/_toHHMM sliced, not retyped: a gentler copy in the harness would move
// every time assertion off the code under test.
const PRIMITIVES = ["pt", "fmt", "ms", "_toHHMM"].map(name => {
  const re = new RegExp("^function " + name + "\\([\\s\\S]*?\\n\\}|^function " + name + "\\(.*\\}$", "m");
  return mustSlice(STATE_SRC, re, "state.js " + name);
}).join("\n");

const SECTION = [PRIMITIVES, PRESETS, TIME_LABEL, PICKER_STATE, CLOSE, RENDER_AFTER,
  DAY_TASKS, EARLIEST, BUSY, COMMIT, FIELDS, COMMIT_TASK].join("\n");

// ── harness ─────────────────────────────────────────────────────────────────
// A non-today date on purpose: day-context anchors the cursor to `now` only on the
// ACTUAL today, so every slot assertion below is wall-clock independent.
const DAY = "2099-01-05";

function makeEl(tag) {
  const el = {
    tagName: tag, type: "", className: "", textContent: "", value: "", disabled: false,
    innerHTML: "", children: [],
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { if (t === "click") el.onclick = fn; },
    querySelectorAll: () => [],
    classList: { add() {}, remove() {} }
  };
  return el;
}

function harness(opts) {
  opts = opts || {};
  const rec = {
    createBlocks: [], persisted: [], scheduled: [], toasts: [], logs: [],
    onPlace: [], onScheduled: [], recalcs: 0, renders: 0, warnings: 0, pins: {}
  };
  const els = {
    "sched-after-chips": makeEl("div"),
    "sched-after-tasks": makeEl("div"),
    "sched-after-daylabel": makeEl("span"),
    "sched-step-after": makeEl("div"),
    "sched-picker-overlay": null
  };
  const store = {};
  let seq = 0;
  const ctx = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, isNaN, parseInt, Set,
    document: {
      getElementById: id => (id in els ? els[id] : null),
      createElement: makeEl,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    scheduled: rec.scheduled,
    viewDate: opts.viewDate || DAY,
    __state: { date: opts.viewDate || DAY },
    qaId: () => "t" + (++seq),
    loadPinnedStarts: () => rec.pins,
    savePinnedStarts: p => { rec.pins = p; },
    recalcTimes: () => { rec.recalcs++; },
    render: () => { rec.renders++; },
    checkBlockWarnings: () => { rec.warnings++; },
    persistAddedTask: item => { rec.persisted.push(item); return { ok: true }; },
    log: (kind, id, msg) => rec.logs.push({ kind, id, msg }),
    showToast: (msg, sev) => rec.toasts.push({ msg, sev }),
    _prettyDateLabel: d => (d === DAY ? "Jan 5" : d),
    f12: s => s
  };
  ctx.window = {
    TaskTypes: null,
    USE_BLOCKSTORE: { addedTasks: true },
    blockStore: {
      createBlock: (type, props, o) => { rec.createBlocks.push({ type, props, opts: o }); return { id: "blk" + rec.createBlocks.length }; }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // REAL slot engine + REAL serializer, both inside the context.
  installDayContext(ctx);
  ctx.window.DCC = ctx.DCC;
  ctx.DCC.taskCommonProps = serialize.taskCommonProps;
  ctx.DCC.taskBlockProps = serialize.taskBlockProps;
  // The one piece of I/O: a day fetch. Everything downstream of it is real.
  const state = { date: DAY, schedule: { day_start: "09:00", blocks: [{ start: "09:00", end: "17:00" }], timeline: opts.timeline || [] } };
  ctx.DCC.getDayContext = d => (opts.dayContext
    ? opts.dayContext(d)
    : Promise.resolve(ctx.DCC.buildDayContext(d, state, opts.blocks || [])));
  vm.runInContext(SECTION, ctx);
  const run = expr => vm.runInContext(expr, ctx);
  return { ctx, rec, els, run, state };
}

// Arm the picker the way _schedPickDay leaves it, then commit.
function armCreate(h, options) {
  h.ctx.__opts = options || {};
  h.run('_schedPickerTitle="Reply to Janice";_schedPickerDur=30;_schedPickerOptions=__opts;'
    + '_schedPickerDate="' + DAY + '";_schedPickerOnPlace=null;');
}

// ── 1. the gate ─────────────────────────────────────────────────────────────

test("the Earliest free chip renders in CREATE mode, first in the row", async () => {
  const h = harness();
  h.run('_schedPickerOnPlace=null;_schedPickerDate="' + DAY + '";');
  await h.run('_renderSchedAfterStep("' + DAY + '")');
  const chips = h.els["sched-after-chips"].children;
  assert.ok(chips.length > 1, "expected the earliest-free chip plus the time presets");
  assert.match(chips[0].className, /sched-chip-earliest/,
    "the earliest-free chip must be FIRST: it is the one-tap default, ahead of the named times");
  assert.equal(chips[0].textContent, "⚡ Earliest free");
  // The three default presets still follow it, unchanged.
  assert.deepEqual(chips.slice(1).map(c => c.textContent), ["8 AM", "12 PM", "5 PM"]);
});

test("clicking the chip commits with a null time, which the create path resolves", async () => {
  const h = harness();
  armCreate(h);
  await h.run('_renderSchedAfterStep("' + DAY + '")');
  const chip = h.els["sched-after-chips"].children[0];
  await chip.onclick();
  assert.equal(h.rec.scheduled.length, 1, "the chip's click must reach a real commit");
  // dayStart 09:00, empty day -> the first free slot IS 09:00.
  assert.equal(h.rec.scheduled[0].start, "09:00");
  assert.equal(h.rec.scheduled[0].end, "09:30");
});

// ── 2. an engine-chosen start is not a user-named one ───────────────────────

test("an auto-placed row keeps the pin but is NOT marked user-set", async () => {
  const h = harness();
  armCreate(h);
  await h.run('_schedCommit("' + DAY + '",null)');
  const row = h.rec.scheduled[0];
  assert.equal(row._pinnedStart, "09:00", "the derived pin must stay: it is what stops recalcTimes cascading the row away");
  assert.equal("_userSetStart" in row, false,
    "the key must be ABSENT, not undefined — persistAddedTask reads the value and _setUserSetStart's contract is that a value test and an `in` test cannot disagree");
  assert.equal("_userSetStart" in h.rec.persisted[0], false, "and it must not reach the persisted item either");
});

test("a hand-named time still IS user-set (the pre-existing contract)", async () => {
  const h = harness();
  armCreate(h);
  await h.run('_schedCommit("' + DAY + '","14:00")');
  const row = h.rec.scheduled[0];
  assert.equal(row._userSetStart, true);
  assert.equal(row._pinnedStart, "14:00");
  assert.equal(row.start, "14:00");
});

test("the other-date arm drops userSetStart when auto-placed, keeps it when named", async () => {
  const other = "2099-02-09";
  const auto = harness({ viewDate: DAY });
  armCreate(auto);
  auto.run('_schedPickerDate="' + other + '";');
  await auto.run('_schedCommit("' + other + '",null)');
  assert.equal(auto.rec.createBlocks.length, 1);
  const props = auto.rec.createBlocks[0].props;
  assert.equal(props._pinnedStart, "09:00");
  assert.equal(props.userSetStart, undefined, "undefined drops out of the JSON body — the persistAddedTask idiom");

  const named = harness({ viewDate: DAY });
  armCreate(named);
  named.run('_schedPickerDate="' + other + '";');
  await named.run('_schedCommit("' + other + '","10:30")');
  assert.equal(named.rec.createBlocks[0].props.userSetStart, true);
});

// ── 3. the Triage-row-clears contract ──────────────────────────────────────

test("onScheduled still fires exactly once, with a concrete start, on both arms", async () => {
  const seen = [];
  const sameDay = harness();
  sameDay.ctx.__cb = info => seen.push(info);
  armCreate(sameDay, {});
  sameDay.run('_schedPickerOptions={onScheduled:__cb};');
  await sameDay.run('_schedCommit("' + DAY + '",null)');
  assert.equal(seen.length, 1, "losing this callback leaves an unclearable Triage row");
  assert.equal(seen[0].start, "09:00", "a null start would break responsibilities.js's parentStart and the Brief's copy");
  assert.equal(seen[0].dateStr, DAY);
  assert.ok(seen[0].localId);

  const other = "2099-02-09";
  const otherDay = harness();
  otherDay.ctx.__cb = info => seen.push(info);
  armCreate(otherDay, {});
  otherDay.run('_schedPickerOptions={onScheduled:__cb};_schedPickerDate="' + other + '";');
  await otherDay.run('_schedCommit("' + other + '",null)');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].start, "09:00");
});

// ── 4. a full day must not swallow the task ─────────────────────────────────

test("no free slot keeps the picker OPEN and says so", async () => {
  // 09:00-17:00 day, wall to wall past dayEnd+60 -> findSlot returns null.
  const h = harness({ blocks: [{ type: "block", properties: { start: "09:00", end: "23:00" } }] });
  armCreate(h);
  await h.run('_schedCommit("' + DAY + '",null)');
  assert.equal(h.rec.scheduled.length, 0, "nothing committed");
  assert.equal(h.rec.createBlocks.length, 0);
  assert.equal(h.run("_schedPickerDate"), DAY,
    "closeSchedulePicker clears _schedPickerDate — it still being set proves the modal stayed open for a hand-typed time");
  assert.equal(h.rec.toasts.length, 1);
  assert.match(h.rec.toasts[0].msg, /No free slot on Jan 5's schedule/);
  assert.equal(h.rec.toasts[0].sev, "error");
});

// ── 5. re-entrancy across the await ────────────────────────────────────────

test("a double-click during the resolve commits exactly once", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({
    dayContext: d => gate.then(() => h.ctx.DCC.buildDayContext(d, h.state, []))
  });
  armCreate(h);
  const a = h.run('_schedCommit("' + DAY + '",null)');
  const b = h.run('_schedCommit("' + DAY + '",null)');
  release();
  await a; await b;
  assert.equal(h.rec.scheduled.length, 1, "the modal stays open across the resolve, so the second click has to be latched out");
});

test("closing the picker mid-resolve commits nothing", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({
    dayContext: d => gate.then(() => h.ctx.DCC.buildDayContext(d, h.state, []))
  });
  armCreate(h);
  const p = h.run('_schedCommit("' + DAY + '",null)');
  h.run("closeSchedulePicker()");
  release();
  await p;
  assert.equal(h.rec.scheduled.length, 0, "the day moved on under the resolve; committing anyway would land a task on a day the user left");
});

// ── 6. movers are untouched ────────────────────────────────────────────────

test("placement mode still hands a raw null straight to onPlace", async () => {
  const h = harness();
  const calls = [];
  h.ctx.__onPlace = (d, t, title) => calls.push({ d, t, title });
  h.run('_schedPickerTitle="Move me";_schedPickerDur=30;_schedPickerOptions={};'
    + '_schedPickerDate="' + DAY + '";_schedPickerOnPlace=__onPlace;');
  await h.run('_schedCommit("' + DAY + '",null)');
  assert.deepEqual(calls, [{ d: DAY, t: null, title: "Move me" }],
    "rescheduleTaskToDate auto-slots a null pinnedStart itself — resolving it here would be a second engine");
  assert.equal(h.rec.scheduled.length, 0);
});

// ── 7. the anchor list ─────────────────────────────────────────────────────

test("an UNTIMED row is not offered as an anchor (the live arm)", async () => {
  // What Drake actually saw: five "ends 12:30 AM" rows crowding out the real anchors.
  // They are Unscheduled-section rows, which render inline yet carry a stored
  // 00:00-based end -- so 00:30 sorted ahead of every genuine end in the day.
  const h = harness();
  h.rec.scheduled.push(
    { title: "Real anchor", start: "09:00", end: "10:00" },
    { title: "Sitting in Unscheduled", start: "00:00", end: "00:30", untimed: true }
  );
  const items = await h.run('_schedDayTasks("' + DAY + '")');
  assert.deepEqual(Array.from(items, i => i.title), ["Real anchor"]);
});

test("a startless block is not offered as an anchor (the API arm)", async () => {
  // task-model.js DERIVES untimed from a missing properties.start, and this list only
  // ever required an end -- so the API arm had to start testing the same thing.
  const h = harness({ viewDate: "2099-03-01" });
  const blocks = [
    { type: "block", properties: { title: "Real anchor", start: "09:00", end: "10:00" } },
    { type: "block", properties: { title: "No start at all", end: "00:30" } }
  ];
  h.ctx.DCC.getDayContext = d => Promise.resolve(h.ctx.DCC.buildDayContext(d, h.state, blocks));
  const items = await h.run('_schedDayTasks("' + DAY + '")');
  assert.deepEqual(Array.from(items, i => i.title), ["Real anchor"]);
});

test("a past-midnight task is not offered as an anchor", async () => {
  const h = harness({ viewDate: "2099-03-01" });   // force the API branch, not live `scheduled`
  const blocks = [
    { type: "block", properties: { title: "Real anchor", start: "09:00", end: "10:00" } },
    { type: "block", properties: { title: "Overflowed", start: "23:00", end: "24:30" } },
    { type: "block", properties: { title: "Way over", start: "23:00", end: "25:00" } }
  ];
  h.ctx.DCC.getDayContext = d => Promise.resolve(h.ctx.DCC.buildDayContext(d, h.state, blocks));
  const items = await h.run('_schedDayTasks("' + DAY + '")');
  // Array.from: `items` is built inside the vm realm, so its prototype is not node's.
  assert.deepEqual(Array.from(items, i => i.title), ["Real anchor"],
    'fmt() does not wrap at midnight but pt() does, so a "24:30" end rendered as "ends 12:30 AM", sorted FIRST, and committed "24:30" as a start');
});

// ── 8. the engine, through this path ───────────────────────────────────────

test("the resolved slot is the shared engine's answer, not a local guess", async () => {
  const h = harness({ timeline: [{ type: "break", title: "Standup", start: "09:00", end: "10:00" }] });
  armCreate(h);
  await h.run('_schedCommit("' + DAY + '",null)');
  assert.equal(h.rec.scheduled[0].start, "10:00", "the 09:00 blocker must push the slot, exactly as findSlot says");
});
