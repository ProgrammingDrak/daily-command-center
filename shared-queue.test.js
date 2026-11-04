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
      const data = response.body; assert.equal(data.view, 'activity-v2'); assert.equal(data.tasks.length, 8);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.ok(!JSON.stringify(data).includes('SENTINEL')); assert.equal(data.blocks, undefined);
      const lane = id => data.tasks.find(t => t.blockId === id).activity.lane;
      assert.equal(lane('focus'), 'now'); assert.equal(lane('done'), 'done');
      for (const id of ['review', 'paused', 'blocked', 'background', 'high', 'low']) assert.equal(lane(id), 'next', id);
      assert.ok(!JSON.stringify(data).includes('needs-you')); assert.equal(data.nextChangeAt, null);
      assert.equal(data.viewer.capabilities.place_bounty, !!user); original = data;
    }
  });
  await t.test('a live worker report shows Running and schedules the lease expiry', async () => {
    const until = new Date(Date.now() + 10 * 60000).toISOString();
    await f.pool.query("INSERT INTO delegated_work(user_id,workspace_id,task_id,work_key,report) VALUES(1,'ws-1','background','live',$1)",
      [{ phase: 'working', work: { source: 'claude', id: 'WORKER SENTINEL' }, at: new Date().toISOString(), summary: 'WORKER REPORT SENTINEL',
        execution: { state: 'running', observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: until } }]);
    const data = (await f.request(f.url)).body;
    assert.equal(data.tasks.find(t => t.blockId === 'background').activity.lane, 'running');
    assert.equal(data.nextChangeAt, until);
    assert.ok(!JSON.stringify(data).includes('SENTINEL')); assert.ok(!JSON.stringify(data).includes('claude'));
    await f.pool.query("DELETE FROM delegated_work WHERE work_key='live'");
  });
  await t.test('DCC_SHARE_ACTIVITY_V2=false restores the PR #444 payload', async () => {
    process.env.DCC_SHARE_ACTIVITY_V2 = 'false';
    try {
      const data = (await f.request(f.url)).body;
      assert.equal(data.view, 'working-queue'); assert.equal(data.tasks.find(t => t.blockId === 'review').queue.lane, 'needs-you');
    } finally { delete process.env.DCC_SHARE_ACTIVITY_V2; }
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

// ── Activity v2 (Now / Running / Up next / Later / Done) ──
const { projectPublicActivity, PUBLIC_TASK_FIELDS } = require('./lib/public-working-queue');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const runningReport = (observed, until, extra = {}) => ({ phase: 'working', work: { source: 'claude', id: 'WORKER-ID-SENTINEL' },
  note: 'REPORT NOTE SENTINEL', reviewActions: ['REVIEW SENTINEL'],
  execution: { state: 'running', observedAt: new Date(observed).toISOString(), validUntil: new Date(until).toISOString() }, ...extra });
const Policy = require('./public/js/queue-policy');
function snapItem(id, status, extra = {}) {
  const item = { task: { id, properties: { startedAt: status === 'foreground' ? '2026-10-29T11:14:37Z' : undefined, notes: 'TASK NOTE SENTINEL' } },
    status, note: 'QUEUE NOTE SENTINEL', taskPriority: 'High', delegated: [], dueAt: '2026-10-29T13:00:00Z', generation: 'GEN-SENTINEL',
    actualMinutes: 42, ...extra };
  return Policy.presentation(item, NOW);
}
const pub = (id, extra = {}) => ({ id: 'local-' + id, blockId: id, title: 'Task ' + id, status: 'open', detail: 'DETAIL SENTINEL', identityIds: ['IDENTITY-SENTINEL'], ...extra });
function deepKeys(value, out = new Set()) {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); deepKeys(v, out); }
  return out;
}

test('activity v2 lanes: foreground, live worker, snooze and Needs You', () => {
  const items = [
    snapItem('focus', 'foreground'),
    snapItem('worker', 'background', { delegated: [runningReport(NOW - 3 * 60000, NOW + 5 * 60000)] }),
    snapItem('stale', 'background', { delegated: [runningReport(NOW - 20 * 60000, NOW - 60000)] }),
    snapItem('snoozed', 'background', { dueAt: '2026-10-29T13:00:00Z', snoozedUntil: '2026-10-29T13:00:00Z' }),
    snapItem('review', 'queued', { needsReview: true }),
    snapItem('done', 'completed', { completedAt: Date.parse('2026-10-29T09:05:30Z') })
  ];
  const tasks = ['focus', 'worker', 'stale', 'snoozed', 'review', 'done'].map(id => pub(id));
  const { tasks: out, nextChangeAt } = projectPublicActivity(tasks, { items, priorityOrder: ['review'] }, { now: NOW });
  const lane = id => out.find(t => t.blockId === id).activity.lane;
  assert.equal(lane('focus'), 'now');
  assert.equal(lane('worker'), 'running');
  assert.equal(lane('stale'), 'next', 'an expired lease is not running');
  assert.equal(lane('snoozed'), 'next', 'a snooze is attention, not work');
  assert.equal(lane('review'), 'next', 'Needs You folds into Up next');
  assert.equal(lane('done'), 'done');
  assert.equal(out.find(t => t.blockId === 'focus').activity.startedAt, '2026-10-29T11:14:00.000Z');
  assert.equal(out.find(t => t.blockId === 'worker').activity.confirmedAt, '2026-10-29T11:57:00.000Z');
  assert.equal(out.find(t => t.blockId === 'done').activity.completedAt, '2026-10-29T09:05:00.000Z');
  assert.equal(nextChangeAt, new Date(NOW + 5 * 60000).toISOString());
  assert.equal(new Set(out.map(t => t.blockId)).size, out.length, 'each task appears once');
});

test('activity v2 never serializes queue, worker, reminder or actuals fields', () => {
  const items = [snapItem('focus', 'foreground'), snapItem('worker', 'background', { delegated: [runningReport(NOW - 60000, NOW + 60000)] }),
    snapItem('review', 'queued', { needsReview: true })];
  const { tasks } = projectPublicActivity(['focus', 'worker', 'review'].map(id => pub(id)), { items, priorityOrder: [] }, { now: NOW });
  const text = JSON.stringify(tasks);
  assert.ok(!/SENTINEL|claude/.test(text), text);
  const keys = deepKeys(tasks);
  for (const key of ['note', 'notes', 'delegated', 'reports', 'execution', 'workers', 'reviewActions', 'dueAt', 'snoozedUntil',
    'generation', 'needsYou', 'needsReview', 'snoozed', 'actualMinutes', 'detail', 'identityIds', 'properties'])
    assert.ok(!keys.has(key), 'leaked ' + key);
  for (const task of tasks) for (const key of Object.keys(task)) assert.ok([...PUBLIC_TASK_FIELDS, 'status', 'activity', 'queue'].includes(key), key);
  assert.ok(!tasks.some(t => t.queue.lane === 'needs-you'));
});

test('hidden focus is indistinguishable from no focus', () => {
  const visible = [pub('a')];
  const base = { items: [snapItem('a', 'queued')], priorityOrder: ['a'] };
  const none = projectPublicActivity(visible, base, { now: NOW });
  for (const hidden of ['private', 'other-date', 'other-workspace'])
    assert.deepEqual(projectPublicActivity(visible, { items: [snapItem(hidden, 'foreground'), ...base.items], priorityOrder: [hidden, 'a'] }, { now: NOW }), none);
  const redacted = projectPublicActivity([...visible, pub('p', { redacted: true })], { items: [snapItem('p', 'foreground'), ...base.items], priorityOrder: ['a'] }, { now: NOW });
  assert.deepEqual(redacted, none);
});

test('Up next keeps canonical order without gaps from hidden rows', () => {
  // Snapshot order is the canonical order (priorityOrder is derived from it).
  const items = ['b', 'secret', 'a', 'x'].map(id => snapItem(id, 'queued'));
  const { tasks } = projectPublicActivity(['a', 'b', 'x'].map(id => pub(id)), { items, priorityOrder: ['b', 'secret', 'a', 'x'] }, { now: NOW });
  assert.deepEqual(tasks.map(t => [t.blockId, t.activity.order]), [['b', 0], ['a', 1], ['x', 2]]);
});

test('Later today lists shared timed tasks by start and drops past meetings', () => {
  const day = [
    pub('late', { start: '16:00', end: '16:30' }), pub('soon', { start: '13:00', end: '13:30', itemType: 'calendar' }),
    pub('past-meeting', { start: '09:00', end: '09:30', itemType: 'calendar' }), pub('overdue-task', { start: '08:00', end: '08:30', status: 'overdue' }),
    pub('untimed', { untimed: true }), pub('sub', { start: '14:00', subtaskOf: 'late' }), pub('triage', { start: '14:00', triageBlock: true }),
    pub('finished', { start: '07:00', status: 'done' }), pub('queued', { start: '15:00' })
  ];
  const { tasks } = projectPublicActivity(day, { items: [snapItem('queued', 'queued')], priorityOrder: ['queued'] }, { now: NOW, localMinutes: 12 * 60 });
  const by = lane => tasks.filter(t => t.activity.lane === lane).map(t => t.blockId);
  assert.deepEqual(by('later'), ['overdue-task', 'soon', 'late']);
  assert.deepEqual(by('next'), ['queued']);
  assert.deepEqual(by('done'), ['finished']);
  assert.ok(!tasks.some(t => ['untimed', 'sub', 'triage', 'past-meeting'].includes(t.blockId)));
});
