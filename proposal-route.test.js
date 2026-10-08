const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const http=require("node:http");
const intelligence=require("./dcc-intelligence");
const ID="gmail:thread-test:message-test";
function appFor({duplicate=false,ownerError=false,mergeError=false}={}){
 const app=express(), calls=[], mirrors=[], events=[]; app.use(express.json());
 require("./routes/dcc")(app,{
  blockDB:{mergeDccProposalPacket:async(...args)=>{calls.push(args);if(mergeError)throw Error("read unavailable");return{state:{},duplicate,acceptedSourceIds:[ID],suppressedSourceIds:[]};}},
  dccIntelligence:intelligence,buildSkeletonState:date=>({date}),
  isValidDate:value=>typeof value==="string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value,
  resolveOwnerStrict:async()=>{if(ownerError){const e=Error("owner required");e.status=400;throw e;}return{userId:7,workspaceId:"ws-owned"};},
  getDayFilePath:()=>"unused",writeJSON:(...args)=>mirrors.push(args),broadcast:(...args)=>events.push(args)
 });return{app,calls,mirrors,events};
}
async function post(app,body){
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/dcc/deep-sweep/ingest`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
 finally{await new Promise(resolve=>server.close(resolve));}
}
const body=()=>({date:"2026-09-30",source:"Drakula",packet:{id:"reviewed-native-packet",suggested_tasks:[{id:ID,source_item_id:ID,title:"Reviewed business proposal"}]}});
test("invalid packet/date and missing owner fail without invoking persistence",async()=>{
 for(const value of [{...body(),date:"2026-02-30"},{...body(),packet:{suggested_tasks:[]}},{...body(),packet:{id:"x",suggested_tasks:{}}},{...body(),packet:{id:"x",suggested_tasks:Array.from({length:101},(_,i)=>({id:String(i),title:"x"}))}}]){
  const ctx=appFor();assert.equal((await post(ctx.app,value)).status,400);assert.equal(ctx.calls.length,0);
 }
 const ctx=appFor({ownerError:true});assert.equal((await post(ctx.app,body())).status,400);assert.equal(ctx.calls.length,0);
});
test("strict resolved owner and dry-run flag reach atomic merge; dry-run and replay never mirror or broadcast",async()=>{
 for(const [options,dry,status] of [[{},true,"dry_run"],[{duplicate:true},false,"duplicate"],[{},false,"merged"]]){
  const ctx=appFor(options),result=await post(ctx.app,{...body(),dry_run:dry});assert.equal(result.status,200);assert.equal(result.body.status,status);
  assert.deepEqual(result.body.owner,{userId:7,workspaceId:"ws-owned"});assert.equal(ctx.calls[0][2],7);assert.equal(ctx.calls[0][3],"ws-owned");assert.equal(ctx.calls[0][6],dry);
  assert.equal(ctx.mirrors.length,status==="merged"?1:0);assert.equal(ctx.events.length,status==="merged"?1:0);
 }
});
test("source read failure returns failure with no mirror or success broadcast",async()=>{
 const ctx=appFor({mergeError:true});assert.equal((await post(ctx.app,body())).status,500);assert.equal(ctx.mirrors.length,0);assert.equal(ctx.events.length,0);
});

test("existing local builder packets derive repeatable IDs from their fixed generated_at",async()=>{
 const ctx=appFor();const legacy=body();delete legacy.packet.id;legacy.packet.generated_at="2026-09-30T19:30:00Z";
 const first=await post(ctx.app,legacy),second=await post(ctx.app,legacy);
 assert.equal(first.status,200);assert.equal(first.body.packet_id,second.body.packet_id);assert.ok(first.body.packet_id);
});
