const test = require('node:test');
const assert = require('node:assert/strict');
const {create, viewport, taskHierarchy, COLLECTIONS, LANES} = require('./public/js/device-views/glasses-navigation-model');
const taskModel = require('./public/js/task-model');
const rows = count => Array.from({length:count}, (_,i)=>({id:'task-'+i,title:'Task '+i}));
test('collection order and working queue lanes are fixed',()=>{
 assert.deepEqual(COLLECTIONS,['All Tasks','Working Queue','Itinerary','Loose Ends','Unscheduled','Whenever','Someday','Waiting']);
 assert.deepEqual(LANES,['Foreground','Needs You','Background','Priority Queue']);
});
test('11-row viewport remains full near boundaries',()=>{
 assert.deepEqual(viewport(20,0),{start:0,end:11,selectedSlot:0});
 assert.deepEqual(viewport(20,10),{start:5,end:16,selectedSlot:5});
 assert.deepEqual(viewport(20,19),{start:9,end:20,selectedSlot:10});
});
test('hierarchy resolves row IDs and same-day aliases without changing action targets', () => {
 const describe = (id, date, properties) => {
   const row = { id, date, properties };
   return { id, actionId: id, kind: 'task', row, ev: taskModel.fromBlock(row) };
 };
 const parent = describe('parent', '2026-11-13', { local_id: 'legacy-parent' });
 const otherDay = describe('other-day', '2026-11-12', { local_id: 'legacy-parent' });
 const child = describe('child', parent.row.date, { subtaskOf: 'legacy-parent' });
 const nested = describe('nested', parent.row.date, { wrapId: 'child' });
 const orphan = describe('orphan', parent.row.date, { subtaskOf: 'missing' });
 const items = [nested, otherDay, child, parent, orphan];
 const formatted = taskHierarchy(items, taskModel);
 assert.deepEqual(formatted.map(item => [item.actionId, item.depth, item.relation]), [
   ['other-day', 0, null], ['parent', 0, null], ['child', 1, 'subtask'],
   ['nested', 2, 'ride-along'], ['orphan', 0, null]
 ]);
 assert.equal(formatted[2].ev, child.ev);
 assert.deepEqual(taskHierarchy(items, taskModel, { preserveOrder: true }).map(item => item.id),
   items.map(item => item.id));
});
test('jump moves five, select moves one and back preserves selection',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('down');assert.equal(m.snapshot().index,5);
 m.input('tap-fore');assert.equal(m.snapshot().level,'select');
 m.input('down');assert.equal(m.snapshot().index,6);
 m.input('tap-fore');assert.equal(m.snapshot().level,'task');
 m.input('hold-fore');assert.equal(m.snapshot().level,'details');
 m.input('back');assert.equal(m.snapshot().level,'task');
 m.input('back');assert.equal(m.snapshot().level,'select');
 assert.equal(m.snapshot().index,6);
});
test('collections retain independent selected task identities across refresh',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('down');m.input('left');m.input('down');
 assert.equal(m.snapshot().collectionName,'Working Queue');
 assert.equal(m.snapshot().index,5);
 m.input('right');assert.equal(m.snapshot().index,5);
 m.setLists(COLLECTIONS.map(()=>rows(20).slice(1)));
 assert.equal(m.snapshot().selected.id,'task-5');
});
test('home returns to All Tasks jump view',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));
 m.input('left');m.input('tap-fore');m.input('tap-fore');m.input('home');
 assert.equal(m.snapshot().collectionName,'All Tasks');assert.equal(m.snapshot().level,'jump');
});
test('range contains five tasks at boundaries and headers never enter the model',()=>{
 const m=create();m.setLists([rows(24)]);assert.deepEqual(m.snapshot().range,{start:0,end:5,selectedSlot:0});
 for(let i=0;i<10;i++)m.input('down');assert.equal(m.snapshot().index,23);assert.equal(m.snapshot().rows.length,11);assert.equal(m.snapshot().range.end-m.snapshot().range.start,5);
});
test('removing a focused task returns to select instead of silently acting on another',()=>{
 const m=create();m.setLists([rows(4)]);m.input('tap-fore');m.input('tap-fore');
 m.setLists([rows(4).slice(1)]);assert.equal(m.snapshot().level,'select');assert.equal(m.snapshot().selected.id,'task-1');
});
test('More returns to Task and home preserves the All Tasks selection',()=>{
 const m=create();m.setLists(COLLECTIONS.map(()=>rows(20)));m.input('down');m.input('tap-fore');m.input('tap-fore');m.input('more');
 assert.equal(m.snapshot().level,'more');m.input('back');assert.equal(m.snapshot().level,'task');m.input('home');assert.equal(m.snapshot().index,5);
});
function clock(){let t=0,id=0;const jobs=new Map();return {setTimeout:(fn,ms)=>{jobs.set(++id,{fn,at:t+ms});return id;},clearTimeout:key=>jobs.delete(key),advance:ms=>{t+=ms;for(const [key,job]of [...jobs])if(job.at<=t){jobs.delete(key);job.fn();}}};}
test('middle taps go Back immediately without a double-tap action',()=>{
 const time=clock(),actions=[],input=require('./public/js/device-views/glasses-navigation-model').createInput(a=>actions.push(a),time);
 input.down('middle');input.up('middle');assert.deepEqual(actions,['tap-middle']);
 input.down('middle');input.up('middle');time.advance(400);assert.deepEqual(actions,['tap-middle','tap-middle']);
});
test('holds and cancellation never leak a forefinger completion tap',()=>{
 const time=clock(),actions=[],input=require('./public/js/device-views/glasses-navigation-model').createInput(a=>actions.push(a),time);
 input.down('fore');input.down('fore');time.advance(550);input.up('fore');assert.deepEqual(actions,['hold-fore']);
 input.down('fore');input.cancel();input.up('fore');time.advance(600);assert.deepEqual(actions,['hold-fore']);
 input.down('fore');input.up('fore');assert.deepEqual(actions,['hold-fore','tap-fore']);
 input.down('middle');input.reset();input.up('middle');time.advance(400);assert.deepEqual(actions,['hold-fore','tap-fore']);
});
test('More supports bounded gesture selection and returns to task',()=>{
 const m=create();m.setLists([rows(2)]);m.input('tap-fore');m.input('tap-fore');m.input('more');
 assert.equal(m.snapshot().moreIndex,0);m.input('down');assert.equal(m.snapshot().moreIndex,1);
 for(let i=0;i<10;i++)m.input('down');assert.equal(m.snapshot().moreIndex,3);
 m.input('back');assert.equal(m.snapshot().level,'task');m.input('more');assert.equal(m.snapshot().moreIndex,0);
});

function historyHarness(model = create()) {
 const { createHistory } = require('./public/js/device-views/glasses-navigation-model');
 const entries = [{ dccNav: { page: 'tasks' }, marker: 'preserved' }];
 let cursor = 0, requested = null, active = true;
 const history = {
  get state() { return entries[cursor]; },
  replaceState(value) { entries[cursor] = value; },
  pushState(value) { entries.splice(++cursor); entries[cursor] = value; },
  go(delta) { requested = delta; }, back() { requested = -1; }
 };
 const coordinator = createHistory({ history, scope: 'account-a', active: () => active,
  changed: saved => { model.restore(saved); coordinator.sync(model.snapshot()); } });
 const move = action => { model.input(action); return coordinator.sync(model.snapshot()); };
 function pop(delta = requested) { requested = null; cursor += delta; coordinator.pop(); }
 return { model, coordinator, history, entries, move, pop,
  requested: () => requested, deactivate: () => { active = false; } };
}
test('history adds only view boundaries, preserves workspace state and backs out with live selection', async () => {
 const h = historyHarness(); h.model.setLists([rows(20)]); h.coordinator.sync(h.model.snapshot());
 h.move('down'); assert.equal(h.entries.length, 1);
 h.move('tap-fore'); h.move('down'); h.move('tap-fore'); h.move('hold-fore');
 assert.equal(h.entries.length, 4);
 assert.deepEqual(h.history.state.dccNav, {page:'tasks'});
 assert.equal(h.history.state.marker, 'preserved');
 for (const expected of ['task','select','jump']) {
  const done = h.coordinator.back(h.model.snapshot());
  assert.equal(h.requested(), -1);
  h.coordinator.sync(h.model.snapshot()); // A canonical rerender during traversal.
  h.pop(); await done;
  assert.equal(h.model.snapshot().level, expected);
  assert.equal(h.model.snapshot().selected.id, 'task-6');
 }
 h.coordinator.back(h.model.snapshot()); assert.equal(h.requested(), -1);
});
test('native Back and Forward restore navigation without emitting commands', () => {
 const h = historyHarness(); h.model.setLists([rows(20)]); h.coordinator.sync(h.model.snapshot());
 h.move('tap-fore'); h.move('down'); h.move('tap-fore'); h.move('more');
 h.pop(-1); assert.equal(h.model.snapshot().level, 'task');
 h.pop(-1); assert.equal(h.model.snapshot().level, 'select');
 h.pop(1); assert.equal(h.model.snapshot().selected.id, 'task-1');
 h.pop(1); assert.equal(h.model.snapshot().level, 'more');
 const saved = h.coordinator.current();
 const fresh = create(); fresh.setLists([rows(20)]); fresh.restore(saved);
 assert.equal(fresh.snapshot().level, 'more'); assert.equal(fresh.snapshot().selected.id,'task-1');
 fresh.setLists([rows(20).slice(2)]); fresh.restore(saved);
 assert.equal(fresh.snapshot().level, 'select');
});
test('Home and completion traverse existing ancestors and repeated Back cannot duplicate a traversal', async () => {
 const h = historyHarness(); h.model.setLists([rows(20)]); h.coordinator.sync(h.model.snapshot());
 h.move('tap-fore'); h.move('tap-fore'); h.move('more');
 const done = h.move('home'); assert.equal(h.requested(), -3);
 h.coordinator.back(h.model.snapshot()); assert.equal(h.requested(), -3);
 h.pop(); await done; assert.equal(h.history.state.dccGlasses.depth,0);
 h.move('tap-fore'); h.move('tap-fore');
 const completion = h.move('select-view'); h.model.setLists([rows(20).slice(1)]);
 h.coordinator.sync(h.model.snapshot()); h.pop(); await completion;
 assert.equal(h.model.snapshot().level,'select'); assert.equal(h.model.snapshot().selected.id,'task-1');
 h.deactivate(); h.pop(1); assert.equal(h.model.snapshot().level,'select');
});

test('native Back from Select keeps the current task in Jump', () => {
 const h = historyHarness(); h.model.setLists([rows(20)]); h.coordinator.sync(h.model.snapshot());
 h.move('tap-fore'); h.move('down'); h.pop(-1);
 assert.equal(h.model.snapshot().level, 'jump'); assert.equal(h.model.snapshot().selected.id, 'task-1');
});
