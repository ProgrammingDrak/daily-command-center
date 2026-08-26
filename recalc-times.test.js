// Contract tests for the recalcTimes() cascade in public/js/drag.js, including
// the orderWins drag-reflow mode (list order is truth: pinned tasks bump and
// re-sync their pins; meetings/OOO/breaks and _locked tasks still hold).
// Harness pattern: slots-frontend-contract.test.js (raw source in a node:vm
// context with stubbed globals).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// C6a: the sliced code derives its task sets through DCC.TaskModel; install the real
// module INSIDE the context so it resolves this harness's isDone/isDeleted stubs.
const { installTaskModel, installDayContext } = require("./task-model-vm-fixture.js");

const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");

// addToSchedule only (schedule.js has DOM side effects at load; slice the one
// top-level function under test, same string-surgery spirit as the slots harness).
const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const addToScheduleSource = scheduleSource.match(/\/\/ opts \(drag drops\)[\s\S]*?function addToSchedule[\s\S]*?\n\}/)[0];

// Build a fresh vm context around a scheduled[] day. Time helpers mirror
// state.js (pt/fmt/dur); pins map is a plain object exposed for assertions.
function makeDay(scheduled, opts = {}) {
  const pins = opts.pins || {};
  let pinsSaved = 0;
  const userSetWrites = [];
  const context = {
    console,
    window: { __TAGS__: null },
    scheduled,
    INIT_SCHED: opts.initSched || scheduled.slice(),
    __state: { schedule: { blocks: opts.blocks || [], day_start: opts.dayStart } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: function (ev) { return this.pt(ev.end) - this.pt(ev.start); },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    // C6a: delegate to the real module (installed just below), not a second copy.
    isNested: (ev) => context.DCC.TaskModel.isNested(ev),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    parentIdOf: (ev) => context.DCC.TaskModel.parentIdOf(ev),
    relOf: (ev) => context.DCC.TaskModel.relOf(ev),
    isWrap: (ev) => !!ev.isWrap || (Array.isArray(ev.tags) && ev.tags.includes("wrap")),
    loadPinnedStarts: () => pins,
    savePinnedStarts: () => { pinsSaved++; },
    // The real one lives in schedule.js and persists `userSetStart` through
    // persistRowProp. Stubbed as a SPY, not omitted: without it `_clearPin`'s
    // `typeof _setUserSetStart === "function"` check is false and the tests would only
    // ever exercise the local-delete fallback, which never runs in the browser.
    _setUserSetStart: (ev, id, on) => {
      userSetWrites.push({ id, on });
      if (on) ev._userSetStart = true; else delete ev._userSetStart;
    },
  };
  context.__userSetWrites = userSetWrites;
  context.dur = context.dur.bind(context);
  // _dropAtTargetLevel collaborators (subtask-order spy; reparentAsSubtask left
  // undefined so the helper's manual fallback branch is what gets exercised)
  const subtaskOrderSaves = [];
  context.saveSubtaskOrder = (pid) => { subtaskOrderSaves.push(pid); };
  context.__subtaskOrderSaves = subtaskOrderSaves;
  // addToSchedule collaborators (no-ops except the backlog source list)
  context.consider = [];
  context.backlog = opts.backlog || [];
  context.deleteBacklogBlock = () => {};
  context.persistAddedTask = () => {};
  context.checkOverflow = () => {};
  context.log = () => {};
  context.render = () => {};
  vm.createContext(context);
  installTaskModel(context);
  // Only the floor tests install day-context. drag.js's _dayStartFloor is guarded, so
  // every other test in this file keeps its pre-feature anchor maths.
  if (opts.dayStart) installDayContext(context);
  vm.runInContext(dragSource, context);
  vm.runInContext(addToScheduleSource, context);
  return { context, pins, pinsSavedCount: () => pinsSaved, subtaskOrderSaves };
}

const t = (id, start, end, extra) => Object.assign({ id, title: id, type: "task", start, end }, extra);
const find = (sched, id) => sched.find((e) => e.id === id);

test("default mode: pinned task holds, unpinned flow around it", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("p", "10:00", "10:30", { _pinnedStart: "10:00" }),
    t("b", "11:00", "11:30"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes();
  assert.equal(find(sched, "p").start, "10:00"); // pin holds
  assert.equal(find(sched, "a").start, "09:00");
  assert.equal(find(sched, "b").start, "10:30"); // packs after the pinned block
});

test("orderWins: dropped task starts when the previous one ends; next task chains off it", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("moved", "10:00", "10:45"), // 45m, dropped right after a
    t("c", "09:30", "10:00"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "moved").start, "09:30");
  assert.equal(find(sched, "moved").end, "10:15");
  assert.equal(find(sched, "c").start, "10:15");
});

test("orderWins: chain flows around a meeting", () => {
  const meeting = t("mtg", "10:00", "10:30", { type: "meeting" });
  const sched = [
    t("a", "09:00", "09:45"),
    t("moved", "09:45", "10:15"), // 30m, would straddle the meeting
    meeting,
    t("c", "10:30", "11:00"),
  ];
  const { context } = makeDay(sched, { initSched: [meeting] });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "mtg").start, "10:00"); // meeting never moves
  assert.equal(find(sched, "moved").start, "10:30"); // bumped past the meeting
  assert.equal(find(sched, "c").start, "11:00");
});

test("orderWins: a moved meeting blocks the cascade at its NEW slot (live-sourced, not INIT_SCHED)", () => {
  // The meeting started the day at 13:00 (INIT_SCHED) but the user moved it to
  // 09:30. Task 'a' (60m, ordered first) would naturally sit 09:00-10:00 and
  // collide with the meeting's NEW slot, so it must be pushed past it. This only
  // holds if _meetingBlocks() reads the live scheduled position, not INIT_SCHED.
  const meetingInit = t("mtg", "13:00", "13:30", { type: "meeting" });
  const meetingNow = t("mtg", "09:30", "10:00", { type: "meeting" });
  const sched = [
    t("a", "09:00", "10:00"),
    meetingNow,
  ];
  const { context } = makeDay(sched, { initSched: [meetingInit] });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "mtg").start, "09:30");  // meeting held at its moved time
  assert.equal(find(sched, "a").start, "10:00");    // bumped past the meeting's NEW slot
});

test("orderWins: locked task holds; successor starts at its end", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("lk", "09:30", "10:00", { _locked: true }),
    t("c", "10:30", "11:00"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "lk").start, "09:30"); // lock holds
  assert.equal(find(sched, "c").start, "10:00"); // chains from the locked end
});

test("orderWins: pinned task bumps, pin updates, explicit pin map re-syncs", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("p", "10:00", "10:30", { _pinnedStart: "10:00" }), // in the explicit map
    t("q", "11:00", "11:30", { _pinnedStart: "11:00" }), // auto-pin, not in map
  ];
  const pins = { p: "10:00", other: "08:00" };
  const day = makeDay(sched, { pins });
  day.context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "p").start, "09:30"); // pulled up to the chain
  assert.equal(find(sched, "p")._pinnedStart, "09:30"); // pin follows
  assert.equal(pins.p, "09:30"); // map entry rewritten
  assert.equal(pins.other, "08:00"); // untouched
  assert.ok(!("q" in pins)); // auto-pins never added to the map
  assert.equal(find(sched, "q")._pinnedStart, "10:00");
  assert.equal(day.pinsSavedCount(), 1);
});

test("★★ a DERIVED pin still anchors the day; only INTENT leaves the anchor pool", () => {
  // The anchor exclusion is justified by intent ("a hand-set 06:00 must not drag the whole
  // day down to 06:00"). Keying it on _holdsTime instead sweeps out derived pins too, and
  // task-model.js stamps one on every top-level timed row -- so on the no-opts paths
  // (pinStartTime, render, add-task) almost the entire day leaves the pool and unpinned
  // work stops filling the morning. INIT_SCHED is empty so firstOrig cannot mask it.
  const sched = [t("P", "09:00", "10:00", { _pinnedStart: "09:00" }), t("Q", "14:00", "14:30")];
  const { context } = makeDay(sched, { initSched: [] });
  context.recalcTimes();
  assert.equal(find(sched, "P").start, "09:00");
  assert.equal(find(sched, "Q").start, "10:00"); // pulled up behind the pin, not left at 14:00
});

test("★★ the reach-back applies to the DRAGGED row only, not the chain behind it", () => {
  // `cursor` is the one cursor pass 2 threads through the whole day, so lowering it for the
  // dropped row re-anchors every untouched task after it. That is the exact harm the anchor
  // pool above exists to prevent, reintroduced through the other door.
  const sched = [
    t("B", "10:00", "10:30"),                                          // dropped at the top
    t("U", "06:00", "06:30", { _userSetStart: true }),
    t("A", "09:00", "09:30"),                                          // never touched
  ];
  const { context } = makeDay(sched, { initSched: [t("A", "09:00", "09:30")] });
  context.recalcTimes({ orderWins: true, reachBackFor: "B" });
  assert.equal(find(sched, "B").start, "05:30"); // reached back before the hand-set 06:00
  assert.equal(find(sched, "U").start, "06:00"); // held
  assert.equal(find(sched, "A").start, "09:00"); // NOT dragged back to 06:30
});

test("★ orderWins: a USER-SET start holds while a DERIVED pin bumps", () => {
  // The whole reason _userSetStart exists apart from _pinnedStart. task-model.js derives
  // a _pinnedStart for every timed row, so orderWins must demote those or a drag could
  // never reorder anything -- but a time a person typed has to survive that same drag.
  const sched = [
    t("a", "09:00", "09:30"),
    t("p", "11:00", "11:30", { _pinnedStart: "11:00" }),                       // derived
    t("u", "14:00", "14:30", { _pinnedStart: "14:00", _userSetStart: true }),  // hand-set
  ];
  const pins = { p: "11:00", u: "14:00" };
  const day = makeDay(sched, { pins });
  day.context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "p").start, "09:30");        // derived pin still bumps
  assert.equal(pins.p, "09:30");                        // and re-syncs, as before
  assert.equal(find(sched, "u").start, "14:00");        // hand-set start untouched
  assert.equal(find(sched, "u")._pinnedStart, "14:00");
  assert.equal(pins.u, "14:00");                        // and never rewritten
});

test("★ orderWins: a user-set start EARLIER than the plan holds, and is not the anchor", () => {
  // The reported bug, in one case: set a task to 06:00, then drag anything. It used to
  // be pulled back into the chain AND to drag the whole day's anchor down with it.
  const sched = [
    t("early", "06:00", "06:30", { _pinnedStart: "06:00", _userSetStart: true }),
    t("a", "09:00", "09:30"),
    t("b", "10:00", "10:30"),
  ];
  const { context } = makeDay(sched, { initSched: [t("a", "09:00", "09:30")] });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "early").start, "06:00"); // held
  assert.equal(find(sched, "a").start, "09:00");     // anchor is still the day's plan
  assert.equal(find(sched, "b").start, "09:30");     // ordinary chain, unchanged
});

test("★ orderWins: a drop at the very top lands BEFORE the day's first held item", () => {
  // Without reachBackFor the cascade anchor is a floor no drop position can beat, so
  // "drag it above the 09:00 task" landed it at 09:30 instead. reachBackFor is ignored
  // unless the task really is first in the chain, so every other drop is untouched.
  const day = () => {
    const sched = [
      t("moved", "13:00", "13:45"),                                              // 45m
      t("u", "09:00", "09:30", { _pinnedStart: "09:00", _userSetStart: true }),
    ];
    return { sched, ctx: makeDay(sched, { initSched: [t("u", "09:00", "09:30")] }).context };
  };
  const before = day();
  before.ctx.recalcTimes({ orderWins: true });
  assert.equal(find(before.sched, "moved").start, "09:30"); // control: pushed past it
  const after = day();
  after.ctx.recalcTimes({ orderWins: true, reachBackFor: "moved" });
  assert.equal(find(after.sched, "moved").start, "08:15");  // 09:00 minus its 45m
  assert.equal(find(after.sched, "moved").end, "09:00");
  assert.equal(find(after.sched, "u").start, "09:00");      // the held item never moves
});

test("★ orderWins: the reach-back lands a top drop BEFORE a meeting too", () => {
  // The comment on reachBackFor names a meeting first, but every other test here uses a
  // hand-set start as the held item. A meeting reaches `blockers` by a different route
  // (_meetingBlocks, not the pass-1 push) and is the ONLY case where the
  // `!isFixedTimeBlock` filter on `top` is load-bearing: without it the meeting is top[0],
  // the id check fails, and the reach-back silently does nothing.
  const mtg = t("mtg", "09:00", "10:00", { type: "meeting" });
  const sched = [t("moved", "13:00", "13:30"), mtg];
  const { context } = makeDay(sched, { initSched: [mtg] });
  context.recalcTimes({ orderWins: true, reachBackFor: "moved" });
  assert.equal(find(sched, "moved").start, "08:30"); // 09:00 minus its 30m
  assert.equal(find(sched, "mtg").start, "09:00");   // the meeting never moves
});

test("★ orderWins: a drop AFTER a leading meeting must not reach back past it", () => {
  // The drop landed at index 1, behind the meeting. Excluding fixed blocks when deciding
  // "did this land first" would make the meeting invisible to that check, so the task
  // would be treated as first and yanked to 08:30 -- in front of the very meeting the
  // user dropped it behind.
  const mtg = t("mtg", "09:00", "10:00", { type: "meeting" });
  const sched = [mtg, t("moved", "13:00", "13:30")];
  const { context } = makeDay(sched, { initSched: [mtg] });
  context.recalcTimes({ orderWins: true, reachBackFor: "moved" });
  assert.equal(find(sched, "moved").start, "10:00"); // after the meeting, where it was dropped
  assert.equal(find(sched, "mtg").start, "09:00");
});

test("orderWins: reachBackFor is ignored when the task did not land first", () => {
  const sched = [
    t("u", "09:00", "09:30", { _pinnedStart: "09:00", _userSetStart: true }),
    t("moved", "13:00", "13:30"),
  ];
  const { context } = makeDay(sched, { initSched: [t("u", "09:00", "09:30")] });
  context.recalcTimes({ orderWins: true, reachBackFor: "moved" });
  assert.equal(find(sched, "moved").start, "09:30"); // still chains after the held row
});

test("orderWins: the reach-back clamps at midnight", () => {
  const sched = [
    t("moved", "13:00", "13:30"),
    t("u", "00:15", "00:45", { _pinnedStart: "00:15", _userSetStart: true }),
  ];
  const { context } = makeDay(sched, { initSched: [t("u", "00:15", "00:45")] });
  context.recalcTimes({ orderWins: true, reachBackFor: "moved" });
  // No room for 30m before 00:15, so it packs after rather than wrapping to yesterday.
  assert.equal(find(sched, "moved").start, "00:45");
});

test("★ tag-aware: a held row is a BLOCKER, so the fallback cascade routes around it", () => {
  // Pass 1's job is to push the held row into `blockers`. Asserting only that the held row
  // stayed put is satisfied by the pass-2 hold alone, so this covers the double-booking
  // that the pass-1 line is what actually prevents.
  const sched = [t("a", "14:00", "15:00"), t("u", "14:00", "14:30", { _userSetStart: true })];
  const blocks = [{ id: "b1", start: "09:00", end: "17:00", acceptedTags: ["deep"] }];
  const { context } = makeDay(sched, { blocks, initSched: [t("a", "14:00", "15:00")] });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "u").start, "14:00");
  assert.equal(find(sched, "a").start, "14:30"); // routed past it, not stacked on top
});

test("★ tag-aware: an early user-set start is not the day's anchor", () => {
  const sched = [t("early", "06:00", "06:30", { _userSetStart: true }), t("a", "09:00", "09:30")];
  const blocks = [{ id: "b1", start: "09:00", end: "17:00", acceptedTags: ["deep"] }];
  const { context } = makeDay(sched, { blocks, initSched: [t("a", "09:00", "09:30")] });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "early").start, "06:00");
  assert.equal(find(sched, "a").start, "09:00"); // 06:30 without the tagAnchorPool filter
});

test("★ tag-aware mode holds a user-set start too", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("u", "14:00", "14:30", { _userSetStart: true }),
  ];
  const blocks = [{ id: "b1", start: "09:00", end: "17:00", acceptedTags: ["deep"] }];
  const { context } = makeDay(sched, { blocks });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "u").start, "14:00");
});

test("_clearPin drops the hand-set intent along with the derived pin", () => {
  // A drag IS the user handing that task's time back to the cascade. Only the DRAGGED
  // row reaches _clearPin; every other user-set start on the day survives.
  const sched = [t("a", "09:00", "09:30", { _pinnedStart: "09:00", _userSetStart: true })];
  const pins = { a: "09:00" };
  const day = makeDay(sched, { pins });
  day.context._clearPin(find(sched, "a"));
  assert.equal("_pinnedStart" in find(sched, "a"), false);
  assert.equal("_userSetStart" in find(sched, "a"), false);
  assert.equal("a" in pins, false);
  assert.deepEqual(day.context.__userSetWrites, [{ id: "a", on: false }],
    "cleared through the PERSISTING writer, not the local fallback");
});

test("orderWins: pure chain closes gaps (downstream pulls earlier)", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("p", "11:00", "11:30", { _pinnedStart: "11:00" }),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "p").start, "09:30"); // gap closed despite the pin
});

test("orderWins: task moved to first position inherits the day's earliest start", () => {
  const sched = [
    t("moved", "13:00", "13:30"),
    t("a", "09:00", "09:30"),
    t("b", "09:30", "10:00"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "moved").start, "09:00");
  assert.equal(find(sched, "a").start, "09:30");
  assert.equal(find(sched, "b").start, "10:00");
});

test("orderWins: nested ride-along keeps its time and consumes no cursor", () => {
  const sched = [
    t("wrap", "09:00", "10:00", { isWrap: true }),
    t("ride", "09:15", "09:30", { wrapId: "wrap" }),
    t("c", "10:30", "11:00"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "ride").start, "09:15"); // untouched
  assert.equal(find(sched, "c").start, "10:00"); // chains from the wrap, not the ride-along
});

test("orderWins: done tasks keep their time and don't consume the chain", () => {
  const sched = [
    t("d", "08:00", "08:30", { done: true }),
    t("a", "09:00", "09:30"),
    t("c", "10:00", "10:30"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "d").start, "08:00"); // untouched
  assert.equal(find(sched, "a").start, "09:00");
  assert.equal(find(sched, "c").start, "09:30"); // chains from a, not from d
});

test("backlog drop lands at the drop position and chains from there", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("b", "09:30", "10:00", { _pinnedStart: "09:30" }),
  ];
  const backlog = [{ id: "new", title: "New task", durMin: 45, type: "task", meta: "", priority: "High" }];
  const { context } = makeDay(sched, { backlog });
  context.addToSchedule("new", { targetId: "a", after: true, orderWins: true });
  assert.equal(find(sched, "new").start, "09:30"); // dropped right after a
  assert.equal(find(sched, "new").end, "10:15");
  assert.equal(find(sched, "b").start, "10:15"); // pinned successor bumped
});

test("addToSchedule without opts keeps the append-at-end behavior", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("b", "09:30", "10:00"),
  ];
  const backlog = [{ id: "new", title: "New task", durMin: 30, type: "task", meta: "", priority: "High" }];
  const { context } = makeDay(sched, { backlog });
  context.addToSchedule("new");
  assert.equal(find(sched, "new").start, "10:00"); // appended after the last task
  assert.equal(find(sched, "a").start, "09:00");
  assert.equal(find(sched, "b").start, "09:30");
});

test("orderWins: untimed rows are excluded and don't poison the anchor", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("u", "00:00", "00:30", { untimed: true }),
    t("c", "10:00", "10:30"),
  ];
  const { context } = makeDay(sched);
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "u").start, "00:00"); // untouched
  assert.equal(find(sched, "a").start, "09:00"); // anchor is 09:00, not midnight
  assert.equal(find(sched, "c").start, "09:30");
});

test("tag-aware mode still outranks orderWins: pinned task does not bump", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("p", "10:00", "10:30", { _pinnedStart: "10:00" }),
  ];
  const blocks = [{ id: "b1", start: "09:00", end: "12:00", acceptedTags: ["deep"] }];
  const { context } = makeDay(sched, { blocks });
  context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "p").start, "10:00"); // tag-aware pass keeps the pin
});

// ---- _dropAtTargetLevel: edge drops on nested rows join the target's level ----

test("edge drop under a ride-along joins the wrap and re-chains the nest", () => {
  const sched = [
    t("wrapA", "09:00", "10:00", { isWrap: true }),
    t("r1", "09:00", "09:20", { wrapId: "wrapA" }),
    t("x", "10:00", "10:30"),
    t("c", "10:30", "11:00"),
  ];
  const { context } = makeDay(sched);
  const joined = context._dropAtTargetLevel(find(sched, "x"), find(sched, "r1"), true);
  const jWs = context.pt(joined.start); // dDrop Case C' sequence: reflow, then delta-shift
  context.recalcTimes({ orderWins: true });
  context._shiftWrapChildren(joined, jWs);
  assert.equal(joined.id, "wrapA"); // ride-along join returns the wrap
  assert.equal(find(sched, "x").wrapId, "wrapA"); // joined the nest, not top level
  assert.equal(find(sched, "x").subtaskOf, null);
  assert.equal(find(sched, "r1").start, "09:00"); // nest chained in order
  assert.equal(find(sched, "x").start, "09:20");
  assert.equal(find(sched, "x").end, "09:50");
  assert.equal(find(sched, "c").start, "10:00"); // top-level gap closed behind x
});

test("edge drop under a subtask joins as a sibling subtask at the drop position", () => {
  const sched = [
    t("p", "09:00", "10:00"),
    t("s1", "09:00", "09:00", { subtaskOf: "p" }),
    t("s2", "09:00", "09:00", { subtaskOf: "p" }),
    t("x", "10:00", "10:30"),
  ];
  const day = makeDay(sched);
  const handled = day.context._dropAtTargetLevel(find(sched, "x"), find(sched, "s1"), true);
  assert.equal(handled, true);
  assert.equal(find(sched, "x").subtaskOf, "p");
  assert.equal(find(sched, "x").wrapId, null);
  const sibs = sched.filter((e) => e.subtaskOf === "p").map((e) => e.id);
  assert.deepEqual(sibs, ["s1", "x", "s2"]); // landed between s1 and s2
  assert.deepEqual(day.subtaskOrderSaves, ["p"]); // order persisted for the parent
});

test("edge drop within the same subtask nest reorders without promoting", () => {
  const sched = [
    t("p", "09:00", "10:00"),
    t("s1", "09:00", "09:00", { subtaskOf: "p" }),
    t("s2", "09:00", "09:00", { subtaskOf: "p" }),
  ];
  const { context } = makeDay(sched);
  const handled = context._dropAtTargetLevel(find(sched, "s2"), find(sched, "s1"), false);
  assert.equal(handled, true);
  assert.equal(find(sched, "s2").subtaskOf, "p"); // still nested
  const sibs = sched.filter((e) => e.subtaskOf === "p").map((e) => e.id);
  assert.deepEqual(sibs, ["s2", "s1"]);
});

test("edge drop of a parent under its own subtask is refused (cycle guard)", () => {
  const sched = [
    t("p", "09:00", "10:00"),
    t("s1", "09:00", "09:00", { subtaskOf: "p" }),
  ];
  const { context } = makeDay(sched);
  const handled = context._dropAtTargetLevel(find(sched, "p"), find(sched, "s1"), true);
  assert.equal(handled, false); // caller falls back to the top-level path
  assert.equal(find(sched, "p").subtaskOf, undefined);
});

test("edge drop on a top-level target is not handled by the nest path", () => {
  const sched = [t("a", "09:00", "09:30"), t("b", "09:30", "10:00")];
  const { context } = makeDay(sched);
  assert.equal(context._dropAtTargetLevel(find(sched, "b"), find(sched, "a"), true), false);
});

test("_chainWrapChildren stacks overflow back at the window start", () => {
  const sched = [
    t("wrapA", "09:00", "09:45", { isWrap: true }),
    t("r1", "09:00", "09:30", { wrapId: "wrapA" }),
    t("r2", "09:30", "10:00", { wrapId: "wrapA" }),
    t("r3", "09:00", "09:20", { wrapId: "wrapA" }),
  ];
  const { context } = makeDay(sched);
  context._chainWrapChildren(find(sched, "wrapA"));
  assert.equal(find(sched, "r1").start, "09:00"); // 30m
  assert.equal(find(sched, "r2").start, "09:30"); // 30m, ends past window (over-capacity)
  assert.equal(find(sched, "r3").start, "09:00"); // cursor past window end: stacked at start
});

test("wrap moves during the reflow: joined nest shifts with it (post-reflow delta)", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    t("x", "09:30", "10:00"), // vacates this top-level slot by joining the nest
    t("wrapB", "10:00", "11:00", { isWrap: true }),
    t("k", "10:00", "10:20", { wrapId: "wrapB" }),
  ];
  const { context } = makeDay(sched);
  const joined = context._dropAtTargetLevel(find(sched, "x"), find(sched, "k"), false);
  const jWs = context.pt(joined.start);
  context.recalcTimes({ orderWins: true });
  context._shiftWrapChildren(joined, jWs);
  assert.equal(find(sched, "wrapB").start, "09:30"); // wrap pulled up behind x
  assert.equal(find(sched, "x").start, "09:30"); // nest followed the wrap
  assert.equal(find(sched, "x").end, "10:00");
  assert.equal(find(sched, "k").start, "10:00"); // still inside the new window
  assert.equal(find(sched, "k").end, "10:20");
});

test("subtask join uses the real reparentAsSubtask when present (time collapses to parent)", () => {
  const sched = [
    t("p", "09:00", "10:00"),
    t("s1", "09:00", "09:00", { subtaskOf: "p" }),
    t("x", "13:00", "13:30"),
  ];
  const day = makeDay(sched);
  const calls = [];
  day.context.reparentAsSubtask = (childId, parentId) => { // mirrors tabs.js reparentAsSubtask
    calls.push([childId, parentId]);
    const child = sched.find((e) => e.id === childId), parent = sched.find((e) => e.id === parentId);
    child.subtaskOf = parentId; child.wrapId = null;
    child.start = parent.start; child.end = child.start;
    return true;
  };
  const handled = day.context._dropAtTargetLevel(find(sched, "x"), find(sched, "s1"), true);
  assert.equal(handled, true);
  assert.deepEqual(calls, [["x", "p"]]);
  assert.equal(find(sched, "x").start, "09:00"); // collapsed to the parent's start
  assert.equal(find(sched, "x").end, "09:00");
  assert.deepEqual(sched.filter((e) => e.subtaskOf === "p").map((e) => e.id), ["s1", "x"]);
});

// ── START OF DAY: the floor on the cascade anchor ─────────────────────────
// recalcTimes anchors on the MINIMUM start across unheld rows, so one stray early
// row used to drag the whole day's cascade down with it. The user's start of day is
// a floor on that anchor. Held rows (_locked / _userSetStart) are excluded from the
// anchor pool already, so a hand-set early start keeps its slot without pulling the
// chain back down with it.

test("floor: a stray 00:00 row no longer cascades the whole day from midnight", () => {
  const sched = [t("stray", "00:00", "00:30"), t("a", "09:00", "09:30")];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.recalcTimes();
  assert.equal(find(sched, "stray").start, "07:00");
  assert.equal(find(sched, "a").start, "07:30");
});

test("floor: an early anchor lifts to the floor, and a later one is untouched", () => {
  const early = [t("a", "05:00", "05:30"), t("b", "05:30", "06:00")];
  makeDay(early, { dayStart: "07:00" }).context.recalcTimes();
  assert.equal(find(early, "a").start, "07:00");
  assert.equal(find(early, "b").start, "07:30");

  const late = [t("a", "09:00", "09:30"), t("b", "09:30", "10:00")];
  makeDay(late, { dayStart: "07:00" }).context.recalcTimes();
  assert.equal(find(late, "a").start, "09:00", "the floor must not PULL a later day earlier");
});

// The escape hatch. _userSetStart is set only where a human named a time, and it has
// to survive the floor -- otherwise "start of day" would silently overwrite the one
// thing the user asked for explicitly.
test("floor: a hand-set start before the floor still holds, and does not re-anchor the chain", () => {
  const sched = [t("hand", "06:00", "06:30", { _userSetStart: true }), t("a", "09:00", "09:30")];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "hand").start, "06:00", "the human named this time");
  assert.equal(find(sched, "a").start, "07:00", "the rest still starts at the floor");
});

test("floor: on today's view, a now() before the floor does not repack the day early", () => {
  const sched = [t("a", "09:00", "09:30")];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.viewMode = "today";
  day.context.now = () => 5 * 60 + 30; // 05:30, the early riser
  day.context.recalcTimes();
  assert.equal(find(sched, "a").start, "07:00");
});

// reachBackFor exists so a drop at the very top lands BEFORE a meeting or a hand-set
// start. The floor must not quietly undo that when the held item is itself early.
test("floor: reach-back still clears an EARLY held item, or the drop is a silent no-op", () => {
  const sched = [t("mv", "10:00", "10:30"), t("hold", "06:00", "06:30", { _userSetStart: true })];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.recalcTimes({ orderWins: true, reachBackFor: "mv" });
  assert.equal(find(sched, "mv").start, "05:30", "lands before the 06:00 hold it was dragged above");
  assert.equal(find(sched, "hold").start, "06:00");
});

// Reach-back is deliberately NOT floored: an explicit drag to the top outranks the
// floor, and clamping it would push the drop past the item it was dragged above.
test("reach-back stays below the floor when the hold leaves no room above it", () => {
  const sched = [t("mv", "13:00", "14:00"), t("hold", "07:30", "08:00", { _userSetStart: true })];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.recalcTimes({ orderWins: true, reachBackFor: "mv" });
  assert.equal(find(sched, "mv").start, "06:30", "before the 07:30 hold, not pushed to 08:00 after it");
});

test("reach-back with a hold just ABOVE the floor still lands the drop before it", () => {
  const sched = [t("mv", "13:00", "13:30"), t("hold", "07:15", "07:45", { _userSetStart: true })];
  const day = makeDay(sched, { dayStart: "07:00" });
  day.context.recalcTimes({ orderWins: true, reachBackFor: "mv" });
  assert.equal(find(sched, "mv").start, "06:45", "before the hold it was dragged above, not 07:45 after it");
});

// recalcTimesTagAware is the OTHER cascade: when any schedule block has acceptedTags,
// recalcTimes delegates to it and the per-block cursor -- not fallbackCursor -- is where
// tasks actually land. Reverting that one clamp used to leave every test in the repo green.
test("floor: a tagged block starting before the floor still places at the floor", () => {
  const sched = [t("a", "09:00", "09:30", { tags: ["deep"] })];
  const blocks = [{ id: "b1", start: "05:00", end: "17:00", acceptedTags: ["deep"] }];
  makeDay(sched, { blocks, dayStart: "07:00" }).context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "a").start, "07:00", "05:00 without the nextFree clamp");
});

test("floor: the tag-aware FALLBACK cursor is floored too, for a task no block accepts", () => {
  const sched = [t("a", "05:30", "06:00", { tags: ["other"] })];
  const blocks = [{ id: "b1", start: "05:00", end: "17:00", acceptedTags: ["deep"] }];
  makeDay(sched, { blocks, dayStart: "07:00" }).context.recalcTimes({ orderWins: true });
  assert.equal(find(sched, "a").start, "07:00");
});
