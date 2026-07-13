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
