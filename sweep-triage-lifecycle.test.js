const test=require("node:test"), assert=require("node:assert/strict");
const S=require("./lib/sweep-triage");
const TM=require("./public/js/task-model");
const options={isDone:()=>false,isDeleted:()=>false,trivialFlags:{}};
const pending=()=>{const p={kind:"task",title:"Synthetic",publicVisibility:"private",status:"open",detail:"Owner notes",triageContext:{draft_preview:"Unsent draft"}};S.create(p,{runId:"synthetic-run"});return p;};
const view=(props,date=null)=>TM.selectSweepTriage([TM.fromBlock({id:"fixture",date,properties:props})],options);

test("only a dedicated verified sweep capability can select the configured owner",async()=>{
 const env={SECRET_DCC_TOKEN:"fixture-broad",SECRET_PA_TOKEN:"fixture-pa",SECRET_SWEEP_SUITE_TOKEN:"fixture-sweep",DCC_SERVICE_USER_ID:"7",DCC_SERVICE_WORKSPACE_ID:"fixture-ws"};
 const verify=async(token,scope,options)=>{
  assert.equal(scope,"sweep");assert.deepEqual(options,{exact:true});return token==="fixture-db-sweep";
 };
 for(const token of ["","Bearer fixture-broad","Bearer fixture-pa","Bearer unrelated"])
  await assert.rejects(S.authenticate(token,verify,env),{statusCode:403});
 for(const token of ["fixture-sweep","fixture-db-sweep"])
  assert.deepEqual(await S.authenticate("Bearer "+token,verify,env),{userId:7,workspaceId:"fixture-ws",source:"verified-sweep-capture"});
 await assert.rejects(S.authenticate("Bearer fixture-sweep",verify,{...env,DCC_SERVICE_WORKSPACE_ID:""}),{statusCode:503});
});

test("only server creation stamps sweep origin; writes cannot forge, erase or reset it",()=>{
 const forged={...pending()};S.create(forged);
 assert.equal(S.state(forged),null);
 assert.equal(S.state(S.reconcile({title:"Manual"},pending())),null);
 const p=pending(), next=S.reconcile(p,{title:"Owner renamed",publicVisibility:"private"});
 assert.equal(next.sweepTriage.disposition,"pending");
 assert.equal(next.title,"Owner renamed");
 assert.equal(view(p).length,1);
});

test("each acknowledged exit is monotonic and preserves the immutable audit before-state",()=>{
 for(const [name,patch,placement,expected] of [
  ["date-only",{}, {date:"2026-11-25"},"promoted"],
  ["Working Queue",{}, {reason:"queued"},"promoted"],
  ["start",{startedAt:"2026-11-24T10:00:00Z"},{},"promoted"],
  ["complete",{completedAt:"2026-11-24T10:00:00Z"},{},"completed"],
  ["dismiss",{}, {reason:"dismissed"},"dismissed"],
 ]) {
  const before=pending(), after=S.reconcile(before,{...before,...patch},placement);
  assert.equal(before.sweepTriage.disposition,"pending",name);
  assert.equal(after.sweepTriage.disposition,expected,name);
  assert.equal(after.detail,"Owner notes");
  assert.equal(after.triageContext.draft_preview,"Unsent draft");
  assert.equal(view(S.reconcile(after,before,{date:null})).length,0,name+" cannot implicitly reenter");
 }
});
