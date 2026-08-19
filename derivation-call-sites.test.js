// C6a: the CALL SITES of the derivation layer.
//
// task-model-selectors.test.js proves the mechanism. This file proves the surfaces are
// wired to it — and it exists because they were not covered. A mutation pass over C6a
// found six mutations the suite missed, and EVERY ONE was at a call site rather than in
// the layer: reverting the focus-id default to `!ev.subtaskOf`, rendering Unscheduled
// flat again, dropping buildSchedule's fold, and — the worst of them — pooling the list view's tree
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

const schedTabSrc = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const schedTabCode = stripJsComments(schedTabSrc);

// Any dotted-property `nested` read. Two cuts of this were wrong. The first whitelisted eight
// receiver names (ev|s|t|task|item|node|c|p), so `row.nested` / `block.nested` walked past it.
// The second added a `(?<![\w$.])` lookbehind whose `.` then excluded a DOTTED receiver --
// `b.properties.nested` is the natural spelling in a file that reads block properties, and it
// escaped. The prefix requirement alone is what dodges the two false positives (a bare local
// `const nested = await ...`, and the class literal "be-card nested"); allowing a dotted chain
// is what closes the escape.
const NESTED_READ_RX = /(?<![\w$])[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*nested\b/;

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
  assert.ok(NESTED_READ_RX.test("if(b.properties.nested)return;"), "a DOTTED receiver must not escape either");
  assert.ok(NESTED_READ_RX.test("if(this.state.nested)return;"));
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

test("★ buildSchedule's compact Done section lists done + nestedDone, and excludes only the fold", () => {
  // This surface renders two FLAT populations and nests nothing, so a row the list view shows
  // nested under its parent has no home here -- `day.done` alone would render it on no row at
  // all. `day.folded` stays excluded, because those really do live in the parent's detail panel.
  const rx = /const doneItems=day\.done\.concat\(day\.nestedDone\);/;
  assert.match(schedTabCode, rx);
  assert.equal(rx.test("const doneItems=day.done;"), false, "day.done alone drops the nested-done rows");
  assert.equal(rx.test("const doneItems=DCC.TaskModel.selectDone(vis);"), false, "selectDone(vis) would re-list the folded ones");
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
  assert.equal(listView.includes('section("Unfinished"'), false,
    "past-day unfinished work must stay in Loose Ends instead of rendering below the task list");
  assert.equal(listView.includes("function buildSchedule("), false, "the slice must not run into buildSchedule");
  const calls = (listView.match(/TaskModel\.selectDay\(/g) || []).length;
  assert.equal(calls, 1, "buildListView must call selectDay exactly once, got " + calls);
  assert.match(listView, /const day=DCC\.TaskModel\.selectDay\(scheduled,viewDate,\{today:actualToday,carryoverPool:unfPool\}\)/);
  assert.match(listView, /const unfPool=\[\];/,
    "the list derivation must keep its carryover pool empty because Loose Ends owns those rows");
  assert.equal(listView.includes("_ensureUnfinished(actualToday)"), false,
    "the retired list queue must not trigger a hidden carryover fetch and second render");
});
