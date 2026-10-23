const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createActivityDb } = require('./test-support/activity-db');
const { route, isValidDate } = require('./lib/route-helpers');

test('check-in task completion uses canonical PostgreSQL transitions and safe retries', {
  skip: !process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL,
}, async t => {
  const ctx = await createActivityDb(); t.after(ctx.close);
  const date = '2026-10-23', at = date + 'T12:00:00Z';
  Object.assign(ctx, { route, APP_TIME_ZONE: 'UTC', getTodayStr: () => date,
    getScheduleBlocks: async () => [], filterLegacyGcalBlocks: rows => rows, isValidDate, broadcast() {} });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: req.headers['x-other'] ? 2 : 1 }; req.workspaceId = req.headers['x-other'] ? 'ws-2' : 'ws-1'; next(); });
  require('./routes/blocks')(app, ctx);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (id, body, other = false) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/waiting-items/${id}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(other ? { 'x-other': '1' } : {}) }, body: JSON.stringify(body),
    }); return { status: res.status, body: await res.json() };
  };
  const read = id => ctx.blockDB.getBlockIncludingDeleted(id);
  const task = (properties = {}, on = date) => ctx.blockDB.createItineraryTask({ date: on, userId: 1, workspaceId: 'ws-1', properties: { kind: 'task', type: 'task', title: 'Synthetic task', duration: 15, ...properties } });
  const waiting = linkedBlockId => ctx.blockDB.createBlock({ type: 'block', date: null, user_id: 1, workspace_id: 'ws-1', properties: {
    kind: 'delegated_item', myTask: 'Synthetic waiting work', title: 'Reply', status: 'open', linkedBlockId,
    checkInDate: date, checkInRepeat: true, checkInHistory: [],
  } });
  const payload = row => ({ completedAt: at, expectedUpdatedAt: row.updated_at, resolveBlockedTask: true });
  const ok = res => { assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body; };
  const operations = async id => Number((await ctx.pool.query('SELECT count(*) AS n FROM operations WHERE block_id=$1', [id])).rows[0].n);

  await t.test('complete, reload, duplicate and concurrent retry close every reminder without another check-in log', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminders = await Promise.all([0, 1].map(n => task({ source: 'waiting-checkin', delegatedItemId: item.id, local_id: `waiting-checkin-task:${item.id}:${n}` })));
    const replies = await Promise.all([post(item.id, payload(item)), post(item.id, payload(item))]);
    assert.ok(replies.some(res => res.status === 200));
    assert.ok(replies.every(res => [200, 409].includes(res.status)), JSON.stringify(replies));
    const done = await read(work.id), closed = await read(item.id);
    assert.equal(done.properties.status, 'done'); assert.ok(done.properties._completionRevision);
    assert.equal(closed.properties.status, 'done'); assert.deepEqual(closed.properties.checkInHistory, []);
    for (const reminder of reminders) assert.equal((await read(reminder.id)).properties.status, 'done');
    const before = await operations(work.id), revision = done.properties._completionRevision;
    assert.equal(ok(await post(item.id, payload(item))).duplicate, true);
    assert.equal((await read(work.id)).properties._completionRevision, revision);
    assert.equal(await operations(work.id), before, 'retry must not add completion/timing history');
    assert.equal(Number((await ctx.pool.query("SELECT count(*) AS n FROM blocks WHERE properties->>'source'='waiting-checkin-log'")).rows[0].n), 0);
    await ctx.blockDB.setTaskCompletion({ taskRef: work.id, completed: false, mutationId: 'reopen-test', expectedRevision: revision, userId: 1, workspaceId: 'ws-1' });
    ok(await post(item.id, payload(item)));
    assert.notEqual((await read(work.id)).properties.status, 'done', 'an old request never recompletes reopened work');
    await ctx.reopenWaitingItem({ itemId: item.id, userId: 1, workspaceId: 'ws-1', reopenedAt: date + 'T13:00:00Z' });
    assert.equal((await post(item.id, payload(item))).status, 409, 'stale dialog after Waiting reopen is rejected');
  });

  await t.test('stale edits, deleted work, invalid version, and foreign ownership cannot complete work', async () => {
    const work = await task(), item = await waiting(work.id);
    assert.equal((await post(item.id, payload(item), true)).status, 404);
    assert.equal((await post(item.id, { ...payload(item), expectedUpdatedAt: 'bad' })).status, 400);
    await ctx.blockDB.updateBlock(item.id, { properties: { ...item.properties, title: 'Changed elsewhere' } });
    assert.equal((await post(item.id, payload(item))).status, 409);
    await ctx.blockDB.deleteBlock(work.id);
    assert.equal((await post(item.id, payload(await read(item.id)))).status, 409);
    assert.equal((await read(item.id)).properties.status, 'open');
  });

  await t.test('explicit completion releases the blocked task without completing its prerequisite or next recurrence', async () => {
    const prerequisite = await task(), work = await task({ repeatSeriesId: 'synthetic-series', repeatOccurrenceKey: date });
    const next = await task({ repeatSeriesId: 'synthetic-series', repeatOccurrenceKey: '2026-10-24' }, '2026-10-24');
    let item = await waiting(work.id);
    item = await ctx.blockDB.updateBlock(item.id, { properties: { ...item.properties, blockerType: 'task', blockerBlockId: prerequisite.id } });
    await ctx.blockDB.updateBlock(work.id, { properties: { ...work.properties, dependencyWaitingItemId: item.id, dependencyWaitingItemIds: [item.id] } });
    assert.equal((await post(item.id, { completedAt: at })).status, 409, 'legacy completion keeps its prerequisite guard');
    ok(await post(item.id, payload(item)));
    assert.equal((await read(work.id)).properties.status, 'done');
    assert.notEqual((await read(prerequisite.id)).properties.status, 'done');
    assert.notEqual((await read(next.id)).properties.status, 'done');
  });

  await t.test('standalone Waiting work is serialized and repeat completion creates no extra history', async () => {
    const item = await waiting(null);
    const results = await Promise.all([post(item.id, payload(item)), post(item.id, payload(item))]);
    results.forEach(ok);
    const count = await operations(item.id);
    ok(await post(item.id, payload(item)));
    assert.equal(await operations(item.id), count);
    assert.deepEqual((await read(item.id)).properties.checkInHistory, []);
  });

  await t.test('shared work completes only this participant and never another private task', async () => {
    await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,2,'accepted')");
    ctx.socialStore = require('./social-store');
    const store = require('./shared-task-store').createSharedTaskStore(ctx);
    const work = await task(), owner = { userId: 1, workspaceId: 'ws-1' }, friend = { userId: 2, workspaceId: 'ws-2' };
    const share = await store.invite(work.id, 2, owner);
    const joined = await store.respond(share.id, 'accept', friend);
    const item = await waiting(work.id);
    ok(await post(item.id, payload(item)));
    assert.equal((await read(work.id)).properties.status, 'done');
    assert.notEqual((await read(joined.taskId)).properties.status, 'done');
    const detail = (await store.list(owner)).find(row => row.id === share.id);
    assert.equal(detail.participants.filter(p => p.completed).length, 1);
    const count = async () => Number((await ctx.pool.query('SELECT count(*) AS n FROM shared_task_notifications WHERE share_id=$1', [share.id])).rows[0].n);
    assert.equal(await count(), 1);
    ok(await post(item.id, payload(item)));
    assert.equal(await count(), 1, 'retry does not notify the other participant twice');
  });

  await t.test('companion revision compares Date values at millisecond precision and rolls back work', async () => {
    const work = await task(), item = await waiting(work.id);
    await ctx.pool.query('UPDATE blocks SET updated_at=$2 WHERE id=$1', [item.id, '2026-10-23T12:00:00.101Z']);
    const stale = await read(item.id);
    await ctx.pool.query('UPDATE blocks SET updated_at=$2 WHERE id=$1', [item.id, '2026-10-23T12:00:00.202Z']);
    await assert.rejects(ctx.blockDB.setTaskCompletion({ taskRef: work.id, completed: true, mutationId: 'stale-companion',
      userId: 1, workspaceId: 'ws-1', companionUpdates: [{ id: item.id, expectedUpdatedAt: stale.updated_at, properties: { ...item.properties, status: 'done' } }],
    }), { publicCode: 'COMPLETION_COMPANION_CONFLICT' });
    assert.notEqual((await read(work.id)).properties.status, 'done');
    assert.equal((await read(item.id)).properties.status, 'open');
  });

  await t.test('lost timing normalization repairs the original subtree without duplicate completion', async () => {
    const work = await task(), child = await task({ subtaskOf: work.id, title: 'Synthetic child' }), item = await waiting(work.id);
    const original = ctx.blockDB.getTaskTimeEntries;
    ctx.blockDB.getTaskTimeEntries = async (...args) => {
      if (args[0] === child.id) throw new Error('synthetic timing interruption');
      return original(...args);
    };
    try { assert.equal((await post(item.id, payload(item))).status, 500); }
    finally { ctx.blockDB.getTaskTimeEntries = original; }
    const revision = (await read(child.id)).properties._completionRevision;
    ok(await post(item.id, payload(item)));
    const repaired = await read(child.id);
    assert.equal(repaired.properties._completionRevision, revision);
    assert.ok(repaired.properties.workStateOperationId, 'child timing normalized on replay');
    const count = await operations(child.id);
    ok(await post(item.id, payload(item)));
    assert.equal(await operations(child.id), count);
  });

  await t.test('partial reminder cleanup reports pending and a retry repairs it without recompleting the work', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const original = ctx.blockDB.getWaitingClusterTasks;
    ctx.blockDB.getWaitingClusterTasks = async () => { throw new Error('synthetic cleanup interruption'); };
    let response;
    try { response = ok(await post(item.id, payload(item))); } finally { ctx.blockDB.getWaitingClusterTasks = original; }
    assert.equal(response.cleanupPending, true);
    const revision = (await read(work.id)).properties._completionRevision;
    assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
    assert.equal((await read(reminder.id)).properties.status, 'done');
    assert.equal((await read(work.id)).properties._completionRevision, revision);
  });
});
