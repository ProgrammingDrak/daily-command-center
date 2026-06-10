const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTaskForPoints, scoreTaskPoints } = require("./slot-scoring");

test("8 hours of medium normal work yields about 480 points", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 480, effort_tier: "medium", attention_tier: "normal" });
  assert.equal(scoring.awardPoints, 480);
});

test("10 hours of medium normal work yields about 600 points", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 600, effort_tier: "medium", attention_tier: "normal" });
  assert.equal(scoring.awardPoints, 600);
});

test("bounty doubles the computed award", () => {
  const normal = scoreTaskPoints({ duration_minutes: 60, effort_tier: "medium", attention_tier: "normal" });
  const bounty = scoreTaskPoints({ duration_minutes: 60, effort_tier: "medium", attention_tier: "normal", bounty: true });
  assert.equal(normal.awardPoints, 60);
  assert.equal(bounty.awardPoints, 120);
});

test("partner bounty stacks as one additional double", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 30, bounty: true, partner_bounty: true });
  assert.equal(scoring.bountyCount, 2);
  assert.equal(scoring.multipliers.bounty, 4);
  assert.equal(scoring.awardPoints, 120);
});

test("importance and urgency multiply the minute base", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 30, importance: "high", urgency: "urgent" });
  assert.equal(scoring.importanceTier, "high");
  assert.equal(scoring.multipliers.importance, 1.25);
  assert.equal(scoring.multipliers.urgency, 1.15);
  assert.equal(scoring.awardPoints, 43);
});

test("meetings breaks and OOO earn zero", () => {
  for (const type of ["meeting", "break", "ooo"]) {
    const scoring = scoreTaskPoints({ type, duration_minutes: 60 });
    assert.equal(scoring.awardPoints, 0);
    assert.equal(scoring.eligible, false);
  }
});

test("half, quarter, and no-point multipliers adjust the minute base", () => {
  const half = scoreTaskPoints({ duration_minutes: 60, point_tier: "half", point_multiplier: 0.5 });
  const quarter = scoreTaskPoints({ duration_minutes: 60, point_tier: "quarter", point_multiplier: 0.25 });
  const none = scoreTaskPoints({ duration_minutes: 60, point_tier: "none", point_multiplier: 0 });

  assert.equal(half.awardPoints, 30);
  assert.equal(quarter.awardPoints, 15);
  assert.equal(none.awardPoints, 0);
  assert.equal(none.eligible, false);
});

test("meeting can earn when the user sorts it into an earning tier, but OOO stays zero", () => {
  const meeting = scoreTaskPoints({ type: "meeting", duration_minutes: 60, point_multiplier: 0.5 });
  const ooo = scoreTaskPoints({ type: "ooo", duration_minutes: 60, point_multiplier: 1 });

  assert.equal(meeting.eligible, true);
  assert.equal(meeting.awardPoints, 30);
  assert.equal(ooo.eligible, false);
  assert.equal(ooo.awardPoints, 0);
});

test("trivial short tasks earn small but nonzero points when eligible", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 10, effort_tier: "trivial", attention_tier: "light" });
  assert.equal(scoring.awardPoints, 2);
});

test("duration precedence uses actual minutes before scheduled duration", () => {
  const scoring = scoreTaskPoints({ actual_minutes: 25, duration_minutes: 90, effort_tier: "medium", attention_tier: "normal" });
  assert.equal(scoring.durationMinutes, 25);
  assert.equal(scoring.awardPoints, 25);
});

test("generic lunch tasks are classified as non-earning breaks", () => {
  const classification = classifyTaskForPoints({ title: "Lunch", type: "task", duration_minutes: 45 });
  const scoring = scoreTaskPoints({ title: "Lunch", type: "task", duration_minutes: 45 });

  assert.equal(classification.type, "break");
  assert.equal(scoring.classifiedType, "break");
  assert.equal(scoring.pointMultiplier, 0);
  assert.equal(scoring.awardPoints, 0);
  assert.equal(scoring.eligible, false);
});

test("generic routines and chores default to half points", () => {
  const routine = scoreTaskPoints({ title: "Morning routine", type: "task", duration_minutes: 60 });
  const chores = scoreTaskPoints({ title: "Clean kitchen chores", type: "task", duration_minutes: 60 });

  assert.equal(routine.pointTier, "half");
  assert.equal(routine.pointMultiplier, 0.5);
  assert.equal(routine.awardPoints, 30);
  assert.equal(chores.pointTier, "half");
  assert.equal(chores.pointMultiplier, 0.5);
  assert.equal(chores.awardPoints, 30);
});
