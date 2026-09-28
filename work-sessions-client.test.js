const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { setImmediate } = require("node:timers");

const source = fs.readFileSync(require.resolve("./public/js/work-sessions.js"), "utf8");

function loadCheckInApi() {
  const context = {
    window: { TaskTypes: { rule: () => "work_sessions" }, DCC: {} },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    setInterval: () => 0,
    Date,
    Map,
    Set,
    Array,
    Number,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.DCCWorkSessions;
}

test("pet check-ins use a 25-minute cadence and auto-pause after two misses", () => {
  const work = loadCheckInApi();
  const started = Date.parse("2026-09-28T13:00:00.000Z");
  const task = { id: "timer", startedAt: new Date(started).toISOString() };

  assert.ok(work.CHECK_IN_MINUTES >= 20 && work.CHECK_IN_MINUTES <= 30);
  assert.equal(work.checkInState(task, started + 24 * 60_000).due, false);
  const first = work.checkInState(task, started + 25 * 60_000);
  assert.equal(first.due, true);
  assert.equal(first.missed, 1);
  assert.match(first.prompt, /two minutes/i);
  const controls = work.checkInHtml(task, started + 25 * 60_000);
  assert.match(controls, />Pause</);
  assert.match(controls, />Continue</);

  const second = work.checkInState(task, started + 50 * 60_000);
  assert.equal(second.shouldAutoPause, true);
  assert.equal(second.missed, 2);
  assert.equal(second.autoPauseAtMs, started + 50 * 60_000);
});

test("continue acknowledgements rotate prompts and reset the missed count", () => {
  const work = loadCheckInApi();
  const started = Date.parse("2026-09-28T13:00:00.000Z");
  const checked = started + 25 * 60_000;
  const task = {
    id: "timer",
    startedAt: new Date(started).toISOString(),
    workCheckInAt: new Date(checked).toISOString(),
    workCheckInCount: 1,
  };

  assert.equal(work.checkInState(task, checked + 24 * 60_000).due, false);
  const next = work.checkInState(task, checked + 25 * 60_000);
  assert.equal(next.due, true);
  assert.equal(next.prompt, work.BREAK_PROMPTS[1]);
  assert.equal(next.autoPauseAtMs, checked + 50 * 60_000);
});

test("overnight recovery pauses at the missed-check-in cutoff, not wake time", () => {
  const work = loadCheckInApi();
  const started = Date.parse("2026-09-28T23:40:00.000Z");
  const wake = Date.parse("2026-09-29T12:00:00.000Z");
  const state = work.checkInState({ id: "overnight", startedAt: new Date(started).toISOString() }, wake);

  assert.equal(state.shouldAutoPause, true);
  assert.equal(new Date(state.autoPauseAtMs).toISOString(), "2026-09-29T00:30:00.000Z");
});

test("an acknowledged timer still stops after eight continuous hours", () => {
  const work = loadCheckInApi();
  const started = Date.parse("2026-09-28T13:00:00.000Z");
  const task = {
    id: "long-session",
    startedAt: new Date(started).toISOString(),
    workCheckInAt: new Date(started + 7 * 60 * 60_000 + 50 * 60_000).toISOString(),
    workCheckInCount: 18,
  };
  const state = work.checkInState(task, started + 8 * 60 * 60_000);

  assert.equal(state.shouldAutoPause, true);
  assert.equal(state.autoPauseAtMs, started + 8 * 60 * 60_000);
});

test("the timer tick auto-pauses through the canonical work action", async () => {
  const started = Date.parse("2026-09-28T23:40:00.000Z");
  const wake = Date.parse("2026-09-29T12:00:00.000Z");
  const raw = {
    id: "row-1",
    type: "block",
    properties: { local_id: "timer-1", type: "task", title: "Late work", startedAt: new Date(started).toISOString() },
  };
  const task = { ...raw.properties, id: "timer-1", _blockId: raw.id };
  const calls = [];
  const dock = { hidden: true, innerHTML: "" };
  const model = {
    fromBlock: row => ({ ...(row.properties || {}), id: (row.properties || {}).local_id || row.id, _blockId: row.id }),
    isTaskRow: row => row && row.type === "block" && (row.properties || {}).type === "task",
    foldsIntoItinerary: row => row && row.type === "block" && !!(row.properties || {}).local_id,
  };
  const context = {
    window: {
      TaskTypes: { rule: () => "work_sessions" },
      DCC: { TaskModel: model, toast() {} },
      blockStore: {
        get: id => id === raw.id ? raw : null,
        getByType: () => [raw],
        workAction: async (id, action, options) => {
          calls.push({ id, action, options });
          delete raw.properties.startedAt;
          raw.properties.workAutoPausedAt = options.at;
          return { block: raw };
        },
      },
    },
    document: {
      getElementById: id => id === "active-work-dock" ? dock : null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    scheduled: [task],
    backlog: [],
    setInterval: () => 0,
    Date,
    Map,
    Set,
    Array,
    Number,
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);

  await context.window.DCCWorkSessions.checkInTick(wake);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "auto-pause");
  assert.equal(calls[0].options.at, "2026-09-29T00:30:00.000Z");
  assert.match(calls[0].options.actionId, /^work-checkin-auto-pause:/);
});

test("past-day tasks outside today's cache share the work lifecycle and complete at their origin", async () => {
  const model = require("./public/js/task-model.js");
  const raw = { id: "past-block", type: "block", date: "2026-09-08", properties: {
    local_id: "past-task", type: "task", title: "Past-day task", status: "open", duration: 30,
  } };
  const task = model.fromBlock(raw);
  task.__unf = { sourceId: raw.id, sourceDate: raw.date, sourceBlock: raw };
  let pool = [task];
  const calls = [], events = [], completed = [];
  const dock = { hidden: true, innerHTML: "" };
  let clickHandler;
  const context = {
    window: {
      TaskTypes: { rule: () => "work_sessions" },
      DCC: { TaskModel: model, Carryover: {
        rows: () => pool,
        get: (id) => pool.find(row => row.id === id || row.__unf.sourceId === id),
        complete: async (row, rows) => { completed.push({ row, rows }); pool = []; return { removed: [row.id] }; },
      } },
      blockStore: {
        get: () => null, getByType: () => [],
        workAction: async (id, action) => {
          calls.push({ id, action });
          const block = { ...raw, properties: { ...raw.properties,
            startedAt: action === "start" ? "2026-09-09T13:00:00.000Z" : null,
            actualMinutes: action === "pause" ? 7 : 0,
          } };
          return { block };
        },
      },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      dispatchEvent: (event) => events.push(event),
    },
    document: {
      getElementById: (id) => id === "active-work-dock" ? dock : null,
      addEventListener: (name, handler) => { if (name === "click") clickHandler = handler; },
    },
    scheduled: [], backlog: [],
    toggleDone: () => assert.fail("A past-day task must never complete against today's state"),
    setInterval: () => 0, Date, Map, Set,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const work = context.window.DCCWorkSessions;
  assert.match(work.itineraryActionButtonsHtml(task, false), />Start</);
  await work.act(task, "start");
  assert.equal(dock.hidden, false);
  assert.match(work.itineraryActionButtonsHtml(task, false), />Pause<.*>Complete</);
  await work.act(task, "pause");
  assert.equal(task.actualMinutes, 7);
  assert.equal(dock.hidden, true);
  assert.equal(task.__unf.sourceDate, raw.date);
  assert.equal(task.__unf.sourceBlock.properties.actualMinutes, 7);
  assert.deepEqual(calls, [{ id: raw.id, action: "start" }, { id: raw.id, action: "pause" }]);
  assert.equal(events.length, 2);

  await work.act(task, "start");
  const originalPool = pool;
  clickHandler({
    target: { closest: (selector) => selector === "[data-work-task]"
      ? { dataset: { workTask: task.id, workComplete: "true" } } : null },
    preventDefault() {}, stopPropagation() {},
  });
  await new Promise(setImmediate);
  assert.equal(completed[0].row, task);
  assert.equal(completed[0].rows, originalPool);
  assert.equal(dock.hidden, true);
});

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
