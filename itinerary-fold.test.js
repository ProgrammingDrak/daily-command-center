// Contract tests for the itinerary fold guard (isFoldableTask) in
// public/js/persistence.js. Regression for the prod incident where dateless
// kind:"pending_task" backlog copies (written by savePendingTasks in sync.js)
// folded into the itinerary on EVERY day and read as tasks duplicating from
// yesterday onto today and tomorrow.
// Harness pattern: recalc-times.test.js (raw source sliced into a node:vm
// context with stubbed globals).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const foldSource = persistenceSource.match(/const isFoldableTask=b=>\{[\s\S]*?\n\s*\};/);
assert.ok(foldSource, "isFoldableTask definition not found in persistence.js");

function makeFold(currentDate) {
  return vm.runInNewContext(`(() => { ${foldSource[0]} return isFoldableTask; })()`, { currentDate });
}

const TODAY = "2026-07-08";
const block = (date, props) => ({ date, properties: props });

test("dated quick-add folds only on its own date", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(TODAY, { local_id: "qa-1", title: "t" })), true);
  assert.equal(fold(block("2026-07-07", { local_id: "qa-1", title: "t" })), false);
});

test("dateless pending_task backlog copy never folds (the duplication bug)", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(null, { local_id: "qa-2", kind: "pending_task" })), false);
  assert.equal(fold(block(undefined, { local_id: "carry-1", kind: "backlog" })), false);
  // even a dated one stays out of the itinerary — backlog rows belong to the Pending UI
  assert.equal(fold(block(TODAY, { local_id: "qa-3", kind: "pending_task" })), false);
});

test("API-inserted kind:task folds dated or dateless (Slack-bookmark fix preserved)", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(TODAY, { kind: "task", title: "from api" })), true);
  assert.equal(fold(block(null, { kind: "task", title: "from api" })), true);
  assert.equal(fold(block("2026-07-09", { kind: "task", title: "from api" })), false);
});

test("dateless legacy quick-add residue (local_id, no kind) does not fold", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(null, { local_id: "qa-legacy" })), false);
});

test("responsibility scaffolding and kindless rows without local_id stay excluded", () => {
  const fold = makeFold(TODAY);
  assert.equal(fold(block(TODAY, { local_id: "r-1", kind: "responsibility_item" })), false);
  assert.equal(fold(block(TODAY, { title: "no identity" })), false);
});
