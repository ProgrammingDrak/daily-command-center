// Contract tests for the single-path, immediate delete in public/js/state.js:
// _subtreeIdsOf + deleteTaskWithUndo + undoDeleteTask.
//
// The contract: a delete is one transactional batch of soft-deletes on the whole
// visible subtree, fired immediately (no setTimeout), through one entry point; Undo
// revives those ORIGINAL rows through POST /api/blocks/:id/undelete (B2), after waiting
// for the delete to land -- the two are not commutative the way B1's re-create was.
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

const SUBTREE_SRC = mustMatch(STATE_SRC, /function _subtreeIdsOf\(rootId,pool\)\{[\s\S]*?\n\}/, "_subtreeIdsOf");
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
const snapshotsOf = ctx => {const m=vm.runInContext("_deleteUndoSnapshots",ctx);return {get:id=>m.get(DAY+":"+id)||m.get("pool:"+id),delete:id=>m.delete(DAY+":"+id),has:id=>m.has(DAY+":"+id),keys:()=>[...m.values()].map(s=>s.rootId).values(),get size(){return m.size;}};};

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
// `deferDelete` holds the delete batch open so a test can click Undo while it is still
// in flight -- the race that matters now that Undo revives the SAME row instead of
// creating a new one. Release it with the returned releaseDelete().
// `failDelete` makes the delete batch fail the way the real one does -- swallowed, empty
// blocks, entry left in the WAL -- which is the case Undo has to detect and cancel.
// `rejectUndelete` makes /undelete refuse permanently (a live twin holds the row's
// idempotency key, or the row is past the purge).
// `bufferUndelete` is the OTHER half of undeleteBlock's {ok, permanent} split: not-yet
// rather than never. `cancelFails` makes cancelBufferedWrite report that the queued delete
// already replayed, which is what happens when reconnecting fires replayWAL before the click.
function makeDay({ scheduled, rows = {}, alreadyDeleted = [], deferDelete = false, failDelete = false, rejectUndelete = false, bufferUndelete = false, cancelFails = false, storage = new Map() }) {
  const batches = [], restoreBatches = [], deleteTokens = [];
  const undeletes = [];
  const cancelled = [];
  const toasts = [];
  let _releaseDelete = null;
  const deletedSet = new Set(alreadyDeleted);
  const context = {
    console,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    _TM: () => require("./public/js/task-model"),
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
      DCC_ACCOUNT_CONTEXT:{userId:1,workspaceId:"ws-1"},
      blockStore: {
        batchOp: async (operations) => {
          batches.push(operations.map(op=>{const copy={...op};delete copy.deleteMutationId;return copy;}));
          deleteTokens.push(operations.map(op=>op.deleteMutationId));
          if (deferDelete) await new Promise((r) => { _releaseDelete = r; });
          // What the real batchOp returns when it swallows a failure and leaves the entry
          // in the WAL. Undo must notice this rather than treating it as landed.
          if (failDelete) return { blocks: [], walId: "wal-del", buffered: true };
          return {
            blocks: operations.map((op) => op.op === "delete"
              ? { id: op.id, deleted_at: "2026-07-29T12:00:00.000Z" }
              // A RE-CREATED row would come back under a new id, as it did pre-B2. Keep
              // answering that way even though nothing should create any more, so that a
              // returning re-create path actually trips the assertions below instead of
              // being masked by a stub that cannot express it.
              : { id: "restored-" + ((op.properties || {}).local_id), ...op, deleted_at: null }),
            walId: "wal-del",
            buffered: false
          };
        },
        restoreBlocks: async (ids,meta) => {
          restoreBatches.push({ids:[...ids],meta});undeletes.push(...ids);
          if (rejectUndelete) return { ok: false, permanent: true };
          if (bufferUndelete) return { ok: false, permanent: false,buffered:true };
          return { ok: true, blocks: ids.map(id=>({id,type:"block",properties:{_deleteUndoToken:meta.deleteMutationId},deleted_at:null})) };
        },
        // Mirrors the real signature: TRUE only when a still-pending entry was cancelled.
        cancelBufferedWrite: (walId, ids) => { cancelled.push({ walId, ids }); return !cancelFails; }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext([VIEWED_DATE_SRC, SUBTREE_SRC, DELETE_SRC].join("\n"), context);
  return {
    context, batches, restoreBatches,deleteTokens,storage,undeletes, cancelled, toasts, deletedSet,
    releaseDelete: () => { if (_releaseDelete) _releaseDelete(); },
  };
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

test("undo revives the ORIGINAL rows through /undelete and re-creates nothing", async () => {
  // B2 replaces B1's snapshot-and-recreate. The strongest statement of the new contract
  // is not "the fields come back" but "the row was never replaced, so there is no field
  // list that could drop one" -- so this asserts no create op reaches the server at all.
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

  assert.strictEqual(day.batches.length, 1, "one delete batch and one separately recorded atomic restore batch");
  const everyOp = plain(day.batches).flat();
  assert.ok(everyOp.every((o) => o.op === "delete"), "no create op is ever issued");
  assert.deepStrictEqual(day.undeletes, ["B1", "B2", "B3"], "one restore batch revives every original row ID");
  assert.strictEqual(day.deletedSet.size, 0, "the whole subtree is un-hidden");
});

test("undo keeps every id stable, so nothing needs re-pointing", async () => {
  // B1 had to re-point ev._blockId because the restored rows were new rows with new ids.
  // /undelete revives the same row, so the id the ev already holds stays correct -- and
  // that is the assertion, since a "restored-" style id appearing here would mean the
  // re-create path came back.
  const parent = ev("t1", { _blockId: "B1" });
  const day = makeDay({
    scheduled: [parent],
    rows: { t1: row("B1", "t1") }
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(parent._blockId, "B1", "the row id is unchanged, so _blockId was never stale");
  assert.deepStrictEqual(day.undeletes, ["B1"]);
});

test("undo CANCELS a delete that never landed, instead of reviving a row that was never deleted", async () => {
  // Awaiting the delete promise is not enough on its own: batchOp swallows its failure and
  // resolves either way, so a delete still sitting in the WAL looks exactly like one that
  // landed. If Undo just proceeded, it would undelete a row that was never deleted and
  // then the buffered batch would replay on the next reconnect and delete it for real --
  // silently, with the UI showing the task restored. Reachable inside the 8s toast:
  // delete while offline, reconnect, click Undo.
  const day = makeDay({
    scheduled: [ev("t1")],
    rows: { t1: row("B1", "t1") },
    failDelete: true
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");

  assert.deepStrictEqual(day.undeletes, ["B1"], "a cancelled or lost delete ack still needs authoritative restore confirmation");
  // plain(): `ids` is an array built inside the vm realm, so deepStrictEqual would reject
  // it on prototype identity alone.
  assert.deepStrictEqual(plain(day.cancelled), [{ walId: "wal-del", ids: ["B1"] }], "the queued delete is abandoned, not left to replay");
  assert.strictEqual(day.deletedSet.size, 0, "and the task is un-hidden");
});

test("if the buffered delete already replayed, undo stops trusting the flag and undeletes for real", async () => {
  // `buffered` is a snapshot from when the batch failed; replayWAL fires on `online` with no
  // delay, so the delete can land in the gap before the click. cancelBufferedWrite reporting
  // false is the only way to know, and skipping the undelete on a stale flag would leave the
  // row deleted server-side while the UI claims it is back.
  const day = makeDay({
    scheduled: [ev("t1")],
    rows: { t1: row("B1", "t1") },
    failDelete: true,
    cancelFails: true
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");
  assert.deepStrictEqual(day.undeletes, ["B1"], "it falls through and revives the row for real");
  assert.strictEqual(day.deletedSet.size, 0);
});

test("a buffered atomic restore retains retry metadata and never reports success", async () => {
  // Only a PERMANENT rejection may re-hide. Treating a retryable failure the same way would
  // persist a hide through saveDeletedState while the WAL goes on to succeed, leaving the row
  // live server-side and invisible locally across reloads -- this phase's bug, inverted.
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") }, bufferUndelete: true });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(day.deletedSet.size, 1, "the whole tree stays hidden until confirmed");
  const last = day.toasts[day.toasts.length - 1];
  assert.match(last.msg, /pending/);assert.equal(last.action.label,"Retry");assert.equal(snapshotsOf(day.context).get("t1").state,"pending");
});

test("a permanently rejected undelete re-hides the task instead of claiming it came back", async () => {
  // 409 from /undelete means a live row already holds this tombstone's idempotency key.
  // The row stays deleted server-side, so leaving the overlay un-hidden would show a task
  // that vanishes again on the next reload.
  const day = makeDay({
    scheduled: [ev("t1"), ev("t2", { subtaskOf: "t1" })],
    rows: { t1: row("B1", "t1"), t2: row("B2", "t2") },
    rejectUndelete: true
  });
  await day.context.deleteTaskWithUndo("t1");
  await day.context.undoDeleteTask("t1");

  assert.deepStrictEqual(day.undeletes, ["B1", "B2"], "it tried every row");
  assert.deepStrictEqual([...day.deletedSet].sort(), ["t1", "t2"], "and put the hide back when the server refused");
  const last = day.toasts[day.toasts.length - 1];
  assert.match(last.msg, /Could not restore/, "the user is told the truth, not 'Task restored'");
  assert.strictEqual(last.kind, "error");
});

test("undo waits for the in-flight delete before reviving, or the restore is lost", async () => {
  // The one race /undelete introduces that B1's design did not have. Undo is clickable
  // while the delete batch is still in flight; if the undelete reached the server first
  // it would clear a deleted_at that is not set yet, the delete would then land, and the
  // task would be gone server-side while the UI showed it restored.
  const day = makeDay({
    scheduled: [ev("t1")],
    rows: { t1: row("B1", "t1") },
    deferDelete: true
  });
  const deleting = day.context.deleteTaskWithUndo("t1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(day.batches.length, 1, "the delete is in flight");

  const undoing = day.context.undoDeleteTask("t1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(day.undeletes, [], "undo must NOT have revived anything yet");

  day.releaseDelete();
  await Promise.all([deleting, undoing]);
  assert.deepStrictEqual(day.undeletes, ["B1"], "it revives only once the delete has landed");
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

test("missing Undo history fails closed rather than reviving an unknown subtree", async () => {
  const day = makeDay({ scheduled: [ev("t1")], rows: { t1: row("B1", "t1") } });
  await day.context.deleteTaskWithUndo("t1");
  snapshotsOf(day.context).delete("t1"); // simulate eviction
  await day.context.undoDeleteTask("t1");
  assert.strictEqual(day.deletedSet.has("t1"), true, "unknown tree membership cannot be presented as restored");
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


test("Whenever delete and undo use the normal transactional subtree path and original rows",async()=>{
  const items=[ev("parent"),ev("sub",{subtaskOf:"parent"}),ev("nested",{wrapId:"parent"}),ev("deep",{subtaskOf:"nested"})];
  const rows=Object.fromEntries(items.map(item=>[item.id,{...row("row-"+item.id,item.id),date:null}]));
  const h=makeDay({scheduled:[],rows});h.context.backlog=items;
  h.context.taskAnchorById=id=>({ev:items.find(item=>item.id===id),whenever:true,date:null});
  await h.context.deleteTaskWithUndo("parent");
  assert.deepEqual(plain(h.batches),[items.map(item=>({op:"delete",id:"row-"+item.id}))]);
  assert.deepEqual([...h.deletedSet].sort(),items.map(item=>item.id).sort());
  await h.context.undoDeleteTask("parent");
  assert.deepEqual(h.undeletes,items.map(item=>"row-"+item.id));assert.equal(h.deletedSet.size,0);
});


test("delete and Undo preserve all 1,500 mixed descendants and original row IDs", async () => {
  const tasks=Array.from({length:1500},(_,i)=>ev("deep-"+i,i?{[i%2?"subtaskOf":"wrapId"]:"deep-"+(i-1)}:{}));
  const rows=Object.fromEntries(tasks.map(e=>[e.id,row("row-"+e.id,e.id,{notes:"Keep "+e.id,subtaskOf:e.subtaskOf,wrapId:e.wrapId})]));
  const day=makeDay({scheduled:tasks,rows});
  await day.context.deleteTaskWithUndo("deep-0");
  assert.equal(day.deletedSet.size,1500);assert.equal(day.batches[0].length,1500);
  await day.context.undoDeleteTask("deep-0");
  assert.equal(day.deletedSet.size,0);assert.equal(day.undeletes.length,1500);
  assert.deepEqual(new Set(day.undeletes),new Set(Object.values(rows).map(r=>r.id)));
  assert.equal(day.batches.length,1,"Undo revives original rows rather than re-creating them");
});

test("a repeated delete waits for an in-flight Undo touching the same descendant row", async () => {
  const tasks=[ev("t1"),ev("t2",{subtaskOf:"t1"})];
  const day=makeDay({scheduled:tasks,rows:{t1:row("B1","t1"),t2:row("B2","t2")}});
  const persisted=new Set(),store=day.context.window.blockStore;
  store.batchOp=async operations=>{day.batches.push(operations);operations.forEach(op=>persisted.add(op.id));return {blocks:[],buffered:false};};
  let release,started;const inverseStarted=new Promise(resolve=>started=resolve);
  store.restoreBlocks=async ids=>{day.undeletes.push(...ids);started();await new Promise(resolve=>release=resolve);ids.forEach(id=>persisted.delete(id));return {ok:true};};
  await day.context.deleteTaskWithUndo("t1");
  const undo=day.context.undoDeleteTask("t1");await inverseStarted;
  const again=day.context.deleteTaskWithUndo("t2");
  release();await Promise.all([undo,again]);
  assert.deepEqual([...persisted],["B2"],"newer deletion must land after the older restore of its row");
  assert.equal(day.deletedSet.has("t2"),true);
});


test("failed atomic restore survives reload and Retry restores exactly the original tree",async()=>{
  const storage=new Map(),tasks=[ev("t1"),ev("t2",{subtaskOf:"t1"})],rows={t1:row("B1","t1"),t2:row("B2","t2")};
  const first=makeDay({scheduled:tasks,rows,storage,rejectUndelete:true});
  await first.context.deleteTaskWithUndo("t1");await first.context.undoDeleteTask("t1");
  assert.equal(first.deletedSet.size,2);assert.equal(snapshotsOf(first.context).get("t1").state,"failed");
  assert(!first.toasts.some(t=>t.msg==="Task restored"));
  const reload=makeDay({scheduled:tasks,rows,storage,alreadyDeleted:["t1","t2"]});
  await reload.context.undoDeleteTask("t1");
  assert.deepEqual(reload.undeletes,["B1","B2"]);assert.equal(reload.deletedSet.size,0);
  assert.equal(reload.restoreBatches[0].meta.deleteMutationId,first.deleteTokens[0][0]);
  assert.equal(reload.toasts.filter(t=>t.msg==="Task restored").length,1);
});

test("an older replay acknowledgement cannot unhide a newer child deletion",async()=>{
  const tasks=[ev("t1"),ev("t2",{subtaskOf:"t1"})],rows={t1:row("B1","t1"),t2:row("B2","t2")};
  const day=makeDay({scheduled:tasks,rows,bufferUndelete:true});
  await day.context.deleteTaskWithUndo("t1");await day.context.undoDeleteTask("t1");
  const old=day.restoreBatches[0].meta;
  day.context.deletedSet.delete("t2");await day.context.deleteTaskWithUndo("t2");
  day.context._applyTaskRestoreOutcome(old,{ok:true});
  assert.equal(day.deletedSet.has("t1"),false);assert.equal(day.deletedSet.has("t2"),true);
});

test("a failed tree restore rehydrates a persistent Retry notice without reporting success",async()=>{
 const storage=new Map(),nodes=[ev("root"),ev("child",{subtaskOf:"root"})],rows={root:row("b-root","root"),child:row("b-child","child",{subtaskOf:"root"})};
 const first=makeDay({scheduled:nodes,rows,rejectUndelete:true,storage});await first.context.deleteTaskWithUndo("root");await first.context.undoDeleteTask("root");
 const reload=makeDay({scheduled:nodes,rows,storage});vm.runInContext("restoreDeleteUndoState()",reload.context);
 assert.deepEqual([...reload.deletedSet].sort(),["child","root"]);assert.equal(reload.toasts.length,1);assert.equal(reload.toasts[0].ms,0);assert.equal(reload.toasts[0].action.label,"Retry");
 await reload.toasts[0].action.onClick();assert.equal(reload.restoreBatches.length,1);assert.equal(reload.deletedSet.size,0);
});

test("Retry remains bound to the original dated occurrence and cannot unhide another day's occurrence",async()=>{
 const rows={same:row("today-row","same")},day=makeDay({scheduled:[ev("same")],rows,rejectUndelete:true});
 await day.context.deleteTaskWithUndo("same");await day.context.undoDeleteTask("same");
 const oldRetry=day.toasts.at(-1).action.onClick,oldToken=day.restoreBatches[0].meta.deleteMutationId;
 day.context.viewDate="2026-07-30";rows.same={...row("tomorrow-row","same"),date:"2026-07-30"};day.deletedSet.clear();
 await day.context.deleteTaskWithUndo("same");
 await oldRetry();assert.equal(day.deletedSet.has("same"),true,"off-date rejection leaves current date hidden");
 assert.deepEqual(day.restoreBatches.at(-1).ids,["today-row"]);assert.equal(day.restoreBatches.at(-1).meta.deleteMutationId,oldToken);
 day.context.viewDate=DAY;await oldRetry();assert.deepEqual(day.restoreBatches.at(-1).ids,["today-row"]);
 assert.equal(day.deletedSet.has("same"),true);assert.equal(vm.runInContext("_deleteUndoSnapshots.size",day.context),2);
});

test("a stale Retry cannot choose a newer deletion of the same dated tree",async()=>{
 const day=makeDay({scheduled:[ev("same")],rows:{same:row("same-row","same")},rejectUndelete:true});
 await day.context.deleteTaskWithUndo("same");await day.context.undoDeleteTask("same");const retry=day.toasts.at(-1).action.onClick;
 day.deletedSet.delete("same");await day.context.deleteTaskWithUndo("same");const count=day.restoreBatches.length;
 await retry();assert.equal(day.restoreBatches.length,count);assert.equal(day.deletedSet.has("same"),true);
});
