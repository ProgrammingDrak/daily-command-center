const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./public/js/state.js'),'utf8');
const taskModelSource=fs.readFileSync(require.resolve('./public/js/task-model.js'),'utf8');
function harness({date=null,fail=null,delayed=false}={}){
  let release;
  const gate=delayed?new Promise(resolve=>release=resolve):Promise.resolve();
  const row={id:'existing-row',type:'block',date,properties:{local_id:'existing-task',title:'Fixture task',duration:30,responsibilityId:'repeat-definition',_taskNotes:{text:'History kept'},publicVisibility:'private'}};
  const calls=[],toasts=[];
  const c={console,Map,window:{},scheduled:[],viewDate:'2026-10-22',__state:{date:'2026-10-22'},
    _viewedDateStr:()=>c.viewDate,_resolvedTodayDate:()=> '2026-10-22',_prettyDateLabel:d=>d,
    pt:t=>Number(t.slice(0,2))*60+Number(t.slice(3)),fmt:n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'),
    dur:ev=>c.pt(ev.end)-c.pt(ev.start),isFixedTimeBlock:ev=>ev.type==='meeting',
    _findTaskBlockForDate:()=>row,_computeRescheduleSlot:async()=>({start:'12:00'}),
    showToast:(message,kind)=>toasts.push({message,kind}),render(){},pinStartTime(){},syncAddedTaskTimes(){},log(){},
    refoldTaskStateFromBlockCache(){c.scheduled=[c.DCC.TaskModel.fromBlock(row)];}
  };
  vm.createContext(c);vm.runInContext(taskModelSource,c);c.DCC=c.window.DCC||c.DCC;
  // The UMD module attaches to the VM global when self is absent.
  c.scheduled=[c.DCC.TaskModel.fromBlock(row)];
  c.window.blockStore={rescheduleBlock:async(id,target,opts)=>{
    calls.push({id,target,opts});opts.onQueued();await gate;
    if(fail)throw Object.assign(new Error('Fixture rejection'),{permanent:fail==='permanent'});
    row.date=target;Object.assign(row.properties,{start:opts.parentStart,end:opts.parentEnd,userSetStart:opts.userSetStart});
    return {moved:[id],blocks:[row]};
  }};
  vm.runInContext(source.slice(source.indexOf('const _untimedPlacements ='),source.indexOf('// Restore a task from the amber')),c);
  return {c,row,calls,toasts,release};
}
for(const date of [null,'2026-10-22'])test('same-day scheduling persists date and time for '+(date?'dated':'dateless')+' work',async()=>{
  const h=harness({date});const before=JSON.parse(JSON.stringify(h.row.properties));
  await h.c.rescheduleTaskToDate('existing-task','2026-10-22',{pinnedStart:'12:00'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].id,'existing-row');
  assert.equal(h.row.date,'2026-10-22');assert.equal(h.row.properties.start,'12:00');assert.equal(h.row.properties.end,'12:30');
  assert.equal(h.row.properties.responsibilityId,before.responsibilityId);assert.deepEqual(h.row.properties._taskNotes,before._taskNotes);
  assert.equal(h.row.properties.publicVisibility,'private');
  const reloaded=h.c.DCC.TaskModel.fromBlock(JSON.parse(JSON.stringify(h.row)));
  assert.equal(reloaded.id,'existing-task');assert.equal(reloaded.untimed,false);assert.equal(reloaded._dateless,false);
  assert.equal(h.c.scheduled[0].untimed,false);assert.equal(h.toasts.at(-1).kind,'success');
});
test('earliest-free choice uses the same durable placement',async()=>{
  const h=harness();await h.c.rescheduleTaskToDate('existing-task','2026-10-22');
  assert.equal(h.calls[0].opts.parentStart,'12:00');assert.equal(h.row.date,'2026-10-22');assert.equal(h.calls[0].opts.userSetStart,false,'auto placement remains eligible for ordinary reflow');
});
test('placement is single-flight and reports success only after acknowledgement',async()=>{
  const h=harness({delayed:true});
  const a=h.c.rescheduleTaskToDate('existing-task','2026-10-22',{pinnedStart:'12:00'});
  const b=h.c.rescheduleTaskToDate('existing-task','2026-10-22',{pinnedStart:'12:00'});
  assert.equal(h.calls.length,1);assert.ok(h.c.scheduled[0].untimed);assert.equal(h.toasts.some(t=>t.kind==='success'),false);
  h.release();await Promise.all([a,b]);assert.equal(h.c.scheduled[0].untimed,false);
});
for(const fail of ['permanent','transient'])test(fail+' failure leaves task visible and states retry semantics',async()=>{
  const h=harness({fail}),before=JSON.stringify(h.row);
  assert.equal(await h.c.rescheduleTaskToDate('existing-task','2026-10-22',{pinnedStart:'12:00'}),false);
  assert.equal(JSON.stringify(h.row),before);assert.ok(h.c.scheduled[0].untimed);
  assert.match(h.toasts.at(-1).message,fail==='permanent'?/Could not schedule/:/queued.*retry/);
  assert.equal(h.toasts.some(t=>t.kind==='success'),false);assert.equal(h.c.window.__RESCHEDULE_IN_FLIGHT__,false);
});
test('navigation during save never refolds the old day into the new day',async()=>{
  const h=harness({delayed:true});let refolds=0;h.c.refoldTaskStateFromBlockCache=()=>refolds++;
  const done=h.c.rescheduleTaskToDate('existing-task','2026-10-22',{pinnedStart:'12:00'});
  h.c.viewDate='2026-10-23';h.release();await done;assert.equal(refolds,0);
});
test('fixed meetings, locks, malformed clocks and overflowing duration do not write',async()=>{
  for(const scenario of ['meeting','locked','24:00','12:60','23:45']){
    const h=harness();if(scenario==='meeting')h.c.scheduled[0].type='meeting';if(scenario==='locked')h.c.scheduled[0]._locked=true;
    await h.c.scheduleUntimedTask('existing-task','2026-10-22',scenario.includes(':')?scenario:'12:00');
    assert.equal(h.calls.length,0,scenario);assert.equal(h.toasts.at(-1).kind,'error');
  }
});

test('failed day-context read leaves a retryable error instead of a silent no-op',async()=>{
  const h=harness();h.c._computeRescheduleSlot=async()=>{throw new Error('offline')};
  assert.equal(await h.c.rescheduleTaskToDate('existing-task','2026-10-22'),false);
  assert.equal(h.calls.length,0);assert.match(h.toasts.at(-1).message,/Try again/);assert.ok(h.c.scheduled[0].untimed);
});
