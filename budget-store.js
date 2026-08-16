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

// Legacy storage default. `cents_per_point` is retained in saved settings and
// conversion rows so older data stays readable, but new conversions are quoted
// in canonical Bank Units instead of taking an independently configured rate.
const DEFAULT_CENTS_PER_POINT = 1;
const BANK_UNIT_BUDGET_PERCENT = 0.0015;
const BANK_UNIT_PACING_GAMMA = 0.80;
const BANK_UNIT_FINAL_WEEK_GAMMA = 0.20;
const BANK_UNIT_SHIELD_REMAINDER_FRAC = 0.020;
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

// Canonical consumer-card taxonomy for discretionary purchases. Categories are
// rollups, never envelopes: the user enters the concrete thing they want to buy
// and this classifier places it. Rules are intentionally plain and inspectable
// so the same contract can be reused by imports from a card feed later.
const CREDIT_CARD_CATEGORIES = [
  { id: "dining", label: "Dining", color: "#f97316", aliases: ["restaurant", "restaurants", "food & dining"], keywords: ["dinner", "lunch", "brunch", "breakfast", "restaurant", "cafe", "coffee", "bar", "takeout", "delivery", "doordash", "uber eats", "grubhub", "pizza"] },
  { id: "groceries", label: "Groceries", color: "#22c55e", aliases: ["grocery"], keywords: ["grocer", "supermarket", "whole foods", "trader joe", "costco", "market", "food shop"] },
  { id: "travel", label: "Travel", color: "#0ea5e9", aliases: ["vacation"], keywords: ["flight", "airfare", "airline", "hotel", "resort", "airbnb", "vacation", "trip", "cruise", "luggage"] },
  { id: "transportation", label: "Transportation", color: "#06b6d4", aliases: ["transit", "gas", "fuel"], keywords: ["uber", "lyft", "taxi", "train", "subway", "bus", "parking", "toll", "gas", "fuel", "car", "auto", "vehicle", "bike"] },
  { id: "entertainment", label: "Entertainment", color: "#a855f7", aliases: ["fun"], keywords: ["movie", "cinema", "concert", "show", "theater", "theatre", "game", "museum", "festival", "ticket", "streaming", "netflix", "spotify"] },
  { id: "shopping", label: "Shopping", color: "#ec4899", aliases: ["merchandise"], keywords: ["clothes", "clothing", "shoes", "amazon", "electronics", "furniture", "decor", "book", "gear", "shopping"] },
  { id: "health", label: "Health & Wellness", color: "#10b981", aliases: ["health", "medical", "fitness"], keywords: ["doctor", "dentist", "therapy", "therapist", "pharmacy", "medicine", "medical", "gym", "fitness", "massage", "wellness"] },
  { id: "personal", label: "Personal Care", color: "#e879f9", aliases: ["beauty"], keywords: ["hair", "haircut", "salon", "spa", "nails", "skincare", "cosmetic", "barber", "personal care"] },
  { id: "home", label: "Home", color: "#84cc16", aliases: ["home improvement", "household"], keywords: ["home", "house", "appliance", "hardware", "garden", "repair", "cleaning", "household"] },
  { id: "gifts", label: "Gifts & Donations", color: "#f43f5e", aliases: ["gift", "gifts", "donation", "charity"], keywords: ["gift", "present", "donation", "charity", "birthday", "wedding"] },
  { id: "pets", label: "Pets", color: "#f59e0b", aliases: ["pet"], keywords: ["pet", "vet", "veterinary", "dog", "cat", "pet food", "grooming"] },
  { id: "bills", label: "Bills & Utilities", color: "#64748b", aliases: ["utilities", "bills", "subscriptions"], keywords: ["phone", "internet", "utility", "electric", "water bill", "insurance", "subscription", "membership"] },
  { id: "other", label: "Other", color: "#94a3b8", aliases: ["misc", "miscellaneous"], keywords: [] },
];

function normalizedCategoryText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
}

function categoryByName(value) {
  const wanted = normalizedCategoryText(value);
  if (!wanted) return null;
  return CREDIT_CARD_CATEGORIES.find(category =>
    normalizedCategoryText(category.id) === wanted ||
    normalizedCategoryText(category.label) === wanted ||
    category.aliases.some(alias => normalizedCategoryText(alias) === wanted)
  ) || null;
}

function categorizePurchase(description, requestedCategory) {
  const requested = categoryByName(requestedCategory);
  if (requested) return requested;
  const text = normalizedCategoryText(description);
  const matched = CREDIT_CARD_CATEGORIES.find(category =>
    category.id !== "other" && category.keywords.some(keyword => text.includes(normalizedCategoryText(keyword)))
  );
  return matched || CREDIT_CARD_CATEGORIES[CREDIT_CARD_CATEGORIES.length - 1];
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isHexColor(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

// Shapes a necessity's reef decoration can take (front-end SPRITES keys).
const TANK_SHAPES = ["chest", "gift", "star", "heart", "castle", "coral", "plant", "rocks", "shell"];
const DEFAULT_NEC_SHAPES = ["castle", "coral", "plant", "rocks", "shell"];

function normalizeNecessities(list) {
  if (!Array.isArray(list)) return DEFAULT_NECESSITIES.map((n, i) => ({ ...n, shape: DEFAULT_NEC_SHAPES[i % DEFAULT_NEC_SHAPES.length] }));
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
      shape: TANK_SHAPES.includes(raw.shape) ? raw.shape : DEFAULT_NEC_SHAPES[out.length % DEFAULT_NEC_SHAPES.length],
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
  // "last_income" = the tank budget is the income you earned last period (a
  // figure you state); "prior_period_banked" = auto-derive it from what your
  // bank build actually banked last period; "fixed" = a set number.
  const capacitySource = ["last_income", "prior_period_banked", "fixed"].includes(src.capacity_source)
    ? src.capacity_source
    : "last_income";
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

// Canonical value of one Bank Unit. The Money Changer owns this quote and games
// consume it rather than inventing their own dollar scale. The curve is the
// existing budget-aware Bank Builder curve, now promoted to a shared economy
// primitive: it starts from the discretionary goal, tapers with remaining
// headroom, and gets the established final-week/shield treatment.
function quoteBankUnit({ goalCents, bankedCents = 0, finalWeek = false } = {}) {
  const goal = clampInt(goalCents, 100, MAX_BLOCK_CENTS);
  const banked = Math.max(0, Math.round(Number(bankedCents) || 0));
  const remaining = Math.max(0, goal - banked);
  const inShield = remaining <= 0;
  const gamma = finalWeek ? BANK_UNIT_FINAL_WEEK_GAMMA : BANK_UNIT_PACING_GAMMA;
  const pacingRemaining = inShield ? goal * BANK_UNIT_SHIELD_REMAINDER_FRAC : remaining;
  const pacingBaseCents = Math.pow(goal, 1 - gamma) * Math.pow(pacingRemaining, gamma);
  const rawUnitCents = pacingBaseCents * BANK_UNIT_BUDGET_PERCENT;
  return {
    units_per_point: 1,
    cents: Math.max(1, Math.floor(rawUnitCents)),
    raw_cents: rawUnitCents,
    goal_cents: goal,
    banked_cents: banked,
    remaining_cents: remaining,
    pacing_base_cents: Math.floor(pacingBaseCents),
    final_week: !!finalWeek,
    in_shield: inShield,
    budget_percent: BANK_UNIT_BUDGET_PERCENT,
  };
}

function isFinalPeriodWeek(periodType, now = new Date()) {
  if (periodType === "week") return now.getDay() === 0;
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return now.getDate() > daysInMonth - 7;
}

function quoteBankUnitForTank(accountSettings = {}, usage = {}, fallback = {}) {
  const hasTank = !!(accountSettings && accountSettings.budget_tank);
  if (!hasTank) {
    return quoteBankUnit({
      goalCents: fallback.goalCents,
      bankedCents: fallback.bankedCents,
      finalWeek: fallback.finalWeek,
    });
  }
  const settings = normalizeBudgetTankSettings(accountSettings.budget_tank);
  const tank = resolveTankWaterline(settings, usage);
  return quoteBankUnit({
    goalCents: tank.capacityCents || fallback.goalCents,
    bankedCents: tank.waterlineCents,
    finalWeek: isFinalPeriodWeek(settings.period_type),
  });
}

// The Bank Builder goal the tank drives (0 = don't drive; caller falls back to
// the account's monthly_goal_cents). Only a monthly tank drives the monthly
// goal — a weekly tank's capacity is the wrong magnitude for the month curve.
function tankDrivenGoalCents(accountSettings) {
  const bt = accountSettings && accountSettings.budget_tank;
  if (!bt || bt.goal_mode === "manual") return 0;
  if ((bt.period_type || "month") !== "month") return 0;
  // The Bank Builder paces toward filling the DISCRETIONARY tank
  // (gross - necessities), which is what the waterline caps at.
  let gross;
  if (bt.capacity_source === "last_income") gross = Math.round(Number(bt.income_cents));
  else if (bt.capacity_source === "fixed") gross = Math.round(Number(bt.fixed_capacity_cents));
  else gross = bt.current_period && Math.round(Number(bt.current_period.capacity_cents));
  const necessities = (Array.isArray(bt.necessities) ? bt.necessities : []).reduce((s, n) => s + (Number(n && n.amount_cents) || 0), 0);
  const cap = Math.max(0, (Number.isFinite(gross) ? gross : 0) - necessities);
  return cap > 0 ? cap : 0;
}

// Capacity + waterline resolution shared by getBudgetState, claimTankBlock,
// and slot-store's getState (the machine surface must gate identically).
//
// Two figures: GROSS = last period's income (the whole tank); DISCRETIONARY =
// gross - necessities (the fillable budget for reward blocks). Necessities are
// the submerged decorative base, always covered; the bank-build waterline and
// the reward blocks live only in the discretionary zone above them. So a $2000
// income with $1300 of necessities leaves a $700 tank to allocate.
//
// prior_period_banked uses the gross stamped at rollover so it can't drift
// mid-period; stated income / fixed are stable figures resolved live, so
// editing "Income from last month" resizes the current tank immediately.
function resolveTankWaterline(settings, usage) {
  const grossCents = settings.capacity_source === "prior_period_banked"
    ? (settings.current_period && settings.current_period.key === usage.periodKey
        ? settings.current_period.capacity_cents
        : resolveCapacity(settings, usage))
    : resolveCapacity(settings, usage);
  const necessitiesCents = necessitiesTotalCents(settings);
  const capacityCents = Math.max(0, grossCents - necessitiesCents); // discretionary budget
  return {
    grossCents,
    necessitiesCents,
    capacityCents,
    waterlineCents: Math.min(usage.periodBanked, capacityCents),
  };
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
// The tank is the user's free priority order: items fill bottom-up strictly by
// tank_position, independent of category. This cumulative gate — recomputed
// inside the caller's transaction — is what the waterline unlocks against. The
// budget ledger's grouping/order is a separate concern (see buildCategories).
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
// Tank order = tank_position (the user's drag priority).
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
  const storedCategory = row.tank_category || "";
  const cardCategory = categorizePurchase(row.title, storedCategory);
  return {
    id: row.id,
    title: row.title,
    category: cardCategory.label,
    category_id: cardCategory.id,
    // The item label without the "Category: " prefix, for nesting under a header.
    item: storedCategory && String(row.title || "").indexOf(storedCategory + ": ") === 0
      ? String(row.title).slice(storedCategory.length + 2)
      : row.title,
    color: cardCategory.color,
    shape: row.tank_shape || null,
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

// Roll items up into Monarch/Mint-style category groups for the STANDALONE
// budget ledger. This is divorced from the tank's order: categories sort by
// creation (their earliest item's id) and items by id, so reordering the tank
// never reshuffles the budget. Each item's funded amount is computed from its
// own tank threshold and summed, so the rollup is correct even though the
// category's items may be scattered anywhere in the tank's free order.
function buildCategories(blocks, waterlineCents) {
  const cats = [];
  const byKey = new Map();
  for (const b of blocks) {
    const name = (b.category || b.title || "").trim() || "Other";
    const key = name.toLowerCase();
    let cat = byKey.get(key);
    if (!cat) {
      cat = { key, name, color: b.color || null, items: [], budget_cents: 0, funded_cents: 0,
        min_id: b.id, unlocked_count: 0, claimable_count: 0, claimed_count: 0 };
      byKey.set(key, cat);
      cats.push(cat);
    }
    cat.items.push(b);
    cat.budget_cents += b.value_cents;
    const itemBottom = (b.tank_unlock_cents || 0) - b.value_cents;
    cat.funded_cents += Math.max(0, Math.min(waterlineCents - itemBottom, b.value_cents));
    cat.min_id = Math.min(cat.min_id, b.id);
    if (b.unlocked) cat.unlocked_count++;
    if (b.claimable) cat.claimable_count++;
    if (b.claimed) cat.claimed_count++;
    if (!cat.color && b.color) cat.color = b.color;
  }
  const categoryOrder = new Map(CREDIT_CARD_CATEGORIES.map((category, index) => [category.label.toLowerCase(), index]));
  cats.sort((a, b) =>
    (categoryOrder.get(a.name.toLowerCase()) ?? 999) - (categoryOrder.get(b.name.toLowerCase()) ?? 999) ||
    a.min_id - b.min_id
  );
  for (const c of cats) {
    c.items.sort((x, y) => x.id - y.id);
    c.count = c.items.length;
    c.fill_frac = c.budget_cents > 0 ? c.funded_cents / c.budget_cents : 0;
    c.status = c.count && c.claimed_count === c.count ? "claimed"
      : c.claimable_count > 0 ? "claimable"
      : c.unlocked_count > 0 ? "partial"
      : "locked";
  }
  return cats;
}

function normalizeBlockInput(body = {}) {
  const requestedCategory = String(body.category ?? body.tank_category ?? "").trim().slice(0, 60);
  const item = String(body.item ?? body.description ?? body.label ?? "").trim().slice(0, 120);
  const explicitTitle = String(body.title ?? "").trim().slice(0, 180);
  const description = item || explicitTitle || requestedCategory;
  if (!description) throw badRequest("A planned purchase needs a description");
  const cardCategory = categorizePurchase(description, requestedCategory);
  const titlePrefix = description.match(/^([^:]+):\s*(.+)$/);
  const cleanDescription = titlePrefix && categoryByName(titlePrefix[1]) ? titlePrefix[2].trim() : description;
  const legacyCategoryEnvelope = !item && !explicitTitle && !!requestedCategory;
  const title = legacyCategoryEnvelope ? cardCategory.label : cardCategory.label + ": " + cleanDescription;
  const cents = clampInt(
    body.value_cents ?? body.amount_cents ?? (body.amount != null ? Math.round(Number(body.amount) * 100) : NaN),
    0, MAX_BLOCK_CENTS
  );
  if (!(cents > 0)) throw badRequest("A planned purchase needs a positive amount");
  const recurring = body.recurring === true || body.recurring === "true" || body.tank_recurring === true;
  return {
    title,
    category: cardCategory.label,
    category_id: cardCategory.id,
    color: isHexColor(body.color) ? String(body.color).trim() : cardCategory.color,
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

// ── Money Changer ────────────────────────────────────────────────────────────
// One point -> one Bank Unit at the Money Changer's current budget-aware quote.
// This is the safe floor to the casino. Idempotency arbiter is the slot_point_ledger
// unique index (workspace, source_type, source_key) — the earnTaskCredit
// pattern — so a retried POST can never double-debit. Conversions land in
// budget_conversions (raising the tank waterline), NEVER in slot_spins, so
// Bank Builder pacing/shield/head-start sums stay clean.
async function convertPointsToBank(workspaceId, userId, { points, source_key } = {}) {
  const pts = parseInt(points, 10);
  if (!Number.isFinite(pts) || pts < 1) throw badRequest("points must be a positive integer");
  if (pts > 1000000) throw badRequest("That's too many points at once");
  const sourceKey = String(source_key || "").trim();
  if (!sourceKey) throw badRequest("source_key is required");
  await upsertSlotAccountRow(pool, workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [existing] } = await client.query(
      `SELECT * FROM budget_conversions WHERE workspace_id = $1 AND source_key = $2`,
      [workspaceId, sourceKey]
    );
    if (existing) {
      await client.query("COMMIT");
      return { converted: false, duplicate: true, conversion: existing };
    }
    const { rows: [fresh] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id = $1 FOR UPDATE",
      [workspaceId]
    );
    if (((fresh && fresh.point_balance) || 0) < pts) {
      throw badRequest("Not enough points: you have " + ((fresh && fresh.point_balance) || 0));
    }
    const settings = normalizeBudgetTankSettings(fresh && fresh.settings && fresh.settings.budget_tank);
    const usage = await getTankUsage(workspaceId, settings, client);
    const quote = quoteBankUnitForTank({
      ...(fresh && fresh.settings),
      budget_tank: settings,
    }, usage, {
      goalCents: fresh && fresh.settings && fresh.settings.monthly_goal_cents,
    });
    const bankUnits = pts;
    const rate = quote.cents;
    const cents = bankUnits * rate;
    const { rows: [ledger] } = await client.query(
      `INSERT INTO slot_point_ledger (workspace_id, user_id, delta, source_type, source_key, description, metadata)
       VALUES ($1, $2, $3, 'bank_conversion', $4, $5, $6)
       ON CONFLICT (workspace_id, source_type, source_key) DO NOTHING
       RETURNING id`,
      [workspaceId, userId || null, -pts, sourceKey,
       "Money Changer: " + pts + " pts -> " + bankUnits + " Bank Units -> $" + (cents / 100).toFixed(2),
       JSON.stringify({ bank_units: bankUnits, bank_unit_cents: rate, rate_cents_per_point: rate })]
    );
    if (!ledger) {
      const { rows: [racedConversion] } = await client.query(
        `SELECT * FROM budget_conversions WHERE workspace_id = $1 AND source_key = $2`,
        [workspaceId, sourceKey]
      );
      await client.query("COMMIT");
      return { converted: false, duplicate: true, conversion: racedConversion || null };
    }
    const { rows: [updated] } = await client.query(
      `UPDATE slot_accounts
          SET point_balance = point_balance - $2,
              bank_balance_cents = bank_balance_cents + $3,
              updated_at = NOW()
        WHERE workspace_id = $1
        RETURNING point_balance, bank_balance_cents`,
      [workspaceId, pts, cents]
    );
    const { rows: [conversion] } = await client.query(
      `INSERT INTO budget_conversions (workspace_id, user_id, points, cents, rate_cents_per_point, source_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [workspaceId, userId || null, pts, cents, rate, sourceKey]
    );
    await client.query("COMMIT");
    return {
      converted: true,
      duplicate: false,
      conversion,
      bank_units: bankUnits,
      bank_unit: quote,
      point_balance: updated.point_balance,
      bank_balance_cents: updated.bank_balance_cents,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── Rollover + sweep ─────────────────────────────────────────────────────────
// Lazy month boundary (getBankUsage spirit): getBudgetState flags rollover_due
// on a period-key mismatch and nothing mutates until the user chooses fresh or
// carry. The sweep invests the partial fill above the last fully-funded block:
// leftover = closingWaterline - lastFundedThreshold, bounded by the spendable
// balance (you can't invest money already spent). UNIQUE(workspace, period_key)
// on budget_investments makes re-running the rollover a no-op debit-wise.
function sweepPreview(settings, usage, blocks) {
  const closing = settings.current_period || { key: null, capacity_cents: 0 };
  // The stamped capacity is GROSS income; the fillable tank the waterline
  // actually reaches is discretionary (gross - necessities). Cap the closing
  // waterline at discretionary so the sweep matches the live waterline and can't
  // invest phantom money above the last funded block (matches resolveTankWaterline).
  const closingCapacity = Math.max(0, (closing.capacity_cents || 0) - necessitiesTotalCents(settings));
  const closingWaterline = Math.min(usage.priorPeriodBanked, closingCapacity);
  const plannedCents = blocks.reduce((sum, block) => sum + (block.value_cents || 0), 0);
  // Overflow exists only after every planned purchase is covered. Partial
  // progress toward the next planned purchase is never swept away.
  const leftover = Math.max(0, closingWaterline - plannedCents);
  const unhit = blocks.filter(b => !b.tank_recurring && !b.tank_claimed_period && (b.tank_unlock_cents || 0) > closingWaterline);
  return { closing_key: closing.key, closing_capacity_cents: closingCapacity, closing_waterline_cents: closingWaterline, planned_cents: plannedCents, leftover_cents: leftover, unhit: unhit.map(b => ({ id: b.id, title: b.title, value_cents: b.value_cents })) };
}

// `onSwept` (optional) runs INSIDE the rollover transaction, right before
// COMMIT, only when a leftover was actually swept. The route uses it to create
// the "Transfer $X to brokerage" itinerary task + stamp it on the investment
// row on the SAME client, so money is never swept without its task: if the task
// creation throws, the whole rollover (sweep debit, ledger insert, tank reflow)
// rolls back. Injected via the options object, mirroring claimTankBlock's
// sweepPendingBankBuilders. onSwept(client, { swept_cents, closing_period }) ->
// any; whatever it returns is surfaced on result.task.
async function rolloverPeriod(workspaceId, userId, { mode, overflow_action, overflowAction, onSwept } = {}) {
  const rolloverMode = mode === "fresh" ? "fresh" : "carry";
  const overflowMode = (overflow_action || overflowAction) === "carry" ? "carry" : "invest";
  await upsertSlotAccountRow(pool, workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id = $1 FOR UPDATE",
      [workspaceId]
    );
    const settings = normalizeBudgetTankSettings(account && account.settings && account.settings.budget_tank);
    if (!settings.current_period) throw badRequest("No tank period to roll over");
    const usage = await getTankUsage(workspaceId, settings, client);
    if (settings.current_period.key === usage.periodKey) {
      throw badRequest("The current period isn't over yet");
    }
    const { rows: blocks } = await client.query(
      `SELECT * FROM slot_rewards
        WHERE workspace_id = $1 AND tank_position IS NOT NULL AND deleted_at IS NULL
        ORDER BY tank_position ASC, id ASC
        FOR UPDATE`,
      [workspaceId]
    );
    const preview = sweepPreview(settings, usage, blocks);
    const sweep = Math.min(preview.leftover_cents, (account && account.bank_balance_cents) || 0);

    // Idempotent overflow disposition. Investing debits the reserve and creates
    // the existing transfer task. Carrying keeps the reserve intact and seeds
    // the new period's waterline through a zero-point conversion entry.
    let sweptCents = 0;
    let carriedOverCents = 0;
    if (sweep > 0 && overflowMode === "invest") {
      const { rows: [inv] } = await client.query(
        `INSERT INTO budget_investments (workspace_id, user_id, period_key, amount_cents, details)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, period_key) DO NOTHING
         RETURNING *`,
        [workspaceId, userId || null, preview.closing_key, sweep,
         JSON.stringify({ closing_waterline_cents: preview.closing_waterline_cents, leftover_cents: preview.leftover_cents })]
      );
      if (inv) {
        sweptCents = sweep;
        await client.query(
          `UPDATE slot_accounts SET bank_balance_cents = GREATEST(0, bank_balance_cents - $2), updated_at = NOW()
            WHERE workspace_id = $1`,
          [workspaceId, sweep]
        );
      }
    }
    if (sweep > 0 && overflowMode === "carry") {
      const { rows: [carry] } = await client.query(
        `INSERT INTO budget_carryovers(workspace_id,user_id,from_period,to_period,amount_cents)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(workspace_id,from_period) DO NOTHING
         RETURNING *`,
        [workspaceId, userId || null, preview.closing_key, usage.periodKey, sweep]
      );
      if (carry) {
        carriedOverCents = sweep;
        await client.query(
          `INSERT INTO budget_conversions(workspace_id,user_id,points,cents,rate_cents_per_point,source_key)
           VALUES($1,$2,0,$3,0,$4)
           ON CONFLICT(workspace_id,source_key) DO NOTHING`,
          [workspaceId, userId || null, sweep, "carryover:" + preview.closing_key]
        );
      }
    }

    // Blocks: claimed one-shots leave the tank; unhit one-shots carry to the
    // BOTTOM (highest priority) or leave on fresh; recurring envelopes persist
    // (a new period key means unclaimed again — no reset write needed).
    const leaving = [];
    const unhitOneShots = [];
    const recurring = [];
    for (const b of blocks) {
      if (b.tank_recurring) recurring.push(b);
      else if (b.tank_claimed_period) leaving.push(b);
      else if (rolloverMode === "carry") unhitOneShots.push(b);
      else leaving.push(b);
    }
    for (const b of leaving) {
      await client.query(
        `UPDATE slot_rewards SET tank_position = NULL, tank_unlock_cents = 0, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, b.id]
      );
    }
    const newOrder = [...unhitOneShots, ...recurring];
    for (let i = 0; i < newOrder.length; i++) {
      await client.query(
        `UPDATE slot_rewards SET tank_position = $3, updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, newOrder[i].id, (i + 1) * TANK_POSITION_STEP]
      );
    }
    await recomputeTankThresholds(client, workspaceId);

    const nextSettings = {
      ...settings,
      current_period: {
        key: usage.periodKey,
        capacity_cents: resolveCapacity(settings, usage),
        started_at: new Date().toISOString(),
      },
    };
    await saveBudgetTankSettings(workspaceId, nextSettings, client);

    // Atomic side effect: create the brokerage-transfer task on the same client
    // so a mid-flight failure rolls the sweep back rather than stranding money.
    let sweptTask = null;
    if (sweptCents > 0 && typeof onSwept === "function") {
      sweptTask = await onSwept(client, { swept_cents: sweptCents, closing_period: preview.closing_key });
    }

    await client.query("COMMIT");
    return {
      rolled: true,
      mode: rolloverMode,
      closing_period: preview.closing_key,
      new_period: usage.periodKey,
      swept_cents: sweptCents,
      carried_over_cents: carriedOverCents,
      overflow_action: overflowMode,
      already_swept: sweep > 0 && sweptCents === 0 && carriedOverCents === 0,
      new_capacity_cents: nextSettings.current_period.capacity_cents,
      carried: unhitOneShots.map(b => b.title),
      left_tank: leaving.map(b => b.title),
      task: sweptTask,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Stamp the created "Transfer $X to brokerage" DCC task onto the investment row
// so the tank can deep-link to it. `exec` lets rolloverPeriod's onSwept callback
// run this on the same tx client as the sweep (atomic); defaults to the pool.
async function setInvestmentTaskBlock(workspaceId, periodKey, taskBlockId, exec = pool) {
  await exec.query(
    `UPDATE budget_investments SET task_block_id = $3 WHERE workspace_id = $1 AND period_key = $2`,
    [workspaceId, periodKey, taskBlockId]
  );
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
  if (settings.capacity_source === "last_income") return settings.income_cents;
  if (settings.capacity_source === "fixed") return settings.fixed_capacity_cents;
  return usage ? usage.priorPeriodBanked : 0;
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

  const { grossCents, necessitiesCents, capacityCents, waterlineCents } = resolveTankWaterline(settings, usage);
  const bankUnit = quoteBankUnitForTank({
    ...(account.settings || {}),
    budget_tank: settings,
  }, usage, {
    goalCents: capacityCents || (account.settings && account.settings.monthly_goal_cents),
  });
  const funding = await getFunding(workspaceId, account);
  const rows = await getTankBlockRows(workspaceId);
  const blocks = rows.map(r => decorateBlock(r, usage, funding, waterlineCents));
  const allocatedCents = blocks.reduce((sum, b) => sum + b.value_cents, 0);
  const overflowCents = Math.max(0, Math.min(waterlineCents - allocatedCents, funding.total || 0));
  const categories = buildCategories(blocks, waterlineCents);
  const investments = await getInvestments(workspaceId);

  return {
    settings,
    blocks,
    categories,
    usage: {
      period_key: usage.periodKey,
      period_banked_cents: usage.periodBanked,
      prior_period_banked_cents: usage.priorPeriodBanked,
      income_cents: grossCents,                 // whole tank = last period's income
      necessities_total_cents: necessitiesCents, // submerged covered base
      capacity_cents: capacityCents,             // discretionary budget = income - necessities
      waterline_cents: waterlineCents,
      allocated_cents: allocatedCents,
      unallocated_cents: Math.max(0, capacityCents - allocatedCents),
      overflow_cents: overflowCents,
    },
    funding,
    investments,
    points: account.point_balance || 0,
    rollover_due: rolloverDue,
    rollover_preview: rolloverDue ? sweepPreview(settings, usage, rows) : null,
    constants: {
      credit_card_categories: CREDIT_CARD_CATEGORIES.map(({ id, label, color, keywords }) => ({ id, label, color, keywords })),
      bank_unit: bankUnit,
      bank_unit_cents: bankUnit.cents,
      bank_units_per_point: 1,
      // Compatibility alias for older clients. This is a live Bank Unit quote,
      // not the retired independently configurable rate.
      cents_per_point: bankUnit.cents,
    },
  };
}

module.exports = {
  DEFAULT_CENTS_PER_POINT,
  CREDIT_CARD_CATEGORIES,
  categorizePurchase,
  normalizeBlockInput,
  BANK_UNIT_BUDGET_PERCENT,
  quoteBankUnit,
  quoteBankUnitForTank,
  isFinalPeriodWeek,
  normalizeBudgetTankSettings,
  necessitiesTotalCents,
  tankDrivenGoalCents,
  resolveTankWaterline,
  getTankUsage,
  getFunding,
  claimTankBlock,
  convertPointsToBank,
  rolloverPeriod,
  setInvestmentTaskBlock,
  sweepPreview,
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
