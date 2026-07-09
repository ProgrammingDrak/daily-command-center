// Contract tests for public/js/meeting-alerts.js (the T-5 pulse / T-2 toast on
// the 1s clock tick). Harness pattern mirrors recalc-times.test.js: raw source
// in a node:vm context with stubbed globals + a minimal fake DOM/localStorage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/meeting-alerts.js"), "utf8");
const TODAY = new Date().toISOString().slice(0, 10);

// Minimal element: a class Set + dataset; querySelector is unused in these paths.
function makeEl(id, kind) {
  const classes = new Set([kind]);
  return {
    dataset: { id },
    _classes: classes,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelector: () => null,
    has: (c) => classes.has(c),
  };
}

function makeHarness(opts = {}) {
  const els = opts.els || [];
  const toasts = [];
  const store = opts.localStore || {};
  const document = {
    querySelectorAll(sel) {
      const m = sel.match(/\[data-id="(.*)"\]/);
      if (m) return els.filter((e) => String(e.dataset.id) === m[1]);
      if (sel.indexOf("meeting-soon") !== -1) return els.filter((e) => e.has("meeting-soon"));
      return [];
    },
  };
  const context = {
    console,
    Number, JSON, Set, Array, Date, String, Math,
    document,
    window: {
      __state: { date: opts.date || TODAY },
      CSS: { escape: (s) => s },
      DCC: { toast: (message, type, duration, action) => toasts.push({ message, type, duration, action }) },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    scheduled: opts.scheduled || [],
    pt: (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; },
    now: () => (opts.nowMin != null ? opts.nowMin : 600),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
  };
  context.window.scheduled = context.scheduled;
  // module reads window.scheduled AND bare scheduled; keep them the same ref
  Object.defineProperty(context, "scheduledRef", { value: context.scheduled });
  vm.createContext(context);
  vm.runInContext(src, context);
  // meeting-alerts reads window.scheduled
  context.window.scheduled = context.scheduled;
  return { context, toasts, store, tick: () => context.window.meetingAlertTick() };
}

const meetingAt = (id, hhmm, extra) => Object.assign({ id, title: id, type: "meeting", start: hhmm, end: hhmm }, extra);

test("pulse: meeting within 5 min gets .meeting-soon; 7 min out does not", () => {
  const soon = makeEl("m4", "card");   // 10:04, 4 min out
  const far = makeEl("m7", "card");    // 10:07, 7 min out
  const h = makeHarness({
    nowMin: 600,
    els: [soon, far],
    scheduled: [meetingAt("m4", "10:04"), meetingAt("m7", "10:07")],
  });
  h.tick();
  assert.equal(soon.has("meeting-soon"), true);
  assert.equal(far.has("meeting-soon"), false);
});

test("pulse clears once the meeting passes the 5-min window", () => {
  const el = makeEl("m", "card");
  const sched = [meetingAt("m", "10:04")];
  const h = makeHarness({ nowMin: 600, els: [el], scheduled: sched });
  h.tick();
  assert.equal(el.has("meeting-soon"), true);
  sched[0].start = "10:20"; // meeting moved far out
  h.tick();
  assert.equal(el.has("meeting-soon"), false);
});

test("alert fires once at T-2 and does not re-fire on the next tick", () => {
  const h = makeHarness({ nowMin: 600, els: [makeEl("m2", "card")], scheduled: [meetingAt("m2", "10:02", { hangout_link: "https://meet.example/x" })] });
  h.tick();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /Meeting in 2 min: m2/);
  assert.equal(h.toasts[0].action.label, "Join"); // hangout link -> Join button
  h.tick();
  assert.equal(h.toasts.length, 1); // fire-once
});

test("alert re-arms when the meeting's start changes (drag / calendar re-sync)", () => {
  const sched = [meetingAt("m", "10:02")];
  const h = makeHarness({ nowMin: 600, els: [makeEl("m", "card")], scheduled: sched });
  h.tick();
  assert.equal(h.toasts.length, 1);
  sched[0].start = "10:01"; // moved -> new fire key
  h.tick();
  assert.equal(h.toasts.length, 2);
});

test("fired alerts persist across reload (same localStorage -> no re-fire)", () => {
  const store = {};
  const a = makeHarness({ nowMin: 600, els: [makeEl("m2", "card")], scheduled: [meetingAt("m2", "10:02")], localStore: store });
  a.tick();
  assert.equal(a.toasts.length, 1);
  // Fresh harness, same backing store = a page refresh.
  const b = makeHarness({ nowMin: 600, els: [makeEl("m2", "card")], scheduled: [meetingAt("m2", "10:02")], localStore: store });
  b.tick();
  assert.equal(b.toasts.length, 0);
});

test("meetings already well underway do not fire a late alert", () => {
  const h = makeHarness({ nowMin: 600, els: [makeEl("m", "card")], scheduled: [meetingAt("m", "09:50")] }); // started 10 min ago
  h.tick();
  assert.equal(h.toasts.length, 0);
});

test("not viewing today: no pulse, no alert", () => {
  const el = makeEl("m2", "card");
  const h = makeHarness({ date: "2020-01-01", nowMin: 600, els: [el], scheduled: [meetingAt("m2", "10:02")] });
  h.tick();
  assert.equal(el.has("meeting-soon"), false);
  assert.equal(h.toasts.length, 0);
});

test("done / deleted meetings are ignored", () => {
  const el1 = makeEl("d", "card"), el2 = makeEl("x", "card");
  const h = makeHarness({
    nowMin: 600, els: [el1, el2],
    scheduled: [meetingAt("d", "10:02", { done: true }), meetingAt("x", "10:02", { deleted: true })],
  });
  h.tick();
  assert.equal(h.toasts.length, 0);
  assert.equal(el1.has("meeting-soon"), false);
});
