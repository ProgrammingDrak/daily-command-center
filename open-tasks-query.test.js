// Phase C2 — the carryover lane's pool, resolved server-side.
//
// These pin the half of the predicate that MOVED into SQL. The client half (done-ness
// off the day_root overlay, __unf provenance, dedupe, sort, MAX_ROWS) stays in
// unfinished-collect.test.js, and the split is deliberate: reimplementing the SQL
// predicate in the client harness would let a broken query pass on both sides.
//
// What the plan got wrong, measured against a prod restore while building this, and
// pinned below so it cannot come back:
//   • `status='open'` does NOT mean not-done. Itinerary completion writes the
//     day_root `_done` overlay, not the row. 264 finished rows read open.
//     -> there is no status filter here at all; done-ness is the caller's.
//   • `parent_id IS NULL` is NOT the root test. A root task's parent is its day_root.
//     It hid 1084 of 1548 real roots.
//   • `type='block'` alone drops schedule_item / added_task rows the lane shows.
//   • dcc_is_task_row is not the whole filter -- 1137 meetings/breaks/focus rows
//     passed it and would have flooded the lane.
//   • a row with no start and no parent edge was never carryover work.
//
// Harness: the mock-pool trick from canonical-migration.test.js / batchop-tx.test.js,
// so `npm test` stays hermetic. Row-level correctness against real data is proven by
// the old-vs-new differential harness recorded in the phase completion, which is the
// only thing that can prove "no visible change".
const test = require("node:test");
const assert = require("node:assert/strict");

const TaskTypes = require("./public/js/task-types");

function loadDbWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

// Records every statement and answers each query shape getCarryoverPool issues.
function makeRecordingPool({ roots = [], subtree = [], kids = null, dayRoots = [] } = {}) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ text, params });
      if (/FROM blocks b\s+WHERE[\s\S]*b\.date IS NOT NULL AND b\.date < \$2/.test(text)) return { rows: roots };
      if (/WITH RECURSIVE tree/.test(text)) return { rows: subtree };
      if (/b\.id = ANY\(\$2::text\[\]\)/.test(text)) return { rows: kids === null ? subtree : kids };
      if (/type = 'day_root'/.test(text)) return { rows: dayRoots };
      return { rows: [] };
    }
  };
}

const row = (id, over = {}) => ({
  id, type: "block", date: "2026-07-28", parent_id: null, sort_order: 0,
  created_at: "2026-07-28T09:00:00.000Z", deleted_at: null, workspace_id: "ws-1",
  properties: Object.assign({ title: id, type: "task", start: "09:00" }, over.properties || {}),
  ...over
});

// ── the skip set (moved here from task-type-growth.test.js) ──────────────────

test("the fixed-type skip set is derived from the registry, not a second literal list", () => {
  const db = loadDbWithMock(makeRecordingPool());
  const skip = db.carryoverSkipTypes();
  // The registry owns the fixed-time half...
  for (const t of ["meeting", "oneone", "ooo", "break"]) {
    assert.ok(skip.includes(t), t + " (fixed) must skip");
    assert.equal(TaskTypes.isFixed(t), true, t + " must still be fixed in the registry");
  }
  // ...and these four are raw calendar types that never became registry entries.
  for (const t of ["focus", "focus_time", "free_time", "prep"]) {
    assert.ok(skip.includes(t), t + " (raw calendar) must skip");
  }
  for (const t of ["task", "triage", "habit", "wrap", "shell"]) {
    assert.ok(!skip.includes(t), t + " is work and must NOT skip");
  }
  // Adding a fixedTime entry to the registry must extend this automatically. If this
  // ever needs a hand-edit, the drift the registry exists to prevent is back.
  const fixedInRegistry = Object.keys(TaskTypes.TYPES).filter((t) => TaskTypes.isFixed(t));
  for (const t of fixedInRegistry) assert.ok(skip.includes(t), "registry type " + t + " must be in the skip set");
});

// ── the roots query ──────────────────────────────────────────────────────────

test("the roots query carries every term of the client predicate it replaced", async () => {
  const pool = makeRecordingPool();
  const db = loadDbWithMock(pool);
  await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14, limit: 50 });

  const { text, params } = pool.log[0];
  // roots-only, and NOT the plan's `parent_id IS NULL` -- a root's parent is its
  // day_root, so the string form of isDayRootId is the second half of the test.
  assert.match(text, /b\.parent_id IS NULL OR b\.parent_id LIKE 'day-root-%'/,
    "roots-only, by the predicate that is actually true");
  // Every mention of parent_id IS NULL must be paired with the day_root half. The
  // plan's `AND parent_id IS NULL` on its own is the regression to guard against: it
  // reads as "roots only" and silently hides 70% of them.
  for (const m of text.matchAll(/parent_id IS NULL(.{0,40})/g)) {
    assert.match(m[1], /^ OR b\.parent_id LIKE 'day-root-%'/,
      "parent_id IS NULL must never stand alone as the root test");
  }
  assert.match(text, /b\.type = ANY\(\$4::text\[\]\)/, "three row types, not just 'block'");
  assert.match(text, /dcc_is_task_row\(b\.type, b\.properties\)/, "one task-row predicate, not a copy");
  assert.match(text, /COALESCE\(b\.properties->>'type', ''\) <> ALL\(\$5::text\[\]\)/, "fixed-type skip");
  assert.match(text, /properties->>'subtaskOf' IS NOT NULL/, "start-or-nested keeps timeless subtasks");
  assert.match(text, /COALESCE\(b\.properties->>'start', ''\) <> ''/);
  assert.match(text, /b\.deleted_at IS NULL/, "tombstones are gone to this reader");
  assert.match(text, /b\.date IS NOT NULL AND b\.date < \$2/, "strictly before, never undated");
  assert.match(text, /LIMIT \$6/);
  // Crucially absent: any status filter. See the header.
  assert.ok(!/status/.test(text), "a status filter here resurrects 264 finished rows");

  assert.deepEqual(params.slice(0, 3), ["ws-1", "2026-07-29", 14]);
  assert.deepEqual(params[3], ["block", "schedule_item", "added_task"]);
  assert.equal(params[5], 50);
});

test("days:null lifts the window; a number applies the floor", async () => {
  const unbounded = makeRecordingPool();
  await loadDbWithMock(unbounded).getCarryoverPool("ws-1", "2026-07-29", { days: null });
  assert.equal(unbounded.log[0].params[2], null, "days=null passes NULL so the floor term is skipped");
  assert.match(unbounded.log[0].text, /\$3::int IS NULL OR b\.date >=/,
    "the floor has to be conditional in SQL, not branched in JS");

  const bounded = makeRecordingPool();
  await loadDbWithMock(bounded).getCarryoverPool("ws-1", "2026-07-29", {});
  assert.equal(bounded.log[0].params[2], 14, "the default window is 14 days");
});

// ── descendants ──────────────────────────────────────────────────────────────

test("descendants are re-filtered through the SAME predicate, so a meeting child cannot ride in", async () => {
  const pool = makeRecordingPool({
    roots: [row("parent")],
    subtree: [row("parent"), row("kid"), row("mtgkid", { properties: { type: "meeting", start: "10:00" } })]
  });
  const db = loadDbWithMock(pool);
  await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });

  const kidQ = pool.log.find((q) => /b\.id = ANY\(\$2::text\[\]\)/.test(q.text));
  assert.ok(kidQ, "descendants must be re-selected, not taken raw from the walk");
  // getSubtree deliberately returns whole subtrees unfiltered. Filtering only the
  // roots would let a meeting-type or startless child into a lane that never showed
  // one, which the old per-block client scan did filter.
  assert.match(kidQ.text, /dcc_is_task_row\(b\.type, b\.properties\)/);
  assert.match(kidQ.text, /COALESCE\(b\.properties->>'type', ''\) <> ALL\(\$4::text\[\]\)/);
  assert.match(kidQ.text, /COALESCE\(b\.properties->>'start', ''\) <> ''/);
  assert.deepEqual(kidQ.params[1], ["kid", "mtgkid"], "the root itself is not re-fetched as its own child");
});

test("no roots means no subtree query and no overlay query", async () => {
  const pool = makeRecordingPool({ roots: [] });
  const db = loadDbWithMock(pool);
  const out = await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.equal(pool.log.length, 1, "one query, then stop");
  assert.deepEqual(out, { rows: [], overlays: {}, scanned: 0 });
});

// ── overlays ─────────────────────────────────────────────────────────────────

test("overlays come back keyed by date STRING, and carry done + locked", async () => {
  const pool = makeRecordingPool({
    roots: [row("a")],
    subtree: [row("a")],
    kids: [],
    // pg hands back a Date for a `date` column. Keying the map on it directly
    // stringifies to "Tue Jul 28 2026 ..." and no caller can ever look it up.
    dayRoots: [{
      date: new Date("2026-07-28T00:00:00Z"),
      properties: { _done: { ids: ["a", "gone"] }, _lockedTasks: ["a"] }
    }]
  });
  const db = loadDbWithMock(pool);
  const out = await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });

  assert.deepEqual(Object.keys(out.overlays), ["2026-07-28"]);
  assert.deepEqual(out.overlays["2026-07-28"].done, ["a", "gone"]);
  assert.deepEqual(out.overlays["2026-07-28"].locked, ["a"],
    "locks live on the ORIGIN day's day_root, never on the block");
  assert.equal(out.scanned, 1);
});

test("_lockedTasks is accepted as an object map as well as an array", async () => {
  const pool = makeRecordingPool({
    roots: [row("a")], subtree: [row("a")], kids: [],
    dayRoots: [{ date: "2026-07-28", properties: { _lockedTasks: { a: true, b: true } } }]
  });
  const out = await loadDbWithMock(pool).getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.deepEqual(out.overlays["2026-07-28"].locked, ["a", "b"]);
  assert.deepEqual(out.overlays["2026-07-28"].done, [], "a day_root with no _done is not undefined");
});

test("the overlay read is workspace-scoped and one query for every date in play", async () => {
  const pool = makeRecordingPool({
    roots: [row("a"), row("b", { date: "2026-07-27" })],
    subtree: [row("a"), row("b", { date: "2026-07-27" })], kids: []
  });
  await loadDbWithMock(pool).getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  const ovQ = pool.log.filter((q) => /type = 'day_root'/.test(q.text));
  assert.equal(ovQ.length, 1, "one overlay read, not one per day like the client scan did");
  assert.match(ovQ[0].text, /workspace_id IS NOT DISTINCT FROM \$1/);
  assert.deepEqual(ovQ[0].params[1].sort(), ["2026-07-27", "2026-07-28"]);
});
