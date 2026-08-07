const { test } = require("node:test");
const assert = require("node:assert/strict");
const { measuredTaskWindow } = require("./public/js/measured-task-window");

const TZ = { timeZone: "America/New_York" };

test("measured window floors the start and ceils the end to five minutes", () => {
  assert.deepEqual(
    measuredTaskWindow("2026-07-28T15:32:00Z", "2026-07-28T15:46:00Z", TZ),
    {
      start: "11:30", end: "11:50", durationMinutes: 20,
      roundedStartMs: Date.parse("2026-07-28T15:30:00Z"),
      roundedEndMs: Date.parse("2026-07-28T15:50:00Z"),
    }
  );
});

test("measured window leaves exact boundaries alone and expands short work to one block", () => {
  assert.equal(measuredTaskWindow("2026-07-28T15:30:00Z", "2026-07-28T15:45:00Z", TZ).durationMinutes, 15);
  assert.deepEqual(
    measuredTaskWindow("2026-07-28T15:32:00Z", "2026-07-28T15:33:00Z", TZ),
    {
      start: "11:30", end: "11:35", durationMinutes: 5,
      roundedStartMs: Date.parse("2026-07-28T15:30:00Z"),
      roundedEndMs: Date.parse("2026-07-28T15:35:00Z"),
    }
  );
});

test("measured window rejects invalid, reversed, and overnight intervals", () => {
  assert.equal(measuredTaskWindow(null, "2026-07-28T15:45:00Z", TZ), null);
  assert.equal(measuredTaskWindow("2026-07-28T15:45:00Z", "2026-07-28T15:44:00Z", TZ), null);
  assert.equal(measuredTaskWindow("2026-07-29T03:58:00Z", "2026-07-29T04:02:00Z", TZ), null);
});
