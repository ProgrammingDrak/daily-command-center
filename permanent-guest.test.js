const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('routes/social-todo.js','utf8');
const fn=name=>source.match(new RegExp('function '+name+'\\([^]*?\\n\\}'))[0];
async function project(rows,poolRows,triage=[]){
  const context={
    crypto:require('node:crypto'),console,date:'2026-09-09',share:{workspace_id:'ws'},state:{triage:{open_items:triage}},
    collectSubtreeBlockIds:require('./lib/reschedule').collectSubtreeBlockIds,
    blockDB:{getBlocksByDateIncludingDeleted:async()=>rows,getRescheduleSubtreePool:async(_date,ws,opts)=>{assert.equal(ws,'ws');assert.equal(opts.includeTriageRoots,true);return poolRows;}},
    filterLegacyGcalBlocks:rows=>rows,shared:null,getPublicCalendarMap:async()=>new Map(),getPublicTagMap:async()=>new Map(),
    publicFeedType:()=> 'task',calendarMeta:()=>null,localTimeFromAny:v=>v||'',publicFeedTypeLabel:()=> 'Task',taskMinutes:(_a,_b,d)=>d||30,publicTaskPoints:()=>0,publicTaskStatus:(task,done)=>done.has(task.id)||task.completed?'done':'open'
  };
  vm.createContext(context);
  const start=source.indexOf('  let allRows;'),end=source.indexOf('\n  const { rows: sponsors }',start);
  vm.runInContext(fn('publicTaskIdentityIds')+'\n'+fn('normalizePublicTask')+'\nasync function run(){'+source.slice(start,end)+'\nreturn tasks;}globalThis.result=run();',context);
  return JSON.parse(JSON.stringify(await context.result));
}
const row=(id,date,properties,parent_id=null)=>({id,date,type:'block',workspace_id:'ws',properties:{kind:'task',local_id:id,...properties},parent_id});
test('guest grouping includes global Triage trees and redacts private content',async()=>{
  const root=row('t',null,{title:'Secret title',notes:'Secret note',triageBlock:true,publicVisibility:'private'});
  const child=row('c',null,{title:'Private child',triageBlock:true,publicVisibility:'private'},'t');
  const backlog=row('b',null,{title:'Backlog',kind:'backlog',triageBlock:true});
  const loose=row('l','2026-09-08',{title:'Loose end'});
  const tasks=await project([],[root,child,backlog,loose]);
  assert.deepEqual(tasks.map(t=>t.id),['t','c']);
  assert.equal(tasks[0].title,'Private task');assert.equal(tasks[0].detail,'');
  assert.equal(tasks[1].subtaskOf,'t');assert.ok(tasks.every(t=>t.triageBlock&&t.untimed));
  assert.ok(!JSON.stringify(tasks).includes('Secret'));
});
test('canonical Unplanned placement defeats stale intake and keeps done tasks in their block',async()=>{
  const moved=row('m','2026-09-09',{title:'Moved task',triageId:'source',duration:25,publicVisibility:'private',status:'done'});
  const tasks=await project([moved],[],[{id:'source',title:'Stale title',publicVisibility:'public'}]);
  assert.equal(tasks.length,1);assert.equal(tasks[0].id,'m');
  assert.equal(tasks[0].triageBlock,false);assert.equal(tasks[0].untimed,true);
  assert.equal(tasks[0].status,'done');assert.equal(tasks[0].title,'Private task');
});
