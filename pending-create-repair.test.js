const test = require('node:test');
const assert = require('node:assert/strict');
const factory = require('./lib/pending-create-repair');
const original = () => ({ id: 'same-child', type: 'block', parent_id: null, date: '2026-10-28', properties: {
  title: 'Review release', detail: 'Keep every original detail', local_id: 'child-local', source: 'manual', type: 'task',
  duration: 0, start: '00:00', end: '00:00', subtaskOf: 'parent-local', tags: ['release'] } });
function setup() {
  const state = { parent: { id: 'parent', workspace_id: 'ws', date: null, updated_at: 'v1', properties: { title: 'Release', local_id: 'parent-local' } }, existing: null, creates: [], queries: [] };
  const client = { query: async sql => { state.queries.push(sql); }, release() {} };
  const repair = factory({ pool: { connect: async () => client }, blockDB: {
    findUniqueLiveBlockByReference: async () => state.parent,
    isTaskRow: row => row.type !== 'day_root',
    getBlock: async () => state.existing,
    createBlock: async input => { state.creates.push(input); state.existing = { ...input, updated_at: 'v2' }; return state.existing; },
  } });
  const call = extra => repair({ original: original(), userId: 1, workspaceId: 'ws', ...extra });
  return { state, call };
}
test('preview is read-only; repair preserves original ID, properties and normal create path', async () => {
  const { state, call } = setup(); const before = original();
  const preview = await call(); assert.equal(state.creates.length, 0); assert.equal(preview.expected.date, null);
  const result = await call({ apply: true, expected: preview.expected });
  assert.equal(result.block.id, before.id); assert.equal(result.block.date, null); assert.equal(result.block.parent_id, 'parent');
  assert.deepEqual(result.block.properties, before.properties); assert.equal(state.creates.length, 1);
  const again = await call({ apply: true, expected: preview.expected });
  assert.equal(again.created, false); assert.equal(state.creates.length, 1);
});
test('dated parent and changed placement require a new preview', async () => {
  const { state, call } = setup(); const preview = await call(); state.parent.date = '2026-10-29'; state.parent.updated_at = 'v2';
  await assert.rejects(call({ apply: true, expected: preview.expected }), /changed/); assert.equal(state.creates.length, 0);
  const next = await call(); const result = await call({ apply: true, expected: next.expected }); assert.equal(result.block.date, '2026-10-29');
});
test('changed content after preview is refused without mutation', async () => {
  const { state, call } = setup(); const preview = await call(); const changed = original(); changed.properties.detail = 'new';
  await assert.rejects(call({ original: changed, apply: true, expected: preview.expected }), /changed/); assert.equal(state.creates.length, 0);
});
test('foreign, absent, ambiguous, deleted or colliding original rows cannot be overwritten', async () => {
  for (const variant of ['foreign-parent', 'absent-parent', 'foreign-child', 'deleted-child', 'edited-child']) {
    const { state, call } = setup();
    if (variant === 'foreign-parent') state.parent.workspace_id = 'other';
    if (variant === 'absent-parent') state.parent = null;
    if (variant.endsWith('child')) state.existing = { ...original(), parent_id: 'parent', date: null, workspace_id: variant === 'foreign-child' ? 'other' : 'ws', deleted_at: variant === 'deleted-child' ? 'today' : null };
    if (variant === 'edited-child') state.existing.properties.title = 'new server title';
    await assert.rejects(call()); assert.equal(state.creates.length, 0); assert.equal(state.queries.at(-1), 'ROLLBACK');
  }
});
test('restrict repair to manual timeless subtasks and explicit authenticated owners', async () => {
  for (const change of [{ source: 'automation' }, { wrapId: 'other' }, { duration: 30 }, { startedAt: 'now' }, { subtaskOf: '' }]) {
    const { call } = setup(); const input = original(); Object.assign(input.properties, change); await assert.rejects(call({ original: input }), /Only a pending/);
  }
  await assert.rejects(setup().call({ userId: null }), /authenticated/);
});
test('parent disagreement and self-parenting do not move or recreate work', async () => {
  const { call, state } = setup(); const input = original(); input.parent_id = 'another';
  await assert.rejects(call({ original: input }), /disagree/); state.parent.id = input.id;
  await assert.rejects(call(), /disagree/); assert.equal(state.creates.length, 0);
});

test('repair cannot bypass the Waiting dependency validator', async () => {
  const { call, state } = setup(); const input = original();
  Object.assign(input.properties, { kind: 'delegated_item', blockerType: 'task', blockerBlockId: 'foreign', linkedBlockId: 'other' });
  await assert.rejects(call({ original: input }), /Waiting API/); assert.equal(state.creates.length, 0);
});
