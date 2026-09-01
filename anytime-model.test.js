// Model tests for the Anytime lane (public/js/anytime-store.js): a target count
// inside a repeating window, with no time inside the window.
//
// What these pin, in order of how badly each would hurt:
//   1. periodMinutes is always a DIVISOR of 1440 — otherwise the wrap-around key
//      for a window that began before day start can collide with a real window's
//      key on the same day, and two windows share one counter
//   2. windows align to the USER'S day start, not UTC midnight
//   3. closing a window is IDEMPOTENT: a second tick, or a second device, must
//      not double-count a hit or re-log a miss
//   4. an INACTIVE window is never seeded, so quiet hours can never become misses
//   5. a fresh window does not nudge on its first tick, and an open window does
//      not nudge on every tick after the first
//   6. the streak reads finished days only — a day in progress is never a failure
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./public/js/anytime-store.js");

const MIN = 60000;
const DAY_START = 420;          // 07:00, the app default
const TODAY = "2026-08-28";

function def(props) {
  return A.normalizeDef({ id: props.id || "def-1", properties: { title: "T", ...props } });
}
function hourly(extra) {
  return def({ periodMinutes: 60, target: 1, nudgeEveryMin: 20, ...(extra || {}) });
}
function daily(extra) {
  return def({ periodMinutes: 1440, target: 3, nudgeEveryMin: 120, ...(extra || {}) });
}
// `ctx` the pure functions take. midnightMs is arbitrary but consistent.
function ctx(minutesOfDay, opts) {
  opts = opts || {};
  const midnightMs = Date.UTC(2026, 7, 28);
  return {
    nowMs: midnightMs + minutesOfDay * MIN,
    midnightMs: midnightMs,
    minutesOfDay: minutesOfDay,
    dayStartMin: opts.dayStartMin == null ? DAY_START : opts.dayStartMin,
    dowIndex: opts.dowIndex == null ? 5 : opts.dowIndex,   // 2026-08-28 is a Friday
    todayStr: TODAY
  };
}

// ── 1. the divisor rule ──

test("periodMinutes always snaps to a divisor of 1440", () => {
  A.PERIOD_CHOICES.forEach(p => assert.equal(1440 % p, 0, p + " must divide 1440"));
  [100, 7, 13, 501, 999].forEach(bogus => {
    const snapped = A.snapPeriod(bogus);
    assert.equal(1440 % snapped, 0, bogus + " -> " + snapped + " must divide 1440");
    assert.ok(snapped <= bogus, "snaps down, never up");
  });
  assert.equal(def({ periodMinutes: 100 }).periodMinutes, 96);
});

test("a divisor period yields exactly 1440/span distinct keys across a whole day", () => {
  A.PERIOD_CHOICES.filter(p => p < 1440).forEach(span => {
    const d = def({ periodMinutes: span });
    const keys = new Set();
    for (let m = 0; m < 1440; m++) keys.add(A.windowKeyFor(d, m, DAY_START));
    assert.equal(keys.size, 1440 / span, "span " + span);
  });
});

// ── 2. window alignment ──

test("an hourly item on a 07:00 day start yields 07:00, 08:00, 09:00", () => {
  const d = hourly();
  assert.equal(A.windowKeyFor(d, 7 * 60, DAY_START), "07:00");
  assert.equal(A.windowKeyFor(d, 7 * 60 + 59, DAY_START), "07:00");
  assert.equal(A.windowKeyFor(d, 8 * 60, DAY_START), "08:00");
  assert.equal(A.windowKeyFor(d, 9 * 60 + 30, DAY_START), "09:00");
});

test("windows follow the user's day start, not midnight", () => {
  const d = def({ periodMinutes: 90 });
  // 05:30 day start -> 90-minute windows at 05:30, 07:00, 08:30.
  assert.equal(A.windowKeyFor(d, 6 * 60, 330), "05:30");
  assert.equal(A.windowKeyFor(d, 7 * 60 + 1, 330), "07:00");
  assert.equal(A.windowKeyFor(d, 8 * 60 + 45, 330), "08:30");
});

test("a tick before day start lands on the window that began the evening before", () => {
  const d = def({ periodMinutes: 480 });   // 8h windows off a 07:00 start
  // 03:00 sits in the window that opened at 23:00 the previous day.
  assert.equal(A.windowKeyFor(d, 180, DAY_START), "23:00");
  // ...and its start timestamp must be pulled back a day, or the nudge anchor
  // would sit in the future and suppress every nudge for that window.
  const c = ctx(180);
  assert.ok(A.windowStartMs(d, c) < c.nowMs, "window start is in the past");
  assert.equal(c.nowMs - A.windowStartMs(d, c), 4 * 60 * MIN, "23:00 to 03:00 is 4h");
});

test("a daily item is one window for every minute of the day", () => {
  const d = daily();
  for (let m = 0; m < 1440; m += 37) assert.equal(A.windowKeyFor(d, m, DAY_START), "day");
  assert.equal(A.windowResetMinutes(d, 600, DAY_START), null);
  assert.equal(A.windowResetMinutes(hourly(), 600, DAY_START), 660);
});

// ── 3. idempotent close ──

test("closing the same window twice writes history once", () => {
  const d = hourly();
  const entry = { w: { "07:00": 1, "08:00": 0 }, closed: [], lastNudgeAt: null, lastWindowKey: "07:00" };
  const first = A.closeStaleWindows(d, entry, "08:00", TODAY);
  assert.deepEqual(first.entry.closed, ["07:00"]);
  assert.deepEqual(first.history[TODAY], { hit: 1, closed: 1 });
  assert.equal(first.changed, true);

  // Replay with the definition now carrying that history: nothing moves.
  d.history = first.history;
  const second = A.closeStaleWindows(d, first.entry, "08:00", TODAY);
  assert.deepEqual(second.entry.closed, ["07:00"], "no duplicate close");
  assert.deepEqual(second.history[TODAY], { hit: 1, closed: 1 });
  assert.equal(second.changed, false, "a replay is a no-op");
  assert.deepEqual(second.missed, [], "a miss is not re-logged");
});

test("a window that closes below target is a miss, and it is reported once", () => {
  const d = def({ periodMinutes: 60, target: 3 });
  const entry = { w: { "07:00": 2 }, closed: [], lastNudgeAt: null, lastWindowKey: "07:00" };
  const res = A.closeStaleWindows(d, entry, "08:00", TODAY);
  assert.deepEqual(res.missed, ["07:00"], "2 of 3 is a miss");
  assert.deepEqual(res.history[TODAY], { hit: 0, closed: 1 });

  d.history = res.history;
  assert.deepEqual(A.closeStaleWindows(d, res.entry, "08:00", TODAY).missed, []);
});

test("a window handover clears the nudge stamp so the new window nudges on its own clock", () => {
  const d = hourly();
  const entry = { w: { "07:00": 0 }, closed: [], lastNudgeAt: "2026-08-28T07:40:00Z", lastWindowKey: "07:00" };
  const res = A.closeStaleWindows(d, entry, "08:00", TODAY);
  assert.equal(res.entry.lastNudgeAt, null);
  assert.equal(res.entry.lastWindowKey, "08:00");
});

test("the running window is never counted as closed", () => {
  const d = hourly();
  const entry = { w: { "07:00": 1, "08:00": 0 }, closed: [], lastNudgeAt: null, lastWindowKey: "08:00" };
  const res = A.closeStaleWindows(d, entry, "08:00", TODAY);
  assert.deepEqual(res.entry.closed, ["07:00"]);
  assert.deepEqual(res.history[TODAY], { hit: 1, closed: 1 }, "08:00 is still in play");
});

test("history is capped and keeps the newest days", () => {
  const history = {};
  for (let i = 0; i < 45; i++) history[A.shiftDate(TODAY, -i)] = { hit: 1, closed: 1 };
  const trimmed = A.trimHistory(history);
  const keys = Object.keys(trimmed).sort();
  assert.equal(keys.length, A.HISTORY_DAYS);
  assert.equal(keys[keys.length - 1], TODAY, "newest survives");
});

// ── 4. quiet hours ──

test("quiet hours and days off gate a window as inactive", () => {
  const d = def({ periodMinutes: 60, activeFrom: "08:00", activeUntil: "21:00" });
  assert.equal(A.isActiveAt(d, 7 * 60, 5), false, "before the window");
  assert.equal(A.isActiveAt(d, 8 * 60, 5), true);
  assert.equal(A.isActiveAt(d, 21 * 60, 5), false, "the end is exclusive");

  const weekdays = def({ periodMinutes: 60, activeDays: [1, 2, 3, 4, 5] });
  assert.equal(A.isActiveAt(weekdays, 600, 5), true, "Friday");
  assert.equal(A.isActiveAt(weekdays, 600, 0), false, "Sunday");

  const overnight = def({ periodMinutes: 60, activeFrom: "22:00", activeUntil: "02:00" });
  assert.equal(A.isActiveAt(overnight, 23 * 60, 5), true);
  assert.equal(A.isActiveAt(overnight, 60, 5), true);
  assert.equal(A.isActiveAt(overnight, 12 * 60, 5), false);

  assert.equal(A.isActiveAt(def({ status: "archived" }), 600, 5), false);
});

// ── 5. nudge timing ──

test("a fresh window does not nudge on its first tick", () => {
  const d = hourly({ nudgeEveryMin: 20 });
  const entry = A.blankEntry();
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60)), false, "window just opened");
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60 + 19)), false, "one minute short");
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60 + 20)), true, "20 minutes in");
});

test("an already-nudged window waits a full cadence before nudging again", () => {
  const d = hourly({ nudgeEveryMin: 20 });
  const stamped = new Date(ctx(8 * 60 + 20).nowMs).toISOString();
  const entry = { w: { "08:00": 0 }, closed: [], lastNudgeAt: stamped, lastWindowKey: "08:00" };
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60 + 35)), false);
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60 + 40)), true);
});

test("a met target never nudges", () => {
  const d = hourly({ target: 2 });
  const entry = { w: { "08:00": 2 }, closed: [], lastNudgeAt: null, lastWindowKey: "08:00" };
  assert.equal(A.nudgeDue(d, entry, ctx(8 * 60 + 59)), false);
});

test("no cadence means never nudge", () => {
  const d = hourly({ nudgeEveryMin: null });
  assert.equal(A.nudgeDue(d, A.blankEntry(), ctx(9 * 60)), false);
  assert.equal(def({ nudgeEveryMin: 0 }).nudgeEveryMin, null, "0 is not a cadence");
});

test("dueNudges skips quiet hours and days off, and sorts the most-behind first", () => {
  const quiet = def({ id: "q", title: "Water", periodMinutes: 1440, target: 3, nudgeEveryMin: 30, activeFrom: "08:00", activeUntil: "21:00" });
  const weekend = def({ id: "w", title: "Weekend", periodMinutes: 1440, target: 1, nudgeEveryMin: 30, activeDays: [0, 6] });
  const open = def({ id: "o", title: "Pushups", periodMinutes: 1440, target: 1, nudgeEveryMin: 30 });

  assert.deepEqual(A.dueNudges([quiet, weekend, open], {}, ctx(6 * 60)).map(r => r.def.id), [],
    "06:00 is before the day start, so no window has run long enough");

  const midday = ctx(13 * 60);
  const ids = A.dueNudges([quiet, weekend, open], {}, midday).map(r => r.def.id);
  assert.deepEqual(ids, ["q", "o"], "weekend item is off on a Friday; water is furthest behind");

  const sunday = ctx(13 * 60, { dowIndex: 0 });
  assert.ok(A.dueNudges([weekend], {}, sunday).length === 1, "Sunday admits the weekend item");
});

test("an untitled definition is never nudged", () => {
  const blank = A.normalizeDef({ id: "x", properties: { periodMinutes: 1440, nudgeEveryMin: 30 } });
  assert.deepEqual(A.dueNudges([blank], {}, ctx(13 * 60)), []);
});

// ── 6. streaks ──

test("the streak counts finished days before today and stops at the first gap", () => {
  const h = {};
  [1, 2, 3].forEach(i => { h[A.shiftDate(TODAY, -i)] = { hit: 5, closed: 5 }; });
  h[A.shiftDate(TODAY, -4)] = { hit: 4, closed: 5 };   // the gap
  h[A.shiftDate(TODAY, -5)] = { hit: 5, closed: 5 };
  assert.equal(A.streakFrom(h, TODAY), 3);
});

test("today never counts toward the streak, hit or missed", () => {
  const h = { [TODAY]: { hit: 0, closed: 1 } };
  h[A.shiftDate(TODAY, -1)] = { hit: 1, closed: 1 };
  assert.equal(A.streakFrom(h, TODAY), 1, "a bad morning does not break yesterday");

  const h2 = { [TODAY]: { hit: 1, closed: 1 } };
  assert.equal(A.streakFrom(h2, TODAY), 0, "and a good morning does not start one");
});

test("a missing day is a gap, and an empty history is a zero streak", () => {
  const h = {};
  h[A.shiftDate(TODAY, -1)] = { hit: 1, closed: 1 };
  h[A.shiftDate(TODAY, -3)] = { hit: 1, closed: 1 };
  assert.equal(A.streakFrom(h, TODAY), 1);
  assert.equal(A.streakFrom({}, TODAY), 0);
  assert.equal(A.streakFrom(null, TODAY), 0);
});

test("a day with no closed window is not a hit", () => {
  const h = {};
  h[A.shiftDate(TODAY, -1)] = { hit: 0, closed: 0 };
  assert.equal(A.streakFrom(h, TODAY), 0);
});

test("shiftDate crosses a DST boundary without losing a day", () => {
  // US DST ends 2026-11-01. A local-midnight anchor would repeat or skip a day.
  assert.equal(A.shiftDate("2026-11-02", -1), "2026-11-01");
  assert.equal(A.shiftDate("2026-11-01", -1), "2026-10-31");
  assert.equal(A.shiftDate("2026-03-08", -1), "2026-03-07");
});

// ── normalization ──

test("a half-written row degrades to a sane daily item instead of throwing", () => {
  const d = A.normalizeDef({ id: "z", properties: { title: "  Water  ", target: "x", periodMinutes: null, activeFrom: "nope", activeDays: [9, 1, 1] } });
  assert.equal(d.title, "Water");
  assert.equal(d.target, 1);
  assert.equal(d.periodMinutes, 1440);
  assert.equal(d.activeFrom, null);
  assert.deepEqual(d.activeDays, [1, 6], "out-of-range clamps, duplicates collapse");
  assert.equal(d.status, "active");
  assert.deepEqual(d.history, {});
  assert.doesNotThrow(() => A.normalizeDef(null));
  assert.doesNotThrow(() => A.normalizeDef({}));
});

test("target and progress agree on what done means", () => {
  const d = daily();   // target 3
  assert.deepEqual(A.progressFor(d, { w: { day: 0 } }, "day"), { n: 0, target: 3, done: false, remaining: 3 });
  assert.deepEqual(A.progressFor(d, { w: { day: 3 } }, "day"), { n: 3, target: 3, done: true, remaining: 0 });
  assert.deepEqual(A.progressFor(d, { w: {} }, "day"), { n: 0, target: 3, done: false, remaining: 3 });
  assert.equal(A.countIn({ w: { day: -5 } }, "day"), 0, "a negative count reads as zero");
});

test("readEntry copies rather than aliasing the stored state", () => {
  const state = { a: { w: { day: 1 }, closed: ["x"], lastNudgeAt: "t", lastWindowKey: "day" } };
  const entry = A.readEntry(state, "a");
  entry.w.day = 99;
  entry.closed.push("y");
  assert.equal(state.a.w.day, 1, "the stored map is untouched");
  assert.deepEqual(state.a.closed, ["x"]);
  assert.deepEqual(A.readEntry({}, "missing"), A.blankEntry());
});
