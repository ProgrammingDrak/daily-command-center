const test=require('node:test');const assert=require('node:assert/strict');
const TimeBlocks=require('./public/js/time-blocks');
test('only review-sourced roots enter Triage; manual, repeats and waiting stay reachable',()=>{
 const rows=[
  {id:'manual',untimed:true},
  {id:'flag-only',untimed:true,triageBlock:true},
  {id:'message',untimed:true,triageBlock:true,triageId:'slack:123',triageSourceRef:'https://example.slack.com/archives/123'},
  {id:'meeting',untimed:true,triageBlock:true,triageId:'meeting:456'},
  {id:'key',untimed:true,triageBlock:true,triageKey:'slack:key'},
  {id:'context',untimed:true,triageBlock:true,triageContext:{id:'meeting:context'}},
  {id:'repeat',untimed:true,triageBlock:true,triageId:'repeat:1',responsibilityId:'r1'},
  {id:'delegated',untimed:true,triageBlock:true,triageId:'slack:delegated',delegatedItemId:'d1'},
  {id:'followup',untimed:true,triageBlock:true,triageId:'waiting:1',triageContext:{waiting_item_id:'w1'}},
 ];
 const before=JSON.stringify(rows);
 const groups=TimeBlocks.groupItineraryTree(rows.map(ev=>({depth:0,ev})),[]);
 assert.deepEqual(groups[0].nodes.map(n=>n.ev.id),['message','meeting','key','context']);
 assert.deepEqual(groups.at(-1).nodes.map(n=>n.ev.id),['manual','flag-only','repeat','delegated','followup']);
 assert.equal(JSON.stringify(rows),before,'presentation grouping must not rewrite identity or provenance');
});
