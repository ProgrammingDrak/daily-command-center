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

const SRC = {
  addToSchedule: mustSlice(scheduleSource, /^function addToSchedule\(blId,opts\)\{[\s\S]*?\n\}/m, "addToSchedule"),
  hydrateBacklog: mustSlice(scheduleSource, /^function hydrateBacklogFromBlocks\(\)\{[\s\S]*?\n\}/m, "hydrateBacklogFromBlocks"),
  scheduleRowOnDay: mustSlice(stateSource, /^async function scheduleRowOnDay\(blockId,dateStr,opts\)\{[\s\S]*?\n\}/m, "scheduleRowOnDay"),
  unscheduleRow: mustSlice(stateSource, /^async function unscheduleRow\(blockId,opts\)\{[\s\S]*?\n\}/m, "unscheduleRow"),
  writeRowDate: mustSlice(stateSource, /^async function _writeRowDate\(blockId,block,props,dateStr\)\{[\s\S]*?\n\}/m, "_writeRowDate"),
  rowForDateWrite: mustSlice(stateSource, /^async function _rowForDateWrite\(blockId\)\{[\s\S]*?\n\}/m, "_rowForDateWrite"),
  syncBacklog: mustSlice(stateSource, /^function _syncBacklogProjection\(evId,dateStr\)\{[\s\S]*?\n\}/m, "_syncBacklogProjection"),
  taskAnchorById: mustSlice(tabSource, /^function taskAnchorById\(id\)\{[\s\S]*?\n\}/m, "taskAnchorById"),
  unfRecById: mustSlice(tabSource, /^function _unfRecById\(id\)\{[\s\S]*?\n\}/m, "_unfRecById"),
};

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
  const kinds = (body.match(/'(delegated_item|task_group|reschedule_tombstone)'/g) || []).map((s) => s.replace(/'/g, ""));
  assert.deepEqual(kinds.sort(), ["delegated_item", "reschedule_tombstone", "task_group"],
    "the SQL exclusion list changed — update TaskModel.isTaskRow to match");
  for (const kind of kinds) {
    assert.equal(TaskModel.isTaskRow(row("x", null, { kind, local_id: "l" })), false, kind + " must be excluded");
  }
  assert.ok(/responsibility%/.test(body), "the SQL must still exclude responsibility%");
  assert.equal(TaskModel.isTaskRow(row("x", null, { kind: "responsibility_item", local_id: "l" })), false);
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
  const ctx = ctxWith([SRC.scheduleRowOnDay, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], { window: { blockStore: store } });
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
  const ctx = ctxWith([SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], { window: { blockStore: store } });
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

test("both primitives REFUSE before writing when the row cannot be resolved", () => {
  // updateBlock REPLACES properties wholesale (db.js: newProps = parsed), so writing
  // without the row destroys title/local_id/subtaskOf/notes behind a success toast.
  // That was a live data-loss bug in C1's toBacklog; the guard is now in one place.
  const { store, calls } = makeStore([], { cached: false });
  const ctx = ctxWith([SRC.scheduleRowOnDay, SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], {
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
  const ctx = ctxWith([SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], { window: { blockStore: store } });
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
  const ctx = ctxWith([SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], {
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

test("opts.block skips resolution, so a caller with the right cache does not pay an HTTP GET", () => {
  // A backlog row is in _globalCache, today's rows in _dayCache, a past-day carryover
  // ONLY in _rangeCache — and blockStore.get() reads neither of the last. toBacklog
  // resolves through _originBlock (the _rangeCache path, plus C1's one-day refill) and
  // hands the row over. Letting the primitive resolve instead would swap a cache read for
  // a round trip on every carryover action. No `fetch` in this context proves it.
  const r = row("carry-1", "2026-07-28", { local_id: "c-1", title: "Do laundry" });
  const { store, calls } = makeStore([r], { cached: false });
  const ctx = ctxWith([SRC.unscheduleRow, SRC.writeRowDate, SRC.rowForDateWrite, SRC.syncBacklog, SRC.hydrateBacklog], { window: { blockStore: store } });
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
  return new Promise((r2) => setImmediate(r2)).then(() => {
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
  assert.equal(/"bl-"\+Date\.now\(\)/.test(stateSource), false,
    "state.js _moveTaskToBacklogStage must re-date the row, not mint a bl- copy");
  assert.equal(/"bl-"\+Date\.now\(\)/.test(triageSource), false,
    "triage.js must not mint a bl- copy either — it did not even remove the original");
  assert.ok(/moveTaskToBacklog\(/.test(triageSource),
    "triage's Backlog button must route through the one mover");
  assert.ok(/unscheduleRow\(/.test(stateSource), "and _moveTaskToBacklogStage must use the primitive");
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
  assert.ok(/isMeeting\(ev\)/.test(gate), "meetings still skip it: their children are prep artifacts");

  // The details-modal click listener must be attached unconditionally.
  const clickAt = tabSource.indexOf('el.addEventListener("click",e=>{');
  assert.ok(clickAt > 0);
  const beforeClick = tabSource.slice(Math.max(0, clickAt - 60), clickAt);
  assert.equal(/if\(!isUnfRow\)\s*$/.test(beforeClick), false,
    "the row's open-space click must not be behind if(!isUnfRow) any more");

  // The bounty is still deliberately off, and that is a product decision, not a gap.
  assert.ok(/!isUnfRow&&_canPlaceBounty\(ev,isDoneRow\)/.test(tabSource),
    "the bounty stays off carryover rows until its points semantics are chosen");
});

test("addSubtask on a carryover creates on the ORIGIN day and stays out of today's plan", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addSubtask\(taskId, text\)\{[\s\S]*?\n\}/m, "addSubtask");
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
    _recollectCarryover: (d) => { ctx.recollectedDate = d; },
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
});

test("addSubtask on an ordinary row is unchanged: viewed day, and it joins the plan", () => {
  const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
  const src = mustSlice(tabsSource, /^function addSubtask\(taskId, text\)\{[\s\S]*?\n\}/m, "addSubtask");
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
