const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const state=fs.readFileSync(require.resolve('./public/js/state.js'),'utf8');
const schedule=fs.readFileSync(require.resolve('./public/js/schedule.js'),'utf8');
function moverPage(){
 const calls=[],task={id:'shared-local-id',_blockId:'requested-row',title:'Dateless task',_dateless:true,untimed:true};
 const row={id:task._blockId,date:null,properties:{local_id:task.id,duration:30}};
 const context={scheduled:[{id:task.id,_blockId:'different-row'}],viewDate:'2026-11-23',_viewedDateStr:()=> '2026-11-23',isDone:()=>false,
  window:{DCCWorkSessions:{blockFor:target=>{assert.equal(target,task);return row;}},blockStore:{rescheduleBlock:async(...args)=>calls.push(args)}},
  showToast(){},refoldTaskStateFromBlockCache:()=>calls.push('refold'),render:()=>calls.push('render')};
 vm.createContext(context);
 vm.runInContext(state.slice(state.indexOf('async function moveTaskToUnplanned('),state.indexOf('\nfunction moveTaskViaPlacement(')),context);
 vm.runInContext(state.slice(state.indexOf('async function _moveTaskToBacklogStage('),state.indexOf('// Convert an existing scheduled task',state.indexOf('async function _moveTaskToBacklogStage('))),context);
 return {context,calls,task,row};
}
test('dateless menu placement preserves the requested row and uses the canonical subtree mover',async()=>{
 for(const action of ['moveTaskToUnplanned','moveTaskToBacklog']){
  const {context,calls,task}=moverPage();
  assert.equal(await context[action](task.id,{task}),true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['requested-row',null,{placement:{kind:'whenever',...(action==='moveTaskToBacklog'?{durations:{}}:{}),stage:'Backlog'}}]);
  assert.deepEqual(calls.slice(1),['refold','render']);
  assert.equal(context.scheduled[0]._blockId,'different-row');
 }
});
test('Lock on a library task updates its exact row instead of the same local ID on today',async()=>{
 const {context,calls,task,row}=moverPage();
 context.isMeeting=()=>false;
 context.enqueueRowPropsWrite=async(id,merge)=>{assert.equal(id,row.id);row.properties=merge(row.properties);calls.push(id);return row;};
 vm.runInContext(schedule.slice(schedule.indexOf('function toggleLock('),schedule.indexOf('// Apply persisted locks')),context);
 assert.equal(await context.toggleLock(task.id,{task}),true);assert.equal(row.properties.locked,true);assert.equal(task._locked,true);
 assert.equal(await context.toggleLock(task.id,{task}),true);assert.equal(row.properties.locked,false);assert.equal(task._locked,false);
 assert.equal(context.scheduled[0]._locked,undefined);
});
test('the drawer delegates nested popup dismissal to the shared overlay controller',()=>{
 const source=fs.readFileSync(require.resolve('./public/js/side-drawers.js'),'utf8');
 const pointer=source.slice(source.indexOf('document.addEventListener("pointerdown", e => {'),source.indexOf('window.addEventListener("resize"'));
 const keys=source.slice(source.indexOf('document.addEventListener("keydown", e => {'),source.indexOf('document.addEventListener("pointerdown", e => {'));
 assert.match(pointer,/if\(window\.DCC\?\.overlay\?\.eventInLayerAbove\(e\)\) return;/);
 assert.match(keys,/if\(window\.DCC\?\.overlay\?\.layerAboveOpen\(\)\) return;/);
 const radial=fs.readFileSync(require.resolve('./public/js/radial-menu.js'),'utf8');
 for(const part of ['backdrop','item','cancel'])assert.ok(radial.includes(part+'.dataset.dccLayer="above"'),part);
});

test('historical Unscheduled actions keep their source date and never copy today\'s colliding task durations',async()=>{
 const {context,calls,task,row}=moverPage();task._dateless=false;task.untimed=false;row.date='2026-11-22';
 context.sessionStorage={getItem:()=> '1'};context.dur=()=>45;
 context.DCC={TaskModel:{selectTree:()=>[{ev:context.scheduled[0],depth:0}]},TimeBlocks:{UNPLANNED_BLOCK:'unplanned',collapseKey:()=> 'source-unplanned'}};
 context.isCollapsed=()=>false;context.toggleCollapsed=()=>assert.fail('must not expand a different day');
 assert.equal(await context.moveTaskToUnplanned(task.id,{task}),true);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['requested-row','2026-11-22',{fromDate:'2026-11-22',placement:{kind:'unplanned',durations:{'requested-row':45}}}]);
 assert.equal(calls.length,1,'the currently viewed day stays unchanged');
});

test('historical Whenever actions send only their own duration to the canonical subtree mover',async()=>{
 const {context,calls,task,row}=moverPage();row.date='2026-11-22';task._dateless=false;
 context._viewedDateStr=()=>context.viewDate;context.dur=()=>45;
 context._subtreeIdsOf=()=>assert.fail('must not traverse today for a task on another day');
 vm.runInContext(state.slice(state.indexOf('async function moveTaskToWhenever('),state.indexOf('// Convert an existing scheduled task',state.indexOf('async function moveTaskToWhenever('))),context);
 assert.equal(await context.moveTaskToWhenever(task.id,{task}),true);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['requested-row',null,{placement:{kind:'whenever',durations:{'requested-row':45}}}]);
});


test('cold library actions preserve exact source rows despite a colliding current-day anchor',()=>{
 const source=fs.readFileSync(require.resolve('./public/js/work-sessions.js'),'utf8');
 const historical={id:'historical-row',date:'2026-10-01'},today={id:'today-row'};
 let cached=null;
 const context={window:{blockStore:{get:id=>id==='today-row'?today:cached}},taskAnchorById:()=>({blockId:today.id})};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('  function blockFor('),source.indexOf('  function isWorkTaskBlock(')),context);
 const task={id:'shared-local-id',_blockId:historical.id,__taskContext:{block:historical}};
 assert.equal(context.blockFor({id:'shared-local-id'}),today);
 assert.equal(context.blockFor(task),historical);
 cached={...historical,properties:{locked:true}};
 assert.equal(context.blockFor(task),cached,'fresh cached data wins over the library snapshot');
});

test('hierarchy actions load the source day or global pool before opening canonical editors',async()=>{
 const source=fs.readFileSync(require.resolve('./public/js/schedule-tab.js'),'utf8'),calls=[];
 let row={id:'source-row',date:'2026-10-01'};
 const context={window:{DCCWorkSessions:{blockFor:()=>row},blockStore:{get:()=>null,loadGlobals:async()=>calls.push('globals')}},_schedViewDate:()=> '2026-11-23',switchToDate:async date=>calls.push(date)};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('async function openTaskHierarchyAction('),source.indexOf('function buildTaskChangeItems(')),context);
 await context.openTaskHierarchyAction({},()=>calls.push('open'));
 assert.deepEqual(calls,['2026-10-01','open']);
 row={id:'global-row',date:null};calls.length=0;
 await context.openTaskHierarchyAction({},()=>calls.push('open'));
 assert.deepEqual(calls,['globals','open']);
});
