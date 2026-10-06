"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const FROM = "2026-10-05", TO = "2026-10-06", WS = "ws-1";
const row = (id, props = {}, date = FROM) => ({ id, type: "block", date, workspace_id: WS, updated_at: "2026-10-05T15:00Z", properties: { kind: "task", type: "task", local_id: id, title: id, duration: 30, ...props } });
const state = { schedule: { working_hours: { start: "09:00", end: "17:00" }, timeline: [] } };
function mount(rows, { target = [], roots = [], beforeApply = () => {}, materializeFails = false } = {}) {
 const handlers = {}, calls = { moves: [], options: [], prepared: [], scopes: [] };
 const ctx = {
  APP_TIME_ZONE: "America/New_York", getTodayStr: () => FROM, isValidDate: d => /^\d{4}-\d{2}-\d{2}$/.test(d), getScheduleBlocks: async () => [], broadcast: () => {}, filterLegacyGcalBlocks: x => x, buildDayResponse: async () => state,
  pool: { query: async () => ({ rows: [] }) },
  blockDB: {
   getBlockIncludingDeleted: async id => rows.find(r => r.id === id), getBlock: async id => rows.find(r => r.id === id),
   ensureDayRoot: async date => calls.prepared.push(date), getResponsibilityBlocks: async () => { if (materializeFails) throw new Error("materialization unavailable"); return []; },
   getCarryoverPool: async (ws, _date, opts) => { calls.scopes.push({ ws, opts }); return { rows, dayRoots: roots, overlays: {} }; },
   getBlocksByDate: async date => date === TO ? target : [...rows, ...roots],
   getRescheduleSubtreePool: async () => rows, getRescheduleTombstone: async () => null,
   rescheduleBlocks: async (moves, creates, options) => { if (options) { beforeApply(); await options.beforeApply({ fakeTransaction: true }); } calls.moves.push(moves); calls.options.push(options); return { blocks: [...moves, ...creates] }; },
  },
 };
 const app = { get: (path, fn) => { handlers['GET ' + path] = fn; }, post: (path, fn) => { handlers['POST ' + path] = fn; }, patch: () => {}, delete: () => {}, put: () => {} };
 require("./routes/blocks")(app, ctx);
 async function call(path, body = {}, method = "POST") {
  const req = { method, body, query: method === "GET" ? body : {}, params: { id: body.id || rows[0]?.id }, workspaceId: WS, session: { userId: 1 } }; let status = 200, data;
  const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; }, headersSent: false };
  await handlers[method + " " + path](req, res, e => { throw e; }); return { status, body: data };
 }
 return { call, calls, rows, target, ctx };
}
const preview = f => f.call("/api/review-tomorrow/preview");
const move = (f, item) => f.call("/api/blocks/:id/reschedule", { id: item.id, targetDate: TO, placement: item.placement, reviewGuard: item.reviewGuard, userSetStart: false });
test("preview includes untimed dated tasks, uses New York, and does not move anything", async () => {
 const f = mount([row("a")]); const p = await preview(f);
 assert.equal(p.status, 200); assert.equal(p.body.targetDate, TO); assert.equal(p.body.timeZone, "America/New_York"); assert.equal(p.body.items[0].included, true);
 assert.deepEqual(f.calls.moves, []); assert.equal(f.calls.scopes[0].opts.includeUntimed, true); assert.equal(f.calls.scopes[0].ws, WS);
});
test("preview rejects invalid selections/lookbacks and supports all older work", async () => {
 const f = mount([row("a")]);
 for (const body of [{ selectedIds: [1] }, { selectedIds: "{" }, { days: -1 }, { days: 1.5 }]) assert.equal((await f.call("/api/review-tomorrow/preview", body)).status, 400);
 const p = await f.call("/api/review-tomorrow/preview", { days: "all", selectedIds: [] }); assert.equal(p.body.days, null); assert.equal(p.body.items[0].included, false);
});
test("confirmed move preserves IDs, completed checklist history, and zero-minute child times", async () => {
 const parent = row("p", { start: "11:00", end: "11:30" }), child = row("c", { subtaskOf: "p", start: "11:00", end: "11:00", duration: 0 });
 const root = { type: "day_root", date: FROM, properties: { _done: { at: { c: "original timestamp" } } } };
 const f = mount([parent, child], { roots: [root] }); const p = (await preview(f)).body; const result = await move(f, p.items[0]);
 assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body.moved, ["p", "c"]); assert.equal(result.body.created.length, 1);
 const moves = f.calls.moves[0]; assert.equal(moves[1].properties.done, true); assert.equal(moves[1].properties.status, "done"); assert.equal(moves[1].properties.completedAt, undefined); assert.equal(moves[1].properties.start, "09:00"); assert.equal(moves[1].properties.end, "09:00");
 assert.equal(f.calls.options[0].lockKey, "dcc-review:ws-1:" + TO);
});
test("overflow preserves duration and completion while clearing timed placement", async () => {
 const parent = row("p"), child = row("c", { subtaskOf: "p", done: true, duration: 0 });
 const f = mount([parent, child], { target: [row("busy", { start: "09:00", end: "17:00" }, TO)] }); const p = (await preview(f)).body; assert.equal(p.items[0].placement.kind, "unplanned");
 const result = await move(f, p.items[0]); assert.equal(result.status, 200); assert.equal(f.calls.moves[0][0].properties.duration, 30); assert.ok(!f.calls.moves[0][0].properties.start); assert.equal(f.calls.moves[0][1].properties.done, true);
});
test("source edits and newly fixed target appointments reject the confirmation", async () => {
 for (const edit of [f => { f.rows[0].properties.title = "changed"; }, f => { f.target.push(row("meeting", { type: "meeting", start: "09:00", end: "10:00" }, TO)); }]) {
  const f = mount([row("a")]); const p = (await preview(f)).body; edit(f);
  const response = await move(f, p.items[0]); assert.equal(response.status, 409); assert.equal(response.body.code, "REVIEW_PLAN_CHANGED"); assert.equal(f.calls.moves.length, 0);
 }
});
test("a new descendant arriving before transaction application rejects the entire group", async () => {
 const rows = [row("p")]; const f = mount(rows, { beforeApply: () => rows.push(row("new", { subtaskOf: "p" }, null)) }); const p = (await preview(f)).body;
 const response = await move(f, p.items[0]); assert.equal(response.status, 409); assert.equal(f.calls.moves.length, 0);
});
test("repeat preparation failure surfaces an error instead of an empty preview", async () => {
 const f = mount([row("a")], { materializeFails: true }); const p = await preview(f);
 assert.equal(p.status, 500); assert.match(p.body.error, /materialization unavailable/); assert.equal(f.calls.moves.length, 0);
});
test("the database guard runs on the transaction client before writes and rolls back failures", async () => {
 const queries = [], client = { release() {}, async query(sql) { queries.push(sql); return { rows: [] }; } };
 const poolPath = require.resolve("./pg-pool"), dbPath = require.resolve("./db"); const previousPool = require.cache[poolPath], previousDb = require.cache[dbPath];
 delete require.cache[dbPath]; require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { connect: async () => client } };
 try { const db = require("./db"); await assert.rejects(db.rescheduleBlocks([{ id: "p" }], [], { lockKey: "review", beforeApply: async received => { assert.equal(received, client); throw new Error("schedule changed"); } }), /schedule changed/);
  assert.equal(queries[0], "BEGIN"); assert.match(queries[1], /pg_advisory_xact_lock/); assert.equal(queries.at(-1), "ROLLBACK"); assert.ok(!queries.some(q => /UPDATE blocks/.test(q)));
 } finally { require.cache[poolPath] = previousPool; require.cache[dbPath] = previousDb; }
});

test("moving undated checklist children preserves source-overlay completion", async () => {
 const parent = row("p"), child = row("c", { subtaskOf: "p", duration: 0 }, null);
 const root = { type: "day_root", date: FROM, properties: { _done: { ids: ["c"] } } };
 const f = mount([parent, child], { roots: [root] }); const p = (await preview(f)).body;
 const result = await move(f, p.items[0]); assert.equal(result.status, 200);
 assert.equal(f.calls.moves[0][1].date, TO); assert.equal(f.calls.moves[0][1].properties.done, true);
});
