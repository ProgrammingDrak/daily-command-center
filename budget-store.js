/**
 * budget-store.js — Budget Tank engine.
 *
 * Tank blocks ARE slot_rewards rows (kind 'bank_gated', payment_source 'self')
 * carrying the additive tank_* columns, so the same row is a slot-machine
 * objective and a tank block: two claim surfaces, one economy.
 *
 * Money model (all cents):
 *  - Waterline = money banked THIS period (positive slot_spins deltas +
 *    budget_conversions), a monotonic ledger sum. Claims and punishments debit
 *    the spendable reserve (slot_accounts.bank_balance_cents) but never lower
 *    the waterline — a block can be unlocked yet "reserve short".
 *  - tank_unlock_cents = cumulative sum of value_cents from the tank bottom up,
 *    recomputed server-side inside every tank-mutating transaction. It is NOT
 *    unlock_threshold_cents: reserveCostCents() debits max(value, threshold),
 *    so the cumulative gate must live in its own column.
 *  - Capacity above the necessities base = last period's banked total (or a
 *    fixed override), stamped once per period into settings.budget_tank.
 *
 * Depends only on pg-pool and slot-account-common — slot-store imports from
 * here (getTankUsage) in later phases, never the reverse, so no require cycle.
 */

const pool = require("./pg-pool");
const { badRequest, notFound, upsertSlotAccountRow } = require("./slot-account-common");

const DEFAULT_CENTS_PER_POINT = 1;
const MAX_BLOCK_CENTS = 100000000; // $1M sanity cap
const TANK_POSITION_STEP = 1000;

// Same starter numbers the Phase 0 client seeded, so the first server render
// looks familiar. Real values are a minute of inline editing away.
const DEFAULT_NECESSITIES = [
  { id: "rent",      name: "Rent / Housing",    amount_cents: 150000, color: "#22c55e" },
  { id: "groceries", name: "Groceries",         amount_cents: 50000,  color: "#10b981" },
  { id: "utils",     name: "Utilities & Phone", amount_cents: 30000,  color: "#14b8a6" },
  { id: "transport", name: "Transportation",    amount_cents: 25000,  color: "#06b6d4" },
  { id: "insurance", name: "Insurance",         amount_cents: 20000,  color: "#0ea5e9" },
];

const BLOCK_PALETTE = ["#f59e0b", "#a78bfa", "#ec4899", "#f43f5e", "#6366f1", "#14b8a6", "#84cc16", "#fb923c"];

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isHexColor(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

function normalizeNecessities(list) {
  if (!Array.isArray(list)) return DEFAULT_NECESSITIES.map(n => ({ ...n }));
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || "").trim().slice(0, 80);
    if (!name) continue;
    out.push({
      id: String(raw.id || "").trim() || "nec-" + (out.length + 1),
      name,
      amount_cents: clampInt(raw.amount_cents ?? raw.amountCents ?? raw.amount, 0, MAX_BLOCK_CENTS),
      color: isHexColor(raw.color) ? raw.color.trim() : BLOCK_PALETTE[out.length % BLOCK_PALETTE.length],
    });
  }
  return out;
}

function normalizeCurrentPeriod(raw) {
  if (!raw || typeof raw !== "object" || !raw.key) return null;
  return {
    key: String(raw.key),
    capacity_cents: clampInt(raw.capacity_cents, 0, MAX_BLOCK_CENTS),
    started_at: raw.started_at || null,
  };
}

function normalizeBudgetTankSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const periodType = src.period_type === "week" ? "week" : "month";
  const capacitySource = src.capacity_source === "fixed" ? "fixed" : "prior_period_banked";
  return {
    income_cents: clampInt(src.income_cents ?? 310000, 0, MAX_BLOCK_CENTS),
    necessities: normalizeNecessities(src.necessities),
    period_type: periodType,
    capacity_source: capacitySource,
    fixed_capacity_cents: clampInt(src.fixed_capacity_cents ?? 0, 0, MAX_BLOCK_CENTS),
    cents_per_point: clampInt(src.cents_per_point ?? DEFAULT_CENTS_PER_POINT, 1, 1000),
    // "tank" = the Bank Builder monthly goal follows the tank capacity, so the
    // pacing curve paces toward filling the tank; "manual" keeps the account's
    // own monthly_goal_cents.
    goal_mode: src.goal_mode === "manual" ? "manual" : "tank",
    current_period: normalizeCurrentPeriod(src.current_period),
  };
}

// The Bank Builder goal the tank drives (0 = don't drive; caller falls back to
// the account's monthly_goal_cents). Only a monthly tank drives the monthly
// goal — a weekly tank's capacity is the wrong magnitude for the month curve.
function tankDrivenGoalCents(accountSettings) {
  const bt = accountSettings && accountSettings.budget_tank;
  if (!bt || bt.goal_mode === "manual") return 0;
  if ((bt.period_type || "month") !== "month") return 0;
  const cap = bt.current_period && Math.round(Number(bt.current_period.capacity_cents));
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

// Capacity + waterline resolution shared by getBudgetState, claimTankBlock,
// and slot-store's getState (the machine surface must gate identically).
function resolveTankWaterline(settings, usage) {
  const capacityCents = settings.current_period && settings.current_period.key === usage.periodKey
    ? settings.current_period.capacity_cents
    : resolveCapacity(settings, usage);
  return { capacityCents, waterlineCents: Math.min(usage.periodBanked, capacityCents) };
}

function necessitiesTotalCents(settings) {
  return (settings.necessities || []).reduce((sum, n) => sum + (n.amount_cents || 0), 0);
}

async function saveBudgetTankSettings(workspaceId, budgetTank, exec = pool) {
  await exec.query(
    `UPDATE slot_accounts
        SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
      WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify({ budget_tank: budgetTank })]
  );
}

// ── Waterline ────────────────────────────────────────────────────────────────
// Period windows follow getBankUsage's convention: DB clock, date_trunc bounds.
// period_type is validated to a literal before it touches SQL.
const PERIOD_SQL = {
  month: { trunc: "date_trunc('month', NOW())", interval: "INTERVAL '1 month'", keyExpr: "to_char(date_trunc('month', NOW()), 'YYYY-MM')" },
  week:  { trunc: "date_trunc('week', NOW())",  interval: "INTERVAL '1 week'",  keyExpr: "to_char(date_trunc('week', NOW()), 'IYYY\"-W\"IW')" },
};

async function getTankUsage(workspaceId, settings = {}, exec = pool) {
  const p = PERIOD_SQL[settings.period_type === "week" ? "week" : "month"];
  const { rows: [spins] } = await exec.query(
    `SELECT ${p.keyExpr} AS period_key,
            COALESCE(SUM(bank_delta_cents) FILTER (WHERE created_at >= ${p.trunc}), 0)::int AS cur_cents,
            COALESCE(SUM(bank_delta_cents) FILTER (WHERE created_at >= ${p.trunc} - ${p.interval}
                                                     AND created_at <  ${p.trunc}), 0)::int AS prior_cents
       FROM slot_spins
      WHERE workspace_id = $1 AND status IN ('pending','confirmed') AND bank_delta_cents > 0`,
    [workspaceId]
  );
  const { rows: [conv] } = await exec.query(
    `SELECT COALESCE(SUM(cents) FILTER (WHERE created_at >= ${p.trunc}), 0)::int AS cur_cents,
            COALESCE(SUM(cents) FILTER (WHERE created_at >= ${p.trunc} - ${p.interval}
                                          AND created_at <  ${p.trunc}), 0)::int AS prior_cents
       FROM budget_conversions
      WHERE workspace_id = $1`,
    [workspaceId]
  );
  return {
    periodKey: spins.period_key,
    periodBanked: (spins.cur_cents || 0) + (conv.cur_cents || 0),
    priorPeriodBanked: (spins.prior_cents || 0) + (conv.prior_cents || 0),
  };
}

// Spendable reserve = confirmed balance + pending bank-builder deposits.
// Mirrors slot-store's getPendingBankDeposit so both surfaces agree.
async function getFunding(workspaceId, account, exec = pool) {
  const { rows: [pending] } = await exec.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
       FROM slot_spins
      WHERE workspace_id = $1
        AND status = 'pending'
        AND bank_delta_cents > 0
        AND bank_reserved_cents = 0
        AND (reward_snapshot->>'kind' = 'bank_builder'
             OR reward_snapshot->>'source_type' = 'slot_screen_bank_builder')`,
    [workspaceId]
  );
  const ready = (account && account.bank_balance_cents) || 0;
  return { ready, pending: pending.cents || 0, total: ready + (pending.cents || 0) };
}

// ── Thresholds ───────────────────────────────────────────────────────────────
// Single source of truth for the bottom-up cumulative gate. Runs inside the
// caller's transaction so order + thresholds commit atomically.
async function recomputeTankThresholds(client, workspaceId) {
  const { rows } = await client.query(
    `UPDATE slot_rewards r
        SET tank_unlock_cents = c.cum, updated_at = NOW()
       FROM (SELECT id, SUM(value_cents) OVER (ORDER BY tank_position ASC, id ASC)::int AS cum
               FROM slot_rewards
              WHERE workspace_id = $1 AND tank_position IS NOT NULL AND deleted_at IS NULL) c
      WHERE r.id = c.id AND r.workspace_id = $1
      RETURNING r.id`,
    [workspaceId]
  );
  return rows.length;
}

// ── Blocks ───────────────────────────────────────────────────────────────────
async function getTankBlockRows(workspaceId, exec = pool) {
  const { rows } = await exec.query(
    `SELECT * FROM slot_rewards
      WHERE workspace_id = $1 AND tank_position IS NOT NULL AND deleted_at IS NULL
      ORDER BY tank_position ASC, id ASC`,
    [workspaceId]
  );
  return rows;
}

function decorateBlock(row, usage, funding, waterlineCents) {
  const unlockCents = row.tank_unlock_cents || 0;
  const valueCents = row.value_cents || 0;
  const claimed = !!row.tank_claimed_period && row.tank_claimed_period === usage.periodKey;
  const unlocked = waterlineCents >= unlockCents;
  const affordable = (funding.total || 0) >= valueCents;
  const claimable = unlocked && affordable && !claimed && !!row.active;
  return {
    id: row.id,
    title: row.title,
    category: row.tank_category || null,
    color: row.tank_color || null,
    value_cents: valueCents,
    tank_position: row.tank_position,
    tank_unlock_cents: unlockCents,
    tank_recurring: !!row.tank_recurring,
    tank_claimed_period: row.tank_claimed_period || null,
    active: !!row.active,
    kind: row.kind,
    duration_minutes: Math.max(0, parseInt(row.duration_minutes, 10) || 0),
    uses_remaining: row.uses_remaining != null ? Number(row.uses_remaining) : null,
    claimed,
    unlocked,
    claimable,
    // Locked: how much more must be banked. Unlocked-but-short: reserve gap.
    needs_cents: unlocked ? 0 : Math.max(0, unlockCents - waterlineCents),
    shortfall_cents: unlocked && !claimed ? Math.max(0, valueCents - (funding.total || 0)) : 0,
    status: claimed ? "claimed"
      : !unlocked ? "locked"
      : claimable ? "claimable"
      : "short",
  };
}

function normalizeBlockInput(body = {}) {
  const category = String(body.category ?? body.tank_category ?? "").trim().slice(0, 60);
  const item = String(body.item ?? body.label ?? "").trim().slice(0, 120);
  const explicitTitle = String(body.title ?? "").trim().slice(0, 180);
  const title = explicitTitle || (category && item ? category + ": " + item : category || item);
  if (!title) throw badRequest("A block needs a category or a label");
  const cents = clampInt(
    body.value_cents ?? body.amount_cents ?? (body.amount != null ? Math.round(Number(body.amount) * 100) : NaN),
    0, MAX_BLOCK_CENTS
  );
  if (!(cents > 0)) throw badRequest("A block needs a positive amount");
  const recurring = body.recurring === true || body.recurring === "true" || body.tank_recurring === true;
  return {
    title,
    category: category || null,
    color: isHexColor(body.color) ? String(body.color).trim() : null,
    value_cents: cents,
    recurring,
    duration_minutes: clampInt(body.duration_minutes ?? body.durationMinutes ?? 0, 0, 1440),
  };
}

async function addTankBlock(workspaceId, userId, body) {
  const b = normalizeBlockInput(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [mx] } = await client.query(
      `SELECT COALESCE(MAX(tank_position), 0) + ${TANK_POSITION_STEP} AS next,
              COUNT(*)::int AS count
         FROM slot_rewards
        WHERE workspace_id = $1 AND tank_position IS NOT NULL AND deleted_at IS NULL`,
      [workspaceId]
    );
    const position = Number(mx && mx.next) || TANK_POSITION_STEP;
    const color = b.color || BLOCK_PALETTE[(Number(mx && mx.count) || 0) % BLOCK_PALETTE.length];
    const { rows: [row] } = await client.query(
      `INSERT INTO slot_rewards
         (workspace_id, title, kind, sponsor_type, sponsor_splits, weight, chance_shares,
          payment_source, tier_id, active, sponsor_active, value_cents, bank_delta_cents,
          duration_minutes, requires_confirmation, cooldown_days, unlock_threshold_cents,
          notes, uses_remaining, sort_order, owner_user_id, created_by_user_id,
          tank_position, tank_unlock_cents, tank_category, tank_color, tank_recurring)
       VALUES ($1, $2, 'bank_gated', 'self', '[]', 1, 1,
               'self', 'tier_i', TRUE, TRUE, $3, 0,
               $4, FALSE, 0, 0,
               '', $5, $6, $7, $7,
               $6, 0, $8, $9, $10)
       RETURNING *`,
      [workspaceId, b.title, b.value_cents, b.duration_minutes,
       b.recurring ? null : 1, position, userId || null, b.category, color, b.recurring]
    );
    await recomputeTankThresholds(client, workspaceId);
    await client.query("COMMIT");
    return row;
  } catch (e) {
    await client.query("ROLLBACK");
    if (e && e.code === "23505") throw badRequest("A reward with that title already exists");
    throw e;
  } finally {
    client.release();
  }
}

async function updateTankBlock(workspaceId, id, body) {
  const rewardId = parseInt(id, 10);
  if (!Number.isFinite(rewardId)) throw badRequest("Invalid block id");
  const b = normalizeBlockInput(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      `UPDATE slot_rewards
          SET title = $3, value_cents = $4, duration_minutes = $5,
              tank_category = $6, tank_color = COALESCE($7, tank_color),
              tank_recurring = $8,
              uses_remaining = CASE WHEN $8 THEN NULL ELSE COALESCE(uses_remaining, 1) END,
              updated_at = NOW()
        WHERE workspace_id = $1 AND id = $2 AND tank_position IS NOT NULL AND deleted_at IS NULL
        RETURNING *`,
      [workspaceId, rewardId, b.title, b.value_cents, b.duration_minutes, b.category, b.color, b.recurring]
    );
    if (!row) throw notFound("Tank block not found");
    await recomputeTankThresholds(client, workspaceId);
    await client.query("COMMIT");
    return row;
  } catch (e) {
    await client.query("ROLLBACK");
    if (e && e.code === "23505") throw badRequest("A reward with that title already exists");
    throw e;
  } finally {
    client.release();
  }
}

// Remove from the tank. keepReward leaves the row in the slot catalog;
// otherwise soft-delete it the same way slot-store's deleteReward does.
async function removeTankBlock(workspaceId, id, { keepReward = false } = {}) {
  const rewardId = parseInt(id, 10);
  if (!Number.isFinite(rewardId)) throw badRequest("Invalid block id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      keepReward
        ? `UPDATE slot_rewards
              SET tank_position = NULL, tank_unlock_cents = 0, updated_at = NOW()
            WHERE workspace_id = $1 AND id = $2 AND tank_position IS NOT NULL AND deleted_at IS NULL
            RETURNING id`
        : `UPDATE slot_rewards
              SET tank_position = NULL, tank_unlock_cents = 0,
                  active = FALSE, weight = 0, deleted_at = NOW(), updated_at = NOW()
            WHERE workspace_id = $1 AND id = $2 AND tank_position IS NOT NULL AND deleted_at IS NULL
            RETURNING id`,
      [workspaceId, rewardId]
    );
    if (!row) throw notFound("Tank block not found");
    await recomputeTankThresholds(client, workspaceId);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Persist a drag order. Mirrors slot-store's reorderRewards (write positions,
// renumber the whole tank on collision), then recompute the cumulative gates —
// order and thresholds always move together.
async function reorderTank(workspaceId, items) {
  const list = (Array.isArray(items) ? items : [])
    .map(it => ({ id: parseInt(it && it.id, 10), tank_position: Number(it && (it.tank_position ?? it.position)) }))
    .filter(it => Number.isFinite(it.id) && Number.isFinite(it.tank_position));
  if (!list.length) return { reordered: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of list) {
      await client.query(
        `UPDATE slot_rewards SET tank_position = $3, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2 AND tank_position IS NOT NULL AND deleted_at IS NULL`,
        [workspaceId, item.id, item.tank_position]
      );
    }
    const sorted = [...list].sort((a, b) => a.tank_position - b.tank_position);
    let needsRebalance = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].tank_position - sorted[i - 1].tank_position < 0.001) { needsRebalance = true; break; }
    }
    if (needsRebalance) {
      const { rows: tank } = await client.query(
        `SELECT id FROM slot_rewards
          WHERE workspace_id = $1 AND tank_position IS NOT NULL AND deleted_at IS NULL
          ORDER BY tank_position ASC, id ASC`,
        [workspaceId]
      );
      for (let i = 0; i < tank.length; i++) {
        await client.query(
          `UPDATE slot_rewards SET tank_position = $3, updated_at = NOW() WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, tank[i].id, (i + 1) * TANK_POSITION_STEP]
        );
      }
    }
    await recomputeTankThresholds(client, workspaceId);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { reordered: list.length };
}

// ── Claim ────────────────────────────────────────────────────────────────────
// Modeled on slot-store's claimBankrollGoalReward: row FOR UPDATE, sweep
// pending bank builders so fresh deposits count, gate checks against a
// transaction-consistent waterline, debit value_cents (NEVER the cumulative
// tank_unlock_cents), stamp the claim period. The pending-builder sweep is
// injected by the route (from slot-store) to keep the dependency direction
// slot-store -> budget-store only.
async function claimTankBlock(workspaceId, userId, id, { sweepPendingBankBuilders } = {}) {
  const rewardId = parseInt(id, 10);
  if (!Number.isFinite(rewardId)) throw badRequest("Invalid block id");
  await upsertSlotAccountRow(pool, workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      `SELECT * FROM slot_rewards
        WHERE workspace_id = $1 AND id = $2 AND tank_position IS NOT NULL AND deleted_at IS NULL
        FOR UPDATE`,
      [workspaceId, rewardId]
    );
    if (!row) throw notFound("Tank block not found");
    if (!row.active) throw badRequest("That block is inactive");
    if (typeof sweepPendingBankBuilders === "function") {
      await sweepPendingBankBuilders(client, workspaceId);
    }
    const { rows: [account] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id = $1 FOR UPDATE",
      [workspaceId]
    );
    const settings = normalizeBudgetTankSettings(account && account.settings && account.settings.budget_tank);
    const usage = await getTankUsage(workspaceId, settings, client);
    if (row.tank_claimed_period === usage.periodKey) {
      // Already claimed this period — idempotent no-op; the route re-enqueues
      // with the same sourceId and gets the existing queue item back.
      await client.query("ROLLBACK");
      return { claimed: false, duplicate: true, block: row, period_key: usage.periodKey };
    }
    const { waterlineCents } = resolveTankWaterline(settings, usage);
    if (waterlineCents < (row.tank_unlock_cents || 0)) {
      throw badRequest("The waterline hasn't reached that block yet — needs " +
        "$" + (((row.tank_unlock_cents || 0) - waterlineCents) / 100).toFixed(2) + " more banked");
    }
    const priceCents = row.value_cents || 0;
    if (((account && account.bank_balance_cents) || 0) < priceCents) {
      throw badRequest("Not enough Reward Reserve for that block");
    }
    await client.query(
      `UPDATE slot_accounts
          SET bank_balance_cents = GREATEST(0, bank_balance_cents - $2), updated_at = NOW()
        WHERE workspace_id = $1`,
      [workspaceId, priceCents]
    );
    const { rows: [updated] } = await client.query(
      `UPDATE slot_rewards
          SET tank_claimed_period = $3, last_won_at = NOW(),
              uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE GREATEST(uses_remaining - 1, 0) END,
              updated_at = NOW()
        WHERE workspace_id = $1 AND id = $2
        RETURNING *`,
      [workspaceId, rewardId, usage.periodKey]
    );
    await client.query("COMMIT");
    return { claimed: true, block: updated, period_key: usage.periodKey, debited_cents: priceCents };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── Config + state ───────────────────────────────────────────────────────────
async function updateBudgetConfig(workspaceId, userId, body = {}) {
  const account = await upsertSlotAccountRow(pool, workspaceId, userId);
  const current = normalizeBudgetTankSettings(account.settings && account.settings.budget_tank);
  const next = normalizeBudgetTankSettings({
    ...current,
    ...(body.income_cents != null || body.incomeCents != null ? { income_cents: body.income_cents ?? body.incomeCents } : {}),
    ...(body.necessities != null ? { necessities: body.necessities } : {}),
    ...(body.period_type != null || body.periodType != null ? { period_type: body.period_type ?? body.periodType } : {}),
    ...(body.capacity_source != null || body.capacitySource != null ? { capacity_source: body.capacity_source ?? body.capacitySource } : {}),
    ...(body.fixed_capacity_cents != null || body.fixedCapacityCents != null ? { fixed_capacity_cents: body.fixed_capacity_cents ?? body.fixedCapacityCents } : {}),
    ...(body.cents_per_point != null || body.centsPerPoint != null ? { cents_per_point: body.cents_per_point ?? body.centsPerPoint } : {}),
    ...(body.goal_mode != null || body.goalMode != null ? { goal_mode: body.goal_mode ?? body.goalMode } : {}),
    current_period: current.current_period, // server-stamped only; never client-set
  });
  await saveBudgetTankSettings(workspaceId, next);
  return next;
}

async function getInvestments(workspaceId, exec = pool) {
  const { rows } = await exec.query(
    `SELECT period_key, amount_cents, task_block_id, created_at
       FROM budget_investments
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 24`,
    [workspaceId]
  );
  const total = rows.reduce((sum, r) => sum + (r.amount_cents || 0), 0);
  const { rows: [all] } = await exec.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS total FROM budget_investments WHERE workspace_id = $1`,
    [workspaceId]
  );
  return { total_cents: (all && all.total) || total, entries: rows };
}

function resolveCapacity(settings, usage) {
  return settings.capacity_source === "fixed"
    ? settings.fixed_capacity_cents
    : usage.priorPeriodBanked;
}

async function getBudgetState(workspaceId, userId) {
  const account = await upsertSlotAccountRow(pool, workspaceId, userId);
  let settings = normalizeBudgetTankSettings(account.settings && account.settings.budget_tank);
  const usage = await getTankUsage(workspaceId, settings);

  // First run: stamp the period silently (nothing to sweep). A later period
  // MISMATCH is never auto-resolved — the user chooses fresh vs carry at
  // rollover (Phase 5), so we only flag it here.
  let rolloverDue = false;
  if (!settings.current_period) {
    settings = {
      ...settings,
      current_period: {
        key: usage.periodKey,
        capacity_cents: resolveCapacity(settings, usage),
        started_at: new Date().toISOString(),
      },
    };
    await saveBudgetTankSettings(workspaceId, settings);
  } else if (settings.current_period.key !== usage.periodKey) {
    rolloverDue = true;
  }

  const { capacityCents, waterlineCents } = resolveTankWaterline(settings, usage);
  const funding = await getFunding(workspaceId, account);
  const rows = await getTankBlockRows(workspaceId);
  const blocks = rows.map(r => decorateBlock(r, usage, funding, waterlineCents));
  const allocatedCents = blocks.reduce((sum, b) => sum + b.value_cents, 0);
  const investments = await getInvestments(workspaceId);

  return {
    settings,
    blocks,
    usage: {
      period_key: usage.periodKey,
      period_banked_cents: usage.periodBanked,
      prior_period_banked_cents: usage.priorPeriodBanked,
      capacity_cents: capacityCents,
      waterline_cents: waterlineCents,
      allocated_cents: allocatedCents,
      unallocated_cents: Math.max(0, capacityCents - allocatedCents),
      necessities_total_cents: necessitiesTotalCents(settings),
    },
    funding,
    investments,
    points: account.point_balance || 0,
    rollover_due: rolloverDue,
    constants: {
      cents_per_point: settings.cents_per_point,
    },
  };
}

module.exports = {
  DEFAULT_CENTS_PER_POINT,
  normalizeBudgetTankSettings,
  necessitiesTotalCents,
  tankDrivenGoalCents,
  resolveTankWaterline,
  getTankUsage,
  getFunding,
  claimTankBlock,
  recomputeTankThresholds,
  getTankBlockRows,
  addTankBlock,
  updateTankBlock,
  removeTankBlock,
  reorderTank,
  updateBudgetConfig,
  getInvestments,
  getBudgetState,
};
