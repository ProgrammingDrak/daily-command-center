// public/js/persistence.js applyDayRootOverlays — the day_root -> live-registry read.
//
// This exists for the LEGACY `_pushed` branch C3 added. The pushed subsystem is deleted and
// nothing writes that key any more, but a pushed row was never removed from its origin day,
// only hidden by the overlay — so the read has to stay or those days resurface the origin
// copy beside the duplicate the old push created on the next day. That is an invariant about
// real historical data (measured: 4 day_roots, 10 ids, 1 still resolving to a live row) and
// before this file, deleting either `forEach` left the whole suite green.
//
// Harness: itinerary-fold.test.js's pattern — slice the hoisted pure function out of
// persistence.js and run it in a node:vm context, since the file has DOM side effects at load.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const match = SRC.match(/function applyDayRootOverlays\(props, \{ manualDone, doneAt, deletedSet \}\) \{[\s\S]*?\n\}/);
if (!match) throw new Error("day-root-overlays.test.js could not slice applyDayRootOverlays -- the source moved, fix the pattern");

function load() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(match[0], ctx);
  const manualDone = new Set(), doneAt = {}, deletedSet = new Set();
  return {
    apply: (props) => vm.runInContext("applyDayRootOverlays", ctx)(props, { manualDone, doneAt, deletedSet }),
    manualDone, doneAt, deletedSet
  };
}

test("a legacy _pushed overlay HIDES the origin row rather than resurrecting it", () => {
  const { apply, deletedSet } = load();
  apply({ _pushed: { ids: ["old-1", "old-2"], at: { "old-1": "2026-04-06T12:00:00Z" } } });
  assert.deepEqual([...deletedSet].sort(), ["old-1", "old-2"],
    "a pushed row IS a row that left this day; leaving it visible shows it on two days at once");
});

test("_pushed and _deleted both land in the same hide set", () => {
  const { apply, deletedSet } = load();
  apply({ _deleted: ["d-1"], _pushed: { ids: ["p-1"] } });
  assert.deepEqual([...deletedSet].sort(), ["d-1", "p-1"]);
});

test("completion ids and timestamps come through", () => {
  const { apply, manualDone, doneAt } = load();
  apply({ _done: { ids: ["t1", "t2"], at: { t1: "2026-07-31T10:00:00Z" } } });
  assert.deepEqual([...manualDone].sort(), ["t1", "t2"]);
  assert.equal(doneAt.t1, "2026-07-31T10:00:00Z");
});

test("a day with no overlays adds nothing", () => {
  const { apply, manualDone, deletedSet, doneAt } = load();
  apply({});
  assert.equal(manualDone.size, 0);
  assert.equal(deletedSet.size, 0);
  assert.deepEqual(doneAt, {});
});

test("missing / malformed overlays do not throw", () => {
  // day_root properties are user-writable JSON; a half-written overlay must not break boot.
  for (const props of [undefined, null, {}, { _done: {} }, { _pushed: {} }, { _deleted: [] }, { _pushed: { at: {} } }]) {
    const { apply, deletedSet, manualDone } = load();
    apply(props);
    assert.equal(deletedSet.size, 0);
    assert.equal(manualDone.size, 0);
  }
});

test("_pushed with ids but no `at` still hides them", () => {
  // The old writer always wrote both halves, but only `ids` is load-bearing for hiding, and
  // an overlay hand-edited down to just ids must still work.
  const { apply, deletedSet } = load();
  apply({ _pushed: { ids: ["only-ids"] } });
  assert.ok(deletedSet.has("only-ids"));
});
