// GET /api/tasks/open — the HTTP half of C2's carryover pool.
//
// db.getCarryoverPool is pinned in open-tasks-query.test.js and the collector in
// unfinished-collect.test.js, but the route between them owns real branching that
// neither of those can see: the `days=all` sentinel, both clamps, the 400 on a bad
// `?before=`, the default `before`, and the two wrappers applied to the rows.
//
// Pre-review caught that gap, and the concrete failure is worth naming: delete the
// `rawDays === "all" ? null :` clause and `days` becomes `parseInt("all", 10) || 14`,
// so the modal's "Show older" sweep silently stays capped at 14 days. Every other test
// in the repo still passes, because the collector test asserts the client SENDS
// `days=all` and carryover-fixture.js has its own independent `all` branch. Two stubs
// agreeing with each other is not coverage of the thing in between.
//
// routes/blocks.js is an (app, ctx) factory, so it mounts on a bare express app with
// fake stores — same harness as blocks-batch-authz.test.js. req.workspaceId and
// req.session come from server middleware in the real app and are injected here.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const MINE = "ws-1";
const TODAY = "2026-07-30";

function mountApp({ poolRows = [], dayRoots = [], getBlock } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const calls = [];
  const filtered = [];
  const updated = [];
  const ctx = {
    blockDB: {
      getCarryoverPool: async (ws, before, opts) => {
        calls.push({ ws, before, opts });
        return {
          rows: poolRows, dayRoots,
          overlays: { [TODAY]: { done: [], locked: [] } }, scanned: 1
        };
      },
      updateBlock: async (id, props) => { updated.push({ id, props }); return { id, properties: props }; },
      getBlock: getBlock || (async () => null),
      getBlockIncludingDeleted: async () => null,
      batchOp: async () => ({ batchId: "b", blocks: [] }),
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getDelegatedItems: async () => [],
      getUndatedTaskBlocks: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
    },
    broadcast: () => {},
    crypto: require("node:crypto"),
    // Recorded rather than a passthrough: the route must actually run the rows
    // through it, because the read this endpoint replaced applied it too.
    filterLegacyGcalBlocks: (b) => { filtered.push(b); return b.filter((r) => !r.legacy); },
    getScheduleBlocks: async () => [],
    getTodayStr: () => TODAY,
    isAllowedSweepBlockItem: () => true,
    // The REAL shape, not `() => true`: a permissive stub would hide the 400 branch.
    isValidDate: (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)),
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
    APP_TIME_ZONE: "America/Chicago",
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, calls, filtered, updated };
}

async function get(app, qs) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/tasks/open${qs}`);
    const body = await resp.json().catch(() => ({}));
    return { status: resp.status, body };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("days=all is the unbounded sentinel and reaches the store as null", async () => {
  const { app, calls } = mountApp();
  const { status } = await get(app, "?days=all");
  assert.equal(status, 200);
  assert.equal(calls[0].opts.days, null,
    'without the "all" branch this becomes parseInt("all") || 14 and Show older silently stays capped');
});

// Note the falsy-zero interaction, which is easy to misread: `parseInt(x,10) || N`
// short-circuits on 0, so `days=0` takes the DEFAULT rather than the clamp floor,
// while `days=-5` is truthy and does reach Math.max. Zero days of lookback is a
// meaningless request for a carryover lane, so defaulting is the right answer -- it is
// pinned here because the two paths look identical and behave differently.
test("days is clamped, and anything unparseable falls back to the 14-day default", async () => {
  const cases = [["?days=7", 7], ["?days=9999", 3650], ["?days=0", 14], ["?days=-5", 1],
    ["?days=junk", 14], ["", 14], ["?days=", 14]];
  for (const [qs, expected] of cases) {
    const { app, calls } = mountApp();
    await get(app, qs);
    assert.equal(calls[0].opts.days, expected, `${qs || "(no query)"} -> days=${expected}`);
  }
});

test("limit is clamped the same way", async () => {
  const cases = [["?limit=25", 25], ["?limit=99999", 2000], ["?limit=0", 500], ["?limit=-5", 1],
    ["?limit=junk", 500], ["", 500]];
  for (const [qs, expected] of cases) {
    const { app, calls } = mountApp();
    await get(app, qs);
    assert.equal(calls[0].opts.limit, expected, `${qs || "(no query)"} -> limit=${expected}`);
  }
});

test("an invalid ?before= is a 400, and the store is never reached", async () => {
  const { app, calls } = mountApp();
  const { status, body } = await get(app, "?before=nope");
  assert.equal(status, 400);
  assert.match(body.error, /before/i);
  assert.equal(calls.length, 0,
    "a bad date must not reach the query; the client swallows errors into an empty lane, " +
    "so a 400 here would look like 'no carryover work' rather than a failure");
});

test("?before= defaults to today and is passed through when valid", async () => {
  const dflt = mountApp();
  await get(dflt.app, "");
  assert.equal(dflt.calls[0].before, TODAY);

  const explicit = mountApp();
  await get(explicit.app, "?before=2026-07-01");
  assert.equal(explicit.calls[0].before, "2026-07-01");
});

test("the workspace comes from the session, never from the query string", async () => {
  const { app, calls } = mountApp();
  await get(app, "?workspaceId=ws-someone-else&workspace_id=ws-someone-else");
  assert.equal(calls[0].ws, MINE);
});

test("rows go through filterLegacyGcalBlocks; overlays and scanned pass through untouched", async () => {
  const { app, filtered } = mountApp({
    poolRows: [{ id: "keep", date: TODAY }, { id: "drop", date: TODAY, legacy: true }]
  });
  const { status, body } = await get(app, "?days=14");
  assert.equal(status, 200);
  assert.equal(filtered.length, 1, "the filter must actually run on the pool");
  assert.deepEqual(body.rows.map((r) => r.id), ["keep"]);
  assert.deepEqual(body.overlays, { [TODAY]: { done: [], locked: [] } });
  assert.equal(body.scanned, 1);
  assert.ok(!("dayRoots" in body), "dayRoots is internal plumbing for the reconciler, not payload");
});

// The LIMIT applies to the RAW pool, before the caller's done filter, and it drops the
// oldest rows. "Show older" is the surface whose whole point is reaching old work, so a
// silently short count is the worst thing to render there. No silent caps.
test("truncated is reported when the raw pool hits the limit, and not when it does not", async () => {
  const three = [1, 2, 3].map((n) => ({ id: "r" + n, date: TODAY }));

  const full = mountApp({ poolRows: three });
  const hit = await get(full.app, "?limit=3");
  assert.equal(hit.body.truncated, true, "3 rows back on a limit of 3 means rows were probably cut");

  const room = mountApp({ poolRows: three });
  const under = await get(room.app, "?limit=10");
  assert.equal(under.body.truncated, false);
});

// ── the timing reconcile ─────────────────────────────────────────────────────
// This is the pass that round 2 of pre-review forced, and the bug it caught lived
// INSIDE round 1's fix. reconcileTiming rebuilds its completion map from the day_root
// rows in the array it is handed. getCarryoverPool selects three TASK types and no
// day_root, so passing the lane's rows alone makes every overlay-completed row read as
// NOT done: instead of settling an orphaned timer it withdraws a legitimate derived
// stamp and deletes the time_entry Day Review reads. Strictly worse than no wrapper.
//
// A row with no `type` never reaches the reconciler's candidate filter, so a fixture
// like `{id, date}` exercises none of this and the whole branch can be deleted with a
// green suite. These use real `type: "block"` rows.

const PAST = "2026-07-28";
const timedRow = (over = {}) => ({
  id: "t1", type: "block", date: PAST, workspace_id: MINE, deleted_at: null,
  properties: Object.assign({
    title: "t", type: "task", start: "09:00",
    startedAt: "2026-07-28T14:00:00.000Z"
  }, over)
});
const dayRootWith = (props) => ({
  id: "day-root-" + MINE + "-" + PAST, type: "day_root", date: PAST,
  workspace_id: MINE, deleted_at: null, properties: props
});

test("an overlay-completed carryover row IS seen as done, so its orphaned timer settles", async () => {
  const target = timedRow();
  const { app, updated } = mountApp({
    poolRows: [target],
    // The real day_root, carrying both halves the reconciler reads: `ids` for
    // isBlockDone and `at` for completionMsOf (which is why the reduced `overlays`
    // slice cannot stand in for it -- the slice drops `at`).
    dayRoots: [dayRootWith({ _done: { ids: ["t1"], at: { t1: "2026-07-28T14:30:00.000Z" } } })],
    getBlock: async () => JSON.parse(JSON.stringify(target))
  });
  const { status } = await get(app, "");
  assert.equal(status, 200);
  const wrote = updated.find((u) => u.id === "t1");
  assert.ok(wrote, "the reconciler must reach the store; with no day_root it bails before this");
  // blockDB.updateBlock(id, { properties: nextProps }) -- the patch is nested.
  assert.equal(wrote.props.properties.actualMinutes, 30,
    "09:00 start, 14:30 completion stamp -> 30 real minutes");
  assert.equal(wrote.props.properties.actualMinutesFrom, "reconcile");
});

test("a derived stamp on a still-done row is NOT withdrawn", async () => {
  // The inverse of the bug: with the overlay visible, isBlockDone is true, so a row
  // already carrying our own stamp is not a candidate and nothing is cleared.
  const target = timedRow({ actualMinutes: 30, actualMinutesFrom: "reconcile", startedAt: undefined });
  const { app, updated } = mountApp({
    poolRows: [target],
    dayRoots: [dayRootWith({ _done: { ids: ["t1"], at: { t1: "2026-07-28T14:30:00.000Z" } } })],
    getBlock: async () => JSON.parse(JSON.stringify(target))
  });
  await get(app, "");
  assert.equal(updated.length, 0, "clearTiming here would delete real duration and its time_entry");
});

test("a time_entry the reconciler mints never surfaces as a lane row", async () => {
  // reconcileTiming pushes any minted segment into the array it was given. That array
  // is the scratch, not `rows` -- and it matters more since the collector's own
  // type guard was removed: a time_entry has a `start` and no title, so it would
  // render as an untitled phantom row.
  const target = timedRow();
  const { app } = mountApp({
    poolRows: [target],
    dayRoots: [dayRootWith({ _done: { ids: ["t1"], at: { t1: "2026-07-28T14:30:00.000Z" } } })],
    getBlock: async () => JSON.parse(JSON.stringify(target))
  });
  const { body } = await get(app, "");
  assert.deepEqual(body.rows.map((r) => r.id), ["t1"],
    "exactly the pool row: no minted time_entry, no day_root");
  assert.ok(!body.rows.some((r) => r.type === "day_root" || r.type === "time_entry"));
});

test("a reconcile failure still renders the lane", async () => {
  // withReconciledTiming swallows by contract ("never let a read fail on a reconcile").
  // Worth pinning here because this route now depends on that for a store it stubs.
  const { app } = mountApp({
    poolRows: [timedRow()],
    dayRoots: [dayRootWith({ _done: { ids: ["t1"] } })],
    getBlock: async () => { throw new Error("db down"); }
  });
  const { status, body } = await get(app, "");
  assert.equal(status, 200);
  assert.deepEqual(body.rows.map((r) => r.id), ["t1"]);
});
