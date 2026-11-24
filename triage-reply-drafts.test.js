const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { validate } = require("./triage-reply-drafts");
const source = "https://cleverrealestate.slack.com/archives/C123TEST/p1795453462467919";
const draft = () => ({task_id:"task-fixture",triage_id:"slack:mention:C123TEST:1795453462.467919",source_ref:source,draft_preview:"Can we compare the three cases?\nUnsent <b>literal</b> & researched."});

test("reply draft validation bounds plaintext, exact source URLs, excluded channels and batch identity", () => {
  assert.equal(validate({reply_drafts:[draft()]})[0].draft_preview,draft().draft_preview);
  assert.equal(validate({reply_drafts:[{...draft(),draft_preview:"x".repeat(1000)}]}).length,1);
  for(const change of [{draft_preview:"x".repeat(1001)},{draft_preview:{html:"x"}},{draft_preview:"\u0000"},
    {source_ref:"javascript:alert(1)"},{source_ref:source.replace("7919","7920")},{source_ref:"https://cleverrealestate.slack.com/archives/C0A2YDUD4N5/p1795453462467919"},
    {source_ref:"https://cleverrealestate.slack.com/archives/C08KRSS69MH/p1795453462467919"},{extra:"not permitted"}]) {
    assert.throws(()=>validate({reply_drafts:[{...draft(),...change}]}),e=>e.statusCode===400);
  }
  for(const value of [[],[draft(),draft()],Array(11).fill(draft()),null]) assert.throws(()=>validate({reply_drafts:value}));
  assert.throws(()=>validate({items:[],reply_drafts:[draft()]}));
});

function viewContext(task) {
  const code=fs.readFileSync(require.resolve("./public/js/triage.js"),"utf8");
  const esc=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
  const copied=[];
  const DCC={esc,safeUrlAttr:url=>url&&url.startsWith("https://")?esc(url):""};
  const ctx=vm.createContext({window:{DCC},DCC,INIT_TRIAGE:[{id:task.triageId,title:"stale raw source"}],scheduled:[task],
    navigator:{clipboard:{writeText:async text=>copied.push(text)}},waitingItemLinkHtml:()=>""});
  vm.runInContext(code.slice(code.indexOf("function triageDraftAction("),code.indexOf("async function activateTriageDraftAction(")),ctx);
  vm.runInContext(code.slice(code.indexOf("function triageTaskSourceItem("),code.indexOf("function wireTriageTaskSourceActions(")),ctx);
  return {ctx,copied};
}

test("real Triage controls copy the stored draft over a stale raw item, without HTML insertion or sending",async()=>{
  const text="</textarea><img src=x onerror=alert(1)> & \"quoted\"";
  const task={triageId:"source-1",triageContext:{id:"source-1",source_ref:source,link:source,draft_preview:text}};
  const {ctx,copied}=viewContext(task);
  const html=ctx.triageTaskSourceActionsHtml(task);
  assert.match(html,/Review and Send/);
  assert.ok(!html.includes(text));assert.ok(!html.includes("<img"));
  assert.equal(await ctx.copyTriageDraft("source-1"),true);assert.deepEqual(copied,[text]);
});

test("authenticated intake, real Postgres store and existing block readback preserve placement, edits and exact replay",async t=>{
  if(!process.env.DCC_TEST_DATABASE_URL)return t.skip("DCC_TEST_DATABASE_URL not set");
  const {Pool}=require("pg"),express=require("express"),session=require("express-session"),http=require("node:http");
  const connectionString=process.env.DCC_TEST_DATABASE_URL;
  assert.match(connectionString,/(localhost|127\.0\.0\.1|host=\/tmp)/,"Disposable test must use local Postgres");
  const admin=new Pool({connectionString});
  const schema="reply_draft_test_"+process.pid+"_"+Date.now();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
  let server;
  try {
    await pool.query(`CREATE TABLE blocks(id text PRIMARY KEY,type text,date text,parent_id text,user_id integer,workspace_id text,properties jsonb,deleted_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
    const props={sweepTriage:{origin:"automated_sweep",disposition:"pending",runId:"synthetic"},kind:"task",type:"task",title:"Owner's edited title",detail:"Owner notes",priority:"High",status:"open",triageBlock:true,publicVisibility:"private",triageId:draft().triage_id,triageSourceRef:source,triageContext:{id:draft().triage_id,source_ref:source,link:source,summary:"Owner context"}};
    await pool.query("INSERT INTO blocks(id,type,user_id,workspace_id,properties) VALUES('task-fixture','block',7,'ws-owned',$1),('foreign','block',9,'ws-other',$1),('same-workspace-foreign','block',9,'ws-owned',$1)",[props]);
    const poolPath=require.resolve("./pg-pool");
    require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:pool};
    const db=require("./db"),{resolveOwnerStrict}=require("./middleware/resolve-owner");
    const app=express(),events=[];app.use(express.json());
    app.use(session({secret:"disposable-fixture-secret-only",resave:false,saveUninitialized:false}));
    app.post("/__fixture/login",(req,res)=>{req.session.userId=7;req.session.workspace="ws-owned";res.json({ok:true});});
    app.use((req,res,next)=>{if(!req.session.userId)return res.status(401).json({error:"Not authenticated"});req.workspaceId=req.session.workspace;next();});
    const context={pool,blockDB:db,resolveOwnerStrict,broadcast:(...args)=>events.push(args),crypto:require("node:crypto"),getTodayStr:()=>"2026-11-23",isValidDate:()=>true};
    require("./routes/dcc")(app,context);require("./routes/blocks")(app,context);
    server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const login=await fetch(base+"/__fixture/login",{method:"POST"});const cookie=login.headers.get("set-cookie").split(";")[0];
    async function request(path,body,authenticated=true){const response=await fetch(base+path,{method:body?"POST":"GET",headers:{...(authenticated?{cookie}:{}),"content-type":"application/json","x-user-id":"9","x-workspace-id":"ws-other"},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};}
    const post=body=>request("/api/dcc/triage-check/ingest",body);
    const body={packet:{reply_drafts:[draft()]}};
    assert.equal((await request("/api/dcc/triage-check/ingest",body,false)).status,401);
    assert.equal((await request("/api/blocks/task-fixture",null,false)).status,401);
    const before=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows;
    const preview=await post({...body,dry_run:true});assert.equal(preview.status,200);assert.equal(preview.body.status,"dry_run");
    assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,before);assert.equal(events.length,0);
    await pool.query("UPDATE blocks SET properties=jsonb_set(properties,'{title}','\"Owner changed after preflight\"') WHERE id='task-fixture'");
    const result=await post(body);assert.equal(result.status,200);assert.equal(result.body.status,"merged");assert.deepEqual(result.body.owner,{userId:7,workspaceId:"ws-owned"});assert.equal(events.length,1);
    const read=await request("/api/blocks/task-fixture");assert.equal(read.status,200);
    const row=read.body;assert.equal(row.date,null);assert.equal(row.properties.triageBlock,true);assert.equal(row.properties.publicVisibility,"private");
    assert.equal(row.properties.title,"Owner changed after preflight");assert.equal(row.properties.detail,props.detail);assert.equal(row.properties.triageContext.summary,"Owner context");
    assert.equal(row.properties.triageContext.draft_preview,draft().draft_preview);
    const task=require("./public/js/task-model").fromBlock(row),view=viewContext(task);
    const groups=require("./public/js/time-blocks").groupItineraryTree([{ev:task,depth:0}],[]);
    assert.equal(groups.find(group=>group.block.id==="triage").nodes.length,1);
    // The canonical model makes date-free rows untimed even with a legacy clock.
    // A clock string alone must not invent another lane policy in this writer.
    const legacyTask=require("./public/js/task-model").fromBlock({...row,properties:{...row.properties,start:"09:00",untimed:false}});
    assert.equal(require("./public/js/time-blocks").groupItineraryTree([{ev:legacyTask,depth:0}],[]).find(group=>group.block.id==="triage").nodes.length,1);
    assert.match(view.ctx.triageTaskSourceActionsHtml(task),/Review and Send/);await view.ctx.copyTriageDraft(task.triageId);assert.deepEqual(view.copied,[draft().draft_preview]);
    const stored=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows;
    const replay=await post(body);assert.equal(replay.body.status,"duplicate");assert.equal(events.length,1);assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,stored);
    assert.equal((await post({packet:{reply_drafts:[{...draft(),task_id:"foreign"}]}})).status,404);
    assert.equal((await request("/api/blocks/foreign")).status,404);
    assert.equal((await post({packet:{reply_drafts:[{...draft(),task_id:"same-workspace-foreign"}]}})).status,404);
    assert.equal((await post({packet:{reply_drafts:[{...draft(),triage_id:"wrong-source-wrapper"}]}})).status,409);
    assert.equal((await post({packet:{reply_drafts:[{...draft(),source_ref:source.replace("7919","7920")}]}})).status,400);
    assert.equal((await post({packet:{reply_drafts:[{...draft(),draft_preview:"Overwrite owner"}]}})).status,409);
    for(const patch of [{sweepTriage:null},{sweepTriage:{origin:"automated_sweep",disposition:"dismissed"}},{sweepTriage:{origin:"automated_sweep",disposition:"promoted"}},{status:"archived"},{status:"done"},{triageBlock:false},{publicVisibility:"public"},{responsibilityId:"recurring"},{delegatedItemId:"waiting"},{kind:"backlog"}]) {
      await pool.query("UPDATE blocks SET properties=properties || $1::jsonb WHERE id='task-fixture'",[JSON.stringify(patch)]);
      assert.equal((await post(body)).status,409,JSON.stringify(patch));
      await pool.query("UPDATE blocks SET properties=$1 WHERE id='task-fixture'",[row.properties]);
    }
    const parentProps={kind:"task",type:"task",title:"Owner moved this under Unplanned",status:"open",publicVisibility:"private"};
    await pool.query("INSERT INTO blocks(id,type,user_id,workspace_id,properties) VALUES('unplanned-parent','block',7,'ws-owned',$1)",[parentProps]);
    const childProps={...row.properties,subtaskOf:"unplanned-parent"};
    await pool.query("UPDATE blocks SET parent_id='unplanned-parent',properties=$1 WHERE id='task-fixture'",[childProps]);
    const hierarchy=(await pool.query("SELECT * FROM blocks WHERE id IN ('unplanned-parent','task-fixture')")).rows;
    const TM=require("./public/js/task-model"),TB=require("./public/js/time-blocks");
    const realGroups=TB.groupItineraryTree(TM.selectTree(hierarchy.map(block=>TM.fromBlock(block))),[]);
    assert.ok(realGroups.find(group=>group.block.id==="unplanned").nodes.some(node=>node.ev._blockId==="task-fixture"));
    assert.equal(realGroups.find(group=>group.block.id==="triage").nodes.length,0);
    const hierarchyBefore=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows;
    assert.equal((await post({...body,dry_run:true})).status,409,"Nested source is no longer a standalone Triage task");
    assert.equal((await post(body)).status,409);
    assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,hierarchyBefore);assert.equal(events.length,1);
    await pool.query("UPDATE blocks SET parent_id=NULL,properties=$1 WHERE id='task-fixture'",[row.properties]);
    await pool.query("UPDATE blocks SET deleted_at=now() WHERE id='task-fixture'");assert.equal((await post(body)).status,404);
    await pool.query("UPDATE blocks SET deleted_at=NULL,date='2026-11-23' WHERE id='task-fixture'");assert.equal((await post(body)).status,409);
    assert.equal(events.length,1);
    await pool.query("INSERT INTO blocks(id,type,user_id,workspace_id,properties) VALUES('own-next','block',7,'ws-owned',$1),('race','block',7,'ws-owned',$1)",[props]);
    const snapshot=(await pool.query("SELECT * FROM blocks WHERE id='own-next'")).rows[0];
    const mixed=await post({packet:{reply_drafts:[{...draft(),task_id:"own-next"},{...draft(),task_id:"foreign"}]}});
    assert.equal(mixed.status,404);assert.deepEqual((await pool.query("SELECT * FROM blocks WHERE id='own-next'")).rows[0],snapshot);
    await pool.query("UPDATE blocks SET properties=jsonb_set(properties,'{triageContext,draft_id}','\"native-unsent\"') WHERE id='own-next'");
    assert.equal((await post({packet:{reply_drafts:[{...draft(),task_id:"own-next"}]}})).status,409);
    assert.equal((await pool.query("SELECT properties#>>'{triageContext,draft_id}' AS id FROM blocks WHERE id='own-next'")).rows[0].id,"native-unsent");
    await pool.query("INSERT INTO blocks(id,type,user_id,workspace_id,properties) VALUES('sql-good','block',7,'ws-owned',$1),('sql-fail','block',7,'ws-owned',$1)",[props]);
    await pool.query("ALTER TABLE blocks ADD CONSTRAINT disposable_draft_reject CHECK(id <> 'sql-fail' OR NOT(properties->'triageContext' ? 'draft_preview'))");
    const sqlBefore=(await pool.query("SELECT * FROM blocks WHERE id IN ('sql-good','sql-fail') ORDER BY id")).rows;
    const failed=await post({packet:{reply_drafts:[{...draft(),task_id:"sql-good"},{...draft(),task_id:"sql-fail"}]}});
    assert.equal(failed.status,500);assert.deepEqual((await pool.query("SELECT * FROM blocks WHERE id IN ('sql-good','sql-fail') ORDER BY id")).rows,sqlBefore);
    const raceBody={packet:{reply_drafts:[{...draft(),task_id:"race"}]}};
    const concurrent=await Promise.all([post(raceBody),post(raceBody)]);
    assert.deepEqual(concurrent.map(r=>r.body.status).sort(),["duplicate","merged"]);assert.equal(events.length,2);
    const raceStored=(await pool.query("SELECT * FROM blocks WHERE id='race'")).rows[0];
    await pool.query("UPDATE blocks SET properties=jsonb_set(properties,'{triageContext,draft_preview}','\"Owner edited reply\"') WHERE id='race'");
    assert.equal((await post(raceBody)).status,409);
    const edited=(await pool.query("SELECT * FROM blocks WHERE id='race'")).rows[0];assert.equal(edited.properties.triageContext.draft_preview,"Owner edited reply");assert.equal(edited.properties.title,raceStored.properties.title);assert.equal(events.length,2);
    t.diagnostic("Real POST + cookie-auth GET + TaskModel/Triage copy controls; disposable local schema; no external sends");
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
