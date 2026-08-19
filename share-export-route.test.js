// Contract tests for the two pure-JS halves of the export/activity routes
// (routes/social-todo.js): `exportDatesFrom`'s range + cap, and the unread
// arithmetic inside `buildGuestActivity`.
//
// Why this file exists, separately from share-export.test.js: the serializer is
// require()able and already covered. These two are not — they live inside a
// `module.exports = function mount(app, ctx)` closure and reach the DB. But the
// parts that matter are pure, and they are the parts that fail SILENTLY:
//
//   - `exportDatesFrom` is the only thing standing between an ANONYMOUS link and
//     an unbounded day loop. A `<` slipped to `<=`, or a later refactor of the
//     cursor, ships a rate-limit regression that no page looks wrong for.
//   - `unreadCount` decides whether the owner sees "3 new" or "All caught up".
//     Wrong is not an exception and does not look broken; it renders "All caught
//     up" over an unread comment, which is the exact failure the inbox exists to
//     prevent. The > vs >= boundary is the NORMAL path, not an edge: the client
//     posts `activity.latestAt` verbatim, so on every "Mark all read" the newest
//     item's timestamp is compared against itself.
//
// Harness pattern: raw source sliced into a node:vm context, same as
// public-share-status.test.js / day-root-overlays.test.js, so the code under
// test is the shipped code and not a transcription of it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./routes/social-todo.js"), "utf8");

function mustMatch(re, what) {
  const m = SRC.match(re);
  if (!m) throw new Error("share-export-route.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

const TODAY = "2026-08-19";

// ── exportDatesFrom ──────────────────────────────────────────────────────────

const DATES_SRC = mustMatch(
  /const MAX_EXPORT_DAYS = \d+;[\s\S]*?\nfunction exportDatesFrom\(query\) \{[\s\S]*?\n\}/,
  "MAX_EXPORT_DAYS + exportDatesFrom"
);
// Assert the slice really caught the cap, so a line-number shift fails the
// harness instead of silently testing the wrong thing.
assert.ok(/dates\.length < MAX_EXPORT_DAYS/.test(DATES_SRC), "slice lost the day cap");

function loadExportDatesFrom() {
  const sandbox = {
    getTodayStr: () => TODAY,
    coerceDateString: (v) => (typeof v === "string" ? v.trim() : ""),
    isValidDate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
    module: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(DATES_SRC + "\nmodule.exports = { exportDatesFrom, MAX_EXPORT_DAYS };", sandbox);
  return sandbox.module.exports;
}

const { exportDatesFrom, MAX_EXPORT_DAYS } = loadExportDatesFrom();

test("export range: no params means today only", () => {
  const out = exportDatesFrom({});
  assert.deepEqual([...out.dates], [TODAY]);
  assert.equal(out.from, TODAY);
  assert.equal(out.to, TODAY);
});

test("export range: the day cap is enforced and the reported `to` follows it", () => {
  // The cap is a rate limit on an unauthenticated route. If `to` did NOT follow
  // the truncation, the filename and the Markdown subtitle would both claim a
  // span the file does not contain.
  const out = exportDatesFrom({ from: "2026-01-01", to: "2036-01-01" });
  assert.equal(out.dates.length, MAX_EXPORT_DAYS);
  assert.equal(out.from, "2026-01-01");
  assert.equal(out.to, "2026-01-31");
});

test("export range: an inverted range is a 400, not a silent empty file", () => {
  assert.throws(() => exportDatesFrom({ from: "2026-08-19", to: "2026-08-01" }), e => e.statusCode === 400);
});

test("export range: a regex-shaped but impossible date is a 400, not a 200 with nothing in it", () => {
  // isValidDate is a SHAPE check. Treating it as a validity check meant
  // "2026-13-45" produced Invalid Date, the cursor loop never ran, and the caller
  // got a header-only CSV that reads as "the owner has nothing scheduled".
  assert.throws(() => exportDatesFrom({ from: "2026-08-19", to: "2026-13-45" }), e => e.statusCode === 400);
  assert.throws(() => exportDatesFrom({ from: "2026-99-99" }), e => e.statusCode === 400);
});

test("export range: a rolling date like 2026-02-30 is rejected, not silently shifted", () => {
  // JS rolls this to 2026-03-02. Exporting a different day than the caller asked
  // for, with no indication, is worse than refusing.
  assert.throws(() => exportDatesFrom({ from: "2026-02-30", to: "2026-02-30" }), e => e.statusCode === 400);
});

test("export range: month and year boundaries roll correctly", () => {
  assert.equal(exportDatesFrom({ from: "2026-02-27", to: "2026-03-02" }).dates.length, 4);
  assert.deepEqual(
    [...exportDatesFrom({ from: "2026-12-30", to: "2027-01-02" }).dates],
    ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]
  );
});

test("export range: a DST spring-forward day is not skipped or doubled", () => {
  // The UTC-noon anchor exists for exactly this. US DST starts 2026-03-08.
  const out = exportDatesFrom({ from: "2026-03-07", to: "2026-03-09" });
  assert.deepEqual([...out.dates], ["2026-03-07", "2026-03-08", "2026-03-09"]);
});

test("export range: a single `date` param still works alongside from/to", () => {
  assert.deepEqual([...exportDatesFrom({ date: "2026-07-04" }).dates], ["2026-07-04"]);
  // `from` alone means a one-day range starting there, not from..forever.
  assert.deepEqual([...exportDatesFrom({ from: "2026-07-04" }).dates], ["2026-07-04"]);
});

// ── buildGuestActivity: the unread arithmetic ────────────────────────────────

const ACTIVITY_SRC = mustMatch(
  /const seenAt = \(share\.settings[\s\S]*?unreadCount: seenAt[\s\S]*?\n {2}\};/,
  "the seenAt / unreadCount tail of buildGuestActivity"
);

function unreadFor(items, seenAtValue) {
  const sandbox = { items, share: { settings: seenAtValue ? { activity_seen_at: seenAtValue } : {} }, module: {} };
  vm.createContext(sandbox);
  vm.runInContext("module.exports = (function(){ " + ACTIVITY_SRC.replace(/^\s*return\s*\{/m, "return {") + " })();", sandbox);
  return sandbox.module.exports;
}

const AT = (iso) => ({ at: iso });

test("activity: with no seen cursor, everything is unread", () => {
  const out = unreadFor([AT("2026-08-19T12:00:00Z"), AT("2026-08-19T11:00:00Z")], null);
  assert.equal(out.unreadCount, 2);
  assert.equal(out.seenAt, null);
  assert.equal(out.latestAt, "2026-08-19T12:00:00Z");
});

test("activity: an item stamped EXACTLY at the seen cursor is read, not unread", () => {
  // The normal path, not an edge case: markActivitySeen posts `latestAt`
  // verbatim, so the newest item is always compared against itself. Flip the
  // comparison to >= and the badge sticks at 1 forever.
  const items = [AT("2026-08-19T12:00:00Z"), AT("2026-08-19T11:00:00Z")];
  assert.equal(unreadFor(items, "2026-08-19T12:00:00Z").unreadCount, 0);
});

test("activity: only strictly newer items count as unread", () => {
  const items = [AT("2026-08-19T13:00:00Z"), AT("2026-08-19T12:00:00Z"), AT("2026-08-19T11:00:00Z")];
  assert.equal(unreadFor(items, "2026-08-19T12:00:00Z").unreadCount, 1);
});

test("activity: an empty inbox reports no latest and nothing unread", () => {
  const out = unreadFor([], null);
  assert.equal(out.unreadCount, 0);
  assert.equal(out.latestAt, null);
});

test("activity: a seen cursor newer than every item still reads as caught up", () => {
  // Possible after a rotate or a clock skew; it must not go negative or throw.
  assert.equal(unreadFor([AT("2026-08-19T10:00:00Z")], "2026-08-20T00:00:00Z").unreadCount, 0);
});

// ── range-export rate cap ────────────────────────────────────────────────────

const CAP_SRC = mustMatch(
  /const RANGE_EXPORT_WINDOW_MS[\s\S]*?\nfunction allowRangeExport\(actorKey, now\) \{[\s\S]*?\n\}/,
  "allowRangeExport + its window constants"
);

function loadCap() {
  const sandbox = { module: {} };
  vm.createContext(sandbox);
  vm.runInContext(CAP_SRC + "\nmodule.exports = { allowRangeExport, RANGE_EXPORT_PER_WINDOW, RANGE_EXPORT_WINDOW_MS };", sandbox);
  return sandbox.module.exports;
}

test("range export cap: allows a burst up to the limit, then refuses", () => {
  const { allowRangeExport, RANGE_EXPORT_PER_WINDOW } = loadCap();
  const t0 = 1_000_000;
  for (let i = 0; i < RANGE_EXPORT_PER_WINDOW; i++) {
    assert.equal(allowRangeExport("guest:a", t0 + i), true, "rejected request " + i);
  }
  assert.equal(allowRangeExport("guest:a", t0 + RANGE_EXPORT_PER_WINDOW), false);
});

test("range export cap: one guest cannot starve another", () => {
  const { allowRangeExport, RANGE_EXPORT_PER_WINDOW } = loadCap();
  const t0 = 2_000_000;
  for (let i = 0; i < RANGE_EXPORT_PER_WINDOW; i++) allowRangeExport("guest:a", t0 + i);
  assert.equal(allowRangeExport("guest:a", t0 + 10), false);
  assert.equal(allowRangeExport("guest:b", t0 + 10), true);
});

test("range export cap: the window rolls, it is not a permanent ban", () => {
  const { allowRangeExport, RANGE_EXPORT_PER_WINDOW, RANGE_EXPORT_WINDOW_MS } = loadCap();
  const t0 = 3_000_000;
  for (let i = 0; i < RANGE_EXPORT_PER_WINDOW; i++) allowRangeExport("guest:a", t0 + i);
  assert.equal(allowRangeExport("guest:a", t0 + 10), false);
  assert.equal(allowRangeExport("guest:a", t0 + RANGE_EXPORT_WINDOW_MS + 1), true);
});

test("range export cap: sweeps expired keys so the map cannot grow forever", () => {
  const { allowRangeExport, RANGE_EXPORT_WINDOW_MS } = loadCap();
  const t0 = 4_000_000;
  for (let i = 0; i < 500; i++) allowRangeExport("guest:" + i, t0);
  // One request past the window sweeps every stale key on its way through.
  assert.equal(allowRangeExport("guest:late", t0 + RANGE_EXPORT_WINDOW_MS + 1), true);
  // The swept keys are free again, which is the observable proof they were dropped.
  assert.equal(allowRangeExport("guest:0", t0 + RANGE_EXPORT_WINDOW_MS + 2), true);
});
