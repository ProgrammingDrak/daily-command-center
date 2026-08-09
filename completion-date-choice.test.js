// Contract tests for the "when was this completed?" choice — the modal you get by
// checking off a task while viewing a PAST day (state.js openCompletionDateConfirm,
// fired from schedule.js toggleDone).
//
// These exist because C3 deletes the clone fallback inside rescheduleTaskToDate, and
// this modal's `Today` button routes straight through it:
//   Today  -> toggleDone(id,{markOnDate:today,bringToToday:true})
//          -> rescheduleTaskToDate(id,today) -> commitDoneOnDate(id,today)
//   On <d> -> toggleDone(id,{markOnDate:sourceDate})  (credits the origin day, moves nothing)
// It had NO direct test before C3 — recurrence-lifecycle.test.js was the only file
// mentioning any of these symbols — so the behavior Drake explicitly asked to keep
// was resting on nothing. Both buttons are pinned here, including the points contract:
// ONE credit per click, keyed to the date the user chose.
//
// Harness pattern: delete-subtree.test.js / shell-rollup.test.js — raw source sliced
// out of the browser files and run in a node:vm context, since state.js and
// schedule.js both have DOM side effects at load.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// C6a: the sliced code derives its task sets through DCC.TaskModel; install the real
// module INSIDE the context so it resolves this harness's isDone/isDeleted stubs.
const { installTaskModel } = require("./task-model-vm-fixture.js");

const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const SCHEDULE_SRC = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");

function mustMatch(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error("completion-date-choice.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

// The whole confirm region: the three module-level `let`s through closeCompletionDateConfirm.
const CDC_SRC = mustMatch(
  STATE_SRC,
  /let _cdcId=null[\s\S]*?function closeCompletionDateConfirm\(\)\{[\s\S]*?\n\}/,
  "the completion-date-confirm region in public/js/state.js"
);
const TOGGLE_DONE_SRC = mustMatch(SCHEDULE_SRC, /function toggleDone\(id,opts\)\{[\s\S]*?\n\}\n/, "toggleDone");
const COMMIT_DONE_SRC = mustMatch(SCHEDULE_SRC, /async function commitDoneOnDate\(id,dateStr,opts\)\{[\s\S]*?\n\}\n/, "commitDoneOnDate");
// C5b's done-writer region, run for real rather than stubbed: `_doneRowProps` through
// `_clearRowDone`. Stubbing `_persistDone` is what would make this whole file assert
// nothing about where a completion actually lands.
// Extends through `_refreshResponsibilityAfterDone` on purpose: that function IS part of
// the completion write path now (C5b step 7 replaced D1's client cadence POST with it), so
// stubbing it would leave the recurring-task half of a check-off untested.
const ON_PARENT_SRC = mustMatch(SCHEDULE_SRC, /function _onParentCompleted\(id\)\{[\s\S]*?\n\}\n/, "_onParentCompleted");
const PERSIST_DONE_SRC = mustMatch(
  SCHEDULE_SRC,
  /function _doneRowProps\(props,completedAt\)\{[\s\S]*?function _refreshResponsibilityAfterDone\(ev,write\)\{[\s\S]*?\n\}/,
  "the C5b _persistDone region in public/js/schedule.js"
);

// Let the reschedule -> commit promise chain settle. The chain awaits a fetch and a
// PATCH, so one microtask tick is not enough.
const flush = () => new Promise((r) => setTimeout(r, 0));

const PAST = "2026-07-20";
const TODAY = "2026-07-31";

// ── A mini-DOM that is only as big as openCompletionDateConfirm needs, and that can
// still FAIL: ids are registered from the innerHTML the function itself writes, so a
// button the markup stops emitting becomes a missing-element throw rather than a
// silently skipped listener.
function makeDom() {
  const byId = new Map();
  const el = (id) => {
    const e = {
      id: id || "",
      className: "",
      _text: "",
      classes: new Set(),
      listeners: {},
      classList: {
        add: (c) => e.classes.add(c),
        remove: (c) => e.classes.delete(c),
        contains: (c) => e.classes.has(c),
      },
      addEventListener: (evt, fn) => { (e.listeners[evt] = e.listeners[evt] || []).push(fn); },
      get textContent() { return e._text; },
      set textContent(v) { e._text = v; },
      set innerHTML(html) {
        // Register every id the markup declares, so getElementById can find them.
        for (const m of String(html).matchAll(/id="([^"]+)"/g)) byId.set(m[1], el(m[1]));
        e._html = String(html);
      },
      get innerHTML() { return e._html || ""; },
    };
    return e;
  };
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => el(""),
    body: { appendChild: (node) => { if (node.id) byId.set(node.id, node); } },
  };
  return { document, byId, click: (id) => {
    const node = byId.get(id);
    if (!node) throw new Error("no element #" + id + " -- the modal markup changed");
    const fns = node.listeners.click || [];
    if (!fns.length) throw new Error("#" + id + " has no click listener wired");
    for (const fn of fns) fn({ target: node });
  } };
}

// Context for the MODAL half: toggleDone is a spy, so these tests pin exactly which
// options each button sends.
function makeModalCtx({ scheduled = [{ id: "t1", title: "Ship the thing" }] } = {}) {
  const dom = makeDom();
  const toggles = [];
  const context = {
    console,
    scheduled,
    document: dom.document,
    __tomorrowDate: "2026-08-01",
    _actualTodayStr: () => TODAY,
    toggleDone: (id, opts) => toggles.push({ id, opts, overlayOpen: openState() }),
  };
  vm.createContext(context);
  installTaskModel(context);
  vm.runInContext(
    mustMatch(STATE_SRC, /function _prettyDateLabel\(dateStr\)\{[\s\S]*?\n\}/, "_prettyDateLabel") + "\n" + CDC_SRC,
    context
  );
  const openState = () => {
    const o = dom.byId.get("cdc-overlay");
    return !!(o && o.classes.has("open"));
  };
  return { context, dom, toggles, openState, cdcId: () => vm.runInContext("_cdcId", context) };
}

test("Today button sends markOnDate=today AND bringToToday, once", () => {
  const { context, dom, toggles, openState } = makeModalCtx();
  vm.runInContext(`openCompletionDateConfirm("t1","${PAST}","${TODAY}")`, context);
  assert.equal(openState(), true, "modal opens");
  dom.click("cdc-today");
  assert.equal(toggles.length, 1, "exactly one completion is committed per click");
  assert.deepEqual({ ...toggles[0].opts }, { markOnDate: TODAY, bringToToday: true });
  assert.equal(toggles[0].id, "t1");
  // Closed BEFORE toggleDone runs: the move is async, and an overlay still open over
  // it is how a second click double-commits.
  assert.equal(toggles[0].overlayOpen, false, "overlay is closed before the commit fires");
});

test("source-date button sends markOnDate=sourceDate and does NOT ask to bring it to today", () => {
  const { context, dom, toggles } = makeModalCtx();
  vm.runInContext(`openCompletionDateConfirm("t1","${PAST}","${TODAY}")`, context);
  dom.click("cdc-source");
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].opts.markOnDate, PAST, "credits the day it was scheduled for");
  assert.ok(!toggles[0].opts.bringToToday, "must not move the task -- this button moves nothing");
});

test("both buttons clear the pending id, so a stale second click cannot re-commit", () => {
  for (const btn of ["cdc-today", "cdc-source"]) {
    const { context, dom, toggles, cdcId } = makeModalCtx();
    vm.runInContext(`openCompletionDateConfirm("t1","${PAST}","${TODAY}")`, context);
    dom.click(btn);
    assert.equal(cdcId(), null, btn + " clears _cdcId");
    dom.click(btn); // stale re-click: no id, so nothing must be committed
    assert.equal(toggles.length, 1, btn + " cannot commit twice from one open");
  }
});

test("cancel commits nothing", () => {
  const { context, dom, toggles, openState } = makeModalCtx();
  vm.runInContext(`openCompletionDateConfirm("t1","${PAST}","${TODAY}")`, context);
  dom.click("cdc-cancel");
  assert.equal(toggles.length, 0);
  assert.equal(openState(), false);
});

test("the modal names the task and the date it was scheduled for", () => {
  const { context, dom } = makeModalCtx();
  vm.runInContext(`openCompletionDateConfirm("t1","${PAST}","${TODAY}")`, context);
  assert.match(dom.byId.get("cdc-title").textContent, /Ship the thing/);
  assert.match(dom.byId.get("cdc-msg").textContent, /Jul 20/);
  assert.match(dom.byId.get("cdc-source").textContent, /Jul 20/);
});

// ── Context for the CHAIN half: the real toggleDone + commitDoneOnDate, with the
// mover and the ledger spied on.
// ── ONE view of "which rows exist", for every question the harness is asked ──
//
// C5a's most expensive mock bug was a pool that held three different views of "does this
// row exist" across its closure, exact, UPDATE and DELETE handlers. So here
// `_findTaskBlockForDate`, the `/api/blocks?date=` fetch and every row write read and
// mutate the SAME array. A fixture cannot claim a row exists for one question and not
// another, and a write is observable by the next read the way it is in production.
//
// The default day is the REALISTIC shape: t1 has a row on the day being viewed, and that
// row has a subtask child. A day containing only a day_root (which is what this harness
// used to return) sends every completion down the row-less fallback, so the row write and
// the subtree cascade would both read as covered while never executing.
const dayRows = () => [
  { id: "row-t1", date: PAST, type: "block", properties: { local_id: "t1", title: "Ship the thing", status: "open" } },
  { id: "row-t1-kid", date: PAST, type: "block", properties: { local_id: "t1-kid", title: "A step", subtaskOf: "t1", status: "open" } },
];

function makeChainCtx({ viewing = PAST, scheduled = [{ id: "t1", title: "Ship the thing", type: "task", start: "09:00", end: "09:30", _blockId: "row-t1" }], rescheduleRemovesRow = false, rescheduleResult = undefined, rows = dayRows(), dayRootProps = {} } = {}) {
  const calls = { reschedule: [], commit: [], credit: [], confirm: [], patched: [], toasts: [], rowWrites: [], backlogSync: [] };
  const manualDone = new Set();
  const dayRoot = { id: "root-" + PAST, date: PAST, type: "day_root", properties: dayRootProps };
  // One day_root PER DATE, registered on demand. The cross-day fallback writes the TARGET
  // day's root (its id comes back from the /api/blocks?date= response), so a registry keyed
  // only on the viewed day's root would silently resolve nothing and the write would vanish.
  const roots = { [dayRoot.id]: dayRoot };
  const rootFor = (date) => {
    const id = "root-" + date;
    if (!roots[id]) roots[id] = { id, date, type: "day_root", properties: {} };
    return roots[id];
  };
  const findRow = (blockId) => roots[blockId] || rows.find((r) => r.id === blockId) || null;
  const context = {
    console,
    scheduled,
    manualDone,
    doneAt: {},
    viewDate: viewing,
    __state: { date: viewing },
    log: () => {},
    render: () => {},
    isDone: (ev) => manualDone.has(ev && ev.id),
    childrenOf: () => [],
    relOf: () => null,
    parentIdOf: () => null,
    _viewedDateStr: () => viewing,
    // Recorded, not stubbed away: the Backlog projection is in-memory and only ever REMOVED
    // here, so a completion that promotes a dateless row and skips this leaves the finished
    // task in the drawer and both badge counts.
    _syncBacklogProjection: (evId, d) => calls.backlogSync.push([evId, d]),
    // The real predicate, derived from `rows`: match on local_id, row id or ev._blockId,
    // scoped to the requested date exactly as state.js does. Returning a constant here
    // would let a broken resolver pass.
    _findTaskBlockForDate: (id, dateStr, ev) => {
      const matches = rows.filter((b) => {
        const ids = [b.properties && b.properties.local_id, b.id];
        if (ev && ev._blockId) ids.push(ev._blockId);
        // The trailing `b.id === ev._blockId` clause is part of the real predicate; a fake
        // without it is narrower than production and fails a working un-check.
        return ids.filter(Boolean).map(String).includes(String(id)) ||
          !!(ev && ev._blockId && String(b.id) === String(ev._blockId));
      });
      if (!dateStr) return matches[0] || null;
      return matches.find((b) => b.date === dateStr) || matches.find((b) => !b.date) || null;
    },
    // Applies the merge to the SAME row objects the reads above see, and honors a null
    // merge as "skip the write" the way state.js does.
    enqueueRowPropsWrite: (blockId, merge, extra) => {
      const row = findRow(blockId);
      if (!row || !row.properties) return null;
      const next = merge(row.properties, row);
      if (!next) return null;
      row.properties = next;
      extra = typeof extra === "function" ? extra(row, next) : extra;
      // `extra` is the top-level COLUMN write (today just {date}), which is how a completion
      // promotes a dateless Unscheduled row onto its day -- and how un-checking gives the date
      // back. Gated on `!== undefined`, exactly as `db.updateBlock` does
      // (`const newDate = date !== undefined ? date : existing.date`): a truthiness check here
      // silently ignores `{date: null}`, which is a fake gentler than production and would
      // report a working un-promote as broken.
      if (extra && extra.date !== undefined) row.date = extra.date;
      calls.rowWrites.push({ blockId, properties: { ...next }, extra: extra || null });
      return Promise.resolve(row);
    },
    _onParentCompleted: () => {},
    _beginCompletionCelebration: () => null,
    _finishCompletionCelebration: () => {},
    _autoCompleteShellAncestors: () => {},
    // Realistic: the override is computed from the live row (its pie share / rollup
     // bonus), so it resolves BEFORE a move and is undefined after one. A stub that
     // returned a constant would make the award handoff untestable.
    _pointAwardOverride: (id) => (scheduled.find((e) => e.id === id) ? 42 : undefined),
    _prettyDateLabel: (d) => d,
    _actualTodayStr: () => TODAY,
    showToast: (msg, kind) => calls.toasts.push({ msg, kind }),
    openCompletionDateConfirm: (id, src, today) => calls.confirm.push({ id, src, today }),
    awardSlotTaskCredit: (ev, opts) => calls.credit.push({ ev: { ...ev }, opts: { ...opts } }),
    localStorage: { getItem: () => null, setItem: () => {} },
    // The cross-date commit reads the target day's blocks, off the same `rows` store, so
    // the day it sees is the day the row resolver sees. A day_root is always present (the
    // server creates one per day) and is what the row-less fallback PATCHes.
    fetch: async (url, init) => {
      if (init && init.method === "PATCH") { calls.patched.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; }
      const m = /[?&]date=([^&]+)/.exec(String(url));
      const date = m ? decodeURIComponent(m[1]) : null;
      const onDay = rows.filter((r) => r.date === date);
      return { ok: true, json: async () => [rootFor(date)].concat(onDay) };
    },
    window: { USE_BLOCKSTORE: { done: true }, TaskTypes: null, blockStore: { getDayRootId: () => dayRoot.id, get: findRow } },
    rescheduleTaskToDate: async (id, date, opts) => {
      calls.reschedule.push({ id, date, opts: { ...opts } });
      // What the TRUE move does, both halves. It RE-DATES the row and its subtree
      // server-side (C3: one transaction, ids preserved) — without that the harness would
      // hand every Today-choice completion a target day containing no row, sending it down
      // the archive fallback and leaving the row write path unexercised.
      if (rescheduleResult !== false) {
        const moving = new Set([String(id)]);
        rows.forEach((r) => {
          const p = r.properties || {};
          if (moving.has(String(p.local_id)) || moving.has(String(r.id))) { r.date = date; if (p.local_id) moving.add(String(p.local_id)); }
        });
        rows.forEach((r) => { const p = r.properties || {}; if (moving.has(String(p.subtaskOf)) || moving.has(String(p.wrapId))) r.date = date; });
      }
      // ...and _removeSubtreeFromScheduled drops the row out of `scheduled` before the
      // completion is committed.
      if (rescheduleRemovesRow) {
        const i = scheduled.findIndex((e) => e.id === id);
        if (i >= 0) scheduled.splice(i, 1);
      }
      // FALSE is the server permanently refusing; undefined is a transient failure the WAL
      // will replay. The two must be treated differently by the caller, so the harness has to
      // be able to express both.
      return rescheduleResult === undefined ? { id } : rescheduleResult;
    },
  };
  context.USE_BLOCKSTORE = context.window.USE_BLOCKSTORE;
  vm.createContext(context);
  installTaskModel(context);
  vm.runInContext(TOGGLE_DONE_SRC + "\n" + COMMIT_DONE_SRC + "\n" + PERSIST_DONE_SRC, context);
  context.__rows = rows;
  context.__dayRoot = dayRoot;
  // Wrap commitDoneOnDate so the chain's ordering is observable without stubbing it
  // out. Forward EVERY argument: a wrapper that drops the third one silently disables
  // the ev/award handoff it is here to observe, and the test then "fails" against a
  // fix that is actually present.
  vm.runInContext(
    "const __realCommit=commitDoneOnDate; commitDoneOnDate=async function(...a){__commitSpy(a[0],a[1],a[2]);return __realCommit(...a)};",
    Object.assign(context, { __commitSpy: (id, d, o) => calls.commit.push({ id, d, opts: o }) })
  );
  return { context, calls, manualDone, rows, dayRoot, rootFor };
}

test("toggleDone(bringToToday) moves the task FIRST, then commits the completion on today", async () => {
  const { context, calls } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush();
  assert.deepEqual(calls.reschedule.map((c) => [c.id, c.date, c.opts.silent]), [["t1", TODAY, true]],
    "one silent move to today (silent: the completion toast is the user-facing one)");
  assert.deepEqual(calls.commit.map((c) => [c.id, c.d]), [["t1", TODAY]], "committed exactly once");
});

test("toggleDone(markOnDate only) commits on the source date and never calls the mover", async () => {
  const { context, calls } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${PAST}"})`, context);
  await flush();
  assert.equal(calls.reschedule.length, 0, "the source-date button must not move the task");
  assert.deepEqual(calls.commit.map((c) => [c.id, c.d]), [["t1", PAST]]);
});

test("checking off a past-day task opens the choice instead of silently completing it", () => {
  const { context, calls } = makeChainCtx();
  vm.runInContext('toggleDone("t1")', context);
  assert.deepEqual(calls.confirm, [{ id: "t1", src: PAST, today: TODAY }]);
  assert.equal(calls.credit.length, 0, "nothing is credited until the user picks a date");
});

test("source-date choice credits the ORIGIN day exactly once", async () => {
  const { context, calls } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${PAST}"})`, context);
  await flush();
  assert.equal(calls.credit.length, 1, "one ledger credit per completion");
  assert.equal(calls.credit[0].opts.sourceDate, PAST, "keyed to the origin day, not today");
  assert.equal(calls.patched.length, 0, "same-day fast path: no cross-date day_root patch");
});

// ★ ADDED IN C5b AFTER A MUTATION CHECK CAUGHT THE GAP. Disabling the row write inside
// `_persistDone` left this entire file green — so the same-day completion, which is the
// path Drake clicks most, was asserted nowhere. Both same-day entrances are pinned: the
// `commitDoneOnDate` fast path (below) and plain `toggleDone` on the day being viewed.
test("the same-day fast path marks the ROW done (not just the in-memory registry)", async () => {
  const { context, rows, calls, manualDone } = makeChainCtx();
  vm.runInContext(`commitDoneOnDate("t1","${PAST}")`, context);
  await flush();
  const t1 = rows.find((r) => r.id === "row-t1");
  assert.equal(t1.properties.status, "done", "the row carries it, so it survives a reload");
  assert.ok(t1.properties.completedAt);
  assert.ok(manualDone.has("t1"), "and the in-memory projection agrees");
  assert.equal(calls.patched.length, 0, "no overlay write");
});

// ★ THE SAME-DAY PATH CASCADES TOO, and this test previously encoded the gap rather than
// catching it: the default fixture already contains `row-t1-kid` (`subtaskOf: "t1"`) and the
// assertion above only ever looked at the parent. Every cascade assertion in this file used the
// CROSS-day branch, so the branch the primary button takes was covered by nothing.
//
// `openCompletionDateConfirm(id, currentDate, today)` hands `#cdc-source`
// `_cdcSourceDate === currentDate`, so "done on its original date" always reaches
// `commitDoneOnDate(id, currentDate)` with `currentDate === dateStr` — the fast path. Without a
// cascade the steps stayed `status:"open"` and `getCarryoverPool` re-offered them every morning.
test("the same-day fast path cascades to the subtree (the 'done on its original date' button)", async () => {
  const { context, rows } = makeChainCtx({
    scheduled: [
      { id: "t1", title: "Ship the thing", type: "task", start: "09:00", end: "09:30", _blockId: "row-t1" },
      { id: "t1-kid", title: "A step", type: "task", subtaskOf: "t1", start: "09:00", end: "09:15", _blockId: "row-t1-kid" },
    ],
  });
  // The real cascade, not the no-op stub.
  vm.runInContext("recalcTimes=()=>{};_clearPin=()=>{};_persistEvWrap=()=>{};\n" + ON_PARENT_SRC, context);
  vm.runInContext(`commitDoneOnDate("t1","${PAST}")`, context);
  await flush();
  assert.equal(rows.find((r) => r.id === "row-t1").properties.status, "done");
  assert.equal(rows.find((r) => r.id === "row-t1-kid").properties.status, "done",
    "an open step means the carryover lane re-offers it tomorrow, forever");
});

// ...and the carryover lane, which walks the subtree ITSELF, must not get a second walk.
test("cascade:false suppresses it, so the carryover lane's own loop is not doubled", async () => {
  // The child MUST be in `scheduled`, or this test is vacuous: `_onParentCompleted` walks
  // `scheduled.filter(c=>c.subtaskOf===pid)`, so with the default one-ev fixture there is
  // nothing to cascade and the assertion passes whether the flag is honored or not. Caught by a
  // mutation check that removed the `cascade!==false` guard and stayed green.
  const { context, rows } = makeChainCtx({
    scheduled: [
      { id: "t1", title: "Ship the thing", type: "task", start: "09:00", end: "09:30", _blockId: "row-t1" },
      { id: "t1-kid", title: "A step", type: "task", subtaskOf: "t1", start: "09:00", end: "09:15", _blockId: "row-t1-kid" },
    ],
  });
  vm.runInContext("recalcTimes=()=>{};_clearPin=()=>{};_persistEvWrap=()=>{};\n" + ON_PARENT_SRC, context);
  vm.runInContext(`commitDoneOnDate("t1","${PAST}",{cascade:false})`, context);
  await flush();
  assert.equal(rows.find((r) => r.id === "row-t1").properties.status, "done", "the named node still completes");
  assert.equal(rows.find((r) => r.id === "row-t1-kid").properties.status, "open",
    "the caller owns the walk; a second one multiplies the queued writes");
});

test("cross-day cascade:false refuses a completion whose row write did not persist", async () => {
  const { context, calls } = makeChainCtx({ viewing: TODAY });
  context.enqueueRowPropsWrite = () => Promise.resolve(null);
  await assert.rejects(
    vm.runInContext(`commitDoneOnDate("t1","${PAST}",{cascade:false})`, context),
    /Completion did not persist/
  );
  assert.equal(calls.credit.length, 0, "a refused write must not bank completion credit");
});

test("cross-day cascade:false refuses a missing origin row instead of claiming success", async () => {
  const { context, calls } = makeChainCtx({ viewing: TODAY, rows: [] });
  await assert.rejects(
    vm.runInContext(`commitDoneOnDate("missing","${PAST}",{cascade:false})`, context),
    /Completion target unavailable/
  );
  assert.equal(calls.credit.length, 0);
  assert.equal(calls.rowWrites.length, 0);
});

test("plain toggleDone on the day being viewed marks the ROW done, and un-checking clears it", async () => {
  const todayRows = [{ id: "row-t1", date: TODAY, type: "block", properties: { local_id: "t1", title: "Ship the thing", status: "open" } }];
  const { context, rows } = makeChainCtx({ viewing: TODAY, rows: todayRows });
  vm.runInContext('toggleDone("t1")', context);
  await flush();
  assert.equal(rows[0].properties.status, "done");
  vm.runInContext('toggleDone("t1")', context);
  await flush();
  assert.equal(rows[0].properties.status, "open", "un-checking re-opens the row");
  assert.equal(rows[0].properties.completedAt, undefined, "and drops the completion stamp");
});

// C0 left `completedBy` behind on an un-check deliberately and flagged clearing it to this
// phase: no done predicate reads it, but an OPEN row stamped `completedBy:"slack-events"`
// is a lie to whoever greps for it next.
test("un-checking clears completedBy, the provenance stamp C0 left behind", async () => {
  const slackRows = [{ id: "row-t1", date: TODAY, type: "block", properties: { local_id: "t1", title: "Ship the thing", status: "done", done: true, completedAt: "2026-07-31T12:00:00Z", completedBy: "slack-events" } }];
  const { context, rows } = makeChainCtx({ viewing: TODAY, rows: slackRows });
  vm.runInContext('manualDone.add("t1"); toggleDone("t1")', context);
  await flush();
  assert.equal(rows[0].properties.status, "open");
  assert.equal(rows[0].properties.completedBy, undefined, "provenance for a completion that no longer exists");
});

// The `_done` overlay is read-only legacy data now (sync.js), and a read-only source you
// cannot clear is a completion that cannot be un-done: the next load re-hydrates it and the
// row snaps straight back to done. That is the C0 wart, inverted.
test("un-checking also removes a LEGACY _done entry for that id", async () => {
  const todayRows = [{ id: "row-t1", date: TODAY, type: "block", properties: { local_id: "t1", title: "Ship the thing", status: "done", done: true } }];
  const { context, dayRoot } = makeChainCtx({ viewing: TODAY, rows: todayRows, dayRootProps: { _done: { ids: ["t1", "other"], at: { t1: "x", other: "y" } } } });
  vm.runInContext('manualDone.add("t1"); toggleDone("t1")', context);
  await flush();
  assert.deepEqual(dayRoot.properties._done.ids, ["other"], "only this id is removed");
  assert.deepEqual(Object.keys(dayRoot.properties._done.at), ["other"]);
});

// ...and the inverse, because a PATCH per un-check on every ordinary task is pure write
// amplification on the day_root. The queue honors a null merge for exactly this.
test("un-checking an id that is NOT in _done writes nothing to the day_root", async () => {
  const todayRows = [{ id: "row-t1", date: TODAY, type: "block", properties: { local_id: "t1", status: "done", done: true } }];
  const { context, calls } = makeChainCtx({ viewing: TODAY, rows: todayRows, dayRootProps: { _done: { ids: ["someone-else"], at: {} } } });
  vm.runInContext('manualDone.add("t1"); toggleDone("t1")', context);
  await flush();
  assert.deepEqual(calls.rowWrites.map((w) => w.blockId), ["row-t1"], "the row, and only the row");
});

// REWRITTEN IN C5b: this used to assert "writes today's day_root overlay". A cross-day
// completion now writes the ROW, which is the whole point of the phase — the overlay is a
// fact about an id on a day, so it could never travel with a task that changed days.
test("Today choice credits TODAY exactly once, and marks the ROW done, not the overlay", async () => {
  const { context, calls, rows } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush();
  await flush();
  assert.equal(calls.credit.length, 1, "ONE credit -- a second would double-award the same task");
  assert.equal(calls.credit[0].opts.sourceDate, TODAY, "keyed to today, matching where the task now lives");
  const t1 = rows.find((r) => r.id === "row-t1");
  assert.equal(t1.properties.status, "done", "the row carries the completion");
  assert.ok(t1.properties.completedAt, "and when it happened");
  assert.equal(calls.patched.length, 0, "the day_root _done overlay is NOT written any more");
});

// The bug this phase was asked to fix, stated as its own test: `_done` held a SINGLE id
// with no subtree walk, so completing an unfinished parent left every child open and the
// carryover collector re-offered them the next morning, forever.
test("a cross-day completion cascades to the subtree", async () => {
  const { context, rows } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush();
  await flush();
  assert.equal(rows.find((r) => r.id === "row-t1").properties.status, "done");
  assert.equal(rows.find((r) => r.id === "row-t1-kid").properties.status, "done",
    "the child moved with its parent and completes with it");
});

// The residual shape, kept honest rather than silently dropped: an ev projected from
// `schedule.timeline` on an archive day has no row to carry the fact. Measured on prod
// 2026-08-04: 11 such entries, none newer than 2026-05-27.
test("with NO row on the target date, the completion falls back to that day's _done", async () => {
  const { context, calls, rootFor } = makeChainCtx({ rows: [] });
  vm.runInContext(`commitDoneOnDate("tl-legacy","${TODAY}")`, context);
  await flush();
  await flush();
  // Through the shared QUEUE, and onto the TARGET day's root -- not a hand-rolled PATCH. The
  // first cut duplicated `_patchOverlayDone` here with a raw fetch, which was unqueued (so it
  // could lose a concurrent day_root write) and carried no `_clientId`, so the SSE self-echo
  // was not suppressed for the tab that made it.
  assert.equal(calls.patched.length, 0, "no raw PATCH bypassing the queue");
  const write = calls.rowWrites.find((w) => w.blockId === "root-" + TODAY);
  assert.ok(write, "the completion is persisted, not dropped: " + JSON.stringify(calls.rowWrites.map((w) => w.blockId)));
  // Compared through JSON: `_done.ids` is built inside the vm realm, so deepStrictEqual
  // rejects it on the prototype alone.
  assert.equal(JSON.stringify(write.properties._done.ids), JSON.stringify(["tl-legacy"]));
  assert.equal(JSON.stringify(rootFor(TODAY).properties._done.ids), JSON.stringify(["tl-legacy"]),
    "and it lands on the TARGET day's root");
});

// ★ The regression review caught: `_findTaskBlockForDate` falls back to an UNDATED row, and a
// dateless row is exactly what the Unscheduled section and the Backlog are made of. Marking one
// done without stamping a date makes the task vanish from every surface on the next load --
// `isFoldableTask` rejects `(status==="done"||done===true)&&!b.date`, and
// `TaskModel.selectUnscheduled` rejects `status==="done"` -- so it is neither folded nor in the
// backlog. Same "a completion makes the task disappear" failure C0 shipped to fix.
test("completing a DATELESS (Unscheduled/backlog) row stamps the day it was finished on", async () => {
  const rows = [{ id: "row-u1", date: null, type: "block", properties: { local_id: "u1", title: "Someday thing", kind: "backlog", status: "open" } }];
  const { context } = makeChainCtx({
    viewing: TODAY, rows,
    scheduled: [{ id: "u1", title: "Someday thing", type: "task", start: "00:00", end: "00:30", untimed: true, _blockId: "row-u1" }],
  });
  vm.runInContext('toggleDone("u1")', context);
  await flush();
  assert.equal(rows[0].properties.status, "done");
  assert.equal(rows[0].date, TODAY, "without the date the finished task is dropped by BOTH readers");
  assert.equal(rows[0].properties.kind, undefined, "and it is not backlog material once it has a day");
});

test("Today choice credits the REAL task even though the move already removed its row", async () => {
  // The true move calls _removeSubtreeFromScheduled BEFORE commitDoneOnDate runs, so
  // `scheduled.find` misses and the credit would fall back to a synthetic
  // {title:"Task completed", type:"task"} stub -- scoring a 30-minute task as a
  // bare default and logging the wrong title. C3 makes this path universal (every
  // cross-date move is a true move now), so the real ev has to survive the handoff.
  const { context, calls } = makeChainCtx({ rescheduleRemovesRow: true });
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush();
  await flush();
  assert.equal(calls.credit.length, 1);
  assert.equal(calls.credit[0].ev.title, "Ship the thing", "credits the real task, not a synthetic stub");
  assert.equal(calls.credit[0].ev.end, "09:30", "carries its duration, so scoring is the task's own");
  // Same handoff, other half: the pie/rollup award is only computable while the row is
  // live, so it is captured before the move and forwarded, not recomputed after.
  assert.equal(calls.credit[0].opts.awardPoints, 42, "carries the award computed before the move");
});

test("a PERMANENTLY refused move does NOT bank the completion", async () => {
  // The consuming half of the FALSE sentinel, and the half that actually protects the ledger.
  // push-is-a-move.test.js pins that the mover RESOLVES false; this pins that toggleDone acts
  // on it. Without the guard, a 400 ("Block is deleted", "Block not found") still patched the
  // target day's _done overlay, wrote pa-done-<date> and banked points — for a task sitting
  // unchecked on the day the user was looking at.
  const { context, calls, rows } = makeChainCtx({ rescheduleResult: false });
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush(); await flush();
  assert.equal(calls.commit.length, 0, "no commit: the task never reached that date");
  assert.equal(calls.credit.length, 0, "and no points banked on a day it is not on");
  assert.equal(calls.patched.length, 0, "that day's _done overlay is untouched");
  // C5b: the row is the completion now, so "did not bank it" has to be asserted THERE too.
  // Checking only `patched` would have gone vacuous the moment the write moved to the row.
  assert.equal(calls.rowWrites.length, 0, "and no row was marked done");
  assert.equal(rows.find((r) => r.id === "row-t1").properties.status, "open");
});

// ★ ADDED AFTER REVIEW FOUND THE GAP. `_onParentCompleted` and `_autoCompleteShellAncestors`
// are stubbed to no-ops in `makeChainCtx`, and this is the only file that runs `toggleDone` at
// all — so both `_persistDone` calls C5b added inside them were covered by nothing. Deleting
// either one left the whole suite green, and the consequence is in the diff's own comment: a
// child left unpersisted comes back unfinished on the next load and lands back on today via
// collectUnfinished. The cross-day cascade test above does NOT cover this: that exercises
// commitDoneOnDate's BFS over `/api/blocks?date=` rows, a different mechanism from the
// in-memory `scheduled` walk here.
test("the subtask cascade persists EACH child's row, not just the parent's", async () => {
  const rows = [
    { id: "row-t1", date: TODAY, type: "block", properties: { local_id: "t1", title: "P", status: "open" } },
    { id: "row-kid", date: TODAY, type: "block", properties: { local_id: "kid", title: "S", subtaskOf: "t1", status: "open" } },
  ];
  const { context } = makeChainCtx({
    viewing: TODAY, rows,
    scheduled: [
      { id: "t1", title: "P", type: "task", start: "09:00", end: "09:30", _blockId: "row-t1" },
      { id: "kid", title: "S", type: "task", subtaskOf: "t1", start: "09:00", end: "09:15", _blockId: "row-kid" },
    ],
  });
  // Swap the no-op stub for the REAL cascade.
  vm.runInContext("recalcTimes=()=>{};_clearPin=()=>{};_persistEvWrap=()=>{};\n" + ON_PARENT_SRC, context);
  vm.runInContext('toggleDone("t1")', context);
  await flush();
  assert.equal(rows[0].properties.status, "done", "the parent");
  assert.equal(rows[1].properties.status, "done",
    "and the child -- unpersisted, it comes back unfinished and lands back on today");
});

// ★ THE WALK'S POOL IS TASK ROWS ONLY. Round 1 widened the cascade to read `parent_id` citing
// lib/reschedule.js's canonical walk — but that walk is fed a FILTERED pool
// (`type='block' AND (local_id IS NOT NULL OR kind='task')`), and db.js records that the filter
// is the only thing stopping a subtree walk from reaching a meeting's artifacts. Unfiltered, a
// meeting row (which HAS a check-off in the List view) cascaded `status:"done"` onto its
// meeting_prep / meeting_summary / meeting_transcript / proposed_action_item children — and
// approveActions skips proposals whose status is "approved" or "placed", so overwriting
// "placed" with "done" makes a PLACED proposal re-approvable, minting a duplicate task and
// wiping its placedDate.
test("a cross-day completion never touches non-task children (a meeting's artifacts)", async () => {
  const rows = [
    // A meeting: no local_id, keyed by row id, completable as the TARGET.
    { id: "row-mtg", date: PAST, type: "block", properties: { title: "Standup", kind: "meeting", type: "meeting", status: "open" } },
    // Its artifacts, all parent_id children on the same date. None is a task row.
    { id: "row-prep", date: PAST, type: "block", parent_id: "row-mtg", properties: { title: "Prep", kind: "meeting_prep", status: "ready" } },
    { id: "row-sum", date: PAST, type: "block", parent_id: "row-mtg", properties: { title: "Summary", kind: "meeting_summary", status: "ready" } },
    { id: "row-prop", date: PAST, type: "block", parent_id: "row-mtg", properties: { title: "Follow up", kind: "proposed_action_item", status: "placed" } },
    // A REAL subtask of the meeting still has to cascade.
    { id: "row-kid", date: PAST, type: "block", parent_id: "row-mtg", properties: { local_id: "mtg-kid", title: "Send notes", status: "open" } },
  ];
  const { context } = makeChainCtx({
    viewing: TODAY, rows,
    scheduled: [{ id: "row-mtg", title: "Standup", type: "meeting", start: "09:00", end: "09:15", _blockId: "row-mtg" }],
  });
  vm.runInContext(`commitDoneOnDate("row-mtg","${PAST}")`, context);
  await flush();
  await flush();
  assert.equal(rows[0].properties.status, "done", "the meeting itself completes");
  assert.equal(rows[4].properties.status, "done", "and its real subtask cascades");
  assert.equal(rows[1].properties.status, "ready", "meeting_prep is untouched");
  assert.equal(rows[2].properties.status, "ready", "meeting_summary is untouched");
  assert.equal(rows[3].properties.status, "placed",
    "a PLACED proposal must stay placed -- 'done' would put it back in the approvable set");
});

// The date stamp has to be REVERSIBLE, or a mis-click permanently evicts a task from the
// Backlog: it had folded onto whatever day you were viewing and shown in the drawer, and
// afterwards it is pinned to one date and gone from the drawer with no visible action taken.
test("un-checking a promoted dateless row puts it back in the Backlog", async () => {
  const rows = [{ id: "row-u1", date: null, type: "block", properties: { local_id: "u1", title: "Someday", kind: "backlog", status: "open" } }];
  const { context, calls } = makeChainCtx({
    viewing: TODAY, rows,
    scheduled: [{ id: "u1", title: "Someday", type: "task", start: "00:00", end: "00:30", untimed: true, _blockId: "row-u1" }],
  });
  vm.runInContext('toggleDone("u1")', context);
  await flush();
  assert.equal(rows[0].date, TODAY, "promoted onto the day it was finished");
  assert.equal(rows[0].properties._doneStampedDate, TODAY, "and marked as a completion-stamped date");
  assert.deepEqual(calls.backlogSync[calls.backlogSync.length - 1], ["u1", TODAY], "and removed from the Backlog projection");
  vm.runInContext('toggleDone("u1")', context);
  await flush();
  assert.equal(rows[0].date, null, "un-checking gives the date back");
  assert.equal(rows[0].properties.kind, "backlog", "and restores it as backlog material");
  assert.equal(rows[0].properties._doneStampedDate, undefined, "with the marker cleared");
  assert.deepEqual(calls.backlogSync[calls.backlogSync.length - 1], ["u1", null], "and re-hydrated into the projection");
});

// ...and a date the USER chose is not a completion stamp, so it must survive an un-check.
test("un-checking a genuinely DATED task does not strip its date", async () => {
  const rows = [{ id: "row-d1", date: TODAY, type: "block", properties: { local_id: "d1", title: "Real task", status: "done", done: true } }];
  const { context, calls } = makeChainCtx({
    viewing: TODAY, rows,
    scheduled: [{ id: "d1", title: "Real task", type: "task", start: "09:00", end: "09:30", _blockId: "row-d1" }],
  });
  vm.runInContext('manualDone.add("d1"); toggleDone("d1")', context);
  await flush();
  assert.equal(rows[0].date, TODAY, "no _doneStampedDate marker, so the date is the user's");
  assert.deepEqual(calls.backlogSync, [], "and the Backlog projection is not involved at all");
});

test("a refused move SAYS so, instead of closing the dialog in silence", async () => {
  // The mover runs with {silent:true} so the completion toast can be the only one, which
  // suppresses the mover's own error toast. Skipping the commit silently would leave the user
  // with a closed dialog, an unchecked task, and no explanation.
  const { context, calls } = makeChainCtx({ rescheduleResult: false });
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush(); await flush();
  const err = calls.toasts.find((t) => t.kind === "error");
  assert.ok(err, "the user has to be told: " + JSON.stringify(calls.toasts));
  assert.match(err.msg, /not marked done/i);
});

test("a TRANSIENT failure still commits, because the WAL will land the move", async () => {
  // The asymmetry is the whole point of the sentinel: undefined means "queued, it will
  // happen", so the completion is correct and must not be dropped with it.
  const { context, calls } = makeChainCtx({ rescheduleResult: undefined });
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush(); await flush();
  assert.equal(calls.commit.length, 1, "a queued move still completes the task");
  assert.equal(calls.credit.length, 1);
});
