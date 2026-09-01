// Contract tests for the anytime nudge (public/js/pet-nudge.js): the pet runs in
// when a window is running down and the target is unmet.
//
// What these pin, in order of how badly each would hurt:
//   1. the nudge is BANKED BEFORE it is delivered — the tick fires every minute,
//      so an ignored or failed delivery must not re-summon the pet 60s later
//   2. it never reads or writes state while a day other than today is on screen
//      (_bsProp addresses the VIEWED day, so it would stamp the wrong root)
//   3. windows are settled on EVERY tick, due or not, or a lapsed window that
//      nobody watched never records its miss
//   4. it does not animate over a half-typed note: busy degrades to a toast that
//      carries the same message and a way in
//   5. reduced motion skips the run and still delivers
//   6. the checklist opens AFTER the run, so the pet arrives before the list
//   7. an already-open checklist IS the nudge: stamp the cadence, skip the theatre
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/pet-nudge.js"), "utf8");

// ── a DOM just big enough for a body-level animated element ──
function FakeEl(tag, onUnmount) {
  const el = {
    tag, id: "", className: "", innerHTML: "", textContent: "",
    children: [], _on: {}, _removed: false,
    style: {
      setProperty(k, v) { this[k] = v; },
      left: "", top: "", transitionDuration: ""
    },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }
    },
    offsetWidth: 0,
    setAttribute(k, v) { el[k] = v; },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    fire(ev, arg) { (el._on[ev] || []).slice().forEach(fn => fn(arg || { target: el })); },
    appendChild(c) { el.children.push(c); return c; },
    remove() { el._removed = true; if (onUnmount) onUnmount(el); }
  };
  return el;
}

const isRunner = el => String(el.className || "").split(/\s+/).indexOf("pet-courier") > -1;

// `opts`: {due, defs, viewMode, busy, reducedMotion, panelOpen, noStore}
function load(opts) {
  opts = opts || {};
  const log = [];                  // ordering: what happened, in sequence
  const pending = [];              // timers longer than the run itself (the bubble linger)
  const byId = new Map();
  const appended = [];
  const stamped = [];
  const settled = [];

  const unmount = el => { if (el.id) byId.delete(el.id); };
  const doc = {
    _on: {},
    body: { appendChild(el) { appended.push(el); if (el.id) byId.set(el.id, el); return el; } },
    createElement: tag => FakeEl(tag, unmount),
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    addEventListener(ev, fn) { (doc._on[ev] = doc._on[ev] || []).push(fn); },
    get hidden() { return false; },
    get activeElement() { return null; }
  };

  const defs = opts.defs || [{ id: "d1", title: "Water", target: 3, nudgeEveryMin: 30 }];
  const due = (opts.due || []).map(d => ({
    def: d.def || defs[0],
    progress: d.progress || { n: 1, target: 3, remaining: 2, done: false }
  }));

  const store = {
    list: () => defs,
    context: () => ({ nowMs: 1000, minutesOfDay: 600, dayStartMin: 420, dowIndex: 5, todayStr: "2026-08-28" }),
    onTodayView: () => (opts.viewMode || "today") === "today",
    settle: (d, c) => { settled.push(c); log.push("settle"); return []; },
    readState: () => ({}),
    dueNudges: () => due,
    stampNudge: (ids, iso) => { stamped.push({ ids, iso }); log.push("stamp"); return true; }
  };

  const dock = {
    _open: !!opts.panelOpen,
    _pulse: false,
    isOpen() { return this._open; },
    open() { this._open = true; log.push("open-panel"); },
    setPulse(on) { this._pulse = !!on; log.push("pulse:" + (on ? "on" : "off")); },
    anchorPoint: () => ({ x: 900, y: 700 })
  };

  const toasts = [];
  const live = { busy: !!opts.busy };
  const win = {
    innerWidth: 1000, innerHeight: 800,
    DCC: {
      esc: s => String(s == null ? "" : s),
      Anytime: opts.noStore ? null : store,
      AnytimeDock: dock,
      reducedMotion: () => !!opts.reducedMotion,
      busyElsewhere: () => live.busy,
      toast: (msg, type, dur, action) => { toasts.push({ msg, type, dur, action }); log.push("toast"); }
    },
    addEventListener() {},
    buildAnytime: () => log.push("build")
  };
  win.window = win;

  const context = {
    window: win, document: doc, console: { warn() {}, log() {} },
    // Collapse the RUN's timers (200-620ms legs) so the ~1.7s animation completes
    // inside the test and the ORDERING (pet first, panel second) is observable.
    // Long timers are held instead: the bubble's 7s linger has NOT elapsed while
    // the run is finishing, and collapsing it would delete the bubble the busy
    // path depends on. `pending` lets a test fire them deliberately.
    setTimeout: (fn, ms) => {
      if (Number(ms) >= 3000) { pending.push(fn); return pending.length; }
      Promise.resolve().then(() => { log.push("tick"); fn(); });
      return 1;
    },
    clearTimeout: () => {},
    Promise, Math, Date, String, Number, Array, Object, JSON, parseFloat, Set,
    requestAnimationFrame: fn => fn()
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    tick: () => win.anytimeNudgeTick(),
    api: () => win.DCC.AnytimeNudge,
    log, appended, stamped, settled, toasts, dock, byId,
    setBusy: v => { live.busy = !!v; },
    firePending: () => { const q = pending.splice(0); q.forEach(fn => fn()); },
    runners: () => appended.filter(isRunner),
    bubbles: () => appended.filter(el => el.id === "pet-nudge-bubble" && !el._removed),
    // The run awaits a chain of collapsed timers; drain the microtask queue.
    settleAsync: async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); }
  };
}

const oneDue = [{ progress: { n: 1, target: 3, remaining: 2, done: false } }];

// ── 1. bank before deliver ──

test("the nudge is stamped BEFORE the pet is sent", async () => {
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  assert.equal(h.stamped.length, 1, "stamped once");
  assert.deepEqual(h.stamped[0].ids, ["d1"]);
  assert.ok(h.log.indexOf("stamp") < h.log.indexOf("pulse:on"),
    "the stamp lands before any delivery begins");
});

test("a second tick in the same window does not re-summon the pet", async () => {
  // The store is what remembers; once stamped, dueNudges stops returning it.
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  const runsAfterFirst = h.runners().length;
  assert.equal(runsAfterFirst, 1);
  // A run still in flight is refused outright, which is the in-tick half of the guard.
  const h2 = load({ due: oneDue });
  h2.tick();
  h2.tick();
  await h2.settleAsync();
  assert.equal(h2.runners().length, 1, "a tick landing mid-run does not start a second pet");
});

// ── 2. never touch another day ──

test("nothing is read, stamped, or settled while another day is on screen", () => {
  ["tomorrow", "future", "archive"].forEach(mode => {
    const h = load({ due: oneDue, viewMode: mode });
    assert.equal(h.tick(), false, mode + " must bail");
    assert.deepEqual(h.stamped, [], "no stamp on " + mode);
    assert.deepEqual(h.settled, [], "no settle on " + mode);
    assert.equal(h.runners().length, 0, "no pet on " + mode);
  });
});

// ── 3. settle every tick ──

test("windows are settled even when nothing is due", () => {
  const h = load({ due: [] });
  assert.equal(h.tick(), false, "nothing to deliver");
  assert.equal(h.settled.length, 1, "but the lapsed window still got closed");
  assert.ok(h.log.indexOf("build") > -1, "and the dock still refreshed");
});

test("no definitions means no work at all", () => {
  const h = load({ defs: [], due: oneDue });
  assert.equal(h.tick(), false);
  assert.deepEqual(h.settled, []);
});

test("a missing store is survived, not thrown through", () => {
  const h = load({ noStore: true, due: oneDue });
  assert.doesNotThrow(() => h.tick());
  assert.equal(h.tick(), false);
});

// ── 4. busy degrades to a toast ──

test("busy elsewhere: no pet, a toast with a way in, and the dock keeps pulsing", async () => {
  const h = load({ due: oneDue, busy: true });
  h.tick();
  await h.settleAsync();
  assert.equal(h.runners().length, 0, "nothing animated over the note");
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].msg, /Water 1\/3/);
  assert.equal(h.toasts[0].action.label, "Open");
  assert.equal(h.dock._pulse, true, "the pill still says something is waiting");
  assert.equal(h.dock._open, false, "and the panel was NOT yanked open");
  assert.deepEqual(h.stamped.length, 1, "the cadence still advanced");
});

test("the toast's Open button opens the checklist", async () => {
  const h = load({ due: oneDue, busy: true });
  h.tick();
  await h.settleAsync();
  h.toasts[0].action.onClick();
  assert.equal(h.dock._open, true);
});

// ── 5. reduced motion ──

test("reduced motion delivers without ever animating", async () => {
  const h = load({ due: oneDue, reducedMotion: true });
  h.tick();
  await h.settleAsync();
  assert.equal(h.runners().length, 0, "no run");
  assert.equal(h.toasts.length, 1, "but the nudge still landed");
  assert.equal(h.stamped.length, 1);
});

// ── 6. the run, and what follows it ──

test("the pet runs, and the checklist opens only after it has", async () => {
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  assert.equal(h.runners().length, 1, "one runner, not one per leg");
  const runner = h.runners()[0];
  assert.equal(runner._removed, true, "the pet leaves");
  assert.ok(h.log.indexOf("pulse:on") < h.log.indexOf("open-panel"),
    "the pill flags it before the panel opens");
  assert.ok(h.log.indexOf("tick") < h.log.indexOf("open-panel"),
    "the panel opens after the run's timers, not before");
  assert.equal(h.dock._open, true);
});

test("the pet says what is outstanding, and the bubble opens the list", async () => {
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  const bubble = h.appended.filter(el => el.id === "pet-nudge-bubble")[0];
  assert.ok(bubble, "a bubble was raised");
  assert.match(bubble.innerHTML, /Water 1\/3/);
  assert.match(bubble.innerHTML, /forget/i);
  h.dock._open = false;
  bubble.fire("click");
  assert.equal(h.dock._open, true, "clicking the bubble opens the checklist");
});

test("going busy DURING the run holds the panel shut", async () => {
  const h = load({ due: oneDue });
  h.tick();
  // The pet is mid-screen and Drake clicks into a note. deliver() re-reads
  // busyElsewhere() after the run for exactly this moment; opening a panel over
  // a half-typed note is the one behaviour that makes this a feature to disable.
  h.setBusy(true);
  await h.settleAsync();
  assert.equal(h.runners().length, 1, "the run it already started still finished");
  assert.equal(h.dock._open, false, "but the checklist was NOT opened over the note");
  assert.equal(h.dock._pulse, true, "the pill still carries the reminder");
  assert.equal(h.bubbles().length, 1, "and the bubble is still there to click");
});

test("staying free through the run opens the checklist", async () => {
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  assert.equal(h.dock._open, true);
});

// ── 7. an open checklist is its own nudge ──

test("an already-open checklist advances the cadence and skips the theatre", () => {
  const h = load({ due: oneDue, panelOpen: true });
  assert.equal(h.tick(), false, "nothing delivered");
  assert.equal(h.stamped.length, 1, "but the cadence advanced, so it will not fire the instant it closes");
  assert.equal(h.runners().length, 0);
  assert.equal(h.toasts.length, 0);
});

// ── the message ──

test("the bubble names at most three items and counts the rest", () => {
  const h = load({});
  const nudgeText = h.api().nudgeText;
  const row = (title, n, target) => ({ def: { title }, progress: { n, target } });

  assert.equal(nudgeText([row("Water", 1, 3)]), "Water 1/3");
  assert.equal(nudgeText([row("Water", 1, 3), row("Pushups", 0, 1)]), "Water 1/3 · Pushups 0/1");
  const five = ["A", "B", "C", "D", "E"].map(t => row(t, 0, 1));
  const text = nudgeText(five);
  assert.equal(text, "A 0/1 · B 0/1 · C 0/1 +2 more");
  assert.equal((text.match(/·/g) || []).length, 2, "three items means two separators");
  assert.equal(nudgeText([]), "");
  assert.equal(nudgeText([{ def: {}, progress: { n: 0, target: 1 } }]), "Something 0/1");
});

test("removeBubble is safe with nothing on screen", () => {
  const h = load({});
  assert.doesNotThrow(() => h.api().removeBubble());
});

test("busy from the start shows a toast and no bubble at all", async () => {
  const h = load({ due: oneDue, busy: true });
  h.tick();
  await h.settleAsync();
  assert.equal(h.bubbles().length, 0);
  assert.equal(h.toasts.length, 1);
});

test("opening the checklist clears the bubble instead of stacking with it", async () => {
  const h = load({ due: oneDue });
  h.tick();
  await h.settleAsync();
  assert.equal(h.dock._open, true);
  assert.equal(h.bubbles().length, 0, "the panel replaces the bubble, it does not sit under it");
});

test("a bubble left behind by a mid-run interruption fades on its own", async () => {
  const h = load({ due: oneDue });
  h.tick();
  h.setBusy(true);            // the only path where the bubble outlives the run
  await h.settleAsync();
  const bubble = h.bubbles()[0];
  assert.ok(bubble, "the bubble is the standing reminder");
  assert.equal(bubble.classList.contains("leaving"), false, "still on screen mid-linger");
  h.firePending();            // the 7s linger elapses
  assert.equal(bubble.classList.contains("leaving"), true,
    "it starts leaving rather than sitting in the corner forever");
});
