const test = require("node:test");
const assert = require("node:assert/strict");

function loadStoreWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const storePath = require.resolve("./slot-store");
  delete require.cache[poolPath];
  delete require.cache[storePath];
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: mockPool,
  };
  return require("./slot-store");
}

function createMockPool(options = {}) {
  const calls = [];
  const state = {
    pointBalance: options.pointBalance ?? 0,
    migrated: options.migrated ?? true,
    ledgerInserted: false,
    pointAdds: 0,
    ledgerMetadata: null,
  };

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const text = String(sql);
    if (text.includes("CREATE TABLE IF NOT EXISTS slot_accounts")) return { rows: [] };
    if (text.includes("INSERT INTO slot_accounts")) {
      return { rows: [{ workspace_id: params[0], user_id: params[1], point_balance: state.pointBalance, settings: state.migrated ? { points_v2_migrated_at: "already" } : {} }] };
    }
    if (text.includes("point_balance = point_balance *")) {
      if (state.migrated) return { rows: [] };
      state.pointBalance *= params[1];
      state.migrated = true;
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: JSON.parse(params[2]) }] };
    }
    if (text.includes("SELECT settings FROM slot_accounts")) {
      return { rows: [{ settings: { default_rewards_seeded_at: "seeded", points_v2_migrated_at: "already" } }] };
    }
    if (text.includes("INSERT INTO slot_point_ledger")) {
      state.ledgerMetadata = JSON.parse(params[5]);
      if (state.ledgerInserted) return { rows: [] };
      state.ledgerInserted = true;
      return { rows: [{ delta: params[2], metadata: state.ledgerMetadata }] };
    }
    if (text.includes("point_balance = point_balance +")) {
      state.pointBalance += params[1];
      state.pointAdds += 1;
      return { rows: [] };
    }
    if (text.includes("date_trunc('day'")) return { rows: [{ cents: 0 }] };
    if (text.includes("date_trunc('week'")) return { rows: [{ cents: 0 }] };
    if (text.includes("MIN(created_at) AS oldest_at")) return { rows: [{ cents: 0, count: 0, oldest_at: null }] };
    if (text.includes("SELECT * FROM slot_rewards")) return { rows: [] };
    if (text.includes("SELECT * FROM slot_spins")) return { rows: [] };
    throw new Error("Unexpected query: " + text.slice(0, 120));
  }

  return { query, calls, state };
}

test("earnTaskCredit stores formula metadata and does not double-award duplicate source keys", async () => {
  const mockPool = createMockPool({ pointBalance: 100, migrated: true });
  const store = loadStoreWithMock(mockPool);

  const body = {
    source_key: "2026-05-13:task-1",
    task_id: "task-1",
    title: "Normal task",
    type: "task",
    duration_minutes: 60,
    effort_tier: "medium",
    attention_tier: "normal",
  };
  const first = await store.earnTaskCredit("ws-1", 1, body);
  const duplicate = await store.earnTaskCredit("ws-1", 1, body);

  assert.equal(first.awarded, true);
  assert.equal(first.delta, 14);
  assert.equal(duplicate.awarded, false);
  assert.equal(duplicate.delta, 0);
  assert.equal(mockPool.state.pointAdds, 1);
  assert.equal(mockPool.state.ledgerMetadata.formulaVersion, "task_points_v2");
  assert.equal(mockPool.state.ledgerMetadata.scoring.awardPoints, 14);
  assert.equal(mockPool.state.ledgerMetadata.inputs.duration_minutes, 60);
});

test("getState migrates old one-spin credits into v2 points once", async () => {
  const mockPool = createMockPool({ pointBalance: 7, migrated: false });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(state.account.point_balance, 70);
  assert.equal(state.constants.spinCostPoints, 10);
  assert.equal(state.constants.pointsPerSpin, 10);
  assert.equal(state.constants.pointsFormulaVersion, "task_points_v2");
});
