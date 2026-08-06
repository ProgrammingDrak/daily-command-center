// Regression coverage for meeting tasks as hierarchy parents. Meetings can own
// full nested work done concurrently and timeless subtasks relevant to the call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");
const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
const cardSource = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
const listSource = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const pointPlanSource = fs.readFileSync(require.resolve("./public/js/point-plan.js"), "utf8");

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

function dropEvent({ clientY = 50, height = 100, shiftKey = false } = {}) {
  return {
    preventDefault() {}, shiftKey, clientY,
    currentTarget: {
      getBoundingClientRect: () => ({ top: 0, left: 0, height }),
      classList: { remove() {}, toggle() {}, add() {} },
    },
  };
}

function startDrag(context, id) {
  context.dStart({ dataTransfer: { effectAllowed: "", setData() {} }, target: { closest: () => null } }, id);
}

test("body-drop nests a task inside a meeting as concurrent work", () => {
  const tasks = [
    { id: "meeting", title: "Planning", type: "meeting", start: "10:00", end: "11:00" },
    { id: "task", title: "Clear inbox", type: "task", start: "09:00", end: "09:30" },
  ];
  const context = makeDragDay(tasks);
  startDrag(context, "task");
  context.dDrop(dropEvent(), "meeting");
  const nested = tasks.find((task) => task.id === "task");
  assert.equal(nested.wrapId, "meeting");
  assert.equal(nested.subtaskOf ?? null, null);
});

test("Shift+body-drop makes a task a meeting subtask", () => {
  const tasks = [
    { id: "meeting", title: "Planning", type: "oneone", start: "10:00", end: "11:00" },
    { id: "task", title: "Review agenda", type: "task", start: "09:00", end: "09:30" },
  ];
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => key === "childEdge" ? "any" : false };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "task");
  context.dDrop(dropEvent({ shiftKey: true }), "meeting");
  const subtask = tasks.find((task) => task.id === "task");
  assert.equal(subtask.subtaskOf, "meeting");
  assert.equal(subtask.wrapId ?? null, null);
});

test("quick add creates both nested tasks and subtasks under a meeting", () => {
  const meeting = { id: "meeting", title: "Planning", type: "meeting", start: "10:00", end: "11:00" };
  const tasks = [meeting];
  const context = {
    window: { PointPlan: { ensure() {} } },
    scheduled: tasks,
    render() {},
    recalcTimes() {},
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    ms: (m) => m + "m",
  };
  vm.createContext(context);
  vm.runInContext(
    sourceFunction(tabsSource, "addSubtask") + "\n" + sourceFunction(tabsSource, "addStackedTask"),
    context,
  );
  const subtask = context.addSubtask("meeting", "Review the agenda");
  const nested = context.addStackedTask("meeting", "Clear inbox", 30);
  assert.equal(subtask.subtaskOf, "meeting");
  assert.equal(subtask.wrapId ?? null, null);
  assert.equal(nested.wrapId, "meeting");
  assert.equal(nested.subtaskOf ?? null, null);
});

test("moving a meeting carries its concurrent nested tasks", () => {
  const tasks = [
    { id: "meeting", title: "Planning", type: "meeting", start: "10:00", end: "11:00", isWrap: true },
    { id: "nested", title: "Clear inbox", type: "task", wrapId: "meeting", start: "10:15", end: "10:45" },
    { id: "target", title: "Target", type: "task", start: "13:00", end: "13:30" },
  ];
  const context = makeDragDay(tasks);
  startDrag(context, "meeting");
  context.dDrop(dropEvent({ clientY: 90 }), "target");
  const meeting = tasks.find((task) => task.id === "meeting");
  const nested = tasks.find((task) => task.id === "nested");
  assert.notEqual(meeting.start, "10:00");
  assert.equal(context.pt(nested.start) - context.pt(meeting.start), 15);
  assert.equal(context.dur(nested), 30);
});

test("moving a meeting carries its entire mixed-edge subtree", () => {
  const tasks = [
    { id: "meeting", title: "Planning", type: "meeting", start: "10:00", end: "11:00", isWrap: true },
    { id: "nested", title: "Clear inbox", type: "task", wrapId: "meeting", start: "10:10", end: "10:40" },
    { id: "grandchild", title: "Send reply", type: "task", subtaskOf: "nested", start: "10:15", end: "10:15" },
    { id: "target", title: "Target", type: "task", start: "13:00", end: "13:30" },
  ];
  const context = makeDragDay(tasks);
  startDrag(context, "meeting");
  context.dDrop(dropEvent({ clientY: 90 }), "target");
  const meeting = tasks.find((task) => task.id === "meeting");
  const nested = tasks.find((task) => task.id === "nested");
  const grandchild = tasks.find((task) => task.id === "grandchild");
  assert.equal(context.pt(nested.start) - context.pt(meeting.start), 10);
  assert.equal(context.pt(grandchild.start) - context.pt(meeting.start), 15);
});

test("meeting parent affordances stay available across both itinerary views", () => {
  assert.doesNotMatch(cardSource, /isMeeting\(ev\)\?'[^']*btn-mtg-tags[^\n]*:\(guest\?'':'<button class="btn-add-menu/);
  assert.match(cardSource, /btn-mtg-tags[\s\S]*btn-add-menu row-add-menu/);
  assert.doesNotMatch(listSource, /isDoneRow\|\|isMeeting\(ev\)\?'':'<button class="btn-add-menu/);
});

test("the make-subtask picker includes fixed-time meeting parents", () => {
  assert.match(tabsSource, /pointEligible\(e\)\|\|meeting\(e\)/);
});

test("a non-earning meeting with subtasks keeps a zero point pool", () => {
  const stored = new Map();
  const tasks = [
    { id: "meeting", title: "Planning", type: "meeting", durMin: 60 },
    { id: "subtask", title: "Review agenda", type: "task", subtaskOf: "meeting" },
  ];
  const context = {
    window: {
      TaskPoints: {
        buildPayload: (ev) => ev,
        estimate: () => ({ eligible: false, awardPoints: 0 }),
      },
      TaskTypes: { rule: (ev, key) => key === "earnsOwnPoints" ? ev.type !== "meeting" : null },
    },
    DCC: { TaskModel: { subtasksOf: (id, pool) => pool.filter((task) => task.subtaskOf === id) } },
    scheduled: tasks,
    manualDone: new Set(),
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
    },
  };
  vm.createContext(context);
  vm.runInContext(pointPlanSource, context);
  const plan = context.window.PointPlan.compute("meeting");
  assert.equal(plan.pool, 0);
  assert.equal(plan.bonus, 0);
  assert.equal(plan.shares.subtask.pts, 0);
  assert.equal(context.window.PointPlan.awardForParentCompletion("meeting"), 0);
});
