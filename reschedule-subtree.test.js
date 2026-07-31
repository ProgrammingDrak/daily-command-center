const { test } = require("node:test");
const assert = require("node:assert");
const { collectSubtreeBlockIds } = require("./lib/reschedule");

// Build a task block the way DCC stores them: type "block" with a local_id and
// optional subtaskOf/wrapId linking to a parent's local_id.
function blk(id, localId, { subtaskOf, wrapId, parent_id, kind, type } = {}) {
  return {
    id,
    type: type || "block",
    parent_id: parent_id || null,
    properties: { local_id: localId, subtaskOf: subtaskOf || null, wrapId: wrapId || null, kind: kind || null }
  };
}

test("leaf task moves only itself", () => {
  const parent = blk("B1", "t1");
  const day = [parent, blk("B2", "t2")];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent), ["B1"]);
});

test("parent carries direct subtasks and ride-alongs", () => {
  const parent = blk("B1", "t1");
  const day = [
    parent,
    blk("B2", "t2", { subtaskOf: "t1" }),
    blk("B3", "t3", { wrapId: "t1" }),
    blk("B4", "t4", { subtaskOf: "other" }), // unrelated
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B2", "B3"]);
});

test("nested subtasks move as a unit", () => {
  const parent = blk("B1", "t1");
  const day = [
    parent,
    blk("B2", "t2", { subtaskOf: "t1" }),
    blk("B3", "t3", { subtaskOf: "t2" }), // grandchild
    blk("B4", "t4", { subtaskOf: "t3" }), // great-grandchild
    blk("B5", "t5"), // sibling task, untouched
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B2", "B3", "B4"]);
});

test("a data cycle does not hang or duplicate", () => {
  const parent = blk("B1", "t1");
  const day = [
    parent,
    blk("B2", "t2", { subtaskOf: "t1" }),
    blk("B3", "t3", { subtaskOf: "t2" }),
    // pathological: t1 also claims t3 as its parent -> cycle
    { id: "B1b", type: "block", properties: { local_id: "t1", subtaskOf: "t3" } },
  ];
  const ids = collectSubtreeBlockIds(day, parent);
  assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
  assert.ok(ids.includes("B1") && ids.includes("B2") && ids.includes("B3"));
});

test("parent without a local_id still moves itself", () => {
  const parent = { id: "B1", type: "block", properties: {} };
  const day = [blk("B2", "t2")];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent), ["B1"]);
});

test("parent is only listed once even if present in dayBlocks", () => {
  const parent = blk("B1", "t1");
  const day = [parent, blk("B2", "t2", { subtaskOf: "t1" })];
  const ids = collectSubtreeBlockIds(day, parent);
  assert.strictEqual(ids.filter(x => x === "B1").length, 1);
});

// ── The parent_id edge space (C3) ──────────────────────────────────────────────
// The walk above reads subtaskOf/wrapId, which hold a parent's LOCAL_ID. Nesting is
// also recorded in the parent_id COLUMN (migration 001 resolved the links into it; A1's
// createBlock dual-writes it). Neither space is complete on real data, so the walk reads
// both. Measurements are in lib/reschedule.js; these pin the semantics.

test("a child linked ONLY by parent_id still moves with its parent", () => {
  // Real shape from the prod restore: kind:"task" rows with no local_id, whose
  // subtaskOf holds the parent's ROW ID. The local-id walk matches link -> local_id, so
  // it cannot see these at all; parent_id is the only edge that reaches them.
  const parent = blk("B1", null, { kind: "task" });
  const day = [
    parent,
    blk("B2", null, { kind: "task", parent_id: "B1" }),
    blk("B3", null, { kind: "task", parent_id: "B9" }), // someone else's child
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent), ["B1", "B2"]);
});

test("parent_id nesting moves the whole chain, not just the first generation", () => {
  const parent = blk("B1", "t1");
  const day = [parent, blk("B2", null, { kind: "task", parent_id: "B1" }), blk("B3", null, { kind: "task", parent_id: "B2" })];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B2", "B3"]);
});

test("the two edge spaces compose: a local-id child's own parent_id child comes too", () => {
  const parent = blk("B1", "t1");
  const day = [
    parent,
    blk("B2", "t2", { subtaskOf: "t1" }),               // reached by local-id link
    blk("B3", null, { kind: "task", parent_id: "B2" }), // reached by parent_id off THAT
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B2", "B3"]);
});

test("a duplicate local_id twin of the parent still moves with it", () => {
  // 28 live local_id collision groups on the prod restore (60 rows). Both twins have to
  // move: leaving one behind is a task that looks like it did not move at all. This is
  // also the case a parent_id-only walk loses — dcc_resolve_local_id returns NULL on the
  // tie, so neither twin nor its children ever got a parent_id edge.
  const parent = blk("B1", "t1");
  const day = [parent, blk("B1b", "t1"), blk("B2", "t2", { subtaskOf: "t1" })];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B1b", "B2"]);
});

test("a day_root in the pool is never walked into", () => {
  // A day_root's parent_id children are every task on that date, so treating one as a
  // subtree node would re-date the whole day.
  const parent = blk("B1", "t1");
  const day = [
    parent,
    { id: "day-root-ws-1-2026-07-31", type: "day_root", parent_id: null, properties: {} },
    blk("B9", "t9", { parent_id: "day-root-ws-1-2026-07-31" }), // unrelated task on the day
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent), ["B1"]);
});

test("rescheduling a day_root moves the container alone, never the day's tasks", () => {
  // Belt and braces: the route refuses a day_root outright (400), and the walk refuses
  // to propagate out of one. Enforced in both places on purpose — an invariant asserted
  // at one call site and merely commented at the other is this repo's repeat offender.
  const root = { id: "day-root-ws-1-2026-07-31", type: "day_root", parent_id: null, properties: {} };
  const day = [
    root,
    blk("B1", "t1", { parent_id: "day-root-ws-1-2026-07-31" }),
    blk("B2", "t2", { parent_id: "day-root-ws-1-2026-07-31" }),
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, root), ["day-root-ws-1-2026-07-31"]);
});

test("the parent is still first in the returned order", () => {
  // routes/blocks.js maps index 0 to the parent (it is the only entry that gets
  // parentStart/parentEnd and the rescheduledFrom stamp), so order is load-bearing.
  const parent = blk("B1", "t1");
  const day = [blk("B2", "t2", { subtaskOf: "t1" }), blk("B3", null, { kind: "task", parent_id: "B1" }), parent];
  assert.strictEqual(collectSubtreeBlockIds(day, parent)[0], "B1");
});

test("a parent_id cycle terminates instead of hanging", () => {
  const parent = blk("B1", "t1");
  const day = [parent, blk("B2", null, { kind: "task", parent_id: "B1" }), { id: "B1", type: "block", parent_id: "B2", properties: {} }];
  const ids = collectSubtreeBlockIds(day, parent);
  assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
  assert.ok(ids.includes("B1") && ids.includes("B2"));
});

test("a day_root is skipped as a subtree NODE even when an edge would admit it", () => {
  // Trips the `type === "day_root"` skip specifically. The other day_root test does not:
  // a real day_root has no local_id and a null parent_id, so nothing would have admitted
  // it anyway and the skip sits unreachable behind that. Here the day_root carries a
  // parent_id pointing INTO the tree — the corrupt-data shape migration 001's cycle
  // scrub exists for — so without the skip it joins, and then every task on that date
  // joins through it and the whole day gets re-dated.
  const parent = blk("B1", "t1");
  const day = [
    parent,
    { id: "day-root-ws-1-2026-07-31", type: "day_root", parent_id: "B1", properties: {} },
    blk("B9", "t9", { parent_id: "day-root-ws-1-2026-07-31" }), // unrelated task on the day
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent), ["B1"]);
});

test("a duplicate twin's OWN parent_id children move too", () => {
  // Trips the twin clause in the join, which the twin test above does not: that one
  // passes off the final collection pass (the twin's local_id is already in the tree),
  // so it stays green even with the join clause disabled. What the clause actually buys
  // is putting the twin's ROW ID into the frontier — without it the twin moves but
  // anything hanging off the twin by parent_id is left behind on the origin day.
  const parent = blk("B1", "t1");
  const day = [
    parent,
    blk("B1b", "t1"),                                    // duplicate local_id twin
    blk("B4", null, { kind: "task", parent_id: "B1b" }), // child of the TWIN, not of B1
  ];
  assert.deepStrictEqual(collectSubtreeBlockIds(day, parent).sort(), ["B1", "B1b", "B4"]);
});
