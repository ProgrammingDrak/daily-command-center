// Contract tests for the pet courier (public/js/pet-courier.js): the pet runs in
// with an envelope when a sweep drops new triage items, then the catch-up modal
// opens on what arrived.
//
// What these pin, in order of how badly each would hurt:
//   1. the trigger is an ID DIFF against a day_root-backed seen set, NOT the SSE
//      source string — sse.js defers refreshes while Drake types and its retry
//      carries no event, so a source-gated trigger would skip the deferred case
//   2. it fires ONCE per arrival: the ids are banked before delivery, so a second
//      SSE tick (there are many) cannot re-summon the pet
//   3. what the morning prompt already showed is not an "arrival"
//   4. it does not yank a modal over a half-typed note — the envelope waits as a
//      chip, and the chip still opens it
//   5. the modal opens AFTER the run, so the envelope lands before the list appears
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const courierSource = fs.readFileSync(require.resolve("./public/js/pet-courier.js"), "utf8");

// ── a DOM just big enough for a body-level animated element ──
function FakeEl(tag, onUnmount) {
  const el = {
    tag, id: "", className: "", innerHTML: "", textContent: "",
    children: [], _on: {}, _removed: false,
    style: { setProperty(k, v) { this[k] = v; } },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    offsetWidth: 0,
    setAttribute(k, v) { el[k] = v; },
    addEventListener(ev, fn) { (el._on[ev] = el._on[ev] || []).push(fn); },
    fire(ev, arg) { (el._on[ev] || []).slice().forEach(fn => fn(arg || { target: el })); },
    appendChild(c) { el.children.push(c); return c; },
    querySelector(sel) {
      if (!el._q) el._q = new Map();
      if (!el._q.has(sel)) el._q.set(sel, FakeEl("span"));
      return el._q.get(sel);
    },
    remove() { el._removed = true; if (onUnmount) onUnmount(el); }
  };
  return el;
}

// The runner itself, not the dust it kicks up or the envelope it drops — those are
// pet-courier-* siblings and a prefix match would count all of them.
const isRunner = (el) => String(el.className || "").split(/\s+/).indexOf("pet-courier") > -1;

// `opts`: {reducedMotion, hidden, editing, modalOpen, triageSection, seen, items}
function load(opts) {
  opts = opts || {};
  const byId = new Map();
  const appended = [];          // everything that reached <body>, in order
  const events = [];            // ordering log: what happened when
  const saved = Object.prototype.hasOwnProperty.call(opts, "seen")
    ? (opts.seen === null ? {} : { _triageCourierSeen: opts.seen })
    : { _triageCourierSeen: [] };
  const unmount = (el) => { if (el.id) byId.delete(el.id); };

  const doc = {
    hidden: !!opts.hidden,
    activeElement: opts.editing ? { tagName: "TEXTAREA" } : null,
    body: {
      appendChild(el) {
        appended.push(el);
        if (el.id) byId.set(el.id, el);
        if (isRunner(el)) events.push("ran");
        return el;
      }
    },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return FakeEl(tag, unmount); },
    addEventListener() {}
  };
  if (opts.triageSection) {
    const sec = FakeEl("section", unmount);
    sec.id = "schedule-triage-section";
    sec.getBoundingClientRect = () => ({ left: 100, top: 200, right: 500, bottom: 260, width: 400, height: 60 });
    byId.set("schedule-triage-section", sec);
  }

  const items = (opts.items || []).slice();
  const opened = [];
  const ctx = {
    console, document: doc, setTimeout, clearTimeout,
    innerWidth: 1200, innerHeight: 800,
    matchMedia: () => ({ matches: !!opts.reducedMotion }),
    activeTriageItems: () => items.slice(),
    _bsProp: (k) => (Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : null),
    _bsSaveProp: (k, v) => { saved[k] = v; },
    _anyModalOpen: () => !!opts.modalOpen,
    PetHome: { identity: async () => ({ name: "Mochi", base: "sprout", color: "#abc", glyph: "S", accessory: "" }) }
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // DCC.esc comes from core.js in the browser; the courier only uses it for the
  // pet's own glyph, so a minimal stand-in keeps this file about the courier.
  ctx.DCC = { esc: (s) => String(s == null ? "" : s) };
  ctx.DCC.CatchUp = {
    openArrivals: async (ids) => {
      events.push("opened");
      opened.push(Array.from(ids));
      return opts.openFails ? false : true;
    }
  };
  vm.runInContext(courierSource, ctx);
  return { ctx, saved, opened, appended, events, items, chip: () => byId.get("pet-courier-chip") || null };
}

const item = (id) => ({ id, title: "Reply to " + id });

// ─────────────────────────── the pure diff ───────────────────────────
test("_newTriageIds returns only ids that have never been shown", () => {
  const { ctx } = load({});
  // Array.from: the module runs in a vm realm, so the arrays it returns have a
  // different Array.prototype and deepStrictEqual would reject them on identity.
  const f = (a, b) => Array.from(ctx.window.DCC.TriageCourier._newTriageIds(a, b));
  assert.deepEqual(f(["a"], ["a", "b", "c"]), ["b", "c"]);
  assert.deepEqual(f(["a", "b", "c"], ["a", "b", "c"]), [], "nothing new means no delivery");
  assert.deepEqual(f([], ["a"]), ["a"]);
  // Non-arrays are the "no baseline yet" and "triage never loaded" cases.
  assert.deepEqual(f(null, ["a"]), []);
  assert.deepEqual(f(["a"], null), []);
});

// ─────────────────────────── delivery ───────────────────────────
test("a new triage item is banked and delivered", async () => {
  const h = load({ reducedMotion: true, items: [item("m1")] });
  const shown = await h.ctx.window.notifyTriageArrivals();
  assert.equal(shown, true);
  assert.deepEqual(h.opened, [["m1"]], "the modal opens on exactly what arrived");
  assert.deepEqual(Array.from(h.saved._triageCourierSeen), ["m1"], "and the id is banked on the day_root");
});

test("the pet runs ONCE per arrival, not once per SSE tick", async () => {
  const h = load({ reducedMotion: true, items: [item("m1")] });
  await h.ctx.window.notifyTriageArrivals();
  await h.ctx.window.notifyTriageArrivals();
  await h.ctx.window.notifyTriageArrivals();
  assert.equal(h.opened.length, 1, "refreshDccState fires on every state change; this must not");
});

test("what the morning prompt already showed is not an arrival", async () => {
  const h = load({ reducedMotion: true, items: [item("m1"), item("m2")] });
  // This is what catch-up.js initCatchUp does at boot.
  h.ctx.window.DCC.TriageCourier.markSeen(["m1", "m2"]);
  const shown = await h.ctx.window.notifyTriageArrivals();
  assert.equal(shown, false);
  assert.equal(h.opened.length, 0, "the pet must not sprint in at page load");
});

test("only the NEW item is delivered when it lands beside older ones", async () => {
  const h = load({ reducedMotion: true, seen: ["old1"], items: [item("old1"), item("new1")] });
  await h.ctx.window.notifyTriageArrivals();
  assert.deepEqual(h.opened, [["new1"]]);
  assert.deepEqual(Array.from(h.saved._triageCourierSeen), ["old1", "new1"]);
});

test("no baseline yet: establish one, deliver nothing", async () => {
  // _bsProp returns null both before the day_root exists and before anything has
  // been banked on it. Reading either as "all new" means the pet sprints in on a
  // cold load carrying the whole mailbox.
  const h = load({ reducedMotion: true, seen: null, items: [item("m1")] });
  assert.equal(await h.ctx.window.notifyTriageArrivals(), false);
  assert.equal(h.opened.length, 0, "what was already sitting there is not an arrival");
  assert.deepEqual(Array.from(h.saved._triageCourierSeen), ["m1"], "but it IS now the baseline");
  // And the next genuinely new item does get delivered.
  h.items.push(item("m2"));
  assert.equal(await h.ctx.window.notifyTriageArrivals(), true);
  assert.deepEqual(h.opened, [["m2"]]);
});

// ─────────────────────────── not now ───────────────────────────
for (const [label, opts] of [
  ["mid-sentence", { editing: true }],
  ["with a modal open", { modalOpen: true }],
  ["on a hidden tab", { hidden: true }]
]) {
  test("the envelope waits as a chip " + label, async () => {
    const h = load(Object.assign({ reducedMotion: true, items: [item("m1")] }, opts));
    const shown = await h.ctx.window.notifyTriageArrivals();
    assert.equal(shown, false);
    assert.equal(h.opened.length, 0, "never yank a modal over what Drake is doing");
    const chip = h.chip();
    assert.ok(chip, "but the envelope is still reachable");
    assert.equal(chip.querySelector(".pet-courier-chip-count").textContent, "1");
    assert.deepEqual(Array.from(h.saved._triageCourierSeen), ["m1"], "banked, so the pet won't re-run for it");
  });
}

test("clicking the waiting chip opens the modal and clears the chip", async () => {
  const h = load({ reducedMotion: true, editing: true, items: [item("m1")] });
  await h.ctx.window.notifyTriageArrivals();
  h.chip().fire("click");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(h.opened, [["m1"]]);
  assert.equal(h.chip(), null, "the envelope has been opened");
});

test("a delivery that could not be shown keeps the chip and the ids pending", async () => {
  const h = load({ reducedMotion: true, items: [item("m1")], openFails: true });
  const shown = await h.ctx.window.notifyTriageArrivals();
  assert.equal(shown, false);
  assert.ok(h.chip(), "the arrival is not lost just because the modal declined to open");
});

// ─────────────────────────── the run ───────────────────────────
test("reduced motion delivers without ever animating", async () => {
  const h = load({ reducedMotion: true, items: [item("m1")] });
  await h.ctx.window.notifyTriageArrivals();
  assert.equal(h.appended.some(isRunner), false,
    "no runner element at all");
  assert.deepEqual(h.opened, [["m1"]], "the envelope still arrives");
});

test("the pet runs, and the modal opens only after it has", async () => {
  const h = load({ items: [item("m1")], triageSection: true });
  await h.ctx.window.notifyTriageArrivals();
  assert.deepEqual(h.events, ["ran", "opened"],
    "the envelope has to land before the list it explains appears");
  const pet = h.appended.find(isRunner);
  assert.ok(pet, "a body-level runner is used — the slots one is gated to its own tab");
  assert.match(pet.innerHTML, /pet-courier-envelope/, "carrying the envelope");
  assert.equal(pet._removed, true, "and it cleans itself up when it leaves");
});
