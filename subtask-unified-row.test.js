// Contract + behavior tests for subtask/normal-task unification.
//
// The whole point of the unification is that subtasks render through the SAME row
// builders as normal tasks (renderItineraryCard variant:"sub" on the timeline,
// row() in the list), so every affordance — open-space click to the details modal,
// radial, drag, checkbox — and every FUTURE change to those rows applies to
// subtasks automatically. These tests fail loudly if the forked path (renderSubRow
// and its helpers) ever comes back, and pin the drag-out promotion contract.
//
// Harness pattern: recalc-times.test.js (raw source in a node:vm context).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const cardSource = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
const schedTabSource = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");

// ─────────────────────────── Source-contract guards ───────────────────────────

test("renderSubRow and its schedule-tab helpers are gone (no forked subtask path)", () => {
  assert.ok(!/function\s+renderSubRow/.test(cardSource), "renderSubRow must not be defined in itinerary-card.js");
  assert.ok(!/window\.renderSubRow/.test(cardSource), "renderSubRow must not be exported");
  for (const fn of ["renderSubRow", "function subtaskActionsHtml", "function bindSubtaskActions",
                    "function moveSubtaskSibling", "function subtaskMoveState", "function startSubtaskTitleEdit"]) {
    assert.ok(!schedTabSource.includes(fn), `${fn} must be retired from schedule-tab.js`);
  }
});

test("timeline loop renders subtasks through renderItineraryCard(variant:'sub'), not a fork", () => {
  // No early-return that appends a separate builder before renderItineraryCard.
  assert.ok(!/rel==="subtask"\)\{tl\.appendChild\(renderSubRow/.test(schedTabSource),
    "timeline loop must not short-circuit subtasks to renderSubRow");
  assert.ok(/variant:\s*isSubNode\s*\?\s*"sub"\s*:\s*undefined/.test(schedTabSource),
    "timeline loop must pass variant:'sub' for subtask nodes");
});

test("list emitNode routes every node — including subtasks — through row()", () => {
  assert.ok(/function emitNode\(node,idx,mode\)\{return row\(node\.ev,/.test(schedTabSource),
    "emitNode must delegate to row() for all nodes");
  assert.ok(!/emitNode[\s\S]{0,80}renderSubRow/.test(schedTabSource),
    "emitNode must not call renderSubRow");
});

test("renderItineraryCard carries exactly one subtask branch (variant:'sub')", () => {
  assert.ok(/opts\.variant\s*===\s*"sub"/.test(cardSource),
    "renderItineraryCard must gate its subtask look on opts.variant");
});

// ─────────────────────────── Promotion behavior ───────────────────────────

// Minimal vm context around drag.js — mirrors recalc-times.test.js. Running the
// raw source gives us promoteToTopLevel/_promoteMutate/recalcTimes/_clearPin/etc.
function makeDay(scheduled) {
  const reconcileCalls = [];
  const persisted = [];
  const context = {
    console,
    document: { querySelectorAll: () => [] },
    window: {
      PointPlan: { reconcile: (pid) => { reconcileCalls.push(pid); } },
      blockStore: {
        _blocks: [],
        getByType: () => [],
        get: () => null,
        updateBlock: (id, props) => { persisted.push({ id, props }); },
      },
    },
    scheduled,
    INIT_SCHED: scheduled.slice(),
    __state: { schedule: { blocks: [] } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: function (ev) { return this.pt(ev.end) - this.pt(ev.start); },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
    isNested: (ev) => !!(ev.wrapId || ev.subtaskOf),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    parentIdOf: (ev) => (ev && (ev.wrapId || ev.subtaskOf)) || null,
    relOf: (ev) => ev ? (ev.wrapId ? "ride-along" : (ev.subtaskOf ? "subtask" : null)) : null,
    isWrap: (ev) => !!ev.isWrap,
    userMovable: (ev) => !(ev.type === "meeting" || ev.type === "oneone" || ev.type === "ooo" || ev.type === "break"),
    now: () => 9 * 60,
    loadPinnedStarts: () => ({}),
    savePinnedStarts: () => {},
    saveTaskOrder: () => {},
    syncAddedTaskTimes: () => {},
    showToast: () => {},
    log: () => {},
    render: () => {},
  };
  context.dur = context.dur.bind(context);
  vm.createContext(context);
  vm.runInContext(dragSource, context);
  return { context, reconcileCalls, persisted };
}

const find = (sched, id) => sched.find((e) => e.id === id);

test("promoteToTopLevel: timeless subtask becomes a real 30m top-level task", () => {
  const sched = [
    { id: "p", title: "Parent", type: "task", start: "09:00", end: "10:00" },
    { id: "s", title: "Sub", type: "task", subtaskOf: "p", start: "09:00", end: "09:00" }, // timeless
  ];
  const { context, reconcileCalls } = makeDay(sched);
  context.promoteToTopLevel("s");
  const s = find(sched, "s");
  assert.equal(s.subtaskOf, null, "subtaskOf cleared");
  assert.equal(s.wrapId, null, "wrapId cleared");
  assert.equal(context.dur(s), 30, "timeless subtask gets a real 30m duration");
  assert.deepEqual(reconcileCalls, ["p"], "old parent's point pie is reconciled");
});

test("promoteToTopLevel: persists cleared edges + the new duration to the blockstore", () => {
  const sched = [
    { id: "p", title: "Parent", type: "task", start: "09:00", end: "10:00" },
    { id: "s", title: "Sub", type: "task", subtaskOf: "p", start: "09:00", end: "09:00", _blockId: "blk-s" },
  ];
  const { context, persisted } = makeDay(sched);
  context.promoteToTopLevel("s");
  const write = persisted.find((w) => w.id === "blk-s");
  assert.ok(write, "the promoted subtask's block is persisted");
  assert.equal(write.props.subtaskOf, null);
  assert.equal(write.props.wrapId, null);
  assert.equal(write.props.duration, 30, "duration:0 must not linger in the persisted block");
});

test("promoteToTopLevel: no-op on a task that is already top-level", () => {
  const sched = [{ id: "a", title: "A", type: "task", start: "09:00", end: "09:30" }];
  const { context, reconcileCalls } = makeDay(sched);
  context.promoteToTopLevel("a");
  assert.equal(reconcileCalls.length, 0, "nothing to reconcile for a top-level task");
  assert.equal(find(sched, "a").start, "09:00");
});

// ─────────── Unscheduled-drop bug (QA find 2026-07-15): must schedule, not nest ───────────

// A drop onto the MIDDLE band of a timed row is the "nest" zone. Dragging a row
// out of the Unscheduled queue there used to turn it into a subtask of the target;
// it must schedule top-level instead.
function dropEvent({ clientY = 50, height = 100, shiftKey = false } = {}) {
  return {
    preventDefault() {},
    shiftKey,
    clientY,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, left: 0, height }) },
  };
}

test("Unscheduled drop onto a row's middle band schedules top-level, never nests", () => {
  const sched = [
    { id: "target", title: "Target", type: "task", start: "09:00", end: "09:30" },
    { id: "u", title: "Unscheduled one", type: "task", start: "00:00", end: "00:00", untimed: true },
  ];
  const { context } = makeDay(sched);
  // dragId is a lexical binding inside drag.js — set it the real way, via dStart.
  context.dStart({ dataTransfer: { effectAllowed: "", setData() {} }, target: { closest: () => null } }, "u");
  // clientY 50 of height 100 = dead center = the nest band.
  context.dDrop(dropEvent({ clientY: 50, height: 100 }), "target");
  const u = find(sched, "u");
  assert.equal(u.untimed, false, "task is now scheduled");
  assert.equal(u.subtaskOf ?? null, null, "must NOT become a subtask of the drop target");
  assert.equal(u.wrapId ?? null, null, "must NOT become a ride-along of the drop target");
});

test("Unscheduled drop onto a NESTED row still schedules top-level (guard covers _dropAtTargetLevel)", () => {
  // The nest-band guard alone isn't enough: an edge-drop onto a nested row routes
  // through _dropAtTargetLevel, which would join the moved task to the target's
  // parent. An Unscheduled-origin drop must skip that join too.
  const sched = [
    { id: "p", title: "Parent", type: "task", start: "09:00", end: "10:00" },
    { id: "sub", title: "A subtask", type: "task", subtaskOf: "p", start: "09:00", end: "09:00" },
    { id: "u", title: "Unscheduled one", type: "task", start: "00:00", end: "00:00", untimed: true },
  ];
  const { context } = makeDay(sched);
  context.dStart({ dataTransfer: { effectAllowed: "", setData() {} }, target: { closest: () => null } }, "u");
  // Edge drop (clientY near the top) onto the nested "sub" row.
  context.dDrop(dropEvent({ clientY: 8, height: 100 }), "sub");
  const u = find(sched, "u");
  assert.equal(u.untimed, false, "unscheduled task is now scheduled");
  assert.equal(u.subtaskOf ?? null, null, "must not inherit the nested target's parent as subtaskOf");
  assert.equal(u.wrapId ?? null, null, "must not inherit the nested target's parent as wrapId");
});

test("_dropAtTargetLevel: a timeless subtask joining a ride-along gets a real 30m duration", () => {
  // A ride-along keeps its own duration; a 0-minute subtask joining one must be
  // given a real duration or _chainWrapChildren falls back to a placeholder length.
  const sched = [
    { id: "w", title: "Wrap", type: "task", isWrap: true, start: "09:00", end: "11:00" },
    { id: "r", title: "Ride-along", type: "task", wrapId: "w", start: "09:00", end: "09:30" },
    { id: "s", title: "Timeless subtask", type: "task", subtaskOf: "p", start: "09:00", end: "09:00" },
  ];
  const { context } = makeDay(sched);
  // Join s to r's level (r is a ride-along of w) via an edge drop.
  context._dropAtTargetLevel(find(sched, "s"), find(sched, "r"), false);
  const s = find(sched, "s");
  assert.equal(s.wrapId, "w", "subtask joined the ride-along's wrap");
  assert.equal(s.subtaskOf ?? null, null, "subtaskOf edge cleared");
  assert.equal(context.dur(s), 30, "timeless subtask promoted to a ride-along gets 30m, not 0");
});

test("subShareChipHtml: renders a slice chip, turns 'earned' when the subtask is done", () => {
  // The shared chip helper (one definition used by both row builders). Run the
  // itinerary-card source in a vm and pull the exported helper off window.
  const cardSrc = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
  function chip(done) {
    const ctx = { window: {}, document: {}, isDone: () => done };
    vm.createContext(ctx);
    vm.runInContext(cardSrc, ctx);
    return ctx.window.subShareChipHtml;
  }
  assert.equal(chip(false)({ id: "s" }, null), "", "null share renders no chip");
  const open = chip(false)({ id: "s" }, 14);
  assert.match(open, /class="sub-share"/, "open subtask chip has no earned modifier");
  assert.match(open, /14 pts/);
  const done = chip(true)({ id: "s" }, 14);
  assert.match(done, /class="sub-share earned"/, "done subtask chip is earned (drives the .sub-share.earned rule)");
});
