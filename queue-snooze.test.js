const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Policy = require('./public/js/queue-policy');
const M = require('./lib/conversation-model');

const epoch = Date.parse('2026-11-01T05:55:00Z');
test('cached snoozes expire by absolute time, retaining review and honest execution state', () => {
  const due = new Date(epoch + 30 * 60000).toISOString();
  const item = {status:'queued', needsReview:true, blocked:true, dueAt:due, snoozedUntil:due, delegated:[]};
  const waiting = Policy.presentation(item, epoch);
  assert.equal(waiting.status, 'background');
  assert.equal(waiting.snoozed, true);
  assert.equal(waiting.needsYou, false);
  assert.equal(waiting.needsReview, true);
  assert.equal(waiting.blocked, true);
  assert.equal(waiting.execution.state, 'unknown');
  const worker={phase:'working',work:{source:'test',id:'worker'},execution:{state:'running',observedAt:new Date(epoch).toISOString(),validUntil:new Date(epoch+60000).toISOString()}};
  const dual=Policy.presentation({...item,delegated:[worker]},epoch);
  assert.equal(dual.snoozed,true);assert.equal(dual.needsYou,false);assert.equal(dual.execution.state,'running','snoozing attention does not stop an independently running worker');
  const resumed = Policy.presentation(JSON.parse(JSON.stringify(waiting)), epoch + 30 * 60000);
  assert.equal(resumed.snoozed, false);
  assert.equal(resumed.needsYou, true);
  assert.equal(resumed.status, 'queued');
  assert.equal(Policy.presentation({...item,status:null},epoch).status,null);
  assert.equal(Policy.presentation({...item,status:'foreground'},epoch).status,'foreground');
  assert.equal(Policy.presentation({...item,status:'completed'},epoch).status,'completed');
  assert.equal(Policy.presentation({...item,dueAt:null,snoozedUntil:null},epoch).needsYou,true);
  assert.equal(Policy.presentation({...item,needsReview:false,dueAt:null,snoozedUntil:null},epoch).needsYou,false);
});
test('snooze may start without a reminder but claim and dismiss still require its generation', () => {
  const body={action:'queue-snooze',taskId:'task',sourceEventId:'snooze-test',expectedRevision:0,at:new Date(epoch).toISOString(),remindMinutes:30};
  assert.equal(M.command(body,epoch).remindMinutes,30);
  for(const action of ['queue-claim','queue-dismiss']) assert.throws(()=>M.command({...body,action},epoch),/generation/);
  for(const minutes of [null,0,-1,1.5,1441]) assert.throws(()=>M.command({...body,remindMinutes:minutes},epoch));
});

test('durable Needs You snooze preserves reasons and clocks, serializes retries and expires once',
  {skip:!process.env.DCC_TEST_DATABASE_URL&&!process.env.DCC_PGLITE_MODULE}, async t => {
  const ctx=await require('./test-support/activity-db').createActivityDb();
  const {createConversationStore,FOREGROUND_INDEX_SQL}=require('./conversation-store');
  await ctx.pool.query(FOREGROUND_INDEX_SQL);
  const prior=process.env.DCC_CONVERSATION_ENABLED;
  process.env.DCC_CONVERSATION_ENABLED='true';
  t.after(async()=>{if(prior===undefined)delete process.env.DCC_CONVERSATION_ENABLED;else process.env.DCC_CONVERSATION_ENABLED=prior;await ctx.close();});
  let now=epoch;
  const owner={userId:1,workspaceId:'ws-1'};
  const newStore=()=>createConversationStore({...ctx,now:()=>now,APP_TIME_ZONE:'America/New_York'});
  let store=newStore();
  const body=async(action,taskId,extra={})=>({action,taskId,sourceEventId:crypto.randomUUID(),expectedRevision:(await store.state(owner)).revision,at:new Date(now).toISOString(),...extra});
  const send=async(action,id,extra={})=>store.execute(await body(action,id,extra),owner);
  const entry=async id=>(await store.state(owner)).queue.items.find(i=>i.task.id===id);
  for(const id of ['parent','focus','blocked','review','complete','removed','idle']) {
    await ctx.blockDB.createBlock({id,type:'block',user_id:1,workspace_id:'ws-1',date:'2026-11-01',properties:{local_id:id,type:'task',title:id,status:'open',duration:20,...(id==='blocked'?{subtaskOf:'parent',responsibilityId:'retained-occurrence',notes:'Original context',actualMinutes:7}:{})}});
    await send('queue-add',id);
  }
  await send('start','focus');
  const focusBefore=await ctx.blockDB.getBlock('focus');
  await send('queue-block','blocked');
  await send('queue-note','blocked',{note:'Preserve the original blocker'});
  const before=await ctx.blockDB.getBlock('blocked');
  const blockedBefore=await entry('blocked');
  assert.equal(blockedBefore.needsYou,true);assert.equal(blockedBefore.dueAt,null);

  await t.test('no-reminder blocker snoozes without altering task, occurrence or foreground',async()=>{
    const cmd=await body('queue-snooze','blocked',{remindMinutes:30});
    await store.execute(cmd,owner);
    const current=await entry('blocked');
    assert.equal(current.status,'background');assert.equal(current.snoozed,true);assert.equal(current.needsYou,false);
    assert.equal(current.blocked,true);assert.equal(current.needsReview,true);assert.equal(current.note,blockedBefore.note);
    assert.equal(current.dueAt,'2026-11-01T06:25:00.000Z','elapsed delay crosses DST without ambiguity');
    assert.equal(current.execution.state,'unknown');
    assert.deepEqual((await ctx.blockDB.getBlock('blocked')).properties,before.properties);
    assert.deepEqual((await ctx.blockDB.getBlock('focus')).properties,focusBefore.properties);
    assert.equal((await ctx.blockDB.getTaskTimeEntries('blocked','ws-1')).length,0);
    const replay=await store.execute(cmd,owner);assert.equal(replay.duplicate,true);
    assert.equal((await entry('blocked')).generation,current.generation);
    await assert.rejects(send('queue-return','blocked'),/Resolve the review/);
    const idleBefore=await ctx.blockDB.getBlock('idle');
    await send('queue-snooze','idle',{remindMinutes:5});
    assert.equal((await entry('idle')).snoozed,true);
    assert.deepEqual((await ctx.blockDB.getBlock('idle')).properties,idleBefore.properties);
    assert.deepEqual((await ctx.blockDB.getBlock('focus')).properties,focusBefore.properties);
    await assert.rejects(send('queue-snooze','focus',{remindMinutes:5}),{statusCode:409});
  });
  await t.test('resnooze invalidates old callbacks and concurrent stale writes',async()=>{
    const old=await entry('blocked');
    now+=5*60000;
    const cmd=await body('queue-snooze','blocked',{generation:old.generation,remindMinutes:60});
    const outcomes=await Promise.allSettled([store.execute(cmd,owner),store.execute({...cmd,sourceEventId:crypto.randomUUID()},owner)]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal(outcomes.find(o=>o.status==='rejected').reason.statusCode,409);
    const current=await entry('blocked');
    assert.notEqual(current.generation,old.generation);
    assert.equal(current.dueAt,new Date(now+60*60000).toISOString());
    await assert.rejects(send('queue-claim','blocked',{generation:old.generation}),{statusCode:409});
    await assert.rejects(send('queue-snooze','blocked',{remindMinutes:5}),{statusCode:409});
    assert.equal((await send('queue-claim','blocked',{generation:current.generation})).claimed,false,'not due yet');
  });
  await t.test('reopened store after closed-app expiry returns attention; only one tab claims',async()=>{
    const current=await entry('blocked');now=Date.parse(current.dueAt);
    store=newStore();
    assert.equal((await entry('blocked')).needsYou,true);
    assert.equal((await entry('blocked')).snoozed,false);
    assert.equal((await entry('blocked')).blocked,true);
    const cmd=await body('queue-claim','blocked',{generation:current.generation});
    const commands=[cmd,{...cmd,sourceEventId:crypto.randomUUID()}];
    const outcomes=await Promise.allSettled(commands.map(command=>store.execute(command,owner)));
    assert.equal(outcomes.filter(o=>o.status==='fulfilled'&&o.value.claimed).length,1);
    const winner=commands[outcomes.findIndex(o=>o.status==='fulfilled'&&o.value.claimed)];
    assert.equal((await store.execute(winner,owner)).claimed,false,'receipt replay cannot notify twice');
    assert.equal((await send('queue-claim','blocked',{generation:current.generation})).claimed,false);
    assert.deepEqual((await ctx.blockDB.getBlock('focus')).properties,focusBefore.properties);
    assert.equal((await ctx.blockDB.getTaskTimeEntries('blocked','ws-1')).length,0);
  });
  await t.test('dismiss and review now retain reasons; completion and deletion invalidate old reminders',async()=>{
    const old=await entry('blocked');
    await send('queue-snooze','blocked',{generation:old.generation,remindMinutes:15});
    const snooze=await entry('blocked');
    await send('queue-dismiss','blocked',{generation:snooze.generation});
    assert.equal((await entry('blocked')).needsYou,true);assert.equal((await entry('blocked')).blocked,true);
    await send('queue-snooze','blocked',{remindMinutes:15});
    const review=await entry('blocked');
    await send('queue-unblock','blocked');
    assert.equal((await entry('blocked')).needsYou,false);assert.equal((await entry('blocked')).dueAt,null);
    await assert.rejects(send('queue-claim','blocked',{generation:review.generation}),{statusCode:409});
    for(const id of ['complete','removed']) {
      await send('queue-block',id);await send('queue-snooze',id,{remindMinutes:15});
      const current=await entry(id);
      if(id==='complete')await send('done',id);else await ctx.blockDB.deleteBlock(id);
      now+=16*60000;
      assert.ok(!(await entry(id))?.needsYou);
      await assert.rejects(send('queue-claim',id,{generation:current.generation}));
    }
  });
  await t.test('delegated review without a timer retains its source reason throughout snooze',async()=>{
    const delegation={work:{kind:'research',source:'test',id:'review-work'},phase:'needs-review',sequence:1,note:'Draft ready for review',reviewActions:['Review this draft'],intent:'explicit-work-handoff'};
    await send('delegated-register','review',{delegation});
    const priorReview=await entry('review');assert.equal(priorReview.needsYou,true);
    await send('queue-snooze','review',{remindMinutes:10});
    const deferred=await entry('review');assert.equal(deferred.snoozed,true);assert.equal(deferred.needsReview,true);
    assert.deepEqual(deferred.delegated,priorReview.delegated);
    now+=10*60000;assert.equal((await entry('review')).needsYou,true);
    await send('queue-snooze','review',{generation:(await entry('review')).generation,remindMinutes:10});
    const old=(await entry('review')).generation;
    await send('start','review');
    assert.equal((await entry('review')).status,'foreground');
    assert.equal((await entry('review')).dueAt,null,'reviewing now cancels the deferred reminder');
    await assert.rejects(send('queue-claim','review',{generation:old}),{statusCode:409});
  });
});
