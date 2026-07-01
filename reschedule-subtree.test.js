const { test } = require("node:test");
const assert = require("node:assert");
const { collectSubtreeBlockIds } = require("./lib/reschedule");

// Build a task block the way DCC stores them: type "block" with a local_id and
// optional subtaskOf/wrapId linking to a parent's local_id.
function blk(id, localId, { subtaskOf, wrapId } = {}) {
  return { id, type: "block", properties: { local_id: localId, subtaskOf: subtaskOf || null, wrapId: wrapId || null } };
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
