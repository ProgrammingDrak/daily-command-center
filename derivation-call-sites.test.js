// C6a: the CALL SITES of the derivation layer.
//
// task-model-selectors.test.js proves the mechanism. This file proves the surfaces are
// wired to it — and it exists because they were not covered. A mutation pass over C6a
// found six mutations the suite missed, and EVERY ONE was at a call site rather than in
// the layer: reverting the focus-id default to `!ev.subtaskOf`, removing the pomodoro
// picker's nesting guard, removing the focus banner's, rendering Unscheduled flat again,
// dropping buildSchedule's fold, and — the worst of them — pooling the list view's tree
// on `day.timed` instead of `visible`, which silently un-does the orphan fix on the one
// surface Drake actually uses.
//
// That is C5b's lesson holding again: mutation-check the COMMON path, not just the
// clever new guard. Two of these are real behavioural tests (the guards are pure enough
// to slice and run); the rest are source assertions, each with a negative control
// asserting the regex REJECTS the pre-C6a code, so none of them can pass vacuously.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installTaskModel } = require("./task-model-vm-fixture.js");
const { stripJsComments } = require("./js-comment-strip-fixture.js");

const featuresSrc = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
const timerSrc = fs.readFileSync(require.resolve("./public/js/timer.js"), "utf8");
const schedTabSrc = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const schedTabCode = stripJsComments(schedTabSrc);

const one = (src, re, what) => { const m = src.match(re); if (!m) throw new Error("slice failed: " + what); return m[0]; };

// ══════════════════════ the two guards that were DEAD, run for real ══════════════════

// `ev.nested` was written by data.js as a literal `false` and set true by nothing, so
// `if(ev.nested) return false` never fired and `!ev.nested` removed nothing. Both of
// these therefore OFFERED A SUBTASK as your next task. Now they read the parent edges.
function focusCtx(scheduled, doneIds) {
  const ctx = {
    console,
    scheduled,
    isDone: (ev) => new Set(doneIds || []).has(ev.id),
    isDeleted: () => false,
    getPinnedActiveId: () => null,
    isActive: () => false,
    pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    now: () => 0,
  };
  vm.createContext(ctx);
  installTaskModel(ctx);
  vm.runInContext(one(featuresSrc, /function _focusBannerNextItem\(\)\{[\s\S]*?\n\}/, "_focusBannerNextItem"), ctx);
  return ctx;
}

test("★ the focus banner never offers a NESTED row as 'your next task'", () => {
  const sub = { id: "step", title: "step", subtaskOf: "parent", type: "task", start: "08:00", end: "08:30" };
  const rider = { id: "rider", title: "rider", wrapId: "shell", type: "task", start: "08:30", end: "09:00" };
  const top = { id: "real", title: "real", type: "task", start: "09:00", end: "09:30" };

  // A subtask FIRST in the array: before C6a this was returned as the next task.
  assert.equal(focusCtx([sub, top]).DCC && vm.runInContext("_focusBannerNextItem().id", focusCtx([sub, top])), "real");
  assert.equal(vm.runInContext("_focusBannerNextItem().id", focusCtx([rider, top])), "real",
    "a ride-along is nested too — the old `!ev.nested` and a `!isSubtask` fix would both miss it");
  // Nothing but nested rows -> no banner at all, rather than a meaningless one.
  assert.equal(vm.runInContext("_focusBannerNextItem()", focusCtx([sub, rider])), null);
  // The ordinary case still works, and a done top-level row is skipped.
  assert.equal(vm.runInContext("_focusBannerNextItem().id", focusCtx([top], [])), "real");
  assert.equal(vm.runInContext("_focusBannerNextItem()", focusCtx([top], ["real"])), null);
  // break/ooo/free_time stay excluded (unchanged behaviour).
  assert.equal(vm.runInContext("_focusBannerNextItem()", focusCtx([{ id: "b", type: "break", start: "09:00", end: "09:30" }])), null);
});

test("★ the pomodoro picker never offers a NESTED schedule row", () => {
  const ctx = { console, isDone: () => false, isDeleted: () => false };
  vm.createContext(ctx);
  installTaskModel(ctx);
  vm.runInContext(one(timerSrc, /function _pomoTaskAvailable\(task,source\)\{[\s\S]*?\n\}/, "_pomoTaskAvailable"), ctx);
  const avail = (task, src) => vm.runInContext(`_pomoTaskAvailable(${JSON.stringify(task)},${JSON.stringify(src)})`, ctx);
  assert.equal(avail({ id: "a" }, "schedule"), true);
  assert.equal(avail({ id: "s", subtaskOf: "p" }, "schedule"), false, "a subtask is not a pomodoro target");
  assert.equal(avail({ id: "r", wrapId: "w" }, "schedule"), false, "nor is a ride-along");
  // The legacy field must not be what decides it, in either direction.
  assert.equal(avail({ id: "s2", subtaskOf: "p", nested: false }, "schedule"), false);
  assert.equal(avail({ id: "a2", nested: true }, "schedule"), true);
  // consider/backlog pools carry no parent edges and are unaffected.
  assert.equal(avail({ id: "c", subtaskOf: "p" }, "consider"), true);
});

// Any identifier-dot-`nested` read. The first cut whitelisted eight receiver names
// (ev|s|t|task|item|node|c|p), so `row.nested` / `block.nested` walked straight past it.
// The whitelist was never needed: requiring an identifier-and-dot prefix already excludes
// both things it was meant to dodge -- a bare local (`const nested = await ...`) and a CSS
// class literal ("be-card nested").
const NESTED_READ_RX = /(?<![\w$.])[A-Za-z_$][\w$]*\s*\.\s*nested\b/;

test("nothing in public/js reads the retired `ev.nested` field any more", () => {
  const dir = require("node:path").join(__dirname, "public", "js");
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const code = stripJsComments(fs.readFileSync(require("node:path").join(dir, f), "utf8"));
    const rx = new RegExp(NESTED_READ_RX.source, "g");
    let m;
    while ((m = rx.exec(code))) offenders.push(f + ":" + code.slice(0, m.index).split("\n").length + " " + m[0]);
  }
  assert.deepEqual(offenders, [], "these still read the field data.js used to write as a literal false: " + offenders.join(", "));
  // Negative controls, using the SAME regex the scan uses -- a control that re-types the
  // pattern as a fresh literal keeps testing the old one after the guard is edited.
  assert.ok(NESTED_READ_RX.test("if(!ev||ev.nested)return false;"));
  assert.ok(NESTED_READ_RX.test("scheduled.filter(s=>!s.nested)"));
  assert.ok(NESTED_READ_RX.test("if(row.nested)return;"), "a renamed receiver must not escape the guard");
  assert.ok(NESTED_READ_RX.test("if(block.nested)return;"));
  // ...and the two things it must NOT flag: a plain local, and a CSS class string.
  assert.equal(NESTED_READ_RX.test("const nested = await _moveOriginDayChildrenTo(id);"), false);
  assert.equal(NESTED_READ_RX.test('el.className = "be-card nested";'), false);
  // ...and data.js must no longer WRITE it.
  assert.equal(/nested:\s*false/.test(stripJsComments(fs.readFileSync(require.resolve("./public/js/data.js"), "utf8"))), false,
    "data.js still mints ev.nested");
});

// ═══════════════════ the list view's wiring, with negative controls ═══════════════════

// ★ THE MOST IMPORTANT ONE. `pool:visible` is the orphan fix's actual delivery: it is
// what makes selectTree hide a child whose parent renders in another section instead of
// promoting it to a numbered top-level row. Pool it on `day.timed` and the layer still
// passes every unit test while the surface reverts to pre-C6a behaviour.
test("★ the work list pools its tree on `visible`, not on the section it is rendering", () => {
  const rx = /selectTree\(day\.timed,\{pool:visible\}\)/;
  assert.match(schedTabCode, rx,
    "the work list must resolve roots against the whole visible day, or a child whose parent " +
    "is Unscheduled/folded gets promoted to a top-level row again");
  // Negative controls: every wrong pool must be rejected by this assertion.
  assert.equal(rx.test("selectTree(day.timed,{pool:day.timed})"), false);
  assert.equal(rx.test("selectTree(day.timed)"), false);
  assert.equal(rx.test("selectTree(day.timed,{pool:scheduled})"), false);
});

test("★ the Unscheduled section renders a TREE, not a flat list of roots", () => {
  const rx = /selectTree\(rootOrder\.concat\(day\.unscheduled\.filter\(ev=>!rootIds\.has\(ev\.id\)\)\),\{pool:visible\}\)[\s\S]{0,400}?wrap\.appendChild\(emitNode\(node,_isSubRow\(node\)\?0:uRank\+\+,isDone\(node\.ev\)\?"done":"open"\)\);/;
  assert.match(schedTabCode, rx,
    "roots + their closure must go through selectTree and emitNode WITH the real done/open " +
    "mode, or a step of an untimed parent renders as a standalone numbered row in the Work " +
    "list -- and a done-but-not-yet-foldable step renders as an unchecked 'Mark done' row " +
    "whose click un-completes it");
  // Negative controls: the pre-C6a flat render, and the hardcoded-"open" mode that shipped
  // this bug into review, must both fail this assertion.
  assert.equal(rx.test('unsRows.forEach((ev,idx)=>wrap.appendChild(row(ev,idx,"open")));'), false);
  assert.equal(rx.test('rootOrder.forEach((ev,idx)=>wrap.appendChild(row(ev,idx,"open")));'), false);
  assert.equal(rx.test('DCC.TaskModel.selectTree(rootOrder.concat(day.unscheduled.filter(ev=>!rootIds.has(ev.id))),{pool:visible}).forEach(node=>{wrap.appendChild(emitNode(node,_isSubRow(node)?0:uRank++,"open"));});'), false,
    "the hardcoded mode must be rejected");
  // And the badge counts ROOTS, so it matches what you can point at.
  assert.match(schedTabCode, /section\("Unscheduled",day\.unscheduledRoots\.length,"unscheduled","uns-group"\)/);
});

test("★ buildSchedule's compact Done section uses the folded list, not every done row", () => {
  const rx = /const doneItems=day\.done;/;
  assert.match(schedTabCode, rx,
    "day.done applies the fold; selectDone(vis) would list a done ride-along as its own row again");
  assert.equal(rx.test("const doneItems=DCC.TaskModel.selectDone(vis);"), false);
  assert.equal(rx.test("const doneItems=vis.filter(ev=>isDone(ev)&&!(isSubtask(ev)&&vis.some(p=>p.id===ev.subtaskOf)));"), false);
  // The retired hand-rolled fold must be gone from the file entirely (both copies).
  assert.equal(/isSubtask\(ev\)&&\w+\.some\(p=>p\.id===ev\.subtaskOf\)/.test(schedTabCode), false,
    "a subtaskOf-only fold predicate is back in schedule-tab.js");
});

test("★ the day's default focus row is gated on isNested, not on subtaskOf alone", () => {
  const rx = /activeItems\.find\(ev => !DCC\.TaskModel\.isNested\(ev\) && pointEligible\(ev\)\)/;
  assert.match(schedTabCode, rx);
  assert.equal(rx.test("activeItems.find(ev => !ev.subtaskOf && pointEligible(ev))"), false);
  assert.equal(rx.test("activeItems.find(ev => !isSubtask(ev) && pointEligible(ev))"), false);
});

// ★ The bare globals in state.js (parentIdOf / relOf / isSubtask / isNested /
// childrenOf) are read by ~100 call sites, so the NAMES stay there. The bodies must be
// one-line delegates. A duplicate body is not a style problem: a mutation that restored
// `parentIdOf` locally with `subtaskOf || wrapId` — the ROW-space order from
// lib/reschedule.js, reversed from ev space — passed the entire suite, and it silently
// changes which parent a row carrying both edges belongs to.
test("★ state.js's tree helpers DELEGATE — no second body to drift from TaskModel", () => {
  const stateCode = stripJsComments(fs.readFileSync(require.resolve("./public/js/state.js"), "utf8"));
  const delegates = {
    parentIdOf: /function parentIdOf\(ev\)\{return _TM\(\)\.parentIdOf\(ev\);\}/,
    relOf: /function relOf\(ev\)\{return _TM\(\)\.relOf\(ev\);\}/,
    isSubtask: /function isSubtask\(ev\)\{return _TM\(\)\.isSubtask\(ev\);\}/,
    isNested: /function isNested\(ev\)\{return _TM\(\)\.isNested\(ev\);\}/,
    childrenOf: /function childrenOf\(id,pool\)\{return _TM\(\)\.childrenOf\(id,pool\);\}/,
  };
  for (const [name, rx] of Object.entries(delegates)) {
    assert.match(stateCode, rx, `state.js ${name} must be a one-line delegate to TaskModel`);
  }
  // Negative controls: the pre-C6a bodies, and the reversed-edge-order duplicate.
  assert.equal(delegates.parentIdOf.test("function parentIdOf(ev){return (ev&&(ev.wrapId||ev.subtaskOf))||null;}"), false);
  assert.equal(delegates.parentIdOf.test("function parentIdOf(ev){return (ev&&(ev.subtaskOf||ev.wrapId))||null;}"), false);
  assert.equal(delegates.childrenOf.test("function childrenOf(id,pool){return (pool||[]).filter(c=>parentIdOf(c)===id);}"), false);
  // And the edge order really is wrapId-first through the delegate, which is the thing
  // the duplicate got wrong. state.js documents the deliberate divergence from
  // lib/reschedule.js's row-space order; this pins the ev-space side of it.
  const ctx = { console };
  vm.createContext(ctx);
  installTaskModel(ctx);
  vm.runInContext("function _TM(){return DCC.TaskModel;}" + stateCode.match(/function parentIdOf\(ev\)\{[^}]*\}/)[0], ctx);
  assert.equal(vm.runInContext('parentIdOf({wrapId:"w",subtaskOf:"s"})', ctx), "w");
});

test("the Work-list badge counts every open point-eligible row, Unscheduled included", () => {
  // Deliberately WIDER than day.open, which is the timed section only. That is what the
  // badge has always counted; narrowing it is a behaviour change nobody asked for, and a
  // mutation to day.open passed the suite until this existed. (The mismatch between the
  // badge's name and its population is real and is recorded in the phase handoff.)
  const rx = /const activeIds=new Set\(DCC\.TaskModel\.selectOpen\(visible\)\.filter\(ev=>pointEligible\(ev\)\)\.map\(ev=>ev\.id\)\);/;
  assert.match(schedTabCode, rx);
  assert.equal(rx.test("const activeIds=new Set(day.open.filter(ev=>pointEligible(ev)).map(ev=>ev.id));"), false);
  assert.equal(rx.test("const activeIds=new Set(DCC.TaskModel.selectOpen(day.timed).filter(ev=>pointEligible(ev)).map(ev=>ev.id));"), false);
});

test("★ the timeline pools its tree on the section it renders, NOT on the visible day", () => {
  // The mirror image of the work list, and the reason each needs its own pin. buildSchedule
  // renders OPEN rows only and a done parent shows as a childless compact row in the Done
  // section -- so here a child whose parent is done has no parent rendering anywhere and must
  // still be promoted. Pooling on `vis` made it render NOWHERE (verified: selectTree returns
  // [] for that shape). The list view is the surface that shows a done parent inline with its
  // open children nested, and that one pools on `visible`.
  const rx = /selectTree\(activeItems,\{pool:activeItems\}\)/;
  assert.match(schedTabCode, rx);
  assert.equal(rx.test("selectTree(activeItems,{pool:vis})"), false, "pooling on vis loses an open child of a done parent");
  assert.equal(rx.test("selectTree(activeItems,{pool:visible})"), false);
  // And buildSchedule derives through the layer, not by hand.
  assert.match(schedTabCode, /const day=DCC\.TaskModel\.selectDay\(scheduled,viewDate,\{\}\)/);
});

test("★ the list view derives ONCE — one selectDay call feeding every section", () => {
  // The point of the phase is that the sections cannot disagree. Two selectDay calls in
  // one render, or a section rebuilding its own population, is the disagreement coming
  // back by another route.
  // Slice on the TOP-LEVEL declaration boundary (a `function ` at column 0), not on a
  // lazy `\n}` — buildListView holds a dozen nested functions, and the first cut of this
  // test matched past its end into buildSchedule, which has a legitimate selectDay call
  // of its own. It reported "got 2" for code that was already correct.
  const start = schedTabCode.indexOf("function buildListView(){");
  assert.ok(start > 0, "buildListView must exist");
  const after = schedTabCode.indexOf("\nfunction ", start + 1);
  const listView = schedTabCode.slice(start, after > 0 ? after : undefined);
  assert.ok(listView.includes('section("Unfinished"'), "the slice must cover the whole of buildListView");
  assert.equal(listView.includes("function buildSchedule("), false, "the slice must not run into buildSchedule");
  const calls = (listView.match(/TaskModel\.selectDay\(/g) || []).length;
  assert.equal(calls, 1, "buildListView must call selectDay exactly once, got " + calls);
  assert.match(listView, /const day=DCC\.TaskModel\.selectDay\(scheduled,viewDate,\{today:actualToday,carryoverPool:unfPool\}\)/);
  // The carryover fetch has to precede the derivation that consumes it.
  // Assert PRESENCE before comparing positions. `indexOf` returns -1 when absent, and
  // -1 < anyIndex is true -- so the exact regression this line names (the
  // `_ensureUnfinished` hoist being deleted or moved back below selectDay, leaving unfPool
  // empty when the derivation consumes it) made the assertion PASS.
  const fetchAt = listView.indexOf("_ensureUnfinished(actualToday)");
  const deriveAt = listView.indexOf("TaskModel.selectDay(");
  assert.ok(fetchAt >= 0, "buildListView must still fetch the carryover pool via _ensureUnfinished(actualToday)");
  assert.ok(deriveAt >= 0, "buildListView must still call selectDay");
  assert.ok(fetchAt < deriveAt, "the carryover pool must be resolved before selectDay reads it");
});
