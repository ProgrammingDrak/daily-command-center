// Contract tests for the visibility-aware render registry in public/js/features.js
// (Phase 7). render(scope) resolves through RENDER_SCOPES + _markDirty to decide
// which surfaces rebuild. If a scope ever drops or misnames a surface, the scoped
// call sites (chevron collapse, subtask reorder in schedule-tab.js) would silently
// stop repainting with no error -- and the browser smoke only asserts initial-load
// render, never a scoped re-render. This locks the dirty-marking contract.
//
// Harness pattern: schedule-tab-shell-exclusion.test.js -- slice the pure pieces
// (SURFACES / RENDER_SCOPES / _dirty / _markDirty) into a node:vm context. These
// don't touch the DOM (the isVisible/build thunks are only defined here, never
// called), so no browser stubs are needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
const one = (re) => { const m = src.match(re); if (!m) throw new Error("slice failed: " + re); return m[0]; };
const source = [
  one(/const SURFACES = \{[\s\S]*?\n\};/),
  one(/const RENDER_SCOPES = \{[^\n]*\};/),
  one(/const _dirty = \{\};/),
  one(/function _markDirty\(scope\)\{[\s\S]*?\n\}/),
].join("\n");

function ctx() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
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
