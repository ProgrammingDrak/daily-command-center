const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const M = require('./public/js/activity-model');
const W = require('./public/js/workout-model');
const { createActivityDb } = require('./test-support/activity-db');
const { workout, meal } = require('./test-support/activity-fixtures');
const { createActivityStore, SCHEMA_SQL } = require('./activity-store');
const { createWorkoutLibrary } = require('./workout-library-store');
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
const owner = { userId: 1, workspaceId: 'ws-1' };
const foreign = { userId: 2, workspaceId: 'ws-2' };
const sameWorkspace = { userId: 2, workspaceId: 'ws-1' };
const date = '2026-10-13';
const clone = value => structuredClone(value);

function plan(catalogId = 'bench-press') {
  const record = W.empty();
  record.plan.exercises = [
    { id: 'entry-early', catalogExerciseId: catalogId, name: 'Bench Press', sets: [{ id: 'target-early', round: 1, reps: 8, weight: 135, unit: 'lb', seconds: null, loadMode: 'total', repsMode: 'total' }] },
    { id: 'entry-later', catalogExerciseId: catalogId, name: 'Bench Press', sets: [{ id: 'target-later', round: 1, reps: 5, weight: 60, unit: 'kg', seconds: null, loadMode: 'total', repsMode: 'total' }] },
  ];
  record.plan.groups = [
    { id: 'group-early', kind: 'single', rounds: 1, exerciseIds: ['entry-early'] },
    { id: 'group-later', kind: 'single', rounds: 1, exerciseIds: ['entry-later'] },
  ];
  return W.validate(record);
}
function start(record) { return W.action(record, { id: 'event-start', type: 'start', at: date + 'T10:00:00.000Z' }); }
function log(record) {
  const value = clone(record);
  value.actual.sets.push({ id: 'logged-1', exerciseId: 'entry-early', planSetId: 'target-early', round: 1, status: 'logged', loggedAt: date + 'T10:02:00.000Z', reps: 0, weight: 135, unit: 'lb', seconds: null, loadMode: 'total', repsMode: 'total' },
    { id: 'logged-2', exerciseId: 'entry-early', planSetId: 'target-early', round: 1, status: 'logged', loggedAt: date + 'T10:03:00.000Z', reps: 6, weight: 135, unit: 'lb', seconds: null, loadMode: 'total', repsMode: 'total' });
  value.occurredOn = date;
  return W.validate(value);
}

test('workout planner private PostgreSQL contracts', { skip: !configured }, async t => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  const store = createActivityStore(ctx), library = createWorkoutLibrary(ctx);
  const make = (record = plan(), title = 'Synthetic planner') => store.create({ title, date, record }, owner);
  const templateBody = (extra = {}) => ({ title: 'Strength A', collection: 'Strength Training', variant: 'Heavy', plan: plan().plan, ...extra });

  await t.test('additive schema can run twice without rewriting v1 records', async () => {
    const legacy = await make(workout(date), 'Legacy unchanged');
    await ctx.pool.query(SCHEMA_SQL); await ctx.pool.query(SCHEMA_SQL);
    assert.deepEqual((await store.get(legacy.taskId, owner)).record, M.validate(workout(date)));
    const tables = (await ctx.pool.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('workout_templates','workout_exercises','task_activity_records')")).rows;
    assert.equal(tables.length, 3);
  });

  await t.test('catalog has canonical built-ins and deliberate owner-scoped custom identities', async () => {
    const builtins = await library.catalog(owner);
    assert.deepEqual(builtins.map(e => [e.id, e.name]), [['bench-press', 'Bench Press'], ['dumbbell-curls', 'Dumbbell Curls'], ['overhead-barbell-press', 'Overhead Barbell Press']]);
    await assert.rejects(library.createExercise({ name: 'Bench Press' }, owner), { statusCode: 409 });
    const custom = await library.createExercise({ name: '  My Cable Row  ', loadMode: 'total' }, owner);
    const retry = await library.createExercise({ name: 'my   cable row', loadMode: 'total' }, owner);
    assert.equal(retry.id, custom.id); assert.equal(custom.name, 'My Cable Row');
    assert.equal((await library.catalog(foreign)).some(e => e.id === custom.id), false);
    const other = await library.createExercise({ name: 'My Cable Row' }, foreign);
    assert.notEqual(other.id, custom.id);
    for (const attacker of [foreign, sameWorkspace]) {
      await assert.rejects(library.save(templateBody({ plan: plan(custom.id).plan }), attacker), { statusCode: 404 });
      await assert.rejects(store.create({ title: 'Forged custom', date, record: plan(custom.id) }, attacker), { statusCode: 404 });
    }
  });

  await t.test('templates detach plans and keep collection, variant and revision provenance stable', async () => {
    const template = await library.save(templateBody(), owner);
    const session = await store.create({ title: 'Detached workout', date, templateId: template.id }, owner);
    assert.deepEqual(session.record.plan, template.plan); assert.deepEqual(session.record.actual, { sets: [], runs: [] });
    assert.equal(session.record.baseline, null); assert.deepEqual(session.record.session.events, []);
    assert.deepEqual(session.record.provenance, { templateId: template.id, templateRevision: 1, templateName: template.title, collection: template.collection, variant: template.variant });
    const edited = clone(session.record); edited.plan.exercises[0].sets[0].weight = 140;
    const changedSession = await store.save(session.taskId, { record: edited, expectedRevision: 1 }, owner);
    assert.equal((await library.get(template.id, owner)).plan.exercises[0].sets[0].weight, 135);
    const next = await library.save(templateBody({ title: 'Strength B', variant: 'Light', plan: changedSession.record.plan, sourceTemplateId: template.id, sourceSessionId: session.taskId }), owner);
    assert.notEqual(next.id, template.id); assert.equal(next.sourceTemplateId, template.id); assert.equal(next.sourceSessionId, session.taskId);
    const updatePlan = clone(template.plan); updatePlan.exercises[0].sets[0].reps = 12;
    const updated = await library.save(templateBody({ expectedRevision: 1, plan: updatePlan }), owner, template.id);
    assert.equal(updated.revision, 2);
    assert.deepEqual((await store.get(session.taskId, owner)).record, changedSession.record);
    await assert.rejects(library.save(templateBody({ expectedRevision: 1 }), owner, template.id), { statusCode: 409 });
    assert.equal((await library.list(owner)).filter(x => x.collection === 'Strength Training').length, 2);
    for (const attacker of [foreign, sameWorkspace]) {
      await assert.rejects(library.get(template.id, attacker), { statusCode: 404 });
      await assert.rejects(store.create({ title: 'Cross-owner template', date, templateId: template.id }, attacker), { statusCode: 404 });
      await assert.rejects(library.save(templateBody({ sourceTemplateId: template.id }), attacker), { statusCode: 404 });
    }
  });

  await t.test('template source-session provenance accepts workouts and rejects meal sources', async () => {
    const source = await make(meal(date), 'Meal provenance must not become workout');
    await assert.rejects(library.save(templateBody({ sourceSessionId: source.taskId }), owner), { statusCode: 404 });
  });

  await t.test('v1 history retains local identity and is not silently remapped by catalog', async () => {
    const record = workout(date); record.plan.exercises[0].name = 'Bench Press';
    const row = await make(record, 'Legacy Bench Press');
    const read = await store.get(row.taskId, owner);
    assert.equal(read.record.schemaVersion, 1); assert.equal(read.record.plan.exercises[0].id, 'bench');
    assert.equal(read.record.plan.exercises[0].catalogExerciseId, undefined);
    const saved = await store.save(row.taskId, { record: read.record, expectedRevision: 1 }, owner);
    assert.deepEqual(saved.record, M.validate(record));
    const detached = await store.create({ title: 'Legacy reused', date, sourceId: row.taskId }, owner);
    assert.equal(detached.record.schemaVersion, 1); assert.equal(M.hasActual(detached.record), false);
  });

  await t.test('undo of explicit v1 upgrade restores exact freeform names, IDs, null measurements and results', async () => {
    const original = M.empty('workout');
    original.plan.exercises = [{ id: 'old-exercise-27', name: 'My incline press — left side', sets: [
      { id: 'old-target-3', reps: 8, weight: null, unit: 'kg' },
      { id: 'old-target-4', reps: null, weight: 0, unit: 'lb' },
    ] }];
    original.plan.runs = [{ id: 'old-run-target-9', name: 'Neighborhood loop / easy', distance: 3, unit: 'km', seconds: null }];
    original.actual.sets = [{ id: 'old-actual-31', exerciseId: 'old-exercise-27', planSetId: 'old-target-3', reps: 6, weight: null, unit: 'kg' }];
    original.actual.runs = [{ id: 'old-run-actual-12', planRunId: 'old-run-target-9', name: 'Neighborhood loop / stopped early', distance: null, unit: 'km', seconds: 480 }];
    original.occurredOn = '2026-10-08';
    assert.deepEqual(M.validate(original), original, 'fixture is canonical v1 without normalization changes');
    const created = await make(original, 'Explicit legacy upgrade and undo');
    assert.deepEqual((await store.get(created.taskId, owner)).record, original);
    const upgraded = W.upgrade(original);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.plan.exercises[0].catalogExerciseId, null);
    const saved = await store.save(created.taskId, { record: upgraded, expectedRevision: created.revision, mutationId: 'explicit-v1-upgrade' }, owner);
    assert.equal(saved.record.schemaVersion, 2); assert.equal(saved.revision, created.revision + 1);
    const undone = await store.change(created.taskId, { expectedRevision: saved.revision }, owner, 'undo');
    assert.equal(undone.revision, saved.revision + 1);
    assert.deepEqual(undone.record, original, 'undo restores the complete original v1 payload');
    assert.deepEqual((await store.get(created.taskId, owner)).record, original, 'restored v1 persists exactly after reload');
    assert.deepEqual(original.plan.exercises[0].sets[0], { id: 'old-target-3', reps: 8, weight: null, unit: 'kg' }, 'upgrade did not mutate source');
  });

  await t.test('repeated catalog exercises log distinct local targets without changing baseline', async () => {
    const row = await make(); const running = start(row.record);
    const started = await store.save(row.taskId, { record: running, expectedRevision: 1, mutationId: 'start-record' }, owner);
    const value = log(started.record);
    value.actual.sets.push({ ...value.actual.sets[1], id: 'logged-later', exerciseId: 'entry-later', planSetId: 'target-later', weight: 60, unit: 'kg' });
    value.actual.sets.push({ ...value.actual.sets[1], id: 'extra-set', planSetId: null, reps: 4 });
    const saved = await store.save(row.taskId, { record: value, expectedRevision: 2, mutationId: 'log-record' }, owner);
    assert.equal(saved.record.actual.sets.length, 4); assert.deepEqual(saved.record.baseline, running.plan);
    assert.equal(saved.record.plan.exercises[0].sets[0].reps, 8);
    assert.equal(saved.record.actual.sets[0].reps, 0); assert.equal(saved.completed, false);
    const b = await ctx.blockDB.getBlock(row.taskId);
    assert.equal(b.properties.publicVisibility, 'private');
    for (const key of ['plan', 'actual', 'baseline', 'provenance', 'session']) assert.equal(b.properties[key], undefined);
    const operations = await ctx.blockDB.getOperations(row.taskId);
    assert.equal(JSON.stringify(operations).includes('logged-later'), false);
    const corrupt = clone(saved.record); corrupt.actual.sets[0].planSetId = 'target-later';
    await assert.rejects(store.save(row.taskId, { record: corrupt, expectedRevision: saved.revision }, owner), { statusCode: 400 });
  });

  await t.test('saved baselines, plans, provenance and timing prefixes cannot be rewritten', async () => {
    const template = await library.save(templateBody({ title: 'Immutable source' }), owner);
    const row = await store.create({ title: 'Immutable session', date, templateId: template.id }, owner);
    const started = await store.save(row.taskId, { record: start(row.record), expectedRevision: 1 }, owner);
    for (const alter of [v => { v.baseline.exercises[0].sets[0].reps = 9; }, v => { v.plan.exercises[0].name = 'Rewritten'; }, v => { v.provenance.templateName = 'Forged'; }, v => { v.session.events[0].at = date + 'T09:00:00.000Z'; }]) {
      const bad = clone(started.record); alter(bad);
      await assert.rejects(store.save(row.taskId, { record: bad, expectedRevision: 2 }, owner), { statusCode: 409 });
    }
    assert.deepEqual((await store.get(row.taskId, owner)).record, started.record);
  });

  await t.test('a started v2 session cannot evade immutable history by downgrading to v1', async () => {
    const row = await make(); await store.save(row.taskId, { record: start(row.record), expectedRevision: 1 }, owner);
    await assert.rejects(store.save(row.taskId, { record: M.empty('workout'), expectedRevision: 2 }, owner), { statusCode: 409 });
    assert.equal((await store.get(row.taskId, owner)).record.schemaVersion, 2);
  });

  await t.test('same save retry returns committed revision once and changed payload is rejected', async () => {
    const row = await make(); const value = log(start(row.record));
    const body = { record: value, expectedRevision: 1, mutationId: 'stable-save-retry' };
    const saved = await store.save(row.taskId, body, owner);
    const retried = await store.save(row.taskId, clone(body), owner);
    assert.equal(retried.revision, saved.revision); assert.deepEqual(retried.record, saved.record);
    const different = clone(body); different.record.actual.sets[1].reps = 7;
    await assert.rejects(store.save(row.taskId, different, owner), { statusCode: 409 });
    const stale = { ...body, mutationId: 'distinct-stale' };
    await assert.rejects(store.save(row.taskId, stale, owner), { statusCode: 409 });
    assert.equal((await store.get(row.taskId, owner)).record.actual.sets.length, 2);
  });

  await t.test('undo invalidates old mutation acknowledgement rather than claiming the undone save succeeded', async () => {
    const row = await make();
    const body = { record: log(start(row.record)), expectedRevision: 1, mutationId: 'save-before-undo' };
    const saved = await store.save(row.taskId, body, owner);
    const undone = await store.change(row.taskId, { expectedRevision: saved.revision }, owner, 'undo');
    assert.equal(M.hasActual(undone.record), false);
    await assert.rejects(store.save(row.taskId, body, owner), { statusCode: 409 });
    assert.deepEqual((await store.get(row.taskId, owner)).record, undone.record);
  });

  await t.test('stale tabs reject conflict; move, archive, undo and deletion preserve private v2 records', async () => {
    const row = await make(); const value = log(start(row.record));
    const outcomes = await Promise.allSettled([store.save(row.taskId, { record: value, expectedRevision: 1, mutationId: 'tab-one' }, owner), store.save(row.taskId, { record: value, expectedRevision: 1, mutationId: 'tab-two' }, owner)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(x => x.status === 'rejected').reason.statusCode, 409);
    const before = await store.get(row.taskId, owner), block = await ctx.blockDB.getBlock(row.taskId);
    await ctx.blockDB.rescheduleBlocks([{ id: row.taskId, date: '2026-10-16', properties: { ...block.properties, type: 'task', publicVisibility: 'public' } }], []);
    const moved = await store.get(row.taskId, owner); assert.equal(moved.date, '2026-10-16'); assert.deepEqual(moved.record, before.record); assert.equal(moved.record.occurredOn, date);
    const archived = await store.change(row.taskId, { expectedRevision: moved.revision }, owner, 'archive');
    await assert.rejects(store.save(row.taskId, { record: value, expectedRevision: archived.revision }, owner), { statusCode: 409 });
    const restored = await store.change(row.taskId, { expectedRevision: archived.revision }, owner, 'restore');
    assert.deepEqual(restored.record, before.record);
    await ctx.blockDB.deleteBlock(row.taskId); assert.deepEqual((await store.get(row.taskId, owner)).record, before.record);
    await ctx.blockDB.undeleteBlock(row.taskId); assert.equal((await store.get(row.taskId, owner)).removed, false);
    assert.equal((await ctx.blockDB.getBlock(row.taskId)).properties.publicVisibility, 'private');
  });

  await t.test('v2 scheduled and readiness recurrence copy detached plans but no logged sets or timing', async () => {
    const source = await make(log(start(plan())), 'Logged recurrence source');
    const repeat = require('./responsibility-store')({ blockDB: ctx.blockDB, getScheduleBlocks: async () => [], getTodayStr: () => date, assertBlockOwnership: (b, ws) => assert.equal(b.workspace_id, ws), appTimeZone: 'UTC' });
    const definition = await repeat.upsertResponsibility({ ...owner, properties: { title: 'Planner recurrence snapshot', activityPlanSourceId: source.taskId, repeatType: 'scheduled', scheduleRule: { version: 1, patternType: 'calendar', timeZone: 'UTC', startDate: '2026-10-16', frequency: 'daily', interval: 1, times: ['09:00'], end: { type: 'never' } } } });
    const tasks = await repeat.materializeScheduledRepeatsForDate({ date: '2026-10-16', ...owner });
    assert.equal(tasks.length, 1);
    assert.equal((await repeat.materializeScheduledRepeatsForDate({ date: '2026-10-16', ...owner })).length, 0);
    const props = require('./responsibility-store').buildResponsibilityTaskProps(definition, { duration: 45, slot: 600, localId: 'planner-readiness' });
    const readiness = await ctx.blockDB.createItineraryTask({ date: '2026-10-17', properties: props, ...owner });
    for (const task of [tasks[0], readiness]) {
      const record = (await store.get(task.id, owner)).record;
      assert.deepEqual(record.plan, source.record.plan); assert.equal(record.schemaVersion, 2);
      assert.deepEqual(record.actual, { sets: [], runs: [] }); assert.deepEqual(record.session.events, []);
      assert.equal(record.baseline, null); assert.equal(record.occurredOn, null);
      assert.equal(task.properties.publicVisibility, 'private');
    }
  });

  await t.test('blank legacy rows and skipped sessions persist without counting as logged activity', async () => {
    const blank = workout(date); blank.actual.sets.forEach(s => { s.reps = null; s.weight = null; });
    blank.actual.runs.forEach(r => { r.distance = null; r.seconds = null; }); blank.occurredOn = null;
    const legacy = await make(blank, 'Blank legacy drafts');
    assert.equal(M.hasActual(legacy.record), false);
    const skipped = await make(W.action(plan(), { id: 'skip-event', type: 'skip', at: date + 'T10:00:00.000Z' }), 'Skipped planned workout');
    assert.equal(M.hasActual(skipped.record), false); assert.equal(W.replay(skipped.record).status, 'skipped');
    assert.equal(W.replay(skipped.record).totalSeconds, null);
    const days = M.summarize([legacy, skipped], date, date); assert.equal(days[0].loggedWorkouts, 0);
    assert.equal((await store.get(skipped.taskId, owner)).record.occurredOn, null);
  });

  await t.test('reload preserves partial round and rest boundaries independently from task completion', async () => {
    const row = await make();
    let value = start(row.record);
    value = W.action(value, { id: 'round-start', type: 'start-round', at: date + 'T10:01:00.000Z', groupId: 'group-early', round: 1 });
    let saved = await store.save(row.taskId, { record: value, expectedRevision: 1 }, owner);
    value = (await store.get(row.taskId, owner)).record;
    value = W.action(value, { id: 'round-finish', type: 'finish-round', at: date + 'T10:03:00.000Z', groupId: 'group-early', round: 1 });
    saved = await store.save(row.taskId, { record: value, expectedRevision: saved.revision }, owner);
    value = (await store.get(row.taskId, owner)).record;
    value = W.action(value, { id: 'stop-partial', type: 'stop', at: date + 'T10:04:00.000Z', outcome: 'partial' });
    saved = await store.save(row.taskId, { record: value, expectedRevision: saved.revision }, owner);
    const timing = W.replay((await store.get(row.taskId, owner)).record);
    assert.equal(timing.status, 'partial'); assert.equal(timing.totalSeconds, 240);
    assert.equal(timing.rounds[0].seconds, 120); assert.equal(timing.rests[0].seconds, 60);
    assert.equal(saved.completed, false); assert.equal(M.hasActual(saved.record), false);
    assert.deepEqual(saved.record.baseline, row.record.plan);
  });

  await t.test('private HTTP routes deny guests, viewers, cross-owner IDs and forged sources', async () => {
    const template = await library.save(templateBody({ title: 'HTTP private source' }), owner);
    const session = await make(log(start(plan())), 'HTTP private session');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const user = Number(req.headers['x-test-session']); if (user) { req.session = { userId: user }; req.workspaceId = user === 2 ? 'ws-2' : 'ws-1'; } next(); });
    require('./routes/activity')(app, { ...ctx, broadcast() {} });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (path, user, method = 'GET', body) => fetch(base + '/api/activity' + path, { method, headers: { ...(user ? { 'x-test-session': String(user) } : { 'x-user-id': '1', 'x-workspace-id': 'ws-1', Authorization: 'Bearer fake-service' }), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const path of ['/exercises', '/templates', '/templates/' + template.id, '/tasks/' + session.taskId, '/export?from=' + date + '&to=' + date]) {
      for (const [user, status] of [[null, 401], [3, 403]]) {
        const response = await call(path, user); assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      }
    }
    for (const [path, method, body] of [['/exercises', 'POST', { name: 'Unauthorized' }], ['/templates', 'POST', templateBody()], ['/templates/' + template.id, 'PUT', templateBody({ expectedRevision: 1 })], ['/tasks', 'POST', { title: 'Unauthorized', date, templateId: template.id }], ['/tasks/' + session.taskId, 'PUT', { record: session.record, expectedRevision: 1 }]]) {
      assert.equal((await call(path, 3, method, body)).status, 403);
    }
    assert.equal((await call('/templates/' + template.id, 2)).status, 404);
    assert.equal((await call('/tasks/' + session.taskId, 2)).status, 404);
    assert.equal((await call('/tasks', 2, 'POST', { title: 'Forged template', date, templateId: template.id })).status, 404);
    assert.equal((await call('/templates', 2, 'POST', templateBody({ sourceSessionId: session.taskId }))).status, 404);
    const foreignTemplates = await (await call('/templates', 2)).json(); assert.deepEqual(foreignTemplates.templates, []);
    const json = await call('/export?from=' + date + '&to=' + date, 1);
    assert.equal(json.status, 200); assert.equal(json.headers.get('cache-control'), 'private, no-store');
    const exported = await json.json(); assert.deepEqual(exported.records.find(r => r.taskId === session.taskId).record, session.record);
    const csv = await (await call('/export?from=' + date + '&to=' + date + '&format=csv', 1)).text();
    assert.match(csv, /catalogExerciseId/); assert.match(csv, /loggedAt/); assert.match(csv, /logged-1/); assert.match(csv, /entry-early/);
  });
});
