const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const TM=require('./public/js/task-model'),S=require('./public/js/task-serialize'),placement=require('./lib/whenever-placement');
const row=(id,props={},date=null)=>({id:'row-'+id,type:'block',date,workspace_id:'mine',updated_at:'2026-10-06T12:00:00Z',properties:{local_id:id,title:id,type:'task',kind:'backlog',stage:'Whenever',duration:30,durMin:30,publicVisibility:'private',...props}});
const tree=()=>[row('parent',{source_id:'https://clever.slack.com/archives/C1/p1',tags:['test'],detail:'Notes',sourceReferences:[{kind:'file',url:'https://example.com/original.pdf',name:'Original.pdf'}]}),row('sub',{subtaskOf:'parent',duration:0,durMin:0}),row('nested',{wrapId:'parent',duration:15,durMin:15}),row('deep',{subtaskOf:'nested',duration:0,durMin:0})];
function slice(file,start,end){const source=fs.readFileSync(require.resolve(file),'utf8');return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('Whenever projection retains full task fields, deep edges and zero-duration steps after reload',()=>{
 const rows=tree(),items=rows.map(TM.fromBacklogBlock);
 assert.equal(items[0].source_id,rows[0].properties.source_id);assert.deepEqual(items[0].sourceReferences,rows[0].properties.sourceReferences);assert.equal(items[0].publicVisibility,'private');assert.equal(items[1].duration,0);
 assert.deepEqual(TM.selectTree(items,{isCollapsed:()=>false}).map(node=>[node.ev.id,node.depth]),[['parent',0],['sub',1],['nested',1],['deep',2]]);
 assert.equal(TM.hierarchyRoot('deep',items).id,'parent');
});
test('canonical placement moves every edge and keeps identities, privacy and provenance',()=>{
 const rows=tree();const out=placement.plan(rows[0],rows,{targetDate:'2026-10-06',placement:{kind:'whenever_schedule'},parentStart:'10:00',parentEnd:'10:30'});
 assert.deepEqual(out.ids,rows.map(r=>r.id));assert.ok(out.moves.every(m=>m.date==='2026-10-06'));
 assert.equal(out.moves[1].properties.duration,0);assert.equal(out.moves[1].properties.start,out.moves[1].properties.end);assert.equal(out.moves[3].properties.subtaskOf,'nested');assert.equal(out.moves[2].properties.wrapId,'parent');
 assert.equal(out.moves[0].properties.source_id,rows[0].properties.source_id);assert.deepEqual(out.moves[0].properties.sourceReferences,rows[0].properties.sourceReferences);assert.equal(out.moves[0].properties.publicVisibility,'private');
 const dated=out.moves.map((m,i)=>({...rows[i],date:m.date,properties:m.properties}));
 const back=placement.plan(dated[0],dated,{targetDate:null,placement:{kind:'whenever'}});
 assert.ok(back.moves.every(m=>m.date===null&&m.properties.stage==='Whenever'&&m.properties.kind==='backlog'));
 assert.ok(back.moves.every(m=>m.expectedDate==='2026-10-06'));assert.equal(back.moves[3].properties.subtaskOf,'nested');
});
test('subtree collector follows database parent_id edges too and refuses invalid placements',()=>{
 const rows=tree();rows.push({...row('column-only'),parent_id:rows[2].id});
 assert.equal(placement.plan(rows[0],rows,{targetDate:null,placement:{kind:'whenever'}}).ids.length,5);
 assert.throws(()=>placement.plan(rows[0],rows,{targetDate:'2026-10-06',placement:{kind:'whenever'}}));
 assert.throws(()=>placement.plan(rows[0],rows,{targetDate:null,placement:{kind:'whenever',stage:'Arbitrary'}}));
 assert.throws(()=>placement.plan({...rows[0],deleted_at:'now'},rows,{targetDate:null,placement:{kind:'whenever'}}));
 assert.throws(()=>placement.plan({...rows[0],date:'2026-10-06'},rows,{targetDate:'2026-10-07',placement:{kind:'whenever_schedule'},parentStart:'10:00',parentEnd:'10:30'}));
});
test('ordinary subtask and nested creators persist dateless children of Whenever and support another level',async()=>{
 const rows=tree().slice(0,1),backlog=rows.map(TM.fromBacklogBlock),calls=[];
 const ctx=vm.createContext({window:{DCC:{taskCommonProps:S.taskCommonProps,taskBlockProps:S.taskBlockProps},blockStore:{createBlock:async(type,properties,extra)=>{const r={id:'created-'+calls.length,type,properties,date:extra.date};calls.push(r);return r;}}},backlog,scheduled:[],viewDate:'2026-10-06',render(){},taskAnchorById:id=>({ev:backlog.find(t=>t.id===id),date:null,whenever:true}),fmt:m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),pt:s=>Number(s.slice(0,2))*60+Number(s.slice(3))});
 vm.runInContext(slice('./public/js/tabs','function addSubtask(','// Re-read the carryover'),ctx);
 vm.runInContext(slice('./public/js/tabs','function addStackedTask(','// Re-parent an EXISTING'),ctx);
 const sub=ctx.addSubtask('parent','Step');await sub._persisted;
 const nested=ctx.addStackedTask('parent','Nested task',15);await Promise.resolve();
 const deep=ctx.addSubtask(nested.id,'Deep step');await deep._persisted;
 assert.equal(ctx.scheduled.length,0);assert.equal(backlog.length,4);assert.ok(calls.every(r=>r.date===null&&r.properties.stage==='Whenever'&&r.properties.publicVisibility==='private'));
 assert.equal(calls[0].properties.subtaskOf,'parent');assert.equal(calls[1].properties.wrapId,'parent');assert.equal(calls[2].properties.subtaskOf,nested.id);assert.equal(calls[0].properties.duration,0);
 const reloaded=[...rows,...calls].map(TM.fromBacklogBlock);assert.deepEqual(TM.selectTree(reloaded,{isCollapsed:()=>false}).map(n=>n.depth),[0,1,1,2]);
});
test('pool deletion uses the same subtree resolver for child and grandchild ids',()=>{
 const items=tree().map(TM.fromBacklogBlock),ctx=vm.createContext({scheduled:[],parentIdOf:TM.parentIdOf});
 vm.runInContext(slice('./public/js/state','function _subtreeIdsOf(','// Optimistically drop'),ctx);
 assert.deepEqual([...ctx._subtreeIdsOf('parent',items)],['parent','sub','nested','deep']);
});
function mount(rows){
 const handlers={},writes=[];const ctx={isValidDate:d=>/^\d{4}-\d{2}-\d{2}$/.test(d||''),broadcast(){},blockDB:{getBlockIncludingDeleted:async id=>rows.find(r=>r.id===id),getRescheduleSubtreePool:async()=>rows,rescheduleBlocks:async(moves)=>{writes.push(moves);return {blocks:moves};}}};
 const app={get(){},post(path,handler){handlers[path]=handler;},patch(){},delete(){},put(){}};require('./routes/blocks')(app,ctx);
 return {writes,call:async(body)=>{let status=200,result;await handlers['/api/blocks/:id/reschedule']({params:{id:rows[0].id},body,workspaceId:'mine',session:{userId:1}},{status(code){status=code;return this;},json(value){result=value;return this;}});return {status,result};}};
}
test('HTTP mover delegates the whole tree once and refuses a foreign descendant before any write',async()=>{
 const rows=tree(),f=mount(rows);const result=await f.call({targetDate:null,placement:{kind:'whenever'}});
 assert.equal(result.status,200);assert.equal(result.result.count,4);assert.equal(f.writes.length,1);
 rows[3].workspace_id='someone-else';const denied=mount(rows);const bad=await denied.call({targetDate:null,placement:{kind:'whenever'}});
 assert.ok(bad.status>=400);assert.equal(denied.writes.length,0);
});
test('a denied root and invalid schedule never mutate the pool',async()=>{
 const rows=tree();rows[0].workspace_id='someone-else';const denied=mount(rows);assert.ok((await denied.call({targetDate:null,placement:{kind:'whenever'}})).status>=400);assert.equal(denied.writes.length,0);
 const f=mount(tree());assert.equal((await f.call({targetDate:'2026-10-06',placement:{kind:'whenever_schedule'},parentStart:'24:01',parentEnd:'25:00'})).status,400);assert.equal(f.writes.length,0);
});


test('pool reparenting uses the two normal edges, persists parent_id and rejects cycles',()=>{
 const items=tree().map(TM.fromBacklogBlock),calls=[];
 const ctx=vm.createContext({window:{},parentIdOf:TM.parentIdOf,backlog:items,scheduled:[],render(){},taskAnchorById:id=>({ev:items.find(item=>item.id===id),whenever:true,blockId:'row-'+id}),enqueueRowPropsWrite:(id,merge,extra)=>calls.push({id,properties:merge({}),extra})});
 vm.runInContext(slice('./public/js/drag','function _isAncestor(','// First free slot'),ctx);
 vm.runInContext(slice('./public/js/tabs','function reparentAsSubtask(','// Popover anchored'),ctx);
 assert.equal(ctx.reparentAsSubtask('parent','deep',{nested:true}),false);assert.equal(calls.length,0);
 assert.equal(ctx.reparentAsSubtask('sub','nested',{nested:true}),true);assert.equal(items[1].wrapId,'nested');assert.equal(items[1].subtaskOf,null);assert.equal(calls[0].extra.parent_id,'row-nested');
 assert.equal(ctx.reparentAsSubtask('sub','parent'),true);assert.equal(items[1].subtaskOf,'parent');assert.equal(items[1].wrapId,null);assert.equal(items[1].duration,0);
});

test('pool duration overrides are bounded and can only name members of the moved tree',()=>{
 const rows=tree();
 assert.throws(()=>placement.plan(rows[0],rows,{targetDate:null,placement:{kind:'whenever',durations:{'row-parent':1441}}}));
 assert.throws(()=>placement.plan(rows[0],rows,{targetDate:null,placement:{kind:'whenever',durations:{foreign:20}}}));
 const result=placement.plan(rows[0],rows,{targetDate:null,placement:{kind:'whenever',durations:{'row-parent':45,'row-sub':0}}});
 assert.equal(result.moves[0].properties.duration,45);assert.equal(result.moves[1].properties.duration,0);
});


test('moving a saved scheduled parent to Whenever delegates its full duration map once',async()=>{
 const rows=tree().map(r=>({...r,date:'2026-10-06'})),items=rows.map(TM.fromBlock),calls=[];
 const ctx=vm.createContext({scheduled:items,window:{blockStore:{rescheduleBlock:async(...args)=>calls.push(args)}},_viewedDateStr:()=> '2026-10-06',_findTaskBlockForDate:id=>rows.find(r=>r.properties.local_id===id),_subtreeIdsOf:id=>new Set(items.filter(t=>t.id===id||TM.hierarchyRoot(t.id,items).id===id).map(t=>t.id)),dur:t=>rows.find(r=>r.properties.local_id===t.id).properties.duration,refoldTaskStateFromBlockCache(){},render(){}});
 vm.runInContext(slice('./public/js/state','async function moveTaskToWhenever(','// Convert an existing scheduled'),ctx);
 assert.equal(await ctx.moveTaskToWhenever('parent'),true);assert.equal(calls.length,1);assert.equal(calls[0][0],'row-parent');assert.equal(calls[0][1],null);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2].placement)),{kind:'whenever',durations:{'row-parent':30,'row-sub':0,'row-nested':15,'row-deep':0}});
});


test('Whenever canonical rows suppress original timeline seeds without day deletion overlays',()=>{
 const rows=tree(),items=rows.map(TM.fromBlock);
 const keep={id:'other',title:'Other task'};
 assert.deepEqual(TM.suppressWheneverSeeds([...items,keep],rows),[keep]);
 assert.deepEqual(TM.suppressWheneverSeeds(items,rows.map(row=>({...row,date:'2026-10-06'}))),items);
 const otherRow={...items[0],_blockId:'unrelated-row'};assert.deepEqual(TM.suppressWheneverSeeds([otherRow],rows),[otherRow]);
 assert.ok(fs.readFileSync(require.resolve('./public/js/persistence'),'utf8').includes('scheduled=TM.suppressWheneverSeeds(scheduled,window.blockStore.getByType("block"))'));
});
