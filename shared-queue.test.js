const test = require('node:test');
const assert = require('node:assert/strict');
const { projectPublicQueue } = require('./lib/public-working-queue');
test('public projection joins canonical IDs only and whitelists queue metadata', () => {
  const allowed = [{ id: 'alias', blockId: 'a', title: 'Already public', reactions: { '👍': 2 } }, { id: 'b', blockId: 'b', redacted: true }];
  const snapshot = { items: [
    { task: { id: 'a', properties: { notes: 'secret' } }, note: 'secret', delegated: ['secret'], status: 'background', needsYou: true, taskPriority: 'high' },
    { task: { id: 'b' }, status: 'background' }, { task: { id: 'private' }, status: 'foreground' },
    { task: { id: 'alias' }, status: 'background' }
  ] };
  const result = projectPublicQueue(allowed, snapshot);
  assert.equal(result.length, 1); assert.equal(result[0].id, 'alias');
  assert.deepEqual(result[0].queue, { lane: 'needs-you', status: 'background', priority: 'high', order: 0 });
  assert.equal(result[0].reactions['👍'], 2); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('foreground wins over attention, completion wins over attention, priority order is canonical', () => {
  const states = ['foreground', 'completed', 'queued', 'queued', 'paused', 'blocked'];
  const tasks = states.map((_, i) => ({ id: String(i), blockId: String(i) }));
  const result = projectPublicQueue(tasks, { priorityOrder: ['3', '2'], items: states.map((status, i) => ({ task: { id: String(i) }, status, needsYou: i < 2 })) });
  assert.deepEqual(result.map(t => t.queue.lane), ['foreground', 'completed', 'priority', 'priority', 'background', 'background']);
  assert.equal(result[1].status, 'done');
  assert.equal(result[2].queue.order, 1); assert.equal(result[3].queue.order, 0);
});
test('hidden priority membership cannot be inferred from public ordering', () => {
  const tasks = [{ id: 'a', blockId: 'a' }];
  const item = { task: { id: 'a' }, status: 'queued' };
  assert.deepEqual(projectPublicQueue(tasks, { items: [item], priorityOrder: ['a'] }),
    projectPublicQueue(tasks, { items: [item], priorityOrder: ['secret-1', 'secret-2', 'a'] }));
});
test('shared queue actual routes preserve privacy and viewer permissions', { skip: !process.env.DCC_TEST_DATABASE_URL }, async t => {
  const f = await require('./test-support/shared-queue-fixture').createSharedQueueFixture(); t.after(() => f.close());
  let original;
  await t.test('anonymous, signed-in viewer and owner share the same filtered queue', async () => {
    for (const user of [undefined, 3, 1]) {
      const response = await f.request(f.url, { user }); assert.equal(response.status, 200, JSON.stringify(response.body));
      const data = response.body; assert.equal(data.view, 'working-queue'); assert.equal(data.tasks.length, 8);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.ok(!JSON.stringify(data).includes('SENTINEL')); assert.equal(data.blocks, undefined);
      assert.equal(data.tasks.find(t => t.blockId === 'review').queue.lane, 'needs-you');
      assert.equal(data.tasks.find(t => t.blockId === 'paused').queue.lane, 'background');
      assert.equal(data.viewer.capabilities.place_bounty, !!user); original = data;
    }
  });
  await t.test('viewing never writes foreground, queue metadata or actuals', async () => {
    const before = (await f.pool.query("SELECT properties FROM blocks WHERE id='focus'")).rows;
    const queue = (await f.pool.query('SELECT state FROM work_rotations')).rows;
    await f.request(f.url); await f.request(f.url, { user: 1 });
    assert.deepEqual((await f.pool.query("SELECT properties FROM blocks WHERE id='focus'")).rows, before);
    assert.deepEqual((await f.pool.query('SELECT state FROM work_rotations')).rows, queue);
  });
  await t.test('reaction toggles use existing actor identity and reject private targets', async () => {
    const body = { taskId: 'local-focus', emoji: '👍', date: f.date };
    let response = await f.request(f.url + '/reactions', { body }); assert.equal(response.status, 200); assert.equal(response.body.counts['👍'], 1);
    response = await f.request(f.url + '/reactions', { body }); assert.equal(response.status, 200); assert.equal(response.body.counts['👍'] || 0, 0);
    response = await f.request(f.url + '/reactions', { body: { ...body, taskId: 'local-private' } }); assert.equal(response.status, 404);
    assert.equal((await f.pool.query('SELECT * FROM todo_task_reactions')).rowCount, 0);
    assert.equal((await f.request('/api/working-queue', { body: { action: 'start', taskId: 'private' } })).status, 401);
  });
  await t.test('rewards and bounties remain pending; guests cannot place points bounties', async () => {
    const body = { kind: 'bounty', taskId: 'local-focus', date: f.date };
    assert.equal((await f.request(f.url + '/sponsorships', { body })).status, 403);
    const offer = await f.request(f.url + '/sponsorships', { user: 3, body }); assert.equal(offer.status, 201); assert.equal(offer.body.status, 'pending');
    const reward = await f.request(f.url + '/sponsorships', { body: { ...body, kind: 'reward', rewardTitle: 'Coffee together', sponsorName: 'Casey' } });
    assert.equal(reward.status, 201); assert.equal(reward.body.status, 'pending');
    assert.equal((await f.pool.query('SELECT * FROM slot_rewards')).rowCount, 0);
    const hidden = await f.request(f.url + '/sponsorships', { body: { ...body, kind: 'reward', taskId: 'local-private', rewardTitle: 'Hidden', sponsorName: 'Casey' } }); assert.equal(hidden.status, 404);
  });
  await t.test('hiding a task removes its social records and stale mutation access', async () => {
    await f.blockDB.updateBlock('focus', { properties: { publicVisibility: 'private' } });
    const response = await f.request(f.url); assert.equal(response.status, 200);
    assert.ok(!response.body.tasks.some(t => t.blockId === 'focus')); assert.equal(response.body.sponsorships.length, 0);
    assert.equal((await f.request(f.url + '/comments', { body: { taskId: 'local-focus', body: 'hidden', date: f.date } })).status, 404);
  });
  await t.test('revoked and invalid links refuse read and social writes identically', async () => {
    await f.pool.query('UPDATE todo_shares SET active=FALSE');
    for (const url of [f.url, '/api/public/todo-share/nonexistent']) {
      assert.equal((await f.request(url)).status, 404);
      assert.equal((await f.request(url + '/reactions', { body: { taskId: 'local-review', emoji: '👍' } })).status, 404);
      assert.equal((await f.request(url + '/sponsorships', { body: { kind: 'reward' } })).status, 404);
    }
  });
  assert.ok(original.tasks.length);
});
