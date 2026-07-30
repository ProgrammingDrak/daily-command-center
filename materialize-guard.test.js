// lib/materialize-guard.js — the shared no-resurrection contract.
//
// The thing under test is a rule, not an algorithm: a soft-deleted match is STILL a
// match, so every path that mints a task from an external or derived item skips it
// rather than minting a lookalike. #253 inlined that rule in three places with three
// different lookups; these tests pin the one copy they collapsed into, and the five
// materialize paths that now share it.
const test = require("node:test");
const assert = require("node:assert/strict");

const createMaterializeGuard = require("./lib/materialize-guard");
const { assertNotResurrecting, dedupeStatus } = require("./lib/materialize-guard");

const TOMB = "2026-07-29T10:00:00Z";

function row(id, props = {}, deletedAt = null) {
  return { id, properties: props, deleted_at: deletedAt, workspace_id: "ws-1" };
}

// A blockDB faithful on the two axes that matter: findByIdempotencyKey is
// tombstone-inclusive and live-first (and DATE-BLIND — no date predicate exists in the
// real query either), and getBlocksByDateIncludingDeleted returns tombstones mixed in
// with live rows in sort order, which is why the guard has to pick a winner itself.
function fakeDB(rows) {
  const calls = { findByIdempotencyKey: 0, getBlocksByDateIncludingDeleted: 0 };
  return {
    calls,
    findByIdempotencyKey: async (workspaceId, key) => {
      calls.findByIdempotencyKey++;
      const hits = rows.filter(r =>
        (r.properties || {}).idempotency_key === key &&
        (r.workspace_id || null) === (workspaceId || null));
      return hits.find(r => !r.deleted_at) || hits[0] || null;
    },
    getBlocksByDateIncludingDeleted: async (date, workspaceId) => {
      calls.getBlocksByDateIncludingDeleted++;
      return rows.filter(r => r.date === date && (r.workspace_id || null) === (workspaceId || null));
    },
  };
}

test("assertNotResurrecting: a tombstone is a skip, a live row is not, nothing is not", () => {
  assert.equal(assertNotResurrecting(row("a", {}, TOMB)).skip, true);
  assert.equal(assertNotResurrecting(row("a")).skip, false);
  assert.equal(assertNotResurrecting(null).skip, false);
  assert.equal(assertNotResurrecting(undefined).skip, false);
  // The hit rides along so a caller can name what it skipped without a second lookup.
  assert.equal(assertNotResurrecting(row("a", {}, TOMB)).existing.id, "a");
  assert.equal(assertNotResurrecting(null).existing, null);
});

test("dedupeStatus is the single source of the two status strings", () => {
  assert.equal(dedupeStatus(null), null, "no match means go create, not skip");
  assert.equal(dedupeStatus(row("a")), "skipped_duplicate");
  assert.equal(dedupeStatus(row("a", {}, TOMB)), "skipped_deleted");
});

test("the guard refuses to construct without a blockDB", () => {
  // A silently-degraded guard is worse than none: it would report "no match" for
  // everything, which is exactly the resurrection this module exists to stop.
  assert.throws(() => createMaterializeGuard(), /requires blockDB/);
  assert.throws(() => createMaterializeGuard({}), /requires blockDB/);
});

test("findForDedupe returns a SOFT-DELETED idempotency-key match", async () => {
  // The whole point. A lookup filtering deleted_at IS NULL returns null here, the
  // caller creates, and the task the user deleted is back.
  const db = fakeDB([row("gone", { idempotency_key: "k1" }, TOMB)]);
  const guard = createMaterializeGuard({ blockDB: db });
  const hit = await guard.findForDedupe("ws-1", { idempotencyKey: "k1" });
  assert.equal(hit.id, "gone");
  assert.equal(dedupeStatus(hit), "skipped_deleted");
});

test("findForDedupe prefers the LIVE row when a key has both", async () => {
  const db = fakeDB([
    row("gone", { idempotency_key: "k1" }, TOMB),
    row("live", { idempotency_key: "k1" }),
  ]);
  const guard = createMaterializeGuard({ blockDB: db });
  const hit = await guard.findForDedupe("ws-1", { idempotencyKey: "k1" });
  assert.equal(hit.id, "live", "a caller holding both reports duplicate, not deleted");
  assert.equal(dedupeStatus(hit), "skipped_duplicate");
});

test("the idempotency-key path is DATE-BLIND, deliberately", async () => {
  // This is the one behavior widening A2 makes, so it is pinned rather than left to
  // drift back: the routes/dcc.js lookup this replaced carried `WHERE date = $1`, so
  // deleting a keyed task and letting the same agent retry on a LATER day recreated it.
  // A key is an identity claim, not a per-day one.
  const db = fakeDB([row("gone-monday", { idempotency_key: "k1" }, TOMB)]);
  const guard = createMaterializeGuard({ blockDB: db });
  const hit = await guard.findForDedupe("ws-1", { idempotencyKey: "k1", date: "2026-07-31" });
  assert.equal(hit.id, "gone-monday", "a different date must not hide the tombstone");
  assert.equal(db.calls.getBlocksByDateIncludingDeleted, 0, "and it must not cost a day scan");
});

test("findForDedupe falls back to a same-day source_id match", async () => {
  // The materializer identity scheme: no caller-supplied key, so the row is found by
  // what created it. Tombstone included, same rule.
  const rows = [
    { ...row("m1", { source_id: "evt-1" }, TOMB), date: "2026-07-30" },
    { ...row("m2", { source_id: "evt-2" }), date: "2026-07-30" },
  ];
  const guard = createMaterializeGuard({ blockDB: fakeDB(rows) });
  const hit = await guard.findForDedupe("ws-1", { date: "2026-07-30", sourceId: "evt-1" });
  assert.equal(hit.id, "m1");
  assert.equal(assertNotResurrecting(hit).skip, true);
  const miss = await guard.findForDedupe("ws-1", { date: "2026-07-30", sourceId: "evt-404" });
  assert.equal(miss, null);
});

test("the same-day path takes an arbitrary predicate, and prefers a live hit", async () => {
  // How the task-group route dedupes: no key, no source_id, just "did this group
  // already land on this day". The tombstone sorts FIRST in the day scan, so a naive
  // `rows.find(...)` would report the harsher skipped_deleted while a live row exists.
  const rows = [
    { ...row("tg-gone", { taskGroupId: "g1" }, TOMB), date: "2026-07-30" },
    { ...row("tg-live", { taskGroupId: "g1" }), date: "2026-07-30" },
  ];
  const guard = createMaterializeGuard({ blockDB: fakeDB(rows) });
  const hit = await guard.findForDedupe("ws-1", {
    date: "2026-07-30",
    match: (r) => (r.properties || {}).taskGroupId === "g1",
  });
  assert.equal(hit.id, "tg-live");
});

test("findForDedupe returns null when it has nothing to match on", async () => {
  // Guard against the silent-no-op shape: a caller that forgets to pass an identity
  // must not get "no duplicate exists" for free. No identity, no query at all.
  const db = fakeDB([{ ...row("x", { source_id: "evt-1" }), date: "2026-07-30" }]);
  const guard = createMaterializeGuard({ blockDB: db });
  assert.equal(await guard.findForDedupe("ws-1", {}), null);
  assert.equal(await guard.findForDedupe("ws-1", { date: "2026-07-30" }), null, "date alone is not an identity");
  assert.equal(await guard.findForDedupe("ws-1", { sourceId: "evt-1" }), null, "and neither is a dateless source_id");
  assert.equal(db.calls.findByIdempotencyKey, 0);
  assert.equal(db.calls.getBlocksByDateIncludingDeleted, 0);
});

test("workspace isolation: another tenant's row is not a match", async () => {
  const rows = [{ ...row("theirs", { idempotency_key: "k1" }), workspace_id: "ws-other" }];
  const guard = createMaterializeGuard({ blockDB: fakeDB(rows) });
  assert.equal(await guard.findForDedupe("ws-1", { idempotencyKey: "k1" }), null);
});

// ── The five materialize paths ──
// Each one is a real call site of the guard. The assertion is the same rule five
// times, which is the point: before this module they were three implementations and
// two gaps.
test("all five materialize paths skip a soft-deleted match", async () => {
  const meetingMaterializer = require("./meeting-materializer");

  // 1. meeting-materializer: the reference implementation, now calling the shared guard.
  const created = [];
  const mm = meetingMaterializer({
    blockDB: {
      getBlocksByDateIncludingDeleted: async () => [
        { id: "meet-gone", date: "2026-07-30", deleted_at: TOMB, properties: { source: "calendar", type: "meeting", source_id: "evt-1" } },
      ],
      createItineraryTask: async (b) => { created.push(b); return { id: "new" }; },
      updateBlock: async () => ({}),
      deleteBlock: async () => ({}),
      ensureDayRoot: async () => ({}),
    },
    meetingIdentity: (m) => m.id,
    scoreTaskPoints: () => ({ points: 0 }),
    resolvePointTag: () => null,
  });
  const res = await mm.materializeMeetings({
    date: "2026-07-30",
    meetings: [{ id: "evt-1", title: "Standup", start: "2026-07-30T14:00:00Z", end: "2026-07-30T14:30:00Z" }],
    userId: 1, workspaceId: "ws-1", hasMeetingsKey: true,
  });
  assert.equal(res.skipped, 1, "a deleted meeting is skipped");
  assert.equal(res.created, 0, "and never re-created");
  assert.equal(created.length, 0);

  // 2-4. quick-task, brief log-done, brief push-next — all three reach the guard
  // through routes/dcc.js findBriefBlock, which is now a one-line delegate. The
  // route-level assertions live in delete-contract.test.js; here we pin that the
  // shared lookup they share returns the tombstone at all.
  const db = fakeDB([row("gone", { idempotency_key: "day-review:2026-07-30:7" }, TOMB)]);
  const guard = createMaterializeGuard({ blockDB: db });
  for (const caller of ["quick-task", "brief/log-done", "brief/push-next"]) {
    const hit = await guard.findForDedupe("ws-1", { idempotencyKey: "day-review:2026-07-30:7" });
    assert.equal(dedupeStatus(hit), "skipped_deleted", `${caller} must see the tombstone`);
  }

  // 5. task groups: the path #253 left with no guard of any kind.
  const tgDb = fakeDB([{ ...row("tg-gone", { taskGroupId: "g1" }, TOMB), date: "2026-07-30" }]);
  const tgHit = await createMaterializeGuard({ blockDB: tgDb }).findForDedupe("ws-1", {
    date: "2026-07-30",
    match: (r) => (r.properties || {}).taskGroupId === "g1",
  });
  assert.equal(dedupeStatus(tgHit), "skipped_deleted");
});
