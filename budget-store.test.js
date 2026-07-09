const test = require("node:test");
const assert = require("node:assert/strict");

function loadStoreWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const storePath = require.resolve("./budget-store");
  delete require.cache[poolPath];
  delete require.cache[storePath];
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: mockPool,
  };
  return require("./budget-store");
}

// Stateful mock: tankRows simulate the slot_rewards tank slice; queries are
// recognized by distinctive SQL fragments (same approach as slot-store.test.js).
function createMockPool(options = {}) {
  const calls = [];
  const state = {
    pointBalance: options.pointBalance ?? 0,
    bankBalance: options.bankBalance ?? 0,
    settings: options.settings || {},
    tankRows: (options.tankRows || []).map(r => ({ ...r })),
    savedSettings: null,
    spinsUsage: options.spinsUsage || { period_key: "2026-07", cur_cents: 0, prior_cents: 0 },
    convUsage: options.convUsage || { cur_cents: 0, prior_cents: 0 },
    pendingCents: options.pendingCents ?? 0,
    investments: options.investments || [],
    insertedRewards: [],
    nextId: options.nextId ?? 100,
    rolledBack: false,
  };

  function liveTank() {
    return state.tankRows
      .filter(r => r.tank_position != null && !r.deleted_at)
      .sort((a, b) => (a.tank_position - b.tank_position) || (a.id - b.id));
  }

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const text = String(sql);
    if (text === "BEGIN") { state.txnLedgerKeys = []; return { rows: [] }; }
    if (text === "COMMIT") { state.txnLedgerKeys = []; return { rows: [] }; }
    if (text === "ROLLBACK") {
      state.rolledBack = true;
      // Model Postgres: ROLLBACK undoes this txn's slot_point_ledger inserts, so
      // a same-key retry after a rolled-back failure re-attempts (not a duplicate).
      for (const k of (state.txnLedgerKeys || [])) state.ledgerKeys.delete(k);
      state.txnLedgerKeys = [];
      return { rows: [] };
    }
    if (text.includes("INSERT INTO slot_accounts")) {
      return { rows: [{ workspace_id: params[0], user_id: params[1], point_balance: state.pointBalance, bank_balance_cents: state.bankBalance, settings: state.settings }] };
    }
    if (text.includes("SET settings = COALESCE(settings")) {
      state.savedSettings = JSON.parse(params[1]);
      state.settings = { ...state.settings, ...state.savedSettings };
      return { rows: [] };
    }
    if (text.includes("SUM(bank_delta_cents) FILTER")) {
      return { rows: [{ ...state.spinsUsage }] };
    }
    if (text.includes("FROM budget_conversions") && text.includes("FILTER")) {
      return { rows: [{ ...state.convUsage }] };
    }
    if (text.includes("status = 'pending'") && text.includes("bank_reserved_cents = 0")) {
      return { rows: [{ cents: state.pendingCents }] };
    }
    // Threshold recompute: cumulative sum of value_cents by tank_position.
    if (text.includes("tank_unlock_cents = c.cum")) {
      let run = 0;
      const updated = [];
      for (const r of liveTank()) { run += r.value_cents || 0; r.tank_unlock_cents = run; updated.push({ id: r.id }); }
      return { rows: updated };
    }
    if (text.includes("COALESCE(MAX(tank_position)")) {
      const live = liveTank();
      const max = live.length ? Math.max(...live.map(r => r.tank_position)) : 0;
      return { rows: [{ next: max + 1000, count: live.length }] };
    }
    if (text.includes("INSERT INTO slot_rewards")) {
      const row = {
        id: state.nextId++,
        workspace_id: params[0],
        title: params[1],
        kind: "bank_gated",
        active: true,
        value_cents: params[2],
        duration_minutes: params[3],
        uses_remaining: params[4],
        tank_position: params[5],
        tank_unlock_cents: 0,
        tank_category: params[7],
        tank_color: params[8],
        tank_recurring: params[9],
        tank_claimed_period: null,
        deleted_at: null,
      };
      if (state.tankRows.some(r => !r.deleted_at && r.title === row.title)) {
        const err = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      state.tankRows.push(row);
      state.insertedRewards.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.includes("SELECT * FROM slot_rewards") && text.includes("FOR UPDATE")) {
      if (text.includes("id = $2")) {
        const row = state.tankRows.find(r => r.id === params[1] && r.tank_position != null && !r.deleted_at);
        return { rows: row ? [{ ...row }] : [] };
      }
      return { rows: liveTank().map(r => ({ ...r })) }; // rollover: whole tank
    }
    if (text.includes("INSERT INTO budget_investments")) {
      state.investmentsByPeriod = state.investmentsByPeriod || new Set(state.investments.map(r => r.period_key));
      if (state.investmentsByPeriod.has(params[2])) return { rows: [] };
      state.investmentsByPeriod.add(params[2]);
      const row = { id: state.investments.length + 1, period_key: params[2], amount_cents: params[3], task_block_id: null };
      state.investments.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.includes("UPDATE budget_investments") && text.includes("task_block_id")) {
      const row = state.investments.find(r => r.period_key === params[1]);
      if (row) row.task_block_id = params[2];
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM slot_accounts") && text.includes("FOR UPDATE")) {
      return { rows: [{ workspace_id: params[0], point_balance: state.pointBalance, bank_balance_cents: state.bankBalance, settings: state.settings }] };
    }
    if (text.includes("bank_balance_cents = GREATEST(0, bank_balance_cents - $2")) {
      state.debits = state.debits || [];
      state.debits.push(params[1]);
      state.bankBalance = Math.max(0, state.bankBalance - params[1]);
      return { rows: [] };
    }
    if (text.includes("SET tank_claimed_period = $3")) {
      const row = state.tankRows.find(r => r.id === params[1]);
      if (!row) return { rows: [] };
      row.tank_claimed_period = params[2];
      if (row.uses_remaining != null) row.uses_remaining = Math.max(0, row.uses_remaining - 1);
      return { rows: [{ ...row }] };
    }
    if (text.includes("SELECT * FROM slot_rewards") && text.includes("tank_position IS NOT NULL")) {
      return { rows: liveTank().map(r => ({ ...r })) };
    }
    if (text.includes("SELECT id FROM slot_rewards") && text.includes("tank_position IS NOT NULL")) {
      return { rows: liveTank().map(r => ({ id: r.id })) };
    }
    if (text.includes("SET tank_position = $3")) {
      const row = state.tankRows.find(r => r.id === params[1] && r.tank_position != null && !r.deleted_at);
      if (row) row.tank_position = params[2];
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (text.includes("SET title = $3")) {
      const row = state.tankRows.find(r => r.id === params[1] && r.tank_position != null && !r.deleted_at);
      if (!row) return { rows: [] };
      row.title = params[2];
      row.value_cents = params[3];
      row.duration_minutes = params[4];
      row.tank_category = params[5];
      if (params[6] != null) row.tank_color = params[6];
      row.tank_recurring = params[7];
      row.uses_remaining = params[7] ? null : (row.uses_remaining ?? 1);
      return { rows: [{ ...row }] };
    }
    if (text.includes("SET tank_position = NULL")) {
      const row = state.tankRows.find(r => r.id === params[1] && r.tank_position != null && !r.deleted_at);
      if (!row) return { rows: [] };
      row.tank_position = null;
      row.tank_unlock_cents = 0;
      if (text.includes("deleted_at = NOW()")) { row.deleted_at = "now"; row.active = false; }
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("INSERT INTO slot_point_ledger")) {
      state.ledgerKeys = state.ledgerKeys || new Set();
      const key = params[3];
      if (state.ledgerKeys.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING
      state.ledgerKeys.add(key);
      (state.txnLedgerKeys = state.txnLedgerKeys || []).push(key); // undone on ROLLBACK
      state.ledgerDeltas = state.ledgerDeltas || [];
      state.ledgerDeltas.push(params[2]);
      return { rows: [{ id: state.ledgerDeltas.length }] };
    }
    if (text.includes("SELECT point_balance FROM slot_accounts")) {
      return { rows: [{ point_balance: state.pointBalance }] };
    }
    if (text.includes("SET point_balance = point_balance - $2")) {
      state.pointBalance -= params[1];
      state.bankBalance += params[2];
      return { rows: [{ point_balance: state.pointBalance, bank_balance_cents: state.bankBalance }] };
    }
    if (text.includes("INSERT INTO budget_conversions")) {
      state.conversions = state.conversions || [];
      const row = { id: state.conversions.length + 1, workspace_id: params[0], points: params[2], cents: params[3], rate_cents_per_point: params[4], source_key: params[5] };
      state.conversions.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.includes("FROM budget_conversions") && text.includes("source_key")) {
      const row = (state.conversions || []).find(c => c.source_key === params[1]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (text.includes("FROM budget_investments") && text.includes("SUM(amount_cents)")) {
      return { rows: [{ total: state.investments.reduce((s, r) => s + r.amount_cents, 0) }] };
    }
    if (text.includes("FROM budget_investments")) {
      return { rows: state.investments.map(r => ({ ...r })) };
    }
    throw new Error("Unhandled mock query: " + text.slice(0, 120));
  }

  const client = { query, release() {} };
  return { query, connect: async () => client, calls, state };
}

const WS = "ws-test";

function tankRow(id, valueCents, position, extra = {}) {
  return {
    id, title: "Block " + id, kind: "bank_gated", active: true,
    value_cents: valueCents, duration_minutes: 0, uses_remaining: 1,
    tank_position: position, tank_unlock_cents: 0, tank_category: null,
    tank_color: "#f59e0b", tank_recurring: false, tank_claimed_period: null,
    deleted_at: null, ...extra,
  };
}

test("normalizeBudgetTankSettings applies defaults and clamps", () => {
  const store = loadStoreWithMock(createMockPool());
  const s = store.normalizeBudgetTankSettings(undefined);
  assert.equal(s.period_type, "month");
  assert.equal(s.capacity_source, "last_income");
  assert.equal(s.cents_per_point, 1);
  assert.equal(s.current_period, null);
  assert.ok(s.necessities.length >= 1);

  const custom = store.normalizeBudgetTankSettings({
    period_type: "week",
    cents_per_point: 99999,
    necessities: [{ name: "Rent", amount_cents: 120000 }, { name: "", amount_cents: 5 }],
    current_period: { key: "2026-07", capacity_cents: 40000 },
  });
  assert.equal(custom.period_type, "week");
  assert.equal(custom.cents_per_point, 1000); // clamped
  assert.equal(custom.necessities.length, 1); // empty name dropped
  assert.equal(custom.current_period.key, "2026-07");

  const junk = store.normalizeBudgetTankSettings({ period_type: "fortnight", capacity_source: "vibes" });
  assert.equal(junk.period_type, "month");
  assert.equal(junk.capacity_source, "last_income");
  assert.equal(store.normalizeBudgetTankSettings({ capacity_source: "prior_period_banked" }).capacity_source, "prior_period_banked");
});

test("getTankUsage sums spins + conversions and uses the month window by default", async () => {
  const mock = createMockPool({
    spinsUsage: { period_key: "2026-07", cur_cents: 4200, prior_cents: 30000 },
    convUsage: { cur_cents: 800, prior_cents: 500 },
  });
  const store = loadStoreWithMock(mock);
  const usage = await store.getTankUsage(WS, { period_type: "month" });
  assert.equal(usage.periodKey, "2026-07");
  assert.equal(usage.periodBanked, 5000);
  assert.equal(usage.priorPeriodBanked, 30500);
  const spinSql = mock.calls.find(c => c.sql.includes("SUM(bank_delta_cents) FILTER")).sql;
  assert.ok(spinSql.includes("date_trunc('month', NOW())"));
  assert.ok(!spinSql.includes("date_trunc('week'"));
});

test("getTankUsage switches to the week window for period_type week", async () => {
  const mock = createMockPool({ spinsUsage: { period_key: "2026-W28", cur_cents: 100, prior_cents: 200 } });
  const store = loadStoreWithMock(mock);
  const usage = await store.getTankUsage(WS, { period_type: "week" });
  assert.equal(usage.periodKey, "2026-W28");
  const spinSql = mock.calls.find(c => c.sql.includes("SUM(bank_delta_cents) FILTER")).sql;
  assert.ok(spinSql.includes("date_trunc('week', NOW())"));
  assert.ok(spinSql.includes("INTERVAL '1 week'"));
});

test("addTankBlock places on top (MAX+1000) and recomputes cumulative thresholds", async () => {
  const mock = createMockPool({ tankRows: [tankRow(1, 5000, 1000), tankRow(2, 10000, 2000)] });
  const store = loadStoreWithMock(mock);
  const row = await store.addTankBlock(WS, 7, { category: "Restaurants", item: "Anniversary dinner", amount: 150 });
  assert.equal(row.title, "Restaurants: Anniversary dinner");
  assert.equal(row.value_cents, 15000);
  assert.equal(row.tank_position, 3000);
  assert.equal(row.uses_remaining, 1); // one-shot by default
  const byId = Object.fromEntries(mock.state.tankRows.map(r => [r.id, r.tank_unlock_cents]));
  assert.equal(byId[1], 5000);
  assert.equal(byId[2], 15000);
  assert.equal(byId[row.id], 30000);
});

test("addTankBlock: recurring envelopes get no uses_remaining; duplicate titles 400", async () => {
  const mock = createMockPool();
  const store = loadStoreWithMock(mock);
  const row = await store.addTankBlock(WS, 7, { category: "Restaurants", amount_cents: 20000, recurring: true });
  assert.equal(row.title, "Restaurants");
  assert.equal(row.uses_remaining, null);
  assert.equal(row.tank_recurring, true);
  await assert.rejects(
    () => store.addTankBlock(WS, 7, { category: "Restaurants", amount_cents: 5000 }),
    (e) => e.statusCode === 400
  );
  assert.ok(mock.state.rolledBack);
});

test("addTankBlock validates input", async () => {
  const store = loadStoreWithMock(createMockPool());
  await assert.rejects(() => store.addTankBlock(WS, 7, { amount: 50 }), e => e.statusCode === 400);
  await assert.rejects(() => store.addTankBlock(WS, 7, { category: "Fun", amount: 0 }), e => e.statusCode === 400);
});

test("reorderTank persists order and recomputes thresholds bottom-up", async () => {
  const mock = createMockPool({ tankRows: [tankRow(1, 5000, 1000), tankRow(2, 10000, 2000), tankRow(3, 2000, 3000)] });
  const store = loadStoreWithMock(mock);
  // Drag block 3 to the bottom (highest priority).
  await store.reorderTank(WS, [
    { id: 3, tank_position: 1000 },
    { id: 1, tank_position: 2000 },
    { id: 2, tank_position: 3000 },
  ]);
  const byId = Object.fromEntries(mock.state.tankRows.map(r => [r.id, r.tank_unlock_cents]));
  assert.equal(byId[3], 2000);
  assert.equal(byId[1], 7000);
  assert.equal(byId[2], 17000);
});

test("reorderTank renumbers the whole tank on position collisions", async () => {
  const mock = createMockPool({ tankRows: [tankRow(1, 5000, 1000), tankRow(2, 10000, 2000)] });
  const store = loadStoreWithMock(mock);
  await store.reorderTank(WS, [
    { id: 2, tank_position: 1000 },
    { id: 1, tank_position: 1000.0001 },
  ]);
  const positions = mock.state.tankRows.map(r => r.tank_position).sort((a, b) => a - b);
  assert.deepEqual(positions, [1000, 2000]);
  const byId = Object.fromEntries(mock.state.tankRows.map(r => [r.id, r.tank_unlock_cents]));
  assert.equal(byId[2], 10000);
  assert.equal(byId[1], 15000);
});

test("updateTankBlock amount change reflows thresholds above it", async () => {
  const mock = createMockPool({ tankRows: [tankRow(1, 5000, 1000), tankRow(2, 10000, 2000)] });
  const store = loadStoreWithMock(mock);
  await store.updateTankBlock(WS, 1, { title: "Block 1", amount_cents: 8000 });
  const byId = Object.fromEntries(mock.state.tankRows.map(r => [r.id, r.tank_unlock_cents]));
  assert.equal(byId[1], 8000);
  assert.equal(byId[2], 18000);
});

test("removeTankBlock soft-deletes by default, keeps catalog row with keepReward", async () => {
  const mock = createMockPool({ tankRows: [tankRow(1, 5000, 1000), tankRow(2, 10000, 2000)] });
  const store = loadStoreWithMock(mock);
  await store.removeTankBlock(WS, 1);
  assert.equal(mock.state.tankRows.find(r => r.id === 1).deleted_at, "now");
  assert.equal(mock.state.tankRows.find(r => r.id === 2).tank_unlock_cents, 10000);

  const mock2 = createMockPool({ tankRows: [tankRow(1, 5000, 1000)] });
  const store2 = loadStoreWithMock(mock2);
  await store2.removeTankBlock(WS, 1, { keepReward: true });
  const row = mock2.state.tankRows.find(r => r.id === 1);
  assert.equal(row.tank_position, null);
  assert.equal(row.deleted_at, null);

  await assert.rejects(() => store2.removeTankBlock(WS, 99), e => e.statusCode === 404);
});

test("getBudgetState stamps the first period from prior-period banked and derives block states", async () => {
  const mock = createMockPool({
    pointBalance: 250,
    bankBalance: 6000,
    // Auto-capacity from the bank build, no necessities, so capacity == gross.
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [] } },
    spinsUsage: { period_key: "2026-07", cur_cents: 7000, prior_cents: 40000 },
    convUsage: { cur_cents: 0, prior_cents: 0 },
    tankRows: [
      tankRow(1, 5000, 1000, { tank_unlock_cents: 5000 }),                                   // waterline 7000 covers it
      tankRow(2, 10000, 2000, { tank_unlock_cents: 15000 }),                                 // locked
      tankRow(3, 1000, 3000, { tank_unlock_cents: 16000, tank_claimed_period: "2026-07" }),  // claimed
    ],
  });
  const store = loadStoreWithMock(mock);
  const state = await store.getBudgetState(WS, 7);

  assert.equal(state.rollover_due, false);
  assert.equal(state.settings.current_period.key, "2026-07");
  assert.equal(state.settings.current_period.capacity_cents, 40000); // prior period banked
  assert.equal(mock.state.savedSettings.budget_tank.current_period.key, "2026-07"); // persisted
  assert.equal(state.usage.waterline_cents, 7000);
  assert.equal(state.points, 250);
  assert.equal(state.funding.total, 6000);

  const byId = Object.fromEntries(state.blocks.map(b => [b.id, b]));
  assert.equal(byId[1].status, "claimable");
  assert.equal(byId[2].status, "locked");
  assert.equal(byId[2].needs_cents, 8000);
  assert.equal(byId[3].status, "claimed");
});

test("getBudgetState flags rollover on period mismatch and shows unlocked-but-short", async () => {
  const mock = createMockPool({
    bankBalance: 500, // drained reserve
    settings: { budget_tank: { period_type: "month", current_period: { key: "2026-06", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 9000, prior_cents: 20000 },
    tankRows: [tankRow(1, 5000, 1000, { tank_unlock_cents: 5000 })],
  });
  const store = loadStoreWithMock(mock);
  const state = await store.getBudgetState(WS, 7);
  assert.equal(state.rollover_due, true);
  assert.equal(state.settings.current_period.key, "2026-06"); // untouched until user chooses
  const block = state.blocks[0];
  assert.equal(block.unlocked, true);
  assert.equal(block.status, "short");
  assert.equal(block.shortfall_cents, 4500);
});

test("getBudgetState waterline is capped at capacity", async () => {
  const mock = createMockPool({
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-07", capacity_cents: 3000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 9000, prior_cents: 0 },
  });
  const store = loadStoreWithMock(mock);
  const state = await store.getBudgetState(WS, 7);
  assert.equal(state.usage.waterline_cents, 3000);
  assert.equal(state.usage.period_banked_cents, 9000);
});

test("last_income capacity = income minus necessities; editing income resizes the current tank live", async () => {
  const mock = createMockPool({
    settings: { budget_tank: {
      capacity_source: "last_income",
      income_cents: 200000,                                   // $2000 income last month
      necessities: [{ name: "Rent", amount_cents: 100000 }, { name: "Groceries", amount_cents: 30000 }], // $1300
      current_period: { key: "2026-07", capacity_cents: 999999 }, // stale stamp — ignored for last_income
    } },
    spinsUsage: { period_key: "2026-07", cur_cents: 90000, prior_cents: 0 },
  });
  const store = loadStoreWithMock(mock);
  const state = await store.getBudgetState(WS, 7);
  assert.equal(state.usage.income_cents, 200000);
  assert.equal(state.usage.necessities_total_cents, 130000);
  assert.equal(state.usage.capacity_cents, 70000);          // $700 discretionary = income - necessities
  assert.equal(state.usage.waterline_cents, 70000);         // banked 90000 capped at the $700 budget

  // Editing income re-resolves live (no rollover needed).
  const next = await store.updateBudgetConfig(WS, 7, { income_cents: 250000, capacity_source: "last_income" });
  assert.equal(next.income_cents, 250000);
  const after = await store.getBudgetState(WS, 7);
  assert.equal(after.usage.capacity_cents, 120000);         // 250000 - 130000
});

test("updateBudgetConfig merges fields, clamps the rate, and never takes current_period from the client", async () => {
  const mock = createMockPool({
    settings: { budget_tank: { period_type: "month", current_period: { key: "2026-07", capacity_cents: 40000 } } },
  });
  const store = loadStoreWithMock(mock);
  const next = await store.updateBudgetConfig(WS, 7, {
    income_cents: 500000,
    cents_per_point: 5,
    current_period: { key: "2099-01", capacity_cents: 999999 }, // must be ignored
  });
  assert.equal(next.income_cents, 500000);
  assert.equal(next.cents_per_point, 5);
  assert.equal(next.current_period.key, "2026-07");
  assert.equal(mock.state.savedSettings.budget_tank.current_period.key, "2026-07");
});

test("claimTankBlock debits value_cents (never the cumulative threshold) and stamps the period", async () => {
  const mock = createMockPool({
    bankBalance: 20000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-07", capacity_cents: 50000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 40000, prior_cents: 0 },
    // $50 block at the TOP of a $400 stack: cumulative gate 40000, price 5000.
    tankRows: [tankRow(1, 35000, 1000, { tank_unlock_cents: 35000 }), tankRow(2, 5000, 2000, { tank_unlock_cents: 40000 })],
  });
  const store = loadStoreWithMock(mock);
  let swept = false;
  const result = await store.claimTankBlock(WS, 7, 2, { sweepPendingBankBuilders: async () => { swept = true; } });
  assert.equal(result.claimed, true);
  assert.equal(result.debited_cents, 5000);          // price, NOT the 40000 gate
  assert.deepEqual(mock.state.debits, [5000]);
  assert.equal(swept, true);
  assert.equal(mock.state.tankRows.find(r => r.id === 2).tank_claimed_period, "2026-07");
  assert.equal(mock.state.tankRows.find(r => r.id === 2).uses_remaining, 0); // one-shot burned
});

test("claimTankBlock gates: below waterline and reserve-short both 400; double claim is a no-op duplicate", async () => {
  const base = {
    settings: { budget_tank: { current_period: { key: "2026-07", capacity_cents: 50000 } } },
    tankRows: [tankRow(1, 5000, 1000, { tank_unlock_cents: 5000 })],
  };
  // Below waterline.
  let mock = createMockPool({ ...base, bankBalance: 9999, spinsUsage: { period_key: "2026-07", cur_cents: 1000, prior_cents: 0 } });
  let store = loadStoreWithMock(mock);
  await assert.rejects(() => store.claimTankBlock(WS, 7, 1, {}), e => e.statusCode === 400 && /waterline/.test(e.message));
  assert.equal(mock.state.debits, undefined);

  // Unlocked but reserve short.
  mock = createMockPool({ ...base, bankBalance: 100, spinsUsage: { period_key: "2026-07", cur_cents: 6000, prior_cents: 0 } });
  store = loadStoreWithMock(mock);
  await assert.rejects(() => store.claimTankBlock(WS, 7, 1, {}), e => e.statusCode === 400 && /Reserve/.test(e.message));

  // Claim, then claim again: duplicate, single debit.
  mock = createMockPool({ ...base, bankBalance: 9000, spinsUsage: { period_key: "2026-07", cur_cents: 6000, prior_cents: 0 } });
  store = loadStoreWithMock(mock);
  const first = await store.claimTankBlock(WS, 7, 1, {});
  assert.equal(first.claimed, true);
  const second = await store.claimTankBlock(WS, 7, 1, {});
  assert.equal(second.claimed, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(mock.state.debits, [5000]);

  // Missing block.
  await assert.rejects(() => store.claimTankBlock(WS, 7, 99, {}), e => e.statusCode === 404);
});

test("tankDrivenGoalCents drives the Bank Builder goal only for an active monthly tank", () => {
  const store = loadStoreWithMock(createMockPool());
  const cp = { current_period: { key: "2026-07", capacity_cents: 20446 } };
  assert.equal(store.tankDrivenGoalCents({ budget_tank: { period_type: "month", ...cp } }), 20446);
  assert.equal(store.tankDrivenGoalCents({ budget_tank: { period_type: "month", goal_mode: "manual", ...cp } }), 0);
  assert.equal(store.tankDrivenGoalCents({ budget_tank: { period_type: "week", ...cp } }), 0);
  assert.equal(store.tankDrivenGoalCents({ budget_tank: { period_type: "month" } }), 0);
  assert.equal(store.tankDrivenGoalCents({}), 0);
  assert.equal(store.tankDrivenGoalCents(null), 0);
});

test("slot-store rowToReward: tank rows gate on the waterline, afford on value_cents, and lock after a period claim", () => {
  loadStoreWithMock(createMockPool()); // ensure pg-pool mock is in the require cache
  const slotPath = require.resolve("./slot-store");
  delete require.cache[slotPath];
  const slotStore = require("./slot-store");
  const rowToReward = slotStore._test.rowToReward;
  const account = { bank_balance_cents: 6000, settings: {} };
  const row = {
    id: 2, title: "Restaurants: Anniversary dinner", kind: "bank_gated", active: true,
    weight: 1, chance_shares: 1, payment_source: "self", tier_id: "tier_i",
    value_cents: 5000, unlock_threshold_cents: 0,
    tank_position: 2000, tank_unlock_cents: 40000, tank_claimed_period: null,
  };
  // Waterline below the gate: tank_locked even though value is affordable.
  let r = rowToReward(row, account, {}, 6000, { periodKey: "2026-07", waterlineCents: 30000 });
  assert.equal(r.eligible, false);
  assert.equal(r.locked_reason, "tank_locked");
  assert.equal(r.tank_needs_cents, 10000);
  assert.equal(r.reserve_cost_cents, 5000); // debit price = value, never the gate

  // Waterline past the gate: eligible.
  r = rowToReward(row, account, {}, 6000, { periodKey: "2026-07", waterlineCents: 45000 });
  assert.equal(r.eligible, true);
  assert.equal(r.locked_reason, null);

  // Claimed this period: locked as tank_claimed.
  r = rowToReward({ ...row, tank_claimed_period: "2026-07" }, account, {}, 6000, { periodKey: "2026-07", waterlineCents: 45000 });
  assert.equal(r.eligible, false);
  assert.equal(r.locked_reason, "tank_claimed");

  // Non-tank rows are untouched by tank usage.
  r = rowToReward({ ...row, tank_position: null, tank_unlock_cents: 0 }, account, {}, 6000, { periodKey: "2026-07", waterlineCents: 0 });
  assert.equal(r.eligible, true);
});

test("convertPointsToBank debits points, credits bank at the configured rate, and logs both ledgers", async () => {
  const mock = createMockPool({
    pointBalance: 500,
    bankBalance: 1000,
    settings: { budget_tank: { cents_per_point: 2 } },
  });
  const store = loadStoreWithMock(mock);
  const out = await store.convertPointsToBank(WS, 7, { points: 200, source_key: "k-1" });
  assert.equal(out.converted, true);
  assert.equal(out.point_balance, 300);
  assert.equal(out.bank_balance_cents, 1400); // 200 pts * 2¢
  assert.equal(out.conversion.cents, 400);
  assert.deepEqual(mock.state.ledgerDeltas, [-200]);
  assert.equal(mock.state.conversions.length, 1);
});

test("convertPointsToBank: duplicate source_key is a no-op returning the original conversion", async () => {
  const mock = createMockPool({ pointBalance: 500 });
  const store = loadStoreWithMock(mock);
  const first = await store.convertPointsToBank(WS, 7, { points: 100, source_key: "k-dup" });
  assert.equal(first.converted, true);
  const second = await store.convertPointsToBank(WS, 7, { points: 100, source_key: "k-dup" });
  assert.equal(second.converted, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.conversion.source_key, "k-dup");
  assert.equal(mock.state.pointBalance, 400);       // debited exactly once
  assert.equal(mock.state.conversions.length, 1);
});

test("convertPointsToBank: insufficient points rolls back, and a same-key retry after topping up succeeds (not a duplicate)", async () => {
  const mock = createMockPool({ pointBalance: 50 });
  const store = loadStoreWithMock(mock);
  // Not enough points: rejects and rolls back the whole attempt.
  await assert.rejects(() => store.convertPointsToBank(WS, 7, { points: 100, source_key: "k-poor" }),
    e => e.statusCode === 400 && /Not enough points/.test(e.message));
  assert.equal(mock.state.pointBalance, 50);
  assert.equal(mock.state.bankBalance, 0);
  assert.equal((mock.state.conversions || []).length, 0);
  assert.ok(mock.state.rolledBack);
  // The ROLLBACK undid the ledger insert, so retrying the SAME source_key after
  // topping up re-attempts and converts — it does NOT read back as a duplicate.
  mock.state.pointBalance = 200;
  const retry = await store.convertPointsToBank(WS, 7, { points: 100, source_key: "k-poor" });
  assert.equal(retry.converted, true);
  assert.equal(retry.duplicate, false);
  assert.equal(mock.state.pointBalance, 100);
  assert.equal(mock.state.conversions.length, 1);
  // Validation guards.
  await assert.rejects(() => store.convertPointsToBank(WS, 7, { points: 0, source_key: "k" }), e => e.statusCode === 400);
  await assert.rejects(() => store.convertPointsToBank(WS, 7, { points: 10 }), e => e.statusCode === 400);
});

test("claimTankBlock: the injected sweep credits pending bank builders before the reserve gate", async () => {
  // Block is affordable only AFTER the pending Bank Builder deposit is swept
  // into bank_balance_cents: reserve starts at 2000, block costs 5000, and a
  // 4000 pending sweep bridges the gap. Proves the injected-sweep contract.
  const mock = createMockPool({
    bankBalance: 2000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-07", capacity_cents: 50000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 40000, prior_cents: 0 },
    tankRows: [tankRow(1, 5000, 1000, { tank_unlock_cents: 5000 })],
  });
  const store = loadStoreWithMock(mock);
  const sweep = async () => { mock.state.bankBalance += 4000; }; // pending -> balance
  // Without the sweep this would 400 (2000 < 5000); with it, balance becomes 6000.
  const result = await store.claimTankBlock(WS, 7, 1, { sweepPendingBankBuilders: sweep });
  assert.equal(result.claimed, true);
  assert.equal(result.debited_cents, 5000);
  assert.equal(mock.state.bankBalance, 1000); // 2000 + 4000 swept - 5000 debited
});

test("REGRESSION: getBankUsage (Bank Builder pacing) never reads budget_conversions", async () => {
  loadStoreWithMock(createMockPool());
  const slotPath = require.resolve("./slot-store");
  delete require.cache[slotPath];
  // Fresh mock that serves slot_spins window sums and BLOWS UP on the
  // conversions table — proving conversions can't contaminate pacing/shield.
  const poolPath = require.resolve("./pg-pool");
  const guard = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("budget_conversions")) throw new Error("Bank Builder read budget_conversions!");
      if (text.includes("FROM slot_spins")) return { rows: [{ cents: 0, day_of_month: 8, days_in_month: 31 }] };
      throw new Error("Unexpected: " + text.slice(0, 60));
    },
    connect: async () => ({ query: guard.query, release() {} }),
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: guard };
  delete require.cache[slotPath];
  const slotStore = require("./slot-store");
  const usage = await slotStore._test.getBankUsage(WS, {});
  assert.equal(usage.month, 0);
  assert.ok(usage.monthlyGoal > 0);
});

test("rolloverPeriod carry: sweep leftover, claimed one-shots leave, unhit sink to the bottom, envelopes persist", async () => {
  const mock = createMockPool({
    bankBalance: 10000,
    // Auto capacity so the new period's budget = last period's build (20000).
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-06", capacity_cents: 30000 } } },
    // June banked 20000 (prior window now); July banked 500 so far.
    spinsUsage: { period_key: "2026-07", cur_cents: 500, prior_cents: 20000 },
    tankRows: [
      tankRow(1, 8000, 1000, { tank_unlock_cents: 8000, tank_claimed_period: "2026-06" }),        // claimed one-shot -> leaves
      tankRow(2, 7000, 2000, { tank_unlock_cents: 15000, tank_recurring: true, uses_remaining: null }), // envelope -> persists
      tankRow(3, 9000, 3000, { tank_unlock_cents: 24000 }),                                        // unhit one-shot -> carries to bottom
    ],
  });
  const store = loadStoreWithMock(mock);
  const out = await store.rolloverPeriod(WS, 7, { mode: "carry" });
  assert.equal(out.rolled, true);
  assert.equal(out.closing_period, "2026-06");
  assert.equal(out.new_period, "2026-07");
  // Closing waterline = min(20000, 30000) = 20000; last funded gate = 15000; leftover 5000 <= balance.
  assert.equal(out.swept_cents, 5000);
  assert.deepEqual(mock.state.debits, [5000]);
  assert.equal(mock.state.investments[0].period_key, "2026-06");
  assert.equal(out.new_capacity_cents, 20000); // June's build is July's budget
  assert.equal(mock.state.savedSettings.budget_tank.current_period.key, "2026-07");

  const r1 = mock.state.tankRows.find(r => r.id === 1);
  const r2 = mock.state.tankRows.find(r => r.id === 2);
  const r3 = mock.state.tankRows.find(r => r.id === 3);
  assert.equal(r1.tank_position, null);            // claimed one-shot left the tank
  assert.equal(r3.tank_position, 1000);            // unhit carried to the BOTTOM (priority 1)
  assert.equal(r2.tank_position, 2000);            // envelope above it
  assert.equal(r3.tank_unlock_cents, 9000);        // thresholds reflowed
  assert.equal(r2.tank_unlock_cents, 16000);
});

test("rolloverPeriod fresh: unhit one-shots leave too; sweep is bounded by the spendable balance", async () => {
  const mock = createMockPool({
    bankBalance: 1200, // less than the 5000 leftover
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-06", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 20000 },
    tankRows: [
      tankRow(2, 15000, 1000, { tank_unlock_cents: 15000, tank_recurring: true, uses_remaining: null }),
      tankRow(3, 9000, 2000, { tank_unlock_cents: 24000 }),
    ],
  });
  const store = loadStoreWithMock(mock);
  const out = await store.rolloverPeriod(WS, 7, { mode: "fresh" });
  assert.equal(out.swept_cents, 1200);             // min(leftover 5000, balance 1200)
  assert.equal(mock.state.tankRows.find(r => r.id === 3).tank_position, null);
  assert.equal(mock.state.tankRows.find(r => r.id === 2).tank_position, 1000);
});

test("rolloverPeriod: per-period sweep is idempotent and same-period rollover is a 400", async () => {
  const mock = createMockPool({
    bankBalance: 10000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-06", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 20000 },
    investments: [{ id: 9, period_key: "2026-06", amount_cents: 4444, task_block_id: null }], // already swept
    tankRows: [tankRow(2, 15000, 1000, { tank_unlock_cents: 15000, tank_recurring: true, uses_remaining: null })],
  });
  const store = loadStoreWithMock(mock);
  const out = await store.rolloverPeriod(WS, 7, { mode: "carry" });
  assert.equal(out.swept_cents, 0);
  assert.equal(out.already_swept, true);
  assert.equal(mock.state.debits, undefined);      // no double debit

  const mock2 = createMockPool({
    settings: { budget_tank: { current_period: { key: "2026-07", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 0 },
  });
  const store2 = loadStoreWithMock(mock2);
  await assert.rejects(() => store2.rolloverPeriod(WS, 7, {}), e => e.statusCode === 400 && /isn't over/.test(e.message));
});

test("rolloverPeriod sweep caps at discretionary (income - necessities), never gross — no phantom sweep", async () => {
  // Gross capacity stamped 30000; necessities 12000 -> discretionary 18000.
  // Prior banked 25000 EXCEEDS discretionary. One block funded at threshold 10000.
  // Correct leftover = min(25000, 18000) - 10000 = 8000, NOT the gross-based
  // 25000 - 10000 = 15000 that would over-invest ~necessities-worth of reserve.
  const mock = createMockPool({
    bankBalance: 100000,
    settings: { budget_tank: { capacity_source: "prior_period_banked",
      necessities: [{ id: "rent", name: "Rent", amount_cents: 12000, color: "#22c55e" }],
      current_period: { key: "2026-06", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 25000 },
    tankRows: [tankRow(1, 10000, 1000, { tank_unlock_cents: 10000 })],
  });
  const store = loadStoreWithMock(mock);
  const out = await store.rolloverPeriod(WS, 7, { mode: "fresh" });
  assert.equal(out.swept_cents, 8000);
});

test("getBudgetState surfaces a rollover preview on period mismatch", async () => {
  const mock = createMockPool({
    bankBalance: 10000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-06", capacity_cents: 30000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 20000 },
    tankRows: [
      tankRow(2, 15000, 1000, { tank_unlock_cents: 15000 }),
      tankRow(3, 9000, 2000, { tank_unlock_cents: 24000 }),
    ],
  });
  const store = loadStoreWithMock(mock);
  const state = await store.getBudgetState(WS, 7);
  assert.equal(state.rollover_due, true);
  assert.equal(state.rollover_preview.closing_key, "2026-06");
  assert.equal(state.rollover_preview.closing_waterline_cents, 20000);
  assert.equal(state.rollover_preview.leftover_cents, 5000);
  assert.deepEqual(state.rollover_preview.unhit.map(u => u.id), [3]);
});

test("tank thresholds follow the drag order (tank_position), independent of category", async () => {
  const mock = createMockPool({
    tankRows: [
      tankRow(1, 5000, 1000, { tank_category: "Restaurants" }),
      tankRow(2, 6000, 2000, { tank_category: "Gifts" }),        // categories interleave — that's fine
      tankRow(3, 3000, 3000, { tank_category: "Restaurants" }),
      tankRow(4, 4000, 4000, { tank_category: "Gifts" }),
    ],
  });
  const store = loadStoreWithMock(mock);
  await store.reorderTank(WS, [
    { id: 1, tank_position: 1000 }, { id: 2, tank_position: 2000 },
    { id: 3, tank_position: 3000 }, { id: 4, tank_position: 4000 },
  ]);
  const byId = Object.fromEntries(mock.state.tankRows.map(r => [r.id, r.tank_unlock_cents]));
  // Strict position order, categories ignored: the tank is free.
  assert.equal(byId[1], 5000);
  assert.equal(byId[2], 11000);
  assert.equal(byId[3], 14000);
  assert.equal(byId[4], 18000);
});

test("buildCategories keeps its own stable order (by creation), divorced from tank order", async () => {
  const mock = createMockPool({
    bankBalance: 50000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-07", capacity_cents: 100000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 0, prior_cents: 0 },
    tankRows: [
      // Gifts (id 2) is dragged to the BOTTOM of the tank (position 500), but the
      // budget list must still lead with Restaurants (created first, id 1).
      tankRow(1, 5000, 1000, { tank_category: "Restaurants", title: "Restaurants: Dinner", tank_unlock_cents: 5500 }),
      tankRow(2, 500, 500, { tank_category: "Gifts", title: "Gifts: Card", tank_unlock_cents: 500 }),
      tankRow(3, 3000, 2000, { tank_category: "Restaurants", title: "Restaurants: Lunch", tank_unlock_cents: 8500 }),
    ],
  });
  const store = loadStoreWithMock(mock);
  const cats = (await store.getBudgetState(WS, 7)).categories;
  assert.deepEqual(cats.map(c => c.name), ["Restaurants", "Gifts"]); // creation order, not tank order
  assert.equal(cats[0].budget_cents, 8000);   // both Restaurants items roll up
  assert.equal(cats[0].count, 2);
  assert.equal(cats[1].name, "Gifts");
});

test("getBudgetState rolls items up into Monarch-style category groups", async () => {
  const mock = createMockPool({
    bankBalance: 20000,
    settings: { budget_tank: { capacity_source: "prior_period_banked", necessities: [], current_period: { key: "2026-07", capacity_cents: 50000 } } },
    spinsUsage: { period_key: "2026-07", cur_cents: 9000, prior_cents: 0 },
    tankRows: [
      tankRow(1, 5000, 1000, { tank_category: "Restaurants", title: "Restaurants: Dinner", tank_unlock_cents: 5000 }),
      tankRow(2, 3000, 3000, { tank_category: "Restaurants", title: "Restaurants: Lunch", tank_unlock_cents: 8000 }),
      tankRow(3, 6000, 2000, { tank_category: "Gifts", title: "Gifts: Fae", tank_unlock_cents: 14000 }),
    ],
  });
  const store = loadStoreWithMock(mock);
  const cats = (await store.getBudgetState(WS, 7)).categories; // waterline = 9000
  assert.equal(cats.length, 2);
  assert.equal(cats[0].name, "Restaurants");
  assert.equal(cats[0].budget_cents, 8000);     // 5000 + 3000 rolled up
  assert.equal(cats[0].count, 2);
  assert.equal(cats[0].claimable_count, 2);      // both under the 9000 waterline
  assert.equal(cats[0].items[0].item, "Dinner"); // category prefix stripped for nesting
  assert.equal(cats[1].name, "Gifts");
  assert.equal(cats[1].budget_cents, 6000);
  assert.equal(cats[1].unlocked_count, 0);       // 14000 gate is above the waterline
  assert.equal(cats[1].status, "locked");
});

test("conversions raise the tank waterline (they sum into periodBanked)", async () => {
  const mock = createMockPool({
    spinsUsage: { period_key: "2026-07", cur_cents: 1000, prior_cents: 0 },
    convUsage: { cur_cents: 2500, prior_cents: 0 },
  });
  const store = loadStoreWithMock(mock);
  const usage = await store.getTankUsage(WS, { period_type: "month" });
  assert.equal(usage.periodBanked, 3500);
});
