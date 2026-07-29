// Contract tests for Phase C0: a task completed by a SERVER-side path renders as a
// done row instead of vanishing.
//
// The gap: three writers mark completion on the block row itself —
// routes/dcc.js (Day in Review's Approve), routes/slack-events.js (the ✅ reaction)
// and the MCP tools — all writing status:"done"/done:true/completedAt. The client
// only ever read completions out of day_root._done, and the itinerary fold
// EXCLUDED status==="done", so those tasks were dropped from the list entirely: no
// row, no checkmark, no points line, and Day in Review's Approve looked broken.
//
// Two halves are under test:
//   1. the fold seeds manualDone/doneAt from the row (persistence.js)
//   2. un-checking clears the row too (schedule.js _clearRowDone), or the next
//      reload re-hydrates the completion and the row snaps back to done
//
// Harness pattern: recalc-times.test.js — raw source sliced into a node:vm context.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");

// ── half 1: the fold seeds the done registry off the row ─────────────────────

// The seed is a 4-line block inside addedBlocks.forEach; slice it and run it over a
// fake props bag with the same surrounding state the fold has.
const seedSource = persistenceSource.match(/if\(p\.done===true\|\|p\.status==="done"\)\{[\s\S]*?\n\s*\}/);
assert.ok(seedSource, "the done-registry seed must exist in persistence.js");

function seed(props, existingDoneAt) {
  const ctx = {
    p: props,
    taskId: "t1",
    manualDone: new Set(),
    doneAt: existingDoneAt || {}
  };
  vm.runInNewContext(seedSource[0], ctx);
  return { done: [...ctx.manualDone], doneAt: ctx.doneAt };
}

test("a row marked done by the server seeds manualDone", () => {
  assert.deepEqual(seed({ status: "done" }).done, ["t1"]);
  assert.deepEqual(seed({ done: true }).done, ["t1"]);
  // Day in Review writes all three flags; any one of them is enough.
  assert.deepEqual(seed({ status: "done", done: true, completed: true }).done, ["t1"]);
});

test("an open row seeds nothing", () => {
  assert.deepEqual(seed({}).done, []);
  assert.deepEqual(seed({ status: "open" }).done, []);
  // `done` must be strictly true — a truthy leftover ("false", 0, "") is not a completion
  assert.deepEqual(seed({ done: "false" }).done, []);
});

test("the completion timestamp comes off the row, either spelling", () => {
  assert.equal(seed({ status: "done", completedAt: "2026-07-29T15:46:48.002Z" }).doneAt.t1, "2026-07-29T15:46:48.002Z");
  assert.equal(seed({ status: "done", doneAt: "2026-07-29T16:03:02.014Z" }).doneAt.t1, "2026-07-29T16:03:02.014Z");
  // no timestamp on the row: still done, just undated
  assert.equal(seed({ status: "done" }).doneAt.t1, null);
});

test("day_root._done wins the timestamp — it is the user's own completion", () => {
  // reloadPersistedEdits fills doneAt from the day overlay BEFORE this loop runs, so
  // the row must not overwrite a timestamp already recorded for the same task.
  const out = seed({ status: "done", completedAt: "2026-07-29T15:00:00Z" }, { t1: "2026-07-29T09:00:00Z" });
  assert.equal(out.doneAt.t1, "2026-07-29T09:00:00Z");
});

// ── half 2: un-checking clears the row, not just the overlay ─────────────────

const clearSource = scheduleSource.match(/function _clearRowDone\(id\)\{[\s\S]*?\n\}/);
assert.ok(clearSource, "_clearRowDone must exist in schedule.js");

function makeClear(blockProps, ev) {
  const calls = [];
  const ctx = {
    scheduled: ev ? [ev] : [],
    window: {
      blockStore: {
        get: () => (blockProps ? { id: "blk-1", properties: blockProps } : null),
        updateBlock: (id, props) => calls.push({ id, props })
      }
    }
  };
  vm.runInNewContext(clearSource[0] + "\n_clearRowDone(\"t1\");", ctx);
  return calls;
}

test("un-check clears every completion flag on the row and re-opens its status", () => {
  const calls = makeClear(
    { title: "t", status: "done", done: true, completed: true, completedAt: "x", doneAt: "x", tags: ["keep"], start: "09:00" },
    { id: "t1", _blockId: "blk-1" }
  );
  assert.equal(calls.length, 1);
  const props = calls[0].props;
  assert.equal(props.status, "open");
  for (const k of ["done", "completed", "completedAt", "doneAt"]) {
    assert.equal(k in props, false, `${k} must be removed`);
  }
  // ...and nothing else is touched: this is a status clear, not a rewrite
  assert.deepEqual(props.tags, ["keep"]);
  assert.equal(props.start, "09:00");
  assert.equal(props.title, "t");
});

test("un-check is a no-op when the row carries no completion", () => {
  assert.equal(makeClear({ title: "t", status: "open" }, { id: "t1", _blockId: "blk-1" }).length, 0);
});

test("un-check is a no-op with no block behind the row (legacy localStorage task)", () => {
  assert.equal(makeClear({ status: "done" }, { id: "t1" }).length, 0);          // no _blockId
  assert.equal(makeClear(null, { id: "t1", _blockId: "blk-1" }).length, 0);     // block not cached
  assert.equal(makeClear({ status: "done" }, null).length, 0);                  // not in scheduled[]
});

test("toggleDone's un-check branch calls it (the snap-back regression)", () => {
  assert.ok(/manualDone\.delete\(id\);delete doneAt\[id\];log\("unchecked",id\);[\s\S]{0,400}?_clearRowDone\(id\);/.test(scheduleSource),
    "the un-check branch must clear the row before saving");
});
