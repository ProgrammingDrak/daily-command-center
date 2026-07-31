// C3 — db.getRescheduleSubtreePool / db.getRescheduleTombstone, the SQL half of the mover.
//
// These exist because the pool's predicate is the widest new piece of logic in the phase
// and every other test in the suite stubs it out: reschedule-route.test.js replaces it with
// a fake store, and reschedule-subtree.test.js walks in-memory arrays. So the claims the
// function's own comment makes were unguarded, including the load-bearing one — that the
// task filter is what keeps a meeting's artifacts (meeting_prep / meeting_summary /
// meeting_transcript / proposed_action_item) from being dragged onto a new date by a task
// move. Now that the walk reads parent_id, those artifacts ARE real children of a meeting
// row, and this predicate is the only thing standing between them and a re-date.
//
// A mock pool can only pin the statement, not row-level behavior — the same trade-off
// open-tasks-query.test.js accepts, and for the same stated reason: reimplementing the
// predicate in a JS harness would let a broken query pass on both sides. Row-level
// correctness is proven by the old-vs-new membership differential against the prod restore
// recorded in the phase completion (2057 candidates, onlyOld=0 onlyNew=0).
const test = require("node:test");
const assert = require("node:assert/strict");

function loadDbWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

function recorder(rows = []) {
  const log = [];
  return { log, async query(sql, params = []) { log.push({ sql: String(sql), params }); return { rows }; } };
}

test("the pool is the origin date plus LINKED undated strays, task rows only", async () => {
  const pool = recorder();
  const db = loadDbWithMock(pool);
  await db.getRescheduleSubtreePool("2026-07-30", "ws-1");
  assert.equal(pool.log.length, 1, "one query, not the getBlocksByDate + getUndatedTaskBlocks pair it replaced");
  const { sql, params } = pool.log[0];
  assert.deepEqual(params, ["2026-07-30", "ws-1"]);
  assert.match(sql, /b\.type = 'block'/, "a day_root can never enter the pool");
  assert.match(sql, /b\.deleted_at IS NULL/, "tombstoned rows do not move");
  assert.match(sql, /b\.workspace_id IS NOT DISTINCT FROM \$2/,
    "always scoped — the two functions this replaced dropped the predicate entirely when workspaceId was falsy");
  assert.match(
    sql,
    /b\.properties->>'local_id' IS NOT NULL OR b\.properties->>'kind' = 'task'/,
    "kind:'task' with no local_id is still a task (6 such live rows on the prod restore); a meeting artifact is neither"
  );
  assert.match(
    sql,
    /b\.date = \$1 OR \(b\.date IS NULL AND \(b\.properties->>'subtaskOf' IS NOT NULL OR b\.properties->>'wrapId' IS NOT NULL\)\)/,
    "an undated row joins ONLY when it carries a link — otherwise every dateless delegated_item rides along on every reschedule"
  );
});

test("the pool admits no meeting artifact, by either half of its task test", async () => {
  // The exclusion is structural rather than a kind blacklist: artifacts carry neither a
  // local_id nor kind 'task'. Assert the query does not try to name them, so nobody
  // "simplifies" it into a blacklist that a new artifact kind would slip past.
  const pool = recorder();
  const db = loadDbWithMock(pool);
  await db.getRescheduleSubtreePool("2026-07-30", "ws-1");
  const { sql } = pool.log[0];
  for (const kind of ["meeting_prep", "meeting_summary", "meeting_transcript", "proposed_action_item", "delegated_item"]) {
    assert.equal(sql.includes(kind), false, "the filter must not enumerate kinds; it admits tasks, not everything-but-a-list");
  }
});

test("a falsy workspaceId still constrains, it does not read every workspace", async () => {
  const pool = recorder();
  const db = loadDbWithMock(pool);
  await db.getRescheduleSubtreePool("2026-07-30", undefined);
  assert.deepEqual(pool.log[0].params, ["2026-07-30", null],
    "null, not omitted — `IS NOT DISTINCT FROM NULL` matches only null-workspace rows");
  assert.match(pool.log[0].sql, /b\.workspace_id IS NOT DISTINCT FROM \$2/);
});

test("getRescheduleTombstone asks for one row by the moved row's id", async () => {
  const pool = recorder();
  const db = loadDbWithMock(pool);
  await db.getRescheduleTombstone("2026-07-30", "blk-1", "ws-1");
  const { sql, params } = pool.log[0];
  assert.deepEqual(params, ["2026-07-30", "blk-1", "ws-1"]);
  assert.match(sql, /properties->>'kind' = 'reschedule_tombstone'/);
  assert.match(sql, /properties->>'movedBlockId' = \$2/);
  assert.match(sql, /LIMIT 1/, "the dedupe wants existence, not a day scan");
  assert.match(sql, /workspace_id IS NOT DISTINCT FROM \$3/);
});

test("getRescheduleTombstone returns null when the origin day has none", async () => {
  const db = loadDbWithMock(recorder([]));
  assert.equal(await db.getRescheduleTombstone("2026-07-30", "blk-1", "ws-1"), null);
});

test("getUndatedTaskBlocks is gone from the db surface", async () => {
  const db = loadDbWithMock(recorder());
  assert.equal(typeof db.getUndatedTaskBlocks, "undefined",
    "its only caller was the reschedule route, which now takes one pool query instead of concatenating two");
  assert.equal(typeof db.getRescheduleSubtreePool, "function");
  assert.equal(typeof db.getRescheduleTombstone, "function");
});
