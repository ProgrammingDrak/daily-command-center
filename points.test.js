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
