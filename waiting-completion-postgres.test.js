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
  // Exercise the mounted HTTP handler without opening a process socket.
  const handler = app._router.stack.find(layer => layer.route && layer.route.path === '/api/waiting-items/:id/complete').route.stack[0].handle;
  const post = async (id, body, other = false) => {
    const res = { statusCode: 200, headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.headersSent = true; return this; },
    };
    await handler({ params: { id }, body: JSON.parse(JSON.stringify(body)),
      session: { userId: other ? 2 : 1 }, workspaceId: other ? 'ws-2' : 'ws-1' }, res);
    return { status: res.statusCode, body: res.body };
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

  await t.test('committed reminder cleanup stays pending until timing succeeds and repeated retries are idempotent', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const other = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const original = ctx.blockDB.getTaskTimeEntries;
    ctx.blockDB.getTaskTimeEntries = async (...args) => {
      if (args[0] === reminder.id) throw new Error('synthetic post-commit reminder interruption');
      return original(...args);
    };
    let revision;
    try {
      assert.equal(ok(await post(item.id, payload(item))).cleanupPending, true);
      const committed = await read(reminder.id);
      assert.equal(committed.properties.status, 'done');
      assert.equal(committed.properties.workStateOperationId, undefined);
      revision = committed.properties._completionRevision;
      const count = await operations(reminder.id);
      assert.equal(ok(await post(item.id, payload(item))).cleanupPending, true);
      assert.equal(await operations(reminder.id), count, 'failed retries do not repeat canonical completion');
    } finally { ctx.blockDB.getTaskTimeEntries = original; }
    assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
    assert.equal((await read(reminder.id)).properties._completionRevision, revision);
    for (const row of [reminder, other]) {
      assert.ok((await read(row.id)).properties.workStateOperationId);
      assert.equal((await original(row.id, 'ws-1')).length, 1);
    }
    const counts = await Promise.all([work, reminder, other].map(row => operations(row.id)));
    const notifications = (await ctx.pool.query('SELECT count(*) AS n FROM shared_task_notifications')).rows[0].n;
    for (let n = 0; n < 3; n++) assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
    assert.deepEqual(await Promise.all([work, reminder, other].map(row => operations(row.id))), counts);
    assert.equal((await ctx.pool.query('SELECT count(*) AS n FROM shared_task_notifications')).rows[0].n, notifications);
    assert.deepEqual((await read(item.id)).properties.checkInHistory, []);
  });

  await t.test('timing failure after session insertion rolls back all derived effects before retry', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const original = ctx.blockDB.updateBlock;
    ctx.blockDB.updateBlock = async (id, ...args) => {
      if (id === reminder.id) throw new Error('synthetic timing projection interruption');
      return original(id, ...args);
    };
    try { assert.equal(ok(await post(item.id, payload(item))).cleanupPending, true); }
    finally { ctx.blockDB.updateBlock = original; }
    assert.equal((await read(reminder.id)).properties.status, 'done', 'canonical completion already committed');
    assert.equal((await ctx.blockDB.getTaskTimeEntries(reminder.id, 'ws-1')).length, 0, 'derived session rolled back with projection');
    assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
    assert.equal((await ctx.blockDB.getTaskTimeEntries(reminder.id, 'ws-1')).length, 1);
  });

  await t.test('historical reminder effects repair moved children even after root deletion and preserve reopened or newer work', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const pending = await task({ subtaskOf: reminder.id });
    const reopened = await task({ subtaskOf: reminder.id });
    const newer = await task({ subtaskOf: reminder.id });
    const original = ctx.blockDB.getTaskTimeEntries;
    ctx.blockDB.getTaskTimeEntries = async (...args) => {
      if (args[0] === pending.id) throw new Error('synthetic reminder child interruption');
      return original(...args);
    };
    try { assert.equal(ok(await post(item.id, payload(item))).cleanupPending, true); }
    finally { ctx.blockDB.getTaskTimeEntries = original; }
    const revision = (await read(pending.id)).properties._completionRevision;
    await ctx.blockDB.deleteBlock(reminder.id);
    const child = await read(pending.id);
    await ctx.blockDB.updateBlock(child.id, { properties: { ...child.properties, subtaskOf: work.id } });
    const timing = require('./lib/task-timing')({ pool: ctx.pool, blockDB: ctx.blockDB, timeZone: 'UTC' });
    for (const row of [reopened, newer]) {
      await ctx.blockDB.setTaskCompletion({ taskRef: row.id, completed: false, mutationId: 'later-reopen-' + row.id,
        expectedRevision: (await read(row.id)).properties._completionRevision, userId: 1, workspaceId: 'ws-1' });
      await timing.reopenWork({ block: await read(row.id), atMs: Date.parse(date + 'T13:00:00Z'), actionId: 'reopen-time-' + row.id });
    }
    await timing.startWork({ block: await read(reopened.id), atMs: Date.parse(date + 'T13:05:00Z'), actionId: 'restarted-child' });
    await ctx.blockDB.setTaskCompletion({ taskRef: newer.id, completed: true, completedAt: date + 'T14:00:00Z', mutationId: 'newer-child-completion',
      expectedRevision: (await read(newer.id)).properties._completionRevision, userId: 1, workspaceId: 'ws-1' });
    const before = await Promise.all([reopened, newer].map(row => read(row.id)));
    assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
    assert.equal((await read(pending.id)).properties._completionRevision, revision);
    assert.ok((await read(pending.id)).properties.workStateOperationId, 'original child repaired despite lost root/current edge');
    assert.deepEqual(await Promise.all([reopened, newer].map(row => read(row.id))), before, 'old replay does not normalize a newer mutation or erase a timer');
    assert.ok((await read(reminder.id)).deleted_at);
    assert.equal((await original(reopened.id, 'ws-1')).length, 0);
    assert.equal((await original(newer.id, 'ws-1')).length, 0);
  });

  await t.test('replay revalidates a stale work snapshot under lock and preserves concurrent reopen timing and triage', async () => {
    const work = await task({ triageId: 'synthetic-replay-triage' }), item = await waiting(work.id);
    const entries = ctx.blockDB.getTaskTimeEntries;
    ctx.blockDB.getTaskTimeEntries = async (...args) => {
      if (args[0] === work.id) throw new Error('synthetic original work interruption');
      return entries(...args);
    };
    try { assert.equal((await post(item.id, payload(item))).status, 500); }
    finally { ctx.blockDB.getTaskTimeEntries = entries; }
    const readBlock = ctx.blockDB.getBlockIncludingDeleted;
    let before;
    ctx.blockDB.getBlockIncludingDeleted = async (id, client, ...args) => {
      const stale = await readBlock(id, client, ...args);
      if (id === work.id && !client && !before) {
        ctx.blockDB.getBlockIncludingDeleted = readBlock;
        await ctx.reopenWaitingItem({ itemId: item.id, userId: 1, workspaceId: 'ws-1', reopenedAt: date + 'T13:00:00Z' });
        const timing = require('./lib/task-timing')({ pool: ctx.pool, blockDB: ctx.blockDB, timeZone: 'UTC' });
        await timing.startWork({ block: await read(work.id), atMs: Date.parse(date + 'T13:05:00Z'), actionId: 'concurrent-restart' });
        await ctx.transitionLinkedTriage(await read(work.id), 'scheduled', Date.parse(date + 'T13:05:00Z'));
        before = await read(work.id);
      }
      return stale;
    };
    let result;
    try { result = ok(await post(item.id, payload(item))); }
    finally { ctx.blockDB.getBlockIncludingDeleted = readBlock; }
    assert.ok(before, 'interleaving occurred after receipt lookup');
    assert.deepEqual(await read(work.id), before);
    assert.equal((await read(item.id)).properties.status, 'open');
    assert.equal((await entries(work.id, 'ws-1')).length, 0);
    assert.equal(result.actualWork, null, 'old replay must not offer credit for reopened work');
    const suppressions = await ctx.blockDB.getBlocksByKind('triage_suppression', 'ws-1');
    assert.equal(suppressions.find(row => row.properties.triage_id === 'synthetic-replay-triage').properties.reason, 'scheduled');
  });

  await t.test('a pending reminder cannot complete after the Waiting item reopens during cleanup', async () => {
    const work = await task(), item = await waiting(work.id);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const complete = ctx.blockDB.setTaskCompletion;
    let interrupted = false;
    ctx.blockDB.setTaskCompletion = async input => {
      if (input.taskRef === reminder.id && !interrupted) {
        interrupted = true;
        await ctx.reopenWaitingItem({ itemId: item.id, userId: 1, workspaceId: 'ws-1', reopenedAt: date + 'T13:00:00Z' });
      }
      return complete(input);
    };
    let result;
    try { result = ok(await post(item.id, payload(item))); }
    finally { ctx.blockDB.setTaskCompletion = complete; }
    assert.equal(interrupted, true);
    assert.equal(result.cleanupPending, false, 'superseded cleanup is no longer outstanding');
    assert.equal(result.actualWork, null);
    assert.notEqual((await read(work.id)).properties.status, 'done');
    assert.notEqual((await read(reminder.id)).properties.status, 'done');
    assert.equal((await read(item.id)).properties.status, 'open');
  });

  await t.test('first completion and lost acknowledgement expose only the same canonical actual work for credit', async () => {
    const work = await task({ local_id: 'credit-original-occurrence' }, '2026-10-22'), item = await waiting(work.id);
    const first = ok(await post(item.id, payload(item)));
    const replay = ok(await post(item.id, payload(item)));
    assert.equal(first.actualWork.id, work.id);
    assert.equal(replay.actualWork.id, work.id);
    assert.equal(replay.actualWork.date, '2026-10-22');
    assert.equal(replay.actualWork.properties._completionMutationId, first.actualWork.properties._completionMutationId);
    await ctx.blockDB.updateBlock(work.id, { date: '2026-10-24' });
    assert.equal(ok(await post(item.id, payload(item))).actualWork, null, 'redated task cannot claim a second source key on replay');
    const standalone = await waiting(null);
    assert.equal(ok(await post(standalone.id, payload(standalone))).actualWork, null);
  });


  await t.test('original work and reminder child repairs survive a reopened root without recompleting it', async () => {
    for (const role of ['work', 'reminder']) {
      const work = await task(), item = await waiting(work.id);
      const root = role === 'work' ? work : await task({ source: 'waiting-checkin', delegatedItemId: item.id });
      const child = await task({ subtaskOf: root.id }), movedParent = await task();
      const entries = ctx.blockDB.getTaskTimeEntries;
      ctx.blockDB.getTaskTimeEntries = async (...args) => {
        if (args[0] === child.id) throw new Error('synthetic original descendant interruption');
        return entries(...args);
      };
      try {
        const first = await post(item.id, payload(item));
        if (role === 'work') assert.equal(first.status, 500);
        else assert.equal(ok(first).cleanupPending, true);
      } finally { ctx.blockDB.getTaskTimeEntries = entries; }
      await ctx.blockDB.setTaskCompletion({ taskRef: root.id, completed: false, mutationId: 'reopen-root-' + root.id,
        expectedRevision: (await read(root.id)).properties._completionRevision, userId: 1, workspaceId: 'ws-1' });
      const timing = require('./lib/task-timing')({ pool: ctx.pool, blockDB: ctx.blockDB, timeZone: 'UTC' });
      await timing.reopenWork({ block: await read(root.id), atMs: Date.parse(date + 'T13:00:00Z'), actionId: 'reopen-root-timing-' + root.id });
      await timing.startWork({ block: await read(root.id), atMs: Date.parse(date + 'T13:05:00Z'), actionId: 'restart-root-' + root.id });
      await ctx.blockDB.updateBlock(child.id, { properties: { ...(await read(child.id)).properties, subtaskOf: movedParent.id } });
      const before = await read(root.id);
      assert.equal(ok(await post(item.id, payload(item))).cleanupPending, false);
      assert.deepEqual(await read(root.id), before, role + ' root must retain its new timer');
      assert.ok((await read(child.id)).properties.workStateOperationId, 'original moved child is still repaired');
      const childOperations = await operations(child.id);
      ok(await post(item.id, payload(item)));
      assert.deepEqual(await read(root.id), before);
      assert.equal(await operations(child.id), childOperations);
      assert.equal((await entries(root.id, 'ws-1')).length, 0);
      assert.equal((await entries(child.id, 'ws-1')).length, 1);
    }
  });


  await t.test('concurrent standalone completions use the persisted timestamp when retrying partial cleanup', async () => {
    const item = await waiting(null);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: item.id });
    const cluster = ctx.blockDB.getWaitingClusterTasks;
    let interrupted = false;
    ctx.blockDB.getWaitingClusterTasks = async (...args) => {
      if (!interrupted) { interrupted = true; throw new Error('synthetic first standalone cleanup interruption'); }
      return cluster(...args);
    };
    let replies;
    try {
      replies = await Promise.all([
        post(item.id, payload(item)),
        post(item.id, { ...payload(item), completedAt: date + 'T13:00:00Z' }),
      ]);
    } finally { ctx.blockDB.getWaitingClusterTasks = cluster; }
    replies.forEach(ok);
    assert.ok(replies.some(reply => reply.body.cleanupPending));
    assert.ok(replies.some(reply => !reply.body.cleanupPending));
    const persisted = await read(item.id), cleaned = await read(reminder.id);
    assert.equal(cleaned.properties.status, 'done');
    assert.equal(Date.parse(cleaned.properties.completedAt), Date.parse(persisted.properties.completedAt));
    assert.ok(cleaned.properties.workStateOperationId);
    const count = await operations(reminder.id);
    ok(await post(item.id, payload(item)));
    assert.equal(await operations(reminder.id), count);
  });

});
