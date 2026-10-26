const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const M = require("./lib/guided-model");
const owner={userId:1,workspaceId:"ws-1"}, other={userId:2,workspaceId:"ws-2"};
const spec=(extra={})=>M.definition({title:"Synthetic Friday metrics",goal:"Review synthetic metrics",starterPrompt:"Ask which figures are confirmed. Never invent missing figures.",completionCriteria:"User confirms the saved outcome.",context:"Synthetic context only",checklist:["Confirm sources","Review results"],...extra});
const uid=()=>crypto.randomUUID();
function command(view,action,extra={}) {return {action,operationId:uid(),expectedRevision:view.revision,expectedDefinitionRevision:view.definitionRevision,expectedContextVersion:view.contextVersion,...extra};}

test("guided prompt boundaries, validation and prerequisite expiry",()=>{
  const d=spec({references:[{label:"Synthetic source",url:"https://example.com/report"}],includeTaskDetail:true});
  const b={id:"occurrence-1",date:"2099-01-02",updated_at:new Date(),properties:{title:"<script>never execute</script>",guidedDefinitionId:"def-1",detail:"x".repeat(13000)}};
  const prompt=M.brief(d,b,null,{generatedAt:"2099-01-02T12:00:00Z",definitionRevision:2,timeZone:"UTC"});
  assert.match(prompt,/prompt schema 1/);assert.match(prompt,/content not fetched/);assert.match(prompt,/Truncated: first 12000 of 13000/);assert.match(prompt,/ACCESS PREFLIGHT/);assert.match(prompt,/Task ID \/ occurrence ID: occurrence-1/);
  assert.equal(M.accessState({status:"ready",at:"2099-01-02T10:00:00Z"},"2099-01-02T12:00:00Z"),"expired");
  assert.equal(M.accessState({status:"denied",at:"2099-01-02T10:00:00Z"},"2099-01-02T12:00:00Z"),"denied");
  for(const bad of [{starterPrompt:" "},{goal:"a".repeat(2001)},{references:[{label:"x",url:"javascript:alert(1)"}]},{references:[{label:"x",url:"https://user:pass@example.com/"}]},{prerequisites:[{service:"x",resource:"x",action:"x",required:true,readCheck:"shell"}]}]) assert.throws(()=>spec(bad));
});

test("guided real PostgreSQL lifecycle, ownership, rollback and concurrency",{skip:!process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE},async t=>{
  const ctx=await require("./test-support/activity-db").createActivityDb();
  const {createGuidedStore,SCHEMA_SQL}=require("./guided-store");
  const store=createGuidedStore({...ctx,APP_TIME_ZONE:"UTC"});
  try {
    await ctx.pool.query(SCHEMA_SQL); // idempotent bootstrap
    let definition=await store.saveDefinition({id:uid(),expectedRevision:0,definition:spec()},owner);
    const make=async(def=definition)=>store.createTask({id:uid(),definitionId:def.id,date:"2099-01-02"},owner);
    let v=await make();
    await t.test("database API roles cannot read or mutate private guided tables",async()=>{
      const role="guided_untrusted_"+uid().replaceAll("-","");
      const q=await ctx.pool.connect();
      try {
        const schema=(await q.query("SELECT current_schema() AS name")).rows[0].name;
        await q.query(`CREATE ROLE "${role}" NOLOGIN`);
        await q.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        // Even accidental row read/write grants must not bypass the server-only RLS boundary.
        await q.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON guided_definitions,guided_sessions,guided_definition_versions TO "${role}"`);
        await q.query("BEGIN");
        await q.query(`SET LOCAL ROLE "${role}"`);
        for(const table of ["guided_definitions","guided_sessions","guided_definition_versions"]) {
          assert.equal((await q.query(`SELECT * FROM ${table}`)).rows.length,0);
          assert.equal((await q.query(`DELETE FROM ${table} RETURNING *`)).rows.length,0);
        }
        await assert.rejects(q.query("INSERT INTO guided_definitions(id,workspace_id,owner_user_id,definition) VALUES($1,$2,$3,$4)",[uid(),owner.workspaceId,owner.userId,spec()]),{code:"42501"});
        await q.query("ROLLBACK");
        assert.equal((await store.get(v.taskId,owner)).definitionId,definition.id);
        const enabled=await q.query("SELECT relrowsecurity FROM pg_class WHERE oid IN ('guided_definitions'::regclass,'guided_sessions'::regclass,'guided_definition_versions'::regclass)");
        assert.equal(enabled.rows.length,3);assert.ok(enabled.rows.every(r=>r.relrowsecurity));
      } finally {
        await q.query("ROLLBACK");
        await q.query(`DROP OWNED BY "${role}"`);
        await q.query(`DROP ROLE "${role}"`);
        q.release();
      }
    });
    await t.test("create retries, GET and copy content never start work",async()=>{
      const again=await store.createTask({id:v.taskId,definitionId:definition.id,date:"2099-01-02"},owner);
      assert.equal(again.taskId,v.taskId);assert.equal(again.session,null);
      assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM guided_sessions")).rows[0].n,0);
      assert.equal((await ctx.blockDB.getBlock(v.taskId)).properties.startedAt,undefined);
      await assert.rejects(store.get(v.taskId,other),{statusCode:404});
      await assert.rejects(store.get(v.taskId,{userId:3,workspaceId:"ws-1"}),{statusCode:404});
    });
    await t.test("stale definition/context preflight and double starts",async()=>{
      const stale=v;
      definition=await store.saveDefinition({definition:spec({goal:"Updated goal"}),expectedRevision:1},owner,definition.id);
      await assert.rejects(store.act(v.taskId,command(stale,"start"),owner),{statusCode:409});
      v=await store.get(v.taskId,owner); const start=command(v,"start");
      const results=await Promise.all([store.act(v.taskId,start,owner),store.act(v.taskId,start,owner)]);
      assert.equal(results[0].session.id,results[1].session.id);assert.equal(results[0].revision,1);v=results[1];
      assert.ok(v.startedAt);assert.equal(v.session.events.length,1);
      await assert.rejects(store.act(v.taskId,{...start,progress:"different"},owner),{statusCode:409});
      const second=await make(),a=command(second,"start"),b=command(second,"start");
      const race=await Promise.allSettled([store.act(second.taskId,a,owner),store.act(second.taskId,b,owner)]);
      assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(race.find(r=>r.status==="rejected").reason.statusCode,409);
    });
    await t.test("progress conflicts, frozen instructions and occurrence isolation",async()=>{
      const old=v; v=await store.act(v.taskId,command(v,"progress",{progress:"Confirmed revenue only",checked:[0]}),owner);
      await assert.rejects(store.act(v.taskId,command(old,"progress",{progress:"stale"}),owner),{statusCode:409});
      const beforeSnapshot=JSON.stringify(v.session.snapshot);
      definition=await store.saveDefinition({definition:spec({starterPrompt:"New instruction for the next run"}),expectedRevision:2},owner,definition.id);
      const refresh=await store.get(v.taskId,owner);assert.equal(JSON.stringify(refresh.session.snapshot),beforeSnapshot);assert.match(refresh.prompt,/Definition changed since start/);
      const next=await make();assert.equal(next.session,null);assert.match(next.prompt,/New instruction for the next run/);assert.doesNotMatch(next.prompt,/Confirmed revenue only/);
      v=refresh;
    });
    await t.test("pause/resume preserves one session and history",async()=>{
      const id=v.session.id;v=await store.act(v.taskId,command(v,"pause"),owner);assert.equal(v.startedAt,null);assert.equal(v.session.state,"paused");
      const atPause=v;v=await store.act(v.taskId,command(v,"resume"),owner);assert.equal(v.session.id,id);assert.ok(v.startedAt);
      await assert.rejects(store.act(v.taskId,command(atPause,"progress"),owner),{statusCode:409});
    });
    await t.test("failed outer session write rolls canonical completion and time entries back",async()=>{
      const before=await ctx.blockDB.getBlock(v.taskId),beforeEntries=await ctx.blockDB.getTaskTimeEntries(v.taskId,owner.workspaceId,{});
      const action=command(v,"complete",{confirmed:true,outcome:"Synthetic outcome confirmed",progress:"Finished",checked:[0,1]});
      const failingPool={...ctx.pool,query:ctx.pool.query.bind(ctx.pool),connect:async()=>{
        const q=await ctx.pool.connect();return {release:()=>q.release(),query:(sql,args)=>{
          if(String(sql).startsWith("INSERT INTO guided_sessions")) throw new Error("Injected guided-session failure");return q.query(sql,args);
        }};
      }};
      const failing=createGuidedStore({...ctx,pool:failingPool,APP_TIME_ZONE:"UTC"});
      await assert.rejects(failing.act(v.taskId,action,owner),/Injected guided-session failure/);
      assert.deepEqual((await ctx.blockDB.getBlock(v.taskId)).properties,before.properties);
      assert.deepEqual(await ctx.blockDB.getTaskTimeEntries(v.taskId,owner.workspaceId,{}),beforeEntries);
      assert.equal((await store.get(v.taskId,owner)).revision,v.revision);
      v=await store.act(v.taskId,action,owner);assert.equal(v.completed,true);assert.equal(v.session.state,"completed");assert.equal(v.startedAt,null);
      assert.equal((await store.act(v.taskId,action,owner)).revision,v.revision);
      await assert.rejects(store.act(v.taskId,command(v,"resume"),owner),{statusCode:409});
    });
    await t.test("explicit reopen keeps the session and original completion history",async()=>{
      const id=v.session.id,initial=v.session.initialPrompt;
      await assert.rejects(ctx.blockDB.setTaskCompletion({taskRef:v.taskId,completed:false,mutationId:uid(),expectedRevision:(await ctx.blockDB.getBlock(v.taskId)).properties._completionRevision,userId:1,workspaceId:"ws-1"}),{publicCode:"GUIDED_REOPEN_REQUIRED"});
      v=await store.act(v.taskId,command(v,"reopen"),owner);assert.equal(v.completed,false);assert.equal(v.session.id,id);assert.equal(v.session.state,"paused");assert.deepEqual(v.session.initialPrompt,initial);
      assert.ok(v.session.events.some(e=>e.action==="complete" && e.outcome==="Synthetic outcome confirmed"));
      v=await store.act(v.taskId,command(v,"resume"),owner);
      v=await store.act(v.taskId,command(v,"complete",{confirmed:true,outcome:"Corrected confirmed outcome"}),owner);assert.equal(v.session.id,id);
    });
    await t.test("reviewed learning, stale proposals, immutable snapshots and rollback",async()=>{
      const used=v.session.snapshot,proposed=spec({goal:"Refined source-first goal"});
      v=await store.act(v.taskId,command(v,"feedback",{feedback:{worked:"Revenue source",failed:"Other inputs missing",blockers:"Synthetic access denied",corrections:"Do not guess",proposedChanges:"Check access first",proposedDefinition:proposed,baseDefinitionRevision:definition.revision}}),owner);
      assert.equal((await store.list(owner)).definitions.find(d=>d.id===definition.id).revision,definition.revision);
      const applied=await store.applyFeedback(v.taskId,{expectedRevision:definition.revision,expectedSessionRevision:v.revision},owner);assert.equal(applied.revision,definition.revision+1);
      assert.deepEqual((await store.get(v.taskId,owner)).session.snapshot,used);
      assert.match((await store.get(v.taskId,owner)).prompt,/Synthetic access denied/);
      const rolled=await store.rollback(definition.id,{expectedRevision:applied.revision,targetRevision:1},owner);assert.equal(rolled.revision,applied.revision+1);
      const versions=await store.versions(definition.id,owner);assert.equal(versions[0].provenance.source,"rollback");
      await assert.rejects(store.applyFeedback(v.taskId,{expectedRevision:applied.revision,expectedSessionRevision:v.revision-1},owner),{statusCode:409});
      definition=rolled;
    });
    await t.test("required access, denial, expiry and optional dependencies stay distinct",async()=>{
      const def=await store.saveDefinition({id:uid(),expectedRevision:0,definition:spec({prerequisites:[{service:"Synthetic report",account:"Demo",resource:"demo report",action:"read",reason:"needed input",required:true,readCheck:"none",remedy:"Ask owner"},{service:"Optional report",resource:"optional demo",action:"read",required:false,readCheck:"none"}]})},owner);
      let task=await make(def);task=await store.act(task.taskId,command(task,"start"),owner);
      await assert.rejects(store.act(task.taskId,command(task,"complete",{confirmed:true,outcome:"not yet"}),owner),{statusCode:409});
      task=await store.act(task.taskId,command(task,"preflight",{prerequisiteIndex:0,status:"denied",note:"Do not retry"}),owner);
      assert.match(task.prompt,/last reported state: denied/);
      task=await store.act(task.taskId,command(task,"progress",{progress:"Blocked pending access"}),owner);assert.equal(task.completed,false);
      task=await store.act(task.taskId,command(task,"preflight",{prerequisiteIndex:0,status:"ready",note:"New explicit authorization and successful read confirmed"}),owner);
      task=await store.act(task.taskId,command(task,"complete",{confirmed:true,outcome:"User confirmed synthetic result"}),owner);assert.equal(task.completed,true);
    });
    await t.test("history cap still permits terminal completion with fresh explicit evidence",async()=>{
      const def=await store.saveDefinition({id:uid(),expectedRevision:0,definition:spec({prerequisites:[{service:"Synthetic",resource:"demo",action:"read",required:true,readCheck:"none"}]})},owner);
      let task=await make(def);task=await store.act(task.taskId,command(task,"start"),owner);
      const session=structuredClone(task.session);session.events=Array.from({length:500},(_,i)=>({operationId:"synthetic-"+i,hash:"synthetic",action:"progress",at:"2000-01-01T00:00:00Z"}));
      session.access={0:{status:"ready",at:"2000-01-01T00:00:00Z"}};
      await ctx.pool.query("UPDATE guided_sessions SET session=$2 WHERE task_id=$1",[task.taskId,session]);
      task=await store.get(task.taskId,owner);
      await assert.rejects(store.act(task.taskId,command(task,"complete",{confirmed:true,outcome:"Blocked without fresh evidence"}),owner),{statusCode:409});
      task=await store.act(task.taskId,command(task,"pause"),owner);const revision=task.revision;
      task=await store.act(task.taskId,command(task,"pause"),owner);assert.equal(task.revision,revision);
      task=await store.act(task.taskId,command(task,"complete",{confirmed:true,outcome:"Synthetic result confirmed",observations:[{index:0,status:"ready",note:"A new permitted read was just confirmed"}]}),owner);
      assert.equal(task.completed,true);assert.equal(task.session.events.at(-1).observations[0].status,"ready");
    });
    await t.test("guided privacy survives generic edits and direct checkbox completion is rejected",async()=>{
      const task=await make();const row=await ctx.blockDB.getBlock(task.taskId);
      await ctx.blockDB.updateBlock(row.id,{properties:{...row.properties,type:"task",publicVisibility:"public"}});
      const stored=await ctx.blockDB.getBlock(row.id);assert.equal(stored.properties.type,"guided");assert.equal(stored.properties.publicVisibility,"private");
      await assert.rejects(ctx.blockDB.setTaskCompletion({taskRef:row.id,completed:true,mutationId:uid(),userId:1,workspaceId:"ws-1"}),{publicCode:"GUIDED_OUTCOME_REQUIRED"});
    });
    await t.test("recurring series preserves flat and nested playbooks with isolated sessions",async()=>{
      const createResponsibilityStore=require("./responsibility-store");
      const repeats=createResponsibilityStore({blockDB:ctx.blockDB,getTodayStr:()=>"2099-01-02",assertBlockOwnership(){},appTimeZone:"UTC"});
      const rule={version:1,patternType:"calendar",timeZone:"UTC",startDate:"2099-01-02",frequency:"daily",interval:1,times:["09:00"],end:{type:"never"}};
      const series=await repeats.upsertResponsibility({userId:1,workspaceId:"ws-1",properties:{title:"Synthetic recurring guided",guidedDefinitionId:definition.id,repeatType:"scheduled",scheduleRule:rule,estimatedMinutes:30}});
      assert.equal(series.properties.guidedDefinitionId,definition.id);
      const first=await repeats.materializeScheduledRepeatsForDate({date:"2099-01-02",userId:1,workspaceId:"ws-1",strict:true});
      const one=first.find(b=>b.properties.guidedDefinitionId===definition.id);assert.ok(one);assert.equal(one.properties.type,"guided");
      assert.equal((await repeats.materializeScheduledRepeatsForDate({date:"2099-01-02",userId:1,workspaceId:"ws-1",strict:true})).length,0);
      let run=await store.get(one.id,owner);run=await store.act(one.id,command(run,"start"),owner);
      const second=await repeats.materializeScheduledRepeatsForDate({date:"2099-01-03",userId:1,workspaceId:"ws-1",strict:true});const two=second.find(b=>b.properties.guidedDefinitionId===definition.id);
      assert.notEqual(one.id,two.id);assert.equal((await store.get(two.id,owner)).session,null);
      const normalized=createResponsibilityStore.normalizeTemplateTree({root:{title:"Parent",children:[{title:"Guided child",type:"guided",guidedDefinitionId:definition.id,durationMin:20,edge:"wrap"}]}});
      assert.equal(normalized.root.children[0].guidedDefinitionId,definition.id);
      await repeats.upsertResponsibility({userId:1,workspaceId:"ws-1",properties:{title:"Synthetic nested guided",repeatType:"scheduled",scheduleRule:rule,estimatedMinutes:20,templateTree:normalized}});
      const nested=await repeats.materializeScheduledRepeatsForDate({date:"2099-01-02",userId:1,workspaceId:"ws-1",strict:true});
      const child=nested.find(b=>b.properties.title==="Guided child");assert.equal(child.properties.guidedDefinitionId,definition.id);assert.equal(child.properties.type,"guided");
      const flat=createResponsibilityStore.buildResponsibilityTaskProps(series,{duration:30,slot:540,localId:"flat-guided"});assert.equal(flat.guidedDefinitionId,definition.id);assert.equal(flat.type,"guided");
    });
    await t.test("immutable briefing survives later context edits and stale source prevents start",async()=>{
      let task=await make();const stale=task;const row=await ctx.blockDB.getBlock(task.taskId);
      await ctx.blockDB.updateBlock(task.taskId,{properties:{...row.properties,title:"New synthetic context"}});
      await assert.rejects(store.act(task.taskId,command(stale,"start"),owner),{statusCode:409});
      task=await store.get(task.taskId,owner);task=await store.act(task.taskId,command(task,"start"),owner);const initial=task.session.initialPrompt;
      const live=await ctx.blockDB.getBlock(task.taskId);await ctx.blockDB.updateBlock(task.taskId,{properties:{...live.properties,title:"Later context"}});
      const after=await store.get(task.taskId,owner);assert.deepEqual(after.session.initialPrompt,initial);assert.match(after.prompt,/Later context/);assert.doesNotMatch(initial.text,/Later context/);
    });
    await t.test("HTTP owner, session and account-switch boundaries",async()=>{
      const express=require("express"),app=express();app.use(express.json());
      app.use((req,_res,next)=>{const id=Number(req.headers["x-test-user"]||1);req.session=id?{userId:id}:{};req.workspaceId=id===2?"ws-2":"ws-1";next();});
      app.use(require("./lib/account-binding"));require("./routes/guided")(app,{...ctx,broadcast(){}});
      const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
      const url=`http://127.0.0.1:${server.address().port}/api/guided`;
      try {
        for(const [user,headers,expected] of [[0,{},401],[3,{"X-DCC-User":"3","X-DCC-Workspace":"ws-1"},403],[2,{"X-DCC-User":"1","X-DCC-Workspace":"ws-1"},409]]){
          const response=await fetch(url,{headers:{"x-test-user":String(user),...headers}});assert.equal(response.status,expected);
        }
        const response=await fetch(url+"/tasks/"+v.taskId,{headers:{"X-DCC-User":"1","X-DCC-Workspace":"ws-1"}});assert.equal(response.status,200);assert.match(response.headers.get("cache-control"),/no-store/);assert.equal((await response.json()).taskId,v.taskId);
      } finally {await new Promise(resolve=>server.close(resolve));}
    });
  } finally {await ctx.close();}
});
