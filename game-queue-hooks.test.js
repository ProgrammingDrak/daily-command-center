const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

// Replace the queue store before the route module loads it.
const storePath = require.resolve("./conversation-store");
let fakeStore;
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { createConversationStore: () => fakeStore } };
const mountQueue = require("./routes/working-queue");

function app(gameStore) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { userId: 1 }; req.workspaceId = "ws-1"; next(); });
  const broadcasts = [];
  mountQueue(a, { gameStore, pool: { query: async () => ({ rows: [1] }) }, broadcast: (type, payload) => broadcasts.push({ type, payload }) }, { enabled: true });
  return { a, broadcasts };
}
async function post(a, body) {
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/working-queue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  } finally { await new Promise((r) => server.close(r)); }
}
const task = { id: "t1", type: "block", date: "2026-11-27", properties: { title: "T" } };

test("queue Done awards sparks and the 'sits with you' bonus only for the Foreground task", async () => {
  const calls = [];
  fakeStore = { state: async () => ({ foreground: [{ id: "t1", title: "T" }] }), execute: async () => ({ ok: true, task, affectedTasks: [task] }) };
  const { a, broadcasts } = app({ onTaskCompletion: async (i) => { calls.push(i); return [{ type: "complete", points: 10 }]; } });
  const res = await post(a, { action: "done", taskId: "t1", at: "2026-11-27T15:00:00Z" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.game.awarded, [{ type: "complete", points: 10 }]);
  assert.equal(calls[0].inFocus, true);
  assert.equal(calls[0].completed, true);
  assert.ok(broadcasts.some((b) => b.type === "game-changed"));

  fakeStore.state = async () => ({ foreground: [] });
  await post(a, { action: "done", taskId: "t1" });
  assert.equal(calls[1].inFocus, false);
});

test("queue Start and Undo call the matching hooks; other actions award nothing", async () => {
  const seen = [];
  fakeStore = { state: async () => ({ foreground: [] }), execute: async () => ({ ok: true, task, affectedTasks: [task] }) };
  const { a } = app({
    onTaskStarted: async (i) => { seen.push(["start", i.atMs]); return []; },
    onTaskCompletion: async (i) => { seen.push(["completion", i.completed]); return []; },
  });
  await post(a, { action: "start", taskId: "t1", at: "2026-11-27T15:00:00Z" });
  await post(a, { action: "undo-completion", taskId: "t1" });
  const snooze = await post(a, { action: "queue-snooze", taskId: "t1" });
  assert.deepEqual(seen, [["start", Date.parse("2026-11-27T15:00:00Z")], ["completion", false]]);
  assert.deepEqual(snooze.body.game, { awarded: [] });
});

test("a failing game store never breaks a queue command", async () => {
  fakeStore = { state: async () => ({ foreground: [] }), execute: async () => ({ ok: true, task, affectedTasks: [task] }) };
  const { a } = app({ onTaskCompletion: async () => { throw new Error("db down"); } });
  const original = console.error; console.error = () => {};
  try {
    const res = await post(a, { action: "done", taskId: "t1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.game, { awarded: [] });
  } finally { console.error = original; }
});
