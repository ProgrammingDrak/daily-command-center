const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityDb } = require('./test-support/activity-db');

// Socket-free: these exercise the real canonical PostgreSQL transaction, not a
// mocked dependency guard or an HTTP listener.
test('explicit Waiting completion atomically resolves only this work\'s owned dependencies', {
  skip: !process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL,
}, async t => {
  const ctx = await createActivityDb(); t.after(ctx.close);
  const date = '2026-10-23', at = date + 'T12:00:00Z';
  const read = id => ctx.blockDB.getBlockIncludingDeleted(id);
  const task = (properties = {}, on = date, userId = 1, workspaceId = 'ws-1') => ctx.blockDB.createItineraryTask({
    date: on, userId, workspaceId,
    properties: { kind: 'task', type: 'task', title: 'Synthetic dependency work', duration: 15, ...properties },
  });
  const waiting = (work, prerequisite, properties = {}, userId = 1, workspaceId = 'ws-1') => ctx.blockDB.createBlock({
    type: 'block', user_id: userId, workspace_id: workspaceId,
    properties: { kind: 'delegated_item', title: 'Synthetic dependency', status: 'open',
      linkedBlockId: work.id, blockerType: 'task', blockerBlockId: prerequisite.id,
      checkInTaskId: 'synthetic-reminder', checkInScheduledFor: date, snoozedUntil: date,
      checkInHistory: [{ cycleKey: 'prior-cycle', completedAt: '2026-10-22T12:00:00Z' }], ...properties },
  });
  const mark = async (work, items) => ctx.blockDB.updateBlock(work.id, { properties: {
    ...work.properties, dependencyWaitingItemId: items[0].id, dependencyWaitingItemIds: items.map(row => row.id),
  } });
  const options = (work, item, extra = {}) => ({ taskRef: work.id, completed: true, completedAt: at,
    mutationId: `waiting:${item.id}:${Date.parse(at)}`, expectedRevision: work.properties._completionRevision || null,
    userId: 1, workspaceId: 'ws-1', resolveWaitingItemId: item.id,
    companionUpdates: [{ id: item.id, expectedUpdatedAt: item.updated_at,
      properties: { ...item.properties, status: 'done', completedAt: at, completedBy: 'waiting' } }], ...extra,
  });
  const complete = (work, item, extra) => ctx.blockDB.setTaskCompletion(options(work, item, extra));
  const operationCount = async () => Number((await ctx.pool.query('SELECT count(*) AS n FROM operations')).rows[0].n);
  const pair = async () => {
    let work = await task();
    const prerequisites = [await task(), await task()];
    const items = [await waiting(work, prerequisites[0]), await waiting(work, prerequisites[1])];
    work = await mark(work, items);
    return { work, prerequisites, items };
  };
  const assertOpen = async rows => {
    for (const row of rows) assert.notEqual((await read(row.id)).properties.status, 'done', row.id);
  };

  await t.test('secondary card closes every active sibling, including ready aliases without markers', async () => {
    const { work: initial, prerequisites, items } = await pair();
    const work = await ctx.blockDB.updateBlock(initial.id, { properties: {
      ...initial.properties, local_id: 'this-occurrence', repeatSeriesId: 'synthetic-series', repeatOccurrenceKey: date,
    } });
    const ready = await waiting(work, prerequisites[0], { status: 'ready', linkedBlockId: 'this-occurrence' });
    const next = await task({ repeatSeriesId: 'synthetic-series', repeatOccurrenceKey: '2026-10-24' }, '2026-10-24');
    const future = await waiting(next, prerequisites[0]);
    const other = await task(), unrelated = await waiting(other, prerequisites[0]);
    const otherParticipant = await task({ sharedTaskId: 'synthetic-share' }, date, 2, 'ws-2');
    const participantItem = await waiting(otherParticipant, prerequisites[0], {}, 2, 'ws-2');
    const foreignWorkspace = await waiting(work, prerequisites[0], {}, 2, 'ws-2');
    const differentOwner = await waiting(work, await task(), {}, 3);
    const nonDependency = await waiting(work, prerequisites[0], { blockerType: 'person' });
    const result = await complete(work, items[1]);
    const group = [...items, ready];
    assert.equal(result.task.properties.status, 'done');
    assert.equal(result.task.properties.dependencyWaitingItemId, undefined);
    assert.equal(result.task.properties.dependencyWaitingItemIds, undefined);
    assert.deepEqual(result.companionBlocks.map(row => row.id).sort(), group.map(row => row.id).sort());
    for (const row of group) {
      const props = (await read(row.id)).properties;
      assert.equal(props.status, 'done');
      assert.equal(props.waitingCompletionMutationId, result.task.properties._completionMutationId);
      assert.equal(props.waitingCompletionTaskId, work.id);
      assert.equal(props.waitingCompletionTaskDate, date);
      assert.equal(props.waitingCompletionTaskLocalId, 'this-occurrence');
      assert.deepEqual(props.waitingCompletionItemIds.sort(), group.map(row => row.id).sort());
      assert.deepEqual(props.checkInHistory, row.properties.checkInHistory);
      assert.equal(props.checkInTaskId, null); assert.equal(props.checkInScheduledFor, null); assert.equal(props.snoozedUntil, null);
      assert.ok(result.broadcastIds.includes(row.id));
    }
    await assertOpen([...prerequisites, next, future, other, unrelated, otherParticipant, participantItem,
      foreignWorkspace, differentOwner, nonDependency]);
  });

  await t.test('legacy workspace tasks without an owner accept only legacy or actor-owned Waiting rows', async () => {
    const { work: original, items } = await pair();
    await ctx.pool.query('UPDATE blocks SET user_id = NULL WHERE id = $1', [original.id]);
    const work = await read(original.id);
    const legacy = await waiting(work, await task(), {}, null);
    const otherOwner = await waiting(work, await task(), {}, 3);
    const result = await complete(work, items[1]);
    assert.deepEqual(result.companionBlocks.map(row => row.id).sort(), [...items, legacy].map(row => row.id).sort());
    assert.equal((await read(otherOwner.id)).properties.status, 'open');
  });

  await t.test('ordinary completion cannot release open dependencies using a companion update', async () => {
    const { work, items } = await pair();
    for (const companionUpdates of [[], options(work, items[0]).companionUpdates]) {
      await assert.rejects(complete(work, items[0], { resolveWaitingItemId: null, companionUpdates }), { publicCode: 'TASK_DEPENDENCY_BLOCKED' });
    }
    await assertOpen([work, ...items]);
  });

  await t.test('stale primary or task revisions leave the entire group untouched', async () => {
    const { work, items } = await pair();
    await ctx.pool.query('UPDATE blocks SET updated_at=$2 WHERE id=$1', [items[1].id, '2026-10-23T15:00:00Z']);
    const before = await operationCount();
    await assert.rejects(complete(work, items[1]), { publicCode: 'COMPLETION_COMPANION_CONFLICT' });
    await assert.rejects(complete(work, await read(items[1].id), { expectedRevision: 'stale-revision' }), { publicCode: 'COMPLETION_CONFLICT' });
    assert.equal(await operationCount(), before);
    await assertOpen([work, ...items]);
  });

  await t.test('a marker or forged companion cannot claim another task\'s Waiting row', async () => {
    const { work: initial, items, prerequisites } = await pair();
    const unrelatedWork = await task(), unrelated = await waiting(unrelatedWork, prerequisites[0]);
    const work = await mark(initial, [...items, unrelated]);
    await assert.rejects(complete(work, items[1]), { publicCode: 'TASK_DEPENDENCY_BLOCKED' });
    const forged = { ...unrelated, properties: { ...unrelated.properties, linkedBlockId: work.id } };
    await assert.rejects(complete(work, forged), { publicCode: 'COMPLETION_WAITING_TARGET_CONFLICT' });
    await assertOpen([work, ...items, unrelatedWork, unrelated]);
  });

  await t.test('a linked local id with multiple occurrences fails closed', async () => {
    const { work: initial, prerequisites, items } = await pair();
    const work = await ctx.blockDB.updateBlock(initial.id, { properties: { ...initial.properties, local_id: 'ambiguous-series' } });
    const next = await task({ local_id: 'ambiguous-series' }, '2026-10-24');
    const ambiguous = await waiting(work, prerequisites[0], { linkedBlockId: 'ambiguous-series' });
    await assert.rejects(complete(work, items[1]), /ambiguous/i);
    await assertOpen([work, next, ...items, ambiguous]);
  });

  await t.test('secondary companion failure rolls back work and all preceding companion writes', async () => {
    const { work, items } = await pair();
    const before = await operationCount(), originalConnect = ctx.pool.connect;
    let writes = 0;
    ctx.pool.connect = async () => {
      const client = await originalConnect.call(ctx.pool);
      const originalQuery = client.query;
      const originalRelease = client.release;
      const query = client.query.bind(client);
      client.query = async (sql, args) => {
        if (sql.startsWith('UPDATE blocks SET properties = $1, updated_at = $2 WHERE id = $3') && items.some(row => row.id === args[2])) {
          if (++writes === 2) throw new Error('synthetic second companion write failure');
        }
        return query(sql, args);
      };
      client.release = (...args) => {
        client.query = originalQuery;
        client.release = originalRelease;
        return originalRelease.apply(client, args);
      };
      return client;
    };
    try { await assert.rejects(complete(work, items[1]), /synthetic second companion write failure/); }
    finally { ctx.pool.connect = originalConnect; }
    assert.equal(writes, 2);
    assert.equal(await operationCount(), before);
    await assertOpen([work, ...items]);
  });

  await t.test('retries are idempotent and old completion cannot overwrite a newer reopen', async () => {
    const { work, items } = await pair();
    const result = await complete(work, items[1]);
    const before = await operationCount();
    const duplicate = await complete(work, items[1]);
    assert.equal(duplicate.duplicate, true); assert.equal(await operationCount(), before);
    assert.equal(duplicate.revision, result.revision);
    await ctx.blockDB.setTaskCompletion({ taskRef: work.id, completed: false,
      mutationId: 'multi-waiting-reopen', expectedRevision: result.revision, userId: 1, workspaceId: 'ws-1' });
    await assert.rejects(complete(work, items[1]), { publicCode: 'COMPLETION_CONFLICT' });
    assert.equal((await read(work.id)).properties.status, 'open');
    assert.equal((await read(items[0].id)).properties.status, 'done');
  });

  await t.test('concurrent duplicate requests commit a single group completion', async () => {
    const { work, items } = await pair();
    const results = await Promise.all([complete(work, items[1]), complete(work, items[1])]);
    assert.equal(results.filter(result => result.duplicate).length, 1);
    assert.equal(results[0].revision, results[1].revision);
    for (const row of [work, ...items]) assert.equal((await read(row.id)).properties.status, 'done');
  });

  await t.test('simultaneous completion from different sibling cards commits one shared identity', async () => {
    const { work, items } = await pair();
    const results = await Promise.allSettled(items.map(item => complete(work, item)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.publicCode, 'COMPLETION_CONFLICT');
    const winner = results.find(result => result.status === 'fulfilled').value;
    for (const row of items) {
      const current = await read(row.id);
      assert.equal(current.properties.status, 'done');
      assert.equal(current.properties.waitingCompletionMutationId, winner.task.properties._completionMutationId);
    }
    const sibling = await read(items[1].id), before = await operationCount();
    const retry = await complete(winner.task, sibling, { mutationId: sibling.properties.waitingCompletionMutationId });
    assert.equal(retry.duplicate, true);
    assert.equal(await operationCount(), before);
  });

  await t.test('a concurrent duplicate cannot undo canonical reopen in either lock order', async () => {
    const { work, items } = await pair();
    const result = await complete(work, items[1]);
    const outcomes = await Promise.allSettled([
      ctx.blockDB.setTaskCompletion({ taskRef: work.id, completed: false,
        mutationId: 'concurrent-group-reopen', expectedRevision: result.revision, userId: 1, workspaceId: 'ws-1' }),
      complete(work, items[1]),
    ]);
    assert.equal(outcomes[0].status, 'fulfilled');
    // Real PostgreSQL may grant either request the row lock first. A duplicate
    // that wins first is a no-op; one following the reopen must conflict.
    if (outcomes[1].status === 'rejected') {
      assert.equal(outcomes[1].reason.publicCode, 'COMPLETION_CONFLICT');
    } else {
      assert.equal(outcomes[1].value.duplicate, true);
      assert.equal(outcomes[1].value.revision, result.revision);
    }
    const current = await read(work.id);
    assert.equal(current.properties.status, 'open');
    assert.equal(current.properties._completionMutationId, 'concurrent-group-reopen');
    assert.equal(current.properties._completionRevision, outcomes[0].value.revision);
    await assert.rejects(complete(work, items[1]), { publicCode: 'COMPLETION_CONFLICT' });
    assert.deepEqual(await read(work.id), current, 'a later stale retry cannot alter reopened work');
  });

  await t.test('cleanup guard atomically rejects a reopened, replaced, or foreign Waiting completion', async () => {
    const { work, items } = await pair();
    await complete(work, items[1]);
    const reminder = await task({ source: 'waiting-checkin', delegatedItemId: items[0].id });
    const run = (guard, mutationId) => ctx.blockDB.setTaskCompletion({ taskRef: reminder.id, completed: true,
      completedAt: at, mutationId, userId: 1, workspaceId: 'ws-1', waitingCompletionGuard: guard });
    const before = await operationCount();
    await assert.rejects(run({ itemId: items[0].id, completedAt: '2026-10-23T13:00:00Z' }, 'wrong-completion'), { publicCode: 'WAITING_COMPLETION_SUPERSEDED' });
    const foreign = await waiting(work, work, { status: 'done', completedAt: at }, 2, 'ws-2');
    await assert.rejects(run({ itemId: foreign.id, completedAt: at }, 'foreign-completion'), { publicCode: 'WAITING_COMPLETION_SUPERSEDED' });
    const current = await read(items[0].id);
    await ctx.blockDB.updateBlock(current.id, { properties: { ...current.properties, status: 'open' } });
    const afterReopen = await operationCount();
    await assert.rejects(run({ itemId: current.id, completedAt: at }, 'reopened-completion'), { publicCode: 'WAITING_COMPLETION_SUPERSEDED' });
    assert.equal(await operationCount(), afterReopen);
    assert.ok(afterReopen > before);
    await assertOpen([reminder, current]);
    const sibling = await read(items[1].id);
    const valid = await run({ itemId: sibling.id, completedAt: at }, 'still-current-completion');
    assert.equal(valid.task.properties.status, 'done');
  });

  await t.test('explicit option requires a versioned owned Waiting action and a real task', async () => {
    const { work, items } = await pair();
    await assert.rejects(complete(work, items[1], { companionUpdates: [] }), { publicCode: 'COMPLETION_WAITING_INVALID' });
    await assert.rejects(complete(work, items[1], { completed: false }), { publicCode: 'COMPLETION_WAITING_INVALID' });
    await assert.rejects(complete(work, items[1], { userId: 3 }), { publicCode: 'COMPLETION_WAITING_TARGET_CONFLICT' });
    await assert.rejects(complete(work, items[1], { taskRef: 'missing-task', taskDate: date }), { publicCode: 'COMPLETION_WAITING_TARGET_CONFLICT' });
    await assertOpen([work, ...items]);
  });
});
