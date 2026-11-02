const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const TM = require('./public/js/task-model');
const source = name => fs.readFileSync(require.resolve('./public/js/' + name + '.js'), 'utf8');
const fn = (name, file) => {
  const match = source(file).match(new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'));
  assert.ok(match, name + ' must use the actual browser implementation');
  return match[0];
};
const plain = value => JSON.parse(JSON.stringify(value));
function browser(parent, create, realStore = false) {
  const writes = [], storage = new Map();
  const event = TM.fromBlock(parent);
  event.__unf = { sourceId: parent.id, sourceDate: parent.date, sourceBlock: parent };
  const context = {
    console, crypto, Date, Promise, Map, Set,
    viewDate: '2026-11-02', scheduled: [], backlog: [],
    _unfinishedCache: { rows: [event] },
    render() {}, _recollectCarryover() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    navigator: { onLine: true }, document: { addEventListener() {}, visibilityState: 'visible' },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    DCC_ACCOUNT_CONTEXT: { userId: 1, workspaceId: 'ws-1' },
    fetch: async (_url, init) => {
      const payload = JSON.parse(init.body); writes.push(payload);
      try { const row = await create(payload); return { ok: true, status: 200, json: async () => row }; }
      catch (error) { return { ok: false, status: error.statusCode || 500, json: async () => ({ error: error.message }) }; }
    }
  };
  context.window = context;
  vm.createContext(context);
  if (realStore) vm.runInContext(source('block-store'), context);
  else context.blockStore = { createBlock: async (type, properties, options) => {
    const payload = plain({ type, properties, ...options }); writes.push(payload); return payload;
  } };
  vm.runInContext(fn('_unfRecById', 'schedule-tab') + '\n' + fn('taskAnchorById', 'schedule-tab') + '\n' + fn('addSubtask', 'tabs'), context);
  return { context, writes, storage };
}
const parentRow = date => ({ id: 'parent-row', type: 'block', date, properties: {
  local_id: 'parent-local', type: 'task', title: 'Pack supplies', source: 'manual',
  notes: 'Keep this context', actualMinutes: 17, publicVisibility: 'private'
} });

for (const date of [null, '2026-10-30']) test('checklist child retains canonical parent placement: ' + date, async () => {
  const parent = parentRow(date), before = plain(parent), b = browser(parent);
  await b.context.addSubtask('parent-local', 'Pack notebook')._persisted;
  assert.equal(b.writes[0].date, date);
  assert.equal(b.writes[0].properties.subtaskOf, 'parent-local');
  assert.equal(b.writes[0].properties.duration, 0);
  assert.equal(b.writes[0].properties.publicVisibility, 'private');
  assert.equal(b.context.scheduled.length, 0, 'a pool/carryover child is not injected into today');
  assert.deepEqual(parent, before);
});

test('a newly scheduled future parent retains its explicit placement context', async () => {
  const b = browser(parentRow(null));
  await b.context.addSubtask('new-parent', 'Prepare supplies', { date: '2026-11-09', parentStart: '14:00' })._persisted;
  assert.equal(b.writes[0].date, '2026-11-09');
  assert.equal(b.writes[0].properties.start, '14:00');
  assert.equal(b.context.scheduled.length, 0);
});

test('unscheduled checklist persists through real BlockStore and PostgreSQL without WAL retry or parent changes',
  { skip: !process.env.DCC_TEST_DATABASE_URL }, async t => {
    const fixture = await require('./test-support/activity-db').createActivityDb();
    t.after(() => fixture.close());
    const parent = await fixture.blockDB.createBlock({ ...parentRow(null), user_id: 1, workspace_id: 'ws-1' });
    const create = payload => fixture.blockDB.createBlock({ ...payload, user_id: 1, workspace_id: 'ws-1' });
    const b = browser(parent, create, true);
    const task = b.context.addSubtask('parent-local', 'Pack notebook');
    const saved = await task._persisted;
    assert.equal(b.writes.length, 1);
    assert.equal(saved.date, null);
    assert.equal(saved.parent_id, parent.id);
    assert.equal(saved.properties.title, 'Pack notebook');
    assert.equal(saved.properties.duration, 0);
    assert.equal(saved.properties.publicVisibility, 'private');
    assert.equal(b.context.blockStore.hasPendingWrites(), false);
    assert.deepEqual(JSON.parse(b.storage.get('blockstore-wal:1:ws-1') || '[]'), []);
    assert.deepEqual(await fixture.blockDB.getBlock(parent.id), parent);
    const reread = await fixture.blockDB.getBlock(saved.id);
    assert.deepEqual(reread, saved);
    assert.equal((await create(b.writes[0])).id, saved.id, 'lost acknowledgement retry retains identity');
    assert.equal((await fixture.pool.query('SELECT COUNT(*)::int AS n FROM blocks WHERE parent_id=$1', [parent.id])).rows[0].n, 1);
    // Exercise the shipped recovery path for a create retained by an older tab.
    const retained = { ...b.writes[0], id: 'pending-child', date: '2026-11-02',
      properties: { ...b.writes[0].properties, local_id: 'pending-local', title: 'Pack charger', detail: 'Keep this checklist context' } };
    await assert.rejects(create(retained), /same task pool or day/);
    const repair = require('./lib/pending-create-repair')({ pool: fixture.pool, blockDB: fixture.blockDB });
    const request = { original: retained, userId: 1, workspaceId: 'ws-1' };
    const preview = await repair(request);
    assert.equal(preview.expected.date, null);
    assert.equal(await fixture.blockDB.getBlock(retained.id), null, 'preview is read-only');
    const repaired = await repair({ ...request, expected: preview.expected, apply: true });
    assert.equal(repaired.block.id, retained.id);
    assert.equal(repaired.block.date, null);
    for (const [key, value] of Object.entries(retained.properties)) assert.deepEqual(repaired.block.properties[key], value);
    assert.equal((await repair({ ...request, expected: preview.expected, apply: true })).created, false);
    assert.deepEqual(await fixture.blockDB.getBlock(parent.id), parent);
  });
