"use strict";

// Calendar-backed recurrence for scheduled repeat responsibilities.
//
// Definitions stay as a stable DCC JSON object. rrule is an implementation
// detail used to answer the calendar-date question; exact task times remain
// local wall-clock strings and are converted into the DCC display zone only at
// materialization time. That keeps a 09:00 responsibility at 09:00 through DST.

const { RRule, datetime } = require("rrule");

const DAY_MS = 86400000;
const MAX_FINITE_OCCURRENCES = 730;
const MAX_TIMES_PER_DAY = 48;
const WEEKDAYS = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FREQUENCIES = {
  daily: RRule.DAILY,
  weekly: RRule.WEEKLY,
  monthly: RRule.MONTHLY,
  yearly: RRule.YEARLY,
};

function bad(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function pad(value) { return String(value).padStart(2, "0"); }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  return !!(match && Number(match[1]) < 24 && Number(match[2]) < 60);
}
function validLocalKey(value) {
  const raw = String(value || "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) && validDate(raw.slice(0, 10)) && validTime(raw.slice(11));
}
function utcDate(dateStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  return datetime(year, month, day, 0, 0);
}
function utcDateStr(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function addDays(dateStr, amount) {
  return utcDateStr(new Date(utcDate(dateStr).getTime() + Number(amount || 0) * DAY_MS));
}
function localKey(date, time) { return `${date}T${time}`; }

function assertTimeZone(value, fallback) {
  const timeZone = String(value || fallback || "America/New_York");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date()); }
  catch { throw bad("scheduleRule.timeZone must be a valid IANA time zone"); }
  return timeZone;
}

function uniqueSorted(values) { return [...new Set(values)].sort(); }
function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeScheduleRule(input, opts = {}) {
  if (!input || typeof input !== "object") throw bad("scheduleRule required for scheduled repeats");
  const patternType = input.patternType === "dates" ? "dates" : "calendar";
  const timeZone = assertTimeZone(input.timeZone, opts.defaultTimeZone);
  const endInput = input.end && typeof input.end === "object" ? input.end : {};
  const endType = ["never", "on", "after"].includes(endInput.type) ? endInput.type : "never";
  const end = { type: endType };
  if (endType === "on") {
    if (!validDate(endInput.date)) throw bad("scheduleRule.end.date must be YYYY-MM-DD");
    end.date = String(endInput.date);
  }
  if (endType === "after") end.count = int(endInput.count, 1, 1, MAX_FINITE_OCCURRENCES);

  const out = {
    version: 1,
    patternType,
    timeZone,
    end,
  };
  if (validLocalKey(input.effectiveFrom)) out.effectiveFrom = String(input.effectiveFrom);
  if (validLocalKey(input.effectiveUntil)) out.effectiveUntil = String(input.effectiveUntil);

  if (patternType === "dates") {
    const dateTimes = uniqueSorted((Array.isArray(input.dateTimes) ? input.dateTimes : [])
      .map(String).filter(validLocalKey));
    if (!dateTimes.length) throw bad("Add at least one specific date and time");
    if (dateTimes.length > MAX_FINITE_OCCURRENCES) throw bad(`Specific dates are limited to ${MAX_FINITE_OCCURRENCES} occurrences`);
    out.dateTimes = dateTimes;
    return out;
  }

  const startDate = validDate(input.startDate) ? String(input.startDate) : String(opts.today || "");
  if (!validDate(startDate)) throw bad("scheduleRule.startDate must be YYYY-MM-DD");
  const frequency = Object.prototype.hasOwnProperty.call(FREQUENCIES, input.frequency) ? input.frequency : "weekly";
  const times = uniqueSorted((Array.isArray(input.times) ? input.times : []).map(String).filter(validTime));
  if (!times.length) throw bad("Add at least one scheduled time");
  if (times.length > MAX_TIMES_PER_DAY) throw bad(`Scheduled repeats are limited to ${MAX_TIMES_PER_DAY} times per day`);

  out.startDate = startDate;
  out.frequency = frequency;
  out.interval = int(input.interval, 1, 1, 365);
  out.times = times;

  if (frequency === "weekly") {
    const startWeekday = utcDate(startDate).getUTCDay();
    out.weekDays = uniqueSorted((Array.isArray(input.weekDays) ? input.weekDays : [startWeekday])
      .map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
    if (!out.weekDays.length) out.weekDays = [startWeekday];
  }

  if (frequency === "monthly" || frequency === "yearly") {
    const allowedModes = ["month_days", "ordinal_weekday", "last_day", "last_weekday"];
    out.monthMode = allowedModes.includes(input.monthMode) ? input.monthMode : "month_days";
    if (out.monthMode === "month_days") {
      out.monthDays = uniqueSorted((Array.isArray(input.monthDays) ? input.monthDays : [Number(startDate.slice(8, 10))])
        .map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 31));
      if (!out.monthDays.length) out.monthDays = [Number(startDate.slice(8, 10))];
    }
    if (out.monthMode === "ordinal_weekday") {
      out.ordinal = [-1, 1, 2, 3, 4, 5].includes(Number(input.ordinal)) ? Number(input.ordinal) : 1;
      out.ordinalWeekday = int(input.ordinalWeekday, utcDate(startDate).getUTCDay(), 0, 6);
    }
    if (frequency === "yearly") {
      out.months = uniqueSorted((Array.isArray(input.months) ? input.months : [Number(startDate.slice(5, 7))])
        .map(Number).filter((month) => Number.isInteger(month) && month >= 1 && month <= 12));
      if (!out.months.length) out.months = [Number(startDate.slice(5, 7))];
    }
  }

  if (end.type === "on" && end.date < startDate) throw bad("The repeat end date cannot be before its start date");
  return out;
}

function buildRRule(rule) {
  const options = {
    freq: FREQUENCIES[rule.frequency],
    interval: rule.interval,
    dtstart: utcDate(rule.startDate),
    wkst: RRule.MO,
  };
  if (rule.end.type === "on") {
    const end = utcDate(rule.end.date);
    options.until = new Date(end.getTime() + DAY_MS - 1);
  }
  if (rule.frequency === "weekly") options.byweekday = rule.weekDays.map((day) => WEEKDAYS[day]);
  if (rule.frequency === "monthly" || rule.frequency === "yearly") {
    if (rule.monthMode === "month_days") options.bymonthday = rule.monthDays;
    if (rule.monthMode === "last_day") options.bymonthday = [-1];
    if (rule.monthMode === "ordinal_weekday") options.byweekday = [WEEKDAYS[rule.ordinalWeekday].nth(rule.ordinal)];
    if (rule.monthMode === "last_weekday") {
      options.byweekday = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR];
      options.bysetpos = -1;
    }
    if (rule.frequency === "yearly") options.bymonth = rule.months;
  }
  return new RRule(options);
}

function withinEffective(rule, key) {
  if (rule.effectiveFrom && key < rule.effectiveFrom) return false;
  if (rule.effectiveUntil && key >= rule.effectiveUntil) return false;
  return true;
}

function calendarLocalKeysBetween(rule, fromDate, throughDate) {
  if (throughDate < rule.startDate) return [];
  const start = fromDate > rule.startDate ? fromDate : rule.startDate;
  const dates = buildRRule(rule).between(utcDate(start), new Date(utcDate(throughDate).getTime() + DAY_MS - 1), true);
  const keys = [];
  for (const date of dates) {
    const day = utcDateStr(date);
    for (const time of rule.times) {
      const key = localKey(day, time);
      if (withinEffective(rule, key)) keys.push(key);
    }
  }
  return keys.sort();
}

function allSpecificKeys(rule) {
  let keys = rule.dateTimes.filter((key) => withinEffective(rule, key));
  if (rule.end.type === "on") keys = keys.filter((key) => key.slice(0, 10) <= rule.end.date);
  if (rule.end.type === "after") keys = keys.slice(0, rule.end.count);
  return keys;
}

function occurrenceCountBefore(input, key, opts = {}) {
  const rule = normalizeScheduleRule(input, opts);
  if (!validLocalKey(key)) throw bad("occurrence key must be YYYY-MM-DDTHH:mm");
  let keys = rule.patternType === "dates"
    ? allSpecificKeys(rule)
    : calendarLocalKeysBetween(rule, rule.startDate, key.slice(0, 10));
  if (rule.end.type === "after") keys = keys.slice(0, rule.end.count);
  return keys.filter((candidate) => candidate < key).length;
}

function localKeysForLocalDate(rule, date) {
  if (rule.patternType === "dates") return allSpecificKeys(rule).filter((key) => key.slice(0, 10) === date);
  if (date < rule.startDate || (rule.end.type === "on" && date > rule.end.date)) return [];
  let keys = calendarLocalKeysBetween(rule, date, date);
  if (rule.end.type === "after" && keys.length) {
    const allowed = new Set(calendarLocalKeysBetween(rule, rule.startDate, date).slice(0, rule.end.count));
    keys = keys.filter((key) => allowed.has(key));
  }
  return keys;
}

const formatterCache = new Map();
function formatter(timeZone) {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}
function instantParts(date, timeZone) {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type) => Number((parts.find((part) => part.type === type) || {}).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

// Convert a wall-clock local date-time in an IANA zone to an instant without a
// heavyweight timezone dependency. Iterating the formatter offset converges in
// two passes for ordinary and DST dates. On an ambiguous fall-back minute, the
// earlier matching instant wins; nonexistent spring-forward minutes move to the
// first representable time after the gap.
function localKeyToInstant(key, timeZone) {
  const desired = {
    year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8, 10)),
    hour: Number(key.slice(11, 13)), minute: Number(key.slice(14, 16)),
  };
  const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
  let guess = desiredUtc;
  for (let i = 0; i < 4; i++) {
    const actual = instantParts(new Date(guess), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = desiredUtc - actualUtc;
    if (!correction) break;
    guess += correction;
  }
  const resolved = new Date(guess);
  if (instantToLocalKey(resolved, timeZone) === key) return resolved;

  // A spring-forward gap contains wall-clock labels that never occur. Calendar
  // products move those to the first representable minute after the gap. This
  // slow path runs only for such invalid local minutes; ordinary occurrences
  // return from the iterative path above.
  const wantedDate = key.slice(0, 10);
  const start = desiredUtc - 18 * 60 * 60 * 1000;
  const end = desiredUtc + 18 * 60 * 60 * 1000;
  for (let instant = start; instant <= end; instant += 60000) {
    const candidate = new Date(instant);
    const candidateKey = instantToLocalKey(candidate, timeZone);
    if (candidateKey.slice(0, 10) === wantedDate && candidateKey > key) return candidate;
  }
  return resolved;
}

function instantToLocalKey(date, timeZone) {
  const p = instantParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function occurrenceFromLocalKey(rule, key, targetTimeZone) {
  const instant = localKeyToInstant(key, rule.timeZone);
  const displayKey = instantToLocalKey(instant, targetTimeZone || rule.timeZone);
  return {
    occurrenceKey: key,
    localDate: key.slice(0, 10),
    localTime: key.slice(11),
    timeZone: rule.timeZone,
    instant: instant.toISOString(),
    date: displayKey.slice(0, 10),
    start: displayKey.slice(11),
  };
}

function occurrencesForDate(input, targetDate, opts = {}) {
  const rule = normalizeScheduleRule(input, opts);
  if (!validDate(targetDate)) throw bad("target date must be YYYY-MM-DD");
  const targetTimeZone = opts.targetTimeZone || rule.timeZone;
  const candidates = [];
  for (let offset = -2; offset <= 2; offset++) {
    for (const key of localKeysForLocalDate(rule, addDays(targetDate, offset))) {
      const occurrence = occurrenceFromLocalKey(rule, key, targetTimeZone);
      if (occurrence.date === targetDate) candidates.push(occurrence);
    }
  }
  return candidates.sort((a, b) => a.instant.localeCompare(b.instant));
}

function nextOccurrences(input, opts = {}) {
  const rule = normalizeScheduleRule(input, opts);
  const targetTimeZone = opts.targetTimeZone || rule.timeZone;
  const after = opts.after instanceof Date ? opts.after : new Date(opts.after || Date.now());
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5));
  let keys = [];
  if (rule.patternType === "dates") {
    keys = allSpecificKeys(rule);
  } else if (rule.end.type === "after") {
    // A finite occurrence count is global across all times, so enumerate date
    // matches until enough local keys exist, then apply the shared count once.
    const rrule = buildRRule(rule);
    let cursor = new Date(utcDate(rule.startDate).getTime() - 1);
    for (let guard = 0; guard < MAX_FINITE_OCCURRENCES * 366 && keys.length < rule.end.count; guard++) {
      const date = rrule.after(cursor, true);
      if (!date || date.getUTCFullYear() > 2200) break;
      for (const time of rule.times) {
        const key = localKey(utcDateStr(date), time);
        if (withinEffective(rule, key)) keys.push(key);
        if (keys.length >= rule.end.count) break;
      }
      cursor = new Date(date.getTime() + DAY_MS);
    }
  } else {
    const rrule = buildRRule(rule);
    const searchLocal = instantToLocalKey(after, rule.timeZone).slice(0, 10);
    let cursor = new Date(utcDate(addDays(searchLocal, -2)).getTime() - 1);
    for (let i = 0; i < 100 && keys.length < limit * 3; i++) {
      const date = rrule.after(cursor, true);
      if (!date) break;
      const day = utcDateStr(date);
      if (rule.end.type === "on" && day > rule.end.date) break;
      for (const time of rule.times) {
        const key = localKey(day, time);
        if (withinEffective(rule, key)) keys.push(key);
      }
      cursor = new Date(date.getTime() + DAY_MS);
    }
  }
  return uniqueSorted(keys)
    .map((key) => occurrenceFromLocalKey(rule, key, targetTimeZone))
    .filter((occurrence) => new Date(occurrence.instant) > after)
    .sort((a, b) => a.instant.localeCompare(b.instant))
    .slice(0, limit);
}

function scheduleSummary(input, opts = {}) {
  const rule = normalizeScheduleRule(input, opts);
  if (rule.patternType === "dates") return `${rule.dateTimes.length} specific date${rule.dateTimes.length === 1 ? "" : "s"}`;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.frequency];
  let pattern = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  if (rule.frequency === "weekly") pattern += ` on ${rule.weekDays.map((day) => WEEKDAY_LABELS[day]).join(", ")}`;
  if (rule.frequency === "monthly" || rule.frequency === "yearly") {
    if (rule.monthMode === "month_days") pattern += ` on day ${rule.monthDays.join(", ")}`;
    if (rule.monthMode === "last_day") pattern += " on the last day";
    if (rule.monthMode === "last_weekday") pattern += " on the last weekday";
    if (rule.monthMode === "ordinal_weekday") pattern += ` on the ${rule.ordinal === -1 ? "last" : rule.ordinal} ${WEEKDAY_LABELS[rule.ordinalWeekday]}`;
  }
  pattern += ` at ${rule.times.join(", ")} (${rule.timeZone})`;
  if (rule.end.type === "on") pattern += ` through ${rule.end.date}`;
  if (rule.end.type === "after") pattern += ` for ${rule.end.count} occurrence${rule.end.count === 1 ? "" : "s"}`;
  return pattern;
}

module.exports = {
  MAX_FINITE_OCCURRENCES,
  MAX_TIMES_PER_DAY,
  normalizeScheduleRule,
  occurrencesForDate,
  nextOccurrences,
  scheduleSummary,
  localKeyToInstant,
  instantToLocalKey,
  occurrenceCountBefore,
  addDays,
  validTime,
  validLocalKey,
};
