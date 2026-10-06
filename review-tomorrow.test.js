"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const review = require("./lib/review-tomorrow");
const FROM = "2026-10-05", TO = "2026-10-06";
const state = { schedule: { working_hours: { start: "09:00", end: "17:00" }, timeline: [] } };
const row = (id, p = {}, date = FROM) => ({ id, type: "block", date, workspace_id: "ws-1", updated_at: "2026-10-05T16:00:00Z", properties: { kind: "task", type: "task", local_id: id, title: id, duration: 30, ...p } });
const plan = (rows, extras = {}) => review.buildPlan({ sourceDate: FROM, rows, targetState: state, targetBlocks: [], ...extras });
test("priority then age controls scheduling, with exact work-hour boundaries", () => {
 const p = plan([row("low", { priority: "Low" }), row("new", { priority: "High" }), row("old", { priority: "High" }, "2026-10-04")], { targetBlocks: [row("meeting", { type: "meeting", start: "09:00", end: "10:00" }, TO)] });
 assert.deepEqual(p.items.map(i => [i.id, i.placement.start]), [["old", "10:00"], ["new", "10:30"], ["low", "11:00"]]);
 assert.deepEqual(p.bounds, { start: "09:00", end: "17:00" });
});
test("overflow goes to Unscheduled, without the legacy one-hour grace", () => {
 const p = plan([row("fits", { duration: 30, priority: "High" }), row("overflow", { duration: 31 })], { targetBlocks: [row("busy", { start: "09:00", end: "16:30" }, TO)] });
 assert.equal(p.items[0].placement.end, "17:00"); assert.deepEqual(p.items[1].placement, { kind: "unplanned" });
});
test("dated untimed work schedules and selection refits remaining work", () => {
 const rows = [row("a"), row("b")]; assert.equal(plan(rows).items[0].placement.start, "09:00");
 const p = plan(rows, { selectedIds: ["b"] }); assert.equal(p.items[0].included, false); assert.equal(p.items[1].placement.start, "09:00");
});
test("completion IDs and timestamp-only overlays both exclude completed work", () => {
 const ov = review.overlay({ properties: { _done: { ids: ["a"], at: { b: "2026-10-05T12:00Z" } } } });
 assert.equal(plan([row("a"), row("b"), row("c", { done: true })], { overlays: { [FROM]: ov } }).items.length, 0);
});
test("calendar, explicit locks, scheduled repeats, waiting and active timers stay put", () => {
 const p = plan([row("m", { type: "meeting" }), row("lock"), row("repeat", { repeatMode: "scheduled" }), row("waiting", { status: "waiting" }), row("timer", { startedAt: "2026-10-05T12:00Z" }), row("unknown", { duration: null })], { overlays: { [FROM]: { locked: ["lock"] } } });
 assert.ok(p.items.every(i => i.held && !i.included && !i.placement));
});
test("full subtree includes undated and completed children, preserving one root", () => {
 const parent = row("p"), child = row("c", { subtaskOf: "p", done: true }, null);
 const p = plan([parent], { subtreePools: { [FROM]: [parent, child] } });
 assert.equal(p.items.length, 1); assert.equal(p.items[0].subtreeCount, 2);
 const changed = plan([parent], { subtreePools: { [FROM]: [parent, { ...child, properties: { ...child.properties, title: "changed" } }] } });
 assert.notEqual(p.fingerprint, changed.fingerprint);
});
test("cross-date descendants and ambiguous cycles are visible and held", () => {
 const parent = row("p"), future = row("c", { subtaskOf: "p" }, TO);
 assert.match(plan([parent], { subtreePools: { [FROM]: [parent, future] } }).items[0].held, /multiple dates/);
 const cycles = plan([row("a", { subtaskOf: "b" }), row("b", { subtaskOf: "a" })]);
 assert.equal(cycles.items.length, 2); assert.ok(cycles.items.every(i => /Ambiguous/.test(i.held)));
});
test("a child outside its parent window prevents misleading timed placement", () => {
 const parent = row("p", { start: "10:00", end: "10:30" }), child = row("c", { subtaskOf: "p", start: "10:20", end: "11:00" });
 assert.equal(plan([parent, child]).items[0].placement.kind, "unplanned");
});
test("all-day fixed events occupy working hours; transparent events permit slots", () => {
 assert.equal(plan([row("a")], { targetBlocks: [row("leave", { type: "ooo", all_day: true }, TO)] }).items[0].placement.kind, "unplanned");
 assert.equal(plan([row("a")], { targetBlocks: [row("leave", { type: "ooo", all_day: true, transparency: "transparent" }, TO)] }).items[0].placement.start, "09:00");
});
test("calendar date increment stays correct across DST and month/year boundaries", () => {
 for (const [date, expected] of [["2026-03-08", "2026-03-09"], ["2026-11-01", "2026-11-02"], ["2026-12-31", "2027-01-01"]]) assert.equal(review.addDay(date), expected);
});
function guardFixture() {
 const parent = row("a"), roots = [{ id: "root", type: "day_root", date: FROM, properties: {} }]; let target = [];
 const req = { workspaceId: "ws-1", session: { userId: 1 }, body: { targetDate: TO } };
 const ctx = { getTodayStr: () => FROM, buildDayResponse: async () => state, blockDB: { getBlocksByDate: async date => date === FROM ? roots : target } };
 const item = plan([parent]).items[0];
 return { parent, roots, req, ctx, item, changeTarget: rows => { target = rows; } };
}
test("guard rejects changed source completion, locks, duration and target appointments", async () => {
 for (const change of [f => { f.roots[0].properties._done = { at: { a: "now" } }; }, f => { f.roots[0].properties._lockedTasks = ["a"]; }, f => { f.parent.properties.duration = 40; }, f => f.changeTarget([row("new", { start: "09:00", end: "10:00" }, TO)])]) {
  const f = guardFixture(); change(f);
  await assert.rejects(review.validateMove(f.ctx, f.req, f.parent, [f.parent], f.item.placement, f.item.reviewGuard), e => e.code === "REVIEW_PLAN_CHANGED" && e.statusCode === 409);
 }
});
test("guard rejects midnight changes and invalid placements", async () => {
 const f = guardFixture(); f.ctx.getTodayStr = () => TO;
 await assert.rejects(review.validateMove(f.ctx, f.req, f.parent, [f.parent], f.item.placement, f.item.reviewGuard), /review date changed/);
});
test("previewed sequential placements match the actual target after each move", async () => {
 const a = row("a", { start: "11:00", end: "11:30" }), b = row("b"), c = row("c", { subtaskOf: "a", start: "11:00", end: "11:00", duration: 0 });
 const p = plan([a, b, c]); const first = p.items.find(i => i.id === "a"), second = p.items.find(i => i.id === "b");
 const req = { workspaceId: "ws-1", session: { userId: 1 }, body: { targetDate: TO } };
 const ctx = { getTodayStr: () => FROM, buildDayResponse: async () => state, blockDB: { getBlocksByDate: async date => date === FROM ? [] : [row("a", { start: first.placement.start, end: first.placement.end }, TO), row("c", { subtaskOf: "a", start: "09:00", end: "09:00", duration: 0 }, TO)] } };
 await review.validateMove(ctx, req, b, [b], second.placement, second.reviewGuard);
});
test("day preparation finishes before returning, with strict recurrence failures", async () => {
 const log = [], prep = require("./lib/prepare-scheduled-day")({ getTodayStr: () => FROM, APP_TIME_ZONE: "America/New_York", blockDB: { ensureDayRoot: async (...args) => log.push(["root", ...args]) }, respStore: { catchUpScheduledRepeats: async args => log.push(["catch", args]), materializeScheduledRepeatsForDate: async args => { log.push(["materialize", args]); throw new Error("repeat failed"); } } });
 await assert.rejects(prep(TO, 1, "ws-1"), /repeat failed/);
 assert.deepEqual(log.map(x => x[0]), ["root", "catch", "materialize"]); assert.equal(log[2][1].strict, true); assert.equal(log[2][1].targetTimeZone, "America/New_York");
});
test("sync bootstrap and pull prepare repeats before reading their cursor", async () => {
 const log = [], store = require("./sync-store"); const original = { bootstrap: store.bootstrap, pull: store.pull };
 store.bootstrap = async () => { log.push("snapshot"); return {}; }; store.pull = async () => { log.push("delta"); return {}; };
 try {
  const handlers = {}; require("./routes/sync")({ get: (url, fn) => { handlers[url] = fn; }, post: () => {} }, { getTodayStr: () => FROM, isValidDate: () => true, resolveOwnerStrict: async () => ({ workspaceId: "ws-1", userId: 1 }), prepareScheduledDay: async date => { assert.equal(date, TO); log.push("prepared"); }, buildDayResponse: async () => state });
  const req = { query: { date: TO } }, res = { json: () => {} };
  for (const url of ["/api/sync/bootstrap", "/api/sync/pull"]) await handlers[url](req, res, e => { throw e; });
  assert.deepEqual(log, ["prepared", "snapshot", "prepared", "delta"]);
 } finally { Object.assign(store, original); }
});

test("undated children inherit source-day completion and lock overlays", () => {
 const parent = row("p"), child = row("c", { subtaskOf: "p" }, null);
 const held = plan([parent], { subtreePools: { [FROM]: [parent, child] }, overlays: { [FROM]: { done: ["c"], locked: ["c"] } } });
 assert.match(held.items[0].held, /Locked/);
 assert.equal(plan([row("done", { doneAt: "2026-10-05T12:00Z" })]).items.length, 0);
});
test("a child of completed work is held instead of moving away from its parent", () => {
 const p = plan([row("p", { done: true }), row("c", { subtaskOf: "p" })]);
 assert.equal(p.items.length, 1); assert.ok(p.items[0].held); assert.equal(p.items[0].included, false);
});
test("deep reverse-ordered trees form one complete group", () => {
 const rows = Array.from({ length: 2000 }, (_, i) => row("n" + i, i ? { subtaskOf: "n" + (i - 1) } : {})).reverse();
 const p = plan(rows); assert.equal(p.items.length, 1); assert.equal(p.items[0].subtreeCount, 2000);
});

test("ISO fixed windows use New York local time even on a UTC server", () => {
 const p = plan([row("a", { duration: 60 })], { targetState: { schedule: { working_hours: { start: "09:00", end: "17:00" }, timeline: [{ type: "ooo", start: "2026-10-06T13:00:00Z", end: "2026-10-06T14:00:00Z" }] } } });
 assert.equal(p.items[0].placement.start, "10:00");
});
