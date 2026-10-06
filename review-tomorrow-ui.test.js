"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require.resolve("./public/js/review-tomorrow"), "utf8");
const makePlan = fingerprint => ({ sourceDate: "2026-10-05", targetDate: "2026-10-06", timeZone: "America/New_York", days: 14, bounds: { start: "09:00", end: "17:00" }, fingerprint, items: ["a", "b"].map(id => ({ id, title: id, included: true, sourceDate: "2026-10-05", placement: { kind: "timed", start: "09:00", end: "09:30" }, reviewGuard: {} })) });
async function harness({ plans = [makePlan("one")], move = async () => {} } = {}) {
 const calls = [], reads = [], recollected = []; let modal, config;
 const element = () => ({ innerHTML: "", classList: { add() {} }, addEventListener() {}, querySelectorAll: () => [] });
 const DCC = { esc: value => String(value == null ? "" : value), api: async (url, options) => { reads.push({ url, options }); return structuredClone(plans.length > 1 ? plans.shift() : plans[0]); }, modal: opts => { config = opts; modal = { el: element(), update: value => { config = { ...config, ...value }; }, close: () => config.onClose() }; return modal; }, toast: () => {}, Carryover: { recollect(date) { recollected.push(date); }, refoldViewedDay: async () => {} } };
 const window = { DCC, blockStore: { rescheduleBlock: async (...args) => { calls.push(args); return move(args, () => modal.close()); } }, render() {} };
 vm.runInNewContext(source, { window, document: { createElement: element, getElementById: () => null } });
 await DCC.ReviewTomorrow.open(); return { calls, reads, recollected, confirm: () => config.actions.find(a => /Confirm/.test(a.label)).onClick(), body: () => config.body.innerHTML };
}
test("opening preview never moves tasks", async () => { const f = await harness(); assert.equal(f.reads.length, 1); assert.equal(f.calls.length, 0); });
test("a changed preview requires another confirmation before any writes", async () => {
 const f = await harness({ plans: [makePlan("old"), makePlan("new"), makePlan("new")] }); await f.confirm(); assert.equal(f.calls.length, 0); assert.match(f.body(), /confirm again/);
 await f.confirm(); assert.equal(f.calls.length, 2);
});
test("a partial failure stops and displays the completed count", async () => {
 let count = 0; const three = makePlan("one"); three.items.push({ ...three.items[1], id: "c", title: "c" });
 const f = await harness({ plans: [three], move: async () => { if (++count === 2) throw new Error("schedule changed"); } }); await f.confirm();
 assert.equal(f.calls.length, 2); assert.match(f.body(), /1 task groups moved/); assert.match(f.body(), /Refresh the preview before continuing/);
});
test("closing during a move stops after the current group", async () => {
 const f = await harness({ move: async (_args, close) => close() }); await f.confirm(); assert.equal(f.calls.length, 1);
});

test("successful moves invalidate their original dates even when the refreshed pool is empty", async () => {
 const empty = { ...makePlan("one"), items: [] };
 const f = await harness({ plans: [makePlan("one"), makePlan("one"), empty] });
 await f.confirm(); assert.equal(f.calls.length, 2); assert.ok(f.recollected.includes("2026-10-05"));
});
