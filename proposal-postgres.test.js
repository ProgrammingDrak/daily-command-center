const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

test('proposal merge SQL scopes native suppressions, honors tombstones and settled wrappers, and preserves unrelated state', async t => {
  if (!process.env.DCC_TEST_DATABASE_URL) return t.skip('DCC_TEST_DATABASE_URL not set');
  const client = new Client({connectionString:process.env.DCC_TEST_DATABASE_URL});
  await client.connect();
  try {
    await client.query('SET search_path = pg_temp');
    await client.query(`CREATE TEMP TABLE blocks (id text PRIMARY KEY, type text, parent_id text, workspace_id text, properties jsonb, deleted_at timestamptz, created_at timestamptz DEFAULT now())`);
    await client.query(`CREATE TEMP TABLE dcc_state (date text, state_json jsonb, user_id integer, workspace_id text, updated_at timestamptz, UNIQUE(date,workspace_id))`);
    const source='slack:mention:C000000TEST:1790791513.460309';
    const other='gmail:native:foreign';
    const settled='gmail:native:settled';
    await client.query(`INSERT INTO blocks(id,type,workspace_id,properties,deleted_at) VALUES
      ('tombstone','block','ws-owned',$1,now()), ('foreign','block','ws-other',$2,NULL),
      ('adjacent','block','ws-owned',$3,NULL)`,[
      {idempotency_key:'slack-bookmark:C000000TEST:1790791513.460309'},
      {source_item_id:other}, {source_item_id:'slack:mention:C000000TEST:1790791514.460309'}]);
    await client.query(`INSERT INTO dcc_state VALUES ('2026-09-29',$1,7,'ws-owned',now()),('2026-09-30',$2,7,'ws-owned',now())`,[
      {glymphatic_context:{suggested_tasks:[{id:'old-wrapper',source_item_id:settled,title:'Human title'}]},glymphatic_brief:{decisions:{'old-wrapper':{action:'drop'}}}},
      {date:'2026-09-30',notes:{human:'keep'},schedule:{human:'keep'}}]);
    const poolPath=require.resolve('./pg-pool');
    require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:{connect:async()=>({query:(...args)=>client.query(...args),release:()=>{}})}};
    const db=require('./db');
    const packet={id:'sql-proof',suggested_tasks:[source,other,settled].map((source_item_id,i)=>({id:'wrapper-'+i,source_item_id,title:'Reviewed business proposal'}))};
    const result=await db.mergeDccProposalPacket('2026-09-30',packet,7,'ws-owned',{},'Drakula');
    assert.deepEqual(new Set(result.suppressedSourceIds),new Set([source,settled]));
    assert.deepEqual(result.acceptedSourceIds,['wrapper-1']);
    assert.deepEqual(result.state.notes,{human:'keep'});assert.deepEqual(result.state.schedule,{human:'keep'});
    await client.query(`UPDATE dcc_state SET state_json=jsonb_set(state_json,'{glymphatic_context,suggested_tasks}','[]'::jsonb) WHERE date='2026-09-29' AND workspace_id='ws-owned'`);
    const nextDay=await db.mergeDccProposalPacket('2026-10-01',{id:'later-day',suggested_tasks:[{id:'another-wrapper',source_item_id:settled,title:'Do not resurrect'}]},7,'ws-owned',{},'Drakula');
    assert.deepEqual(nextDay.acceptedSourceIds,[]);assert.deepEqual(nextDay.suppressedSourceIds,[settled]);
    await client.query(`INSERT INTO blocks(id,type,workspace_id,properties,deleted_at) VALUES ('page-only-handled','block','ws-owned',$1,now())`,[{source_item_id:'gmail:page:handled'}]);
    await client.query(`UPDATE dcc_state SET state_json=jsonb_set(state_json,'{glymphatic_context,pages}',$1::jsonb) WHERE date='2026-09-30' AND workspace_id='ws-owned'`,[JSON.stringify([{id:'front',tomorrow:[{id:'page-wrapper',source_item_id:'gmail:page:handled',title:'Handled page-only proposal'}]}])]);
    const visible=await db.mergeDccProposalPacket('2026-09-30',{id:'visible-proof',reviewed_findings:true,suggested_tasks:[{id:'visible-new',source_item_id:'gmail:visible:new',title:'Fresh ordinary proposal'}]},7,'ws-owned',{},'Drakula');
    assert.deepEqual(visible.state.glymphatic_brief.current.pages[0].tomorrow.map(x=>x.id),['visible-new']);
    const before=(await client.query(`SELECT state_json FROM dcc_state WHERE date='2026-09-30' AND workspace_id='ws-owned'`)).rows[0].state_json;
    const retry=await db.mergeDccProposalPacket('2026-09-30',packet,7,'ws-owned',{},'Drakula');
    assert.equal(retry.duplicate,true);
    assert.deepEqual((await client.query(`SELECT state_json FROM dcc_state WHERE date='2026-09-30' AND workspace_id='ws-owned'`)).rows[0].state_json,before);
    await db.mergeDccProposalPacket('2026-09-30',{id:'dry-only',suggested_tasks:[{id:'new',source_item_id:'gmail:dry:new',title:'Dry only'}]},7,'ws-owned',{},'Drakula',true);
    assert.deepEqual((await client.query(`SELECT state_json FROM dcc_state WHERE date='2026-09-30' AND workspace_id='ws-owned'`)).rows[0].state_json,before);
  } finally { await client.end(); }
});
