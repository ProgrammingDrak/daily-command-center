// Contract tests for shell exclusion from the day-math tallies in
// public/js/schedule-tab.js. A shell is a wrapper container, not work, so it
// must not count toward done/remaining tallies. Harness pattern: shell-rollup
// .test.js / recalc-times.test.js -- slice the pure functions under test into a
// node:vm context with stubbed scheduled / isDone / window.TaskTypes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskTypes = require("./public/js/task-types");
const src = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const slice = (name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const source = [slice("_isShellEv"), slice("_dayDoneTasks"), slice("_remainingForScope")].join("\n");

// vm objects carry the vm realm's Object.prototype, so read results back through
// a JSON round-trip evaluated inside the context (same trick as shell-rollup.test.js).
function makeContext(tasks, { done = new Set(), taskTypes = TaskTypes } = {}) {
  const context = {
    console,
    scheduled: tasks,
    window: taskTypes ? { TaskTypes: taskTypes } : {},
    isDone: (ev) => done.has(ev.id),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}
const evalJSON = (ctx, expr) => JSON.parse(vm.runInContext("JSON.stringify(" + expr + ")", ctx));

test("_isShellEv: true for a rollup shell, false for a plain task", () => {
  const ctx = makeContext([]);
  assert.equal(vm.runInContext('_isShellEv({id:"S",type:"shell"})', ctx), true);
  assert.equal(vm.runInContext('_isShellEv({id:"a",type:"task"})', ctx), false);
});

test('_isShellEv: falls back to type==="shell" when TaskTypes is not loaded', () => {
  const ctx = makeContext([], { taskTypes: null });
  assert.equal(vm.runInContext('_isShellEv({id:"S",type:"shell"})', ctx), true);
  assert.equal(vm.runInContext('_isShellEv({id:"a",type:"task"})', ctx), false);
});

test("_dayDoneTasks: excludes completed shells, keeps completed tasks", () => {
  const tasks = [
    { id: "S", type: "shell" },
    { id: "a", type: "task" },
    { id: "b", type: "task" },
  ];
  const ctx = makeContext(tasks, { done: new Set(["S", "a"]) });
  assert.deepEqual(evalJSON(ctx, "_dayDoneTasks().map(e=>e.id)"), ["a"]);
});

test("_remainingForScope('day'): excludes shells and _dateless rows", () => {
  const tasks = [
    { id: "S", type: "shell" },
    { id: "a", type: "task" },
    { id: "d", type: "task", _dateless: true },
  ];
  const ctx = makeContext(tasks);
  assert.deepEqual(evalJSON(ctx, '_remainingForScope("day").map(e=>e.id)'), ["a"]);
});
