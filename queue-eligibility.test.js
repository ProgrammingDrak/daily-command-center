const test = require('node:test');
const assert = require('node:assert/strict');
const { eligible, sql } = require('./lib/queue-eligibility');
const cases = [
  ['ordinary', {title:'Plan launch',type:'task'}, true],
  ['older', {title:'Finish earlier work'}, true],
  ['date-title', {title:'2026-10-01',type:'task'}, true],
  ['task-notes', {title:'Subtask with notes',type:'task',html:'<p>Details</p>',text:'Details',_taskNotes:{text:'Keep me'}}, true],
  ['note', {title:'Note heading',type:'note'}, false],
  ['saved-note', {html:'<p>Keep this note</p>',text:'Keep this note',_sourceTaskId:'ordinary'}, false],
  ['titled-saved-note', {title:'Note heading',html:'<p>Keep</p>',text:'Keep',_sourceTaskId:'ordinary'}, false],
  ['generic-child-note', {title:'Note heading',html:'<p>Keep</p>',text:'Keep'}, false],
  ['blank', {title:' \t\n ​\u1680\u202f\u3000\ufeff'}, false],
  ['missing', {}, false],
  ['invalid-title', {title:123}, false],
  ['definition', {title:'Weekly definition',kind:'responsibility_item'}, false],
  ['occurrence', {title:'Weekly concrete occurrence',kind:'responsibility_task',responsibilityId:'definition'}, true],
  ...['done','completed','complete','cancelled','canceled','deleted','archived','skipped'].map(status=>['status-'+status,{title:'Closed '+status,status:'\t '+status.toUpperCase()+'\n'},false]),
  ...['done','completed','checked'].map(key=>['flag-'+key,{title:'Closed by flag',[key]:true},false]),
  ...['doneAt','completedAt'].map(key=>['timestamp-'+key,{title:'Finished by timestamp',[key]:'2026-11-04T12:00:00Z'},false]),
  ['false-time', {title:'False timestamp is not completion',completedAt:false}, true],
  ['alias', {title:'Finished in overlay',local_id:'overlay-local'}, false],
  ['numeric-alias', {title:'Numeric overlay alias',local_id:123}, false],
  ['second-root', {title:'Finished in second root'}, false],
  ['overlay-at', {title:'Finished in at map'}, false]
];
const root={_done:{ids:['overlay-local',123,'second-root'],at:{'overlay-at':'2026-11-04T12:00:00Z'}}};
const canonical = row => row.type!=='day_root' && row.type!=='time_entry' && row.properties.kind!=='responsibility_item';
function row(id,properties){return {id,type:'block',parent_id:['task-notes','generic-child-note'].includes(id)?'ordinary':null,properties};}
test('picker policy excludes notes and closed aliases without mutating legitimate work',()=>{
  for(const [id,properties,wanted] of cases){const task=row(id,properties),before=structuredClone(task);assert.equal(eligible(task,root,canonical),wanted,id);assert.deepEqual(task,before,id+' is read-only');}
});
test('picker SQL, paginated store, HTTP and coordinator enforce one policy with tenant isolation', {skip:!process.env.DCC_TEST_DATABASE_URL},async t=>{
  const ctx=await require('./test-support/activity-db').createActivityDb();t.after(()=>ctx.close());
  const {createConversationStore,FOREGROUND_INDEX_SQL}=require('./conversation-store');
  await ctx.pool.query(FOREGROUND_INDEX_SQL);
  const store=createConversationStore(ctx),owner={userId:1,workspaceId:'ws-1'};
  const insert=async(id,properties,{date='2026-11-04',type='block',user=1,ws='ws-1',parent=null}={})=>ctx.pool.query("INSERT INTO blocks(id,type,properties,date,parent_id,user_id,workspace_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())",[id,type,properties,date,parent,user,ws]);
  await insert('day-root',{_done:{ids:['overlay-local',123],at:root._done.at}},{type:'day_root'});
  await insert('day-root-second',{_done:{ids:['second-root']}},{type:'day_root'});
  await insert('foreign-root',{_done:{ids:['task-notes']}},{type:'day_root',user:2,ws:'ws-2'});
  for(const [id,p] of cases)await insert(id,p,{parent:row(id,p).parent_id,date:id==='older'?'2020-01-01':id==='ordinary'?null:'2026-11-04'});
  // Hundreds of more-recent excluded rows must not consume the first page.
  for(let i=0;i<125;i++)await insert('noise-'+i,{html:'<p>Untitled note</p>',text:'Untitled note',_sourceTaskId:'ordinary'});
  for(let i=0;i<58;i++)await insert('valid-'+String(i).padStart(2,'0'),{title:'Eligible task '+i,type:'task'},{date:null});
  await insert('foreign',{title:'Foreign sentinel',type:'task'},{user:2,ws:'ws-2'});
  const before=(await ctx.pool.query('SELECT id,properties FROM blocks ORDER BY id')).rows;
  const actual=new Set((await ctx.pool.query(`SELECT b.id FROM blocks b WHERE b.user_id=1 AND b.workspace_id='ws-1' AND ${sql()}`)).rows.map(r=>r.id));
  for(const [id,,wanted] of cases)assert.equal(actual.has(id),wanted,'SQL/JS parity '+id);
  const first=await store.searchQueueTasks({},owner);assert.equal(first.tasks.length,50);assert.equal(first.nextOffset,50);
  const second=await store.searchQueueTasks({offset:first.nextOffset},owner);assert.equal(second.nextOffset,null);
  const all=[...first.tasks,...second.tasks];assert.equal(new Set(all.map(t=>t.id)).size,all.length);assert.equal(all.length,actual.size);
  assert.ok(all.some(t=>t.id==='ordinary'&&t.date===null));assert.ok(all.some(t=>t.id==='older'));assert.ok(all.some(t=>t.id==='occurrence'));
  assert.equal(all.some(t=>t.id==='foreign'),false);
  assert.deepEqual((await store.searchQueueTasks({query:'No such title'},owner)).tasks,[]);
  assert.equal((await store.searchQueueTasks({query:'earlier'},owner)).tasks[0].id,'older');
  assert.equal((await store.search({query:'Closed completed'},owner)).tasks[0].id,'status-completed','broad search retains completed history');
  assert.ok((await store.search({query:'Weekly definition'},owner)).tasks.some(t=>t.id==='definition'),'broad search retains recurrence definitions');
  await assert.rejects(store.searchQueueTasks({offset:-1},owner));
  const express=require('express'),app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={userId:1};req.workspaceId='ws-1';next();});
  require('./routes/working-queue')(app,ctx,{enabled:true});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/working-queue/tasks?query=earlier');assert.equal(response.status,200);assert.equal((await response.json()).tasks[0].id,'older');
  const old=process.env.DCC_CONVERSATION_ENABLED;process.env.DCC_CONVERSATION_ENABLED='true';t.after(()=>{if(old===undefined)delete process.env.DCC_CONVERSATION_ENABLED;else process.env.DCC_CONVERSATION_ENABLED=old;});
  for(const [id,,wanted] of cases){
    if(wanted)continue;
    const prior=await store.state(owner),events=(await store.history(owner)).length;
    const result=await fetch(base+'/api/working-queue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'queue-add',taskId:id,sourceEventId:'forbidden-'+id,expectedRevision:prior.revision,at:new Date().toISOString()})});
    assert.ok([404,409].includes(result.status),id+' direct route rejected');
    assert.equal((await store.state(owner)).revision,prior.revision);assert.equal((await store.history(owner)).length,events,'no audit event for rejected add');
  }
  for(const id of ['ordinary','older','occurrence','task-notes'])await store.execute({action:'queue-add',taskId:id,sourceEventId:'valid-'+id,expectedRevision:(await store.state(owner)).revision,at:new Date().toISOString()},owner);
  assert.deepEqual((await ctx.pool.query('SELECT id,properties FROM blocks ORDER BY id')).rows,before,'all note/task data retained exactly');
});
