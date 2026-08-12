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

// ─────────────────── the key-set guard (the equivalence pin) ───────────────────
// The extraction was proven byte-identical to the projection it replaced over ~2900
// real prod rows by a one-off harness, but that harness is not part of the repo, so
// from here on THIS is what stops a future edit silently dropping a field. The named
// assertions above cover the fields that motivated the phase; this covers the rest,
// including two that are load-bearing right now and would otherwise go unnoticed:
// reschedulePlacement (persistence.js branches on it one line after the call:
// `if(task.reschedulePlacement==="earliest"&&!task.subtaskOf)scheduled.unshift(task)`)
// and wrapId/isWrap, which drive ride-along nesting in the carryover lane.
const BASE_KEYS = [
  "_blockId", "_dateless", "actualMinutes", "aiSummary", "alertKey", "alertType", "allDay", "allDayEnd", "allDayStart", "ampUrl", "calUrl",
  "calendarAccountEmail", "calendarAccountKey", "calendarColor", "calendarId", "calendarName", "capacityBucket",
  "completedAt", "createdAt", "dashboardRef", "delegatedItemId", "detail", "end", "hangout_link",
  "hubspotUrl", "id", "isPlaceholder", "isWrap", "kind", "linkedBlockId", "linkedTagId",
  "location", "meetingBlockId", "meta", "notes", "notionUrl", "placeholderMenus", "pointsDurationMinutes",
  "prepStatus", "priority", "publicVisibility", "recapStatus", "recordingReview",
  "recurrenceOverride", "repeatMode", "repeatOccurrenceInstant", "repeatOccurrenceKey", "repeatOccurrenceRootId", "repeatSeriesId",
  "rescheduledFrom", "reschedulePlacement", "responsibilityId", "responsibilityScore",
  "responsibilityTitle", "rsvp_status", "source", "sourceKey", "sourceLabel", "sourceTaskId", "source_id", "start", "startedAt", "status",
  "subtaskOf", "tags", "taskGroupId", "title", "triageId", "type", "untimed", "wrapId"
].sort();

test("key-set guard: a bare block still projects EVERY key, so none can be dropped silently", () => {
  const ev = TaskModel.fromBlock(block({ properties: {} }));
  assert.deepStrictEqual(Object.keys(ev).sort(), BASE_KEYS);
});

test("every projected key round-trips its property, including the ones nothing asserts by name", () => {
  // One maximal block; assert the full object at once so a renamed key, a changed
  // default, or a dropped field all fail here rather than in production.
  const ev = TaskModel.fromBlock(block({
    id: "row-9", date: "2026-07-28", created_at: "2026-07-28T14:00:00.000Z",
    properties: {
      local_id: "qa-1", title: "T", type: "task", start: "09:00", end: "09:30", duration: 30,
      meta: "M", detail: "D", source: "slack", source_id: "https://s/1", notes: "N",
      notionUrl: "https://n", calUrl: "https://c", priority: "Low", tags: ["a"], kind: "task",
      location: "Room", conferenceUrl: "https://meet", rsvp_status: "yes",
      prep_status: "ready", recap_status: "ready", dashboard_ref: "dash", recording_review: 1,
      meetingBlockId: "mb", isPlaceholder: true, placeholderMenus: ["m"], taskGroupId: "tg",
      responsibilityId: "r", responsibilityTitle: "RT", capacityBucket: "deep",
      responsibilityScore: 7, repeatMode: "scheduled", repeatSeriesId: "r",
      repeatOccurrenceKey: "2026-07-28T09:00", repeatOccurrenceInstant: "2026-07-28T13:00:00.000Z",
      repeatOccurrenceRootId: "row-9", recurrenceOverride: true,
      alertKey: "ak", alertType: "at", publicVisibility: "private",
      triageId: "ti", delegatedItemId: "di", linkedBlockId: "lb", linkedTagId: "lt",
      ampUrl: "https://amp", hubspotUrl: "https://hs", wrapId: "w", isWrap: true,
      subtaskOf: "p", reschedulePlacement: "earliest", rescheduledFrom: "2026-07-27",
      sourceTaskId: "st", status: "open", startedAt: "2026-07-28T15:00:00.000Z",
      completedAt: null, actualMinutes: 12, pointsDurationMinutes: 20, aiSummary: "Thread context"
    }
  }));
  assert.deepStrictEqual(ev, {
    id: "qa-1", title: "T", type: "task", _blockId: "row-9", _dateless: false,
    createdAt: "2026-07-28T14:00:00.000Z", start: "09:00", end: "09:30", meta: "M",
    detail: "D", source: "slack", source_id: "https://s/1", notes: "N", untimed: false,
    status: "open", allDay: false, allDayStart: null, allDayEnd: null,
    sourceKey: "slack", sourceLabel: "Slack",
    startedAt: "2026-07-28T15:00:00.000Z", completedAt: null,
    actualMinutes: 12, pointsDurationMinutes: 20, aiSummary: "Thread context",
    notionUrl: "https://n", calUrl: "https://c", priority: "Low",
    calendarId: "", calendarName: "", calendarColor: "", calendarAccountKey: "", calendarAccountEmail: "",
    tags: ["a"], kind: "task",
    location: "Room", hangout_link: "https://meet", rsvp_status: "yes",
    prepStatus: "ready", recapStatus: "ready", dashboardRef: "dash", recordingReview: true,
    meetingBlockId: "mb", isPlaceholder: true, placeholderMenus: ["m"], taskGroupId: "tg",
    responsibilityId: "r", responsibilityTitle: "RT", capacityBucket: "deep",
    responsibilityScore: 7, repeatMode: "scheduled", repeatSeriesId: "r",
    repeatOccurrenceKey: "2026-07-28T09:00", repeatOccurrenceInstant: "2026-07-28T13:00:00.000Z",
    repeatOccurrenceRootId: "row-9", recurrenceOverride: true,
    alertKey: "ak", alertType: "at", publicVisibility: "private",
    triageId: "ti", delegatedItemId: "di", linkedBlockId: "lb", linkedTagId: "lt",
    ampUrl: "https://amp", hubspotUrl: "https://hs", wrapId: "w", isWrap: true,
    subtaskOf: "p", reschedulePlacement: "earliest", rescheduledFrom: "2026-07-27",
    sourceTaskId: "st"
    // no _pinnedStart: a subtask never pins its start, even with a stored time.
  });
});

test("deriveEnd clamps at the end of the day instead of producing a negative duration", () => {
  // Unclamped, start 23:30 + 60min gave "25:30"; pt() wraps the hour, so dur(ev) came
  // out -1320 and every reschedule of that row failed with a 400 from the server.
  const late = TaskModel.fromBlock(
    block({ properties: { local_id: "l", start: "23:30", duration: 60 } }), { deriveEnd: true });
  assert.equal(late.end, "23:59");
  // exactly-midnight boundary
  const edge = TaskModel.fromBlock(
    block({ properties: { local_id: "l", start: "23:00", duration: 60 } }), { deriveEnd: true });
  assert.equal(edge.end, "23:59");
  // an ordinary row is untouched by the clamp
  const normal = TaskModel.fromBlock(
    block({ properties: { local_id: "l", start: "09:00", duration: 45 } }), { deriveEnd: true });
  assert.equal(normal.end, "09:45");
});

test("in-progress state follows the hourglass lifecycle and completion always wins", () => {
  const running = { startedAt: "2026-07-28T15:00:00.000Z", status: "open", completedAt: null };
  assert.equal(TaskModel.isInProgress(running, false), true);
  assert.equal(TaskModel.isInProgress(running, true), false, "the day completion overlay wins");
  assert.equal(TaskModel.isInProgress({ ...running, status: "done" }, false), false);
  assert.equal(TaskModel.isInProgress({ ...running, completedAt: "2026-07-28T16:00:00.000Z" }, false), false);
  assert.equal(TaskModel.isInProgress({ ...running, startedAt: null }, false), false, "removing the hourglass clears the state");
});

test("calendar source identity is independent from meeting type", () => {
  const meeting = TaskModel.fromBlock(block({
    properties: {
      type: "meeting", kind: "meeting", source: "calendar",
      calendar_id: "team", calendar_name: "Team calendar",
      account_key: "work", account_email: "drake@example.com",
    },
  }));
  assert.equal(meeting.type, "meeting");
  assert.equal(meeting.sourceKey, "calendar:work:team");
  assert.equal(meeting.sourceLabel, "Team calendar");
});

test("source normalization gives Slack precedence and unknown origins fall back to Other", () => {
  const slack = TaskModel.fromBlock(block({ properties: { source: "manual", alertType: "slack", notionUrl: "https://notion.so/task" } }));
  const unknown = TaskModel.fromBlock(block({ properties: { source: "custom-importer" } }));
  assert.equal(slack.sourceKey, "slack");
  assert.equal(slack.sourceLabel, "Slack");
  assert.equal(unknown.sourceKey, "other");
  assert.equal(unknown.sourceLabel, "Other");
});

test("all-day rows stay scheduled and retain exclusive date bounds", () => {
  const allDay = TaskModel.fromBlock(block({ properties: { all_day: true, all_day_start: "2026-08-07", all_day_end: "2026-08-10" } }));
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.untimed, false);
  assert.equal(allDay.allDayStart, "2026-08-07");
  assert.equal(allDay.allDayEnd, "2026-08-10");
});
