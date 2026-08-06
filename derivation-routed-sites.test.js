// C6a: the sites the SOURCE GUARD forced into the layer, and the leftovers review found.
//
// These are separate from derivation-call-sites.test.js because they came from a different
// place. That file covers the four fixes the phase set out to make. This one covers the
// nine call sites that had to change because the guard, once it was written honestly, said
// they were duplicating a canonical question -- plus the hand-rolled done/open splits the
// consistency lane found sitting two lines below a converted call.
//
// Every one of these was untested BEFORE the phase too, so a mutation to the routed version
// went uncaught in round 3: pet-home dropping its deleted filter, point-plan reading the
// wrong parent edge, the sync duplicate-check losing its open test, wrapBandwidth counting
// subtasks as ride-alongs, and _dayPointSummary inverting done/remaining -- which silently
// swaps the day's EARNED and REMAINING point totals. Routing them is only half the job; if a
// mutation to the new form is invisible, the layer bought nothing here.
//
// Behavioural where the function is sliceable, source-asserted (with negative controls)
// where it is not.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installTaskModel } = require("./task-model-vm-fixture.js");
const { stripJsComments } = require("./js-comment-strip-fixture.js");

const read = (f) => fs.readFileSync(require.resolve("./public/js/" + f), "utf8");
const one = (src, re, what) => { const m = src.match(re); if (!m) throw new Error("slice failed: " + what); return m[0]; };
const stateSrc = read("state.js");
const schedTabSrc = read("schedule-tab.js");
const triageCode = stripJsComments(read("triage.js"));
const stateCode = stripJsComments(stateSrc);

// A vm context with the real TaskModel and the harness's own status registries.
function ctxWith(globals, sources) {
  const ctx = Object.assign({ console }, globals);
  vm.createContext(ctx);
  installTaskModel(ctx);
  for (const s of sources) vm.runInContext(s, ctx);
  return ctx;
}
const T = (id, x) => Object.assign({ id, title: id, start: "09:00", end: "09:30" }, x || {});
// vm-realm arrays carry the vm's prototypes, so re-home before a strict assert.
const out = (ctx, expr) => JSON.parse(vm.runInContext("JSON.stringify(" + expr + ")", ctx));

// ─────────────────────────── wrapBandwidth: the wrap edge ONLY ───────────────────────────

test("wrapBandwidth counts RIDE-ALONGS, not every child", () => {
  // The chip reads "N ride-alongs · ~Xm inside". Routing it to childrenOf instead of
  // ridersOf would count a wrap's timeless subtasks as concurrent work and inflate both
  // numbers -- and nothing caught that swap.
  const ctx = ctxWith(
    { pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; } },
    [
      "function _TM(){return DCC.TaskModel;}",
      "function dur(ev){return pt(ev.end)-pt(ev.start)}",
      one(stateSrc, /function isWrap\(ev\)\{[^\n]*\}/, "isWrap"),
      one(stateSrc, /function wrapBandwidth\(ev,pool\)\{[\s\S]*?\n\}/, "wrapBandwidth"),
    ]
  );
  ctx.pool = [
    T("w", { isWrap: true, start: "13:00", end: "14:00" }),
    T("rider", { wrapId: "w", start: "13:00", end: "13:20" }),   // 20 min of concurrent work
    T("step", { subtaskOf: "w", start: "13:00", end: "13:30" }),  // a timeless step, NOT a rider
  ];
  assert.deepEqual(out(ctx, "wrapBandwidth(pool[0],pool)"), { count: 1, mins: 20 },
    "the subtask must not be counted as a ride-along");
  assert.equal(out(ctx, "wrapBandwidth(pool[1],pool)"), null, "a non-wrap has no bandwidth");
  ctx.empty = [T("w2", { isWrap: true })];
  assert.equal(out(ctx, "wrapBandwidth(empty[0],empty)"), null, "an empty wrap has no bandwidth");
});

test("state.js isRideAlong delegates — the wrap edge has one definition too", () => {
  // isRideAlong was ADDED to task-model.js and exported while state.js kept its own body,
  // which made it the second copy the delegation block exists to prevent.
  const rx = /function isRideAlong\(ev\)\{return _TM\(\)\.isRideAlong\(ev\);\}/;
  assert.match(stateCode, rx);
  assert.equal(rx.test("function isRideAlong(ev){return !!wrapParentId(ev);}"), false);
  assert.equal(rx.test("function isRideAlong(ev){return !!(ev&&ev.subtaskOf);}"), false);
  // and wrapBandwidth reads the layer's rider lookup rather than re-filtering.
  assert.match(stateCode, /const kids=_TM\(\)\.ridersOf\(ev\.id,pool\);/);
  assert.equal(/wrapParentId\(k\)===ev\.id&&relOf\(k\)==="ride-along"/.test(stateCode), false,
    "the hand-rolled rider filter must stay gone");
});

// ─────────────────────── the day's POINTS: done vs remaining ───────────────────────

test("_dayPointSummary puts DONE points in earned and OPEN points in remaining", () => {
  // Inverting these two selectors swaps the day's earned and remaining point totals with no
  // other symptom. It is two identifiers apart and nothing caught it.
  const ctx = ctxWith(
    {
      isDone: (ev) => ev.id === "done",
      isDeleted: () => false,
      loadTrivialFlags: () => ({}),
      scheduled: [T("done", { _pts: 10 }), T("open", { _pts: 3 })],
      getDayPointGoals: () => ({ min: 0, max: 0 }),
      _estimatedTaskPoints: (ev) => ev._pts,
    },
    [
      one(schedTabSrc, /function _pointEligibleScheduleItems\(\)\{[\s\S]*?\n\}/, "_pointEligibleScheduleItems"),
      one(schedTabSrc, /function _dayPointSummary\(\)\{[\s\S]*?\n\}/, "_dayPointSummary"),
    ]
  );
  const s = out(ctx, "_dayPointSummary()");
  assert.equal(s.earned, 10, "earned comes from the DONE rows");
  assert.equal(s.remainingPoints, 3, "remaining comes from the OPEN rows");
  assert.equal(s.scheduledPoints, 13);
  assert.deepEqual(s.done.map((e) => e.id), ["done"]);
  assert.deepEqual(s.remaining.map((e) => e.id), ["open"]);
});

test("_pointEligibleScheduleItems excludes deleted, side-project AND day-agnostic rows", () => {
  const ctx = ctxWith(
    {
      isDone: () => false,
      isDeleted: (ev) => ev.id === "del",
      loadTrivialFlags: () => ({ triv: true }),
      scheduled: [T("keep"), T("del"), T("triv"), T("dateless", { _dateless: true })],
    },
    [one(schedTabSrc, /function _pointEligibleScheduleItems\(\)\{[\s\S]*?\n\}/, "_pointEligibleScheduleItems")]
  );
  assert.deepEqual(out(ctx, "_pointEligibleScheduleItems().map(e=>e.id)"), ["keep"]);
});

// ─────────────────────────── pet home: a live guest-facing surface ───────────────────────

test("the pet home's task list still hides DELETED rows", () => {
  // `(scheduled||[]).filter(ev=>ev&&!isDeleted(ev)&&pointEligible(ev))` is the offender that
  // proved the first cut of the source guard was false. Its replacement needs the test the
  // original never had, or the guard traded an inline predicate for an untested one.
  const ctx = ctxWith(
    {
      isDeleted: (ev) => ev.id === "del",
      isDone: () => false,
      pointEligible: (ev) => ev.type !== "meeting",
      scheduled: [T("a"), T("del"), T("m", { type: "meeting" })],
    },
    ["function currentTasks(){try{return DCC.TaskModel.selectNotDeleted(scheduled).filter(pointEligible).slice(0,8);}catch(e){return[];}}"]
  );
  assert.deepEqual(out(ctx, "currentTasks().map(e=>e.id)"), ["a"]);
  // and the shape really is the one in the file (so this test tracks the real code).
  assert.match(stripJsComments(read("pet-home.js")),
    /DCC\.TaskModel\.selectNotDeleted\(scheduled\)\.filter\(pointEligible\)\.slice\(0,8\)/);
});

// ───────────────────────── point-plan: the SUBTASK edge, not either ─────────────────────

test("point-plan's pie slices are SUBTASKS — a ride-along is not a slice", () => {
  // `_subsOf` feeds the point pie. Reading either edge would make a wrap's ride-alongs share
  // the parent's point pool, which is a different (and wrong) points answer.
  const ctx = ctxWith(
    { scheduled: [T("p"), T("slice", { subtaskOf: "p" }), T("rider", { wrapId: "p" })] },
    [
      'function _pool(){return (typeof scheduled!=="undefined"&&scheduled)?scheduled:[];}',
      "function _subsOf(parentId){return DCC.TaskModel.subtasksOf(parentId,_pool());}",
    ]
  );
  assert.deepEqual(out(ctx, '_subsOf("p").map(e=>e.id)'), ["slice"], "the ride-along is not a pie slice");
  assert.match(stripJsComments(read("point-plan.js")),
    /function _subsOf\(parentId\) \{ return DCC\.TaskModel\.subtasksOf\(parentId, _pool\(\)\); \}/);
});

// ───────────────────── sync: the duplicate check is about OPEN rows ─────────────────────

test("scheduling a drawer action is blocked by an OPEN duplicate, not by a finished one", () => {
  // Dropping the open test makes a task you already finished today block you from re-adding
  // it -- and the drawer just says "Already in today's schedule" with no way to see why.
  const ctx = ctxWith(
    {
      isDone: (ev) => ev.id === "finished",
      isDeleted: () => false,
      scheduled: [T("finished", { title: "Water the plants" }), T("live", { title: "Call Mike" })],
    },
    ['function blocked(text){return DCC.TaskModel.selectOpen(scheduled).some(s=>s.title===text);}']
  );
  assert.equal(vm.runInContext('blocked("Call Mike")', ctx), true, "an open duplicate blocks");
  assert.equal(vm.runInContext('blocked("Water the plants")', ctx), false,
    "a task already FINISHED today must not block re-adding it");
  assert.match(stripJsComments(read("sync.js")),
    /DCC\.TaskModel\.selectOpen\(scheduled\)\.some\(s=>s\.title===item\.text\)/);
});

// ──────────────────── the "index of the first open row" insertion point ────────────────────

test("a new task inserts at the first OPEN row's index, not at 0 and not past the end", () => {
  // Three copies of `scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev))` existed
  // (schedule.js x2, state.js). The layer answers "which are open"; the call site answers
  // "where is it". Getting it wrong drops new tasks at the top of a half-finished day.
  // SLICE the real expression instead of retyping it. The first cut ran an inline copy and
  // pinned only its FIRST line, so mutating the last line to `return fi===-1?0:fi;` left both
  // behavioural assertions passing -- i.e. the two that carry the actual risk guarded nothing.
  const insertExpr = one(read("schedule.js"),
    /\(\(\)=>\{const firstOpen=DCC\.TaskModel\.selectOpen\(scheduled\)\[0\];[\s\S]*?\}\)\(\)/, "insertAt IIFE");
  const ctx = ctxWith(
    { isDone: (ev) => ev.id === "d1" || ev.id === "d2", isDeleted: () => false, scheduled: [T("d1"), T("d2"), T("open1"), T("open2")] },
    ["function firstOpenIdx(){return " + insertExpr + ";}"]
  );
  assert.equal(vm.runInContext("firstOpenIdx()", ctx), 2, "index 2 is the first open row");
  ctx.scheduled = [T("d1"), T("d2")];
  assert.equal(vm.runInContext("firstOpenIdx()", ctx), 2, "all done -> append at the end");
  ctx.scheduled = [];
  assert.equal(vm.runInContext("firstOpenIdx()", ctx), 0, "empty day -> index 0");
  // Both files must carry the routed shape, and the retired map-then-filter must stay gone.
  for (const f of ["schedule.js", "state.js"]) {
    const code = stripJsComments(read(f));
    assert.match(code, /DCC\.TaskModel\.selectOpen\(scheduled\)\[0\]|_TM\(\)\.selectOpen\(scheduled\)\[0\]/, f);
    assert.equal(/scheduled\.map\(\(ev,i\)=>\(\{ev,i\}\)\)/.test(code), false, f + " still carries the map-then-filter copy");
  }
});

// ─────────────────────────────── triage: two questions, two lookups ──────────────────────

test("triage scheduling matches by id OR by an open visible triage row of the same title", () => {
  // The two-lookup shape now lives in ONE helper (existingTriageTask), because two
  // paths schedule a triage item: the strip's picker and the catch-up modal's
  // date-only buttons. Inlining it twice is how they would drift apart.
  // Both halves must still be there, as two separate lookups.
  const byId = /const byId=scheduled\.find\(ev=>ev\.triageId===triageId\);/;
  const byTitle = /return DCC\.TaskModel\.selectActive\(scheduled\)\.find\(ev=>ev\.source==="triage"&&ev\.title===item\.title\);/;
  assert.match(triageCode, byId);
  assert.match(triageCode, byTitle);
  // And the title half must stay DATE-SCOPED: `scheduled` holds only the viewed day,
  // so it cannot answer "is this already on Thursday". Unscoped, a Tomorrow click
  // reports "already on the schedule" and links the item to the wrong day's task.
  assert.match(triageCode, /if\(dateStr&&viewing&&dateStr!==viewing\)return null;/);
  // Negative controls: the merged single-lookup form, and dropping either half.
  assert.equal(byTitle.test('return scheduled.find(ev=>ev.triageId===triageId);'), false,
    "dropping the title match would re-mint a duplicate task");
  assert.equal(byId.test('return scheduled.find(ev=>ev.triageId===triageId||(!isDone(ev)&&!isDeleted(ev)&&ev.source==="triage"&&ev.title===item.title));'), false,
    "the pre-C6a merged predicate must not satisfy this");
  // And both schedulers must go through it rather than re-deriving the answer.
  for (const fn of ["function scheduleTriageItem(", "async function scheduleTriageOnDate("]) {
    const body = triageCode.slice(triageCode.indexOf(fn));
    // The date-specific scheduler passes dateStr; the strip's picker path does not.
    assert.match(body.slice(0, 1200), /existingTriageTask\(triageId,item(,dateStr)?\)/,
      fn + " must route through the shared lookup");
  }
});

test("a scheduled triage item is recorded DURABLY, and not as completed work", () => {
  // The load-bearing half of this feature: 65a17c1 moved dismiss and delete onto
  // dateless suppression rows because day_root state expires at midnight, and left
  // _triageScheduled behind. Without the durable write, an item turned into a task on
  // Tuesday is back in Wednesday's recap and "Today" mints a duplicate.
  const rec = triageCode.slice(triageCode.indexOf("function recordTriageScheduled("));
  const fn = rec.slice(0, rec.indexOf("\nasync function scheduleTriageOnDate("));
  assert.match(fn, /persistTriageSuppression\(triageId,item,"scheduled","Scheduled",false\)/,
    "the decision outlives the day, in the same authority dismiss and delete use");
  // reason MUST NOT be "done": four client sites read reason==="done" as completed work
  // (Done tab, Completed Today, the plan timeline, and the day's actual/planned totals),
  // so "done" billed the item as finished while its new task was still open.
  assert.equal(/persistTriageSuppression\([^)]*"done"/.test(fn), false,
    "scheduled is its own disposition, not a completion");
  // And the server has to preserve the third value rather than collapsing it.
  const sup = require("node:fs").readFileSync(require.resolve("./triage-suppressions.js"), "utf8");
  assert.match(sup, /reason: \(reason === "deleted" \|\| reason === "scheduled"\) \? reason : "done"/);
});

test("scheduling a triage item onto the VIEWED day refolds the itinerary", () => {
  // scheduleTaskOnDate writes a block; it does not touch the in-memory scheduled[]
  // that the itinerary renders. Without this refold the row exists on the server and
  // nowhere on screen until a reload — which reads as "Today did nothing".
  const body = triageCode.slice(triageCode.indexOf("async function scheduleTriageOnDate("));
  const fn = body.slice(0, body.indexOf("\nfunction scheduleTriageItem("));
  // deferRefold is a contract the "Move all" batch depends on: without it the batched
  // refold is undone once per item by a per-item loadDay + full render.
  assert.match(fn, /if\(dateStr===viewing&&!opts\.deferRefold\)/,
    "must compare the target to the viewed date AND honour the batch deferral");
  // A packed day must never be silent, and must never stack one toast per batch item.
  assert.match(fn, /if\(!block\)\{\s*\n\s*if\(!opts\.silent&&typeof showToast==="function"\)showToast\("No free slot on "/,
    "the no-slot failure toast exists and respects opts.silent");
  for (const call of ["blockStore.loadDay(dateStr)", "reloadPersistedEdits()", "recalcTimes()", "render()"]) {
    assert.ok(fn.indexOf(call) > -1, "missing " + call + " — the same fold delegated.js does");
  }
});

test("the done-modal parent list escapes both the title and the id", () => {
  // The one HTML builder in triage.js that skipped DCC.esc, on a line this phase rewrote.
  // Titles are not all owner-authored: data.js takes them from the server timeline, and
  // guest public-share submissions are only trimmed and truncated server-side.
  const rx = /'<option value="' \+ DCC\.esc\(String\(e\.id\)\) \+ '"' \+ \(triageParents\[id\] === e\.id \? ' selected' : ''\) \+ '>' \+ DCC\.esc\(e\.title \|\| ''\)/;
  assert.match(triageCode, rx);
  assert.equal(rx.test("'<option value=\"' + e.id + '\"' + (triageParents[id] === e.id ? ' selected' : '') + '>' + e.title"), false,
    "the unescaped form must be rejected");
});
