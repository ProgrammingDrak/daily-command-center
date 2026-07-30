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

const TaskModel = require("./public/js/task-model.js");
const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
const catchUpSource = fs.readFileSync(require.resolve("./public/js/catch-up.js"), "utf8");

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
function load(daysByDate, archiveDates) {
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
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(unfSource, ctx);
  ctx.window.blockStore = store;
  ctx.window.DCC.TaskModel = TaskModel;
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
