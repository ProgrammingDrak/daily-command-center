const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadTaskPoints() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/js/points.js", "utf8"), context);
  return context.window.TaskPoints;
}

test("TaskPoints payload carries stacked self and partner bounty", () => {
  const TaskPoints = loadTaskPoints();
  const payload = TaskPoints.buildPayload(
    { id: "task-1", title: "Stacked bounty task", durMin: 30 },
    { bounty: true, bounty_count: 2, partner_bounty: true }
  );
  assert.equal(payload.bounty, true);
  assert.equal(payload.bounty_count, 2);
  assert.equal(payload.partner_bounty, true);

  const scoring = TaskPoints.estimate(payload);
  assert.equal(scoring.bountyCount, 2);
  assert.equal(scoring.multipliers.bounty, 4);
  assert.equal(scoring.awardPoints, 120);
});

test("TaskPoints classifies lunch as a non-earning break", () => {
  const TaskPoints = loadTaskPoints();
  const payload = TaskPoints.buildPayload(
    { id: "lunch-1", title: "Lunch", type: "task", durMin: 45 },
    {}
  );
  const scoring = TaskPoints.estimate(payload);

  assert.equal(payload.type, "break");
  assert.equal(payload.point_tier, "none");
  assert.equal(payload.point_multiplier, 0);
  assert.equal(scoring.eligible, false);
  assert.equal(scoring.awardPoints, 0);
});

test("TaskPoints classifies routines and chores as half-point work", () => {
  const TaskPoints = loadTaskPoints();
  const routine = TaskPoints.buildPayload(
    { id: "routine-1", title: "Morning routine", type: "task", durMin: 60 },
    {}
  );
  const chores = TaskPoints.buildPayload(
    { id: "chores-1", title: "Clean kitchen chores", type: "task", durMin: 60 },
    {}
  );

  assert.equal(routine.point_tier, "half");
  assert.equal(routine.point_multiplier, 0.5);
  assert.equal(TaskPoints.estimate(routine).awardPoints, 30);
  assert.equal(chores.point_tier, "half");
  assert.equal(chores.point_multiplier, 0.5);
  assert.equal(TaskPoints.estimate(chores).awardPoints, 30);
});
