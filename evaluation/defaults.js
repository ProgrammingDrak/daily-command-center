/**
 * evaluation/defaults.js
 *
 * Default settings for the task-evaluation engine.
 *
 * Categories are sticky once evaluations exist — renaming or removing a
 * category breaks historical evaluations. Add new ones freely; rename only
 * with a migration.
 *
 * Per-point USD rates are placeholders calibrated to one anchor:
 *   +100 in a category = the best realistic outcome from a year of dedicated
 *   effort in that lane. Tune as you collect real evaluations.
 *
 * The points scale (-100..+100) is enforced; values outside that range
 * almost always indicate the user meant something else (a financial outcome
 * stored as points instead of value_usd, typically).
 */

const CATEGORIES = [
  "financial",
  "professional",
  "physical_health",
  "mental_health",
  "learning",
  "creative",
  "relational",
  "relaxation",
  "pleasure",
  "life_admin",
];

const DEFAULT_SETTINGS = {
  hourly_rate_usd: 45,

  padding: {
    enabled: true,
    percent: 35,
  },

  energy_multipliers: {
    very_restorative: 0.3,
    restorative: 0.6,
    neutral: 1.0,
    medium: 1.3,
    high: 1.7,
    draining: 2.2,
  },

  attention_multipliers: {
    restorative: 0.7,
    neutral: 1.0,
    medium: 1.2,
    high: 1.5,
    intense: 1.9,
  },

  // USD subjective value of one point in each category. financial is fixed
  // at 1.0 because financial outcomes use value_usd directly (no points).
  category_rates_usd_per_point: {
    financial: 1.0,
    professional: 12.0,
    physical_health: 18.0,
    mental_health: 25.0,
    learning: 15.0,
    creative: 20.0,
    relational: 30.0,
    relaxation: 10.0,
    pleasure: 10.0,
    life_admin: 5.0,
  },
};

const POINTS_MIN = -100;
const POINTS_MAX = 100;
const PROBABILITY_TOLERANCE = 0.5;
const MIN_OUTCOMES_PER_CATEGORY = 2;

module.exports = {
  CATEGORIES,
  DEFAULT_SETTINGS,
  POINTS_MIN,
  POINTS_MAX,
  PROBABILITY_TOLERANCE,
  MIN_OUTCOMES_PER_CATEGORY,
};
