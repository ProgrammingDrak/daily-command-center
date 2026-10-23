const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createActivityDb } = require('./test-support/activity-db');
const { route, isValidDate } = require('./lib/route-helpers');

test('Waiting title edits are atomic, scoped and preserve follow-up state', {skip: !process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL}, async t => {
  const ctx = await createActivityDb(); t.after(ctx.close);
  Object.assign(ctx, {route, isValidDate, broadcast() {}, getTodayStr: () => '2026-10-23', getScheduleBlocks: async () => []});
  const app = express(); require('./routes/blocks')(app, ctx);
  const handler = app._router.stack.find(l => l.route?.path === '/api/waiting-items/:id/title' && l.route.methods.patch).route.stack[0].handle;
  const getHandler = app._router.stack.find(l => l.route?.path === '/api/waiting-items/:id/title' && l.route.methods.get).route.stack[0].handle;
  const get = async (id, workspaceId='ws-1') => {
    const res={statusCode:200,headersSent:false,status(c){this.statusCode=c;return this;},json(b){this.body=b;this.headersSent=true;return this;}};
    await getHandler({params:{id},workspaceId},res);return {status:res.statusCode,body:res.body};
  };
  const snapshot = async id => {
    const row=await ctx.blockDB.getBlock(id),linked=row.properties.linkedBlockId?await ctx.blockDB.getBlock(row.properties.linkedBlockId):null;
    return {expectedTitle:row.properties.myTask||row.properties.title||'',expectedLinkedTitle:linked?.properties.title||null,expectedLinkedBlockId:row.properties.linkedBlockId||null};
  };
  const patch = async (id, body, workspaceId = 'ws-1') => {
    body={...await snapshot(id),...body};
    const res = { statusCode:200, headersSent:false, status(c){this.statusCode=c;return this;},json(b){this.body=b;this.headersSent=true;return this;} };
    await handler({params:{id},body,workspaceId,session:{userId:workspaceId==='ws-1'?1:2}},res);
    return {status:res.statusCode,body:res.body};
  };
  const task = await ctx.blockDB.createItineraryTask({date:'2026-10-23',workspaceId:'ws-1',userId:1,properties:{title:'Original',kind:'task',start:'11:00',end:'11:30',status:'blocked',waitingItemId:'keep',custom:'retain'}});
  const props = {kind:'delegated_item',myTask:'Original',title:'Approval',status:'open',waitingReason:'blocked',linkedBlockId:task.id,checkInDate:null,checkInRepeat:false,checkInHistory:[{note:'Previous check-in',completedAt:'2026-10-22T12:00:00Z'}],delegatee:{name:'Synthetic colleague'},notes:'Keep context',source_id:'https://example.com/source',parksLinkedTask:true};
  const item = await ctx.blockDB.createBlock({type:'block',date:null,user_id:1,workspace_id:'ws-1',properties:props});
  const beforeTask = await ctx.blockDB.getBlock(task.id), beforeItem = await ctx.blockDB.getBlock(item.id);
  assert.equal((await patch(item.id,{title:'Renamed',expectedTitle:'Original'})).status,200);
  const savedItem = await ctx.blockDB.getBlock(item.id),savedTask = await ctx.blockDB.getBlock(task.id);
  assert.deepEqual(savedItem.properties,{...beforeItem.properties,myTask:'Renamed'});
  assert.deepEqual(savedTask.properties,{...beforeTask.properties,title:'Renamed'});
  for(const key of ['date','parent_id','sort_order'])assert.equal(savedTask[key],beforeTask[key]);
  assert.equal((await patch(item.id,{title:'Stale',expectedTitle:'Original'})).status,409);
  assert.equal((await patch(item.id,{title:'Foreign'},'ws-2')).status,404);
  for(const title of ['', ' ', 123, 'x'.repeat(301)])assert.equal((await patch(item.id,{title})).status,400);
  const orphan = await ctx.blockDB.createBlock({type:'block',date:null,user_id:1,workspace_id:'ws-1',properties:{...props,linkedBlockId:null}});
  assert.equal((await patch(orphan.id,{title:'Unlinked renamed'})).status,200);
  assert.equal((await ctx.blockDB.getBlock(orphan.id)).properties.myTask,'Unlinked renamed');
  const stale = await snapshot(item.id);
  await ctx.blockDB.updateBlock(task.id,{properties:{...savedTask.properties,title:'Newer ordinary task title'}});
  assert.equal((await get(item.id)).body.title,'Newer ordinary task title');
  assert.deepEqual((await get(item.id)).body,{title:'Newer ordinary task title',expectedTitle:'Renamed',expectedLinkedTitle:'Newer ordinary task title',expectedLinkedBlockId:task.id});
  assert.equal((await get(item.id,'ws-2')).status,404);
  assert.equal((await patch(item.id,{...stale,title:'Stale overwrite'})).status,409);
  assert.equal((await patch(item.id,{title:'Stale link',expectedLinkedBlockId:'no-longer-linked'})).status,409);
  assert.equal((await ctx.blockDB.getBlock(task.id)).properties.title,'Newer ordinary task title');
  await ctx.blockDB.updateBlock(task.id,{properties:savedTask.properties});
  const update=ctx.blockDB.updateBlock;
  ctx.blockDB.updateBlock=async(id,...args)=>{if(id===item.id)throw new Error('Synthetic second-write failure');return update(id,...args);};
  assert.equal((await patch(item.id,{title:'Must roll back'})).status,500);
  ctx.blockDB.updateBlock=update;
  assert.equal((await ctx.blockDB.getBlock(task.id)).properties.title,'Renamed');
  assert.equal((await ctx.blockDB.getBlock(item.id)).properties.myTask,'Renamed');
  const dependency=await ctx.blockDB.createBlock({type:'block',date:null,user_id:1,workspace_id:'ws-1',properties:{...props,waitingReason:'task-dependency',blockerBlockId:orphan.id,myTask:'Stale task caption'}});
  assert.equal((await get(dependency.id)).body.title,'Renamed');
  assert.equal((await patch(dependency.id,{title:'Dependency title'})).status,200);
  assert.deepEqual((await ctx.blockDB.getBlock(dependency.id)).properties,{...dependency.properties,myTask:'Dependency title'});
  await ctx.blockDB.deleteBlock(task.id);
  assert.equal((await patch(item.id,{title:'Missing link'})).status,409);

await t.test('Waiting rename serializes with unblock and cluster deletion without lost titles', {skip: !process.env.DCC_TEST_DATABASE_URL || !!process.env.DCC_PGLITE_MODULE}, async t => {
  Object.assign(ctx,{route,isValidDate,broadcast(){},getTodayStr:()=> '2026-10-23',getScheduleBlocks:async()=>[]});
  const app=express();require('./routes/blocks')(app,ctx);
  const invoke=async(method,path,id,body={})=>{
    const handler=app._router.stack.find(l=>l.route?.methods[method]&&(Array.isArray(l.route.path)?l.route.path.includes(path):l.route.path===path)).route.stack[0].handle;
    const res={statusCode:200,headersSent:false,status(c){this.statusCode=c;return this;},json(b){this.body=b;this.headersSent=true;return this;}};
    await handler({params:{id},body,workspaceId:'ws-1',session:{userId:1}},res);return {status:res.statusCode,body:res.body};
  };
  await t.test('dependency propagation lock contention returns a retryable conflict without title loss',async()=>{
    const task=await ctx.blockDB.createItineraryTask({date:'2026-10-23',workspaceId:'ws-1',userId:1,properties:{kind:'task',title:'Dependency work'}});
    const item=await ctx.blockDB.createBlock({type:'block',date:null,user_id:1,workspace_id:'ws-1',properties:{kind:'delegated_item',myTask:'Dependency work',status:'open',linkedBlockId:task.id}});
    const snapshot=(await invoke('get','/api/waiting-items/:id/title',item.id)).body;
    const propagating=await ctx.pool.connect();
    try{
      await propagating.query('BEGIN');
      // This is propagation's Waiting -> dependent-task ordering. Rename must
      // release its task lock promptly instead of waiting on the relation.
      await ctx.blockDB.getBlockIncludingDeleted(item.id,propagating,true);
      const result=await invoke('patch','/api/waiting-items/:id/title',item.id,{...snapshot,title:'Retry title'});
      assert.equal(result.status,409);
      assert.match(result.body.error,/changing elsewhere/);
      assert.equal((await ctx.blockDB.getBlockIncludingDeleted(task.id,propagating,true)).properties.title,'Dependency work');
      await propagating.query('COMMIT');
      assert.equal((await invoke('patch','/api/waiting-items/:id/title',item.id,{...snapshot,title:'Retry title'})).status,200);
    }finally{await propagating.query('ROLLBACK');propagating.release();}
  });
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
  for(const mode of ['unblock','dependency-delete','cluster-delete'])await t.test(mode,async()=>{
    const task=await ctx.blockDB.createItineraryTask({date:'2026-10-23',workspaceId:'ws-1',userId:1,properties:{kind:'task',title:'Before',...(mode==='cluster-delete'?{source:'slack-delegate-completion'}:{})}});
    const item=await ctx.blockDB.createBlock({type:'block',date:null,user_id:1,workspace_id:'ws-1',properties:{kind:'delegated_item',myTask:'Before',status:'open',linkedBlockId:task.id,parksLinkedTask:mode!=='cluster-delete'}});
    const snapshot=(await invoke('get','/api/waiting-items/:id/title',item.id)).body;
    const locked=deferred(),release=deferred(),secondStarted=deferred();
    const originalGet=ctx.blockDB.getBlockIncludingDeleted,originalConnect=ctx.pool.connect.bind(ctx.pool);
    let paused=false,advisories=0;
    ctx.blockDB.getBlockIncludingDeleted=async(id,client,forUpdate)=>{
      const row=await originalGet(id,client,forUpdate);
      if(!paused&&forUpdate&&id===item.id){
        paused=true;locked.resolve();await release.promise;
      }
      return row;
    };
    ctx.pool.connect=(...connectArgs)=>{
      // Pool.query uses connect(callback); preserve that overload for preflight reads.
      if(connectArgs.length)return originalConnect(...connectArgs);
      return originalConnect().then(client=>({release:()=>client.release(),query:async(sql,args)=>{
        if(sql.includes('pg_advisory_xact_lock(hashtextextended')&&args?.[0]===`waiting-cluster:ws-1:${item.id}`&&++advisories===2)secondStarted.resolve();
        return client.query(sql,args);
      }}));
    };
    let first,second;
    try{
      const rename=()=>invoke('patch','/api/waiting-items/:id/title',item.id,{...snapshot,title:'Renamed concurrently'});
      const remove=()=>invoke('delete','/api/waiting-items/:id',item.id);
      first=mode==='cluster-delete'?remove():rename();
      await Promise.race([locked.promise,first.then(()=>{throw new Error('First operation did not reach the expected row lock');})]);
      second=mode==='cluster-delete'?rename():mode==='unblock'?invoke('post','/api/waiting-items/:id/unblock',item.id,{taskBlockId:task.id,date:'2026-10-23'}):remove();
      await Promise.race([secondStarted.promise,second.then(()=>{throw new Error('Second operation did not acquire the cluster lock');})]);
      release.resolve();
      const results=await Promise.all([first,second]);assert.equal(results[0].status,200,JSON.stringify(results));
      assert.equal(results[1].status,mode==='cluster-delete'?404:200,JSON.stringify(results));
      const savedTask=await originalGet(task.id),savedItem=await originalGet(item.id);
      if(mode==='cluster-delete'){assert.ok(savedTask.deleted_at);assert.ok(savedItem.deleted_at);}
      else{
        assert.equal(savedTask.properties.title,'Renamed concurrently');
        assert.equal(savedItem.properties.myTask,'Renamed concurrently');
        if(mode==='unblock')assert.equal(savedItem.properties.status,'unblocked');else assert.ok(savedItem.deleted_at);
      }
    }finally{
      release.resolve();await Promise.allSettled([first,second].filter(Boolean));ctx.blockDB.getBlockIncludingDeleted=originalGet;ctx.pool.connect=originalConnect;
    }
  });
});

});
