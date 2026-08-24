// Tracked time is transferrable and splittable — the ledger half.
//
// The invariant every test here is really guarding: a reallocation NEVER invents
// or loses tracked time. A move conserves it, a split conserves it, and a
// double-submit cannot double-count it. Everything else (which row keeps the id,
// which flags get dropped) exists to protect that invariant from the writers
// around it — deleteTimerRow and reopenWork both delete segments by rules that
// would erase re-attributed time if the flags rode along.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const createTaskTiming = require("./lib/task-timing");
const { planAllocations, entryWindow } = createTaskTiming;

function harness() {
  const rows = [];
  let seq = 0;
  const db = {
    async getBlock(id) { return rows.find((row) => row.id === id) || null; },
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
      if (rows.some((row) => row.id === input.id)) throw new Error("duplicate id " + input.id);
      const row = {
        id: input.id || `row-${++seq}`,
        type: input.type,
        parent_id: input.parent_id || null,
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
      date: options.date === undefined ? "2026-08-20" : options.date,
      properties: { title: options.title || "Work", type: "task", status: "open", ...properties },
      user_id: 1,
      workspace_id: options.workspaceId === undefined ? "ws-1" : options.workspaceId,
      deleted_at: null,
    };
    rows.push(row);
    return row;
  }
  const live = (row) => rows.filter((candidate) => candidate.type === "time_entry"
    && candidate.properties.blockId === row.id && !candidate.deleted_at);
  const totalSec = () => rows.filter((row) => row.type === "time_entry" && !row.deleted_at)
    .reduce((sum, row) => sum + (Number(row.properties.durSec) || 0), 0);
  return { rows, timing, task, live, totalSec, db };
}

// One tracked hour on `owner`, written by the real work-session writer so the
// segment under test has the exact shape production produces.
async function trackedHour(h, owner, { startIso = "2026-08-20T13:00:00.000Z", minutes = 60 } = {}) {
  const startMs = Date.parse(startIso);
  await h.timing.startWork({ block: owner, atMs: startMs, actionId: `start-${owner.id}` });
  await h.timing.pauseWork({ block: owner, atMs: startMs + minutes * 60_000 });
  const entries = h.live(owner);
  assert.equal(entries.length, 1, "one segment written");
  return entries[0];
}

// ── the pure conservation rule ────────────────────────────────────────────────

test("planAllocations gives the last piece the remainder, always", () => {
  assert.deepEqual(planAllocations(3600, [{}]), { ok: true, parts: [{ durSec: 3600 }] });
  assert.deepEqual(planAllocations(3600, [{ minutes: 20 }, {}]).parts, [{ durSec: 1200 }, { durSec: 2400 }]);
  assert.deepEqual(planAllocations(3600, [{ minutes: 20 }, { minutes: 5 }, {}]).parts,
    [{ durSec: 1200 }, { durSec: 300 }, { durSec: 2100 }]);
  // An odd second cannot leak: the remainder swallows it.
  const odd = planAllocations(3667, [{ minutes: 20 }, {}]);
  assert.equal(odd.parts.reduce((sum, part) => sum + part.durSec, 0), 3667);
  // A length on the LAST piece is ignored rather than trusted.
  const overstated = planAllocations(3600, [{ minutes: 20 }, { minutes: 999 }]);
  assert.deepEqual(overstated.parts, [{ durSec: 1200 }, { durSec: 2400 }]);
});

test("planAllocations refuses anything that would not conserve the time", () => {
  assert.equal(planAllocations(3600, [{ minutes: 60 }, {}]).ok, false, "no remainder left");
  assert.equal(planAllocations(3600, [{ minutes: 90 }, {}]).ok, false, "over the total");
  assert.equal(planAllocations(3600, [{ minutes: 0 }, {}]).ok, false, "a zero-length piece");
  assert.equal(planAllocations(3600, []).ok, false, "no destinations");
  assert.equal(planAllocations(0, [{}]).ok, false, "nothing tracked");
  assert.equal(planAllocations(3600, new Array(13).fill({ minutes: 1 })).ok, false, "past the ceiling");
});

test("entryWindow reads all three shapes a time_entry start comes in", () => {
  // writeLogicalSession: ISO startedAt wins.
  assert.equal(entryWindow({
    date: "2026-08-20",
    properties: { startedAt: "2026-08-20T13:00:00.000Z", start: "09:00", durSec: 3600 },
  }).startMs, Date.parse("2026-08-20T13:00:00.000Z"));
  // finalizeTiming: "HH:MM" against the row's date, in app-local time.
  const hhmm = entryWindow({ date: "2026-08-20", properties: { start: "09:00", durSec: 1800 } });
  assert.equal(hhmm.startMs, Date.parse("2026-08-20T13:00:00.000Z"));
  assert.equal(hhmm.endMs, hhmm.startMs + 1_800_000);
  // day-review's manual editor: a naive local ISO.
  assert.equal(entryWindow({
    date: "2026-08-20", properties: { start: "2026-08-20T09:00:00", durSec: 600 },
  }).startMs, Date.parse("2026-08-20T13:00:00.000Z"));
  // Unreadable start, real duration: still splittable, just unpositioned.
  const blind = entryWindow({ date: null, properties: { durSec: 900 } });
  assert.equal(blind.startMs, null);
  assert.equal(blind.durSec, 900);
});

// ── moving ────────────────────────────────────────────────────────────────────

test("a whole segment moves to another task and both totals follow", async () => {
  const h = harness();
  const from = h.task({}, { id: "from", title: "Wrong task" });
  const to = h.task({}, { id: "to", title: "Right task" });
  const entry = await trackedHour(h, from);
  assert.equal(from.properties.actualMinutes, 60);

  const result = await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 3600, task: to }], actor: "dcc:1", workspaceId: "ws-1",
  });

  assert.equal(h.live(from).length, 0, "nothing left on the origin");
  assert.equal(h.live(to).length, 1, "one segment on the destination");
  assert.equal(from.properties.actualMinutes, undefined, "the origin stamp is removed, not zeroed");
  assert.equal(to.properties.actualMinutes, 60);
  assert.equal(h.totalSec(), 3600, "the ledger still holds exactly one hour");
  assert.equal(result.sourceEntryDeleted, true);
  const moved = h.live(to)[0];
  assert.equal(moved.properties.taskTitle, "Right task");
  assert.equal(moved.properties.movedFromTaskId, "from");
  assert.notEqual(moved.id, entry.id, "a moved piece never keeps an id that encodes the old task");
});

test("a moved piece keeps its clock window", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({}, { id: "to" });
  const entry = await trackedHour(h, from);
  const before = { start: entry.properties.start, end: entry.properties.end, startedAt: entry.properties.startedAt };
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], workspaceId: "ws-1" });
  const moved = h.live(to)[0];
  assert.equal(moved.properties.start, before.start);
  assert.equal(moved.properties.end, before.end);
  assert.equal(moved.properties.startedAt, before.startedAt);
  assert.equal(moved.date, "2026-08-20", "the segment stays on the day the work happened");
});

// ── splitting ─────────────────────────────────────────────────────────────────

test("a split lays the pieces out in clock order and conserves the hour", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner", title: "Migration" });
  const other = h.task({}, { id: "other", title: "Onboarding" });
  const entry = await trackedHour(h, owner);

  const plan = planAllocations(3600, [{ minutes: 20 }, {}]);
  await h.timing.reallocateTimeEntry({
    entry,
    allocations: [{ durSec: plan.parts[0].durSec, task: other }, { durSec: plan.parts[1].durSec, task: owner }],
    workspaceId: "ws-1",
  });

  assert.equal(other.properties.actualMinutes, 20);
  assert.equal(owner.properties.actualMinutes, 40);
  assert.equal(h.totalSec(), 3600, "no second created or destroyed");
  const first = h.live(other)[0];
  const second = h.live(owner)[0];
  assert.equal(first.properties.startedAt, "2026-08-20T13:00:00.000Z");
  assert.equal(first.properties.endedAt, "2026-08-20T13:20:00.000Z");
  assert.equal(second.properties.startedAt, "2026-08-20T13:20:00.000Z", "piece two picks up where piece one ended");
  assert.equal(second.properties.endedAt, "2026-08-20T14:00:00.000Z");
  assert.equal(second.id, entry.id, "the piece that stays keeps the row id");
});

test("a three-way split can land on three different tasks", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const b = h.task({}, { id: "b" });
  const c = h.task({}, { id: "c" });
  const entry = await trackedHour(h, owner);
  const plan = planAllocations(3600, [{ minutes: 15 }, { minutes: 15 }, {}]);
  await h.timing.reallocateTimeEntry({
    entry,
    allocations: [
      { durSec: plan.parts[0].durSec, task: owner },
      { durSec: plan.parts[1].durSec, task: b },
      { durSec: plan.parts[2].durSec, task: c },
    ],
    workspaceId: "ws-1",
  });
  assert.equal(owner.properties.actualMinutes, 15);
  assert.equal(b.properties.actualMinutes, 15);
  assert.equal(c.properties.actualMinutes, 30);
  assert.equal(h.totalSec(), 3600);
});

test("the store refuses an allocation that does not conserve the time", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 1200, task: other }], workspaceId: "ws-1" }),
    /conserve/,
  );
  assert.equal(owner.properties.actualMinutes, 60, "the rejected call changed nothing");
  assert.equal(h.totalSec(), 3600);
});

// ── the writers that would otherwise erase re-attributed time ────────────────

test("moving an inferred meeting window strips the flags reopenWork deletes on", async () => {
  const h = harness();
  const meeting = h.task({
    type: "meeting", start: "09:00", end: "10:00", plannedStartAt: "2026-08-20T13:00:00.000Z",
    plannedEndAt: "2026-08-20T14:00:00.000Z",
  }, { id: "meeting" });
  const real = h.task({}, { id: "real", title: "What I actually did" });
  await h.timing.completeWork({ block: meeting, atMs: Date.parse("2026-08-20T14:05:00.000Z") });
  const inferred = h.live(meeting)[0];
  assert.equal(inferred.properties.inferenceReason, "meeting-planned-window");

  await h.timing.reallocateTimeEntry({ entry: inferred, allocations: [{ durSec: 3600, task: real }], workspaceId: "ws-1" });
  const moved = h.live(real)[0];
  assert.equal(moved.properties.inferred, undefined);
  assert.equal(moved.properties.estimated, undefined);
  assert.equal(moved.properties.inferenceReason, undefined);

  // The proof: reopening the destination must not sweep the re-attributed hour away.
  await h.timing.reopenWork({ block: real, atMs: Date.parse("2026-08-20T15:00:00.000Z") });
  assert.equal(h.live(real).length, 1, "hand-placed time survives a reopen");
  assert.equal(real.properties.actualMinutes, 60);
});

test("a moved Slack timer row cannot be hard-deleted by the origin's clearTiming", async () => {
  const h = harness();
  const from = h.task({ startedAt: "2026-08-20T13:00:00.000Z" }, { id: "from" });
  const to = h.task({}, { id: "to" });
  await h.timing.finalizeTiming({
    block: from, endMs: Date.parse("2026-08-20T13:30:00.000Z"), userId: 1, workspaceId: "ws-1", title: "Slack task",
  });
  const timerRow = h.live(from)[0];
  assert.equal(timerRow.id, "from-slacktimer", "the Slack path writes an id that encodes the task");

  await h.timing.reallocateTimeEntry({ entry: timerRow, allocations: [{ durSec: timerRow.properties.durSec, task: to }], workspaceId: "ws-1" });
  const moved = h.live(to)[0];
  assert.notEqual(moved.id, "from-slacktimer");
  // clearTiming on the ORIGIN hard-deletes `<origin>-slacktimer` by id. The moved
  // row must no longer answer to that id, or the origin would erase the
  // destination's time.
  await h.timing.clearTiming({ block: from });
  assert.equal(h.live(to).length, 1, "the destination keeps its time");
  assert.equal(to.properties.actualMinutes, 30);
});

test("recomputeActualMinutes drops a stale ⏱ note but keeps an unrelated one", async () => {
  const h = harness();
  const from = h.task({ startedAt: "2026-08-20T13:00:00.000Z", notes: "Ticket ABC-1" }, { id: "from" });
  const to = h.task({}, { id: "to" });
  await h.timing.finalizeTiming({ block: from, endMs: Date.parse("2026-08-20T13:30:00.000Z"), userId: 1, workspaceId: "ws-1" });
  assert.match(from.properties.notes, /⏱ Took ~30m/);

  const entry = h.live(from)[0];
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 1800, task: to }], workspaceId: "ws-1" });
  assert.equal(from.properties.notes, "Ticket ABC-1", "the ⏱ line goes, the user's own text stays");
  assert.equal(from.properties.actualMinutes, undefined);
});

test("a reconciled guess becomes a real measurement once a human places it", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({ actualMinutes: 45, actualMinutesFrom: "reconcile" }, { id: "to" });
  const entry = await trackedHour(h, from);
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], workspaceId: "ws-1" });
  assert.equal(to.properties.actualMinutes, 60);
  assert.equal(to.properties.actualMinutesFrom, undefined, "the derived flag is gone, so no read withdraws it");
});

// ── replay safety ─────────────────────────────────────────────────────────────

test("replaying the same submission splits once, not twice", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  await h.timing.reallocateTimeEntry({ entry, allocations, actionId: "submit-1", workspaceId: "ws-1" });
  assert.equal(other.properties.actualMinutes, 20);
  assert.equal(owner.properties.actualMinutes, 40);

  // The double-submit shape that has no other guard: the piece that STAYS keeps
  // the source row, so the shortened source is still a valid 40m segment and the
  // same plan would happily cut 20m off it again.
  const shortened = h.rows.find((row) => row.id === entry.id);
  assert.equal(planAllocations(shortened.properties.durSec, [{ minutes: 20 }, {}]).ok, true,
    "the plan alone cannot tell a replay from a new split");
  const replay = await h.timing.reallocateTimeEntry({
    entry: shortened, allocations, actionId: "submit-1", workspaceId: "ws-1",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(other.properties.actualMinutes, 20, "the destination did not gain a second slice");
  assert.equal(owner.properties.actualMinutes, 40);
  assert.equal(h.totalSec(), 3600);

  // A DIFFERENT submission is still allowed to split what is left.
  await h.timing.reallocateTimeEntry({
    entry: shortened, allocations: [{ durSec: 600, task: other }, { durSec: 1800, task: owner }],
    actionId: "submit-2", workspaceId: "ws-1",
  });
  assert.equal(other.properties.actualMinutes, 30);
  assert.equal(owner.properties.actualMinutes, 30);
  assert.equal(h.totalSec(), 3600, "still exactly one hour of tracked time");
});

test("a piece that lands on a deleted-and-restored row reuses it instead of duplicating", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  await h.timing.reallocateTimeEntry({ entry, allocations, workspaceId: "ws-1" });
  const created = h.live(other)[0];
  await h.db.deleteBlock(created.id);

  // Same source, same plan, same derived id: the tombstone is revived rather than
  // colliding on insert.
  const stayed = h.rows.find((row) => row.id === entry.id);
  stayed.properties.durSec = 3600;
  await h.timing.reallocateTimeEntry({ entry: stayed, allocations, workspaceId: "ws-1" });
  assert.equal(h.live(other).length, 1);
  assert.equal(h.live(other)[0].id, created.id);
});
