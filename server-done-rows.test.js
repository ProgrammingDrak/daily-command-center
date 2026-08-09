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
const { setImmediate } = require("node:timers");

const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const syncSource = fs.readFileSync(require.resolve("./public/js/sync.js"), "utf8");

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
//
// REWORKED FOR C5b. `_clearRowDone` is now one line over `_persistDone`, the single
// completion writer, so the slice is that whole region and the harness has to supply the
// two collaborators it resolves through: `_findTaskBlockForDate` (state.js) and
// `enqueueRowPropsWrite` (state.js, C4's serialized row-properties queue). The queue's
// null-merge contract is reproduced faithfully — a fake that wrote regardless would hide
// every "this must not touch the row" case below.
const clearSource = scheduleSource.match(/function _doneRowProps\(props,completedAt\)\{[\s\S]*?function _refreshResponsibilityAfterDone\(ev,write\)\{[\s\S]*?\n\}/);
assert.ok(clearSource, "the C5b _persistDone region must exist in schedule.js");

function makeClear(blockProps, ev, dayRootProps) {
  const calls = [];
  const row = blockProps ? { id: "blk-1", properties: blockProps } : null;
  const dayRoot = { id: "root-1", properties: dayRootProps || {} };
  const ctx = {
    console: { warn: () => {} },
    scheduled: ev ? [ev] : [],
    _viewedDateStr: () => null,
    // Derived from the fixture, and it can MISS: a row that is not cached resolves to
    // null, which is the legacy-task case below.
    //
    // Mirrors state.js's predicate EXACTLY, including the trailing `b.id === ev._blockId`
    // clause. Leaving that clause out is what this fake did first, and it made the fixture
    // for the flagship case (ev keyed "t1", row keyed "blk-1") resolve to nothing — a fake
    // NARROWER than reality, reporting a working un-check as broken.
    _findTaskBlockForDate: (id, dateStr, e) => {
      if (!row) return null;
      const ids = [row.properties && row.properties.local_id, row.id];
      if (e && e._blockId) ids.push(e._blockId);
      const byId = ids.filter(Boolean).map(String).includes(String(id));
      const byBlock = !!(e && e._blockId && String(row.id) === String(e._blockId));
      return (byId || byBlock) ? row : null;
    },
    enqueueRowPropsWrite: (blockId, merge) => {
      const target = blockId === dayRoot.id ? dayRoot : (row && row.id === blockId ? row : null);
      if (!target || !target.properties) return null;
      const next = merge(target.properties);
      if (!next) return null;              // the queue's null-merge skip
      target.properties = next;
      calls.push({ id: blockId, props: next });
      return null;
    },
    window: { blockStore: { getDayRootId: () => dayRoot.id, get: (id) => (id === dayRoot.id ? dayRoot : row) } }
  };
  vm.runInNewContext(clearSource[0] + "\n_clearRowDone(\"t1\");", ctx);
  return calls.filter((c) => c.id === "blk-1");
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

test("un-check is a no-op with no row identity (legacy localStorage task)", () => {
  assert.equal(makeClear(null, { id: "t1" }).length, 0);
  // NOTE, changed in C5b: an ev with no `_blockId` is no longer a dead end. `_persistDone`
  // resolves through `_findTaskBlockForDate`, which also matches on `local_id` and row id,
  // so a completion still lands for an ev whose _blockId was never stamped (prep.js's
  // distraction log, tabs.js's migrated subtasks). Only a genuinely unresolvable row
  // (above) skips the write, and that case falls back to the legacy overlay instead.
  assert.equal(makeClear({ local_id: "t1", status: "done" }, { id: "t1" }).length, 1);
});

test("a cache miss still writes through the rendered task's authoritative row id", () => {
  const calls = [];
  const ev = { id: "t1", _blockId: "blk-1" };
  const fetched = { id: "blk-1", date: null, properties: { title: "Persist me", status: "open", kind: "backlog" } };
  const ctx = {
    console: { warn: () => {} },
    scheduled: [ev],
    _viewedDateStr: () => "2026-08-07",
    _findTaskBlockForDate: () => null,
    enqueueRowPropsWrite: (blockId, merge, extra) => {
      const props = merge(fetched.properties, fetched);
      calls.push({ blockId, props, extra: typeof extra === "function" ? extra(fetched, props) : extra });
      return Promise.resolve({ id: blockId });
    },
    window: { blockStore: { getDayRootId: () => null } },
  };
  vm.runInNewContext(clearSource[0] + '\n_persistDone("t1",true,{ev:scheduled[0],completedAt:"2026-08-07T17:00:00Z"});', ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blockId, "blk-1");
  assert.equal(calls[0].props.status, "done");
  assert.equal(calls[0].props._doneStampedDate, "2026-08-07");
  assert.equal(calls[0].extra.date, "2026-08-07");
  assert.equal(calls[0].extra.completionIntent, "complete");
});

test("un-check clears the LEGACY _done entry too, and only that entry", () => {
  // The `_done` overlay is read-only legacy data now (sync.js) and is still load-bearing
  // for 23 measured completions. A read-only source you cannot clear is a completion that
  // cannot be un-done: the next load re-hydrates it and the row snaps back to done.
  const calls = [];
  const dayRoot = { id: "root-1", properties: { _done: { ids: ["t1", "keep"], at: { t1: "a", keep: "b" } } } };
  const row = { id: "blk-1", properties: { status: "done", done: true } };
  const ctx = {
    console: { warn: () => {} },
    scheduled: [{ id: "t1", _blockId: "blk-1" }],
    _viewedDateStr: () => null,
    _findTaskBlockForDate: () => row,
    enqueueRowPropsWrite: (blockId, merge) => {
      const target = blockId === dayRoot.id ? dayRoot : row;
      const next = merge(target.properties);
      if (!next) return null;
      target.properties = next;
      calls.push(blockId);
      return null;
    },
    window: { blockStore: { getDayRootId: () => dayRoot.id, get: () => dayRoot } }
  };
  vm.runInNewContext(clearSource[0] + "\n_clearRowDone(\"t1\");", ctx);
  assert.deepEqual(dayRoot.properties._done.ids, ["keep"]);
  assert.deepEqual(Object.keys(dayRoot.properties._done.at), ["keep"]);
  assert.deepEqual(calls, ["blk-1", "root-1"], "the row and the overlay, in that order");
});

test("side-project completion and undo declare their durable completion intent", async () => {
  const featuresSource = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  const toggleSource = featuresSource.match(/function toggleTrivialTask\(id\)\{[\s\S]*?\n\}/);
  assert.ok(toggleSource, "toggleTrivialTask must remain available");

  const calls = [];
  const block = { id: "side-1", properties: { kind: "side_project", text: "Durable", done: false } };
  const ctx = {
    window: {
      USE_BLOCKSTORE: { trivialTasks: true },
      blockStore: {
        get: () => block,
        updateBlock: (id, properties, extra) => {
          calls.push({ id, properties, extra });
          block.properties = properties;
          return Promise.resolve();
        },
      },
    },
    buildTrivialTasks: () => {},
    buildSchedule: () => {},
  };
  vm.runInNewContext(toggleSource[0] + '\ntoggleTrivialTask("side-1");', ctx);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInNewContext('toggleTrivialTask("side-1");', ctx);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls[0].extra.completionIntent, "complete");
  assert.equal(calls[1].extra.completionIntent, "reopen");
});

test("toggleDone's un-check branch calls it (the snap-back regression)", () => {
  // The call is wrapped in `_refreshResponsibilityAfterDone(...)` now, so the branch chains the
  // responsibility-cadence refresh on the un-check write as well as the completion write.
  assert.ok(/manualDone\.delete\(id\);delete doneAt\[id\];log\("unchecked",id\);[\s\S]{0,900}?_clearRowDone\(id\)/.test(scheduleSource),
    "the un-check branch must clear the row");
});

// ── half 3: the write side of the overlay is GONE (C5b) ──────────────────────
//
// The stated done-signal for this phase. Asserted against the source rather than a
// behavior because the point is an ABSENCE: no caller anywhere, so there is no call to
// observe. `saveDoneState` rewrote `_done` wholesale from the in-memory `manualDone` set,
// which meant any window where that set was narrower than what was persisted permanently
// un-completed the difference — and `collectUnfinished` then put every one back on today.
test("saveDoneState no longer exists, and nothing calls it", () => {
  assert.equal(/^\s*function saveDoneState\s*\(/m.test(syncSource), false,
    "sync.js must not define saveDoneState");
  const callers = [];
  for (const f of fs.readdirSync("public/js")) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync("public/js/" + f, "utf8");
    // Strip comments first: several files legitimately NAME it while explaining what
    // replaced it, and a bare substring search would read those as live call sites.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (/saveDoneState\s*\(/.test(code)) callers.push(f);
  }
  assert.deepEqual(callers, [], "live saveDoneState call sites remain");
});

// The key can arrive through a LOCAL, and that is how the mirror this phase deleted was
// actually written: `commitDoneOnDate` had `const key="pa-done-"+dateStr; ...
// localStorage.setItem(key,...)`. A guard matching only `setItem(DONE_KEY` / `setItem("pa-done-`
// stays green if that block is restored verbatim, i.e. it is decorative for the exact
// regression it names. So the key VARIABLES are collected first and matched too.
test("nothing writes the pa-done-<date> localStorage mirror any more", () => {
  const path = require("node:path");
  const dir = path.join(__dirname, "public", "js");
  const writers = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const code = fs.readFileSync(path.join(dir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const keyVars = [...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*["'`]pa-done-/g)].map((m) => m[1]);
    const names = ["DONE_KEY", ...keyVars].join("|");
    if (new RegExp('setItem\\(\\s*(?:' + names + '|["\'`]pa-done-)').test(code)) writers.push(f);
  }
  assert.deepEqual(writers, [], "the localStorage done mirror is retired");
});

// Proves the guard above can actually fail, by running it against the code that WAS deleted.
// A source-text assertion nobody has watched fail is a guess about a regex.
test("...and that guard catches the local-variable form it exists for", () => {
  const deleted = 'const key="pa-done-"+dateStr;\n localStorage.setItem(key,JSON.stringify(d));';
  const keyVars = [...deleted.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*["'`]pa-done-/g)].map((m) => m[1]);
  assert.deepEqual(keyVars, ["key"]);
  const names = ["DONE_KEY", ...keyVars].join("|");
  assert.equal(new RegExp('setItem\\(\\s*(?:' + names + '|["\'`]pa-done-)').test(deleted), true,
    "the deleted mirror must trip the guard, or the guard is decorative");
});
