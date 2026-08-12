const test = require("node:test");
const assert = require("node:assert/strict");
const createResponsibilityStore = require("./responsibility-store");

function scheduleRule(overrides = {}) {
  return {
    version: 1,
    patternType: "calendar",
    timeZone: "America/New_York",
    startDate: "2026-07-11",
    frequency: "daily",
    interval: 1,
    times: ["09:00", "17:00"],
    end: { type: "never" },
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    id: overrides.id || "series-1",
    workspace_id: "ws-1",
    properties: {
      kind: "responsibility_item",
      repeatType: "scheduled",
      title: "Take medicine",
      slug: "take-medicine",
      estimatedMinutes: 10,
      status: "active",
      scheduleRule: scheduleRule(),
      ...overrides.properties,
    },
  };
}

function fakeDb(seed = {}) {
  const definitions = new Map((seed.definitions || [definition()]).map((row) => [row.id, row]));
  const generated = [...(seed.generated || [])];
  const calls = { identity: [], createTrees: [], batch: [], locks: [], clients: [] };
  const txClient = { tx: true };
  const db = {
    calls,
    definitions,
    generated,
    async withRepeatSeriesLock(id, workspaceId, work) { calls.locks.push([id, workspaceId]); return work(txClient); },
    async getResponsibilityBlocks() { return [...definitions.values()].filter((row) => !row.deleted_at); },
    async getBlocksByIdempotencyKeys(_workspaceId, keys, client) {
      calls.clients.push(client);
      calls.identity.push(keys);
      return generated.filter((row) => keys.includes((row.properties || {}).idempotency_key));
    },
    async createItineraryTasks(rows, _opts, client) {
      calls.clients.push(client);
      calls.createTrees.push(rows);
      if (seed.createError) throw seed.createError;
      const created = rows.map((row) => ({ ...row, id: row.id, workspace_id: "ws-1" }));
      generated.push(...created);
      return created;
    },
    isIdempotencyConflict(error) { return error && error.code === "23505"; },
    async getBlock(id, client) {
      calls.clients.push(client);
      return definitions.get(id) || generated.find((row) => row.id === id) || null;
    },
    async updateBlock(id, changes, client) {
      calls.clients.push(client);
      const row = definitions.get(id) || generated.find((item) => item.id === id);
      if (!row) return null;
      if (changes.properties) row.properties = changes.properties;
      if (changes.date) row.date = changes.date;
      return row;
    },
    async getRepeatSeriesBlocks(seriesId, _workspaceId, _opts, client) {
      calls.clients.push(client);
      return generated.filter((row) => (row.properties || {}).repeatSeriesId === seriesId && !row.deleted_at);
    },
    async batchOp(ops, client) {
      calls.clients.push(client);
      calls.batch.push(ops);
      const blocks = [];
      for (const op of ops) {
        if (op.op === "delete") {
          const row = definitions.get(op.id) || generated.find((item) => item.id === op.id);
          if (row) row.deleted_at = "2026-07-11T12:00:00.000Z";
          blocks.push(row || { id: op.id, deleted_at: true });
        } else if (op.op === "update") {
          const row = definitions.get(op.id) || generated.find((item) => item.id === op.id);
          if (row) {
            if (op.properties) row.properties = op.properties;
            if (op.date) row.date = op.date;
          }
          blocks.push(row || { id: op.id });
        } else if (op.op === "create") {
          const row = { id: op.id, type: op.type, date: op.date, workspace_id: op.workspace_id, properties: op.properties };
          definitions.set(row.id, row);
          blocks.push(row);
        }
      }
      return { batchId: "batch-1", blocks };
    },
    async findResponsibilityBySlug() { return null; },
  };
  return db;
}

function store(db) {
  return createResponsibilityStore({
    blockDB: db,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-07-11",
    assertBlockOwnership: () => {},
    appTimeZone: "America/New_York",
  });
}

function occurrenceRow(key, overrides = {}) {
  const id = overrides.id || `row-${key.replace(/\W/g, "")}`;
  return {
    id,
    date: overrides.date || key.slice(0, 10),
    properties: {
      kind: "scheduled_repeat_task",
      repeatMode: "scheduled",
      repeatSeriesId: "series-1",
      repeatOccurrenceKey: key,
      repeatOccurrenceRootId: overrides.rootId || id,
      idempotency_key: `repeat:series-1:${key}`,
      local_id: overrides.localId || id,
      title: "Take medicine",
      start: key.slice(11),
      end: key.slice(11),
      status: overrides.status || "open",
      completedAt: overrides.completedAt || null,
      ...overrides.properties,
    },
  };
}

test("day materialization creates every matching time with exact overlap-friendly placement", async () => {
  const db = fakeDb();
  const created = await store(db).materializeScheduledRepeatsForDate({
    date: "2026-07-11", userId: "u1", workspaceId: "ws-1",
  });
  assert.equal(created.length, 8);
  assert.equal(db.calls.identity.length, 1, "all occurrence keys are looked up in one query");
  assert.equal(db.calls.createTrees.length, 1, "the whole day is inserted atomically");
  assert.ok(db.calls.clients.filter(Boolean).every((client) => client.tx), "protected reads and writes share the lock transaction");
  const rows = db.calls.createTrees[0];
  const roots = rows.filter((row) => (row.properties || {}).idempotency_key);
  assert.deepEqual(roots.map((row) => row.properties.start), ["09:00", "17:00"]);
  assert.deepEqual(roots.map((row) => row.properties.repeatOccurrenceKey), ["2026-07-11T09:00", "2026-07-11T17:00"]);
  assert.ok(rows.every((row) => row.properties.repeatMode === "scheduled"));
  for (const root of roots) {
    const children = rows.filter((row) => row.parent_id === root.id);
    assert.equal(children.length, 3);
    assert.ok(children.every((row) => row.properties.subtaskOf === root.properties.local_id));
    assert.ok(children.every((row) => row.properties.start === root.properties.start));
  }
});

test("repeated loads are idempotent and a tombstone is an intentional skip", async () => {
  const tombstone = occurrenceRow("2026-07-11T09:00");
  tombstone.deleted_at = "2026-07-11T10:00:00.000Z";
  const db = fakeDb({ generated: [tombstone] });
  await store(db).materializeScheduledRepeatsForDate({ date: "2026-07-11", workspaceId: "ws-1" });
  assert.equal(db.calls.createTrees[0].length, 4);
  assert.equal(db.calls.createTrees[0][0].properties.repeatOccurrenceKey, "2026-07-11T17:00");
  await store(db).materializeScheduledRepeatsForDate({ date: "2026-07-11", workspaceId: "ws-1" });
  assert.equal(db.calls.createTrees.length, 1, "neither live nor soft-deleted occurrences are recreated");
});

test("an unfinished older occurrence never blocks the next scheduled occurrence", async () => {
  const olderOpen = occurrenceRow("2026-07-10T09:00");
  const db = fakeDb({ generated: [olderOpen] });
  const created = await store(db).materializeScheduledRepeatsForDate({ date: "2026-07-11", workspaceId: "ws-1" });
  const roots = created.filter((row) => (row.properties || {}).idempotency_key);
  assert.deepEqual(roots.map((row) => row.properties.repeatOccurrenceKey), ["2026-07-11T09:00", "2026-07-11T17:00"]);
  assert.equal(olderOpen.properties.status, "open");
});

test("past dates never backfill and a concurrent idempotency loser is harmless", async () => {
  const pastDb = fakeDb();
  assert.deepEqual(await store(pastDb).materializeScheduledRepeatsForDate({ date: "2026-07-10", workspaceId: "ws-1" }), []);
  assert.equal(pastDb.calls.identity.length, 0);

  const conflict = Object.assign(new Error("duplicate"), { code: "23505" });
  const racingDb = fakeDb({ createError: conflict });
  assert.deepEqual(await store(racingDb).materializeScheduledRepeatsForDate({ date: "2026-07-11", workspaceId: "ws-1" }), []);
});

test("shell templates create one complete tree in one materialization transaction", async () => {
  const shell = definition({ properties: {
    templateTree: { version: 1, root: {
      title: "Morning routine", type: "shell", children: [
        { title: "Open report", edge: "wrap", durationMin: 15 },
        { title: "Record result", edge: "subtask", durationMin: 5 },
      ],
    } },
    scheduleRule: scheduleRule({ times: ["09:00"] }),
  } });
  const db = fakeDb({ definitions: [shell] });
  await store(db).materializeScheduledRepeatsForDate({ date: "2026-07-11", workspaceId: "ws-1" });
  assert.equal(db.calls.createTrees.length, 1);
  const rows = db.calls.createTrees[0];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].properties.type, "shell");
  assert.equal(rows[1].parent_id, rows[0].id);
  assert.equal(rows[2].parent_id, rows[0].id);
  assert.ok(rows.every((row) => row.properties.repeatOccurrenceKey === "2026-07-11T09:00"));
});

test("occurrence delete removes its complete generated tree without touching the definition", async () => {
  const root = occurrenceRow("2026-07-11T09:00", { id: "root-1" });
  const child = occurrenceRow("2026-07-11T09:00", { id: "child-1", rootId: "root-1", properties: { idempotency_key: null } });
  const db = fakeDb({ generated: [root, child] });
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "delete", scope: "occurrence",
    occurrenceKey: "2026-07-11T09:00", blockId: "root-1",
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(db.calls.batch[0].map((op) => op.id).sort(), ["child-1", "root-1"]);
  assert.equal(db.definitions.get("series-1").deleted_at, undefined);
});

test("series delete preserves completed and historical rows while removing open future work", async () => {
  const past = occurrenceRow("2026-07-10T09:00");
  const completed = occurrenceRow("2026-07-11T09:00", { status: "done", completedAt: "2026-07-11T14:00:00.000Z" });
  const openFuture = occurrenceRow("2026-07-12T09:00");
  const db = fakeDb({ generated: [past, completed, openFuture] });
  await store(db).changeScheduledSeries({ id: "series-1", workspaceId: "ws-1", action: "delete", scope: "series" });
  const deletedIds = db.calls.batch[0].filter((op) => op.op === "delete").map((op) => op.id);
  assert.ok(deletedIds.includes("series-1"));
  assert.ok(deletedIds.includes(openFuture.id));
  assert.ok(!deletedIds.includes(past.id));
  assert.ok(!deletedIds.includes(completed.id));
});

test("following update truncates the original and creates a new series at the selected local key", async () => {
  const selected = occurrenceRow("2026-07-12T09:00");
  const db = fakeDb({ generated: [selected] });
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", userId: "u1", action: "update", scope: "following",
    occurrenceKey: "2026-07-12T09:00",
    changes: { title: "Take vitamins", scheduleRule: scheduleRule({ times: ["08:00"] }) },
  });
  const ops = db.calls.batch[0];
  const truncate = ops.find((op) => op.op === "update" && op.id === "series-1");
  const clone = ops.find((op) => op.op === "create");
  assert.equal(truncate.properties.scheduleRule.effectiveUntil, "2026-07-12T09:00");
  assert.equal(clone.properties.scheduleRule.effectiveFrom, "2026-07-12T08:00");
  assert.equal(clone.properties.repeatIdentityId, "series-1");
  assert.equal(clone.properties.title, "Take vitamins");
  assert.equal(result.newDefinitionId, clone.id);
});

test("catch-up creates every missed occurrence through today and advances its durable cursor", async () => {
  const missed = definition({ properties: {
    materializedThrough: "2026-07-09",
    scheduleRule: scheduleRule({ startDate: "2026-07-10" }),
  } });
  const db = fakeDb({ definitions: [missed] });
  const created = await store(db).catchUpScheduledRepeats({ workspaceId: "ws-1", throughDate: "2026-07-11" });
  const roots = created.filter((row) => (row.properties || {}).idempotency_key);
  assert.deepEqual(roots.map((row) => row.properties.repeatOccurrenceKey), [
    "2026-07-10T09:00", "2026-07-10T17:00", "2026-07-11T09:00", "2026-07-11T17:00",
  ]);
  assert.equal(db.definitions.get("series-1").properties.materializedThrough, "2026-07-11");
  assert.equal(db.calls.locks.length, 1);
});

test("a following split keeps the lineage key so a completed occurrence is never duplicated", async () => {
  const completed = occurrenceRow("2026-07-12T09:00", { status: "done", completedAt: "2026-07-12T14:00:00.000Z" });
  const db = fakeDb({ generated: [completed] });
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", userId: "u1", action: "update", scope: "following",
    occurrenceKey: "2026-07-12T09:00", changes: { title: "Take medicine later", scheduleRule: scheduleRule({ times: ["09:00"] }) },
  });
  await store(db).materializeScheduledRepeatsForDate({ date: "2026-07-12", workspaceId: "ws-1" });
  const sameOccurrence = db.generated.filter((row) => (row.properties || {}).repeatOccurrenceKey === "2026-07-12T09:00"
    && (row.properties || {}).idempotency_key);
  assert.equal(sameOccurrence.length, 1);
  assert.equal((db.definitions.get(result.newDefinitionId).properties || {}).repeatIdentityId, "series-1");
});

test("following split allows an earlier time on the selected day", async () => {
  const selected = occurrenceRow("2026-07-12T17:00");
  const db = fakeDb({ generated: [selected] });
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", userId: "u1", action: "update", scope: "following",
    occurrenceKey: "2026-07-12T17:00", changes: { scheduleRule: scheduleRule({ times: ["08:00"] }) },
  });
  const next = db.definitions.get(result.newDefinitionId);
  assert.equal(next.properties.scheduleRule.effectiveFrom, "2026-07-12T08:00");
  assert.deepEqual(createResponsibilityStore.scheduledRecurrence.occurrencesForDate(next.properties.scheduleRule, "2026-07-12")
    .map((item) => item.start), ["08:00"]);
});

test("occurrence edits reject invalid clocks, unbounded duration, and midnight crossing", async () => {
  const root = occurrenceRow("2026-07-11T23:00", { id: "root-late", properties: { duration: 30 } });
  const db = fakeDb({ generated: [root] });
  const base = { id: "series-1", workspaceId: "ws-1", action: "update", scope: "occurrence", occurrenceKey: "2026-07-11T23:00", blockId: "root-late" };
  await assert.rejects(store(db).changeScheduledSeries({ ...base, changes: { task: { start: "99:99" } } }), /Start time/);
  await assert.rejects(store(db).changeScheduledSeries({ ...base, changes: { task: { durationMinutes: Infinity } } }), /Duration/);
  await assert.rejects(store(db).changeScheduledSeries({ ...base, changes: { task: { start: "23:30", durationMinutes: 60 } } }), /cross midnight/);
});

test("following title edits replace superseded tombstones instead of losing open occurrences", async () => {
  const selected = occurrenceRow("2026-07-12T09:00");
  const db = fakeDb({ generated: [selected] });
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", userId: "u1", action: "update", scope: "following",
    occurrenceKey: "2026-07-12T09:00", changes: { title: "Take vitamins" },
  });
  const old = db.generated.find((row) => row.id === selected.id);
  assert.equal(old.properties.recurrenceSupersededBy, result.newDefinitionId);
  const liveRoots = db.generated.filter((row) => !row.deleted_at && (row.properties || {}).idempotency_key
    && (row.properties || {}).repeatOccurrenceKey === "2026-07-12T09:00");
  assert.equal(liveRoots.length, 1);
  assert.equal(liveRoots[0].properties.title, "Take vitamins");
});

test("following split maps the selected occurrence ordinal and preserves remaining after-count", async () => {
  const selected = occurrenceRow("2026-07-12T17:00");
  const db = fakeDb({ generated: [selected] });
  const oldRule = scheduleRule({ end: { type: "after", count: 10 } });
  db.definitions.get("series-1").properties.scheduleRule = oldRule;
  const result = await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", userId: "u1", action: "update", scope: "following",
    occurrenceKey: "2026-07-12T17:00",
    changes: { scheduleRule: scheduleRule({ times: ["08:00", "12:00", "18:00"], end: { type: "after", count: 10 } }) },
  });
  const next = db.definitions.get(result.newDefinitionId).properties.scheduleRule;
  assert.equal(next.effectiveFrom, "2026-07-12T12:00");
  assert.deepEqual(createResponsibilityStore.scheduledRecurrence.occurrencesForDate(next, "2026-07-12").map((item) => item.start), ["12:00", "18:00"]);
  assert.ok(next.end.count < 10);
});

test("scheduled shell definitions validate their full timed tree before saving", async () => {
  const db = fakeDb({ definitions: [] });
  await assert.rejects(store(db).upsertResponsibility({
    workspaceId: "ws-1", properties: {
      title: "Late routine", repeatType: "scheduled", estimatedMinutes: 5,
      scheduleRule: scheduleRule({ times: ["23:30"] }),
      templateTree: { version: 1, root: { title: "Late routine", type: "shell", children: [
        { title: "Long step", edge: "wrap", durationMin: 45 },
      ] } },
    },
  }), /cross midnight/);
});

test("scheduled to readiness conversion updates the definition and cleans open work in one batch", async () => {
  const open = occurrenceRow("2026-07-11T09:00");
  const db = fakeDb({ generated: [open] });
  const updated = await store(db).convertScheduledToReadiness({ id: "series-1", workspaceId: "ws-1", changes: { cadence: "weekly" } });
  assert.equal(updated.id, "series-1");
  assert.equal(updated.properties.repeatType, "readiness");
  assert.equal(updated.properties.scheduleRule, undefined);
  assert.equal(db.calls.batch.length, 1);
  assert.ok(db.calls.batch[0].some((op) => op.op === "update" && op.id === "series-1"));
  assert.ok(db.calls.batch[0].some((op) => op.op === "delete" && op.id === open.id));
});

test("whole-series edits validate shell bounds before updating the definition", async () => {
  const db = fakeDb();
  await assert.rejects(store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "update", scope: "series",
    changes: {
      scheduleRule: scheduleRule({ times: ["23:30"] }),
      templateTree: { version: 1, root: { title: "Late routine", type: "shell", children: [
        { title: "Long step", edge: "wrap", durationMin: 45 },
      ] } },
    },
  }), /cross midnight/);
  assert.equal(db.calls.batch.length, 0);
});

test("whole-series time-zone edits refresh occurrence instant and zone metadata", async () => {
  const root = occurrenceRow("2026-07-11T09:00", { properties: {
    repeatOccurrenceInstant: "2026-07-11T13:00:00.000Z", repeatTimeZone: "America/New_York",
  } });
  const db = fakeDb({ generated: [root] });
  await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "update", scope: "series",
    changes: { scheduleRule: scheduleRule({ timeZone: "America/Los_Angeles" }) },
  });
  assert.equal(root.properties.repeatTimeZone, "America/Los_Angeles");
  assert.equal(root.properties.repeatOccurrenceInstant, "2026-07-11T16:00:00.000Z");
});

test("following edit replaces an elevated overdue occurrence on its current itinerary date", async () => {
  const overdue = occurrenceRow("2026-07-10T09:00", { date: "2026-07-11" });
  const def = definition({ properties: { scheduleRule: scheduleRule({ startDate: "2026-07-10", times: ["09:00"] }) } });
  const db = fakeDb({ definitions: [def], generated: [overdue] });
  await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "update", scope: "following",
    occurrenceKey: "2026-07-10T09:00", changes: { title: "Take vitamins" },
  });
  const replacement = db.generated.find((row) => !row.deleted_at && (row.properties || {}).idempotency_key
    && (row.properties || {}).repeatOccurrenceKey === "2026-07-10T09:00");
  assert.ok(replacement);
  assert.equal(replacement.date, "2026-07-11");
  assert.equal(replacement.properties.title, "Take vitamins");
});

test("following edit replaces a cross-zone overdue occurrence on its displayed date", async () => {
  const key = "2026-07-10T23:30";
  const overdue = occurrenceRow(key, { date: "2026-07-11", properties: {
    start: "02:30", end: "02:40", repeatOccurrenceInstant: "2026-07-11T06:30:00.000Z", repeatTimeZone: "America/Los_Angeles",
  } });
  const def = definition({ properties: { scheduleRule: scheduleRule({
    startDate: "2026-07-10", times: ["23:30"], timeZone: "America/Los_Angeles",
  }) } });
  const db = fakeDb({ definitions: [def], generated: [overdue] });
  await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "update", scope: "following",
    occurrenceKey: key, changes: { title: "Take vitamins" },
  });
  const replacement = db.generated.find((row) => !row.deleted_at && (row.properties || {}).idempotency_key
    && (row.properties || {}).repeatOccurrenceKey === key);
  assert.ok(replacement);
  assert.equal(replacement.date, "2026-07-11");
  assert.equal(replacement.properties.title, "Take vitamins");
});

test("following edit preserves separate itinerary dates for same-day occurrences", async () => {
  const morning = occurrenceRow("2026-07-10T09:00", { id: "morning", date: "2026-07-11" });
  const evening = occurrenceRow("2026-07-10T17:00", { id: "evening", date: "2026-07-12" });
  const def = definition({ properties: { scheduleRule: scheduleRule({ startDate: "2026-07-10" }) } });
  const db = fakeDb({ definitions: [def], generated: [morning, evening] });
  await store(db).changeScheduledSeries({
    id: "series-1", workspaceId: "ws-1", action: "update", scope: "following",
    occurrenceKey: "2026-07-10T09:00", changes: { title: "Take vitamins" },
  });
  const live = db.generated.filter((row) => !row.deleted_at && (row.properties || {}).idempotency_key);
  assert.equal(live.find((row) => row.properties.repeatOccurrenceKey === "2026-07-10T09:00").date, "2026-07-11");
  assert.equal(live.find((row) => row.properties.repeatOccurrenceKey === "2026-07-10T17:00").date, "2026-07-12");
});
