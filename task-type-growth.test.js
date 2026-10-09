// Contract tests for the Phase 9 runtime logic that lives in browser files
// (schedule-tab.js, unfinished-tasks.js) and so isn't otherwise exercised by the
// node suite: skipType (registry-driven skip set), _habitStreakCount (consecutive
// prior-day streak), and convertTaskType (type change + wrap-flag + child-keep).
// Harness pattern mirrors schedule-tab-shell-exclusion.test.js: slice the pure
// functions into a node:vm context with stubbed globals.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskTypes = require("./public/js/task-types");
const stSrc = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
// col-0 closing brace for top-level fns; single-line grab for _prevDate.
const slice = (src, name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const sliceLine = (src, name) => src.match(new RegExp("function " + name + "[^\\n]*"))[0];

// ── skipType MOVED (C2) ─────────────────────────────────────────────────────
// unfinished-tasks.js skipType() is gone. The carryover lane's fixed-type skip is
// SQL now (db.js carryoverSkipTypes, applied inside getCarryoverPool), so the two
// tests that lived here are in open-tasks-query.test.js against the new home. The
// registry-not-loaded fallback went with it: a server require() cannot half-load,
// so that branch no longer exists to test.

// ── _habitStreakCount (schedule-tab.js) ─────────────────────────────────────
function streakCtx() {
  const source = [sliceLine(stSrc, "_prevDate"), slice(stSrc, "_habitStreakCount")].join("\n");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source + "\nthis._habitStreakCount=_habitStreakCount;this._prevDate=_prevDate;", context);
  return context;
}
function dayMap(today, offsets, key) {
  // Build a Map(dateStr -> Set(key)) using UTC stepping (matches _prevDate).
  const m = new Map();
  for (const off of offsets) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - off);
    m.set(d.toISOString().slice(0, 10), new Set([key]));
  }
  return m;
}

test("_habitStreakCount: counts consecutive prior days and stops at the first gap", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  // days back 1,2 present, 3 missing, 4 present -> streak is 2.
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 4], "x"), T, "x"), 2);
});

test("_habitStreakCount: unbroken run counts every day; empty map / today-only is 0", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 3, 4, 5], "y"), T, "y"), 5);
  assert.equal(ctx._habitStreakCount(new Map(), T, "y"), 0);
  assert.equal(ctx._habitStreakCount(dayMap(T, [0], "y"), T, "y"), 0); // today doesn't count (prior days only)
});

test("_habitStreakCount: a different key doesn't borrow another habit's streak", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 3], "y"), T, "z"), 0);
});

test("_prevDate: steps exactly one calendar day across a month boundary (UTC-stable)", () => {
  const ctx = streakCtx();
  assert.equal(ctx._prevDate("2026-08-01"), "2026-07-31");
  assert.equal(ctx._prevDate("2026-03-01"), "2026-02-28"); // non-leap
  assert.equal(ctx._prevDate("2026-07-11"), "2026-07-10");
});

// ── convertTaskType (schedule-tab.js) ───────────────────────────────────────
function convertCtx(tasks, save) {
  const persists = [], toasts = [];
  const rows = tasks.map(ev => ({id: ev._blockId || ev.id, properties: {...ev, local_id:ev.id}}));
  const context = {
    window: { TaskTypes, blockStore: {
      get: id => rows.find(row=>row.id===id), getByType: ()=>rows,
      updateBlock: async (id, props, extra) => {
        persists.push({id, patch:props, extra});
        return save ? save(id,props) : {id,properties:props};
      }
    } },
    console:{warn:()=>{}}, _rowForDateWrite:id=>context.window.blockStore.get(id),
    scheduled: tasks, childrenOf: () => [], recalcTimes: () => {}, render: () => {},
    showToast: (message,kind) => toasts.push({message,kind}),
  };
  vm.createContext(context);
  const stateSrc=fs.readFileSync(require.resolve("./public/js/state.js"),"utf8");
  vm.runInContext("let _rowPropsChain=Promise.resolve();\n"+slice(stateSrc,"enqueueRowPropsWrite"),context);
  vm.runInContext("async " + slice(stSrc, "convertTaskType") + "\nthis.convertTaskType=convertTaskType;", context);
  return { context, persists, toasts };
}

test("conversion waits for acknowledgement and retains identity, duration and children", async () => {
  const ev={id:"t1",_blockId:"row-1",type:"focus",duration:90,subtaskOf:"parent"};
  let resolve;
  const {context,persists,toasts}=convertCtx([ev],()=>new Promise(r=>{resolve=r;}));
  const pending=context.convertTaskType("t1","task");
  assert.equal(ev.type,"focus"); assert.equal(toasts.length,0);
  assert.equal(await context.convertTaskType("t1","habit"),false,"duplicate conversion blocked");
  resolve({id:"row-1",properties:persists[0].patch});
  assert.equal(await pending,true); assert.equal(ev.type,"task");
  assert.equal(persists[0].id,"row-1"); assert.equal(persists[0].patch.duration,90);
  assert.equal(persists[0].patch.subtaskOf,"parent");
  assert.equal(persists[0].extra._reportSaveStatus,true);
  assert.equal(toasts.at(-1).kind,"success");
});

test("legacy shell -> task clears wrap without orphaning children", async () => {
  const ev={id:"t2",type:"shell",isWrap:true};
  const {context,persists}=convertCtx([ev]);
  assert.equal(await context.convertTaskType("t2","task"),true);
  assert.equal(ev.type,"task"); assert.ok(!ev.isWrap); assert.equal(persists[0].patch.isWrap,false);
});

test("conversion rejects fixed, unknown, legacy targets and same type", async () => {
  const ev={id:"t3",type:"task"};
  const {context,persists}=convertCtx([ev]);
  for(const type of ["meeting","unknown","shell","task"]) assert.equal(await context.convertTaskType("t3",type),false);
  assert.equal(ev.type,"task"); assert.equal(persists.length,0);
});

test("private workout and meal types cannot report a false Task conversion", async () => {
  for(const type of ["workout","meal"]){
    const ev={id:type,type,publicVisibility:"private"};
    const {context,persists,toasts}=convertCtx([ev]);
    assert.equal(await context.convertTaskType(type,"task"),false);
    assert.equal(ev.type,type); assert.equal(ev.publicVisibility,"private");
    assert.equal(persists.length,0); assert.equal(toasts.at(-1).kind,"info");
    assert.match(toasts.at(-1).message,/keeps its activity type/);
  }
});

test("normalized, failed and buffered writes never announce successful conversion", async () => {
  for(const outcome of ["normalized","failed","pending"]){
    const ev={id:"t4",type:"focus"};
    const {context,toasts}=convertCtx([ev],(_id,props)=>{
      if(outcome==="failed")throw Error("Save rejected");
      return {properties:{...props,type:outcome==="normalized"?"focus":"task"}, ...(outcome==="pending"?{_savePending:true}:{})};
    });
    assert.equal(await context.convertTaskType("t4","task"),false);
    assert.equal(toasts.some(t=>t.kind==="success"),false);
    assert.equal(ev.type,outcome==="pending"?"task":"focus");
    assert.equal(ev._typeConversionPending,undefined);
  }
});

test("conversion into workout/meal saves privacy and rejects absent persistence", async () => {
  for(const type of ["workout","meal"]){
    const ev={id:"t5",type:"task",publicVisibility:"public"};
    const {context,persists}=convertCtx([ev]);
    assert.equal(await context.convertTaskType("t5",type),true);
    assert.equal(ev.publicVisibility,"private"); assert.equal(persists[0].patch.publicVisibility,"private");
  }
  const ev={id:"unsaved",type:"focus"}, {context,toasts}=convertCtx([ev]);
  context.window.blockStore=null;
  assert.equal(await context.convertTaskType("unsaved","task"),false);
  assert.equal(ev.type,"focus"); assert.equal(toasts.at(-1).kind,"error");
});


test("conversion composes after pending row writes without overwriting their properties", async () => {
  const ev={id:"queued",type:"focus",duration:60};
  const {context,persists}=convertCtx([ev]);
  let release;
  context._rowForDateWrite=async id=>{await new Promise(resolve=>{release=resolve;});return {id,properties:{type:"focus",duration:90,sourceReferences:[{url:"https://example.com"}]}};};
  const pending=context.convertTaskType("queued","task");
  await Promise.resolve();await Promise.resolve();release();
  assert.equal(await pending,true);
  assert.equal(persists[0].patch.duration,90);
  assert.equal(persists[0].patch.sourceReferences[0].url,"https://example.com");
});

test("conversion checks protected types again after the shared queue reads the row", async () => {
  const ev={id:"changed",type:"focus"};
  const {context,persists,toasts}=convertCtx([ev]);
  context._rowForDateWrite=id=>({id,properties:{type:"workout",publicVisibility:"private"}});
  assert.equal(await context.convertTaskType("changed","task"),false);
  assert.equal(persists.length,0);assert.equal(toasts.at(-1).kind,"error");
});
