// Contract tests for C6a's derivation layer in public/js/task-model.js:
// selectDay, selectTree, the shape/status predicates and the edge lookups.
//
// What these pin, in the order the bugs bit:
//   1. selectTree HIDES a child whose parent is in the pool but filtered out of the
//      input, and still PROMOTES a genuine orphan. That one difference is the whole
//      reason flattenSchedule moved: resolving roots against the input array meant any
//      filter that dropped a parent promoted its children to depth 0.
//   2. selectDay's two partitions are disjoint AND exhaustive, so no row can be
//      dropped by a section boundary or rendered twice.
//   3. a done RIDE-ALONG folds under its visible parent. Both fold predicates this
//      replaced tested `subtaskOf` only, so a done ride-along listed forever.
//   4. a wrap/shell child does NOT leak into Unscheduled as a standalone row
//      (`!isNested`, where the old predicate said `!isSubtask`).
//   5. a done row with an OPEN descendant does NOT fold — folding it would hide that
//      open work on every surface, which is worse than the orphan promotion being fixed.
//   6. isNested reads the real parent edges. `ev.nested` was written as a literal
//      `false` by data.js and set true by nothing, yet gated the focus banner and the
//      pomodoro picker, so both could offer a subtask as "your next task".
//   7. a missing status resolver THROWS instead of quietly answering "nothing is done".
//
// Harness: the module is require()d directly — it is pure and dependency-free, which
// is the invariant that forced status to be injected in the first place. Resolvers are
// passed explicitly via opts so no test depends on an ambient global.
const test = require("node:test");
const assert = require("node:assert/strict");

const vm = require("node:vm");
const TaskModel = require("./public/js/task-model.js");
// For the ONE path that reads a page global rather than an injected resolver.
const { installTaskModel } = require("./task-model-vm-fixture.js");

// Status lives in registries outside the ev (C5b), so the harness models them the same
// way the page does: an id Set per registry, read through a resolver.
function res(doneIds, deletedIds, trivialIds) {
  return {
    isDone: (ev) => !!ev && new Set(doneIds || []).has(ev.id),
    isDeleted: (ev) => !!ev && new Set(deletedIds || []).has(ev.id),
    trivialFlags: (trivialIds || []).reduce((m, id) => (m[id] = true, m), {}),
  };
}
const ids = (list) => list.map((x) => (x && x.ev ? x.ev.id : x.id));
// {id, depth, rel} per node — the shape a row builder actually branches on.
const shape = (nodes) => nodes.map((n) => n.ev.id + "@" + n.depth + (n.rel ? ":" + n.rel : ""));

const T = (id, extra) => Object.assign({ id, title: id, start: "09:00", end: "09:30" }, extra || {});
const untimed = (id, extra) => T(id, Object.assign({ untimed: true, start: "00:00" }, extra || {}));

// ══════════════════════════════════════ shape ══════════════════════════════════════

test("isNested reads the real parent edges, and ignores the dead `nested` field", () => {
  assert.equal(TaskModel.isNested(T("a")), false);
  assert.equal(TaskModel.isNested(T("s", { subtaskOf: "p" })), true);
  assert.equal(TaskModel.isNested(T("r", { wrapId: "w" })), true);
  // ★ the bug: data.js wrote `nested:false` on every ev and nothing ever wrote true,
  // so `!ev.nested` removed nothing and `if(ev.nested)` never fired.
  assert.equal(TaskModel.isNested(T("s2", { subtaskOf: "p", nested: false })), true,
    "a subtask carrying the legacy nested:false is still nested");
  assert.equal(TaskModel.isNested(T("a2", { nested: true })), false,
    "the legacy `nested` field is not an edge and must not be read as one");
  assert.equal(TaskModel.isNested(null), false);
});

test("parentIdOf keeps the ev-space edge order: wrapId wins over subtaskOf", () => {
  // state.js documents the deliberate divergence from lib/reschedule.js's row-space
  // order. A row carrying both edges must resolve the same way it always has.
  assert.equal(TaskModel.parentIdOf(T("x", { wrapId: "w", subtaskOf: "s" })), "w");
  assert.equal(TaskModel.parentIdOf(T("x", { subtaskOf: "s" })), "s");
  assert.equal(TaskModel.parentIdOf(T("x")), null);
  assert.equal(TaskModel.parentIdOf(null), null);
  assert.equal(TaskModel.relOf(T("x", { wrapId: "w", subtaskOf: "s" })), "ride-along");
});

test("the three edge lookups answer three different questions", () => {
  const pool = [T("p"), T("s", { subtaskOf: "p" }), T("r", { wrapId: "p" }), T("other")];
  assert.deepEqual(ids(TaskModel.childrenOf("p", pool)), ["s", "r"], "childrenOf = either edge");
  assert.deepEqual(ids(TaskModel.ridersOf("p", pool)), ["r"], "ridersOf = the wrap edge only");
  assert.deepEqual(ids(TaskModel.subtasksOf("p", pool)), ["s"], "subtasksOf = the subtask edge only");
  assert.deepEqual(TaskModel.childrenOf("p", null), [], "a null pool is empty, not a throw");
});

test("isScheduled / isDayScoped separate 'no clock time' from 'not this day'", () => {
  assert.equal(TaskModel.isScheduled(T("a")), true);
  assert.equal(TaskModel.isScheduled(untimed("u")), false);
  assert.equal(TaskModel.isDayScoped(T("a")), true);
  assert.equal(TaskModel.isDayScoped(T("d", { _dateless: true })), false);
});

// ═══════════════════════════════ injected status ═══════════════════════════════════

test("★ a missing status resolver THROWS — it never answers 'nothing is done'", () => {
  // There is no `ev.done`: completion lives on the row and is projected into the
  // manualDone registry (C5b). A fallback reading an ev flag would answer false for
  // every real ev — a fake more benign than production, which is a different program.
  assert.throws(() => TaskModel.selectOpen([T("a")]), /pass opts\.isDone/);
  assert.throws(() => TaskModel.selectDone([T("a")]), /pass opts\.isDone/);
  assert.throws(() => TaskModel.selectNotDeleted([T("a")]), /pass opts\.isDeleted/);
  assert.throws(() => TaskModel.selectVisible([T("a")], { isDeleted: () => false }), /pass opts\.trivialFlags/);
  assert.throws(() => TaskModel.selectDay([T("a")], "2026-08-04", { isDone: () => false }), /pass opts\.isDeleted/);
  // The shape predicates need no status and must NOT throw.
  assert.doesNotThrow(() => TaskModel.selectTopLevel([T("a")]));
  assert.doesNotThrow(() => TaskModel.selectTree([T("a")]));
  assert.doesNotThrow(() => TaskModel.selectCarryover([T("a")]));
});

test("selectOpen / selectActive / selectTimedActive preserve their exact differences", () => {
  const pool = [T("a"), T("done"), T("del"), untimed("u")];
  const o = res(["done"], ["del"]);
  // selectOpen deliberately does NOT exclude deleted rows: most call sites had already
  // excluded them upstream, and folding the two together would change what they count.
  assert.deepEqual(ids(TaskModel.selectOpen(pool, o)), ["a", "del", "u"]);
  assert.deepEqual(ids(TaskModel.selectActive(pool, o)), ["a", "u"]);
  assert.deepEqual(ids(TaskModel.selectTimedActive(pool, o)), ["a"], "untimed rows take no time slot");
  assert.deepEqual(ids(TaskModel.selectDone(pool, o)), ["done"]);
});

test("selectVisible hides deleted AND side-project-flagged rows", () => {
  const pool = [T("a"), T("del"), T("triv")];
  assert.deepEqual(ids(TaskModel.selectVisible(pool, res([], ["del"], ["triv"]))), ["a"]);
});

test("selectDayScoped drops day-agnostic rows, and the exported status wrappers agree", () => {
  // Same gap that let a selectTopLevel pass-through through: the PREDICATE was covered, the
  // SET was not, and the set is what the call sites use. selectDayScoped feeds three
  // user-visible numbers -- buildProgress's day bar, _remainingForScope, and
  // _pointEligibleScheduleItems (the day's point totals).
  const pool = [T("a"), T("d", { _dateless: true }), untimed("u")];
  assert.deepEqual(ids(TaskModel.selectDayScoped(pool)), ["a", "u"], "_dateless rows are not this day's plan");
  assert.deepEqual(TaskModel.selectDayScoped(null), []);
  assert.deepEqual(ids(TaskModel.selectDayScoped([null, T("x")])), ["x"]);
  const o = res(["done"], ["del"]);
  assert.equal(TaskModel.isDone(T("done"), o), true);
  assert.equal(TaskModel.isDone(T("a"), o), false);
  assert.equal(TaskModel.isOpen(T("done"), o), false);
  assert.equal(TaskModel.isOpen(T("a"), o), true);
  assert.equal(TaskModel.isOpen(null, o), false, "a null ev is not open");
  assert.equal(TaskModel.isDeleted(T("del"), o), true);
  assert.equal(TaskModel.isDeleted(T("a"), o), false);
});

test("selectRoots is 'nothing here parents you', which is NOT selectTopLevel", () => {
  // The carryover lane's fallback conflated these in review: rootsOf promotes an orphan whose
  // parent finished on another day, selectTopLevel excludes anything carrying an edge at all.
  const pool = [T("p"), T("kid", { subtaskOf: "p" }), T("orphan", { subtaskOf: "gone" }), T("solo")];
  assert.deepEqual(ids(TaskModel.selectRoots(pool)), ["p", "orphan", "solo"], "the orphan IS a root here");
  assert.deepEqual(ids(TaskModel.selectTopLevel(pool)), ["p", "solo"], "but it is NOT top-level");
  assert.deepEqual(TaskModel.selectRoots(null), []);
});

test("selectTopLevel / selectOpenTopLevel drop nested rows of BOTH edge types", () => {
  // The set behind the two dead nesting guards. A mutation making selectTopLevel a
  // pass-through went uncaught until this existed — `isNested` was covered as a
  // predicate, the set it feeds was not, and the set is what the call sites use.
  const pool = [T("top"), T("sub", { subtaskOf: "top" }), T("rider", { wrapId: "top" }), T("topDone")];
  assert.deepEqual(ids(TaskModel.selectTopLevel(pool)), ["top", "topDone"]);
  assert.deepEqual(ids(TaskModel.selectOpenTopLevel(pool, res(["topDone"]))), ["top"]);
  assert.deepEqual(TaskModel.selectTopLevel(null), []);
  assert.deepEqual(ids(TaskModel.selectTopLevel([null, T("x")])), ["x"]);
});

// ═══════════════════════════════════ selectTree ════════════════════════════════════

test("selectTree nests subtasks before ride-alongs, and ride-alongs by start time", () => {
  const pool = [
    T("p"),
    T("late", { wrapId: "p", start: "11:00", end: "11:30" }),
    T("early", { wrapId: "p", start: "10:00", end: "10:30" }),
    T("step", { subtaskOf: "p" }),
  ];
  assert.deepEqual(shape(TaskModel.selectTree(pool)),
    ["p@0", "step@1:subtask", "early@1:ride-along", "late@1:ride-along"]);
});

test("★ selectTree HIDES a child whose parent is in the pool but filtered out of the input", () => {
  // This is the orphan fix. Before C6a, roots resolved against the INPUT array, so any
  // filter that dropped a parent promoted its children to depth 0 — the child rendered
  // as a top-level task with a rank number of its own while its parent sat in another
  // section. state.js:786 documented that as known behaviour.
  const pool = [T("p"), T("kid", { subtaskOf: "p" })];
  const input = [pool[1]];                 // parent filtered out of THIS section
  assert.deepEqual(shape(TaskModel.selectTree(input, { pool })), [],
    "the child renders under its parent wherever the parent renders, not here");
  // Same input, no pool named -> the OLD behaviour, which is the documented default so
  // untouched call sites keep working. If this ever flips, every caller changed at once.
  assert.deepEqual(shape(TaskModel.selectTree(input)), ["kid@0:subtask"]);
});

test("★ selectTree still PROMOTES a genuine orphan — standalone work never disappears", () => {
  const pool = [T("kid", { subtaskOf: "gone" })];
  assert.deepEqual(shape(TaskModel.selectTree(pool, { pool })), ["kid@0:subtask"],
    "parent absent from the POOL entirely -> visible at depth 0");
  // depth 0 is what _isSubRow (schedule-tab.js) reads to give it a rank number and its
  // own type tag instead of a "Subtask" label with nothing above it.
});

test("selectTree omits descendants of a collapsed node, and reports collapsed/hasKids", () => {
  const pool = [T("p"), T("kid", { subtaskOf: "p" }), T("gk", { subtaskOf: "kid" })];
  const open = TaskModel.selectTree(pool, { isCollapsed: () => false });
  assert.deepEqual(shape(open), ["p@0", "kid@1:subtask", "gk@2:subtask"]);
  assert.deepEqual(open.map((n) => n.hasKids), [true, true, false]);
  const shut = TaskModel.selectTree(pool, { isCollapsed: (id) => id === "p" });
  assert.deepEqual(shape(shut), ["p@0"]);
  assert.equal(shut[0].collapsed, true);
  // A childless node is never "collapsed" even if its id is in the collapsed set.
  const leaf = TaskModel.selectTree([T("solo")], { isCollapsed: () => true });
  assert.equal(leaf[0].collapsed, false);
});

test("selectTree reads the page's global isCollapsed when opts does not name one", () => {
  // No production call site passes opts.isCollapsed -- all four pass only {pool}. So the
  // browser only ever takes _collapsedFn's GLOBAL branch, and unlike the status resolvers
  // that one does NOT throw: it falls through to nothing-collapsed. If it ever stops
  // resolving, every collapsed tree silently renders fully expanded.
  const ctx = { console, isCollapsed: (id) => id === "p" };
  vm.createContext(ctx);
  const TM = installTaskModel(ctx);
  const pool = [T("p"), T("kid", { subtaskOf: "p" })];
  // A value crossing back out of a vm carries the VM REALM's prototypes, so a strict
  // structural assert fails on two identical-looking arrays. `[...]` re-homes it in this
  // realm. (unfinished-collect.test.js documents the same trap; deepStrictEqual reported
  // actual ['p'] !== expected ['p'] until this spread was added.)
  const nodes = [...TM.selectTree(pool)];
  assert.deepEqual(nodes.map((n) => n.ev.id), ["p"], "the collapsed parent hides its child");
  assert.equal(nodes[0].collapsed, true);
  // With no global at all, nothing-collapsed is the documented answer, not a throw.
  const bare = { console };
  vm.createContext(bare);
  assert.equal(installTaskModel(bare).selectTree(pool).length, 2, "no global -> nothing is collapsed");
});

test("selectTree survives a parent cycle and a runaway depth", () => {
  const cyc = [T("a", { subtaskOf: "b" }), T("b", { subtaskOf: "a" })];
  const out = TaskModel.selectTree(cyc, { pool: cyc });
  // Both parents are present in the pool, so neither is a root: a pure cycle renders nothing
  // rather than looping. Termination is proven by this test not hanging; assert the OUTCOME
  // too, because `Array.isArray(out)` is true for every possible implementation.
  assert.deepEqual(shape(out), [], "a pure cycle has no root, so it renders nothing");
  const chain = [];
  for (let i = 0; i < 40; i++) chain.push(T("n" + i, i ? { subtaskOf: "n" + (i - 1) } : {}));
  const deep = TaskModel.selectTree(chain, { pool: chain });
  assert.equal(Math.max(...deep.map((n) => n.depth)), 20, "depth is clamped at 20");
});

// ═══════════════════════════════════ selectDay ═════════════════════════════════════

const partition = (day) => {
  const seen = new Map();
  for (const key of ["timed", "unscheduled", "folded"]) {
    for (const ev of day[key]) {
      assert.equal(seen.has(ev.id), false, `${ev.id} is in both ${seen.get(ev.id)} and ${key} — sections must be disjoint`);
      seen.set(ev.id, key);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), day.visible.map((e) => e.id).sort(),
    "timed + unscheduled + folded must cover every visible row exactly once");
  const inner = new Set();
  for (const key of ["open", "done"]) {
    for (const ev of day[key]) {
      assert.equal(inner.has(ev.id), false, `${ev.id} is in both open and done`);
      inner.add(ev.id);
    }
  }
  assert.deepEqual([...inner].sort(), day.timed.map((e) => e.id).sort(), "open + done must cover timed exactly once");
};

test("★ selectDay's sections are disjoint AND exhaustive over the visible rows", () => {
  const pool = [
    T("timed"), T("timedDone"),
    untimed("u"), untimed("uKid", { subtaskOf: "u" }),
    T("parent"), T("doneStep", { subtaskOf: "parent" }), T("doneRider", { wrapId: "parent" }),
    T("del"), T("triv"),
    T("orphanDone", { subtaskOf: "vanished" }),
  ];
  const day = TaskModel.selectDay(pool, "2026-08-04",
    res(["timedDone", "doneStep", "doneRider", "orphanDone"], ["del"], ["triv"]));
  partition(day);
  assert.deepEqual(ids(day.visible).sort(),
    ["doneRider", "doneStep", "orphanDone", "parent", "timed", "timedDone", "u", "uKid"].sort(),
    "deleted and side-project rows are not visible at all");
});

test("★ a done RIDE-ALONG folds under its visible parent (the subtaskOf-only bug)", () => {
  const pool = [T("parent"), T("rider", { wrapId: "parent" })];
  const day = TaskModel.selectDay(pool, "2026-08-04", res(["rider"]));
  assert.deepEqual(ids(day.folded), ["rider"], "a done ride-along renders inside its parent, not as its own row");
  assert.deepEqual(ids(day.done), [], "and it must NOT also appear in the compact Done section");
  partition(day);
  // The subtask case, which already worked, must keep working.
  const day2 = TaskModel.selectDay([T("p2"), T("s2", { subtaskOf: "p2" })], "2026-08-04", res(["s2"]));
  assert.deepEqual(ids(day2.folded), ["s2"]);
});

test("★ a done nested row whose parent is GONE stays listed — it is not lost", () => {
  const day = TaskModel.selectDay([T("orphan", { subtaskOf: "deleted-parent" })], "2026-08-04", res(["orphan"]));
  assert.deepEqual(ids(day.folded), [], "nothing to fold into");
  assert.deepEqual(ids(day.done), ["orphan"], "it gets its own Done row so it is not lost");
});

test("★ a done row with an OPEN descendant does NOT fold — folding would hide live work", () => {
  // Fold means "no row of your own", and selectTree then hides your children too
  // (their parent is in the pool but not in the input). Fold a done step that still has
  // an unfinished step under it and that open work vanishes from every surface.
  const pool = [T("root"), T("doneStep", { subtaskOf: "root" }), T("openSubStep", { subtaskOf: "doneStep" })];
  const day = TaskModel.selectDay(pool, "2026-08-04", res(["doneStep"]));
  assert.deepEqual(ids(day.folded), [], "the done step keeps its row because its child is still open");
  assert.deepEqual(ids(day.done), ["doneStep"]);
  assert.deepEqual(ids(day.open).sort(), ["openSubStep", "root"]);
  partition(day);
  // And the open child really does reach the screen, nested under its greyed parent.
  assert.deepEqual(shape(TaskModel.selectTree(day.timed, { pool: day.visible })),
    ["root@0", "doneStep@1:subtask", "openSubStep@2:subtask"]);
  // Finish the child and the whole subtree folds away together.
  const day2 = TaskModel.selectDay(pool, "2026-08-04", res(["doneStep", "openSubStep"]));
  assert.deepEqual(ids(day2.folded).sort(), ["doneStep", "openSubStep"]);
  assert.deepEqual(ids(day2.done), []);
  partition(day2);
});

test("★ a finished step under an UNTIMED parent FOLDS — it does not join the Unscheduled subtree", () => {
  // Shipped as a real bug into review. The fold used to be computed AFTER the unscheduled
  // closure and skipped whatever the closure had claimed, so a done step under an untimed
  // parent could never fold: it joined the subtree and rendered as an unchecked row titled
  // "Mark done" whose checkbox UN-COMPLETED it. Folding first makes the rule uniform.
  const pool = [untimed("u"), untimed("step", { subtaskOf: "u" }), untimed("rider", { wrapId: "u" })];
  const day = TaskModel.selectDay(pool, "2026-08-04", res(["step", "rider"]));
  assert.deepEqual(ids(day.unscheduled), ["u"], "only the open root is in the section");
  assert.deepEqual(ids(day.folded).sort(), ["rider", "step"], "both finished children fold under it");
  assert.deepEqual(ids(day.timed), []);
  partition(day);
  // ...but a done step with an OPEN step under it still cannot fold, so it DOES join the
  // subtree -- which is exactly why the call site must pass the real done/open mode.
  const pool2 = [untimed("u2"), untimed("doneStep", { subtaskOf: "u2" }), untimed("openSub", { subtaskOf: "doneStep" })];
  const day2 = TaskModel.selectDay(pool2, "2026-08-04", res(["doneStep"]));
  assert.deepEqual(ids(day2.folded), []);
  assert.deepEqual(ids(day2.unscheduled).sort(), ["doneStep", "openSub", "u2"]);
  partition(day2);
});

test("★ a wrap/shell child does not leak into Unscheduled as a standalone row", () => {
  // The old predicate was `ev.untimed && !isDone(ev) && !isSubtask(ev)` — no
  // !isRideAlong — so an untimed ride-along became a top-level Unscheduled row.
  const pool = [T("shell"), untimed("rider", { wrapId: "shell" }), untimed("real")];
  const day = TaskModel.selectDay(pool, "2026-08-04", res([]));
  assert.deepEqual(ids(day.unscheduledRoots), ["real"], "only genuinely top-level untimed rows are roots");
  assert.equal(day.timed.some((e) => e.id === "rider"), true, "the rider stays with its parent's section");
  assert.deepEqual(shape(TaskModel.selectTree(day.timed, { pool: day.visible })),
    ["shell@0", "rider@1:ride-along"]);
  partition(day);
});

test("★ Unscheduled is a SUBTREE, so a step of an untimed parent cannot vanish", () => {
  // With roots-only, `uKid` would land in `timed` with its parent absent from that
  // section, and selectTree's pool check would hide it — losing the row. The closure is
  // what makes the orphan fix safe.
  const pool = [untimed("u"), untimed("uKid", { subtaskOf: "u" }), T("uGrand", { subtaskOf: "uKid" })];
  const day = TaskModel.selectDay(pool, "2026-08-04", res([]));
  assert.deepEqual(ids(day.unscheduledRoots), ["u"]);
  assert.deepEqual(ids(day.unscheduled).sort(), ["u", "uGrand", "uKid"], "the whole subtree comes along");
  assert.deepEqual(ids(day.timed), []);
  partition(day);
  assert.deepEqual(shape(TaskModel.selectTree(day.unscheduled, { pool: day.visible })),
    ["u@0", "uKid@1:subtask", "uGrand@2:subtask"]);
});

test("a fully-done subtree folds even when its parent edges form a CYCLE", () => {
  // `allDone` treats a revisited node as non-blocking, so a cycle can still be proven
  // finished; the enclosing done() test is what actually gates the fold. The opposite
  // choice (a cycle blocks) leaves a finished cyclic subtree rendering forever, and it
  // passed the suite until this test existed.
  // Every ev has exactly ONE parent pointer, so a cycle is necessarily a closed ring with
  // no root above it: a -> b -> c -> a. (The first cut of this test hung a "cycle" off a
  // root, which a single parent pointer cannot express — the fixture was wrong, not the
  // code, and it made the second assertion assert nothing about a cycle at all.)
  const ring = [T("a", { subtaskOf: "c" }), T("b", { subtaskOf: "a" }), T("c", { subtaskOf: "b" })];
  const day = TaskModel.selectDay(ring, "2026-08-04", res(["a", "b", "c"]));
  assert.deepEqual(ids(day.folded).sort(), ["a", "b", "c"], "a finished cyclic subtree still folds");
  assert.deepEqual(ids(day.timed), [], "and none of them also renders as its own row");
  partition(day);
  // One open member anywhere in the ring blocks the fold for every done member, because
  // the failing `done(child)` test propagates all the way round.
  const day2 = TaskModel.selectDay(ring, "2026-08-04", res(["a", "b"]));
  assert.deepEqual(ids(day2.folded), [], "an open member of the ring keeps every done row visible");
  assert.deepEqual(ids(day2.timed).sort(), ["a", "b", "c"]);
  partition(day2);
});

test("selectDay's unscheduled closure walks the whole subtree, and a detached ring is never reached", () => {
  // The first cut of this test claimed to wire a cycle and wired a CHAIN (u->a->b->c), so
  // the BFS visited-set guard it named was never taken and deleting that guard left it
  // green. And the guard is genuinely unreachable for well-formed input: every ev has one
  // parent pointer, so a cycle is a closed RING with no root above it, and a ring member is
  // `isNested`, therefore never an unscheduledRoots seed. Pin the reachability fact rather
  // than pretending to test a cycle.
  const pool = [
    untimed("u"), untimed("a", { subtaskOf: "u" }), untimed("b", { subtaskOf: "a" }), untimed("c", { subtaskOf: "b" }),
    untimed("r1", { subtaskOf: "r3" }), untimed("r2", { subtaskOf: "r1" }), untimed("r3", { subtaskOf: "r2" }),
  ];
  const day = TaskModel.selectDay(pool, "2026-08-04", res([]));
  assert.deepEqual(ids(day.unscheduled).sort(), ["a", "b", "c", "u"], "the whole 4-deep subtree comes along");
  assert.deepEqual(ids(day.unscheduledRoots), ["u"], "a ring member is isNested, so it is never a root");
  assert.deepEqual(ids(day.timed).sort(), ["r1", "r2", "r3"], "the ring still renders rather than vanishing");
  partition(day);
});

test("a DONE untimed row is not Unscheduled — closed work is not open work", () => {
  const day = TaskModel.selectDay([untimed("u"), untimed("uDone")], "2026-08-04", res(["uDone"]));
  assert.deepEqual(ids(day.unscheduledRoots), ["u"]);
  assert.deepEqual(ids(day.done), ["uDone"], "it falls through to the day's Done list");
  partition(day);
});

test("carryover folds in only on the actual today, and only its open rows", () => {
  const carryoverPool = [
    Object.assign(T("old1"), { __unf: { done: false, sourceDate: "2026-08-01" } }),
    Object.assign(T("old2"), { __unf: { done: true, sourceDate: "2026-08-01" } }),
  ];
  const o = Object.assign(res([]), { carryoverPool });
  const today = TaskModel.selectDay([], "2026-08-04", Object.assign({ today: "2026-08-04" }, o));
  assert.deepEqual(ids(today.carryover), ["old1"], "rows finished on their origin day ride along but do not render");
  const past = TaskModel.selectDay([], "2026-08-01", Object.assign({ today: "2026-08-04" }, o));
  assert.deepEqual(ids(past.carryover), [], "a past day does not collect yesterday's leftovers");
  const future = TaskModel.selectDay([], "2026-08-09", Object.assign({ today: "2026-08-04" }, o));
  assert.deepEqual(ids(future.carryover), []);
});

test("selectCarryover is the carryover done predicate, and DCC.Carryover.openRows is it", () => {
  const pool = [
    Object.assign(T("a"), { __unf: { done: false } }),
    Object.assign(T("b"), { __unf: { done: true } }),
    T("c"),                                            // no stamp at all -> open
  ];
  assert.deepEqual(ids(TaskModel.selectCarryover(pool)), ["a", "c"]);
  // isDone() reads TODAY's registry and knows nothing about an origin-day overlay, so
  // the two must stay distinct predicates.
  assert.deepEqual(ids(TaskModel.selectCarryover([Object.assign(T("x"), { __unf: { done: true } })])), []);
  const fs = require("node:fs");
  const unfSrc = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
  assert.match(unfSrc, /function openRows\(pool\) \{ return DCC\.TaskModel\.selectCarryover\(pool\); \}/,
    "DCC.Carryover.openRows must delegate, not carry a second copy of the predicate");
});

test("selectDay tolerates a null pool and null members without throwing", () => {
  const day = TaskModel.selectDay(null, "2026-08-04", res([]));
  assert.deepEqual(day.visible, []);
  partition(day);
  const day2 = TaskModel.selectDay([null, T("a"), undefined], "2026-08-04", res([]));
  assert.deepEqual(ids(day2.visible), ["a"]);
});
