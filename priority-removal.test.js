"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const scoring = require("./slot-scoring");
function bank(saved){
 const ctx={window:{DCC:{esc:s=>s}},localStorage:{getItem:()=>JSON.stringify(saved),setItem(){}},document:{readyState:"loading",addEventListener(){}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync("public/js/task-bank.js","utf8"),ctx);return ctx.window;
}
test("retired priority sort preserves existing manual order, including legacy saved preferences",()=>{
 const rows=[{id:"low",title:"Z",priority:"Low"},{id:"high",title:"A",priority:"High"}];
 for(const saved of [{},{sort:"priority"}]){
  const w=bank(saved);
  assert.deepEqual(Array.from(w.taskBankSort(rows),r=>r.id),["low","high"]);
  assert.deepEqual(Array.from(w.taskBankSort(rows,{sort:"title"}),r=>r.id),["high","low"]);
 }
});
test("backlog editing preserves legacy priority while removing its control",()=>{
 const w=bank({});w.startTaskBankBacklogEdit("a");
 assert.doesNotMatch(w.renderTaskBankBacklogEditForm({id:"a",title:"Legacy",priority:"High",durMin:30}),/tbe-priority|>High</);
});

test("legacy priority is inert in both point calculators, with explicit urgency and importance preserved",()=>{
 const ctx={window:{},console};vm.createContext(ctx);
 vm.runInContext(fs.readFileSync("public/js/points.js","utf8"),ctx);
 const base={type:"task",duration_minutes:30};
 const server=scoring.scoreTaskPoints(base).awardPoints;
 const client=ctx.window.TaskPoints.estimate(base).awardPoints;
 assert.equal(client,server);
 for(const priority of ["Low","Medium","High","urgent","critical","p1"]){
  assert.equal(scoring.scoreTaskPoints({...base,priority}).awardPoints,server,priority);
  assert.equal(ctx.window.TaskPoints.estimate({...base,priority}).awardPoints,client,priority);
  assert.equal(ctx.window.TaskPoints.buildPayload({...base,priority}).urgent,false,priority);
 }
 for(const explicit of [{urgent:true},{importance:"critical"}]){
  assert.ok(scoring.scoreTaskPoints({...base,...explicit}).awardPoints>server);
  assert.equal(ctx.window.TaskPoints.estimate({...base,...explicit}).awardPoints,scoring.scoreTaskPoints({...base,...explicit}).awardPoints);
 }
});
