const test=require('node:test'),assert=require('node:assert/strict');
const {createActivityDb}=require('./test-support/activity-db');
const {createSharedTaskStore}=require('./shared-task-store');
const W=require('./public/js/workout-model');
const owner={userId:1,workspaceId:'ws-1'},peer={userId:2,workspaceId:'ws-2'};
test('recurrence materialization reuses the caller transaction, lock and tombstone lookup',async()=>{
  const calls=[],client={query:async(sql,args)=>{calls.push({kind:'lock',sql,args});return {rows:[]};}};
  const definition={id:'shared-series',workspace_id:'ws-1',properties:{kind:'responsibility_item',repeatType:'scheduled',title:'Shared routine',status:'active',estimatedMinutes:20,
    scheduleRule:{version:1,patternType:'calendar',timeZone:'UTC',startDate:'2026-10-21',frequency:'daily',interval:1,times:['07:00'],end:{type:'never'}}}};
  let existing=[],createError=null;
  const blockDB={
    withRepeatSeriesLock:async()=>{assert.fail('must not open a second transaction');},
    getBlock:async(id,q)=>{assert.equal(id,definition.id);assert.equal(q,client);calls.push({kind:'definition'});return definition;},
    getBlocksByIdempotencyKeys:async(workspace,keys,q)=>{assert.equal(workspace,'ws-1');assert.equal(q,client);calls.push({kind:'identities',keys});return existing;},
    createItineraryTasks:async(rows,opts,q)=>{assert.equal(q,client);assert.deepEqual(opts,owner);calls.push({kind:'create'});if(createError)throw createError;return rows;},
    isIdempotencyConflict:error=>error.code==='23505'
  };
  const repeats=require('./responsibility-store')({blockDB,getTodayStr:()=> '2026-10-21',appTimeZone:'UTC'});
  const args={date:'2026-10-22',...owner,targetTimeZone:'UTC'};
  const rows=await repeats.materializeDefinitionForDate(definition.id,args,client);
  assert.ok(rows.length);assert.deepEqual(calls.map(c=>c.kind),['lock','definition','identities','create']);
  assert.match(calls[0].sql,/pg_advisory_xact_lock/);assert.deepEqual(calls[0].args,['ws-1:shared-series']);
  existing=[{deleted_at:'2026-10-21T12:00:00Z',properties:{idempotency_key:calls[2].keys[0]}}];calls.length=0;
  assert.deepEqual(await repeats.materializeDefinitionForDate(definition.id,args,client),[]);
  assert.deepEqual(calls.map(c=>c.kind),['lock','definition','identities'],'a deleted occurrence remains reserved inside the caller transaction');
  existing=[];createError=Object.assign(new Error('synthetic conflict'),{code:'23505'});
  await assert.rejects(repeats.materializeDefinitionForDate(definition.id,args,client),createError,'caller must roll back a failed statement');
});
test('accepted scheduled series: real recurrence, grants and private histories',{skip:!process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL},async t=>{
  const ctx=await createActivityDb();t.after(ctx.close);
  let today='2026-10-21';Object.assign(ctx,{getTodayStr:()=>today,APP_TIME_ZONE:'UTC',socialStore:require('./social-store')});
  const store=createSharedTaskStore(ctx),activity=require('./activity-store').createActivityStore(ctx);
  const repeats=require('./responsibility-store')({blockDB:ctx.blockDB,getTodayStr:ctx.getTodayStr,appTimeZone:'UTC'});
  await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,2,'accepted')");
  async function routine(overrides={}){
    const id=ctx.crypto.randomUUID();
    const properties={kind:'responsibility_item',repeatType:'scheduled',title:'Synthetic daily workout',estimatedMinutes:20,status:'active',activityTaskType:'workout',scheduleRule:{version:1,patternType:'calendar',timeZone:'UTC',startDate:today,frequency:'daily',interval:1,times:['07:00'],end:{type:'never'},...overrides}};
    await ctx.pool.query("INSERT INTO blocks(id,type,properties,created_at,updated_at,user_id,workspace_id) VALUES($1,'task',$2,NOW(),NOW(),1,'ws-1')",[id,properties]);
    const record=W.empty();record.plan=W.gentleReset(ctx.crypto.randomUUID);record.plan.exercises[0].sets[0].weight=997;
    await ctx.pool.query("INSERT INTO task_activity_records(task_id,workspace_id,owner_user_id,task_type,record) VALUES($1,'ws-1',1,'workout',$2)",[id,record]);
    const tasks=await repeats.materializeDefinitionForDate(id,{date:today,...owner});assert.ok(tasks.length);
    const task=tasks[0];
    return {id,task};
  }
  async function shareRoutine(options){const r=await routine(options);const p=await store.preview(r.task.id,owner);assert.equal(p.seriesEligible,true);const share=await store.invite(r.task.id,2,owner,{scope:'series',includeInstructions:true,instructionsHash:p.hash});return {...r,share};}
  const find=async(root,date)=> (await store.list(peer,date)).filter(s=>s.seriesId===root && s.date===date);
  await t.test('one accepted invitation creates fresh dated tasks, frozen instructions and separate completions; duplicate sync is safe',async()=>{
    const r=await shareRoutine();assert.equal((await store.list(peer)).find(s=>s.id===r.share.id).scope,'series');
    await store.sync(peer,'2026-10-22');assert.equal((await find(r.share.id,'2026-10-22')).length,0);
    const joined=await store.respond(r.share.id,'accept',peer);
    await ctx.blockDB.setTaskCompletion({taskRef:joined.taskId,...peer,completed:true,mutationId:'first-done'});
    const record=(await activity.get(joined.taskId,peer)).record;record.occurredOn=today;record.actual.runs.push({id:'private',name:'PRIVATE-RESULT',distance:4,seconds:10,unit:'km'});
    await activity.save(joined.taskId,{record,expectedRevision:1,mutationId:'private-result'},peer);
    await Promise.all([store.sync(peer,'2026-10-22'),store.sync(owner,'2026-10-22'),store.sync(peer,'2026-10-22')]);
    const [next]=await find(r.share.id,'2026-10-22');assert.ok(next);assert.notEqual(next.taskId,joined.taskId);assert.equal(next.participants.length,2);assert.ok(next.participants.every(p=>!p.completed));
    const fresh=(await activity.get(next.taskId,peer)).record;assert.equal(fresh.plan.exercises.length,10);assert.equal(fresh.plan.exercises[0].sets[0].weight,null);assert.deepEqual(fresh.actual,{sets:[],runs:[]});
    const sharedJson=JSON.stringify(await store.list(owner),(_key,value)=>{
      // Check the private measurement as a value, not as a substring of a
      // random task UUID (which can legitimately contain the digits 997).
      assert.notEqual(value,997,'private weight must not enter the shared projection');
      assert.notEqual(value,'997','stringified private weight must not enter the shared projection');
      return value;
    });
    assert.doesNotMatch(sharedJson,/PRIVATE-RESULT/);
    assert.equal((await find(r.share.id,'2026-10-21'))[0].participants.find(p=>p.self).completed,true);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM shared_task_occurrences WHERE series_parent_id=$1',[r.share.id])).rows[0].n,1);
    await assert.rejects(store.preview(next.taskId,owner),{statusCode:404});
    await store.respond(next.id,'remove',peer);
    await store.sync(owner,'2026-10-23');assert.equal((await find(r.share.id,'2026-10-23')).length,0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int n FROM shared_task_participants p JOIN shared_task_occurrences s ON s.id=p.share_id WHERE s.series_parent_id=$1 AND s.occurrence_date='2026-10-23' AND p.user_id=2",[r.share.id])).rows[0].n,0);
    assert.equal((await activity.get(joined.taskId,peer)).record.actual.runs[0].name,'PRIVATE-RESULT');
    assert.equal((await activity.get(next.taskId,peer)).record.plan.exercises.length,10);
  });
  await t.test('one-off consent cannot be widened into a recurring invitation',async()=>{
    const r=await routine();await store.invite(r.task.id,2,owner);await assert.rejects(store.invite(r.task.id,2,owner,{scope:'series'}),{statusCode:409});
  });
  await t.test('revocation after the initial grant check prevents owner generation and every participant write',async()=>{
    const r=await shareRoutine();await store.respond(r.share.id,'accept',peer);
    const query=ctx.pool.query;let revoked=false;
    ctx.pool.query=async(sql,args)=>{
      const result=await query.call(ctx.pool,sql,args);
      if(sql==='SELECT * FROM shared_task_participants WHERE share_id=$1' && args[0]===r.share.id) {
        // Return the accepted preflight snapshot only after the owner has
        // committed removal, immediately before sync can materialize anything.
        ctx.pool.query=query;
        await store.respond(r.share.id,'remove',owner,peer.userId);revoked=true;
      }
      return result;
    };
    try {await store.sync(peer,'2026-10-22');}finally{ctx.pool.query=query;}
    assert.equal(revoked,true,'exercise the stale-grant window rather than an already-removed request');
    assert.equal((await ctx.pool.query("SELECT count(*)::int n FROM blocks WHERE workspace_id='ws-1' AND date='2026-10-22' AND properties->>'repeatSeriesId'=$1",[r.id])).rows[0].n,0);
    assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM shared_task_occurrences WHERE series_parent_id=$1',[r.share.id])).rows[0].n,0);
    assert.equal((await ctx.pool.query('SELECT state FROM shared_task_participants WHERE share_id=$1 AND user_id=2',[r.share.id])).rows[0].state,'removed');
  });
  await t.test('blocked users, outsiders and lost ownership cannot materialize participant tasks',async()=>{
    const r=await shareRoutine();await store.respond(r.share.id,'accept',peer);
    const before=(await ctx.pool.query('SELECT count(*) AS n FROM blocks')).rows[0].n;
    await assert.rejects(store.sync({userId:3,workspaceId:'ws-1'},'2026-10-22'),{statusCode:403});
    assert.equal((await ctx.pool.query('SELECT count(*) AS n FROM blocks')).rows[0].n,before);
    await ctx.pool.query("UPDATE friendships SET status='blocked' WHERE requester_id=1 AND addressee_id=2");
    await store.sync(peer,'2026-10-22');await store.sync(owner,'2026-10-22');assert.equal((await find(r.share.id,'2026-10-22')).length,0);
    await ctx.pool.query("UPDATE friendships SET status='accepted' WHERE requester_id=1 AND addressee_id=2");
    await ctx.pool.query("DELETE FROM workspace_members WHERE user_id=2 AND workspace_id='ws-2'");
    await store.sync(owner,'2026-10-23');
    const row=(await ctx.pool.query("SELECT count(*)::int n FROM shared_task_participants p JOIN shared_task_occurrences s ON s.id=p.share_id WHERE s.series_parent_id=$1 AND s.occurrence_date='2026-10-23' AND p.user_id=2",[r.share.id])).rows[0];assert.equal(row.n,0);
    await ctx.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('ws-2',2,'owner',NOW())");
  });
  await t.test('paused, ended and tombstoned occurrences do not create new shared tasks; invalid/past/distant dates are bounded',async()=>{
    const r=await shareRoutine({end:{type:'on',date:'2026-10-21'}});await store.respond(r.share.id,'accept',peer);
    await store.sync(peer,'2026-10-22');assert.equal((await find(r.share.id,'2026-10-22')).length,0);
    const p=await shareRoutine();await store.respond(p.share.id,'accept',peer);
    await ctx.pool.query("UPDATE blocks SET properties=properties || '{\"pausedUntil\":\"forever\"}'::jsonb WHERE id=$1",[p.id]);
    await store.sync(peer,'2026-10-22');assert.equal((await find(p.share.id,'2026-10-22')).length,0);
    const d=await shareRoutine();await store.respond(d.share.id,'accept',peer);
    const [deleted]=await repeats.materializeDefinitionForDate(d.id,{date:'2026-10-22',...owner});await ctx.pool.query('UPDATE blocks SET deleted_at=NOW() WHERE id=$1',[deleted.id]);
    await store.sync(peer,'2026-10-22');assert.equal((await find(d.share.id,'2026-10-22')).length,0);
    assert.equal((await store.sync(peer,'2026-10-20')).created,0);await assert.rejects(store.sync(peer,'2026-12-01'),{statusCode:400});await assert.rejects(store.sync(peer,'2026-02-30'),{statusCode:400});
  });
  await t.test('sync failures roll back participant tasks and retry preserves a single private session',async()=>{
    const r=await shareRoutine();await store.respond(r.share.id,'accept',peer);
    const before=(await ctx.pool.query("SELECT id FROM blocks WHERE date='2026-10-24' ORDER BY id")).rows;
    const create=ctx.blockDB.createItineraryTask;
    ctx.blockDB.createItineraryTask=async args=>{if(args.workspaceId==='ws-2')throw new Error('synthetic failure');return create(args);};
    try {await assert.rejects(store.sync(peer,'2026-10-24'),/synthetic failure/);}finally{ctx.blockDB.createItineraryTask=create;}
    assert.deepEqual((await ctx.pool.query("SELECT id FROM blocks WHERE date='2026-10-24' ORDER BY id")).rows,before,'owner generation and both day roots roll back along with participant creation');
    assert.equal((await find(r.share.id,'2026-10-24')).length,0);
    await store.sync(peer,'2026-10-24');await store.sync(peer,'2026-10-24');assert.equal((await find(r.share.id,'2026-10-24')).length,1);
  });
  await t.test('GET is read-only; HTTP sync targets each workspace and returns no foreign task IDs',async()=>{
    const r=await shareRoutine();await store.respond(r.share.id,'accept',peer);
    const express=require('express'),app=express(),events=[];app.use(express.json());
    app.use((req,_res,next)=>{req.session={userId:2};req.workspaceId='ws-2';next();});
    require('./routes/shared-tasks')(app,{...ctx,sharedTasks:store,broadcast:(type,data,workspaceId)=>events.push({type,data,workspaceId})});
    const server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv));});
    try {
      const base='http://127.0.0.1:'+server.address().port;
      const before=(await ctx.pool.query('SELECT count(*) n FROM blocks')).rows[0].n;
      await fetch(base+'/api/shared-tasks?date=2026-10-25');assert.equal((await ctx.pool.query('SELECT count(*) n FROM blocks')).rows[0].n,before);
      const response=await fetch(base+'/api/shared-tasks/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:'2026-10-25'})});
      assert.equal(response.status,200);const body=await response.json();assert.deepEqual(Object.keys(body),['created']);assert.ok(body.created>0);
      assert.ok(events.some(e=>e.workspaceId==='ws-1'));assert.ok(events.some(e=>e.workspaceId==='ws-2'));
      for(const event of events){assert.equal(event.type,'blocks-changed');for(const id of event.data.blockIds)assert.equal((await ctx.blockDB.getBlock(id)).workspace_id,event.workspaceId);}
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
  await t.test('timezone date rollover and DST use the existing occurrence identities',async()=>{
    today='2026-10-31';
    const r=await shareRoutine({timeZone:'America/New_York',startDate:'2026-10-30',times:['23:30']});await store.respond(r.share.id,'accept',peer);
    await store.sync(peer,'2026-11-01');await store.sync(peer,'2026-11-02');
    const rows=(await ctx.pool.query('SELECT occurrence_key,occurrence_date FROM shared_task_occurrences WHERE series_parent_id=$1 ORDER BY occurrence_key',[r.share.id])).rows;
    assert.deepEqual(rows.map(x=>x.occurrence_key),['2026-10-31T23:30','2026-11-01T23:30']);
    assert.equal((await find(r.share.id,'2026-11-01')).length,1);assert.equal((await find(r.share.id,'2026-11-02')).length,1);
  });
});
