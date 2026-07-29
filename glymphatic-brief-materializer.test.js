const assert = require("assert");
const { materializeBriefPlan } = require("./dcc-intelligence");

const sourceState = {
  date: "2026-06-12",
  glymphatic_brief: {
    decisions: {
      "t-accept": { action: "accept", time: "08:30" },
      "t-move": { action: "schedule", time: "10:15" },
      "t-backlog": { action: "backlog", time: null },
      "t-drop": { action: "drop", time: null },
    },
    current: {
      pages: [
        {
          id: "front",
          label: "Today + Tomorrow",
          tomorrow: [
            { id: "t-accept", title: "Accepted task", suggested_start: "08:00", duration: 30, priority: "High", project: "ops" },
            { id: "t-move", title: "Moved task", suggested_start: "09:00", duration: 45, priority: "Medium" },
            { id: "t-backlog", title: "Backlogged task", suggested_start: "11:00", duration: 15 },
            { id: "t-drop", title: "Dropped task", suggested_start: "12:00", duration: 15 },
            { id: "t-unreviewed", title: "Unreviewed task", suggested_start: "13:00", duration: 15 },
          ],
        },
      ],
    },
  },
};

const plan = materializeBriefPlan({ sourceState, targetDate: "2026-06-13", existingBlocks: [] });
assert.strictEqual(plan.items.length, 2, "only accepted/scheduled decisions materialize");
assert.strictEqual(plan.counts.pending, 2, "pending count reflects materializable items");
assert.strictEqual(plan.counts.skipped, 2, "backlog/drop are skipped");
assert.strictEqual(plan.counts.unreviewed, 1, "unreviewed item is reported");
assert.strictEqual(plan.items[0].properties.status, "pending_approval", "created blocks are staged for DCC approval");
assert.strictEqual(plan.items[0].properties.start, "08:30", "accept uses recorded/suggested time");
assert.strictEqual(plan.items[0].properties.end, "09:00", "end time is computed");
assert.strictEqual(plan.items[1].properties.start, "10:15", "schedule uses chosen time");
assert.strictEqual(plan.items[1].properties.end, "11:00", "schedule end time is computed");

const repeat = materializeBriefPlan({
  sourceState,
  targetDate: "2026-06-13",
  existingBlocks: [{ properties: { glymphatic_task_id: "t-accept" } }],
});
assert.strictEqual(repeat.items.length, 1, "existing glymphatic task is idempotently skipped");
assert.strictEqual(repeat.counts.alreadyExisting, 1, "duplicate is reported");

// A SOFT-DELETED block still suppresses re-materialization: routes/dcc.js feeds
// include-deleted rows in on purpose, so the tombstone's glymphatic_task_id lands
// in existingIds and a task the user deleted is not resurrected on the next run.
const tombstoned = materializeBriefPlan({
  sourceState,
  targetDate: "2026-06-13",
  existingBlocks: [{ deleted_at: "2026-06-13T00:00:00Z", properties: { glymphatic_task_id: "t-accept" } }],
});
assert.strictEqual(tombstoned.items.length, 1, "a soft-deleted brief block is not re-materialized");
assert.strictEqual(tombstoned.counts.alreadyExisting, 1, "the deleted task is reported alreadyExisting");

console.log("glymphatic-brief-materializer: all assertions passed");
