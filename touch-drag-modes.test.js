// Regression coverage for the TOUCH drag modes. On a phone the desktop mid-row
// nest band (25%-75% of the row) swallowed nearly every drop, so a long-press
// drag could only ever nest — the blue "reorder here" bar was unreachable.
// Touch now sends an explicit mode and dOver/dDrop honor it; a mouse drag sends
// no mode and keeps the mid-row band.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");
const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
const touchSource = fs.readFileSync(require.resolve("./public/js/touch-drag.js"), "utf8");

function sourceFunction(source, name) {
  const match = source.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"));
  assert.ok(match, "expected to find " + name);
  return match[0];
}

function makeDragDay(scheduled) {
  const context = {
    console,
    document: { querySelectorAll: () => [] },
    window: { blockStore: { _blocks: [], getByType: () => [], get: () => null, updateBlock: () => {} } },
    DCC: { TaskModel: {
      ridersOf: (id, pool) => pool.filter((task) => task.wrapId === id),
      subtasksOf: (id, pool) => pool.filter((task) => task.subtaskOf === id),
      childrenOf: (id, pool) => pool.filter((task) => task.wrapId === id || task.subtaskOf === id),
      selectActive: (pool) => pool.filter((task) => !task.done && !task.deleted),
      selectOpen: (pool) => pool.filter((task) => !task.done && !task.deleted),
      selectTimedActive: (pool) => pool.filter((task) => !task.done && !task.deleted && !task.untimed),
      selectNotDeleted: (pool) => pool.filter((task) => !task.deleted),
    } },
    scheduled,
    INIT_SCHED: scheduled.slice(),
    __state: { schedule: { blocks: [] } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: (ev) => {
      const [sh, sm] = ev.start.split(":").map(Number);
      const [eh, em] = ev.end.split(":").map(Number);
      return (eh * 60 + em) - (sh * 60 + sm);
    },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
    isNested: (ev) => !!(ev.wrapId || ev.subtaskOf),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    isFixed: (ev) => ["meeting", "oneone", "break", "ooo"].includes(ev.type),
    parentIdOf: (ev) => (ev && (ev.wrapId || ev.subtaskOf)) || null,
    relOf: (ev) => ev ? (ev.wrapId ? "ride-along" : (ev.subtaskOf ? "subtask" : null)) : null,
    isWrap: (ev) => !!ev.isWrap,
    userMovable: () => true,
    now: () => 9 * 60,
    loadPinnedStarts: () => ({}),
    savePinnedStarts: () => {},
    saveTaskOrder: () => {},
    syncAddedTaskTimes: () => {},
    showToast: () => {},
    log: () => {},
    render: () => {},
  };
  vm.createContext(context);
  vm.runInContext(dragSource, context);
  return context;
}

// A row element that records the drop-feedback classes dOver puts on it.
function fakeRow(height) {
  const classes = new Set();
  return {
    classes,
    getBoundingClientRect: () => ({ top: 0, left: 0, height }),
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

function startDrag(context, id) {
  context.dStart({ dataTransfer: { effectAllowed: "", setData() {} }, target: { closest: () => null } }, id);
}

function twoTasks() {
  return [
    { id: "target", title: "Target", type: "task", start: "09:00", end: "09:30" },
    { id: "moved", title: "Moved", type: "task", start: "10:00", end: "10:30" },
  ];
}

test("touch reorder mode drops mid-row WITHOUT nesting", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  // Dead center of the row — the exact spot desktop treats as "wrap inside".
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 50, "reorder");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId ?? null, null);
  assert.equal(moved.subtaskOf ?? null, null);
});

test("touch nest mode nests from a row EDGE, where desktop would only reorder", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 8, "nest");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId, "target");
  assert.equal(moved.subtaskOf ?? null, null);
});

test("touch sub mode nests as a subtask with no Shift key", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => (key === "childEdge" ? "any" : false) };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "moved");
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 50, "sub");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.subtaskOf, "target");
  assert.equal(moved.wrapId ?? null, null);
});

test("mouse drag (no mode) keeps the desktop mid-row nest band", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  context.dDrop({
    preventDefault() {}, shiftKey: false, clientY: 50,
    currentTarget: fakeRow(100),
  }, "target");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId, "target");
});

test("touch reorder feedback is the blue bar, not the purple nest overlay", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  const row = fakeRow(100);
  context.window.DCC_DRAG.over(row, "target", 50, "reorder");
  assert.equal(row.classes.has("drag-over-nest"), false);
  assert.ok(row.classes.has("drag-over-top") || row.classes.has("drag-over-bottom"));

  const nestRow = fakeRow(100);
  context.window.DCC_DRAG.over(nestRow, "target", 8, "nest");
  assert.ok(nestRow.classes.has("drag-over-nest"));
  assert.equal(nestRow.classes.has("drag-over-nest-sub"), false);

  const subRow = fakeRow(100);
  context.window.DCC_DRAG.over(subRow, "target", 8, "sub");
  assert.ok(subRow.classes.has("drag-over-nest-sub"));
});

test("the touch gesture picks its mode from the sideways offset, reorder by default", () => {
  assert.match(touchSource, /function modeFor\(x\)/);
  assert.match(touchSource, /if \(dx >= SUB_PX\) return "sub";/);
  assert.match(touchSource, /if \(dx >= NEST_PX\) return "nest";/);
  assert.match(touchSource, /return "reorder";/);
  // Both the hover feedback and the drop must carry the same mode.
  assert.match(touchSource, /DCC_DRAG\.over\(tgt, tgtId, e\.clientY, mode\)/);
  assert.match(touchSource, /DCC_DRAG\.drop\(tgt, tgt\.dataset\.id, e\.clientY, mode\)/);
});
