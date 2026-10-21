const test=require('node:test');
const assert=require('node:assert/strict');
const priority=require('./public/js/task-priority');
const model=require('./public/js/task-model');
const serializer=require('./public/js/task-serialize');
const {normalizeTemplateTree,buildResponsibilityTaskProps}=require('./responsibility-store');
test('Medium is the default; retired flags and unrecognized values cannot promote a task',()=>{
 for(const value of [undefined,null,'','urgent','critical','p1',true,{},'Normal'])assert.equal(priority.normalize(value),'Medium');
 for(const old of ['Low','High','urgent'])assert.equal(priority.read({priority:old,urgent:true,stage:'Priority'}),'Medium');
 assert.equal(serializer.taskBlockProps({title:'New'}).taskPriority,'Medium');
});
test('all explicit choices survive serialization and a JSON reload without changing timing or legacy values',()=>{
 for(const value of ['Low','Medium','High']){
  const task={id:'t',title:'Task',taskPriority:value,priority:'urgent',start:'10:00',end:'10:30',durMin:30};
  const props=serializer.taskBlockProps(task);
  const row=JSON.parse(JSON.stringify({id:'row',type:'block',date:'2026-10-21',sort_order:2000,properties:props}));
  const loaded=model.fromBlock(row);
  assert.equal(loaded.taskPriority,value);assert.equal(loaded.priority,'urgent');
  assert.equal(loaded.start,'10:00');assert.equal(loaded.end,'10:30');assert.equal(row.sort_order,2000);
 }
});
test('explicit priority survives repeat/template copies while stale template flags default Medium',()=>{
 const tree=normalizeTemplateTree({version:1,root:{title:'Root',taskPriority:'High',children:[{title:'Child',edge:'subtask',durationMin:10,taskPriority:'Low'},{title:'Legacy',priority:'High'}]}});
 assert.equal(tree.root.taskPriority,'High');assert.equal(tree.root.children[0].taskPriority,'Low');assert.equal(tree.root.children[1].taskPriority,'Medium');
 const props=buildResponsibilityTaskProps({id:'r',properties:{title:'Repeat',taskPriority:'Low'}},{duration:30,slot:{start:'10:00',end:'10:30'},localId:'t'});
 assert.equal(props.taskPriority,'Low');
});

test('priority List is a stable partition, includes absent priorities and never changes source data',()=>{
 const tasks=[{id:'m1',priority:'High',start:'09:00'},{id:'l',taskPriority:'Low',start:'10:00'},
  {id:'h2',taskPriority:'High',start:'12:00',manualOrder:1},{id:'h1',taskPriority:'High',start:'11:00',manualOrder:2},
  {id:'m2',taskPriority:'invalid',untimed:true}];
 const before=JSON.stringify(tasks);
 assert.deepEqual(priority.group(tasks.concat(tasks[0])).map(g=>[g.priority,g.tasks.map(t=>t.id)]),
  [['High',['h2','h1']],['Medium',['m1','m2']],['Low',['l']]]);
 assert.equal(JSON.stringify(tasks),before);
 tasks[0].taskPriority='Low';
 assert.deepEqual(priority.group(tasks).map(g=>g.tasks.map(t=>t.id)),[['h2','h1'],['m2'],['m1','l']]);
 assert.equal(tasks[0].start,'09:00');
});
test('priority grouping preserves day exclusions and completion scope',()=>{
 const tasks=[{id:'normal',type:'task',start:'09:00',end:'09:30'},
  {id:'unscheduled',type:'task',untimed:true,taskPriority:'High'},
  {id:'project',type:'task',taskPriority:'High'},
  {id:'deleted',type:'task',taskPriority:'High'},
  {id:'waiting',type:'task',taskPriority:'High'}];
 const opts={today:'2026-10-21',isDone:()=>false,isDeleted:task=>task.id==='deleted',trivialFlags:{project:true},
  waitingRows:[{id:'wait-row',type:'block',properties:{kind:'delegated_item',status:'open',linkedBlockId:'waiting'}}]};
 const day=model.selectDay(tasks,'2026-10-21',opts);
 const ids=priority.group(day.timed.concat(day.unscheduled)).flatMap(g=>g.tasks.map(t=>t.id));
 assert.deepEqual(ids,['unscheduled','normal']);
});
test('List preserves manual tree order within groups while exposing children independently of collapse',()=>{
 const tasks=[{id:'child',type:'task',subtaskOf:'parent',taskPriority:'High'},
  {id:'parent',type:'task',taskPriority:'High'},
  {id:'other',type:'task',taskPriority:'High'},
  {id:'done-child',type:'task',subtaskOf:'parent',taskPriority:'Low'}];
 const day=model.selectDay(tasks,'2026-10-21',{today:'2026-10-21',isDone:t=>t.id==='done-child',isDeleted:()=>false,trivialFlags:{}});
 const ordered=model.selectTree(day.timed.concat(day.unscheduled),{pool:day.visible,isCollapsed:()=>false}).map(n=>n.ev);
 assert.deepEqual(priority.group(ordered)[0].tasks.map(t=>t.id),['parent','child','other']);
 assert.equal(ordered.some(t=>t.id==='done-child'),false,'finished subtask remains in parent details');
 tasks[0].taskPriority='Low';
 assert.deepEqual(priority.group(ordered).map(g=>g.tasks.map(t=>t.id)),[['parent','other'],[],['child']]);
});
