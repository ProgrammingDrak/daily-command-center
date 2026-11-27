// game/rules.js — pure XP / streak / lives / tier math. No database, no clock
// reads: every function takes "now" or a date as an argument so tests can pin it.
// All calendar dates are YYYY-MM-DD strings in config.TIME_ZONE.
"use strict";

const CONFIG = require("./config");

// ── Time zone helpers ──────────────────────────────────────────────────────

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }));
  }
  return partsCache.get(tz);
}

// Wall-clock parts of an instant in a time zone.
function zonedParts(ms, tz = CONFIG.TIME_ZONE) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    minutes: Number(out.hour) * 60 + Number(out.minute),
    seconds: Number(out.hour) * 3600 + Number(out.minute) * 60 + Number(out.second),
  };
}

function localDate(ms, tz = CONFIG.TIME_ZONE) {
  return zonedParts(ms, tz).date;
}

function isDateStr(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0 = Sunday … 6 = Saturday, for a calendar date (zone-free).
function weekday(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

// The calendar date of the week start (refill weekday) on or before dateStr.
function weekStart(dateStr, cfg = CONFIG) {
  const back = (weekday(dateStr) - cfg.STREAK.REFILL_WEEKDAY + 7) % 7;
  return addDays(dateStr, -back);
}

// The UTC instant of 00:00 on dateStr in tz (handles DST shifts).
function zonedMidnightMs(dateStr, tz = CONFIG.TIME_ZONE) {
  const guess = Date.parse(dateStr + "T00:00:00Z");
  let ms = guess;
  // Two passes converge for every real-world offset, including DST days.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ms, tz);
    const wallMs = Date.parse(p.date + "T00:00:00Z") + p.seconds * 1000;
    ms += guess - wallMs;
  }
  return ms;
}

function hhmmToMinutes(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── XP ─────────────────────────────────────────────────────────────────────

function gamePriority(props = {}, cfg = CONFIG) {
  const raw = props.taskPriority != null ? props.taskPriority : props.priority;
  const key = String(raw == null ? "" : raw).trim().toLowerCase();
  return cfg.PRIORITY_LEVELS[key] || "medium";
}

function completionXp(props = {}, cfg = CONFIG) {
  return cfg.XP.COMPLETE[gamePriority(props, cfg)] || 0;
}

// True when atMs falls on taskDate (in tz) within the on-time window of `start`.
function isOnTimeStart({ taskDate, start, atMs, tz = CONFIG.TIME_ZONE }, cfg = CONFIG) {
  const startMin = hhmmToMinutes(start);
  if (startMin == null || !isDateStr(taskDate) || !Number.isFinite(atMs)) return false;
  const scheduledMs = zonedMidnightMs(taskDate, tz) + startMin * 60000;
  return Math.abs(atMs - scheduledMs) <= cfg.XP.ON_TIME_WINDOW_MINUTES * 60000;
}

// Source keys make every award idempotent: one row per key, ever.
const keys = {
  start: (taskId) => `start:${taskId}`,
  complete: (taskId) => `complete:${taskId}`,
  big3: (taskId, date) => `big3:${taskId}:${date}`,
  perfect: (date) => `perfect:${date}`,
  focus: (taskId) => `focus:${taskId}`,
};

function startAward({ taskId, taskDate, start, atMs, swapped = false, tz }, cfg = CONFIG) {
  if (swapped || !isOnTimeStart({ taskDate, start, atMs, tz }, cfg)) return null;
  return { type: "start_on_time", points: cfg.XP.START_ON_TIME, sourceKey: keys.start(taskId), taskId };
}

// Awards earned by completing one task.
//   big3Ids:        the Big 3 for the task's own date ([] when none set)
//   doneIds:        ids of tasks that are done AFTER this completion
function completionAwards({ taskId, taskDate, props = {}, big3Ids = [], doneIds = new Set(), inFocus = false }, cfg = CONFIG) {
  const out = [{ type: "complete", points: completionXp(props, cfg), sourceKey: keys.complete(taskId), taskId }];
  if (inFocus) out.push({ type: "focus_complete", points: cfg.XP.FOCUS_BONUS, sourceKey: keys.focus(taskId), taskId });
  if (big3Ids.includes(taskId)) {
    out.push({ type: "big3_complete", points: cfg.XP.BIG3_BONUS, sourceKey: keys.big3(taskId, taskDate), taskId });
    if (big3Ids.every((id) => doneIds.has(id))) {
      out.push({ type: "perfect_day", points: cfg.XP.PERFECT_DAY_BONUS, sourceKey: keys.perfect(taskDate), taskId: null });
    }
  }
  return out.filter((a) => a.points > 0);
}

// Keys to void when a task is reopened. Perfect Day is voided because the Big 3
// can no longer all be done.
function reopenVoidKeys({ taskId, taskDate, big3Ids = [] }) {
  const out = [keys.complete(taskId), keys.focus(taskId)];
  if (big3Ids.includes(taskId)) out.push(keys.big3(taskId, taskDate), keys.perfect(taskDate));
  return out;
}

// ── Streak + lives ─────────────────────────────────────────────────────────

function dayCounts({ big3Ids = [], doneIds = new Set(), minimumDayDone = false }) {
  if (minimumDayDone) return true;
  return big3Ids.length > 0 && big3Ids.every((id) => doneIds.has(id));
}

function freshStreak(cfg = CONFIG) {
  return { currentStreak: 0, bestStreak: 0, livesLeft: cfg.STREAK.LIVES_PER_WEEK, livesWeekStart: null, lastClosedDate: null };
}

// Close one day. Idempotent: a date on or before lastClosedDate is a no-op.
// Returns { state, outcome } where outcome is counted | life_used | reset | already_closed.
function closeDay(state, date, counted, cfg = CONFIG) {
  if (state.lastClosedDate && date <= state.lastClosedDate) return { state, outcome: "already_closed" };
  const next = { ...state };
  const week = weekStart(date, cfg);
  if (next.livesWeekStart !== week) {
    next.livesLeft = cfg.STREAK.LIVES_PER_WEEK;
    next.livesWeekStart = week;
  }
  let outcome;
  if (counted) {
    next.currentStreak += 1;
    next.bestStreak = Math.max(next.bestStreak, next.currentStreak);
    outcome = "counted";
  } else if (next.livesLeft > 0) {
    next.livesLeft -= 1;
    outcome = "life_used";
  } else {
    next.currentStreak = 0;
    outcome = "reset";
  }
  next.lastClosedDate = date;
  return { state: next, outcome };
}

// Dates still to close, oldest first: from the day after lastClosedDate (or
// firstDate when nothing is closed yet) up to, but not including, today.
function datesToClose({ lastClosedDate, firstDate, today }) {
  let d = lastClosedDate ? addDays(lastClosedDate, 1) : firstDate;
  if (!d) return [];
  if (firstDate && d < firstDate) d = firstDate;
  const out = [];
  for (; d < today; d = addDays(d, 1)) out.push(d);
  return out;
}

// Lives to show today: a new week means a full refill even before any close.
function livesToday(state, today, cfg = CONFIG) {
  return state.livesWeekStart === weekStart(today, cfg) ? state.livesLeft : cfg.STREAK.LIVES_PER_WEEK;
}

// ── Tiers ──────────────────────────────────────────────────────────────────

function tierFor(weekXp, cfg = CONFIG) {
  let idx = 0;
  cfg.TIERS.forEach((t, i) => { if (weekXp >= t.min) idx = i; });
  const tier = cfg.TIERS[idx], next = cfg.TIERS[idx + 1] || null;
  return { ...tier, next: next ? { ...next, xpToGo: next.min - weekXp } : null };
}

module.exports = {
  zonedParts, localDate, isDateStr, addDays, weekStart, zonedMidnightMs, hhmmToMinutes,
  gamePriority, completionXp, isOnTimeStart, keys, startAward, completionAwards, reopenVoidKeys,
  dayCounts, freshStreak, closeDay, datesToClose, livesToday, tierFor,
};
