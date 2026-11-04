const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TaskModel = require('./public/js/task-model');
const read = name => fs.readFileSync(require.resolve('./public/js/'+name), 'utf8');
const pt = value => String(value).split(':').reduce((h,m)=>Number(h)*60+Number(m));
const fmt = value => String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
function slice(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a);return source.slice(a,b);
}
for(const minutes of [5,15,60])test('Working Queue custom placement preserves '+minutes+' minutes',async()=>{
  const row={id:'row',date:'2026-11-04',properties:{title:'Synthetic task',duration:minutes,start:'00:00',end:fmt(30)}};
  const ev=TaskModel.fromBlock(row);ev.__unf={sourceBlock:row};let pop,slot;
  const context={prepareTask:async()=>({ev,date:row.date,blockId:row.id}),refresh:async()=>{},DCC:{Carryover:{moveTo:async(_task,_date,opts)=>{slot=opts.slot;}}},window:{_positiveDuration:(candidate,fallback)=>candidate>0?candidate:fallback,dur:task=>pt(task.end)-pt(task.start),pt,fmt,openSchedulePopover:cfg=>{pop=cfg;}}};
  vm.createContext(context);vm.runInContext(slice(read('working-queue.js'),'  async function openSchedule(','  function itemForTask('),context);
  await context.openSchedule({task:row},{});await pop.onMove(row.date,'12:10');
  assert.equal(slot.start,'12:10');assert.equal(slot.end,fmt(pt('12:10')+minutes));
});
for(const minutes of [5,15,60])test('duration editor writes '+minutes+' minutes to the row without changing actuals or identity',async()=>{
  let row={id:'row',properties:{duration:30,durMin:30,start:'12:10',end:'12:40',actualMinutes:7,startedAt:'unchanged',notes:'Keep',local_id:'task',recurrenceId:'repeat'}};
  const original={...row.properties};const ev={id:'task',start:'12:10',end:'12:40'};
  const context={scheduled:[ev],dur:e=>pt(e.end)-pt(e.start),pt,fmt,origDur:()=>30,durChanges:{},log:()=>{},recalcTimes:()=>{},saveDurChanges:()=>{},render:()=>{},viewDate:'2026-11-04',_findTaskBlockForDate:()=>row,enqueueRowPropsWrite:async(_id,merge)=>{row={...row,properties:merge(row.properties)};}};
  vm.createContext(context);vm.runInContext(slice(read('schedule.js'),'function persistTaskDuration(','// ======== START TIME ADJUSTMENT'),context);
  context.setDurAbsolute('task',minutes);
  assert.equal(row.properties.duration,minutes);assert.equal(row.properties.durMin,minutes);assert.equal(row.properties.end,fmt(pt('12:10')+minutes));
  for(const key of ['actualMinutes','startedAt','notes','local_id','recurrenceId'])assert.equal(row.properties[key],original[key]);
  const reloaded=TaskModel.fromBlock(row);assert.equal(pt(reloaded.end)-pt(reloaded.start),minutes);
});
test('stepper persists the snapped duration through the same row writer',()=>{
  let saved;const ev={id:'task',start:'12:10',end:'13:00'};
  const context={scheduled:[ev],dur:e=>pt(e.end)-pt(e.start),pt,fmt,stepDuration:()=>60,origDur:()=>50,durChanges:{},log:()=>{},recalcTimes:()=>{},saveDurChanges:()=>{},render:()=>{},_findTaskBlockForDate:()=>({id:'row'}),enqueueRowPropsWrite:(_id,merge)=>{saved=merge({start:'12:10',actualMinutes:3});}};
  vm.createContext(context);vm.runInContext(slice(read('schedule.js'),'function persistTaskDuration(','// ======== START TIME ADJUSTMENT'),context);context.adjustDur('task',15);
  assert.equal(saved.duration,60);assert.equal(saved.end,'13:10');assert.equal(saved.actualMinutes,3);
});

test('reselecting an overlay duration repairs the stale canonical end',()=>{
  let saved;const ev={id:'task',start:'12:10',end:'12:25'};
  const context={scheduled:[ev],dur:e=>pt(e.end)-pt(e.start),pt,fmt,_findTaskBlockForDate:()=>({id:'row'}),enqueueRowPropsWrite:(_id,merge)=>{saved=merge({duration:15,start:'12:10',end:'12:40'});}};
  vm.createContext(context);vm.runInContext(slice(read('schedule.js'),'function persistTaskDuration(','// ======== START TIME ADJUSTMENT'),context);context.setDurAbsolute('task',15);
  assert.equal(saved.duration,15);assert.equal(saved.end,'12:25');
});
test('late duration edits retain the estimate and a valid canonical end',()=>{
  let saved;const context={pt,fmt,_findTaskBlockForDate:()=>({id:'row'}),enqueueRowPropsWrite:(_id,merge)=>{saved=merge({start:'23:00'});}};
  vm.createContext(context);vm.runInContext(slice(read('schedule.js'),'function persistTaskDuration(','function adjustDur('),context);context.persistTaskDuration({id:'task'},90);
  assert.equal(saved.duration,90);assert.equal(saved.end,'23:59');
});
for(const end of ['24:30','00:30','23:59'])test('overnight queue task uses the canonical positive estimate: '+end,async()=>{
  const row={id:'row',date:'2026-11-04',properties:{duration:90,start:'23:00',end}};
  const ev=TaskModel.fromBlock(row);ev.__unf={sourceBlock:row};let pop,slot;
  const context={prepareTask:async()=>({ev,date:row.date}),refresh:async()=>{},DCC:{Carryover:{moveTo:async(_task,_date,opts)=>{slot=opts.slot;}}},window:{pt,fmt,openSchedulePopover:cfg=>{pop=cfg;}}};
  vm.createContext(context);vm.runInContext(slice(read('state.js'),'function pt(','function ms(')+slice(read('state.js'),'function _positiveDuration(','// ======== MOVE-TO MENU'),context);
  context.window.dur=task=>context.pt(task.end)-context.pt(task.start);context.window._positiveDuration=context._positiveDuration;
  vm.runInContext(slice(read('working-queue.js'),'  async function openSchedule(','  function itemForTask('),context);
  await context.openSchedule({task:row},{});await pop.onMove(row.date,'12:10');assert.equal(slot.end,'13:40');
});
