const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createFixtureDb}=require('./scripts/commitment-test-db.cjs');
const {createConditionalRewardStore}=require('./conditional-reward-store');
const configured=!!process.env.DCC_TEST_DATABASE_URL;
test('conditional rewards: durable atomic earning, concurrent retries and redemption', {skip:!configured}, async t=>{
  const fixture=await createFixtureDb();t.after(fixture.cleanup);const {pool}=fixture;
  const schema=fs.readFileSync(require.resolve('./pg-schema'),'utf8');
  await pool.query(`CREATE TABLE slot_rewards(id SERIAL PRIMARY KEY);
    CREATE TABLE todo_sponsorships(id SERIAL PRIMARY KEY,workspace_id TEXT,share_id INTEGER,
      task_date DATE,reward_title TEXT,sponsor_user_id INTEGER,value_cents INTEGER,status TEXT,
      offer_settings JSONB,updated_at TIMESTAMPTZ);`);
  await pool.query(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS reward_queue_items ('),schema.indexOf('-- ──',schema.indexOf('CREATE INDEX IF NOT EXISTS idx_reward_events_queue'))));
  await pool.query('ALTER TABLE reward_queue_items ADD COLUMN actual_seconds INTEGER');
  const sandbox={require:name=>name==='./pg-pool'?pool:require(name),module:{exports:{}},console};
  vm.runInNewContext(fs.readFileSync(require.resolve('./social-store'),'utf8'),sandbox);
  const social=sandbox.module.exports;
  const task=taskId=>({type:'task',taskId}),root={type:'group',op:'all',children:[task('a'),{type:'group',op:'any',children:[task('b'),task('c')]}]};
  const {rows:[offer]}=await pool.query(`INSERT INTO todo_sponsorships(workspace_id,reward_title,sponsor_user_id,value_cents,status,offer_settings)
    VALUES('ws-1','Synthetic coffee',2,500,'pending',$1) RETURNING *`,[{condition:root}]);
  let states=new Map([['a',true],['b',false],['c',false]]),failRead=false;
  const store=createConditionalRewardStore({pool,enqueueReward:social.enqueueReward,resolveTasks:async()=>{if(failRead)throw Error('synthetic unavailable database');return states;}});
  const queue=async()=>(await pool.query('SELECT * FROM reward_queue_items ORDER BY id')).rows;
  await t.test('pending and wrong-owner requests never earn',async()=>{
    await store.reconcile('ws-1',1);assert.equal((await queue()).length,0);
    await pool.query("UPDATE todo_sponsorships SET status='approved'");
    states.set('b',true);await store.reconcile('ws-1',2);assert.equal((await queue()).length,0);
    states.set('b',false);await store.reconcile('ws-1',1);assert.equal((await queue()).length,0);
  });
  await t.test('undo before earning and missing tasks remain unmet; read failures do not turn into completion',async()=>{
    states=new Map([['a',false],['b',true]]);await store.reconcile('ws-1',1);assert.equal((await queue()).length,0);
    states=new Map([['b',true]]);await store.reconcile('ws-1',1);assert.equal((await queue()).length,0);
    failRead=true;await assert.rejects(store.reconcile('ws-1',1),/unavailable/);failRead=false;
    assert.equal((await pool.query('SELECT status FROM todo_sponsorships')).rows[0].status,'approved');
  });
  await t.test('failure after enqueue rolls back ledger, queue and earned marker together',async()=>{
    states=new Map([['a',true],['c',true]]);
    await pool.query(`CREATE FUNCTION fail_earned() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interrupted award'; END $$;
      CREATE TRIGGER fail_earned BEFORE UPDATE ON todo_sponsorships FOR EACH ROW EXECUTE FUNCTION fail_earned()`);
    await assert.rejects(store.reconcile('ws-1',1),/interrupted/);
    assert.equal((await queue()).length,0);assert.equal((await pool.query('SELECT * FROM reward_events')).rows.length,0);
    await pool.query('DROP TRIGGER fail_earned ON todo_sponsorships; DROP FUNCTION fail_earned()');
  });
  await t.test('concurrent reconciliation and retried requests create exactly one queue item',async()=>{
    await Promise.all(Array.from({length:5},()=>store.reconcile('ws-1',1)));
    assert.equal((await queue()).length,1);
    const saved=(await pool.query('SELECT * FROM todo_sponsorships WHERE id=$1',[offer.id])).rows[0];
    assert.equal(saved.status,'earned');assert.equal(saved.offer_settings.queueId,(await queue())[0].id);
    states=new Map();await store.reconcile('ws-1',1);assert.equal((await queue()).length,1,'later deletion or reopen never re-earns/retracts');
  });
  await t.test('existing queue authorization and repeated redemption apply unchanged',async()=>{
    const item=(await queue())[0];await assert.rejects(social.redeemReward(item.id,2),/not found/);
    const results=await Promise.all([social.redeemReward(item.id,1),social.redeemReward(item.id,1)]);
    assert.equal(results.filter(r=>r.changed).length,1);assert.equal((await queue())[0].status,'redeemed');
    assert.equal((await pool.query("SELECT * FROM reward_events WHERE event_type='redeemed'")).rows.length,1);
  });
  await t.test('pagination cannot starve eligible offers behind 100 unmet offers',async()=>{
    await pool.query(`INSERT INTO todo_sponsorships(workspace_id,reward_title,status,offer_settings)
      SELECT 'ws-1','Unmet','approved',$1 FROM generate_series(1,105)`,[{condition:task('no')}]);
    await pool.query(`INSERT INTO todo_sponsorships(workspace_id,reward_title,status,offer_settings)
      VALUES('ws-1','After page','approved',$1)`,[{condition:task('yes')}]);
    states=new Map([['yes',true]]);await store.reconcile('ws-1',1);assert.equal((await queue()).length,2);
  });
});
