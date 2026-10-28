// Disposable socket only. Never uses DATABASE_URL or app credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const socket = process.env.DCC_PENDING_REPAIR_TEST_SOCKET;
test('pending-create repair preserves identity, history and actuals in real PostgreSQL', { skip: !socket }, async t => {
  assert.equal(socket, '/tmp/dcc-pending-repair-pg/socket');
  const { Pool } = require('pg');
  const admin = new Pool({ host: socket, port: 55449, database: 'postgres', user: process.env.USER });
  const schema = 'repair_' + require('node:crypto').randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({ host: socket, port: 55449, database: 'postgres', user: process.env.USER, options: '-c search_path=' + schema });
  const poolPath = require.resolve('./pg-pool'), dbPath = require.resolve('./db'), old = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool }; delete require.cache[dbPath];
  const db = require('./db');
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); delete require.cache[dbPath]; if (old) require.cache[poolPath] = old; else delete require.cache[poolPath]; });
  await pool.query(`CREATE TABLE blocks(id TEXT PRIMARY KEY,type TEXT NOT NULL,parent_id TEXT,date DATE,properties JSONB DEFAULT '{}',sort_order DOUBLE PRECISION DEFAULT 0,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ,user_id INTEGER,workspace_id TEXT);
    CREATE TABLE operations(id SERIAL PRIMARY KEY,block_id TEXT,op_type TEXT,before_data JSONB,after_data JSONB,timestamp TIMESTAMPTZ,batch_id TEXT);
    CREATE FUNCTION dcc_is_task_row(TEXT,JSONB) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT $1 NOT IN ('day_root','time_entry') $$;
    CREATE FUNCTION dcc_resolve_local_id(TEXT,DATE,TEXT) RETURNS TEXT LANGUAGE SQL AS $$
      SELECT CASE WHEN COUNT(*)=1 THEN MIN(id) END FROM blocks WHERE workspace_id IS NOT DISTINCT FROM $1 AND date IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND (id=$3 OR properties->>'local_id'=$3) $$;`);
  const parent = await db.createBlock({ id: 'parent', type: 'block', workspace_id: 'ws', user_id: 1, date: null, properties: { title: 'Parent', type: 'task', source: 'manual', local_id: 'parent-local' } });
  const actual = await db.createBlock({ id: 'existing-time', type: 'time_entry', date: '2026-10-28', workspace_id: 'ws', user_id: 1, properties: { taskId: 'other', seconds: 321 } });
  const original = { id: 'original-child', type: 'block', date: '2026-10-28', parent_id: null, properties: { title: 'Release review', detail: 'All notes retained', tags: ['review'], local_id: 'original-local', type: 'task', source: 'manual', subtaskOf: parent.id, duration: 0, start: '00:00', end: '00:00' } };
  const repair = require('./lib/pending-create-repair')({ pool, blockDB: db });
  const call = extra => repair({ original, userId: 1, workspaceId: 'ws', ...extra });
  const preview = await call();
  assert.equal(await db.getBlock(original.id), null);
  // Concurrent tabs and a lost acknowledgement converge on the same row.
  const results = await Promise.all([call({ apply: true, expected: preview.expected }), call({ apply: true, expected: preview.expected })]);
  assert.equal(results.filter(r => r.created).length, 1);
  const saved = await db.getBlock(original.id);
  assert.equal(saved.date, null); assert.equal(saved.parent_id, parent.id);
  for (const key of Object.keys(original.properties)) assert.deepEqual(saved.properties[key], original.properties[key]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM operations WHERE block_id=$1', [original.id])).rows[0].n, 1);
  assert.deepEqual(await db.getBlock(actual.id), actual);
  const changed = { ...original, id: 'changed-child' };
  const prior = await call({ original: changed });
  await pool.query("UPDATE blocks SET date='2026-10-29',updated_at=updated_at+interval '1 second' WHERE id='parent'");
  await assert.rejects(call({ original: changed, apply: true, expected: prior.expected }), /changed/);
  assert.equal(await db.getBlock(changed.id), null);
  // A tombstone and an edited original cannot be revived or overwritten.
  await pool.query("UPDATE blocks SET date=NULL WHERE id='parent'");
  await pool.query("UPDATE blocks SET properties=properties||'{\"detail\":\"New server note\"}' WHERE id='original-child'");
  await assert.rejects(call(), /different content/);
  await pool.query("UPDATE blocks SET deleted_at=NOW() WHERE id='original-child'");
  await assert.rejects(call(), /different content/);
  assert.deepEqual(await db.getBlock(actual.id), actual);
});
