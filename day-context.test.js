const test = require("node:test");
const assert = require("node:assert/strict");

const { findSlot, buildDayContext } = require("./public/js/day-context");

// day-context.js unified the four copy-pasted free-slot pipelines
// (schedulePushedOnDate / _scheduleTaskOnDate / _computeRescheduleSlot /
// _schedDayTasks) onto ONE earliest-free algorithm + ONE day-context builder.
// These tests pin the canonical rule set those call sites now share, so a future
// edit that reintroduces the drift (ooo/break ignored, no anchor-to-now, 08:00
// fallback) fails here.

// A block as /api/blocks returns it.
function block(type, start, end, localId, deletedAt) {
  return { type, deleted_at: deletedAt || null, properties: { start, end, local_id: localId } };
}
// A day-state with a timeline (ooo/break pseudo-blocks) + work-hour blocks.
function state(timeline, blocks) {
  return { schedule: { timeline: timeline || [], blocks: blocks || [] } };
}
const WORKDAY = [{ start: "07:00", end: "17:30" }]; // sets day bounds 07:00-17:30
const OTHER_DAY = "2026-07-15"; // the day we place onto
// Every non-anchor test injects this as todayStr. It differs from OTHER_DAY, so
// anchor-to-now can NEVER fire regardless of the machine clock the suite runs on
// (without it, findSlot would fall back to the real wall clock and the suite
// would flip only on 2026-07-15 — a one-day-a-year time bomb).
const OFF = { todayStr: "2026-07-10" };

// ── buildDayContext ──────────────────────────────────────────────────────

test("buildDayContext pulls ooo/break as meetings and ignores other timeline types", () => {
  const ctx = buildDayContext(
    OTHER_DAY,
    state(
      [
        { type: "ooo", start: "09:00", end: "10:00" },
        { type: "break", start: "12:00", end: "12:30" },
        { type: "meeting", start: "14:00", end: "15:00", title: "Standup" },
      ],
      WORKDAY
    ),
    []
  );
  assert.deepEqual(ctx.meetings, [
    { s: 540, e: 600 },
    { s: 720, e: 750 },
  ]);
});

test("buildDayContext sorts meetings by start", () => {
  const ctx = buildDayContext(
    OTHER_DAY,
    state([
      { type: "break", start: "12:00", end: "12:30" },
      { type: "ooo", start: "09:00", end: "10:00" },
    ]),
    []
  );
  assert.deepEqual(ctx.meetings.map((m) => m.s), [540, 720]);
});

test("buildDayContext takes day bounds from the first/last schedule block", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], [{ start: "08:15", end: "09:00" }, { start: "16:00", end: "18:45" }]), []);
  assert.equal(ctx.dayStart, 8 * 60 + 15);
  assert.equal(ctx.dayEnd, 18 * 60 + 45);
});

test("buildDayContext falls back to 07:00-17:30 when the day has no plan", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], []), []);
  assert.equal(ctx.dayStart, 7 * 60);
  assert.equal(ctx.dayEnd, 17 * 60 + 30);
});

test("buildDayContext tolerates a null state and non-array blocks", () => {
  const ctx = buildDayContext(OTHER_DAY, null, null);
  assert.equal(ctx.state, null);
  assert.deepEqual(ctx.blocks, []);
  assert.deepEqual(ctx.meetings, []);
  assert.equal(ctx.dayStart, 7 * 60);
});

// ── findSlot: basic placement ────────────────────────────────────────────

test("findSlot places at day start on an empty day", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, OFF);
  assert.deepEqual(slot, { start: "07:00", end: "07:30", duration: 30 });
});

test("findSlot slides past an existing task block", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [block("block", "07:00", "08:00", "a")]);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, OFF);
  assert.equal(slot.start, "08:00");
});

test("findSlot slides past an ooo/break meeting (the _scheduleTaskOnDate drift fix)", () => {
  // Old _scheduleTaskOnDate ignored ooo/break and would slot AT 07:00, on top of
  // the out-of-office. Canonical: ooo/break always block.
  const ctx = buildDayContext(
    OTHER_DAY,
    state([{ type: "ooo", start: "07:00", end: "09:00" }], WORKDAY),
    []
  );
  const slot = findSlot({ id: "t1", durMin: 45 }, ctx, OFF);
  assert.equal(slot.start, "09:00");
});

test("findSlot fills the gap between two blockers when the task fits", () => {
  const ctx = buildDayContext(OTHER_DAY, state([{ type: "break", start: "10:00", end: "11:00" }], WORKDAY), [
    block("block", "07:00", "09:30", "a"),
  ]);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, OFF);
  assert.equal(slot.start, "09:30"); // 09:30-10:00 fits before the 10:00 break
  assert.equal(slot.end, "10:00");
});

test("findSlot derives duration from start/end when no durMin/duration", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  const slot = findSlot({ id: "t1", start: "00:00", end: "01:00" }, ctx, OFF);
  assert.equal(slot.duration, 60);
  assert.equal(slot.end, "08:00");
});

// ── findSlot: duration precedence + zero-coercion ────────────────────────

test("findSlot defaults an absent duration to 30", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  assert.equal(findSlot({ id: "t1" }, ctx, OFF).duration, 30);
});

test("findSlot coerces a zero durMin up to 30 (the || 30 guard)", () => {
  // A task can't occupy 0 minutes; a regression to `return ev.durMin` (no || 30)
  // would produce a zero-length slot.
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  assert.equal(findSlot({ id: "t1", durMin: 0 }, ctx, OFF).duration, 30);
});

test("findSlot honors duration > durMin > start/end precedence", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  assert.equal(findSlot({ id: "t1", duration: 45, durMin: 15 }, ctx, OFF).duration, 45);
  assert.equal(findSlot({ id: "t1", durMin: 15, start: "00:00", end: "02:00" }, ctx, OFF).duration, 15);
});

// ── findSlot: no-room ────────────────────────────────────────────────────

test("findSlot returns null when the task would run >60min past dayEnd", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], [{ start: "07:00", end: "08:00" }]), [
    block("block", "07:00", "08:30", "a"),
  ]);
  // dayEnd=08:00, grace to 09:00. A 90-min task from 08:30 ends 10:00 > 09:00.
  const slot = findSlot({ id: "t1", durMin: 90 }, ctx, OFF);
  assert.equal(slot, null);
});

test("findSlot allows a task to run up to 60min past dayEnd", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], [{ start: "07:00", end: "08:00" }]), []);
  // dayEnd=08:00; a 60-min task from 07:00 ends 08:00 (well within grace).
  const slot = findSlot({ id: "t1", durMin: 60 }, ctx, OFF);
  assert.deepEqual(slot, { start: "07:00", end: "08:00", duration: 60 });
});

// ── findSlot: blocker filter (the double-book guards) ─────────────────────

test("findSlot ignores a soft-deleted block (deleted_at set)", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [
    block("block", "07:00", "09:00", "a", "2026-07-01"),
  ]);
  // A deleted block must NOT block the slot, so the task reclaims 07:00.
  assert.equal(findSlot({ id: "t1", durMin: 30 }, ctx, OFF).start, "07:00");
});

test("findSlot ignores a non-blocker block type", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [
    block("note", "07:00", "09:00", "a"), // not added_task/schedule_item/block
  ]);
  assert.equal(findSlot({ id: "t1", durMin: 30 }, ctx, OFF).start, "07:00");
});

test("findSlot counts schedule_item and added_task rows as blockers", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [
    block("schedule_item", "07:00", "08:00", "a"),
    block("added_task", "08:00", "09:00", "b"),
  ]);
  assert.equal(findSlot({ id: "t1", durMin: 30 }, ctx, OFF).start, "09:00");
});

// ── findSlot: excludeSelf ────────────────────────────────────────────────

test("findSlot with excludeSelf drops ev's own block so a re-slot ignores it", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [block("block", "07:00", "09:00", "self")]);
  // Without excludeSelf the task's own block pushes it to 09:00...
  assert.equal(findSlot({ id: "self", durMin: 30 }, ctx, OFF).start, "09:00");
  // ...with excludeSelf it can reclaim its current position at 07:00.
  assert.equal(findSlot({ id: "self", durMin: 30 }, ctx, { ...OFF, excludeSelf: true }).start, "07:00");
});

test("findSlot excludeSelf only drops the matching local_id, not other blocks", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), [
    block("block", "07:00", "09:00", "other"),
    block("block", "09:00", "09:30", "self"),
  ]);
  // "self" is dropped (else it'd push to 09:30) but "other" still blocks 07:00-09:00.
  const slot = findSlot({ id: "self", durMin: 30 }, ctx, { ...OFF, excludeSelf: true });
  assert.equal(slot.start, "09:00");
});

// ── findSlot: anchor-to-now ──────────────────────────────────────────────

test("findSlot anchors to the next quarter-hour when placing on today", () => {
  const ctx = buildDayContext("2026-07-10", state([], WORKDAY), []);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, {
    todayStr: "2026-07-10",
    nowMinutes: 9 * 60 + 7, // 09:07 -> rounds up to 09:15
  });
  assert.equal(slot.start, "09:15");
});

test("findSlot does NOT anchor to now when the target day is not today", () => {
  const ctx = buildDayContext(OTHER_DAY, state([], WORKDAY), []);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, {
    todayStr: "2026-07-10",
    nowMinutes: 14 * 60,
  });
  assert.equal(slot.start, "07:00");
});

test("findSlot anchorNow:false ignores the clock even on today", () => {
  const ctx = buildDayContext("2026-07-10", state([], WORKDAY), []);
  const slot = findSlot({ id: "t1", durMin: 30 }, ctx, {
    anchorNow: false,
    todayStr: "2026-07-10",
    nowMinutes: 14 * 60,
  });
  assert.equal(slot.start, "07:00");
});

test("findSlot returns null for a missing context", () => {
  assert.equal(findSlot({ id: "t1", durMin: 30 }, null, OFF), null);
});

// ── the preview == landed guarantee ──────────────────────────────────────

test("the create path and the reschedule path land the same slot", () => {
  // The whole point of the unification: schedulePushedOnDate (create, no
  // excludeSelf) and _computeRescheduleSlot (reschedule, excludeSelf) read one
  // ctx through one findSlot, so for a task that is not its own blocker they must
  // agree. Different opts, same result.
  const ctx = buildDayContext(
    OTHER_DAY,
    state([{ type: "break", start: "12:00", end: "13:00" }], WORKDAY),
    [block("block", "07:00", "11:00", "someone-else")]
  );
  const ev = { id: "t1", durMin: 90 };
  const createSlot = findSlot(ev, ctx, { ...OFF, anchorNow: true });
  const reschedSlot = findSlot(ev, ctx, { ...OFF, anchorNow: true, excludeSelf: true });
  assert.deepEqual(createSlot, reschedSlot);
  assert.equal(createSlot.start, "13:00"); // 11:00-12:00 too short for 90min; lands after the break
});
