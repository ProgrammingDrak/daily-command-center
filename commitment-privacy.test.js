const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const accountBinding = require("./lib/account-binding");

test("public projection excludes private rows, stale twins, associated discussion and cross-account calendars", async () => {
  const src = fs.readFileSync(require.resolve("./routes/social-todo"), "utf8");
  const names = ["localTimeFromAny","taskMinutes","publicTaskIdentityIds","normalizeReactionIdentityIds","addReactionToMap","addCommentToMap","publicTaskStatus","publicFeedType","publicFeedTypeLabel","getPublicCalendarMap","getPublicTagMap","calendarMeta","publicTaskPoints","normalizePublicTask","buildPublicTodoShare"];
  const functions = names.map(n => { const m = src.match(new RegExp("(?:async )?function " + n + "\\([^]*?\\n\\}")); assert.ok(m,n); return m[0]; }).join("\n");
  const blocks = [
    { id:"secret",type:"block",properties:{title:"Synthetic confidential appointment",publicVisibility:"private",source_id:"secret-source"} },
    { id:"public",type:"block",properties:{title:"Synthetic shared commitment",source_id:"public-source",gcal_calendar_id:"private@example.invalid",calendarName:"Secret account name"} },
  ];
  const queries = [];
  const ctx = { console, crypto, isValidDate:()=>true,getTodayStr:()=>"2026-10-08",coerceDateString:x=>x,
    filterLegacyGcalBlocks:x=>x,scoreTaskPoints:()=>({eligible:false}),capabilities:require("./capabilities"),
    buildDayResponse:async()=>({schedule:{timeline:[{id:"secret",label:"Synthetic confidential appointment",source_id:"secret-source"}],timeBlocks:[]},triage:{open_items:[]}}),
    blockDB:{ getBlocksByDateIncludingDeleted:async()=>blocks },
    pool:{query:async sql=>{
      queries.push(sql);
      return { rows: sql.includes("FROM gcal_calendars") ? [{id:"other",summary:"Foreign calendar",account_email:"other@example.invalid"}]
        :sql.includes("FROM todo_sponsorships") ? [{id:1,task_id:"secret",task_title:"Synthetic confidential appointment",note:"Secret sponsor note",reward_title:"Secret reward"}]
        :sql.includes("FROM todo_task_comments") ? [{task_id:"secret",identity_ids:["secret"],body:"Secret discussion"}] : [] };
    }} };
  vm.createContext(ctx); vm.runInContext(functions,ctx);
  const out = await ctx.buildPublicTodoShare({ id:1,workspace_id:"ws-1" },"2026-10-08",null);
  assert.equal(out.tasks.length,1); assert.equal(out.tasks[0].id,"public");
  assert.deepEqual(JSON.parse(JSON.stringify(out.sponsorships)),[]);
  assert.ok(!queries.some(q=>q.includes("FROM gcal_calendars")));
  assert.doesNotMatch(JSON.stringify(out),/confidential|Secret|secret-source|private@example|other@example/);
});

test("server binding rejects a stale tab's queued create and read after account switch", () => {
  function check({userId=2,workspaceId="ws-2",headers={},path="/api/blocks",service=false}) {
    let accepted=false, result;
    const req={path,workspaceId,session:{userId},dccServiceAuth:service,get:k=>headers[k]};
    const res={status(n){this.n=n;return this;},json(body){result={status:this.n,body};}};
    accountBinding(req,res,()=>{accepted=true;}); return {accepted,result};
  }
  assert.equal(check({headers:{"X-DCC-User":"1","X-DCC-Workspace":"ws-1"}}).result.body.code,"ACCOUNT_CHANGED");
  assert.equal(check({}).accepted,false);
  assert.equal(check({headers:{"X-DCC-User":"2","X-DCC-Workspace":"ws-2"}}).accepted,true);
  assert.equal(check({service:true}).accepted,true);
  assert.equal(check({path:"/api/public/todo-share/example"}).accepted,true);
});
