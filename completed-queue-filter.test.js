const test=require('node:test');
const assert=require('node:assert/strict');
const F=require('./public/js/completed-queue-filter');
const row=(id,at,status='completed')=>({task:{id,properties:{responsibilityId:'same-series'}},status,completedAt:at==null?null:Date.parse(at)});
const ids=value=>value.rows.map(item=>item.task.id);
test('Today follows the configured local calendar through midnight and DST, not rolling 24h',()=>{
  const rows=[row('before','2026-03-08T04:59:59.999Z'),row('midnight','2026-03-08T05:00:00.000Z'),row('after-skip','2026-03-08T07:01:00.000Z')];
  assert.deepEqual(ids(F.select(rows,'today',Date.parse('2026-03-09T03:59:59.999Z'),'America/New_York')),['after-skip','midnight']);
  assert.deepEqual(ids(F.select(rows,'today',Date.parse('2026-03-09T04:00:00.000Z'),'America/New_York')),[]);
  const repeated=[row('midnight','2026-11-01T04:00:00Z'),row('first-1am','2026-11-01T05:30:00Z'),row('second-1am','2026-11-01T06:30:00Z')];
  assert.deepEqual(ids(F.select(repeated,'today',Date.parse('2026-11-02T04:59:59Z'),'America/New_York')),['second-1am','first-1am','midnight']);
  assert.deepEqual(ids(F.select(repeated,'day',Date.parse('2026-11-02T04:59:59Z'),'America/New_York')),['second-1am','first-1am']);
});
test('rolling ranges include exact cutoffs, exclude future/unknown, and month explicitly means 30 days',()=>{
  const now=Date.parse('2026-10-29T16:00:00Z');
  for(const [period,ms] of [['hour',3600000],['day',86400000],['week',7*86400000],['month',30*86400000]]){
    const rows=[row('boundary',new Date(now-ms).toISOString()),row('before',new Date(now-ms-1).toISOString()),row('now',new Date(now).toISOString()),row('future',new Date(now+1).toISOString()),row('unknown',null)];
    assert.deepEqual(ids(F.select(rows,period,now,'UTC')),['now','boundary']);
  }
});
test('latest is one deterministic occurrence; all-time preserves unknowns and excludes reopened tasks',()=>{
  const rows=[row('b','2026-10-29T12:00:00Z'),row('a','2026-10-29T12:00:00Z'),row('unknown',null),row('reopened',null,'paused')];
  assert.deepEqual(ids(F.select(rows,'latest',Date.parse('2026-10-29T13:00:00Z'),'UTC')),['a']);
  assert.deepEqual(ids(F.select(rows,'all')),['a','b','unknown']);
  assert.equal(F.select(rows,'today',Date.parse('2026-10-29T13:00:00Z'),'UTC').unknown,1);
  assert.deepEqual(ids(F.select([row('unknown',null)],'latest')),[]);
});
test('owner queue reads full retained history, canonical overlays, and occurrence identities without mutations', {skip:!process.env.DCC_TEST_DATABASE_URL},async t=>{
  const f=await require('./test-support/shared-queue-fixture').createSharedQueueFixture();t.after(()=>f.close());
  const order=[],items={};
  async function add(id,properties={},extra={}){
    await f.blockDB.createBlock({id,type:'block',user_id:1,workspace_id:'ws-1',date:'2030-01-01',properties:{title:'Synthetic completed occurrence',kind:'task',type:'task',status:'done',...properties},...extra});
    order.push(id);items[id]={status:'completed'};
  }
  for(let i=0;i<125;i++)await add('old-'+String(i).padStart(3,'0'),{completedAt:'2020-01-02T12:00:00Z',responsibilityId:'same-series'});
  await add('unknown',{updatedAt:'2026-10-29T12:00:00Z'});
  await add('reopened',{status:'open'});
  await add('foreign',{completedAt:'2026-10-29T12:00:00Z'},{user_id:3});
  await add('overlay',{status:'open',local_id:'overlay-alias'},{date:f.date});
  const root=await f.blockDB.ensureDayRoot(f.date,1,'ws-1');
  await f.pool.query('UPDATE blocks SET properties=properties||$2::jsonb WHERE id=$1',[root,JSON.stringify({_done:{ids:['overlay-alias'],at:{'overlay-alias':'2026-10-28T18:00:00Z'}}})]);
  await f.pool.query('UPDATE work_rotations SET state=$1 WHERE user_id=1 AND workspace_id=$2',[{version:2,order,items},'ws-1']);
  const before=(await f.pool.query('SELECT id,properties,date FROM blocks ORDER BY id')).rows;
  assert.equal((await f.request('/api/working-queue')).status,401);
  assert.equal((await f.request('/api/working-queue',{user:3})).status,403);
  const response=await f.request('/api/working-queue',{user:1});assert.equal(response.status,200);
  const all=F.select(response.body.queue.items,'all');
  assert.equal(all.total,127,'all 125 older occurrences plus overlay and unknown, beyond search and add limits');
  assert.equal(all.unknown,1);assert.equal(all.rows.find(i=>i.task.id==='overlay').completedAt,Date.parse('2026-10-28T18:00:00Z'));
  assert.ok(!all.rows.some(i=>['foreign','reopened','done'].includes(i.task.id)),'foreign, reopened and removed memberships excluded');
  assert.equal(all.rows.find(i=>i.task.id==='old-124').completedAt,Date.parse('2020-01-02T12:00:00Z'));
  assert.deepEqual((await f.pool.query('SELECT id,properties,date FROM blocks ORDER BY id')).rows,before,'reading does not alter dates, actuals, completion or foreground');
  assert.deepEqual((await f.pool.query('SELECT state FROM work_rotations WHERE user_id=1')).rows[0].state,{version:2,order,items});
});
