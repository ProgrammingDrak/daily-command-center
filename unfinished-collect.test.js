// Contract tests for the carryover lane: the collector in
// public/js/unfinished-tasks.js and the row wiring in public/js/schedule-tab.js.
//
// What these pin, in the order the bugs bit:
//   1. the collector hands out FULL evs (TaskModel.fromBlock) — no bespoke row bag,
//      so source_id / tags / privacy / the parent edge reach the row builder
//   2. children are kept WITH their edge, so the lane can nest them instead of
//      promoting every timed subtask to a standalone top-level task
//   3. the lookback is bounded (it was "every archived day" against a 90-day
//      archive, which is what clogged the lane)
//   4. an unfinished row's affordances are the work list's affordances
//
// Harness pattern: the whole IIFE runs in a node:vm context with a stubbed
// window/document (recalc-times.test.js style, one level up: whole file rather
// than a sliced function, so the real wiring is what's under test).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskModel = require("./public/js/task-model.js");
const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
const schedTabSource = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");

// Values that cross back out of the vm carry the vm realm's prototypes, so
// structural asserts go through JSON rather than deepStrictEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));

const TODAY = "2026-07-29";
const ymd = (offsetDays) => {
  const d = new Date(TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};

// A past-day task block as the range cache serves it.
const blk = (id, date, props) => ({
  id, type: "block", date, created_at: date + "T09:00:00.000Z",
  properties: Object.assign({ local_id: id, title: id, type: "task", start: "09:00", end: "09:30", duration: 30 }, props || {})
});
const dayRoot = (props) => ({ id: "root", type: "day_root", properties: props || {} });

// Build a live carryover module over a fake blockStore.
function load(daysByDate, archiveDates) {
  const store = {
    _loaded: [],
    async loadDateRange(start, end) { store._loaded.push([start, end]); },
    getRangeCache(date) { return daysByDate[date] ? { blocks: daysByDate[date] } : null; },
    get() { return null; }
  };
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { readyState: "complete", getElementById: () => null, addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, querySelector: () => null, querySelectorAll: () => [], appendChild(){}, addEventListener(){} }), body: { appendChild(){} } },
    __todayDate: TODAY,
    __archiveDates: archiveDates,
    // state.js's canonical time helpers, which the module prefers when present.
    pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    ms: (m) => (m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"),
    dur: (ev) => ctx.pt(ev.end) - ctx.pt(ev.start),
    escHtml: (s) => String(s == null ? "" : s)
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(unfSource, ctx);
  ctx.window.blockStore = store;
  ctx.window.DCC.TaskModel = TaskModel;
  return { ctx, store, CO: ctx.window.DCC.Carryover };
}

// ───────────────────────────── the collector ─────────────────────────────

test("rows are full evs: every field the row builder reads survives collection", async () => {
  const d = ymd(1);
  const { CO } = load({ [d]: [dayRoot(), blk("t1", d, {
    title: "Review PR", source: "slack", source_id: "https://clever.slack.com/archives/C1/p1",
    tags: ["amp"], publicVisibility: "private", prep_status: "ready"
  })] }, [d]);
  const { rows, total } = await CO.collect();
  assert.equal(total, 1);
  const ev = rows[0];
  assert.equal(ev.title, "Review PR");
  assert.equal(ev.source_id, "https://clever.slack.com/archives/C1/p1");  // the Slack ↗ pill
  assert.deepEqual(plain(ev.tags), ["amp"]);                                      // tag chips
  assert.equal(ev.publicVisibility, "private");                            // Private, not hardcoded PUBLIC
  assert.equal(ev.prepStatus, "ready");                                    // Prep chip
  // end is anchored to the row's own start (no recalcTimes pass on a carryover)
  assert.equal(ev.start, "09:00");
  assert.equal(ev.end, "09:30");
  // provenance for the amber chip + the origin-day writes
  assert.deepEqual(plain(ev.__unf), { sourceId: "t1", sourceLocalId: "t1", sourceDate: d, createdAt: d + "T09:00:00.000Z", done: false });
});

test("children are kept WITH their edge — timeless subtasks included", async () => {
  const d = ymd(2);
  const { CO } = load({ [d]: [
    dayRoot(),
    blk("parent", d, { title: "Do Laundry", start: "11:00", end: "11:30" }),
    blk("kid1", d, { title: "Washer", subtaskOf: "parent", start: "11:00", end: "11:00", duration: 0 }),
    // A genuinely timeless step: no start at all. The old collector dropped these
    // outright (`if (!p.start) continue`), so half a subtree vanished.
    { id: "kid2", type: "block", date: d, created_at: null, properties: { local_id: "kid2", title: "Dryer", type: "task", subtaskOf: "parent", duration: 0 } },
    blk("ride", d, { title: "Ride along", wrapId: "parent" })
  ] }, [d]);
  const { rows } = await CO.collect();
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(plain(Object.keys(byId).sort()), ["kid1", "kid2", "parent", "ride"]);
  assert.equal(byId.kid1.subtaskOf, "parent");
  assert.equal(byId.kid2.subtaskOf, "parent");
  assert.equal(byId.ride.wrapId, "parent");
  // A subtask whose start === end is timeless, so the row renders its point slice
  // instead of the bogus "1m" the old durMin floor produced.
  assert.equal(byId.kid1.start, byId.kid1.end);
});

test("a done CHILD rides along for progress; a done top-level task does not", async () => {
  const d = ymd(1);
  const { CO } = load({ [d]: [
    dayRoot({ _done: { ids: ["k1", "k2", "finished"] } }),
    blk("finished", d, {}),                                  // done root: simply gone
    blk("p", d, { title: "Parent" }),
    blk("k1", d, { subtaskOf: "p" }), blk("k2", d, { subtaskOf: "p" }),
    blk("k3", d, { subtaskOf: "p" }), blk("k4", d, { subtaskOf: "p" }), blk("k5", d, { subtaskOf: "p" })
  ] }, [d]);
  const { rows, total } = await CO.collect();
  assert.deepEqual(plain(rows.map(r => r.id).sort()), ["k1", "k2", "k3", "k4", "k5", "p"]);
  // the lane counts OPEN work only: parent + 3 open steps
  assert.equal(total, 4);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.k1.__unf.done, true);
  assert.equal(byId.k3.__unf.done, false);
  // ...which is what lets the row render "2/5 subtasks" instead of "0/3".
  const doneKids = rows.filter(r => r.subtaskOf === "p" && r.__unf.done).length;
  assert.equal(doneKids + "/" + rows.filter(r => r.subtaskOf === "p").length, "2/5");
});

test("descendants() walks the whole subtree and survives a parent cycle", async () => {
  const d = ymd(1);
  const { CO } = load({ [d]: [dayRoot()] }, [d]);
  const pool = [
    { id: "a" }, { id: "b", subtaskOf: "a" }, { id: "c", subtaskOf: "b" },
    { id: "d", wrapId: "a" }, { id: "loop", subtaskOf: "loop" }
  ];
  assert.deepEqual(plain(CO.descendants(pool[0], pool).map(x => x.id).sort()), ["b", "c", "d"]);
  assert.deepEqual(plain(CO.descendants(pool[4], pool).map(x => x.id)), []);
});

test("lookback is bounded to SCAN_DAYS; {days:null} lifts it", async () => {
  const recent = ymd(3), old = ymd(40);
  const days = { [recent]: [dayRoot(), blk("recent", recent, {})], [old]: [dayRoot(), blk("old", old, {})] };
  const { CO, store } = load(days, [old, recent]);
  assert.equal(CO.SCAN_DAYS, 14);

  const bounded = await CO.collect();
  assert.deepEqual(plain(bounded.rows.map(r => r.id)), ["recent"]);
  assert.equal(store._loaded[0][0], recent, "bounded scan must not fetch the whole archive");

  const all = await CO.collect({ days: null });
  assert.deepEqual(plain(all.rows.map(r => r.id).sort()), ["old", "recent"]);
  assert.equal(store._loaded[1][0], old, "unbounded scan starts at the oldest archived day");
});

test("completed, deleted-type and fixed-type rows never surface", async () => {
  const d = ymd(1);
  const { CO } = load({ [d]: [
    dayRoot({ _done: { ids: ["doneById", "doneLocal"] } }),
    blk("doneById", d, {}),                            // marked done by row id
    blk("doneLocalBlk", d, { local_id: "doneLocal" }), // marked done by local_id
    blk("propDone", d, { done: true }),
    blk("mtg", d, { type: "meeting" }),
    blk("brk", d, { type: "break" }),
    blk("focus", d, { type: "focus" }),
    blk("open", d, {})
  ] }, [d]);
  const { rows } = await CO.collect();
  assert.deepEqual(plain(rows.map(r => r.id)), ["open"]);
});

test("a row is collected once even when it appears on two days", async () => {
  const d1 = ymd(1), d2 = ymd(2);
  const { CO } = load({ [d1]: [dayRoot(), blk("dupe", d1, {})], [d2]: [dayRoot(), blk("dupe", d2, {})] }, [d1, d2]);
  const { rows, total } = await CO.collect();
  assert.equal(total, 1);
  assert.equal(rows.length, 1);
});

test("locks come off the ORIGIN day's day_root so the padlock renders", async () => {
  const d = ymd(1);
  const { CO } = load({ [d]: [dayRoot({ _lockedTasks: ["pinned"] }), blk("pinned", d, {}), blk("loose", d, {})] }, [d]);
  const { rows } = await CO.collect();
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.pinned._locked, true);
  assert.equal(byId.loose._locked, undefined);
});

test("newest origin day first", async () => {
  const d1 = ymd(1), d5 = ymd(5);
  const { CO } = load({ [d1]: [dayRoot(), blk("yesterday", d1, {})], [d5]: [dayRoot(), blk("older", d5, {})] }, [d5, d1]);
  const { rows } = await CO.collect();
  assert.deepEqual(plain(rows.map(r => r.id)), ["yesterday", "older"]);
});

test("no archive, or no TaskModel, degrades to an empty lane", async () => {
  const empty = await load({}, []).CO.collect();
  assert.deepEqual(plain(empty), { rows: [], total: 0, scanned: 0 });
  const d = ymd(1);
  const noModel = load({ [d]: [dayRoot(), blk("t", d, {})] }, [d]);
  noModel.ctx.window.DCC.TaskModel = null;
  assert.deepEqual(plain(await noModel.CO.collect()), { rows: [], total: 0, scanned: 0 });
});

// ────────────────────── the row wiring (source contracts) ──────────────────────

test("both lossy projections are gone", () => {
  assert.ok(!/function _unfToEv/.test(schedTabSource), "_unfToEv must be retired");
  assert.ok(!/durMin:\s*durMin/.test(unfSource) && !/rows\.push\(\{/.test(unfSource),
    "the bespoke 15-field row bag must be retired (rows are evs now)");
  assert.ok(/TaskModel\.fromBlock\(b, \{ deriveEnd: true \}\)/.test(unfSource), "the collector must project through TaskModel");
});

test("the five affordance gates are off the carryover row", () => {
  // Quick-complete, the start time and the Schedule… button no longer test isUnfRow.
  assert.ok(/!isDoneRow&&!\(tt&&tt\.rollupMode\)\?'<button class="chk-quick"/.test(schedTabSource),
    "quick-complete must not be gated on isUnfRow");
  assert.ok(/\(subTimeless\?'':\(ev\.untimed\?/.test(schedTabSource),
    "the start-time cell must not be gated on isUnfRow");
  assert.ok(/\(!subTimeless&&!isDoneRow&&!isMeeting\(ev\)\?'<button class="btn-schedule"/.test(schedTabSource),
    "the Schedule… button must not be gated on isUnfRow");
  // Both carryover schedule affordances route to the shared true-move.
  assert.ok(/if\(isUnfRow\)\{_unfSchedulePopover\(ev,el,stSpan\);return;\}/.test(schedTabSource));
  assert.ok(/if\(isUnfRow\)\{_unfSchedulePopover\(ev,el,sb\);return;\}/.test(schedTabSource));
});

test("carryover actions route through the ONE shared implementation", () => {
  for (const call of ["C.complete(ev,unfPool)", "C.drop(ev,unfPool)", "C.toBacklog(ev,unfPool)"]) {
    assert.ok(schedTabSource.includes(call), `${call} must go through DCC.Carryover`);
  }
  // ...and the row no longer re-implements the reschedule/delete/complete calls.
  assert.ok(!/blockStore\.rescheduleBlock\(r\.sourceId/.test(schedTabSource));
  assert.ok(!/blockStore\.deleteBlock\(r\.sourceId/.test(schedTabSource));
  assert.ok(!/commitDoneOnDate\(r\.sourceLocalId/.test(schedTabSource));
  // Drop deletes the subtree in ONE atomic batch (carryover-review's Drop deleted
  // nothing at all, and the inline row's deleted only the parent).
  assert.ok(/batchOp\(ids\.map\(id => \(\{ op: "delete", id \}\)\)\)/.test(unfSource));
});

test("carryover rows render through the shared tree, with their own pool", () => {
  assert.ok(/const pool=isUnfRow\?unfPool:scheduled;/.test(schedTabSource),
    "tree lookups must use the row's own pool");
  assert.ok(/wrapBandwidth\(ev,pool\)/.test(schedTabSource) && /subtaskProgress\(ev\.id,pool\)/.test(schedTabSource));
  assert.ok(/flattenSchedule\(rootOrder\.concat/.test(schedTabSource),
    "the lane must render through flattenSchedule so children nest");
  assert.ok(/emitNode\(node,_isSubRow\(node\)\?0:rank\+\+,"unfinished"\)/.test(schedTabSource),
    "carryover nodes must pass the tree node to row() (subtask variant + indent)");
});

// A subtask whose parent is NOT in the pool comes back from flattenSchedule as a
// ROOT (depth 0). It must stay visible — standalone work never disappears — but it
// must also READ as standalone: a rank number and its own type tag, not "·" plus a
// "Subtask" label with nothing above it to belong to. Routine in the carryover lane,
// where a done parent is excluded and its still-open child is not.
test("an ORPHANED subtask renders as top-level, not as a subtask", () => {
  const slice = /function _isSubRow\(node\)\{[^}]*\}/.exec(schedTabSource);
  assert.ok(slice, "_isSubRow must exist");
  const _isSubRow = new Function(`${slice[0]}; return _isSubRow;`)();

  // nested under a present parent -> a real sub row
  assert.equal(_isSubRow({ rel: "subtask", depth: 1 }), true);
  assert.equal(_isSubRow({ rel: "subtask", depth: 2 }), true);
  // orphan: carries the edge, but flattenSchedule made it a root
  assert.equal(_isSubRow({ rel: "subtask", depth: 0 }), false);
  // ride-alongs are untouched by this rule (they keep their rank number today)
  assert.equal(_isSubRow({ rel: "ride-along", depth: 1 }), false);
  assert.equal(_isSubRow({ rel: null, depth: 0 }), false);
  assert.equal(_isSubRow(null), false);

  // and every rank counter agrees with the chrome, or an orphan would take "·" from
  // row() while the caller withheld its number (or vice versa).
  assert.ok(/const subRow=_isSubRow\(node\);/.test(schedTabSource), "row() must gate the subtask variant on _isSubRow");
  assert.ok(/function emitNode\(node,idx,mode\)\{return row\(node\.ev,_isSubRow\(node\)\?0:idx,mode,node\);\}/.test(schedTabSource));
  assert.ok(/const isSub=_isSubRow\(node\);/.test(schedTabSource), "the work list's rank counter must use the same rule");
  assert.ok(!/rel==="subtask"\?0:/.test(schedTabSource), "no rank counter may still gate on rel alone");
});

test("the Unscheduled badge no longer sums two different things", () => {
  assert.ok(!/section\("Unscheduled",untimedItems\.length\+/.test(schedTabSource),
    "the Unscheduled count must not add the carryover total");
  assert.ok(/section\("Unscheduled",untimedItems\.length,"unscheduled","uns-group"\)/.test(schedTabSource));
  assert.ok(/section\("Unfinished",roots\.length,null,"uns-group"\)/.test(schedTabSource));
});

// The window boundary, not just "somewhere between 4 and 39 days". The bounded
// lookback is the fix for the clog, and the previous test probed day 3 vs day 40, so
// changing SCAN_DAYS to 30 or flipping `d >= floor` to `d > floor` left it green while
// the lane silently re-clogged. The collector's rule is
// floor = today - SCAN_DAYS, kept with `d >= floor`, so day 14 is IN and day 15 is OUT.
test("the SCAN_DAYS window includes day 14 and excludes day 15", async () => {
  const inWin = ymd(14), outWin = ymd(15);
  const { CO } = load({
    [inWin]: [dayRoot(), blk("in", inWin, {})],
    [outWin]: [dayRoot(), blk("out", outWin, {})]
  }, [outWin, inWin]);
  const { rows } = await CO.collect();
  assert.deepEqual(plain(rows.map(r => r.id)), ["in"], "day 14 in, day 15 out");
});

test("{days:null} lifts the bound and reaches past day 15", async () => {
  const inWin = ymd(14), outWin = ymd(15);
  const { CO } = load({
    [inWin]: [dayRoot(), blk("in", inWin, {})],
    [outWin]: [dayRoot(), blk("out", outWin, {})]
  }, [outWin, inWin]);
  const { rows } = await CO.collect({ days: null });
  assert.deepEqual(plain(rows.map(r => r.id).sort()), ["in", "out"]);
});

// _unfProgress produces the "2/5 subtasks" label on a carryover row. It is recursive,
// accumulates nested descendants into the parent's count, cycle-guards with _seen, and
// returns null for a childless row -- four branches that had no coverage of either
// kind (the previous "2/5" assertion recomputed the label from the test's own data, so
// it could not fail independently of the assertions above it).
test("_unfProgress counts done children, nested descendants, and survives a cycle", () => {
  const slice = /function _unfProgress\(id,pool,_seen\)\{[\s\S]*?\n\}/.exec(schedTabSource);
  assert.ok(slice, "_unfProgress must exist");
  const _unfProgress = new Function(`${slice[0]}; return _unfProgress;`)();

  const pool = [
    { id: "p" },
    { id: "k1", subtaskOf: "p", __unf: { done: true } },
    { id: "k2", subtaskOf: "p", __unf: { done: true } },
    { id: "k3", subtaskOf: "p", __unf: { done: false } },
    { id: "g1", subtaskOf: "k3", __unf: { done: true } }   // grandchild rolls up
  ];
  assert.deepEqual(plain(_unfProgress("p", pool)), { done: 3, total: 4 });
  assert.deepEqual(plain(_unfProgress("k3", pool)), { done: 1, total: 1 });
  assert.equal(_unfProgress("leaf", pool), null, "a childless row gets no chip");
  // a self-referential edge must terminate rather than recurse forever
  assert.deepEqual(plain(_unfProgress("c", [{ id: "c", subtaskOf: "c", __unf: { done: false } }])), { done: 0, total: 1 });
});

// The Catch up MODAL has to list the same thing the lane and the prompt list. It used
// to hand renderRows every open row flat, so a child got its own Today/Tomorrow/
// Backlog/Drop -- rescheduling the child alone stranded its parent on the origin day
// and landed the child as an orphan, which is the standalone-subtask bug this phase
// removes. The full pool still reaches renderRows so subtree actions carry descendants.
test("the Catch up modal lists ROOTS, and every surface shares one predicate", () => {
  assert.ok(/renderRows\(overlay, rootsOf\(result\.rows\), result\.total, result\.rows\)/.test(unfSource),
    "the modal must render roots, with the full pool passed through for subtree actions");
  assert.ok(!/renderRows\(overlay, result\.rows\.filter/.test(unfSource),
    "the flat open-rows list must be gone");
  // and the predicates are exported, so no surface needs its own copy
  assert.ok(/openRows: openRows,/.test(unfSource) && /rootsOf: rootsOf,/.test(unfSource));
  assert.ok(/window\.DCC\.Carryover\.openRows\(pool\)/.test(
    require("node:fs").readFileSync(require.resolve("./public/js/catch-up.js"), "utf8")),
    "catch-up.js must defer to the shared predicate rather than keep a copy");
  assert.ok(/_CO_\?_CO_\.rootsOf\(unfPool\)/.test(schedTabSource),
    "the lane must defer to the shared predicate too");
});

// Untimed-today and carryovers share one persisted order array but render as two
// headers in a FIXED sequence, so an order interleaving them cannot be drawn. C1
// split the previously-combined list into those two sections; accepting a
// cross-group drop persisted a position the renderer then ignored, so the row
// snapped back and the drag was a silent no-op. Reorder within a group only.
test("cross-group drops are not accepted as reorders (the position is unrenderable)", () => {
  const slice = /function handleUnscheduledDrop\(movedId,targetId,e\)\{[\s\S]*?\n\}/.exec(schedTabSource);
  assert.ok(slice, "handleUnscheduledDrop must exist");
  assert.ok(/if\(\(movedUnf&&targetUnf\)\|\|\(movedUntimed&&targetUntimed\)\)\{/.test(slice[0]),
    "the reorder branch must require both rows to be in the SAME group");
  assert.ok(!/if\(targetUnf\|\|targetUntimed\)\{/.test(slice[0]),
    "the old target-only test accepted cross-group drops and persisted a dead order");
  // the carryover-onto-timed-row gesture must survive as the meaningful cross case
  assert.ok(/_unfScheduleIntoToday\(movedUnf,targetEv,after\)/.test(slice[0]),
    "a carryover dropped at the work list still schedules into today");
});
