const test=require('node:test'),assert=require('node:assert/strict');
const {createActivityDb}=require('./test-support/activity-db');
const {createSharedTaskStore}=require('./shared-task-store');
const W=require('./public/js/workout-model');
const owner={userId:1,workspaceId:'ws-1'},peer={userId:2,workspaceId:'ws-2'};
test('durable shared completion alerts: transactional capture and recipient-controlled access',{skip:!process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL},async t=>{
  const ctx=await createActivityDb();t.after(ctx.close);
  Object.assign(ctx,{getTodayStr:()=> '2026-10-21',APP_TIME_ZONE:'UTC',socialStore:require('./social-store')});
  const store=createSharedTaskStore(ctx),activity=require('./activity-store').createActivityStore(ctx);
  await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,2,'accepted')");
  async function shared(accept=true){
    const task=await activity.create({title:'Synthetic shared task',date:'2026-10-21',record:W.empty()},owner);
    const share=await store.invite(task.taskId,2,owner);
    const joined=accept ? await store.respond(share.id,'accept',peer) : null;
    return {taskId:task.taskId,id:share.id,peerTaskId:joined?.taskId};
  }
  const change=(id,actor,done,mutation,revision=null)=>ctx.blockDB.setTaskCompletion({taskRef:id,...actor,completed:done,mutationId:mutation,expectedRevision:revision});
  const history=async(actor,id)=>(await store.notifications(actor)).filter(n=>n.shareId===id);
  await t.test('capture survives missed SSE, duplicates, no-op writes and store restart',async()=>{
    const s=await shared();
    const result=await change(s.taskId,owner,true,'complete');
    assert.equal((await history(owner,s.id)).length,0);
    let items=await history(peer,s.id);assert.equal(items.length,1);assert.equal(items[0].read,false);assert.equal(items[0].completed,true);
    assert.equal(items[0].actorName,'activity-review');assert.equal(items[0].title,'Synthetic shared task');
    assert.doesNotMatch(JSON.stringify(items),/taskId|record|properties|mutation|workspace|revision/);
    await change(s.taskId,owner,true,'complete');
    await change(s.taskId,owner,true,'complete-again',result.revision);
    await store.notifyTask(s.taskId,'ws-1',()=>{});await store.notifyTask(s.taskId,'ws-1',()=>{});
    assert.equal((await history(peer,s.id)).length,1);
    const restarted=createSharedTaskStore(ctx);assert.ok((await restarted.notifications(peer)).some(n=>n.id===items[0].id));
    const reopened=await change(s.taskId,owner,false,'reopen',result.revision);
    items=await history(peer,s.id);assert.equal(items.length,2);assert.equal(items[0].completed,false);assert.equal(items[1].currentCompleted,false);
    await change(s.taskId,owner,true,'recomplete',reopened.revision);
    assert.equal((await history(peer,s.id)).length,3);
    await assert.rejects(change(s.taskId,owner,false,'stale',result.revision),{statusCode:409});
    assert.equal((await history(peer,s.id)).length,3);
  });
  await t.test('pending invitations do not receive history retroactively',async()=>{
    const s=await shared(false);await change(s.taskId,owner,true,'before-accept');
    assert.equal((await history(peer,s.id)).length,0);await store.respond(s.id,'accept',peer);
    assert.equal((await history(peer,s.id)).length,0);
  });
  await t.test('canonical legacy/batch completion rolls back its notification with the task',async()=>{
    const s=await shared(),q=await ctx.pool.connect();
    try{
      await q.query('BEGIN');const row=await ctx.blockDB.getBlock(s.taskId,q);
      await ctx.blockDB.updateBlock(s.taskId,{properties:row.properties,completionIntent:'complete',completionMutationId:'rolled-back'},q);
      assert.equal((await q.query('SELECT count(*)::int n FROM shared_task_notifications WHERE share_id=$1',[s.id])).rows[0].n,1);
      await q.query('ROLLBACK');
    }finally{q.release();}
    assert.equal((await history(peer,s.id)).length,0);
    const row=await ctx.blockDB.getBlock(s.taskId);
    await ctx.blockDB.updateBlock(s.taskId,{properties:row.properties,completionIntent:'complete',completionMutationId:'legacy-retry'});
    assert.equal((await history(peer,s.id)).length,1);
  });
  await t.test('mute affects only recipient alerts; re-enable never replays muted history',async()=>{
    const s=await shared();const first=await change(s.taskId,owner,true,'pref-done');
    assert.deepEqual(await store.notificationPreferences(peer),{enabled:true});
    await store.setNotificationPreferences(peer,false);
    assert.ok((await history(peer,s.id)).every(n=>n.read));
    const second=await change(s.taskId,owner,false,'pref-reopen',first.revision);
    assert.ok((await history(peer,s.id)).every(n=>n.read));
    await store.setNotificationPreferences(peer,true);
    assert.ok((await history(peer,s.id)).every(n=>n.read));
    await change(s.taskId,owner,true,'pref-new-done',second.revision);
    const items=await history(peer,s.id);assert.equal(items[0].read,false);
    await store.readNotifications(owner,[items[0].id]);assert.equal((await history(peer,s.id))[0].read,false);
    await store.readNotifications(peer,[items[0].id]);await store.readNotifications(peer,[items[0].id]);assert.equal((await history(peer,s.id))[0].read,true);
    await assert.rejects(store.setNotificationPreferences(peer,'false'),{statusCode:400});
    await assert.rejects(store.readNotifications(peer,['not-an-id']),{statusCode:400});
  });
  await t.test('preference cutoffs suppress late-visible events instead of replaying old badges',async()=>{
    const s=await shared();await change(s.taskId,owner,true,'cutoff-done');
    const event=(await history(peer,s.id))[0];
    await store.setNotificationPreferences(peer,false);await store.setNotificationPreferences(peer,true);
    // Simulate a row that was uncommitted (and invisible to both UPDATE sweeps)
    // until after re-enable. Its original event timestamp remains before cutoff.
    await ctx.pool.query('UPDATE shared_task_notifications SET read_at=NULL WHERE id=$1',[event.id]);
    assert.equal((await history(peer,s.id))[0].read,true);
  });
  await t.test('real PostgreSQL late commit cannot resurrect alerts after mute and re-enable',{skip:!!process.env.DCC_PGLITE_MODULE},async()=>{
    const s=await shared(),q=await ctx.pool.connect();
    try{
      await q.query('BEGIN');const row=await ctx.blockDB.getBlock(s.taskId,q);
      await ctx.blockDB.updateBlock(s.taskId,{properties:row.properties,completionIntent:'complete',completionMutationId:'late-commit'},q);
      await store.setNotificationPreferences(peer,false);await store.setNotificationPreferences(peer,true);
      await q.query('COMMIT');
    }catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
    const events=await history(peer,s.id);assert.equal(events.length,1);assert.equal(events[0].read,true);
  });
  await t.test('loss of the completing participant workspace ownership hides their prior events',async()=>{
    const s=await shared();await change(s.peerTaskId,peer,true,'peer-ownership-done');
    assert.equal((await history(owner,s.id)).length,1);
    await ctx.pool.query("DELETE FROM workspace_members WHERE workspace_id='ws-2' AND user_id=2");
    assert.equal((await history(owner,s.id)).length,0);
    assert.ok((await store.list(owner)).find(x=>x.id===s.id).participants.every(p=>p.userId!==2));
    await ctx.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('ws-2',2,'owner',NOW())");
  });
  await t.test('block, revoke, deleted tasks and lost owner access hide stored events immediately',async()=>{
    const s=await shared();const completed=await change(s.taskId,owner,true,'access-done');assert.equal((await history(peer,s.id)).length,1);
    await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(2,1,'blocked')");
    assert.equal((await history(peer,s.id)).length,0);
    await change(s.taskId,owner,false,'blocked-reopen',completed.revision);
    assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM shared_task_notifications WHERE share_id=$1',[s.id])).rows[0].n,1);
    await ctx.pool.query("DELETE FROM friendships WHERE requester_id=2 AND addressee_id=1");
    assert.equal((await history(peer,s.id)).length,1);
    await ctx.pool.query("DELETE FROM workspace_members WHERE workspace_id='ws-1' AND user_id=1");
    assert.equal((await history(peer,s.id)).length,0);
    await ctx.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('ws-1',1,'owner',NOW())");
    await ctx.blockDB.deleteBlock(s.peerTaskId);assert.equal((await history(peer,s.id)).length,0);
    const another=await shared();await change(another.taskId,owner,true,'revoked-done');await store.respond(another.id,'remove',peer);
    assert.equal((await history(peer,another.id)).length,0);
    await assert.rejects(store.notifications({userId:3,workspaceId:'ws-1'}),{statusCode:403});
    await assert.rejects(store.setNotificationPreferences({userId:3,workspaceId:'ws-1'},false),{statusCode:403});
  });
  await t.test('one-off invitations remain usable beyond the recurrence generation horizon',async()=>{
    const task=await activity.create({title:'Future single task',date:'2027-01-01',record:W.empty()},owner);
    const share=await store.invite(task.taskId,2,owner);await store.respond(share.id,'accept',peer);
    assert.ok((await store.list(peer,'2027-01-01')).some(s=>s.id===share.id));
  });
});
