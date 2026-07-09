// Contract tests for the shell rollup walker and the shared bonus formula in
// public/js/state.js. Harness pattern: recalc-times.test.js (state.js has DOM
// side effects at load, so slice the pure functions under test into a node:vm
// context with stubbed tree helpers).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskTypes = require("./public/js/task-types");

const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const shellRollupSource = stateSource.match(/function shellRollup[\s\S]*?\n\}/)[0];
const shellBonusSource = stateSource.match(/function shellBonus[\s\S]*?\n\}/)[0];

// Build a vm context around a task pool. Estimates are supplied per-id via the
// `estimates` map (stubbing PointPlan.estimatePool); ids in `pools` instead
// resolve through PointPlan.compute (a pie parent contributing its pool).
function makeContext(tasks, { estimates = {}, pools = {}, done = new Set() } = {}) {
  const context = {
    console,
    scheduled: tasks,
    window: {
      TaskTypes,
      PointPlan: {
        estimatePool: (id) => estimates[id] || 0,
        compute: (id) => (id in pools ? { pool: pools[id] } : null),
      },
    },
    parentIdOf: (ev) => (ev && (ev.wrapId || ev.subtaskOf)) || null,
    relOf: (ev) => (ev ? (ev.wrapId ? "ride-along" : ev.subtaskOf ? "subtask" : null) : null),
    isDone: (ev) => done.has(ev.id),
  };
  context.childrenOf = (id, pool) => (pool || []).filter((c) => context.parentIdOf(c) === id);
  vm.createContext(context);
  vm.runInContext(shellRollupSource + "\n" + shellBonusSource, context);
  return context;
}

test("shellRollup sums plain wrap children and counts direct progress", () => {
  const tasks = [
    { id: "S", type: "shell" },
    { id: "a", type: "task", wrapId: "S" },
    { id: "b", type: "task", wrapId: "S" },
  ];
  const ctx = makeContext(tasks, { estimates: { a: 30, b: 45 }, done: new Set(["a"]) });
  // JSON round-trip: vm objects carry the vm realm's Object.prototype.
  const r = JSON.parse(vm.runInContext('JSON.stringify(shellRollup("S", scheduled))', ctx));
  assert.deepEqual(r, { points: 75, done: 1, total: 2 });
});

test("shellRollup: a pie parent contributes its pool; its subtasks are not double-counted", () => {
  const tasks = [
    { id: "S", type: "shell" },
    { id: "p", type: "task", wrapId: "S" },       // pie parent inside the shell
    { id: "s1", type: "task", subtaskOf: "p" },   // pie slice — must NOT add
    { id: "r1", type: "task", wrapId: "p" },      // ride-along grandchild — must add
  ];
  const ctx = makeContext(tasks, { estimates: { p: 999, s1: 999, r1: 20 }, pools: { p: 40 } });
  const r = vm.runInContext('shellRollup("S", scheduled)', ctx);
  assert.equal(r.points, 60); // pool 40 + ride-along 20; estimates for p/s1 ignored
  assert.equal(r.total, 1);   // direct children only
});

test("shellRollup: a nested shell contributes its subtree but nothing of its own", () => {
  const tasks = [
    { id: "S", type: "shell" },
    { id: "inner", type: "shell", wrapId: "S" },
    { id: "x", type: "task", wrapId: "inner" },
  ];
  const ctx = makeContext(tasks, { estimates: { inner: 999, x: 25 } });
  const r = vm.runInContext('shellRollup("S", scheduled)', ctx);
  assert.equal(r.points, 25);
});

test("shellRollup survives a parent cycle in the data", () => {
  const tasks = [
    { id: "S", type: "shell", wrapId: "a" }, // corrupt: parent points back into child
    { id: "a", type: "task", wrapId: "S" },
  ];
  const ctx = makeContext(tasks, { estimates: { a: 10 } });
  const r = vm.runInContext('shellRollup("S", scheduled)', ctx);
  assert.equal(r.points, 10); // terminates, counts each node once
});

test("shellBonus pins the formula both award and chip use: pct, floor 1, ceiling 500", () => {
  const ctx = makeContext([]);
  const bonus = (p, pct) => vm.runInContext(`shellBonus(${p},${pct})`, ctx);
  assert.equal(bonus(75, 0.10), 8);    // the walkthrough case: round(7.5)
  assert.equal(bonus(3, 0.10), 1);     // floor: never a zero-point award
  assert.equal(bonus(99999, 0.10), 500); // ledger override ceiling
  assert.equal(bonus(0, 0.10), 0);     // nothing inside -> no bonus
  assert.equal(bonus(75, 0), 0);       // type without a bonus configured
});
