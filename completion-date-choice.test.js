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
function makeChainCtx({ viewing = PAST, scheduled = [{ id: "t1", title: "Ship the thing", type: "task", start: "09:00", end: "09:30" }], rescheduleRemovesRow = false } = {}) {
  const calls = { reschedule: [], commit: [], credit: [], confirm: [], patched: [] };
  const manualDone = new Set();
  const context = {
    console,
    scheduled,
    manualDone,
    doneAt: {},
    viewDate: viewing,
    __state: { date: viewing },
    log: () => {},
    render: () => {},
    saveDoneState: () => {},
    isDone: (ev) => manualDone.has(ev && ev.id),
    childrenOf: () => [],
    relOf: () => null,
    parentIdOf: () => null,
    _clearRowDone: () => {},
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
    showToast: () => {},
    openCompletionDateConfirm: (id, src, today) => calls.confirm.push({ id, src, today }),
    awardSlotTaskCredit: (ev, opts) => calls.credit.push({ ev: { ...ev }, opts: { ...opts } }),
    localStorage: { getItem: () => null, setItem: () => {} },
    // The real cross-date commit reads the target day and patches its day_root._done.
    fetch: async (url, init) => {
      if (init && init.method === "PATCH") { calls.patched.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; }
      return { ok: true, json: async () => [{ id: "root-" + TODAY, type: "day_root", properties: {} }] };
    },
    window: { USE_BLOCKSTORE: { done: true }, TaskTypes: null },
    rescheduleTaskToDate: async (id, date, opts) => {
      calls.reschedule.push({ id, date, opts: { ...opts } });
      // What the TRUE move does: _removeSubtreeFromScheduled drops the row out of
      // `scheduled` before the completion is committed.
      if (rescheduleRemovesRow) {
        const i = scheduled.findIndex((e) => e.id === id);
        if (i >= 0) scheduled.splice(i, 1);
      }
      return { id };
    },
  };
  context.USE_BLOCKSTORE = context.window.USE_BLOCKSTORE;
  vm.createContext(context);
  vm.runInContext(TOGGLE_DONE_SRC + "\n" + COMMIT_DONE_SRC, context);
  // Wrap commitDoneOnDate so the chain's ordering is observable without stubbing it
  // out. Forward EVERY argument: a wrapper that drops the third one silently disables
  // the ev/award handoff it is here to observe, and the test then "fails" against a
  // fix that is actually present.
  vm.runInContext(
    "const __realCommit=commitDoneOnDate; commitDoneOnDate=async function(...a){__commitSpy(a[0],a[1],a[2]);return __realCommit(...a)};",
    Object.assign(context, { __commitSpy: (id, d, o) => calls.commit.push({ id, d, opts: o }) })
  );
  return { context, calls, manualDone };
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

test("Today choice credits TODAY exactly once, and writes today's day_root overlay", async () => {
  const { context, calls } = makeChainCtx();
  vm.runInContext(`toggleDone("t1",{markOnDate:"${TODAY}",bringToToday:true})`, context);
  await flush();
  await flush();
  assert.equal(calls.credit.length, 1, "ONE credit -- a second would double-award the same task");
  assert.equal(calls.credit[0].opts.sourceDate, TODAY, "keyed to today, matching where the task now lives");
  assert.equal(calls.patched.length, 1, "today's _done overlay is written once");
  assert.deepEqual(calls.patched[0].body.properties._done.ids, ["t1"]);
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
