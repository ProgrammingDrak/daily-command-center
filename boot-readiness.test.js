const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setImmediate } = require('node:timers');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./public/js/boot.js'), 'utf8');

function harness(readyState, delta = true) {
  const listeners = new Map(), reads = [], events = [], renders = [], errors = [];
  const task = {id:'synthetic-boot-task'};
  let cache = [], removed = false;
  const ctx = {
    document: {readyState, createElement:()=>({style:{},remove(){removed=true;}}), body:{prepend(){}},
      addEventListener:(name,callback)=>listeners.set(name,callback)},
    console:{log(){},warn:e=>errors.push(e),error:e=>errors.push(e)},
    DCC_DELTA_SYNC_ENABLED:delta, __tomorrowDate:null, __state:null, viewDate:null, PREP_REGISTRY:{},
    updateClock(){}, setInterval(){},
    CustomEvent:class {constructor(type,init){this.type=type;this.detail=init.detail;}},
    dispatchEvent:e=>events.push(e.type),
    transformState:()=>({sched:[],consider:[],bklog:[],triageItems:[],notifications:[]}),
    fetch:async url=>{reads.push(url);return {ok:true,json:async()=>url.includes('bootstrap')
      ? {date:'2026-10-26',blocks:[task],globals:[],dayState:{date:'2026-10-26'}}
      : url==='/api/state/day'?{date:'2026-10-26'}:{}};},
    reloadPersistedEdits(){ if(ctx.USE_BLOCKSTORE?.addedTasks)ctx.scheduled=[...cache]; },
    render:()=>renders.push((ctx.scheduled||[]).map(row=>row.id)),
  };
  ctx.window=ctx;
  const dependencies=()=>{
    ctx.USE_BLOCKSTORE={addedTasks:true};
    ctx.blockStore={hydrateSyncSnapshot:s=>{cache=s.blocks;},loadDay:async()=>{cache=[task];return cache;},loadGlobals:async()=>[],debug:()=>({})};
  };
  vm.createContext(ctx);
  return {ctx,reads,events,renders,errors,dependencies,run:()=>vm.runInContext(source,ctx),parsed:()=>{ctx.document.readyState='interactive';listeners.get('DOMContentLoaded')?.();},removed:()=>removed};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
for(const delta of [true,false])test(`fast ${delta?'delta':'legacy'} API waits for late shell dependencies before task hydration`,async()=>{
  const h=harness('loading',delta);h.run();await settle();
  assert.deepEqual(h.reads,[],'no bootstrap can race remaining script execution');
  h.dependencies();h.parsed();await settle();
  assert.deepEqual(h.renders[0],['synthetic-boot-task']);
  assert.equal(h.events.filter(x=>x==='dcc:data-ready').length,1);
  assert.equal(h.removed(),true);assert.deepEqual(h.errors,[]);
});
test('already parsed document hydrates immediately without waiting for a past DOMContentLoaded event',async()=>{
  const h=harness('complete');h.dependencies();h.run();await settle();
  assert.deepEqual(h.renders[0],['synthetic-boot-task']);
  assert.equal(h.events.filter(x=>x==='dcc:data-ready').length,1);
});

test('shared Day Progress readiness is published after core hydration and before unrelated builders',async()=>{
  const h=harness('complete');h.dependencies();
  let published=false;
  h.ctx.dispatchEvent=event=>{h.events.push(event.type);if(event.type==='dcc:day-data-ready'){
    published=true;assert.equal(event.detail.available,true);assert.equal(event.detail.date,'2026-10-26');
    assert.equal(h.ctx.scheduled[0].id,'synthetic-boot-task');
  }};
  h.ctx.buildTriage=()=>assert.equal(published,true);
  h.run();await settle();assert.equal(published,true);
});
test('failed core hydration publishes unavailable rather than a valid empty day',async()=>{
  const h=harness('complete',false);h.dependencies();
  h.ctx.fetch=async()=>({ok:false,status:503});
  let available;h.ctx.dispatchEvent=event=>{if(event.type==='dcc:day-data-ready')available=event.detail.available;};
  h.run();await settle();assert.equal(available,false);
});
