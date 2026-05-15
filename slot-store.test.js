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
    settings: options.settings || (options.migrated === false ? {} : { points_v2_migrated_at: "already", points_v2_spin_cost_migrated_at: "already" }),
    ledgerInserted: false,
    ledgerDelta: options.ledgerDelta ?? null,
    pointAdds: 0,
    ledgerMetadata: null,
  };

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const text = String(sql);
    if (text.includes("CREATE TABLE IF NOT EXISTS slot_accounts")) return { rows: [] };
    if (text.includes("INSERT INTO slot_accounts")) {
      return { rows: [{ workspace_id: params[0], user_id: params[1], point_balance: state.pointBalance, settings: state.settings }] };
    }
    if (text.includes("THEN point_balance *")) {
      if (!state.settings.points_v2_migrated_at) {
        state.pointBalance *= params[1];
        state.migrated = true;
      }
      state.settings = { ...state.settings, ...JSON.parse(params[2]) };
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: state.settings }] };
    }
    if (text.includes("SELECT settings FROM slot_accounts")) {
      return { rows: [{ settings: { ...state.settings, default_rewards_seeded_at: "seeded" } }] };
    }
    if (text.includes("SELECT * FROM slot_accounts WHERE workspace_id")) {
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: state.settings }] };
    }
    if (text.includes("INSERT INTO slot_point_ledger")) {
      state.ledgerMetadata = JSON.parse(params[5]);
      if (state.ledgerInserted) return { rows: [] };
      state.ledgerInserted = true;
      state.ledgerDelta = params[2];
      return { rows: [{ delta: params[2], metadata: state.ledgerMetadata }] };
    }
    if (text.includes("SELECT delta FROM slot_point_ledger")) {
      return state.ledgerInserted || state.ledgerDelta != null ? { rows: [{ delta: state.ledgerDelta }] } : { rows: [] };
    }
    if (text.includes("UPDATE slot_point_ledger")) {
      state.ledgerDelta = params[2];
      state.ledgerMetadata = JSON.parse(params[4]);
      return { rows: [] };
    }
    if (text.includes("point_balance = point_balance +")) {
      state.pointBalance += params[1];
      state.pointAdds += 1;
      return { rows: [] };
    }
    if (text.includes("date_trunc('day'")) return { rows: [{ cents: 0 }] };
    if (text.includes("date_trunc('week'")) return { rows: [{ cents: 0 }] };
    if (text.includes("date_trunc('month'")) return { rows: [{ cents: 0 }] };
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

test("earnTaskCredit normalizes legacy duration_min payloads into v2 points", async () => {
  const mockPool = createMockPool({ pointBalance: 0, migrated: true });
  const store = loadStoreWithMock(mockPool);

  const result = await store.earnTaskCredit("ws-1", 1, {
    source_key: "2026-05-13:legacy-task",
    task_id: "legacy-task",
    title: "Legacy scheduled task",
    type: "task",
    duration_min: 60,
    focus_minutes: 0,
  });

  assert.equal(result.awarded, true);
  assert.equal(result.credits, 14);
  assert.equal(result.delta, 14);
  assert.equal(mockPool.state.pointBalance, 14);
  assert.equal(mockPool.state.ledgerMetadata.scoring.awardPoints, 14);
  assert.equal(mockPool.state.ledgerMetadata.inputs.duration_minutes, 60);
});

test("earnTaskCredit adjusts old one-point duplicate ledger rows up to v2 points", async () => {
  const mockPool = createMockPool({ pointBalance: 1, migrated: true, ledgerDelta: 1 });
  mockPool.state.ledgerInserted = true;
  const store = loadStoreWithMock(mockPool);

  const result = await store.earnTaskCredit("ws-1", 1, {
    source_key: "2026-05-13:task-1",
    task_id: "task-1",
    title: "Previously under-awarded task",
    type: "task",
    duration_minutes: 60,
  });

  assert.equal(result.awarded, true);
  assert.equal(result.adjusted, true);
  assert.equal(result.credits, 13);
  assert.equal(result.delta, 13);
  assert.equal(mockPool.state.pointBalance, 14);
  assert.equal(mockPool.state.ledgerDelta, 14);
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

test("getState migrates old token spin cost to point spin cost without remultiplying balance", async () => {
  const mockPool = createMockPool({
    pointBalance: 70,
    migrated: true,
    settings: { points_v2_migrated_at: "already", spin_cost: 1 },
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(state.account.point_balance, 70);
  assert.equal(state.constants.spinCost, 10);
  assert.equal(state.account.settings.points_v2_old_spin_cost, 1);
  assert.equal(state.account.settings.points_v2_spin_cost_multiplier, 10);
});

test("bank screen payout values each BANK tile from the monthly goal, not current bank balance", () => {
  const store = loadStoreWithMock(createMockPool());
  const board = Array.from({ length: 15 }, () => "STRAW");
  board[0] = "BANK";
  board[4] = "BANK";
  const payout = store._test.calculateScreenBankPayout(
    board,
    { bank_balance_cents: 0, settings: { monthly_goal_cents: 10000 } },
    { today: 0, week: 0, monthlyGoal: 10000 }
  );

  assert.equal(payout.percent, 0.0022);
  assert.equal(payout.goal_cents, 10000);
  assert.equal(payout.base_cents, 22);
  assert.equal(payout.base_units, 2);
  assert.equal(payout.cents, 44);
});
