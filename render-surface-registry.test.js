// Contract tests for the visibility-aware render registry in public/js/features.js
// (Phase 7). render(scope) resolves through RENDER_SCOPES + _markDirty to decide
// which surfaces rebuild. If a scope ever drops or misnames a surface, the scoped
// call sites (chevron collapse, subtask reorder in schedule-tab.js) would silently
// stop repainting with no error -- and the browser smoke only asserts initial-load
// render, never a scoped re-render. This locks two contracts:
//   1. dirty-MARKING  -- render(scope) -> _markDirty -> which surfaces get flagged
//   2. dirty-CONSUMPTION -- _doRender builds visible+dirty only, clears the flag
//      BEFORE building (so a throw can't strand or loop the rest), and leaves an
//      invisible-but-dirty surface dirty so a tab re-activation rebuilds it. That
//      invisible-stays-dirty rule IS the "no stale surfaces" promise of the phase.
// It also locks the sse.js off-view scoping predicate (_dccEventOffView), the
// decision that skips the heavy day-state refetch for a non-viewed day.
//
// Harness pattern: schedule-tab-shell-exclusion.test.js -- slice the pure pieces
// into a node:vm context. The marking tests never call the isVisible/build thunks;
// the _doRender tests swap SURFACES for instrumented doubles so no DOM is needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
const one = (re) => { const m = src.match(re); if (!m) throw new Error("slice failed: " + re); return m[0]; };
const SURFACES_SLICE = one(/const SURFACES = \{[\s\S]*?\n\};/);
const source = [
  SURFACES_SLICE,
  one(/const RENDER_SCOPES = \{[^\n]*\};/),
  one(/const _dirty = \{\};/),
  one(/function _markDirty\(scope\)\{[\s\S]*?\n\}/),
].join("\n");

// _doRender reads _renderPending (declared elsewhere in features.js) and iterates
// SURFACES/_dirty; slice it on top of `source` with a _renderPending stub so the
// consumption contract can run headless.
const doRenderSource = ["var _renderPending=false;", source, one(/function _doRender\(\)\{[\s\S]*?\n\}/)].join("\n");

function ctx() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}
function doRenderCtx() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(doRenderSource, context);
  return context;
}
const dirtyKeys = (c) => JSON.parse(vm.runInContext("JSON.stringify(Object.keys(_dirty).filter(k=>_dirty[k]))", c)).sort();
const reset = (c) => vm.runInContext("for(const k in _dirty) delete _dirty[k];", c);

test("render('schedule') marks exactly the three schedule sub-view surfaces dirty", () => {
  const c = ctx();
  vm.runInContext("_markDirty('schedule')", c);
  assert.deepEqual(dirtyKeys(c), ["actualView", "listView", "scheduleTimeline"]);
});

test("no-scope render() marks every registered surface dirty", () => {
  const c = ctx();
  vm.runInContext("_markDirty()", c);
  const all = JSON.parse(vm.runInContext("JSON.stringify(Object.keys(SURFACES))", c)).sort();
  assert.deepEqual(dirtyKeys(c), all);
});

test("every RENDER_SCOPES entry names a real SURFACES key (no phantom scope target)", () => {
  const c = ctx();
  const bad = vm.runInContext(
    "JSON.stringify(Object.values(RENDER_SCOPES).flat().filter(n=>!(n in SURFACES)))", c);
  assert.deepEqual(JSON.parse(bad), [], "RENDER_SCOPES references surfaces not in SURFACES");
});

test("an unknown scope string marks nothing (guarded by `n in SURFACES`)", () => {
  const c = ctx();
  vm.runInContext("_markDirty('not-a-real-scope')", c);
  assert.deepEqual(dirtyKeys(c), []);
});

test("an array scope marks only the named surfaces that exist", () => {
  const c = ctx();
  vm.runInContext("_markDirty(['listView','delegated','bogus'])", c);
  assert.deepEqual(dirtyKeys(c), ["delegated", "listView"]);
});

test("the badge-coupled + always-visible surfaces stay registered (regression guard)", () => {
  const c = ctx();
  const keys = JSON.parse(vm.runInContext("JSON.stringify(Object.keys(SURFACES))", c));
  // delegated + meetingAutoPanels were buildSchedule side effects that must remain
  // their own surfaces now that buildSchedule is gated off.
  for (const k of ["delegated", "meetingAutoPanels", "scheduleTriage", "listView", "taskMenusBadge"]) {
    assert.ok(keys.includes(k), "missing surface: " + k);
  }
});

// ---- dirty-CONSUMPTION: _doRender builds visible+dirty only ----
// Each test swaps SURFACES for instrumented doubles (recording build calls, with
// controllable isVisible), sets _dirty, runs the REAL _doRender, then inspects
// what built and which flags remain.
const installDoubles = (c, decls) => vm.runInContext(`
  for(const k in SURFACES) delete SURFACES[k];
  for(const k in _dirty) delete _dirty[k];
  __built = [];
  ${decls}
`, c);
const built = (c) => JSON.parse(vm.runInContext("JSON.stringify(__built)", c));

test("_doRender builds a visible+dirty surface and clears its flag", () => {
  const c = doRenderCtx();
  installDoubles(c, `
    SURFACES.a = { build:()=>{__built.push('a');}, isVisible:()=>true };
    _dirty.a = true;
  `);
  vm.runInContext("_doRender()", c);
  assert.deepEqual(built(c), ["a"]);
  assert.equal(vm.runInContext("_dirty.a === false", c), true);
});

test("_doRender skips an invisible surface and LEAVES it dirty (rebuilds on re-activation = no stale surfaces)", () => {
  const c = doRenderCtx();
  installDoubles(c, `
    SURFACES.hidden  = { build:()=>{__built.push('hidden');},  isVisible:()=>false };
    SURFACES.visible = { build:()=>{__built.push('visible');}, isVisible:()=>true };
    _dirty.hidden = true; _dirty.visible = true;
  `);
  vm.runInContext("_doRender()", c);
  assert.deepEqual(built(c), ["visible"]);          // hidden never built
  assert.equal(vm.runInContext("_dirty.hidden", c), true);  // stays dirty for later
  assert.equal(vm.runInContext("_dirty.visible === false", c), true);
});

test("_doRender does not build a surface that is visible but NOT dirty", () => {
  const c = doRenderCtx();
  installDoubles(c, `
    SURFACES.clean = { build:()=>{__built.push('clean');}, isVisible:()=>true };
    // _dirty.clean left unset
  `);
  vm.runInContext("_doRender()", c);
  assert.deepEqual(built(c), []);
});

test("_doRender: a throwing build clears its OWN flag (no infinite loop) and does not strand later surfaces", () => {
  const c = doRenderCtx();
  installDoubles(c, `
    SURFACES.thrower = { build:()=>{__built.push('thrower'); throw new Error('boom');}, isVisible:()=>true };
    SURFACES.after   = { build:()=>{__built.push('after');},  isVisible:()=>true };
    _dirty.thrower = true; _dirty.after = true;
  `);
  vm.runInContext("_doRender()", c);           // must not throw
  assert.deepEqual(built(c), ["thrower", "after"]);          // later surface still built
  assert.equal(vm.runInContext("_dirty.thrower === false", c), true); // cleared before build -> no loop
  assert.equal(vm.runInContext("_dirty.after === false", c), true);
});

// ---- sse.js off-view scoping predicate ----
// _dccEventOffView decides whether a dcc-state-changed event targets a day other
// than the one on screen (skip the heavy day-state refetch). A regression that
// treats an on-view change as off-view would silently stop the visible day from
// repainting; dropping the viewDate guard would do the heavy work every time.
const sseSrc = fs.readFileSync(require.resolve("./public/js/sse.js"), "utf8");
const offViewFn = (() => {
  const m = sseSrc.match(/function _dccEventOffView\([^)]*\)\{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error("slice failed: _dccEventOffView");
  return m[0];
})();

test("_dccEventOffView is off-view ONLY for an event carrying a different date than viewDate", () => {
  const c = {}; vm.createContext(c);
  vm.runInContext(offViewFn, c);
  const off = (evt, vd) => vm.runInContext(`_dccEventOffView(${JSON.stringify(evt)}, ${JSON.stringify(vd)})`, c);
  assert.equal(off({ date: "2026-07-20" }, "2026-07-11"), true,  "different day -> off-view (skip day-state)");
  assert.equal(off({ date: "2026-07-11" }, "2026-07-11"), false, "same day -> full refresh");
  assert.equal(off({},                     "2026-07-11"), false, "event has no date -> full refresh");
  assert.equal(off({ date: "2026-07-20" }, null),         false, "no viewDate -> full refresh (safe default)");
  assert.equal(off(null,                   "2026-07-11"), false, "no event -> full refresh");
});

// ════════════════════════════════════════════════════════════════════════════════
// C6a: ONE DERIVATION LAYER — the source guard that outlives the phase
// ════════════════════════════════════════════════════════════════════════════════
//
// C6a routed 36 inline `scheduled.filter(...)` predicates across 11 files into
// public/js/task-model.js. The refactor is worth nothing on its own: the reason there
// were 36 is that each new feature added one, and without a guard the 37th arrives
// with the next feature and the disagreements grow back. THIS is the durable half.
//
// WHAT IT BANS, precisely: re-deriving a task set from the GLOBAL `scheduled` array
// outside task-model.js. It does NOT ban chaining a surface-specific extra filter
// onto a canonical selector (`TaskModel.selectOpen(scheduled).filter(pointEligible)`)
// — that is the intended shape, because point-eligibility and search matching are not
// derivation questions. The line is: the shared question comes from the layer, the
// local one may stay local.

// ★ THE REGEX IS THE DELIVERABLE, and its first cut was FALSE. Three widenings, each
// forced by a live offender the previous version walked straight past:
//
//  1. WHITESPACE. The literal `scheduled.filter(` misses four real sites, because prettier
//     had broken them across lines as `scheduled\n  .filter(...)` (day-review.js,
//     persistence.js, schedule.js x2). A hand count with the literal grep reported 32 when
//     there were 36 -- the exact undercount this phase exists to stop repeating.
//  2. THE DEFENSIVE DEFAULT. `(scheduled||[]).filter(...)` puts `||[])` between the
//     identifier and the dot. `pet-home.js` shipped one of these on a LIVE surface, mixing
//     the canonical `!isDeleted` with a local `pointEligible`, and the guard passed green.
//  3. THE OTHER TERMINALS. `.some` / `.every` / `.find` / `.findIndex` derive a task set
//     from the same global and answer the same questions. `responsibilities.js` had two
//     `.some(... !isDeleted(e))`, `schedule.js` one, and `schedule.js`/`state.js` carried
//     three copies of `scheduled.map((ev,i)=>({ev,i})).filter(...)` -- an intermediate
//     `.map` before the terminal, which no receiver-anchored regex catches.
//
// WHAT IT BANS, precisely: reaching the GLOBAL `scheduled` array and deriving a task set
// from it outside task-model.js. It does NOT ban chaining a surface-specific extra filter
// onto a canonical selector (`TaskModel.selectOpen(scheduled).filter(pointEligible)`) --
// that is the intended shape, because point-eligibility and search matching are not
// derivation questions. The line is: the shared question comes from the layer, the local
// one may stay local.
const { stripJsComments } = require("./js-comment-strip-fixture.js");
const path = require("node:path");

// ★ THE RULE IS PREDICATE-BASED, NOT TERMINAL-BASED, and getting that wrong is the third
// thing this guard got wrong. A blanket terminal list (`.some|.find|.findIndex`) flagged 25
// sites that are plain ID LOOKUPS -- `scheduled.find(e => e.id === id)` -- which duplicate
// nothing and belong exactly where they are. Banning them would be noise the next person
// silences by deleting the guard.
//
// So: the guard fires when code reaches the global `scheduled` and applies one of the FIVE
// CANONICAL QUESTIONS inline. Those five are precisely what task-model.js owns:
//   completion (isDone), visibility (isDeleted / the side-project flags), NESTING and the
//   parent edge (subtaskOf / wrapId / isNested / isSubtask), and scheduledness
//   (untimed / _dateless).
// Terminal-agnostic, so `.some(... !isDeleted(e))` is caught and `.find(e => e.id === x)`
// is not. Statement-bounded (`[^;\n]`) so it cannot run past the call it is judging.
// The receiver is the global array, its defensive-default form, OR one of the layer's own
// edge lookups applied to it -- `childrenOf(id, scheduled).some(c=>!isDone(c))` is still a
// canonical question asked inline, and anchoring on `scheduled` alone made the guard blind to
// five of them (three deciding whether a rollup container can be checked off, which are meant
// to agree with each other AND with selectDay's fold).
const RECEIVER = "(?:\\bscheduled\\b" +
  "|\\(\\s*scheduled\\s*\\|\\|\\s*\\[\\s*\\]\\s*\\)" +
  "|(?:childrenOf|ridersOf|subtasksOf)\\s*\\([^;\\n]*?\\bscheduled\\b[^;\\n]*?\\))";
const TERMINAL = "(?:filter|some|every|find|findIndex|flatMap|reduce)";
// BARE WORDS, not `isDone\s*\(`. A point-free predicate reference has no open paren, so
// `scheduled.filter(isDone)` -- sidebar.js's real shape, twice -- was invisible.
const CANONICAL = "(?:\\b(?:isDone|isDeleted|isNested|isSubtask|isRideAlong)\\b" +
  "|\\.\\s*subtaskOf\\b|\\.\\s*wrapId\\b|\\.\\s*untimed\\b|\\.\\s*_dateless\\b|\\.\\s*nested\\b|trivFlags\\s*\\[)";
// `(?:\.\w+\(...\)\s*)*?` allows intermediate chain links (`.map(...)`) before the
// terminal, which is how `scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev))` hid.
// The bound is `[^;]{0,N}?`, NOT `[^;\n]`: a prettier-wrapped predicate body spans lines, so
// excluding `\n` hid every multi-line filter -- including features.js's focus-banner
// predicate, one of this phase's own headline fixes. `;` still stops the match running past
// the call it is judging, and the length cap keeps it from wandering when there is no `;`.
const SCHEDULED_DERIVE_RX = new RegExp(
  RECEIVER + "\\s*(?:\\.\\s*\\w+\\s*\\([^;]{0,200}?\\)\\s*)*?\\.\\s*" + TERMINAL + "\\s*\\([^;]{0,400}?" + CANONICAL
);
const JS_DIR = path.join(__dirname, "public", "js");
const OWNER = "task-model.js";

test("★ no file outside task-model.js derives a task set from `scheduled` directly", () => {
  const offenders = [];
  for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort()) {
    if (file === OWNER) continue;
    const code = stripJsComments(fs.readFileSync(path.join(JS_DIR, file), "utf8"));
    const rx = new RegExp(SCHEDULED_DERIVE_RX.source, "g");
    let m;
    while ((m = rx.exec(code))) {
      offenders.push(file + ":" + code.slice(0, m.index).split("\n").length + "  " + m[0].replace(/\s+/g, " "));
    }
  }
  assert.deepEqual(offenders, [],
    "these must call a TaskModel selector instead of deriving from `scheduled` inline:\n  " + offenders.join("\n  "));
});

// ★ A source assertion nobody has watched FAIL is a guess about a regex. Three of
// C5b's new tests were vacuous on their first cut and every one was found this way —
// including a source guard whose `[^)]*` could not cross an inner `)`, so it never
// matched its own passing code. So: run this guard's regex against the code it exists
// to catch, and against the things it must NOT catch.
test("★ the `scheduled` derivation guard can actually fail (positive + negative control)", () => {
  const mustCatch = [
    'const a = scheduled.filter(ev => !isDone(ev));',                 // the plain form
    'const a=scheduled.filter(ev=>!isDone(ev)&&!isDeleted(ev));',     // minified, no spaces
    'const order = scheduled\n  .filter(ev => ev && ev.untimed)\n  .map(ev => ev.id);', // the multiline form the literal grep missed
    'return scheduled\n        .filter(ev => !isDeleted(ev))',        // day-review.js's real shape
    'x = scheduled . filter ( y => ! isDone ( y ) );',                 // spaced out
    // ── the three shapes the first cut of this guard walked straight past ──
    'return (scheduled||[]).filter(ev=>ev&&!isDeleted(ev)&&pointEligible(ev)).slice(0,8);', // pet-home.js, a LIVE surface
    'return ( scheduled || [] ).some(e => ! isDeleted ( e ) );',       // the same default, spaced, .some terminal
    'return scheduled.some(e=>e&&e.responsibilityId===id&&!isDeleted(e));', // responsibilities.js x2
    'const fi=scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev));', // schedule.js x2 + state.js: .map BEFORE the terminal
    'const n = scheduled.findIndex(ev => !isDone(ev));',
    'const n = scheduled.every(ev => isDone(ev));',
    // ── ONE CONTROL PER CANONICAL MARKER, so dropping any single one from the list fails.
    // Without these, removing `.subtaskOf`/`.wrapId` from CANONICAL went uncaught: every
    // other control carried an isDone/isDeleted call as well, so the list looked load-bearing
    // when only two of its eleven entries were actually being exercised.
    'scheduled.filter(c=>c.subtaskOf===pid).forEach(f);',                  // subtaskOf alone
    'scheduled.filter(c=>c.wrapId===wrapEv.id).forEach(f);',               // wrapId alone
    'const u = scheduled.filter(ev=>ev.untimed);',                         // untimed alone
    'const d = scheduled.filter(ev=>!ev._dateless);',                      // _dateless alone
    'const v = scheduled.filter(ev=>!trivFlags[ev.id]);',                  // the side-project map alone
    'const n = scheduled.filter(ev=>!isNested(ev));',                      // isNested alone
    'const n = scheduled.filter(ev=>!isSubtask(ev));',                     // isSubtask alone
    'const n = scheduled.filter(ev=>isRideAlong(ev));',                    // isRideAlong alone
    'const n = scheduled.filter(s=>!s.nested);',                           // the retired field alone
    'const n = scheduled.filter(ev=>!isDeleted(ev));',                     // isDeleted alone
    // ── the two shapes the predicate-based rewrite still missed, quoting the real base code
    'const items=scheduled.filter(ev=>{\n    if(!ev||ev.nested)return false;\n    if(isDone(ev))return false;\n    return true;\n  });', // features.js:1106 -- marker on line 2+
    'const dc=scheduled.filter(isDone).length;',                           // sidebar.js:5 -- point-free ref
    'const doneItems=scheduled.filter(isDone);',                           // sidebar.js:67
    // ── a canonical question asked on a canonical-edge SET is still asked inline
    'if(childrenOf(parent.id,scheduled).some(c=>!isDone(c)))return;',      // schedule.js:555 real shape
    'const open=childrenOf(id,scheduled).filter(c=>!isDone(c)).length;',   // schedule.js:891 real shape
    // ── the three TERMINAL entries that had no control of their own
    'const existing=scheduled.find(ev=>ev.triageId===tid||(!isDone(ev)&&ev.source==="triage"));', // triage.js:980 base shape
    'const n = scheduled.reduce((n,ev)=>n+(isDone(ev)?1:0),0);',
    'const a = scheduled.flatMap(ev=>isDone(ev)?[]:[ev]);',
  ];
  for (const s of mustCatch) {
    assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments(s)), "guard failed to catch: " + JSON.stringify(s));
  }
  const mustAllow = [
    'const rows = day.unscheduled.filter(ev => !rootIds.has(ev.id));',   // a DIFFERENT array; \b must not match inside "unscheduled"
    'const a = DCC.TaskModel.selectOpen(scheduled).filter(pointEligible);', // the intended shape: canonical selector + local filter
    'const a = DCC.TaskModel.selectNotDeleted(scheduled).some(e => e.responsibilityId === id);', // ditto, .some terminal
    'const a = rescheduled.filter(x => x);',                             // ditto, another word ending in "scheduled"
    'const a = scheduledItems.filter(x => x);',                          // a different identifier that merely starts with it
    'const i = scheduled.indexOf(newItem);',                             // not a set derivation
    'scheduled.splice(insertAt, 0, newItem);',                           // a mutation, not a derivation
    'const n = scheduled.length;',
    'scheduled.forEach(ev => paint(ev));',                               // iteration, not selection
    // ── ID LOOKUPS. 25 of these exist and they duplicate nothing. A terminal-based guard
    // flagged every one, which is how a guard becomes noise and then gets deleted.
    'const ev = scheduled.find(e => e.id === id);',
    'const ev = (scheduled||[]).find(t => t.id === id);',
    'const i = scheduled.findIndex(e => e.id === movedId);',
    'const has = scheduled.some(e => e.responsibilityId === id);',       // no canonical question in it
    'const t = scheduled.find(s => s.title === activeTitle);',
    // ── the ROUTED forms of everything above: the layer answers, the call site chains
    'const open=DCC.TaskModel.selectOpen(childrenOf(id,scheduled)).length;',
    'const kids=DCC.TaskModel.selectNotDeleted(childrenOf(shellEv.id,scheduled));',
    'const dc=DCC.TaskModel.selectDone(scheduled).length;',
    'const hasSubKids=DCC.TaskModel.subtasksOf(id,scheduled).length>0;',
  ];
  for (const s of mustAllow) {
    assert.equal(SCHEDULED_DERIVE_RX.test(stripJsComments(s)), false, "guard false-positived on: " + JSON.stringify(s));
  }
  // And the comment strip is what stops a file being flagged for NAMING the pattern
  // while documenting what replaced it — which this very test file does, above.
  assert.equal(SCHEDULED_DERIVE_RX.test(stripJsComments('// the old scheduled.filter(ev=>!isDone(ev)) predicate is gone')), false);
  assert.equal(SCHEDULED_DERIVE_RX.test(stripJsComments('/* scheduled.filter(ev=>!isDone(ev)) */ ok();')), false);
  // FALSE-NEGATIVE control: a `//` inside a string must not blind the stripper to a
  // real violation later on the same line. A cut-from-first-slash stripper fails this.
  assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments('log("http://x"); const a = scheduled.filter(f => !isDone(f));')),
    "a URL literal must not swallow the rest of the line");
  assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments('if(/a\\/b/.test(u)){ const a = scheduled.filter(f => !isDone(f)); }')),
    "a regex literal containing a slash must not swallow the rest of the line");
  // ★ The regex-literal case is NOT hypothetical in this repo, and the first cut of this
  // control was vacuous: `/a\/b/` contains no `//`, so removing the stripper's
  // regex handling did not change the answer and the mutation went uncaught. The shape
  // that actually bites is an ESCAPED SLASH PAIR — `schedule-tab.js:621` really does
  // carry `!/^https?:\/\//.test(url)`, in the file with the most predicates in it. Strip
  // naively and everything after it on that line disappears.
  assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments(
    'if(!url||!/^https?:\\/\\//.test(url)){ const a = scheduled.filter(f => !isDone(f)); }')),
    "an escaped-slash regex (schedule-tab.js:621's real shape) must not swallow the rest of the line");
  assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments(
    'const u=x.replace(/\\/\\//g,"/"); const a = scheduled.filter(f => !isDone(f));')),
    "a // inside a regex literal is not a comment");
  // And a `/*` inside a regex must not open a block comment that eats the file.
  assert.ok(SCHEDULED_DERIVE_RX.test(stripJsComments(
    'if(/x\\/*y/.test(u)){ const a = scheduled.filter(f => !isDone(f)); }')),
    "a /* inside a regex literal must not open a block comment");
});

test("★ stripJsComments strips comments without eating code (its own edge cases)", () => {
  const strip = (s) => stripJsComments(s).replace(/\s+/g, " ").trim();
  assert.equal(strip("a(); // gone\nb();"), "a(); b();");
  assert.equal(strip("a(); /* gone\nstill gone */ b();"), "a(); b();");
  // Comment markers inside strings are DATA, not comments — all three quote styles.
  assert.equal(strip('var u = "http://x/y"; keep();'), 'var u = "http://x/y"; keep();');
  assert.equal(strip("var u = 'a /* b */ c'; keep();"), "var u = 'a /* b */ c'; keep();");
  assert.equal(strip("var u = `a // b`; keep();"), "var u = `a // b`; keep();");
  // An escaped quote must not end the string early and expose its tail as code.
  assert.equal(strip('var u = "a\\" // not a comment"; keep();'), 'var u = "a\\" // not a comment"; keep();');
  // Division must not be mistaken for a regex opener.
  assert.equal(strip("var r = (a) / b; // gone\nkeep();"), "var r = (a) / b; keep();");
  assert.equal(strip("var r = arr[0] / 2; keep();"), "var r = arr[0] / 2; keep();");
  // An unterminated block comment consumes the tail rather than throwing.
  assert.doesNotThrow(() => stripJsComments("a(); /* never closed"));
  // An unterminated REGEX must bail at the NEWLINE. Not because it would swallow text -- the
  // scanner copies what it consumes -- but because without the bail the following lines are
  // read as regex BODY, so their `//` never registers as a comment and a comment that merely
  // NAMES the retired pattern becomes a false positive. That is the exact failure the comment
  // strip exists to prevent, arriving from the other direction.
  const strayRegex = "const r = /abc;\n// the old scheduled.filter(ev=>!isDone(ev)) is gone\n";
  assert.equal(SCHEDULED_DERIVE_RX.test(stripJsComments(strayRegex)), false,
    "an unterminated regex must not turn the next line's comment into code");
  assert.doesNotThrow(() => stripJsComments("const r = /never closed"));
  assert.equal(stripJsComments(""), "");
  assert.equal(stripJsComments(null), "");
});

test("★ flattenSchedule stays retired — selectTree is the one tree walker", () => {
  for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js"))) {
    const code = stripJsComments(fs.readFileSync(path.join(JS_DIR, file), "utf8"));
    assert.equal(/function\s+flattenSchedule\s*\(/.test(code), false,
      file + " re-declares flattenSchedule; roots must resolve against a POOL (TaskModel.selectTree)");
    assert.equal(/\bflattenSchedule\s*\(/.test(code), false,
      file + " still CALLS flattenSchedule");
  }
  // Negative control: the guard must fire on the code it retired.
  assert.ok(/function\s+flattenSchedule\s*\(/.test("function flattenSchedule(items){}"));
  assert.ok(/\bflattenSchedule\s*\(/.test("flattenSchedule(mainItems).forEach(x=>x)"));
});

// ── C6a: the "8 unregistered surfaces" the phase brief named, MEASURED ──
//
// The brief listed several builds missing from SURFACES. Measured against
// index.html, NONE of them is a registry surface, and registering them would have made
// the registry claim coverage it does not have:
//
//   • features.js buildTaskQueuePanel — same shape, `tqp-panel-*`, deleted by 781657a
//     ("replace Task Menu tab + bottom Task Queue with edge-pinned side drawers").
//   • public-todo-share.js — loads on public-todo.html, the GUEST share page. It has
//     no SURFACES object in scope; there is nothing to register it in.
//   • unfinished-tasks.js renderRows and features.js renderStickyNotesList — bodies of
//     modal overlays, created on open. `render()` DEFERS while any modal is open
//     (_anyModalOpen), so a modal body is deliberately not a registry surface. Their
//     always-visible side effect, the badge, is registered: `snBadge`.
//
// This guard is two-directional on purpose, so it cannot rot into a stale claim: it
// asserts the dead builds stay UNregistered AND that their containers are still
// absent. Restore the markup and the test fails, telling you to register the surface.
const DEAD_BUILD_TARGETS = {
  buildTaskQueuePanel: "tqp-panel-triage",
};

test("★ the builds whose containers no longer exist stay OUT of SURFACES (and their markup stays gone)", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const c = ctx();
  const registered = vm.runInContext("JSON.stringify(SURFACES)", c);
  for (const [fn, containerId] of Object.entries(DEAD_BUILD_TARGETS)) {
    assert.equal(indexHtml.includes('"' + containerId + '"'), false,
      `#${containerId} is back in index.html — ${fn} renders again, so REGISTER it in SURFACES ` +
      `(and delete its entry here). This guard exists so a revived surface is not left un-dirtied.`);
    assert.equal(registered.includes(fn), false,
      `${fn} is registered but #${containerId} does not exist — _doRender would call a no-op every render`);
  }
});

test("★ every SURFACES build names a function that exists in public/js", () => {
  const all = fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js"))
    .map((f) => stripJsComments(fs.readFileSync(path.join(JS_DIR, f), "utf8"))).join("\n");
  const registrySrc = SURFACES_SLICE;
  // Each entry reads `if(typeof buildX==="function")buildX();`
  const names = [...registrySrc.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*===\s*"function"/g)].map((m) => m[1]);
  assert.ok(names.length >= 20, "expected to find the registry's build function names, got " + names.length);
  // A build is "defined" by a declaration OR an assignment. `buildScheduleDelegated`
  // is `window.buildScheduleDelegated = renderDelegatedSidebar` (delegated.js), so a
  // `function X(`-only check false-positives on a perfectly healthy surface — which is
  // exactly what the first cut of this test did.
  const defined = (n) => new RegExp(
    "(function\\s+" + n + "\\s*\\()" +
    "|((?:window\\.|const |let |var )" + n + "\\s*=)" +
    "|(\\b" + n + "\\s*=\\s*(?:function|\\())"
  ).test(all);
  const missing = names.filter((n) => !defined(n));
  assert.deepEqual(missing, [], "SURFACES points at build functions that do not exist: " + missing.join(", "));
  // Negative control: a name nothing defines must be reported.
  assert.equal(defined("buildAbsolutelyNothing_c6a"), false);
});
