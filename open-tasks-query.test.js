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
//     passed it and would have flooded the lane. The shared predicate itself
//     distinguishes responsibility scaffolding from dated responsibility_task work.
//   • a row with no start and no parent edge was never carryover work.
//   • and the correction review forced: this returns the POOL, not the roots. A
//     nested row whose parent does not qualify still has to render, so membership
//     must never depend on the parent. 158 past-day untimed parents have children,
//     and an untimed parent is never a root.
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
function makeRecordingPool({ rows = [], dayRoots = [] } = {}) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ text, params });
      if (/type = 'day_root'/.test(text)) return { rows: dayRoots };
      if (/FROM blocks b/.test(text)) return { rows };
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

// ── the skip set ─────────────────────────────────────────────────────────────

test("the fixed-type skip set is derived from the registry, not a second literal list", () => {
  const db = loadDbWithMock(makeRecordingPool());
  const skip = db.carryoverSkipTypes();
  for (const t of ["meeting", "oneone", "ooo", "break"]) {
    assert.ok(skip.includes(t), t + " (fixed) must skip");
    assert.equal(TaskTypes.isFixed(t), true, t + " must still be fixed in the registry");
  }
  // These four are raw calendar types that never became registry entries.
  for (const t of ["focus", "focus_time", "free_time", "prep"]) {
    assert.ok(skip.includes(t), t + " (raw calendar) must skip");
  }
  for (const t of ["task", "triage", "habit", "wrap", "shell"]) {
    assert.ok(!skip.includes(t), t + " is work and must NOT skip");
  }
  // Adding a fixedTime entry to the registry must extend this automatically. If this
  // ever needs a hand-edit, the drift the registry exists to prevent is back.
  for (const t of TaskTypes.fixedTypes()) {
    assert.ok(skip.includes(t), "registry type " + t + " must be in the skip set");
  }
});

// ── the pool query ───────────────────────────────────────────────────────────

test("the pool query carries every term of the client predicate it replaced", async () => {
  const pool = makeRecordingPool();
  const db = loadDbWithMock(pool);
  await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14, limit: 50 });

  const { text, params } = pool.log[0];
  assert.match(text, /b\.type = ANY\(\$4::text\[\]\)/, "three row types, not just 'block'");
  assert.match(text, /dcc_is_task_row\(b\.type, b\.properties\)/, "one task-row predicate, not a copy");
  assert.doesNotMatch(text, /OR\s+COALESCE\(b\.properties->>'kind', ''\) = 'responsibility_task'/,
    "responsibility_task belongs in the shared task-row predicate, not a query-local workaround");
  assert.match(text, /COALESCE\(b\.properties->>'type', ''\) <> ALL\(\$5::text\[\]\)/, "fixed-type skip");
  assert.match(text, /properties->>'subtaskOf' IS NOT NULL/, "start-or-nested keeps timeless subtasks");
  assert.match(text, /properties->>'wrapId' IS NOT NULL/,
    "the ride-along edge too: drop this and every timeless wrap step leaves the lane, " +
    "and no other test catches it (the fixture applies no predicate, and the one " +
    "ride-along fixture carries a start so it would survive on that term alone)");
  assert.match(text, /COALESCE\(b\.properties->>'start', ''\) <> ''/);
  assert.match(text, /b\.deleted_at IS NULL/, "tombstones are gone to this reader");
  assert.match(text, /b\.date IS NOT NULL AND b\.date < \$2/, "strictly before, never undated");
  assert.match(text, /LIMIT \$6/);
  // Crucially absent: any status filter. See the header.
  assert.ok(!/status/.test(text), "a status filter here resurrects 264 finished rows");

  // The binds, not just the SQL text. Asserting only that `<> ALL($5)` appears would
  // pass with `$5` bound to [] -- and the lane would fill with 1137 meetings while
  // every test stayed green. That is the "a source-regex test cannot guard a
  // swallowed write" shape this repo keeps relearning.
  assert.deepEqual(params.slice(0, 3), ["ws-1", "2026-07-29", 14]);
  assert.deepEqual(params[3], ["block", "schedule_item", "added_task"]);
  assert.deepEqual(params[4].slice().sort(), db.carryoverSkipTypes().slice().sort(),
    "the skip list must actually be BOUND to $5, not merely named in the SQL");
  assert.equal(params[5], 50);
});

test("membership never depends on the parent: nested rows come back from the window query itself", async () => {
  // The regression this guards is the one the review caught. Seeding from roots and
  // walking down means a child of an untimed parent (never a root) is unreachable,
  // and schedule-tab.js requires the opposite: "standalone work must never disappear."
  const pool = makeRecordingPool();
  const db = loadDbWithMock(pool);
  await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  const { text } = pool.log[0];

  // Deliberately the STRONG form. `!/parent_id IS NULL/` would only catch the one
  // phrasing round 1 found; a reintroduced roots filter written as
  // `NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND ...)` or a
  // self-join would slip straight past it. The query references no parent column and
  // performs no join at all today, so the broad assertion costs nothing and holds.
  assert.ok(!/parent/i.test(text),
    "membership must not depend on the parent in ANY form: 158 past-day untimed parents " +
    "have children, and an untimed parent is never a root, so seeding from roots loses them. " +
    "rootsOf() on the client decides rendering.");
  assert.ok(!/\bJOIN\b/i.test(text), "no parent lookup of any shape");
  assert.ok(!/RECURSIVE/.test(text),
    "no subtree walk: it could only add out-of-window rows the old day scan never saw, " +
    "and it was also admitting undated and future-dated children");
});

test("one pool query plus one overlay read, and nothing else", async () => {
  const pool = makeRecordingPool({ rows: [row("a"), row("b", { date: "2026-07-27" })] });
  const db = loadDbWithMock(pool);
  await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.equal(pool.log.length, 2, "the whole point of the phase is that this is not a per-day scan");
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

test("an empty pool means no overlay query at all", async () => {
  const pool = makeRecordingPool({ rows: [] });
  const db = loadDbWithMock(pool);
  const out = await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.equal(pool.log.length, 1, "one query, then stop");
  assert.deepEqual(out, { rows: [], overlays: {}, dayRoots: [], scanned: 0 });
});

// ── what actually comes back ─────────────────────────────────────────────────

test("rows are returned parsed, in query order, with scanned counting the dates that yielded them", async () => {
  const pool = makeRecordingPool({
    rows: [
      row("a"),
      row("kid", { parent_id: "a", properties: { title: "kid", type: "task", subtaskOf: "a" } }),
      row("b", { date: "2026-07-27" })
    ]
  });
  const db = loadDbWithMock(pool);
  const out = await db.getCarryoverPool("ws-1", "2026-07-29", { days: 14 });

  assert.deepEqual(out.rows.map((r) => r.id), ["a", "kid", "b"], "pool order is the query's order");
  assert.equal(out.rows[1].properties.subtaskOf, "a", "properties come back parsed, not as a string");
  assert.equal(out.scanned, 2, "two distinct dates yielded rows");
});

test("a JSON string properties column is parsed on the way out", async () => {
  const raw = row("a");
  raw.properties = JSON.stringify(raw.properties);
  const out = await loadDbWithMock(makeRecordingPool({ rows: [raw] }))
    .getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.equal(out.rows[0].properties.title, "a");
});

// ── overlays ─────────────────────────────────────────────────────────────────

test("overlays come back keyed by date STRING, and carry done + locked", async () => {
  const pool = makeRecordingPool({
    rows: [row("a")],
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
    rows: [row("a")],
    dayRoots: [{ date: "2026-07-28", properties: { _lockedTasks: { a: true, b: true } } }]
  });
  const out = await loadDbWithMock(pool).getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  assert.deepEqual(out.overlays["2026-07-28"].locked, ["a", "b"]);
  assert.deepEqual(out.overlays["2026-07-28"].done, [], "a day_root with no _done is not undefined");
});

test("the overlay read is workspace-scoped and one query for every date in play", async () => {
  const pool = makeRecordingPool({ rows: [row("a"), row("b", { date: "2026-07-27" })] });
  await loadDbWithMock(pool).getCarryoverPool("ws-1", "2026-07-29", { days: 14 });
  const ovQ = pool.log.filter((q) => /type = 'day_root'/.test(q.text));
  assert.equal(ovQ.length, 1, "one overlay read, not one per day like the client scan did");
  assert.match(ovQ[0].text, /workspace_id IS NOT DISTINCT FROM \$1/);
  assert.deepEqual(ovQ[0].params[1].slice().sort(), ["2026-07-27", "2026-07-28"]);
});
