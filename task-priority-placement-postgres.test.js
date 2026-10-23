const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

// Never read dotenv or DATABASE_URL: this test only uses an explicitly supplied
// disposable localhost database and owns an isolated schema.
test('priority-only PATCH merges at the PostgreSQL row lock and preserves placement', {
  skip: !process.env.DCC_TEST_DATABASE_URL,
}, async t => {
  const url = process.env.DCC_TEST_DATABASE_URL;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  const schema = 'priority_placement_' + crypto.randomBytes(8).toString('hex');
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE blocks (
    id TEXT PRIMARY KEY, type TEXT, parent_id TEXT, date DATE, properties JSONB,
    sort_order REAL DEFAULT 1000, user_id INTEGER, workspace_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ
  ); CREATE TABLE operations (
    id SERIAL PRIMARY KEY, block_id TEXT, op_type TEXT, before_data JSONB, after_data JSONB, timestamp TIMESTAMPTZ
  )`);
  const initial = { local_id:'race', title:'Keep title', detail:'Old notes', duration:30,
    start:null, end:null, taskPriority:'Medium', recurrence:{frequency:'daily'}, status:'open' };
  await pool.query("INSERT INTO blocks(id,type,properties,user_id,workspace_id) VALUES('race','block',$1,1,'ws-1')", [initial]);
  const poolPath = require.resolve('./pg-pool');
  const dbPath = require.resolve('./db');
  const oldPool = require.cache[poolPath];
  let reachedLock;
  const instrumented = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), query(sql, params) {
        if (reachedLock && /SELECT \* FROM blocks WHERE id = \$1 FOR UPDATE/.test(sql)) reachedLock();
        return client.query(sql, params);
      } };
    },
  };
  require.cache[poolPath] = { id:poolPath, filename:poolPath, loaded:true, exports:instrumented };
  delete require.cache[dbPath];
  const db = require('./db');
  t.after(() => { delete require.cache[dbPath]; if (oldPool) require.cache[poolPath]=oldPool; else delete require.cache[poolPath]; });
  const app = express(); app.use(express.json());
  app.use((req,_res,next) => { req.workspaceId=req.headers['fixture-workspace']||'ws-1';req.session={userId:1};next(); });
  require('./routes/blocks')(app, {
    blockDB:db, pool:instrumented, crypto, broadcast() {}, APP_TIME_ZONE:'UTC',
    getTodayStr:()=>'2026-10-22', isValidDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value),
    filterLegacyGcalBlocks:rows=>rows, getScheduleBlocks:async()=>[], isAllowedSweepBlockItem:()=>true,
  });
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const patch = (body, workspace='ws-1') => fetch(`http://127.0.0.1:${server.address().port}/api/blocks/race`, {
    method:'PATCH', headers:{'Content-Type':'application/json','fixture-workspace':workspace}, body:JSON.stringify(body),
  });
  const placement = { ...initial, detail:'New notes from another device', start:'12:00', end:'12:30', _pinnedStart:'12:00', userSetStart:true };
  await t.test('a delayed priority request merges the row committed by a concurrent placement', async () => {
    const holder=await pool.connect();
    let started;const entered=new Promise(resolve=>{started=resolve;});reachedLock=started;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT * FROM blocks WHERE id='race' FOR UPDATE");
      await holder.query("UPDATE blocks SET date='2026-10-22',properties=$1,updated_at=NOW() WHERE id='race'",[placement]);
      const response=patch({taskPriority:'High'});
      await entered;
      await holder.query('COMMIT');
      const saved=await response;assert.equal(saved.status,200);
      const row=await saved.json();
      assert.equal(row.date,'2026-10-22');assert.equal(row.workspace_id,'ws-1');assert.equal(row.user_id,1);
      assert.deepEqual(row.properties,{...placement,taskPriority:'High'});
    } finally { reachedLock=null;await holder.query('ROLLBACK');holder.release(); }
  });
  await t.test('a later placement retains acknowledged priority and recurrence', async () => {
    const current=await db.getBlock('race');
    const moved=await db.rescheduleBlocks([{id:'race',date:'2026-10-22',expectedDate:current.date,expectedUpdatedAt:current.updated_at,
      properties:{...current.properties,start:'13:00',end:'13:30',_pinnedStart:'13:00'}}],[]);
    const row=moved.blocks[0];
    assert.equal(row.properties.taskPriority,'High');assert.equal(row.date,'2026-10-22');
    assert.equal(row.properties.detail,placement.detail);assert.deepEqual(row.properties.recurrence,initial.recurrence);
  });
  await t.test('cross-workspace and malformed/mixed priority requests cannot change the row', async () => {
    const before=await db.getBlock('race');
    assert.equal((await patch({taskPriority:'Low'},'ws-2')).status,404);
    for (const body of [{taskPriority:'urgent'},{taskPriority:null},{taskPriority:'Low',properties:initial},{taskPriority:'Low',date:null},{taskPriority:'Low',completionIntent:'complete',completionBaseRevision:null}]) {
      assert.equal((await patch(body)).status,400);
    }
    assert.deepEqual(await db.getBlock('race'),before);
  });
});
