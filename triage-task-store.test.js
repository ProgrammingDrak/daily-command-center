const test = require('node:test');
const assert = require('node:assert/strict');
const createStore = require('./triage-task-store');
const createResponsibilities = require('./responsibility-store');
const TM = require('./public/js/task-model');
const TB = require('./public/js/time-blocks');

function fixture() {
  const rows = new Map();
  let serial = 0;
  let tail = Promise.resolve();
  const db = {
    findByIdempotencyKey: async (ws, key) => [...rows.values()].find(r => r.workspace_id === ws && r.properties.idempotency_key === key),
    getBlock: async id => rows.get(id) || null,
    getResponsibilityBlocks: async ws => [...rows.values()].filter(r => r.workspace_id === ws && r.properties.kind === 'responsibility_item'),
    updateBlock: async (id, update) => { const row = {...rows.get(id), ...update}; rows.set(id, row); return row; },
    createItineraryTask: async ({id, parent_id, date, properties, workspaceId}) => {
      const hit = await db.findByIdempotencyKey(workspaceId, properties.idempotency_key);
      if (hit) return hit;
      const row = {id: id || 'task-' + ++serial, parent_id, type: 'block', date, properties, workspace_id: workspaceId};
      rows.set(row.id, row); return row;
    },
    createItineraryTasks: async (items, owner) => Promise.all(items.map(item => db.createItineraryTask({...item, ...owner}))),
    withRepeatSeriesLock: (_id, _ws, fn) => {const next = tail.then(() => fn(null)); tail = next.catch(() => {}); return next;},
  };
  const respStore = createResponsibilities({blockDB: db, getTodayStr: () => '2026-09-08', assertBlockOwnership: (row, ws) => {if (row.workspace_id !== ws) throw new Error('Not found');}});
  const links = [];
  const store = createStore({blockDB: db, respStore, linkTriage: async (...args) => links.push(args)});
  return {rows, db, respStore, store, links};
}

const source = {title: 'Reply to the partner', triageId: 'inbound-1', triageKey: 'slack|D1:42', duration: 25, source_id: 'https://example.test/thread', triageContext: {draft_preview: 'Saved draft'}};
const owner = {workspaceId: 'ws-1', userId: 1};

test('Slack naming and source metadata survive materialization, moves, and manual renames', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const {taskCommonProps} = require('./public/js/task-serialize');
  const code = fs.readFileSync(require.resolve('./public/js/triage.js'), 'utf8');
  const body = code.slice(code.indexOf('function triageTaskProps('), code.indexOf('// Already on the schedule?'));
  const context = vm.createContext({window:{DCC:{taskSourceUrl:item=>item.source_ref}},triagePriorityLabel:x=>x,triageItemKeyFor:item=>item.id});
  vm.runInContext(body, context);
  const raw = {id:'slack:mention:C1:42',type:'slack',title:'#finance: <@U123|Drake>, please review the report',source_ref:'https://example.slack.com/archives/C1/p42'};
  const request = {title:raw.title,...context.triageTaskProps(raw.id,raw)};
  const f=fixture();
  const [row]=await f.store.materialize({...owner,items:[request]});
  const moved=taskCommonProps(TM.fromBlock(row));
  assert.equal(moved.title,'Review the report');
  assert.equal(moved.generatedTitle,moved.title);
  assert.equal(moved.originalTitle,raw.title);
  assert.equal(moved.sourceContext,'#finance');
  assert.equal(moved.source_id,raw.source_ref);
  assert.equal(moved.triageId,raw.id);
  row.properties.title='My manual title';
  const [repeated]=await f.store.materialize({...owner,items:[request]});
  assert.equal(repeated.id,row.id);
  assert.equal(repeated.properties.title,'My manual title');
  assert.equal(f.rows.size,1);
});

test('materialized Triage uses normal stored tasks and retains identity across reloads and days', async () => {
  const f = fixture();
  const [first] = await f.store.materialize({...owner, items: [source]});
  const [second] = await f.store.materialize({...owner, items: [source]});
  assert.equal(second.id, first.id);
  assert.equal(f.rows.size, 1);
  assert.equal(first.date, null);
  assert.equal(TM.foldsIntoItinerary(first), true);
  const task = TM.fromBlock(first);
  assert.equal(task.triageBlock, true);
  assert.equal(task.untimed, true);
  assert.equal(task.source_id, source.source_id);
  assert.equal(task.triageContext.draft_preview, 'Saved draft');
  assert.equal(task.publicVisibility, 'private');
  assert.deepEqual(TM.selectUnscheduled([first]), [], 'Triage must not duplicate in Backlog');
  first.properties.kind = 'backlog';
  assert.equal(TM.selectUnscheduled([first]).length, 1, 'the standard Backlog move remains usable');
});

test('completion and deletion cannot recreate a source task; another workspace remains independent', async () => {
  const f = fixture();
  const [first] = await f.store.materialize({...owner, items: [source]});
  first.properties.status = 'done';
  await f.store.materialize({...owner, items: [source]});
  assert.equal(f.links.length, 1, 'replay must not replace Done with Scheduled');
  first.deleted_at = '2026-09-08T12:00:00Z';
  await f.store.materialize({...owner, items: [source]});
  assert.equal(f.rows.size, 1);
  const [other] = await f.store.materialize({...owner, workspaceId: 'ws-2', items: [source]});
  assert.notEqual(other.id, first.id);
});

test('failed source linking retries against the same durable task', async () => {
  const f = fixture();
  let fail = true;
  const store = createStore({blockDB: f.db, respStore: f.respStore, linkTriage: async () => {if (fail) throw new Error('offline');}});
  await assert.rejects(store.materialize({...owner, items: [source]}), /offline/);
  fail = false;
  const [retried] = await store.materialize({...owner, items: [source]});
  assert.equal(retried.id, 'task-1');
  assert.equal(f.rows.size, 1);
});

function addResponsibility(f, overrides = {}) {
  f.rows.set('resp-1', {id: 'resp-1', type: 'block', workspace_id: 'ws-1', properties: {
    kind: 'responsibility_item', title: 'Update the Company Scorecard', status: 'active',
    cadenceDays: 7, cadence: 'weekly', lastCompletedAt: '2020-01-01T00:00:00Z', estimatedMinutes: 60,
    defaultSubtasks: ['Collect numbers', 'Check totals'], ...overrides,
  }});
}

test('recurring Triage creates one real task tree and pauses the definition across concurrent loads', async () => {
  const f = fixture(); addResponsibility(f);
  const [a, b] = await Promise.all([1, 2].map(() => f.store.materialize({...owner, responsibilityIds: ['resp-1']})));
  assert.equal(a[0].id, b[0].id);
  assert.equal(f.rows.size, 4, 'one definition, one task, two children');
  const root = a[0];
  assert.equal(root.date, null);
  assert.equal(root.properties.triageBlock, true);
  assert.equal(root.properties.repeatMode, undefined);
  assert.equal(root.properties.retiredContainerHidden, undefined);
  assert.equal(root.properties.duration, 60);
  assert.equal(f.rows.get('resp-1').properties.openInstanceBlockId, root.id);
  assert.equal(f.rows.get('resp-1').properties.openInstanceDate, null);
  assert.equal(a[1].parent_id, root.id);
  assert.equal(a[1].properties.responsibilityId, undefined, "a child completion must not reset the parent cadence");
  assert.equal(a[1].properties.subtaskOf, root.properties.local_id);
  assert.equal(TM.fromBlock(a[1]).end, "00:00", "timeless children must not acquire a default 30 minutes");
  assert.equal(TM.foldsIntoItinerary(root), true);
});

test('recurring Triage honors paused, skipped, scheduled, and not-yet-due definitions', async () => {
  for (const override of [{pausedUntil:'forever'}, {skipUntil:'2099-01-01'}, {repeatType:'scheduled'}, {lastCompletedAt:new Date().toISOString()}]) {
    const f=fixture(); addResponsibility(f, override);
    assert.deepEqual(await f.store.materialize({...owner, responsibilityIds:['resp-1']}), [], JSON.stringify(override));
    assert.equal(f.rows.size, 1);
  }
});

test('Triage grouping keeps whole subtrees together and releases the same task when scheduled', () => {
  const task={id:'root', triageBlock:true, untimed:true};
  const nodes=[{ev:{id:'normal'},depth:0},{ev:task,depth:0},{ev:{id:'child'},depth:1},{ev:{id:'unscheduled',untimed:true},depth:0}];
  assert.deepEqual(TB.groupItineraryTree(nodes,[])[0].nodes.map(n=>n.ev.id), ['root','child']);
  task.untimed=false; task.start='09:00';
  assert.deepEqual(TB.groupItineraryTree(nodes,[])[0].nodes, []);
  assert.equal(TB.TRIAGE_BLOCK.permanent,true);
  assert.equal(TB.TRIAGE_BLOCK.collapsible,true);
});

test('Unplanned placement survives repeated intake without a new task or restored Triage flag',async()=>{
  const f=fixture(),[first]=await f.store.materialize({...owner,items:[source]});
  first.properties=require('./lib/reschedule').unplannedProperties(first,first.id);
  first.date='2026-09-09';
  const [again]=await f.store.materialize({...owner,items:[source]});
  assert.equal(again.id,first.id);assert.equal(f.rows.size,1);
  assert.equal(again.date,'2026-09-09');assert.equal(again.properties.triageBlock,undefined);
  assert.equal(again.properties.triageId,source.triageId);
  assert.equal(again.properties.source_id,source.source_id);
  const ev=TM.fromBlock(again);assert.equal(ev.untimed,true);
  assert.deepEqual(TB.groupItineraryTree([{ev,depth:0}],[]).at(-1).nodes.map(n=>n.ev.id),[ev.id]);
});

test('a promoted zero-duration step retains its effective duration after reload',()=>{
  const block={id:'step',date:'2026-09-09',properties:{local_id:'step',subtaskOf:'parent',duration:0}};
  block.properties=require('./lib/reschedule').unplannedProperties(block,block.id,{step:0});
  const ev=TM.fromBlock(block);
  assert.equal(ev.start,'00:00');assert.equal(ev.end,'00:00');
  assert.equal(ev.subtaskOf,null);assert.equal(ev.untimed,true);
});
