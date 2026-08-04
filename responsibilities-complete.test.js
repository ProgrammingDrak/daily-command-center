// Contract tests for _completeResponsibilitySubtree in public/js/responsibilities.js
// — the leaf-first walker the triage "Done" button uses to complete a
// materialized shell responsibility. Harness pattern: shell-rollup.test.js
// (responsibilities.js has DOM/IIFE side effects at load, so slice the pure
// function under test into a node:vm context with stubbed tree helpers).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// C6a: the sliced code derives its task sets through DCC.TaskModel; install the real
// module INSIDE the context so it resolves this harness's isDone/isDeleted stubs.
const { installTaskModel } = require("./task-model-vm-fixture.js");

const src = fs.readFileSync(require.resolve("./public/js/responsibilities.js"), "utf8");
const fnSource = src.match(/function _completeResponsibilitySubtree[\s\S]*?\n {2}\}/)[0];

// Build a vm context around a task pool. `toggleDone` records the id and marks
// it done (simulating a real completion) so the root's all-children-done gate
// and the already-done skips behave as they would at runtime.
function makeContext(tasks, { done = new Set() } = {}) {
  const toggled = [];
  const context = {
    console,
    scheduled: tasks,
    relOf: (ev) => (ev ? (ev.wrapId ? "ride-along" : ev.subtaskOf ? "subtask" : null) : null),
    isDone: (ev) => done.has(ev.id),
    toggleDone: (id) => { toggled.push(id); done.add(id); },
  };
  context.parentIdOf = (ev) => (ev && (ev.wrapId || ev.subtaskOf)) || null;
  context.childrenOf = (id, pool) => (pool || []).filter((c) => context.parentIdOf(c) === id);
  context.toggled = toggled;
  vm.createContext(context);
  installTaskModel(context);
  vm.runInContext(fnSource, context);
  return context;
}

function run(ctx, rootId) {
  vm.runInContext(`_completeResponsibilitySubtree(${JSON.stringify(rootId)})`, ctx);
  return ctx.toggled;
}

test("completes ride-along children then the root (root last)", () => {
  const ctx = makeContext([
    { id: "S", type: "shell" },
    { id: "a", wrapId: "S" },
    { id: "b", wrapId: "S" },
  ]);
  const toggled = run(ctx, "S");
  assert.deepEqual(toggled, ["a", "b", "S"]);
  assert.equal(toggled[toggled.length - 1], "S"); // root completes last
});

test("nested ride-alongs complete leaf-first (grandchild before child before root)", () => {
  const ctx = makeContext([
    { id: "S", type: "shell" },
    { id: "a", wrapId: "S" },
    { id: "a1", wrapId: "a" },
  ]);
  assert.deepEqual(run(ctx, "S"), ["a1", "a", "S"]);
});

test("subtasks are never toggled (they cascade via their parent's completion)", () => {
  const ctx = makeContext([
    { id: "S", type: "shell" },
    { id: "a", wrapId: "S" },
    { id: "s1", subtaskOf: "a" },
  ]);
  const toggled = run(ctx, "S");
  assert.deepEqual(toggled, ["a", "S"]);
  assert.ok(!toggled.includes("s1"));
});

test("already-done children are skipped, not re-toggled", () => {
  const ctx = makeContext(
    [
      { id: "S", type: "shell" },
      { id: "a", wrapId: "S" },
      { id: "b", wrapId: "S" },
    ],
    { done: new Set(["a"]) }
  );
  assert.deepEqual(run(ctx, "S"), ["b", "S"]);
});

test("a fully-done subtree toggles nothing (root is not double-fired)", () => {
  const ctx = makeContext(
    [
      { id: "S", type: "shell" },
      { id: "a", wrapId: "S" },
      { id: "b", wrapId: "S" },
    ],
    { done: new Set(["S", "a", "b"]) }
  );
  assert.deepEqual(run(ctx, "S"), []);
});
