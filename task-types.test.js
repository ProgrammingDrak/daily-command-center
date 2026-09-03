const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskTypes = require("./public/js/task-types");
const scoring = require("./slot-scoring");

function loadTaskPoints(withRegistry) {
  const context = { window: withRegistry ? { TaskTypes } : {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/js/points.js", "utf8"), context);
  return context.window.TaskPoints;
}

test("registry: Shell and Wrap are absent from the public registry", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(TaskTypes.TYPES, "shell"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(TaskTypes.TYPES, "wrap"), false);
});

test("registry: read compatibility preserves pre-migration behavior", () => {
  assert.equal(TaskTypes.get("shell").rollupMode, "children");
  assert.equal(TaskTypes.get("wrap").childEdge, "wrap");
  assert.equal(scoring.isNonEarningTaskType({ type: "shell" }), true);
  assert.equal(scoring.scoreTaskPoints({ type: "shell", duration_minutes: 60 }).eligible, false);
  assert.equal(loadTaskPoints(true).estimate({ type: "shell", duration_minutes: 60 }).eligible, false);
  assert.equal(scoring.isNonEarningTaskType({ type: "wrap" }), false);
  assert.equal(scoring.scoreTaskPoints({ type: "wrap", duration_minutes: 60 }).eligible, true);
  assert.equal(loadTaskPoints(true).estimate({ type: "wrap", duration_minutes: 60 }).eligible, true);
});

test("registry: fixed and non-earning sets stay limited to current types", () => {
  assert.deepEqual([...new Set(TaskTypes.nonEarningTypes())].sort(), ["break", "meeting", "ooo"]);
  assert.deepEqual([...new Set(TaskTypes.hardZeroTypes())].sort(), ["ooo"]);
  for (const type of ["meeting", "oneone", "break", "ooo"]) assert.equal(TaskTypes.isFixed(type), true);
  for (const type of ["task", "habit", "shell", "wrap"]) assert.equal(TaskTypes.isFixed(type), false);
});
