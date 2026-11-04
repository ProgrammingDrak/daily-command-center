const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const M = require('./lib/conversation-model');
const epoch = Date.parse('2026-11-01T05:55:00Z');
const bulk = {action:'queue-snooze-all',sourceEventId:'bulk-test',expectedRevision:0,at:new Date(epoch).toISOString(),remindMinutes:30,targets:[{taskId:'one',generation:null}]};
test('bulk snooze envelope is bounded, explicit and rejects ambiguous targets',()=>{
  assert.deepEqual(M.command(bulk,epoch),bulk);
  for(const targets of [[],Array.from({length:101},(_,i)=>({taskId:String(i)})),[null],[{taskId:''}],[{taskId:'one',generation:5}],[{taskId:'one',userId:2}],[{taskId:'one'},{taskId:'one'}]])assert.throws(()=>M.command({...bulk,targets},epoch));
  for(const remindMinutes of [null,0,-1,1.5,1441])assert.throws(()=>M.command({...bulk,remindMinutes},epoch));
  assert.throws(()=>M.command({...bulk,taskId:'unexpected'},epoch));
  assert.throws(()=>M.command({...bulk,action:'queue-snooze',taskId:'one'},epoch));
});
test('bulk snooze is atomic, owner-scoped and replay-safe without touching tasks or foreground',
  {skip:!process.env.DCC_TEST_DATABASE_URL&&!process.env.DCC_PGLITE_MODULE},async t=>{
  const ctx=await require('./test-support/activity-db').createActivityDb();
  t.after(()=>ctx.close());
  const {createConversationStore,FOREGROUND_INDEX_SQL}=require('./conversation-store');
  await ctx.pool.query(FOREGROUND_INDEX_SQL);
  let now=epoch;
  const owner={userId:1,workspaceId:'ws-1'},other={userId:2,workspaceId:'ws-2'};
  const store=createConversationStore({...ctx,now:()=>now,APP_TIME_ZONE:'America/New_York'});
  const state=()=>store.state(owner);
  const send=async(action,taskId,extra={})=>store.execute({action,...(taskId?{taskId}:{}),sourceEventId:crypto.randomUUID(),expectedRevision:(await state()).revision,at:new Date(now).toISOString(),...extra},owner);
  for(const id of ['focus','blocked','review','check','plain','later']){
    await ctx.blockDB.createBlock({id,type:'block',user_id:1,workspace_id:'ws-1',date:'2026-11-01',properties:{local_id:id,type:'task',title:id,status:'open',duration:20,actualMinutes:7,notes:'retain'}});
    await send('queue-add',id);
  }
  await ctx.blockDB.createBlock({id:'other',type:'block',user_id:2,workspace_id:'ws-2',date:'2026-11-01',properties:{type:'task',title:'other',status:'open'}});
  await store.execute({action:'queue-block',taskId:'other',sourceEventId:'other-block',expectedRevision:0,at:new Date(now).toISOString()},other);
  await send('start','focus');
  await send('queue-block','blocked');
  await send('queue-note','blocked',{note:'Keep blocker'});
  await send('pause','check',{attentionMode:'needs-you'});
  await send('queue-snooze','later',{remindMinutes:60});
  await send('delegated-register','review',{delegation:{work:{kind:'research',source:'test',id:'review-work'},phase:'needs-review',sequence:1,note:'Review draft',reviewActions:['Review it'],intent:'explicit-work-handoff'}});
  const command=async()=>{
    const s=await state();return {...bulk,sourceEventId:crypto.randomUUID(),expectedRevision:s.revision,at:new Date(now).toISOString(),targets:s.queue.items.filter(i=>i.needsYou&&i.status!=='foreground').map(i=>({taskId:i.task.id,generation:i.generation||null}))};
  };
  const before=await state(),rows=(await ctx.pool.query('SELECT * FROM blocks ORDER BY id')).rows;
  const cmd=await command();assert.equal(cmd.targets.length,3);
  await assert.rejects(store.execute({...cmd,targets:cmd.targets.slice(1)},owner),{statusCode:409});
  await assert.rejects(store.execute({...cmd,targets:[...cmd.targets,{taskId:'other'}]},owner),{statusCode:409});
  await assert.rejects(store.execute({...cmd,targets:cmd.targets.map((x,i)=>i?x:{...x,generation:'stale'})},owner),{statusCode:409});
  assert.deepEqual(await state(),before,'all rejected commands leave all reminders and revision intact');
  const result=await store.execute(cmd,owner);assert.equal(result.snoozedCount,3);
  let after=await state();
  for(const id of ['blocked','review','check']){
    const item=after.queue.items.find(i=>i.task.id===id);
    assert.equal(item.snoozed,true);assert.equal(item.needsYou,false);assert.equal(item.dueAt,'2026-11-01T06:25:00.000Z');
    const prior=before.queue.items.find(i=>i.task.id===id);
    assert.equal(item.note,prior.note);assert.deepEqual(item.delegated,prior.delegated);assert.equal(item.blocked,prior.blocked);
  }
  for(const id of ['focus','plain','later'])assert.deepEqual(after.queue.items.find(i=>i.task.id===id),before.queue.items.find(i=>i.task.id===id));
  assert.deepEqual((await ctx.pool.query('SELECT * FROM blocks ORDER BY id')).rows,rows,'no status, actual, session or task changes');
  assert.equal((await store.state(other)).queue.items[0].needsYou,true);
  const duplicate=await store.execute(cmd,owner);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.claimed,false);
  assert.equal((await state()).revision,after.revision);
  await assert.rejects(store.execute({...cmd,sourceEventId:crypto.randomUUID()},owner),{statusCode:409});
  now+=30*60000;
  after=await state();assert.equal(after.queue.items.filter(i=>i.needsYou).length,3);
  const target=after.queue.items.find(i=>i.task.id==='check');
  const claims=await Promise.allSettled([send('queue-claim','check',{generation:target.generation}),send('queue-claim','check',{generation:target.generation})]);
  assert.equal(claims.filter(o=>o.status==='fulfilled'&&o.value.claimed).length,1);
  const stale=await command();
  await send('start','review');
  await assert.rejects(store.execute(stale,owner),{statusCode:409});
  assert.equal((await state()).queue.items.find(i=>i.task.id==='blocked').needsYou,true);
  // Simulate an independent task writer that does not increment queue revision.
  const deleted=await command();await ctx.blockDB.deleteBlock('blocked');
  await assert.rejects(store.execute(deleted,owner),{statusCode:409});
  assert.equal((await state()).queue.items.find(i=>i.task.id==='check').needsYou,true);
});
