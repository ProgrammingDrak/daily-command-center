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
  // THE FAKE CANNOT SEE A TRANSACTION, so it has to be told. A write that arrives without
  // the client runs on the pool in real Postgres and survives the ROLLBACK, which is the
  // single most likely way this mover regresses and exactly what its comments are about.
  //
  // REFUSED, not merely recorded. Recording left each test responsible for remembering an
  // assertion, and three rounds of review each found another branch that had forgotten
  // one (the revive-and-overwrite path was the last). Throwing while a transaction is
  // open makes the whole class impossible to miss, in every test, without an assertion.
  // Writes outside a transaction stay legal, because startWork, pauseWork, finalizeTiming
  // and clearTiming are all single-row and correctly clientless.
  const escaped = [];
  let writes = 0;
  let leaked = 0;
  function guardWrite(op, id, client) {
    writes++;
    if (snapshot === null || client) return;
    escaped.push([op, id]);
    throw new Error(`write escaped the transaction: ${op} ${id}`);
  }
  const db = {
    // Both take a `client` (and getBlockIncludingDeleted a FOR UPDATE flag) so the mover
    // can read through its own transaction. The real ones ignore neither.
    async getBlock(id, _client) { return rows.find((row) => row.id === id) || null; },
    async getBlockIncludingDeleted(id, _client, _forUpdate) { return rows.find((row) => row.id === id) || null; },
    async getTaskTimeEntries(blockId, workspaceId, opts = {}, _client) {
      return rows.filter((row) => row.type === "time_entry"
        && row.properties.blockId === blockId
        && row.workspace_id === workspaceId
        && (opts.includeDeleted || !row.deleted_at));
    },
    async updateBlock(id, patch, _client) {
      guardWrite("updateBlock", id, _client);
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("missing " + id);
      if (row.deleted_at) throw new Error("Block is deleted: " + id);
      if (patch.properties !== undefined) row.properties = patch.properties;
      if (patch.date !== undefined) row.date = patch.date;
      if (patch.parent_id !== undefined) row.parent_id = patch.parent_id;
      return row;
    },
    async createBlock(input, _client) {
      guardWrite("createBlock", input.id, _client);
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
    async deleteBlock(id, _client) {
      guardWrite("deleteBlock", id, _client);
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.deleted_at = new Date().toISOString();
      return { id };
    },
    async undeleteBlock(id, _client) {
      guardWrite("undeleteBlock", id, _client);
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("missing " + id);
      row.deleted_at = null;
      return row;
    },
    async ensureDayRoot(date, _userId, _workspaceId, _client) {
      if (snapshot !== null && !_client) {
        escaped.push(["ensureDayRoot", date]);
        throw new Error("write escaped the transaction: ensureDayRoot " + date);
      }
      return `day-root-${date}`;
    },
    // Destinations are created inside the transaction now, so the fake has to exist.
    async createItineraryTask(args) {
      const { date, properties, userId, workspaceId } = args;
      guardWrite("createItineraryTask", date, args.client);
      // db.createItineraryTask calls ensureDayRoot WITHOUT forwarding its client, so
      // leaving ensureRoot on would put that insert outside the transaction.
      if (snapshot !== null && args.ensureRoot !== false) {
        escaped.push(["createItineraryTask:ensureRoot", date]);
        throw new Error("createItineraryTask would ensure its day root outside the transaction");
      }
      const row = {
        id: `made-${++seq}`, type: "block", date: date || null,
        properties: { kind: "task", type: "task", status: "open", ...(properties || {}) },
        user_id: userId || null, workspace_id: workspaceId || null, deleted_at: null,
      };
      rows.push(row);
      return row;
    },
  };
  // deleteTimerRow is this module's one raw statement, so an inert pool stub makes
  // every clearTiming assertion below vacuous: nothing could hard-delete anything and
  // "the destination keeps its time" would hold even if the moved piece had kept the
  // `<taskId>-slacktimer` id. task-timing.test.js already models it properly.
  const hardDeleted = [];
  // And the reallocation mover owns a real transaction now, so the stub has to model one
  // or the rollback tests below would be asserting against nothing. BEGIN snapshots every
  // row, ROLLBACK restores the snapshot, COMMIT drops it. That is what lets a test say
  // "the failed attempt changed NOTHING" and mean it.
  let snapshot = null;
  // Restores IN PLACE, onto the same row objects, rather than swapping in clones. Both
  // because callers hold references to these objects (the store assigns
  // `block.properties` back onto the task it was handed) and because a clone-swap would
  // silently detach a test's own fixture from the array under it.
  const clone = () => rows.map((row) => ({ row, fields: { ...row }, properties: { ...row.properties } }));
  const restore = (saved) => {
    const keep = new Set(saved.map((entry) => entry.row));
    for (let i = rows.length - 1; i >= 0; i--) if (!keep.has(rows[i])) rows.splice(i, 1);
    for (const entry of saved) {
      Object.assign(entry.row, entry.fields);
      entry.row.properties = entry.properties;
      if (!rows.includes(entry.row)) rows.push(entry.row);
    }
  };
  const client = {
    query: async (sql, params) => {
      const text = String(sql).trim().toUpperCase();
      if (text.startsWith("BEGIN")) { snapshot = clone(); return { rows: [] }; }
      if (text.startsWith("COMMIT")) { snapshot = null; return { rows: [] }; }
      if (text.startsWith("ROLLBACK")) { if (snapshot) restore(snapshot); snapshot = null; return { rows: [] }; }
      return pool.query(sql, params);
    },
    // Releasing a connection mid-transaction is not a commit and not a rollback: pg hands
    // it back to the pool with the work still open, so the work is discarded AND the next
    // borrower can inherit the open transaction. Modelling the discard is what makes a
    // missing COMMIT visible; counting the leak is what keeps a missing ROLLBACK visible,
    // because otherwise the discard silently does the rollback's job for it.
    release: () => {
      if (snapshot) { leaked++; restore(snapshot); snapshot = null; }
    },
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      if (/^\s*DELETE/i.test(sql)) {
        const i = rows.findIndex((row) => row.id === params[0] && row.type === "time_entry");
        if (i >= 0) hardDeleted.push(rows.splice(i, 1)[0]);
      }
      return { rows: [] };
    },
  };
  const timing = createTaskTiming({ blockDB: db, pool, timeZone: "America/New_York" });
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
  return { rows, timing, task, live, totalSec, db, hardDeleted, escaped, writeCount: () => writes, leaked: () => leaked };
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
  assert.equal(h.totalSec(), 3600);
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
  assert.equal(h.totalSec(), 3600);
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
  assert.equal(h.totalSec(), 1800, "clearTiming on the origin erased nothing");
  // It DOES hard-delete one row: the source's own tombstone, still sitting at
  // `from-slacktimer` after the move soft-deleted it. What matters is that the reach of
  // a delete keyed on the ORIGIN's id stops there and never touches the destination.
  assert.ok(h.hardDeleted.length > 0, "the pool stub really executes deleteTimerRow");
  assert.ok(
    h.hardDeleted.every((row) => (row.properties || {}).blockId !== "to"),
    "nothing clearTiming deleted belonged to the destination",
  );
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
  assert.equal(h.totalSec(), 1800);
});

test("a reconciled guess becomes a real measurement once a human places it", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({ actualMinutes: 45, actualMinutesFrom: "reconcile" }, { id: "to" });
  const entry = await trackedHour(h, from);
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], workspaceId: "ws-1" });
  assert.equal(to.properties.actualMinutes, 60);
  assert.equal(to.properties.actualMinutesFrom, undefined, "the derived flag is gone, so no read withdraws it");
  assert.equal(h.totalSec(), 3600);
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
  h.escaped.length = 0;
  await h.timing.reallocateTimeEntry({ entry: stayed, allocations, workspaceId: "ws-1" });
  assert.equal(h.live(other).length, 1);
  assert.equal(h.live(other)[0].id, created.id);
  assert.deepEqual(h.escaped, [], "the revive-and-overwrite path uses the transaction client too");
  // The ledger, not just the id: a revived row with the wrong durSec, or an extra row
  // on the origin, would satisfy both assertions above.
  assert.equal(h.totalSec(), 3600, "the tombstone was revived, not duplicated");
});

// ── the regressions the five-lane review found ───────────────────────────────

test("splitting an inferred window makes BOTH halves survive a reopen", async () => {
  const h = harness();
  const meeting = h.task({
    type: "meeting", start: "09:00", end: "10:00",
    plannedStartAt: "2026-08-20T13:00:00.000Z", plannedEndAt: "2026-08-20T14:00:00.000Z",
  }, { id: "meeting" });
  const real = h.task({}, { id: "real" });
  await h.timing.completeWork({ block: meeting, atMs: Date.parse("2026-08-20T14:05:00.000Z") });
  const inferred = h.live(meeting)[0];
  assert.equal(inferred.properties.inferenceReason, "meeting-planned-window");

  // The piece that STAYS is hand-placed too: its duration is one the user chose, so it
  // is no longer the planned-window guess. Gating the flag strip on `moved` left it
  // marked as inferred, and reopenWork deletes rows by exactly that field.
  await h.timing.reallocateTimeEntry({
    entry: inferred,
    allocations: [{ durSec: 1200, task: real }, { durSec: 2400, task: meeting }],
    workspaceId: "ws-1",
  });
  assert.equal(h.live(meeting)[0].properties.inferenceReason, undefined);
  assert.equal(h.live(real)[0].properties.inferenceReason, undefined);

  await h.timing.reopenWork({ block: meeting, atMs: Date.parse("2026-08-20T15:00:00.000Z") });
  assert.equal(meeting.properties.actualMinutes, 40, "the 40m that stayed survives the reopen");
  assert.equal(h.totalSec(), 3600);
});

test("moving every minute away does not let the reconciler re-invent them", async () => {
  const h = harness();
  // The shape reconcileTiming exists for: started, then checked off in the UI, so
  // completion lives in the day_root overlay and startedAt outlives it.
  const from = h.task({ startedAt: "2026-08-20T13:00:00.000Z" }, { id: "from" });
  const to = h.task({}, { id: "to" });
  const dayRoot = {
    id: "day-root-2026-08-20", type: "day_root", date: "2026-08-20",
    properties: { _done: { ids: ["from"], at: { from: "2026-08-20T13:30:00.000Z" } } },
    workspace_id: "ws-1", deleted_at: null,
  };
  h.rows.push(dayRoot);

  await h.timing.reconcileTiming([from, dayRoot], { userId: 1, workspaceId: "ws-1" });
  assert.equal(from.properties.actualMinutesFrom, "reconcile", "the reconciler derived a stamp");
  const derived = h.live(from)[0];
  assert.ok(derived, "and minted its segment");

  await h.timing.reallocateTimeEntry({ entry: derived, allocations: [{ durSec: derived.properties.durSec, task: to }], workspaceId: "ws-1" });
  assert.equal(from.properties.actualMinutes, undefined);
  assert.equal(from.properties.actualMinutesFrom, "reallocated", "the sentinel holds the reconciler off");
  const movedMinutes = to.properties.actualMinutes;

  // Deleting actualMinutesFrom outright would drop this row into the "startedAt with no
  // actualMinutes" branch and re-derive the very minutes that just moved.
  await h.timing.reconcileTiming([from, dayRoot], { userId: 1, workspaceId: "ws-1" });
  assert.equal(from.properties.actualMinutes, undefined, "no minutes re-invented on the origin");
  assert.equal(to.properties.actualMinutes, movedMinutes, "and the destination is untouched");
  assert.equal(h.live(from).length, 0, "no timer row re-minted either");

  // The timer on this row is still running (an overlay completion never cleared it),
  // so startWork answers "already-active" and writes nothing. Pausing is what gives
  // such a row real minutes again, and that is what has to retire the sentinel.
  await h.timing.pauseWork({ block: from, atMs: Date.parse("2026-08-20T14:00:00.000Z") });
  assert.equal(from.properties.actualMinutesFrom, undefined, "measured minutes retire the sentinel");
  assert.ok(Number(from.properties.actualMinutes) > 0);
});

test("a segment naming a task in another workspace cannot write to it", async () => {
  const h = harness();
  const mine = h.task({}, { id: "mine" });
  const theirs = h.task({ actualMinutes: 90, notes: "⏱ Took ~90m (their work)" }, { id: "theirs", workspaceId: "ws-other" });
  // properties.blockId is client-writable, so a segment owned by ws-1 can name a task
  // in ws-other. db.updateBlock carries no tenant predicate, so the store must fence.
  const entry = await trackedHour(h, mine);
  // Re-point the segment at the foreign task, and clear the stamp the pause left on
  // `mine`, so the fixture is a segment that only ever pointed at `theirs`.
  entry.properties.blockId = "theirs";
  delete mine.properties.actualMinutes;

  const touchedIds = [];
  const realUpdate = h.db.updateBlock.bind(h.db);
  h.db.updateBlock = async (id, patch, client) => { touchedIds.push(id); return realUpdate(id, patch, client); };

  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: mine }], workspaceId: "ws-1" });
  // The ABSENCE OF THE WRITE is the claim. Asserting only the value passed with the fence
  // deleted, because an unfenced foreign task has no priorTotals entry, so its minutes
  // were carried forward unchanged even though a cross-tenant UPDATE really went out.
  assert.ok(!touchedIds.includes("theirs"), "no UPDATE may be issued against another workspace's row");
  assert.equal(theirs.properties.actualMinutes, 90, "the other workspace's minutes are untouched");
  assert.match(theirs.properties.notes, /Took ~90m/, "and its note was not stripped");
  assert.equal(mine.properties.actualMinutes, 60);
});

test("a piece past local midnight lands on the day it happened", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  // One unsplit row spanning 23:30 to 00:30, which is what finalizeTiming writes for a
  // hourglass that crossed midnight and what Day Review's editor allows by hand.
  // trackedHour cannot produce it: writeLogicalSession already splits by local day.
  const entry = await h.db.createBlock({
    id: "crosses-midnight", type: "time_entry", date: "2026-08-20",
    properties: {
      blockId: "owner", taskTitle: "Work", durSec: 3600, source: "slack",
      startedAt: "2026-08-21T03:30:00.000Z", endedAt: "2026-08-21T04:30:00.000Z",
      start: "23:30", end: "00:30",
    },
    user_id: 1, workspace_id: "ws-1",
  });
  assert.equal(entry.date, "2026-08-20");

  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 1200, task: owner }, { durSec: 2400, task: other }], workspaceId: "ws-1",
  });
  assert.equal(h.totalSec(), 3600);
  // Every row's date must be the local day its OWN window falls in. Pinning each piece
  // to the source row's date put post-midnight minutes on the previous day, where Day
  // Review positions them by `start` and draws them ~23.5h off.
  for (const row of h.rows.filter((r) => r.type === "time_entry" && !r.deleted_at)) {
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(row.properties.startedAt));
    assert.equal(row.date, localDay, `row ${row.id} sits on ${row.date} but starts on ${localDay}`);
  }
  assert.ok(h.rows.some((r) => r.type === "time_entry" && !r.deleted_at && r.date === "2026-08-21"),
    "the minutes after midnight belong to the next day");
});

test("an unpositioned segment splits without smearing a stale clock", async () => {
  const h = harness();
  // A backlog task is dateless and a legal source: isWorkTaskRow admits kind backlog.
  const from = h.task({ kind: "backlog", startedAt: "2026-08-20T13:00:00.000Z" }, { id: "from", date: null });
  const to = h.task({}, { id: "to" });
  await h.timing.finalizeTiming({ block: from, endMs: Date.parse("2026-08-20T13:30:00.000Z"), userId: 1, workspaceId: "ws-1" });
  const entry = h.live(from)[0];
  assert.equal(entry.date, null);

  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 600, task: to }, { durSec: 1200, task: from }], workspaceId: "ws-1",
  });
  assert.equal(h.totalSec(), 1800);
  for (const row of [h.live(to)[0], h.live(from)[0]]) {
    assert.equal(row.properties.start, undefined, "an unpositioned piece carries no clock at all");
    assert.equal(row.properties.end, undefined);
    assert.equal(row.properties.startedAt, undefined);
  }
});

test("a manual segment keeps its naive-local shape instead of gaining an ISO stamp", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  // The shape day-review's editor writes: naive local start/end, no startedAt.
  const manual = await h.db.createBlock({
    id: "manual-1", type: "time_entry", date: "2026-08-20",
    properties: { blockId: "owner", taskTitle: "Work", start: "2026-08-20T09:00:00", end: "2026-08-20T10:00:00", durSec: 3600, source: "manual" },
    user_id: 1, workspace_id: "ws-1",
  });
  await h.timing.reallocateTimeEntry({
    entry: manual, allocations: [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }], workspaceId: "ws-1",
  });
  // entryWindow trusts startedAt first, so inventing one here would make a later
  // Day Review edit invisible: the editor spreads the old props forward.
  assert.equal(h.live(other)[0].properties.startedAt, undefined);
  assert.equal(h.live(owner)[0].properties.startedAt, undefined);
  assert.equal(h.live(other)[0].properties.start, "09:00");
  assert.equal(h.totalSec(), 3600);
});

test("a destination carrying minutes no segment explains does not lose them", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  // finalizeTiming stamps actualMinutes first and mints its segment in a try/catch it
  // labels non-fatal, so a row with minutes and no rows is a state the app produces.
  const legacy = h.task({ actualMinutes: 90 }, { id: "legacy" });
  const entry = await trackedHour(h, from, { minutes: 20 });

  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 1200, task: legacy }], workspaceId: "ws-1" });
  assert.equal(legacy.properties.actualMinutes, 110, "20m projected on top of 90m of unexplained history");
});

test("a whole move stamps the tombstone, so the route can still answer a replay", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({}, { id: "to" });
  const entry = await trackedHour(h, from);
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], actionId: "move-1", workspaceId: "ws-1" });

  const tombstone = h.rows.find((row) => row.id === entry.id);
  assert.ok(tombstone.deleted_at, "the source row is gone");
  assert.equal(tombstone.properties.reallocationOperationId, "move-1",
    "but it remembers the operation, so a retry reads as duplicate instead of 404");
  assert.ok(Array.isArray(tombstone.properties.movedToEntryIds) && tombstone.properties.movedToEntryIds.length);
});

test("a planted row at a derived id cannot absorb another workspace's segment", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  // Ids are client-suppliable (POST /api/blocks takes one), so a row can be sitting at
  // a derived id already. writeLogicalSession refuses that; so must this.
  const { reallocatedRowId } = createTaskTiming;
  const seed = allocations.map((part) => `${part.durSec}>${part.task.id}`).join("|");
  await h.db.createBlock({
    id: reallocatedRowId(entry, seed, "0.0"), type: "time_entry", date: "2026-08-20",
    properties: { blockId: "someone-elses-task", durSec: 1 }, user_id: 2, workspace_id: "ws-other",
  });
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({ entry, allocations, workspaceId: "ws-1" }),
    /identity collision/,
  );
});

// ── iteration 2 of the review: the failure windows the first fix left open ────

test("a retry converges even when a piece is a freshly created task", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const entry = await trackedHour(h, owner);

  // The route mints a new task per attempt, so a seed built from resolved destination ids
  // changed on every retry and orphaned the previous attempt's rows.
  const attempt = (destination) => [{ durSec: 1200, task: destination }, { durSec: 2400, task: owner }];
  const madeOne = h.task({}, { id: "made-1", title: "Typed title" });
  const realCreate = h.db.createBlock;
  let boom = true;
  // Forwards EVERY argument, client included. Dropping it made the harness (correctly)
  // refuse the write as having escaped the transaction.
  h.db.createBlock = async (...args) => { const row = await realCreate(...args); if (boom) { boom = false; throw new Error("db down"); } return row; };
  await assert.rejects(() => h.timing.reallocateTimeEntry({ entry, allocations: attempt(madeOne), actionId: "plan-1", workspaceId: "ws-1" }), /db down/);
  h.db.createBlock = realCreate;

  const madeTwo = h.task({}, { id: "made-2", title: "Typed title" });
  const source = h.rows.find((row) => row.id === entry.id);
  await h.timing.reallocateTimeEntry({ entry: source, allocations: attempt(madeTwo), actionId: "plan-1", workspaceId: "ws-1" });
  assert.equal(h.totalSec(), 3600, "the retry re-landed on the same rows instead of orphaning them");
});

test("an unfenced legacy task cannot be written by whoever names it", async () => {
  const h = harness();
  const mine = h.task({}, { id: "mine" });
  // A row with NO workspace passes the repo's usual `a && b && a !== b` fence, which
  // db.js createBlock calls out by name. Its owner is the only identity left.
  const legacy = h.task({ actualMinutes: 45 }, { id: "legacy", workspaceId: null });
  legacy.user_id = 999;
  const entry = await trackedHour(h, mine);
  entry.properties.blockId = "legacy";
  delete mine.properties.actualMinutes;

  const legacyTouched = [];
  const realLegacyUpdate = h.db.updateBlock.bind(h.db);
  h.db.updateBlock = async (id, patch, client) => { legacyTouched.push(id); return realLegacyUpdate(id, patch, client); };

  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: mine }], workspaceId: "ws-1" });
  assert.ok(!legacyTouched.includes("legacy"), "no UPDATE may be issued against an unfenced row owned by someone else");
  assert.equal(legacy.properties.actualMinutes, 45, "someone else's unfenced row is untouched");
  assert.equal(mine.properties.actualMinutes, 60);
});

test("per-day spans sum exactly to the window even off a sub-second boundary", () => {
  const { splitSessionByLocalDay } = createTaskTiming;
  const cases = [
    ["2026-08-21T03:59:59.600Z", 30_000],
    ["2026-08-21T03:59:59.600Z", 1_000],
    ["2026-08-21T03:30:00.000Z", 3_600_000],
    ["2026-08-20T13:00:00.000Z", 1_800_000],
  ];
  for (const [startIso, ms] of cases) {
    const startMs = Date.parse(startIso);
    const spans = splitSessionByLocalDay(startMs, startMs + ms, "America/New_York");
    const want = Math.round(ms / 1000);
    const have = spans.reduce((sum, span) => sum + span.durSec, 0);
    // Math.max(1, round) only rounds UP, so an unaligned boundary used to gain a second,
    // and the conservation guard runs before the split so it could never catch it.
    assert.equal(have, want, `${startIso} +${ms}ms produced ${have}s of spans for ${want}s`);
  }
});

// ── atomicity: the operation is one transaction, so a failure changes nothing ──
//
// Three review rounds found three different partial-failure windows in this mover while
// it was a sequence of writes: shrinking the source first LOST time, stamping the
// idempotency key before the tail INVENTED it and reported success, and a resume that
// read its own half-written state double-counted it. These tests exist to prove the
// windows are gone rather than moved, so each one fails at a DIFFERENT step and then
// asserts the same thing: the ledger is untouched and the retry is clean.

function failOnce(h, name, predicate) {
  const real = h.db[name].bind(h.db);
  let armed = true;
  h.db[name] = async (...args) => {
    if (armed && (!predicate || predicate(...args))) { armed = false; throw new Error("db down"); }
    return real(...args);
  };
  return () => { h.db[name] = real; };
}

for (const step of [
  // keepFirst puts the piece that STAYS first, so the create failure lands after a real
  // write and the rollback below has something to undo. Ordered the other way this step
  // threw before the first write and was the only one of the four that still passed with
  // ROLLBACK removed.
  { name: "a piece write", hook: ["createBlock"], keepFirst: true },
  { name: "the source write", hook: ["updateBlock", (id) => id === "seg-under-test"] },
  // The delete only runs when NOTHING stays on the origin, so this step needs a whole
  // move to reach it at all.
  { name: "the source delete", hook: ["deleteBlock"], whole: true },
  { name: "a projection", hook: ["updateBlock", (id) => id === "owner" || id === "other"] },
]) {
  test(`a failure at ${step.name} rolls the whole reallocation back`, async () => {
    const h = harness();
    const owner = h.task({}, { id: "owner" });
    const other = h.task({}, { id: "other" });
    const entry = await trackedHour(h, owner);
    // Rename so the source-write hook can target it precisely.
    entry.id = "seg-under-test";
    const before = JSON.stringify(h.rows);

    const allocations = step.whole
      ? [{ durSec: 3600, task: other }]
      : step.keepFirst
        ? [{ durSec: 2400, task: owner }, { durSec: 1200, task: other }]
        : [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
    const writesBefore = h.writeCount();
    // trackedHour's own startWork/pauseWork are not transactional, so drop their writes
    // before measuring what the reallocation does.
    h.escaped.length = 0;

    const restore = failOnce(h, step.hook[0], step.hook[1]);
    await assert.rejects(
      () => h.timing.reallocateTimeEntry({ entry, allocations, actionId: "attempt-1", workspaceId: "ws-1" }),
      /db down/,
    );
    restore();

    // Without this, a step that throws before its first write asserts nothing: there is
    // no state for the rollback to undo, so the comparison below is true either way.
    assert.ok(h.writeCount() > writesBefore,
      `${step.name} failed before writing anything, so its rollback assertion is vacuous`);
    assert.equal(JSON.stringify(h.rows), before, "the failed attempt changed nothing at all");
    assert.equal(h.totalSec(), 3600, "no time lost and none invented");
    const source = h.rows.find((row) => row.id === "seg-under-test");
    assert.equal(source.properties.reallocationOperationId, undefined,
      "and no replay stamp survived, so the retry is not answered as a duplicate");

    // The retry is a clean first attempt and lands exactly once.
    await h.timing.reallocateTimeEntry({ entry: source, allocations, actionId: "attempt-1", workspaceId: "ws-1" });
    assert.equal(h.totalSec(), 3600);
    assert.equal(owner.properties.actualMinutes, step.whole ? undefined : 40);
    assert.equal(other.properties.actualMinutes, step.whole ? 60 : 20);
    assert.deepEqual(h.escaped, [], "and every write went through the transaction client");
    assert.equal(h.leaked(), 0,
      "the connection must be ROLLBACKed before release, not handed back with the transaction open");
  });
}

test("a committed operation is answered, not re-applied, and answering is all it does", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  await h.timing.reallocateTimeEntry({ entry, allocations, actionId: "submit-1", workspaceId: "ws-1" });
  const after = JSON.stringify(h.rows);

  const replay = await h.timing.reallocateTimeEntry({
    entry: h.rows.find((row) => row.id === entry.id), allocations, actionId: "submit-1", workspaceId: "ws-1",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(JSON.stringify(h.rows), after, "a replay writes nothing whatsoever");
  assert.equal(h.totalSec(), 3600);
});

test("a whole move commits the stamp and the delete together", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({}, { id: "to" });
  const entry = await trackedHour(h, from);
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], actionId: "move-1", workspaceId: "ws-1" });

  const tombstone = h.rows.find((row) => row.id === entry.id);
  assert.ok(tombstone.deleted_at, "the source row is gone");
  assert.equal(tombstone.properties.reallocationOperationId, "move-1",
    "and it remembers the operation, so a retry reads as duplicate rather than 404");
  assert.equal(h.totalSec(), 3600);
  assert.equal(to.properties.actualMinutes, 60);
  assert.equal(from.properties.actualMinutes, undefined);
});

test("a destination created inside the transaction does not survive a rollback", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const entry = await trackedHour(h, owner);
  const restore = failOnce(h, "createBlock");
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({
      entry,
      allocations: [{ durSec: 1200, newTask: { properties: { title: "Typed title" } } }, { durSec: 2400, task: owner }],
      actionId: "plan-1", workspaceId: "ws-1",
    }),
    /db down/,
  );
  restore();
  // Creating the task outside the transaction left an orphan behind on every failure.
  assert.equal(h.rows.filter((row) => (row.properties || {}).title === "Typed title").length, 0,
    "no orphan task is left behind");
  assert.equal(h.totalSec(), 3600);
});

test("a chained reallocation does not inherit the previous operation's stamp", async () => {
  const h = harness();
  const a = h.task({}, { id: "a" });
  const b = h.task({}, { id: "b" });
  const c = h.task({}, { id: "c" });
  const entry = await trackedHour(h, a);

  // Split, then move the remainder. Ordinary behaviour, and the bookkeeping used to ride
  // forward on the property spread so the second operation answered for the first.
  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 1200, task: b }, { durSec: 2400, task: a }],
    actionId: "op-1", workspaceId: "ws-1",
  });
  const kept = h.live(a)[0];
  assert.equal(kept.properties.reallocationOperationId, "op-1");

  await h.timing.reallocateTimeEntry({
    entry: kept, allocations: [{ durSec: 2400, task: c }], actionId: "op-2", workspaceId: "ws-1",
  });
  assert.equal(h.totalSec(), 3600, "the chain conserves the original hour");
  assert.equal(a.properties.actualMinutes, undefined);
  assert.equal(b.properties.actualMinutes, 20);
  assert.equal(c.properties.actualMinutes, 40);
  // The moved piece starts clean: its predecessor's operation id is not its own.
  assert.equal(h.live(c)[0].properties.reallocationOperationId, undefined);
  assert.equal(h.live(b)[0].properties.reallocationOperationId, undefined);
});

test("a non-finite tracked length is refused at every layer, not silently accepted", () => {
  // durSec is client-writable, and "Infinity" is valid JSON that Number() coerces. Every
  // guard downstream used to be satisfied by it BY ACCIDENT: the conservation check
  // compares `Infinity !== Infinity`, which is false, and splitSessionByLocalDay returns
  // no spans for a non-finite window, so the infinite piece wrote nothing, nothing
  // "stayed" on the origin, and the source segment was deleted out from under it.
  for (const bad of ["Infinity", "-Infinity", "1e400", Infinity, NaN, "abc", null, undefined]) {
    assert.equal(planAllocations(bad, [{ minutes: 5 }, {}]).ok, false, `planAllocations accepted ${String(bad)}`);
    assert.equal(entryWindow({ date: "2026-08-20", properties: { durSec: bad, startedAt: "2026-08-20T13:00:00.000Z" } }).durSec, 0,
      `entryWindow measured a length for ${String(bad)}`);
  }
  // And a finite length still works, so the guard is not just refusing everything.
  assert.equal(planAllocations(3600, [{ minutes: 5 }, {}]).ok, true);
  assert.equal(entryWindow({ date: "2026-08-20", properties: { durSec: 3600, startedAt: "2026-08-20T13:00:00.000Z" } }).durSec, 3600);
});

test("the store refuses an infinite allocation even if a caller gets past the planner", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  entry.properties.durSec = "Infinity";
  const before = JSON.stringify(h.rows);
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({
      entry, allocations: [{ durSec: 300, task: other }, { durSec: Infinity, task: owner }], workspaceId: "ws-1",
    }),
    /conserve/,
  );
  assert.equal(JSON.stringify(h.rows), before, "and it rolls back rather than deleting the source");
});

test("a task whose Slack timer segment was moved away can still record new time", async () => {
  const h = harness();
  // Named `origin`, not `from`: the deploy workflow's DB-risk guardrail greps added lines
  // for /DELETE[[:space:]]+FROM/i, and `delete origin.properties.x` trips it as a false
  // positive that would then demand a [db-ok] tag on any future PR touching this file.
  const origin = h.task({ startedAt: "2026-08-20T13:00:00.000Z" }, { id: "from" });
  const to = h.task({}, { id: "to" });
  await h.timing.finalizeTiming({ block: origin, endMs: Date.parse("2026-08-20T13:25:00.000Z"), userId: 1, workspaceId: "ws-1" });
  const timerRow = h.live(origin)[0];
  assert.equal(timerRow.id, "from-slacktimer");

  await h.timing.reallocateTimeEntry({ entry: timerRow, allocations: [{ durSec: timerRow.properties.durSec, task: to }], actionId: "move-1", workspaceId: "ws-1" });
  // The source is SOFT-deleted, because the replay stamp the route answers off has to
  // survive on it. That leaves a tombstone at the deterministic `<taskId>-slacktimer` id,
  // and finalizeTiming's existence check is tombstone-inclusive.
  const tombstone = h.rows.find((row) => row.id === "from-slacktimer");
  assert.ok(tombstone.deleted_at);

  // A genuine new hourglass on the origin must still produce a segment.
  origin.properties.startedAt = "2026-08-21T13:00:00.000Z";
  delete origin.properties.actualMinutes;
  await h.timing.finalizeTiming({ block: origin, endMs: Date.parse("2026-08-21T13:30:00.000Z"), userId: 1, workspaceId: "ws-1" });
  assert.equal(origin.properties.actualMinutes, 30);
  assert.equal(h.live(origin).length, 1, "the tombstone was revived rather than swallowing the timer");
  assert.equal(h.live(origin)[0].properties.durSec, 1800, "and it carries the NEW measurement");
  assert.equal(h.live(to).length, 1, "the moved segment is untouched");
  assert.equal(to.properties.actualMinutes, 25);
});

test("two segments moving onto one task cannot corrupt its projection", async () => {
  // The segment lock does not serialize this: two DIFFERENT segments landing on one task
  // are a read-modify-write race, and the projection writes properties wholesale. Without
  // a task-level lock the second operation either lost the first's minutes (10) or read
  // them back as unaccounted and added them on top (30), and the 30 was sticky.
  const h = harness();
  const a = h.task({}, { id: "a" });
  const b = h.task({}, { id: "b" });
  const dest = h.task({}, { id: "dest" });
  const first = await trackedHour(h, a, { startIso: "2026-08-20T13:00:00.000Z", minutes: 10 });
  const second = await trackedHour(h, b, { startIso: "2026-08-20T15:00:00.000Z", minutes: 10 });

  let locks = [];
  const perOperation = [];
  const realLocked = h.db.getBlockIncludingDeleted.bind(h.db);
  h.db.getBlockIncludingDeleted = async (id, client, forUpdate) => {
    if (forUpdate) locks.push(id);
    return realLocked(id, client, forUpdate);
  };
  for (const entry of [first, second]) {
    locks = [];
    await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 600, task: dest }], workspaceId: "ws-1" });
    perOperation.push(locks);
  }

  assert.equal(dest.properties.actualMinutes, 20, "both moves are accounted for exactly once");
  assert.equal(h.live(dest).length, 2);
  assert.equal(h.totalSec(), 1200);
  for (const taken of perOperation) {
    // The destination task itself must be among the rows taken FOR UPDATE, or the
    // read-modify-write above is unprotected.
    assert.ok(taken.includes("dest"), "the destination task is locked, not just the segment");
    // And WITHIN one operation the task locks are taken in a stable order, so two
    // overlapping operations sharing tasks cannot deadlock each other.
    const taskLocks = taken.filter((id) => ["a", "b", "dest"].includes(id));
    assert.deepEqual(taskLocks, [...taskLocks].sort(), "task locks are acquired in sorted order");
  }
});

test("a pool that cannot open a transaction is refused, not silently degraded", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  // A harness missing `connect` would otherwise make every rollback assertion in this
  // file pass with nothing rolled back.
  const naive = createTaskTiming({ blockDB: h.db, pool: { query: async () => ({ rows: [] }) }, timeZone: "America/New_York" });
  await assert.rejects(
    () => naive.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: other }], workspaceId: "ws-1" }),
    /needs a pool that can open a transaction/,
  );
  assert.equal(h.totalSec(), 3600);
});

test("every ledger write in a reallocation runs on the transaction client", async () => {
  // A write that skips the client runs on the pool and survives a ROLLBACK, so this is
  // the one regression the fake transaction cannot catch on its own. Dropping `client`
  // from the mover's writes used to leave the whole suite green.
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const entry = await trackedHour(h, owner);
  h.escaped.length = 0;
  await h.timing.reallocateTimeEntry({
    entry,
    allocations: [{ durSec: 1200, newTask: { properties: { title: "New" } } }, { durSec: 2400, task: owner }],
    actionId: "op-1", workspaceId: "ws-1",
  });
  assert.deepEqual(h.escaped, [], "a write outside the transaction cannot be rolled back");
});

test("the whole-move shape keeps every write inside the transaction too", async () => {
  const h = harness();
  const from = h.task({}, { id: "from" });
  const to = h.task({}, { id: "to" });
  const entry = await trackedHour(h, from);
  h.escaped.length = 0;
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 3600, task: to }], actionId: "m-1", workspaceId: "ws-1" });
  assert.deepEqual(h.escaped, []);
});

test("the source segment is re-read under a row lock", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const locks = [];
  const real = h.db.getBlockIncludingDeleted.bind(h.db);
  h.db.getBlockIncludingDeleted = async (id, client, forUpdate) => { locks.push([id, !!forUpdate]); return real(id, client, forUpdate); };
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }], workspaceId: "ws-1" });
  assert.deepEqual(locks[0], [entry.id, true],
    "without FOR UPDATE two submissions race on one segment and both pass conservation");
});

test("a racer holding a pre-commit copy of the segment is answered, not re-applied", async () => {
  // The concurrent shape the in-transaction duplicate check exists for: request B was
  // built from a read taken before A committed, so B's own copy carries no stamp and only
  // the re-read under the lock can see it. Every other test hands in the same object that
  // lives in `rows`, so the pre-transaction check catches the replay first and this
  // branch is never reached.
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  const stale = { ...entry, properties: { ...entry.properties } };

  await h.timing.reallocateTimeEntry({ entry, allocations, actionId: "submit-1", workspaceId: "ws-1" });
  const after = JSON.stringify(h.rows);

  const replay = await h.timing.reallocateTimeEntry({ entry: stale, allocations, actionId: "submit-1", workspaceId: "ws-1" });
  assert.equal(replay.duplicate, true);
  assert.equal(JSON.stringify(h.rows), after, "the second racer wrote nothing");
  assert.equal(h.totalSec(), 3600);
});

test("a keep piece that changes local day moves its container with it", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  // A row whose `date` disagrees with its own window: filed on 08-19, started 23:30 on
  // 08-20. db.updateBlock leaves parent_id alone on a date change, so the mover has to.
  const entry = await h.db.createBlock({
    id: "misdated", type: "time_entry", date: "2026-08-19", parent_id: "day-root-2026-08-19",
    properties: {
      blockId: "owner", taskTitle: "Work", durSec: 3600,
      startedAt: "2026-08-21T03:30:00.000Z", endedAt: "2026-08-21T04:30:00.000Z", start: "23:30", end: "00:30",
    },
    user_id: 1, workspace_id: "ws-1",
  }, {});
  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 1200, task: owner }, { durSec: 2400, task: other }], workspaceId: "ws-1",
  });
  const kept = h.rows.find((row) => row.id === "misdated");
  assert.equal(kept.date, "2026-08-20");
  assert.equal(kept.parent_id, "day-root-2026-08-20", "the row must not stay in the previous day's container");
  assert.equal(h.totalSec(), 3600);
});

test("a piece spanning three local days conserves and dates every row", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  // 36h is the route's ceiling, and starting late in the evening it covers three days.
  const entry = await h.db.createBlock({
    id: "long-one", type: "time_entry", date: "2026-08-20",
    properties: {
      blockId: "owner", taskTitle: "Work", durSec: 36 * 3600, source: "slack",
      startedAt: "2026-08-21T02:00:00.000Z", endedAt: "2026-08-22T14:00:00.000Z", start: "22:00", end: "10:00",
    },
    user_id: 1, workspace_id: "ws-1",
  }, {});
  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 36 * 3600, task: other }], workspaceId: "ws-1",
  });
  const written = h.rows.filter((row) => row.type === "time_entry" && !row.deleted_at);
  assert.ok(written.length >= 3, `expected 3+ rows across local days, got ${written.length}`);
  assert.equal(h.totalSec(), 36 * 3600, "a multi-span piece still conserves exactly");
  for (const row of written) {
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(row.properties.startedAt));
    assert.equal(row.date, localDay, `row ${row.id} sits on ${row.date} but starts on ${localDay}`);
  }
});

test("a keep piece that straddles local midnight leaves its later day on a fresh row", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  // The `&& j === 0` half of the keep-row rule: only the FIRST span may reuse the source
  // id. Without it both spans write to the same id, the second overwrites the first, and
  // the minutes in between vanish. finalizeTiming writes exactly this shape for an
  // hourglass that spanned midnight.
  const entry = await h.db.createBlock({
    id: "straddle", type: "time_entry", date: "2026-08-20", parent_id: "day-root-2026-08-20",
    properties: {
      blockId: "owner", taskTitle: "Work", durSec: 3600,
      startedAt: "2026-08-21T03:40:00.000Z", endedAt: "2026-08-21T04:40:00.000Z", start: "23:40", end: "00:40",
    },
    user_id: 1, workspace_id: "ws-1",
  }, {});
  h.escaped.length = 0;
  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 2400, task: owner }, { durSec: 1200, task: other }], workspaceId: "ws-1",
  });
  assert.equal(h.totalSec(), 3600, "a multi-span keep piece must not overwrite its own first span");
  assert.equal(h.live(owner).reduce((sum, row) => sum + row.properties.durSec, 0), 2400);
  assert.deepEqual(h.escaped, []);
});

test("task locks are sorted even when the natural order is not", async () => {
  // The previous assertion compared the observed order against its own sort, and the
  // fixture's ids were already in order, so dropping `.sort()` from the mover survived.
  const h = harness();
  const origin = h.task({}, { id: "z-origin" });
  const dest = h.task({}, { id: "a-dest" });
  const entry = await trackedHour(h, origin, { minutes: 10 });
  const locks = [];
  const real = h.db.getBlockIncludingDeleted.bind(h.db);
  h.db.getBlockIncludingDeleted = async (id, client, forUpdate) => {
    if (forUpdate) locks.push(id);
    return real(id, client, forUpdate);
  };
  await h.timing.reallocateTimeEntry({ entry, allocations: [{ durSec: 600, task: dest }], workspaceId: "ws-1" });
  assert.deepEqual(locks.filter((id) => ["z-origin", "a-dest"].includes(id)), ["a-dest", "z-origin"],
    "two operations sharing tasks must acquire them in the same order or they can deadlock");
});

test("a planted row with NO workspace at a derived id fails closed too", async () => {
  // The code claims strict equality so an absent workspace fails CLOSED. The existing
  // test planted a FOREIGN workspace, which the repo's permissive fence would also catch.
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  const allocations = [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }];
  const { reallocatedRowId } = createTaskTiming;
  const seed = allocations.map((part) => `${part.durSec}>${part.task.id}`).join("|");
  await h.db.createBlock({
    id: reallocatedRowId(entry, seed, "0.0"), type: "time_entry", date: "2026-08-20",
    properties: { blockId: "someone-elses-task", durSec: 1 }, user_id: 2, workspace_id: null,
  }, {});
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({ entry, allocations, workspaceId: "ws-1" }),
    /identity collision/,
  );
  assert.equal(h.totalSec(), 3601, "and it rolled back");
});

test("a segment tombstoned between the caller's read and the lock is refused", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  // The caller's copy predates the delete, which is the whole point of re-reading under
  // the lock: neither pre-transaction check can see it.
  const stale = { ...entry, properties: { ...entry.properties } };
  await h.db.deleteBlock(entry.id);
  await assert.rejects(
    () => h.timing.reallocateTimeEntry({
      entry: stale, allocations: [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }], workspaceId: "ws-1",
    }),
    /Tracked time not found/,
  );
  assert.equal(h.totalSec(), 0, "a tombstoned segment must not be resurrected as new rows");
});

test("a committed reallocation closes its transaction cleanly", async () => {
  const h = harness();
  const owner = h.task({}, { id: "owner" });
  const other = h.task({}, { id: "other" });
  const entry = await trackedHour(h, owner);
  await h.timing.reallocateTimeEntry({
    entry, allocations: [{ durSec: 1200, task: other }, { durSec: 2400, task: owner }], workspaceId: "ws-1",
  });
  assert.equal(h.totalSec(), 3600);
  // Neither COMMIT nor ROLLBACK is optional: without the COMMIT pg discards the work, and
  // without either the connection returns to the pool still inside the transaction.
  assert.equal(h.leaked(), 0, "the connection was released with a transaction still open");
});
