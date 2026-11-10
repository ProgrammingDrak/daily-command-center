const test = require('node:test');
const assert = require('node:assert/strict');
const {receipt,undo,version}=require('./lib/queue-completion-undo');
const M=require('./lib/conversation-model');
const row=(id,done=true)=>({id,date:'2026-11-10',properties:{type:'task',status:done?'done':'open',done,_completionRevision:'r1',actualMinutes:12}});
function fixture(){
  const rows=[row('parent'),row('child')],calls=[],owner={userId:1,workspaceId:'ws'};
  const saved=receipt({affectedTasks:rows,responsibilityTransitions:rows.map(r=>({id:r.id,before:{status:'open'}})),state:{revision:3}},{taskId:'parent',sourceEventId:'completed'},1000);
  const q={query:async(sql,args)=>{assert.deepEqual(args,[1,'ws','completed']);return {rows:[{result:{undo:saved}}]};}};
  const b={taskId:'parent',expectedRevision:3,sourceEventId:'undo',undoEventId:'completed',at:'2026-11-10T12:00:00Z'};
  const ctx={now:()=>2000,blockDB:{setTaskCompletion:async input=>{calls.push(input);const r=rows.find(r=>r.id===input.taskRef);r.properties.status='open';r.properties.done=false;return {affectedTasks:[r],responsibilityTransitions:[{id:r.id}]};}}};
  return {rows,calls,owner,saved,q,b,ctx,queue:{items:{},order:[]},read:async(_q,id)=>rows.find(r=>r.id===id)};
}
test('undo calls canonical reopening for completed descendants and preserves measured effort',async()=>{
  const f=fixture(),result=await undo(f.q,f.owner,f.queue,f.b,f.ctx,f.read);
  assert.deepEqual(result.touchedTaskIds,['parent','child']);
  assert.equal(result.responsibilityTransitions.length,2);
  for(const call of f.calls){assert.equal(call.completed,false);assert.equal(call.includeDescendants,false);assert.equal(call.expectedRevision,'r1');assert.equal(call.transactionClient,f.q);}
  assert.equal(result.task.properties.actualMinutes,12);assert.equal(f.queue.items.parent.status,'paused');
});
test('expiry, wrong revision and changed task fail before any reopening',async()=>{
  for(const mutate of [f=>f.ctx.now=()=>31001,f=>f.b.expectedRevision=4,f=>f.rows[1].properties.title='Changed',f=>f.b.taskId='other']){
    const f=fixture();mutate(f);await assert.rejects(undo(f.q,f.owner,f.queue,f.b,f.ctx,f.read),{statusCode:409});assert.equal(f.calls.length,0);
  }
});
test('already completed descendants are never included in the undo receipt',()=>{
  const result={affectedTasks:[row('a'),row('b')],responsibilityTransitions:[{id:'a',before:{done:false}},{id:'b',before:{done:true}}],state:{revision:1}};
  assert.deepEqual(receipt(result,{taskId:'a',sourceEventId:'x'},0).rows,[{id:'a',version:version(row('a'))}]);
});
test('undo requires a canonical event and rejects event fields on other commands',()=>{
  const b={action:'undo-completion',sourceEventId:'u',taskId:'a',expectedRevision:2,at:new Date().toISOString()};
  assert.throws(()=>M.command(b));assert.equal(M.command({...b,undoEventId:'saved'}).undoEventId,'saved');
  assert.throws(()=>M.command({...b,action:'done',undoEventId:'saved'}));
});
test('real coordinator completion replay and undo are idempotent and account guarded',{skip:!process.env.DCC_TEST_DATABASE_URL&&!process.env.DCC_PGLITE_MODULE},async t=>{
  const f=await require('./test-support/shared-queue-fixture').createSharedQueueFixture();t.after(()=>f.close());
  const state=(await f.request('/api/working-queue',{user:1})).body;
  const command={action:'done',taskId:'high',expectedRevision:state.revision,sourceEventId:'undo-test-complete',at:new Date().toISOString()};
  const completed=await f.request('/api/working-queue',{user:1,body:command});assert.equal(completed.status,200,JSON.stringify(completed.body));assert.ok(completed.body.undo);
  const b={action:'undo-completion',taskId:'high',expectedRevision:completed.body.undo.expectedRevision,sourceEventId:'undo-test-reopen',undoEventId:command.sourceEventId,at:new Date().toISOString()};
  assert.equal((await f.request('/api/working-queue',{user:3,body:b})).status,403);
  const undone=await f.request('/api/working-queue',{user:1,body:b});assert.equal(undone.status,200,JSON.stringify(undone.body));assert.notEqual(undone.body.task.properties.status,'done');
  const replay=await f.request('/api/working-queue',{user:1,body:b});assert.equal(replay.status,200);assert.equal(replay.body.duplicate,true);
  assert.equal((await f.request('/api/working-queue',{user:1,body:{...b,sourceEventId:'second-undo'}})).status,409);
});
function clientFixture(){
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync('public/js/working-queue.js','utf8');
  const fragment=source.slice(source.indexOf('  const actionAccount='),source.indexOf('  window.DCCWorkingQueue='));
  const account={userId:1,workspaceId:'ws'},state={revision:4,foreground:[]},item={task:{id:'task',properties:{}},status:'queued'},sent=[];
  const c={account,window:{DCC_ACCOUNT_CONTEXT:account},navigator:{onLine:true},state,sending:false,pending:null,conflict:null,items:()=>[item],refresh:async()=>state,DCC:{api:async()=>({task:item.task})},envelope:(action,extra)=>({action,...extra}),send:async command=>{sent.push(command);return {undo:{taskId:'task',sourceEventId:'completed',expectedRevision:5,expiresAt:Date.now()+30000}};}};
  vm.runInNewContext(fragment+';globalThis.actions={performTaskAction,openTaskOutcome,undoCompletion};',c);
  return {c,sent,item};
}
test('client only offers acknowledged five-second undo and uses canonical commands',async()=>{
  const {c,sent}=clientFixture();const start=Date.now();const result=await c.actions.performTaskAction('complete','task');
  assert.equal(sent[0].action,'done');assert.equal(sent[0].expectedRevision,4);
  assert.ok(result.undo.expiresAt>=start+5000&&result.undo.expiresAt<=Date.now()+5000);
  c.state.revision=5;await c.actions.undoCompletion(result.undo);assert.equal(sent[1].action,'undo-completion');
});
test('client refuses offline, pending, changed account/revision, expired undo and source-specific completion',async()=>{
  for(const mutate of [f=>f.c.navigator.onLine=false,f=>f.c.pending={},f=>f.c.window.DCC_ACCOUNT_CONTEXT={userId:2,workspaceId:'ws'},f=>f.c.refresh=async()=>({revision:8})]){
    const f=clientFixture();mutate(f);await assert.rejects(f.c.actions.performTaskAction('complete','task'));assert.equal(f.sent.length,0);
  }
  const f=clientFixture();await assert.rejects(f.c.actions.performTaskAction('complete','task',{kind:'waiting'}));assert.equal(f.sent.length,0);
  await assert.rejects(f.c.actions.undoCompletion({account:{userId:1,workspaceId:'ws'},expectedRevision:4,expiresAt:0}));assert.equal(f.sent.length,0);
  f.c.send=async()=>{throw new Error('Not acknowledged');};await assert.rejects(f.c.actions.performTaskAction('complete','task'),/Not acknowledged/);
});

test('background uses the existing explicit thirty-minute snooze policy',async()=>{
  const f=clientFixture();await f.c.actions.performTaskAction('background','task');
  assert.equal(f.sent[0].action,'background-start');assert.equal(f.sent[0].attentionMode,'snooze');assert.equal(f.sent[0].remindMinutes,30);
});
test('source outcome routes open the canonical owner without claiming completion',async()=>{
  const f=clientFixture(),opened=[];f.c.DCC.Waiting={open:id=>{opened.push(id);return true;}};
  const result=await f.c.actions.openTaskOutcome('waiting:abc',{kind:'waiting',actionId:'abc'});
  assert.deepEqual(opened,['abc']);assert.equal(result.opened,true);assert.equal(result.completed,false);assert.equal(f.sent.length,0);
  f.c.DCC.CatchUp={open:async()=>true};assert.equal((await f.c.actions.openTaskOutcome('triage:x',{kind:'triage'})).owner,'triage');
  f.c.DCC.Waiting.open=()=>false;await assert.rejects(f.c.actions.openTaskOutcome('missing',{kind:'waiting'}));
  f.c.DCC.CatchUp.open=async()=>false;await assert.rejects(f.c.actions.openTaskOutcome('missing',{kind:'triage'}));
});
test('task outcome uses existing completion dialog even though its opener returns no handle',async()=>{
  const f=clientFixture();let opened=false,transitionAction;
  f.c.document={getElementById:()=>({classList:{contains:()=>opened}})};
  f.c.DCC.TaskModel={fromBlock:row=>({id:row.id,...row.properties})};
  f.c.transition=async action=>{transitionAction=action;opened=true;};
  const result=await f.c.actions.openTaskOutcome('task',{kind:'task'});
  assert.equal(transitionAction,'done');assert.equal(result.opened,true);assert.equal(result.completed,false);assert.equal(f.sent.length,0);
  await assert.rejects(f.c.actions.openTaskOutcome('task',{kind:'task'}),/Finish or close/);
});
