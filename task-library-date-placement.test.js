const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TaskModel = require('./public/js/task-model');
const {plan} = require('./lib/whenever-placement');

const row = (id, properties = {}, extra = {}) => ({
  id, type:'block', date:null, parent_id:null, workspace_id:'mine', updated_at:'2026-10-07T12:00:00Z',
  properties:{kind:'backlog',local_id:'local-'+id,title:id,type:'task',duration:30,detail:'Keep the notes',...properties},...extra,
});
function tree(){return [row('root'),row('sub',{subtaskOf:'local-root',duration:0}),row('nested',{wrapId:'root',duration:15},{parent_id:'root'}),row('deep',{subtaskOf:'local-nested',duration:0}),row('column',{}, {parent_id:'root'}),row('unrelated')];}
function mount(rows, writer){
  const handlers={}, writes=[], broadcasts=[], pools=[];
  const app={get(){},post(url,handler){handlers[url]=handler;},patch(){},put(){},delete(){}};
  require('./routes/blocks')(app,{
    isValidDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value||''),
    blockDB:{
      getBlockIncludingDeleted:async id=>rows.find(item=>item.id===id),
      getRescheduleSubtreePool:async(...args)=>{pools.push(args);return rows;},
      rescheduleBlocks:async(moves,creates)=>{if(writer)await writer(moves);writes.push({moves,creates});return {blocks:moves};},
    },broadcast:(...args)=>broadcasts.push(args),
  });
  return {writes,broadcasts,pools,async call(id,body){
    let status=200,result;
    await handlers['/api/blocks/:id/reschedule']({params:{id},body,workspaceId:'mine',session:{userId:1}},
      {status(code){status=code;return this;},json(value){result=value;return this;}});
    return {status,result};
  }};
}

test('date-only pool assignment preserves the full tree, identity, notes, zero durations and revisions',async()=>{
  const rows=tree();Object.assign(rows[0].properties,{start:'09:00',end:'10:30',_pinnedStart:'09:00',userSetStart:true,all_day:true,all_day_start:'2026-10-01',all_day_end:'2026-10-02'});
  const fixture=mount(rows);
  const {status,result}=await fixture.call('root',{targetDate:'2026-10-08',placement:{kind:'pool_date'}});
  assert.equal(status,200);assert.equal(result.fromDate,null);assert.equal(result.count,5);
  assert.deepEqual(new Set(result.moved),new Set(['root','sub','nested','deep','column']));
  assert.equal(fixture.writes.length,1);assert.deepEqual(fixture.writes[0].creates,[]);
  assert.deepEqual(fixture.pools,[[null,'mine',{includeDatelessRoots:true}]]);
  assert.equal(fixture.broadcasts.length,1);
  for(const move of result.blocks){
    const original=rows.find(item=>item.id===move.id);
    assert.equal(move.date,'2026-10-08');assert.equal(move.expectedDate,null);assert.equal(move.expectedUpdatedAt,original.updated_at);
    assert.equal(move.properties.local_id,original.properties.local_id);assert.equal(move.properties.detail,'Keep the notes');
    assert.equal(move.properties.start,null);assert.equal(move.properties.end,null);
    assert.equal(move.properties.duration,original.properties.duration);
    for(const key of ['kind','rescheduledFrom','_pinnedStart','userSetStart','all_day','all_day_start','all_day_end'])assert.equal(move.properties[key],undefined);
    assert.equal(TaskModel.fromBlock({...original,...move}).untimed,true);
  }
  assert.equal(result.blocks.find(item=>item.id==='sub').properties.subtaskOf,'local-root');
  assert.equal(result.blocks.find(item=>item.id==='deep').properties.subtaskOf,'local-nested');
  assert.equal(result.blocks.find(item=>item.id==='nested').properties.wrapId,'root');
  assert.equal(result.blocks[0].parentId,null);
});

test('date-only assignment supports API task IDs without local_id and ordinary undated task rows',()=>{
  for(const kind of ['backlog','task']){
    const parent=row('api',{kind});delete parent.properties.local_id;
    const move=plan(parent,[parent],{targetDate:'2026-10-08',placement:{kind:'pool_date'}}).moves[0];
    assert.equal(move.id,'api');assert.equal(move.properties.kind,'task');
    assert.equal(TaskModel.foldsIntoItinerary({...parent,...move}),true);
  }
});

test('date-only assignment rejects wrong scope, deleted/locked work, non-tasks, time payloads and stale dated rows',async()=>{
  const badRows=[
    row('root',{}, {workspace_id:'other'}),row('root',{}, {deleted_at:'now'}),
    row('root',{locked:true}),row('root',{status:'done'}),row('root',{source:'calendar'}),
    row('root',{kind:'delegated_item'}),row('root',{}, {date:'2026-10-07'}),
    row('root',{}, {type:'day_root'}),
  ];
  for(const parent of badRows){
    const fixture=mount([parent]);const result=await fixture.call('root',{targetDate:'2026-10-08',placement:{kind:'pool_date'}});
    assert.ok(result.status>=400,JSON.stringify(parent));assert.equal(fixture.writes.length,0);
  }
  for(const payload of [{targetDate:'bad'}, {parentStart:'09:00'}, {parentEnd:'09:30'}, {placement:{kind:'pool_date',durations:{stranger:30}}}]){
    const fixture=mount(tree());const result=await fixture.call('root',{targetDate:'2026-10-08',placement:{kind:'pool_date'},...payload});
    assert.equal(result.status,400);assert.equal(fixture.writes.length,0);
  }
  const foreign=tree();foreign[3].workspace_id='other';const fixture=mount(foreign);
  assert.equal((await fixture.call('root',{targetDate:'2026-10-08',placement:{kind:'pool_date'}})).status,404);
  assert.equal(fixture.writes.length,0);
});

test('date-only assignment passes revision guards and propagates concurrent-move rejection atomically',async()=>{
  const fixture=mount(tree(),async moves=>{
    assert.ok(moves.every(move=>move.expectedDate===null&&move.expectedUpdatedAt));
    const error=new Error('Task changed while placing');error.statusCode=409;error.code='RESCHEDULE_STALE';throw error;
  });
  const result=await fixture.call('root',{targetDate:'2026-10-08',placement:{kind:'pool_date'}});
  assert.equal(result.status,409);assert.equal(result.result.code,'RESCHEDULE_STALE');
  assert.equal(fixture.writes.length,0);assert.equal(fixture.broadcasts.length,0);
});

function libraryCallback(write){
  const source=fs.readFileSync(require.resolve('./public/js/task-library'),'utf8');
  const begin=source.indexOf('  function scheduleTask(task,anchor){');
  const end=source.indexOf('\n  function continueProject(',begin);
  assert.ok(begin>=0&&end>begin);
  let config;const notices=[],refreshes=[];
  const schedule=vm.runInNewContext('('+source.slice(begin,end)+')',{
    window:{blockStore:{rescheduleBlock:write}},openSchedulePopover:value=>{config=value;},
    notify:(...args)=>notices.push(args),refresh:()=>{},setTimeout:fn=>refreshes.push(fn),
  });
  return {notices,refreshes,pick(task){schedule(task,{});return config.onPick;}};
}

test('actual Task Library date callback assigns an undated task without source date or times',async()=>{
  for(const target of ['2026-10-07','2026-10-08','2026-12-19']){
    const fixture=mount(tree());const sent=[];
    const ui=libraryCallback(async(id,date,options)=>{
      sent.push({id,date,options});const reply=await fixture.call(id,{targetDate:date,...options});
      if(reply.status!==200)throw new Error(reply.result.error);
    });
    await ui.pick({id:'root',title:'Synthetic task',raw:{date:null}})(target);
    assert.equal(sent[0].options.placement.kind,'pool_date');assert.equal(sent[0].options.fromDate,undefined);
    assert.equal(sent[0].options.parentStart,undefined);assert.equal(fixture.writes.length,1);
    assert.ok(fixture.writes[0].moves.every(move=>move.date===target));
    assert.deepEqual(ui.notices,[['Added to itinerary']]);assert.equal(ui.refreshes.length,1);
  }
});

test('dated Task Library moves keep their origin and rejected assignments show an error instead of success',async()=>{
  const sent=[];const ui=libraryCallback(async(id,date,options)=>sent.push({id,date,options}));
  await ui.pick({id:'dated',title:'Existing dated task',raw:{date:'2026-10-07'}})('2026-10-08');
  assert.equal(sent[0].options.fromDate,'2026-10-07');assert.equal(sent[0].options.placement,undefined);
  const denied=libraryCallback(async()=>{throw new Error('Task changed elsewhere');});
  await denied.pick({id:'root',title:'Stale task',raw:{date:null}})('2026-10-08');
  assert.deepEqual(denied.notices,[['Task changed elsewhere','error']]);assert.equal(denied.refreshes.length,0);
});
