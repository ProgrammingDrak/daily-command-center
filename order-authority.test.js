// C6b: pins and locks move onto the task row. `properties._pinnedStart` and
// `properties.locked` replace the `day_root` overlay maps `_pinnedStarts` / `_lockedTasks`.
//
// ★ WHAT THIS PHASE DELIBERATELY DID NOT DO, because the whole design turns on it.
//
// The plan was to collapse all FIVE order authorities, including the three order LISTS
// (`_taskOrder`, `_unscheduledOrder`, `_subtaskOrder`) onto the row's `sort_order` column.
// Measured on the prod restore, `sort_order` is NOT one number space: of 1815 live task rows,
// 231 carry the 1000-spaced values a DRAG writes, 1005 carry minutes-of-day 0..1439
// (`db.js createItineraryTask`'s derivedSort), 289 are exactly 0 (`createBlock` defaults
// `sort_order || 0` in both block-store.js and db.js and no create renumbers), and 290 are
// something else. **63 of 113 days hold a mix.** Reading the column as the order would sort
// every server-created and newly-added task ahead of everything the user has dragged, on more
// than half the days. So the three order READS stay on the overlay and go to C6c, which has to
// normalise four producers (two in db.js, Track A's file) plus a renumber migration first.
//
// What C6b DID fix on the order axis is the WRITE: the old dual-write filtered rows by
// `local_id && start`, which silently excluded 1546 of 1815 live task rows from ever having
// their sort_order updated. It is keyed on the ev id now, so C6c inherits a column that is not
// drifting further away.
//
// Harness: pure slices in a node:vm context over a fake blockStore, with the REAL TaskModel
// installed so `foldsIntoItinerary` is the shipped predicate.
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
const TODAY = "2026-08-04";

// A blockStore row. `sort_order` is a top-level COLUMN, not a property. `local_id` makes it
// "addressable as an ev" (foldsIntoItinerary), which is what these ev-id-keyed lists need.
const row = (id, sort_order, props, date) => ({
  id, type: "block", date: date === undefined ? TODAY : date,
  sort_order, deleted_at: null,
  properties: Object.assign({ title: id, type: "task", local_id: id }, props || {}),
});

function ctx(rows, overlay) {
  const reordered = [], updated = [], overlayWrites = [], localWrites = [];
  const rootProps = Object.assign({}, overlay || {});
  const store = {
    _rows: rows.slice(),
    getByType(t) { return t === "block" ? this._rows : []; },
    getDayRootId() { return "root"; },
    get(id) { return id === "root" ? { id: "root", properties: rootProps } : this._rows.find((r) => r.id === id) || null; },
    reorder(items) { reordered.push(...items); items.forEach((i) => { const r = this._rows.find((x) => x.id === i.id); if (r) r.sort_order = i.sort_order; }); return Promise.resolve(); },
    updateBlock(id, props) {
      if (id === "root") { overlayWrites.push(JSON.parse(JSON.stringify(props))); Object.keys(rootProps).forEach((k) => delete rootProps[k]); Object.assign(rootProps, props); return Promise.resolve(); }
      updated.push({ id, props }); const r = this._rows.find((x) => x.id === id); if (r) r.properties = props; return Promise.resolve();
    },
  };
  const c = {
    console, window: null,
    localStorage: { getItem: () => null, setItem: (k, v) => localWrites.push({ k, v }) },
    __state: { date: TODAY },
    scheduleIDBSave() {}, scheduled: [],
    PINNED_KEY: "pa-pinned-starts-" + TODAY, LOCKED_KEY: "pa-locked-tasks-" + TODAY,
    ORDER_KEY: "pa-task-order-" + TODAY, SUBTASK_ORDER_KEY: "pa-subtask-order-" + TODAY,
    reordered, updated, overlayWrites, localWrites, rootProps,
  };
  c.window = c; c.self = c;
  c.USE_BLOCKSTORE = { reorder: true };
  c.blockStore = store;
  vm.createContext(c);
  installTaskModel(c);
  vm.runInContext(one(persistSrc, /function _bsProp\(key, def\) \{[\s\S]*?\n\}/, "_bsProp"), c);
  vm.runInContext(one(persistSrc, /function _bsSaveProp\(key, value\) \{[\s\S]*?\n\}/, "_bsSaveProp"), c);
  // A stand-in for the resolver + the shared row-props queue, writing through the SAME
  // blockStore.updateBlock the real queue uses. It mirrors _findTaskBlockForDate's real
  // preference order: exact date first, then a dateless twin, else null.
  vm.runInContext(`
    function _findTaskBlockForDate(id, dateStr){
      const all = blockStore.getByType("block").filter(b=>String(b.properties.local_id||b.id)===String(id));
      if(!dateStr) return all[0]||null;
      return all.find(b=>b.date===dateStr) || all.find(b=>!b.date) || null;
    }
    function enqueueRowPropsWrite(blockId, merge){
      const b = blockStore.getByType("block").find(x=>x.id===blockId);
      if(!b||!b.properties) return null;
      const next = merge(b.properties);
      if(next) blockStore.updateBlock(b.id, next);
      return Promise.resolve();
    }
  `, c);
  vm.runInContext(one(read("state.js"), /function persistRowProp\(id,key,value,ev,opts\)\{[\s\S]*?\n\}/, "persistRowProp"), c);
  for (const re of [
    /window\.__DCC_C6B_FALLBACK = window\.__DCC_C6B_FALLBACK \|\| \{\};/,
    /function _c6bFallback\(key,n\)\{[\s\S]*?\n\}/,
    /function _orderableRows\(opts\)\{[\s\S]*?\n\}/,
    /function _evIdOfRow\(b\)\{[^\n]*\}/,
    /function _orderFromRows\(pick\)\{[\s\S]*?\n\}/,
    /function _writeRowOrder\(ids\)\{[\s\S]*?\n\}/,
    /function _pruneOverlayMap\(key,keep\)\{[\s\S]*?\n\}/,
    /function loadPinnedStarts\(\)\{[\s\S]*?\n\}/,
    /function savePinnedStarts\(data\)\{[\s\S]*?\n\}/,
    /function loadLockedSet\(\)\{[\s\S]*?\n\}/,
    /function saveLockedSet\(ids\)\{[\s\S]*?\n\}/,
    /function saveTaskOrder\(\)\{[\s\S]*?\n\}/,
  ]) vm.runInContext(one(schedSrc, re, String(re)), c);
  return c;
}
const run = (c, expr) => JSON.parse(vm.runInContext("JSON.stringify(" + expr + ")", c));

// ═══════════════════════════ pins and locks live on the row ═══════════════════════════

test("★ loadPinnedStarts reads the ROW, with the overlay filling only what no row carries", () => {
  const c = ctx(
    [row("a", 1000, { _pinnedStart: "09:00" }), row("b", 2000)],
    { _pinnedStarts: { a: "23:59", b: "14:00", ghost: "07:00" } }
  );
  const pins = run(c, "loadPinnedStarts()");
  assert.equal(pins.a, "09:00", "the ROW wins over the overlay");
  assert.equal(pins.b, "14:00", "the overlay fills a row that has none yet");
  assert.equal(pins.ghost, "07:00", "and an id with no row at all still resolves");
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), { pinnedStarts: 2 }, "both fallbacks COUNTED");
});

test("★ savePinnedStarts writes the row, heals an overlay-only pin, and clears a removed one", () => {
  const c = ctx([row("a", 1000, { _pinnedStart: "09:00" }), row("b", 2000)], { _pinnedStarts: { a: "09:00", b: "14:00" } });
  // b was overlay-only; touching the map pushes it onto its row (the "heals when touched"
  // pattern C4 used for dated backlog rows).
  assert.equal(vm.runInContext('savePinnedStarts({a:"09:00", b:"14:00"})', c), 1, "only b moved");
  const upd = run(c, "updated");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].props._pinnedStart, "14:00");
  // and removing a pin CLEARS the key rather than storing a falsy value
  const c2 = ctx([row("a", 1000, { _pinnedStart: "09:00" })], {});
  vm.runInContext("savePinnedStarts({})", c2);
  const u2 = run(c2, "updated");
  assert.equal(u2.length, 1);
  assert.equal("_pinnedStart" in u2[0].props, false, "the key is deleted, not set falsy");
});

test("★★ UNPIN PRUNES THE OVERLAY — otherwise the counted fallback resurrects it on reload", () => {
  // The blocking bug this phase shipped into review. The fallback re-supplies a pin for any row
  // whose key is absent, and "absent" is EXACTLY what an unpin produces -- so there was no way to
  // express "explicitly unpinned" and every unpin came back on the next load. The old code could
  // not have this bug: it wrote the whole map, so deleting a key deleted it. Live data, not
  // theory: 64 day_roots carry `_pinnedStarts` (178 entries).
  const c = ctx([row("a", 1000, { _pinnedStart: "09:00" })], { _pinnedStarts: { a: "09:00" } });
  assert.equal(run(c, "loadPinnedStarts()").a, "09:00");
  vm.runInContext("savePinnedStarts({})", c);                       // the unpin
  assert.equal("_pinnedStart" in run(c, "updated")[0].props, false, "row key cleared");
  assert.deepEqual(run(c, "rootProps._pinnedStarts"), {}, "and the overlay entry is PRUNED");
  assert.deepEqual(run(c, "loadPinnedStarts()"), {}, "so the next read does not resurrect it");
});

test("★★ UNLOCK PRUNES THE OVERLAY too, including the array shape db.js also accepts", () => {
  const c = ctx([row("a", 1000, { locked: true })], { _lockedTasks: ["a"] });
  assert.deepEqual(run(c, "loadLockedSet()"), ["a"]);
  vm.runInContext("saveLockedSet([])", c);                          // the unlock
  assert.equal("locked" in run(c, "updated")[0].props, false);
  assert.deepEqual(run(c, "rootProps._lockedTasks"), [], "the overlay array is PRUNED");
  assert.deepEqual(run(c, "loadLockedSet()"), [], "so the next read does not resurrect it");
});

test("_pruneOverlayMap skips the write when nothing was dropped", () => {
  const c = ctx([row("a", 1000)], { _pinnedStarts: { a: "09:00" } });
  assert.equal(vm.runInContext('_pruneOverlayMap("_pinnedStarts",()=>true)', c), 0);
  assert.deepEqual(run(c, "overlayWrites"), [], "an unchanged overlay must not be PATCHed");
  assert.equal(vm.runInContext('_pruneOverlayMap("_missing",()=>false)', c), 0, "an absent key is a no-op");
});

test("★ a no-op savePinnedStarts writes NOTHING, and does not even enqueue", () => {
  const c = ctx([row("a", 1000, { _pinnedStart: "09:00" }), row("b", 2000, { _pinnedStart: "10:00" })],
    { _pinnedStarts: { a: "09:00", b: "10:00" } });
  // The RETURN VALUE is the contract: rows this call actually enqueued. Asserting only `updated`
  // hides a version that enqueues a no-op per row on every save.
  assert.equal(vm.runInContext('savePinnedStarts({a:"09:00", b:"10:00"})', c), 0);
  assert.deepEqual(run(c, "updated"), []);
  assert.deepEqual(run(c, "overlayWrites"), []);
  assert.equal(vm.runInContext('savePinnedStarts({a:"09:00", b:"11:00"})', c), 1, "exactly one row moved");
});

test("★ persistRowProp CLEARS on every falsy value, not just undefined", () => {
  // `false` is the one that matters: a reader testing `p.locked` and one testing `"locked" in p`
  // must not disagree, and 001 wrote nothing for locks, so absence is the only value that has
  // ever meant not-locked. Behavioural -- the first cut source-grepped the falsy list and a
  // mutation removing it passed.
  for (const falsy of ["undefined", "null", "false"]) {
    const c = ctx([row("a", 1000, { locked: true, _pinnedStart: "09:00" })], {});
    vm.runInContext(`persistRowProp("a","locked",${falsy},null)`, c);
    const upd = run(c, "updated");
    assert.equal(upd.length, 1, falsy + " should have cleared the key");
    assert.equal("locked" in upd[0].props, false, falsy + " must DELETE the key, not store it");
    assert.equal(upd[0].props._pinnedStart, "09:00", "and must not disturb the rest of the bag");
  }
  const c2 = ctx([row("a", 1000)], {});
  vm.runInContext('persistRowProp("a","_pinnedStart","07:30",null)', c2);
  assert.equal(run(c2, "updated")[0].props._pinnedStart, "07:30");
  const c3 = ctx([row("a", 1000)], {});
  vm.runInContext('persistRowProp("ghost","locked",true,null)', c3);
  assert.deepEqual(run(c3, "updated"), [], "an id with no row writes nothing");
});

test("★★ the pin/lock sweep writes the row it INSPECTED, not whichever twin the resolver prefers", () => {
  // Two live rows CAN share one ev id (a dated row and its dateless twin -- persistence.js
  // documents that as a supported state). The sweep iterates rows, but persistRowProp used to
  // re-resolve by ev id and prefer the viewed day's row -- so the decision made about the
  // dateless twin landed on the dated one, and `wrote++` counted it either way.
  const dated = row("dup", 1000, { _pinnedStart: "09:00" }, TODAY);
  const twin = { id: "dup-dateless", type: "block", date: null, sort_order: 2000, deleted_at: null,
                 properties: { title: "twin", type: "task", local_id: "dup", _pinnedStart: "09:00" } };
  const c = ctx([dated, twin], {});
  // Clearing the pin must clear it on BOTH rows the sweep saw, not twice on the dated one.
  assert.equal(vm.runInContext("savePinnedStarts({})", c), 2, "both rows were decided AND written");
  const ids = run(c, "updated").map((u) => u.id).sort();
  assert.deepEqual(ids, ["dup", "dup-dateless"], "each inspected row got its own write");
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), {}, "and nothing was refused");
});

test("★ locks live on the row; the overlay is a counted fallback and prod has ZERO of it", () => {
  const c = ctx([row("a", 1000, { locked: true }), row("b", 2000)], { _lockedTasks: ["b"] });
  assert.deepEqual(run(c, "loadLockedSet()").sort(), ["a", "b"]);
  assert.deepEqual(run(c, "window.__DCC_C6B_FALLBACK"), { lockedTasks: 1 });
  // an id in BOTH places appears ONCE, and is NOT counted as a fallback
  const dup = ctx([row("a", 1000, { locked: true })], { _lockedTasks: ["a"] });
  assert.deepEqual(run(dup, "loadLockedSet()"), ["a"]);
  assert.deepEqual(run(dup, "window.__DCC_C6B_FALLBACK"), {});
  // the object-map shape db.js also accepts
  const obj = ctx([row("a", 1000)], { _lockedTasks: { z: true } });
  assert.deepEqual(run(obj, "loadLockedSet()"), ["z"]);
});

test("saveLockedSet toggles the row key, writing only what changed, and is idempotent", () => {
  const c = ctx([row("a", 1000, { locked: true }), row("b", 2000)], {});
  assert.equal(vm.runInContext('saveLockedSet(["b"])', c), 2, "a unlocked, b locked");
  const byId = Object.fromEntries(run(c, "updated").map((u) => [u.id, u.props]));
  assert.equal("locked" in byId.a, false, "unlock DELETES the key");
  assert.equal(byId.b.locked, true);
  const c2 = ctx([row("a", 1000, { locked: true })], {});
  assert.equal(vm.runInContext('saveLockedSet(["a"])', c2), 0);
  assert.deepEqual(run(c2, "updated"), []);
});

test("the pin and lock OVERLAY WRITES are gone (only the prune remains)", () => {
  for (const key of ["_pinnedStarts", "_lockedTasks"]) {
    const rx = new RegExp("_bsSaveProp\\(\\s*[\"']" + key + "[\"']");
    assert.equal(rx.test(schedCode), false, key + " is still written directly");
    assert.ok(rx.test('_bsSaveProp("' + key + '", data)'), "control: the guard fires on the retired form");
  }
  // the prune goes through the shared helper, keyed by name, so both axes share one body
  assert.match(schedCode, /_pruneOverlayMap\("_pinnedStarts",id=>!!data\[id\]\)/);
  assert.match(schedCode, /_pruneOverlayMap\("_lockedTasks",id=>want\.has\(String\(id\)\)\)/);
});

// ════════════════════════ row scoping: the cross-day hazard ═══════════════════════════

test("★★ _orderableRows is DATE-SCOPED, so a write on today cannot renumber another day", () => {
  // `loadGlobals()` pulls every type=block row regardless of date and caches them all
  // (persistence.js:290 documents this and date-guards its own fold). Two live rows CAN share one
  // ev id -- schedule.js records `carry-200` doing exactly that on the prod restore -- so an
  // unscoped sweep let a drag on today stamp a July row, losing the drag AND mutating another day.
  const c = ctx([
    row("dup", 9000, {}, TODAY),
    { id: "dup-other", type: "block", date: "2026-07-01", sort_order: 500, deleted_at: null, properties: { title: "july", type: "task", local_id: "dup" } },
    row("z", 1500, {}, "2026-09-01"),
  ], {});
  assert.deepEqual(run(c, "_orderableRows().map(b=>b.id)"), ["dup"], "only today's row is in scope");
  vm.runInContext('_writeRowOrder(["dup"])', c);
  assert.deepEqual(run(c, "reordered"), [{ id: "dup", sort_order: 1000 }], "today's row, not July's");
  // dateless rows are ALWAYS in scope: that is the Backlog, day-agnostic by definition (C4)
  const c2 = ctx([row("backlog", 1000, {}, null), row("other", 500, {}, "2026-07-01")], {});
  assert.deepEqual(run(c2, "_orderableRows().map(b=>b.id)"), ["backlog"]);
  // and an explicit scope is honoured
  assert.deepEqual(run(c2, '_orderableRows({date:"2026-07-01"}).map(b=>b.id)').sort(), ["backlog", "other"]);
  assert.deepEqual(run(c2, "_orderableRows({date:null}).map(b=>b.id)").sort(), ["backlog", "other"]);
});

test("★ _orderableRows uses foldsIntoItinerary, not the far-wider isTaskRow", () => {
  // task-model.js's own comment: isTaskRow alone is "far too wide -- side_project rows, sticky
  // notes and untitled scaffolding all pass the kind exclusions". These lists are keyed by EV ID,
  // so "addressable as an ev" is the question.
  const c = ctx([
    row("keep", 1000),                                                    // has local_id
    { id: "scaffold", type: "block", date: TODAY, sort_order: 500, deleted_at: null, properties: { title: "no local_id, no kind" } },
    { id: "dr", type: "day_root", date: TODAY, sort_order: 400, deleted_at: null, properties: {} },
    { id: "del", type: "block", date: TODAY, sort_order: 600, deleted_at: "2026-08-01", properties: { local_id: "del" } },
  ], {});
  assert.deepEqual(run(c, "_orderableRows().map(b=>b.id)"), ["keep"]);
});

// ══════════════════════ the order WRITE fix (read stays on the overlay) ═══════════════

test("★ _writeRowOrder reorders a row with NO local_id and a row with NO start", () => {
  // The two shapes the old `local_id && start` filter dropped: 1546 of 1815 live task rows have
  // no local_id, and 37 more are untimed.
  const c = ctx([
    { id: "row-api", type: "block", date: TODAY, sort_order: 9000, deleted_at: null, properties: { title: "api", kind: "task" } },
    row("u", 8000),
  ], {});
  assert.equal(vm.runInContext('_writeRowOrder(["u","row-api"])', c), 2);
  assert.deepEqual(run(c, "reordered"), [{ id: "u", sort_order: 1000 }, { id: "row-api", sort_order: 2000 }]);
});

test("_writeRowOrder skips an already-correct row, unknown ids, and empty input", () => {
  const c = ctx([row("a", 1000), row("b", 5000)], {});
  assert.equal(vm.runInContext('_writeRowOrder(["a","b"])', c), 1, "only b moved");
  assert.deepEqual(run(c, "reordered"), [{ id: "b", sort_order: 2000 }]);
  assert.equal(vm.runInContext('_writeRowOrder(["a","b"])', c), 0, "second call is a no-op");
  assert.equal(vm.runInContext('_writeRowOrder(["ghost"])', c), 0);
  assert.equal(vm.runInContext("_writeRowOrder([])", c), 0);
  assert.equal(vm.runInContext("_writeRowOrder(null)", c), 0);
});

test("saveTaskOrder keeps the overlay as the authority AND stamps sort_order", () => {
  // Both, deliberately: the overlay is still the read authority (sort_order is not one number
  // space yet, see the file header) and sort_order is kept current so C6c inherits a usable
  // column instead of a more drifted one.
  const c = ctx([row("a", 5000), row("b", 6000)], {});
  c.scheduled = [{ id: "b" }, { id: "a" }];
  c.isDone = () => false;
  vm.runInContext("saveTaskOrder()", c);
  assert.deepEqual(run(c, "reordered"), [{ id: "b", sort_order: 1000 }, { id: "a", sort_order: 2000 }]);
  assert.deepEqual(run(c, "rootProps._taskOrder"), ["b", "a"], "the overlay is still written");
});

test("★ the three order READS are still overlay-first — C6c owns the flip, and says why", () => {
  // A guard on a deliberate NON-change, because the tempting version of this phase is the one
  // that flips these reads, and the reason not to is a measurement nobody will re-take.
  assert.match(schedCode, /function loadTaskOrder\(\)\{\s*if \(window\.USE_BLOCKSTORE && window\.blockStore\) \{\s*const v = _bsProp\("_taskOrder", null\);/);
  assert.match(schedCode, /function loadUnscheduledOrder\(\)\{\s*if\(window\.USE_BLOCKSTORE&&window\.blockStore\)\{\s*const v=_bsProp\("_unscheduledOrder",null\);/);
  assert.match(persistCode, /function loadSubtaskOrder\(\)\{\s*const fromBlocks=_bsProp\("_subtaskOrder", null\);/);
  // and the measurement that justifies it is IN the file, so the next person sees it
  assert.match(schedSrc, /`sort_order` is not one number space/);
  assert.match(schedSrc, /63 of 113 days hold a mix/);
});

// ══════════════════════════════ migration 003 contract ═══════════════════════════════

const SQL = fs.readFileSync(require.resolve("./migrations/003_order_authority.sql"), "utf8");

test("★ migration 003 is gated, non-destructive, and does NOT rewrite sort_order", () => {
  assert.match(SQL, /^\s*--\s*@gated:/m, "must be @gated so a bare `npm run migrate` refuses it");
  assert.equal(/UPDATE\s+blocks[\s\S]*?SET[^;]*sort_order/i.test(SQL), false,
    "003 must not write sort_order -- an untimestamped overlay beating a dual-written value would undo real drags");
  for (const t of ["slot_point_ledger", "point_balance"]) {
    assert.equal(SQL.includes(t), false, "003 must not touch " + t + "; the ledger identity check is a canary, not a hope");
  }
  assert.equal(/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(SQL), false, "003 must not delete anything");
  assert.equal(/properties\s*-\s*'_pinnedStarts'|properties\s*-\s*'_lockedTasks'/.test(SQL), false,
    "003 must not strip the overlay keys -- A4 owns that, with the _done keys");
  assert.match(SQL, /jsonb_build_object\('_pinnedStart'/);
  assert.match(SQL, /jsonb_build_object\('locked'/);
});

test("★★ 003's locks CTE expands the SRF in FROM, not inside a CASE scalar subquery", () => {
  // The CASE form is not a set expansion. It raises "more than one row returned by a subquery
  // used as an expression" for any `_lockedTasks` with >= 2 entries, and silently returns only
  // the FIRST element when there is exactly 1. The runner wraps the file in ONE transaction, so
  // that error also rolled back step 1's pins backfill -- one user locking two tasks in the
  // window between the deploy and the apply would have bricked the migration.
  assert.equal(/THEN \(SELECT jsonb_array_elements_text/.test(SQL), false, "the CASE-wrapped SRF must stay gone");
  assert.equal(/THEN \(SELECT jsonb_object_keys/.test(SQL), false);
  assert.match(SQL, /FROM jsonb_array_elements_text\(dr\.properties -> '_lockedTasks'\) AS e\(ev_id\)/);
  assert.match(SQL, /FROM jsonb_object_keys\(dr\.properties -> '_lockedTasks'\) AS k/);
  assert.match(SQL, /UNION ALL/, "both shapes are unioned, so an array AND an object map both expand");
});

test("003 joins NULL-safely on workspace_id and covers the row types the client reads", () => {
  // db.js uses IS NOT DISTINCT FROM on this column precisely because a NULL makes `=` yield NULL
  // and the row silently drops out. And the client's _orderableRows unions added_task with block.
  assert.equal(/AND b\.workspace_id = (pe|le)\.workspace_id/.test(SQL), false, "plain = is NULL-unsafe here");
  assert.equal((SQL.match(/workspace_id IS NOT DISTINCT FROM/g) || []).length, 2, "both steps");
  assert.equal((SQL.match(/b\.type IN \('block','added_task'\)/g) || []).length, 2);
});

// ═════════════════════════════ what is handed to A4 / C6c ════════════════════════════

test("db.js's server-side _lockedTasks read is deliberately LEFT for A4, and is annotated", () => {
  // Track A owns db.js, it is a PATH trigger for the CI guardrail on its own, and with zero lock
  // data both readers answer identically today. Leaving it SILENTLY would be the drift this
  // project keeps paying for, so the annotation is the deliverable.
  assert.match(stripJsComments(fs.readFileSync(require.resolve("./db.js"), "utf8")), /_lockedTasks/);
  assert.match(schedSrc, /A4: `db\.js`'s open-tasks query/);
});

test("persistRowProp routes through the shared row-props queue, not straight to updateBlock", () => {
  // That queue is what serializes read-modify-write against the four other writers of the same
  // properties bag. The no-op skip and the falsy clear are asserted behaviourally above.
  assert.match(stateCode, /return enqueueRowPropsWrite\(row\.id,props=>\{/);
  assert.equal(/persistRowProp[\s\S]{0,400}?blockStore\.updateBlock/.test(stateCode), false,
    "persistRowProp must not bypass the queue");
});

test("★ the pin and lock reads tolerate 003 NOT having run — no merge-then-apply window", () => {
  // The C6b brief warned that a deploy landing before the manual apply "loses every manual drag
  // order". True of a canonical-ONLY read; not of canonical-first plus a counted fallback. That is
  // what removed the C5a -> 002 -> C5b dance for these two axes.
  const pre = ctx([row("a", 1000), row("b", 2000)], { _pinnedStarts: { a: "09:00" }, _lockedTasks: ["b"] });
  assert.equal(run(pre, "loadPinnedStarts()").a, "09:00", "pins survive an un-applied migration");
  assert.deepEqual(run(pre, "loadLockedSet()"), ["b"], "locks survive");
  const fb = run(pre, "window.__DCC_C6B_FALLBACK");
  assert.ok(fb.pinnedStarts >= 1 && fb.lockedTasks >= 1, "and the canary counts what is still overlay-only: " + JSON.stringify(fb));
});
