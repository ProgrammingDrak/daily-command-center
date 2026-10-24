const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./public/js/glasses-model');
const { create } = require('./public/js/glasses-tasks-session');
const W = require('./public/js/workout-model');
const block = (id, properties = {}, extra = {}) => ({ id, type: 'block', date: '2026-10-24', sort_order: 1000, properties: { kind: 'task', title: id, start: '09:00', end: '10:00', ...properties }, ...extra });
function harness() {
  let account = 1, connected = true, mode = '', serial = 0;
  const db = new Map([['a', block('a')]]), saved = new Map(), calls = [], receipts = new Map();
  const options = { uuid: () => 'mutation-' + (++serial), online: () => connected,
    storage: { getItem: k => saved.get(k) || null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
    request: async (url, opts = {}) => {
      calls.push({ url, ...opts });
      if (url === '/api/me') { if (account === 0) throw Object.assign(new Error('Auth'), { status: 401 }); return { userId: account, workspaceId: 'ws-' + account }; }
      if (url.startsWith('/api/sync/bootstrap')) return { date: '2026-10-24', workspaceId: 'ws-' + account, blocks: [...db.values()], globals: [] };
      if (url.startsWith('/api/tasks/open')) return { rows: [], overlays: {} };
      if (url.startsWith('/api/blocks/')) return structuredClone(db.get(url.split('/').at(-1)));
      if (url.endsWith('/completion')) {
        const b = opts.body, row = db.get(url.split('/')[3]);
        if (mode === '409') throw Object.assign(new Error('Conflict'), { status: 409 });
        if (!receipts.has(b.mutationId)) { row.properties.status = 'done'; row.properties._completionRevision = b.mutationId; receipts.set(b.mutationId, true); }
        if (mode === 'lost') { mode = ''; throw new Error('Response lost'); }
        return { ok: true, mutationId: b.mutationId };
      }
      throw new Error('Unexpected request ' + url);
    } };
  return { options, db, saved, calls, receipts, create: () => create(options), account: v => { account = v; }, online: v => { connected = v; }, mode: v => { mode = v; } };
}
test('canonical order, task projection, nesting, status overlays and hidden rows', () => {
  const root = { id: 'root', type: 'day_root', date: '2026-10-24', properties: { _done: { ids: ['legacy'] }, _deleted: ['hidden'] } };
  const snapshot = { date: '2026-10-24', blocks: [root, block('z', {}, { sort_order: 10 }), block('a', {}, { sort_order: 20 }), block('child', { subtaskOf: 'z' }, { sort_order: 30 }), block('done', { done: true }), block('legacy'), block('hidden'), block('scaffold', { kind: 'project' }), block('untimed', { start: null, end: null })], globals: [block('pool', { kind: 'backlog', stage: 'Whenever', local_id: 'pool' }, { date: null })] };
  const v = M.project(snapshot);
  assert.deepEqual(v.itinerary.slice(0, 3).map(t => t.taskId), ['z', 'child', 'a']);
  assert.equal(v.itinerary[1].depth, 1);
  assert.deepEqual(v.todos.map(t => t.taskId), ['z', 'child', 'a', 'untimed', 'pool']);
  assert.equal(v.all.some(t => ['hidden', 'scaffold'].includes(t.taskId)), false);
  assert.equal(v.itinerary.find(t => t.taskId === 'legacy').completed, true);
});
test('DCC timezone determines day and current/next, including midnight', () => {
  assert.equal(M.clock('America/Los_Angeles', new Date('2026-10-24T02:00:00Z')).date, '2026-10-23');
  assert.equal(M.clock('UTC', new Date('2026-10-24T00:00:00Z')).minutes, 0);
  const view = M.project({ date: '2026-10-24', blocks: [block('now'), block('next', { start: '11:00', end: '12:00' })] });
  assert.equal(M.currentNext(view, 570).current.taskId, 'now'); assert.equal(M.currentNext(view, 570).next.taskId, 'next');
});
test('backlog without local_id is present using canonical unscheduled membership', () => {
  const b = block('backlog-no-alias', { kind: 'backlog', stage: 'Whenever' }, { date: null });
  const v = M.project({ date: '2026-10-24', blocks: [], globals: [b] });
  assert.deepEqual(v.todos.map(t => t.taskId), ['backlog-no-alias']);
});
test('dateless backlog stays read-only to preserve DCC schedule-before-complete semantics', async () => {
  const h = harness(); h.db.set('a', block('a', { kind: 'backlog', stage: 'Whenever' }, { date: null }));
  const a = h.create(); await a.load({ taskId: 'a' }); await a.complete();
  assert.equal(a.state.row.completed, false); assert.equal(a.state.pending, null); assert.match(a.state.error, /Schedule this task/); assert.equal(h.calls.some(c => c.method === 'POST'), false);
});
test('backlog aliases preserve canonical parent/child depth', () => {
  const parent = block('parent', { kind: 'backlog', stage: 'Whenever' }, { date: null });
  const child = block('child', { kind: 'backlog', stage: 'Whenever', subtaskOf: 'blk-parent' }, { date: null, sort_order: 2000 });
  const v = M.project({ date: '2026-10-24', blocks: [], globals: [child, parent] });
  assert.deepEqual(v.anytime.map(t => [t.taskId, t.depth]), [['parent', 0], ['child', 1]]);
});
test('detail honors the same legacy completion overlay as the list', async () => {
  const h = harness(); h.db.set('root', { id: 'root', type: 'day_root', date: '2026-10-24', properties: { _done: { ids: ['a'] } } });
  const a = h.create(); await a.load({ taskId: 'a' }); assert.equal(a.state.row.completed, true); await a.complete();
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
});
test('per-tab receipts are independent and inaccessible tasks can be left unresolved', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.mode('lost'); await a.complete();
  const receipt = a.state.pending;
  a.leaveUnresolved(); assert.equal(a.state.pending, null); assert.equal(a.state.row, null);
  assert.ok([...h.saved.values()].some(raw => JSON.parse(raw).body.mutationId === receipt.body.mutationId));
  await a.load({}); assert.equal(a.state.pending, null); assert.ok(a.state.view);
});
test('completion receipt survives response loss and reload; retry uses one identity', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.mode('lost'); await a.complete();
  assert.ok(a.state.pending); assert.equal(a.state.row.completed, false); assert.equal(h.receipts.size, 1);
  const b = h.create(); await b.load({}); assert.ok(b.state.pending); await b.retry();
  assert.equal(b.state.row.completed, true); assert.equal(h.receipts.size, 1); assert.equal(h.saved.size, 0);
  const ids = h.calls.filter(c => c.method === 'POST').map(c => c.body.mutationId); assert.deepEqual(ids, ['mutation-1', 'mutation-1']);
});
test('concurrent completion clicks are serialized and already-done tasks do not post', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); await Promise.all([a.complete(), a.complete(), a.complete()]); await a.complete();
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('offline and failed local storage refuse writes', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.online(false); await a.complete();
  assert.match(a.state.error, /Offline/); h.online(true); h.options.storage.setItem = () => { throw new Error('Quota'); }; await a.complete();
  assert.match(a.state.error, /storage unavailable/); assert.equal(h.calls.some(c => c.method === 'POST'), false);
});
test('authentication interruption preserves receipt; different account cannot replay it', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.mode('lost'); await a.complete(); h.account(0); await a.retry(); assert.equal(a.state.code, 401);
  h.account(2); await a.retry(); assert.equal(a.state.code, 403); assert.equal(a.state.row, null); assert.ok(a.state.pending);
  const b = h.create(); await b.load({}); assert.equal(b.state.pending, null); assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('stale completion revision refuses completion until user refreshes', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.db.get('a').properties._completionRevision = 'changed'; await a.complete();
  assert.equal(a.state.code, 409); assert.equal(h.calls.some(c => c.method === 'POST'), false);
  await a.load({ taskId: 'a' }); await a.complete(); assert.equal(a.state.row.completed, true);
});
test('server conflict preserves intent until explicit discard and reload', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.mode('409'); await a.complete(); assert.equal(a.state.code, 409); assert.ok(a.state.pending);
  await a.load({ taskId: 'a', discardConflict: true }); assert.equal(a.state.pending, null); assert.equal(h.saved.size, 0);
});
test('duplicate historical acknowledgement cannot hide a reopened task', async () => {
  const h = harness(), a = h.create(); await a.load({ taskId: 'a' }); h.mode('lost'); await a.complete(); h.db.get('a').properties.status = 'open'; await a.retry();
  assert.equal(a.state.row.completed, false); assert.match(a.state.status, /Task is open/);
});
test('routine controller reuses canonical guidance without fabricating actuals', async () => {
  const { create: make } = require('./public/js/glasses-session'); let n = 0;
  const record = W.empty(); record.plan = W.gentleReset(() => 'step-' + (++n));
  let row = { taskId: 'routine', revision: 1, record }, count = 0;
  const h = harness(), a = make({ ...h.options, request: async (path, opts) => {
    if (path === '/api/me') return { userId: 1, workspaceId: 'ws-1' };
    if (opts?.method === 'PUT') { row = { ...row, record: opts.body.record, revision: row.revision + 1 }; count++; }
    return structuredClone(row);
  } });
  await a.load({ taskId: 'routine' }); await a.guide('begin'); await a.guide('next'); await a.guide('exit'); await a.load({ taskId: 'routine' }); await a.guide('resume');
  assert.equal(a.state.row.record.guidance.stepIndex, 1); assert.equal(count, 4); assert.deepEqual(row.record.actual, { sets: [], runs: [] }); assert.deepEqual(row.record.session.events, []);
});
