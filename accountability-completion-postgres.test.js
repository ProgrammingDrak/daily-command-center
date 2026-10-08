const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createFixtureDb,canonicalBlockDB}=require('./scripts/commitment-test-db.cjs');
const enabled=process.env.DCC_ACCOUNTABILITY_TEST_PG==='1'||!!process.env.DCC_TEST_DATABASE_URL;
const uuid=()=>crypto.randomUUID();
test('itinerary collaboration: canonical task, privacy, paging and workflow', {skip:!enabled},async t=>{
 const fixture=await createFixtureDb();t.after(fixture.cleanup);const {pool}=fixture;
 await pool.query("CREATE TABLE blocks(id TEXT PRIMARY KEY,type TEXT,properties JSONB,date DATE,workspace_id TEXT,user_id INTEGER,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW())");
 await pool.query("INSERT INTO blocks VALUES('task-a','block',$1,'2026-10-08','ws-1',1,NULL,NOW()),('task-b','block',$2,'2026-10-08','ws-2',2,NULL,NOW())",[{kind:'task',local_id:'local-a',title:'PRIVATE title',detail:'PRIVATE notes',source:'gmail',status:'open'},{kind:'task',title:'OTHER PRIVATE',status:'open'}]);
 await pool.query('CREATE TABLE todo_sponsorships(id SERIAL PRIMARY KEY,workspace_id TEXT,owner_user_id INTEGER,sponsor_user_id INTEGER,sponsor_name TEXT,task_id TEXT,task_date DATE,task_block_id TEXT,task_title TEXT,kind TEXT,reward_title TEXT,note TEXT,value_cents INTEGER,status TEXT,updated_at TIMESTAMPTZ DEFAULT NOW(),accountability_commitment_id TEXT)');
 const blockFixture={
 ensureDayRoot:async(day,user,ws,q)=>{const id=ws+':'+day;await q.query("INSERT INTO blocks(id,type,properties,date,workspace_id,user_id) VALUES($1,'day_root','{}',$2,$3,$4) ON CONFLICT DO NOTHING",[id,day,ws,user]);return id;},
 getBlockIncludingDeleted:async(id,q)=> (await q.query('SELECT * FROM blocks WHERE id=$1 FOR UPDATE',[id])).rows[0],
 updateBlock:async(id,fields,q)=>{await q.query('UPDATE blocks SET properties=$2 WHERE id=$1',[id,fields.properties]);}
};
const commitmentBounty=require('./routes/social-todo')({get(){},post(){},use(){},delete(){},put(){},patch(){}},{pool,route:require('./lib/route-helpers').route,blockDB:blockFixture,broadcast(){},coerceDateString:require('./lib/route-helpers').coerceDateString,isValidDate:require('./lib/route-helpers').isValidDate,getTodayStr:()=> '2026-10-08'});
 const store=require('./commitment-store').createStore({...fixture,blockDB:canonicalBlockDB(pool),commitmentBounty});
 const input={id:uuid(),actionId:uuid(),title:'Explicitly shared outcome',definitionDone:'Reviewed conclusion',committedDate:'2026-10-08',timeZone:'America/New_York',sourceBlockId:'local-a'};
 let item=await store.create(1,'ws-1',input);const id=item.id;
 const act=async(user,body)=>store.act(user,id,{actionId:uuid(),expectedRevision:(await store.read(id,1)).revision,...body},{limit:30});
 await t.test('source is owner validated, unique and never copied into shared content',async()=>{
  assert.equal(item.source_block_id,'task-a');assert.equal(item.source_local_id,'local-a');assert.equal(item.capabilities.complete,false);
  assert.ok(!JSON.stringify(item).includes('PRIVATE notes'));
  await assert.rejects(store.create(1,'ws-1',{...input,id:uuid(),actionId:uuid()}),e=>e.statusCode===409);
  await assert.rejects(store.create(1,'ws-1',{...input,id:uuid(),actionId:uuid(),sourceBlockId:'task-b'}),e=>e.statusCode===404);
  await act(1,{kind:'invite',userId:2,role:'coach'});await act(2,{kind:'accept'});
  const shared=await store.read(id,2);const raw=JSON.stringify(shared);
  for(const secret of ['task-a','local-a','PRIVATE','source_block_id','workspace_id','task_available'])assert.ok(!raw.includes(secret),secret);
  assert.equal(shared.linked,true);
 });
 await t.test('concurrent linking returns one success and a recoverable conflict',async()=>{
  await pool.query("INSERT INTO blocks(id,type,properties,date,workspace_id,user_id) VALUES('task-concurrent','block','{\"kind\":\"task\"}','2026-10-08','ws-1',1)");
  const results=await Promise.allSettled([1,2].map(()=>store.create(1,'ws-1',{...input,id:uuid(),actionId:uuid(),sourceBlockId:'task-concurrent'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
 });
 await t.test('the canonical checkbox drives shared completion; evidence/review cannot change it',async()=>{
  await assert.rejects(act(1,{kind:'complete',evidence:'Not a second checkbox'}),e=>e.statusCode===409);
  await act(1,{kind:'evidence',note:'Evidence only'});assert.equal((await store.read(id,1)).status,'open');
  for(const completed of [{status:'done'},{done:true},{completed:true},{completedAt:'2026-10-08T13:00:00Z'},{doneAt:'2026-10-08T13:00:00Z'}]){
   await pool.query("UPDATE blocks SET properties=$2 WHERE id=$1",['task-a',{kind:'task',local_id:'local-a',...completed}]);
   assert.equal((await store.read(id,2)).status,'completed');assert.equal((await store.list(2,null,true))[0].status,'completed');
  }
  await act(1,{kind:'invite',userId:3,role:'manager'});await act(3,{kind:'accept'});
  await act(3,{kind:'review',verdict:'met',note:'Verified conclusion'});
  assert.equal((await store.read(id,3)).events.at(-1).detail.status,'completed');
  await pool.query("UPDATE blocks SET properties=$2 WHERE id=$1",['task-a',{kind:'task',local_id:'local-a',status:'open'}]);
  assert.equal((await store.read(id,3)).status,'open');
 });
 await t.test('removed canonical task never becomes a new open completion state',async()=>{
  await pool.query("UPDATE blocks SET deleted_at=NOW() WHERE id='task-a'");
  assert.equal((await store.read(id,2)).status,'unavailable');
  assert.equal((await store.list(1,null,true))[0].task_available,false);
  await pool.query("UPDATE blocks SET deleted_at=NULL WHERE id='task-a'");
  assert.equal((await store.read(id,2)).status,'open');
 });
 await t.test('check-in response, correction, highlight and reaction retain attributed history',async()=>{
  await act(2,{kind:'check_in',at:'2026-10-08T16:00:00Z',note:'Bring a draft'});
  await assert.rejects(act(2,{kind:'check_in_response',note:'Cannot answer for owner'}),e=>e.statusCode===403);
  await act(1,{kind:'check_in_response',note:'Draft attached as agreed'});assert.equal((await store.read(id,1)).check_in_at,null);
  await act(1,{kind:'revise',title:'Corrected shared outcome',definitionDone:'Reviewed evidence and conclusion',note:'Clarify agreed scope'});
  await act(2,{kind:'highlight',enabled:true,note:'Focus on the missing conclusion'});
  item=await act(2,{kind:'reaction',emoji:'💪',enabled:true});assert.equal(item.reactionCounts['💪'],1);
  await act(2,{kind:'reaction',emoji:'💪',enabled:true});assert.equal((await store.read(id,1)).reactionCounts['💪'],1);
  await act(2,{kind:'reaction',emoji:'💪',enabled:false});assert.equal((await store.read(id,1)).reactionCounts['💪'],undefined);
  const correction=(await store.read(id,1)).events.find(e=>e.kind==='revise');assert.equal(correction.detail.beforeDefinition,'Reviewed conclusion');
 });
 await t.test('bounty offer is pending, daily-limited and atomic with owner consent and history',async()=>{
  const offered=await act(2,{kind:'bounty_offer',note:'Encourage the agreed outcome'});const offer=offered.bountyOffers[0];assert.equal(offer.status,'pending');
  assert.equal((await pool.query("SELECT * FROM blocks WHERE type='day_root'")).rows.length,0);
  await assert.rejects(act(2,{kind:'bounty_offer',note:'Duplicate daily offer'}),e=>e.statusCode===409);
  await assert.rejects(act(2,{kind:'bounty_decision',sponsorshipId:offer.id,decision:'approved',note:'Not owner'}),e=>e.statusCode===403);
  await pool.query("CREATE FUNCTION reject_bounty_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='bounty_decision' THEN RAISE EXCEPTION 'synthetic history failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_bounty_history BEFORE INSERT ON accountability_events FOR EACH ROW EXECUTE FUNCTION reject_bounty_history()");
  await assert.rejects(act(1,{kind:'bounty_decision',sponsorshipId:offer.id,decision:'approved',note:'Owner accepts points only'}));
  assert.equal((await pool.query('SELECT status FROM todo_sponsorships WHERE id=$1',[offer.id])).rows[0].status,'pending');
  assert.equal((await pool.query("SELECT * FROM blocks WHERE type='day_root'")).rows.length,0);
  await pool.query('DROP TRIGGER reject_bounty_history ON accountability_events');
  const body={kind:'bounty_decision',sponsorshipId:offer.id,decision:'approved',note:'Owner accepts points only',actionId:uuid(),expectedRevision:(await store.read(id,1)).revision};
  await store.act(1,id,body);await store.act(1,id,body);
  assert.equal((await pool.query("SELECT properties FROM blocks WHERE type='day_root'")).rows[0].properties._bounty.partner.sponsorshipId,offer.id);
  assert.equal((await pool.query('SELECT value_cents FROM todo_sponsorships WHERE id=$1',[offer.id])).rows[0].value_cents,0);
  await act(1,{kind:'bounty_decision',sponsorshipId:offer.id,decision:'dismissed',note:'Remove points offer'});
  assert.equal((await pool.query("SELECT properties FROM blocks WHERE type='day_root'")).rows[0].properties._bounty.partner,null);
 });
 await t.test('summary stays lightweight and complete; history pages have no gaps/duplicates',async()=>{
  for(let n=0;n<36;n++)await act(2,{kind:'comment',note:'Synthetic comment '+n});
  const summary=(await store.list(2,null,true))[0];assert.equal(summary.events,undefined);assert.equal(summary.members,undefined);assert.equal(summary.summary,true);
  let before,seen=[];
  do {const page=await store.read(id,2,{limit:7,...(before?{before}: {})});assert.ok(page.events.length<=7);seen.push(...page.events.map(e=>e.revision));before=page.nextBeforeRevision;}while(before);
  const full=await store.read(id,2);assert.equal(new Set(seen).size,full.events.length);assert.deepEqual(seen.sort((a,b)=>a-b),full.events.map(e=>e.revision));
  await assert.rejects(store.read(id,2,{limit:101}),e=>e.statusCode===400);
 });
 await t.test('seen state is per-person, monotonic and never marks a future revision',async()=>{
  const revision=(await store.read(id,2)).revision;
  await store.markSeen(2,id,revision);await store.markSeen(2,id,1);
  assert.equal((await store.list(2,null,true))[0].seen_revision,revision);
  await assert.rejects(store.markSeen(2,id,revision+1),e=>e.statusCode===400);
  await assert.rejects(store.markSeen(5,id,revision),e=>e.statusCode===404);
 });
 await t.test('lost decline response is idempotent without resurrecting revoked access',async()=>{
  await act(1,{kind:'invite',userId:4,role:'helper'});
  const body={kind:'decline',actionId:uuid(),expectedRevision:(await store.read(id,1)).revision};
  assert.equal((await store.act(4,id,body)).declined,true);assert.equal((await store.act(4,id,body)).declined,true);
  await act(1,{kind:'revoke',userId:4});await assert.rejects(store.act(4,id,body),e=>e.statusCode===404);
 });
});
test('friend Invite Link: signup intent, explicit add, expiry/revoke/block and retry', {skip:!enabled},async t=>{
 const fixture=await createFixtureDb();t.after(fixture.cleanup);const {pool}=fixture;await pool.query(require('./friend-invite-store').SCHEMA_SQL);
 const store=require('./friend-invite-store').createStore(fixture),input={actionId:uuid(),token:crypto.randomBytes(32).toString('base64url')};
 let link=await store.create(1,input);
 await t.test('tokens are hashed; creation retry is exact and previews reveal no workspace',async()=>{
  assert.equal((await store.create(1,input)).id,link.id);
  await assert.rejects(store.create(1,{...input,token:crypto.randomBytes(32).toString('base64url')}),e=>e.statusCode===409);
  const row=(await pool.query('SELECT * FROM friend_invite_links')).rows[0];assert.ok(!JSON.stringify(row).includes(input.token));
  const preview=await store.preview(input.token);assert.equal(preview.username,'alex');assert.equal(preview.signedIn,false);assert.equal(preview.workspace_id,undefined);
 });
 await t.test('self denied; simultaneous/repeated add produces one friendship and no task grants',async()=>{
  await assert.rejects(store.accept(1,input.token),e=>e.statusCode===400);
  const results=await Promise.all([store.accept(2,input.token),store.accept(2,input.token)]);assert.equal(results.filter(r=>r.alreadyFriends).length,1);
  assert.equal((await pool.query('SELECT * FROM friendships')).rows.length,1);
  assert.equal((await pool.query('SELECT * FROM accountability_members')).rows.length,0);
  assert.equal((await store.accept(2,input.token)).alreadyFriends,true);
 });
 await t.test('either direction block vetoes a link; no new edge silently defeats it',async()=>{
  await pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(3,1,'blocked')");
  await assert.rejects(store.accept(3,input.token),e=>e.statusCode===403);
  assert.equal((await pool.query('SELECT * FROM friendships WHERE requester_id=1 AND addressee_id=3')).rows.length,0);
 });
 await t.test('only owner revokes; repeated revoke is safe and expired/revoked links deny preview and add',async()=>{
  await assert.rejects(store.revoke(2,link.id),e=>e.statusCode===404);
  await store.revoke(1,link.id);await store.revoke(1,link.id);
  await assert.rejects(store.preview(input.token),e=>e.statusCode===404);await assert.rejects(store.accept(4,input.token),e=>e.statusCode===404);
  input.actionId=uuid();input.token=crypto.randomBytes(32).toString('base64url');link=await store.create(1,input);
  await pool.query("UPDATE friend_invite_links SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[link.id]);
  await assert.rejects(store.preview(input.token),e=>e.statusCode===404);await assert.rejects(store.accept(4,input.token),e=>e.statusCode===404);
 });
});
