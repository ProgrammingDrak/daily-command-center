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
    hidden: false, children: [], style: {}, dataset: {}, _attrs: new Map(), _q: new Map(), _on: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { el._attrs.set(k, String(v)); },
    getAttribute(k) { return el._attrs.has(k) ? el._attrs.get(k) : null; },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    // The real DOM has this, and the footer's re-bind guard needs it: without it the
    // harness silently keeps every handler openPrompt ever attached, so a fix for the
    // stacked "Move all" listener could not be expressed here.
    removeEventListener(ev, fn) {
      const list = el._on[ev]; if (!list) return;
      const i = list.indexOf(fn); if (i > -1) list.splice(i, 1);
    },
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
    contains(node) { for (let cur = node; cur; cur = cur._parent) if (cur === el) return true; return false; },
    focus() { el._focused = true; },
    querySelector(sel) {
      if (!el._q.has(sel)) { const child = FakeEl("div"); child._parent = el; el._q.set(sel, child); }
      return el._q.get(sel);
    },
    // Return the stubs this element has actually handed out for button selectors, so
    // busy()'s disable pass is observable instead of writing into the void.
    querySelectorAll(sel) {
      if (sel !== "button") return [];
      return [...el._q.entries()].filter(([k]) => /^\.(cu-|catchup-)/.test(k)).map(([, v]) => v);
    },
    _removed: false, _focused: false, _parent: null
  };
  return el;
}
function fakeDocument() {
  const byId = new Map();
  return {
    readyState: "complete",
    activeElement: null,
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
    .map(r => r.querySelector(".carryover-row-title").textContent)
    .filter(Boolean);
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
// The row buttons and "Move all to today" were entirely unexercised: FakeEl
// defined fire() and no test called it. For a module that exists because
// carryover-review.js's buttons only LOOKED real ("Drop was a single log line -- it
// deleted NOTHING"), "no test clicks anything" is the gap that matters most.
const row0 = (ctx) => ctx.document.getElementById("catchup-overlay")
  .querySelector("#catchup-list").children.find(r => r.className && r.className.indexOf("carryover-row") > -1);
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

test("Today moves the root to the current day", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: "Slipped" })] }, [d]);
  await ctx.window.initCatchUp();
  let target = null;
  ctx.window.DCC.Carryover.moveTo = async (ev, date) => { target = date; return { removed: [ev.id] }; };
  row0(ctx).querySelector(".cu-today").fire("click");
  await settled();
  assert.equal(target, TODAY);
});

test("Complete routes the root and full pool through the shared origin-day completion", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [
    dayRoot(), blk("p", d, { title: "Slipped" }), blk("k", d, { title: "Kid", subtaskOf: "p" })
  ] }, [d]);
  await ctx.window.initCatchUp();
  let got = null;
  const r = row0(ctx);
  ctx.window.DCC.Carryover.complete = async (ev, pool) => {
    got = { id: ev.id, pool: pool.length, disabled: r.querySelector(".cu-drop").disabled };
    return { removed: [ev.id, "k"] };
  };
  r.querySelector(".cu-complete").fire("click", { stopPropagation() {} });
  await settled();
  assert.deepEqual(got, { id: "p", pool: 2, disabled: true });
  assert.equal(r._removed, true, "the completed row leaves the review");
});

test("a failed completion stays in the review instead of pretending it persisted", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: "Slipped" })] }, [d]);
  await ctx.window.initCatchUp();
  const r = row0(ctx);
  ctx.window.DCC.Carryover.complete = async () => null;
  r.querySelector(".cu-complete").fire("click", { stopPropagation() {} });
  await settled();
  assert.equal(r._removed, false);
  assert.equal(r.querySelector(".cu-drop").disabled, false, "the user can retry after a failed write");
});

test("completing the focused row moves focus to the next completion control", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("a", d, { title: "A" }), blk("b", d, { title: "B" })] }, [d]);
  await ctx.window.initCatchUp();
  const rows = ctx.document.getElementById("catchup-overlay").querySelector("#catchup-list").children
    .filter(r => r.className && r.className.indexOf("carryover-row") > -1);
  const firstComplete = rows[0].querySelector(".cu-complete");
  const secondComplete = rows[1].querySelector(".cu-complete");
  ctx.document.activeElement = firstComplete;
  ctx.window.DCC.Carryover.complete = async (ev) => ({ removed: [ev.id] });
  firstComplete.fire("click", { stopPropagation() {} });
  await settled();
  assert.equal(secondComplete._focused, true);
});

test("completing the final focused row returns focus to the task launcher", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("a", d, { title: "A" })] }, [d]);
  const launcher = ctx.document.createElement("button");
  launcher.id = "dcc-launcher-btn";
  ctx.document.body.appendChild(launcher);
  await ctx.window.initCatchUp();
  const row = row0(ctx);
  const complete = row.querySelector(".cu-complete");
  ctx.document.activeElement = complete;
  ctx.window.DCC.Carryover.complete = async (ev) => ({ removed: [ev.id] });
  complete.fire("click", { stopPropagation() {} });
  await settled();
  assert.equal(launcher._focused, true);
});

test("the full title is available on hover and the row expands read-only details", async () => {
  const d = ymd(1);
  const longTitle = "Review the full Offers Script draft and all implementation notes";
  const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: longTitle })] }, [d]);
  await ctx.window.initCatchUp();
  const r = row0(ctx);
  const title = r.querySelector(".carryover-row-title");
  const toggle = r.querySelector(".cu-details-toggle");
  const panel = r.querySelector(".cu-details");
  assert.equal(title.title, longTitle, "native hover text carries the untruncated title");
  assert.equal(toggle.getAttribute("aria-label"), "Show notes and details for " + longTitle);

  ctx.window.DCC.Carryover.loadDetails = async () => ({
    title: longTitle,
    details: ["Compare the new fallback against the control."],
    notes: ["Ask Growth to review the final copy."]
  });
  toggle.fire("click");
  await settled();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Hide notes and details for " + longTitle);
  const sections = r.querySelector(".cu-details-body").children;
  assert.deepEqual(sections.map(s => s.children[0].textContent), ["Details", "Notes"]);
  assert.deepEqual(sections.map(s => s.children[1].textContent), [
    "Compare the new fallback against the control.", "Ask Growth to review the final copy."
  ]);
});

test("details expansion uses a native button and explains an empty task", async () => {
  const d = ymd(1);
  const { ctx } = load({ [d]: [dayRoot(), blk("p", d, { title: "Slipped" })] }, [d]);
  await ctx.window.initCatchUp();
  const r = row0(ctx);
  const toggle = r.querySelector(".cu-details-toggle");
  ctx.window.DCC.Carryover.loadDetails = async () => ({ title: "Slipped", details: [], notes: [] });
  assert.match(r.innerHTML, /<button type="button" class="carryover-btn cu-details-action cu-details-toggle"[^>]*>Details<\/button>/,
    "native button semantics provide Enter and Space activation without a wrapper key handler");
  toggle.fire("click");
  await settled();
  assert.equal(r.querySelector(".cu-details").hidden, false);
  assert.equal(r.querySelector(".cu-details-body").textContent, "No notes or details on this task.");
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

// ───────────────── meeting follow-ups from recap documents ─────────────────
const MTG_ACTION = {
  id: "proposal-1", meetingId: "meeting-1", meetingTitle: "Investor weekly",
  meetingDate: "2026-07-28", meetingStart: "13:00", meetingEnd: "14:00",
  title: "Send the updated investor brief", owner: "drake", priority: "High"
};

function meetingCtx(action, completionResult) {
  const calls = { approved: [], completed: [] };
  const fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url === "/api/meetings/actions/proposed") {
      return { ok: true, json: async () => ({ items: [action] }) };
    }
    if (url.endsWith("/actions/approve")) {
      calls.approved.push(body.actionIds);
      return { ok: true, json: async () => ({ approvedBlocks: [{ id: "approved-1" }] }) };
    }
    throw new Error("Unexpected URL " + url);
  };
  const ctx = load({ [ymd(1)]: [dayRoot()] }, [ymd(1)], { fetch });
  ctx.ctx.window.blockStore.setTaskCompletion = async (id, completed, opts) => {
    calls.completed.push({ id, completed, taskDate: opts.taskDate });
    return completionResult || { ok: true };
  };
  return Object.assign(ctx, { calls });
}

test("meeting follow-ups have an already-done checkmark that completes the approved action", async () => {
  const { ctx, calls } = meetingCtx(MTG_ACTION);
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-complete").fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.approved, [["proposal-1"]]);
  assert.deepEqual(calls.completed, [{ id: "approved-1", completed: true, taskDate: "2026-07-28" }]);
  assert.equal(row._removed, true);
});

test("retrying an approved meeting follow-up completes its existing action without duplicating it", async () => {
  const { ctx, calls } = meetingCtx({ ...MTG_ACTION, approvedBlockId: "approved-existing" });
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-complete").fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.approved, []);
  assert.deepEqual(calls.completed, [{ id: "approved-existing", completed: true, taskDate: "2026-07-28" }]);
  assert.equal(row._removed, true);
});

test("a pending meeting completion stays visible, re-enables, and restores focus", async () => {
  const { ctx, calls } = meetingCtx(MTG_ACTION, { ok: false, pending: true });
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  const complete = row.querySelector(".cu-complete");
  ctx.document.activeElement = complete;
  complete.fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.completed, [{ id: "approved-1", completed: true, taskDate: "2026-07-28" }]);
  assert.equal(row._removed, false, "the row must remain until the canonical write is acknowledged");
  assert.equal(complete.disabled, false, "the user can retry a queued or failed write");
  assert.equal(complete._focused, true, "keyboard focus returns to the action that needs a retry");
});

test("completing the final meeting follow-up returns focus to the task launcher", async () => {
  const { ctx } = meetingCtx(MTG_ACTION);
  const launcher = ctx.document.createElement("button");
  launcher.id = "dcc-launcher-btn";
  ctx.document.body.appendChild(launcher);
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  const complete = row.querySelector(".cu-complete");
  ctx.document.activeElement = complete;
  complete.fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(launcher._focused, true);
});

test("meeting Details opens that meeting's recap", async () => {
  const opened = [];
  const { ctx } = triageCtx({ [ymd(1)]: [dayRoot()] }, [ymd(1)], [], {
    fetch: async () => ({ ok: true, json: async () => ({ items: [MTG_ACTION] }) }),
    openPrepModal: (meeting, opts) => opened.push({ meeting, opts })
  });
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-mtg-details").fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{
    meeting: {
      id: "meeting-1", meetingBlockId: "meeting-1", title: "Investor weekly",
      start: "13:00", end: "14:00"
    },
    opts: { defaultTab: "recap" }
  }]);
  assert.equal(row._removed, false, "viewing the recap does not resolve the follow-up");
});

test("a delegated meeting row keeps the shared layout without stealing the owner's task", async () => {
  const delegated = { ...MTG_ACTION, id: "delegated-1", owner: "other" };
  const scheduled = [];
  const fetch = async (url, opts) => {
    if (url === "/api/meetings/actions/proposed") {
      return { ok: true, json: async () => ({ items: [delegated] }) };
    }
    if (url.endsWith("/actions/delegated-1/schedule")) {
      scheduled.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error("Unexpected URL " + url);
  };
  const { ctx } = triageCtx({ [ymd(1)]: [dayRoot()] }, [ymd(1)], [], { fetch });
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  assert.match(row.innerHTML, /<button disabled[^>]*class="btn-schedule cu-cal"/,
    "delegated rows keep the shared calendar control, visibly disabled");
  assert.match(row.innerHTML, /class="carryover-btn carryover-btn-schedule cu-today cu-mtg-today"[^>]*disabled/,
    "Today stays in the shared action order without scheduling someone else's commitment");
  row.querySelector(".cu-mtg-today").fire("click");
  await settled();
  assert.deepEqual(scheduled, []);
  assert.equal(row._removed, false);
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
  const calls = { placed: [], completed: [], dropped: [], pickers: [], seen: [] };
  const extra = Object.assign({
    activeTriageItems: () => items.slice(),
    triagePriorityLabel: (p) => p || "Medium",
    scheduleTriageOnDate: async (id, date, opts) => {
      calls.placed.push(opts ? { id, date, opts } : { id, date });
      return { id: "blk-" + id, properties: {} };
    },
    dismissTriage: async (id, note, trivial) => {
      calls.completed.push({ id, note, trivial });
      return true;
    },
    deleteTriageItem: (id) => { calls.dropped.push(id); },
    openDatePickPopover: (anchor, opts) => { calls.pickers.push(opts); }
  }, over || {});
  const h = load(daysByDate, archiveDates, extra);
  // The courier's seen-set sink. initCatchUp banks whatever is already waiting at
  // boot so the pet never runs for mail the morning prompt just showed.
  h.ctx.window.DCC.TriageCourier = { markSeen: (ids) => { calls.seen.push(...ids); } };
  return Object.assign(h, { calls });
}
const allRowsOf = (ctx) => ctx.document.getElementById("catchup-overlay")
  .querySelector("#catchup-list").children;
const rowsOf = (ctx) => allRowsOf(ctx)
  .filter(r => r.className && r.className.indexOf("carryover-row") > -1);
const titleOf = (r) => r.querySelector(".carryover-row-title").textContent;

function installDayReview(ctx, count) {
  const packet = { packetDate: TODAY, reviewDate: ymd(1) };
  ctx.window.DCC.DayReview = {
    load: async () => packet,
    pendingCount: () => count,
    renderPending: () => '<article class="cu-review-card">Review cards</article>',
    renderJournal: () => '<section class="gb-journal">Journal</section>'
  };
  return packet;
}

function waitingCtx() {
  const item = {
    id: "waiting-1",
    created_at: "2026-07-23T12:00:00Z",
    properties: {
      kind: "delegated_item",
      myTask: "Launch plan",
      title: "Legal approval",
      delegatee: { name: "Alex" },
      checkInDate: TODAY,
      checkInDays: 7,
      status: "open"
    }
  };
  const draft = {
    id: "waiting-checkin:waiting-1:" + TODAY,
    type: "waiting_checkin",
    title: "Check in: Launch plan",
    waiting_item_id: "waiting-1",
    waiting_cycle_key: "waiting:waiting-1:" + TODAY,
    draft_type: "internal",
    draft_preview: "Hi Alex, quick check-in."
  };
  const calls = { snoozed: [], scheduled: [], unblocked: [], copied: [] };
  const h = load({ [ymd(1)]: [dayRoot()] }, [ymd(1)], {
    getAttentionWaitingItems: () => [item],
    activeTriageItems: () => [draft]
  });
  h.ctx.window.DCC.Waiting = {
    itemUrgency: () => ({ score: 100 }),
    blockerLabel: () => "Blocked by Alex: Legal approval",
    dueLabel: () => "check in today",
    completeCheckIn: async () => true,
    snooze: async (id, date) => { calls.snoozed.push({ id, date }); return true; },
    scheduleCheckIn: (id, _anchor, _done, date) => { calls.scheduled.push({ id, date: date || null }); },
    unblock: async id => { calls.unblocked.push(id); return true; },
    copyText: async text => { calls.copied.push(text); return true; }
  };
  return Object.assign(h, { calls });
}

test("Waiting has one Loose Ends row with its internal draft, not a duplicate triage row", async () => {
  const { ctx } = waitingCtx();
  await ctx.window.initCatchUp();
  assert.deepEqual([...rowsOf(ctx)].map(titleOf).filter(Boolean), ["Launch plan"]);
  assert.deepEqual(
    [...allRowsOf(ctx)].filter(r => r.className === "cu-section-label").map(r => r.textContent),
    ["Waiting"]
  );
  const row = [...rowsOf(ctx)][0];
  assert.ok(row.querySelector(".cu-wait-copy"), "the copy-ready fallback stays in Waiting details");
  const actionHtml = /<div class="carryover-row-actions">([\s\S]*?)<\/div>/.exec(row.innerHTML)[1];
  assert.deepEqual([...actionHtml.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ["Today", "Drop", "Details"]);
});

test("Waiting actions snooze, schedule a check-in, unblock, and copy the fallback", async () => {
  const { ctx, calls } = waitingCtx();
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-wait-details").fire("click");
  assert.equal(row.querySelector(".cu-details").hidden, false);
  row.querySelector(".cu-wait-drop").fire("click");
  await new Promise(resolve => setTimeout(resolve, 0));
  row.querySelector(".cu-wait-today").fire("click", { currentTarget: row.querySelector(".cu-wait-today") });
  row.querySelector(".cu-wait-schedule").fire("click", { currentTarget: row.querySelector(".cu-wait-schedule") });
  row.querySelector(".cu-wait-unblock").fire("click");
  await new Promise(resolve => setTimeout(resolve, 0));
  row.querySelector(".cu-wait-copy").fire("click");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.snoozed, [{ id: "waiting-1", date: "2026-07-30" }]);
  assert.deepEqual(calls.scheduled, [{ id: "waiting-1", date: TODAY }, { id: "waiting-1", date: null }]);
  assert.deepEqual(calls.unblocked, ["waiting-1"]);
  assert.deepEqual(calls.copied, ["Hi Alex, quick check-in."]);
});

test("the unified modal follows the requested section order", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx(
    { [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] },
    [d],
    [TRI("s1"), TRI("g1", { source: "gmail" })],
    { fetch: async () => ({ ok: true, json: async () => ({ items: [MTG_ACTION] }) }) }
  );
  installDayReview(ctx, 2);
  await ctx.window.initCatchUp();
  assert.deepEqual(
    [...allRowsOf(ctx)].filter(r => r.className === "cu-section-label").map(r => r.textContent),
    ["Slipped tasks", "Slack", "Gmail", "Meeting follow-ups", "Day in Review"]
  );
  const journal = [...allRowsOf(ctx)].find(r => r.className === "cu-journal-wrap");
  assert.match(journal.innerHTML, /Journal/);
});

test("every Loose Ends row uses checkmark, title, calendar, Today, Drop, Details in that order", async () => {
  const d = ymd(1);
  const delegated = { ...MTG_ACTION, id: "proposal-2", owner: "other", title: "Wait for finance" };
  const { ctx } = triageCtx(
    { [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] },
    [d],
    [TRI("s1")],
    { fetch: async () => ({ ok: true, json: async () => ({ items: [MTG_ACTION, delegated] }) }) }
  );
  await ctx.window.initCatchUp();
  const rows = [...rowsOf(ctx)];
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const html = row.innerHTML;
    const completeAt = html.indexOf('class="cu-complete"');
    const titleAt = html.indexOf('class="carryover-row-title"');
    const calendarAt = html.indexOf('class="btn-schedule cu-cal"');
    const actionsAt = html.indexOf('class="carryover-row-actions"');
    assert.ok(completeAt > -1 && completeAt < titleAt, "the checkmark leads the row");
    assert.ok(titleAt < calendarAt && calendarAt < actionsAt, "title and calendar precede the text actions");
    const actionHtml = /<div class="carryover-row-actions">([\s\S]*?)<\/div>/.exec(html)[1];
    const labels = [...actionHtml.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
    assert.deepEqual(labels, ["Today", "Drop", "Details"]);
    assert.doesNotMatch(actionHtml, /Tomorrow|Backlog|Dismiss|Recap/);
  }
});

test("an unaddressed Day in Review keeps the Loose Ends reminder after close", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [dayRoot()] }, [d]);
  const pill = ctx.document.createElement("button"); pill.id = "loose-ends-pill"; pill.hidden = true; ctx.document.body.appendChild(pill);
  const count = ctx.document.createElement("span"); count.id = "loose-ends-pill-count"; ctx.document.body.appendChild(count);
  installDayReview(ctx, 3);
  await ctx.window.initCatchUp();
  assert.equal(pill.hidden, false);
  assert.equal(count.textContent, "3");
  ctx.document.getElementById("catchup-overlay").querySelector("#catchup-close").fire("click");
  assert.ok(saved._catchUpReviewed, "closing suppresses a second automatic prompt");
  assert.equal(pill.hidden, false, "the reminder remains until the decisions are handled");
});

test("a completed Day in Review still opens the morning Journal once", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [dayRoot()] }, [d]);
  installDayReview(ctx, 0);
  await ctx.window.initCatchUp();
  const overlay = ctx.document.getElementById("catchup-overlay");
  assert.equal(overlay.classList.contains("open"), true);
  assert.ok([...allRowsOf(ctx)].some(row => row.className === "cu-journal-wrap"));
  assert.equal(saved._catchUpReviewed, undefined);
});

test("a Day in Review load failure never marks the morning reviewed", async () => {
  const d = ymd(1);
  const { ctx, saved } = load({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d]);
  ctx.window.DCC.DayReview = {
    load: async () => { throw new Error("temporarily unavailable"); },
    pendingCount: () => 0
  };
  await ctx.window.initCatchUp();
  assert.equal(saved._catchUpReviewed, undefined);
  assert.equal(ctx.document.getElementById("catchup-overlay"), null,
    "a partial first-run modal waits and retries instead of hiding an omitted section");
});

test("fresh sweep arrivals still open when Day in Review is temporarily unavailable", async () => {
  const { ctx, saved } = triageCtx({}, [], [TRI("s1")]);
  ctx.window.DCC.DayReview = {
    load: async () => { throw new Error("temporarily unavailable"); },
    pendingCount: () => 0
  };
  const opened = await ctx.window.DCC.CatchUp.openArrivals(["s1"]);
  assert.equal(opened, true);
  const overlay = ctx.document.getElementById("catchup-overlay");
  assert.equal(overlay.querySelector("#catchup-title").textContent, "Fresh from the sweep");
  assert.deepEqual([...rowsOf(ctx)].map(titleOf).filter(Boolean), ["Reply to s1"]);
  overlay.querySelector("#catchup-close").fire("click");
  assert.equal(saved._catchUpReviewed, undefined, "closing a partial fresh modal never marks the morning reviewed");
});

test("fresh arrivals stay unreviewed when slipped tasks or meeting follow-ups fail to load", async () => {
  for (const failedSource of ["slipped", "meetings"]) {
    const fetch = failedSource === "meetings"
      ? async () => { throw new Error("meetings unavailable"); }
      : async () => ({ ok: true, json: async () => ({ items: [] }) });
    const { ctx, saved } = triageCtx({}, [], [TRI("s1")], { fetch });
    installDayReview(ctx, 0);
    if (failedSource === "slipped") ctx.window.DCC.Carryover.collect = async () => { throw new Error("tasks unavailable"); };
    assert.equal(await ctx.window.DCC.CatchUp.openArrivals(["s1"]), true);
    ctx.document.getElementById("catchup-overlay").querySelector("#catchup-close").fire("click");
    assert.equal(saved._catchUpReviewed, undefined, failedSource + " failure must keep the morning retryable");
  }
});

test("triage items ride along with the tasks that slipped, in their own section", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  // The unified morning sequence starts with what slipped, then moves into comms.
  const listed = [...rowsOf(ctx)].map(titleOf).filter(Boolean);
  assert.deepEqual(listed, ["Slipped", "Reply to m1"]);
  assert.deepEqual([...allRowsOf(ctx)].filter(r => r.className === "cu-section-label").map(r => r.textContent), ["Slipped tasks", "Slack"]);
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

test("Today on a triage row schedules it on the current day and clears the row", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  const first = [...rowsOf(ctx)][0];
  first.querySelector(".cu-tri-today").fire("click");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.placed, [{ id: "m1", date: TODAY }]);
  assert.equal(first._removed, true, "a scheduled item leaves the list");
});

test("triage Details expands the item context without changing its metadata", async () => {
  const d = ymd(1);
  const item = TRI("m1", { summary: "Needs a reply before Friday", draft_preview: "Thanks for checking in." });
  const { ctx } = triageCtx({ [d]: [dayRoot()] }, [d], [item]);
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  const toggle = row.querySelector(".cu-tri-details");
  const details = row.querySelector(".cu-details");
  assert.match(row.innerHTML, /slack · High · \d+d old · <a class="cu-tri-link"/);
  toggle.fire("click");
  assert.equal(details.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.deepEqual(row.querySelector(".cu-details-body").children.map(section => section.children[0].textContent),
    ["Summary", "Draft preview"]);
});

test("triage Details includes notes-only context", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1", { notes: "Use the approved response." })]);
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-tri-details").fire("click");
  assert.equal(row.querySelector(".cu-details-body").children[0].children[1].textContent,
    "Use the approved response.");
});

test("triage rows have an already-done checkmark that resolves them", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  const row = [...rowsOf(ctx)][0];
  row.querySelector(".cu-complete").fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.completed, [{ id: "m1", note: "Already done", trivial: false }]);
  assert.equal(row._removed, true);
});

test("completing focused triage moves focus to the next source's completion control", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d], [TRI("m1")]);
  await ctx.window.initCatchUp();
  const rows = [...rowsOf(ctx)].filter(row => row.className.includes("carryover-row"));
  const triageComplete = rows.find(row => row.className.includes("cu-triage-row")).querySelector(".cu-complete");
  const slippedComplete = rows.find(row => row.className.includes("cu-task-row")).querySelector(".cu-complete");
  ctx.document.activeElement = triageComplete;
  triageComplete.fire("click", { stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(slippedComplete._focused, true);
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

// ───────────────── the calendar button (every row kind) ─────────────────
// The point of the button is that an arbitrary day behaves EXACTLY like Today —
// same mover, same write. A second code path here is how "Today works but the 12th
// silently doesn't" happens.
test("the calendar button on a task row routes its pick through the same mover", async () => {
  const d = ymd(1);
  // An apostrophe in the title is the case that catches double-escaping: the popover
  // escapes the header itself, so an esc() here would render a literal &#39;.
  const { ctx, calls } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Bob's & Sue's deck" })] }, [d], []);
  await ctx.window.initCatchUp();
  const moves = [];
  ctx.window.DCC.Carryover.moveTo = async (ev, date) => { moves.push({ id: ev.id, date }); return { removed: [ev.id] }; };
  const r = [...rowsOf(ctx)][0];
  r.querySelector(".cu-cal").fire("click", { target: r.querySelector(".cu-cal") });
  assert.equal(calls.pickers.length, 1, "opens the shared day picker");
  assert.equal(calls.pickers[0].header, 'Move "Bob\'s & Sue\'s deck" to…',
    "the caller passes the title RAW; the popover owns the escaping");
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
  assert.deepEqual(calls.placed.map(p => p.id + "@" + p.date), ["m1@" + TODAY],
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
  assert.deepEqual(listed, ["Slipped", "Reply to new1"], "the normal Loose Ends order remains stable; older items are not listed up front");
  const older = [...allRowsOf(ctx)].find(r => r.className && r.className.indexOf("cu-tri-older") > -1);
  assert.ok(older, "but one line says they exist");
  assert.match(older.textContent, /2 older waiting/);
  // Expanding appends in place rather than re-opening the modal, which would
  // re-bind the footer's "Move all" and run it twice per click.
  older.fire("click");
  assert.deepEqual([...rowsOf(ctx)].map(titleOf).filter(Boolean),
    ["Slipped", "Reply to new1", "Reply to old1", "Reply to old2"]);
});

test("openArrivals ignores ids that are no longer active, and never prompts empty", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot()] }, [d], [TRI("still-here")]);
  // The item was handled elsewhere between the sweep and the delivery.
  const shown = await ctx.window.DCC.CatchUp.openArrivals(["already-gone"]);
  assert.equal(shown, false);
  assert.equal(ctx.document.getElementById("catchup-overlay"), null);
});

// ───────── the overlay is reused, so a second open must not stack handlers ─────────
// ensureModal() hands back ONE overlay forever and close() only drops the `open`
// class, so #catchup-all is re-bound on every openPrompt. {once:true} de-registers a
// handler only after it FIRES, so the morning prompt's unclicked handler was still
// live when the courier opened the arrivals prompt: one click ran both, each over its
// own captured pool. openArrivals is the second entry point that made this reachable.
test("a second open does not leave the first Move-all handler bound", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot(), blk("a", d, { title: "A" })] }, [d], [TRI("m1")]);
  ctx.window.DCC.Carryover.refoldViewedDay = async () => {};
  await ctx.window.initCatchUp();
  await ctx.window.DCC.CatchUp.openArrivals(["m1"]);      // same overlay, footer re-bound
  const moves = [];
  ctx.window.DCC.Carryover.moveTo = async (ev) => { moves.push(ev.id); return { removed: [ev.id] }; };
  ctx.document.getElementById("catchup-overlay").querySelector("#catchup-all").fire("click");
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(moves, ["a"], "one move per row, not one per open");
  assert.deepEqual(calls.placed.map(p => p.id + "@" + p.date), ["m1@" + TODAY],
    "and the triage row is written once, not once per open");
});

test("Move all defers the per-item refold for triage rows too", async () => {
  const d = ymd(1);
  const { ctx, calls } = triageCtx({ [d]: [dayRoot(), blk("a", d, { title: "A" })] }, [d], [TRI("m1"), TRI("m2")]);
  let refolds = 0;
  ctx.window.DCC.Carryover.moveTo = async (ev) => ({ removed: [ev.id] });
  ctx.window.DCC.Carryover.refoldViewedDay = async () => { refolds++; };
  ctx.document.getElementById("catchup-overlay") // build it first
    || await ctx.window.initCatchUp();
  await ctx.window.initCatchUp();
  ctx.document.getElementById("catchup-overlay").querySelector("#catchup-all").fire("click");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(refolds, 1, "ONE refold for the whole batch, after both loops");
  assert.ok(calls.placed.every(p => p.opts && p.opts.deferRefold && p.opts.silent),
    "each triage write defers its own refold and stays quiet, like the task writes");
});

// ───────── the shared row helpers, asserted on their real output ─────────
// FakeEl.querySelector mints a stub for ANY selector and wireDateButton returns
// silently on a falsy button, so the click tests above would still pass if the button
// never reached the markup. Assert the markup itself, and unit-test the helpers.
test("core.js's shared row helpers emit what the callers query for", () => {
  const { ctx } = load({}, [], {});
  const DCC = ctx.window.DCC;
  const html = DCC.dateButtonHtml("cu-cal", 'Move "X" to a day');
  assert.match(html, /^<button class="btn-schedule cu-cal"/, "carries the caller's class");
  assert.match(html, /aria-label="Move &quot;X&quot; to a day"/, "and escapes the label");
  assert.ok(DCC.icons.calendar.startsWith("<svg"), "the glyph is the shared SVG");
  assert.equal(DCC.safeUrl("javascript:alert(1)"), "", "sweep URLs are scheme-allowlisted");
  assert.equal(DCC.safeUrl("  https://x.test/a  "), "https://x.test/a", "and trimmed");
  assert.equal(DCC.safeUrlAttr('https://x.test/a" onmouseover="alert(1)'),
    "https://x.test/a&quot; onmouseover=&quot;alert(1)", "attribute form escapes the quote");
});

test("the calendar button is really in every row kind's markup", async () => {
  const d = ymd(1);
  const { ctx } = triageCtx({ [d]: [dayRoot(), blk("t1", d, { title: "Slipped" })] }, [d], [TRI("m1")], {
    fetch: async () => ({ ok: true, json: async () => ({ items: [MTG_ACTION] }) })
  });
  await ctx.window.initCatchUp();
  const rows = [...rowsOf(ctx)].filter(r => r.className && r.className.indexOf("carryover-row") > -1);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.match(r.innerHTML, /<div class="cu-title-line">/, "the name and the button share a line");
    assert.match(r.innerHTML, /<button[^>]*class="btn-schedule cu-cal"[^>]*aria-label="/,
      "the button is in the row markup, not just in a querySelector stub");
    assert.match(r.innerHTML, new RegExp('aria-label="[^"]*' + titleOf(r).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the calendar label names its row");
  }
});

test("the modal traps keyboard focus and closes on Escape", () => {
  assert.match(catchUpSource, /e\.key === "Escape"/);
  assert.match(catchUpSource, /e\.key !== "Tab"/);
  assert.match(catchUpSource, /document\.activeElement === first/);
  assert.match(catchUpSource, /document\.activeElement === last/);
});

test("the Journal mood dialog uses semantic choices and its own focus trap", () => {
  const source = require("node:fs").readFileSync(require.resolve("./public/js/glymphatic-brief.js"), "utf8");
  assert.match(source, /class="gb-mood[^\n]*aria-pressed=/);
  assert.match(source, /class="gb-act[^\n]*aria-pressed=/);
  assert.match(source, /aria-labelledby="gb-mood-title"/);
  assert.match(source, /gbMoodReturnFocus/);
  assert.match(source, /overlay\.querySelectorAll\('button:not\(\[disabled\]\)/);
});
