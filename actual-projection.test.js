// Actual-time evidence for the List and Calendar Actual toggle.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./public/js/actual-projection.js");

const DATE = "2026-11-02";
const entry = (id, props) => ({ id, type: "time_entry", date: DATE, properties: props });

test("only readable, non-estimated starts are positioned", () => {
  assert.deepEqual(A.entryPosition({ start: "09:15", durSec: 1800 }, DATE), { startMin: 555, durMin: 30, positioned: true, reason: null });
  assert.equal(A.entryPosition({ start: "2026-11-02T10:00:00", durSec: 600 }, DATE).startMin, 600);
  assert.equal(A.entryPosition({ startedAt: "2026-11-02T15:00:00.000Z", durSec: 600 }, DATE, { timeZone: "America/New_York" }).startMin, 600);
  assert.equal(A.entryPosition({ durSec: 600 }, DATE).reason, "no-start");
  assert.equal(A.entryPosition({ start: "09:00", durSec: 600, estimated: true }, DATE).reason, "estimated");
  assert.equal(A.entryPosition({ start: "09:00", durSec: 600, inferred: true }, DATE).reason, "estimated");
  assert.equal(A.entryPosition({ start: "2026-11-01T23:00:00", durSec: 600 }, DATE).reason, "other-day");
  assert.equal(A.entryPosition({ start: "09:00", durSec: "Infinity" }, DATE).reason, "no-length");
});

test("every evidence class is distinguished per task", () => {
  const events = [
    { id: "a", title: "Write brief" },
    { id: "b", title: "Call vendor", actualTimeUnknown: true },
    { id: "c", title: "Moved work", actualMinutesFrom: "reallocated" },
    { id: "d", title: "Nothing yet" },
    { id: "e", title: "Old session" },
    { id: "local-f", _blockId: "row-f", title: "Queue task" }
  ];
  const entries = [
    entry("t1", { blockId: "a", start: "09:00", durSec: 1500, source: "manual" }),
    entry("t2", { blockId: "a", durSec: 600, source: "manual" }),
    entry("t3", { blockId: "row-f", startedAt: "2026-11-02T14:00:00.000Z", start: "09:00", durSec: 1200, source: "work-session", estimated: true }),
    entry("t4", { taskTitle: "Coffee chat", durSec: 900 }),
    entry("t5", { allocationKind: "unknown", taskTitle: "Unknown activity", durSec: 420 })
  ];
  const day = A.projectDay(events, entries, { date: DATE, sessions: { e: [{ start: "08:00", durationMin: 15 }] } });
  const a = day.byId.get("a");
  assert.equal(a.status, "recorded");
  assert.equal(a.knownMin, 35);
  assert.deepEqual(a.positioned.map((s) => [s.startMin, s.endMin]), [[540, 565]]);
  assert.equal(a.unpositionedMin, 10);
  assert.equal(day.byId.get("b").status, "unknown");
  assert.equal(day.byId.get("c").status, "reallocated");
  assert.equal(day.byId.get("d").status, "none");
  const legacy = day.byId.get("e");
  assert.equal(legacy.positioned.length, 0, "legacy sessions are never plotted");
  assert.equal(legacy.unpositionedMin, 15);
  const f = day.byId.get("local-f");
  assert.equal(f.positioned.length, 0, "an estimated work session is minutes only");
  assert.equal(f.unpositionedMin, 20);
  assert.deepEqual(day.extras.unmatched.map((x) => [x.title, x.min]), [["Coffee chat", 15]]);
  assert.equal(day.extras.unknownMin, 7);
  assert.equal(day.knownMin, 35 + 15 + 20 + 15, "unknown allocation is excluded from known minutes");
});

test("time entries override unknown markers and are never counted twice", () => {
  const events = [{ id: "x", title: "Same title" }, { id: "y", title: "Same title" }, { id: "z", title: "Flagged", actualTimeUnknown: true }];
  const entries = [entry("t1", { taskTitle: "Same title", start: "10:00", durSec: 600 }), entry("t2", { blockId: "z", start: "11:00", durSec: 300 })];
  const day = A.projectDay(events, entries, { date: DATE });
  assert.equal(day.byId.get("x").knownMin, 10);
  assert.equal(day.byId.get("y").knownMin, 0);
  assert.equal(day.byId.get("z").status, "recorded");
  assert.equal(day.knownMin, 15);
});

test("list presentation states the evidence in plain words", () => {
  const day = A.projectDay(
    [{ id: "a", title: "A" }, { id: "b", title: "B", actualTimeUnknown: true }, { id: "c", title: "C" }, { id: "d", title: "D", actualMinutesFrom: "reallocated" }],
    [entry("t1", { blockId: "a", start: "09:00", durSec: 1800 }), entry("t2", { blockId: "a", start: "13:00", durSec: 900 }), entry("t3", { blockId: "a", durSec: 300 })],
    { date: DATE }
  );
  assert.deepEqual(A.describeTask(day.byId.get("a")), { tone: "recorded", text: "Actual 50m · 9:00 AM to 1:15 PM · 2 segments · 5m without a clock time" });
  assert.deepEqual(A.describeTask(day.byId.get("b")), { tone: "unknown", text: "Actual time unknown" });
  assert.deepEqual(A.describeTask(day.byId.get("c")), { tone: "none", text: "No recorded actual" });
  assert.deepEqual(A.describeTask(day.byId.get("d")), { tone: "unknown", text: "Time moved to other work" });
  assert.deepEqual(A.describeDay(day).map((x) => x.key), ["known", "unplaced"]);
});

test("calendar presentation plots recorded segments only and totals the rest", () => {
  const day = A.projectDay(
    [{ id: "a", title: "A", start: "08:00", end: "12:00" }, { id: "b", title: "B", start: "13:00", end: "14:00" }],
    [
      entry("t1", { blockId: "a", start: "09:30", durSec: 1200 }),
      entry("t2", { blockId: "b", durSec: 1800 }),
      entry("t3", { taskTitle: "Walk-in", start: "15:00", durSec: 600 }),
      entry("t4", { allocationKind: "unknown", durSec: 300 })
    ],
    { date: DATE }
  );
  const layer = A.calendarLayer(day);
  assert.deepEqual(layer.segments.map((s) => [s.taskId, s.startMin, s.endMin]), [["a", 570, 590]]);
  assert.equal(layer.segments[0].entryId, "t1", "segments keep their entry for move/split");
  assert.equal(layer.unplacedMin, 30, "B is not drawn at its planned 13:00");
  assert.equal(layer.unplannedMin, 10);
  assert.equal(layer.unknownMin, 5);
});

test("explicit identity wins over an earlier same-title task; stale identity stays unmatched", () => {
  const events = [{ id: "a", title: "Same title" }, { id: "b", title: "Same title" }, { id: "c", _blockId: "row-c", title: "Row keyed" }, { id: "m", title: "Standup", source_id: "cal-1" }];
  const day = A.projectDay(events, [
    entry("t1", { blockId: "b", taskTitle: "Same title", start: "09:00", durSec: 600 }),
    entry("t2", { blockId: "row-c", taskTitle: "Same title", start: "10:00", durSec: 300 }),
    entry("t3", { blockId: "deleted-row", taskTitle: "Same title", start: "11:00", durSec: 900 }),
    entry("t4", { calendarEventId: "cal-gone", taskTitle: "Standup", durSec: 120 }),
    entry("t5", { calendarEventId: "cal-1", taskTitle: "Something else", durSec: 60 }),
    entry("t6", { taskTitle: "Same title", durSec: 240 })
  ], { date: DATE });
  assert.equal(day.byId.get("a").knownMin, 4, "title fallback only for the entry with no identity");
  assert.equal(day.byId.get("b").knownMin, 10);
  assert.equal(day.byId.get("c").knownMin, 5, "row-id identity resolves to its task");
  assert.equal(day.byId.get("m").knownMin, 1);
  const unmatched = day.extras.unmatched.map((x) => [x.key, x.min]).sort((x, y) => x[0].localeCompare(y[0]));
  assert.deepEqual(unmatched, [["cal-gone", 2], ["deleted-row", 15]], "a stale identity is not re-matched by title");
});

test("ISO instants use the application time zone, not the device zone, including near midnight", () => {
  assert.equal(A.appTimeZone(), "America/New_York");
  assert.equal(A.appTimeZone({ timeZone: "Europe/London" }), "Europe/London");
  // 03:30 UTC on Nov 3 is 10:30 PM on Nov 2 in New York (EST).
  const late = { startedAt: "2026-11-03T03:30:00.000Z", durSec: 1200 };
  assert.deepEqual(A.entryPosition(late, "2026-11-02"), { startMin: 22 * 60 + 30, durMin: 20, positioned: true, reason: null });
  assert.equal(A.entryPosition(late, "2026-11-03").reason, "other-day");
  // 04:50 UTC on Nov 2 is 11:50 PM on Nov 1 in New York; a UTC reading would place it on Nov 2.
  assert.equal(A.entryPosition({ startedAt: "2026-11-02T04:50:00.000Z", durSec: 600 }, "2026-11-02").reason, "other-day");
  assert.equal(A.entryPosition({ startedAt: "2026-11-02T05:10:00.000Z", durSec: 600 }, "2026-11-02").startMin, 10, "00:10 in New York");
  // List and Calendar read the same entry identically.
  const ev = [{ id: "x", title: "X" }];
  const entries = [entry("t", { blockId: "x", startedAt: "2026-11-02T14:15:00.000Z", durSec: 900 })];
  const list = A.describeTask(A.projectDay(ev, entries, { date: DATE }).byId.get("x"));
  const calendar = A.calendarLayer(A.projectDay(ev, entries, { date: DATE, timeZone: A.appTimeZone() }));
  assert.equal(list.text, "Actual 15m · 9:15 AM to 9:30 AM");
  assert.equal(calendar.segments[0].startMin, 9 * 60 + 15);
});

test("the matching rule is Day Review's", () => {
  const { entryMatchesEvent } = require("./public/js/day-review.js");
  const props = { calendarEventId: "cal-1", durSec: 60, start: "09:00" };
  const ev = { id: "m", title: "Standup", source_id: "cal-1" };
  assert.equal(entryMatchesEvent(props, ev), true);
  assert.equal(A.projectDay([ev], [entry("t", props)], { date: DATE }).byId.get("m").knownMin, 1);
});
