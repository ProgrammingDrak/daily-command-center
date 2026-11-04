// Drift guards between the owner Working Queue and the shared-link activity view.
// Both surfaces must call the same policy; these tests fail if either re-derives it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Policy = require('./public/js/queue-policy');
const Priority = require('./public/js/task-priority');
const CompletedFilter = require('./public/js/completed-queue-filter');
const TaskTypes = require('./public/js/task-types');
const { projectPublicActivity, VIEWER_LANE, PUBLIC_TASK_FIELDS, ACTIVITY_FIELDS } = require('./lib/public-working-queue');
const { publicFeedType, TIME_ONLY_FEED_TYPES } = require('./lib/public-feed-type');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const STATUSES = ['foreground', 'background', 'queued', 'completed'];
const LEVELS = [...Priority.levels, undefined, 'urgent'];

// Small deterministic PRNG so failures reproduce.
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function pick(r, list) { return list[Math.floor(r() * list.length)]; }
function report(r) {
  const observed = NOW - Math.floor(r() * 30) * 60000;
  const until = observed + pick(r, [-1, 5, 14, 15, 16, 40]) * 60000;
  return { phase: pick(r, ['working', 'working', 'paused', 'needs-review']),
    work: pick(r, [{ source: 'claude', id: 'w' }, { source: '', id: 'w' }, { source: 'codex', id: 'x' }]),
    reviewActions: r() < 0.3 ? ['Look'] : [],
    execution: { state: pick(r, ['running', 'running', 'stopped']), observedAt: new Date(r() < 0.1 ? NOW + 60000 : observed).toISOString(),
      validUntil: new Date(until).toISOString() } };
}
function corpus(seed, size = 40) {
  const r = rng(seed);
  return Array.from({ length: size }, (_, n) => {
    const id = 't' + Math.floor(r() * size * 0.9); // some duplicate ids on purpose
    const status = pick(r, STATUSES);
    const due = r() < 0.3 ? new Date(NOW + (r() < 0.5 ? -1 : 1) * 600000).toISOString() : null;
    const delegated = Array.from({ length: Math.floor(r() * 3) }, () => report(r));
    const raw = { task: { id, properties: { startedAt: status === 'foreground' ? '2026-10-29T11:14:37Z' : undefined } }, status,
      taskPriority: pick(r, LEVELS), needsReview: r() < 0.2, needsYou: r() < 0.2, delegated, dueAt: due,
      snoozedUntil: due && r() < 0.5 ? due : null, completedAt: status === 'completed' ? NOW - Math.floor(r() * 3e8) : null, n };
    return { ...Policy.presentation({ ...raw, execution: Policy.execution(delegated, NOW) }, NOW) };
  });
}

test('Policy.lanes is a byte-for-byte no-op of the owner split it replaced (ae3b8e7)', () => {
  const source = execFileSync('git', ['show', 'ae3b8e7495f8009edb2463ce5a4b020aaeb2fc86:public/js/working-queue.js'], { encoding: 'utf8' });
  const line = source.split('\n').find(l => l.includes('const fg=all.filter('));
  assert.ok(line && line.includes('upNext=DCC.TaskPriority.group('), 'the old inline split must be sliced verbatim');
  const old = new Function('all', 'DCC', line + '\nreturn {fg,needs,background,upNext};');
  for (let seed = 1; seed <= 200; seed++) {
    const all = corpus(seed);
    const before = old(all, { TaskPriority: Priority });
    const after = Policy.lanes(all, Priority.group);
    assert.deepEqual([after.foreground, after.needs, after.background, after.priority], [before.fg, before.needs, before.background, before.upNext], 'seed ' + seed);
  }
  assert.throws(() => Policy.lanes([]), /TaskPriority.group/);
});

test('owner page calls the shared lane split instead of re-deriving it', () => {
  const owner = fs.readFileSync('./public/js/working-queue.js', 'utf8');
  assert.match(owner, /DCCQueuePolicy\.lanes\(all,DCC\.TaskPriority\.group\)/);
  assert.ok(!owner.includes("needs=all.filter("), 'inline Needs You split is back');
});

// Viewer lane per the shared policy plus the one viewer map.
function expectedViewerLane(item, owner) {
  if (owner.foreground.includes(item)) return 'now';
  if (owner.completed.includes(item)) return 'done';
  if (item.execution?.state === 'running' && (owner.background.includes(item) || owner.needs.includes(item))) return 'running';
  return 'next';
}

test('every shared card lands in the lane the owner policy implies', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const items = corpus(seed).filter((item, i, all) => all.findIndex(o => o.task.id === item.task.id) === i);
    const visible = items.filter((_, i) => i % 4 !== 3); // some queue rows are not on the shared day
    const publicTasks = visible.map(item => ({ id: 'local-' + item.task.id, blockId: item.task.id, title: 'T ' + item.task.id, status: 'open' }));
    const owner = Policy.lanes(items, Priority.group);
    const { tasks } = projectPublicActivity(publicTasks, { items, priorityOrder: [] }, { now: NOW, timeZone: 'UTC', today: true });
    const byId = new Map(tasks.map(t => [t.blockId, t]));
    for (const item of visible) {
      const want = expectedViewerLane(item, owner);
      const got = byId.get(item.task.id);
      if (want === 'done' && !CompletedFilter.select([item], 'today', NOW, 'UTC').rows.length) { assert.notEqual(got?.activity.lane, 'done'); continue; }
      assert.equal(got?.activity.lane, want, 'seed ' + seed + ' ' + item.task.id);
      if (want === 'running') assert.equal(got.activity.confirmedAt, new Date(Math.floor(Date.parse(item.execution.observedAt) / 60000) * 60000).toISOString());
    }
    for (const item of items.filter(i => !visible.includes(i))) assert.ok(!byId.has(item.task.id), 'hidden queue row leaked');
  }
});

test('Running means exactly the owner lease rule, including the 15-minute cap', () => {
  const live = (o, u, extra = {}) => ({ phase: 'working', work: { source: 'claude', id: 'w' },
    execution: { state: 'running', observedAt: new Date(NOW + o * 60000).toISOString(), validUntil: new Date(NOW + u * 60000).toISOString() }, ...extra });
  const cases = { ok: [live(-2, 5)], long: [live(-1, 30)], future: [live(1, 5)], noSource: [live(-2, 5, { work: { source: '', id: 'w' } })],
    paused: [live(-2, 5, { phase: 'paused' })], expired: [live(-20, -1)],
    mixed: [live(-2, 5), live(-1, 40)] /* the rejected long lease must not supply confirmedAt */ };
  for (const [id, delegated] of Object.entries(cases)) {
    const item = Policy.presentation({ task: { id, properties: {} }, status: 'queued', delegated, execution: Policy.execution(delegated, NOW) }, NOW);
    const { tasks } = projectPublicActivity([{ id, blockId: id, title: id }], { items: [item], priorityOrder: [] }, { now: NOW });
    assert.equal(tasks[0].activity.lane === 'running', Policy.execution(delegated, NOW).state === 'running', id);
    if (id === 'mixed') assert.equal(tasks[0].activity.confirmedAt, new Date(NOW - 2 * 60000).toISOString());
  }
});

test('Up next keeps TaskPriority grouping across folded Needs You and snoozed rows', () => {
  const mk = (id, status, taskPriority, extra = {}) => Policy.presentation({ task: { id, properties: {} }, status, taskPriority, delegated: [], ...extra }, NOW);
  const due = new Date(NOW + 600000).toISOString();
  const items = [mk('low', 'queued', 'Low'), mk('snoozedHigh', 'background', 'Very high', { dueAt: due, snoozedUntil: due }),
    mk('needsMed', 'queued', 'Medium', { needsReview: true }), mk('high', 'queued', 'High'), mk('hidden', 'queued', 'Very high')];
  const pub = ['low', 'snoozedHigh', 'needsMed', 'high'].map(id => ({ id, blockId: id, title: id }));
  const { tasks } = projectPublicActivity(pub, { items, priorityOrder: [] }, { now: NOW });
  assert.deepEqual(tasks.filter(t => t.activity.lane === 'next').map(t => [t.blockId, t.activity.order]),
    [['snoozedHigh', 0], ['high', 1], ['needsMed', 2], ['low', 3]]);
});

test('Done today uses the owner completed filter and its order', () => {
  const mk = (id, completedAt) => ({ task: { id, properties: {} }, status: 'completed', completedAt, delegated: [] });
  const items = [mk('yesterday', NOW - 86400000), mk('a', NOW - 3600000), mk('b', NOW - 3600000), mk('later', NOW - 60000), mk('unknown', null)];
  const pub = items.map(i => ({ id: i.task.id, blockId: i.task.id, title: i.task.id }));
  const { tasks } = projectPublicActivity(pub, { items, priorityOrder: [] }, { now: NOW, timeZone: 'UTC', today: true });
  const expected = CompletedFilter.select(items, 'today', NOW, 'UTC').rows.map(i => i.task.id);
  assert.deepEqual(tasks.filter(t => t.activity.lane === 'done').map(t => t.blockId), expected);
  assert.deepEqual(expected, ['later', 'a', 'b']);
  // Other shared dates are not "today": completions stay within the day allowlist.
  const past = projectPublicActivity(pub, { items, priorityOrder: [] }, { now: NOW, timeZone: 'UTC', today: false }).tasks;
  assert.equal(past.filter(t => t.activity.lane === 'done').length, 5);
});

test('fixed-time feed types cover every TaskTypes fixed type', () => {
  for (const kind of TaskTypes.fixedTypes()) assert.ok(TIME_ONLY_FEED_TYPES.has(publicFeedType({ kind })), kind);
  assert.equal(publicFeedType({ kind: 'free_time' }), 'break', 'free_time is the one documented extra');
  assert.ok(!TIME_ONLY_FEED_TYPES.has(publicFeedType({ kind: 'task' })));
});

test('viewer output is limited to the allowlisted fields', () => {
  const items = corpus(7);
  const pub = items.map(i => ({ id: i.task.id, blockId: i.task.id, title: 'x', detail: 'DETAIL SENTINEL', sourceContext: 'SOURCE SENTINEL', identityIds: ['ID SENTINEL'] }));
  const { tasks } = projectPublicActivity(pub, { items, priorityOrder: [] }, { now: NOW, timeZone: 'UTC', today: true });
  assert.ok(!/SENTINEL|claude|codex/.test(JSON.stringify(tasks)));
  for (const t of tasks) {
    for (const key of Object.keys(t)) assert.ok([...PUBLIC_TASK_FIELDS, 'status', 'activity', 'queue'].includes(key), key);
    for (const key of Object.keys(t.activity)) assert.ok(ACTIVITY_FIELDS.includes(key), key);
    assert.deepEqual(Object.keys(t.queue).sort(), ['lane', 'order']);
  }
  assert.equal(Object.keys(VIEWER_LANE).length, 5);
});

// ── Import guards: each surface keeps calling the shared code ──
const read = file => fs.readFileSync(file, 'utf8');
function definitions(pattern) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.cjs'], { encoding: 'utf8' }).split('\n')
    .filter(f => f && !f.endsWith('.test.js') && !f.startsWith('node_modules/'));
  return files.filter(f => pattern.test(read(f)));
}

test('the shared-link projection imports the owner policy and holds no private-field reads', () => {
  const src = read('./lib/public-working-queue.js');
  for (const dep of ['../public/js/queue-policy', '../public/js/task-priority', '../public/js/completed-queue-filter', './public-feed-type'])
    assert.ok(src.includes(`require('${dep}')`), dep);
  for (const banned of ['.delegated', 'reviewActions', 'MAX_LEASE', '15 * 60', "'ooo'", "'break'", '.note', 'snoozedUntil', 'dueAt'])
    assert.ok(!src.includes(banned), 'projection must not touch ' + banned);
});

test('the shared-link page renders through owner modules and opens no stream of its own', () => {
  const page = read('./public/js/public-todo-share.js');
  for (const banned of ['new EventSource', 'setInterval(load', 'DCCQueuePolicy', 'needsYou', 'snoozed', 'delegated', 'shared-queue-grid'])
    assert.ok(!page.includes(banned), 'share page must not contain ' + banned);
  assert.ok(page.includes('renderItineraryListRow('), 'share cards use the owner row renderer');
  const calls = page.split('renderItineraryListRow(').slice(1).map(s => s.slice(0, s.indexOf('});')));
  for (const call of calls) assert.ok(!/\bon[A-Z]\w*\s*:/.test(call), 'viewer rows get no owner callbacks');
  assert.ok(page.includes('createLiveChannel(') && page.includes('createTaskRefreshCoordinator('));
  const html = read('./public-todo.html');
  for (const need of ['/public/css/working-queue.css', '/public/js/itinerary-card.js', '/public/js/refresh-coordinator.js', '/public/js/live-channel.js', '/public/js/queue-layout.js'])
    assert.ok(html.includes(need), need);
  for (const ownerOnly of ['/public/js/working-queue.js', '/public/js/queue-policy.js', '/public/js/sse.js', '/public/js/block-store.js'])
    assert.ok(!html.includes(ownerOnly), ownerOnly);
  const css = read('./public/css/shared-queue.css');
  // Lane and card boxes come from working-queue.css; the share sheet may not restyle them.
  for (const dup of ['.shared-queue-grid', '.shared-queue-col', '--brand']) assert.ok(!css.includes(dup), dup);
  assert.ok(!/\.shared-queue-(lane|card|done|now|running)\s*\{/.test(css), 'share sheet redefines a lane or card box');
});

test('one definition each for shared helpers', () => {
  assert.deepEqual(definitions(/function createTaskRefreshCoordinator\(/), ['public/js/refresh-coordinator.js']);
  assert.deepEqual(definitions(/\bVIEWER_LANE\s*=/), ['lib/public-working-queue.js']);
  assert.deepEqual(definitions(/function minutesOfDay\(/), ['lib/public-working-queue.js']);
  assert.deepEqual(definitions(/function publicFeedType\(/), ['lib/public-feed-type.js']);
  assert.deepEqual(definitions(/function arrange\(/), ['public/js/queue-layout.js']);
  assert.ok(read('./public/js/sse.js').includes('DCCRefreshCoordinator'), 'owner live loop imports the shared coordinator');
});
