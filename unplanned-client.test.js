const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/js/state.js','utf8');
function harness({supported=true,failure=null}={}){
  const calls=[],toasts=[],collapsed=new Set(),storage=new Map(supported?[['dcc-unplanned-placement','1']]:[]);
  const context={viewDate:'2026-09-09',scheduled:[{id:'task',start:'10:00',duration:45},{id:'child',subtaskOf:'task',start:'00:00',end:'00:00'}],
    DCC:{TimeBlocks:require('./public/js/time-blocks'),TaskModel:{selectTree:tasks=>tasks.map((ev,i)=>({ev,depth:i}))}},
    isDone:()=>false,_findTaskBlockForDate:id=>({id}),dur:ev=>ev.duration??0,_positiveDuration:(n,f)=>n||f,
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:async()=>{throw new Error('offline');},
    isCollapsed:key=>collapsed.has(key),toggleCollapsed:key=>collapsed.delete(key),refoldTaskStateFromBlockCache:()=>calls.push('refold'),render:()=>calls.push('render'),showToast:(...args)=>toasts.push(args),
    window:{blockStore:{rescheduleBlock:async(...args)=>{calls.push(args);if(failure)throw failure;}}}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function moveTaskToUnplanned('),source.indexOf('\nfunction moveTaskViaPlacement(')),context);
  return {context,calls,toasts,collapsed};
}
test('client uses the transactional mover, keeps durations, reveals Unplanned, and refolds after acknowledgment',async()=>{
  const h=harness(),key=h.context.DCC.TimeBlocks.collapseKey(h.context.viewDate,h.context.DCC.TimeBlocks.UNPLANNED_BLOCK);h.collapsed.add(key);
  assert.equal(await h.context.moveTaskToUnplanned('task'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])),['task','2026-09-09',{fromDate:'2026-09-09',placement:{kind:'unplanned',durations:{task:45,child:0}}}]);
  assert.deepEqual(h.calls.slice(1),['refold','render']);assert.equal(h.collapsed.size,0);
});
test('buffered and rejected moves never claim success or alter the displayed projection',async()=>{
  for(const permanent of [false,true]){
    const h=harness({failure:{permanent,message:'Locked'}});
    assert.equal(await h.context.moveTaskToUnplanned('task'),false);assert.equal(h.calls.length,1);
    assert.equal(h.toasts[0][1],permanent?'error':'info');assert.match(h.toasts[0][0],permanent?/Locked/:/queued/);
  }
});
test('old servers cannot receive a new placement before support is confirmed',async()=>{
  const h=harness({supported:false});assert.equal(await h.context.moveTaskToUnplanned('task'),false);assert.equal(h.calls.length,0);
});
test('desktop and touch block drops share the same mover and retain protected-task filtering',async()=>{
  const drag=fs.readFileSync('public/js/drag.js','utf8'),calls=[];
  const ctx={window:{},scheduled:[{id:'task'}],dragId:'task',isDone:ev=>ev.done,dEnd:()=>calls.push('end'),moveTaskToUnplanned:async id=>calls.push(id)};
  vm.createContext(ctx);vm.runInContext(drag.slice(drag.indexOf('function _blockDragTask('),drag.indexOf('// ── Scheduling helpers')),ctx);
  vm.runInContext(drag.slice(drag.indexOf('function _dccSynthEvt(')),ctx);
  const zone={dataset:{placement:'unplanned'},classList:{contains:name=>name==='time-block-drop-zone'}},event={currentTarget:zone,preventDefault(){},stopPropagation(){}};
  await ctx.dBlockDrop(event);assert.deepEqual(calls,['end','task']);calls.length=0;
  ctx.window.DCC_DRAG.drop(zone,null,0,'reorder');await Promise.resolve();assert.deepEqual(calls,['end','task']);
  ctx.scheduled[0]._locked=true;calls.length=0;await ctx.dBlockDrop(event);assert.deepEqual(calls,['end']);
});
