const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreEvaluation, normalizeProbability } = require("./scoring");

test("normalizes percentage probabilities", () => {
  assert.equal(normalizeProbability(60), 0.6);
  assert.equal(normalizeProbability(0.25), 0.25);
});

test("computes EV input cost net EV ROI and EV per hour", () => {
  const result = scoreEvaluation({
    category: "financial",
    time_hours: 2,
    energy: 1,
    attention: 1,
    money_usd: 20,
    outcomes: [
      { label: "Win", probability: 0.5, value_usd: 200 },
      { label: "Lose", probability: 0.5, value_usd: 0 },
    ],
  });
  assert.equal(result.ev, 100);
  assert.equal(result.inputCost, 92);
  assert.equal(result.netEv, 8);
  assert.equal(result.evPerHour, 4);
  assert.ok(result.roi > 0.08 && result.roi < 0.09);
});

test("warns when probabilities do not roughly total 100 percent", () => {
  const result = scoreEvaluation({
    outcomes: [
      { label: "A", probability: 0.2, value: 10 },
      { label: "B", probability: 0.2, value: 5 },
    ],
  });
  assert.ok(result.warnings.some(w => w.includes("probabilities")));
});

test("supports non-financial categories through unit values", () => {
  const result = scoreEvaluation({
    category: "health",
    outcomes: [{ label: "Better baseline", probability: 1, value: 2 }],
  });
  assert.equal(result.ev, 90);
});
