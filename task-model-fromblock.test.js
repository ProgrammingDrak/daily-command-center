// Contract tests for TaskModel.fromBlock (public/js/task-model.js) — the ONE
// block -> ev projection, hoisted out of reloadPersistedEdits so the itinerary
// and the carryover lane share a single shape.
//
// The invariant these pin: every field the row builders read unconditionally
// (source_id -> the Slack ↗ pill, tags -> tag chips, prep/recap status,
// publicVisibility -> the Private chip, subtaskOf/wrapId -> nesting) survives the
// projection. The carryover lane's old bespoke bags dropped all of them, which is
// the field loss this phase exists to end.
const test = require("node:test");
const assert = require("node:assert/strict");
const TaskModel = require("./public/js/task-model.js");

const block = (over) => Object.assign({
  id: "blk-1",
  date: "2026-07-28",
  created_at: "2026-07-28T14:00:00.000Z",
  properties: {}
}, over || {});

test("identity: local_id wins, block id is the fallback and always kept as _blockId", () => {
  const withLocal = TaskModel.fromBlock(block({ properties: { local_id: "qa-9", title: "t" } }));
  assert.equal(withLocal.id, "qa-9");
  assert.equal(withLocal._blockId, "blk-1");
  // API-inserted blocks (Slack poller, MCP, calendar) carry no local_id.
  const apiOnly = TaskModel.fromBlock(block({ properties: { kind: "task", title: "t" } }));
  assert.equal(apiOnly.id, "blk-1");
  assert.equal(apiOnly._blockId, "blk-1");
});

test("every row-builder field survives — the carryover field loss regression", () => {
  const ev = TaskModel.fromBlock(block({
    properties: {
      local_id: "qa-1", title: "Ship the thing", type: "task",
      start: "09:00", end: "09:45", duration: 45,
      source: "slack", source_id: "https://clever.slack.com/archives/C1/p123",
      tags: ["deep-work", "amp"], priority: "High",
      prep_status: "ready", recap_status: "ready",
      publicVisibility: "private",
      subtaskOf: "qa-parent", notes: "n", detail: "d",
      notionUrl: "https://notion.so/x", triageId: "tr-1", responsibilityId: "r-1"
    }
  }));
  // The five chips that render blank today on a carryover row.
  assert.equal(ev.source_id, "https://clever.slack.com/archives/C1/p123");
  assert.deepEqual(ev.tags, ["deep-work", "amp"]);
  assert.equal(ev.prepStatus, "ready");
  assert.equal(ev.recapStatus, "ready");
  assert.equal(ev.publicVisibility, "private");
  // ...plus the nesting edge and the rest of the bag.
  assert.equal(ev.subtaskOf, "qa-parent");
  assert.equal(ev.source, "slack");
  assert.equal(ev.priority, "High");
  assert.equal(ev.triageId, "tr-1");
  assert.equal(ev.responsibilityId, "r-1");
  assert.equal(ev.createdAt, "2026-07-28T14:00:00.000Z");
});

test("privacy defaults to public but a private task stays private (the hardcoded-PUBLIC bug)", () => {
  assert.equal(TaskModel.fromBlock(block({ properties: { title: "t" } })).publicVisibility, "public");
  assert.equal(TaskModel.fromBlock(block({ properties: { publicVisibility: "private" } })).publicVisibility, "private");
});

test("dateless rows are untimed and flagged _dateless; a stored start is ignored", () => {
  const ev = TaskModel.fromBlock(block({ date: null, properties: { local_id: "bl-1", start: "11:00", kind: "backlog" } }));
  assert.equal(ev._dateless, true);
  assert.equal(ev.untimed, true);
  assert.equal(ev._pinnedStart, undefined);  // never pin a dateless row
});

test("a dated row with a real start is pinned; a subtask never is", () => {
  const parent = TaskModel.fromBlock(block({ properties: { local_id: "p", start: "13:00", end: "14:00" } }));
  assert.equal(parent._pinnedStart, "13:00");
  assert.equal(parent.untimed, false);
  const sub = TaskModel.fromBlock(block({ properties: { local_id: "s", start: "13:00", end: "13:00", subtaskOf: "p" } }));
  assert.equal(sub._pinnedStart, undefined);
});

test("end: legacy fallback is fmt(duration); deriveEnd anchors it to the start", () => {
  // Legacy shape, kept byte-identical for the work list (recalcTimes rewrites it).
  const legacy = TaskModel.fromBlock(block({ properties: { start: "09:00", duration: 30 } }));
  assert.equal(legacy.end, "00:30");
  // The carryover lane never gets a recalc, so it opts into a real end.
  const derived = TaskModel.fromBlock(block({ properties: { start: "09:00", duration: 30 } }), { deriveEnd: true });
  assert.equal(derived.end, "09:30");
  // An explicit end always wins over both.
  assert.equal(TaskModel.fromBlock(block({ properties: { start: "09:00", end: "10:15", duration: 30 } }), { deriveEnd: true }).end, "10:15");
  // deriveEnd on a startless row falls back to the duration form (nothing to anchor to).
  assert.equal(TaskModel.fromBlock(block({ properties: { duration: 90 } }), { deriveEnd: true }).end, "01:30");
});

test("meta derives from duration when the block has none", () => {
  assert.equal(TaskModel.fromBlock(block({ properties: { duration: 90 } })).meta, "Custom task · 1h 30m");
  assert.equal(TaskModel.fromBlock(block({ properties: { meta: "Caught up · 45m" } })).meta, "Caught up · 45m");
});

test("commute keys are only emitted when present, both spellings accepted", () => {
  const bare = TaskModel.fromBlock(block({ properties: { title: "t" } }));
  assert.equal("commuteMinutes" in bare, false);
  const snake = TaskModel.fromBlock(block({ properties: { commute_minutes: 20, commute_back_minutes: 25 } }));
  assert.equal(snake.commuteMinutes, 20);
  assert.equal(snake.commuteBackMinutes, 25);
});

test("meetingBlockId is the block's own id for meeting types only", () => {
  assert.equal(TaskModel.fromBlock(block({ properties: { type: "meeting" } })).meetingBlockId, "blk-1");
  assert.equal(TaskModel.fromBlock(block({ properties: { type: "oneone" } })).meetingBlockId, "blk-1");
  assert.equal(TaskModel.fromBlock(block({ properties: { type: "task" } })).meetingBlockId, "");
});

test("pure: the source block is never mutated", () => {
  const b = block({ properties: { local_id: "qa-1", title: "t" } });
  const snapshot = JSON.stringify(b);
  TaskModel.fromBlock(b, { deriveEnd: true });
  assert.equal(JSON.stringify(b), snapshot);
});
