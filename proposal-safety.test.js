const test = require("node:test");
const assert = require("node:assert/strict");
const { ingestDeepSweepPacket } = require("./dcc-intelligence");
const { sourceKeys } = require("./lib/proposal-sources");
const ID = "slack:mention:C000000TEST:1790791513.460309";
const packet = (id="packet-1", proposalId=ID) => ({ id, generated_at:"2026-09-30T19:30:00Z", source:"Drakula",
  suggested_tasks:[{id:proposalId,source_item_id:ID,title:"Original source wording",reason:"Original reason"}] });
const base = () => ({date:"2026-09-30",triage:{open_items:[],resolved_items:[]},notes:{human:"preserve"},
  schedule:{day_start:"09:30"},glymphatic_context:{suggested_tasks:[{id:ID,source_item_id:ID,title:"Human edited title",reason:"Human edited reason"}]},
  glymphatic_brief:{decisions:{},decision_log:[],current:{}}});
test("same source preserves human proposal content even with changed proposal id", () => {
 const state=base(), out=ingestDeepSweepPacket({date:state.date,state,packet:packet("packet-1","new-wrapper-id")});
 assert.deepEqual(out.glymphatic_context.suggested_tasks,state.glymphatic_context.suggested_tasks);
 assert.deepEqual(out.notes,state.notes); assert.deepEqual(out.schedule,state.schedule);
 assert.equal(out.glymphatic_brief.current.suggested_tasks[0].title,"Human edited title");
});
test("identical packet is an exact no-op, including after more than ten newer packets", () => {
 let state=ingestDeepSweepPacket({date:"2026-09-30",state:base(),packet:packet()});
 const first=state;
 assert.equal(ingestDeepSweepPacket({date:state.date,state,packet:packet()}),state);
 for(let n=0;n<12;n++)state=ingestDeepSweepPacket({date:state.date,state,packet:packet("later-"+n)});
 assert.equal(ingestDeepSweepPacket({date:state.date,state,packet:packet()}),state);
 assert.equal(first.deep_sweep.packet_count,1);
});
test("dropped, accepted, scheduled and backlogged native IDs are not re-offered", () => {
 for(const action of ["drop","accept","schedule","backlog"]){
  const state=base();state.glymphatic_brief.decisions[ID]={action};
  const out=ingestDeepSweepPacket({date:state.date,state,packet:packet()});
  assert.equal(out.glymphatic_context.suggested_tasks.length,0);
  assert.equal(out.glymphatic_brief.current.suggested_tasks.length,0);
  assert.deepEqual(out.glymphatic_brief.decisions,state.glymphatic_brief.decisions);
 }
});
test("completed/deleted and database-suppressed exact sources are not resurrected", () => {
 for(const field of ["done","deleted"]){
  const state=base();state[field]={[ID]:true};
  assert.equal(ingestDeepSweepPacket({date:state.date,state,packet:packet()}).glymphatic_context.suggested_tasks.length,0);
 }
 const state=base();
 assert.equal(ingestDeepSweepPacket({date:state.date,state,packet:packet(),suppressedSourceIds:[ID]}).glymphatic_context.suggested_tasks.length,0);
});
test("compact publication losing context still preserves existing reviewed proposal title", () => {
 const state=base(); state.glymphatic_brief.current.suggested_tasks=state.glymphatic_context.suggested_tasks;delete state.glymphatic_context;
 assert.equal(ingestDeepSweepPacket({date:state.date,state,packet:packet()}).glymphatic_context.suggested_tasks[0].title,"Human edited title");
});
test("Slack bookmark alias names exactly one native turn", () => {
 assert.ok(sourceKeys([ID]).includes("slack-bookmark:C000000TEST:1790791513.460309"));
 assert.ok(!sourceKeys([ID]).includes("slack-bookmark:C000000TEST:1790791514.460309"));
});

// Exercise the actual persistence seam with a transaction-scoped fake client.
let scenario;
const poolPath=require.resolve("./pg-pool");
const fake={connect:async()=>({query:async(sql,args)=>{
 scenario.calls.push({sql,args});
 if(sql.startsWith("SELECT state_json"))return {rows:[{state_json:scenario.state}]};
 if(sql.startsWith("SELECT * FROM blocks")){
  assert.ok(!sql.includes("deleted_at IS NULL")); assert.equal(args[0],"ws-owned");
  if(scenario.fail)throw Error("source lookup unavailable");
  return {rows:scenario.matches||[]};
 }
 if(sql.includes("jsonb_each"))return {rows:scenario.decisions||[]};
 return {rows:[]};
},release:()=>{scenario.released=true;}})};
require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:fake};
const db=require("./db");
test("transaction checks cross-date tombstones and prior decisions before saving",async()=>{
 scenario={state:base(),calls:[],matches:[{id:"gone",deleted_at:"yesterday",properties:{triageId:ID}}],decisions:[]};
 const out=await db.mergeDccProposalPacket("2026-09-30",packet(),1,"ws-owned",{},"Drakula");
 assert.deepEqual(out.suppressedSourceIds,[ID]);assert.deepEqual(out.acceptedSourceIds,[]);
 assert.ok(scenario.calls.some(x=>x.sql.includes("pg_advisory_xact_lock")));
 assert.ok(scenario.calls.some(x=>x.sql.includes("FOR UPDATE")));
 assert.equal(scenario.calls.at(-1).sql,"COMMIT");assert.equal(scenario.released,true);
 scenario={state:base(),calls:[],decisions:[{key:ID}]};
 assert.deepEqual((await db.mergeDccProposalPacket("2026-09-30",packet(),1,"ws-owned",{},"Drakula")).acceptedSourceIds,[]);
});
test("failed source lookup rolls back without saving, and dry run never inserts",async()=>{
 scenario={state:base(),calls:[],fail:true};
 await assert.rejects(db.mergeDccProposalPacket("2026-09-30",packet(),1,"ws-owned",{},"Drakula"),/source lookup unavailable/);
 assert.ok(!scenario.calls.some(x=>x.sql.startsWith("INSERT")));assert.equal(scenario.calls.at(-1).sql,"ROLLBACK");
 scenario={state:base(),calls:[]};
 await db.mergeDccProposalPacket("2026-09-30",packet(),1,"ws-owned",{},"Drakula",true);
 assert.ok(!scenario.calls.some(x=>x.sql.startsWith("INSERT")));assert.equal(scenario.calls.at(-1).sql,"ROLLBACK");
});

test("suppression receipt never reveals sources absent from the incoming packet",async()=>{
 scenario={state:base(),calls:[],matches:[{id:"gone",properties:{triageId:ID}}]};
 const out=await db.mergeDccProposalPacket("2026-09-30",{id:"empty-packet",suggested_tasks:[]},1,"ws-owned",{},"Drakula",true);
 assert.deepEqual(out.suppressedSourceIds,[]);
});

test("settled wrapper IDs also suppress renamed proposals for the same native source",()=>{
 const state=base();state.glymphatic_context.suggested_tasks[0].id="old-wrapper";state.glymphatic_brief.decisions={"old-wrapper":{action:"drop"}};
 const out=ingestDeepSweepPacket({date:state.date,state,packet:packet("new-packet","new-wrapper")});
 assert.deepEqual(out.glymphatic_context.suggested_tasks,[]);
});
test("cross-date settled wrapper receipt resolves to submitted native identities only",async()=>{
 scenario={state:base(),calls:[],decisions:[{key:"older-wrapper",proposal:{id:"older-wrapper",source_item_id:ID}}]};
 const out=await db.mergeDccProposalPacket("2026-09-30",packet("new-packet","new-wrapper"),1,"ws-owned",{},"Drakula");
 assert.deepEqual(out.acceptedSourceIds,[]);assert.deepEqual(out.suppressedSourceIds,[ID]);
});

test("reviewed packets use the existing front review surface without replacing authored pages or accepted human edits",()=>{
 const state=base();const accepted={id:"accepted",source_item_id:"gmail:accepted:source",title:"Human plan",reason:"Human rationale"};
 state.glymphatic_context.pages=[{id:"front",label:"Human front",tomorrow:[accepted]},{id:"organism",summary:"Human page"}];
 state.glymphatic_brief.decisions.accepted={action:"accept"};
 const p=packet();p.reviewed_findings=true;
 const out=ingestDeepSweepPacket({date:state.date,state,packet:p});
 const front=out.glymphatic_brief.current.pages.find(x=>x.id==="front");
 assert.equal(front.label,"Human front");assert.deepEqual(front.tomorrow[0],accepted);assert.equal(front.tomorrow[1].title,"Human edited title");
 assert.deepEqual(out.glymphatic_brief.current.pages.find(x=>x.id==="organism"),state.glymphatic_context.pages[1]);
});
test("reviewed proposals create a visible front only when admitted and learning proposals retain authored pages",()=>{
 const state=base();delete state.glymphatic_context;state.glymphatic_brief.current.pages=[{id:"organism",summary:"Keep"}];
 const p=packet();p.reviewed_findings=true;
 const out=ingestDeepSweepPacket({date:state.date,state,packet:p});assert.equal(out.glymphatic_brief.current.pages[0].id,"front");assert.equal(out.glymphatic_brief.current.pages[0].tomorrow[0].id,ID);
 const dropped={...state,glymphatic_brief:{...state.glymphatic_brief,decisions:{[ID]:{action:"drop"}}}};
 assert.deepEqual(ingestDeepSweepPacket({date:state.date,state:dropped,packet:p}).glymphatic_brief.current.pages,state.glymphatic_brief.current.pages);
 const lesson={id:"learn",title:"Review learning",reason:"Evidence"};const l={id:"learning",reviewed_findings:true,lessons:[lesson]};
 const learning=ingestDeepSweepPacket({date:state.date,state,packet:l});assert.equal(learning.glymphatic_brief.current.pages[0].id,"organism");assert.equal(learning.glymphatic_brief.current.pages[1].id,"process");assert.deepEqual(learning.glymphatic_brief.current.lessons,[lesson]);
});

test("handled native sources leave the pending front queue while recorded human choices remain",()=>{
 const state=base();state.glymphatic_context.pages=[{id:"front",tomorrow:[{id:ID,source_item_id:ID,title:"Previously proposed"}]}];
 const p={id:"next-reviewed",reviewed_findings:true,suggested_tasks:[{id:"other",title:"New finding"}]};
 const out=ingestDeepSweepPacket({date:state.date,state,packet:p,suppressedSourceIds:[ID]});
 assert.deepEqual(out.glymphatic_brief.current.pages[0].tomorrow.map(x=>x.id),["other"]);
});
