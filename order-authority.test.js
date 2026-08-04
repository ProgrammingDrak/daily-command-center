// C6b: one order authority. `sort_order` on the row is the only persisted order; pins and locks
// live on the row (`properties._pinnedStart`, `properties.locked`) instead of the `day_root`
// overlay maps `_pinnedStarts` / `_lockedTasks`.
//
// What these pin, in the order the bugs bit:
//   1. the ORDER reads derive from `sort_order`, and the overlay is only a FALLBACK. Migration
//      001 already backfilled sort_order on every live task row and `saveTaskOrder` has
//      dual-written since, so the overlay is redundant, not authoritative.
//   2. `_writeRowOrder` keys on the EV ID. The old dual-write filtered rows by
//      `local_id && start`, which silently excluded 1546 of 1815 live task rows (no local_id)
//      and 37 more (untimed) from ever being reordered.
//   3. a no-op pin / unlock does NOT write. The row-props queue treats a null merge as "skip",
//      and without that every render that touched a pin map PATCHed rows for nothing.
//   4. the reads TOLERATE migration 003 not having run. That is what makes this one PR instead
//      of the C5a -> 002 -> C5b dance: a deploy landing before the apply loses nothing.
//   5. every fallback hit is COUNTED, so the canary can say whether the overlay is still
//      load-bearing rather than guessing.
//
// Harness: the pure slices run in a node:vm context over a fake blockStore, with the REAL
// TaskModel installed (task-model-vm-fixture.js) so `isTaskRow` is the shipped predicate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { installTaskModel } = require("./task-model-vm-fixture.js");
const { stripJsComments } = require("./js-comment-strip-fixture.js");

const read = (f) => fs.readFileSync(require.resolve("./public/js/" + f), "utf8");
const one = (src, re, what) => { const m = src.match(re); if (!m) throw new Error("slice failed: " + what); return m[0]; };
const schedSrc = read("schedule.js");
const persistSrc = read("persistence.js");
const schedCode = stripJsComments(schedSrc);
const persistCode = stripJsComments(persistSrc);
const stateCode = stripJsComments(read("state.js"));

// A blockStore row. `sort_order` is a top-level COLUMN, not a property.
const row = (id, sort_order, props, date) => ({
  id, type: "block", date: date === undefined ? "2026-08-04" : date,
  sort_order, deleted_at: null,
  properties: Object.assign({ title: id, type: "task" }, props || {}),
});

function ctx(rows, overlay) {
  const reordered = [];
  const updated = [];
  const store = {
    _rows: rows.slice(),
    getByType(t) { return t === "block" ? this._rows : []; },
    getDayRootId() { return "root"; },
    get(id) { return id === "root" ? { id: "root", properties: overlay || {} } : this._rows.find((r) => r.id === id) || null; },
    reorder(items) { reordered.push(...items); items.forEach((i) => { const r = this._rows.find((x) => x.id === i.id); if (r) r.sort_order = i.sort_order; }); return Promise.resolve(); },
    updateBlock(id, props) { updated.push({ id, props }); const r = this._rows.find((x) => x.id === id); if (r) r.properties = props; return Promise.resolve(); },
  };
  const c = {
    console,
    window: null,
    localStorage: { getItem: () => null, setItem: () => {} },
    __state: { date: "2026-08-04" },
    scheduleIDBSave() {},
    scheduled: [],
    PINNED_KEY: "pa-pinned-starts-2026-08-04",
    LOCKED_KEY: "pa-locked-tasks-2026-08-04",
    ORDER_KEY: "pa-task-order-2026-08-04",
    SUBTASK_ORDER_KEY: "pa-subtask-order-2026-08-04",
    reordered, updated,
  };
  c.window = c;
  c.self = c;
  c.USE_BLOCKSTORE = { reorder: true };
  c.blockStore = store;
  vm.createContext(c);
  installTaskModel(c);
  // the day-root overlay accessors, and the row-props writer the pin/lock paths route through
  vm.runInContext(one(persistSrc, /function _bsProp\(key, def\) \{[\s\S]*?\n\}/, "_bsProp"), c);
  vm.runInContext(one(persistSrc, /function _bsSaveProp\(key, value\) \{[\s\S]*?\n\}/, "_bsSaveProp"), c);
  // persistRowProp resolves the row itself, so a minimal stand-in for the resolver + queue that
  // writes through the SAME blockStore.updateBlock the real queue uses.
  vm.runInContext(`
    function _findTaskBlockForDate(id){ return blockStore.getByType("block").find(b=>String(b.properties.local_id||b.id)===String(id))||null; }
    function enqueueRowPropsWrite(blockId, merge){
      const b = blockStore.getByType("block").find(x=>x.id===blockId);
      if(!b||!b.properties) return null;
      const next = merge(b.properties);
      if(next) blockStore.updateBlock(b.id, next);
      return null;
    }
  `, c);
  vm.runInContext(one(read("state.js"), /function persistRowProp\(id,key,value,ev\)\{[\s\S]*?\n\}/, "persistRowProp"), c);
  for (const re of [
    /window\.__DCC_C6B_FALLBACK = window\.__DCC_C6B_FALLBACK \|\| \{\};/,
    /function _c6bFallback\(key,n\)\{[\s\S]*?\n\}/,
    /function _orderableRows\(\)\{[\s\S]*?\n\}/,
    /function _evIdOfRow\(b\)\{[^\n]*\}/,
    /function _orderFromRows\(pick\)\{[\s\S]*?\n\}/,
    /function _writeRowOrder\(ids\)\{[\s\S]*?\n\}/,
    /function loadPinnedStarts\(\)\{[\s\S]*?\n\}/,
    /function savePinnedStarts\(data\)\{[\s\S]*?\n\}/,
    /function loadLockedSet\(\)\{[\s\S]*?\n\}/,
    /function saveLockedSet\(ids\)\{[\s\S]*?\n\}/,
    /function loadTaskOrder\(\)\{[\s\S]*?\n\}/,
    /function loadUnscheduledOrder\(\)\{[\s\S]*?\n\}/,
  ]) vm.runInContext(one(schedSrc, re, String(re)), c);
  vm.runInContext(one(persistSrc, /function loadSubtaskOrder\(\)\{[\s\S]*?\n\}/, "loadSubtaskOrder"), c);
  return c;
}
const run = (c, expr) => JSON.parse(vm.runInContext("JSON.stringify(" + expr + ")", c));

// ══════════════════════════════════ order reads ══════════════════════════════════

test("★ loadTaskOrder derives from sort_order, and the overlay is only a fallback", () => {
  // 001 backfilled sort_order on every live task row and saveTaskOrder has dual-written since,
  // so the overlay is redundant. It must NOT win: an overlay older than a dual-written
  // sort_order would silently undo a real drag.
  const c = ctx(
    [row("r1", 3000, { local_id: "b" }), row("r2", 1000, { local_id: "a" }), row("r3", 2000, { local_id: "c" })],
    { _taskOrder: ["c", "b", "a"] }
  );
  assert.deepEqual(run(c, "loadTaskOrder()"), ["a", "c", "b"], "sort_order order, not the overlay's");
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), {}, "no fallback was needed");
});

test("loadTaskOrder falls back to the overlay only when NO row is orderable", () => {
  const c = ctx([], { _taskOrder: ["x", "y"] });
  assert.deepEqual(run(c, "loadTaskOrder()"), ["x", "y"]);
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), { taskOrder: 2 }, "and the hit is COUNTED");
});

test("a row with no sort_order sorts LAST, matching the 9999 sentinel it replaces", () => {
  const c = ctx([row("r1", null, { local_id: "late" }), row("r2", 1000, { local_id: "first" })], {});
  assert.deepEqual(run(c, "loadTaskOrder()"), ["first", "late"]);
});

test("an ev id with no local_id keys on the ROW id", () => {
  // 1546 of 1815 live task rows have no local_id. Keying on local_id alone is what excluded
  // them from every reorder.
  const c = ctx([row("row-api", 1000, {}), row("row-b", 2000, { local_id: "b" })], {});
  assert.deepEqual(run(c, "loadTaskOrder()"), ["row-api", "b"]);
});

test("loadTaskOrder skips non-task rows (day_root, time_entry, delegated_item, task_group)", () => {
  const c = ctx([
    row("keep", 1000, { local_id: "keep" }),
    Object.assign(row("dr", 500, {}), { type: "day_root" }),
    row("te", 600, { kind: "delegated_item" }),
    row("tg", 700, { kind: "task_group" }),
  ], {});
  assert.deepEqual(run(c, "loadTaskOrder()"), ["keep"]);
});

test("★ loadUnscheduledOrder covers the untimed rows AND past-day carryovers", () => {
  // The axis the overlay was worst at: 1 day_root, 7 ids, 0 of them row ids, 3 live local_ids,
  // 4 dead. The section mixes untimed today rows with carryovers on OTHER dates, and an overlay
  // on the viewed day cannot name a row that lives on another date -- so carryovers had no
  // order authority at all. On the row, each one carries its own.
  const c = ctx([
    row("u1", 2000, { local_id: "untimed-today" }),                       // no start -> untimed
    row("u2", 1000, { local_id: "carryover" }, "2026-08-01"),              // a PAST day
    row("t1", 500, { local_id: "timed", start: "09:00" }),                 // timed -> excluded
    row("z1", 3000, { local_id: "zero", start: "00:00" }),                 // 00:00 counts as untimed
  ], {});
  assert.deepEqual(run(c, "loadUnscheduledOrder()"), ["carryover", "untimed-today", "zero"]);
});

test("loadSubtaskOrder groups children by parent, each in its own sort_order", () => {
  const c = ctx([
    row("p", 1000, { local_id: "p" }),
    row("k2", 2000, { local_id: "k2", subtaskOf: "p" }),
    row("k1", 1500, { local_id: "k1", subtaskOf: "p" }),
    row("o1", 900, { local_id: "o1", subtaskOf: "other" }),
  ], { _subtaskOrder: { p: ["k2", "k1"] } });
  assert.deepEqual(run(c, "loadSubtaskOrder()"), { p: ["k1", "k2"], other: ["o1"] },
    "sort_order wins over the overlay map");
});

// ══════════════════════════════════ order writes ═════════════════════════════════

test("★ _writeRowOrder reorders a row with NO local_id and a row with NO start", () => {
  // The two shapes `local_id && start` dropped. This is the hole the old dual-write left.
  const c = ctx([row("row-api", 9000, {}), row("row-untimed", 8000, { local_id: "u" })], {});
  assert.equal(vm.runInContext('_writeRowOrder(["u","row-api"])', c), 2, "both rows were written");
  assert.deepEqual(run(c, "reordered"), [{ id: "row-untimed", sort_order: 1000 }, { id: "row-api", sort_order: 2000 }]);
});

test("_writeRowOrder skips a row whose sort_order is already correct, and unknown ids", () => {
  const c = ctx([row("r1", 1000, { local_id: "a" }), row("r2", 5000, { local_id: "b" })], {});
  assert.equal(vm.runInContext('_writeRowOrder(["a","b"])', c), 1, "only r2 moved");
  assert.deepEqual(run(c, "reordered"), [{ id: "r2", sort_order: 2000 }]);
  assert.equal(vm.runInContext('_writeRowOrder(["a","b"])', c), 0, "second call is a no-op");
  assert.equal(vm.runInContext('_writeRowOrder(["ghost"])', c), 0, "an id with no row writes nothing");
  assert.equal(vm.runInContext("_writeRowOrder([])", c), 0);
  assert.equal(vm.runInContext("_writeRowOrder(null)", c), 0);
});

test("the retired overlay WRITES are gone from all three order paths", () => {
  for (const key of ["_taskOrder", "_unscheduledOrder", "_subtaskOrder"]) {
    const rx = new RegExp("_bsSaveProp\\(\\s*[\"']" + key + "[\"']");
    assert.equal(rx.test(schedCode) || rx.test(persistCode), false, key + " is still written to the day_root");
    // Negative control: the guard must fire on the code it retired.
    assert.ok(rx.test('_bsSaveProp("' + key + '", order);'));
  }
});

// ══════════════════════════════════ pins and locks ═══════════════════════════════

test("★ loadPinnedStarts reads the ROW, with the overlay filling only what no row carries", () => {
  const c = ctx(
    [row("r1", 1000, { local_id: "a", _pinnedStart: "09:00" }), row("r2", 2000, { local_id: "b" })],
    { _pinnedStarts: { a: "23:59", b: "14:00", ghost: "07:00" } }
  );
  const pins = run(c, "loadPinnedStarts()");
  assert.equal(pins.a, "09:00", "the ROW wins over the overlay");
  assert.equal(pins.b, "14:00", "the overlay fills a row that has none yet");
  assert.equal(pins.ghost, "07:00", "and an id with no row at all still resolves");
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), { pinnedStarts: 2 }, "both fallbacks COUNTED");
});

test("★ savePinnedStarts writes the row, heals an overlay-only pin, and clears a removed one", () => {
  const c = ctx(
    [row("r1", 1000, { local_id: "a", _pinnedStart: "09:00" }), row("r2", 2000, { local_id: "b" })],
    { _pinnedStarts: { b: "14:00" } }
  );
  // b was overlay-only; touching the map pushes it onto its row (the "heals when touched"
  // pattern C4 used for dated backlog rows).
  vm.runInContext('savePinnedStarts({a:"09:00", b:"14:00"})', c);
  const upd = run(c, "updated");
  assert.equal(upd.length, 1, "only the row that changed was written: " + JSON.stringify(upd));
  assert.equal(upd[0].id, "r2");
  assert.equal(upd[0].props._pinnedStart, "14:00");
  // and removing a pin CLEARS the key rather than storing a falsy value
  const c2 = ctx([row("r1", 1000, { local_id: "a", _pinnedStart: "09:00" })], {});
  vm.runInContext("savePinnedStarts({})", c2);
  const u2 = run(c2, "updated");
  assert.equal(u2.length, 1);
  assert.equal("_pinnedStart" in u2[0].props, false, "the key is deleted, not set falsy");
});

test("★ a no-op savePinnedStarts writes NOTHING, and does not even enqueue", () => {
  const c = ctx([
    row("r1", 1000, { local_id: "a", _pinnedStart: "09:00" }),
    row("r2", 2000, { local_id: "b", _pinnedStart: "10:00" }),
  ], {});
  // The RETURN VALUE is the contract: it counts rows this call decided to change. Asserting only
  // `updated` hides a version that enqueues a no-op write per row on every save -- harmless
  // per-row because persistRowProp skips it too, but N pointless queue links on a 40-row day,
  // and a wrong answer from a function whose whole job is to report what moved.
  assert.equal(vm.runInContext('savePinnedStarts({a:"09:00", b:"10:00"})', c), 0,
    "nothing changed, so nothing was even considered written");
  assert.deepEqual(run(c, "updated"), [], "an unchanged pin must not PATCH the row");
  assert.equal(vm.runInContext('savePinnedStarts({a:"09:00", b:"11:00"})', c), 1, "exactly one row moved");
});

test("★ persistRowProp CLEARS on every falsy value, not just undefined", () => {
  // `false` is the one that matters: a reader testing `p.locked` and a reader testing
  // `"locked" in p` must not disagree, and 001 wrote nothing for locks at all, so absence is the
  // only value that has ever meant not-locked. Asserted behaviourally -- the first cut of this
  // source-grepped the falsy list and a mutation removing it passed.
  for (const falsy of ["undefined", "null", "false"]) {
    const c = ctx([row("r1", 1000, { local_id: "a", locked: true, _pinnedStart: "09:00" })], {});
    vm.runInContext(`persistRowProp("a","locked",${falsy},null)`, c);
    const upd = run(c, "updated");
    assert.equal(upd.length, 1, falsy + " should have cleared the key");
    assert.equal("locked" in upd[0].props, false, falsy + " must DELETE the key, not store it");
    assert.equal(upd[0].props._pinnedStart, "09:00", "and must not disturb the rest of the bag");
  }
  // A real value is stored as-is, and an unresolvable id writes nothing.
  const c2 = ctx([row("r1", 1000, { local_id: "a" })], {});
  vm.runInContext('persistRowProp("a","_pinnedStart","07:30",null)', c2);
  assert.equal(run(c2, "updated")[0].props._pinnedStart, "07:30");
  const c3 = ctx([row("r1", 1000, { local_id: "a" })], {});
  vm.runInContext('persistRowProp("ghost","locked",true,null)', c3);
  assert.deepEqual(run(c3, "updated"), [], "an id with no row writes nothing");
});

test("★ locks live on the row; the overlay is a counted fallback and prod has ZERO of it", () => {
  const c = ctx(
    [row("r1", 1000, { local_id: "a", locked: true }), row("r2", 2000, { local_id: "b" })],
    { _lockedTasks: ["b"] }
  );
  assert.deepEqual(run(c, "loadLockedSet()").sort(), ["a", "b"]);
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), { lockedTasks: 1 });
  // the object-map shape db.js also accepts
  const c2 = ctx([row("r1", 1000, { local_id: "a" })], { _lockedTasks: { z: true } });
  assert.deepEqual(run(c2, "loadLockedSet()"), ["z"]);
});

test("saveLockedSet toggles the row key and clears it on unlock, writing only what changed", () => {
  const c = ctx([row("r1", 1000, { local_id: "a", locked: true }), row("r2", 2000, { local_id: "b" })], {});
  vm.runInContext('saveLockedSet(["b"])', c);
  const upd = run(c, "updated");
  assert.equal(upd.length, 2, "a unlocked, b locked");
  const byId = Object.fromEntries(upd.map((u) => [u.id, u.props]));
  assert.equal("locked" in byId.r1, false, "unlock DELETES the key -- absence is the only value that has ever meant not-locked");
  assert.equal(byId.r2.locked, true);
  // idempotent
  const c2 = ctx([row("r1", 1000, { local_id: "a", locked: true })], {});
  vm.runInContext('saveLockedSet(["a"])', c2);
  assert.deepEqual(run(c2, "updated"), []);
});

test("the retired overlay WRITES are gone from the pin and lock paths", () => {
  for (const key of ["_pinnedStarts", "_lockedTasks"]) {
    const rx = new RegExp("_bsSaveProp\\(\\s*[\"']" + key + "[\"']");
    assert.equal(rx.test(schedCode), false, key + " is still written to the day_root");
    assert.ok(rx.test('_bsSaveProp("' + key + '", data)'));
  }
});

// ═══════════════ THE DURABLE GUARD: exactly one reader per retired key ═══════════════
//
// C6a's lesson: a refactor that removes duplication is worth nothing without a guard, because
// the next feature adds the duplicate back. The five overlay keys are now WRITTEN nowhere and
// READ in exactly one place each -- the fallback inside their own loader. Anything else reaching
// for a `day_root` order/pin/lock key is the drift this phase deletes.
//
// A4 removes the keys and these fallbacks together, at which point this guard's expected count
// per key drops to 0 and the test says so out loud rather than silently passing.
const RETIRED_KEYS = {
  _taskOrder: { file: "schedule.js", reader: "loadTaskOrder" },
  _unscheduledOrder: { file: "schedule.js", reader: "loadUnscheduledOrder" },
  _subtaskOrder: { file: "persistence.js", reader: "loadSubtaskOrder" },
  _pinnedStarts: { file: "schedule.js", reader: "loadPinnedStarts" },
  _lockedTasks: { file: "schedule.js", reader: "loadLockedSet" },
};

test("★ each retired overlay key is read in EXACTLY ONE place, and written nowhere", () => {
  const dir = require("node:path").join(__dirname, "public", "js");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  for (const [key, spec] of Object.entries(RETIRED_KEYS)) {
    const hits = [];
    for (const f of files) {
      const code = stripJsComments(fs.readFileSync(require("node:path").join(dir, f), "utf8"));
      const rx = new RegExp("[\"']" + key + "[\"']", "g");
      let m;
      while ((m = rx.exec(code))) hits.push(f + ":" + code.slice(0, m.index).split("\n").length);
    }
    assert.equal(hits.length, 1,
      key + " must appear exactly once (the fallback read in " + spec.file + " " + spec.reader +
      "), found: " + JSON.stringify(hits));
    assert.ok(hits[0].startsWith(spec.file + ":"), key + " moved out of " + spec.file + ": " + hits[0]);
    // and that one occurrence is inside its own loader, not somewhere else in the file
    const src = read(spec.file);
    const fn = one(src, new RegExp("function " + spec.reader + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"), spec.reader);
    assert.ok(stripJsComments(fn).includes(key), key + " is in " + spec.file + " but not inside " + spec.reader);
  }
  // Negative control: the guard must fire when a key is read a second time.
  const rx = new RegExp("[\"']_taskOrder[\"']", "g");
  assert.equal(('_bsProp("_taskOrder",null); _bsSaveProp("_taskOrder",x);'.match(rx) || []).length, 2);
});

// ══════════════════════════ the deploy-order tolerance claim ══════════════════════

test("★ every read tolerates migration 003 NOT having run — this is why C6b is one PR", () => {
  // The C6b brief warned that a deploy landing before the manual apply "loses every manual drag
  // order", which is true only for a canonical-ONLY read. With canonical-first plus an overlay
  // fallback there is no such window, and that is what removed the C5a -> 002 -> C5b dance.
  // Pre-migration shape: the overlay holds everything, no row carries a canonical value.
  const pre = ctx(
    [row("r1", 1000, { local_id: "a" }), row("r2", 2000, { local_id: "b" })],
    { _pinnedStarts: { a: "09:00" }, _lockedTasks: ["b"], _taskOrder: ["b", "a"], _subtaskOrder: { a: ["b"] } }
  );
  assert.equal(run(pre, "loadPinnedStarts()").a, "09:00", "pins survive an un-applied migration");
  assert.deepEqual(run(pre, "loadLockedSet()"), ["b"], "locks survive");
  // order comes from sort_order, which 001 already backfilled -- so it needs no fallback at all
  assert.deepEqual(run(pre, "loadTaskOrder()"), ["a", "b"]);
  const fb = run(pre, "window.__DCC_C6B_FALLBACK");
  assert.ok(fb.pinnedStarts >= 1 && fb.lockedTasks >= 1, "and the canary counts what is still overlay-only: " + JSON.stringify(fb));
});

// ══════════════════════════════ migration 003 contract ═══════════════════════════

test("★ migration 003 is gated, touches no ledger table, and does NOT rewrite sort_order", () => {
  const sql = fs.readFileSync(require.resolve("./migrations/003_order_authority.sql"), "utf8");
  assert.match(sql, /^\s*--\s*@gated:/m, "must be @gated so a bare `npm run migrate` refuses it");
  // The whole design decision: 001 already backfilled sort_order and saveTaskOrder has
  // dual-written since, so re-deriving it from an un-timestamped overlay could only regress a
  // real drag. A future edit that adds a sort_order write here has to change this test first.
  assert.equal(/UPDATE\s+blocks[\s\S]*?SET[^;]*sort_order/i.test(sql), false,
    "003 must not write sort_order -- see the header for why");
  for (const t of ["slot_point_ledger", "slot_", "point_balance"]) {
    assert.equal(sql.includes(t), false, "003 must not touch " + t + "; the ledger identity check is a canary, not a hope");
  }
  // It must be non-destructive: the overlay keys are A4's to remove.
  assert.equal(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(sql), false, "003 must not delete anything");
  assert.equal(/properties\s*-\s*'_pinnedStarts'|properties\s*-\s*'_lockedTasks'/.test(sql), false,
    "003 must not strip the overlay keys -- A4 owns that, with the _done keys");
  // and it writes the two fields the client now reads
  assert.match(sql, /jsonb_build_object\('_pinnedStart'/);
  assert.match(sql, /jsonb_build_object\('locked'/);
});

test("db.js's server-side _lockedTasks read is deliberately LEFT for A4, and is annotated", () => {
  // Track A owns db.js, it is a PATH trigger for the CI guardrail on its own, and with zero lock
  // data both readers answer identically today. Leaving it silently would be the drift this
  // project keeps paying for, so the annotation is the deliverable.
  assert.match(stripJsComments(fs.readFileSync(require.resolve("./db.js"), "utf8")), /_lockedTasks/,
    "db.js still reads the overlay, which is expected this phase");
  assert.match(schedSrc, /A4: `db\.js`'s open-tasks query/, "and schedule.js says so where the client read moved");
});

test("persistRowProp clears on falsy and skips a no-op, through the shared row-props queue", () => {
  // It routes through enqueueRowPropsWrite rather than calling updateBlock, because that queue
  // is what serializes read-modify-write against the four other writers of the same bag.
  // Structural only: that it routes through the QUEUE rather than calling updateBlock. The
  // no-op skip and the falsy clear are asserted behaviourally above, because source-grepping
  // them let a mutation through.
  assert.match(stateCode, /return enqueueRowPropsWrite\(row\.id,props=>\{/);
  assert.equal(/persistRowProp[\s\S]{0,400}?blockStore\.updateBlock/.test(stateCode), false,
    "persistRowProp must not bypass the row-props queue");
});
