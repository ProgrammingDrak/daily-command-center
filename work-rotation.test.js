const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createWorkRotationStore,SCHEMA_SQL}=require("./work-rotation-store");
const owner={userId:1,workspaceId:"ws-1"};
const uid=()=>crypto.randomUUID();
test("manual rotation: atomic effort, reminders, reload, stale tabs and guided guards",{skip:!process.env.DCC_TEST_DATABASE_URL&&!process.env.DCC_PGLITE_MODULE},async t=>{
 const ctx=await require("./test-support/activity-db").createActivityDb();
 let now=Date.now()-3600000;const store=createWorkRotationStore({...ctx,now:()=>now,APP_TIME_ZONE:"UTC"});
 const make=async(title,extra={})=>ctx.blockDB.createBlock({id:uid(),type:"block",date:"2099-01-02",workspace_id:"ws-1",user_id:1,properties:{local_id:uid(),type:"task",title,status:"open",duration:30,...extra}});
 const command=async(action,extra={})=>({action,operationId:uid(),expectedRevision:(await store.get(owner)).revision,...extra});
 const read=id=>ctx.blockDB.getBlock(id);
 const start=async b=>{const at=new Date(now-600000).toISOString();return ctx.blockDB.updateBlock(b.id,{properties:{...b.properties,startedAt:at,activeWorkSessionId:uid(),workStateChangedAt:at}});};
 const switchTo=async(from,to,minutes=5,extra={})=>store.mutate(owner,await command("switch",{fromId:from?.id||null,fromStartedAt:from?.properties.startedAt||null,toId:to.id,toWorkStateChangedAt:to.properties.workStateChangedAt||null,remindMinutes:minutes,...extra}));
 try {
  await ctx.pool.query(SCHEMA_SQL);
  let a=await start(await make("Umbrella child",{subtaskOf:"parent-id"})),b=await make("Other task"),c=await make("Third task");
  let view;
  await t.test("inherited reminder keys cannot mutate process prototypes",async()=>{
   for(const taskId of ["__proto__","constructor","toString"]) await assert.rejects(store.mutate(owner,await command("snooze",{taskId,minutes:5})),{statusCode:409});
   assert.equal(Object.prototype.dueAt,undefined);assert.equal(Object.prototype.generation,undefined);assert.equal(Object.prototype.notifiedAt,undefined);
  });
  await t.test("switch saves exactly one effort segment and preserves scheduling/nesting",async()=>{
   const before={date:a.date,parent_id:a.parent_id,subtaskOf:a.properties.subtaskOf,duration:a.properties.duration};
   view=await switchTo(a,b);a=await read(a.id);b=await read(b.id);
   assert.equal(a.properties.startedAt,undefined);assert.equal(a.properties.actualMinutes,10);assert.equal(b.properties.startedAt,new Date(now).toISOString());
   assert.deepEqual({date:a.date,parent_id:a.parent_id,subtaskOf:a.properties.subtaskOf,duration:a.properties.duration},before);
   assert.equal(view.background.length,1);assert.equal(view.background[0].task.id,a.id);assert.equal(view.background[0].dueAt,new Date(now+300000).toISOString());
  });
  await t.test("repeat switches never count background wait as effort",async()=>{
   now+=60000;await switchTo(b,a,null);a=await read(a.id);b=await read(b.id);
   assert.equal(b.properties.actualMinutes,1);assert.equal(a.properties.actualMinutes,10);
   now+=120000;view=await switchTo(a,b,1);a=await read(a.id);b=await read(b.id);
   assert.equal(a.properties.actualMinutes,12);assert.equal(b.properties.actualMinutes,1);
   assert.equal(view.background.length,1);
  });
  await t.test("due reminder claim is durable across reload and concurrent tabs",async()=>{
   now+=60001;const item=view.background[0],body=await command("claim",{taskId:a.id,generation:item.generation});
   const bodies=[body,{...body,operationId:uid()}];
   const results=await Promise.allSettled(bodies.map(b=>store.mutate(owner,b)));
   assert.equal(results.filter(r=>r.status==="fulfilled"&&r.value.claimed).length,1);
   assert.equal(results.filter(r=>r.status==="rejected"&&r.reason.statusCode===409).length,1);
   const fresh=createWorkRotationStore({...ctx,now:()=>now});assert.ok((await fresh.get(owner)).background[0].notifiedAt);
   assert.equal((await store.mutate(owner,bodies[results.findIndex(r=>r.status==="fulfilled")])).claimed,false);
  });
  await t.test("snooze re-arms a new generation and rejects old callbacks",async()=>{
   view=await store.get(owner);const old=view.background[0];
   view=await store.mutate(owner,await command("snooze",{taskId:a.id,generation:old.generation,minutes:5}));
   assert.equal(view.background[0].notifiedAt,null);assert.notEqual(view.background[0].generation,old.generation);
   await assert.rejects(store.mutate(owner,await command("claim",{taskId:a.id,generation:old.generation})),{statusCode:409});
   assert.equal((await store.mutate(owner,await command("claim",{taskId:a.id,generation:view.background[0].generation}))).claimed,false);
  });
  await t.test("two simultaneous switches choose one destination and one ledger segment",async()=>{
   now+=120000;b=await read(b.id);a=await read(a.id);
   const one=await command("switch",{fromId:b.id,fromStartedAt:b.properties.startedAt,toId:a.id,toWorkStateChangedAt:a.properties.workStateChangedAt,remindMinutes:5});
   const two={...one,operationId:uid(),toId:c.id,toWorkStateChangedAt:null};
   const results=await Promise.allSettled([store.mutate(owner,one),store.mutate(owner,two)]);
   assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected").length,1);
   const winner=results.findIndex(r=>r.status==="fulfilled"),winning=[one,two][winner],losing=winner===0?c:a;
   assert.equal((await read(losing.id)).properties.startedAt,undefined);
   const entries=await ctx.blockDB.getTaskTimeEntries(b.id,"ws-1");const count=entries.length;
   assert.equal((await store.mutate(owner,winning)).duplicate,true);
   assert.equal((await ctx.blockDB.getTaskTimeEntries(b.id,"ws-1")).length,count);
   await assert.rejects(store.mutate(owner,{...winning,remindMinutes:30}),{statusCode:409});
   const duplicate=await store.mutate(owner,winning);assert.equal(duplicate.blocks.length,2);assert.ok(duplicate.blocks.find(r=>r.id===winning.toId).properties.startedAt);
   if(winner===1){now+=1000;view=await switchTo(await read(c.id),await read(a.id),null);const item=view.background.find(i=>i.task.id===c.id);await store.mutate(owner,await command("dismiss",{taskId:c.id,generation:item.generation}));}
  });
  await t.test("dismiss removes only the background reminder, not the task",async()=>{
   view=await store.get(owner);const item=view.background.find(i=>i.task.id===b.id);
   view=await store.mutate(owner,await command("dismiss",{taskId:b.id,generation:item.generation}));
   assert.equal(view.background.some(i=>i.task.id===b.id),false);assert.ok(await read(b.id));
  });
  await t.test("completed/deleted backgrounds disappear and late claims cannot revive them",async()=>{
   a=await read(a.id);b=await read(b.id);now+=60000;view=await switchTo(a,b,1);
   const item=view.background[0];await ctx.blockDB.deleteBlock(a.id);
   assert.equal((await store.get(owner)).background.length,0);
   await assert.rejects(store.mutate(owner,await command("claim",{taskId:a.id,generation:item.generation})),{statusCode:409});
   now+=60000;b=await read(b.id);c=await read(c.id);view=await switchTo(b,c,1);
   await ctx.blockDB.setTaskCompletion({taskRef:b.id,completed:true,completedAt:new Date(now).toISOString(),mutationId:uid(),expectedRevision:b.properties._completionRevision||null,userId:1,workspaceId:"ws-1"});
   assert.equal((await store.get(owner)).background.length,0);
  });
  await t.test("foreign tasks and completed targets fail without pausing current effort",async()=>{
   c=await read(c.id);const foreign=await ctx.blockDB.createBlock({id:uid(),type:"block",date:"2099-01-02",user_id:2,workspace_id:"ws-2",properties:{local_id:uid(),title:"Foreign",type:"task"}});
   await assert.rejects(switchTo(c,foreign),{statusCode:409});await assert.rejects(switchTo(c,await read(b.id)),{statusCode:409});
   assert.equal((await read(c.id)).properties.startedAt,c.properties.startedAt);
  });
  await t.test("guided stale preview rolls back source pause; fresh preview preserves snapshot",async()=>{
   const guided=require("./guided-store").createGuidedStore({...ctx,APP_TIME_ZONE:"UTC"});
   const definition=await guided.saveDefinition({id:uid(),expectedRevision:0,definition:{title:"Guided",goal:"Synthetic",starterPrompt:"Review synthetic instructions",checklist:[]}},owner);
   const v=await guided.createTask({id:uid(),definitionId:definition.id,date:"2099-01-02"},owner);
   const task=await read(v.taskId);c=await read(c.id);const before=(await ctx.blockDB.getTaskTimeEntries(c.id,"ws-1")).length;
   await assert.rejects(switchTo(c,task,5,{guided:{revision:0,definitionRevision:999,contextVersion:v.contextVersion}}),{statusCode:409});
   assert.equal((await read(c.id)).properties.startedAt,c.properties.startedAt);assert.equal((await ctx.blockDB.getTaskTimeEntries(c.id,"ws-1")).length,before);
   now=Date.now();const current=await guided.get(task.id,owner);await switchTo(c,task,5,{guided:{revision:current.revision,definitionRevision:current.definitionRevision,contextVersion:current.contextVersion}});
   const run=await guided.get(task.id,owner);assert.equal(run.session.state,"active");assert.equal(run.session.snapshot.starterPrompt,"Review synthetic instructions");
   const d=await make("Back to ordinary");now=Date.now()+1000;await switchTo(await read(task.id),d);
   assert.equal((await guided.get(task.id,owner)).session.state,"paused");
   const segments=await ctx.blockDB.getTaskTimeEntries(task.id,"ws-1");assert.equal(segments.at(-1).properties.endedAt,(await read(d.id)).properties.startedAt);
   await ctx.pool.query("UPDATE blocks SET properties=properties || $2::jsonb WHERE id=$1",[task.id,{doneAt:new Date(now).toISOString()}]);
   assert.equal((await store.get(owner)).background.some(i=>i.task.id===task.id),false);
  });
  await t.test("switch after sleep caps unattended effort at the shared check-in deadline",async()=>{
   const active=(await ctx.pool.query("SELECT * FROM blocks WHERE type='block' AND deleted_at IS NULL AND properties->>'startedAt' IS NOT NULL AND user_id=1")).rows[0];
   const startedAt=Date.parse(active.properties.startedAt),before=active.properties.actualMinutes||0;
   now=startedAt+3*3600000;const target=await make("After sleep");
   await switchTo(active,target,5);
   const saved=await read(active.id),entries=await ctx.blockDB.getTaskTimeEntries(active.id,"ws-1");
   assert.equal(saved.properties.actualMinutes-before,50);
   assert.equal(entries.at(-1).properties.endedAt,new Date(startedAt+50*60000).toISOString());
   assert.equal((await read(target.id)).properties.startedAt,new Date(now).toISOString());
  });

  await t.test("ordinary work endpoint serializes with switching and rolls back failed ledger writes",async()=>{
   const express=require("express"),app=express();app.use(express.json());
   app.use((req,_res,next)=>{req.workspaceId="ws-1";req.session={userId:1};next();});
   let failUpdate=false;
   const routeDb={...ctx.blockDB,updateBlock:async(id,fields,q)=>{
    const result=await ctx.blockDB.updateBlock(id,fields,q);
    if(failUpdate && fields.properties?.workStateOperationId==="rollback-route")throw new Error("synthetic failure after task write");
    return result;
   }};
   require("./routes/blocks")(app,{...ctx,blockDB:routeDb,APP_TIME_ZONE:"UTC",broadcast(){},filterLegacyGcalBlocks:v=>v,getScheduleBlocks:async()=>[],getTodayStr:()=>"2099-01-02",isAllowedSweepBlockItem:()=>true,isValidDate:()=>true});
   const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
   const post=async(id,body)=>{
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/blocks/"+id+"/work",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
   };
   try {
    const source=(await ctx.pool.query("SELECT * FROM blocks WHERE type='block' AND deleted_at IS NULL AND properties->>'startedAt' IS NOT NULL AND user_id=1")).rows[0];
    const target=await make("Concurrent destination");now+=60000;
    const outcomes=await Promise.allSettled([post(source.id,{action:"pause",at:new Date(now).toISOString(),actionId:uid()}),switchTo(source,target)]);
    assert.equal(outcomes[0].status,"fulfilled");assert.equal(outcomes[0].value.status,200);
    assert.equal((await read(source.id)).properties.startedAt,undefined);
    assert.equal((await ctx.blockDB.getTaskTimeEntries(source.id,"ws-1")).length,1);
    if(outcomes[1].status==="rejected"){
     assert.equal(outcomes[1].reason.statusCode,409);assert.equal((await read(target.id)).properties.startedAt,undefined);
     await switchTo(null,await read(target.id));
    }
    const active=await read(target.id),before=await ctx.blockDB.getTaskTimeEntries(target.id,"ws-1");
    now+=60000;failUpdate=true;
    const failed=await post(target.id,{action:"pause",at:new Date(now).toISOString(),actionId:"rollback-route"});
    assert.equal(failed.status,500);
    assert.deepEqual((await read(target.id)).properties,active.properties);
    assert.deepEqual(await ctx.blockDB.getTaskTimeEntries(target.id,"ws-1"),before);
   } finally {await new Promise(resolve=>server.close(resolve));}
  });

 }finally{await ctx.close();}
});
