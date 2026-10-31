const test=require('node:test');
const assert=require('node:assert/strict');
test('glasses open-only search excludes completion representations before pagination, preserving default history search',{skip:!process.env.DCC_TEST_DATABASE_URL},async t=>{
 const f=await require('./test-support/shared-queue-fixture').createSharedQueueFixture();t.after(()=>f.close());
 const make=(id,p)=>f.blockDB.createBlock({id,type:'block',date:'2099-01-02',user_id:1,workspace_id:'ws-1',properties:{local_id:id,type:'task',title:'glasses-search '+id,status:'open',...p}});
 await make('search-open',{});
 const done=[{status:'done'},{done:true},{completed:true},{completedAt:'2026-10-31T12:00:00Z'},{doneAt:'2026-10-31T12:00:00Z'},{kind:'responsibility_item'},{status:'archived'}];
 for(let i=0;i<56;i++)await make('search-closed-'+i,done[i%done.length]);
 const all=await f.request('/api/working-queue/tasks?query=glasses-search',{user:1});assert.equal(all.body.tasks.length,50);assert.equal(all.body.nextOffset,50);
 const open=await f.request('/api/working-queue/tasks?query=glasses-search&openOnly=true',{user:1});assert.equal(open.status,200);assert.deepEqual(open.body.tasks.map(t=>t.id),['search-open']);assert.equal(open.body.nextOffset,null);
});
