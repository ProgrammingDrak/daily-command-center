// Contract tests for meeting-materializer.js — calendar meetings[] -> durable
// task blocks. Mocks blockDB with an in-memory block store (mirrors the
// glymphatic-brief-materializer harness). Asserts the create / calendar-wins
// reconcile / cancel / no-resurrect / guard behaviors the ingest path relies on.
const test = require("node:test");
const assert = require("node:assert/strict");
const createMaterializer = require("./meeting-materializer.js");

const meetingIdentity = (m) =>
  String(m?.event_id || m?.source_id || m?.gcal_event_id || m?.id || "").trim();

function makeBlockDB(seed) {
  let seq = 0;
  const store = (seed || []).slice();
  return {
    store,
    async getBlocksByDateIncludingDeleted(date, ws) {
      return store.filter((b) => b.date === date && b.workspace_id === ws);
    },
    async createBlock({ type, date, properties, sort_order, user_id, workspace_id }) {
      const b = { id: "blk-" + (++seq), type, date, properties, sort_order, user_id, workspace_id, deleted_at: null };
      store.push(b);
      return b;
    },
    async updateBlock(id, { properties, sort_order }) {
      const b = store.find((x) => x.id === id);
      if (!b) throw new Error("not found " + id);
      if (b.deleted_at) throw new Error("deleted " + id);
      b.properties = properties;
      if (sort_order !== undefined) b.sort_order = sort_order;
      return b;
    },
    async deleteBlock(id) {
      const b = store.find((x) => x.id === id);
      if (b) b.deleted_at = "2026-07-09T00:00:00Z";
      return { id };
    },
    async ensureDayRoot() {},
  };
}

function M(blockDB) {
  return createMaterializer({
    blockDB,
    scoreTaskPoints: () => ({ awardPoints: 0 }),
    meetingIdentity,
    APP_TIME_ZONE: "America/New_York",
  }).materializeMeetings;
}

const DATE = "2026-07-09";
const mtg = (id, startZ, endZ, extra) =>
  Object.assign({ event_id: id, title: id, start: startZ, end: endZ }, extra);
const args = (meetings, over) =>
  Object.assign({ date: DATE, meetings, userId: 1, workspaceId: "ws-1", hasMeetingsKey: true }, over);
const bySid = (db, sid) => db.store.find((b) => (b.properties || {}).source_id === sid);

test("creates a block per timed meeting; converts ISO to ET HH:MM; never source:gcal", async () => {
  const db = makeBlockDB();
  const res = await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  assert.equal(res.created, 1);
  const b = bySid(db, "e1");
  assert.equal(b.properties.type, "meeting");
  assert.equal(b.properties.start, "12:30"); // 16:30Z = 12:30 EDT
  assert.equal(b.properties.end, "13:30");
  assert.equal(b.properties.source, "calendar"); // NOT "gcal" (would be hidden by isLegacyGcalBlock)
  assert.equal(b.properties.gcal_event_id, undefined);
  assert.equal(b.properties.estimatedMinutes, 60);
});

test("skips all-day meetings; materializes a timed meeting on its own ET date", async () => {
  const db = makeBlockDB();
  const res = await M(db)(args([
    mtg("allday", "2026-07-09T00:00:00Z", "2026-07-09T23:59:00Z", { all_day: true }),
    mtg("other", "2026-07-10T15:00:00Z", "2026-07-10T16:00:00Z"),
  ]));
  assert.equal(res.created, 1); // "other" now materializes (multi-day horizon)...
  assert.equal(bySid(db, "other").date, "2026-07-10"); // ...on its own date
  assert.equal(bySid(db, "allday"), undefined); // all-day never materialized
  assert.equal(db.store.length, 1);
});

test("multi-day horizon: one payload materializes a block on each ET date", async () => {
  const db = makeBlockDB();
  const res = await M(db)(args([
    mtg("d0", "2026-07-09T15:00:00Z", "2026-07-09T16:00:00Z"),
    mtg("d1", "2026-07-10T15:00:00Z", "2026-07-10T16:00:00Z"),
    mtg("d2", "2026-07-11T15:00:00Z", "2026-07-11T16:00:00Z"),
  ]));
  assert.equal(res.created, 3);
  assert.equal(bySid(db, "d0").date, "2026-07-09");
  assert.equal(bySid(db, "d1").date, "2026-07-10");
  assert.equal(bySid(db, "d2").date, "2026-07-11");
});

test("ET date-derivation: an evening-ET meeting lands on its ET day, not the next UTC day", async () => {
  const db = makeBlockDB();
  // 2026-07-10T01:00:00Z is 2026-07-09 21:00 EDT. A UTC slice would say 07-10.
  const res = await M(db)(args([mtg("eve", "2026-07-10T01:00:00Z", "2026-07-10T02:00:00Z")]));
  assert.equal(res.created, 1);
  assert.equal(bySid(db, "eve").date, "2026-07-09"); // ET day, not UTC 07-10
  assert.equal(bySid(db, "eve").properties.start, "21:00");
});

test("cancellation scoping: a vanished future meeting inside the window is cancelled; a later meeting keeps the horizon open", async () => {
  const db = makeBlockDB();
  await M(db)(args([
    mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z"),
    mtg("e2", "2026-07-11T15:00:00Z", "2026-07-11T16:00:00Z"),
    mtg("e3", "2026-07-14T15:00:00Z", "2026-07-14T16:00:00Z"),
  ]));
  // e2 (07-11) vanishes; e3 (07-14) keeps the window open past 07-11.
  const res = await M(db)(args([
    mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z"),
    mtg("e3", "2026-07-14T15:00:00Z", "2026-07-14T16:00:00Z"),
  ]));
  assert.equal(res.cancelled, 1);
  assert.ok(bySid(db, "e2").deleted_at);
  assert.ok(!bySid(db, "e1").deleted_at);
  assert.ok(!bySid(db, "e3").deleted_at);
});

test("cancellation scoping: a live block before the anchor date is never swept", async () => {
  const db = makeBlockDB();
  await M(db)(args([
    mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z"),
    mtg("stale", "2026-07-09T18:00:00Z", "2026-07-09T18:30:00Z"),
  ]));
  // A calendar block on a date BEFORE the anchor (07-07) that the feed never mentions.
  db.store.push({
    id: "old", type: "block", date: "2026-07-07", workspace_id: "ws-1", deleted_at: null,
    properties: { type: "meeting", source: "calendar", source_id: "old", status: "open" },
  });
  const res = await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  assert.equal(res.cancelled, 1); // only "stale" on the anchor date
  assert.ok(bySid(db, "stale").deleted_at);
  assert.ok(!bySid(db, "old").deleted_at); // before the anchor, untouched
});

test("backfill mode (hasMeetingsKey:false) materializes but never cancels", async () => {
  const db = makeBlockDB();
  await M(db)(args([
    mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z"),
    mtg("e2", "2026-07-09T18:00:00Z", "2026-07-09T18:30:00Z"),
  ]));
  // Re-run with only e1 but in backfill mode: e2 must survive.
  const res = await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")], { hasMeetingsKey: false }));
  assert.equal(res.cancelled, 0);
  assert.ok(!bySid(db, "e2").deleted_at);
});

test("backfill never resurrects a user-deleted meeting on a past date", async () => {
  const db = makeBlockDB();
  const past = [mtg("p1", "2026-05-14T11:00:00Z", "2026-05-14T12:00:00Z")];
  await M(db)(Object.assign(args(past), { date: "2026-05-14", hasMeetingsKey: false }));
  await db.deleteBlock(bySid(db, "p1").id); // user removed it back then
  const res = await M(db)(Object.assign(args(past), { date: "2026-05-14", hasMeetingsKey: false }));
  assert.equal(res.created, 0);
  assert.equal(res.skipped, 1);
  assert.equal(db.store.filter((b) => (b.properties || {}).source_id === "p1").length, 1);
  assert.ok(bySid(db, "p1").deleted_at);
});

test("idempotent: re-ingesting identical meetings makes no changes", async () => {
  const db = makeBlockDB();
  const feed = [mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")];
  await M(db)(args(feed));
  const res = await M(db)(args(feed));
  assert.equal(res.created, 0);
  assert.equal(res.updated, 0);
  assert.equal(res.cancelled, 0);
});

test("calendar wins: a changed gcal time overwrites the block start/end", async () => {
  const db = makeBlockDB();
  await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  const res = await M(db)(args([mtg("e1", "2026-07-09T18:00:00Z", "2026-07-09T19:00:00Z")]));
  assert.equal(res.updated, 1);
  assert.equal(bySid(db, "e1").properties.start, "14:00"); // 18:00Z = 14:00 EDT
});

test("completed meeting is never overwritten by a re-sync", async () => {
  const db = makeBlockDB();
  await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  bySid(db, "e1").properties.status = "done";
  const res = await M(db)(args([mtg("e1", "2026-07-09T18:00:00Z", "2026-07-09T19:00:00Z")]));
  assert.equal(res.updated, 0);
  assert.equal(bySid(db, "e1").properties.start, "12:30"); // untouched
});

test("cancellation: a meeting that vanishes from the feed is soft-deleted", async () => {
  const db = makeBlockDB();
  await M(db)(args([
    mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z"),
    mtg("e2", "2026-07-09T18:00:00Z", "2026-07-09T18:30:00Z"),
  ]));
  const res = await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  assert.equal(res.cancelled, 1);
  assert.ok(bySid(db, "e2").deleted_at);
  assert.ok(!bySid(db, "e1").deleted_at);
});

test("cancellation never touches a completed meeting", async () => {
  const db = makeBlockDB();
  await M(db)(args([mtg("e2", "2026-07-09T18:00:00Z", "2026-07-09T18:30:00Z")]));
  bySid(db, "e2").properties.status = "done";
  const res = await M(db)(args([]));
  assert.equal(res.cancelled, 0);
  assert.ok(!bySid(db, "e2").deleted_at);
});

test("no cancellation when the ingest carried no meetings key (triage-only ingest)", async () => {
  const db = makeBlockDB();
  await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  const res = await M(db)(args([], { hasMeetingsKey: false }));
  assert.equal(res.cancelled, 0);
  assert.ok(!bySid(db, "e1").deleted_at);
});

test("never resurrects a user-deleted meeting on re-ingest", async () => {
  const db = makeBlockDB();
  await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  await db.deleteBlock(bySid(db, "e1").id); // user removed it
  const res = await M(db)(args([mtg("e1", "2026-07-09T16:30:00Z", "2026-07-09T17:30:00Z")]));
  assert.equal(res.created, 0);
  assert.equal(res.skipped, 1);
  assert.equal(db.store.filter((b) => (b.properties || {}).source_id === "e1").length, 1); // no duplicate
  assert.ok(bySid(db, "e1").deleted_at); // stays dead
});
