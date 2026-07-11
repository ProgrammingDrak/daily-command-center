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

test("registry: wrap is a shell-shaped container that earns its OWN points", () => {
  const wrap = TaskTypes.get("wrap");
  // Shares shell's container/drag behavior…
  assert.equal(wrap.childEdge, "wrap");
  assert.equal(wrap.dragMovesSubtree, true);
  // …but NONE of shell's rollup economics.
  assert.equal(wrap.earnsOwnPoints, true);
  assert.equal(wrap.hardZero, false);
  assert.equal(wrap.rollupMode, null);
  assert.equal(wrap.autoCompleteWhenChildrenDone, false);
  assert.equal(wrap.blockManualCompleteWithOpenChildren, false);
  assert.equal(TaskTypes.isRollup("wrap"), false);
  // A movable, point-eligible work row.
  assert.equal(wrap.movable, true);
  assert.equal(wrap.fixedTime, false);
});

test("registry: habit earns, moves like a task, never rolls up or fixes its slot", () => {
  const habit = TaskTypes.get("habit");
  assert.equal(habit.earnsOwnPoints, true);
  assert.equal(habit.movable, true);
  assert.equal(habit.fixedTime, false);
  assert.equal(habit.rollupMode, null);
  assert.equal(habit.childEdge, "any");
});

test("registry: adding wrap/habit did NOT touch the non-earning or hard-zero sets", () => {
  // wrap + habit earn, so the FE/BE lockstep sets must be unchanged.
  assert.deepEqual([...new Set(TaskTypes.nonEarningTypes())].sort(), ["break", "meeting", "ooo", "shell"]);
  assert.deepEqual([...new Set(TaskTypes.hardZeroTypes())].sort(), ["ooo", "shell"]);
});

test("registry: isFixed/pointEligible partition the types (replaces the inline predicate)", () => {
  // Fixed = the old `isMeeting(ev)||ooo||break` set, exactly.
  for (const t of ["meeting", "oneone", "ooo", "break"]) {
    assert.equal(TaskTypes.isFixed(t), true, t + " isFixed");
    assert.equal(TaskTypes.pointEligible(t), false, t + " !pointEligible");
  }
  // Normal task rows (incl. shell/wrap/habit and unknown types) are point-eligible.
  for (const t of ["task", "triage", "focus", "shell", "wrap", "habit", "made-up"]) {
    assert.equal(TaskTypes.isFixed(t), false, t + " !isFixed");
    assert.equal(TaskTypes.pointEligible(t), true, t + " pointEligible");
  }
  // Accepts ev objects and is null-safe (matches the inline predicate's guard).
  assert.equal(TaskTypes.isFixed({ type: "meeting" }), true);
  assert.equal(TaskTypes.isFixed(null), false);
  assert.equal(TaskTypes.pointEligible(null), true);
});

test("registry: cfg-shim source fields (label/tagCls/color) are present per type", () => {
  for (const t of ["task", "focus", "shell", "wrap", "habit", "meeting", "ooo"]) {
    const e = TaskTypes.get(t);
    assert.ok(e.label && e.tagCls && e.color, t + " has label/tagCls/color");
  }
  // Unknown types fall back to the task defaults (mirrors the old cfg() fallback).
  assert.equal(TaskTypes.get("nope").color, "#a78bfa");
});

test("backend + frontend: wrap and habit are duration-scored like a task", () => {
  for (const t of ["wrap", "habit"]) {
    assert.equal(scoring.isNonEarningTaskType({ type: t }), false, t + " earns (backend)");
    const scored = scoring.scoreTaskPoints({ type: t, duration_minutes: 60 });
    assert.equal(scored.eligible, true, t + " eligible (backend)");
    assert.ok(scored.awardPoints > 0, t + " awards points (backend)");
    for (const withRegistry of [true, false]) {
      const TaskPoints = loadTaskPoints(withRegistry);
      const est = TaskPoints.estimate({ type: t, duration_minutes: 60 });
      assert.equal(est.eligible, true, `${t} eligible (frontend withRegistry=${withRegistry})`);
    }
  }
});
