// Contract tests for shell exclusion from the day-progress tally.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// C6a: the sliced code derives its task sets through DCC.TaskModel; install the real
// module INSIDE the context so it resolves this harness's isDone/isDeleted stubs.
const { installTaskModel } = require("./task-model-vm-fixture.js");

const TaskTypes = require("./public/js/task-types");
const src = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const slice = (name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const source = slice("_isShellEv");

function makeContext(tasks, { done = new Set(), taskTypes = TaskTypes } = {}) {
  const context = {
    console,
    scheduled: tasks,
    window: taskTypes ? { TaskTypes: taskTypes } : {},
    isDone: (ev) => done.has(ev.id),
  };
  vm.createContext(context);
  installTaskModel(context);
  vm.runInContext(source, context);
  return context;
}

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
