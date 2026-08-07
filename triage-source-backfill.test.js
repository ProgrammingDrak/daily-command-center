const test = require("node:test");
const assert = require("node:assert/strict");

const { buildBackfillPlan } = require("./scripts/backfill-triage-source-links");

const ID = "block-1";
const SLACK = "https://cleverrealestate.slack.com/archives/C1/p123";
const row = (properties, item) => ({
  id: ID,
  properties: { source: "triage", triageId: "slack:1", ...properties },
  state_json: { triage: { open_items: item === undefined ? [{ id: "slack:1", source_ref: SLACK }] : item } },
});

test("plans one allowlisted update from the original triage source_ref", () => {
  const plan = buildBackfillPlan([row({})], [ID]);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(plan.candidates[0], { id: ID, triageId: "slack:1", url: SLACK, label: "Slack" });
});

test("is idempotent when the correct source_id is already present", () => {
  const plan = buildBackfillPlan([row({ source_id: SLACK })], [ID]);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.alreadyCorrect.length, 1);
  assert.deepEqual(plan.issues, []);
});

test("preserves an allowlisted row the user has since deleted", () => {
  const plan = buildBackfillPlan([{ ...row({}), deleted_at: "2026-08-07T19:50:00Z" }], [ID]);
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(plan.skipped, [{ id: ID, reason: "deleted" }]);
  assert.deepEqual(plan.issues, []);
});

test("refuses conflicts, missing source records and unsafe URLs", () => {
  const conflict = buildBackfillPlan([row({ source_id: "https://example.com/wrong" })], [ID]);
  assert.equal(conflict.issues[0].reason, "source_id_conflict");

  const missing = buildBackfillPlan([row({}, [])], [ID]);
  assert.equal(missing.issues[0].reason, "source_item_missing");

  const unsafe = buildBackfillPlan([row({}, [{ id: "slack:1", source_ref: "javascript:alert(1)" }])], [ID]);
  assert.equal(unsafe.issues[0].reason, "valid_source_url_missing");
});

test("refuses to widen beyond the explicit block allowlist", () => {
  const plan = buildBackfillPlan([{ ...row({}), id: "unexpected" }], [ID]);
  assert.deepEqual(plan.issues.map((issue) => issue.reason).sort(), ["allowlisted_block_missing", "not_allowlisted"]);
  assert.equal(plan.candidates.length, 0);
});
