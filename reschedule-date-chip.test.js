// Contract tests for the DATE CHIP half of the "Move … to…" popover
// (public/js/schedule-popover.js).
//
// The bug these lock down: time-picker.js auto-enhances the popover's
// <input type="date"> into a 📅 chip whose calendar opens in its OWN overlay,
// appended to <body> -- a SIBLING of the popover, not a child. The popover's
// "close on outside click" listener is registered capture-phase on document, so
// it ran BEFORE the calendar's day-cell handler and destroyed the popover
// mid-pick. The pick then landed on a detached input and fired `change` at
// nothing: the calendar closed, the popover vanished, the task never moved.
// Today / Tomorrow worked the whole time because those buttons live INSIDE the
// popover, which is exactly why the bug read as "only the date picker is
// broken".
//
// Four things about the fix are invisible from the server tests and each one is
// a real regression if it silently flips back:
//
//   * the LAYER MARKER. time-picker.js's overlay carries data-dcc-layer="above"
//     only while it is open. Drop it and every guard below silently passes
//     nothing through -- the popover starts dying on a pick again.
//   * the GUARD. DCC.overlay.eventInLayerAbove is the one place that knows a
//     layer the popover itself opened is not "outside". core-ui.js's own
//     popover closer had the identical blind spot.
//   * COMMIT ON CHANGE. Without it the pick only relabels the chip, and the
//     move needs a second click on a confirm button. That is the behavior Drake
//     reported as "doesn't work at all".
//   * NO CONFIRM BUTTON. Re-adding .resched-go breaks nothing mechanically, so
//     nothing else would fail -- it just quietly restores the two-step gesture.
//
// Harness follows the two idioms this repo uses for public/js: slice the real
// source with a must-match guard, then run it in a node:vm with stubs
// (earliest-free-create.test.js, launcher-urgent-menu.test.js). The guard and
// the popover under test are the REAL code; only the DOM is fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const POPOVER_SRC = fs.readFileSync(require.resolve("./public/js/schedule-popover.js"), "utf8");
const CORE_UI_SRC = fs.readFileSync(require.resolve("./public/js/core-ui.js"), "utf8");
const PICKER_SRC = fs.readFileSync(require.resolve("./public/js/time-picker.js"), "utf8");
const SLOTS_SRC = fs.readFileSync(require.resolve("./public/js/slots.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  return m[0];
}

const LAYER_CONST = mustSlice(CORE_UI_SRC, /^ {2}const LAYER_ABOVE = .*$/m, "core-ui LAYER_ABOVE");
const IN_LAYER = mustSlice(CORE_UI_SRC, /^ {2}function eventInLayerAbove\(event\) \{[\s\S]*?\n {2}\}/m, "eventInLayerAbove");
const LAYER_OPEN = mustSlice(CORE_UI_SRC, /^ {2}function layerAboveOpen\(\) \{[\s\S]*?\n {2}\}/m, "layerAboveOpen");
const POSITION = mustSlice(POPOVER_SRC, /^function _positionPopoverNear\(anchorEl,pop,opts\)\{[\s\S]*?\n\}/m, "_positionPopoverNear");
const OPEN_POPOVER = mustSlice(POPOVER_SRC, /^function openSchedulePopover\(cfg\)\{[\s\S]*?\n\}/m, "openSchedulePopover");

// ── fake DOM ────────────────────────────────────────────────────────────────
// innerHTML is a string here, so querySelector resolves against the markup the
// popover actually wrote: a selector that stops matching (a renamed class, a
// deleted row) returns null instead of a forgiving stub, which is the point.
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "", textContent: "", value: "", type: "", disabled: false,
    style: {}, dataset: {}, children: [], attrs: {},
    _html: "", _stubs: new Map(), _listeners: {},
    classList: {
      add(c) { el.className = (el.className + " " + c).trim(); },
      remove(c) { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(" "); },
      contains(c) { return el.className.split(/\s+/).includes(c); }
    },
    set innerHTML(v) { el._html = String(v); el._stubs.clear(); },
    get innerHTML() { return el._html; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k); },
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    remove() {
      el.removed = true;
      if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el);
      el.parent = null;
    },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (el._listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
    getBoundingClientRect() { return { top: 100, bottom: 130, left: 40, right: 240, width: 200, height: 30 }; },
    offsetWidth: 220, offsetHeight: 160,
    querySelectorAll(sel) { return el._resolve(sel); },
    querySelector(sel) { return el._resolve(sel)[0] || null; },
    contains(node) {
      if (node === el) return true;
      let found = false;
      el._stubs.forEach(list => list.forEach(s => { if (s === node) found = true; }));
      el.children.forEach(c => { if (c.contains && c.contains(node)) found = true; });
      return found;
    },
    closest() { return null; },
    // One stub per element the markup declares, cached so the code under test
    // sees the same node every time it looks the selector up.
    _resolve(sel) {
      const key = String(sel);
      if (el._stubs.has(key)) return el._stubs.get(key);
      const out = [];
      key.split(",").map(s => s.trim()).forEach(one => {
        const cls = one.replace(/^\./, "");
        const re = new RegExp('<(\\w+)([^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*)>', "g");
        let m;
        while ((m = re.exec(el._html))) {
          const child = makeEl(m[1]);
          const attrs = m[2];
          child.className = cls;
          const grab = (name) => { const g = new RegExp(name + '="([^"]*)"').exec(attrs); return g ? g[1] : null; };
          if (grab("data-target")) child.dataset.target = grab("data-target");
          if (grab("data-d")) child.dataset.d = grab("data-d");
          if (grab("type")) child.type = grab("type");
          out.push(child);
        }
      });
      el._stubs.set(key, out);
      return out;
    }
  };
  return el;
}

function makeContext(overrides) {
  const body = makeEl("body");
  const doc = {
    body,
    _listeners: {},
    createElement: makeEl,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, fn, capture) { (doc._listeners[type] = doc._listeners[type] || []).push({ fn, capture }); },
    removeEventListener(type, fn) {
      (doc._listeners[type] || []).forEach((r, i) => { if (r.fn === fn) doc._listeners[type][i] = null; });
      doc._listeners[type] = (doc._listeners[type] || []).filter(Boolean);
    },
    fire(type, event) { (doc._listeners[type] || []).slice().forEach(r => r.fn(event)); }
  };
  const moves = [];
  const picks = [];
  const pinned = [];
  const ctx = Object.assign({
    document: doc,
    window: { innerWidth: 1200, innerHeight: 800, DCC: {} },
    setTimeout,
    console,
    escHtml: (s) => String(s),
    scheduled: [{ id: "t1", title: "Throw together the pool table", start: "09:15", end: "10:15" }],
    _actualTodayStr: () => "2026-09-02",
    __tomorrowDate: "2026-09-03",
    _resolvedTodayDate: () => "2026-09-02",
    _resolvedTomorrowDate: () => "2026-09-03",
    moveTaskViaPlacement: (id, dateStr) => moves.push({ id, dateStr }),
    pinStartTime: (id, v) => pinned.push({ id, v }),
    syncAddedTaskTimes() {},
    showToast() {},
    ms: (n) => n + "m",
    dur: () => 60,
    f12: (v) => v,
    _moves: moves, _picks: picks, _pinned: pinned
  }, overrides || {});
  ctx.window.document = doc;
  vm.createContext(ctx);
  // The real guard, not a retyped one: a stub here would let a broken
  // eventInLayerAbove pass every popover test below.
  vm.runInContext(
    "(function(){" + LAYER_CONST + IN_LAYER + LAYER_OPEN +
    "window.DCC.overlay={eventInLayerAbove:eventInLayerAbove,layerAboveOpen:layerAboveOpen};})();",
    ctx
  );
  vm.runInContext(POSITION + "\n" + OPEN_POPOVER, ctx);
  return ctx;
}

// A click that landed inside the shared picker's overlay. `closest` is what the
// real guard calls, so the fake target answers the same question the browser
// would.
const inLayer = () => ({ target: { closest: (sel) => (sel === '[data-dcc-layer="above"]' ? {} : null) } });
const outside = () => ({ target: { closest: () => null } });

async function openPopover(ctx, cfg) {
  const anchor = makeEl("button");
  ctx.__anchor = anchor;
  ctx.__cfg = Object.assign({ anchorEl: anchor }, cfg);
  vm.runInContext("openSchedulePopover(__cfg)", ctx);
  await new Promise((r) => setTimeout(r, 0));   // the outside listener is armed on a 0ms timer
  const pop = ctx.document.body.children[ctx.document.body.children.length - 1];
  return { pop, anchor };
}

// ── the shared guard ────────────────────────────────────────────────────────
test("eventInLayerAbove treats only a marked layer as not-outside", () => {
  const ctx = makeContext();
  const guard = ctx.window.DCC.overlay;
  assert.equal(guard.eventInLayerAbove(inLayer()), true);
  assert.equal(guard.eventInLayerAbove(outside()), false);
  assert.equal(guard.eventInLayerAbove({}), false, "a synthetic event with no target must not throw");
  assert.equal(guard.eventInLayerAbove({ target: {} }), false, "a target with no closest() must not throw");
});

test("layerAboveOpen reports whether a layer is currently stacked above", () => {
  const ctx = makeContext();
  assert.equal(ctx.window.DCC.overlay.layerAboveOpen(), false);
  ctx.document.querySelector = (sel) => (sel === '[data-dcc-layer="above"]' ? {} : null);
  assert.equal(ctx.window.DCC.overlay.layerAboveOpen(), true);
});

// ── the marker on the picker's own overlay ──────────────────────────────────
test("the shared picker marks its overlay while open and unmarks it on close", () => {
  const ENSURE = mustSlice(PICKER_SRC, /^ {2}function ensureOverlay\(\) \{[\s\S]*?\n {2}\}/m, "time-picker ensureOverlay");
  const OPEN = mustSlice(PICKER_SRC, /^ {2}function open\(anchor, closeCb\) \{[\s\S]*?\n {2}\}/m, "time-picker open");
  const CLOSE = mustSlice(PICKER_SRC, /^ {2}function close\(\) \{[\s\S]*?\n {2}\}/m, "time-picker close");
  const ctx = makeContext();
  vm.runInContext(
    "var overlay=null,card=null,onClose=null;function position(){}" +
    ENSURE + OPEN + CLOSE +
    "window.__tp={open:open,close:close,peek:function(){return overlay}};",
    ctx
  );
  vm.runInContext("window.__tp.open(null,null)", ctx);
  const overlay = ctx.window.__tp.peek();
  assert.equal(overlay.getAttribute("data-dcc-layer"), "above",
    "without the marker every outside-click guard passes the calendar through as 'outside'");
  assert.equal(overlay.classList.contains("open"), true);
  vm.runInContext("window.__tp.close()", ctx);
  assert.equal(overlay.getAttribute("data-dcc-layer"), null,
    "a closed overlay must stop suppressing dismissal, or the popover can never be clicked away");
});

// ── the popover ─────────────────────────────────────────────────────────────
test("a day picked in the calendar survives the outside-click listener", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  assert.equal(pop.removed, undefined, "sanity: the popover is open");
  ctx.document.fire("click", inLayer());
  assert.equal(pop.removed, undefined,
    "clicking a calendar day must NOT close the popover — this is the reported bug");
});

test("a click truly outside still closes the popover", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  ctx.document.fire("click", outside());
  assert.equal(pop.removed, true, "the popover contract is still close-on-outside");
});

test("Escape goes to the calendar first, then to the popover", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  ctx.document.querySelector = (sel) => (sel === '[data-dcc-layer="above"]' ? {} : null);
  ctx.document.fire("keydown", { key: "Escape" });
  assert.equal(pop.removed, undefined, "the first Escape belongs to the open calendar");
  ctx.document.querySelector = () => null;      // the picker closed itself
  ctx.document.fire("keydown", { key: "Escape" });
  assert.equal(pop.removed, true, "the second Escape closes the popover");
});

test("picking a date advances to the shared placement step", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  const dateInput = pop.querySelector(".resched-date-input");
  assert.ok(dateInput, "the date field is what time-picker.js enhances into the chip");
  // Exactly what the enhanced chip does after a day cell is clicked.
  dateInput.value = "2026-09-11";
  dateInput.dispatchEvent({ type: "change" });
  assert.deepEqual(ctx._moves, [{ id: "t1", dateStr: "2026-09-11" }],
    "the pick itself must reach moveTaskViaPlacement — THE canonical mover, which opens " +
    "the Earliest free / 8 AM / 5 PM placement step");
  assert.equal(pop.removed, true, "the popover hands off and closes");
});

test("an unparseable date commits nothing", async () => {
  const errors = [];
  const ctx = makeContext({ showToast: (msg, kind) => errors.push([msg, kind]) });
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  const dateInput = pop.querySelector(".resched-date-input");
  dateInput.value = "not-a-date";
  dateInput.dispatchEvent({ type: "change" });
  assert.deepEqual(ctx._moves, []);
  assert.equal(pop.removed, undefined, "a rejected value leaves the popover open to try again");
  assert.deepEqual(errors, [["Pick a valid date", "error"]]);
});

test("pick mode hands the picked date to its own writer", async () => {
  const ctx = makeContext();
  const picked = [];
  ctx.__onPick = (dateStr, timeStr) => { picked.push([dateStr, timeStr]); };
  const { pop } = await openPopover(ctx, {
    mode: "pick", view: "date", header: 'Move "x" to…', actionLabel: "Move"
  });
  const dateInput = pop.querySelector(".resched-date-input");
  // openSchedulePopover captured __cfg by reference, so attaching onPick here is
  // the same object the popover holds.
  ctx.__cfg.onPick = ctx.__onPick;
  dateInput.value = "2026-10-01";
  dateInput.dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(picked, [["2026-10-01", null]],
    "catch-up / unfinished rows own their own write and must still receive the date");
});

test("picking a time pins the start in one gesture", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "time" });
  const timeInput = pop.querySelector(".resched-time-input");
  assert.ok(timeInput);
  assert.equal(timeInput.value, "09:15", "seeded from the task, and a seed must not fire change");
  assert.deepEqual(ctx._pinned, []);
  timeInput.value = "14:30";
  timeInput.dispatchEvent({ type: "change" });
  assert.deepEqual(ctx._pinned, [{ id: "t1", v: "14:30" }],
    "the wheel already has its own Set button; a second confirm here was unreachable anyway");
  assert.equal(pop.removed, true);
});

test("no second confirm button in the date or time rows", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "both" });
  assert.ok(!/resched-go/.test(pop.innerHTML),
    "a Move button restores the two-step gesture Drake reported as broken, and nothing " +
    "else would fail if it came back");
  assert.ok(!/resched-time-go/.test(pop.innerHTML), "same for Set time");
  assert.ok(/resched-btn/.test(pop.innerHTML), "Today / Tomorrow are still there");
});

test("the date chip starts unset instead of showing a day nobody chose", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "reschedule", id: "t1", view: "date" });
  assert.equal(pop.querySelector(".resched-date-input").value, "",
    "a seeded value made the chip read like a selection (\"Fri, Sep 4\") that no one picked");
});

// ── the two fields that must not commit out from under each other ──────────
// Regression guard. pick + allowTime is the one configuration with a SECOND
// field, and its time is only ever staged (pickDay reads it at commit time).
// While the time row rendered BELOW the day row, a user working top to bottom
// picked the day first, committed with timeStr null, and watched the time chip
// they were reaching for vanish. Both allowTime callers consume that argument
// (schedule-tab.js _unfSchedulePopover, meeting-automation.js scheduleRecapAction),
// so the drop landed a carryover or a recap action with no start.
test("pick mode with allowTime commits the staged start time", async () => {
  const ctx = makeContext();
  const picked = [];
  const { pop } = await openPopover(ctx, { mode: "pick", allowTime: true, header: 'Move "x" to…' });
  ctx.__cfg.onPick = (dateStr, timeStr) => { picked.push([dateStr, timeStr]); };

  const timeInput = pop.querySelector(".resched-time-input");
  assert.ok(timeInput, "allowTime renders a bare time field");
  timeInput.value = "14:00";                 // staged, exactly as the wheel leaves it

  const dateInput = pop.querySelector(".resched-date-input");
  dateInput.value = "2026-10-01";
  dateInput.dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(picked, [["2026-10-01", "14:00"]],
    "the day pick must carry the time the user already set, not null");
});

test("pick mode with allowTime still allows no time at all", async () => {
  const ctx = makeContext();
  const picked = [];
  const { pop } = await openPopover(ctx, { mode: "pick", allowTime: true });
  ctx.__cfg.onPick = (dateStr, timeStr) => { picked.push([dateStr, timeStr]); };
  const dateInput = pop.querySelector(".resched-date-input");
  dateInput.value = "2026-10-02";
  dateInput.dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(picked, [["2026-10-02", null]],
    "onPick's second arg is documented nullable; skipping the time is a real choice");
});

test("the pick-mode time row renders above the day row", async () => {
  const ctx = makeContext();
  const { pop } = await openPopover(ctx, { mode: "pick", allowTime: true });
  const html = pop.innerHTML;
  const time = html.indexOf("resched-time-only");
  const day = html.indexOf("resched-quick");
  assert.ok(time > -1 && day > -1, "both rows render");
  assert.ok(time < day,
    "order IS the fix: every day affordance commits on the pick, so the staged " +
    "time has to sit above them or a top-to-bottom user loses it");
});

// ── the shared controller applies its own rule ─────────────────────────────
// core-ui.js defines the nested-layer rule, and its Escape handler is registered
// capture-phase for EVERY kind -- the blocking kinds never register onOutside at
// all. Without the guard, one Escape aimed at a sub-picker tore down the host
// drawer, sheet or modal and its unsaved edits (day-review.js's time editor and
// the glymphatic brief both render an <input type="time"> into an overlay body).
test("core-ui's Escape defers to a layer above before closing itself", () => {
  const ONKEY = mustSlice(CORE_UI_SRC, /^ {4}function onKey\(event\) \{[\s\S]*?\n {4}\}/m, "core-ui onKey");
  const ctx = makeContext();
  vm.runInContext(
    "(function(){" + LAYER_CONST + LAYER_OPEN +
    "var blocking=true,panel={contains:function(){return false},focus:function(){},querySelectorAll:function(){return []}};" +
    "window.__closes=0;window.__prevented=0;" +
    "function close(){window.__closes++}function goBack(){return false}" +
    "function visibleFocusable(){return []}" +
    ONKEY + "window.__onKey=onKey;})();",
    ctx
  );
  const esc = () => ({ key: "Escape", preventDefault() { ctx.window.__prevented++; } });

  ctx.document.querySelector = (sel) => (sel === '[data-dcc-layer="above"]' ? {} : null);
  ctx.window.__onKey(esc());
  assert.equal(ctx.window.__closes, 0, "the first Escape belongs to the open sub-picker");
  assert.equal(ctx.window.__prevented, 0, "and must not be swallowed, or the picker never sees it");

  ctx.document.querySelector = () => null;      // the picker closed itself
  ctx.window.__onKey(esc());
  assert.equal(ctx.window.__closes, 1, "with no layer above, Escape closes the overlay as before");
});

// ── the second surface with the same shape ──────────────────────────────────
// Run the real closure, not a regex over it: a source match still passes when
// the guard's condition has been neutered (a `&& false` left the string
// "eventInLayerAbove" sitting in an inert branch and the assertion never
// noticed). Driving the function is what makes this test able to fail.
test("the slots winnings menu keeps its own guard", () => {
  const guard = mustSlice(SLOTS_SRC, /^ {4}function onOutside\(e\)\{[\s\S]*?\n {4}\}/m, "slots winnings onOutside");
  const ctx = makeContext();
  vm.runInContext(
    "var menu={contains:function(n){return n&&n.inMenu===true}};" +
    "var anchor={contains:function(){return false}};" +
    "window.__closes=0;function close(){window.__closes++}" +
    guard + "window.__onOutside=onOutside;",
    ctx
  );
  const fire = (event) => ctx.window.__onOutside(event);

  fire(outside());
  assert.equal(ctx.window.__closes, 1, "a real outside click still dismisses the menu");

  fire(inLayer());
  assert.equal(ctx.window.__closes, 1,
    "its two custom-range date chips open the same overlay — a pick used to close the menu " +
    "and strand the value on a detached input");

  fire({ target: { inMenu: true, closest: () => null } });
  assert.equal(ctx.window.__closes, 1, "a click on the menu itself is not outside either");
});
