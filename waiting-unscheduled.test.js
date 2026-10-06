const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const TM = require("./public/js/task-model");
const serializer = require("./public/js/task-serialize");
const row = (id, props = {}) => ({id,type:"block",date:null,properties:{local_id:id,title:id,kind:"backlog",...props}});
const waiting = (status="open", extra={}) => row("waiting",{kind:"delegated_item",linkedBlockId:"root",status,...extra});
const opts = {isDone:()=>false,isDeleted:()=>false,trivialFlags:{}};
const ids = rows => rows.map(r=>r.id).sort();
function check(rows, expected) {
  assert.deepEqual(ids(TM.selectUnscheduled(rows)), expected.sort());
  const cards = rows.filter(r=>r.properties.kind!=="delegated_item").map(r=>TM.fromBlock(r));
  const day = TM.selectDay(cards,"2026-10-06",{...opts,waitingRows:rows});
  assert.deepEqual(ids(day.visible),expected.sort());
  assert.deepEqual(ids(day.unscheduled),expected.sort());
  // Exercise the real reload fold, including its precomputed parked set.
  const src = fs.readFileSync(require.resolve("./public/js/persistence.js"),"utf8");
  const def = src.match(/const isFoldableTask=b=>\{[\s\S]*?\n\s*\};/)[0];
  const fold = vm.runInNewContext(`(() => {${def}return isFoldableTask;})()`,{TM,currentDate:"2026-10-06",datedLocalIds:new Set(),waitingParkedIds:TM.waitingParkedIds(rows)});
  assert.deepEqual(ids(rows.filter(fold)),expected.sort());
}
test("active Waiting parks original and unstamped descendants through reload and day projection",()=>{
  const rows=[row("root",{stage:"Waiting",dependencyWaitingItemId:"waiting"}),row("child",{subtaskOf:"root"}),row("grandchild",{wrapId:"child"}),row("free"),waiting()];
  check(rows,["free"]);
});
test("legacy linked originals without markers remain parked, prerequisites remain actionable",()=>{
  check([row("root"),row("child",{subtaskOf:"root"}),row("prerequisite"),waiting("ready",{blockerType:"task",blockerBlockId:"prerequisite"})],["prerequisite"]);
});
test("check-in reminders are actionable alongside a parked original",()=>{
  check([row("root"),row("waiting-checkin-task:waiting",{delegatedItemId:"waiting",dependencyWaitingItemId:"waiting"}),row("reminder",{source:"waiting_checkin",dependencyWaitingItemId:"waiting"}),waiting()],["reminder","waiting-checkin-task:waiting"]);
});
test("released, completed and deleted Waiting records admit stale markers and nested work",()=>{
  for(const state of [waiting("unblocked"),waiting("done"),waiting("open",{completedAt:"2026-10-06"}),{...waiting(),deleted_at:"2026-10-06"}]) check([row("root",{dependencyWaitingItemId:"waiting"}),row("child",{subtaskOf:"root"}),state],["child","root"]);
});
test("multiple blockers require all links released; partial reload does not leak explicit parking",()=>{
  const root=row("root",{dependencyWaitingItemIds:["waiting","other"]});
  assert.equal(TM.selectUnscheduled([root,waiting("unblocked")]).length,0);
  assert.equal(TM.selectUnscheduled([root,waiting("unblocked"),row("other",{kind:"delegated_item",status:"unblocked"})]).length,1);
});
test("projection and serializer preserve parking markers without sharing arrays",()=>{
  const b=row("root",{stage:"Waiting",dependencyWaitingItemId:"waiting",dependencyWaitingItemIds:["waiting"]});
  const ev=TM.fromBlock(b),saved=serializer.taskBlockProps(ev);
  assert.equal(saved.stage,"Waiting");assert.equal(saved.dependencyWaitingItemId,"waiting");
  saved.dependencyWaitingItemIds.push("other");assert.deepEqual(ev.dependencyWaitingItemIds,["waiting"]);assert.deepEqual(b.properties.dependencyWaitingItemIds,["waiting"]);
});
test("alias edges and malformed cycles terminate while dated parked work stays off the timeline",()=>{
  const rows=[row("uuid",{local_id:"root"}),row("child",{subtaskOf:"uuid"}),waiting()];
  const parked=TM.waitingParkedIds(rows);assert.equal(parked.has("child"),true);
  const cyclic=[row("root",{subtaskOf:"child"}),row("child",{subtaskOf:"root"}),waiting()];assert.equal(TM.selectUnscheduled(cyclic).length,0);
  const dated={...row("root",{start:"09:00",end:"09:30"}),date:"2026-10-06"};
  assert.equal(TM.selectDay([TM.fromBlock(dated)],"2026-10-06",{...opts,waitingRows:[waiting()]}).timed.length,0);
});

test("canonical parent_id-only descendants remain parked through legacy reload",()=>{
  check([row("root"),{...row("child"),parent_id:"root"},{...row("grandchild"),parent_id:"child"},waiting() ],[]);
});
test("null cache members preserve the existing selector contract",()=>{
  assert.deepEqual([...TM.waitingParkedIds([null,row("root")],[null])],[]);
});
