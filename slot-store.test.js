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

  // A mock account that has opted out of the points migrations (by carrying the
  // points_v3 flag) is treated as already odds-recalibrated too, so a test's
  // explicit jackpot/floor odds aren't overwritten by migrateAccountSlotOdds.
  // Fresh-account tests (migrated: false) leave the flag off so the migration runs.
  if (state.settings.points_v3_migrated_at && !state.settings.slot_odds_par_sheet_migrated_at) {
    state.settings = { ...state.settings, slot_odds_par_sheet_migrated_at: "already" };
  }

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
    if (text.includes("UPDATE slot_spins") && text.includes("reward_snapshot=$3") && text.includes("status=$4")) {
      const idx = state.spinRows.findIndex(r => String(r.id) === String(params[1]));
      if (idx >= 0) state.spinRows[idx] = { ...state.spinRows[idx], reward_snapshot: params[2], status: params[3] };
      return { rows: idx >= 0 ? [state.spinRows[idx]] : [] };
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

test("selectThreeStageOutcome draws a bank builder from the weighted floor", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], {
    jackpot_hit_rate: 0,
    miss_rate: 0,
    floor_weights: { bank: 1, coin: 0, booster: 0, pet: 0, free_spin: 0 },
  }, () => 0);

  assert.equal(outcome.outcome, "bank");
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.bank_builder_hit, true);
  assert.equal(outcome.selected.kind, "bank_builder");
  assert.equal(outcome.reroll_credit, false);
});

test("selectThreeStageOutcome draws coin / booster / pet / free spin from the floor weights", () => {
  const store = loadStoreWithMock(createMockPool());
  const base = { jackpot_hit_rate: 0, miss_rate: 0 };
  const only = kind => ({ ...base, floor_weights: { bank: 0, coin: 0, booster: 0, pet: 0, free_spin: 0, [kind]: 1 } });

  assert.equal(store._test.selectThreeStageOutcome([], only("coin"), () => 0).outcome, "coin");
  assert.equal(store._test.selectThreeStageOutcome([], only("booster"), () => 0).outcome, "booster");
  assert.equal(store._test.selectThreeStageOutcome([], only("free_spin"), () => 0).outcome, "free_spin");
  // The "pet" bucket covers pet delight and collectible gems.
  const petKind = store._test.selectThreeStageOutcome([], only("pet"), () => 0).outcome;
  assert.ok(["pet", "collectible"].includes(petKind));
});

test("a bank_multiplier booster grants a collectible charge instead of gambling", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], {
    jackpot_hit_rate: 0,
    miss_rate: 0,
    floor_weights: { bank: 0, coin: 0, booster: 1, pet: 0, free_spin: 0 },
  }, () => 0); // rng 0 -> bank_multiplier type, 2x charge

  assert.equal(outcome.outcome, "booster");
  assert.equal(outcome.selected.kind, "booster");
  assert.equal(outcome.gamble, undefined);
  assert.deepEqual(outcome.multiplier_charge, { tier: 2 });
});

test("selectThreeStageOutcome pays a bank builder instead of a flat miss when the miss roll misses", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], { jackpot_hit_rate: 0, bank_builder_hit_rate: 0, free_spin_tile_rate: 0, miss_rate: 0 }, () => 0);

  assert.equal(outcome.outcome, "bank");
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.bank_builder_hit, true);
  assert.equal(outcome.selected.kind, "bank_builder");
  assert.equal(outcome.reroll_credit, false);
});

test("selectThreeStageOutcome turns an unfillable jackpot into a bank-builder consolation, not a miss", () => {
  const store = loadStoreWithMock(createMockPool());
  const outcome = store._test.selectThreeStageOutcome([], { jackpot_hit_rate: 1, bank_builder_hit_rate: 0, free_spin_tile_rate: 0 }, () => 0);

  assert.equal(outcome.outcome, "bank");
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.bank_builder_hit, true);
  assert.equal(outcome.empty_bucket, true);
  assert.equal(outcome.selected.kind, "bank_builder");
});

test("selectThreeStageOutcome realized distribution matches the PAR sheet (Monte Carlo)", () => {
  const store = loadStoreWithMock(createMockPool());
  const { SLOT_PAR_SHEET } = store._test;

  // Seeded PRNG so this statistical check is reproducible run to run. mulberry32
  // gives a float in [0,1); the adapter returns an int in [0, max) to match the
  // crypto.randomInt(max) contract the engine expects.
  let a = 0x9e3779b9 >>> 0;
  const prng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = max => Math.floor(prng() * max);

  // A jackpot only registers when a reward bucket is fillable, so collapse the
  // draw to a single source + tier holding one eligible reward. The jackpot /
  // miss rates and floor weights are left at their tuned defaults - those are
  // exactly what this test certifies.
  const settings = {
    payment_source_weights: { self: 0, sponsored: 0, free: 1 },
    reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
  };
  const rewards = [
    { id: 1, title: "Jackpot prize", kind: "small_paid", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 1, value_cents: 500 },
  ];

  const N = 100000;
  const counts = {};
  for (let i = 0; i < N; i++) {
    const out = store._test.selectThreeStageOutcome(rewards, settings, rng).outcome;
    // The "pet" floor bucket also yields collectible gems; the PAR sheet folds
    // the two together under "pet".
    const key = out === "collectible" ? "pet" : out;
    counts[key] = (counts[key] || 0) + 1;
  }

  // +-1.5 percentage points. At N=100k the worst-case standard error is ~0.16%,
  // so this is a ~9x margin: tight enough to catch a miscalibration, loose
  // enough never to flake.
  const tolerance = 0.015;
  for (const [kind, target] of Object.entries(SLOT_PAR_SHEET)) {
    const actual = (counts[kind] || 0) / N;
    assert.ok(
      Math.abs(actual - target) <= tolerance,
      `${kind}: realized ${(actual * 100).toFixed(2)}% vs PAR ${(target * 100).toFixed(2)}% (tolerance +-${tolerance * 100}pts)`
    );
  }
  // Bank must be the clear bread-and-butter: more common than every other
  // outcome combined, and far more common than boosters or jackpots.
  assert.ok(counts.bank > N / 2, `bank should dominate (>50%), got ${counts.bank}/${N}`);
  assert.ok(counts.bank > 7 * (counts.booster || 0), "bank should be ~7x+ more common than boosters");
  assert.ok(counts.bank > 40 * (counts.jackpot || 0), "bank should be far more common than jackpots");
  // No outcome should appear that the PAR sheet does not account for.
  for (const kind of Object.keys(counts)) {
    assert.ok(kind in SLOT_PAR_SHEET, `unexpected outcome kind: ${kind}`);
  }
});

test("rollJackpotSpins maps each climb to a longer run and never draws at a 0 rate", () => {
  const store = loadStoreWithMock(createMockPool());
  const { rollJackpotSpins } = store._test;
  const settings = {}; // default jackpot_upgrade_rate = 0.1, threshold = 100000

  // No climb on either roll -> 3-in-a-row (1 spin).
  assert.equal(rollJackpotSpins(settings, () => 999999), 1);
  // Climb once then stop -> 4-in-a-row (2 spins).
  const twoRolls = [0, 999999];
  assert.equal(rollJackpotSpins(settings, () => twoRolls.shift()), 2);
  // Climb both times -> 5-in-a-row (3 spins).
  assert.equal(rollJackpotSpins(settings, () => 0), 3);
  // A 0 upgrade rate (credit-funded spins use this) is always a single spin and
  // must not consume an rng draw, or it would desync the rest of the spin's rolls.
  assert.equal(
    rollJackpotSpins({ jackpot_upgrade_rate: 0 }, () => { throw new Error("should not draw"); }),
    1
  );
});

test("jackpot run length realizes ~1/100, 1/1000, 1/10000 across the tiers", () => {
  const store = loadStoreWithMock(createMockPool());
  const { rollJackpotSpins } = store._test;

  // Seeded PRNG (mulberry32) so this statistical check is reproducible.
  let a = 0x12345678 >>> 0;
  const prng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = max => Math.floor(prng() * max);

  // Default upgrade rate 0.1, so conditional on a jackpot: 1 spin ~90%, 2 spins
  // ~9%, 3 spins ~1%. Paired with the tuned 1/100 jackpot rate that is exactly
  // the requested 1/100 (3-in-a-row), 1/1000 (4-in-a-row), 1/10000 (5-in-a-row).
  const N = 500000;
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < N; i++) counts[rollJackpotSpins({}, rng)] += 1;

  assert.ok(Math.abs(counts[1] / N - 0.90) <= 0.01, `1 spin: ${(counts[1] / N * 100).toFixed(2)}% vs 90%`);
  assert.ok(Math.abs(counts[2] / N - 0.09) <= 0.01, `2 spins: ${(counts[2] / N * 100).toFixed(2)}% vs 9%`);
  assert.ok(Math.abs(counts[3] / N - 0.01) <= 0.004, `3 spins: ${(counts[3] / N * 100).toFixed(2)}% vs 1%`);
  // Each tier must be roughly a decade rarer than the one below it.
  assert.ok(counts[1] > 5 * counts[2], "3-in-a-row should be far more common than 4-in-a-row");
  assert.ok(counts[2] > 5 * counts[3], "4-in-a-row should be far more common than 5-in-a-row");
});

test("buildSpinScreen lays a jackpot run matching the rolled tier", () => {
  const store = loadStoreWithMock(createMockPool());
  const acct = { settings: { monthly_goal_cents: 10000 } };
  const usage = { today: 0, week: 0, monthlyGoal: 10000 };
  for (const spins of [1, 2, 3]) {
    for (let n = 0; n < 100; n++) {
      const screen = store._test.buildSpinScreen({ kind: "free" }, acct, usage, false, spins);
      const jp = store._test.evaluateJackpotBoard(screen.board);
      assert.equal(jp.spins, spins, `tier ${spins} should pay ${spins} spins`);
      assert.equal(jp.payline.length, spins + 2, `tier ${spins} run should be ${spins + 2} long`);
      assert.equal(screen.board.includes("MISS"), false);
    }
  }
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

test("guided economy profile derives goal, bankroll pacing, and rare jackpot defaults", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = store._test.normalizeSlotSettings({
    economy_profile: {
      monthly_discretionary_cents: 30000,
    },
  });

  // spin_cost is a cold-start placeholder; the live cost is learned from the
  // user's points-per-day history (see learnedSpinCost), not derived here.
  assert.equal(settings.spin_cost, 25);
  assert.equal(settings.monthly_goal_cents, 30000);
  assert.equal(settings.economy_profile.target_daily_spins, 28);
  assert.equal(settings.jackpot_hit_rate, 0.01);
  assert.equal(settings.bank_builder_hit_rate, 0.9);
  assert.equal(settings.free_spin_tile_rate, 0.12);
  assert.equal(settings.miss_rate, 0.01);
  assert.equal(settings.bankroll_pacing.bank_builder_base_percent, 0.0012);
});

test("taskPointTier uses the highest earning matched tag and keeps OOO at zero", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = {
    point_tag_tiers: {
      half: ["chores"],
      full: ["workout"],
      quarter: ["email"],
      none: ["scrolling"],
    },
  };

  assert.deepEqual(store._test.taskPointTier({ tags: ["chores"] }, settings).multiplier, 0.5);
  assert.deepEqual(store._test.taskPointTier({ tags: ["email"] }, settings).multiplier, 0.25);
  assert.deepEqual(store._test.taskPointTier({ tags: ["scrolling", "workout"] }, settings).multiplier, 1);
  // An unsorted tag (in no bucket) defaults to full points.
  assert.deepEqual(store._test.taskPointTier({ tags: ["unsorted-tag"] }, settings).multiplier, 1);
  assert.deepEqual(store._test.taskPointTier({ type: "meeting", tags: ["chores"] }, settings).multiplier, 0.5);
  assert.deepEqual(store._test.taskPointTier({ type: "ooo", tags: ["workout"] }, settings).multiplier, 0);
});

test("normalizePointTagTiers folds retired lane names onto point buckets", () => {
  const store = loadStoreWithMock(createMockPool());
  const normalized = store._test.normalizePointTagTiers({
    advancement: ["career"],
    maintenance: ["chores"],
    light: ["email"],
    none: ["scrolling"],
  });

  assert.deepEqual(normalized.full, ["career"]);
  assert.deepEqual(normalized.half, ["chores"]);
  assert.deepEqual(normalized.quarter, ["email"]);
  assert.deepEqual(normalized.none, ["scrolling"]);
  // A tag lives in exactly one bucket even if it appears under two names.
  const deduped = store._test.normalizePointTagTiers({ full: ["x"], advancement: ["x"] });
  assert.deepEqual(deduped.full, ["x"]);
});

test("spinCostForDailyPoints prices ~20 spins/day with 10% leniency, defaults under MIN_DAYS, and clamps", () => {
  const store = loadStoreWithMock(createMockPool());
  // Fewer than 3 days of history → cold-start default (25).
  assert.equal(store._test.spinCostForDailyPoints(1000, 2), 25);
  // 400 pts/day → 400 * 0.9 / 20 = 18 → rounds to 20.
  assert.equal(store._test.spinCostForDailyPoints(400, 7), 20);
  // 2000 pts/day → 90 → rounds to 90.
  assert.equal(store._test.spinCostForDailyPoints(2000, 14), 90);
  // Tiny average clamps up to the 5-point floor; huge average clamps to 250.
  assert.equal(store._test.spinCostForDailyPoints(10, 5), 5);
  assert.equal(store._test.spinCostForDailyPoints(1000000, 14), 250);
});

test("selectThreeStageOutcome resolves a fallback reward and flags an awaiting dice re-roll when the first bucket is empty", () => {
  const store = loadStoreWithMock(createMockPool());
  const rolls = [0, 0, 0, 0, 0, 0, 0];
  const rng = max => Math.min(max - 1, rolls.shift() || 0);
  const outcome = store._test.selectThreeStageOutcome([
    { id: 1, title: "Sponsored Tier II", kind: "free", active: true, eligible: true, payment_source: "sponsored", tier_id: "tier_ii", chance_shares: 3 },
    { id: 2, title: "Free Tier I", kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 5 },
  ], {
    jackpot_hit_rate: 1,
    payment_source_weights: { self: 0, sponsored: 1, free: 1 },
    reward_tiers: [
      { id: "tier_i", label: "Tier I", weight: 1, active: true },
      { id: "tier_ii", label: "Tier II", weight: 1, active: true },
    ],
  }, rng);

  assert.equal(outcome.jackpot_hit, true);
  // The spin lands a guaranteed-winnable fallback (sponsored/Tier II) but the
  // empty first roll (sponsored/Tier I) is flagged so the player can re-roll.
  assert.equal(outcome.empty_bucket, false);
  assert.equal(outcome.selected.id, 1);
  assert.equal(outcome.source.id, "sponsored");
  assert.equal(outcome.tier.id, "tier_ii");
  assert.equal(outcome.dice_reroll.reason, "empty_bucket");
  assert.equal(outcome.dice_reroll.awaiting, true);
  assert.equal(outcome.dice_reroll.from.payment_source.id, "sponsored");
  assert.equal(outcome.dice_reroll.from.tier.id, "tier_i");
  // No precomputed per-die choices any more - the re-roll is genuine.
  assert.equal(outcome.dice_reroll.choices, undefined);
});

test("selectThreeStageOutcome pays a bank consolation when no bucket is winnable", () => {
  const store = loadStoreWithMock(createMockPool());
  const rng = () => 0;
  const outcome = store._test.selectThreeStageOutcome([], {
    jackpot_hit_rate: 1,
    payment_source_weights: { self: 1, sponsored: 0, free: 0 },
    reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
  }, rng);

  assert.equal(outcome.empty_bucket, true);
  assert.equal(outcome.jackpot_hit, false);
  assert.equal(outcome.dice_reroll, null);
});

test("rollDieReroll re-rolls one die, holds the other, and reports the landed bucket", () => {
  const store = loadStoreWithMock(createMockPool());
  const rewards = [
    { id: 1, kind: "free", active: true, eligible: true, payment_source: "sponsored", tier_id: "tier_ii", chance_shares: 3 },
    { id: 2, kind: "free", active: true, eligible: true, payment_source: "free", tier_id: "tier_i", chance_shares: 5 },
  ];
  const settings = {
    payment_source_weights: { self: 0, sponsored: 1, free: 1 },
    reward_tiers: [
      { id: "tier_i", label: "Tier I", weight: 1, active: true },
      { id: "tier_ii", label: "Tier II", weight: 1, active: true },
    ],
  };
  const from = {
    payment_source: { id: "sponsored", label: "Sponsored", weight: 1 },
    tier: { id: "tier_i", label: "Tier I", weight: 1 },
  };

  // Re-roll the paid-by die onto "free" (same tier) -> finds reward 2.
  const srcRoll = store._test.rollDieReroll(rewards, settings, from, "source", () => 1);
  assert.equal(srcRoll.source.id, "free");
  assert.equal(srcRoll.tier.id, "tier_i");
  assert.deepEqual(srcRoll.bucket.map(r => r.id), [2]);

  // Re-roll the tier die onto Tier II (same payer) -> finds reward 1.
  const tierRoll = store._test.rollDieReroll(rewards, settings, from, "tier", () => 1);
  assert.equal(tierRoll.source.id, "sponsored");
  assert.equal(tierRoll.tier.id, "tier_ii");
  assert.deepEqual(tierRoll.bucket.map(r => r.id), [1]);

  // A genuine roll can land back on the same empty bucket -> caller re-prompts.
  const emptyRoll = store._test.rollDieReroll(rewards, settings, from, "source", () => 0);
  assert.equal(emptyRoll.source.id, "sponsored");
  assert.equal(emptyRoll.bucket.length, 0);
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

  assert.equal(payout.percent, 0.0012);
  assert.equal(payout.goal_cents, 10000);
  assert.equal(payout.base_cents, 11);
  assert.equal(payout.base_units, 2);
  // 11 * 2 = 22, but the flat floor lifts any hit to at least 50 cents.
  assert.equal(payout.cents, 50);
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
  // base_cents 11 * 7 units = 77 (above the flat floor of 50).
  assert.equal(screen.payout.cents, 77);
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
      miss_rate: 0,
      floor_weights: { bank: 1, coin: 0, booster: 0, pet: 0, free_spin: 0 },
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
  // base_cents 11 * 7 units = 77 (above the flat floor of 50).
  assert.equal(spin.bank_delta_cents, 77);
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

// Longest run (>=1) of each symbol across rows and columns of a 3x5 board.
function maxRunsBySymbol(board){
  const ROWS = 3, COLS = 5, found = {};
  const note = (sym, len) => { found[sym] = Math.max(found[sym] || 0, len); };
  for(let r = 0; r < ROWS; r++){ let run = 1; for(let c = 1; c < COLS; c++){ const i = r*COLS+c; if(board[i] === board[i-1]) run++; else { note(board[i-1], run); run = 1; } } note(board[r*COLS+COLS-1], run); }
  for(let c = 0; c < COLS; c++){ let run = 1; for(let r = 1; r < ROWS; r++){ const i = r*COLS+c; if(board[i] === board[(r-1)*COLS+c]) run++; else { note(board[(r-1)*COLS+c], run); run = 1; } } note(board[(ROWS-1)*COLS+c], run); }
  return found;
}

test("buildSpinScreen fills every tile with a prize icon and forms exactly one winning line", () => {
  const store = loadStoreWithMock(createMockPool());
  const acct = { settings: { monthly_goal_cents: 10000 } };
  const usage = { today: 0, week: 0, monthlyGoal: 10000 };
  const cases = [
    { selected: { kind: "points", source_type: "slot_coin" }, bankHit: false, sym: "COIN" },
    { selected: { kind: "pet", source_type: "slot_pet" }, bankHit: false, sym: "PAW" },
    { selected: { kind: "collectible", source_type: "slot_collectible" }, bankHit: false, sym: "GEM" },
    { selected: { kind: "bank_builder" }, bankHit: true, sym: "BANK" },
  ];
  for(const c of cases){
    for(let n = 0; n < 200; n++){
      const screen = store._test.buildSpinScreen(c.selected, acct, usage, c.bankHit);
      assert.equal(screen.board.includes("MISS"), false, c.sym + " board should have no MISS tiles");
      assert.equal(screen.board.includes(null), false);
      const runs = maxRunsBySymbol(screen.board);
      assert.ok((runs[c.sym] || 0) >= 3, c.sym + " should form a 3-in-a-row line");
      const others = Object.keys(runs).filter(s => s !== c.sym && runs[s] >= 3);
      assert.deepEqual(others, [], "no other symbol should form a line, got " + others.join(","));
    }
  }
});

test("buildSpinScreen miss board shows prize icons but forms no winning line", () => {
  const store = loadStoreWithMock(createMockPool());
  for(let n = 0; n < 200; n++){
    const screen = store._test.buildSpinScreen({ kind: "miss" }, { settings: { monthly_goal_cents: 10000 } }, { today: 0, week: 0, monthlyGoal: 10000 }, false);
    assert.equal(screen.board.includes("MISS"), false);
    const runs = maxRunsBySymbol(screen.board);
    const lines = Object.keys(runs).filter(s => runs[s] >= 3);
    assert.deepEqual(lines, [], "miss board should have no 3-in-a-row, got " + lines.join(","));
    assert.equal(screen.jackpot.hit, false);
  }
});

function gambleSpinPool(boosterType = "wild_hold", ladder = [1, 2, 3, 4]) {
  const gamble = {
    booster_type: boosterType,
    ladder,
    advance_odds: 0.5,
    rung: 0,
    multiplier: ladder[0],
    status: "open",
    history: [],
  };
  return createMockPool({
    spinRows: [{
      id: 7,
      workspace_id: "ws-1",
      status: "gamble",
      bank_delta_cents: 0,
      bank_reserved_cents: 0,
      reward_snapshot: { kind: "booster", slot_stages: { outcome: "booster", gamble } },
    }],
  });
}

function chargesPool(charges, extra = {}) {
  return createMockPool({
    pointBalance: 1000,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already", points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already", points_v3_spin_cost_migrated_at: "already",
      multiplier_charges: charges,
      ...extra,
    },
  });
}

test("combineMultiplierCharges trades two 2x charges for one 5x", async () => {
  const mockPool = chargesPool({ "2": 3 });
  const store = loadStoreWithMock(mockPool);
  const r = await store.combineMultiplierCharges("ws-1", 2);
  assert.equal(r.multiplier_charges["2"], 1);
  assert.equal(r.multiplier_charges["5"], 1);
});

test("combineMultiplierCharges trades two 3x charges for one 10x and refuses when short", async () => {
  const mockPool = chargesPool({ "3": 2 });
  const store = loadStoreWithMock(mockPool);
  const r = await store.combineMultiplierCharges("ws-1", 3);
  assert.equal(r.multiplier_charges["3"], 0);
  assert.equal(r.multiplier_charges["10"], 1);
  await assert.rejects(() => store.combineMultiplierCharges("ws-1", 3), /Need two/);
});

test("setActiveMultiplier arms a stocked tier and refuses an empty one", async () => {
  const mockPool = chargesPool({ "2": 2 });
  const store = loadStoreWithMock(mockPool);
  const armed = await store.setActiveMultiplier("ws-1", 2);
  assert.equal(armed.active_multiplier, 2);
  await assert.rejects(() => store.setActiveMultiplier("ws-1", 10), /No 10x/);
  const off = await store.setActiveMultiplier("ws-1", 0);
  assert.equal(off.active_multiplier, 0);
});

test("an armed multiplier burns a charge every spin and multiplies a bank builder", async () => {
  const board = Array.from({ length: 15 }, () => "MISS");
  board[1] = "BANK"; board[2] = "BANK"; board[7] = "BANK"; // 7 units -> 77 cents base
  const mockPool = chargesPool({ "3": 2 }, {
    jackpot_hit_rate: 0, miss_rate: 0,
    floor_weights: { bank: 1, coin: 0, booster: 0, pet: 0, free_spin: 0 },
    monthly_goal_cents: 10000,
    active_multiplier: 3,
    next_spin_tile_override: { tiles: board, created_at: "now" },
  });
  const store = loadStoreWithMock(mockPool);
  const spin = await store.spin("ws-1", 1);
  assert.equal(spin.bank_delta_cents, 231); // 77 * 3
  assert.equal(spin.reward_snapshot.slot_stages.bank_multiplier_applied, 3);
  assert.equal(mockPool.state.settings.multiplier_charges["3"], 1); // burned one
  assert.equal(mockPool.state.settings.active_multiplier, 3); // still armed, one charge left
});

test("an armed multiplier auto-disarms when its last charge burns", async () => {
  const mockPool = chargesPool({ "2": 1 }, {
    jackpot_hit_rate: 0, miss_rate: 0,
    // a coin spin still burns the charge because the toggle is on
    floor_weights: { bank: 0, coin: 1, booster: 0, pet: 0, free_spin: 0 },
    active_multiplier: 2,
  });
  const store = loadStoreWithMock(mockPool);
  await store.spin("ws-1", 1);
  assert.equal(mockPool.state.settings.multiplier_charges["2"], 0);
  assert.equal(mockPool.state.settings.active_multiplier, 0);
});

test("banking a wild_hold booster grants guaranteed jackpot spins", async () => {
  const mockPool = gambleSpinPool("wild_hold", [1, 2, 3, 4]);
  const store = loadStoreWithMock(mockPool);
  const after = await store.chooseSpinGamble("ws-1", 7, { action: "bank" }, () => 0);
  assert.equal(after.status, "awarded");
  assert.equal(mockPool.state.settings.jackpot_spin_credits, 1);
});

test("spending a jackpot spin credit counts down by one and never regenerates", async () => {
  const reward = {
    id: 22, title: "Movie night", kind: "free", payment_source: "free", tier_id: "tier_i",
    sponsor_type: "self", sponsor_splits: [], sponsor_active: true, value_cents: 0,
    bank_delta_cents: 0, requires_confirmation: false, cooldown_days: 0,
    unlock_threshold_cents: 0, notes: "", last_won_at: null, deleted_at: null,
    active: true, weight: 8, chance_shares: 8,
  };
  const mockPool = createMockPool({
    pointBalance: 100,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already", points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already", points_v3_spin_cost_migrated_at: "already",
      jackpot_spin_credits: 3,
      bank_builder_hit_rate: 0,
      payment_source_weights: { self: 0, sponsored: 0, free: 1 },
      reward_tiers: [{ id: "tier_i", label: "Tier I", weight: 1, active: true }],
    },
    rewardRows: [reward],
  });
  const store = loadStoreWithMock(mockPool);

  // Three banked credits must drain to 0 over three spins - each forced jackpot is
  // a single 3-in-a-row that pays no extra credits, so the count strictly falls.
  for (const expected of [2, 1, 0]) {
    const spin = await store.spin("ws-1", 1);
    assert.equal(spin.reward_snapshot.slot_stages.jackpot_hit, true);
    assert.equal(spin.reward_snapshot.slot_stages.jackpot_spins, 1, "a credit spin is always a single 3-in-a-row");
    assert.equal(mockPool.state.settings.jackpot_spin_credits, expected, `credits should fall to ${expected}`);
  }
});

test("banking a tier_up booster queues a tier bump for the next jackpot", async () => {
  const mockPool = gambleSpinPool("tier_up", [1, 2, 3, 4]);
  const store = loadStoreWithMock(mockPool);
  // risk once (rng 0 advances rung 0->1, value 2), then bank.
  await store.chooseSpinGamble("ws-1", 7, { action: "risk" }, () => 0);
  await store.chooseSpinGamble("ws-1", 7, { action: "bank" }, () => 0);
  assert.equal(mockPool.state.settings.next_spin_modifiers.tier_up, 2);
});

test("banking a miss_shield booster queues miss shields", async () => {
  const mockPool = gambleSpinPool("miss_shield", [1, 2, 3, 4]);
  const store = loadStoreWithMock(mockPool);
  const after = await store.chooseSpinGamble("ws-1", 7, { action: "bank" }, () => 0);
  assert.equal(after.status, "awarded");
  assert.equal(mockPool.state.settings.next_spin_modifiers.miss_shield, 1);
});

test("buildBoosterOutcome can produce each booster type", () => {
  const store = loadStoreWithMock(createMockPool());
  const settings = store._test.normalizeSlotSettings({});
  const seen = new Set();
  for(let pick = 0; pick < 4; pick++){
    const outcome = store._test.selectThreeStageOutcome([], {
      ...settings, jackpot_hit_rate: 0, miss_rate: 0,
      floor_weights: { bank: 0, coin: 0, booster: 1, pet: 0, free_spin: 0 },
    }, max => pick % max);
    // bank_multiplier grants a charge (no gamble); the others carry a gamble.
    seen.add(outcome.gamble ? outcome.gamble.booster_type : (outcome.multiplier_charge ? "bank_multiplier" : "?"));
  }
  assert.deepEqual([...seen].sort(), ["bank_multiplier", "miss_shield", "tier_up", "wild_hold"]);
});

test("a queued miss shield converts a miss spin into a bank builder", async () => {
  const mockPool = createMockPool({
    pointBalance: 100,
    migrated: true,
    settings: {
      points_v2_migrated_at: "already",
      points_v2_spin_cost_migrated_at: "already",
      points_v3_migrated_at: "already",
      points_v3_spin_cost_migrated_at: "already",
      jackpot_hit_rate: 0,
      miss_rate: 1,
      monthly_goal_cents: 10000,
      next_spin_modifiers: { miss_shield: 2 },
    },
  });
  const store = loadStoreWithMock(mockPool);
  const spin = await store.spin("ws-1", 1);
  const snap = spin.reward_snapshot;
  assert.equal(snap.slot_stages.miss_shielded, true);
  assert.equal(snap.kind, "bank_builder");
  assert.notEqual(spin.status, "miss");
  // one shield spent, one remains
  assert.equal(mockPool.state.settings.next_spin_modifiers.miss_shield, 1);
});

