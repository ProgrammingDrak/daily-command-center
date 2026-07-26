// Timezone-safety contract for gbFmtReviewDate in public/js/glymphatic-brief.js —
// the Day-in-Review date pill formatter. The invariant under guard: the review
// date is a local calendar date, and gbFmtReviewDate anchors it at local noon
// (`iso + "T12:00:00"`) so the rendered day never rolls back a day in
// negative-offset timezones. A refactor to `new Date(iso)` would parse the iso as
// UTC midnight and render the PREVIOUS day west of UTC — these tests exist so that
// regression fails loudly. Sibling precedent: unfinished-date-chip.test.js.
//
// TZ must be set before any Date is constructed. Honolulu (UTC-10) is the worst
// case for the rollover bug.
process.env.TZ = "Pacific/Honolulu";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// gbFmtReviewDate is 2-space-indented inside the file's IIFE, so the slice must
// match the indented closing brace (mirrors the closure-slicing tests).
const src = fs.readFileSync(require.resolve("./public/js/glymphatic-brief.js"), "utf8");
const slice = src.match(/  function gbFmtReviewDate[\s\S]*?\n  \}/)[0];

function makeCtx() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(slice, context);
  return context;
}

test("gbFmtReviewDate: renders the ISO's own calendar day, no UTC-midnight rollover", () => {
  const ctx = makeCtx();
  // Honolulu is UTC-10; a naive `new Date("2026-07-23")` would render Jul 22 here.
  const mid = vm.runInContext('gbFmtReviewDate("2026-07-23")', ctx);
  assert.match(mid, /23/, `expected day 23 in "${mid}"`);
  assert.doesNotMatch(mid, /22/, `must not roll back to day 22 in a negative-offset TZ ("${mid}")`);
  // First-of-month is the sharpest case: a rollover flips both day AND month.
  const first = vm.runInContext('gbFmtReviewDate("2026-01-01")', ctx);
  assert.match(first, /\b1\b/, `expected day 1 in "${first}"`);
  assert.doesNotMatch(first, /Dec|31/, `must not roll back to Dec 31 ("${first}")`);
});

test("gbFmtReviewDate: falsy input returns empty string", () => {
  const ctx = makeCtx();
  assert.equal(vm.runInContext('gbFmtReviewDate("")', ctx), "");
  assert.equal(vm.runInContext("gbFmtReviewDate(null)", ctx), "");
  assert.equal(vm.runInContext("gbFmtReviewDate(undefined)", ctx), "");
});
