const { test } = require("node:test");
const assert = require("node:assert/strict");
const { candidates, civil, inspect, viewingZone, validZone } = require("./public/js/schedule-zones");

const newYork = "America/New_York";

test("the Tokyo breakfast rolls over without modifying the legacy record", () => {
  const block = { id: "breakfast", date: "2026-11-08", properties: { start: "18:30", duration: 45 } };
  const original = structuredClone(block);
  const { instant } = inspect(block, newYork);
  assert.equal(new Date(instant).toISOString(), "2026-11-08T23:30:00.000Z");
  assert.deepEqual(civil(instant, "Asia/Tokyo"), { date: "2026-11-09", time: "08:30" });
  assert.deepEqual(civil(instant, newYork), { date: "2026-11-08", time: "18:30" });
  assert.deepEqual(civil(instant, "Asia/Kathmandu"), { date: "2026-11-09", time: "05:15" });
  assert.deepEqual(block, original);
});

test("the audit distinguishes all-day, DST gaps, and both occurrences of a repeated time", () => {
  assert.equal(inspect({ date: "2026-11-01", properties: { all_day: true, start: "01:30" } }, newYork).status, "date-only");
  assert.deepEqual(candidates("2026-03-08", "02:30", newYork), []);
  assert.deepEqual(candidates("2026-11-01", "01:30", newYork).map(at => new Date(at).toISOString()), [
    "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z",
  ]);
});

test("device resolution is independent of saved preferences and other devices", () => {
  const pref = Object.freeze({ mode: "device", zone: "Asia/Kathmandu" });
  assert.equal(viewingZone(pref, newYork, () => "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(viewingZone(pref, newYork, () => newYork), newYork);
  assert.equal(viewingZone(pref, newYork, () => ""), newYork);
  assert.equal(viewingZone({ ...pref, mode: "manual" }, newYork, () => newYork), "Asia/Kathmandu");
  assert.equal(validZone("EST"), false);
  assert.equal(validZone("+09:00"), false);
});

test("viewing days use consecutive local midnights through DST transitions", () => {
  const { dayWindow } = require("./public/js/schedule-zones");
  for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
    const { start, end } = dayWindow(day, newYork);
    assert.deepEqual(civil(start, newYork), { date: day, time: "00:00" });
    assert.equal(end - start, hours * 3600000);
  }
});

test("reviewed snapshot migration is idempotent and rollback retains later edits", () => {
  const { migrate } = require("./scripts/audit-schedule-zones");
  const original = [
    { id: "a", type: "block", date: "2026-11-08", properties: { start: "18:30", notes: "Original", duration: 45 } },
    { id: "b", type: "block", date: "2026-11-01", properties: { start: "01:30" } },
  ];
  const opts = { mode: "apply", zone: newYork, approved: ["a", "b"] };
  const applied = migrate(original, opts);
  assert.equal(applied.report.counts.added, 1);
  assert.equal(applied.report.review[0].id, "b");
  assert.equal(inspect(applied.blocks[0], newYork).status, "fixed");
  assert.deepEqual(migrate(applied.blocks, opts).blocks, applied.blocks);
  applied.blocks[0].properties.notes = "Edited after conversion";
  const rollback = migrate(applied.blocks, { ...opts, mode: "rollback" });
  assert.deepEqual(rollback.blocks, [
    { ...original[0], properties: { ...original[0].properties, notes: "Edited after conversion" } },
    original[1],
  ]);
});

test("an authoritative calendar instant resolves a repeated time and is invalidated by a schedule edit", () => {
  const properties = { start: "01:30", end: "02:00", scheduleInstant: {
    date: "2026-11-01", start: "01:30", end: "02:00", startAt: "2026-11-01T06:30:00Z", source: "calendar",
  } };
  const block = { date: "2026-11-01", properties };
  assert.equal(inspect(block, newYork).instant, Date.parse("2026-11-01T06:30:00Z"));
  assert.equal(inspect({ ...block, properties: { ...properties, start: "03:30" } }, newYork).status, "legacy-schedule");
});

test("server range includes fixed appointments by instant and date-only rows by civil date", () => {
  const { selectViewingRange } = require("./lib/viewing-date-range");
  const rows = [
    { id: "breakfast", type: "block", date: "2026-11-08", properties: { start: "18:30" } },
    { id: "previous", type: "block", date: "2026-11-08", properties: { start: "09:59" } },
    { id: "first", type: "block", date: "2026-11-08", properties: { start: "10:00" } },
    { id: "next", type: "block", date: "2026-11-09", properties: { start: "10:00" } },
    { id: "all-day", type: "block", date: "2026-11-07", properties: { all_day: true, all_day_end: "2026-11-10" } },
    { id: "date-only", type: "block", date: "2026-11-09", properties: {} },
  ];
  assert.deepEqual(selectViewingRange(rows, "2026-11-09", "2026-11-09", "Asia/Tokyo", newYork).map(r => r.id),
    ["breakfast", "first", "all-day", "date-only"]);
  assert.equal(rows[0].date, "2026-11-08");
});

test("database migration locks reviewed workspace rows and rolls back a failed update", async () => {
  const { migrateWorkspace } = require("./scripts/migrate-schedule-zones");
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT")) return { rows: [
      { id: "a", type: "block", date: "2026-11-08", properties: { start: "18:30" } },
    ] };
    if (sql.startsWith("UPDATE")) throw new Error("injected write failure");
  } };
  await assert.rejects(migrateWorkspace(client, { workspace: "ws", mode: "apply", zone: newYork, approved: ["a"] }),
    /injected write failure/);
  assert.match(calls[1].sql, /FOR UPDATE$/);
  assert.deepEqual(calls[1].params, ["ws", ["a"]]);
  assert.deepEqual(calls[2].params.slice(0, 2), ["ws", "a"]);
  assert.equal(calls[3].sql, "ROLLBACK");
});

test("the viewing-zone route scopes reads and rejects invalid zones and dates", async () => {
  let handler;
  const calls = [];
  const app = {
    get(path, callback) { if (path === "/api/blocks/range") handler = callback; },
    post() {}, patch() {}, put() {}, delete() {},
  };
  require("./routes/blocks")(app, {
    APP_TIME_ZONE: newYork,
    isValidDate: require("./lib/route-helpers").isValidDate,
    filterLegacyGcalBlocks: rows => rows,
    pool: {},
    blockDB: { async getBlocksByDateRange(...args) {
      calls.push(args);
      return [{ id: "breakfast", type: "block", date: "2026-11-08", properties: { start: "18:30" } }];
    } },
  });
  async function request(query, workspaceId) {
    const out = { status: 200 };
    await handler({ query, workspaceId }, {
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    });
    return out;
  }
  const query = { start: "2026-11-09", end: "2026-11-09", viewingZone: "Asia/Tokyo" };
  assert.equal((await request(query)).status, 403);
  assert.equal((await request({ ...query, start: "2026-02-31" }, "ws")).status, 400);
  assert.equal((await request({ ...query, viewingZone: "EST" }, "ws")).status, 400);
  assert.equal((await request(query, "ws")).body[0].id, "breakfast");
  assert.deepEqual(calls, [["2026-11-07", "2026-11-11", "ws"]]);
});
