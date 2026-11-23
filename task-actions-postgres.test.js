const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const enabled=!!process.env.DCC_PGLITE_MODULE||!!process.env.DCC_TEST_DATABASE_URL;
test('bounded reads retain ancestor context and full mutation trees inside the workspace',{skip:!enabled},async t=>{
  const ctx=await require('./test-support/activity-db').createActivityDb();t.after(()=>ctx.close());
  const date='2026-11-22';
  const make=(id,properties={},day=date,workspace_id='ws-1')=>ctx.blockDB.createBlock({id,type:'block',date:day,workspace_id,user_id:workspace_id==='ws-1'?1:2,
    properties:{kind:'task',type:'task',title:id,local_id:'legacy-'+id,...properties}});
  await make('parent');await make('child',{subtaskOf:'parent'});await make('deep',{subtaskOf:'legacy-child'});
  await make('foreign',{subtaskOf:'parent'},date,'ws-2');
  // Simulate legacy cross-date data without weakening the production writer.
  await ctx.pool.query("UPDATE blocks SET date='2026-10-01' WHERE id='parent'");
  const ancestors=await ctx.blockDB.getTaskAncestors(['child'],'ws-1');
  assert.deepEqual(ancestors.map(row=>row.id).sort(),['child','parent']);
  const tree=await ctx.blockDB.getSubtree(['parent'],'ws-1');
  assert.deepEqual(tree.map(row=>row.id).sort(),['child','deep','parent']);
  await ctx.pool.query("UPDATE blocks SET sort_order=0 WHERE id='child'");
  await ctx.pool.query("UPDATE blocks SET sort_order=100 WHERE id='deep'");
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.session={userId:1};req.workspaceId='ws-1';next();});
  Object.assign(ctx,{APP_TIME_ZONE:'UTC',getTodayStr:()=>'2026-11-23',isValidDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value),filterLegacyGcalBlocks:rows=>rows,broadcast(){}});
  require('./routes/blocks')(app,ctx);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/tasks/open?before=2026-11-23&days=14&limit=1');
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.rows.length,1);assert.equal(body.rows[0].id,'child');
  assert.ok(body.ancestors.some(row=>row.id==='parent'));
  assert.ok(body.actionRows.some(row=>row.id==='deep'));
  assert.ok(![...body.rows,...body.ancestors,...body.actionRows].some(row=>row.id==='foreign'));
});
