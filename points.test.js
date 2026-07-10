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

test("frontend: a meeting tagged 'meeting' earns half out of the box, but a bare meeting stays zero", () => {
  const TaskPoints = loadTaskPoints();
  TaskPoints.setPointTagTiers(null); // no user config: only the builtin applies

  // Materialized meetings carry the builtin `meeting` tag -> half multiplier,
  // rescued despite the non-earning meeting TYPE.
  const tagged = TaskPoints.estimate({ type: "meeting", duration_minutes: 60, tags: ["meeting"] });
  assert.equal(tagged.eligible, true);
  assert.equal(tagged.pointTier, "half");
  assert.equal(tagged.pointMultiplier, 0.5);
  assert.equal(tagged.awardPoints, 30); // round(60 * 0.5)

  // A meeting WITHOUT the tag has nothing to rescue it -> still zero.
  const bare = TaskPoints.estimate({ type: "meeting", duration_minutes: 60 });
  assert.equal(bare.eligible, false);
  assert.equal(bare.awardPoints, 0);

  // OOO is hard-zero: even the meeting tag can't rescue it.
  const ooo = TaskPoints.estimate({ type: "ooo", duration_minutes: 60, tags: ["meeting"] });
  assert.equal(ooo.eligible, false);
  assert.equal(ooo.awardPoints, 0);

  // User override beats the builtin: sorting the meeting tag into full -> 1.0x.
  TaskPoints.setPointTagTiers({ full: ["meeting"] });
  const overridden = TaskPoints.estimate({ type: "meeting", duration_minutes: 60, tags: ["meeting"] });
  assert.equal(overridden.pointTier, "full");
  assert.equal(overridden.pointMultiplier, 1);
  assert.equal(overridden.awardPoints, 60);
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
