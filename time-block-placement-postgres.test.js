const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const configured = !!process.env.DCC_TEST_DATABASE_URL;
test("time-block placement uses production HTTP and PostgreSQL persistence", { skip: !configured }, async t => {
  const f = await require("./test-support/time-block-fixture").fixture();
  const server = f.app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await f.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  const send = async (id, body, other = false) => { const r = await fetch(base + "/api/blocks/" + id + "/reschedule", { method: "POST", headers: { "content-type": "application/json", ...(other ? { "x-review-session": "other" } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const choice = () => ({ targetDate: f.date, placement: { kind: "time_block", blockId: "focus", requestId: crypto.randomUUID() } });
  await f.config([{ id: "focus" }]);
  await f.block("already", { start: "09:00", end: "09:45" });
  await f.block("meeting", { type: "meeting", start: "09:45", end: "10:00" });
  await f.block("moving", { elapsedSeconds: 19, occurrenceKey: "2099-11-01T09:00", repeatMode: "scheduled" });
  await t.test("same-day untimed task becomes durably timed and preserves identity/actual/occurrence", async () => {
    const request = choice(); request.placement.title = "Edited title";
    const response = await send("moving", request); assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await f.ctx.blockDB.getBlock("moving"); assert.equal(row.date, f.date); assert.equal(row.properties.start, "10:00"); assert.equal(row.properties.end, "10:30");
    assert.equal(row.properties.title, "Edited title"); assert.equal(row.properties.elapsedSeconds, 19); assert.equal(row.properties.occurrenceKey, "2099-11-01T09:00");
    assert.equal(require("./public/js/task-model").fromBlock(row).untimed, false);
    const repeated = await send("moving", request); assert.equal(repeated.status, 200); assert.equal(repeated.body.repeated, true);
    const reselected = await send("moving", choice()); assert.equal(reselected.body.blocks[0].properties.start, "10:00");
  });
  await t.test("cross-day subtree and lost-response receipt retain child and tombstone", async () => {
    await f.block("tree", { start: "08:00", end: "08:30" }, "block", "2099-11-01");
    await f.block("child", { subtaskOf: "tree", start: "08:00", end: "08:15", duration: 15 }, "block", "2099-11-01");
    const request = choice(); const first = await send("tree", request); assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await send("tree", request); assert.equal(again.status, 200); assert.equal(again.body.blocks.length, 2); assert.equal(again.body.created.length, 1);
    assert.equal((await f.ctx.blockDB.getBlock("child")).date, f.date);
    const row = await f.ctx.blockDB.getBlock("tree"); await f.ctx.blockDB.updateBlock(row.id, { properties: { ...row.properties, start: "15:00", end: "15:30" } });
    assert.equal((await send("tree", request)).status, 409);
  });
  await t.test("foreign task and block identifiers are isolated", async () => {
    assert.equal((await send("moving", choice(), true)).status, 404);
    const r = await fetch(base + "/api/time-block-placement?date=" + f.date, { headers: { "x-review-session": "other" } }); assert.deepEqual((await r.json()).blocks, []);
    await f.block("foreign", {}, "block", f.date, "ws-2"); assert.equal((await send("foreign", choice(), true)).status, 409);
  });
  await t.test("stale occupancy is re-read under the transaction and rejects atomically", async () => {
    await f.block("stale", {});
    const original = f.ctx.blockDB.rescheduleBlocks;
    f.ctx.blockDB.rescheduleBlocks = async (...args) => { await f.block("interloper", { start: "11:00", end: "12:00" }); return original(...args); };
    try { const r = await send("stale", choice()); assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal((await f.ctx.blockDB.getBlock("stale")).properties.start, undefined); }
    finally { f.ctx.blockDB.rescheduleBlocks = original; await f.ctx.blockDB.deleteBlock("interloper"); }
  });
  await t.test("concurrent selections cannot claim the same slot", async () => {
    await f.block("concurrent-a", {}); await f.block("concurrent-b", {});
    const results = await Promise.all([send("concurrent-a", choice()), send("concurrent-b", choice())]);
    assert.ok(results.some(r => r.status === 200)); assert.ok(results.every(r => [200,409].includes(r.status)), JSON.stringify(results));
    const rows = await Promise.all([f.ctx.blockDB.getBlock("concurrent-a"), f.ctx.blockDB.getBlock("concurrent-b")]);
    if (rows.every(r => r.properties.start)) assert.notEqual(rows[0].properties.start, rows[1].properties.start);
  });
  await t.test("legacy day-root completion and completed timestamps cannot reopen work", async () => {
    await f.block("legacy-done", {}, "block", "2099-11-01");
    const root = await f.ctx.blockDB.ensureDayRoot("2099-11-01", 1, "ws-1");
    await f.ctx.blockDB.updateBlock(root, { properties: { _done: { ids: ["legacy-done"] } } });
    const r = await send("legacy-done", choice()); assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((await f.ctx.blockDB.getBlock("legacy-done")).date, "2099-11-01");
    await f.block("timestamp-done", { completedAt: "2099-11-01T13:00:00Z" });
    assert.equal((await send("timestamp-done", choice())).status, 409);
  });
  await t.test("configuration changed during commit is rejected without a partial write", async () => {
    await f.block("config-race", {});
    const original = f.ctx.blockDB.rescheduleBlocks;
    f.ctx.blockDB.rescheduleBlocks = async (...args) => { await f.config([{ id: "focus", start: "14:00", end: "16:00" }]); return original(...args); };
    try { const r = await send("config-race", choice()); assert.equal(r.status, 409); assert.equal((await f.ctx.blockDB.getBlock("config-race")).properties.start, undefined); }
    finally { f.ctx.blockDB.rescheduleBlocks = original; }
  });
  await t.test("empty configuration never invents default blocks; manual move remains supported", async () => {
    await f.config([]); const r = await fetch(base + "/api/time-block-placement?date=" + f.date); assert.deepEqual((await r.json()).blocks, []);
    assert.equal((await send("moving", choice())).status, 409);
    assert.equal((await send("moving", { targetDate: f.date, placement: { kind: "timed", start: "14:15", end: "14:45" }, userSetStart: true })).status, 200);
    assert.equal((await f.ctx.blockDB.getBlock("moving")).properties.start, "14:15");
  });
});
