const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const TM=require('./public/js/task-model');
const source=name=>fs.readFileSync('./public/js/'+name+'.js','utf8');
const block=(id,properties={},date=null)=>({id,type:'block',date,properties:{kind:'backlog',title:id,...properties}});
function context(extra={}){
  const window={DCC:{TaskModel:TM},addEventListener(){}};
  return vm.createContext({window,document:{getElementById(){return null;},addEventListener(){}},location:{href:'http://localhost/'},URL,
    localStorage:{getItem(){return JSON.stringify({query:'hide everything',filters:[{key:'title',op:'contains',value:'absent'}]});}},...extra});
}
test('glasses library reads the full API independently of desktop filters and keeps canonical identities',async()=>{
  const rows=[block('scheduled',{local_id:'legacy'},'2026-11-10'),block('open'),block('idea',{someday:true}),block('dated-idea',{someday:true},'2026-11-10'),block('done',{status:'done'}),block('closed',{completedAt:'2026-11-09'}),{...block('deleted'),deleted_at:'2026-11-09'}];
  const calls=[];const ctx=context({fetch:async url=>{calls.push(url);return {ok:true,json:async()=>({tasks:rows,projects:[]})};}});
  vm.runInContext(source('task-library'),ctx);
  const result=await ctx.window.DCCTaskLibrary.glassesCollections();
  assert.deepEqual(Array.from(result.allTasks,row=>row.id),['scheduled','open','idea','dated-idea']);
  assert.deepEqual(Array.from(result.someday,row=>row.id),['idea']);
  assert.equal(result.allTasks[0].actionId,'scheduled');
  assert.equal(result.allTasks[0].ev._blockId,'scheduled');
  assert.equal(result.allTasks[0].ev.id,'legacy');
  assert.deepEqual(calls,['/api/task-library']);
});
test('glasses library rejects failed or malformed reads rather than returning partial cached tasks',async()=>{
  for(const response of [{ok:false,json:async()=>({error:'Account changed'})},{ok:true,json:async()=>({})}]){
    const ctx=context({fetch:async()=>response});vm.runInContext(source('task-library'),ctx);
    await assert.rejects(ctx.window.DCCTaskLibrary.glassesCollections());
  }
});
test('Loose Ends retains source action identity, owner ordering, and Waiting draft deduplication',async()=>{
  const ev={id:'carry-local',title:'Slipped',__unf:{sourceId:'carry-block'}};
  const waiting=block('waiting',{kind:'delegated_item',myTask:'Follow up'});
  const draft={id:'draft',waiting_item_id:'waiting',source:'gmail',title:'Draft'};
  const triage=[{id:'mail',source:'gmail',title:'Email'},draft,{id:'slack',source:'slack',title:'Slack'}];
  const ctx=context({activeTriageItems:()=>triage});
  ctx.window.DCC.Carryover={collect:async()=>({rows:[ev],total:4,truncated:true}),rootsOf:rows=>rows};
  ctx.window.getAttentionWaitingItems=()=>[waiting];
  vm.runInContext(source('catch-up'),ctx);
  const rows=await ctx.window.DCC.CatchUp.glassesTasks();
  assert.deepEqual(Array.from(rows,row=>[row.kind,row.actionId]),[['task','carry-block'],['waiting','waiting'],['triage','slack'],['triage','mail']]);
  assert.equal(rows[0].ev,ev);assert.equal(rows[0].pool[0],ev);
  assert.equal(rows[1].draft,draft);assert.equal(rows[1].title,'Follow up');
  assert.equal(rows.truncated,true);assert.equal(rows.total,4);
});
test('failed and malformed real carryover reads remain errors through the glasses projection',async()=>{
  for(const api of [async()=>{throw new Error('Offline');},async()=>({}),async()=>({rows:[]})]){
    const ctx=context({__todayDate:'2026-11-10'});
    ctx.window.DCC.api=api;
    vm.runInContext(source('unfinished-tasks'),ctx);
    const result=await ctx.window.DCC.Carryover.collect();
    vm.runInContext(source('catch-up'),ctx);
    if(result.failed){
      assert.equal(result.rows.length,0);
      await assert.rejects(ctx.window.DCC.CatchUp.glassesTasks(),/could not be refreshed/);
    }else{
      assert.equal(result.failed,false);
      assert.equal((await ctx.window.DCC.CatchUp.glassesTasks()).length,0);
    }
  }
});
test('glasses itinerary expands desktop-collapsed parents before filtering done parents',()=>{
  const rows=[{id:'parent',title:'Parent',done:true},{id:'child',title:'Open child',subtaskOf:'parent'}];
  const T={...TM,selectDay:()=>({visible:rows,timed:rows,unscheduled:[]}),selectTree:(items,options)=>{
    assert.equal(options.isCollapsed('parent'),false);
    return items.map(ev=>({ev,depth:ev.subtaskOf?1:0}));
  }};
  const timeBlocks={forDate:()=>[],groupItineraryTree:nodes=>[{block:{id:'timed'},nodes}],UNPLANNED_BLOCK:{id:'unplanned'},TRIAGE_BLOCK:{id:'triage'}};
  const ctx=context({__state:{date:'2026-11-10'},scheduled:rows,_orderUnscheduled:rows=>rows,_fileDoneUntimedOnTheDay(){},isDone:ev=>!!ev.done});
  ctx.DCC=ctx.window.DCC;ctx.DCC.TaskModel=T;ctx.DCC.TimeBlocks=timeBlocks;
  const text=source('schedule-tab');
  vm.runInContext(text.slice(text.indexOf('function _itineraryListModel('),text.indexOf('// Finished work is recorded')),ctx);
  vm.runInContext(text.slice(text.indexOf('window.glassesItineraryTasks='),text.indexOf('window.glassesUnscheduledTasks=')),ctx);
  assert.deepEqual(Array.from(ctx.window.glassesItineraryTasks(),ev=>ev.id),['child']);
});
