// game/config.js — every number the XP / streak game uses lives here.
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

// Weekly tiers by week XP (Monday–Sunday, TIME_ZONE). `min` is inclusive.
// Must stay sorted by `min`, first entry at 0.
const TIERS = [
  { id: "bronze", label: "Bronze", min: 0 },
  { id: "silver", label: "Silver", min: 200 },
  { id: "gold", label: "Gold", min: 450 },
  { id: "platinum", label: "Platinum", min: 750 },
  { id: "diamond", label: "Diamond", min: 1100 },
];

module.exports = { TIME_ZONE, XP, PRIORITY_LEVELS, BIG3_MAX, STREAK, TIERS };
