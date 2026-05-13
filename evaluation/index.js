/**
 * evaluation/index.js
 *
 * Entry point for the evaluation engine. Re-exports the public API so
 * callers can do:
 *
 *   const { evaluate, validate, getSettings, DEFAULT_SETTINGS } = require("./evaluation");
 */

const { evaluate, validate, ValidationError } = require("./scoring");
const { getSettings, updateSettings, resetSettings } = require("./settings-store");
const {
  CATEGORIES,
  DEFAULT_SETTINGS,
  POINTS_MIN,
  POINTS_MAX,
  PROBABILITY_TOLERANCE,
  MIN_OUTCOMES_PER_CATEGORY,
} = require("./defaults");

module.exports = {
  // Pure scoring
  evaluate,
  validate,
  ValidationError,
  // Persistence
  getSettings,
  updateSettings,
  resetSettings,
  // Config
  CATEGORIES,
  DEFAULT_SETTINGS,
  POINTS_MIN,
  POINTS_MAX,
  PROBABILITY_TOLERANCE,
  MIN_OUTCOMES_PER_CATEGORY,
};
