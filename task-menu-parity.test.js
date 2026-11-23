const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve(file),'utf8');
const source=read('./public/js/schedule-tab.js');
function menuPage(){
 const calls=[];
 const context={window:{DCC:{Whenever:{LABEL:'Whenever',UNSCHEDULED_LABEL:'Unscheduled'}},DCCWorkingQueue:{addTask:async task=>calls.push(['priority',task.id])}},
  _schedViewDate:()=> '2026-11-23',isMeeting:()=>false,isNested:()=>false,
  openMakeSubtaskOf:(id)=>calls.push(['subtask',id]),moveTaskToUnplanned:(id,opts)=>calls.push(['unscheduled',id,opts.task._blockId]),
  openConvertToRadial:task=>calls.push(['convert',task.id]),convertTaskToDelegated:(id,opts)=>calls.push(['delegate',id,opts.task._blockId]),
  openRepeatResponsibilityFromTask:task=>calls.push(['repeat',task.id]),moveTaskToBacklog:(id,opts)=>calls.push(['solo',id,opts.task._blockId]),
  moveTaskToWhenever:(id,opts)=>calls.push(['whenever',id,opts.task._blockId]),toggleLock:(id,opts)=>calls.push(['lock',id,opts.task._blockId])};
 context.window.openTaskDependencyModal=id=>calls.push(['dependency',id]);context.DCC=context.window.DCC;
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function buildMeetingRadialItems('),source.indexOf('// Sub-fan: convert')),context);
 vm.runInContext(source.slice(source.indexOf('function buildCarryoverRadialItems('),source.indexOf('const _TASK_RADIAL_OPTS')),context);
 return {context,calls};
}
const expected=['Subtask…','Move to Priority Queue','Remove time','Convert…','Delegate / block','Blocked by task','Repeat','Move to Someday','Whenever','Lock'];
test('every task state shares the itinerary menu; unavailable actions remain visible and cannot run',async()=>{
 const {context,calls}=menuPage();
 const task={id:'local',_blockId:'actual-row',title:'Example'};
 for(const state of [{},{untimed:true},{stage:'Whenever',_dateless:true}]){
  const items=context.buildTaskRadialItems({...task,...state},{});
  assert.deepEqual(Array.from(items,item=>item.label),expected);
 }
 const delegated=context.buildTaskRadialItems(task,{}, {unavailableReason:'No underlying task',actions:{delegate:()=>calls.push(['waiting'])}});
 assert.deepEqual(Array.from(delegated,item=>item.label),expected);
 assert.equal(delegated.filter(item=>item.disabled).length,9);
 for(const item of delegated)await item.onPick();
 assert.deepEqual(calls,[['waiting']]);
 assert.ok(delegated.filter(item=>item.disabled).every(item=>item.title==='No underlying task'));
});
test('shared menu actions preserve the task row identity; carryovers keep their origin-aware Solo writer',async()=>{
 const {context,calls}=menuPage(),task={id:'local',_blockId:'actual-row',title:'Example'};
 for(const item of context.buildTaskRadialItems(task,{}))await item.onPick();
 assert.deepEqual(calls,[['subtask','local'],['priority','local'],['unscheduled','local','actual-row'],['convert','local'],['delegate','local','actual-row'],['dependency','actual-row'],['repeat','local'],['solo','local','actual-row'],['whenever','local','actual-row'],['lock','local','actual-row']]);
 const menu=context.buildCarryoverRadialItems(task,{}, {backlog:()=>calls.push(['origin-solo'])});
 assert.deepEqual(Array.from(menu,item=>item.label),expected);
 await menu.find(item=>item.id==='solo').onPick();assert.deepEqual(calls.at(-1),['origin-solo']);
});
test('task view adapters call the shared menu instead of constructing alternative action lists',()=>{
 for(const file of ['whenever','task-library'])assert.match(read('./public/js/'+file+'.js'),/onRadial:[\s\S]*?window\.openTaskRadial\(/);
 const delegated=read('./public/js/delegated.js');assert.match(delegated,/function openTaskActions[\s\S]*?window\.openTaskRadial\(task,trigger/);
 assert.match(read('./public/js/catch-up.js'),/onRadial: opts\.onTaskActions \|\| \(trigger => window\.openTaskRadial/);
 assert.doesNotMatch(read('./public/js/catch-up.js'),/waiting\.forEach/);
 const radial=read('./public/js/radial-menu.js');assert.match(radial,/if\(d\.disabled\)\{item\.disabled=true/);
});
test('Loose Ends shares centered modal dimensions and blocks backdrop clicks',()=>{
 const css=read('./public/css/ui-optimization.css');
 assert.match(css,/\.carryover-overlay \{[^}]*justify-content: center; align-items: center;/);
 assert.match(css,/\.carryover,\s*#tasks-drawer\.queue-focused\.open \.side-drawer-body \{/);
 assert.doesNotMatch(css,/\.carryover-overlay \{[^}]*pointer-events: none/);
 assert.match(read('./public/js/catch-up.js'),/class="carryover" role="dialog" aria-modal="true"/);
});
