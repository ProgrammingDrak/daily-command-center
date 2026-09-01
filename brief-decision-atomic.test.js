const test = require("node:test");
const assert = require("node:assert/strict");

function loadDbWithPool(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

function reviewState() {
  return {
    date: "2026-08-14",
    glymphatic_brief: {
      decisions: {},
      current: {
        pages: [{
          id: "front",
          done_today: [],
          tasks: [{ id: "task-1" }, { id: "task-2" }]
        }]
      }
    }
  };
}

function makePool(initialState) {
  let state = structuredClone(initialState);
  const log = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();
      log.push({ text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("INSERT INTO dcc_state")) return { rows: [] };
      if (text.startsWith("SELECT state_json FROM dcc_state")) return { rows: [{ state_json: structuredClone(state) }] };
      if (text.startsWith("UPDATE dcc_state SET state_json")) {
        state = structuredClone(params[0]);
        return { rows: [] };
      }
      throw new Error("Unhandled query: " + text.slice(0, 80));
    },
    release() {}
  };
  return {
    query: async () => ({ rows: [] }),
    connect: async () => client,
    state: () => state,
    log
  };
}

test("atomic brief decisions preserve separate per-task choices", async () => {
  const pool = makePool(reviewState());
  const db = loadDbWithPool(pool);
  await db.saveDccBriefDecision("2026-08-14", { taskId: "task-1", action: "accept" }, 1, "ws-1", reviewState());
  await db.saveDccBriefDecision("2026-08-14", { taskId: "task-2", action: "backlog" }, 1, "ws-1", reviewState());
  assert.equal(pool.state().glymphatic_brief.decisions["task-1"].action, "accept");
  assert.equal(pool.state().glymphatic_brief.decisions["task-2"].action, "backlog");
  assert.equal(pool.state().glymphatic_brief.decision_log.length, 2);
  assert.ok(pool.log.some(entry => /FOR UPDATE/.test(entry.text)));
});

test("repeating the same decision does not duplicate audit history", async () => {
  const pool = makePool(reviewState());
  const db = loadDbWithPool(pool);
  await db.saveDccBriefDecision("2026-08-14", { taskId: "task-1", action: "accept" }, 1, "ws-1", reviewState());
  const result = await db.saveDccBriefDecision("2026-08-14", { taskId: "task-1", action: "accept" }, 1, "ws-1", reviewState());
  assert.equal(result.changed, false);
  assert.equal(pool.state().glymphatic_brief.decision_log.length, 1);
});

test("atomic decisions normalize legacy camel-case brief state", async () => {
  const legacy = reviewState();
  legacy.glymphaticBrief = legacy.glymphatic_brief;
  delete legacy.glymphatic_brief;
  const pool = makePool(legacy);
  const db = loadDbWithPool(pool);
  await db.saveDccBriefDecision("2026-08-14", { taskId: "task-1", action: "accept" }, 1, "ws-1", legacy);
  assert.equal(pool.state().glymphaticBrief, undefined);
  assert.equal(pool.state().glymphatic_brief.decisions["task-1"].action, "accept");
  assert.equal(pool.state().glymphatic_brief.current.pages[0].id, "front");
});

test("whole-day saves cannot resurrect a decision removed by an atomic reset", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; },
    connect: async () => { throw new Error("not used"); }
  };
  const db = loadDbWithPool(pool);
  await db.saveDccState("2026-08-14", reviewState(), 1, "ws-1");
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /dcc_state\.state_json#>'\{glymphatic_brief,decisions\}'/);
  assert.doesNotMatch(queries[0].sql, /EXCLUDED\.state_json#>'\{glymphatic_brief,decisions\}'/,
    "the locked database map is authoritative, including an absent reset key");
  assert.match(queries[0].sql, /dcc_state\.state_json#>'\{glymphatic_brief,decision_log\}'/);
});
