// Contract tests for the single-path, immediate delete in public/js/state.js:
// _subtreeIdsOf + deleteTaskWithUndo + undoDeleteTask.
//
// The contract: a delete is one transactional batch of soft-deletes on the whole
// visible subtree, fired immediately (no setTimeout), through one entry point; Undo
// re-creates the snapshotted rows verbatim, parents before children.
//
// Harness pattern: recalc-times.test.js / slots-frontend-contract.test.js -- raw
// source sliced out of the browser file and run in a node:vm context with stubbed
// globals, since state.js has DOM side effects at load.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const TASK_BANK_SRC = fs.readFileSync(require.resolve("./public/js/task-bank.js"), "utf8");

const SUBTREE_SRC = mustMatch(STATE_SRC, /function _subtreeIdsOf\(rootId\)\{[\s\S]*?\n\}/, "_subtreeIdsOf");
const VIEWED_DATE_SRC = mustMatch(STATE_SRC, /function _viewedDateStr\(\)\{[\s\S]*?\n\}/, "_viewedDateStr");
// _deleteUndoSnapshots through the end of undoDeleteTask: the snapshot map and its
// stash helper, openDeleteConfirm, deleteTaskWithUndo and undoDeleteTask -- the whole
// delete region. Fail loudly rather than silently reviewing nothing if it moves.
const DELETE_SRC = mustMatch(
  STATE_SRC,
  /const _deleteUndoSnapshots[\s\S]*?\nasync function undoDeleteTask[\s\S]*?\n\}/,
  "the delete region in public/js/state.js"
);

function mustMatch(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error("delete-subtree.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

// Top-level `const`/`let` in the sliced source are lexical bindings, not properties of
// the vm context object, so they have to be read by evaluating their name.
const snapshotsOf = (ctx) => vm.runInContext("_deleteUndoSnapshots", ctx);

const DAY = "2026-07-29";

// Objects the sliced source builds live in the vm's realm, so their prototype is not
// this realm's Object.prototype and deepStrictEqual would reject an exact match.
// Compare values, not realms.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A row as blockStore caches it: type "block", subtask/ride-along edges by local_id.
function row(blockId, localId, props = {}) {
  return {
    id: blockId,
    type: "block",
    date: DAY,
    parent_id: null,
    sort_order: 0,
    properties: { local_id: localId, ...props }
  };
}

function ev(id, extra = {}) {
  return { id, title: "Task " + id, start: "09:00", end: "09:30", ...extra };
}

// Build a vm context around one day. `rows` maps ev id -> cached block row; an ev
// with no entry is a timeline-JSON item with nothing to delete server-side.
function makeDay({ scheduled, rows = {}, alreadyDeleted = [] }) {
  const batches = [];
  const toasts = [];
  const deletedSet = new Set(alreadyDeleted);
  const context = {
    console,
    scheduled,
    deletedSet,
    viewDate: DAY,
    __state: { date: DAY },
    saveDeletedState: () => {},
    log: () => {},
    recalcTimes: () => {},
    render: () => {},
    parentIdOf: (e) => (e && (e.wrapId || e.subtaskOf)) || null,
    // Mirrors the real resolver's contract (state.js:877) closely enough that the
    // delete path cannot quietly stop passing the args that make it safe: `ev`
    // supplies the _blockId fallback for a folded task whose row is keyed by
    // something other than the ev id, and a requested date that the row is not on
    // returns null rather than falling back to some other day's block.
    _findTaskBlockForDate: (id, dateStr, evArg) => {
      const byLocalId = rows[id] || null;
      const byBlockId = evArg && evArg._blockId
        ? Object.values(rows).find((b) => b.id === evArg._blockId) || null
        : null;
      const hit = byLocalId || byBlockId;
      if (!hit) return null;
      if (dateStr && hit.date && hit.date !== dateStr) return null;
      return hit;
    },
    showToast: (msg, kind, ms, action) => toasts.push({ msg, kind, ms, action }),
    window: {
      blockStore: {
        batchOp: async (operations) => {
          batches.push(operations);
          return {
            blocks: operations.map((op) =>
              op.op === "delete"
                ? { id: op.id, deleted_at: "2026-07-29T12:00:00.000Z" }
                : { id: "restored-" + op.properties.local_id, ...op, deleted_at: null }
            )
          };
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext([VIEWED_DATE_SRC, SUBTREE_SRC, DELETE_SRC].join("\n"), context);
  return { context, batches, toasts, deletedSet };
}

// ── _subtreeIdsOf ──

test("a leaf task is its own whole subtree", () => {
  const { context } = makeDay({ scheduled: [ev("t1"), ev("t2")] });
  assert.deepStrictEqual([...context._subtreeIdsOf("t1")], ["t1"]);
});

test("subtree carries direct subtasks and ride-alongs, not unrelated rows", () => {
  const { context } = makeDay({
    scheduled: [
      ev("t1"),
      ev("t2", { subtaskOf: "t1" }),
      ev("t3", { wrapId: "t1" }),
      ev("t4", { subtaskOf: "other" })
    ]
  });
  assert.deepStrictEqual([...context._subtreeIdsOf("t1")].sort(), ["t1", "t2", "t3"]);
});

test("nested subtasks come along, and the root comes first", () => {
  const { context } = makeDay({
    scheduled: [
      ev("t3", { subtaskOf: "t2" }), // deliberately out of tree order in the array
      ev("t1"),
      ev("t2", { subtaskOf: "t1" }),
      ev("t4", { subtaskOf: "t3" }),
      ev("t5")
    ]
  });
  // Assert the exact order, not a sorted copy: undoDeleteTask re-creates rows in
  // this order, and a child's subtaskOf edge is only valid if its parent was created
  // first. "root is first" alone would still pass for [t1, t3, t2, t4].
  assert.deepStrictEqual(
    [...context._subtreeIdsOf("t1")],
    ["t1", "t2", "t3", "t4"],
    "root, then children, then grandchildren -- regardless of scheduled[] order"
  );
});

test("a data cycle terminates without duplicates", () => {
  const { context } = makeDay({
    scheduled: [
      ev("t1", { subtaskOf: "t3" }), // pathological: root claims its own grandchild
      ev("t2", { subtaskOf: "t1" }),
      ev("t3", { subtaskOf: "t2" })
    ]
  });
  const ids = [...context._subtreeIdsOf("t1")];
  assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
  assert.deepStrictEqual(ids.sort(), ["t1", "t2", "t3"]);
});

// ── _viewedDateStr ──

test("_viewedDateStr prefers the viewed day and falls back to day state", () => {
  const { context } = makeDay({ scheduled: [] });
  assert.strictEqual(context._viewedDateStr(), DAY);
  context.viewDate = "2026-08-02";
  assert.strictEqual(context._viewedDateStr(), "2026-08-02", "the viewed day wins over __state.date");
  context.viewDate = null;
  assert.strictEqual(context._viewedDateStr(), DAY, "falls back to the loaded day state");
  context.__state = null;
  assert.strictEqual(context._viewedDateStr(), null);
});

// ── deleteTaskWithUndo ──

test("a subtask resolved only via ev._blockId is still deleted", async () => {
  // The row's local_id does not match the ev id -- the _blockId stamp persistence.js
  // puts on folded tasks is the only way to find it. Dropping the `ev` arg from the
  // resolver call would strand this row: exactly the resurrection bug.
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1", _blockId: "B2" })],
    rows: { t1: row("B1", "t1"), other: row("B2", "some-other-local-id") }
  });
  await day.context.deleteTaskWithUndo("t1");
  assert.deepStrictEqual(
    plain(day.batches[0]),
    [{ op: "delete", id: "B1" }, { op: "delete", id: "B2" }],
    "the child's block was found through ev._blockId"
  );
});

test("a subtree row sitting on another date is hidden but never deleted", async () => {
  // The resolver refuses a cross-date match rather than deleting some other day's
  // block. The row must still be hidden locally, but no op may be issued for it.
  const strayRow = row("B2", "t2");
  strayRow.date = "2026-07-15";
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" })],
    rows: { t1: row("B1", "t1"), t2: strayRow }
  });
  await day.context.deleteTaskWithUndo("t1");
  assert.deepStrictEqual(plain(day.batches[0]), [{ op: "delete", id: "B1" }], "no cross-date delete");
  assert.deepStrictEqual([...day.deletedSet].sort(), ["t1", "t2"], "both still hidden");
});

test("delete fires one transactional batch immediately, one op per row", async () => {
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" }), ev("t3", { wrapId: "t1" }), ev("t9")],
    rows: { t1: row("B1", "t1"), t2: row("B2", "t2"), t3: row("B3", "t3"), t9: row("B9", "t9") }
  });
  await day.context.deleteTaskWithUndo("t1");
  assert.strictEqual(day.batches.length, 1, "exactly one batchOp, not one call per row");
  assert.deepStrictEqual(plain(day.batches[0]), [
    { op: "delete", id: "B1" },
    { op: "delete", id: "B2" },
    { op: "delete", id: "B3" }
  ]);
});

test("delete hides the whole subtree and leaves siblings alone", async () => {
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" }), ev("t3", { wrapId: "t1" }), ev("t9")],
    rows: { t1: row("B1", "t1"), t2: row("B2", "t2"), t3: row("B3", "t3"), t9: row("B9", "t9") }
  });
  await day.context.deleteTaskWithUndo("t1");
  assert.deepStrictEqual([...day.deletedSet].sort(), ["t1", "t2", "t3"]);
});

test("a task with no backing row still hides, and issues no server op", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: {} });
  await day.context.deleteTaskWithUndo("t1");
  assert.strictEqual(day.batches.length, 0, "nothing server-side exists to delete");
  assert.ok(day.deletedSet.has("t1"), "the per-day overlay is the only correct record");
});

test("deleting twice is a no-op the second time", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") } });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.deleteTaskWithUndo("t1");
  assert.strictEqual(day.batches.length, 1);
});

test("delete offers Undo", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") } });
  await day.context.deleteTaskWithUndo("t1");
  assert.strictEqual(day.toasts.length, 1);
  assert.strictEqual(day.toasts[0].action.label, "Undo");
});

// ── undoDeleteTask ──

test("undo re-creates every row verbatim, parents before children", async () => {
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" }), ev("t3", { subtaskOf: "t2" })],
    rows: {
      t1: row("B1", "t1", {
        title: "Ship it",
        source_id: "https://slack.example/archives/C1/p1",
        prep_status: "ready",
        publicVisibility: "private",
        tags: ["deep"],
        detail: "notes survive",
        _locked: true
      }),
      t2: row("B2", "t2", { subtaskOf: "t1", title: "Sub" }),
      t3: row("B3", "t3", { subtaskOf: "t2", title: "Grandchild" })
    }
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");

  assert.strictEqual(day.batches.length, 2);
  const creates = plain(day.batches[1]);
  assert.deepStrictEqual(creates.map((c) => c.op), ["create", "create", "create"]);
  assert.deepStrictEqual(
    creates.map((c) => c.properties.local_id),
    ["t1", "t2", "t3"],
    "root, then child, then grandchild -- each parent exists before the row pointing at it"
  );
  // Every field the block carried comes back, including the ones a
  // persistAddedTask-shaped restore would have dropped on the floor.
  assert.deepStrictEqual(creates[0].properties, {
    local_id: "t1",
    title: "Ship it",
    source_id: "https://slack.example/archives/C1/p1",
    prep_status: "ready",
    publicVisibility: "private",
    tags: ["deep"],
    detail: "notes survive",
    _locked: true
  });
  assert.strictEqual(creates[0].type, "block");
  assert.strictEqual(creates[0].date, DAY);
  assert.strictEqual(day.deletedSet.size, 0, "the whole subtree is un-hidden");
});

test("undo re-points the live rows at their restored blocks", async () => {
  const parent = ev("t1", { _blockId: "B1" });
  const day = makeDay({
    scheduled: [parent],
    rows: { t1: row("B1", "t1") }
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(parent._blockId, "restored-t1", "a stale _blockId would aim the next delete at a tombstone");
});

test("undo does not resurrect a subtask deleted before its parent", async () => {
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" })],
    rows: { t1: row("B1", "t1"), t2: row("B2", "t2") },
    alreadyDeleted: ["t2"]
  });
  await day.context.deleteTaskWithUndo("t1");
  assert.deepStrictEqual(plain(day.batches[0]), [{ op: "delete", id: "B1" }], "t2 is already gone");
  await day.context.undoDeleteTask("t1");
  assert.deepStrictEqual([...day.deletedSet], ["t2"], "t2 stays deleted");
});

test("the snapshot map keeps the newest deletes and evicts oldest-first", async () => {
  // Numeric-looking ids are the trap: legacy DCC ids are Date.now()-based, and a plain
  // object would order those keys numerically ahead of every prefixed id, evicting a
  // recent snapshot instead of the oldest. A Map is immune; this pins that.
  const ids = ["1753812345678", "a-task", "1753812345679", ...Array.from({ length: 9 }, (_, i) => "t" + i)];
  const rowsById = {};
  ids.forEach((id, i) => { rowsById[id] = row("B" + i, id); });
  const day = makeDay({ scheduled: ids.map((id) => ev(id)), rows: rowsById });

  for (const id of ids) await day.context.deleteTaskWithUndo(id);

  const snaps = snapshotsOf(day.context);
  assert.strictEqual(snaps.size, 10, "capped at 10");
  assert.deepStrictEqual([...snaps.keys()], ids.slice(-10), "the 10 most recently deleted survive");
  assert.strictEqual(snaps.has("1753812345678"), false, "the oldest went first, numeric id or not");
});

test("re-deleting an id refreshes its place in the snapshot map", async () => {
  const day = makeDay({
    scheduled: [ev("keep"), ev("x1"), ev("x2")],
    rows: { keep: row("BK", "keep"), x1: row("B1", "x1"), x2: row("B2", "x2") }
  });
  await day.context.deleteTaskWithUndo("keep");
  await day.context.undoDeleteTask("keep");
  await day.context.deleteTaskWithUndo("x1");
  await day.context.deleteTaskWithUndo("keep");
  assert.deepStrictEqual([...snapshotsOf(day.context).keys()], ["x1", "keep"], "keep moved to the back");
});

test("undo still works when its snapshot was evicted", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") } });
  await day.context.deleteTaskWithUndo("t1");
  snapshotsOf(day.context).delete("t1"); // simulate eviction
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(day.deletedSet.has("t1"), false, "the row is un-hidden rather than stuck deleted");
});

test("undo on a task that isn't deleted does nothing", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") } });
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(day.batches.length, 0);
});

// ── the representations this phase removed ──

test("the 8-second delete timer is gone", () => {
  assert.strictEqual(STATE_SRC.includes("_deleteUndoTimers"), false, "_deleteUndoTimers must have 0 refs");
  assert.strictEqual(/setTimeout/.test(DELETE_SRC), false, "the delete path must fire immediately");
});

test("_purgeManualBlock and its source===manual gate are gone", () => {
  assert.strictEqual(STATE_SRC.includes("_purgeManualBlock"), false);
});

test("the backlog_deleted tombstone representation is gone", () => {
  assert.strictEqual(TASK_BANK_SRC.includes("backlog_deleted"), false);
  assert.strictEqual(TASK_BANK_SRC.includes("getBacklogDeleteBlock"), false);
  assert.strictEqual(TASK_BANK_SRC.includes("isTaskBankBacklogDeleted"), false);
});
