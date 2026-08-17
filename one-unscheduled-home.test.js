// Contract tests for C4, "one home for unscheduled work": `date IS NULL` is the
// definition of unscheduled, the Backlog is a PROJECTION over those rows rather than a
// parallel store, and moving a task between the two is an in-place `date` UPDATE.
//
// The bug this phase closes, measured on the prod restore before any code changed:
// viewing today, `backlog[]` held 12 items while the itinerary fold admitted 11 rows,
// and 5 were the SAME rows in both — one piece of work rendering in two places behind
// two badges that could not agree. On 2026-07-27 it was 11 of 17.
//
// The bug it prevents recurring is the identity loss. addToSchedule used to
// deleteBacklogBlock() then persistAddedTask(), i.e. tombstone the row and create a new
// one under a fresh block id, so a backlog → today → backlog round trip returned a
// different row each time and orphaned everything keyed to the old id: `parent_id` child
// edges, `subtaskOf` links written as a row id (C3 measured 7 live rows in that form),
// and the ledger's `<date>:<row id>` server-side credit key. 11 tombstoned backlog rows
// on the restore, two of which Drake had re-added by hand under fresh `bl-<timestamp>`
// ids — the churn, seen from outside.
//
// Harness pattern: raw source sliced into a node:vm context (recalc-times.test.js,
// itinerary-fold.test.js). Slices are asserted AND span-checked, because C3 hit a regex
// that ran past its function into the next one and still "matched".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskModel = require("./public/js/task-model.js");

const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const tabSource = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — C4 code moved or was renamed");
  assert.equal((m[0].match(/^(async )?function /gm) || []).length, 1,
    what + " slice spans more than one function — the regex ran past its closing brace");
  return m[0];
}
// For a span that is not a whole function declaration (an event-handler block). Same
// must-match discipline, without the one-function span check.
function mustSliceLoose(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — C4 code moved or was renamed");
  return m[0];
}

const SRC = {
  addToSchedule: mustSlice(scheduleSource, /^function addToSchedule\(blId,opts\)\{[\s\S]*?\n\}/m, "addToSchedule"),
  hydrateBacklog: mustSlice(scheduleSource, /^function hydrateBacklogFromBlocks\(\)\{[\s\S]*?\n\}/m, "hydrateBacklogFromBlocks"),
  scheduleRowOnDay: mustSlice(stateSource, /^async function scheduleRowOnDay\(blockId,dateStr,opts\)\{[\s\S]*?\n\}/m, "scheduleRowOnDay"),
  unscheduleRow: mustSlice(stateSource, /^async function unscheduleRow\(blockId,opts\)\{[\s\S]*?\n\}/m, "unscheduleRow"),
  writeRowDate: mustSlice(stateSource, /^async function _writeRowDate\(blockId,block,props,dateStr\)\{[\s\S]*?\n\}/m, "_writeRowDate"),
  rowForDateWrite: mustSlice(stateSource, /^async function _rowForDateWrite\(blockId\)\{[\s\S]*?\n\}/m, "_rowForDateWrite"),
  syncBacklog: mustSlice(stateSource, /^function _syncBacklogProjection\(evId,dateStr\)\{[\s\S]*?\n\}/m, "_syncBacklogProjection"),
  positiveDuration: mustSlice(stateSource, /^function _positiveDuration\(candidate,fallback\)\{[\s\S]*?\n\}/m, "_positiveDuration"),
  // C5b widened the signature to `(blockId,merge,extra)` — `extra` is the top-level COLUMN
  // write (today just `{date}`), which is how a completion promotes a dateless Unscheduled row
  // onto the day it was finished on. Matching the parameter list loosely so the next argument
  // does not break the slice; the `mustSlice` guard still fails loudly if the function moves.
  enqueueRowProps: mustSlice(stateSource, /^function enqueueRowPropsWrite\([^)]*\)\{[\s\S]*?\n\}/m, "enqueueRowPropsWrite"),
  taskAnchorById: mustSlice(tabSource, /^function taskAnchorById\(id\)\{[\s\S]*?\n\}/m, "taskAnchorById"),
  unfRecById: mustSlice(tabSource, /^function _unfRecById\(id\)\{[\s\S]*?\n\}/m, "_unfRecById"),
  unfDropRows: mustSlice(tabSource, /^function _unfDropRows\(ids\)\{[\s\S]*?\n\}/m, "_unfDropRows"),
  unfHandleSettlement: mustSlice(tabSource, /^function _unfHandleSettlement\(event\)\{[\s\S]*?\n\}/m, "_unfHandleSettlement"),
};

// The full set of state.js pieces the date primitives depend on. Bundled so a new shared
// helper lands in EVERY context at once — the round-3 fixes added two, and hand-listing
// them per test is how a context ends up missing one and failing for the wrong reason.
const PRIMITIVES = [
  "let _rowPropsChain = Promise.resolve();",
  SRC.scheduleRowOnDay, SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite,
  SRC.syncBacklog, SRC.positiveDuration, SRC.enqueueRowProps, SRC.hydrateBacklog,
];

const row = (id, date, props) => ({
  id, type: "block", date, created_at: "2026-07-01T09:00:00.000Z", sort_order: 1,
  properties: Object.assign({ title: id }, props || {}),
});

// A store that records every write and distinguishes the three kinds, because the whole
// point of C4 is that a promotion is an UPDATE and never a delete+create pair.
function makeStore(rows, opts = {}) {
  const calls = { update: [], create: [], del: [] };
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    calls,
    store: {
      getCurrentDate: () => opts.currentDate || "2026-08-03",
      getByType: (t) => (t === "block" ? rows.filter((r) => !r.deleted_at) : []),
      // Mirrors production: reads _dayCache/_globalCache only. `cached` false models a
      // row those caches do not hold (a past-day carryover), which is the case that used
      // to make a write silently do nothing.
      get: (id) => (opts.cached === false ? null : byId.get(id) || null),
      async updateBlock(id, props, extra) {
        calls.update.push({ id, props, extra });
        // Production returns the server row on success and `optimistic || existing` on a
        // buffered failure — which is NULL for an uncached row. opts.updateReturns
        // reproduces that exactly; a stub that always returned a block would be gentler
        // than reality and would hide the bug this models.
        if ("updateReturns" in opts) return opts.updateReturns;
        return Object.assign({}, byId.get(id) || { id }, { date: extra && extra.date, properties: props });
      },
      async createBlock(type, props, extra) { calls.create.push({ type, props, extra }); return { id: "new-row", properties: props }; },
      async deleteBlock(id) { calls.del.push(id); },
      invalidateRangeCache() {},
    },
  };
}

function ctxWith(sources, extra) {
  const ctx = Object.assign({
    console, JSON, Date, Number, Set, Map, Object, Array, Promise,
    pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    ms: (m) => (m >= 60 ? Math.floor(m / 60) + "h" : m + "m"),
    log: () => {}, render: () => {}, recalcTimes: () => {},
    showToast: () => {}, saveDeletedState: () => {},
    scheduled: [], backlog: [], consider: [], deletedSet: new Set(),
  }, extra || {});
  ctx.window = ctx.window || {};
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(sources.join("\n"), ctx);
  return ctx;
}

// ───────────────────── the predicate: twin of dcc_is_task_row ─────────────────────

test("isTaskRow's exclusion list is READ from the SQL definition, not restated here", () => {
  // The claim in task-model.js is that this is the client twin of dcc_is_task_row. A test
  // that hardcoded the same four kinds would pass forever while the two drifted, so this
  // parses the SQL's own definition and holds the client to it. If someone widens
  // dcc_is_task_row, this fails until the client follows.
  //
  // pg-schema.js, NOT migrations/001: the function is declared in POST_SCHEMA_STATEMENTS,
  // whose own comment says it lives there so the migration, the audit endpoint and later
  // phases cannot each carry a copy. 001 only CALLS it. (Worth recording — the phase plan
  // and my first cut of this test both assumed the migration was the source of truth.)
  const schema = fs.readFileSync(require.resolve("./pg-schema.js"), "utf8");
  const fn = schema.match(/CREATE OR REPLACE FUNCTION dcc_is_task_row[\s\S]*?\$fn\$;/);
  assert.ok(fn, "dcc_is_task_row definition not found in pg-schema.js");
  const body = fn[0];
  // Parse the list GENERICALLY. The first version matched
  // /'(delegated_item|task_group|reschedule_tombstone)'/g — it restated the very list it
  // claimed to read, so adding a fourth kind to the SQL changed nothing and the twin could
  // silently fall behind. Widening is the direction that matters: a kind excluded
  // server-side but admitted here folds a non-task row into the itinerary.
  // `[\s\S]*?` and not `[^)]*`: the predicate reads
  // `COALESCE(p_props->>'kind', '') NOT IN (...)`, so there is a `)` between 'kind' and
  // NOT IN that a negated-paren class cannot cross.
  const notIn = body.match(/'kind'[\s\S]*?NOT IN\s*\(([^)]*)\)/i);
  assert.ok(notIn, "dcc_is_task_row's kind NOT IN list not found — the SQL shape changed");
  const kinds = (notIn[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, ""));
  assert.ok(kinds.length >= 3, "parsed a real list, not an empty match: " + JSON.stringify(kinds));
  for (const kind of kinds) {
    assert.equal(TaskModel.isTaskRow(row("x", null, { kind, local_id: "l" })), false,
      kind + " is excluded by dcc_is_task_row, so TaskModel.isTaskRow must exclude it too");
  }
  assert.ok(/responsibility%/.test(body), "the SQL must still identify responsibility scaffolding by prefix");
  assert.ok(/responsibility_task/.test(body), "the SQL must exempt dated responsibility task instances");
  assert.equal(TaskModel.isTaskRow(row("x", null, { kind: "responsibility_item", local_id: "l" })), false);
  assert.equal(TaskModel.isTaskRow(row("x", "2026-08-03", { kind: "responsibility_task", local_id: "l" })), true);
  for (const kind of ["meeting_prep", "meeting_transcript", "meeting_summary", "proposed_action_item"]) {
    assert.equal(TaskModel.isTaskRow(row("x", "2026-08-03", { kind, local_id: "l", start: 1465 })), false,
      kind + " must never become a task because it carries transcript evidence");
  }
  // types, not kinds
  assert.equal(TaskModel.isTaskRow({ type: "day_root", properties: {} }), false);
  assert.equal(TaskModel.isTaskRow({ type: "time_entry", properties: {} }), false);
  // and a plain task row passes
  assert.equal(TaskModel.isTaskRow(row("x", null, { local_id: "l" })), true);
});

test("foldsIntoItinerary admits SHELLS — the branch syncAddedTaskTimes was missing", () => {
  const shellByKind = row("s1", "2026-08-03", { kind: "shell" });
  const shellByType = row("s2", "2026-08-03", { type: "shell" });
  assert.equal(TaskModel.foldsIntoItinerary(shellByKind), true, "kind:shell must fold");
  assert.equal(TaskModel.foldsIntoItinerary(shellByType), true, "type:shell must fold");
});

test("a responsibility task root stays visible so its default subtasks remain nested", () => {
  const blocks = [
    row("root-row", "2026-08-03", {
      kind: "responsibility_task", local_id: "do-laundry", title: "Do Laundry",
      start: "09:00", end: "09:30", duration: 30,
    }),
    row("dryer-row", "2026-08-03", {
      local_id: "dryer", title: "Transfer it to Dryer", subtaskOf: "do-laundry",
      start: "09:00", end: "09:00", duration: 0,
    }),
    row("fold-row", "2026-08-03", {
      local_id: "fold", title: "Fold", subtaskOf: "do-laundry",
      start: "09:00", end: "09:00", duration: 0,
    }),
  ];
  const folded = blocks.filter(TaskModel.foldsIntoItinerary).map((block) => TaskModel.fromBlock(block));
  const shape = TaskModel.selectTree(folded, { pool: folded })
    .map((node) => `${node.ev.title}@${node.depth}`);
  assert.deepEqual(shape, ["Do Laundry@0", "Transfer it to Dryer@1", "Fold@1"],
    "dropping the responsibility_task root recreates the production bug: every child is promoted to depth 0");
});

test("syncAddedTaskTimes persists a SHELL's times, and still skips a non-task row", () => {
  // The drift this phase found by factoring: the fold admitted shells, the time-sync did
  // not, so a shell block rendered in the itinerary and then never persisted its
  // start/end — its times reset on every reload.
  //
  // This CALLS the function. An earlier version of this test asserted on the source text
  // instead ("does schedule.js mention TM.foldsIntoItinerary") and the mutation check
  // proved it vacuous: deleting the guard left the name behind in a comment, so the test
  // stayed green with the predicate gone. C1 wrote the rule this breaks —
  // a source-regex test cannot guard a swallowed write.
  const src = mustSlice(scheduleSource, /^function syncAddedTaskTimes\(\)\{[\s\S]*?\n\}/m, "syncAddedTaskTimes");
  const rows = [
    row("shell-1", "2026-08-03", { kind: "shell", title: "Morning block", start: "08:00", end: "08:30" }),
    row("side-1", "2026-08-03", { kind: "side_project", title: "Not a task", start: "08:00", end: "08:30" }),
  ];
  const { store, calls } = makeStore(rows);
  const ctx = ctxWith([src], {
    window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: store, DCC: { TaskModel } },
    // The evs the shell and the side-project row would produce. Both differ from the
    // stored times, so a row that reaches the write WILL be written — which is what makes
    // the skip observable rather than a coincidence.
    scheduled: [
      { id: "shell-1", start: "09:00", end: "09:30", untimed: false },
      { id: "side-1", start: "09:00", end: "09:30", untimed: false },
    ],
  });
  ctx.syncAddedTaskTimes();
  const written = calls.update.map((w) => w.id);
  assert.deepEqual(written, ["shell-1"],
    "the shell's times persist (the drift) and the side_project row is still skipped");
  assert.equal(calls.update[0].props.start, "09:00");
});

test("foldsIntoItinerary rejects what isTaskRow alone lets through", () => {
  // isTaskRow is a KIND test only, so it is far too wide on its own: these rows pass it.
  // Both shapes are real on the prod restore (2 side_project, 4 kindless, all dateless).
  const sideProject = row("sp", null, { kind: "side_project" });
  const kindless = { id: "k", type: "block", properties: {} };
  assert.equal(TaskModel.isTaskRow(sideProject), true, "isTaskRow is a kind test and admits this");
  assert.equal(TaskModel.foldsIntoItinerary(sideProject), false, "but it is not addressable as a task");
  assert.equal(TaskModel.foldsIntoItinerary(kindless), false);
  // API-inserted shapes with no local_id ARE addressable, by row id
  assert.equal(TaskModel.foldsIntoItinerary(row("api", null, { kind: "task" })), true);
  assert.equal(TaskModel.foldsIntoItinerary(row("m", "2026-08-03", { kind: "meeting" })), true);
  assert.equal(TaskModel.foldsIntoItinerary(row("o", "2026-08-03", { type: "oneone" })), true);
});

// ───────────────────── the projection: one list ─────────────────────

test("selectUnscheduled is date IS NULL, and closed/titleless rows are not unscheduled work", () => {
  const rows = [
    row("a", null, { local_id: "a", title: "open dateless" }),
    row("b", "2026-08-03", { local_id: "b", title: "scheduled today" }),
    row("c", null, { local_id: "c", title: "done", status: "done" }),
    row("d", null, { local_id: "d", title: "flag-done", done: true }),
    row("e", null, { local_id: "e", title: "archived", status: "archived" }),
    row("f", null, { local_id: "f", title: null }),
    row("g", null, { local_id: "g", title: "delegated", kind: "delegated_item" }),
    row("blocked", null, { local_id: "blocked", title: "parked in Waiting", dependencyWaitingItemId: "dependency-1" }),
    Object.assign(row("h", null, { local_id: "h", title: "tombstoned" }), { deleted_at: "2026-08-01" }),
  ];
  const got = TaskModel.selectUnscheduled(rows).map((r) => r.id);
  assert.deepEqual(got, ["a"], "only the open, titled, dateless task row is unscheduled");
});

test("a backlog row with no local_id is still projected (the old 'blk-<rowid>' shape)", () => {
  // hydrateBacklogFromBlocks keyed such a row by row id. foldsIntoItinerary does not
  // admit it — and must not, since that predicate is shared with the fold, which has
  // never rendered it — so selectUnscheduled carries the branch itself. 0 rows are in
  // this shape on the prod restore; the point is not to lose a path the old code handled.
  const rows = [row("r-nolid", null, { title: "Legacy backlog row", kind: "backlog" })];
  assert.equal(TaskModel.foldsIntoItinerary(rows[0]), false, "the shared predicate rightly excludes it");
  assert.deepEqual(TaskModel.selectUnscheduled(rows).map((r) => r.id), ["r-nolid"],
    "but the backlog projection keeps it");
  const { store } = makeStore(rows);
  const ctx = ctxWith([SRC.hydrateBacklog], { window: { blockStore: store, DCC: { TaskModel } } });
  ctx.hydrateBacklogFromBlocks();
  assert.deepEqual(ctx.backlog.map((b) => b.id), ["blk-r-nolid"], "under its row-id key, as before");
});

test("the legacy dated-backlog inclusion is OPT-IN, and it is the only way a dated row gets in", () => {
  // 8 live rows on the prod restore carry kind:"backlog" AND a date, because the
  // dcc-task-ops API stamps the request date. The drawer is the only place they have ever
  // rendered, so dropping them would hide 8 genuinely open tasks — and C2's carryover
  // lane cannot pick them up either (getCarryoverPool requires a `start` or a parent
  // edge, and an API-minted backlog row has neither).
  const rows = [
    row("dateless", null, { local_id: "d1", title: "real backlog", kind: "backlog" }),
    row("dated-bl", "2026-07-27", { local_id: "d2", title: "API backlog", kind: "backlog" }),
    row("dated-task", "2026-07-27", { local_id: "d3", title: "ordinary scheduled task" }),
  ];
  assert.deepEqual(TaskModel.selectUnscheduled(rows).map((r) => r.id), ["dateless"],
    "by default the definition is strictly date IS NULL");
  assert.deepEqual(
    TaskModel.selectUnscheduled(rows, { includeLegacyDatedBacklog: true }).map((r) => r.id),
    ["dateless", "dated-bl"],
    "with the flag, a DATED backlog row rides along — but an ordinary dated task never does");
});

test("hydrateBacklogFromBlocks projects the selector and dedupes the live twin", () => {
  // `carry-200` really does have two live rows sharing one local_id on the prod restore.
  // The drawer shows one, matching the fold (which keys on local_id||row id) — kept
  // deliberately rather than rendering a twin nobody asked for.
  const rows = [
    row("r1", null, { local_id: "carry-200", title: "Audit Angel QA", kind: "backlog", start: "17:30" }),
    row("r2", null, { local_id: "carry-200", title: "Audit Angel QA", kind: "backlog" }),
    row("r3", null, { local_id: "bl-1", title: "Real item", kind: "backlog" }),
    // The legacy shape: kind:"backlog" WITH a date, as the dcc-task-ops API writes it.
    // The drawer is the only surface these have ever rendered on, so the projection has
    // to pass includeLegacyDatedBacklog or 8 live rows go quiet. Asserted here at the
    // CALL SITE, because the flag's own unit test passes whether or not hydrate uses it —
    // the mutation check caught exactly that gap.
    row("r4", "2026-07-27", { local_id: "dcc-legacy", title: "API backlog item", kind: "backlog" }),
    // ...while an ordinary DATED task must never leak into the drawer.
    row("r5", "2026-07-27", { local_id: "sched-1", title: "Ordinary scheduled task" }),
  ];
  const { store } = makeStore(rows);
  const ctx = ctxWith([SRC.hydrateBacklog], { window: { blockStore: store, DCC: { TaskModel } } });
  const added = ctx.hydrateBacklogFromBlocks();
  assert.equal(added, 3, "two distinct dateless local_ids plus the legacy dated backlog row");
  assert.deepEqual(ctx.backlog.map((b) => b.id), ["carry-200", "bl-1", "dcc-legacy"]);
  assert.equal(ctx.backlog[0]._blockId, "r1", "the projection carries the ROW id so writes can target it");
});

test("hydrateBacklogFromBlocks fails LOUDLY instead of handing back an empty backlog", () => {
  // Same rule as the fold: a stale cached index.html without the <script> tag would
  // otherwise produce a silently empty drawer with nothing in the console.
  const { store } = makeStore([row("r1", null, { local_id: "b", title: "t", kind: "backlog" })]);
  const errs = [];
  const ctx = ctxWith([SRC.hydrateBacklog], {
    console: Object.assign({}, console, { error: (m) => errs.push(m) }),
    window: { blockStore: store, DCC: {} },
  });
  assert.equal(ctx.hydrateBacklogFromBlocks(), 0);
  assert.equal(ctx.backlog.length, 0);
  assert.equal(errs.length, 1, "it must say so");
  assert.match(String(errs[0]), /task-model\.js missing or stale/);
});

// ───────────────────── the primitives: a date UPDATE, never delete+create ─────────────

test("scheduleRowOnDay is ONE update with the date, and strips the backlog marker", () => {
  const r = row("r1", null, { local_id: "bl-1", title: "Provision AWS", kind: "backlog", durMin: 45, notes: "keep me" });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, { window: { blockStore: store } });
  return ctx.scheduleRowOnDay("r1", "2026-08-03", { start: "09:00", end: "09:45" }).then((res) => {
    assert.ok(res, "must resolve to the row it wrote");
    assert.equal(calls.update.length, 1, "exactly one write");
    assert.equal(calls.del.length, 0, "NOTHING is deleted — this is the delete-and-recreate that C4 removed");
    assert.equal(calls.create.length, 0, "and nothing is created, so the row keeps its id");
    const w = calls.update[0];
    assert.equal(w.id, "r1", "the SAME row id");
    assert.equal(w.extra.date, "2026-08-03");
    assert.equal(w.props.start, "09:00");
    assert.equal(w.props.end, "09:45");
    assert.equal("kind" in w.props, false, "kind:backlog is stripped — otherwise it renders in the drawer AND on its day");
    assert.equal(w.props.local_id, "bl-1", "identity survives");
    assert.equal(w.props.notes, "keep me", "and so does everything else on the row");
  });
});

test("unscheduleRow clears the date and the stale slot, and sets the stage", () => {
  const r = row("r1", "2026-08-03", { local_id: "t-1", title: "Do laundry", duration: 45, start: "09:00", end: "09:45", _pinnedStart: "09:00", subtaskOf: "p" });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, { window: { blockStore: store } });
  return ctx.unscheduleRow("r1", { stage: "Priority" }).then((res) => {
    assert.ok(res);
    assert.equal(calls.update.length, 1);
    assert.equal(calls.del.length, 0, "no tombstone");
    assert.equal(calls.create.length, 0, "no new bl- row — the OLD path minted one every time");
    const w = calls.update[0];
    assert.equal(w.extra.date, null, "date IS NULL is what unscheduled means");
    assert.equal(w.props.kind, "backlog");
    assert.equal(w.props.stage, "Priority");
    assert.equal(w.props.durMin, 45, "durMin, because hydrateBacklogFromBlocks reads durMin and not duration");
    assert.equal("start" in w.props, false, "a stale start on a dateless row would pin it on the way back out");
    assert.equal("end" in w.props, false);
    assert.equal("_pinnedStart" in w.props, false);
    assert.equal(w.props.subtaskOf, "p", "the parent edge survives");
    assert.equal(w.props.local_id, "t-1");
  });
});

test("a midnight-wrapped duration is REJECTED, not persisted to both spellings", () => {
  // dur(ev) is pt(end) - pt(start), and it goes NEGATIVE when an ev's end wrapped past
  // midnight: recalcTimes writes ev.end with no day clamp, so 23:00 + 90m is "24:30" and
  // pt() wraps the hour, giving -1350. The row's stored duration used to floor this;
  // writing an unvalidated value into durMin AND duration removes the floor, and every
  // reader filters falsy rather than negative. That is the negative-duration -> findSlot ->
  // 400 chain task-model.js records as a real incident that stuck rows on every surface.
  const r = row("row-9", "2026-08-03", { local_id: "t-1", title: "Late task", duration: 45 });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store, DCC: { TaskModel } },
  });
  return ctx.unscheduleRow("row-9", { block: r, durMin: -1350 }).then(() => {
    assert.equal(calls.update[0].props.durMin, 45, "it falls back to the row's own duration");
    assert.equal(calls.update[0].props.duration, 45);
    assert.ok(calls.update[0].props.durMin > 0, "and never persists a non-positive duration");
    // 0 and NaN are the same class of junk and must be refused the same way.
    const { store: s2, calls: c2 } = makeStore([r]);
    const ctx2 = ctxWith(PRIMITIVES, {
      window: { blockStore: s2, DCC: { TaskModel } },
    });
    return ctx2.unscheduleRow("row-9", { block: r, durMin: 0 }).then(() => {
      assert.equal(c2.update[0].props.durMin, 45, "0 is not a duration either");
    });
  });
});

test("a carryover ride-along's end is CLAMPED to the end of the day", () => {
  // The onViewedDay gate correctly skips recalcTimes for a carryover — which also removes
  // the only thing that used to repair an overflowing end. A 23:45 parent + 30m gives
  // "24:15"; pt() wraps the hour, so that origin-day row's dur(ev) is negative FOREVER,
  // because nothing ever recalcs a past day. task-model.js clamps for exactly this reason.
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addStackedTask\(taskId, text, durMinArg, opts\)\{[\s\S]*?\n\}/m, "addStackedTask");
  const { store, calls } = makeStore([]);
  const lateParent = { id: "c-1", title: "Late shell", start: "23:45", end: "23:59" };
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {}, TaskTypes: { rule: () => null, isRollup: () => false }, PointPlan: { ensure: () => {} } },
    scheduled: [], viewDate: "2026-08-03",
    taskAnchorById: () => ({ ev: lateParent, date: "2026-07-28", blockId: "row-77", carryover: true }),
    _recollectCarryover: () => {},
  });
  ctx.addStackedTask("c-1", "Ride along", 30);
  const p = calls.create[0].props;
  assert.equal(p.start, "23:45");
  assert.equal(p.end, "23:59", "clamped to the last minute of the day, never '24:15'");
  assert.ok(ctx.pt(p.end) - ctx.pt(p.start) > 0,
    "so the row's duration stays positive — an unclamped end wraps and goes permanently negative");
});

test("both primitives REFUSE before writing when the row cannot be resolved", () => {
  // updateBlock REPLACES properties wholesale (db.js: newProps = parsed), so writing
  // without the row destroys title/local_id/subtaskOf/notes behind a success toast.
  // That was a live data-loss bug in C1's toBacklog; the guard is now in one place.
  const { store, calls } = makeStore([], { cached: false });
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store },
    fetch: async () => ({ ok: false }),
  });
  return Promise.all([ctx.scheduleRowOnDay("gone", "2026-08-03"), ctx.unscheduleRow("gone")]).then((res) => {
    assert.deepEqual(res, [null, null], "both refuse");
    assert.equal(calls.update.length, 0, "and neither writes anything");
  });
});

test("a falsy updateBlock return is NOT a failure — the WAL will land it", () => {
  // updateBlock answers `optimistic || existing` on a buffered failure, and `existing` is
  // cacheGet(id) — NULL for a row outside _dayCache/_globalCache. A past-day carryover is
  // exactly that, so the caller most likely to hit a hiccup is the one whose "failure"
  // value is null. The mutation is in the WAL regardless, so reporting failure here would
  // toast "Could not move…" over a move that then quietly happened.
  const r = row("r1", "2026-08-03", { local_id: "t-1", title: "Do laundry" });
  const { store, calls } = makeStore([r], { updateReturns: null });
  const ctx = ctxWith(PRIMITIVES, { window: { blockStore: store } });
  return ctx.unscheduleRow("r1", { block: r }).then((res) => {
    assert.ok(res, "a null return from updateBlock must still count as written");
    assert.equal(res.date, null, "and it resolves to the row we know we wrote");
    assert.equal(res.properties.kind, "backlog");
    assert.equal(calls.update.length, 1);
  });
});

test("backlog[] tracks the write immediately — one badge, between the write and the reload", () => {
  // Found in live QA, not by a test: after Move-to-backlog the row appeared in the
  // Unscheduled section while the Backlog badge still read the old count, because the
  // projection only re-runs inside reloadPersistedEdits. Same disagreement this phase
  // removes, moved from "two predicates" to "two moments".
  const r = row("row-9", "2026-08-03", { local_id: "t-1", title: "Do laundry", duration: 30 });
  const { store } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store, DCC: { TaskModel } },
    backlog: [],
  });
  // The store's updateBlock mutates nothing, so mirror production's optimistic cache
  // write: the row is dateless in cache by the time the projection runs.
  const origUpdate = store.updateBlock.bind(store);
  store.updateBlock = async (id, props, extra) => { r.date = extra.date; r.properties = props; return origUpdate(id, props, extra); };
  return ctx.unscheduleRow("row-9", { block: r }).then(() => {
    assert.deepEqual(ctx.backlog.map((b) => b.id), ["t-1"], "unscheduling ADDS it to the backlog at once");
    // ...and the other direction removes it.
    const ctx2 = ctxWith([SRC.syncBacklog, SRC.hydrateBacklog], {
      window: { blockStore: store, DCC: { TaskModel } },
      backlog: [{ id: "t-1", title: "Do laundry" }],
    });
    ctx2._syncBacklogProjection("t-1", "2026-08-04");
    assert.deepEqual(ctx2.backlog, [], "giving a row a date REMOVES it from the backlog at once");
  });
});

test("scheduling a row with NO local_id removes the right backlog entry (the blk- key)", () => {
  // The one case where the two spellings differ. `_writeRowDate` must look the entry up
  // under TaskModel.backlogKey — the SAME key hydrateBacklogFromBlocks stored it under —
  // and not under `local_id || blockId`, which for a row without a local_id misses by the
  // "blk-" prefix. Missing it leaves the task scheduled on its day AND still in the drawer
  // with a stale badge, which is the two-homes disagreement this phase closes.
  // The previous badge test used a row WITH a local_id, so both spellings agreed and the
  // wrong one passed; the mutation harness flagged it.
  const r = row("row-nolid", null, { title: "Legacy backlog row", kind: "backlog" });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store, DCC: { TaskModel } },
    backlog: [{ id: "blk-row-nolid", title: "Legacy backlog row", _blockId: "row-nolid" }],
  });
  return ctx.scheduleRowOnDay("row-nolid", "2026-08-03", { start: "09:00", end: "09:30" }).then(() => {
    assert.equal(calls.update.length, 1);
    assert.deepEqual(ctx.backlog, [],
      "the blk--keyed entry must be removed; looking it up as the bare row id silently no-ops");
  });
});

test("setTaskCommuteTimes writes the ROW when handed its id", () => {
  // The details modal is open on carryover rows now, and _commuteBlockForTask searches
  // _dayCache/_globalCache, which never hold one — so commute minutes landed only in the
  // day-scoped map, recorded against the wrong day. Flagged as untested by the harness.
  const src = mustSlice(stateSource, /^function setTaskCommuteTimes\(taskId,value,opts\)\{[\s\S]*?\n\}/m, "setTaskCommuteTimes");
  const propsSrc = mustSlice(stateSource, /^function _commuteProps\(properties,pair\)\{[\s\S]*?\n\}/m, "_commuteProps");
  const r = row("row-77", "2026-07-28", { local_id: "c-1", title: "Do laundry", notes: "keep me" });
  // cached:false — the store models a row NO cache holds, which is what a past-day
  // carryover is. My first cut used a cached store, so it proved the ordinary-row path and
  // said nothing about the case the opts.blockId argument exists for; `blockStore.get()`
  // reads exactly the caches that miss, so the fix appeared to work and did not.
  const { store, calls } = makeStore([r], { cached: false });
  // NOTE: SRC.rowForDateWrite is deliberately NOT sliced in here. A function DECLARATION
  // inside the vm shadows a same-named context property, so including it would silently
  // replace the `_rowForDateWrite` stub below with the real resolver — which, with no
  // `fetch` in this context, resolves to null and writes nothing. That is the same
  // shadowing trap that made an earlier spy in this file never run.
  // A CARRYOVER ev: deliberately NOT in scheduled[], reachable only through the anchor.
  const carryEv = { id: "c-1", title: "Do laundry" };
  const ctx = ctxWith([src, propsSrc, "let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps], {
    window: { blockStore: store },
    commuteTimes: {},
    scheduled: [],
    normalizeCommutePair: (v) => ({ to: Number(v.to) || 0, back: Number(v.back) || 0, total: (Number(v.to) || 0) + (Number(v.back) || 0) }),
    // NOT a no-op. Stubbing this benign is what hid the ev half of the bug: reaching the row
    // but not the ev meant a reopen read a stale ev, rendered the commute inputs EMPTY, and
    // the next close persisted {to:0,back:0} back over the row.
    _applyCommutePairToEvent: (e, pair) => { if (e) { e.commuteToMinutes = pair.to; e.commuteBackMinutes = pair.back; } },
    saveCommuteTimes: () => {},
    _rowForDateWrite: async () => r,
    _commuteBlockForTask: () => null,
    // A CARRYOVER ev: not in scheduled[], reachable only through the anchor.
    taskAnchorById: (id) => (id === "c-1" ? { ev: carryEv, date: "2026-07-28", blockId: "row-77", carryover: true } : null),
  });
  ctx.setTaskCommuteTimes("c-1", { to: 20, back: 15 }, { blockId: "row-77" });
  assert.equal(carryEv.commuteToMinutes, 20,
    "the carryover EV must be updated too, or the modal reopens empty and the next close deletes what was saved");
  assert.equal(carryEv.commuteBackMinutes, 15);
  return new Promise((d) => setTimeout(d, 0)).then(() => {
    assert.equal(calls.update.length, 1, "it writes the row even when no cache holds it");
    assert.equal(calls.update[0].id, "row-77");
    assert.equal(calls.update[0].props.commuteToMinutes, 20);
    assert.equal(calls.update[0].props.commuteBackMinutes, 15);
    assert.equal(calls.update[0].props.notes, "keep me", "updateBlock replaces, so the rest must be carried");
  });
});

test("opts.block skips resolution, so a caller with the right cache does not pay an HTTP GET", () => {
  // A backlog row is in _globalCache, today's rows in _dayCache, a past-day carryover
  // ONLY in _rangeCache — and blockStore.get() reads neither of the last. toBacklog
  // resolves through _originBlock (the _rangeCache path, plus C1's one-day refill) and
  // hands the row over. Letting the primitive resolve instead would swap a cache read for
  // a round trip on every carryover action. No `fetch` in this context proves it.
  const r = row("carry-1", "2026-07-28", { local_id: "c-1", title: "Do laundry" });
  const { store, calls } = makeStore([r], { cached: false });
  const ctx = ctxWith(PRIMITIVES, { window: { blockStore: store } });
  return ctx.unscheduleRow("carry-1", { block: r }).then((res) => {
    assert.ok(res, "resolves from opts.block with no cache hit and no fetch available");
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].props.title, "Do laundry", "the REAL properties, not a wiped bag");
  });
});

// ───────────────────── addToSchedule: the round trip keeps its id ─────────────────────

test("addToSchedule promotes a backlog row IN PLACE — no delete, no create", () => {
  const r = row("row-9", null, { local_id: "bl-1", title: "Provision AWS", kind: "backlog", durMin: 45 });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith([SRC.addToSchedule, SRC.scheduleRowOnDay, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], {
    window: { blockStore: store },
    backlog: [{ id: "bl-1", title: "Provision AWS", type: "task", durMin: 45, _blockId: "row-9" }],
    persistAddedTask: () => { throw new Error("persistAddedTask must NOT run for a block-backed backlog item"); },
    _reorderActive: () => {},
  });
  ctx.addToSchedule("bl-1");
  assert.equal(ctx.backlog.length, 0, "it leaves the backlog");
  assert.equal(ctx.scheduled.length, 1, "and joins the day's plan");
  assert.equal(ctx.scheduled[0].id, "bl-1", "under its own id");
  return new Promise((r2) => setTimeout(r2, 0)).then(() => {
    assert.equal(calls.del.length, 0, "the tombstone is gone: this used to deleteBacklogBlock");
    assert.equal(calls.create.length, 0, "and this used to persistAddedTask a row with a NEW id");
    assert.equal(calls.update.length, 1, "one date UPDATE instead");
    assert.equal(calls.update[0].id, "row-9", "on the row that already existed");
    assert.equal(calls.update[0].extra.date, "2026-08-03");
  });
});

test("addToSchedule still CREATES for a consider item and for a backlog item with no row", () => {
  // consider[] comes from INIT_CONSIDER (data.js) and has no row to re-date, and a
  // backlog item added in this session may not have round-tripped through the projection
  // yet. Both must keep creating, or the task would not persist at all.
  const { store, calls } = makeStore([]);
  const created = [];
  const ctx = ctxWith([SRC.addToSchedule, SRC.scheduleRowOnDay, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], {
    window: { blockStore: store },
    consider: [{ id: "cons-1", title: "From consider", type: "task", durMin: 30 }],
    backlog: [{ id: "bl-norow", title: "No row yet", type: "task", durMin: 30 }],
    persistAddedTask: (item) => created.push(item.id),
    _reorderActive: () => {},
  });
  ctx.addToSchedule("cons-1");
  ctx.addToSchedule("bl-norow");
  assert.deepEqual(created, ["cons-1", "bl-norow"], "both take the create path");
  assert.equal(calls.update.length, 0, "and neither issues a date update");
  assert.equal(calls.del.length, 0);
});

test("deleteBacklogBlock is GONE from the codebase", () => {
  // Its only job was "destroy the row so we can make another one". Keeping it would leave
  // the delete-and-recreate one call away.
  assert.equal(/function deleteBacklogBlock/.test(scheduleSource), false,
    "deleteBacklogBlock must be deleted, not just unused");
  assert.equal(/deleteBacklogBlock\(/.test(SRC.addToSchedule), false,
    "and addToSchedule must not call it");
});

test("the two bl- minting copies are gone: one mechanic, not three", () => {
  const triageSource = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");
  // Scoped to the SLICED functions, not the whole file. `/unscheduleRow\(/.test(stateSource)`
  // was vacuous: `async function unscheduleRow(blockId,opts){` satisfies it on its own, so
  // it proved the primitive EXISTS, not that the mover calls it. Mutation-proved (gutting
  // the call left the suite green). Same hardening for triage, whose nearby comment writes
  // the name and would have carried the regex on its own after one edit.
  const mover = mustSlice(stateSource,
    /^async function _moveTaskToBacklogStage\(id,stage,toastMsg\)\{[\s\S]*?\n\}/m, "_moveTaskToBacklogStage");
  assert.ok(/await unscheduleRow\(/.test(mover),
    "_moveTaskToBacklogStage must actually CALL the primitive");
  // The mover DOES still mint an id — but only in the block-less branch, where no row
  // exists to re-date. What must be gone is minting on the path that HAS a row, so the
  // negative is scoped to everything after the block-less branch returns.
  const reDatePath = mover.slice(mover.indexOf("const updated=await unscheduleRow("));
  assert.equal(/"bl-"\+Date\.now\(\)/.test(reDatePath), false,
    "the re-date path must never mint a copy — that was the identity loss this phase removed");
  assert.equal((mover.match(/"bl-"\+Date\.now\(\)/g) || []).length, 1,
    "exactly one mint, in the block-less branch");

  const triageBtn = mustSliceLoose(triageSource,
    /el\.querySelectorAll\("\.sched-backlog-btn"\)[\s\S]*?\n {2}\}\);/, "triage .sched-backlog-btn handler");
  assert.ok(/moveTaskToBacklog\(/.test(triageBtn),
    "triage's Backlog button must route through the one mover");
  assert.equal(/"bl-"\+Date\.now\(\)/.test(triageBtn), false,
    "and must not mint a bl- copy — its old version did not even remove the original");
});

// ───────────────────── the day -> backlog mover, behaviorally ─────────────────────

const MOVER = mustSlice(stateSource,
  /^async function _moveTaskToBacklogStage\(id,stage,toastMsg\)\{[\s\S]*?\n\}/m, "_moveTaskToBacklogStage");

function moverCtx(extra) {
  return ctxWith([MOVER].concat(PRIMITIVES), extra);
}

test("move-to-backlog re-dates the row and LEAVES IT VISIBLE in Unscheduled", () => {
  // The most user-visible change in the phase, and it had only source-regex coverage.
  const ev = { id: "t-1", title: "Do laundry", start: "09:00", end: "10:30", _blockId: "row-9", _pinnedStart: "09:00" };
  const r = row("row-9", "2026-08-03", { local_id: "t-1", title: "Do laundry", duration: 30, start: "09:00", end: "09:30" });
  const { store, calls } = makeStore([r]);
  const toasts = [];
  const ctx = moverCtx({
    window: { blockStore: store, DCC: { TaskModel } },
    scheduled: [ev], deletedSet: new Set(),
    dur: () => 90,
    _findTaskBlockForDate: () => r,
    _viewedDateStr: () => "2026-08-03",
    _clearTaskPinAndLock: (e) => { delete e._pinnedStart; e._pinCleared = true; },
    showToast: (msg, kind) => toasts.push(kind),
  });
  return ctx._moveTaskToBacklogStage("t-1", "Backlog", "Moved to backlog").then(() => {
    assert.equal(calls.update.length, 1, "one date UPDATE");
    assert.equal(calls.update[0].extra.date, null);
    assert.equal(calls.del.length + calls.create.length, 0, "no delete, no replacement row");
    assert.equal(ctx.deletedSet.size, 0,
      "the row EXISTS and is dateless, so it must never be day-hidden — hiding it would leave the task in the drawer but missing from the list that IS the drawer");
    assert.equal(ev.untimed, true, "it moves to the Unscheduled section instead of vanishing");
    assert.equal(ev._dateless, true);
    assert.equal(ev.stage, "Backlog");
    assert.equal(ev._pinCleared, true, "and the client must drop a pin the row no longer has");
    assert.deepEqual(toasts, ["success"]);
    // The duration regression: dur(ev) is 90, the row's stale properties.duration is 30.
    assert.equal(calls.update[0].props.durMin, 90,
      "the REAL duration must survive — properties.duration is the stale create-time value, because adjustDur only moves ev.end");
    assert.equal(calls.update[0].props.duration, 90, "both spellings, or they drift again");
  });
});

test("move-to-backlog MINTS a row for a block-less scheduled task instead of refusing", () => {
  // Timeline-sourced rows (data.js transformState, ids like `tl-<n>`) have no block. The
  // old path created one via persistBacklogItem; my first cut refused, which turned a
  // working action into an error toast for every Notion/PA timeline task.
  const ev = { id: "tl-3", title: "From Notion", start: "09:00", end: "09:45", type: "task" };
  const storeRows = [];
  const { store, calls } = makeStore(storeRows);
  const toasts = []; const persisted = [];
  const ctx = moverCtx({
    window: { blockStore: store, DCC: { TaskModel, taskCommonProps: (e, o) => Object.assign({ title: e.title }, o) } },
    scheduled: [ev], deletedSet: new Set(),
    dur: () => 45,
    _findTaskBlockForDate: () => null,
    _viewedDateStr: () => "2026-08-03",
    _clearTaskPinAndLock: () => {},
    // Writes into the store the projection reads, the way the real persistBacklogItem
    // does (createBlock caches optimistically and synchronously), so the assertion below
    // observes the REAL hydrateBacklogFromBlocks rather than a spy. A spy would not have
    // run at all: the sliced function declaration shadows a same-named context property.
    persistBacklogItem: (entry) => {
      persisted.push(entry);
      storeRows.push(row("minted-row", null, { local_id: entry.id, title: entry.title, kind: "backlog", durMin: entry.durMin, stage: entry.stage }));
    },
    showToast: (msg, kind) => toasts.push(kind),
  });
  return ctx._moveTaskToBacklogStage("tl-3", "Backlog", "Moved to backlog").then(() => {
    assert.equal(calls.update.length, 0, "there is no row to re-date");
    assert.equal(persisted.length, 1, "so it mints the dateless row");
    assert.equal(persisted[0].durMin, 45, "with the real duration");
    assert.equal(persisted[0].stage, "Backlog");
    assert.ok(ctx.deletedSet.has("tl-3"),
      "and hides the origin the way delete does — the ONE case where deletedSet is still right, because there is no date to clear");
    assert.notEqual(persisted[0].id, "tl-3",
      "the minted row must NOT reuse the ev id: that id is in deletedSet, and buildListView filters deletedSet while buildBacklog does not, so the task would show in the drawer and be missing from the Unscheduled section");
    assert.match(String(persisted[0].id), /^bl-/, "it mints its own id, as the pre-C4 code did");
    assert.deepEqual(ctx.backlog.map((b) => b.id), [persisted[0].id],
      "and the drawer projection must refresh immediately, or the minted row is invisible until a reload");
    assert.deepEqual(toasts, ["success"], "not an error");
  });
});

test("the minted backlog row floors a midnight-crossing duration, meta included", () => {
  // This branch only runs for block-less rows, i.e. data.js timeline items, whose start/end
  // come from two separate Date objects — so one crossing midnight (23:00 -> 00:30) is BORN
  // with dur(ev) = -1350, no reflow overflow required. Persisted raw it would show
  // "-1350m · from schedule" in the drawer and make addToSchedule stamp an end of "-7:-30".
  const ev = { id: "tl-9", title: "Overnight task", start: "23:00", end: "00:30", type: "task" };
  const storeRows = [];
  const { store } = makeStore(storeRows);
  const persisted = [];
  const ctx = moverCtx({
    window: { blockStore: store, DCC: { TaskModel, taskCommonProps: (e, o) => Object.assign({ title: e.title }, o) } },
    scheduled: [ev], deletedSet: new Set(),
    dur: () => -1350,
    ms: (m) => m + "m",
    _findTaskBlockForDate: () => null,
    _viewedDateStr: () => "2026-08-03",
    _clearTaskPinAndLock: () => {},
    persistBacklogItem: (entry) => persisted.push(entry),
    showToast: () => {},
  });
  return ctx._moveTaskToBacklogStage("tl-9", "Backlog", "Moved").then(() => {
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0].durMin > 0, "a negative duration must never be persisted");
    assert.equal(persisted[0].durMin, 30, "it floors to the default");
    assert.equal(persisted[0].meta, "30m · from schedule",
      "and meta is derived from the VALIDATED value, so the drawer text cannot disagree with the stored duration");
  });
});

test("move-to-backlog refuses, without writing, when the write itself fails", () => {
  const ev = { id: "t-1", title: "Do laundry", start: "09:00", end: "09:30", _blockId: "row-9" };
  const r = row("row-9", "2026-08-03", { local_id: "t-1", title: "Do laundry" });
  const { store } = makeStore([r]);
  store.updateBlock = async () => { throw new Error("boom"); };
  const toasts = [];
  const ctx = moverCtx({
    window: { blockStore: store, DCC: { TaskModel } },
    scheduled: [ev], deletedSet: new Set(),
    dur: () => 30,
    _findTaskBlockForDate: () => r,
    _viewedDateStr: () => "2026-08-03",
    _clearTaskPinAndLock: () => {},
    showToast: (msg, kind) => toasts.push(kind),
  });
  return ctx._moveTaskToBacklogStage("t-1", "Backlog", "Moved").then(() => {
    assert.deepEqual(toasts, ["error"], "a THROWN write really did fail and is not in the WAL");
    assert.equal(ev.untimed, undefined, "and the ev must not be mutated as though it had moved");
  });
});

test("_writeRowDate: a throw in the projection refresh does NOT fail the write", () => {
  // The comment calls this load-bearing; nothing exercised it. Reported as a test gap.
  const r = row("row-9", "2026-08-03", { local_id: "t-1", title: "Do laundry" });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store, DCC: { TaskModel } },
    backlog: [],
    hydrateBacklogFromBlocks: () => { throw new Error("projection boom"); },
  });
  return ctx.unscheduleRow("row-9", { block: r }).then((res) => {
    assert.ok(res, "a bookkeeping throw must never report a landed write as failed");
    assert.equal(calls.update.length, 1);
  });
});

test("_rowForDateWrite resolves through the HTTP fallback on a cache miss", () => {
  // The only fetch stub in this file returned {ok:false}, so the success branch of the
  // resolver every id-only caller depends on had never run.
  const r = row("row-9", "2026-07-28", { local_id: "c-1", title: "Do laundry", duration: 30 });
  const { store, calls } = makeStore([r], { cached: false });
  let fetched = null;
  const ctx = ctxWith(PRIMITIVES, {
    window: { blockStore: store, DCC: { TaskModel } },
    fetch: async (u) => { fetched = u; return { ok: true, json: async () => r }; },
    encodeURIComponent,
  });
  return ctx.scheduleRowOnDay("row-9", "2026-08-03").then((res) => {
    assert.ok(res, "it resolves");
    assert.match(String(fetched), /^\/api\/blocks\/row-9$/, "one GET for the row, id-encoded");
    assert.equal(calls.update[0].props.title, "Do laundry", "and writes the REAL properties");
  });
});

test("the drag-out-of-Unscheduled promote strips kind:backlog (the named reuse target)", () => {
  // The only syncAddedTaskTimes test used DATED rows, so the `if(!block.date)` promote
  // branch — the line the phase plan named as its reuse target — was never executed.
  const src = mustSlice(scheduleSource, /^function syncAddedTaskTimes\(\)\{[\s\S]*?\n\}/m, "syncAddedTaskTimes");
  const r = row("bl-row", null, { local_id: "bl-1", title: "Provision AWS", kind: "backlog", durMin: 45 });
  const { store, calls } = makeStore([r]);
  const ctx = ctxWith([src].concat(PRIMITIVES), {
    window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: store, DCC: { TaskModel } },
    backlog: [{ id: "bl-1", _blockId: "bl-row" }],
    scheduled: [{ id: "bl-1", start: "09:00", end: "09:45", untimed: false }],
  });
  ctx.syncAddedTaskTimes();
  return new Promise((d) => setTimeout(d, 0)).then(() => {
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].extra.date, "2026-08-03", "the drag-out stamps the viewed day");
    assert.equal("kind" in calls.update[0].props, false,
      "and strips kind:backlog, which is why it leaves the drawer as well as taking a slot");
    assert.deepEqual(ctx.backlog, [], "so the projection drops it immediately, not on the next reload");
  });
});

test("syncAddedTaskTimes fails loudly rather than silently skipping every row", () => {
  const src = mustSlice(scheduleSource, /^function syncAddedTaskTimes\(\)\{[\s\S]*?\n\}/m, "syncAddedTaskTimes");
  const { store, calls } = makeStore([row("r", "2026-08-03", { local_id: "a", title: "t", start: "08:00" })]);
  const errs = [];
  const ctx = ctxWith([src], {
    console: Object.assign({}, console, { error: (m) => errs.push(m) }),
    window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: store, DCC: {} },
    scheduled: [{ id: "a", start: "09:00", end: "09:30", untimed: false }],
  });
  ctx.syncAddedTaskTimes();
  assert.equal(calls.update.length, 0);
  assert.equal(errs.length, 1);
  assert.match(String(errs[0]), /task-model\.js missing or stale/);
});

// ───────────────────── the anchor: both pools, the right day ─────────────────────

test("taskAnchorById resolves BOTH pools and returns the ORIGIN day for a carryover", () => {
  const carry = { id: "c-1", title: "Do laundry", __unf: { sourceId: "row-77", sourceDate: "2026-07-28" } };
  const ctx = ctxWith([SRC.taskAnchorById, SRC.unfRecById], {
    scheduled: [{ id: "s-1", title: "Today's task", _blockId: "row-1" }],
    viewDate: "2026-08-03",
    _unfinishedCache: { rows: [carry], total: 1 },
    window: {},
  });
  const today = ctx.taskAnchorById("s-1");
  assert.equal(today.carryover, false);
  assert.equal(today.date, "2026-08-03", "a row in this day's plan writes to the viewed day");
  assert.equal(today.blockId, "row-1");

  const past = ctx.taskAnchorById("c-1");
  assert.equal(past.carryover, true);
  assert.equal(past.date, "2026-07-28", "a carryover writes to its ORIGIN day, never today");
  assert.equal(past.blockId, "row-77", "and it hands out the ROW id, because _rangeCache is not searchable by local_id");
  assert.equal(past.ev, carry, "the ev comes from the carryover pool");

  assert.equal(ctx.taskAnchorById("nope"), null, "an unknown id resolves to nothing rather than a wrong day");
});

test("a carryover settlement evicts the itinerary cache and renders once", () => {
  let renders = 0;
  const source = [
    "let _unfinishedCache={rows:[{id:'p',__unf:{done:false}},{id:'k',__unf:{done:false}},{id:'other',__unf:{done:false}}],total:3};",
    SRC.unfDropRows,
    SRC.unfHandleSettlement,
    "this.readUnfinished=()=>_unfinishedCache;"
  ];
  const ctx = ctxWith(source, { render: () => { renders++; } });
  ctx._unfHandleSettlement({ detail: { action: "drop", removed: ["p", "k"] } });

  assert.deepEqual(JSON.parse(JSON.stringify(ctx.readUnfinished().rows.map(row => row.id))), ["other"]);
  assert.equal(ctx.readUnfinished().total, 1);
  assert.equal(renders, 1);
});

test("the row + and the row click are no longer gated on isUnfRow, and the bounty still is", () => {
  // Anchored on the ternary that immediately precedes the button literal, read BACKWARDS
  // from it, so the span is exactly the gate and nothing else. The first version of this
  // used a loose `[^?]*` and the mutation check showed it did not trip when isUnfRow was
  // put back — it had matched a different span.
  const at = tabSource.indexOf('<button class="btn-add-menu row-add-menu"');
  assert.ok(at > 0, "the + button literal must still be findable");
  const before = tabSource.slice(Math.max(0, at - 120), at);
  const gate = before.slice(before.lastIndexOf("+("));
  assert.ok(/isDoneRow/.test(gate), "sanity: the slice really is the gate expression — " + JSON.stringify(gate));
  assert.equal(/isUnfRow/.test(gate), false,
    "the + must render on carryover rows now — gate was " + JSON.stringify(gate));
  assert.equal(/isMeeting\(ev\)/.test(gate), false,
    "meetings can own concurrent nested work or relevant subtasks now");

  // The details-modal click listener must be attached unconditionally.
  //
  // THIS ASSERTION WAS VACUOUS TWICE. `indexOf('el.addEventListener("click",e=>{')`
  // matches as a SUBSTRING of `del.addEventListener("click",e=>{` about 1.5kB earlier, so
  // the 60-char window landed on the delete button's handler and the isUnfRow regex could
  // never match whatever the row listener looked like. Mutation-proved: restoring
  // `if(!isUnfRow)` on the real listener left the suite green. Anchored now on the
  // listener's own first line, with a negative lookbehind so `del.`/`bb.`/`am.` cannot
  // match, and the sanity assert below fails loudly if the anchor ever drifts again.
  const m = /([\s\S]{0,60})(?<![\w.$])el\.addEventListener\("click",e=>\{\s*\n\s*if\(e\.target\.closest\("button,a,input/.exec(tabSource);
  assert.ok(m, "the row's open-space click listener must still be findable");
  // The guard pattern is deliberately WIDER than the exact form C1 used: `if(!isUnfRow){`
  // and `if(!isUnfRow&&!isDoneRow)` both slipped past a `/if\(!isUnfRow\)\s*$/` test. This
  // assertion has been vacuous twice, so the anchor is precise and the guard match is loose.
  assert.equal(/if\s*\([^)]*isUnfRow[^)]*\)\s*\{?\s*$/.test(m[1]), false,
    "the row's open-space click must not be behind an isUnfRow gate any more — saw " + JSON.stringify(m[1].slice(-40)));

  // The bounty is still deliberately off, and that is a product decision, not a gap.
  assert.ok(/!isUnfRow&&_canPlaceBounty\(ev,isDoneRow\)/.test(tabSource),
    "the bounty stays off carryover rows until its points semantics are chosen");
});

test("addSubtask on a carryover creates on the ORIGIN day and stays out of today's plan", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addSubtask\(taskId, text, options\)\{[\s\S]*?\n\}/m, "addSubtask");
  const { store, calls } = makeStore([]);
  const carry = { id: "c-1", title: "Do laundry", start: "09:00", __unf: { sourceId: "row-77", sourceDate: "2026-07-28" } };
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {} },
    scheduled: [],
    viewDate: "2026-08-03",
    taskAnchorById: (id) => (id === "c-1"
      ? { ev: carry, date: "2026-07-28", blockId: "row-77", carryover: true }
      : null),
    invalidateUnfinishedSection: () => { ctx.recollected = true; },
    _recollectCarryover: (d, pending) => { ctx.recollectedDate = d; ctx.recollectedPending = pending; },
  });
  ctx.addSubtask("c-1", "Fold the darks");
  assert.equal(calls.create.length, 1, "the subtask is persisted");
  assert.equal(calls.create[0].extra.date, "2026-07-28",
    "on the parent's ORIGIN day — created on today it would be an orphan on both days");
  assert.equal(calls.create[0].props.subtaskOf, "c-1", "with the parent edge");
  assert.equal(ctx.scheduled.length, 0,
    "and NOT pushed into today's plan, where its parent is not present so nothing could nest it");
  assert.equal(ctx.recollectedDate, "2026-07-28",
    "the lane must re-collect, or the new child does not appear until a reload");
  assert.ok(ctx.recollectedPending && typeof ctx.recollectedPending.then === "function",
    "and the IN-FLIGHT create must be handed over: the lane reads the SERVER, so re-collecting first lets the read be served before the POST lands and then cache an answer without the new row");
});

test("addSubtask for a future scheduled parent uses the parent's date and stays out of today", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addSubtask\(taskId, text, options\)\{[\s\S]*?\n\}/m, "addSubtask");
  const { store, calls } = makeStore([]);
  let renders = 0;
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {} },
    scheduled: [],
    viewDate: "2026-08-13",
    taskAnchorById: () => null,
    render: () => { renders++; },
  });

  ctx.addSubtask("future-parent", "Put it in the washer", {
    date: "2026-08-14",
    parentStart: "08:00",
  });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].extra.date, "2026-08-14",
    "the child must be persisted beside its future parent");
  assert.equal(calls.create[0].props.subtaskOf, "future-parent");
  assert.equal(calls.create[0].props.start, "08:00");
  assert.equal(ctx.scheduled.length, 0,
    "a future child must never appear as a standalone row in today's plan");
  assert.equal(renders, 0, "today's unchanged plan does not need a speculative repaint");
});

test("addTaskAdjacent on a carryover: origin day, and today's plan is NOT reflowed", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addTaskAdjacent\(targetId,title,durMin,where\)\{[\s\S]*?\n\}/m, "addTaskAdjacent");
  const { store, calls } = makeStore([]);
  const carry = { id: "c-1", title: "Do laundry", start: "09:00", end: "09:30" };
  let reorders = 0, reflows = 0, savedOrder = 0;
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {} },
    scheduled: [], viewDate: "2026-08-03",
    taskAnchorById: () => ({ ev: carry, date: "2026-07-28", blockId: "row-77", carryover: true }),
    _reorderActive: () => { reorders++; },
    recalcTimes: () => { reflows++; },
    saveTaskOrder: () => { savedOrder++; },
    syncAddedTaskTimes: () => { throw new Error("must not sync today's times for a carryover insert"); },
    _recollectCarryover: (d, pending) => { ctx.recollectedDate = d; ctx.recollectedPending = pending; },
  });
  ctx.addTaskAdjacent("c-1", "Sort the darks", 30, "after");
  assert.equal(calls.create[0].extra.date, "2026-07-28", "created on the ORIGIN day");
  assert.equal(ctx.scheduled.length, 0, "and never pushed into today's plan");
  assert.equal(reorders, 0, "_reorderActive must not run against a row that is not in scheduled[]");
  assert.equal(reflows, 0, "nor may today's plan be reflowed around it");
  assert.equal(savedOrder, 0);
  assert.equal(ctx.recollectedDate, "2026-07-28");
  assert.ok(ctx.recollectedPending && typeof ctx.recollectedPending.then === "function",
    "and the in-flight create must be handed over");
});

test("addTaskAdjacent's derived end is clamped to the end of the day", () => {
  // Same reason as addStackedTask: on a carryover the onViewedDay gate skips the recalcTimes
  // pass, so an overflowing "24:15" would be permanent on that origin-day row.
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addTaskAdjacent\(targetId,title,durMin,where\)\{[\s\S]*?\n\}/m, "addTaskAdjacent");
  const { store, calls } = makeStore([]);
  const lateParent = { id: "c-1", title: "Late task", start: "23:30", end: "23:50" };
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {} },
    scheduled: [], viewDate: "2026-08-03",
    taskAnchorById: () => ({ ev: lateParent, date: "2026-07-28", blockId: "row-77", carryover: true }),
    _recollectCarryover: () => {},
  });
  ctx.addTaskAdjacent("c-1", "After it", 30, "after");
  const p = calls.create[0].props;
  assert.equal(p.end, "23:59", "clamped, never '24:20'");
  assert.ok(ctx.pt(p.end) - ctx.pt(p.start) > 0, "so the duration stays positive");
});

test("addStackedTask on a carryover: origin day, no wrap-window placement, lane re-collects", () => {
  // Reachable three ways on a carryover row now: openTaskAdd's "Nested" place (the popover
  // the row "+" opens), addSubtask's reroute for wrap-edge parents, and the details modal's
  // `stacked` item type. Unfixed, each created the ride-along on the VIEWED day with a
  // wrapId pointing at a past-day row: an orphan on both days.
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addStackedTask\(taskId, text, durMinArg, opts\)\{[\s\S]*?\n\}/m, "addStackedTask");
  const { store, calls } = makeStore([]);
  const carry = { id: "c-1", title: "Shell parent", start: "09:00", end: "11:00" };
  const ctx = ctxWith([src], {
    window: {
      blockStore: store, DCC: {},
      TaskTypes: { rule: () => null, isRollup: () => true },
      PointPlan: { ensure: () => {} },
    },
    scheduled: [], viewDate: "2026-08-03",
    taskAnchorById: () => ({ ev: carry, date: "2026-07-28", blockId: "row-77", carryover: true }),
    _placeInWrapWindow: () => { throw new Error("wrap-window placement reflows scheduled[]; must not run for a carryover"); },
    recalcTimes: () => { throw new Error("must not reflow today's plan"); },
    _recollectCarryover: (d, pending) => { ctx.recollectedDate = d; ctx.recollectedPending = pending; },
  });
  const t = ctx.addStackedTask("c-1", "Ride along", 30);
  assert.ok(t);
  assert.equal(calls.create[0].extra.date, "2026-07-28", "created on the ORIGIN day");
  assert.equal(calls.create[0].props.wrapId, "c-1", "with the ride-along edge intact");
  assert.equal(calls.create[0].props.start, "09:00",
    "and it inherits the carryover parent's start — only the anchor knows it, scheduled[] does not hold that ev");
  assert.equal(calls.create[0].props.end, "09:30");
  assert.equal(ctx.recollectedPending && typeof ctx.recollectedPending.then === "function", true,
    "and the in-flight create must be handed over");
  assert.equal(ctx.scheduled.length, 0, "and not in today's plan");
  assert.equal(ctx.recollectedDate, "2026-07-28");
});

test("_recollectCarryover waits for the create, then does BOTH halves", () => {
  // Both halves: the range cache holds the day's rows, _unfinishedCache is what the lane
  // renders from, and invalidating only one leaves the other stale. And it must run AFTER
  // the create commits — the lane reads the SERVER, so invalidating first lets the
  // re-collect be served before the POST lands and then cache that empty answer.
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function _recollectCarryover\(sourceDate,pending\)\{[\s\S]*?\n\}/m, "_recollectCarryover");
  const seen = [];
  let resolveCreate;
  const pending = new Promise((r) => { resolveCreate = r; });
  const ctx = ctxWith([src], {
    window: {
      blockStore: { invalidateRangeCache: (d) => seen.push(["range", d]) },
      DCC: { Carryover: { recollect: (d) => seen.push(["recollect", d]) } },
    },
    render: () => seen.push(["render"]),
  });
  ctx._recollectCarryover("2026-07-28", pending);
  assert.deepEqual(seen, [], "nothing happens while the create is still in flight");
  resolveCreate();
  return pending.then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.deepEqual(seen, [["recollect", "2026-07-28"], ["render"]],
      "then it re-collects through DCC.Carryover and re-renders, in that order");
  });
});

test("_recollectCarryover's fallback keeps both halves when DCC.Carryover is absent", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function _recollectCarryover\(sourceDate,pending\)\{[\s\S]*?\n\}/m, "_recollectCarryover");
  const seen = [];
  const ctx = ctxWith([src], {
    window: { blockStore: { invalidateRangeCache: (d) => seen.push(["range", d]) }, DCC: {} },
    invalidateUnfinishedSection: () => seen.push(["section"]),
    render: () => seen.push(["render"]),
  });
  ctx._recollectCarryover("2026-07-28", null);
  assert.deepEqual(seen, [["range", "2026-07-28"], ["section"], ["render"]],
    "range cache AND section, neither is sufficient alone");
});

test("_recollectCarryover still re-collects when the create FAILS", () => {
  // `pending.then(run, run)` — the second handler is deliberate and was unguarded. If the
  // create rejects (offline, 500, a WAL-buffered failure), dropping it would leave the lane
  // stale AND never repaint, which is strictly worse than the pre-fix behavior of always
  // re-collecting. Reported as a gap by round 2.
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function _recollectCarryover\(sourceDate,pending\)\{[\s\S]*?\n\}/m, "_recollectCarryover");
  const seen = [];
  const ctx = ctxWith([src], {
    window: {
      blockStore: { invalidateRangeCache: (d) => seen.push(["range", d]) },
      DCC: { Carryover: { recollect: (d) => seen.push(["recollect", d]) } },
    },
    render: () => seen.push(["render"]),
  });
  const pending = Promise.reject(new Error("POST failed"));
  ctx._recollectCarryover("2026-07-28", pending);
  return pending.catch(() => {}).then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.deepEqual(seen, [["recollect", "2026-07-28"], ["render"]],
      "a failed create must still re-collect and repaint");
  });
});

test("each details-modal helper writes its OWN key, with the right value", () => {
  // The routing test was presence-only, so every patch PAYLOAD could be wrong and stay
  // green: `{ key: val }` instead of `{ [key]: val }` writes properties.key; `{ title:
  // taskId }` writes the ev id as the title; `{ tag: ids }` lands where nothing reads.
  // Each is a silent wrong-property write behind a success toast — the failure
  // _amWriteRowProps exists to close. Round 2 caught all three as uncovered.
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  // JSON-normalized on the way out. The patch object is constructed INSIDE the vm, so its
  // prototype is that realm's Object — and assert/strict's deepEqual compares prototypes,
  // so a correct payload fails a naive deepEqual. That is a harness trap, not a code
  // defect, and it is worth naming: a cross-realm comparison that fails on a right answer
  // is one debugging session away from someone "fixing" working production code.
  function patchFrom(what, re, drive) {
    const spy = [];
    const ctx = ctxWith([mustSlice(featuresSource, re, what)], {
      _amWriteRowProps: (p) => { spy.push(JSON.parse(JSON.stringify(p))); return true; },
      window: {},
    });
    drive(ctx);
    return spy;
  }
  assert.deepEqual(
    patchFrom("_persistMeetingFlag", /^function _persistMeetingFlag\(taskId, key, val\) \{[\s\S]*?\n\}/m,
      (c) => c._persistMeetingFlag("c-1", "recording_review", true)),
    [{ recording_review: true }],
    "the flag must be written under its OWN key, not the literal 'key'");
  assert.deepEqual(
    patchFrom("_persistTaskTitle", /^function _persistTaskTitle\(taskId, newTitle\) \{[\s\S]*?\n\}/m,
      (c) => c._persistTaskTitle("c-1", "Renamed")),
    [{ title: "Renamed" }],
    "the title must be the NEW title, not the task id");
  assert.deepEqual(
    patchFrom("_persistTaskTags", /^function _persistTaskTags\(taskId, tagIds\) \{[\s\S]*?\n\}/m,
      (c) => c._persistTaskTags("c-1", ["home"])),
    [{ tags: ["home"] }],
    "tags go under `tags`");
});

test("DCC.Carryover.recollect is exported, so the next caller finds it", () => {
  const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
  assert.ok(/recollect: recollect/.test(unfSource),
    "the lane owns this mechanic; leaving it private in tabs.js is how a fifth hand-rolled copy happens");
});

// ───────────────────── the details modal's writes reach the right row ─────────────────

test("_amWriteRowProps addresses the ROW, carries the rest, and refuses on a miss", () => {
  // The modal is open on carryover rows now, and a carryover's block is in _rangeCache
  // only — so every getByType search in features.js misses it. Three of the four write
  // helpers ignored the row id in the first cut: rename toasted success and persisted
  // nothing, the recording-review toggle no-opped, and commute wrote the wrong day.
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  // _amWriteRowProps delegates to state.js's shared queue now, so the context gets the real
  // queue rather than a local one. The chain assertion moved with it: it lives in state.js
  // and is shared with the commute writer, which is the whole point of the round-3 fix.
  const src = mustSlice(featuresSource, /^function _amWriteRowProps\(patch\) \{[\s\S]*?\n\}/m, "_amWriteRowProps");
  assert.ok(/_rowPropsChain=_rowPropsChain\n?\s*\.then\(/.test(stateSource),
    "row-properties writes must be serialized, or a rename and a tag edit from the same click drop one of the two");
  assert.equal(/_amWriteChain/.test(featuresSource), false,
    "and there must be no second, per-file chain — four writers with the queue in one of them is the bug");
  const r = row("row-77", "2026-07-28", { local_id: "c-1", title: "Do laundry", notes: "keep me", tags: ["old"] });
  const { store, calls } = makeStore([r], { cached: false });

  const queue = ["let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps];
  const ok = ctxWith([src].concat(queue), {
    window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: store },
    _addModalBlockId: "row-77",
    _rowForDateWrite: async () => r,
  });
  assert.equal(ok._amWriteRowProps({ title: "Renamed" }), true, "it owns the write");
  return new Promise((d) => setTimeout(d, 0)).then(() => {
    assert.equal(calls.update[0].id, "row-77", "addressed by ROW id, not a local_id search");
    assert.equal(calls.update[0].props.title, "Renamed");
    assert.equal(calls.update[0].props.notes, "keep me",
      "updateBlock REPLACES properties, so everything else has to be carried");
    assert.deepEqual(calls.update[0].props.tags, ["old"]);

    // refuses when the row cannot be resolved, rather than writing a wiped bag
    const { store: s2, calls: c2 } = makeStore([], { cached: false });
    const miss = ctxWith([src].concat(queue), {
      window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: s2 },
      _addModalBlockId: "gone",
      _rowForDateWrite: async () => null,
    });
    assert.equal(miss._amWriteRowProps({ title: "x" }), true, "it still owns it");
    return new Promise((d) => setTimeout(d, 0)).then(() => {
      assert.equal(c2.update.length, 0, "but writes nothing");
    });
  }).then(() => {
    // and it declines (returns false) so the caller keeps its legacy path.
    //
    // Each of these supplies a WORKING _rowForDateWrite, so the only thing that can make
    // it decline is the condition under test. My first cut omitted the stub in the
    // flag-off case, so that assertion passed because the resolver was missing rather
    // than because the flag was off — the mutation harness caught it as vacuous.
    const { store: s3 } = makeStore([r]);
    const resolver = async () => r;
    const noId = ctxWith([src].concat(queue), {
      window: { USE_BLOCKSTORE: { addedTasks: true }, blockStore: s3 },
      _addModalBlockId: null, _rowForDateWrite: resolver,
    });
    assert.equal(noId._amWriteRowProps({ title: "x" }), false, "no row id -> caller falls back");

    const flagOff = ctxWith([src].concat(queue), {
      window: { USE_BLOCKSTORE: { addedTasks: false }, blockStore: s3 },
      _addModalBlockId: "row-77", _rowForDateWrite: resolver,
    });
    assert.equal(flagOff._amWriteRowProps({ title: "x" }), false,
      "and the USE_BLOCKSTORE rollback lever must revert THIS write too, not just the legacy two");

    const noStore = ctxWith([src].concat(queue), {
      window: { USE_BLOCKSTORE: { addedTasks: true } },
      _addModalBlockId: "row-77", _rowForDateWrite: resolver,
    });
    assert.equal(noStore._amWriteRowProps({ title: "x" }), false, "and no blockStore -> caller falls back");
  });
});

test("row-properties writes are SERIALIZED, so two edits from one click both survive", () => {
  // The bug this closes: updateBlock REPLACES properties, so two concurrent
  // read-modify-writes both read the pre-write bag and the second PATCH drops the first's
  // field. The gesture is ordinary — type a new title, then click a tag chip (or just close
  // the modal, which always fires the commute write): the blur and the click both fire, two
  // GETs go out, and for an UNCACHED row (a carryover) neither read sees the other's write.
  //
  // Driven through the real queue with a resolver that always answers the ORIGINAL row, so
  // an unserialized implementation provably loses a field and a serialized one does not.
  const base = row("row-77", "2026-07-28", { local_id: "c-1", title: "Old title", tags: [] });
  const { store, calls } = makeStore([base], { cached: false });
  let served = 0;
  const ctx = ctxWith(["let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps], {
    window: { blockStore: store },
    // Models an uncached row: every read is a fresh fetch of what the SERVER has. The
    // queue's own writes are what must be visible to the next link, so this returns the
    // latest written properties — exactly what updateBlock's cacheSet buys in production.
    _rowForDateWrite: async () => {
      served++;
      const latest = calls.update.length ? calls.update[calls.update.length - 1].props : base.properties;
      return { id: "row-77", properties: latest };
    },
  });
  ctx.enqueueRowPropsWrite("row-77", (p) => Object.assign({}, p, { title: "New title" }));
  const settled = ctx.enqueueRowPropsWrite("row-77", (p) => Object.assign({}, p, { tags: ["home"] }));
  assert.ok(settled && typeof settled.then === "function", "it returns the queue tail so callers can await it");
  return settled.then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.equal(calls.update.length, 2, "both writes happen");
    assert.equal(served, 2, "each link re-reads, so it composes on the previous result");
    const final = calls.update[1].props;
    assert.equal(final.title, "New title", "the rename must survive the tag write");
    assert.deepEqual(final.tags, ["home"], "and the tag write must survive too");
    assert.equal(final.local_id, "c-1", "with the rest of the bag intact");
  });
});

// C5b: the queue resolves and forwards `extra`, the top-level write metadata.
// and it is what stops a completion on a DATELESS Unscheduled row from making the task vanish
// — `isFoldableTask` rejects `(status==="done"||done===true)&&!b.date` and
// `selectUnscheduled` rejects `status==="done"`, so a done row with no date is in neither
// list. Asserted on the real queue because the completion tests reach it through a fake,
// which cannot catch the argument being dropped here.
test("the queue forwards the `extra` column write (a completion promotes a dateless row)", () => {
  const base = row("row-88", null, { local_id: "u-1", title: "Someday", kind: "backlog" });
  const { store, calls } = makeStore([base], { cached: true });
  const ctx = ctxWith(["let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps], {
    window: { blockStore: store },
    _rowForDateWrite: async () => ({ id: "row-88", properties: base.properties }),
  });
  const settled = ctx.enqueueRowPropsWrite(
    "row-88",
    (p, block) => Object.assign({}, p, { status: "done", sourceRow: block.id }),
    block => ({ date: block.date ? undefined : "2026-08-04", completionIntent: "complete" })
  );
  return settled.then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].props.status, "done");
    assert.equal(calls.update[0].props.sourceRow, "row-88", "the merge sees the freshly-read row");
    assert.equal(calls.update[0].extra.date, "2026-08-04");
    assert.equal(calls.update[0].extra.completionIntent, "complete");
    assert.equal(calls.update[0].extra._completionBaseBlock.id, "row-88",
      "the fetched cache-miss row also becomes the completion CAS/delta base");
  });
});

// ...and it stays undefined when nobody asks, so an ordinary properties write cannot
// accidentally re-date a row.
test("no `extra` means no column write", () => {
  const base = row("row-89", "2026-07-28", { local_id: "c-9", title: "Dated" });
  const { store, calls } = makeStore([base], { cached: true });
  const ctx = ctxWith(["let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps], {
    window: { blockStore: store },
    _rowForDateWrite: async () => ({ id: "row-89", properties: base.properties }),
  });
  const settled = ctx.enqueueRowPropsWrite("row-89", (p) => Object.assign({}, p, { title: "Renamed" }));
  return settled.then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.equal(calls.update[0].extra, undefined);
  });
});

test("one failed row write does not wedge the queue for the rest of the session", () => {
  // The per-link `.catch` is what guarantees this. Without it a single rejection leaves
  // `_rowPropsChain` permanently rejected and every later modal edit silently no-ops.
  const r = row("row-77", "2026-07-28", { local_id: "c-1", title: "T" });
  const { store, calls } = makeStore([r], { cached: false });
  let n = 0;
  const ctx = ctxWith(["let _rowPropsChain = Promise.resolve();", SRC.enqueueRowProps], {
    window: { blockStore: store },
    _rowForDateWrite: async () => { n++; if (n === 1) throw new Error("GET failed"); return r; },
  });
  ctx.enqueueRowPropsWrite("row-77", (p) => Object.assign({}, p, { title: "first" }));
  const settled = ctx.enqueueRowPropsWrite("row-77", (p) => Object.assign({}, p, { title: "second" }));
  return settled.then(() => new Promise((d) => setTimeout(d, 0))).then(() => {
    assert.equal(calls.update.length, 1, "the first write failed and the SECOND still ran");
    assert.equal(calls.update[0].props.title, "second");
  });
});

test("both _amWriteRowProps and the commute write use the ONE shared queue", () => {
  // Four writers touch this properties bag. An earlier cut put the chain inside features.js
  // and then added the commute writer outside it in the same change — the "enforced at one
  // call site, assumed at the other" shape. Scoped to the sliced functions so a comment
  // cannot satisfy it.
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  const amw = mustSlice(featuresSource, /^function _amWriteRowProps\(patch\) \{[\s\S]*?\n\}/m, "_amWriteRowProps");
  assert.ok(/enqueueRowPropsWrite\(/.test(amw), "the modal writes must go through the shared queue");
  assert.equal(/_rowForDateWrite\(/.test(amw), false,
    "and must NOT resolve the row themselves — that is what put a writer outside the queue");
  const commute = mustSlice(stateSource, /^function setTaskCommuteTimes\(taskId,value,opts\)\{[\s\S]*?\n\}/m, "setTaskCommuteTimes");
  assert.ok(/enqueueRowPropsWrite\(/.test(commute), "and so must the commute write");
  assert.equal(/_amWriteChain/.test(featuresSource), false, "no second, per-file chain");
});

test("the modal's row id is SET from the anchor and CLEARED on close", () => {
  // openAddModal / closeAddModal are too DOM-bound to drive here, so these are scoped
  // source assertions over the sliced functions — honest about what they are, and they
  // cannot be satisfied by a mention elsewhere in the file. Reported by the mutation
  // harness as uncovered: without the clear, the NEXT modal's tag/title/flag writes target
  // the PREVIOUS row, which is a cross-task write.
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  const open = mustSlice(featuresSource, /^function openAddModal\(taskId, taskTitle\) \{[\s\S]*?\n\}/m, "openAddModal");
  assert.ok(/taskAnchorById/.test(open), "openAddModal must resolve through the shared anchor, not scheduled[] alone");
  assert.ok(/_addModalBlockId = \(anchor && anchor\.blockId\) \|\| null;/.test(open),
    "and stamp the row id, or every write helper below falls back to a cache search that misses a carryover");
  const close = mustSlice(featuresSource, /^function closeAddModal\(\) \{[\s\S]*?\n\}/m, "closeAddModal");
  assert.ok(/_addModalBlockId = null;/.test(close),
    "closeAddModal must clear the row id, or the next modal writes to this row");
});

test("the fold's _tmReady gate stops the loop rather than throwing into a discarding catch", () => {
  // reloadPersistedEdits is not sliceable (it is hundreds of lines of globals), so this is
  // a scoped source assertion. It matters because isFoldableTask now CALLS TM: without the
  // gate, a missing module throws on the first block, the surrounding catch discards it,
  // and the user gets a silently EMPTY itinerary with nothing in the console.
  const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
  assert.ok(/const _tmReady=!!\(TM&&typeof TM\.fromBlock==="function"&&typeof TM\.foldsIntoItinerary==="function"\);/.test(persistenceSource),
    "the gate must check BOTH exports the fold loop uses");
  assert.ok(/const addedBlocks=_tmReady\?\[/.test(persistenceSource),
    "and it must gate the COLLECTION, not just the loop — .filter(isFoldableTask) is what calls TM");
  assert.ok(/if\(!_tmReady\)console\.error\("\[persistence\] task-model\.js missing or stale/.test(persistenceSource),
    "and say so out loud");
  // The declaration has to precede the predicate, or the const is in its TDZ when
  // .filter() runs and the ReferenceError lands in the discarding catch instead.
  assert.ok(persistenceSource.indexOf("const _tmReady=") < persistenceSource.indexOf("const isFoldableTask="),
    "_tmReady must be declared ABOVE isFoldableTask");
});

test("DCC.Carryover.recollect does both halves", () => {
  // The tabs.js fallback is covered separately; this is the real exported mechanic, which
  // the mutation harness found untested.
  const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
  // mustSliceLoose, not mustSlice: this function is indented inside the module IIFE, so
  // the one-function span check (which anchors `function` at column 0) cannot see it. The
  // dedent below is what makes it runnable, and the assertion on `seen` is what proves the
  // slice was the right span.
  const src = mustSliceLoose(unfSource, /^ {2}function recollect\(sourceDate\) \{[\s\S]*?\n {2}\}/m, "recollect")
    .replace(/^ {2}/gm, "");
  assert.equal((src.match(/function /g) || []).length, 1, "the slice must be exactly one function");
  const seen = [];
  const ctx = ctxWith([src], {
    window: { blockStore: { invalidateRangeCache: (d) => seen.push(["range", d]) } },
    invalidateUnfinishedSection: () => seen.push(["section"]),
  });
  ctx.recollect("2026-07-28");
  assert.deepEqual(seen, [["range", "2026-07-28"], ["section"]],
    "the range cache holds the day's rows and _unfinishedCache is what renders; one without the other leaves a stale lane");
});

test("every details-modal write helper routes through _amWriteRowProps", () => {
  // The blocking finding was that only the tags path did. Scoped to each function so a
  // mention in a comment cannot satisfy it.
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  for (const [re, what] of [
    [/^function _persistTaskTags\(taskId, tagIds\) \{[\s\S]*?\n\}/m, "_persistTaskTags"],
    [/^function _persistMeetingFlag\(taskId, key, val\) \{[\s\S]*?\n\}/m, "_persistMeetingFlag"],
    [/^function _persistTaskTitle\(taskId, newTitle\) \{[\s\S]*?\n\}/m, "_persistTaskTitle"],
  ]) {
    const fn = mustSlice(featuresSource, re, what);
    assert.ok(/_amWriteRowProps\(/.test(fn),
      what + " must address the row directly, or its edit is silently dropped on a carryover");
  }
  const commute = mustSlice(featuresSource, /^function persistAddModalCommute\(\) \{[\s\S]*?\n\}/m, "persistAddModalCommute");
  assert.ok(/blockId: _addModalBlockId/.test(commute),
    "the commute write must hand the row id to setTaskCommuteTimes, or it records against the wrong day");
});

test("addSubtask on an ordinary row is unchanged: viewed day, and it joins the plan", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addSubtask\(taskId, text, options\)\{[\s\S]*?\n\}/m, "addSubtask");
  const { store, calls } = makeStore([]);
  const parent = { id: "s-1", title: "Today's task", start: "10:00" };
  const ctx = ctxWith([src], {
    window: { blockStore: store, DCC: {} },
    scheduled: [parent],
    viewDate: "2026-08-03",
    taskAnchorById: () => ({ ev: parent, date: "2026-08-03", blockId: "row-1", carryover: false }),
    _recollectCarryover: () => { throw new Error("must not re-collect the carryover lane for a normal row"); },
  });
  ctx.addSubtask("s-1", "Step one");
  assert.equal(calls.create[0].extra.date, "2026-08-03");
  assert.equal(ctx.scheduled.length, 2, "it renders in today's plan immediately, as before");
});
