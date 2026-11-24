const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = name => fs.readFileSync(require.resolve('./public/js/' + name), 'utf8');
const date = '2026-11-24';
const marker = {triageBlock:true, triageId:'gmail:synthetic-reviewed'};
const task = (id, props = {}, day = null) => ({
  id, type:'block', date:day,
  properties:{kind:'task', title:id, publicVisibility:'private', ...props},
});

function makeModel(blocks, options = {}, collapsed = '') {
  const ctx = vm.createContext({
    __state:{date}, isDone:ev=>ev.done===true, isDeleted:ev=>ev.id==='deleted',
    loadTrivialFlags:()=>({hidden:true}), isCollapsed:id=>id===collapsed,
    _orderUnscheduled:items=>items,
  });
  ctx.window = ctx;
  vm.runInContext(script('task-model.js'), ctx);
  vm.runInContext(script('time-blocks.js'), ctx);
  ctx.scheduled = ctx.DCC.TaskModel.projectCollection(blocks);
  const itineraryScript = script('schedule-tab.js');
  const start = itineraryScript.indexOf('function _datelessTriageNodes');
  const end = itineraryScript.indexOf('// Apply the Unscheduled sort mode', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(itineraryScript.slice(start, end), ctx);
  return ctx._itineraryListModel(options);
}

const rows = nodes => Array.from(nodes, node=>[node.ev.id, node.depth]);

test('drawer model projects only open private date-free reviewed trees without polluting the day', () => {
  const model = makeModel([
    task('reviewed', marker), task('step', {subtaskOf:'reviewed'}),
    task('nested', {subtaskOf:'step'}), task('public-step', {subtaskOf:'reviewed', publicVisibility:'public'}),
    task('unrelated'), task('wrong-root', {...marker, subtaskOf:'unrelated'}),
    task('orphan', {...marker, subtaskOf:'missing'}),
    task('public', {...marker, publicVisibility:'public'}),
    task('deleted', marker), task('hidden', marker),
    task('finished', {...marker, status:'done'}), task('archived', {...marker, status:'archived'}),
    task('parked', {...marker, dependencyWaitingItemId:'active-waiting'}),
    task('responsibility', {...marker, responsibilityId:'r'}),
    task('waiting', {...marker, triageContext:{waiting_item_id:'w'}}),
    task('dated-review', marker, date), task('dated-unplanned', {}, date),
  ]);
  assert.deepEqual(rows(model.triageGroup.nodes), [
    ['dated-review', 0], ['reviewed', 0], ['step', 1], ['nested', 2],
  ]);
  assert.deepEqual(Array.from(model.day.visible, t=>t.id), ['dated-review', 'dated-unplanned']);
  assert.deepEqual(rows(model.unscheduledGroup.nodes), [['dated-unplanned', 0]]);
});

test('drawer model preserves collapse state without promoting descendants', () => {
  const blocks = [task('reviewed', marker), task('step', {subtaskOf:'reviewed'})];
  assert.deepEqual(rows(makeModel(blocks, {}, 'reviewed').triageGroup.nodes), [['reviewed', 0]]);
  assert.deepEqual(rows(makeModel(blocks, {expandAll:true}, 'reviewed').triageGroup.nodes), [['reviewed', 0], ['step', 1]]);
});
