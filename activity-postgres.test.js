const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express");
const M = require("./public/js/activity-model");
const { workout, meal } = require("./test-support/activity-fixtures");
const { createActivityDb } = require("./test-support/activity-db");
const { createActivityStore } = require("./activity-store");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
test("activity PostgreSQL persistence, recurrence, recovery and private HTTP boundaries", { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  const store = createActivityStore(ctx), owner = { userId: 1, workspaceId: "ws-1" };
  let created;
  await t.test("creates a normal all-day task with a separate canonical record", async () => {
    created = await store.create({ title: "Synthetic workout", date: "2026-10-06", record: workout() }, owner);
    const b = await ctx.blockDB.getBlock(created.taskId);
    assert.equal(b.properties.type, "workout"); assert.equal(b.properties.all_day, true); assert.equal(b.properties.all_day_end, "2026-10-07");
    assert.equal(b.properties.publicVisibility, "private"); assert.equal(b.properties.status, "open");
    assert.equal(b.properties.actual, undefined); assert.equal(b.properties.plan, undefined);
    assert.deepEqual((await store.get(created.taskId, owner)).record, M.validate(workout()));
    assert.equal((await store.list({ from: "2026-10-06", to: "2026-10-06" }, owner)).length, 1);
  });
  await t.test("owner/workspace scoping hides both task and record including forged writes", async () => {
    const foreign = { userId: 2, workspaceId: "ws-2" }, sameWorkspace = { userId: 2, workspaceId: "ws-1" };
    for (const attacker of [foreign, sameWorkspace]) {
      await assert.rejects(store.get(created.taskId, attacker), { statusCode: 404 });
      await assert.rejects(store.save(created.taskId, { expectedRevision: 1, record: workout() }, attacker), { statusCode: 404 });
      await assert.rejects(store.create({ title: "Copy", date: "2026-10-06", sourceId: created.taskId }, attacker), { statusCode: 404 });
      assert.equal((await store.list({ from: "2026-10-06", to: "2026-10-06" }, attacker)).length, 0);
    }
  });
  await t.test("optimistic revisions reject concurrent edits and undo restores the previous record", async () => {
    const edit = workout(); edit.actual.sets[0].reps = 8;
    const saved = await store.save(created.taskId, { record: edit, expectedRevision: 1 }, owner);
    assert.equal(saved.revision, 2);
    await assert.rejects(store.save(created.taskId, { record: workout(), expectedRevision: 1 }, owner), { statusCode: 409 });
    const undone = await store.change(created.taskId, { expectedRevision: 2 }, owner, "undo");
    assert.equal(undone.record.actual.sets[0].reps, 5); assert.equal(undone.revision, 3);
    const outcomes = await Promise.allSettled([store.save(created.taskId, { record: edit, expectedRevision: 3 }, owner), store.save(created.taskId, { record: workout(), expectedRevision: 3 }, owner)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(outcomes.find(r => r.status === "rejected").reason.statusCode, 409);
  });
  await t.test("archive, restore, and reuse preserve the old record and reset actuals in the new task", async () => {
    let r = await store.get(created.taskId, owner);
    r = await store.change(r.taskId, { expectedRevision: r.revision }, owner, "archive"); assert.equal(r.archived, true);
    assert.equal((await store.list({ from: "2026-10-06", to: "2026-10-06" }, owner)).length, 0);
    assert.equal((await store.list({ from: "2026-10-06", to: "2026-10-06", includeArchived: true }, owner)).length, 1);
    await assert.rejects(store.save(r.taskId, { expectedRevision: r.revision, record: workout() }, owner), { statusCode: 409 });
    r = await store.change(r.taskId, { expectedRevision: r.revision }, owner, "restore");
    const copy = await store.create({ title: "Reused workout", date: "2026-10-07", sourceId: r.taskId }, owner);
    assert.deepEqual(copy.record.plan, r.record.plan); assert.equal(M.hasActual(copy.record), false); assert.equal(copy.record.occurredOn, null);
  });
  await t.test("true moves and stale generic updates retain logs and private type", async () => {
    const before = await store.get(created.taskId, owner), b = await ctx.blockDB.getBlock(created.taskId);
    await ctx.blockDB.rescheduleBlocks([{ id: b.id, date: "2026-10-08", properties: { ...b.properties, type: "task", publicVisibility: "public", start: "09:00", end: "09:30", all_day: false } }], []);
    assert.equal((await ctx.blockDB.getBlock(b.id)).properties.type, "workout");
    assert.equal((await ctx.blockDB.getBlock(b.id)).properties.publicVisibility, "private");
    await ctx.blockDB.updateBlock(b.id, { properties: { ...b.properties, type: "task", publicVisibility: "public" } });
    const after = await store.get(b.id, owner), current = await ctx.blockDB.getBlock(b.id);
    assert.equal(after.date, "2026-10-08"); assert.deepEqual(after.record, before.record);
    assert.equal(current.properties.type, "workout"); assert.equal(current.properties.publicVisibility, "private");
    assert.equal((await store.list({ from: "2026-10-06", to: "2026-10-06" }, owner))[0].taskId, b.id);
  });
  await t.test("scheduled and readiness recurrence use saved plans with empty actuals", async () => {
    const makeStore = require("./responsibility-store");
    const repeat = makeStore({ blockDB: ctx.blockDB, getScheduleBlocks: async () => [], getTodayStr: () => "2026-10-06", assertBlockOwnership: (b, ws) => assert.equal(b.workspace_id, ws), appTimeZone: "UTC" });
    const definition = await repeat.upsertResponsibility({ ...owner, properties: { title: "Repeat workout", activityPlanSourceId: created.taskId,
      repeatType: "scheduled", scheduleRule: { version: 1, patternType: "calendar", timeZone: "UTC", startDate: "2026-10-07", frequency: "daily", interval: 1, times: ["09:00"], end: { type: "never" } } } });
    assert.equal(definition.properties.activityTaskType, "workout");
    const tasks = await repeat.materializeScheduledRepeatsForDate({ date: "2026-10-07", ...owner });
    assert.equal(tasks.length, 1);
    const record = await store.get(tasks[0].id, owner);
    assert.equal(M.hasActual(record.record), false); assert.equal(record.record.plan.exercises[0].sets[0].reps, 10);
    assert.equal(record.record.occurredOn, null); assert.equal(tasks[0].properties.type, "workout");
    assert.equal((await repeat.materializeScheduledRepeatsForDate({ date: "2026-10-07", ...owner })).length, 0, "materialization is idempotent");
    const props = makeStore.buildResponsibilityTaskProps(definition, { duration: 30, slot: 600, localId: "readiness-1" });
    const readiness = await ctx.blockDB.createItineraryTask({ date: "2026-10-09", properties: props, ...owner });
    assert.equal(M.hasActual((await store.get(readiness.id, owner)).record), false);
    // A series is its own plan snapshot, not a live dependency on its source task.
    let original = await store.get(created.taskId, owner);
    original = await store.change(original.taskId, { expectedRevision: original.revision }, owner, "archive");
    const split = await repeat.changeScheduledSeries({ id: definition.id, ...owner, action: "update", scope: "following",
      occurrenceKey: "2026-10-07T09:00", changes: { title: "Updated workout series" } });
    const plan = await require("./activity-store").readPlanSource(ctx.pool, split.newDefinitionId, owner.workspaceId, owner.userId);
    assert.deepEqual(plan.plan, record.record.plan); assert.equal(M.hasActual(plan), false);
    await store.change(original.taskId, { expectedRevision: original.revision }, owner, "restore");
  });
  await t.test("soft deletion and routine cleanup retain activity history, recovery restores the task", async () => {
    await ctx.blockDB.deleteBlock(created.taskId);
    assert.equal((await store.get(created.taskId, owner)).removed, true);
    await ctx.pool.query("UPDATE blocks SET deleted_at='2020-01-01' WHERE id=$1", [created.taskId]);
    await ctx.blockDB.purgeSoftDeleted(30);
    assert.ok(await ctx.blockDB.getBlockIncludingDeleted(created.taskId));
    await ctx.blockDB.undeleteBlock(created.taskId);
    assert.equal((await store.get(created.taskId, owner)).removed, false);
  });
  await t.test("sessionless, guest and cross-owner requests cannot read, export or mutate records", async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const user = Number(req.headers["x-test-session"]); if (user) { req.session = { userId: user }; req.workspaceId = user === 2 ? "ws-2" : "ws-1"; } next(); });
    require("./routes/activity")(app, { ...ctx, broadcast() {} });
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const base = "http://127.0.0.1:" + server.address().port;
      const url = "/api/activity?from=2026-10-06&to=2026-10-09";
      for (const path of [url, url.replace("activity?", "activity/export?"), "/api/activity/tasks/" + created.taskId]) {
        for (const [headers, status] of [[{ "x-user-id": "1", "x-workspace-id": "ws-1", Authorization: "Bearer fake-service" }, 401], [{ "x-test-session": "3" }, 403]]) {
          const r = await fetch(base + path, { headers }); assert.equal(r.status, status); assert.equal(r.headers.get("cache-control"), "private, no-store");
        }
      }
      const denied = await fetch(base + "/api/activity/tasks/" + created.taskId, { headers: { "x-test-session": "2" } }); assert.equal(denied.status, 404);
      const rejected = await fetch(base + "/api/activity/tasks/" + created.taskId, { method: "PUT", headers: { "x-test-session": "3", "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, record: workout() }) }); assert.equal(rejected.status, 403);
      const json = await fetch(base + url.replace("activity?", "activity/export?"), { headers: { "x-test-session": "1" } }); assert.equal(json.status, 200); assert.ok((await json.json()).records.length);
      const invalid = await fetch(base + "/api/activity?from=2026-02-30&to=2026-03-01", { headers: { "x-test-session": "1" } }); assert.equal(invalid.status, 400);
      await store.create({ title: "Partial fixture meal", date: "2026-10-06", record: meal() }, owner);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
