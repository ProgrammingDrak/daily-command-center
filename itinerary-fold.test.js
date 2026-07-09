// Contract tests for the itinerary fold guard (isFoldableTask) in
// public/js/persistence.js. Regression for the prod incident where dateless
// kind:"pending_task" copies of scheduled tasks (minted by the old quick-add
// dual-write) folded into the itinerary on EVERY day.
// Day-scoping semantics under test:
//   - dated rows fold only on their own date
//   - dateless rows fold (into the Unscheduled section) UNLESS a dated sibling
//     shares their local_id — then they're a leftover copy and are suppressed
//   - closed pending rows (status deleted/archived/done) never fold
// Harness pattern: recalc-times.test.js (raw source sliced into a node:vm
// context with stubbed globals).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const foldSource = persistenceSource.match(/const isFoldableTask=b=>\{[\s\S]*?\n\s*\};/);
assert.ok(foldSource, "isFoldableTask definition not found in persistence.js");

// The guard closes over `currentDate` and the precomputed `datedLocalIds` set;
// the harness supplies both.
function makeFold(currentDate, datedLocalIds) {
  return vm.runInNewContext(`(() => { ${foldSource[0]} return isFoldableTask; })()`, {
    currentDate,
    datedLocalIds: datedLocalIds || new Set(),
  });
}

const TODAY = "2026-07-08";
const block = (date, props) => ({ date, properties: props });

test("dated quick-add folds only on its own date", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(TODAY, { local_id: "qa-1", title: "t" })), true);
  assert.equal(fold(block("2026-07-07", { local_id: "qa-1", title: "t" })), false);
});

test("dateless row WITHOUT a dated sibling folds (Unscheduled section)", () => {
  const fold = makeFold(TODAY, new Set());
  assert.equal(fold(block(null, { local_id: "qa-solo", kind: "pending_task" })), true);
  assert.equal(fold(block(undefined, { local_id: "carry-1", kind: "backlog" })), true);
  assert.equal(fold(block(null, { local_id: "qa-legacy" })), true);
});

test("dateless twin WITH a dated sibling is suppressed (the duplication bug)", () => {
  const fold = makeFold(TODAY, new Set(["qa-2", "qa-3"]));
  assert.equal(fold(block(null, { local_id: "qa-2", kind: "pending_task" })), false);
  assert.equal(fold(block(null, { local_id: "qa-3" })), false);
  // an unrelated dateless row still folds
  assert.equal(fold(block(null, { local_id: "qa-other", kind: "pending_task" })), true);
});

test("closed pending rows never fold", () => {
  const fold = makeFold(TODAY, new Set());
  assert.equal(fold(block(null, { local_id: "qa-4", kind: "pending_task", status: "deleted" })), false);
  assert.equal(fold(block(null, { local_id: "qa-5", kind: "pending_task", status: "archived" })), false);
  assert.equal(fold(block(null, { local_id: "qa-6", kind: "pending_task", status: "done" })), false);
});

test("API-inserted kind:task folds dated or dateless (Slack-bookmark fix preserved)", () => {
  const fold = makeFold(TODAY, new Set());
  assert.equal(fold(block(TODAY, { kind: "task", title: "from api" })), true);
  assert.equal(fold(block(null, { kind: "task", title: "from api" })), true);
  assert.equal(fold(block("2026-07-09", { kind: "task", title: "from api" })), false);
});

test("materialized calendar meeting block folds on its own date (single render path)", () => {
  const fold = makeFold(TODAY, new Set());
  const meeting = { type: "meeting", kind: "meeting", source: "calendar", source_id: "evt-1", status: "open", start: "12:30", end: "13:30" };
  // A meeting has no local_id but must still fold on its date (meetings render only
  // as blocks now; synthesis was deleted).
  assert.equal(fold(block(TODAY, meeting)), true);
  assert.equal(fold(block("2026-07-07", meeting)), false); // only on its own date
  // a completed meeting never folds
  assert.equal(fold(block(TODAY, { ...meeting, status: "done" })), false);
  // the oneone variant is admitted the same way
  assert.equal(fold(block(TODAY, { type: "oneone", source: "calendar", source_id: "evt-2", status: "open" })), true);
});

test("responsibility scaffolding and kindless rows without local_id stay excluded", () => {
  const fold = makeFold(TODAY, new Set());
  assert.equal(fold(block(TODAY, { local_id: "r-1", kind: "responsibility_item" })), false);
  assert.equal(fold(block(TODAY, { title: "no identity" })), false);
});
