const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { installTaskModel } = require('./task-model-vm-fixture');
const source = fs.readFileSync(require.resolve('./public/js/features.js'), 'utf8');
const radial = fs.readFileSync(require.resolve('./public/js/schedule-tab.js'), 'utf8');
const html = fs.readFileSync(require.resolve('./index.html'), 'utf8');
function section(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
}
function element() {
  return { children: [], attrs: {}, dataset: {}, replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, action) { this[key] = action; },
    getBoundingClientRect() { return {left:20, right:320, top:200, bottom:244, width:300, height:44}; },
    querySelector() { return this.children[0]; }, focus() {} };
}
function harness({archive = false, meeting = false, carryover = false, queuedToday = false} = {}) {
  const host = element(), calls = [], task = {id:'local', _blockId:'stored', title:'Task', type:'task'};
  const ctx = {document:{getElementById:()=>host, createElement:element, querySelector:()=>host},
    window:{TaskTypes:{TYPES:{task:{},focus:{}},isFixed:()=>false,get:type=>({label:type})},
      openTaskDependencyModal:id=>calls.push(['dependency',id]),
      DCC:{Carryover:{toBacklog:ev=>calls.push(['carryover',ev.id])}}},
    _addModalAnchor:{ev:task,carryover:carryover || queuedToday,queue:queuedToday,blockId:'stored'},
    scheduled:queuedToday ? [{...task,_locked:true}] : [],
    _addModalEditing:!archive, viewMode:archive?'archive':'today',
    isMeeting:()=>meeting, isNested:()=>true, now:()=>0, pt:()=>1,
    _setAddModalControlsEditable() {}, closeAddModal:()=>calls.push(['close']),
    toggleLock:id=>calls.push(['lock',id]), convertTaskToDelegated:id=>calls.push(['waiting',id]),
    promoteToTopLevel:id=>calls.push(['promote',id]), moveTaskToUnplanned:id=>calls.push(['unplan',id]),
    moveTaskToBacklog:id=>calls.push(['someday',id]), moveTaskToWhenever:id=>calls.push(['whenever',id]),
    openMakeSubtaskOf:(id,trig)=>calls.push(['subtask',id,trig.getBoundingClientRect().top]),
    openRepeatResponsibilityFromTask:ev=>calls.push(['repeat',ev.id]),
    convertTaskType:(id,type)=>calls.push(['convert',id,type]), openMeetingPanel:ev=>calls.push(['meeting',ev.id])};
  ctx.DCC = ctx.window.DCC;
  vm.createContext(ctx);
  vm.runInContext(section(radial,'function buildMeetingRadialItems','// Convert a scheduled task'),ctx);
  vm.runInContext(section(radial,'function buildCarryoverRadialItems','const _TASK_RADIAL_OPTS'),ctx);
  vm.runInContext(section(source,'const TASK_ACTIONS_LAYOUT','function setAddModalMode'),ctx);
  ctx.renderAddModalTaskActions(task);
  return {ctx,host,calls,task};
}

test('task action buttons share radial labels and dispatch its callbacks after closing details', async () => {
  const actions = [['Subtask…',['subtask','local',200]],['Promote',['promote','local']],
    ['Remove time',['unplan','local']],['Delegate / block',['waiting','local']],
    ['Blocked by task',['dependency','stored']],['Repeat',['repeat','local']],
    ['Move to Someday',['someday','local']],['Whenever',['whenever','local']],['Lock',['lock','local']]];
  for (const [label,expected] of actions) {
    const h = harness();
    assert.deepEqual(h.host.children.map(b=>b.attrs['aria-label']),
      Array.from(h.ctx.buildTaskRadialItems(h.task,{}), item=>item.label));
    await h.host.children.find(b=>b.attrs['aria-label']===label).click();
    assert.deepEqual(h.calls,[['close'],expected]);
  }
});

test('Convert uses the shared type submenu without opening a second radial', async () => {
  const h = harness();
  await h.host.children.find(b=>b.attrs['aria-label']==='Convert…').click();
  assert.deepEqual(h.calls,[]);
  assert.equal(h.host.children[0].textContent,'Back');
  await h.host.children[0].click();
  assert.ok(h.host.children.some(b=>b.attrs['aria-label']==='Lock'));
  await h.host.children.find(b=>b.attrs['aria-label']==='Convert…').click();
  await h.host.children.find(b=>b.attrs['aria-label']==='→ focus').click();
  assert.deepEqual(h.calls,[['close'],['convert','local','focus']]);
});

test('current-day queue anchors use the full shared menu and live lock state', async () => {
  const h = harness({queuedToday:true});
  const queueSource = fs.readFileSync(require.resolve('./public/js/working-queue.js'), 'utf8');
  const anchorSource = queueSource.match(/^ {2}function taskAnchor\(id\)\{[\s\S]*?\n {2}\}/m);
  assert.ok(anchorSource, 'real queue anchor function must be present');
  installTaskModel(h.ctx);
  const row = {id:'stored',date:'2099-01-05',properties:{local_id:'local',title:'Task',type:'task',start:'09:00',end:'09:30'}};
  h.ctx.items = ()=>[{task:row}];
  h.ctx.contextRows = ()=>[row];
  vm.runInContext(anchorSource[0],h.ctx);
  h.ctx._addModalAnchor = h.ctx.taskAnchor('stored');
  assert.equal(h.ctx._addModalAnchor.carryover,true);
  h.ctx.scheduled = [{...h.ctx._addModalAnchor.ev,_locked:true}];
  h.ctx.renderAddModalTaskActions(h.ctx._addModalAnchor.ev);
  const labels = h.host.children.map(b=>b.attrs['aria-label']);
  assert.ok(labels.includes('Convert…'));
  assert.ok(labels.includes('Delegate / block'));
  assert.ok(labels.includes('Unlock'));
  assert.ok(!labels.includes('Solo'));
  await h.host.children.find(b=>b.attrs['aria-label']==='Unlock').click();
  assert.deepEqual(h.calls,[['close'],['lock','local']]);
  // A historical row may reuse a local id. Never act on today's different row.
  h.ctx._addModalAnchor.blockId = 'historical-row';
  h.ctx.renderAddModalTaskActions(h.ctx._addModalAnchor.ev);
  assert.deepEqual(h.host.children.map(b=>b.attrs['aria-label']),['Move…','Solo']);
});

test('archived actions cannot mutate; meetings and carryovers keep their own shared menus', async () => {
  const archived = harness({archive:true});
  await archived.host.children.find(b=>b.attrs['aria-label']==='Lock').click();
  assert.deepEqual(archived.calls,[]);
  const meeting = harness({meeting:true});
  assert.deepEqual(meeting.host.children.map(b=>b.attrs['aria-label']),['Prep']);
  await meeting.host.children[0].click();
  assert.deepEqual(meeting.calls,[['close'],['meeting','local']]);
  const carryover = harness({carryover:true});
  assert.deepEqual(carryover.host.children.map(b=>b.attrs['aria-label']),['Move…','Solo']);
  await carryover.host.children[1].click();
  assert.deepEqual(carryover.calls,[['close'],['carryover','local']]);
});

test('detail panels place journal, sources, actions and work controls in their requested sections', () => {
  const journal = section(html,'<div id="am-panel-photos"','<div id="am-panel-history"');
  const actions = section(html,'<div id="am-panel-actions"','<div id="am-panel-subtasks"');
  const history = section(html,'<div id="am-panel-history"','<div id="am-panel-automation"');
  assert.ok(journal.indexOf('id="am-photos-anchor"') < journal.indexOf('id="am-sources-section"'));
  assert.match(journal,/<details[^>]*id="am-sources-section"[^>]*>[\s\S]*id="am-source-references"[\s\S]*id="am-source-form"[\s\S]*<\/details>/);
  assert.doesNotMatch(journal,/<details[^>]*\sopen[\s>]/);
  assert.match(actions,/id="am-task-actions"/);
  assert.doesNotMatch(actions,/id="am-work-actions"|id="am-time-summary"/);
  assert.match(history,/id="am-work-actions"[\s\S]*id="am-time-summary"[\s\S]*id="am-work-history"/);
  assert.doesNotMatch(html,/id="am-(?:tab-settings|panel-settings|tag-picker|commute-to-input|commute-back-input|tab-notes|panel-notes|notes-block-editor)"/);
  assert.doesNotMatch(source,/function (?:_persistTaskTags|_persistMeetingFlag|persistAddModalCommute|updateAddModalCommuteHint|_writeAddModalNotes)\(/);
});

test('read mode protects sources while journal controls retain their own lifecycle', () => {
  const sourceFiles = {disabled:false};
  function control(journal) {
    return {disabled:false, matches:()=>false, closest:selector=>selector==='#am-panel-photos' || journal && selector==='#am-photos-anchor',
      getAttribute:()=>null, setAttribute() {}, removeAttribute() {}, hasAttribute:()=>false};
  }
  const sourceButton = control(false), journalButton = control(true);
  const modal = {querySelector:()=>({querySelectorAll:()=>[sourceButton,journalButton]})};
  const ctx = vm.createContext({_addModalControlState:new WeakMap(),document:{getElementById:()=>sourceFiles}});
  vm.runInContext(section(source,'function _setAddModalControlsEditable','function _handleAddModalKeydown'),ctx);
  ctx._setAddModalControlsEditable(modal,false);
  assert.equal(sourceFiles.disabled,true);
  assert.equal(sourceButton.disabled,true);
  assert.equal(journalButton.disabled,false);
  ctx._setAddModalControlsEditable(modal,true);
  assert.equal(sourceFiles.disabled,false);
  assert.equal(sourceButton.disabled,false);
});
