const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {setImmediate} = require('node:timers');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const read = name => fs.readFileSync('public/js/'+name+'.js','utf8');

test('today renders and signals ready before slow supporting data; late data cannot reset edits',async()=>{
 const supplemental=deferred(), ready=deferred();let renders=0;const calls=[],surfaces=[];
 const state={date:'2026-10-20'};
 const ctx={console,setInterval:()=>0,setTimeout:()=>0,CustomEvent:function(type){this.type=type;},
  document:{createElement:()=>({style:{},remove(){}}),body:{prepend(){}}},
  fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url==='/api/sync/bootstrap'?{dayState:state,blocks:[],globals:[]}:supplemental.promise};},
  transformState:()=>({sched:[{id:'task',title:'original'}],consider:[],bklog:[]}),
  blockStore:{hydrateSyncSnapshot(){},getByType:()=>[],debug:()=>({})},
  render:keys=>{renders++;surfaces.push(keys);},updateClock(){},PREP_REGISTRY:{},__tomorrowDate:null,__archiveDates:[],
  DCC_DELTA_SYNC_ENABLED:true,dispatchEvent:event=>{if(event.type==='dcc:data-ready')ready.resolve();},
 };
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(read('boot'),ctx);
 await ready.promise;
 assert.equal(renders,1);assert.deepEqual(calls.slice(0,1),['/api/sync/bootstrap']);
 assert.equal(ctx.scheduled[0].title,'original');ctx.scheduled[0].title='edited while support loads';ctx.viewDate='2026-10-21';
 supplemental.resolve({meetings:[{id:'meeting'}],actions:[{id:'action'}]});await tick();
 assert.equal(renders,2);assert.deepEqual(Array.from(surfaces[1]),['upcoming','actionItems']);
 assert.equal(ctx.__DCC_UPCOMING__.meetings[0].id,'meeting');
 assert.equal(ctx.__SECOND_BRAIN_GLOBALS__.actions[0].id,'action');
 assert.equal(ctx.scheduled[0].title,'edited while support loads');assert.equal(ctx.viewDate,'2026-10-21');
 assert.ok(!calls.includes('/api/brain/recent'),'retired endpoint is not fetched');
});

test('legacy startup starts day and global block reads together',async()=>{
 const ready=deferred(), gate=deferred(), reads=[];
 const ctx={console,setInterval:()=>0,setTimeout:()=>0,CustomEvent:function(type){this.type=type;},
 document:{createElement:()=>({style:{},remove(){}}),body:{prepend(){}}},
 fetch:async()=>({ok:true,json:async()=>({date:'2026-10-20'})}),
 transformState:()=>({sched:[],consider:[],bklog:[]}),
 blockStore:{loadDay:()=>{reads.push('day');return gate.promise;},loadGlobals:()=>{reads.push('global');return gate.promise;},getByType:()=>[],debug:()=>({})},
 updateClock(){},PREP_REGISTRY:{},__tomorrowDate:null,__archiveDates:[],
 dispatchEvent:event=>{if(event.type==='dcc:data-ready')ready.resolve();}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(read('boot'),ctx);await tick();
 assert.deepEqual(reads,['day','global']);gate.resolve([]);await ready.promise;
});

test('day-context starts independent destination reads in parallel',async()=>{
 const gate=deferred(),calls=[];const ctx={_resolveKnownState:()=>null,_root:{fetch:url=>{calls.push(url);return gate.promise;}},buildDayContext:(date,state,blocks)=>({date,state,blocks})};
 vm.createContext(ctx);const src=read('day-context');vm.runInContext(src.slice(src.indexOf('  async function _loadDayContext('),src.indexOf('  function getDayContext(')),ctx);
 const result=ctx._loadDayContext('2026-10-21');assert.equal(calls.length,2);
 gate.resolve({json:async()=>[]});assert.equal((await result).date,'2026-10-21');
});

test('unrelated row writes start together while same-row merges wait for the prior ack',async()=>{
 const gate=deferred(),calls=[],rows=new Map([['a',{id:'a',properties:{title:'A'}}],['b',{id:'b',properties:{title:'B'}}]]);
 const ctx={console,window:{blockStore:{updateBlock:async(id,p)=>{calls.push(id);if(calls.length===1)await gate.promise;rows.set(id,{id,properties:p});return rows.get(id);}}},_rowForDateWrite:async id=>rows.get(id)};
 vm.createContext(ctx);const src=read('state');vm.runInContext(src.slice(src.indexOf('const _rowPropsChains='),src.indexOf('// ── C6b:')),ctx);
 const a=ctx.enqueueRowPropsWrite('a',p=>({...p,title:'new'}));const a2=ctx.enqueueRowPropsWrite('a',p=>({...p,tag:'tag'}));const b=ctx.enqueueRowPropsWrite('b',p=>({...p,title:'new B'}));
 await tick();assert.deepEqual(calls,['a','b']);await b;gate.resolve();await Promise.all([a,a2]);assert.deepEqual(rows.get('a').properties,{title:'new',tag:'tag'});
});

function moveHarness(){
 const gate=deferred();const task={id:'a',title:'A',start:'09:00',end:'09:30'},child={id:'kid',title:'Child'},other={id:'b',title:'B'};
 const ctx={console,window:{blockStore:{rescheduleBlock:async(_id,_date,options)=>{options.onQueued();return gate.promise;}}},scheduled:[task,child,other],viewDate:'2026-10-20',
 _findTaskBlockForDate:()=>({id:'row-a'}),_subtreeIdsOf:()=>new Set(['a','kid']),_clearTaskPinAndLock(){},_removeSubtreeFromScheduled(){},
 _prettyDateLabel:d=>d,fmt:()=> '09:30',pt:()=>540,dur:()=>30,render(){},log(){},showToast(){}};
 vm.createContext(ctx);const src=read('state');vm.runInContext(src.slice(src.indexOf('async function rescheduleTaskToDate('),src.indexOf('// Restore a task from the amber')),ctx);
 return {ctx,gate,other};
}

test('move preview removes the subtree after enqueue and rejection restores it without reverting other edits',async()=>{
 const {ctx,gate,other}=moveHarness();
 const move=ctx.rescheduleTaskToDate('a','2026-10-21',{pinnedStart:'09:00'});
 assert.deepEqual(Array.from(ctx.scheduled,r=>r.id),['b']);assert.equal(ctx.window.__RESCHEDULE_IN_FLIGHT__,true);
 other.title='Edited while moving';gate.resolve(Promise.reject(Object.assign(new Error('Rejected'),{permanent:true})));
 assert.equal(await move,false);assert.deepEqual(Array.from(ctx.scheduled,r=>r.id),['a','kid','b']);assert.equal(ctx.scheduled[2].title,'Edited while moving');assert.equal(ctx.window.__RESCHEDULE_IN_FLIGHT__,false);
});

test('a rejected move after navigation does not insert old-day rows into the new day',async()=>{
 const {ctx,gate}=moveHarness();const move=ctx.rescheduleTaskToDate('a','2026-10-21',{pinnedStart:'09:00'});
 ctx.viewDate='2026-10-22';ctx.scheduled=[{id:'new-day'}];gate.resolve(Promise.reject(Object.assign(new Error('Rejected'),{permanent:true})));
 await move;assert.deepEqual(ctx.scheduled,[{id:'new-day'}]);
});
