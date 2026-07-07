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
    loadPinnedStarts: () => pins,
    savePinnedStarts: () => { pinsSaved++; },
  };
  context.dur = context.dur.bind(context);
  vm.createContext(context);
  vm.runInContext(dragSource, context);
  return { context, pins, pinsSavedCount: () => pinsSaved };
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
