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
    pendingBankDeposit: options.pendingBankDeposit || { cents: 0, count: 0, oldest_at: null },
    pendingSpinRows: options.pendingSpinRows || [],
    spinRows: options.spinRows || [],
    legacyBankBuildersRetired: false,
  };

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const text = String(sql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
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
      const jsonParam = params.find(p => typeof p === "string" && p.trim().startsWith("{"));
      if (jsonParam) state.settings = { ...state.settings, ...JSON.parse(jsonParam) };
      if (text.includes("point_balance = point_balance -")) {
        state.pointBalance -= params[1] || 0;
      }
      if (text.includes("bank_balance_cents = GREATEST") && params.length >= 3) {
        state.bankBalance = Math.max(0, state.bankBalance - (params[1] || 0));
      }
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, bank_balance_cents: state.bankBalance, settings: state.settings }] };
    }
    if (text.includes("SELECT point_balance, settings FROM slot_accounts")) {
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, settings: state.settings }] };
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
    if (text.includes("MIN(created_at) AS oldest_at")) return { rows: [{ cents: state.pendingBankDeposit.cents || 0, count: state.pendingBankDeposit.count || 0, oldest_at: state.pendingBankDeposit.oldest_at || null }] };
    if (text.includes("SELECT id, bank_delta_cents") && text.includes("FROM slot_spins")) {
      return { rows: state.pendingSpinRows };
    }
    if (text.includes("UPDATE slot_accounts SET bank_balance_cents = bank_balance_cents +")) {
      state.bankBalance += params[1] || 0;
      return { rows: [] };
    }
    if (text.includes("UPDATE slot_spins") && text.includes("status='confirmed'")) {
      state.pendingSpinRows = [];
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM slot_rewards") && text.includes("id=$2")) {
      return { rows: state.rewardRows.filter(row => String(row.id) === String(params[1]) && !row.deleted_at) };
    }
    if (text.includes("SELECT * FROM slot_rewards")) {
      const legacyKind = params[1];
      let rows = legacyKind ? state.rewardRows.filter(row => row.kind !== legacyKind) : state.rewardRows;
      if (text.includes("deleted_at IS NULL")) rows = rows.filter(row => !row.deleted_at);
      return { rows };
    }
    if (text.includes("INSERT INTO slot_rewards")) {
      const hasDuration = text.includes("duration_minutes");
      const row = {
        id: state.rewardRows.length + 1,
        workspace_id: params[0],
        title: params[1],
        kind: params[2],
        sponsor_type: params[3],
        sponsor_splits: JSON.parse(params[4] || "[]"),
        weight: params[5],
        chance_shares: params[6],
        payment_source: params[7],
        tier_id: params[8],
        active: params[9],
        sponsor_active: params[10],
        value_cents: params[11],
        bank_delta_cents: params[12],
        duration_minutes: hasDuration ? params[13] : 0,
        requires_confirmation: hasDuration ? params[14] : params[13],
        cooldown_days: hasDuration ? params[15] : params[14],
        unlock_threshold_cents: hasDuration ? params[16] : params[15],
        notes: hasDuration ? params[17] : params[16],
      };
      state.rewardRows.push(row);
      return { rows: [row] };
    }
    if (text.includes("INSERT INTO slot_spins")) {
      const normalSpin = params.length >= 8;
      const row = normalSpin
        ? {
          id: state.spinRows.length + 1,
          workspace_id: params[0],
          user_id: params[1],
          cost_credits: params[2],
          reward_id: params[3],
          reward_snapshot: params[4],
          status: params[5],
          bank_delta_cents: params[6],
          bank_reserved_cents: params[7],
          created_at: "now",
          confirmed_at: params[5] === "confirmed" ? "now" : null,
        }
        : {
          id: state.spinRows.length + 1,
          workspace_id: params[0],
          user_id: params[1],
          cost_credits: 0,
          reward_id: params[2],
          reward_snapshot: params[3],
          status: "confirmed",
          bank_delta_cents: 0,
          bank_reserved_cents: params[4],
          created_at: "now",
          confirmed_at: "now",
        };
      state.spinRows.unshift(row);
      return { rows: [row] };
    }
    if (text.includes("UPDATE slot_rewards SET last_won_at=NOW()")) {
      state.rewardRows = state.rewardRows.map(row => String(row.id) === String(params[0]) ? { ...row, last_won_at: "now" } : row);
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM slot_spins")) return { rows: state.spinRows };
    throw new Error("Unexpected query: " + text.slice(0, 120));
  }

  return { query, connect: async () => ({ query, release() {} }), calls, state };
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

test("earnTaskCredit applies point tag tiers from slot settings", async () => {
  const settings = {
    points_v2_migrated_at: "already",
    points_v2_spin_cost_migrated_at: "already",
    points_v3_migrated_at: "already",
    points_v3_spin_cost_migrated_at: "already",
    point_tag_tiers: {
      maintenance: ["chores"],
      advancement: ["career"],
      light: ["email"],
      none: ["off"],
    },
  };
  const mockPool = createMockPool({
    pointBalance: 0,
    migrated: true,
    settings,
  });
  const store = loadStoreWithMock(mockPool);

  const maintenance = await store.earnTaskCredit("ws-1", 1, {
    source_key: "maintenance-task",
    task_id: "maintenance-task",
    type: "task",
    duration_minutes: 60,
    tags: ["chores"],
  });
  const meetingPool = createMockPool({ pointBalance: 0, migrated: true, settings });
  const meetingStore = loadStoreWithMock(meetingPool);
  const meeting = await meetingStore.earnTaskCredit("ws-1", 1, {
    source_key: "meeting-task",
    task_id: "meeting-task",
    type: "meeting",
    duration_minutes: 60,
    tags: ["chores"],
  });
  const oooPool = createMockPool({ pointBalance: 0, migrated: true, settings });
  const oooStore = loadStoreWithMock(oooPool);
  const ooo = await oooStore.earnTaskCredit("ws-1", 1, {
    source_key: "ooo-task",
    task_id: "ooo-task",
    type: "ooo",
    duration_minutes: 60,
    tags: ["career"],
  });

  assert.equal(maintenance.delta, 30);
  assert.equal(meeting.delta, 30);
  assert.equal(ooo.awarded, false);
  assert.equal(ooo.delta, 0);
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

test("createReward stores optional duration minutes", async () => {
  const mockPool = createMockPool({ migrated: true });
  const store = loadStoreWithMock(mockPool);

  const reward = await store.createReward("ws-1", {
    title: "Movie break",
    kind: "free",
    payment_source: "free",
    duration_minutes: 95,
    chance_shares: 4,
  });

  assert.equal(reward.duration_minutes, 95);
  assert.equal(mockPool.state.rewardRows[0].duration_minutes, 95);
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

test("getState excludes self-funded paid rewards during bankroll goal mode", async () => {
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
    bankBalance: 10000,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      bankroll_goal: { enabled: true, reward_id: 10, target_cents: 7500 },
    },
    rewardRows: [
      { ...rewardBase, id: 10, title: "Dinner jackpot", kind: "bank_gated", payment_source: "self", value_cents: 7500, unlock_threshold_cents: 7500, active: true, weight: 8 },
      { ...rewardBase, id: 11, title: "Partner reward", kind: "sponsor", payment_source: "sponsored", active: true, weight: 5 },
      { ...rewardBase, id: 12, title: "Free rest", kind: "free", payment_source: "free", active: true, weight: 6 },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);
  const selfReward = state.rewards.find(r => r.id === 10);
  const sponsorReward = state.rewards.find(r => r.id === 11);
  const freeReward = state.rewards.find(r => r.id === 12);

  assert.equal(state.constants.bankrollGoalModeEnabled, true);
  assert.equal(selfReward.active, true);
  assert.equal(selfReward.weight, 8);
  assert.equal(selfReward.eligible, false);
  assert.equal(selfReward.bankroll_goal_excluded, true);
  assert.equal(selfReward.locked_reason, "bankroll_goal");
  assert.equal(sponsorReward.eligible, true);
  assert.equal(freeReward.eligible, true);
});

test("bankroll goal state counts pending bank deposits toward funding", async () => {
  const mockPool = createMockPool({
    bankBalance: 1200,
    pendingBankDeposit: { cents: 6300, count: 2, oldest_at: "soon" },
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      bankroll_goal: { enabled: true, reward_id: 10, target_cents: 7500 },
    },
    rewardRows: [
      {
        id: 10,
        title: "Big headphones",
        kind: "bank_gated",
        payment_source: "self",
        sponsor_type: "self",
        sponsor_splits: [],
        sponsor_active: true,
        value_cents: 7500,
        bank_delta_cents: 0,
        requires_confirmation: false,
        cooldown_days: 0,
        unlock_threshold_cents: 7500,
        notes: "",
        last_won_at: null,
        deleted_at: null,
        active: true,
        weight: 4,
      },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const state = await store.getState("ws-1", 1);

  assert.equal(state.bankrollGoal.enabled, true);
  assert.equal(state.bankrollGoal.total_cents, 7500);
  assert.equal(state.bankrollGoal.ready_cents, 1200);
  assert.equal(state.bankrollGoal.pending_cents, 6300);
  assert.equal(state.bankrollGoal.funded, true);
  assert.equal(state.bankrollGoal.claimable, true);
  assert.equal(state.bankrollGoal.progress_percent, 100);
});

test("celebrationSpinForBankrollGoal forces a free confirmed jackpot and cannot run twice", async () => {
  const mockPool = createMockPool({
    bankBalance: 7500,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      bankroll_goal: { enabled: true, reward_id: 10, target_cents: 7500 },
    },
    rewardRows: [
      {
        id: 10,
        title: "Big headphones",
        kind: "bank_gated",
        payment_source: "self",
        tier_id: "tier_i",
        sponsor_type: "self",
        sponsor_splits: [],
        sponsor_active: true,
        value_cents: 7500,
        bank_delta_cents: 0,
        requires_confirmation: false,
        cooldown_days: 0,
        unlock_threshold_cents: 7500,
        notes: "",
        last_won_at: null,
        deleted_at: null,
        active: true,
        weight: 4,
      },
    ],
  });
  const store = loadStoreWithMock(mockPool);

  const spin = await store.celebrationSpinForBankrollGoal("ws-1", 1);

  assert.equal(spin.cost_credits, 0);
  assert.equal(spin.status, "confirmed");
  assert.equal(spin.bank_reserved_cents, 7500);
  assert.equal(spin.reward_snapshot.source_type, "bankroll_goal_celebration");
  assert.equal(spin.reward_snapshot.slot_stages.jackpot_hit, true);
  assert.equal(spin.reward_snapshot.bankroll_goal_celebration, true);
  assert.equal(mockPool.state.bankBalance, 0);
  assert.ok(mockPool.state.settings.bankroll_goal.celebration_spin_claimed_at);

  await assert.rejects(
    () => store.celebrationSpinForBankrollGoal("ws-1", 1),
    /already claimed/
  );
});

test("selectThreeStageOutcome returns a miss when jackpot and bank builder rolls miss", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], { jackpot_hit_rate: 0, bank_builder_hit_rate: 0, free_spin_tile_rate: 0 }, () => 0);

  assert.equal(outcome.outcome, "miss");
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.bank_builder_hit, false);
  assert.equal(outcome.selected.kind, "miss");
  assert.equal(outcome.reroll_credit, false);
});

test("selectThreeStageOutcome can hit bank builder outside jackpot", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], { jackpot_hit_rate: 0, bank_builder_hit_rate: 1, free_spin_tile_rate: 0 }, () => 0);

  assert.equal(outcome.outcome, "bank");
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.bank_builder_hit, true);
  assert.equal(outcome.selected.kind, "bank_builder");
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
    bank_builder_hit_rate: 0,
    free_spin_tile_rate: 0,
    payment_source_weights: { self: 0, sponsored: 0, free: 1 },
    reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
  }, rng);

  assert.equal(outcome.jackpot_hit, true);
  assert.equal(outcome.source.id, "free");
  assert.equal(outcome.tier.id, "tier_i");
  assert.equal(outcome.selected.id, 2);
  assert.equal(outcome.empty_bucket, false);
});

test("selectThreeStageOutcome can bank-build before a jackpot on the same full spin", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([
    { id: 1, title: "Reward", kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 1 },
  ], {
    jackpot_hit_rate: 1,
    bank_builder_hit_rate: 1,
    free_spin_tile_rate: 0,
    payment_source_weights: { self: 0, sponsored: 0, free: 1 },
    reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
  }, () => 0);

  assert.equal(outcome.bank_builder_hit, true);
  assert.equal(outcome.jackpot_hit, true);
  assert.equal(outcome.selected.id, 1);
});

test("default reward tier percentages add up to 100", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = store._test.normalizeSlotSettings({});
  const total = settings.reward_tiers
    .filter(tier => tier.active !== false)
    .reduce((sum, tier) => sum + tier.weight, 0);

  assert.equal(total, 100);
});

test("guided economy profile derives hidden spin cost, bankroll pacing, and rare jackpot defaults", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = store._test.normalizeSlotSettings({
    economy_profile: {
      maintenance_hours_per_day: 4,
      advancement_hours_per_day: 5,
      monthly_discretionary_cents: 30000,
    },
  });

  assert.equal(settings.spin_cost, 15);
  assert.equal(settings.monthly_goal_cents, 30000);
  assert.equal(settings.economy_profile.target_daily_spins, 28);
  assert.equal(settings.jackpot_hit_rate, 0.04);
  assert.equal(settings.bank_builder_hit_rate, 0.9);
  assert.equal(settings.free_spin_tile_rate, 0.08);
  assert.equal(settings.bankroll_pacing.bank_builder_base_percent, 0.00031);
});

test("taskPointTier uses the highest earning matched tag and keeps OOO at zero", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = {
    point_tag_tiers: {
      maintenance: ["chores"],
      advancement: ["workout"],
      light: ["email"],
      none: ["scrolling"],
    },
  };

  assert.deepEqual(store._test.taskPointTier({ tags: ["chores"] }, settings).multiplier, 0.5);
  assert.deepEqual(store._test.taskPointTier({ tags: ["scrolling", "workout"] }, settings).multiplier, 1);
  assert.deepEqual(store._test.taskPointTier({ type: "meeting", tags: ["chores"] }, settings).multiplier, 0.5);
  assert.deepEqual(store._test.taskPointTier({ type: "ooo", tags: ["workout"] }, settings).multiplier, 0);
});

test("selectThreeStageOutcome offers separate die choices when first source-tier bucket is empty", () => {
  const store = loadStoreWithMock(createMockPool());
  const rolls = [0, 0, 0, 0, 0, 0, 0];
  const rng = max => Math.min(max - 1, rolls.shift() || 0);
  const outcome = store._test.selectThreeStageOutcome([
    { id: 1, title: "Same source new tier", kind: "free", active: true, eligible: true, payment_source: "sponsored", tier_id: "tier_ii", chance_shares: 3 },
    { id: 2, title: "Same tier new source", kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 5 },
  ], {
    jackpot_hit_rate: 1,
    payment_source_weights: { self: 0, sponsored: 1, free: 1 },
    reward_tiers: [
      { id: "tier_i", label: "Tier I", weight: 1, active: true },
      { id: "tier_ii", label: "Tier II", weight: 1, active: true },
    ],
  }, rng);

  assert.equal(outcome.jackpot_hit, true);
  assert.equal(outcome.empty_bucket, false);
  assert.equal(outcome.reroll_credit, false);
  assert.equal(outcome.selected.id, 2);
  assert.equal(outcome.dice_reroll.reason, "empty_bucket");
  assert.equal(outcome.dice_reroll.from.payment_source.id, "sponsored");
  assert.equal(outcome.dice_reroll.from.tier.id, "tier_i");
  assert.equal(outcome.dice_reroll.choices.source.reward.id, 2);
  assert.equal(outcome.dice_reroll.choices.source.payment_source.id, "free");
  assert.equal(outcome.dice_reroll.choices.source.tier.id, "tier_i");
  assert.equal(outcome.dice_reroll.choices.tier.reward.id, 1);
  assert.equal(outcome.dice_reroll.choices.tier.payment_source.id, "sponsored");
  assert.equal(outcome.dice_reroll.choices.tier.tier.id, "tier_ii");
});

test("bank screen payout values each BANK tile from the monthly goal, not current bank balance", () => {
  const store = loadStoreWithMock(createMockPool());
  const board = Array.from({ length: 15 }, () => "MISS");
  board[0] = "BANK";
  board[4] = "BANK";
  const payout = store._test.calculateScreenBankPayout(
    board,
    { bank_balance_cents: 0, settings: { monthly_goal_cents: 10000 } },
    { today: 0, week: 0, monthlyGoal: 10000 }
  );

  assert.equal(payout.percent, 0.00031);
  assert.equal(payout.goal_cents, 10000);
  assert.equal(payout.base_cents, 3);
  assert.equal(payout.base_units, 2);
  assert.equal(payout.cents, 6);
});

test("normalizeNextSpinTileOverride requires exactly fifteen known symbols", () => {
  const store = loadStoreWithMock(createMockPool());
  const override = store._test.normalizeNextSpinTileOverride({
    tiles: [
      "miss", "bank", "jackpot", "M", "B",
      "JP", "MISS", "BANK", "JACK", "MISS",
      "MISS", "MISS", "MISS", "MISS", "MISS",
    ],
  }, "user-1");

  assert.equal(override.tiles.length, 15);
  assert.deepEqual(override.tiles.slice(0, 6), ["MISS", "BANK", "JACKPOT", "MISS", "BANK", "JACKPOT"]);
  assert.equal(override.created_by, "user-1");
  assert.throws(
    () => store._test.normalizeNextSpinTileOverride({ tiles: ["MISS"] }),
    /exactly 15/
  );
  assert.throws(
    () => store._test.normalizeNextSpinTileOverride({ tiles: Array.from({ length: 15 }, () => "WILD") }),
    /MISS, BANK, JACKPOT, or SPIN/
  );
});

test("normalizeSlotSettings keeps bonus jackpot spin credits separate from rerolls", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = store._test.normalizeSlotSettings({
    reroll_credits: 2,
    jackpot_spin_credits: 3,
  });

  assert.equal(settings.reroll_credits, 2);
  assert.equal(settings.jackpot_spin_credits, 3);
});

test("evaluateJackpotBoard only counts connected horizontal or vertical jackpot runs", () => {
  const store = loadStoreWithMock(createMockPool());
  const scattered = [
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "BANK", "MISS", "JACKPOT", "MISS", "MISS",
  ];
  const diagonal = Array.from({ length: 15 }, () => "MISS");
  diagonal[0] = "JACKPOT";
  diagonal[6] = "JACKPOT";
  diagonal[12] = "JACKPOT";

  assert.equal(store._test.evaluateJackpotBoard(scattered).hit, false);
  assert.equal(store._test.evaluateJackpotBoard(diagonal).hit, false);

  const vertical = Array.from({ length: 15 }, () => "MISS");
  vertical[3] = "JACKPOT";
  vertical[8] = "JACKPOT";
  vertical[13] = "JACKPOT";
  assert.deepEqual(store._test.evaluateJackpotBoard(vertical), {
    hit: true,
    level: 1,
    spins: 1,
    payline: [3, 8, 13],
    orientation: "vertical",
  });

  const fourHorizontal = Array.from({ length: 15 }, () => "MISS");
  [5, 6, 7, 8].forEach(i => { fourHorizontal[i] = "JACKPOT"; });
  assert.deepEqual(store._test.evaluateJackpotBoard(fourHorizontal), {
    hit: true,
    level: 2,
    spins: 2,
    payline: [5, 6, 7, 8],
    orientation: "horizontal",
  });

  const fiveHorizontal = Array.from({ length: 15 }, () => "MISS");
  [10, 11, 12, 13, 14].forEach(i => { fiveHorizontal[i] = "JACKPOT"; });
  assert.deepEqual(store._test.evaluateJackpotBoard(fiveHorizontal), {
    hit: true,
    level: 3,
    spins: 3,
    payline: [10, 11, 12, 13, 14],
    orientation: "horizontal",
  });
});

test("applyTileOverrideToScreen does not turn scattered jackpots into a payline", () => {
  const store = loadStoreWithMock(createMockPool());
  const board = [
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "BANK", "MISS", "JACKPOT", "MISS", "MISS",
  ];
  const screen = store._test.applyTileOverrideToScreen(
    { board: Array.from({ length: 15 }, () => "MISS"), payline: [], payout: {} },
    { tiles: board, created_at: "now" },
    { kind: "free" },
    { settings: { monthly_goal_cents: 10000 } },
    { today: 0, week: 0, monthlyGoal: 10000 },
    false
  );

  assert.deepEqual(screen.payline, []);
  assert.equal(screen.jackpot.hit, false);
});

test("applyTileOverrideToScreen keeps exact tiles and pays bank from override on bank-builder spins", () => {
  const store = loadStoreWithMock(createMockPool());
  const board = Array.from({ length: 15 }, () => "MISS");
  board[1] = "BANK";
  board[2] = "BANK";
  board[7] = "BANK";
  const screen = store._test.applyTileOverrideToScreen(
    { board: Array.from({ length: 15 }, () => "MISS"), payline: [], payout: {} },
    { tiles: board, created_at: "now" },
    { kind: "bank_builder" },
    { settings: { monthly_goal_cents: 10000 } },
    { today: 0, week: 0, monthlyGoal: 10000 },
    true
  );

  assert.deepEqual(screen.board, board);
  assert.deepEqual(screen.payout.positions, [1, 2, 7]);
  assert.equal(screen.payout.base_units, 3);
  assert.equal(screen.payout.horizontal_bonus_units, 2);
  assert.equal(screen.payout.vertical_bonus_units, 2);
  assert.equal(screen.payout.cents, 21);
});

test("spin downgrades a jackpot outcome when override tiles have no jackpot payline", async () => {
  const scattered = [
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "MISS", "BANK", "MISS", "JACKPOT", "MISS",
    "BANK", "MISS", "JACKPOT", "MISS", "MISS",
  ];
  const mockPool = createMockPool({
    pointBalance: 100,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      jackpot_hit_rate: 1,
      bank_builder_hit_rate: 0,
      payment_source_weights: { self: 0, sponsored: 0, free: 1 },
      reward_tiers: [{ id: "tier_i", label: "Tier 1", weight: 1, active: true }],
      next_spin_tile_override: { tiles: scattered, created_at: "now" },
    },
    rewardRows: [{
      id: 21,
      title: "Free movie",
      kind: "free",
      payment_source: "free",
      tier_id: "tier_i",
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
      active: true,
      weight: 8,
      chance_shares: 8,
    }],
  });
  const store = loadStoreWithMock(mockPool);

  const spin = await store.spin("ws-1", 1);
  const snap = spin.reward_snapshot;

  assert.equal(spin.status, "miss");
  assert.equal(snap.kind, "miss");
  assert.equal(snap.slot_stages.jackpot_hit, false);
  assert.deepEqual(snap.screen_board, scattered);
  assert.deepEqual(snap.screen_payline, []);
});

test("spin stores authoritative bank board, payout positions, and pending reserve delta", async () => {
  const board = Array.from({ length: 15 }, () => "MISS");
  board[1] = "BANK";
  board[2] = "BANK";
  board[7] = "BANK";
  const mockPool = createMockPool({
    pointBalance: 100,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      jackpot_hit_rate: 0,
      bank_builder_hit_rate: 1,
      monthly_goal_cents: 10000,
      next_spin_tile_override: { tiles: board, created_at: "now" },
    },
  });
  const store = loadStoreWithMock(mockPool);

  const spin = await store.spin("ws-1", 1);
  const snap = spin.reward_snapshot;

  assert.equal(spin.status, "pending");
  assert.equal(snap.kind, "bank_builder");
  assert.equal(snap.source_type, "slot_screen_bank_builder");
  assert.equal(snap.slot_stages.bank_builder_hit, true);
  assert.equal(snap.slot_stages.jackpot_hit, false);
  assert.deepEqual(snap.screen_board, board);
  assert.deepEqual(snap.bank_screen_payout.positions, [1, 2, 7]);
  assert.equal(snap.bank_screen_payout.cents, spin.bank_delta_cents);
  assert.equal(spin.bank_delta_cents, 21);
});

test("spin stores jackpot payline metadata when override tiles form a valid jackpot", async () => {
  const board = Array.from({ length: 15 }, () => "MISS");
  [3, 8, 13].forEach(index => { board[index] = "JACKPOT"; });
  const mockPool = createMockPool({
    pointBalance: 100,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      jackpot_hit_rate: 1,
      bank_builder_hit_rate: 0,
      payment_source_weights: { self: 0, sponsored: 0, free: 1 },
      reward_tiers: [{ id: "tier_i", label: "Tier 1", weight: 1, active: true }],
      next_spin_tile_override: { tiles: board, created_at: "now" },
    },
    rewardRows: [{
      id: 22,
      title: "Movie night",
      kind: "free",
      payment_source: "free",
      tier_id: "tier_i",
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
      active: true,
      weight: 8,
      chance_shares: 8,
    }],
  });
  const store = loadStoreWithMock(mockPool);

  const spin = await store.spin("ws-1", 1);
  const snap = spin.reward_snapshot;

  assert.equal(spin.status, "awarded");
  assert.equal(snap.kind, "free");
  assert.equal(snap.slot_stages.jackpot_hit, true);
  assert.equal(snap.slot_stages.jackpot_level, 1);
  assert.equal(snap.slot_stages.jackpot_spins, 1);
  assert.equal(snap.slot_stages.jackpot_orientation, "vertical");
  assert.deepEqual(snap.slot_stages.jackpot_payline, [3, 8, 13]);
  assert.deepEqual(snap.screen_board, board);
  assert.deepEqual(snap.screen_payline, [3, 8, 13]);
});

test("buildSpinScreen can pay bank bonus on miss screens because bank resolves first", () => {
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

    assert.equal(screen.board.includes("BANK"), true);
    assert.ok(screen.payout.base_units > 0);
    assert.ok(screen.payout.positions.length > 0);
    assert.ok(screen.payout.cents > 0);
  } finally {
    crypto.randomInt = originalRandomInt;
  }
});
