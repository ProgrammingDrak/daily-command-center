const { test } = require("node:test");
const assert = require("node:assert/strict");
const createTaskTiming = require("./lib/task-timing");

function harness() {
  const rows = [];
  let seq = 0;
  const db = {
    async getBlock(id) { return rows.find((row) => row.id === id && !row.deleted_at) || null; },
    async getBlockIncludingDeleted(id) { return rows.find((row) => row.id === id) || null; },
    async getTaskTimeEntries(blockId, workspaceId, opts = {}) {
      return rows.filter((row) => row.type === "time_entry"
        && row.properties.blockId === blockId
        && row.workspace_id === workspaceId
        && (opts.includeDeleted || !row.deleted_at));
    },
    async updateBlock(id, patch) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("missing " + id);
      if (patch.properties !== undefined) row.properties = patch.properties;
      if (patch.date !== undefined) row.date = patch.date;
      return row;
    },
    async createBlock(input) {
      const row = {
        id: input.id || `row-${++seq}`,
        type: input.type,
        date: input.date || null,
        properties: input.properties || {},
        user_id: input.user_id || null,
        workspace_id: input.workspace_id || null,
        deleted_at: null,
      };
      rows.push(row);
      return row;
    },
    async deleteBlock(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.deleted_at = new Date().toISOString();
      return { id };
    },
    async undeleteBlock(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("missing " + id);
      row.deleted_at = null;
      return row;
    },
    async ensureDayRoot(date) { return `day-root-${date}`; },
  };
  const timing = createTaskTiming({ blockDB: db, pool: { query: async () => ({ rows: [] }) }, timeZone: "America/New_York" });
  function task(properties = {}, options = {}) {
    const row = {
      id: options.id || `task-${++seq}`,
      type: "block",
      date: options.date === undefined ? "2026-07-09" : options.date,
      properties: { title: "Work", type: "task", status: "open", ...properties },
      user_id: 1,
      workspace_id: options.workspaceId || "ws-1",
      deleted_at: null,
    };
    rows.push(row);
    return row;
  }
  const sessions = (row) => rows.filter((candidate) => candidate.type === "time_entry" && candidate.properties.blockId === row.id && !candidate.deleted_at);
  return { rows, timing, task, sessions, db };
}

test("start, pause, and resume append sessions without moving the plan", async () => {
  const { timing, task, sessions } = harness();
  const row = task({ start: "09:00", end: "10:00", estimatedMinutes: 60 });
  const first = Date.parse("2026-07-09T13:10:00Z");
  await timing.startWork({ block: row, atMs: first, actionId: "first" });
  await timing.pauseWork({ block: row, atMs: first + 20 * 60_000 });
  await timing.startWork({ block: row, atMs: first + 40 * 60_000, actionId: "second" });
  await timing.pauseWork({ block: row, atMs: first + 55 * 60_000 });
  assert.equal(sessions(row).length, 2);
  assert.equal(sessions(row)[0].properties.startedBy, "dcc");
  assert.equal(sessions(row)[0].properties.endedBy, "dcc");
  assert.equal(sessions(row)[0].properties.inferred, false);
  assert.equal(sessions(row)[0].properties.logicalSessionStartedAt, new Date(first).toISOString());
  assert.equal(sessions(row)[0].properties.logicalSessionEndedAt, new Date(first + 20 * 60_000).toISOString());
  assert.equal(row.properties.actualMinutes, 35);
  assert.equal(row.properties.start, "09:00");
  assert.equal(row.properties.end, "10:00");
  assert.equal(row.properties.startedAt, undefined);
});

test("multiple tasks may be active at once", async () => {
  const { timing, task } = harness();
  const one = task({}, { id: "one" });
  const two = task({}, { id: "two" });
  await timing.startWork({ block: one, atMs: 1_800_000_000_000, actionId: "one" });
  await timing.startWork({ block: two, atMs: 1_800_000_001_000, actionId: "two" });
  assert.ok(one.properties.startedAt);
  assert.ok(two.properties.startedAt);
});

test("completing active work closes it; completing paused work invents nothing", async () => {
  const { timing, task, sessions } = harness();
  const active = task({ estimatedMinutes: 30 }, { id: "active" });
  const start = Date.parse("2026-07-09T14:00:00Z");
  await timing.startWork({ block: active, atMs: start, actionId: "active" });
  await timing.completeWork({ block: active, atMs: start + 12 * 60_000 });
  assert.equal(active.properties.actualMinutes, 12);
  assert.equal(active.properties.status, "done");
  assert.equal(sessions(active).length, 1);

  const paused = task({ actualMinutes: 8 }, { id: "paused" });
  await timing.completeWork({ block: paused, atMs: start + 20 * 60_000 });
  assert.equal(paused.properties.actualMinutes, 8);
  assert.equal(sessions(paused).length, 0);
});

test("a completion retry finishes after an interrupted active-session close", async () => {
  const { timing, task, sessions, db } = harness();
  const row = task({ estimatedMinutes: 30 }, { id: "retry-complete" });
  const start = Date.parse("2026-07-09T14:00:00Z");
  const end = start + 12 * 60_000;
  await timing.startWork({ block: row, atMs: start, actionId: "start" });

  const update = db.updateBlock;
  let interrupted = false;
  db.updateBlock = async function (id, patch) {
    if (!interrupted && patch.properties && patch.properties.status === "done") {
      interrupted = true;
      throw new Error("injected completion interruption");
    }
    return update(id, patch);
  };

  await assert.rejects(
    timing.completeWork({ block: row, atMs: end, actionId: "complete-once" }),
    /injected completion interruption/
  );
  assert.equal(row.properties.status, "open");
  assert.equal(row.properties.startedAt, undefined);
  assert.equal(row.properties.workStateOperationId, "complete-once:close-session");

  await timing.completeWork({ block: row, atMs: end, actionId: "complete-once" });
  assert.equal(row.properties.status, "done");
  assert.equal(row.properties.workStateOperationId, "complete-once");
  assert.equal(sessions(row).length, 1);
  assert.equal(row.properties.actualMinutes, 12);
});

test("completion with no history infers only a positive planned duration", async () => {
  const { timing, task, sessions } = harness();
  const at = Date.parse("2026-07-09T15:00:00Z");
  const estimated = task({ estimatedMinutes: 25 }, { id: "estimated" });
  await timing.completeWork({ block: estimated, atMs: at });
  assert.equal(estimated.properties.actualMinutes, 25);
  assert.equal(sessions(estimated)[0].properties.estimated, true);
  assert.equal(sessions(estimated)[0].properties.inferred, true);
  assert.equal(sessions(estimated)[0].properties.inferenceReason, "planned-duration-completion");

  const unknown = task({ start: "", end: "" }, { id: "unknown" });
  await timing.completeWork({ block: unknown, atMs: at });
  assert.equal(unknown.properties.actualMinutes, undefined);
  assert.equal(sessions(unknown).length, 0);
});

test("meetings use the exact planned window", async () => {
  const { timing, task, sessions } = harness();
  const row = task({
    type: "meeting",
    plannedStartAt: "2026-07-09T13:30:00.000Z",
    plannedEndAt: "2026-07-09T14:15:00.000Z",
    start: "09:30",
    end: "10:15",
  }, { id: "meeting" });
  const checkedAt = Date.parse("2026-07-11T18:00:00.000Z");
  await timing.completeWork({ block: row, atMs: checkedAt });
  assert.equal(row.properties.completedAt, "2026-07-09T14:15:00.000Z");
  assert.equal(row.properties.completionRecordedAt, "2026-07-11T18:00:00.000Z");
  assert.equal(row.properties.actualMinutes, 45);
  assert.equal(sessions(row)[0].properties.startedAt, "2026-07-09T13:30:00.000Z");
  assert.equal(sessions(row)[0].properties.endedAt, "2026-07-09T14:15:00.000Z");
  assert.equal(sessions(row)[0].properties.inferenceReason, "meeting-planned-window");
});

test("meetings report only their planned window even when prior tracked time exists", async () => {
  const { timing, task, rows, sessions } = harness();
  const row = task({
    type: "meeting",
    plannedStartAt: "2026-07-09T13:30:00.000Z",
    plannedEndAt: "2026-07-09T14:15:00.000Z",
    actualMinutes: 20,
  }, { id: "meeting-with-history" });
  rows.push({
    id: "old-measured-session", type: "time_entry", date: "2026-07-09",
    workspace_id: "ws-1", deleted_at: null,
    properties: { blockId: row.id, workSessionId: "old", durSec: 1200, source: "work-session" },
  });

  await timing.completeWork({ block: row, atMs: Date.parse("2026-07-11T18:00:00.000Z") });

  assert.equal(sessions(row).length, 2);
  assert.equal(row.properties.actualMinutes, 45);
});

test("oneone remains a normal tracked task", async () => {
  const { timing, task, sessions } = harness();
  const row = task({ type: "oneone", start: "09:30", end: "10:15" }, { id: "oneone" });
  const checkedAt = Date.parse("2026-07-11T18:00:00.000Z");
  await timing.completeWork({ block: row, atMs: checkedAt });
  assert.equal(row.properties.completedAt, new Date(checkedAt).toISOString());
  assert.equal(row.properties.completionRecordedAt, undefined);
  assert.equal(row.properties.actualMinutes, 45);
  assert.equal(sessions(row)[0].properties.inferenceReason, "planned-duration-completion");
});

test("a planned meeting crossing local midnight becomes one logical session with two day rows", async () => {
  const { timing, task, sessions } = harness();
  const row = task({
    type: "meeting",
    plannedStartAt: "2026-07-10T03:30:00.000Z",
    plannedEndAt: "2026-07-10T04:30:00.000Z",
  }, { id: "overnight" });
  await timing.completeWork({ block: row, atMs: Date.parse("2026-07-12T12:00:00Z") });
  const parts = sessions(row);
  assert.deepEqual(parts.map((part) => part.date), ["2026-07-09", "2026-07-10"]);
  assert.deepEqual(parts.map((part) => part.properties.durSec), [1800, 1800]);
  assert.equal(new Set(parts.map((part) => part.properties.workSessionId)).size, 1);
  assert.equal(row.properties.actualMinutes, 60);
});

test("legacy meetings derive their planned instant from date and local times", async () => {
  const { timing, task, sessions } = harness();
  const row = task({ type: "meeting", start: "09:00", end: "09:30" }, { id: "legacy-meeting", date: "2026-07-09" });
  await timing.completeWork({ block: row, atMs: Date.parse("2026-07-12T12:00:00Z") });
  assert.equal(row.properties.completedAt, "2026-07-09T13:30:00.000Z");
  assert.equal(row.properties.actualMinutes, 30);
  assert.equal(sessions(row)[0].properties.startedAt, "2026-07-09T13:00:00.000Z");
});

test("reopening removes completion estimates but preserves measured sessions", async () => {
  const { timing, task, sessions } = harness();
  const at = Date.parse("2026-07-09T17:00:00Z");
  const estimated = task({ estimatedMinutes: 10 }, { id: "estimated" });
  await timing.completeWork({ block: estimated, atMs: at });
  await timing.reopenWork({ block: estimated, atMs: at + 60_000 });
  assert.equal(sessions(estimated).length, 0);
  assert.equal(estimated.properties.actualMinutes, undefined);

  const measured = task({}, { id: "measured" });
  await timing.startWork({ block: measured, atMs: at, actionId: "m" });
  await timing.completeWork({ block: measured, atMs: at + 7 * 60_000 });
  await timing.reopenWork({ block: measured, atMs: at + 8 * 60_000 });
  assert.equal(sessions(measured).length, 1);
  assert.equal(measured.properties.actualMinutes, 7);
});

test("recompletion restores the deterministic planned meeting session row", async () => {
  const { timing, task, sessions, rows } = harness();
  const at = Date.parse("2026-07-09T17:00:00Z");
  const row = task({
    type: "meeting",
    plannedStartAt: "2026-07-09T13:30:00.000Z",
    plannedEndAt: "2026-07-09T13:40:00.000Z",
  }, { id: "recomplete" });
  await timing.completeWork({ block: row, atMs: at });
  const sessionId = sessions(row)[0].id;

  await timing.reopenWork({ block: row, atMs: at + 60_000 });
  assert.equal(sessions(row).length, 0);

  await timing.completeWork({ block: row, atMs: at + 2 * 60_000 });
  assert.equal(sessions(row).length, 1);
  assert.equal(sessions(row)[0].id, sessionId);
  assert.equal(rows.filter((candidate) => candidate.id === sessionId).length, 1);
  assert.equal(row.properties.actualMinutes, 10);
});

test("non-work types cannot start and stale events cannot reverse newer state", async () => {
  const { timing, task, sessions } = harness();
  const shell = task({ type: "shell" }, { id: "shell" });
  const rejected = await timing.startWork({ block: shell, atMs: 1_800_000_000_000 });
  assert.equal(rejected.reason, "not-trackable");
  await timing.completeWork({ block: shell, atMs: 1_800_000_000_000 });
  assert.equal(sessions(shell).length, 0);

  const row = task({}, { id: "ordered" });
  await timing.startWork({ block: row, atMs: 1_800_000_100_000, actionId: "new" });
  const duplicate = await timing.startWork({ block: row, atMs: 1_800_000_100_000, actionId: "new" });
  assert.equal(duplicate.reason, "duplicate");
  const stale = await timing.pauseWork({ block: row, atMs: 1_800_000_000_000 });
  assert.equal(stale.reason, "stale");
  assert.ok(row.properties.startedAt);
  assert.equal(sessions(row).length, 0);
});

test("the same external action id cannot collide across tasks or workspaces", async () => {
  const { timing, task, sessions } = harness();
  const one = task({}, { id: "one", workspaceId: "ws-a" });
  const two = task({}, { id: "two", workspaceId: "ws-b" });
  const start = Date.parse("2026-07-09T14:00:00Z");
  await timing.startWork({ block: one, atMs: start, actionId: "slack-event-1" });
  await timing.startWork({ block: two, atMs: start, actionId: "slack-event-1" });
  await timing.pauseWork({ block: one, atMs: start + 5 * 60_000 });
  await timing.pauseWork({ block: two, atMs: start + 8 * 60_000 });

  assert.equal(sessions(one).length, 1);
  assert.equal(sessions(two).length, 1);
  assert.notEqual(sessions(one)[0].id, sessions(two)[0].id);
});
