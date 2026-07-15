// Contract tests for _unfSlashDate in public/js/schedule-tab.js — the amber
// "Unfinished from MM/DD/YYYY" chip formatter. The invariant under guard: the
// iso input is already a local calendar date, so the formatter must be a pure
// string split. A refactor back to `new Date(iso).toLocaleDateString(...)`
// would parse the iso as UTC midnight and render the PREVIOUS day in
// negative-offset timezones — these tests exist so that regression fails loudly.
// Harness pattern: schedule-tab-shell-exclusion.test.js — slice the pure
// function into a node:vm context.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const slice = (name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];

function makeContext() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(slice("_unfSlashDate"), context);
  return context;
}

test("_unfSlashDate: YYYY-MM-DD reorders to MM/DD/YYYY as a pure string split", () => {
  const ctx = makeContext();
  assert.equal(vm.runInContext('_unfSlashDate("2026-07-13")', ctx), "07/13/2026");
  assert.equal(vm.runInContext('_unfSlashDate("2026-01-01")', ctx), "01/01/2026");
  // Zero-padding passes through untouched (no numeric parsing to strip it).
  assert.equal(vm.runInContext('_unfSlashDate("2026-12-09")', ctx), "12/09/2026");
});

test("_unfSlashDate: non-matching input returns unchanged, nullish returns empty string", () => {
  const ctx = makeContext();
  assert.equal(vm.runInContext('_unfSlashDate("2026-07-13T00:00:00Z")', ctx), "2026-07-13T00:00:00Z");
  assert.equal(vm.runInContext('_unfSlashDate("not a date")', ctx), "not a date");
  assert.equal(vm.runInContext("_unfSlashDate(null)", ctx), "");
  assert.equal(vm.runInContext("_unfSlashDate(undefined)", ctx), "");
});
