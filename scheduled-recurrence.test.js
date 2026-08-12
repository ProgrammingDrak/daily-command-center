const test = require("node:test");
const assert = require("node:assert/strict");
const recurrence = require("./lib/scheduled-recurrence");

function rule(overrides = {}) {
  return {
    version: 1,
    patternType: "calendar",
    timeZone: "America/New_York",
    startDate: "2026-01-01",
    frequency: "daily",
    interval: 1,
    times: ["09:00"],
    end: { type: "never" },
    ...overrides,
  };
}

function keys(input, date) {
  return recurrence.occurrencesForDate(input, date, {
    targetTimeZone: "America/New_York",
    today: "2026-01-01",
  }).map((item) => item.occurrenceKey);
}

test("twice daily creates both independent occurrences and count is global", () => {
  const input = rule({ times: ["09:00", "17:00"], end: { type: "after", count: 3 } });
  assert.deepEqual(keys(input, "2026-01-01"), ["2026-01-01T09:00", "2026-01-01T17:00"]);
  assert.deepEqual(keys(input, "2026-01-02"), ["2026-01-02T09:00"]);
  assert.deepEqual(keys(input, "2026-01-03"), []);
});

test("every N days honors the start boundary", () => {
  const input = rule({ startDate: "2026-01-03", interval: 3 });
  assert.deepEqual(keys(input, "2026-01-02"), []);
  assert.deepEqual(keys(input, "2026-01-03"), ["2026-01-03T09:00"]);
  assert.deepEqual(keys(input, "2026-01-06"), ["2026-01-06T09:00"]);
  assert.deepEqual(keys(input, "2026-01-07"), []);
});

test("multi-weekday weekly schedules use the selected weekdays", () => {
  const input = rule({
    startDate: "2026-01-05",
    frequency: "weekly",
    weekDays: [1, 3, 5],
  });
  assert.deepEqual(keys(input, "2026-01-05"), ["2026-01-05T09:00"]);
  assert.deepEqual(keys(input, "2026-01-06"), []);
  assert.deepEqual(keys(input, "2026-01-07"), ["2026-01-07T09:00"]);
  assert.deepEqual(keys(input, "2026-01-09"), ["2026-01-09T09:00"]);
});

test("day 31 skips short months while last day is explicit", () => {
  const day31 = rule({
    startDate: "2026-01-31",
    frequency: "monthly",
    monthMode: "month_days",
    monthDays: [31],
  });
  assert.deepEqual(keys(day31, "2026-02-28"), []);
  assert.deepEqual(keys(day31, "2026-03-31"), ["2026-03-31T09:00"]);

  const lastDay = rule({
    startDate: "2026-01-31",
    frequency: "monthly",
    monthMode: "last_day",
  });
  assert.deepEqual(keys(lastDay, "2026-02-28"), ["2026-02-28T09:00"]);
});

test("monthly ordinal weekday and last weekday patterns", () => {
  const secondTuesday = rule({
    startDate: "2026-01-01",
    frequency: "monthly",
    monthMode: "ordinal_weekday",
    ordinal: 2,
    ordinalWeekday: 2,
  });
  assert.deepEqual(keys(secondTuesday, "2026-02-10"), ["2026-02-10T09:00"]);
  assert.deepEqual(keys(secondTuesday, "2026-02-17"), []);

  const lastWeekday = rule({
    startDate: "2026-01-01",
    frequency: "monthly",
    monthMode: "last_weekday",
  });
  assert.deepEqual(keys(lastWeekday, "2026-01-30"), ["2026-01-30T09:00"]);
  assert.deepEqual(keys(lastWeekday, "2026-01-31"), []);
});

test("yearly leap-day schedules skip non-leap years", () => {
  const input = rule({
    startDate: "2024-02-29",
    frequency: "yearly",
    monthMode: "month_days",
    monthDays: [29],
    months: [2],
  });
  assert.deepEqual(keys(input, "2025-02-28"), []);
  assert.deepEqual(keys(input, "2028-02-29"), ["2028-02-29T09:00"]);
});

test("specific dates accept arbitrary local date-times", () => {
  const input = {
    version: 1,
    patternType: "dates",
    timeZone: "America/New_York",
    dateTimes: ["2026-04-01T08:15", "2026-04-03T16:45"],
    end: { type: "never" },
  };
  assert.deepEqual(keys(input, "2026-04-01"), ["2026-04-01T08:15"]);
  assert.deepEqual(keys(input, "2026-04-02"), []);
  assert.deepEqual(keys(input, "2026-04-03"), ["2026-04-03T16:45"]);
});

test("inclusive end date keeps every matching time on the final day", () => {
  const input = rule({ times: ["08:00", "20:00"], end: { type: "on", date: "2026-01-02" } });
  assert.deepEqual(keys(input, "2026-01-02"), ["2026-01-02T08:00", "2026-01-02T20:00"]);
  assert.deepEqual(keys(input, "2026-01-03"), []);
});

test("DST changes preserve wall-clock time while the UTC instant shifts", () => {
  const input = rule({ startDate: "2026-03-07", times: ["09:00"] });
  const before = recurrence.occurrencesForDate(input, "2026-03-07", { targetTimeZone: "America/New_York" })[0];
  const after = recurrence.occurrencesForDate(input, "2026-03-09", { targetTimeZone: "America/New_York" })[0];
  assert.equal(before.start, "09:00");
  assert.equal(after.start, "09:00");
  assert.equal(before.instant, "2026-03-07T14:00:00.000Z");
  assert.equal(after.instant, "2026-03-09T13:00:00.000Z");
});

test("a nonexistent spring-forward time moves to the first valid local minute", () => {
  const instant = recurrence.localKeyToInstant("2026-03-08T02:30", "America/New_York");
  assert.equal(recurrence.instantToLocalKey(instant, "America/New_York"), "2026-03-08T03:00");
});

test("effective series boundaries split on the exact local occurrence", () => {
  const input = rule({
    times: ["09:00", "17:00"],
    effectiveFrom: "2026-01-02T17:00",
    effectiveUntil: "2026-01-03T17:00",
  });
  assert.deepEqual(keys(input, "2026-01-02"), ["2026-01-02T17:00"]);
  assert.deepEqual(keys(input, "2026-01-03"), ["2026-01-03T09:00"]);
});

test("next-five preview and summary are human-readable", () => {
  const input = rule({ interval: 2, times: ["09:00", "17:00"] });
  const next = recurrence.nextOccurrences(input, {
    after: new Date("2026-01-01T14:30:00.000Z"),
    targetTimeZone: "America/New_York",
    limit: 5,
  });
  assert.equal(next.length, 5);
  assert.equal(next[0].occurrenceKey, "2026-01-01T17:00");
  assert.match(recurrence.scheduleSummary(input), /^Every 2 days at 09:00, 17:00/);
});

test("invalid dates, empty times, and invalid zones are rejected", () => {
  assert.throws(() => recurrence.normalizeScheduleRule(rule({ startDate: "2026-02-30" })), /startDate/);
  assert.throws(() => recurrence.normalizeScheduleRule(rule({ times: [] })), /scheduled time/);
  assert.throws(() => recurrence.normalizeScheduleRule(rule({ timeZone: "Mars/Olympus" })), /IANA time zone/);
});
