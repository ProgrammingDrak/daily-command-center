/**
 * Run with: node --test evaluation/scoring.test.js
 *
 * Pure unit tests for the scoring engine. No DB, no HTTP. The persistence
 * and routes layers are integration concerns and aren't exercised here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluate, validate, ValidationError } = require("./scoring");
const { DEFAULT_SETTINGS } = require("./defaults");

// Tolerance for floating-point comparisons. The math chains 5+ multiplies
// per category so we can't expect bit-exact equality.
const EPS = 0.01;

function approx(actual, expected, eps = EPS) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${expected} ± ${eps}, got ${actual}`
  );
}

// Reusable valid skeleton — tests mutate copies of this to test specific paths.
function validEvaluation() {
  return {
    success_metric: {
      tier_1: "Named something to fix in the relationship",
      tier_2: "Real conversation about something not surface-level",
      tier_3: "We caught up",
      measurement: "Self-report after the meeting",
      confounding_controls: "If either of us is exhausted, downgrade tier",
    },
    inputs: {
      time_hours: 1.5,
      energy: "restorative",
      attention: "restorative",
      money_usd: 0,
    },
    category_evaluations: [
      {
        category: "relational",
        outcomes: [
          { label: "Named fix", points: 25, probability: 30, tier: 1 },
          { label: "Real conversation", points: 10, probability: 30, tier: 2 },
          { label: "Caught up", points: 3, probability: 30, tier: 3 },
          { label: "Tense", points: -8, probability: 10, tier: "fail" },
        ],
      },
      {
        category: "relaxation",
        outcomes: [
          { label: "Restored", points: 8, probability: 70, tier: 1 },
          { label: "Drained", points: -2, probability: 30, tier: "fail" },
        ],
      },
      {
        category: "financial",
        outcomes: [
          { label: "I cover coffee", value_usd: -20, probability: 100, tier: "fail" },
          { label: "Brother insists on paying", value_usd: 0, probability: 0 },
        ],
      },
    ],
  };
}

// ── Worked example: coffee with brother ──

test("coffee-with-brother produces the expected score", () => {
  const ev = validEvaluation();
  const score = evaluate(ev, DEFAULT_SETTINGS);

  // relational: (25*0.3 + 10*0.3 + 3*0.3 + -8*0.1) = 10.6 pts × $30 = $318
  approx(score.ev_breakdown.relational, 318);
  // relaxation: (8*0.7 + -2*0.3) = 5.0 pts × $10 = $50
  approx(score.ev_breakdown.relaxation, 50);
  // financial: -20 × 1.0 + 0 × 0 = -$20
  approx(score.ev_breakdown.financial, -20);

  // total EV
  approx(score.expected_value, 348);

  // padded_hours = 1.5 × 1.35 = 2.025
  // time_cost    = 2.025 × 0.6 × 0.7 × 45 = $38.27
  approx(score.inputs_used.padded_hours, 2.025);
  approx(score.total_input_cost, 38.27);

  approx(score.net_ev, 309.73);
  approx(score.roi, 9.09, 0.05);
  approx(score.ev_per_hour, 171.85, 0.5);
  assert.equal(score.primary_category, "relational");
});

test("disabling padding uses raw time_hours and emits a warning", () => {
  const settings = { ...DEFAULT_SETTINGS, padding: { enabled: false, percent: 35 } };
  const score = evaluate(validEvaluation(), settings);
  approx(score.inputs_used.padded_hours, 1.5);
  // 1.5 × 0.6 × 0.7 × 45 = 28.35
  approx(score.total_input_cost, 28.35);
  assert.ok(score.warnings.some((w) => w.includes("Padding is disabled")));
});

test("missing fail-tier outcome surfaces a warning", () => {
  const ev = validEvaluation();
  // Strip every fail tier
  for (const ce of ev.category_evaluations) {
    for (const o of ce.outcomes) if (o.tier === "fail") delete o.tier;
  }
  const score = evaluate(ev, DEFAULT_SETTINGS);
  assert.ok(score.warnings.some((w) => w.includes('tier:"fail"')));
});

test("hourly_rate_override_usd takes precedence over global rate", () => {
  const ev = validEvaluation();
  ev.inputs.hourly_rate_override_usd = 200;
  const score = evaluate(ev, DEFAULT_SETTINGS);
  approx(score.inputs_used.hourly_rate, 200);
  // 2.025 × 0.6 × 0.7 × 200 = $170.10
  approx(score.total_input_cost, 170.1, 0.05);
});

test("money_usd is added to input cost on top of time cost", () => {
  const ev = validEvaluation();
  ev.inputs.money_usd = 100;
  const score = evaluate(ev, DEFAULT_SETTINGS);
  approx(score.total_input_cost, 38.27 + 100);
});

test("primary_category picks the largest absolute breakdown", () => {
  const ev = validEvaluation();
  // Make financial dominate
  ev.category_evaluations[2].outcomes[0].value_usd = -10000;
  const score = evaluate(ev, DEFAULT_SETTINGS);
  assert.equal(score.primary_category, "financial");
});

test("tier_breakdown sums match expected_value", () => {
  const score = evaluate(validEvaluation(), DEFAULT_SETTINGS);
  const tierTotal = Object.values(score.tier_breakdown).reduce((a, b) => a + b, 0);
  approx(tierTotal, score.expected_value);
});

// ── Validators ──

test("validate: requires success_metric.tier_1", () => {
  const ev = validEvaluation();
  delete ev.success_metric.tier_1;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: requires success_metric.measurement", () => {
  const ev = validEvaluation();
  ev.success_metric.measurement = "  ";
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects time_hours <= 0", () => {
  const ev = validEvaluation();
  ev.inputs.time_hours = 0;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects unknown energy level", () => {
  const ev = validEvaluation();
  ev.inputs.energy = "intergalactic";
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects unknown attention level", () => {
  const ev = validEvaluation();
  ev.inputs.attention = "telepathic";
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects empty category_evaluations", () => {
  const ev = validEvaluation();
  ev.category_evaluations = [];
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects unknown category", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].category = "spiritual_warfare";
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects duplicate categories", () => {
  const ev = validEvaluation();
  ev.category_evaluations.push({
    category: "relational",
    outcomes: [
      { label: "x", points: 1, probability: 50 },
      { label: "y", points: -1, probability: 50 },
    ],
  });
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects fewer than 2 outcomes per category", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes = [
    { label: "only one", points: 5, probability: 100 },
  ];
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects probability sums outside tolerance", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[0].probability = 25; // total now = 95
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: accepts probability sums within tolerance", () => {
  const ev = validEvaluation();
  // 30 + 30 + 30 + 10.3 = 100.3, within 0.5 tolerance
  ev.category_evaluations[0].outcomes[3].probability = 10.3;
  assert.doesNotThrow(() => evaluate(ev, DEFAULT_SETTINGS));
});

test("validate: rejects financial outcome missing value_usd", () => {
  const ev = validEvaluation();
  delete ev.category_evaluations[2].outcomes[0].value_usd;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects financial outcome with points field", () => {
  const ev = validEvaluation();
  ev.category_evaluations[2].outcomes[0].points = 5;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects non-financial outcome with value_usd field", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[0].value_usd = 100;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects points outside [-100, 100]", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[0].points = 150;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects probability outside [0, 100]", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[0].probability = 110;
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("validate: rejects invalid tier value", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[0].tier = "bronze";
  assert.throws(() => evaluate(ev, DEFAULT_SETTINGS), ValidationError);
});

test("ValidationError carries a path for the offending field", () => {
  const ev = validEvaluation();
  ev.category_evaluations[0].outcomes[1].probability = 200;
  try {
    evaluate(ev, DEFAULT_SETTINGS);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.match(e.path, /category_evaluations\[0\].outcomes\[1\].probability/);
  }
});

// ── Settings deep-merge contract ──

test("evaluate: respects custom category rates", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    category_rates_usd_per_point: {
      ...DEFAULT_SETTINGS.category_rates_usd_per_point,
      relational: 60.0, // double the default
    },
  };
  const ev = validEvaluation();
  const score = evaluate(ev, settings);
  approx(score.ev_breakdown.relational, 636); // was 318, doubles to 636
});

test("evaluate: respects custom energy multipliers", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    energy_multipliers: { ...DEFAULT_SETTINGS.energy_multipliers, restorative: 1.0 },
  };
  const score = evaluate(validEvaluation(), settings);
  // 2.025 × 1.0 × 0.7 × 45 = 63.79
  approx(score.total_input_cost, 63.79, 0.05);
});

test("evaluate: zero input_cost yields null roi (not Infinity)", () => {
  const settings = { ...DEFAULT_SETTINGS, hourly_rate_usd: 0 };
  const ev = validEvaluation();
  ev.inputs.money_usd = 0;
  const score = evaluate(ev, settings);
  assert.equal(score.total_input_cost, 0);
  assert.equal(score.roi, null);
});
