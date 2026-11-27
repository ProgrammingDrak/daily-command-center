const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function mountBlocks(gameStore, { duplicate = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = "ws-1"; req.session = { userId: 7 }; next(); });
  const task = { id: "row-1", type: "block", date: "2026-11-27", workspace_id: "ws-1", properties: { title: "T", status: "open" } };
  const blockDB = {
    setTaskCompletion: async (input) => ({
      task: { ...task, properties: { ...task.properties, status: input.completed ? "done" : "open" } },
      affectedTasks: [], revision: "r2", persistenceTarget: "task_row", duplicate, broadcastIds: ["row-1"],
    }),
    getBlockIncludingDeleted: async () => task,
    getCarryoverPool: async () => ({ rows: [], dayRoots: [], overlays: {}, scanned: 0 }),
    getBlock: async () => null,
    updateBlock: async (_id, input = {}) => ({ ...task, ...input }),
    getBlocksByDate: async () => [],
    getBlocksByTypes: async () => [],
  };
  require("./routes/blocks")(app, {
    blockDB, gameStore,
    broadcast: () => {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (v) => v,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-11-27",
    isAllowedSweepBlockItem: () => true,
    isValidDate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)),
    pool: { query: async () => ({ rows: [] }) },
    APP_TIME_ZONE: "America/New_York",
  });
  return app;
}

async function request(app, path, method, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const completeBody = (completed = true) => ({ completed, mutationId: "m-" + Math.random().toString(36).slice(2), taskDate: "2026-11-27" });

test("completion route returns the XP that landed", async () => {
  const calls = [];
  const app = mountBlocks({ onTaskCompletion: async (input) => { calls.push(input); return [{ type: "complete", points: 10, taskId: "row-1" }]; } });
  const res = await request(app, "/api/tasks/row-1/completion", "POST", completeBody());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.game, { awarded: [{ type: "complete", points: 10, taskId: "row-1" }] });
  assert.equal(calls[0].completed, true);
  assert.equal(calls[0].workspaceId, "ws-1");
  assert.equal(calls[0].userId, 7);
});

test("a failing game store never breaks completion", async () => {
  const app = mountBlocks({ onTaskCompletion: async () => { throw new Error("db down"); } });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await request(app, "/api/tasks/row-1/completion", "POST", completeBody());
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.game, { awarded: [] });
  } finally {
    console.error = original;
  }
});

test("a duplicate completion skips the game hook", async () => {
  let called = 0;
  const app = mountBlocks({ onTaskCompletion: async () => { called++; return []; } }, { duplicate: true });
  const res = await request(app, "/api/tasks/row-1/completion", "POST", completeBody());
  assert.equal(res.status, 200);
  assert.equal(called, 0);
});

test("game routes: summary, intentions and date validation", async () => {
  const app = express();
  app.use(express.json());
  const seen = [];
  const store = {
    summary: async (owner) => ({ todayXp: 5, owner }),
    getIntentions: async (ws, date) => ({ ws, date }),
    setIntentions: async (input) => { seen.push(input); return { big3: input.big3 }; },
    setMinimumDayDone: async (input) => ({ minimumDayDone: input.done }),
    closeDays: async () => ({ closed: [{ date: "2026-11-26", outcome: "counted" }], state: {} }),
  };
  require("./routes/game")(app, { gameStore: store, resolveOwnerStrict: async () => ({ workspaceId: "ws-1", userId: 1 }) });

  assert.equal((await request(app, "/api/game/summary", "GET")).body.todayXp, 5);
  assert.equal((await request(app, "/api/game/intentions/bad-date", "GET")).status, 400);
  const put = await request(app, "/api/game/intentions/2026-11-27", "PUT", { big3: ["a"], minimumDay: "walk" });
  assert.deepEqual(put.body, { big3: ["a"] });
  assert.equal(seen[0].minimumDay, "walk");
  assert.equal((await request(app, "/api/game/intentions/2026-11-27/minimum-day", "POST", {})).body.minimumDayDone, true);
  assert.equal((await request(app, "/api/game/intentions/2026-11-27/minimum-day", "POST", { done: false })).body.minimumDayDone, false);
  const close = await request(app, "/api/dcc/game/close-day", "POST", {});
  assert.equal(close.body.closed.length, 1);
  assert.ok((await request(app, "/api/game/config", "GET")).body.xp.START_ON_TIME > 0);
});
