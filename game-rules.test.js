const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("./game/rules");
const C = require("./game/config");

const ms = (iso) => Date.parse(iso);

test("completion XP by priority, with app levels and game words", () => {
  assert.equal(R.completionXp({ taskPriority: "Very low" }), 5);
  assert.equal(R.completionXp({ taskPriority: "Low" }), 8);
  assert.equal(R.completionXp({ taskPriority: "Medium" }), 10);
  assert.equal(R.completionXp({ taskPriority: "High" }), 15);
  assert.equal(R.completionXp({ taskPriority: "Very high" }), 20);
  assert.equal(R.completionXp({ priority: "urgent" }), 20);
  assert.equal(R.completionXp({ priority: "normal" }), 8);
  assert.equal(R.completionXp({}), 10, "unknown priority falls back to medium");
  assert.equal(R.completionXp({ taskPriority: "High", priority: "low" }), 15, "taskPriority wins");
});

test("on-time start: inside 5 minutes either side, in America/New_York", () => {
  // 2026-11-27 is EST (UTC-5). 09:00 ET = 14:00Z.
  const base = { taskId: "t1", taskDate: "2026-11-27", start: "09:00" };
  assert.ok(R.startAward({ ...base, atMs: ms("2026-11-27T14:00:00Z") }));
  assert.ok(R.startAward({ ...base, atMs: ms("2026-11-27T14:05:00Z") }));
  assert.ok(R.startAward({ ...base, atMs: ms("2026-11-27T13:55:00Z") }));
  assert.equal(R.startAward({ ...base, atMs: ms("2026-11-27T14:05:01Z") }), null);
  assert.equal(R.startAward({ ...base, atMs: ms("2026-11-27T13:54:59Z") }), null);
  assert.equal(R.startAward({ ...base, atMs: ms("2026-11-27T14:00:00Z"), swapped: true }), null, "swap gets no start bonus");
  assert.equal(R.startAward({ ...base, start: null, atMs: ms("2026-11-27T14:00:00Z") }), null, "unscheduled task");
  const a = R.startAward({ ...base, atMs: ms("2026-11-27T14:00:00Z") });
  assert.deepEqual(a, { type: "start_on_time", points: 10, sourceKey: "start:t1", taskId: "t1" });
});

test("on-time start respects DST (July is UTC-4)", () => {
  assert.ok(R.isOnTimeStart({ taskDate: "2026-07-01", start: "09:00", atMs: ms("2026-07-01T13:00:00Z") }));
  assert.equal(R.isOnTimeStart({ taskDate: "2026-07-01", start: "09:00", atMs: ms("2026-07-01T14:00:00Z") }), false);
});

test("completion awards: plain, Big 3, Perfect Day, never negative", () => {
  const plain = R.completionAwards({ taskId: "a", taskDate: "2026-11-27", props: { taskPriority: "High" } });
  assert.deepEqual(plain.map((x) => [x.type, x.points]), [["complete", 15]]);

  const big3Ids = ["a", "b", "c"];
  const partial = R.completionAwards({ taskId: "a", taskDate: "2026-11-27", props: {}, big3Ids, doneIds: new Set(["a"]) });
  assert.deepEqual(partial.map((x) => [x.type, x.points]), [["complete", 10], ["big3_complete", 10]]);

  const last = R.completionAwards({ taskId: "c", taskDate: "2026-11-27", props: {}, big3Ids, doneIds: new Set(big3Ids) });
  assert.deepEqual(last.map((x) => [x.type, x.points]), [["complete", 10], ["big3_complete", 10], ["perfect_day", 25]]);
  assert.equal(last.find((x) => x.type === "perfect_day").sourceKey, "perfect:2026-11-27");

  const focus = R.completionAwards({ taskId: "z", taskDate: "2026-11-27", props: {}, inFocus: true });
  assert.deepEqual(focus.map((x) => x.type), ["complete", "focus_complete"]);

  for (const award of [...plain, ...partial, ...last, ...focus]) assert.ok(award.points > 0);
  for (const v of Object.values(C.XP.COMPLETE)) assert.ok(v >= 0);
});

test("reopen voids completion, Big 3 and Perfect Day keys", () => {
  assert.deepEqual(R.reopenVoidKeys({ taskId: "x", taskDate: "2026-11-27" }), ["complete:x", "focus:x"]);
  assert.deepEqual(R.reopenVoidKeys({ taskId: "a", taskDate: "2026-11-27", big3Ids: ["a"] }),
    ["complete:a", "focus:a", "big3:a:2026-11-27", "perfect:2026-11-27"]);
});

test("day counts: all Big 3 done OR minimum day checked", () => {
  assert.equal(R.dayCounts({ big3Ids: ["a", "b"], doneIds: new Set(["a", "b"]) }), true);
  assert.equal(R.dayCounts({ big3Ids: ["a", "b"], doneIds: new Set(["a"]) }), false);
  assert.equal(R.dayCounts({ big3Ids: ["a", "b"], doneIds: new Set(["a"]), minimumDayDone: true }), true);
  assert.equal(R.dayCounts({ big3Ids: [], doneIds: new Set() }), false, "no intentions → day missed");
});

test("week start is Monday; lives refill on Monday", () => {
  assert.equal(R.weekStart("2026-11-27"), "2026-11-23"); // Friday → Monday
  assert.equal(R.weekStart("2026-11-23"), "2026-11-23"); // Monday
  assert.equal(R.weekStart("2026-11-29"), "2026-11-23"); // Sunday belongs to previous Monday
  assert.equal(R.weekStart("2026-11-30"), "2026-11-30");
});

function run(dates) {
  let s = R.freshStreak();
  const outcomes = [];
  for (const [date, counted] of dates) {
    const r = R.closeDay(s, date, counted);
    s = r.state;
    outcomes.push(r.outcome);
  }
  return { s, outcomes };
}

test("streak: missed days use lives, reset only at 0 lives", () => {
  const { s, outcomes } = run([
    ["2026-11-23", true],  // Mon
    ["2026-11-24", true],
    ["2026-11-25", false], // life 2→1
    ["2026-11-26", false], // life 1→0
    ["2026-11-27", true],  // streak continues
    ["2026-11-28", false], // 0 lives → reset
    ["2026-11-29", true],
  ]);
  assert.deepEqual(outcomes, ["counted", "counted", "life_used", "life_used", "counted", "reset", "counted"]);
  assert.equal(s.currentStreak, 1);
  assert.equal(s.bestStreak, 3);
  assert.equal(s.livesLeft, 0);
});

test("lives refill Monday: a miss on Monday after a lifeless Sunday does not reset", () => {
  const { s, outcomes } = run([
    ["2026-11-25", true],
    ["2026-11-26", false],
    ["2026-11-27", false],
    ["2026-11-28", true],
    ["2026-11-29", true],  // Sunday, 0 lives
    ["2026-11-30", false], // Monday: refill to 2, then use 1
  ]);
  assert.deepEqual(outcomes, ["counted", "life_used", "life_used", "counted", "counted", "life_used"]);
  assert.equal(s.currentStreak, 3);
  assert.equal(s.livesLeft, 1);
  assert.equal(s.livesWeekStart, "2026-11-30");
});

test("livesToday shows a full refill on a new week before any close runs", () => {
  const s = { ...R.freshStreak(), livesLeft: 0, livesWeekStart: "2026-11-23" };
  assert.equal(R.livesToday(s, "2026-11-29"), 0);
  assert.equal(R.livesToday(s, "2026-11-30"), C.STREAK.LIVES_PER_WEEK);
});

test("closeDay is idempotent: closing the same day twice changes nothing", () => {
  const a = R.closeDay(R.freshStreak(), "2026-11-27", true);
  const b = R.closeDay(a.state, "2026-11-27", true);
  assert.equal(b.outcome, "already_closed");
  assert.deepEqual(b.state, a.state);
  const older = R.closeDay(a.state, "2026-11-20", false);
  assert.equal(older.outcome, "already_closed");
});

test("datesToClose rolls over day by day and never includes today", () => {
  assert.deepEqual(R.datesToClose({ lastClosedDate: "2026-11-24", firstDate: "2026-11-20", today: "2026-11-27" }),
    ["2026-11-25", "2026-11-26"]);
  assert.deepEqual(R.datesToClose({ lastClosedDate: null, firstDate: "2026-11-26", today: "2026-11-27" }), ["2026-11-26"]);
  assert.deepEqual(R.datesToClose({ lastClosedDate: "2026-11-26", firstDate: "2026-11-01", today: "2026-11-27" }), []);
  assert.deepEqual(R.datesToClose({ lastClosedDate: null, firstDate: null, today: "2026-11-27" }), []);
  // Month and year rollover.
  assert.deepEqual(R.datesToClose({ lastClosedDate: "2026-12-30", firstDate: null, today: "2027-01-02" }),
    ["2026-12-31", "2027-01-01"]);
});

test("local date rolls over at midnight New York, not UTC", () => {
  assert.equal(R.localDate(ms("2026-11-28T04:59:00Z")), "2026-11-27");
  assert.equal(R.localDate(ms("2026-11-28T05:00:00Z")), "2026-11-28");
  assert.equal(new Date(R.zonedMidnightMs("2026-11-30")).toISOString(), "2026-11-30T05:00:00.000Z");
  assert.equal(new Date(R.zonedMidnightMs("2026-03-08")).toISOString(), "2026-03-08T05:00:00.000Z"); // DST day
  assert.equal(new Date(R.zonedMidnightMs("2026-03-09")).toISOString(), "2026-03-09T04:00:00.000Z");
});

test("tiers by week XP", () => {
  assert.equal(R.tierFor(0).id, "bronze");
  assert.equal(R.tierFor(199).next.xpToGo, 1);
  assert.equal(R.tierFor(200).id, "silver");
  assert.equal(R.tierFor(5000).id, "diamond");
  assert.equal(R.tierFor(5000).next, null);
});
