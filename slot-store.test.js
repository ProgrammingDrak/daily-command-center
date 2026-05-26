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
    bankBalance: options.bankBalance ?? 0,
    migrated: options.migrated ?? true,
    settings: options.settings || (options.migrated === false ? {} : {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
    }),
    ledgerInserted: false,
    ledgerDelta: options.ledgerDelta ?? null,
    pointAdds: 0,
    ledgerMetadata: null,
    rewardRows: options.rewardRows || [],
    legacyBankBuildersRetired: false,
  };

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const text = String(sql);
    if (text.includes("CREATE TABLE IF NOT EXISTS slot_accounts")) return { rows: [] };
    if (text.includes("INSERT INTO slot_accounts")) {
      return { rows: [{ workspace_id: params[0], user_id: params[1], point_balance: state.pointBalance, bank_balance_cents: state.bankBalance, settings: state.settings }] };
    }
    if (text.includes("THEN point_balance *")) {
      if (!state.settings.points_v2_migrated_at) {
        state.pointBalance *= params[1];
        state.migrated = true;
      }
      state.settings = { ...state.settings, ...JSON.parse(params[2]) };
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: state.settings }] };
    }
    if (text.includes("points_v3_migrated_at")) {
      if (!state.settings.points_v3_migrated_at) {
        state.pointBalance = Math.round(state.pointBalance * params[1]);
      }
      state.settings = { ...state.settings, ...JSON.parse(params[2]) };
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: state.settings }] };
    }
    if (text.includes("SELECT settings FROM slot_accounts")) {
      return { rows: [{ settings: { ...state.settings, default_rewards_seeded_at: "seeded" } }] };
    }
    if (text.includes("UPDATE slot_rewards") && text.includes("kind = $2")) {
      state.legacyBankBuildersRetired = true;
      state.rewardRows = state.rewardRows.map(row => row.kind === params[1] ? { ...row, active: false, weight: 0 } : row);
      return { rows: [] };
    }
    if (text.includes("UPDATE slot_rewards") && text.includes("SET chance_shares = GREATEST")) {
      state.rewardRows = state.rewardRows.map(row => ({
        ...row,
        chance_shares: (row.chance_shares === undefined || (row.chance_shares === 1 && row.weight !== 1))
          ? Math.max(0, row.weight || 0)
          : row.chance_shares,
      }));
      return { rows: [] };
    }
    if (text.includes("UPDATE slot_rewards") && text.includes("SET payment_source = CASE")) {
      state.rewardRows = state.rewardRows.map(row => {
        if (row.payment_source && row.payment_source !== "self") return row;
        if (row.kind === "sponsor") return { ...row, payment_source: "sponsored" };
        if (["free", "choice", "reroll"].includes(row.kind)) return { ...row, payment_source: "free" };
        return row.payment_source ? row : { ...row, payment_source: "self" };
      });
      return { rows: [] };
    }
    if (text.includes("UPDATE slot_rewards") && text.includes("deleted_at=NOW()")) {
      const idx = state.rewardRows.findIndex(row => String(row.id) === String(params[1]) && !row.deleted_at);
      if (idx < 0) return { rowCount: 0, rows: [] };
      state.rewardRows[idx] = { ...state.rewardRows[idx], active: false, weight: 0, deleted_at: "now" };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("UPDATE slot_accounts") && text.includes("settings = COALESCE(settings")) {
      state.settings = { ...state.settings, ...JSON.parse(params[1]) };
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM slot_accounts WHERE workspace_id")) {
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, bank_balance_cents: state.bankBalance, settings: state.settings }] };
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
    if (text.includes("SELECT * FROM slot_rewards")) {
      const legacyKind = params[1];
      let rows = legacyKind ? state.rewardRows.filter(row => row.kind !== legacyKind) : state.rewardRows;
      if (text.includes("deleted_at IS NULL")) rows = rows.filter(row => !row.deleted_at);
      return { rows };
    }
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
  assert.equal(first.delta, 60);
  assert.equal(duplicate.awarded, false);
  assert.equal(duplicate.delta, 0);
  assert.equal(mockPool.state.pointAdds, 1);
  assert.equal(mockPool.state.ledgerMetadata.formulaVersion, "task_points_v3");
  assert.equal(mockPool.state.ledgerMetadata.scoring.awardPoints, 60);
  assert.equal(mockPool.state.ledgerMetadata.inputs.duration_minutes, 60);
});

test("earnTaskCredit normalizes legacy duration_min payloads into minute-based points", async () => {
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
  assert.equal(result.credits, 60);
  assert.equal(result.delta, 60);
  assert.equal(mockPool.state.pointBalance, 60);
  assert.equal(mockPool.state.ledgerMetadata.scoring.awardPoints, 60);
  assert.equal(mockPool.state.ledgerMetadata.inputs.duration_minutes, 60);
});

test("earnTaskCredit adjusts old one-point duplicate ledger rows up to minute-based points", async () => {
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
  assert.equal(result.credits, 59);
  assert.equal(result.delta, 59);
  assert.equal(mockPool.state.pointBalance, 60);
  assert.equal(mockPool.state.ledgerDelta, 60);
});

test("getState migrates old one-spin credits into minute-based points once", async () => {
  const mockPool = createMockPool({ pointBalance: 7, migrated: false });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(state.account.point_balance, 175);
  assert.equal(state.constants.spinCostPoints, 25);
  assert.equal(state.constants.pointsPerSpin, 25);
  assert.equal(state.constants.pointsFormulaVersion, "task_points_v3");
});

test("getState migrates v2 spin cost to minute-based v3 spin cost", async () => {
  const mockPool = createMockPool({
    pointBalance: 70,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      spin_cost: 10,
    },
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(state.account.point_balance, 175);
  assert.equal(state.constants.spinCost, 25);
  assert.equal(state.account.settings.points_v3_old_spin_cost, 10);
  assert.equal(state.account.settings.points_v3_balance_multiplier, 2.5);
  assert.ok(
    mockPool.calls.some(call => String(call.sql).includes("ROUND(point_balance * $2::numeric)::int")),
    "v3 balance migration casts the fractional multiplier to numeric for Postgres"
  );
});

test("getState retires and omits legacy bank builder rewards", async () => {
  const rewardBase = {
    sponsor_type: "self",
    sponsor_active: true,
    value_cents: 0,
    bank_delta_cents: 0,
    requires_confirmation: false,
    cooldown_days: 0,
    unlock_threshold_cents: 0,
    notes: "",
    last_won_at: null,
  };
  const mockPool = createMockPool({
    pointBalance: 70,
    migrated: true,
    rewardRows: [
      { ...rewardBase, id: 1, title: "Bank builder: add $1", kind: "bank_builder", active: true, weight: 100, bank_delta_cents: 100 },
      { ...rewardBase, id: 2, title: "Take a walk", kind: "free", active: true, weight: 16 },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(mockPool.state.legacyBankBuildersRetired, true);
  assert.deepEqual(state.rewards.map(r => r.title), ["Take a walk"]);
});

test("deleteReward hides rewards without removing rows referenced by spin history", async () => {
  const rewardBase = {
    sponsor_type: "self",
    sponsor_splits: [],
    sponsor_active: true,
    value_cents: 0,
    bank_delta_cents: 0,
    requires_confirmation: false,
    cooldown_days: 0,
    unlock_threshold_cents: 0,
    notes: "",
    last_won_at: null,
    deleted_at: null,
  };
  const mockPool = createMockPool({
    pointBalance: 70,
    migrated: true,
    rewardRows: [
      { ...rewardBase, id: 1, title: "Take a nap", kind: "free", active: true, weight: 16 },
      { ...rewardBase, id: 2, title: "Take a walk", kind: "free", active: true, weight: 16 },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const result = await store.deleteReward("ws-1", 1);
  const state = await store.getState("ws-1", 1);

  assert.deepEqual(result, { ok: true });
  assert.equal(mockPool.state.rewardRows[0].deleted_at, "now");
  assert.equal(mockPool.state.rewardRows[0].active, false);
  assert.equal(mockPool.state.rewardRows[0].weight, 0);
  assert.equal(typeof mockPool.state.settings.default_rewards_user_modified_at, "string");
  assert.deepEqual(state.rewards.map(r => r.title), ["Take a walk"]);
});

test("getState locks paid jackpots when reserve is short", async () => {
  const rewardBase = {
    sponsor_type: "self",
    sponsor_splits: [],
    sponsor_active: true,
    value_cents: 7500,
    bank_delta_cents: 0,
    requires_confirmation: true,
    cooldown_days: 0,
    unlock_threshold_cents: 7500,
    notes: "",
    last_won_at: null,
    deleted_at: null,
  };
  const mockPool = createMockPool({
    bankBalance: 1200,
    migrated: true,
    rewardRows: [
      { ...rewardBase, id: 10, title: "Dinner jackpot", kind: "bank_gated", active: true, weight: 8 },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);
  const reward = state.rewards.find(r => r.id === 10);

  assert.equal(reward.eligible, false);
  assert.equal(reward.reserve_affordable, false);
  assert.equal(reward.reserve_shortfall_cents, 6300);
  assert.equal(reward.locked_reason, "bank_too_small");
  assert.equal(reward.jackpot_type, "self");
});

test("selectThreeStageOutcome returns a miss when jackpot roll misses", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], { jackpot_hit_rate: 0 }, () => 0);

  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.selected.kind, "miss");
  assert.equal(outcome.reroll_credit, false);
});

test("selectThreeStageOutcome rolls source, tier, then reward by shares", () => {
  const store = loadStoreWithMock(createMockPool());
  const rolls = [0, 0, 5];
  const rng = () => rolls.shift() || 0;
  const outcome = store._test.selectThreeStageOutcome([
    { id: 1, title: "Small thing", kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 3 },
    { id: 2, title: "Big thing", kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 7 },
  ], {
    jackpot_hit_rate: 1,
    payment_source_weights: { self: 0, sponsored: 0, free: 1 },
    reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
  }, rng);

  assert.equal(outcome.jackpot_hit, true);
  assert.equal(outcome.source.id, "free");
  assert.equal(outcome.tier.id, "tier_i");
  assert.equal(outcome.selected.id, 2);
  assert.equal(outcome.empty_bucket, false);
});

test("selectThreeStageOutcome awards reroll credit for empty source-tier bucket", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([
    { id: 1, title: "Wrong bucket", kind: "free", active: true, eligible: true, payment_source: "self", tier_id: "tier_i", chance_shares: 3 },
  ], {
    jackpot_hit_rate: 1,
    payment_source_weights: { self: 0, sponsored: 1, free: 0 },
    reward_tiers: [{ id: "tier_vi", label: "Tier VI", weight: 1, active: true }],
  }, () => 0);

  assert.equal(outcome.jackpot_hit, true);
  assert.equal(outcome.empty_bucket, true);
  assert.equal(outcome.reroll_credit, true);
  assert.equal(outcome.selected.kind, "reroll");
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

test("buildSpinScreen does not pay bank bonus on miss screens", () => {
  const crypto = require("node:crypto");
  const originalRandomInt = crypto.randomInt;
  crypto.randomInt = () => 0;
  try {
    const store = loadStoreWithMock(createMockPool());
    const screen = store._test.buildSpinScreen(
      { kind: "miss" },
      { bank_balance_cents: 0, settings: { monthly_goal_cents: 10000 } },
      { today: 0, week: 0, monthlyGoal: 10000 },
      true
    );

    assert.equal(screen.board.includes("BANK"), false);
    assert.equal(screen.payout.base_units, 0);
    assert.equal(screen.payout.positions.length, 0);
    assert.equal(screen.payout.cents, 0);
  } finally {
    crypto.randomInt = originalRandomInt;
  }
});
