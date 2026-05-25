const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreTaskPoints } = require("./slot-scoring");

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

test("trivial short tasks earn small but nonzero points when eligible", () => {
  const scoring = scoreTaskPoints({ duration_minutes: 10, effort_tier: "trivial", attention_tier: "light" });
  assert.equal(scoring.awardPoints, 2);
});

test("duration precedence uses actual minutes before scheduled duration", () => {
  const scoring = scoreTaskPoints({ actual_minutes: 25, duration_minutes: 90, effort_tier: "medium", attention_tier: "normal" });
  assert.equal(scoring.durationMinutes, 25);
  assert.equal(scoring.awardPoints, 25);
});
