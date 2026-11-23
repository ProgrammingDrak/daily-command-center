const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs");
const {validate}=require("./triage-reply-findings");
const SOURCE="slack:mention:C123TEST:1795453462.467919";
const REF="https://cleverrealestate.slack.com/archives/C123TEST/p1795453462467919";
const finding=(extra={})=>({thread_id:extra.source_id&&extra.source_id.startsWith("gmail:")?extra.source_id.split(":")[1]:"1793798147.890389",source_id:SOURCE,source_ref:REF,title:"Review synthetic source context",reason:"Synthetic local evidence reviewed; no external claim.",draft_preview:"Can we compare these cases?\nUnsent <b>literal</b> & researched.",received_at:"2026-11-23T17:04:22Z",reviewed_at:new Date().toISOString(),sensitivity:"ordinary_business",...extra});
test("new findings require bounded, fresh, native source-backed business evidence",()=>{
 assert.equal(validate({reply_findings:[finding()]})[0].draft_preview,finding().draft_preview);
 for(const extra of [{source_id:"calendar:excluded"},{source_id:"calendar:abc123",thread_id:"abc123",source_ref:"https://mail.google.com/mail/u/0/#all/abc123"},{thread_id:"1795453463.999999"},{reviewed_at:"2020-01-01T00:00:00Z"},{sensitivity:"private_personal"},{title:"x".repeat(201)},{reason:"x".repeat(1001)},{draft_preview:"x".repeat(1001)},{source_ref:REF.replace("7919","7920")},{extra:"unsupported"}])assert.throws(()=>validate({reply_findings:[finding(extra)]}),e=>e.statusCode===400);
 assert.throws(()=>validate({reply_findings:[finding(),finding()]}));
 assert.throws(()=>validate({reply_findings:[finding()],reply_drafts:[]}));
});
test("public handler atomically creates a private Triage task with its researched draft; rollback/replay/edits survive actual store and readback",async t=>{
 if(!process.env.DCC_TEST_DATABASE_URL)return t.skip("DCC_TEST_DATABASE_URL not set");
 const {Pool}=require("pg"),express=require("express"),session=require("express-session"),http=require("node:http");
 const connectionString=process.env.DCC_TEST_DATABASE_URL;assert.match(connectionString,/(localhost|127\.0\.0\.1|host=\/tmp)/);
 const admin=new Pool({connectionString}),schema="finding_draft_test_"+process.pid+"_"+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`});let server;
 try{
  await pool.query(`CREATE TABLE blocks(id text PRIMARY KEY,type text,parent_id text,date date,properties jsonb,sort_order double precision DEFAULT 0,user_id integer,workspace_id text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
   CREATE TABLE operations(id serial PRIMARY KEY,block_id text,op_type text,before_data jsonb,after_data jsonb,timestamp timestamptz,batch_id text);
   CREATE UNIQUE INDEX idx_blocks_idem_unique ON blocks(workspace_id,(properties->>'idempotency_key')) WHERE deleted_at IS NULL AND properties->>'idempotency_key' IS NOT NULL;`);
  const schemaCode=fs.readFileSync(require.resolve("./pg-schema"),"utf8");
  const fn=schemaCode.match(/CREATE OR REPLACE FUNCTION dcc_is_task_row[\s\S]*?\$fn\$;/);assert.ok(fn);await pool.query(fn[0]);
  const poolPath=require.resolve("./pg-pool");require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:pool};
  const db=require("./db"),{resolveOwnerStrict}=require("./middleware/resolve-owner");const app=express(),events=[];
  app.use(express.json());app.use(session({secret:"disposable-finding-fixture-only",resave:false,saveUninitialized:false}));
  app.post("/__fixture/login",(req,res)=>{req.session.userId=7;req.session.workspace="ws-owned";res.json({ok:true});});
  app.use((req,res,next)=>{if(!req.session.userId)return res.status(401).json({error:"Not authenticated"});req.workspaceId=req.session.workspace;next();});
  const ctx={pool,blockDB:db,resolveOwnerStrict,broadcast:(...args)=>events.push(args),crypto:require("node:crypto"),getTodayStr:()=>"2026-11-23",isValidDate:()=>true,
   // Tripwires: the new intake must never call any outward source synchronization.
   syncSlackTaskReactions:()=>{throw Error("Unexpected external Slack action");},materializeScrapedSlackItems:()=>{throw Error("Unexpected legacy outward path");}};
  require("./routes/dcc")(app,ctx);require("./routes/blocks")(app,ctx);
  server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+"/__fixture/login",{method:"POST"}),cookie=login.headers.get("set-cookie").split(";")[0];
  const request=async(path,body,authed=true)=>{const r=await fetch(base+path,{method:body?"POST":"GET",headers:{...(authed?{cookie}:{}),"content-type":"application/json","x-user-id":"99","x-workspace-id":"ws-foreign"},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
  const post=body=>request("/api/dcc/triage-check/ingest",body);const body={packet:{reply_findings:[finding()]}};
  assert.equal((await request("/api/dcc/triage-check/ingest",body,false)).status,401);
  const preview=await post({...body,dry_run:true});assert.equal(preview.status,200);assert.equal(preview.body.status,"dry_run");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM blocks")).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM operations")).rows[0].n,0);assert.equal(events.length,0);
  const published=await post(body);assert.equal(published.status,200);assert.equal(published.body.status,"merged");assert.deepEqual(published.body.owner,{userId:7,workspaceId:"ws-owned"});assert.deepEqual(published.body.source_ids,[SOURCE]);assert.equal(published.body.task_ids.length,1);
  const id=published.body.task_ids[0];assert.ok(id);const read=await request("/api/blocks/"+id);assert.equal(read.status,200);const row=read.body;
  assert.equal(row.workspace_id,"ws-owned");assert.equal(row.user_id,7);assert.equal(row.date,null);assert.equal(row.properties.publicVisibility,"private");assert.equal(row.properties.triageBlock,true);assert.equal(row.properties.status,"open");
  assert.equal(row.properties.triageId,SOURCE);assert.equal(row.properties.slack_thread_ts,body.packet.reply_findings[0].thread_id);assert.equal(row.properties.triageContext.thread_id,body.packet.reply_findings[0].thread_id);assert.equal(row.properties.triageSourceRef,REF);assert.equal(row.properties.triageContext.draft_preview,body.packet.reply_findings[0].draft_preview);
  const model=require("./public/js/task-model").fromBlock(row),groups=require("./public/js/time-blocks").groupItineraryTree([{ev:model,depth:0}],[]);
  assert.equal(groups.find(group=>group.block.id==="triage").nodes.length,1);assert.equal(groups.find(group=>group.block.id==="unplanned").nodes.length,0);
  const saved=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows,ops=(await pool.query("SELECT * FROM operations ORDER BY id")).rows;
  const retry=await post(body);assert.equal(retry.body.status,"duplicate");assert.deepEqual(retry.body.task_ids,[id]);assert.equal(events.length,1);
  assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,saved);assert.deepEqual((await pool.query("SELECT * FROM operations ORDER BY id")).rows,ops);
  await pool.query("UPDATE blocks SET properties=jsonb_set(properties,'{title}','\"Owner renamed after capture\"') WHERE id=$1",[id]);
  const renamed=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows;
  assert.equal((await post({packet:{reply_findings:[finding({title:"Automation stale title"})]}})).body.status,"duplicate");assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,renamed);
  assert.equal((await post({packet:{reply_findings:[finding({draft_preview:"Overwrite owner draft"})]}})).status,409);
  const different=finding({source_id:"gmail:abc123:abc456",source_ref:"https://mail.google.com/mail/u/0/#all/abc123"});
  const raceBody={packet:{reply_findings:[different]}};const race=await Promise.all([post(raceBody),post(raceBody)]);
  assert.deepEqual(race.map(r=>r.body.status).sort(),["duplicate","merged"]);assert.equal(new Set(race.map(r=>r.body.task_ids[0])).size,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM blocks")).rows[0].n,2);assert.equal(events.length,2);
  await pool.query("UPDATE blocks SET deleted_at=now() WHERE id=$1",[id]);assert.equal((await post(body)).status,404);assert.equal((await pool.query("SELECT count(*)::int AS n FROM blocks")).rows[0].n,2);
  const suppression=require("./triage-suppressions").buildSuppressionProperties({triageId:"gmail:ccc111:ddd222",reason:"deleted",itemSnapshot:{id:"gmail:ccc111:ddd222",type:"email"}});
  await pool.query("INSERT INTO blocks(id,type,workspace_id,user_id,properties) VALUES('handled-source','block','ws-owned',7,$1)",[suppression]);
  const handled=finding({source_id:"gmail:ccc111:ddd222",source_ref:"https://mail.google.com/mail/u/0/#all/ccc111"});
  const cutoff=require("./triage-suppressions").buildSuppressionProperties({triageId:"gmail:cccaaa",reason:"done",at:new Date().toISOString()});
  await pool.query("INSERT INTO blocks(id,type,workspace_id,user_id,properties) VALUES('legacy-cutoff','block','ws-owned',7,$1)",[cutoff]);
  assert.equal((await post({packet:{reply_findings:[finding({source_id:"gmail:cccaaa:111bbb",source_ref:"https://mail.google.com/mail/u/0/#all/cccaaa"})]}})).status,409);
  const foreignProps={...row.properties,triageId:"gmail:bbb111:bbb222",source_id:"https://mail.google.com/mail/u/0/#all/bbb111",triageSourceRef:"https://mail.google.com/mail/u/0/#all/bbb111",triageContext:{id:"gmail:bbb111:bbb222",source_ref:"https://mail.google.com/mail/u/0/#all/bbb111"}};
  await pool.query("INSERT INTO blocks(id,type,workspace_id,user_id,properties) VALUES('another-owner','block','ws-owned',99,$1)",[foreignProps]);
  assert.equal((await post({packet:{reply_findings:[finding({source_id:"gmail:bbb111:bbb222",source_ref:"https://mail.google.com/mail/u/0/#all/bbb111"})]}})).status,404);
  const beforeAtomic=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows;
  const atomicFailure=await post({packet:{reply_findings:[finding({source_id:"gmail:eee111:fff222",source_ref:"https://mail.google.com/mail/u/0/#all/eee111"}),handled]}});
  assert.equal(atomicFailure.status,409);assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,beforeAtomic);
  // Force the second actual INSERT to fail, after the first task+draft was written.
  await pool.query("ALTER TABLE blocks ADD CONSTRAINT reject_fixture_finding CHECK(properties->>'triageId' IS DISTINCT FROM 'gmail:bad111:bad222')");
  const sqlBefore=(await pool.query("SELECT * FROM blocks ORDER BY id")).rows,opsBefore=(await pool.query("SELECT * FROM operations ORDER BY id")).rows;
  const sqlFail=await post({packet:{reply_findings:[finding({source_id:"gmail:aaa111:aaa222",source_ref:"https://mail.google.com/mail/u/0/#all/aaa111"}),finding({source_id:"gmail:bad111:bad222",source_ref:"https://mail.google.com/mail/u/0/#all/bad111"})]}});
  assert.equal(sqlFail.status,500);assert.deepEqual((await pool.query("SELECT * FROM blocks ORDER BY id")).rows,sqlBefore);assert.deepEqual((await pool.query("SELECT * FROM operations ORDER BY id")).rows,opsBefore);assert.equal(events.length,2);
  if(process.env.DCC_DRAFT_EVIDENCE_PATH) fs.writeFileSync(process.env.DCC_DRAFT_EVIDENCE_PATH,JSON.stringify({local_only:true,receipt:published.body,readback:{id:row.id,user_id:row.user_id,workspace_id:row.workspace_id,date:row.date,private:row.properties.publicVisibility,triage_id:row.properties.triageId,draft_preview:row.properties.triageContext.draft_preview,lane:groups.find(group=>group.block.id==="triage").block.id},retry:retry.body,preflight_rows:0,forced_insert_failure_rolled_back:true},null,2)+"\n");
  t.diagnostic("Actual new Slack and Gmail findings through public POST -> canonical creator/materializer -> atomic draft -> authenticated GET -> canonical private Triage lane; no source sends");
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
