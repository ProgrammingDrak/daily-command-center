const test = require("node:test");
const assert = require("node:assert/strict");

const { taskCommonProps, taskBlockProps } = require("./public/js/task-serialize");

// This module exists to stop the field-drift the six hand-built task-property
// bags had accumulated, so these tests pin the exact defaulting/reconciliation
// contract the call sites now depend on. A future edit that reintroduces the
// drift should fail here.

test("taskCommonProps applies canonical defaults for an empty task", () => {
  const c = taskCommonProps({}, {});
  assert.equal(c.title, "");
  assert.equal(c.priority, "High");
  assert.equal(c.meta, "");
  assert.equal(c.detail, "");
  assert.equal(c.notionUrl, "");
  assert.equal(c.source, "manual");
  assert.deepEqual(c.tags, []);
  assert.equal(c.delegatedItemId, null);
  assert.equal(c.linkedBlockId, null);
  assert.equal(c.linkedTagId, null);
  assert.equal(c.commuteMinutes, null);
  assert.equal(c.commuteToMinutes, null);
  assert.equal(c.commuteBackMinutes, null);
});

test("overrides win over ev before defaulting (priority Medium beats the High default)", () => {
  const c = taskCommonProps({ priority: null, source: null }, { priority: "Medium", source: "moved" });
  assert.equal(c.priority, "Medium");
  assert.equal(c.source, "moved");
});

test("delegated/linked fields are preserved (the _scheduleTaskOnDate drift fix)", () => {
  const c = taskCommonProps({ delegatedItemId: "D1", linkedBlockId: "LB1", linkedTagId: "LT1" });
  assert.equal(c.delegatedItemId, "D1");
  assert.equal(c.linkedBlockId, "LB1");
  assert.equal(c.linkedTagId, "LT1");
});

test("commute reconciles in both directions across aliases", () => {
  // to-direction falls back to the single commuteMinutes; back-direction reads
  // the return aliases.
  const a = taskCommonProps({ commuteMinutes: 20, commuteReturnMinutes: 15 });
  assert.equal(a.commuteMinutes, 20);
  assert.equal(a.commuteToMinutes, 20);
  assert.equal(a.commuteBackMinutes, 15);

  const b = taskCommonProps({ commute_minutes: 10, commute_back_minutes: 5 });
  assert.equal(b.commuteMinutes, 10);
  assert.equal(b.commuteToMinutes, 10);
  assert.equal(b.commuteBackMinutes, 5);

  const c = taskCommonProps({ commuteToMinutes: 30, commute_return_minutes: 12 });
  assert.equal(c.commuteToMinutes, 30);
  assert.equal(c.commuteBackMinutes, 12);
});

test("tags coerces non-array input to []", () => {
  assert.deepEqual(taskCommonProps({ tags: "nope" }).tags, []);
  assert.deepEqual(taskCommonProps({ tags: ["a", "b"] }).tags, ["a", "b"]);
});

test("taskBlockProps preserves duration 0 (checklist subtask), not null", () => {
  assert.equal(taskBlockProps({ duration: 0 }).duration, 0);
  assert.equal(taskBlockProps({ durMin: 0 }).duration, 0);
  assert.equal(taskBlockProps({}).duration, null);
});

test("taskBlockProps maps local_id and duration with id/durMin fallbacks", () => {
  const b = taskBlockProps({ id: "evid", durMin: 45, start: "09:00", end: "09:45" });
  assert.equal(b.local_id, "evid");
  assert.equal(b.duration, 45);
  assert.equal(b.start, "09:00");
  assert.equal(b.end, "09:45");

  // explicit overrides win over the ev's id/durMin
  const o = taskBlockProps({ id: "evid", durMin: 45 }, { local_id: "L", duration: 30 });
  assert.equal(o.local_id, "L");
  assert.equal(o.duration, 30);
});

test("taskBlockProps carries the shared value fields through", () => {
  const b = taskBlockProps({ title: "T", priority: "Low", delegatedItemId: "D", tags: ["x"] }, { local_id: "id", duration: 15, start: "10:00", end: "10:15" });
  assert.equal(b.title, "T");
  assert.equal(b.priority, "Low");
  assert.equal(b.delegatedItemId, "D");
  assert.deepEqual(b.tags, ["x"]);
});
