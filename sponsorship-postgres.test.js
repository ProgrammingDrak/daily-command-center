const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { createFixtureDb } = require("./scripts/commitment-test-db.cjs");
const configured = process.env.DCC_ACCOUNTABILITY_TEST_PG === "1" || !!process.env.DCC_TEST_DATABASE_URL;
test("pending sponsorship activation is owner-only, atomic and idempotent", { skip: !configured }, async t => {
  const fixture = await createFixtureDb(); t.after(fixture.cleanup);
  const { pool } = fixture;
  await pool.query(`ALTER TABLE workspaces ADD COLUMN name TEXT DEFAULT 'Fictional workspace';
    CREATE TABLE slot_rewards(id SERIAL PRIMARY KEY,workspace_id TEXT,title TEXT,kind TEXT,sponsor_type TEXT,
      sponsor_splits JSONB DEFAULT '[]',weight INTEGER,active BOOLEAN DEFAULT TRUE,sponsor_active BOOLEAN,
      value_cents INTEGER DEFAULT 0,bank_delta_cents INTEGER,requires_confirmation BOOLEAN,cooldown_days INTEGER,
      unlock_threshold_cents INTEGER,notes TEXT,public_visibility TEXT,expires_at TIMESTAMPTZ,uses_remaining INTEGER,
      deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,UNIQUE(workspace_id,title));
    CREATE TABLE blocks(id TEXT PRIMARY KEY,properties JSONB DEFAULT '{}');`);
  const source = fs.readFileSync(require.resolve("./routes/social-todo"),"utf8");
  const functions = ["centsFromBody","ensureTodoShareTables","findTodoShareByToken","publicTaskIdentityIds","findPublicShareTask","activateTodoShareBounty","revokeTodoShareBounty","applyTodoShareReward","normalizeBountyState"].map(name => {
    const match = source.match(new RegExp("(?:async )?function " + name + "\\([^]*?\\n\\}")); assert.ok(match,name); return match[0];
  }).join("\n");
  const handlers = new Map(), broadcasts = [];
  let publicTasks = [{id:"public-task",title:"Canonical fictional task",blockId:"public-block",identityIds:["public-task"]}];
  const ctx = { pool, console, slotStore:{ensureSchema:async()=>{}}, capabilities:require("./capabilities"),
    getTodayStr:()=>"2026-10-08",coerceDateString:String,isValidDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value),
    buildPublicTodoShare:async()=>({tasks:publicTasks}), broadcast:(...args)=>broadcasts.push(args),
    app:{post:(path,fn)=>handlers.set(path,fn)}, blockDB:{
      ensureDayRoot:async(date,_user,ws,q)=>{assert.ok(q && q!==pool);const id=ws+":"+date;await q.query("INSERT INTO blocks(id) VALUES($1) ON CONFLICT DO NOTHING",[id]);return id;},
      getBlockIncludingDeleted:async(id,q,lock)=>{assert.equal(lock,true);return (await q.query("SELECT * FROM blocks WHERE id=$1 FOR UPDATE",[id])).rows[0];},
      updateBlock:async(id,fields,q)=>{assert.ok(q && q!==pool);await q.query("UPDATE blocks SET properties=$2 WHERE id=$1",[id,fields.properties]);}
    }};
  vm.createContext(ctx); vm.runInContext(functions,ctx);
  for(const path of ["/api/todo-share/sponsorships/:id/status","/api/public/todo-share/:token/sponsorships"]){
    const start=source.indexOf('app.post("'+path+'"'),end=source.indexOf('\n});',start)+4;
    vm.runInContext(source.slice(start,end),ctx);
  }
  await ctx.ensureTodoShareTables();
  await pool.query("INSERT INTO todo_shares(workspace_id,token,created_by) VALUES('ws-1','fictional-token',1)");
  async function call(path,req){let body,status=200;const res={status(n){status=n;return this;},json(value){body=value;return this;}};await handlers.get(path)(req,res);return {status,body};}
  const submit = body => call("/api/public/todo-share/:token/sponsorships",{params:{token:"fictional-token"},body,session:{userId:2,username:"blair"}});
  const change = (id,status="approved",who=1) => call("/api/todo-share/sponsorships/:id/status",{params:{id},workspaceId:"ws-1",body:{status},session:{userId:who}});
  let offer;
  await t.test("submission records a pending canonical offer without activating it, preserving private settings",async()=>{
    const result=await submit({kind:"reward",taskId:"public-task",taskTitle:"Forged title",taskBlockId:"secret",sponsorName:"Blair",rewardTitle:"Fictional treat",rewardPrivate:true,target:"slot",uses:2,expiresAt:"2026-12-01T00:00:00Z"});
    assert.equal(result.status,201);offer=result.body;
    assert.equal(offer.status,"pending");assert.equal(offer.reward,null);assert.equal(offer.bounty,null);
    assert.equal((await pool.query("SELECT * FROM slot_rewards")).rows.length,0);
    assert.equal(offer.offer_settings.private,true);assert.equal(offer.offer_settings.usesRemaining,2);
    assert.equal(offer.task_id,"slot-machine");
    const canonical=await submit({kind:"reward",taskId:"public-task",taskTitle:"Forged title",taskBlockId:"secret",sponsorName:"Blair",rewardTitle:"Other fictional treat"});
    assert.equal(canonical.body.task_title,"Canonical fictional task");assert.equal(canonical.body.task_block_id,"public-block");
  });
  await t.test("unavailable/private targets do not create an offer",async()=>{
    publicTasks=[];const before=(await pool.query("SELECT COUNT(*)::int AS n FROM todo_sponsorships")).rows[0].n;
    assert.equal((await submit({kind:"reward",taskId:"private-task",sponsorName:"Blair"})).status,404);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM todo_sponsorships")).rows[0].n,before);
    publicTasks=[{id:"public-task",title:"Canonical fictional task",identityIds:["public-task"]}];
  });
  await t.test("only the actual workspace owner may activate an offer",async()=>{
    assert.equal((await change(offer.id,"approved",2)).status,404);
    assert.equal((await pool.query("SELECT * FROM slot_rewards")).rows.length,0);
  });
  async function failStatus(enable){
    if(enable) await pool.query(`CREATE FUNCTION reject_offer_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic status failure'; END $$;
      CREATE TRIGGER reject_offer_status BEFORE UPDATE ON todo_sponsorships FOR EACH ROW EXECUTE FUNCTION reject_offer_status()`);
    else await pool.query("DROP TRIGGER reject_offer_status ON todo_sponsorships; DROP FUNCTION reject_offer_status()");
  }
  await t.test("status failure rolls activation back and retry preserves saved settings exactly once",async()=>{
    await failStatus(true);assert.equal((await change(offer.id)).status,500);
    assert.equal((await pool.query("SELECT * FROM slot_rewards")).rows.length,0);
    assert.equal((await pool.query("SELECT status FROM todo_sponsorships WHERE id=$1",[offer.id])).rows[0].status,"pending");
    await failStatus(false);const approved=await change(offer.id);assert.equal(approved.status,200);
    assert.equal(approved.body.reward.public_visibility,"private");assert.equal(approved.body.reward.uses_remaining,2);
    assert.equal(approved.body.reward.expires_at.toISOString(),"2026-12-01T00:00:00.000Z");
    const results=await Promise.all([change(offer.id),change(offer.id)]);assert.ok(results.every(r=>r.status===200));
    assert.equal((await pool.query("SELECT * FROM slot_rewards")).rows.length,1);
  });
  await t.test("concurrent sponsors preserve distinct splits and repeat approvals cannot append duplicates",async()=>{
    const reward=(await pool.query("INSERT INTO slot_rewards(workspace_id,title,kind,active,public_visibility) VALUES('ws-1','Shared fictional reward','sponsor',TRUE,'public') RETURNING *")).rows[0];
    const a=(await submit({kind:"reward",target:"slot",slotRewardId:reward.id,sponsorName:"Blair"})).body;
    const b=(await submit({kind:"reward",target:"slot",slotRewardId:reward.id,sponsorName:"Casey"})).body;
    assert.ok((await Promise.all([change(a.id),change(b.id)])).every(r=>r.status===200));
    await change(a.id);
    let splits=(await pool.query("SELECT sponsor_splits FROM slot_rewards WHERE id=$1",[reward.id])).rows[0].sponsor_splits;
    assert.deepEqual(splits.map(s=>s.sponsorshipId).sort(),[a.id,b.id].sort());
    assert.equal((await change(a.id,"pending")).status,409);
    assert.equal((await change(a.id,"dismissed")).status,200);
    splits=(await pool.query("SELECT sponsor_splits FROM slot_rewards WHERE id=$1",[reward.id])).rows[0].sponsor_splits;
    assert.deepEqual(splits.map(s=>s.sponsorshipId),[b.id]);
  });
  await t.test("bounty block writes also roll back with offer status",async()=>{
    const bounty=(await submit({kind:"bounty",taskId:"public-task",sponsorName:"Blair"})).body;
    await failStatus(true);assert.equal((await change(bounty.id)).status,500);
    assert.equal((await pool.query("SELECT * FROM blocks")).rows.length,0);
    await failStatus(false);assert.equal((await change(bounty.id)).status,200);
    const root=(await pool.query("SELECT * FROM blocks")).rows[0];assert.equal(root.properties._bounty.partner.sponsorshipId,bounty.id);
    assert.equal((await change(bounty.id)).status,200);
    assert.equal((await change(bounty.id,"dismissed")).status,200);
    assert.equal((await pool.query("SELECT * FROM blocks")).rows[0].properties._bounty.partner,null);
  });
});
