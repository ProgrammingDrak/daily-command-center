const test = require("node:test"),
  assert = require("node:assert/strict");
const { entryMatchesEvent, actualSegmentsFor } = require("./public/js/day-review");
test("calendar corrections match identity, never another same-title task or occurrence", () => {
  const entry = {
    source: "conversation-correction",
    allocationKind: "meeting",
    calendarEventId: "occurrence-1",
    taskTitle: "Mike 1:1"
  };
  assert.equal(entryMatchesEvent(entry, { id: "ordinary-task", title: "Mike 1:1" }), false);
  assert.equal(entryMatchesEvent(entry, { source_id: "occurrence-2", title: "Mike 1:1" }), false);
  assert.equal(entryMatchesEvent(entry, { source_id: "occurrence-1", title: "Renamed meeting" }), true);
  assert.equal(
    entryMatchesEvent({ allocationKind: "unknown", taskTitle: "Unknown activity" }, { title: "Unknown activity" }),
    false
  );
  assert.equal(
    entryMatchesEvent(
      { source: "conversation-correction", allocationKind: "focused", blockId: "row-1" },
      { id: "local-1", _blockId: "row-1" }
    ),
    true
  );
});
test("a corrected-away task cannot resurrect a legacy duration", () => {
  const ctx = { timeEntries: [], sessions: { a: [{ durationMin: 50 }] } };
  assert.deepEqual(actualSegmentsFor({ id: "a", actualMinutesFrom: "reallocated" }, ctx), []);
  assert.deepEqual(actualSegmentsFor({ id: "a", actualTimeUnknown: true }, ctx), []);
  assert.equal(actualSegmentsFor({ id: "a" }, ctx)[0].durMin, 50, "unrelated legacy behavior preserved");
});

test("unknown intervals remain visible data but never inflate actual effort", () => {
  const { knownActualMinutes } = require("./public/js/day-review");
  assert.equal(
    knownActualMinutes({
      rows: [],
      extras: [
        { allocationKind: "meeting", min: 30 },
        { allocationKind: "unknown", min: 7 },
        { allocationKind: "unknown", min: 13 }
      ]
    }),
    30
  );
});
