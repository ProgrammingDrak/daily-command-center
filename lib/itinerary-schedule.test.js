const { test } = require("node:test");
const assert = require("node:assert/strict");
const { placement, interval } = require("./itinerary-schedule");

test("Tokyo schedule preserves instants and projects to the established storage zone", () => {
  const slot = placement(
    { date: "2026-11-16", start: "21:03", end: "22:28", timeZone: "Asia/Tokyo" },
    "America/New_York"
  );
  assert.equal(slot.date, "2026-11-16");
  assert.equal(slot.properties.start, "07:03");
  assert.equal(slot.properties.duration, 85);
  assert.equal(slot.properties.scheduleInstant.startAt, "2026-11-16T12:03:00.000Z");
  assert.equal(slot.properties.scheduleInstant.endAt, "2026-11-16T13:28:00.000Z");
  assert.equal(slot.properties.scheduleInstant.zone, "Asia/Tokyo");
  assert.deepEqual(interval(slot, "America/New_York"), { start: slot.startMs, end: slot.endMs, fixed: true });
});

test("DST gaps are rejected and repeated wall times require an offset", () => {
  const input = { date: "2026-03-08", start: "02:30", end: "04:00", timeZone: "America/New_York" };
  assert.throws(() => placement(input, "UTC"), /does not exist/);
  const repeated = { ...input, date: "2026-11-01", start: "01:30", end: "02:30" };
  assert.throws(() => placement(repeated, "UTC"), /repeats/);
  assert.throws(() => placement({ ...repeated, startOffset: "-03:00" }, "UTC"), /does not match/);
  assert.equal(placement({ ...repeated, startOffset: "-04:00" }, "UTC").properties.duration, 120);
  assert.equal(placement({ ...repeated, startOffset: "-05:00" }, "UTC").properties.duration, 60);
});
