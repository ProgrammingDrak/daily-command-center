// Contract tests for the recalcTimes() cascade in public/js/drag.js, including
// the orderWins drag-reflow mode (list order is truth: pinned tasks bump and
// re-sync their pins; meetings/OOO/breaks and _locked tasks still hold).
// Harness pattern: slots-frontend-contract.test.js (raw source in a node:vm
// context with stubbed globals).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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
  const context = {
    console,
    window: { __TAGS__: null },
    scheduled,
    INIT_SCHED: opts.initSched || scheduled.slice(),
    __state: { schedule: { blocks: opts.blocks || [] } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: function (ev) { return this.pt(ev.end) - this.pt(ev.start); },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
    isNested: (ev) => !!(ev.wrapId || ev.subtaskOf),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    parentIdOf: (ev) => ev.wrapId || ev.subtaskOf || null,
    isWrap: (ev) => !!ev.isWrap || (Array.isArray(ev.tags) && ev.tags.includes("wrap")),
    loadPinnedStarts: () => pins,
    savePinnedStarts: () => { pinsSaved++; },
  };
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
