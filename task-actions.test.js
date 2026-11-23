const test=require('node:test');
const assert=require('node:assert/strict');
const TM=require('./public/js/task-model');
const {create}=require('./public/js/task-actions');
const {performance}=require('node:perf_hooks');
const account={userId:1,workspaceId:'test'};
const row=(id,properties={},date='2026-11-22')=>({id,type:'block',date,properties:{kind:'task',title:id,...properties}});
const fixture=()=>TM.projectCollection([
  row('p',{local_id:'legacy-p'}),row('c',{local_id:'legacy-c',subtaskOf:'p'}),
  row('g',{subtaskOf:'legacy-c'}),row('r',{wrapId:'p'})
]);
function element(){return {style:{display:''},attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}};}

test('one collection resolves exact IDs and aliases before selectors and never changes stored edges',()=>{
  const blocks=[row('p',{local_id:'legacy-p'}),row('c',{subtaskOf:'p'})];
  const saved=structuredClone(blocks),pool=TM.projectCollection(blocks);
  assert.equal(pool[1].subtaskOf,'legacy-p');
  assert.deepEqual(TM.selectRoots(pool).map(ev=>ev.id),['legacy-p']);
  assert.deepEqual(TM.actionTargets('legacy-p',pool).map(ev=>ev._canonicalTaskId),['p','c']);
  assert.deepEqual(blocks,saved);
});

test('completed and out-of-window parents remain nonactionable context for open children',()=>{
  const pool=TM.projectCollection([row('p',{status:'done'},'2026-10-01'),row('c',{subtaskOf:'p'})]);
  pool[0]._contextOnly=true;pool[0].__unf={done:true};pool[1].__unf={done:false};
  const visible=TM.selectCarryover(pool),tree=TM.selectTree(visible,{isCollapsed:()=>false});
  assert.deepEqual(tree.map(node=>[node.ev._canonicalTaskId,node.depth]),[['p',0],['c',1]]);
  assert.equal(TM.hierarchyLabel(tree[0].ev),'Parent context');
  assert.equal(visible.filter(ev=>!ev._contextOnly&&!ev.__unf.done).length,1);
});
test('Glasses counts unfinished groups through the shared hierarchy, including completed-parent context',()=>{
  const M=require('./public/js/glasses-model');
  const view=M.project({date:'2026-11-23',blocks:[],globals:[],dayState:{}},{rows:[row('p',{status:'done'}),row('c',{subtaskOf:'p'}),row('other')]});
  assert.equal(view.queues.find(queue=>queue.id==='loose').count,2);
  assert.deepEqual(view.earlier.map(task=>[task.taskId,task.depth]),[['p',0],['c',1],['other',0]]);
  assert.ok(!view.todos.some(task=>task.taskId==='p'));
});

test('missing, ambiguous and duplicate legacy references never become invented standalone tasks',()=>{
  const missing=TM.projectCollection([row('c',{subtaskOf:'gone'})]);
  assert.equal(missing[0].subtaskOf,'gone');
  assert.match(TM.hierarchyLabel(missing[0]),/Subtask: parent unavailable/);
  const pool=TM.projectCollection([row('a',{local_id:'duplicate'}),row('b',{local_id:'duplicate'}),row('c',{subtaskOf:'duplicate'})]);
  assert.deepEqual(pool.map(ev=>ev.id),['a','b','c']);
  assert.equal(pool[2]._hierarchyIssue,'ambiguous-parent');
  assert.throws(()=>TM.actionTargets('a',pool),/ambiguous/);
});

test('aliases resolve within dates while exact canonical references retain cross-date ancestry',()=>{
  const pool=TM.projectCollection([row('a',{local_id:'daily'},'2026-11-21'),row('b',{local_id:'daily'}),row('c',{subtaskOf:'daily'}),row('d',{subtaskOf:'a'})]);
  assert.equal(pool[2]._parentTaskId,'b');assert.equal(pool[3]._parentTaskId,'a');
});

test('completion excludes independent ride-alongs and deletion keeps the complete tree',()=>{
  const pool=fixture(),actions=create({account:()=>account,pool:()=>pool});
  assert.deepEqual(actions.targetList('p','2026-11-22').map(t=>t.id),['p','c','g']);
  assert.deepEqual(TM.actionTargets('p',pool).map(t=>t._canonicalTaskId),['p','c','g','r']);
});
test('registered menu copies deduplicate canonically without confusing another task alias',()=>{
  const pool=fixture(),actions=create({account:()=>account,pool:()=>pool.map(task=>({...task,_taskDate:null}))});
  actions.registerPool('library',()=>pool);
  assert.deepEqual(actions.targetList('p','2026-11-22').map(t=>t.id),['p','c','g']);
  actions.capture({token:'canonical',action:'delete',targets:['p']});
  assert.equal(actions.stateFor({_blockId:'different',id:'p'}),null);
});

test('two-second write updates every bound menu within 100ms and duplicate clicks share one write',async()=>{
  const pool=fixture(),actions=create({account:()=>account,pool:()=>pool});
  const copies=Array.from({length:6},()=>element());
  copies.forEach(el=>actions.bind(el,pool[0]));
  actions.subscribe(()=>copies.forEach(el=>el.__dccTaskActionUpdate()));
  let writes=0;
  const write=()=>{writes++;actions.captureWrite({op:'completion',id:'p',data:{completed:true,taskDate:'2026-11-22'},_walId:'durable'});
    return new Promise(resolve=>setTimeout(()=>{actions.finish('durable');resolve({ok:true});},2000));};
  const started=performance.now(),first=actions.run({task:pool[0],action:'complete',write});
  assert.equal(actions.run({task:pool[0],action:'complete',write}),first);
  assert.ok(performance.now()-started<100);
  assert.ok(copies.every(el=>el.style.display==='none'));
  assert.equal(writes,1);await first;
});

test('a rejected older completion cannot undo a newer restore or another task',()=>{
  const actions=create({account:()=>account}),a=element(),b=element();
  actions.bind(a,{id:'a'});actions.bind(b,{id:'b'});
  actions.subscribe(()=>{a.__dccTaskActionUpdate();b.__dccTaskActionUpdate();});
  actions.capture({token:'first',action:'delete',targets:['a','b']});
  actions.capture({token:'newer',action:'restore',targets:['a']});
  actions.finish('first','rejected');
  assert.equal(a.style.display,'');assert.equal(b.style.display,'');
  assert.equal(actions.stateFor({id:'a'}).token,'newer');
});
test('receipt reconciliation cannot acknowledge another outbox or an in-flight Undo',()=>{
  const actions=create({account:()=>account});
  actions.captureWrite({op:'completion',id:'task',data:{completed:true},_walId:'wal'});
  actions.capture({source:'delete-undo',token:'undo',action:'restore',targets:['other']});
  actions.capture({source:'queue-transition',token:'queue-undo',action:'reopen',targets:['third']});
  actions.settleMissing('blockstore',[]);
  assert.equal(actions.stateFor({id:'task'}).status,'confirmed');
  assert.equal(actions.stateFor({id:'other'}).status,'pending');
  actions.settleMissing('queue-completion',[]);
  assert.equal(actions.stateFor({id:'third'}).status,'pending');
});

test('reload recovery uses the existing receipt, keeps pending over stale reads, and isolates accounts',()=>{
  let current=account;
  const entries=[{op:'completion',id:'a',data:{completed:true,mutationId:'m',taskDate:'2026-11-22'},_walId:'wal',meta:{taskTargets:[{id:'a'},{id:'b'}]}}];
  const actions=create({account:()=>current});actions.restore(entries);
  actions.reconcile([row('a'),row('b')],actions.readToken());
  assert.equal(actions.stateFor({id:'b'}).status,'pending');
  const staleRead=actions.readToken();actions.finish('wal');
  actions.reconcile([row('a'),row('b')],staleRead);
  assert.equal(actions.stateFor({id:'a'}).status,'confirmed');
  actions.reconcile([row('a'),row('b')],actions.readToken());
  assert.equal(actions.stateFor({id:'a'}),null);
  actions.restore(entries);current={userId:2,workspaceId:'other'};
  assert.equal(actions.stateFor({id:'a'}),null);assert.equal(actions.pending().length,0);
});
