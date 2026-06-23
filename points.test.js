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

test("tag bucket multiplier scales the live estimate", () => {
  const TaskPoints = loadTaskPoints();
  const task = { duration_minutes: 90, tags: ["Tag-Social-123"] };

  // Unset tiers -> no change (full points, no regression).
  assert.equal(TaskPoints.estimate(task).awardPoints, 90);

  // Quarter bucket -> 0.25x. Case-sensitive id match (no lowercasing).
  TaskPoints.setPointTagTiers({ quarter: ["Tag-Social-123"] });
  const quarter = TaskPoints.estimate(task);
  assert.equal(quarter.pointTier, "quarter");
  assert.equal(quarter.pointMultiplier, 0.25);
  assert.equal(quarter.awardPoints, 23); // round(90 * 0.25)

  // "No points" bucket -> ineligible, badge hidden.
  TaskPoints.setPointTagTiers({ none: ["Tag-Social-123"] });
  const none = TaskPoints.estimate(task);
  assert.equal(none.eligible, false);
  assert.equal(none.awardPoints, 0);

  // Highest matched multiplier wins when a task spans buckets.
  TaskPoints.setPointTagTiers({ quarter: ["Tag-Social-123"], half: ["other"] });
  task.tags = ["Tag-Social-123", "other"];
  assert.equal(TaskPoints.estimate(task).pointMultiplier, 0.5);

  // Reset clears it back to full.
  TaskPoints.setPointTagTiers(null);
  task.tags = ["Tag-Social-123"];
  assert.equal(TaskPoints.estimate(task).awardPoints, 90);
});

test("rewards estimate at the quarter rate via source or tag", () => {
  const TaskPoints = loadTaskPoints();

  // Reward-bank task (source) -> quarter, no tag-tier config needed.
  const bySource = TaskPoints.estimate({ duration_minutes: 80, source: "reward" });
  assert.equal(bySource.pointTier, "quarter");
  assert.equal(bySource.pointMultiplier, 0.25);
  assert.equal(bySource.awardPoints, 20); // round(80 * 0.25)

  // Reward tag alone -> quarter.
  assert.equal(TaskPoints.estimate({ duration_minutes: 80, tags: ["reward"] }).pointMultiplier, 0.25);

  // Reward wins even if its tag was bucketed into a higher tier.
  TaskPoints.setPointTagTiers({ full: ["reward"] });
  assert.equal(TaskPoints.estimate({ duration_minutes: 80, tags: ["reward"] }).pointMultiplier, 0.25);
  TaskPoints.setPointTagTiers(null);
});

test("commute time adds one tenth point per minute across both legs", () => {
  const TaskPoints = loadTaskPoints();
  const payload = TaskPoints.buildPayload({
    id: "task-commute",
    title: "Appointment",
    durMin: 60,
    commuteToMinutes: 20,
    commuteBackMinutes: 30,
  });

  assert.equal(payload.commute_total_minutes, 50);
  const scoring = TaskPoints.estimate(payload);
  assert.equal(scoring.commuteMinutes, 50);
  assert.equal(scoring.commutePoints, 5);
  assert.equal(scoring.awardPoints, 65);
});
