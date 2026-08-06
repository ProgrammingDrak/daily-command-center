// Contract tests for the morning catch-up prompt (public/js/catch-up.js), which
// replaced carryover-review.js in Phase C1.
//
// What these pin:
//   1. the prompt lists only work that is actually OPEN — the collector keeps done
//      CHILDREN in the pool so a parent's "2/5 subtasks" can count them, and
//      offering one as "this slipped" is the bug this file exists to prevent
//   2. roots only: a child follows its parent through every action, so listing both
//      would double-count and let you drop a subtree twice
//   3. a child orphaned by a finished parent is still real work and stays listed
//   4. an all-done pool marks the day reviewed instead of opening an empty prompt
//
// The prompt is driven through the REAL collector (DCC.Carryover over a fake
// blockStore), so what is under test is the actual pool shape catch-up.js sees at
// runtime rather than a hand-made stand-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// C6a: install the REAL TaskModel INSIDE the context. A require()d copy sees node's
// globals, never this harness's stubs -- which is the trap task-model-vm-fixture.js exists
// to close, and these three were still hand-assigning the node-realm module in.
const { installTaskModel } = require("./task-model-vm-fixture.js");

const TaskModel = require("./public/js/task-model.js");
const { apiStub } = require("./carryover-fixture.js");
const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
const catchUpSource = fs.readFileSync(require.resolve("./public/js/catch-up.js"), "utf8");
// The REAL core.js, same discipline as installTaskModel: the row's calendar button is
// built and wired by DCC.dateButtonHtml / DCC.wireDateButton, so stubbing those would
// only test the stub. core.js has no parse-time side effects beyond defining DCC.
const coreSource = fs.readFileSync(require.resolve("./public/js/core.js"), "utf8");

const TODAY = "2026-07-29";
const ymd = (offsetDays) => {
  const d = new Date(TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};
const blk = (id, date, props) => ({
  id, type: "block", date, created_at: date + "T09:00:00.000Z",
  properties: Object.assign({ local_id: id, title: id, type: "task", start: "09:00", end: "09:30", duration: 30 }, props || {})
});
const dayRoot = (props) => ({ id: "root", type: "day_root", properties: props || {} });

// ── the smallest DOM that catch-up.js actually exercises ──
// querySelector hands back a stable stub per selector, so the module's
// `overlay.querySelector("#catchup-list")` is the same node every call and the
// rows it appends are inspectable.
function FakeEl(tag) {
  const el = {
    tag, id: "", className: "", innerHTML: "", textContent: "", disabled: false,
    children: [], style: {}, dataset: {}, _q: new Map(), _on: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    fire(ev, arg) { (el._on[ev] || []).forEach(fn => fn(arg || { target: el })); },
    appendChild(c) { el.children.push(c); return c; },
    // Strict like the real DOM: a non-child reference is a TypeError, not a silent
    // append. The forgiving version hid a bug where forEach's index arrived as the
    // reference node and every browser threw while the tests stayed green.
    insertBefore(c, ref) {
      const i = el.children.indexOf(ref);
      if (i < 0) throw new TypeError("insertBefore: reference is not a child");
      el.children.splice(i, 0, c);
      return c;
    },
    remove() { el._removed = true; },
    querySelector(sel) { if (!el._q.has(sel)) el._q.set(sel, FakeEl("div")); return el._q.get(sel); },
    // Return the stubs this element has actually handed out for button selectors, so
    // busy()'s disable pass is observable instead of writing into the void.
    querySelectorAll(sel) {
      if (sel !== "button") return [];
      return [...el._q.entries()].filter(([k]) => /^\.(cu-|catchup-)/.test(k)).map(([, v]) => v);
    },
    _removed: false
  };
  return el;
}
function fakeDocument() {
  const byId = new Map();
  return {
    readyState: "complete",
    body: { appendChild(el) { if (el.id) byId.set(el.id, el); return el; } },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return FakeEl(tag); },
    addEventListener() {}
  };
}

// Boot the collector + the prompt in one context and return handles.
// `extra` adds context globals — used to stand in for triage.js (activeTriageItems,
// scheduleTriageOnDate, deleteTriageItem) and schedule-popover.js's day picker, the
// three collaborators the prompt reaches through typeof guards.
function load(daysByDate, archiveDates, extra) {
  const store = {
    async loadDateRange() {},
    getRangeCache(date) { return daysByDate[date] ? { blocks: daysByDate[date] } : null; },
    get() { return null; }
  };
  const saved = {};
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: fakeDocument(),
    __todayDate: TODAY,
    __tomorrowDate: "2026-07-30",
    __archiveDates: archiveDates,
    viewMode: "today",
    pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    ms: (m) => (m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"),
    dur: (ev) => ctx.pt(ev.end) - ctx.pt(ev.start),
    escHtml: (s) => String(s == null ? "" : s),
    // day_root-backed reviewed flag (the whole point of not using localStorage)
    _bsProp: (k) => saved[k] || null,
    _bsSaveProp: (k, v) => { saved[k] = v; },
    render() {},
    invalidateUnfinishedSection() {},
    showToast() {}
  };
  Object.assign(ctx, extra || {});
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.URLSearchParams = URLSearchParams;
  vm.createContext(ctx);
  vm.runInContext(coreSource, ctx);
  vm.runInContext(unfSource, ctx);
  ctx.window.blockStore = store;
  installTaskModel(ctx);
  // C2: the collector reads GET /api/tasks/open instead of scanning the range cache.
  // The blockStore stub above stays because _originBlock still resolves through it.
  ctx.window.DCC.api = apiStub(daysByDate);
  vm.runInContext(catchUpSource, ctx);
  return { ctx, saved, CO: ctx.window.DCC.Carryover };
}

// Titles the prompt actually rendered, in order.
function listedTitles(ctx) {
  const overlay = ctx.document.getElementById("catchup-overlay");
  if (!overlay) return null;
  return overlay.querySelector("#catchup-list").children
    .map(r => r.querySelector(".carryover-row-title").textContent);
}

test("a done subtask is NOT offered as work that slipped", async () => {
  const d = ymd(1);
  // Parent finished on its origin day AND its subtask finished with it. The
  // collector drops the done parent (done + top-level) but keeps the done child so
  // progress can count it -- which left the child parentless in the pool. The
  // prompt used to promote it to a root and ask Drake to reschedule a task he had
  // already completed.
  const { ctx } = load({ [d]: [
    dayRoot({ _done: { ids: ["parent", "kid"] } }),
    blk("parent", d, { title: "Do Laundry" }),
    blk("kid", d, { title: "Washer", subtaskOf: "parent" }),
    blk("real", d, { title: "Actually unfinished" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  assert.deepEqual(listedTitles(ctx), ["Actually unfinished"]);
});

test("roots only: a child with an open parent nests and is not listed separately", async () => {
  const d = ymd(2);
  const { ctx } = load({ [d]: [
    dayRoot(),
    blk("parent", d, { title: "Ship C1" }),
    blk("kid", d, { title: "Write the tests", subtaskOf: "parent" }),
    blk("ride", d, { title: "Ride along", wrapId: "parent" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  assert.deepEqual(listedTitles(ctx), ["Ship C1"]);
});

test("a child orphaned by a FINISHED parent is still real work and stays listed", async () => {
  const d = ymd(1);
  // Same shape as the first test, except the child is open. Filtering done rows
  // must not also swallow a live subtask whose parent is gone -- standalone work
  // must never disappear.
  const { ctx } = load({ [d]: [
    dayRoot({ _done: { ids: ["parent"] } }),
    blk("parent", d, { title: "Do Laundry" }),
    blk("kid", d, { title: "Dryer still running", subtaskOf: "parent" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  assert.deepEqual(listedTitles(ctx), ["Dryer still running"]);
});

test("an all-done pool marks the day reviewed instead of opening an empty prompt", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [
    dayRoot({ _done: { ids: ["parent", "kid"] } }),
    blk("parent", d, { title: "Do Laundry" }),
    blk("kid", d, { title: "Washer", subtaskOf: "parent" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  assert.equal(ctx.document.getElementById("catchup-overlay"), null, "no modal should be built");
  assert.ok(saved._catchUpReviewed, "the day must be marked reviewed so it does not re-prompt");
});

test("nothing unfinished at all: reviewed, no prompt", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [dayRoot({ _done: { ids: ["only"] } }), blk("only", d, {})] }, [d]);
  await ctx.window.initCatchUp();
  assert.equal(ctx.document.getElementById("catchup-overlay"), null);
  assert.ok(saved._catchUpReviewed);
});

test("an already-reviewed day never prompts twice", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d]);
  await ctx.window.initCatchUp();
  assert.deepEqual(listedTitles(ctx), ["Slipped"]);
  // Second call on the same day: the flag is set, so it must bail before building.
  const { ctx: ctx2, saved: saved2 } = load({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d]);
  saved2._catchUpReviewed = new Date(0).toISOString();
  await ctx2.window.initCatchUp();
  assert.equal(ctx2.document.getElementById("catchup-overlay"), null);
});

// ─────────────── the action path: something has to CLICK ───────────────
// The four row buttons and "Move all to today" were entirely unexercised: FakeEl
// defined fire() and no test called it. For a module that exists because
// carryover-review.js's buttons only LOOKED real ("Drop was a single log line -- it
// deleted NOTHING"), "no test clicks anything" is the gap that matters most.
const row0 = (ctx) => ctx.document.getElementById("catchup-overlay")
  .querySelector("#catchup-list").children[0];
// setTimeout(0) rather than setImmediate: the click handlers are async, so one macro
// task is enough to let them settle, and it keeps the lint env browser-compatible.
const settled = () => new Promise(r => setTimeout(r, 0));

test("Drop routes the listed ROOT through DCC.Carryover.drop and clears its row", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [
    dayRoot(), blk("p", d, { title: "Slipped" }), blk("k", d, { title: "Kid", subtaskOf: "p" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  let got = null;
  ctx.window.DCC.Carryover.drop = async (ev, pool) => { got = { id: ev.id, pool: pool.length }; return { removed: [ev.id, "k"] }; };

  const r = row0(ctx);
  r.querySelector(".cu-drop").fire("click");
  await settled();
  assert.equal(got.id, "p", "the root, not the child");
  assert.equal(got.pool, 2, "the FULL pool goes through so the subtree travels with it");
  assert.equal(r._removed, true, "the settled row is removed from the list");
});

test("Today and Tomorrow move the root to the right date", async () => {
  const d = ymd(1);
  for (const [sel, expected] of [[".cu-today", TODAY], [".cu-tomorrow", "2026-07-30"]]) {
    const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: "Slipped" })] }, [d]);
    await ctx.window.initCatchUp();
    let target = null;
    ctx.window.DCC.Carryover.moveTo = async (ev, date) => { target = date; return { removed: [ev.id] }; };
    row0(ctx).querySelector(sel).fire("click");
    await settled();
    assert.equal(target, expected, `${sel} must move to ${expected}`);
  }
});

test("Backlog routes through toBacklog, and a REFUSED action leaves the row in place", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: "Slipped" })] }, [d]);
  await ctx.window.initCatchUp();
  let called = false;
  const r = row0(ctx);
  // toBacklog returns null when it cannot resolve the origin row. The prompt must not
  // pretend the row is handled: settle(null) is falsy, so the row stays and the
  // buttons are re-enabled for another try. Assert the disable IN FLIGHT as well as
  // the re-enable after -- FakeEl defaults disabled:false, so checking only the
  // re-enable would still pass if busy() silently became a no-op.
  ctx.window.DCC.Carryover.toBacklog = async () => {
    assert.equal(r.querySelector(".cu-drop").disabled, true, "buttons must disable while the action is in flight");
    called = true;
    return null;
  };
  r.querySelector(".cu-backlog").fire("click");
  await settled();
  assert.equal(called, true);
  assert.equal(r._removed, false, "a refused action must not remove the row");
  assert.equal(r.querySelector(".cu-drop").disabled, false, "and must re-enable the buttons");
});

test("Move all to today drains the queue, defers the refold, and marks the day reviewed", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [
    dayRoot(), blk("a", d, { title: "A" }), blk("b", d, { title: "B" }), blk("c", d, { title: "C" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  const moves = [];
  let refolds = 0;
  ctx.window.DCC.Carryover.moveTo = async (ev, date, opts) => {
    moves.push({ id: ev.id, date, deferred: !!opts.deferRefold });
    return { removed: [ev.id] };
  };
  ctx.window.DCC.Carryover.refoldViewedDay = async () => { refolds++; };

  const overlay = ctx.document.getElementById("catchup-overlay");
  overlay.querySelector("#catchup-all").fire("click");
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(moves.map(m => m.id), ["a", "b", "c"], "every queued root moves, in order");
  assert.ok(moves.every(m => m.date === TODAY && m.deferred),
    "each move targets today and defers its refold to the batch");
  assert.equal(refolds, 1, "exactly ONE refold for the whole batch, not one per row");
  assert.ok(saved._catchUpReviewed, "the day is marked reviewed when the batch closes it");
});

// ───────────────── triage rides along (the sweep's items) ─────────────────
// Swept triage items appear in this same modal, but they are NOT blocks: none of
// DCC.Carryover applies to them. Scheduling one CREATES a task on the chosen day
// and dropping one deletes the triage item. These pin that the modal reaches the
// triage writers and nothing else, since routing a triage row through moveTo would
// try to reschedule a block id that does not exist.
const TRI = (id, over) => Object.assign({
  id, title: "Reply to " + id, source: "slack", priority: "High",
  first_seen_at: "2026-07-27T09:00:00.000Z", link: "https://example.com/" + id
}, over || {});

// A context wired with triage collaborators. `calls` records every write the modal
// attempts, so a test can assert the destination as well as the fact of the call.
function triageCtx(daysByDate, archiveDates, items, over) {
  const calls = { placed: [], dropped: [], pickers: [], seen: [] };
  const extra = Object.assign({
    activeTriageItems: () => items.slice(),
    triagePriorityLabel: (p) => p || "Medium",
    scheduleTriageOnDate: async (id, date) => { calls.placed.push({ id, date }); return { id: "blk-" + id, properties: {} }; },
    deleteTriageItem: (id) => { calls.dropped.push(id); },
    openDatePickPopover: (anchor, opts) => { calls.pickers.push(opts); }
  }, over || {});
  const h = load(daysByDate, archiveDates, extra);
  // The courier's seen-set sink. initCatchUp banks whatever is already waiting at
  // boot so the pet never runs for mail the morning prompt just showed.
  h.ctx.window.DCC.TriageCourier = { markSeen: (ids) => { calls.seen.push(...ids); } };
  return Object.assign(h, { calls });
}
const rowsOf = (ctx) => ctx.document.getElementById("catchup-overlay")
  .querySelector("#catchup-list").children;
const titleOf = (r) => r.querySelector(".carryover-row-title").textContent;

test("triage items ride along with the tasks that slipped, in their own section", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  // Triage leads: something waiting on a reply is more time-sensitive than something
  // that slipped, and burying it under N slipped rows means scrolling for the thing
  // the pet just delivered.
  const listed = [...rowsOf(ctx)].map(titleOf).filter(Boolean);
  assert.deepEqual(listed, ["Reply to m1", "Slipped"]);
  // Section labels only appear when both kinds are present — two of them here.
  assert.equal([...rowsOf(ctx)].filter(r => r.className === "cu-section-label").length, 2);
});

test("a triage-only morning still opens the prompt (and does not mark it reviewed)", async () => {
  const d = ymd(1);
  // Nothing unfinished at all: the old gate returned early on an empty root list,
  // which would have swallowed a mailbox full of replies.
  const { ctx, saved } = triageCtx({ [d]: [dayRoot({ _done: { ids: ["only"] } }), blk("only", d, {})] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  assert.deepEqual([...rowsOf(ctx)].map(titleOf).filter(Boolean), ["Reply to m1"]);
  assert.equal(saved._catchUpReviewed, undefined, "an open prompt has not been answered yet");
});

test("boot banks what is already waiting so the pet does not run at page load", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1"), TRI("m2")]);
  await ctx.window.initCatchUp();
  assert.deepEqual(calls.seen, ["m1", "m2"]);
});

test("Today and Tomorrow on a triage row schedule it on that date and clear the row", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1"), TRI("m2")]);
  await ctx.window.initCatchUp();
  const [first, second] = [...rowsOf(ctx)];
  first.querySelector(".cu-tri-today").fire("click");
  await new Promise(r => setTimeout(r, 0));
  second.querySelector(".cu-tri-tomorrow").fire("click");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.placed, [{ id: "m1", date: TODAY }, { id: "m2", date: "2026-07-30" }]);
  assert.ok(first._removed && second._removed, "a scheduled item leaves the list");
});

test("a refused schedule leaves the triage row in place and re-enables it", async () => {
  const d = ymd(1);
  // No free slot / already on that day: scheduleTriageOnDate returns null, and the
  // row must survive so the answer isn't silently lost.
  const { ctx } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1")],
    { scheduleTriageOnDate: async () => null });
  await ctx.window.initCatchUp();
  const r = [...rowsOf(ctx)][0];
  r.querySelector(".cu-tri-today").fire("click");
  await new Promise(r2 => setTimeout(r2, 0));
  assert.equal(r._removed, false);
  assert.equal(r.querySelector(".cu-tri-today").disabled, false);
});

test("Drop on a triage row deletes the triage item, never a block", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  let carryoverDrops = 0;
  ctx.window.DCC.Carryover.drop = async () => { carryoverDrops++; return null; };
  const r = [...rowsOf(ctx)][0];
  r.querySelector(".cu-tri-drop").fire("click");
  await new Promise(r2 => setTimeout(r2, 0));
  assert.deepEqual(calls.dropped, ["m1"], "routes through deleteTriageItem (durable, with Undo)");
  assert.equal(carryoverDrops, 0, "and never through the block dropper");
  assert.equal(r._removed, true);
});

// ───────────────── the calendar button (both row kinds) ─────────────────
// The point of the button is that an arbitrary day behaves EXACTLY like Today —
// same mover, same write. A second code path here is how "Today works but the 12th
// silently doesn't" happens.
test("the calendar button on a task row routes its pick through the same mover", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d], []);
  await ctx.window.initCatchUp();
  const moves = [];
  ctx.window.DCC.Carryover.moveTo = async (ev, date) => { moves.push({ id: ev.id, date }); return { removed: [ev.id] }; };
  const r = [...rowsOf(ctx)][0];
  r.querySelector(".cu-cal").fire("click", { target: r.querySelector(".cu-cal") });
  assert.equal(calls.pickers.length, 1, "opens the shared day picker");
  assert.match(calls.pickers[0].header, /Move "Slipped" to/);
  await calls.pickers[0].onPick("2026-08-12");
  assert.deepEqual(moves, [{ id: "t1", date: "2026-08-12" }]);
  assert.equal(r._removed, true);
});

test("the calendar button on a triage row routes its pick through the triage scheduler", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  const r = [...rowsOf(ctx)][0];
  r.querySelector(".cu-cal").fire("click", { target: r.querySelector(".cu-cal") });
  assert.equal(calls.pickers.length, 1);
  await calls.pickers[0].onPick("2026-08-12");
  assert.deepEqual(calls.placed, [{ id: "m1", date: "2026-08-12" }]);
});

test("Move all to today takes the triage rows with it", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot(), blk("a", d, { title: "A" })] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  ctx.window.DCC.Carryover.moveTo = async (ev) => ({ removed: [ev.id] });
  ctx.window.DCC.Carryover.refoldViewedDay = async () => {};
  ctx.document.getElementById("catchup-overlay").querySelector("#catchup-all").fire("click");
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls.placed, [{ id: "m1", date: TODAY }],
    "'all' means all — a swept reply is exactly what this button is for");
});

// ───────────────── the courier's prompt (openArrivals) ─────────────────
test("openArrivals leads with what arrived and folds the rest behind one line", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d],
    [TRI("new1"), TRI("old1"), TRI("old2")]);
  const shown = await ctx.window.DCC.CatchUp.openArrivals(["new1"]);
  assert.equal(shown, true);
  const listed = [...rowsOf(ctx)].map(titleOf).filter(Boolean);
  assert.deepEqual(listed, ["Reply to new1", "Slipped"], "the arrival leads; older items are not listed up front");
  const older = [...rowsOf(ctx)].find(r => r.className && r.className.indexOf("cu-tri-older") > -1);
  assert.ok(older, "but one line says they exist");
  assert.match(older.textContent, /2 older waiting/);
  // Expanding appends in place rather than re-opening the modal, which would
  // re-bind the footer's "Move all" and run it twice per click.
  older.fire("click");
  assert.deepEqual([...rowsOf(ctx)].map(titleOf).filter(Boolean),
    ["Reply to new1", "Reply to old1", "Reply to old2", "Slipped"]);
});

test("openArrivals ignores ids that are no longer active, and never prompts empty", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("still-here")]);
  // The item was handled elsewhere between the sweep and the delivery.
  const shown = await ctx.window.DCC.CatchUp.openArrivals(["already-gone"]);
  assert.equal(shown, false);
  assert.equal(ctx.document.getElementById("catchup-overlay"), null);
});
