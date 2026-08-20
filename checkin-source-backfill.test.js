// The backfill's planner. It re-implements the client's resolution order against SQL
// rows instead of the block cache, so the risk it carries is drift: a plan that stamps
// a DIFFERENT link than the row would have shown, or one that invents a link for a
// check-in that never had an origin.
const test = require("node:test");
const assert = require("node:assert/strict");

const { waitingItemIdFor, itemSourceRef, buildBackfillPlan } = require("./scripts/backfill-checkin-source-links");

const PERMALINK = "https://cleverrealestate.slack.com/archives/C1/p1723999999000100";
const OTHER_PERMALINK = "https://cleverrealestate.slack.com/archives/C9/p1799999999000999";
const NOTES = "Delegated from Slack\n" + PERMALINK + "\n\nFrom unknown in #slack:";
const WS = "ws-1";

const checkIn = (properties, extra) => ({
  id: "blk-1",
  workspace_id: WS,
  date: "2026-08-19",
  properties: {
    source: "waiting-checkin",
    source_id: "",
    title: "Check in: Slack task",
    local_id: "waiting-checkin-task:wait-1",
    delegatedItemId: "wait-1",
    ...properties,
  },
  ...extra,
});

const item = (properties, extra) => ({
  id: "wait-1",
  workspace_id: WS,
  properties: { kind: "delegated_item", contact: { sourceRef: PERMALINK }, ...properties },
  ...extra,
});

test("the Waiting item is the first place a plan looks", () => {
  const plan = buildBackfillPlan([checkIn()], [item()]);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.unresolved, []);
  assert.deepEqual(plan.candidates, [{
    id: "blk-1", date: "2026-08-19", title: "Check in: Slack task",
    url: PERMALINK, label: "Slack", via: "waiting_item",
  }]);
});

test("an orphan falls through to its own detail prose", () => {
  // The row from the bug report: item deleted, so nothing left but the copied notes.
  const detail = "Check in\n\nWaiting on an external dependency\n\n" + NOTES;
  const plan = buildBackfillPlan([checkIn({ detail })], []);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].url, PERMALINK);
  assert.equal(plan.candidates[0].via, "detail_prose");

  const tombstoned = buildBackfillPlan([checkIn({ detail })], [item({}, { deleted_at: "2026-08-18T00:00:00Z" })]);
  assert.equal(tombstoned.candidates[0].via, "detail_prose",
    "a soft-deleted item is not resolvable, matching the client's checkInItem");
});

test("the item outranks the prose when the two disagree", () => {
  const plan = buildBackfillPlan([checkIn({ detail: "Delegated from Slack\n" + OTHER_PERMALINK })], [item()]);
  assert.equal(plan.candidates[0].url, PERMALINK);
  assert.equal(plan.candidates[0].via, "waiting_item");
});

test("a check-in with no recoverable origin is left alone, not invented", () => {
  const plan = buildBackfillPlan([checkIn({ detail: "Check in\n\nWaiting on Mike" })], []);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].id, "blk-1");
});

test("an item in another workspace is not a source for this row", () => {
  // The join happens in JS, so nothing but this composite key stops a same-id row in a
  // second tenant from supplying the link.
  const plan = buildBackfillPlan([checkIn()], [item({}, { workspace_id: "ws-2" })]);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.unresolved.length, 1);
});

test("resolution mirrors the client's field precedence on the item", () => {
  assert.equal(itemSourceRef({ contact: { sourceRef: PERMALINK }, source_id: OTHER_PERMALINK }), PERMALINK);
  assert.equal(itemSourceRef({ source_id: PERMALINK }), PERMALINK, "the flat twin when contact is absent");
  assert.equal(itemSourceRef({ notes: NOTES }), PERMALINK, "prose only once both link fields are empty");
  assert.equal(itemSourceRef({ captureNotes: NOTES }), PERMALINK);
  assert.equal(itemSourceRef({ notes: "Waiting to hear back from Matt." }), "");
  assert.equal(itemSourceRef(null), "");
});

test("the item edge reads the stamp first and the local_id suffix second", () => {
  assert.equal(waitingItemIdFor({ delegatedItemId: "wait-1", local_id: "waiting-checkin-task:other" }), "wait-1");
  assert.equal(waitingItemIdFor({ local_id: "waiting-checkin-task:wait-9" }), "wait-9",
    "the older spelling is the only edge the first reminders have");
  assert.equal(waitingItemIdFor({ local_id: "task-3" }), "");
  assert.equal(waitingItemIdFor({}), "");
});

test("a cycle key on the item resolves to no link rather than a broken href", () => {
  // waiting-items.js puts an opaque "waiting:<id>:<date>" in source_id. taskSourceUrl
  // skips it; a first-truthy read would have stamped it into an href.
  const plan = buildBackfillPlan([checkIn()], [item({ contact: { sourceRef: "" }, source_id: "waiting:wait-1:2026-08-18" })]);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.unresolved.length, 1);
});

test("rows the SELECT should never return are reported, not silently written", () => {
  const already = buildBackfillPlan([checkIn({ source_id: PERMALINK })], [item()]);
  assert.deepEqual(already.issues, [{ id: "blk-1", reason: "already_linked" }]);

  const deleted = buildBackfillPlan([checkIn({}, { deleted_at: "2026-08-19T00:00:00Z" })], [item()]);
  assert.deepEqual(deleted.issues, [{ id: "blk-1", reason: "deleted" }]);

  const wrongKind = buildBackfillPlan([checkIn({ source: "slack-bookmark" })], [item()]);
  assert.deepEqual(wrongKind.issues, [{ id: "blk-1", reason: "not_a_check_in" }]);

  for (const plan of [already, deleted, wrongKind]) assert.deepEqual(plan.candidates, []);
});
