const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createFixtureDb}=require('./scripts/commitment-test-db.cjs');
const store=require('./shared-task-suggestion-store');
const configured=!!process.env.DCC_TEST_DATABASE_URL;
test('shared suggestions persist task inputs once without scheduling or replacing the day',{skip:!configured},async t=>{
 const fixture=await createFixtureDb();t.after(fixture.cleanup);const {pool}=fixture;
 await pool.query(`CREATE TABLE todo_shares(id SERIAL PRIMARY KEY,workspace_id TEXT,active BOOLEAN DEFAULT TRUE);
  INSERT INTO todo_shares(workspace_id) VALUES('ws-1');
  CREATE TABLE dcc_state(date DATE,workspace_id TEXT,user_id INTEGER,state_json JSONB,updated_at TIMESTAMPTZ,PRIMARY KEY(date,workspace_id));`);
 await pool.query(store.SCHEMA_SQL);
 await pool.query(`INSERT INTO dcc_state VALUES('2026-10-22','ws-1',1,'{"schedule":{"timeline":[{"title":"Keep scheduled work"}]},"triage":{"open_items":[],"resolved_items":[]},"privateData":"keep"}',NOW())`);
 const share={id:1,workspace_id:'ws-1',owner_id:1,token:'synthetic'};
 const source=fs.readFileSync(require.resolve('./routes/social-todo'),'utf8');
 const ctx={pool,crypto:require('node:crypto'),APP_TIME_ZONE:'America/New_York',suggestionStore:store,todoShareUrl:()=>'/todo/synthetic',buildSkeletonState:date=>({date,triage:{open_items:[]}})};
 vm.createContext(ctx);vm.runInContext(source.match(/async function appendPublicShareTriageItem\([\s\S]*?\n\}/)[0],ctx);
 const input={share,date:'2026-10-22',title:'Plan a walk',durationMinutes:45,visitorName:'Riley',visitorEmail:'',note:'At the park',suggestedTime:'14:30',requestKey:'suggestion-request-123',fingerprint:'one',req:{}};
 const results=await Promise.all([ctx.appendPublicShareTriageItem(input),ctx.appendPublicShareTriageItem(input)]);
 assert.equal(results[0].id,results[1].id);
 const read=async()=>(await pool.query("SELECT * FROM dcc_state WHERE date='2026-10-22' AND workspace_id='ws-1'")).rows[0];
 let row=await read();assert.equal(row.user_id,1);assert.equal(row.state_json.privateData,'keep');assert.equal(row.state_json.schedule.timeline.length,1);
 const item=row.state_json.triage.open_items[0];assert.equal(row.state_json.triage.open_items.length,1);
 assert.equal(item.duration_minutes,45);assert.equal(item.estimated_minutes,45);assert.equal(item.suggested_time,'14:30');assert.equal(item.suggested_timezone,'America/New_York');assert.equal(item.suggested_date,'2026-10-22');assert.match(item.summary,/Suggested time: 14:30/);assert.equal(item.start,undefined);
 await assert.rejects(ctx.appendPublicShareTriageItem({...input,fingerprint:'changed'}),/different suggestion/);
 // An accepted response lost across midnight still returns its original receipt.
 assert.equal((await ctx.appendPublicShareTriageItem({...input,date:'2026-10-23'})).id,item.id);
 assert.equal((await pool.query("SELECT * FROM dcc_state WHERE date='2026-10-23'")).rows.length,0);
 await pool.query(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic lost write'; END $$;
 CREATE TRIGGER fail_receipt BEFORE INSERT ON todo_task_suggestion_requests FOR EACH ROW EXECUTE FUNCTION fail_receipt()`);
 await assert.rejects(ctx.appendPublicShareTriageItem({...input,requestKey:'suggestion-request-456'}),/lost write/);
 row=await read();assert.equal(row.state_json.triage.open_items.length,1);
 await pool.query('DROP TRIGGER fail_receipt ON todo_task_suggestion_requests; DROP FUNCTION fail_receipt()');
 await ctx.appendPublicShareTriageItem({...input,requestKey:'suggestion-request-456'});
 assert.equal((await read()).state_json.triage.open_items.length,2);
 await t.test('the production handler rejects unsupported dates but replays accepted receipts across midnight',async()=>{
  let today='2026-10-22',handler;
  Object.assign(ctx,{
   console,findTodoShareByToken:async()=>share,getTodayStr:()=>today,
   isValidDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value),broadcast(){},
   getDayFilePath:date=>'/unused-synthetic-day/'+date,
   blockDB:{
    getDccState:async(date,workspace)=>(await pool.query('SELECT * FROM dcc_state WHERE date=$1 AND workspace_id=$2',[date,workspace])).rows[0],
    saveDccState:async(date,state,user,workspace)=>pool.query(`INSERT INTO dcc_state(date,workspace_id,user_id,state_json,updated_at)
     VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(date,workspace_id) DO UPDATE SET state_json=EXCLUDED.state_json`,[date,workspace,user,state]),
   },
   app:{post:(_path,fn)=>{handler=fn;}},
  });
  const start=source.indexOf('app.post("/api/public/todo-share/:token/tasks"');
  vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),ctx);
  async function call(body){let status=200,result;const res={status(n){status=n;return this;},json(value){result=value;return this;}};await handler({params:{token:'synthetic'},body},res);return {status,body:result};}
  const body={requestKey:'handler-date-request-123',title:'Keep the requested day',durationMinutes:30,date:today,suggestedTime:'14:30'};
  const accepted=await call(body);assert.equal(accepted.status,201,JSON.stringify(accepted.body));
  today='2026-10-23';
  const retry=await call(body);assert.equal(retry.status,201,JSON.stringify(retry.body));assert.equal(retry.body.triageItem.id,accepted.body.triageItem.id);
  assert.equal(retry.body.triageItem.suggested_date,'2026-10-22');
  assert.equal((await pool.query("SELECT * FROM dcc_state WHERE date='2026-10-23'")).rows.length,0,'retry does not create or move a day');
  assert.equal((await call({...body,title:'Changed payload'})).status,409,'changed old requests still conflict');
  const before=await pool.query('SELECT COUNT(*)::int AS n FROM todo_task_suggestion_requests');
  for(const date of ['2026-10-22','2026-10-25','2099-01-01','not-a-date']){
   const rejected=await call({...body,date,requestKey:'unsupported-date-'+date});
   assert.equal(rejected.status,400,JSON.stringify(rejected.body));assert.match(rejected.body.error,/today or tomorrow/);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM todo_task_suggestion_requests')).rows[0].n,before.rows[0].n);
  assert.equal((await pool.query("SELECT * FROM dcc_state WHERE date<>'2026-10-22'")).rows.length,0,'rejected dates never write another day');
  const tomorrow=await call({...body,date:'2026-10-24',requestKey:'handler-tomorrow-request'});assert.equal(tomorrow.status,201);
  assert.equal(tomorrow.body.triageItem.suggested_date,'2026-10-24');
  const noDate={...body,requestKey:'handler-no-date-request'};delete noDate.date;
  const current=await call(noDate);assert.equal(current.status,201);assert.equal(current.body.triageItem.suggested_date,today);
  delete noDate.requestKey;
  const legacy=await call(noDate);assert.equal(legacy.status,201);assert.equal(legacy.body.triageItem.suggested_date,today);
  await pool.query("UPDATE dcc_state SET state_json=$1 WHERE date='2026-10-23'",[{triage:{open_items:Array.from({length:50},(_,i)=>({id:'cap-'+i,source:'public_share'}))}}]);
  const capped=await call({...body,date:today,requestKey:'handler-capped-request'});assert.equal(capped.status,429);
 });
 await pool.query('UPDATE todo_shares SET active=FALSE');
 await assert.rejects(ctx.appendPublicShareTriageItem({...input,requestKey:'suggestion-request-789'}),/unavailable/);
});
