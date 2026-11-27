// game/config.js — every number the Mochi game uses lives here. The UI calls
// XP "sparks": they belong to Mochi, not to the player.
// Change a value here and the server, the tests and the HUD all follow.
// XP is separate from the slot-credit economy (slot-scoring.js). Nothing here
// moves slot credits, and no rule here may ever produce negative points.
"use strict";

const TIME_ZONE = "America/New_York";

const XP = {
  // Start within this many minutes of the scheduled start (before or after).
  ON_TIME_WINDOW_MINUTES: 5,
  START_ON_TIME: 10,
  // Completion XP by game priority level.
  COMPLETE: { low: 5, normal: 8, medium: 10, high: 15, urgent: 20 },
  BIG3_BONUS: 10,
  PERFECT_DAY_BONUS: 25,
  // Phase 2: completing a task inside its focus session.
  FOCUS_BONUS: 5,
};

// The app stores taskPriority as one of five levels (public/js/task-priority.js).
// Map each one, plus the game's own words, to a game level. Unknown → medium,
// which matches TaskPriority.normalize's own default.
const PRIORITY_LEVELS = {
  "very low": "low",
  low: "normal",
  medium: "medium",
  high: "high",
  "very high": "urgent",
  normal: "normal",
  urgent: "urgent",
  critical: "urgent",
};

const BIG3_MAX = 3;

const STREAK = {
  LIVES_PER_WEEK: 2,
  // Lives refill at 00:00 TIME_ZONE on this weekday (1 = Monday).
  REFILL_WEEKDAY: 1,
};

// Weekly trips by week XP ("sparks" in the UI): the more sparks this week,
// the farther Mochi travels at the weekend. `min` is inclusive. Must stay
// sorted by `min`, first entry at 0. (Internally still called tiers.)
const TIERS = [
  { id: "backyard", label: "Backyard", min: 0 },
  { id: "park", label: "Park", min: 200 },
  { id: "forest", label: "Forest", min: 450 },
  { id: "mountains", label: "Mountains", min: 750 },
  { id: "seaside", label: "Seaside", min: 1100 },
];

// Mochi grows from lifetime sparks. Growth never resets and never goes down.
const PET_STAGES = [
  { id: "seed", label: "Seed", min: 0 },
  { id: "sprout", label: "Sprout", min: 150 },
  { id: "sapling", label: "Sapling", min: 400 },
  { id: "bloom", label: "Bloom", min: 800 },
  { id: "grove", label: "Grove", min: 1400 },
];

module.exports = { TIME_ZONE, XP, PRIORITY_LEVELS, BIG3_MAX, STREAK, TIERS, PET_STAGES };
