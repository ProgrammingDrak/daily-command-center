const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/work-sessions.js"), "utf8");

test("completing from Active Work removes the task immediately", () => {
  const done = new Set();
  const task = {
    id: "task-1",
    title: "Let's time some stuff",
    type: "task",
    status: "open",
    startedAt: "2026-08-13T13:00:00.000Z",
  };
  const dock = { hidden: false, innerHTML: "" };
  let clickHandler = null;
  const button = {
    dataset: { workTask: task.id, workComplete: "true" },
  };
  const taskRow = { id: task.id, type: "block", properties: { ...task, local_id: task.id } };
  const context = {
    window: {
      TaskTypes: { rule: () => "work_sessions" },
      DCC: { TaskModel: {
        fromBlock: (row) => ({ ...(row.properties || {}), id: (row.properties || {}).local_id || row.id, _blockId: row.id }),
        isTaskRow: (row) => row.type === "block" && (row.properties || {}).type === "task",
        foldsIntoItinerary: (row) => row.type === "block" && !!(row.properties || {}).local_id,
      } },
      blockStore: {
        get: (id) => id === taskRow.id ? taskRow : null,
        getByType: () => [taskRow],
      },
    },
    document: {
      getElementById: (id) => id === "active-work-dock" ? dock : null,
      addEventListener: (name, handler) => { if (name === "click") clickHandler = handler; },
    },
    scheduled: [task],
    backlog: [],
    consider: [],
    isDone: (candidate) => done.has(candidate.id),
    toggleDone: (id) => done.add(id),
    setInterval: () => 0,
    Date,
    Map,
    Set,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);

  context.window.DCCWorkSessions.refresh();
  assert.equal(dock.hidden, false);
  assert.match(dock.innerHTML, /Let&#39;s time some stuff/);

  clickHandler({
    target: { closest: (selector) => selector === "[data-work-task]" ? button : null },
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(done.has(task.id), true);
  assert.equal(dock.hidden, true);
  assert.equal(dock.innerHTML, "");
});

test("an active itinerary task stacks Complete underneath Pause", () => {
  const rows = [
    { id: "task-1", type: "block", properties: { type: "task", local_id: "task-1" } },
    { id: "task-2", type: "block", properties: { type: "task", local_id: "task-2" } },
  ];
  const context = {
    window: {
      TaskTypes: { rule: () => "work_sessions" },
      DCC: { TaskModel: {
        isTaskRow: (row) => row.type === "block" && (row.properties || {}).type === "task",
        foldsIntoItinerary: (row) => row.type === "block" && !!(row.properties || {}).local_id,
      } },
      blockStore: {
        get: (id) => rows.find((row) => row.id === id) || null,
        getByType: () => rows,
      },
    },
    document: { getElementById: () => null, addEventListener() {} },
    setInterval: () => 0,
    Date,
    Map,
    Set,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);

  const active = context.window.DCCWorkSessions.itineraryActionButtonsHtml({
    id: "task-1",
    startedAt: "2026-08-13T13:00:00.000Z",
  }, false);
  assert.match(active, /work-itinerary-actions/);
  assert.ok(active.indexOf(">Pause<") < active.indexOf(">Complete<"));
  assert.match(active, /data-work-complete="true"/);

  const idle = context.window.DCCWorkSessions.itineraryActionButtonsHtml({ id: "task-2" }, false);
  assert.match(idle, />Start</);
  assert.doesNotMatch(idle, />Complete</);
});

test("non-task global rows never receive work controls", () => {
  const globalRow = { id: "waiting", type: "block", properties: { type: "task", kind: "waiting_list" } };
  const context = {
    window: {
      TaskTypes: { rule: () => "work_sessions" },
      DCC: { TaskModel: {
        isTaskRow: () => false,
        foldsIntoItinerary: () => false,
      } },
      blockStore: { get: () => globalRow, getByType: () => [globalRow] },
    },
    document: { getElementById: () => null, addEventListener() {} },
    setInterval: () => 0,
    Date,
    Map,
    Set,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(context.window.DCCWorkSessions.actionButtonHtml({ id: "waiting", type: "task" }, false), "");
});
