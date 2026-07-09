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

test("registry: shell rules are declared as designed", () => {
  const shell = TaskTypes.get("shell");
  assert.equal(shell.earnsOwnPoints, false);
  assert.equal(shell.rollupMode, "children");
  assert.equal(shell.bonusPct, 0.10);
  assert.equal(shell.autoCompleteWhenChildrenDone, true);
  assert.equal(shell.blockManualCompleteWithOpenChildren, true);
  assert.equal(shell.childEdge, "wrap");
  assert.equal(shell.dragMovesSubtree, true);
  assert.equal(shell.barColor, "#e2e8f0");
  assert.equal(shell.cardClass, "card-shell");
});

test("registry: get() accepts an ev object and falls back to task defaults", () => {
  assert.equal(TaskTypes.get({ type: "SHELL" }).rollupMode, "children");
  assert.equal(TaskTypes.get({ kind: "shell" }).rollupMode, "children");
  const unknown = TaskTypes.get("something-new");
  assert.equal(unknown.earnsOwnPoints, true);
  assert.equal(unknown.rollupMode, null);
  assert.equal(TaskTypes.isRollup("shell"), true);
  assert.equal(TaskTypes.isRollup("task"), false);
});

test("registry: non-earning set is exactly the historical set plus shell", () => {
  const set = new Set(TaskTypes.nonEarningTypes());
  assert.deepEqual([...set].sort(), ["break", "meeting", "ooo", "shell"]);
  // oneone has never been non-earning; the registry must not change that.
  assert.equal(set.has("oneone"), false);
});

test("registry: meeting/oneone are fixed-time but user-movable, break/ooo are not", () => {
  // fixedTime keeps them out of the reflow cascade; movable lets the user still
  // drag/re-time them by hand. This split is the contract meeting moves rely on.
  for (const t of ["meeting", "oneone"]) {
    assert.equal(TaskTypes.rule(t, "fixedTime"), true, t + " fixedTime");
    assert.equal(TaskTypes.rule(t, "movable"), true, t + " movable");
  }
  assert.equal(TaskTypes.rule("meeting", "barColor"), "#f97316"); // orange
  assert.equal(TaskTypes.rule("oneone", "barColor"), "#f59e0b");  // amber
  // ooo/break are fixed AND not user-movable (kept the way they were).
  assert.equal(TaskTypes.rule("ooo", "movable"), false);
  assert.equal(TaskTypes.rule("break", "movable"), false);
  // Plain tasks stay movable by default.
  assert.equal(TaskTypes.rule("task", "movable"), true);
});

test("registry: hard-zero tier is exactly ooo + shell (meeting/break stay rescuable)", () => {
  assert.deepEqual([...new Set(TaskTypes.hardZeroTypes())].sort(), ["ooo", "shell"]);
  assert.deepEqual([...scoring.HARD_ZERO_TYPES].sort(), ["ooo", "shell"]);
  // A positive multiplier rescues meeting (conditional tier) but never shell.
  assert.equal(scoring.isNonEarningTaskType({ type: "meeting", point_multiplier: 1 }), false);
  assert.equal(scoring.isNonEarningTaskType({ type: "shell", point_multiplier: 1 }), true);
});

test("backend: shell is never duration-scored, even with a point multiplier", () => {
  assert.equal(scoring.isNonEarningTaskType({ type: "shell" }), true);
  assert.equal(scoring.isNonEarningTaskType({ kind: "shell", point_multiplier: 1 }), true);
  const scored = scoring.scoreTaskPoints({ type: "shell", duration_minutes: 480, point_multiplier: 1 });
  assert.equal(scored.eligible, false);
  assert.equal(scored.awardPoints, 0);
});

test("frontend mirror: shell ineligible with and without the registry loaded", () => {
  for (const withRegistry of [true, false]) {
    const TaskPoints = loadTaskPoints(withRegistry);
    const est = TaskPoints.estimate({ type: "shell", duration_minutes: 480 });
    assert.equal(est.eligible, false, `withRegistry=${withRegistry}`);
    assert.equal(est.awardPoints, 0, `withRegistry=${withRegistry}`);
    // A plain task still earns.
    assert.equal(TaskPoints.estimate({ type: "task", duration_minutes: 30 }).eligible, true);
  }
});
