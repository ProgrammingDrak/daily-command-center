// Pins the shared chip-slot precedence in itinerary-card.js, now the single
// source of the points/pie chip for BOTH the timeline card and the List row
// (schedule-tab.js buildListView calls window.itineraryChipSlotHtml(ev,{sub})).
// Precedence: shell rollup → own point-pie → subtask slice → plain points chip.
// Easy to regress silently (a pie leaking onto a shell, a slice showing under a
// pie) with no error thrown, so pin every branch.
//
// Harness pattern: subtask-unified-row.test.js — raw source in a node:vm, pull
// the exported helper off window.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const cardSrc = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");

function chipSlot(stubs) {
  const ctx = Object.assign(
    { window: {}, document: {}, isDone: () => false, pointEligible: () => true, shellRollupChip: () => "" },
    stubs,
  );
  vm.createContext(ctx);
  vm.runInContext(cardSrc, ctx);
  return ctx.window.itineraryChipSlotHtml;
}

test("chip-slot: shell rollup wins outright, even over a point-pie", () => {
  const fn = chipSlot({
    window: {
      TaskTypes: { get: () => ({ rollupMode: true }) },
      PointPlan: { compute: () => ({ pool: 10, earned: 5, doneCount: 1, total: 2 }) },
    },
    shellRollupChip: () => '<span class="shell">SHELL</span>',
  });
  assert.match(fn({ id: "a" }, { sub: true }), /SHELL/, "shell chip returned even with a pie present and sub=true");
  assert.doesNotMatch(fn({ id: "a" }, {}), /pie-bar/, "pie must never render when a shell rollup wins");
});

test("chip-slot: point-pie beats the subtask slice", () => {
  const fn = chipSlot({
    window: {
      TaskTypes: { get: () => null },
      PointPlan: { compute: () => ({ pool: 10, earned: 5, doneCount: 1, total: 2 }), shareFor: () => 7 },
    },
  });
  const html = fn({ id: "a", subtaskOf: "p" }, { sub: true });
  assert.match(html, /pie-bar/, "pie renders");
  assert.match(html, /5\/10 pts/, "pie label shows earned/pool");
  assert.doesNotMatch(html, /sub-share/, "sub-slice suppressed when a pie exists");
});

test("chip-slot: subtask slice only when opts.sub and there is no pie/shell", () => {
  const fn = chipSlot({
    window: { TaskTypes: { get: () => null }, PointPlan: { compute: () => null, shareFor: () => 7 } },
  });
  assert.match(fn({ id: "a", subtaskOf: "p" }, { sub: true }), /sub-share/, "sub row gets its slice");
});

test("chip-slot: plain points chip when not a sub and no pie/shell", () => {
  const fn = chipSlot({
    window: { TaskTypes: { get: () => null }, PointPlan: { compute: () => null } },
  });
  assert.match(fn({ id: "a", type: "task" }, {}), /points-chip/, "plain task falls through to the points chip");
});
