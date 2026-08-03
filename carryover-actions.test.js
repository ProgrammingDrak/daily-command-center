// Executable contract tests for the four carryover WRITE actions in
// public/js/unfinished-tasks.js: complete / moveTo / drop / toBacklog.
//
// These exist because the actions were previously guarded only by regexes on the
// source text, and that class of guard cannot catch the class of bug this module
// was built to fix. `drop()` wraps its delete in try/catch and returns
// `{removed:[...]}` regardless, so a store whose batchOp is missing reproduces
// carryover-review.js's exact original bug -- the row disappears from the lane, the
// user gets a success toast, and the block is still on disk -- while a source regex
// asserting the batchOp literal stays green.
//
// So: every action is CALLED here, against a spying fake store, and asserted on the
// writes it actually issued.
//
// The specific regression pinned by "toBacklog preserves the row's properties" is a
// silent data-loss bug found in review: toBacklog resolved the origin row with
// blockStore.get(), which reads _dayCache/_globalCache, but a carryover block is
// loaded by loadDateRange, which fills _rangeCache ONLY. get() therefore returned
// null for a past-day block, and because updateBlock REPLACES properties wholesale
// (db.js: `newProps = parsed`) rather than merging, the row was overwritten with
// `{kind:"backlog"}` -- destroying title, local_id, duration, subtaskOf, notes, tags
// and source_id, then vanishing from every surface behind a success toast.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// C4 moved toBacklog's write into `state.js unscheduleRow`, so this harness loads the
// REAL function rather than stubbing it. That is not a convenience: the assertion this
// file exists for -- "the row's properties survive" -- is now enforced INSIDE
// unscheduleRow, so a stub would make the test pass while the production write wiped the
// row. It is the same trap as B2's four tests that could not fail and C3's three stubs
// gentler than reality, and it would have hidden exactly the bug the header describes.
//
// Sliced rather than required because state.js is not a module (the repo's established
// idiom: recalc-times.test.js, itinerary-fold.test.js). `mustSlice` asserts the match,
// because C3 hit a slice regex that ran PAST its function into the next one and produced
// invalid JS while still "matching".
const TaskModel = require("./public/js/task-model.js");
const { apiStub } = require("./carryover-fixture.js");
const unfSource = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found in state.js — C4's write primitive moved or was renamed");
  // A slice that swallowed a following function declaration matched the wrong span.
  assert.equal((m[0].match(/^(async )?function /gm) || []).length, 1,
    what + " slice spans more than one function — the regex ran past its closing brace");
  return m[0];
}
const unscheduleRowSource = mustSlice(
  stateSource, /^async function unscheduleRow\(blockId,opts\)\{[\s\S]*?\n\}/m, "unscheduleRow");
const rowForDateWriteSource = mustSlice(
  stateSource, /^async function _rowForDateWrite\(blockId\)\{[\s\S]*?\n\}/m, "_rowForDateWrite");
const syncBacklogSource = mustSlice(
  stateSource, /^function _syncBacklogProjection\(evId,dateStr\)\{[\s\S]*?\n\}/m, "_syncBacklogProjection");
const writeRowDateSource = mustSlice(
  stateSource, /^async function _writeRowDate\(blockId,block,props,dateStr\)\{[\s\S]*?\n\}/m, "_writeRowDate");

const plain = (x) => JSON.parse(JSON.stringify(x));
const TODAY = "2026-07-29";
const ymd = (offsetDays) => {
  const d = new Date(TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};
const blk = (id, date, props) => ({
  id, type: "block", date, created_at: date + "T09:00:00.000Z",
  properties: Object.assign({ local_id: id, title: id, type: "task", start: "09:00", end: "09:30", duration: 30 }, props || {})
});
const dayRoot = (props) => ({ id: "root", type: "day_root", properties: props || {} });

// A fake blockStore that records every write. `get()` returns null on purpose: that
// is the REAL behavior for a past-day carryover block, since loadDateRange populates
// only _rangeCache and _dayCache is cleared on every date switch.
function load(daysByDate, archiveDates) {
  const calls = { batchOp: [], deleteBlock: [], updateBlock: [], reschedule: [], commitDone: [], loadDay: [] };
  const store = {
    async loadDateRange() {},
    getRangeCache(date) { return daysByDate[date] ? { blocks: daysByDate[date] } : null; },
    get() { return null; },                       // _dayCache/_globalCache miss, as in prod
    invalidateRangeCache() {},
    async loadDay(d) { calls.loadDay.push(d); },
    async batchOp(ops) { calls.batchOp.push(...ops); },
    async deleteBlock(id) { calls.deleteBlock.push(id); },
    async updateBlock(id, props, opts) { calls.updateBlock.push({ id, props, opts }); },
    async rescheduleBlock(id, date, opts) { calls.reschedule.push({ id, date, opts }); }
  };
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { readyState: "complete", getElementById: () => null, addEventListener: () => {}, body: { appendChild() {} },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], appendChild() {}, addEventListener() {} }) },
    __todayDate: TODAY,
    __archiveDates: archiveDates,
    pt: (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "00:00")); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    ms: (m) => (m >= 60 ? Math.floor(m / 60) + "h" : m + "m"),
    dur: (ev) => ctx.pt(ev.end) - ctx.pt(ev.start),
    escHtml: (s) => String(s == null ? "" : s),
    showToast: (msg, kind) => { calls.toast = { msg, kind }; },
    async commitDoneOnDate(id, date) { calls.commitDone.push({ id, date }); },
    reloadPersistedEdits() {},
    recalcTimes() {}
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.URLSearchParams = URLSearchParams;
  // No `fetch` in this context ON PURPOSE. _rowForDateWrite's fallback would need one,
  // and its absence is what proves toBacklog resolves the row through _originBlock (the
  // _rangeCache path) and hands it over as opts.block. If someone later drops that and
  // lets the primitive resolve for itself, these tests fail with a ReferenceError
  // instead of quietly doing an HTTP round trip per carryover action.
  vm.createContext(ctx);
  vm.runInContext(unfSource, ctx);
  vm.runInContext([unscheduleRowSource, rowForDateWriteSource, writeRowDateSource, syncBacklogSource].join("\n"), ctx);
  ctx.window.blockStore = store;
  ctx.window.DCC.TaskModel = TaskModel;
  // C2: the collector reads GET /api/tasks/open instead of scanning the range cache.
  // The blockStore stub above stays because _originBlock still resolves through it.
  ctx.window.DCC.api = apiStub(daysByDate);
  return { ctx, store, calls, CO: ctx.window.DCC.Carryover };
}

// parent + one open child on the same past day
function parentAndKid() {
  const d = ymd(1);
  return {
    d,
    days: {
      [d]: [
        dayRoot(),
        blk("p", d, { title: "Do Laundry", notes: "sort darks", tags: ["home"], source_id: "https://x/y", duration: 45 }),
        blk("k", d, { title: "Washer", subtaskOf: "p" })
      ]
    }
  };
}

// ───────────────────────────── toBacklog ─────────────────────────────

test("toBacklog PRESERVES the row's properties (it used to wipe them)", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const parent = rows.find(r => r.id === "p");

  const res = await h.CO.toBacklog(parent, rows);
  assert.ok(res, "toBacklog must succeed when the row resolves from the range cache");
  assert.equal(h.calls.updateBlock.length, 1);

  const w = h.calls.updateBlock[0];
  assert.equal(w.id, "p");
  assert.equal(w.opts.date, null, "backlog rows are date-less");
  assert.equal(w.props.kind, "backlog");
  // The whole point: identity and payload survive the write.
  assert.equal(w.props.title, "Do Laundry", "title must survive -- hydrateBacklogFromBlocks skips !p.title");
  assert.equal(w.props.local_id, "p");
  assert.equal(w.props.notes, "sort darks");
  assert.equal(w.props.source_id, "https://x/y");
  assert.deepEqual(plain(w.props.tags), ["home"]);
  // hydrateBacklogFromBlocks reads durMin, not duration.
  assert.equal(w.props.durMin, 45, "duration must be mapped to durMin or the backlog row shows 30m");
});

test("toBacklog REFUSES rather than writing a wiped row when the origin can't be resolved", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const parent = rows.find(r => r.id === "p");
  // Simulate the row being gone from every cache. updateBlock swallows its own
  // errors and returns, so refusing BEFORE the write is the only way to be safe.
  h.store.getRangeCache = () => null;

  const res = await h.CO.toBacklog(parent, rows);
  assert.equal(res, null, "must report failure, not a phantom success");
  assert.equal(h.calls.updateBlock.length, 0, "must not write anything");
  assert.equal(h.calls.toast.kind, "error");
});

test("toBacklog keeps the parent edge so children follow as nested backlog rows", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const kid = rows.find(r => r.id === "k");
  await h.CO.toBacklog(kid, rows);
  assert.equal(h.calls.updateBlock[0].props.subtaskOf, "p", "the parent edge must survive");
});

// ───────────────────────────── drop ─────────────────────────────

test("drop soft-deletes the origin row AND its subtree in ONE atomic batch", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const parent = rows.find(r => r.id === "p");

  const res = await h.CO.drop(parent, rows);
  assert.deepEqual(plain(h.calls.batchOp), [{ op: "delete", id: "p" }, { op: "delete", id: "k" }]);
  assert.equal(h.calls.deleteBlock.length, 0, "one batch, not N singleton deletes");
  assert.deepEqual(plain(res.removed.slice().sort()), ["k", "p"]);
});

test("drop of a childless row falls back to a single deleteBlock", async () => {
  const d = ymd(1);
  const h = load({ [d]: [dayRoot(), blk("solo", d, {})] }, [d]);
  const { rows } = await h.CO.collect();
  await h.CO.drop(rows[0], rows);
  assert.deepEqual(plain(h.calls.deleteBlock), ["solo"]);
  assert.equal(h.calls.batchOp.length, 0);
});

// ───────────────────────────── complete ─────────────────────────────

test("complete marks the row AND every descendant, each on its ORIGIN day", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const parent = rows.find(r => r.id === "p");

  const res = await h.CO.complete(parent, rows);
  // Keyed by local_id (writeId prefers sourceLocalId), and dated to the origin day,
  // never the viewed day. The old handler had no subtree walk, so a carryover
  // parent's children stayed unfinished forever.
  assert.deepEqual(plain(h.calls.commitDone), [{ id: "p", date: d }, { id: "k", date: d }]);
  assert.deepEqual(plain(res.removed.slice().sort()), ["k", "p"]);
});

// ───────────────────────────── moveTo ─────────────────────────────

test("moveTo reschedules the ORIGIN block id to the target date and carries the subtree", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const parent = rows.find(r => r.id === "p");

  const res = await h.CO.moveTo(parent, TODAY, { pool: rows });
  assert.equal(h.calls.reschedule.length, 1);
  assert.equal(h.calls.reschedule[0].id, "p");
  assert.equal(h.calls.reschedule[0].date, TODAY);
  assert.deepEqual(plain(res.removed.slice().sort()), ["k", "p"]);
});

test("moveTo rejects a malformed target date before touching the store", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  assert.equal(await h.CO.moveTo(rows[0], "07/29/2026", { pool: rows }), null);
  assert.equal(await h.CO.moveTo(rows[0], "", { pool: rows }), null);
  assert.equal(h.calls.reschedule.length, 0);
});

test("moveTo refolds the viewed day once, and deferRefold suppresses it for bulk callers", async () => {
  const { d, days } = parentAndKid();

  const single = load(days, [d]);
  const r1 = await single.CO.collect();
  await single.CO.moveTo(r1.rows.find(r => r.id === "p"), TODAY, { pool: r1.rows });
  assert.deepEqual(plain(single.calls.loadDay), [TODAY], "a single move refolds so the row appears immediately");

  const bulk = load(days, [d]);
  const r2 = await bulk.CO.collect();
  await bulk.CO.moveTo(r2.rows.find(r => r.id === "p"), TODAY, { pool: r2.rows, deferRefold: true });
  assert.deepEqual(plain(bulk.calls.loadDay), [], "deferRefold defers it to the batch's single trailing refold");
  await bulk.CO.refoldViewedDay(TODAY);
  assert.deepEqual(plain(bulk.calls.loadDay), [TODAY]);
});

// ───────────────── the shared pool predicates ─────────────────

test("openRows / rootsOf are exported and are the ONE definition every surface uses", async () => {
  const d = ymd(1);
  const h = load({ [d]: [
    dayRoot({ _done: { ids: ["donekid", "doneparent"] } }),
    blk("open", d, {}),
    blk("doneparent", d, {}),
    blk("donekid", d, { subtaskOf: "doneparent" }),
    blk("orphan", d, { subtaskOf: "doneparent" })
  ] }, [d]);
  const { rows } = await h.CO.collect();

  assert.equal(typeof h.CO.openRows, "function");
  assert.equal(typeof h.CO.rootsOf, "function");
  // the done child rides along in the pool for progress...
  assert.ok(rows.some(r => r.id === "donekid" && r.__unf.done));
  // ...but is not work
  assert.ok(!h.CO.openRows(rows).some(r => r.id === "donekid"));
  // roots: the standalone row and the orphan whose parent is finished
  assert.deepEqual(plain(h.CO.rootsOf(rows).map(r => r.id).sort()), ["open", "orphan"]);
});

// Every action ends with invalidateRangeCache(sourceDate), and the itinerary lane
// never re-collects afterwards (_unfSettle only drops the settled rows and renders;
// _ensureUnfinished short-circuits on _unfinishedFetchedFor). So the FIRST action on
// an origin day evicts that day from _rangeCache, and any later resolution for it
// misses. Two unfinished tasks from yesterday is the ordinary case, so without a
// refill the second Backlog refused with an error toast until a page reload -- the
// property-wipe fix would have traded data loss for a dead button.
test("a second action on the same origin day still works after the range cache is evicted", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();

  // Simulate what invalidateRangeCache does: evict the day. Track refills.
  let refills = 0;
  let evicted = true;
  h.store.getRangeCache = (date) => (evicted || !days[date]) ? null : { blocks: days[date] };
  h.store.loadDateRange = async (start, end) => { refills++; if (start === d && end === d) evicted = false; };

  const kid = rows.find(r => r.id === "k");
  const res = await h.CO.toBacklog(kid, rows);

  assert.equal(refills, 1, "the evicted day must be refilled, not given up on");
  assert.ok(res, "the action must succeed rather than refuse");
  assert.equal(h.calls.updateBlock.length, 1);
  assert.equal(h.calls.updateBlock[0].props.title, "Washer", "and it must still write the REAL properties");
});

test("the refill is scoped to the one day, and a genuinely missing row still refuses", async () => {
  const { d, days } = parentAndKid();
  const h = load(days, [d]);
  const { rows } = await h.CO.collect();
  const ranges = [];
  h.store.getRangeCache = () => null;                                  // never resolves
  h.store.loadDateRange = async (start, end) => { ranges.push([start, end]); };

  const res = await h.CO.toBacklog(rows.find(r => r.id === "p"), rows);
  assert.deepEqual(plain(ranges), [[d, d]], "refill exactly the origin day, not the whole window");
  assert.equal(res, null, "a row that truly cannot be resolved must still refuse");
  assert.equal(h.calls.updateBlock.length, 0, "and must still write nothing");
});
