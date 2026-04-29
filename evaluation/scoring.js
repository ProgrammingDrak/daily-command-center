/**
 * evaluation/scoring.js
 *
 * Pure functions: validate(evaluation, settings) and evaluate(evaluation, settings).
 * No I/O. The HTTP layer and the settings store wrap these.
 *
 * Data shape (the public contract — keep stable):
 *
 *   evaluation = {
 *     success_metric: {
 *       tier_1, tier_2?, tier_3?,
 *       measurement,
 *       confounding_controls?
 *     },
 *     category_evaluations: [
 *       { category, outcomes: [
 *           { label, probability, value_usd?, points?, tier? }   // financial uses value_usd; everything else uses points
 *       ] }
 *     ],
 *     inputs: {
 *       time_hours,
 *       energy,                   // key in settings.energy_multipliers
 *       attention,                // key in settings.attention_multipliers
 *       money_usd?,               // direct dollar cost, default 0
 *       dependencies?,            // free-form list, not used in math
 *       hourly_rate_override_usd? // null/undefined → fall back to settings.hourly_rate_usd
 *     },
 *     notes?,
 *     evaluated_at?,
 *     evaluated_by?
 *   }
 */

const {
  POINTS_MIN,
  POINTS_MAX,
  PROBABILITY_TOLERANCE,
  MIN_OUTCOMES_PER_CATEGORY,
} = require("./defaults");

class ValidationError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "ValidationError";
    this.path = path || null;
  }
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Throws ValidationError on first problem found. The skill that helps a user
 * fill out an evaluation should use this to surface specific issues, not just
 * "invalid". `path` is a dotted location like "category_evaluations[2].outcomes[0].probability".
 */
function validate(evaluation, settings) {
  if (!evaluation || typeof evaluation !== "object") {
    throw new ValidationError("Evaluation must be an object", "$");
  }
  if (!settings || typeof settings !== "object") {
    throw new ValidationError("Settings must be an object", "$");
  }

  // --- success_metric ---
  const sm = evaluation.success_metric;
  if (!sm || typeof sm !== "object") {
    throw new ValidationError("success_metric is required", "success_metric");
  }
  if (!nonEmptyString(sm.tier_1)) {
    throw new ValidationError(
      "success_metric.tier_1 is required (define what tier-1 success looks like)",
      "success_metric.tier_1"
    );
  }
  if (!nonEmptyString(sm.measurement)) {
    throw new ValidationError(
      "success_metric.measurement is required (how will you know you hit it?)",
      "success_metric.measurement"
    );
  }

  // --- inputs ---
  const inputs = evaluation.inputs;
  if (!inputs || typeof inputs !== "object") {
    throw new ValidationError("inputs is required", "inputs");
  }
  if (!isFiniteNumber(inputs.time_hours) || inputs.time_hours <= 0) {
    throw new ValidationError(
      "inputs.time_hours must be a positive number",
      "inputs.time_hours"
    );
  }
  if (!nonEmptyString(inputs.energy) || !(inputs.energy in settings.energy_multipliers)) {
    throw new ValidationError(
      `inputs.energy must be one of: ${Object.keys(settings.energy_multipliers).join(", ")}`,
      "inputs.energy"
    );
  }
  if (
    !nonEmptyString(inputs.attention) ||
    !(inputs.attention in settings.attention_multipliers)
  ) {
    throw new ValidationError(
      `inputs.attention must be one of: ${Object.keys(settings.attention_multipliers).join(", ")}`,
      "inputs.attention"
    );
  }
  if (inputs.money_usd !== undefined && !isFiniteNumber(inputs.money_usd)) {
    throw new ValidationError("inputs.money_usd must be a number", "inputs.money_usd");
  }
  if (
    inputs.hourly_rate_override_usd !== undefined &&
    inputs.hourly_rate_override_usd !== null &&
    (!isFiniteNumber(inputs.hourly_rate_override_usd) || inputs.hourly_rate_override_usd < 0)
  ) {
    throw new ValidationError(
      "inputs.hourly_rate_override_usd must be a non-negative number or null",
      "inputs.hourly_rate_override_usd"
    );
  }

  // --- category_evaluations ---
  const cats = evaluation.category_evaluations;
  if (!Array.isArray(cats) || cats.length === 0) {
    throw new ValidationError(
      "category_evaluations must be a non-empty array — pick at least one lane this task affects",
      "category_evaluations"
    );
  }

  const seenCategories = new Set();
  for (let ci = 0; ci < cats.length; ci++) {
    const ce = cats[ci];
    const path = `category_evaluations[${ci}]`;
    if (!ce || typeof ce !== "object") {
      throw new ValidationError("Category evaluation must be an object", path);
    }
    if (!nonEmptyString(ce.category)) {
      throw new ValidationError("category is required", `${path}.category`);
    }
    if (!(ce.category in settings.category_rates_usd_per_point)) {
      throw new ValidationError(
        `Unknown category "${ce.category}". Known: ${Object.keys(settings.category_rates_usd_per_point).join(", ")}`,
        `${path}.category`
      );
    }
    if (seenCategories.has(ce.category)) {
      throw new ValidationError(
        `Duplicate category "${ce.category}" — combine outcomes into one entry`,
        `${path}.category`
      );
    }
    seenCategories.add(ce.category);

    if (!Array.isArray(ce.outcomes) || ce.outcomes.length < MIN_OUTCOMES_PER_CATEGORY) {
      throw new ValidationError(
        `outcomes must have at least ${MIN_OUTCOMES_PER_CATEGORY} entries — include the failure/partial paths, not just the win`,
        `${path}.outcomes`
      );
    }

    let probSum = 0;
    for (let oi = 0; oi < ce.outcomes.length; oi++) {
      const o = ce.outcomes[oi];
      const opath = `${path}.outcomes[${oi}]`;
      if (!o || typeof o !== "object") {
        throw new ValidationError("Outcome must be an object", opath);
      }
      if (!nonEmptyString(o.label)) {
        throw new ValidationError("outcome.label is required", `${opath}.label`);
      }
      if (!isFiniteNumber(o.probability) || o.probability < 0 || o.probability > 100) {
        throw new ValidationError(
          "outcome.probability must be a number 0..100",
          `${opath}.probability`
        );
      }
      probSum += o.probability;

      if (ce.category === "financial") {
        if (!isFiniteNumber(o.value_usd)) {
          throw new ValidationError(
            "financial outcomes require numeric value_usd (negative for cost)",
            `${opath}.value_usd`
          );
        }
        if (o.points !== undefined) {
          throw new ValidationError(
            "financial outcomes use value_usd, not points",
            `${opath}.points`
          );
        }
      } else {
        if (!isFiniteNumber(o.points)) {
          throw new ValidationError(
            `${ce.category} outcomes require numeric points (-${POINTS_MAX}..+${POINTS_MAX})`,
            `${opath}.points`
          );
        }
        if (o.points < POINTS_MIN || o.points > POINTS_MAX) {
          throw new ValidationError(
            `points must be in [${POINTS_MIN}, ${POINTS_MAX}] — values outside this range usually mean the wrong unit was used`,
            `${opath}.points`
          );
        }
        if (o.value_usd !== undefined) {
          throw new ValidationError(
            `${ce.category} outcomes use points, not value_usd. Only "financial" uses value_usd directly.`,
            `${opath}.value_usd`
          );
        }
      }

      if (o.tier !== undefined && !["1", "2", "3", "fail", 1, 2, 3].includes(o.tier)) {
        throw new ValidationError(
          'outcome.tier must be 1, 2, 3, or "fail"',
          `${opath}.tier`
        );
      }
    }

    if (Math.abs(probSum - 100) > PROBABILITY_TOLERANCE) {
      throw new ValidationError(
        `Probabilities for "${ce.category}" sum to ${probSum.toFixed(2)}, must sum to 100 (tolerance ±${PROBABILITY_TOLERANCE})`,
        `${path}.outcomes`
      );
    }
  }

  return true;
}

/**
 * Returns a score object. Throws ValidationError if the input is malformed.
 * Pure: same input → same output, no I/O.
 */
function evaluate(evaluation, settings) {
  validate(evaluation, settings);

  const inputs = evaluation.inputs;
  const padding = settings.padding || { enabled: false, percent: 0 };
  const padded_hours = padding.enabled
    ? inputs.time_hours * (1 + padding.percent / 100)
    : inputs.time_hours;

  const energy_mult = settings.energy_multipliers[inputs.energy];
  const attention_mult = settings.attention_multipliers[inputs.attention];
  const hourly_rate =
    inputs.hourly_rate_override_usd != null
      ? inputs.hourly_rate_override_usd
      : settings.hourly_rate_usd;

  const time_cost = padded_hours * energy_mult * attention_mult * hourly_rate;
  const money_usd = inputs.money_usd || 0;
  const total_input_cost = time_cost + money_usd;

  const ev_breakdown = {};
  const tier_breakdown = { 1: 0, 2: 0, 3: 0, fail: 0, untiered: 0 };
  let expected_value = 0;

  for (const ce of evaluation.category_evaluations) {
    const rate = settings.category_rates_usd_per_point[ce.category];
    let cat_ev = 0;
    for (const o of ce.outcomes) {
      const p = o.probability / 100;
      let outcome_value_usd;
      if (ce.category === "financial") {
        outcome_value_usd = o.value_usd;
      } else {
        outcome_value_usd = o.points * rate;
      }
      const contribution = outcome_value_usd * p;
      cat_ev += contribution;
      const tierKey =
        o.tier === undefined || o.tier === null ? "untiered" : String(o.tier);
      if (tier_breakdown[tierKey] === undefined) tier_breakdown[tierKey] = 0;
      tier_breakdown[tierKey] += contribution;
    }
    ev_breakdown[ce.category] = cat_ev;
    expected_value += cat_ev;
  }

  const net_ev = expected_value - total_input_cost;
  const roi = total_input_cost > 0 ? expected_value / total_input_cost : null;
  const ev_per_hour = padded_hours > 0 ? expected_value / padded_hours : null;

  // Identify the lane that drives the most absolute value (positive or negative).
  // Useful when the user wants "what is this task really about?"
  let primary_category = null;
  let max_abs = 0;
  for (const [cat, val] of Object.entries(ev_breakdown)) {
    if (Math.abs(val) > max_abs) {
      max_abs = Math.abs(val);
      primary_category = cat;
    }
  }

  const warnings = [];
  if (!padding.enabled) {
    warnings.push(
      "Padding is disabled — time estimates are taken at face value. Most people underestimate by 25–50%."
    );
  }
  // Surface a warning when no outcome is tagged as a failure path. Users
  // commonly skip this step, which inflates EV.
  const hasFailTier = evaluation.category_evaluations.some((ce) =>
    ce.outcomes.some((o) => o.tier === "fail")
  );
  if (!hasFailTier) {
    warnings.push(
      'No outcome is tagged tier:"fail". Including an explicit failure path keeps EV honest.'
    );
  }

  return {
    expected_value,
    total_input_cost,
    net_ev,
    roi,
    ev_per_hour,
    ev_breakdown,
    tier_breakdown,
    primary_category,
    inputs_used: {
      time_hours: inputs.time_hours,
      padded_hours,
      hourly_rate,
      energy: inputs.energy,
      energy_mult,
      attention: inputs.attention,
      attention_mult,
      money_usd,
    },
    warnings,
  };
}

module.exports = { validate, evaluate, ValidationError };
