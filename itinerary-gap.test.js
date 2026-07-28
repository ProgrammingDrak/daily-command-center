// Contract tests for the List-view idle-gap marker decision cores in
// public/js/schedule-tab.js. The marker shows the idle time between two
// consecutive top-level timed rows; these two pure functions own "can this row
// anchor a gap?" and "how many minutes to show, if any?". Harness pattern:
// schedule-tab-shell-exclusion.test.js -- slice the named functions into a
// node:vm context and assert against them directly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const slice = (name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const source = [slice("_rowIsTimed"), slice("_gapMarkerMins")].join("\n");

function makeContext() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}
const run = (ctx, expr) => vm.runInContext(expr, ctx);

test("_rowIsTimed: true only for a row with real HH:MM start AND end", () => {
  const ctx = makeContext();
  assert.equal(run(ctx, '_rowIsTimed({start:"09:00",end:"09:30"})'), true);
  assert.equal(run(ctx, '_rowIsTimed({start:"09:00"})'), false);          // no end
  assert.equal(run(ctx, '_rowIsTimed({start:"",end:""})'), false);        // empty
  assert.equal(run(ctx, "_rowIsTimed(null)"), false);
});

test('_rowIsTimed: false for an untimed row even if it carries stored times', () => {
  // A done "Unscheduled" task renders inline but must not anchor a gap.
  const ctx = makeContext();
  assert.equal(run(ctx, '_rowIsTimed({untimed:true,start:"00:00",end:"00:30"})'), false);
});

test("_gapMarkerMins: no marker before the first timed row", () => {
  const ctx = makeContext();
  assert.equal(run(ctx, "_gapMarkerMins(null, 540)"), null);
});

test("_gapMarkerMins: 15-minute floor (14 hides, 15 shows)", () => {
  const ctx = makeContext();
  assert.equal(run(ctx, "_gapMarkerMins(540, 554)"), null); // 14m gap
  assert.equal(run(ctx, "_gapMarkerMins(540, 555)"), 15);   // 15m gap
  assert.equal(run(ctx, "_gapMarkerMins(540, 630)"), 90);   // 1h 30m gap
});

test("_gapMarkerMins: back-to-back (0) and overlaps (negative) draw nothing", () => {
  const ctx = makeContext();
  assert.equal(run(ctx, "_gapMarkerMins(570, 570)"), null); // back-to-back
  assert.equal(run(ctx, "_gapMarkerMins(600, 570)"), null); // overlap
});
