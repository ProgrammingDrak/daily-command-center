// The purge script's decision logic, tested without a database.
//
// These three pure functions decide WHAT gets destroyed, so they are the part worth
// pinning: an over-broad pruneState would strip a live page out of every stored packet,
// and a wrong isCompleted would either skip a real credit claw-back or try to revoke
// one that was never banked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { pruneState, dropPage, isCompleted, creditKey, ymd, MATCH_SQL } = require("./scripts/purge-day-review-rows");

const briefState = (brief) => ({ date: "2026-08-19", glymphatic_brief: brief });

test("pruneState drops the day-review page and leaves every other page alone", () => {
  const state = briefState({
    current: { pages: [
      { id: "day-review", items: [{ id: "dr-abc" }] },
      { id: "canvas", canvas_html: "<p>keep me</p>" },
      { id: "front", tasks: [{ id: "t1" }] },
    ] },
  });
  const removed = pruneState(state);
  assert.deepEqual(removed, { pages: 1, context_pages: 0, decisions: 0, log: 0 });
  assert.deepEqual(state.glymphatic_brief.current.pages.map((p) => p.id), ["canvas", "front"]);
});

test("pruneState removes dr- and f-dr- decisions but never a front-page one", () => {
  const state = briefState({
    current: { pages: [] },
    decisions: {
      "dr-session-1": { action: "approve" },
      "f-dr-session-1": { action: "push-next" },
      "front-task-9": { action: "accept" },
      "tg:group:1": { action: "drop" },
    },
  });
  const removed = pruneState(state);
  assert.equal(removed.decisions, 2);
  assert.deepEqual(Object.keys(state.glymphatic_brief.decisions).sort(), ["front-task-9", "tg:group:1"]);
});

test("pruneState filters the decision_log by the same rule", () => {
  const state = briefState({
    current: { pages: [] },
    decision_log: [
      { task_id: "dr-x", action: "approve" },
      { task_id: "front-y", action: "accept" },
      { task_id: "f-dr-z", action: "push-next" },
      null,
      { action: "accept" },
    ],
  });
  const removed = pruneState(state);
  assert.equal(removed.log, 2);
  // Malformed entries are NOT this script's business to clean; mergeBriefForIngest owns that.
  assert.equal(state.glymphatic_brief.decision_log.length, 3);
});

test("pruneState returns null when there is nothing of ours to remove", () => {
  assert.equal(pruneState(briefState({ current: { pages: [{ id: "canvas" }] }, decisions: { a: {} } })), null);
  assert.equal(pruneState({ date: "2026-08-19" }), null, "no brief section at all");
  assert.equal(pruneState(null), null);
  assert.equal(pruneState({ glymphatic_brief: "nope" }), null, "a non-object brief is not walked");
});

test("pruneState reads the legacy camelCase section too", () => {
  const state = { date: "2026-08-19", glymphaticBrief: { current: { pages: [{ id: "day-review" }] } } };
  assert.deepEqual(pruneState(state), { pages: 1, context_pages: 0, decisions: 0, log: 0 });
  assert.deepEqual(state.glymphaticBrief.current.pages, []);
});

test("isCompleted recognises every flag routes/dcc.js used to write", () => {
  // log-done stamped done + completedBy + status; a later edit could leave only one.
  assert.equal(isCompleted({ done: true }), true);
  assert.equal(isCompleted({ completedBy: "day-review" }), true);
  assert.equal(isCompleted({ completed_at: "2026-08-19T10:00:00Z" }), true);
  assert.equal(isCompleted({ status: "done" }), true);
  // push-next rows are OPEN and were never credited, so they must not be revoked.
  assert.equal(isCompleted({ status: "open" }), false);
  assert.equal(isCompleted({}), false);
  assert.equal(isCompleted(null), false);
});

test("creditKey matches the ledger key shape earnTaskCredit was given", () => {
  assert.equal(creditKey({ date: "2026-08-19", id: "blk-1" }), "2026-08-19:blk-1");
  // An undated row must not key `null:<id>` or `undefined:<id>`.
  assert.equal(creditKey({ date: null, id: "blk-2" }), ":blk-2");
});

test("the match query covers all three provenance fields, and only tasks the scan wrote", () => {
  assert.match(MATCH_SQL, /properties->>'source' IN \('day-review', 'day-review-followup'\)/);
  assert.match(MATCH_SQL, /properties->>'created_by' = 'day-review'/);
  assert.match(MATCH_SQL, /properties->>'completedBy' = 'day-review'/);
  // A bare `source LIKE 'day-review%'` would also sweep up a user task someone happened
  // to name that way; the explicit IN list is the guard.
  assert.doesNotMatch(MATCH_SQL, /LIKE/i);
});

test("ymd keeps a DATE column on its own calendar day", () => {
  // node-postgres builds a DATE as LOCAL midnight. toISOString() on that shifts west of
  // UTC into the PREVIOUS day, which would prune (or key) the wrong row.
  const localMidnight = new Date(2026, 7, 16, 0, 0, 0);
  assert.equal(ymd(localMidnight), "2026-08-16");
  assert.equal(ymd("2026-08-16"), "2026-08-16");
  assert.equal(ymd("2026-08-16T04:00:00.000Z"), "2026-08-16");
  assert.equal(ymd(null), null);
  // Single-digit month and day must stay zero-padded.
  assert.equal(ymd(new Date(2026, 0, 5, 0, 0, 0)), "2026-01-05");
});

test("creditKey normalizes a Date-valued row date", () => {
  assert.equal(creditKey({ date: new Date(2026, 7, 16, 0, 0, 0), id: "blk-3" }), "2026-08-16:blk-3");
});

// The gap the first pass of this script missed, caught only by re-querying prod-shaped
// local data after an --apply reported success.
test("pruneState also cleans glymphatic_context.pages, the INGESTED copy", () => {
  // dcc-intelligence.js buildBrief assigns glymphatic_context.pages straight over
  // current.pages whenever it is non-empty, so leaving this copy behind means the next
  // rebuild promotes the dead page back into the brief.
  const state = {
    date: "2026-08-16",
    glymphatic_brief: { current: { pages: [{ id: "canvas" }] } },
    glymphatic_context: { pages: [{ id: "day-review", items: [] }, { id: "canvas" }] },
  };
  const removed = pruneState(state);
  assert.equal(removed.context_pages, 1);
  assert.equal(removed.pages, 0, "the brief copy was already clean");
  assert.deepEqual(state.glymphatic_context.pages.map((p) => p.id), ["canvas"]);
});

test("pruneState handles a packet that has ONLY the ingested context", () => {
  const state = { date: "2026-08-16", glymphatic_context: { pages: [{ id: "day-review" }] } };
  const removed = pruneState(state);
  assert.equal(removed.context_pages, 1);
  assert.deepEqual(state.glymphatic_context.pages, []);
});

test("dropPage leaves a holder with no pages array untouched", () => {
  assert.equal(dropPage(null), 0);
  assert.equal(dropPage({}), 0);
  assert.equal(dropPage({ pages: "nope" }), 0);
  assert.equal(dropPage({ pages: [{ id: "canvas" }] }), 0);
});
