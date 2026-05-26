const crypto = require("crypto");
const pool = require("./pg-pool");
const {
  POINTS_FORMULA_VERSION,
  POINTS_PER_SPIN,
  DEFAULT_SPIN_COST_POINTS,
  LEGACY_POINTS_V2_MULTIPLIER,
  POINTS_V3_BALANCE_MULTIPLIER,
  scoreTaskPoints,
} = require("./slot-scoring");

const DEFAULT_SPIN_COST = DEFAULT_SPIN_COST_POINTS;
const DAILY_BANK_CAP_CENTS = 5000;
const WEEKLY_BANK_CAP_CENTS = 15000;
const SCREEN_BANK_BUILDER_HIT_RATE = 0.65;
const SCREEN_BANK_BUILDER_PERCENT = 0.0022;
const SLOT_ROWS = 3;
const SLOT_COLS = 5;
const SLOT_CELL_COUNT = SLOT_ROWS * SLOT_COLS;
const FILLER_SYMBOLS = ["STRAW", "STICK", "BRICK", "HAT", "TOOLS", "HOUSE"];
const TEASER_SYMBOLS = ["CARE", "BONUS", "JACKPOT", "PLEDGE", "PICK", "REROLL"];
const PAYLINES = [
  [0, 1, 2], [1, 2, 3], [2, 3, 4],
  [5, 6, 7], [6, 7, 8], [7, 8, 9],
  [10, 11, 12], [11, 12, 13], [12, 13, 14],
  [0, 6, 12], [2, 6, 10], [4, 8, 12], [2, 8, 14],
];
const BANK_SCREEN_COUNT_WEIGHTS = [
  [1, 55],
  [2, 30],
  [3, 10],
  [4, 4],
  [5, 1],
];
const DEFAULT_MONTHLY_GOAL_CENTS = 10000;
const DEFAULT_SHORTFALL_PENALTY = "Leftover goal amount goes to the boring responsible fund.";
const LEGACY_BANK_BUILDER_KIND = "bank_builder";
const LEGACY_BANK_BUILDER_RETIRED_SETTING = "legacy_bank_builder_rewards_retired_at";
const DEFAULT_SCORING_RATIONALE = [
  "Task points are automatic so task entry stays lightweight.",
  "Every eligible completed task starts at 1 point per completed or scheduled minute.",
  "Effort, attention, importance, urgency, and bounty status multiply that base.",
  "A self bounty doubles the award; a partner/shared bounty can stack as one additional bounty.",
  "Meetings, breaks, and OOO blocks do not earn task points."
].join("\n");

const SPONSOR_TYPES = new Set(["self", "accountability_partner", "romantic_partner", "either_partner", "split"]);
const REWARD_KINDS = new Set(["miss", "free", "small_paid", "bank_gated", "sponsor", "choice", "reroll"]);
const PAYMENT_SOURCES = new Set(["self", "sponsored", "free"]);
const DEFAULT_JACKPOT_HIT_RATE = 0.2;
const DEFAULT_SOURCE_WEIGHTS = { self: 45, sponsored: 25, free: 30 };
const DEFAULT_REWARD_TIERS = [
  { id: "tier_i", label: "Tier I", weight: 36, active: true },
  { id: "tier_ii", label: "Tier II", weight: 24, active: true },
  { id: "tier_iii", label: "Tier III", weight: 16, active: true },
  { id: "tier_iv", label: "Tier IV", weight: 10, active: true },
  { id: "tier_v", label: "Tier V", weight: 6, active: true },
  { id: "tier_vi", label: "Tier VI", weight: 3, active: true },
];

const DEFAULT_REWARDS = [
  ...[
    ["No prize - default 01", 240],
    ["No prize - default 02", 220],
    ["No prize - default 03", 200],
    ["No prize - default 04", 190],
    ["No prize - default 05", 180],
    ["No prize - default 06", 180],
    ["No prize - default 07", 170],
    ["No prize - default 08", 160],
    ["No prize - default 09", 150],
    ["No prize - default 10", 150],
    ["No prize - default 11", 140],
    ["No prize - default 12", 130],
    ["No prize - default 13", 120],
    ["No prize - default 14", 110],
    ["No prize - default 15", 110],
  ].map(([title, weight]) => reward({ title, kind: "miss", weight, notes: "No-prize outcome that keeps rewards from landing every spin." })),
  ...[
    "Take a guilt-free 30-minute nap",
    "Take a long shower or bath",
    "Go on a walk with no productivity goal",
    "Do a no chores for one hour block",
    "Watch one comfort episode",
    "Play a game for 30 minutes",
    "Read for pleasure for 30 minutes",
    "Sit outside with coffee/tea",
    "Order your day by vibes for one hour",
    "Make a favorite homemade snack",
    "Take a scenic drive",
    "Visit a library or bookstore and browse",
    "Do a cozy reset: blanket, candle, music",
    "Sleep in by 30 minutes",
    "Take a lunch away from screens",
    "Use fancy mug/plate/glass mode",
    "Do a low-effort creative session",
    "Have a no optimization evening",
    "Pick tomorrow's first task to be easy",
    "Move one non-urgent task to another day",
    "Declare a tiny win and stop working after essentials",
    "Do a hobby sprint: music, writing, drawing, coding-for-fun",
    "Have a solo cafe/library work block",
    "Rewatch a favorite movie",
    "Make a nostalgic meal",
    "Take a phone-free hour",
    "Window-shop a wishlist without buying",
    "Do a permission to be mediocre task pass",
    "Take a recovery walk after work",
    "Have a deluxe bedtime routine",
  ].map(title => reward({ title, kind: "free", weight: 16 })),
  ...[
    ["Buy a fancy coffee", 700],
    ["Buy a bakery treat", 700],
    ["Buy a new notebook or pen", 1200],
    ["Buy a $5-$10 app/game/book", 1000],
    ["Get takeout within a small cap", 1800],
    ["Buy a plant", 1500],
    ["Buy a candle", 1800],
    ["Buy a small desk upgrade", 2000],
    ["Buy a bath/shower upgrade", 1500],
    ["Buy a used book", 1200],
    ["Buy a fun drink/snack", 800],
    ["Pay for one month of a small subscription", 1500],
    ["Buy a comfort item under a configured cap", 2500],
    ["Upgrade dinner ingredients", 2000],
    ["Rent a movie", 600],
    ["Go to a matinee", 1800],
    ["Get a car wash", 1500],
    ["Buy a small piece of art/poster/sticker", 1200],
    ["Buy a puzzle/model/LEGO-style small set", 2500],
    ["Buy one wishlist item under jackpot", 3000],
  ].map(([title, value]) => reward({ title, kind: "small_paid", weight: 7, value_cents: value, unlock_threshold_cents: value })),
  ...[
    ["Buy a wishlist item up to current bank value", 5000],
    ["Take a random PTO day", 15000],
    ["Take a half-day off", 8000],
    ["Book a massage", 9000],
    ["Buy a larger hobby/tool upgrade", 12000],
    ["Weekend day trip fund", 15000],
    ["Nice dinner fund", 10000],
    ["Hotel night / staycation fund", 20000],
    ["Concert/event ticket fund", 12000],
    ["Clothing/shoes upgrade", 10000],
    ["Home office upgrade", 15000],
    ["Gaming/hobby hardware fund", 20000],
    ["Premium class/course/workshop", 15000],
    ["Big ridiculous thing fund", 50000],
  ].map(([title, value]) => reward({ title, kind: "bank_gated", weight: 3, value_cents: value, unlock_threshold_cents: value })),
  ...[
    "Partner sends a congratulatory voice note",
    "Partner chooses a fun free challenge reward",
    "Partner validates one completed hard thing",
    "Partner brings/sends coffee",
    "Partner sponsors a treat under a cap",
    "Partner covers a meal or dessert",
    "Partner joins a walk",
    "Partner plans a low-cost outing",
    "Partner gives a skip one obligation coupon they can reasonably cover",
    "Partner contributes a pledge to the bank",
    "Partner picks from your wishlist under sponsor cap",
    "Partner schedules a celebration check-in",
    "Partner gives you a brag audit",
    "Partner unlocks a shared activity",
  ].map(title => reward({ title, kind: "sponsor", sponsor_type: "accountability_partner", weight: 5 })),
  ...[
    "Cuddle/movie night",
    "Partner-planned date at home",
    "Partner makes or picks dinner",
    "Massage/back rub",
    "Love note / appreciation note",
    "Partner handles one agreed chore",
    "Partner chooses a shared playlist night",
    "Partner plans a walk/date",
    "Partner makes dessert or drinks",
    "Partner sponsors flowers or small gift",
    "Partner picks a romantic surprise under cap",
    "Partner contributes to trip/date bank",
    "Partner gives a full attention hour",
    "Partner plans a cozy no-phone evening",
    "Partner helps execute a larger reward when jackpot unlocks it",
  ].map(title => reward({ title, kind: "sponsor", sponsor_type: "romantic_partner", weight: 5 })),
  reward({ title: "Pick one of three eligible rewards", kind: "choice", weight: 2 }),
  reward({ title: "Free reroll", kind: "reroll", weight: 2 }),
];

function reward(data) {
  const kind = data && data.kind ? data.kind : "free";
  return {
    sponsor_type: "self",
    sponsor_splits: [],
    weight: 1,
    chance_shares: data && data.weight != null ? data.weight : 1,
    payment_source: defaultPaymentSourceForKind(kind),
    tier_id: "tier_i",
    active: true,
    sponsor_active: true,
    value_cents: 0,
    bank_delta_cents: 0,
    requires_confirmation: false,
    cooldown_days: 0,
    unlock_threshold_cents: 0,
    notes: "",
    ...data,
  };
}

function defaultPaymentSourceForKind(kind) {
  if (kind === "sponsor") return "sponsored";
  if (kind === "free" || kind === "choice" || kind === "reroll") return "free";
  return "self";
}

function defaultKindForPaymentSource(paymentSource, valueCents = 0) {
  if (paymentSource === "sponsored") return "sponsor";
  if (paymentSource === "free") return "free";
  return valueCents > 0 ? "bank_gated" : "free";
}

function normalizePaymentSource(value, kind) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "sponsor") return "sponsored";
  if (PAYMENT_SOURCES.has(source)) return source;
  return defaultPaymentSourceForKind(kind);
}

function tierSlug(label, fallbackIndex = 0) {
  const raw = String(label || "").trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `tier_${fallbackIndex + 1}`;
}

function normalizeRewardTiers(value) {
  const input = Array.isArray(value) && value.length ? value : DEFAULT_REWARD_TIERS;
  const seen = new Set();
  return input.map((tier, index) => {
    const label = String((tier && tier.label) || DEFAULT_REWARD_TIERS[index]?.label || `Tier ${index + 1}`).trim() || `Tier ${index + 1}`;
    let id = String((tier && tier.id) || tierSlug(label, index)).trim();
    if (!id) id = tierSlug(label, index);
    while (seen.has(id)) id = `${id}_${index + 1}`;
    seen.add(id);
    return {
      id,
      label,
      weight: clampInt(tier && tier.weight, 0, 1000000),
      active: tier ? tier.active !== false : true,
      sort: Number.isFinite(Number(tier && tier.sort)) ? Number(tier.sort) : index,
    };
  }).sort((a, b) => a.sort - b.sort);
}

function normalizeSourceWeights(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    self: clampInt(raw.self ?? DEFAULT_SOURCE_WEIGHTS.self, 0, 1000000),
    sponsored: clampInt(raw.sponsored ?? raw.sponsor ?? DEFAULT_SOURCE_WEIGHTS.sponsored, 0, 1000000),
    free: clampInt(raw.free ?? DEFAULT_SOURCE_WEIGHTS.free, 0, 1000000),
  };
}

function normalizeJackpotHitRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_JACKPOT_HIT_RATE;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slot_accounts (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      point_balance INTEGER NOT NULL DEFAULT 0,
      bank_balance_cents INTEGER NOT NULL DEFAULT 0,
      settings JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS slot_rewards (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      sponsor_type TEXT NOT NULL DEFAULT 'self',
      sponsor_splits JSONB NOT NULL DEFAULT '[]',
      weight INTEGER NOT NULL DEFAULT 1,
      chance_shares INTEGER NOT NULL DEFAULT 1,
      payment_source TEXT NOT NULL DEFAULT 'self',
      tier_id TEXT NOT NULL DEFAULT 'tier_i',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sponsor_active BOOLEAN NOT NULL DEFAULT TRUE,
      value_cents INTEGER NOT NULL DEFAULT 0,
      bank_delta_cents INTEGER NOT NULL DEFAULT 0,
      requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
      cooldown_days INTEGER NOT NULL DEFAULT 0,
      unlock_threshold_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      last_won_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(workspace_id, title)
    );

    CREATE TABLE IF NOT EXISTS slot_point_ledger (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      delta INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE slot_point_ledger
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

    ALTER TABLE slot_rewards
      ADD COLUMN IF NOT EXISTS sponsor_splits JSONB NOT NULL DEFAULT '[]';

    ALTER TABLE slot_rewards
      ADD COLUMN IF NOT EXISTS chance_shares INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'self',
      ADD COLUMN IF NOT EXISTS tier_id TEXT NOT NULL DEFAULT 'tier_i';

    ALTER TABLE slot_rewards
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_point_ledger_source
      ON slot_point_ledger(workspace_id, source_type, source_key);

    CREATE TABLE IF NOT EXISTS slot_spins (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      cost_credits INTEGER NOT NULL DEFAULT 1,
      reward_id INTEGER REFERENCES slot_rewards(id),
      reward_snapshot JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'awarded',
      bank_delta_cents INTEGER NOT NULL DEFAULT 0,
      bank_reserved_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_slot_rewards_workspace
      ON slot_rewards(workspace_id, active, kind);

    CREATE INDEX IF NOT EXISTS idx_slot_spins_workspace
      ON slot_spins(workspace_id, created_at DESC);
  `);
  await pool.query(`
    UPDATE slot_rewards
       SET chance_shares = GREATEST(0, weight)
     WHERE chance_shares = 1
       AND weight <> 1;
  `);
  await pool.query(`
    UPDATE slot_rewards
       SET payment_source = CASE
         WHEN kind = 'sponsor' THEN 'sponsored'
         WHEN kind IN ('free','choice','reroll') THEN 'free'
         ELSE payment_source
       END
     WHERE payment_source = 'self'
       AND kind IN ('sponsor','free','choice','reroll');
  `);
}

async function ensureAccount(workspaceId, userId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO slot_accounts (workspace_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET user_id = COALESCE(slot_accounts.user_id, EXCLUDED.user_id)
     RETURNING *`,
    [workspaceId, userId || null]
  );
  let account = await migrateAccountPointsV2(workspaceId, rows[0]);
  account = await migrateAccountPointsV3(workspaceId, account);
  await seedRewards(workspaceId);
  await retireLegacyBankBuilderRewards(workspaceId);
  return account;
}

async function migrateAccountPointsV2(workspaceId, account) {
  const settings = account && account.settings ? account.settings : {};
  const needsBalanceMigration = !settings.points_v2_migrated_at;
  const needsSpinCostMigration = !settings.points_v2_spin_cost_migrated_at;
  if (!needsBalanceMigration && !needsSpinCostMigration) return account;
  const now = new Date().toISOString();
  const oldSpinCost = clampInt(settings.spin_cost || 1, 1, 250);
  const migration = {};
  if (needsBalanceMigration) {
    Object.assign(migration, {
      points_v2_migrated_at: now,
      points_v2_multiplier: LEGACY_POINTS_V2_MULTIPLIER,
      points_v2_formula_version: "task_points_v2",
    });
  }
  if (needsSpinCostMigration) {
    Object.assign(migration, {
      spin_cost: clampInt(oldSpinCost * LEGACY_POINTS_V2_MULTIPLIER, 1, 250),
      points_v2_spin_cost_migrated_at: now,
      points_v2_old_spin_cost: oldSpinCost,
      points_v2_spin_cost_multiplier: LEGACY_POINTS_V2_MULTIPLIER,
    });
  }
  const { rows: [updated] } = await pool.query(
    `UPDATE slot_accounts
     SET point_balance = CASE
           WHEN NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v2_migrated_at')
           THEN point_balance * $2
           ELSE point_balance
         END,
         settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND (
         NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v2_migrated_at')
         OR NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v2_spin_cost_migrated_at')
       )
     RETURNING *`,
    [workspaceId, LEGACY_POINTS_V2_MULTIPLIER, JSON.stringify(migration)]
  );
  if (updated) return updated;
  const { rows: [current] } = await pool.query("SELECT * FROM slot_accounts WHERE workspace_id = $1", [workspaceId]);
  return current || account;
}

async function migrateAccountPointsV3(workspaceId, account) {
  const settings = account && account.settings ? account.settings : {};
  const needsBalanceMigration = !settings.points_v3_migrated_at;
  const needsSpinCostMigration = !settings.points_v3_spin_cost_migrated_at;
  if (!needsBalanceMigration && !needsSpinCostMigration) return account;
  const now = new Date().toISOString();
  const oldSpinCost = clampInt(settings.spin_cost || DEFAULT_SPIN_COST, 1, 250);
  const nextSpinCost = Math.max(DEFAULT_SPIN_COST, oldSpinCost);
  const migration = {};
  if (needsBalanceMigration) {
    Object.assign(migration, {
      points_v3_migrated_at: now,
      points_v3_balance_multiplier: POINTS_V3_BALANCE_MULTIPLIER,
      points_v3_formula_version: POINTS_FORMULA_VERSION,
    });
  }
  if (needsSpinCostMigration) {
    Object.assign(migration, {
      spin_cost: clampInt(nextSpinCost, 1, 250),
      points_v3_spin_cost_migrated_at: now,
      points_v3_old_spin_cost: oldSpinCost,
    });
  }
  const { rows: [updated] } = await pool.query(
    `UPDATE slot_accounts
     SET point_balance = CASE
           WHEN NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v3_migrated_at')
           THEN ROUND(point_balance * $2::numeric)::int
           ELSE point_balance
         END,
         settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND (
         NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v3_migrated_at')
         OR NOT (COALESCE(settings, '{}'::jsonb) ? 'points_v3_spin_cost_migrated_at')
       )
     RETURNING *`,
    [workspaceId, POINTS_V3_BALANCE_MULTIPLIER, JSON.stringify(migration)]
  );
  if (updated) return updated;
  const { rows: [current] } = await pool.query("SELECT * FROM slot_accounts WHERE workspace_id = $1", [workspaceId]);
  return current || account;
}

function normalizeSlotSettings(settings = {}) {
  const raw = settings && typeof settings === "object" ? settings : {};
  return {
    ...raw,
    spin_cost: clampInt(raw.spin_cost || DEFAULT_SPIN_COST, 1, 250),
    jackpot_hit_rate: normalizeJackpotHitRate(raw.jackpot_hit_rate ?? raw.jackpotHitRate),
    payment_source_weights: normalizeSourceWeights(raw.payment_source_weights || raw.paymentSourceWeights),
    reward_tiers: normalizeRewardTiers(raw.reward_tiers || raw.rewardTiers),
    reroll_credits: clampInt(raw.reroll_credits ?? raw.rerollCredits ?? 0, 0, 1000),
    monthly_goal_cents: clampInt(raw.monthly_goal_cents || DEFAULT_MONTHLY_GOAL_CENTS, 100, 1000000),
    shortfall_penalty: String(raw.shortfall_penalty || DEFAULT_SHORTFALL_PENALTY),
    scoring_rationale: String(raw.scoring_rationale || DEFAULT_SCORING_RATIONALE),
  };
}

function accountWithSettings(account) {
  if (!account) return account;
  return { ...account, settings: normalizeSlotSettings(account.settings) };
}

function getSpinCost(account) {
  return normalizeSlotSettings(account && account.settings).spin_cost;
}

async function seedRewards(workspaceId) {
  const { rows: [account] } = await pool.query("SELECT settings FROM slot_accounts WHERE workspace_id = $1", [workspaceId]);
  const settings = account && account.settings ? account.settings : {};
  if (settings.default_rewards_seeded_at || settings.default_rewards_user_modified_at) return;

  const { rows: [existing] } = await pool.query("SELECT COUNT(*)::int AS count FROM slot_rewards WHERE workspace_id = $1", [workspaceId]);
  if ((existing && existing.count) > 0) {
    await pool.query(
      `UPDATE slot_accounts
       SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE workspace_id = $1`,
      [workspaceId, JSON.stringify({
        default_rewards_seeded_at: new Date().toISOString(),
        default_rewards_seeded_from_existing: true
      })]
    );
    return;
  }

  for (const r of DEFAULT_REWARDS) {
    await pool.query(
      `INSERT INTO slot_rewards
       (workspace_id, title, kind, sponsor_type, sponsor_splits, weight, chance_shares, payment_source, tier_id, active, sponsor_active, value_cents, bank_delta_cents, requires_confirmation, cooldown_days, unlock_threshold_cents, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (workspace_id, title) DO NOTHING`,
      [workspaceId, r.title, r.kind, r.sponsor_type, JSON.stringify(r.sponsor_splits || []), r.weight, r.chance_shares || r.weight, r.payment_source || defaultPaymentSourceForKind(r.kind), r.tier_id || "tier_i", r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
    );
  }
  await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify({ default_rewards_seeded_at: new Date().toISOString() })]
  );
}

async function retireLegacyBankBuilderRewards(workspaceId) {
  const { rows: [account] } = await pool.query("SELECT settings FROM slot_accounts WHERE workspace_id = $1", [workspaceId]);
  const settings = account && account.settings ? account.settings : {};
  if (settings[LEGACY_BANK_BUILDER_RETIRED_SETTING]) return;

  await pool.query(
    `UPDATE slot_rewards
     SET active = FALSE,
         weight = 0,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND kind = $2
       AND (active IS DISTINCT FROM FALSE OR weight <> 0)`,
    [workspaceId, LEGACY_BANK_BUILDER_KIND]
  );
  await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify({ [LEGACY_BANK_BUILDER_RETIRED_SETTING]: new Date().toISOString() })]
  );
}

function normalizeRewardInput(body) {
  const title = String(body.title || "").trim();
  if (!title) throw new Error("title required");
  const valueCents = Math.max(0, parseInt(body.value_cents, 10) || 0);
  const paymentSource = normalizePaymentSource(body.payment_source || body.paymentSource, body.kind);
  const kind = String(body.kind || defaultKindForPaymentSource(paymentSource, valueCents));
  const sponsorSplits = normalizeSponsorSplits(body.sponsor_splits || body.sponsorSplits || []);
  const sponsorType = sponsorSplits.length ? "split" : String(body.sponsor_type || "self");
  if (!REWARD_KINDS.has(kind)) throw new Error("invalid kind");
  if (!SPONSOR_TYPES.has(sponsorType)) throw new Error("invalid sponsor_type");
  const chanceShares = Math.max(0, parseInt(body.chance_shares ?? body.chanceShares ?? body.weight, 10) || 0);
  return {
    title,
    kind,
    sponsor_type: sponsorType,
    sponsor_splits: sponsorSplits,
    weight: chanceShares,
    chance_shares: chanceShares,
    payment_source: paymentSource,
    tier_id: String(body.tier_id || body.tierId || "tier_i").trim() || "tier_i",
    active: body.active !== false,
    sponsor_active: true,
    value_cents: valueCents,
    bank_delta_cents: 0,
    requires_confirmation: false,
    cooldown_days: 0,
    unlock_threshold_cents: Math.max(0, parseInt(body.unlock_threshold_cents, 10) || 0),
    notes: String(body.notes || ""),
  };
}

function normalizeSponsorSplits(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map(row => ({
      name: String(row && row.name || "").trim(),
      percent: clampInt(row && row.percent, 0, 100),
    }))
    .filter(row => row.name && row.percent > 0);
}

function reserveCostCents(row) {
  if (!row || !["small_paid", "bank_gated"].includes(row.kind)) return 0;
  return Math.max(row.value_cents || 0, row.unlock_threshold_cents || 0);
}

function isJackpotChoiceReward(row) {
  return !!row && ["small_paid", "bank_gated", "sponsor"].includes(row.kind);
}

function jackpotType(row) {
  if (!row) return "any";
  if (row.kind === "sponsor") return "partner";
  return "self";
}

function rowToReward(row, account, bankUsage, fundingAvailableCents) {
  const bankBalance = Number.isFinite(fundingAvailableCents) ? fundingAvailableCents : (account ? account.bank_balance_cents : 0);
  const threshold = reserveCostCents(row);
  const reserveAffordable = threshold <= bankBalance;
  const bankCapLocked = row.kind === "bank_builder" && bankUsage && (
    bankUsage.month + row.bank_delta_cents > bankUsage.monthlyGoal
  );
  const paymentSource = normalizePaymentSource(row.payment_source, row.kind);
  const chanceShares = Math.max(0, parseInt(row.chance_shares ?? row.weight, 10) || 0);
  const reserveLocked = ["small_paid", "bank_gated"].includes(row.kind) && threshold > 0 && !reserveAffordable;
  return {
    ...row,
    payment_source: paymentSource,
    tier_id: String(row.tier_id || "tier_i"),
    chance_shares: chanceShares,
    weight: chanceShares,
    sponsor_splits: normalizeSponsorSplits(row.sponsor_splits),
    eligible: !!row.active && chanceShares > 0 && !bankCapLocked && !reserveLocked,
    jackpot_type: jackpotType(row),
    reserve_cost_cents: threshold,
    reserve_affordable: reserveAffordable,
    reserve_shortfall_cents: Math.max(0, threshold - bankBalance),
    locked_reason: !row.active ? "inactive" :
      chanceShares <= 0 ? "zero_weight" :
      reserveLocked ? "bank_too_small" :
      bankCapLocked ? "bank_cap" :
      null,
  };
}

async function getBankUsage(workspaceId, settings = {}) {
  const { rows: [today] } = await pool.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND bank_delta_cents > 0
       AND created_at >= date_trunc('day', NOW())`,
    [workspaceId]
  );
  const { rows: [week] } = await pool.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND bank_delta_cents > 0
       AND created_at >= date_trunc('week', NOW())`,
    [workspaceId]
  );
  const { rows: [month] } = await pool.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND reward_snapshot->>'kind' = 'bank_builder'
       AND created_at >= date_trunc('month', NOW())`,
    [workspaceId]
  );
  const monthlyGoal = clampInt(settings.monthly_goal_cents || DEFAULT_MONTHLY_GOAL_CENTS, 100, 1000000);
  return {
    today: today.cents,
    week: week.cents,
    month: month.cents,
    dailyCap: DAILY_BANK_CAP_CENTS,
    weeklyCap: WEEKLY_BANK_CAP_CENTS,
    monthlyGoal,
    monthlyRemaining: Math.max(0, monthlyGoal - month.cents),
  };
}

async function getPendingBankDeposit(workspaceId) {
  const { rows: [pending] } = await pool.query(
    `SELECT
       COALESCE(SUM(bank_delta_cents), 0)::int AS cents,
       COUNT(*)::int AS count,
       MIN(created_at) AS oldest_at
     FROM slot_spins
     WHERE workspace_id = $1
       AND status = 'pending'
       AND bank_delta_cents > 0
       AND bank_reserved_cents = 0
       AND (
         reward_snapshot->>'kind' = 'bank_builder'
         OR reward_snapshot->>'source_type' = 'slot_screen_bank_builder'
       )`,
    [workspaceId]
  );
  return { cents: pending.cents, count: pending.count, oldest_at: pending.oldest_at };
}

async function getState(workspaceId, userId) {
  const account = accountWithSettings(await ensureAccount(workspaceId, userId));
  const spinCost = getSpinCost(account);
  const bankUsage = await getBankUsage(workspaceId, account.settings);
  const pendingBankDeposit = await getPendingBankDeposit(workspaceId);
  const funding = {
    ready: account.bank_balance_cents || 0,
    pending: pendingBankDeposit.cents || 0,
    total: (account.bank_balance_cents || 0) + (pendingBankDeposit.cents || 0),
  };
  const { rows: rewardRows } = await pool.query(
    "SELECT * FROM slot_rewards WHERE workspace_id = $1 AND kind <> $2 AND deleted_at IS NULL ORDER BY active DESC, kind, title",
    [workspaceId, LEGACY_BANK_BUILDER_KIND]
  );
  const rewards = rewardRows
    .filter(r => r.kind !== LEGACY_BANK_BUILDER_KIND)
    .map(r => rowToReward(r, account, bankUsage, funding.total));
  const { rows: spins } = await pool.query(
    "SELECT * FROM slot_spins WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 25",
    [workspaceId]
  );
  return {
    account,
    rewards,
    spins,
    bankUsage,
    pendingBankDeposit,
    funding,
    constants: {
      spinCost,
      spinCostPoints: spinCost,
      pointsPerSpin: POINTS_PER_SPIN,
      pointsFormulaVersion: POINTS_FORMULA_VERSION,
      maxTaskCredits: null,
      monthlyGoalCents: account.settings.monthly_goal_cents,
      jackpotHitRate: account.settings.jackpot_hit_rate,
      paymentSourceWeights: account.settings.payment_source_weights,
      rewardTiers: account.settings.reward_tiers,
      rerollCredits: account.settings.reroll_credits,
      shortfallPenalty: account.settings.shortfall_penalty,
      scoringRationale: account.settings.scoring_rationale,
    },
  };
}

async function updateSettings(workspaceId, userId, body = {}) {
  const account = accountWithSettings(await ensureAccount(workspaceId, userId));
  const current = account.settings || {};
  const next = {
    ...current,
    spin_cost: clampInt(body.spin_cost || body.spinCost || current.spin_cost || DEFAULT_SPIN_COST, 1, 250),
    jackpot_hit_rate: normalizeJackpotHitRate(
      body.jackpot_hit_rate ?? body.jackpotHitRate ?? current.jackpot_hit_rate ?? DEFAULT_JACKPOT_HIT_RATE
    ),
    payment_source_weights: normalizeSourceWeights(
      body.payment_source_weights || body.paymentSourceWeights || current.payment_source_weights || DEFAULT_SOURCE_WEIGHTS
    ),
    reward_tiers: normalizeRewardTiers(
      body.reward_tiers || body.rewardTiers || current.reward_tiers || DEFAULT_REWARD_TIERS
    ),
    reroll_credits: clampInt(
      body.reroll_credits ?? body.rerollCredits ?? current.reroll_credits ?? 0,
      0,
      1000
    ),
    monthly_goal_cents: clampInt(
      body.monthly_goal_cents || body.monthlyGoalCents || current.monthly_goal_cents || DEFAULT_MONTHLY_GOAL_CENTS,
      100,
      1000000
    ),
    shortfall_penalty: String(
      body.shortfall_penalty != null ? body.shortfall_penalty :
      body.shortfallPenalty != null ? body.shortfallPenalty :
      current.shortfall_penalty || DEFAULT_SHORTFALL_PENALTY
    ).trim() || DEFAULT_SHORTFALL_PENALTY,
    scoring_rationale: String(
      body.scoring_rationale != null ? body.scoring_rationale :
      body.scoringRationale != null ? body.scoringRationale :
      current.scoring_rationale || DEFAULT_SCORING_RATIONALE
    ).trim() || DEFAULT_SCORING_RATIONALE,
  };
  const { rows } = await pool.query(
    "UPDATE slot_accounts SET settings=$2, updated_at=NOW() WHERE workspace_id=$1 RETURNING *",
    [workspaceId, next]
  );
  return accountWithSettings(rows[0]);
}

async function createReward(workspaceId, body) {
  const r = normalizeRewardInput(body);
  const { rows } = await pool.query(
    `INSERT INTO slot_rewards
     (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,chance_shares,payment_source,tier_id,active,sponsor_active,value_cents,bank_delta_cents,requires_confirmation,cooldown_days,unlock_threshold_cents,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [workspaceId, r.title, r.kind, r.sponsor_type, JSON.stringify(r.sponsor_splits), r.weight, r.chance_shares, r.payment_source, r.tier_id, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
  );
  return rows[0];
}

async function updateReward(workspaceId, id, body) {
  const r = normalizeRewardInput(body);
  const { rows } = await pool.query(
    `UPDATE slot_rewards SET
       title=$3, kind=$4, sponsor_type=$5, sponsor_splits=$6, weight=$7, chance_shares=$8,
       payment_source=$9, tier_id=$10, active=$11, sponsor_active=$12,
       value_cents=$13, bank_delta_cents=$14, requires_confirmation=$15,
       cooldown_days=$16, unlock_threshold_cents=$17, notes=$18, updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL
     RETURNING *`,
    [workspaceId, id, r.title, r.kind, r.sponsor_type, JSON.stringify(r.sponsor_splits), r.weight, r.chance_shares, r.payment_source, r.tier_id, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
  );
  if (!rows[0]) throw notFound("Reward not found");
  return rows[0];
}

async function deleteReward(workspaceId, id) {
  const { rowCount } = await pool.query(
    `UPDATE slot_rewards
     SET active=FALSE,
         weight=0,
         deleted_at=NOW(),
         updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [workspaceId, id]
  );
  if (!rowCount) throw notFound("Reward not found");
  await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify({
      default_rewards_user_modified_at: new Date().toISOString()
    })]
  );
  return { ok: true };
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeTaskCreditBody(body = {}) {
  return {
    ...body,
    duration_minutes: body.duration_minutes ?? body.durationMinutes ?? body.duration_min ?? body.dur_min ?? body.duration ?? body.durMin,
    actual_minutes: body.actual_minutes ?? body.actualMinutes ?? body.focus_minutes ?? body.focusMin,
  };
}

async function earnTaskCredit(workspaceId, userId, body) {
  body = normalizeTaskCreditBody(body || {});
  await ensureAccount(workspaceId, userId);
  const sourceKey = String(body.source_key || body.task_id || "").trim();
  if (!sourceKey) throw new Error("source_key required");
  const description = String(body.description || body.title || "Task completed");
  const scoring = scoreTaskPoints(body);
  const credits = scoring.awardPoints;
  const metadata = {
    formulaVersion: POINTS_FORMULA_VERSION,
    scoring,
    inputs: {
      task_id: body.task_id || null,
      title: body.title || null,
      type: body.type || body.kind || null,
      priority: body.priority || null,
      importance: body.importance || body.importance_tier || body.importanceTier || null,
      urgency: body.urgency || null,
      source: body.source || null,
      tags: body.tags || [],
      duration_minutes: body.duration_minutes ?? body.durationMinutes ?? body.duration ?? body.durMin ?? null,
      actual_minutes: body.actual_minutes ?? body.actualMinutes ?? null,
      effort_tier: body.effort_tier || body.effortTier || null,
      attention_tier: body.attention_tier || body.attentionTier || null,
      bounty: body.bounty === true,
      bounty_count: body.bounty_count ?? body.bountyCount ?? null,
      partner_bounty: body.partner_bounty === true || body.partnerBounty === true || body.shared_bounty === true || body.sharedBounty === true,
      trivial: body.trivial === true,
      completed_at: body.completed_at || body.completedAt || null,
    },
  };
  if (!scoring.eligible || credits < 1) {
    const state = await getState(workspaceId, userId);
    return { awarded: false, credits: 0, delta: 0, account: state.account, scoring };
  }
  const { rows } = await pool.query(
    `INSERT INTO slot_point_ledger (workspace_id, user_id, delta, source_type, source_key, description, metadata)
     VALUES ($1,$2,$3,'task_complete',$4,$5,$6)
     ON CONFLICT (workspace_id, source_type, source_key) DO NOTHING
     RETURNING *`,
    [workspaceId, userId || null, credits, sourceKey, description, JSON.stringify(metadata)]
  );
  let awarded = false;
  let adjusted = false;
  let delta = 0;
  if (rows[0]) {
    awarded = true;
    delta = credits;
    await pool.query("UPDATE slot_accounts SET point_balance = point_balance + $2, updated_at=NOW() WHERE workspace_id=$1", [workspaceId, delta]);
  } else {
    const { rows: [existing] } = await pool.query(
      `SELECT delta FROM slot_point_ledger
       WHERE workspace_id=$1 AND source_type='task_complete' AND source_key=$2`,
      [workspaceId, sourceKey]
    );
    if (existing && Number(existing.delta) < credits) {
      delta = credits - Number(existing.delta || 0);
      await pool.query(
        `UPDATE slot_point_ledger
         SET delta=$3, description=$4, metadata=$5
         WHERE workspace_id=$1 AND source_type='task_complete' AND source_key=$2`,
        [workspaceId, sourceKey, credits, description, JSON.stringify(metadata)]
      );
      if (delta !== 0) {
        adjusted = true;
        await pool.query("UPDATE slot_accounts SET point_balance = point_balance + $2, updated_at=NOW() WHERE workspace_id=$1", [workspaceId, delta]);
      }
    }
  }
  const state = await getState(workspaceId, userId);
  return { awarded: awarded || adjusted, adjusted, credits: awarded || adjusted ? delta : 0, delta, account: state.account, scoring };
}

function chooseWeighted(items, weightKey = "weight", rng = crypto.randomInt) {
  const pool = (items || []).filter(item => (Number(item && item[weightKey]) || 0) > 0);
  const total = pool.reduce((sum, r) => sum + (Number(r[weightKey]) || 0), 0);
  if (total <= 0) return null;
  let roll = rng(total) + 1;
  for (const r of pool) {
    roll -= Number(r[weightKey]) || 0;
    if (roll <= 0) return r;
  }
  return pool[pool.length - 1];
}

function sourceOptions(settings) {
  const weights = normalizeSlotSettings(settings).payment_source_weights;
  return [
    { id: "self", label: "Self", weight: weights.self },
    { id: "sponsored", label: "Sponsored", weight: weights.sponsored },
    { id: "free", label: "Free", weight: weights.free },
  ];
}

function tierOptions(settings) {
  return normalizeSlotSettings(settings).reward_tiers
    .filter(tier => tier.active !== false)
    .map(tier => ({ ...tier, weight: Number(tier.weight) || 0 }));
}

function jackpotHits(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).jackpot_hit_rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng(1000000) < Math.floor(rate * 1000000);
}

function fakeMissReward() {
  return reward({
    id: null,
    title: "No prize",
    kind: "miss",
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "No-jackpot outcome.",
  });
}

function fakeRerollReward(source, tier) {
  return reward({
    id: null,
    title: `Reroll credit: ${source.label} ${tier.label} had no rewards`,
    kind: "reroll",
    payment_source: source.id,
    tier_id: tier.id,
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Empty jackpot bucket awarded a free reroll credit.",
  });
}

function selectThreeStageOutcome(rewards, settings, rng = crypto.randomInt) {
  const normalized = normalizeSlotSettings(settings);
  const hit = jackpotHits(normalized, rng);
  if (!hit) {
    return {
      jackpot_hit: false,
      selected: fakeMissReward(),
      source: null,
      tier: null,
      bucket: [],
      empty_bucket: false,
      reroll_credit: false,
    };
  }
  const source = chooseWeighted(sourceOptions(normalized), "weight", rng) || sourceOptions(normalized)[0];
  const tier = chooseWeighted(tierOptions(normalized), "weight", rng) || tierOptions(normalized)[0] || DEFAULT_REWARD_TIERS[0];
  const bucket = (rewards || []).filter(r =>
    r &&
    r.eligible &&
    normalizePaymentSource(r.payment_source, r.kind) === source.id &&
    String(r.tier_id || "tier_i") === String(tier.id) &&
    (Number(r.chance_shares ?? r.weight) || 0) > 0
  );
  if (!bucket.length) {
    return {
      jackpot_hit: true,
      selected: fakeRerollReward(source, tier),
      source,
      tier,
      bucket,
      empty_bucket: true,
      reroll_credit: true,
    };
  }
  return {
    jackpot_hit: true,
    selected: chooseWeighted(bucket, "chance_shares", rng),
    source,
    tier,
    bucket,
    empty_bucket: false,
    reroll_credit: false,
  };
}

function rewardCostCents(row) {
  return Math.max((row && row.value_cents) || 0, (row && row.unlock_threshold_cents) || 0);
}

function rewardSymbol(row) {
  if (!row || row.kind === "miss") return "MISS";
  if (rewardCostCents(row) > 0) return "JACKPOT";
  if (row.kind === "bank_builder") return "BANK";
  if (row.kind === "sponsor") return "PLEDGE";
  if (row.kind === "choice") return "PICK";
  if (row.kind === "reroll") return "REROLL";
  return "CARE";
}

function weightedBankScreenCount() {
  const total = BANK_SCREEN_COUNT_WEIGHTS.reduce((sum, row) => sum + row[1], 0);
  let roll = crypto.randomInt(total) + 1;
  for (const [count, weight] of BANK_SCREEN_COUNT_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) return count;
  }
  return 1;
}

function shouldHitScreenBankBuilder() {
  return crypto.randomInt(1000000) < Math.floor(SCREEN_BANK_BUILDER_HIT_RATE * 1000000);
}

function buildSpinScreen(selected, account, bankUsage, screenBankHit) {
  const board = Array.from({ length: SLOT_CELL_COUNT }, () => FILLER_SYMBOLS[crypto.randomInt(FILLER_SYMBOLS.length)]);
  const protectedCells = new Set();
  const selectedSymbol = rewardSymbol(selected);
  const isMiss = selected.kind === "miss";
  const canPlaceBankSymbols = screenBankHit && !isMiss;
  let payline = [];

  if (!isMiss && selected.kind !== "bank_builder") {
    const line = PAYLINES[crypto.randomInt(PAYLINES.length)];
    payline = [...line];
    line.forEach(i => {
      board[i] = selectedSymbol;
      protectedCells.add(i);
    });
  } else {
    for (let i = 0; i < 4; i++) {
      board[crypto.randomInt(SLOT_CELL_COUNT)] = TEASER_SYMBOLS[crypto.randomInt(TEASER_SYMBOLS.length)];
    }
  }

  if (canPlaceBankSymbols) {
    const openCells = Array.from({ length: SLOT_CELL_COUNT }, (_, i) => i).filter(i => !protectedCells.has(i));
    const bankCount = Math.min(weightedBankScreenCount(), openCells.length);
    for (let i = 0; i < bankCount; i++) {
      const pick = crypto.randomInt(openCells.length);
      board[openCells[pick]] = "BANK";
      openCells.splice(pick, 1);
    }
  }

  const payout = canPlaceBankSymbols
    ? calculateScreenBankPayout(board, account, bankUsage)
    : emptyScreenBankPayout(account, bankUsage);
  return { board, payline, payout };
}

function calculateScreenBankPayout(board, account, bankUsage) {
  const positions = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] === "BANK") positions.push(i);
  }

  const horizontalGroups = [];
  for (let row = 0; row < SLOT_ROWS; row++) {
    let run = [];
    for (let col = 0; col < SLOT_COLS; col++) {
      const idx = row * SLOT_COLS + col;
      if (board[idx] === "BANK") run.push(idx);
      if (board[idx] !== "BANK" || col === SLOT_COLS - 1) {
        if (run.length >= 2) horizontalGroups.push([...run]);
        run = [];
      }
    }
  }

  const verticalGroups = [];
  for (let col = 0; col < SLOT_COLS; col++) {
    let run = [];
    for (let row = 0; row < SLOT_ROWS; row++) {
      const idx = row * SLOT_COLS + col;
      if (board[idx] === "BANK") run.push(idx);
      if (board[idx] !== "BANK" || row === SLOT_ROWS - 1) {
        if (run.length >= 2) verticalGroups.push([...run]);
        run = [];
      }
    }
  }

  const monthlyGoalCents = clampInt(
    (bankUsage && bankUsage.monthlyGoal) ||
    (account && account.settings && account.settings.monthly_goal_cents) ||
    DEFAULT_MONTHLY_GOAL_CENTS,
    100,
    1000000
  );
  const baseCents = Math.floor(monthlyGoalCents * SCREEN_BANK_BUILDER_PERCENT);
  const baseUnits = positions.length;
  const horizontalBonusUnits = horizontalGroups.reduce((sum, group) => sum + group.length * (group.length - 1), 0);
  const verticalBonusUnits = verticalGroups.reduce((sum, group) => sum + group.length, 0);
  const units = baseUnits + horizontalBonusUnits + verticalBonusUnits;
  const rawCents = baseCents * units;
  const remainingCap = Math.max(0, Math.min(
    DAILY_BANK_CAP_CENTS - ((bankUsage && bankUsage.today) || 0),
    WEEKLY_BANK_CAP_CENTS - ((bankUsage && bankUsage.week) || 0)
  ));
  const cents = Math.min(rawCents, remainingCap);

  return {
    source_type: "slot_screen_bank_builder",
    positions,
    horizontal_groups: horizontalGroups,
    vertical_groups: verticalGroups,
    base_cents: baseCents,
    goal_cents: monthlyGoalCents,
    base_units: baseUnits,
    horizontal_bonus_units: horizontalBonusUnits,
    vertical_bonus_units: verticalBonusUnits,
    units,
    raw_cents: rawCents,
    cents,
    capped: cents < rawCents,
    percent: SCREEN_BANK_BUILDER_PERCENT,
  };
}

function emptyScreenBankPayout(account, bankUsage) {
  const monthlyGoalCents = clampInt(
    (bankUsage && bankUsage.monthlyGoal) ||
    (account && account.settings && account.settings.monthly_goal_cents) ||
    DEFAULT_MONTHLY_GOAL_CENTS,
    100,
    1000000
  );
  return {
    source_type: "slot_screen_bank_builder",
    positions: [],
    horizontal_groups: [],
    vertical_groups: [],
    base_cents: Math.floor(monthlyGoalCents * SCREEN_BANK_BUILDER_PERCENT),
    goal_cents: monthlyGoalCents,
    base_units: 0,
    horizontal_bonus_units: 0,
    vertical_bonus_units: 0,
    units: 0,
    raw_cents: 0,
    cents: 0,
    capped: false,
    percent: SCREEN_BANK_BUILDER_PERCENT,
  };
}

async function spin(workspaceId, userId) {
  const state = await getState(workspaceId, userId);
  const spinCost = state.constants.spinCost;
  const settings = normalizeSlotSettings(state.account.settings || {});
  const hasRerollCredit = settings.reroll_credits > 0;
  if (!hasRerollCredit && state.account.point_balance < spinCost) {
    const err = new Error("Not enough points");
    err.statusCode = 400;
    throw err;
  }
  const drawPool = state.rewards.filter(r => r.kind !== "miss");
  if (!drawPool.length) {
    const err = new Error("No eligible rewards");
    err.statusCode = 400;
    throw err;
  }
  const outcome = selectThreeStageOutcome(drawPool, settings);
  const selected = outcome.selected;
  const canHitScreenBank = outcome.jackpot_hit && !outcome.empty_bucket && shouldHitScreenBankBuilder();
  const screen = buildSpinScreen(selected, state.account, state.bankUsage, canHitScreenBank);
  const bankDelta = outcome.jackpot_hit && !outcome.empty_bucket ? (screen.payout.cents || 0) : 0;
  const reserveCost = outcome.jackpot_hit && !outcome.empty_bucket ? reserveCostCents(selected) : 0;
  const selectedSnapshot = {
    ...selected,
    source_type: bankDelta > 0 ? "slot_screen_bank_builder" : selected.source_type,
    payment_source: selected.payment_source || (outcome.source && outcome.source.id) || defaultPaymentSourceForKind(selected.kind),
    tier_id: selected.tier_id || (outcome.tier && outcome.tier.id) || "tier_i",
    slot_stages: {
      jackpot_hit: outcome.jackpot_hit,
      jackpot_hit_rate: settings.jackpot_hit_rate,
      payment_source: outcome.source,
      tier: outcome.tier,
      empty_bucket: outcome.empty_bucket,
      reroll_credit: outcome.reroll_credit,
      reward_spin: outcome.empty_bucket ? null : {
        reward_id: selected.id,
        chance_shares: selected.chance_shares || selected.weight || 0,
        bucket_size: outcome.bucket.length,
        bucket_total_shares: outcome.bucket.reduce((sum, r) => sum + (Number(r.chance_shares ?? r.weight) || 0), 0),
      },
    },
    screen_board: screen.board,
    screen_payline: screen.payline,
    bank_screen_payout: screen.payout,
  };
  const status = outcome.reroll_credit
    ? "reroll_credit"
    : selected.kind === "miss"
    ? "miss"
    : selected.kind === "bank_builder" || bankDelta > 0 || reserveCost > 0 || selected.requires_confirmation
    ? "pending"
    : "awarded";
  const bankReserved = reserveCost;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT point_balance, settings FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const lockedSettings = normalizeSlotSettings(account && account.settings);
    const usedRerollCredit = lockedSettings.reroll_credits > 0;
    const lockedSpinCost = usedRerollCredit ? 0 : getSpinCost(account);
    if (!account || account.point_balance < lockedSpinCost) throw new Error("Not enough points");
    const nextRerollCredits = Math.max(0, lockedSettings.reroll_credits - (usedRerollCredit ? 1 : 0)) + (outcome.reroll_credit ? 1 : 0);
    await client.query(
      `UPDATE slot_accounts
       SET point_balance = point_balance - $2,
           settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb,
           updated_at=NOW()
       WHERE workspace_id=$1`,
      [workspaceId, lockedSpinCost, JSON.stringify({ reroll_credits: nextRerollCredits })]
    );
    const { rows } = await client.query(
      `INSERT INTO slot_spins
       (workspace_id,user_id,cost_credits,reward_id,reward_snapshot,status,bank_delta_cents,bank_reserved_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [workspaceId, userId || null, lockedSpinCost, selected.id || null, selectedSnapshot, status, bankDelta || selected.bank_delta_cents || 0, bankReserved]
    );
    if (selected.id) await client.query("UPDATE slot_rewards SET last_won_at=NOW() WHERE id=$1", [selected.id]);
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function confirmSpin(workspaceId, spinId, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM slot_spins WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, spinId]);
    const spinRow = rows[0];
    if (!spinRow) throw notFound("Spin not found");
    if (spinRow.status !== "pending") {
      await client.query("COMMIT");
      return spinRow;
    }
    const snapshot = spinRow.reward_snapshot || {};
    let accountUpdate = "";
    const params = [workspaceId];
    let nextSnapshot = snapshot;
    let nextRewardId = spinRow.reward_id;
    let nextReservedCents = spinRow.bank_reserved_cents || 0;
    if (snapshot.requires_jackpot_choice) {
      const rewardId = options.reward_id || options.rewardId || options.jackpot_reward_id || options.jackpotRewardId;
      if (!rewardId) {
        const err = new Error("Pick a jackpot reward");
        err.statusCode = 400;
        throw err;
      }
      const { rows: rewardRows } = await client.query(
        "SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [workspaceId, rewardId]
      );
      const reward = rewardRows[0];
      if (!reward || !reward.active || reward.weight <= 0 || !isJackpotChoiceReward(reward)) {
        const err = new Error("That jackpot is not available");
        err.statusCode = 400;
        throw err;
      }
      await sweepPendingBankBuildersInTx(client, workspaceId);
      const { rows: [account] } = await client.query("SELECT bank_balance_cents FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
      const reserveCost = reserveCostCents(reward);
      const currentBankDelta = snapshot.source_type === "slot_screen_bank_builder" && spinRow.bank_delta_cents > 0 && !spinRow.bank_reserved_cents
        ? spinRow.bank_delta_cents
        : 0;
      const availableReserve = ((account && account.bank_balance_cents) || 0) + currentBankDelta;
      if (reserveCost > availableReserve) {
        const err = new Error("Not enough Reward Reserve for that jackpot");
        err.statusCode = 400;
        throw err;
      }
      const reserveNet = currentBankDelta - reserveCost;
      if (reserveNet !== 0) {
        accountUpdate = "bank_balance_cents = GREATEST(0, bank_balance_cents + $2),";
        params.push(reserveNet);
      }
      nextRewardId = reward.id;
      nextReservedCents = reserveCost;
      nextSnapshot = {
        ...snapshot,
        ...reward,
        sponsor_splits: normalizeSponsorSplits(reward.sponsor_splits),
        source_type: snapshot.source_type,
        screen_board: snapshot.screen_board,
        screen_payline: snapshot.screen_payline,
        bank_screen_payout: snapshot.bank_screen_payout,
        requires_jackpot_choice: false,
        jackpot_choice_type: jackpotType(reward),
        jackpot_selected_at: new Date().toISOString(),
      };
    } else if (snapshot.kind === "bank_builder" && spinRow.bank_delta_cents > 0) {
      accountUpdate = "bank_balance_cents = bank_balance_cents + $2,";
      params.push(spinRow.bank_delta_cents);
    } else if (["small_paid", "bank_gated"].includes(snapshot.kind) && spinRow.bank_reserved_cents > 0) {
      await sweepPendingBankBuildersInTx(client, workspaceId);
      accountUpdate = "bank_balance_cents = GREATEST(0, bank_balance_cents - $2),";
      params.push(spinRow.bank_reserved_cents);
    }
    if (accountUpdate) {
      await client.query(`UPDATE slot_accounts SET ${accountUpdate} updated_at=NOW() WHERE workspace_id=$1`, params);
    }
    const { rows: [updated] } = await client.query(
      `UPDATE slot_spins
       SET status='confirmed',
           confirmed_at=NOW(),
           reward_id=$3,
           reward_snapshot=$4,
           bank_reserved_cents=$5
       WHERE workspace_id=$1 AND id=$2
       RETURNING *`,
      [workspaceId, spinId, nextRewardId, nextSnapshot, nextReservedCents]
    );
    await client.query("COMMIT");
    return updated;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function sweepPendingBankBuildersInTx(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT id, bank_delta_cents
     FROM slot_spins
     WHERE workspace_id=$1
       AND status='pending'
       AND (
         reward_snapshot->>'kind' = 'bank_builder'
         OR reward_snapshot->>'source_type' = 'slot_screen_bank_builder'
       )
       AND COALESCE(reward_snapshot->>'requires_jackpot_choice', 'false') <> 'true'
     FOR UPDATE`,
    [workspaceId]
  );
  const cents = rows.reduce((sum, row) => sum + (row.bank_delta_cents || 0), 0);
  if (cents > 0) {
    await client.query(
      "UPDATE slot_accounts SET bank_balance_cents = bank_balance_cents + $2, updated_at=NOW() WHERE workspace_id=$1",
      [workspaceId, cents]
    );
    await client.query(
      `UPDATE slot_spins
       SET status='confirmed', confirmed_at=NOW()
       WHERE workspace_id=$1
         AND status='pending'
         AND (
           reward_snapshot->>'kind' = 'bank_builder'
           OR reward_snapshot->>'source_type' = 'slot_screen_bank_builder'
         )
         AND COALESCE(reward_snapshot->>'requires_jackpot_choice', 'false') <> 'true'`,
      [workspaceId]
    );
  }
  return { cents, count: rows.length };
}

async function confirmPendingBankBuilders(workspaceId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { cents, count } = await sweepPendingBankBuildersInTx(client, workspaceId);
    const { rows: [account] } = await client.query("SELECT * FROM slot_accounts WHERE workspace_id=$1", [workspaceId]);
    await client.query("COMMIT");
    return { confirmed_cents: cents, confirmed_count: count, account };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

module.exports = {
  ensureSchema,
  getState,
  updateSettings,
  createReward,
  updateReward,
  deleteReward,
  earnTaskCredit,
  spin,
  confirmSpin,
  confirmPendingBankBuilders,
  _test: {
    buildSpinScreen,
    calculateScreenBankPayout,
    emptyScreenBankPayout,
    normalizeSlotSettings,
    selectThreeStageOutcome,
    chooseWeighted,
  },
};
