const test=require('node:test');
const assert=require('node:assert/strict');
const TM=require('./public/js/task-model');
test('raw block subtree preserves canonical parent grouping, legacy aliases and parent_id fallback',()=>{
 const row=(id,order,p={},extra={})=>({id,date:'2026-10-31',sort_order:order,properties:{title:id,local_id:'local-'+id,...p},...extra});
 const rows=[row('root',0),row('a',10,{subtaskOf:'local-root'}),row('b',20,{subtaskOf:'root'}),row('child-a',30,{}, {parent_id:'a'}),row('grandchild',40,{subtaskOf:'local-child-a'})];
 const before=structuredClone(rows),nodes=TM.fromBlocksTree(rows);
 assert.deepEqual(nodes.map(n=>[n.ev._blockId,n.depth]),[['root',0],['a',1],['child-a',2],['grandchild',3],['b',1]]);
 assert.deepEqual(nodes.map(n=>n.ev),['root','a','child-a','grandchild','b'].map(id=>TM.fromBlock(rows.find(row=>row.id===id))));
 assert.deepEqual(rows,before);
});
test('raw tree aliases stay date-scoped and ambiguous aliases do not invent nesting',()=>{
 const rows=[{id:'one',date:'2026-10-30',properties:{local_id:'repeat'}},{id:'two',date:'2026-10-31',properties:{local_id:'repeat'}},{id:'kid',date:'2026-10-31',properties:{subtaskOf:'repeat'}}];
 assert.deepEqual(TM.fromBlocksTree(rows).map(n=>[n.ev._blockId,n.depth]),[['one',0],['two',0],['kid',1]]);
 rows.push({id:'duplicate',date:'2026-10-31',properties:{local_id:'repeat'}});
 assert.equal(TM.fromBlocksTree(rows).find(n=>n.ev._blockId==='kid').depth,0);
});
