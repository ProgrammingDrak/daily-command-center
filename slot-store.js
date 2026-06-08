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
// Shared slot_accounts primitives (also used by punishment-store). The monthly
// default and the account upsert are single-sourced here so the two stores can't
// drift. See slot-account-common.js.
const {
  DEFAULT_MONTHLY_GOAL_CENTS,
  MONTHLY_MIN,
  MONTHLY_MAX,
  upsertSlotAccountRow,
} = require("./slot-account-common");

const DEFAULT_SPIN_COST = DEFAULT_SPIN_COST_POINTS;
const DEFAULT_TARGET_DAILY_SPINS = 28;
// Spin cost is learned from how many points the user actually earns per day:
// average the daily point totals over the trailing window, then price a spin so a
// typical day buys ~SPIN_COST_TARGET_DAILY_SPINS spins. LENIENCY makes spins a
// touch cheaper than break-even so the target is comfortably reachable. Until the
// user has MIN_DAYS of earning history we fall back to DEFAULT_SPIN_COST.
const SPIN_COST_LEARNING_WINDOW_DAYS = 14;
const SPIN_COST_TARGET_DAILY_SPINS = 20;
const SPIN_COST_LENIENCY = 0.9;
const SPIN_COST_MIN_DAYS = 3;
const DEFAULT_MAINTENANCE_HOURS_PER_DAY = 4;
const DEFAULT_ADVANCEMENT_HOURS_PER_DAY = 5;
const DEFAULT_BANK_BUILDER_HIT_RATE = 0.9;
// Jackpot is the rare headline event, not a near-daily occurrence: ~1 in 100
// spins. Like a real slot's PAR sheet, the headline symbol owns a tiny slice of
// the draw while the common "bank" symbol owns the bulk (see SLOT_PAR_SHEET).
const DEFAULT_JACKPOT_HIT_RATE = 0.01;
// Every jackpot lands as a 3-in-a-row (1 spin) by default. From there it can
// climb to a longer run, and each climb clears an independent roll at this rate.
// With the 1-in-100 jackpot rate above, a 10% climb rate makes a 3-in-a-row
// ~1/100, a 4-in-a-row (2 spins) ~1/1000, and a 5-in-a-row (3 spins) ~1/10000 -
// each tier a clean decade rarer than the last.
const DEFAULT_JACKPOT_UPGRADE_RATE = 0.1;
const DEFAULT_FREE_SPIN_TILE_RATE = 0.12;
// True "nothing happens" outcome. Kept deliberately tiny so the floor is almost
// always a real outcome - roughly 1 dead spin in 100, by design.
const DEFAULT_MISS_RATE = 0.01;

// Relative weights for the non-jackpot, non-miss floor. Bank is the dominant
// floor outcome again (the bread-and-butter "small win"); coin/pet are the
// occasional small wins and booster/free_spin are the rarer "bonus" tiles. This
// is the weighted-reel-strip model: bank owns most of the draw so it reads as
// the default, while bonuses stay genuinely scarce. Tunable per account.
const DEFAULT_FLOOR_WEIGHTS = {
  bank: 60,
  coin: 18,
  pet: 10,
  booster: 8,
  free_spin: 4,
};
// PAR sheet (single source of truth for the tuned odds). With the defaults
// above - jackpot 1%, miss 1%, floor weights summing to 100 - a spin lands as
// roughly: bank 58.8%, coin 17.6%, pet/gem 9.8%, booster 7.8%, free_spin 3.9%,
// jackpot 1.0%, miss 1.0%. Bank ends up ~7.5x more common than boosters and
// ~59x more common than jackpots. The distribution test in slot-store.test.js
// re-derives these realized frequencies and asserts they stay on target.
const SLOT_PAR_SHEET = {
  jackpot: 0.010,
  bank: 0.588,
  coin: 0.176,
  pet: 0.098,
  booster: 0.078,
  free_spin: 0.039,
  miss: 0.010,
};
// Coin outcome: either refund the spin (cashback) or drop a pile of points.
const DEFAULT_COIN_CASHBACK_CHANCE = 0.4;
const DEFAULT_COIN_POINT_DROP = [10, 50];
// Booster gamble ladder. Start at the first rung; each "risk" either climbs a
// rung (advance odds) or busts to nothing. "Bank" locks the current multiplier
// onto the next spin. Punchy and stackable, per Drake's call.
const DEFAULT_BOOSTER_LADDER = [2, 3, 5, 10];
const DEFAULT_BOOSTER_ADVANCE_ODDS = 0.5;
const BOOSTER_TYPES = ["bank_multiplier", "tier_up", "miss_shield", "wild_hold"];
// Each booster type climbs its own ladder. bank_multiplier escalates a payout
// multiplier; the rest escalate a count (tiers bumped, misses shielded, or
// guaranteed jackpot spins held).
const BOOSTER_LADDERS = {
  tier_up: [1, 2, 3, 4],
  miss_shield: [1, 2, 3, 4],
  wild_hold: [1, 2, 3, 4],
};
// The bank_multiplier booster grants a collectible charge instead of gambling.
// A booster drops one 2x or 3x charge (2x is the common base); charges combine
// up (two 2x make a 5x, two 3x make a 10x). A charge is spent per spin while the
// player has that tier "armed", multiplying that spin's bank builder.
const MULTIPLIER_CHARGE_TIERS = [2, 3, 5, 10];
const BOOSTER_CHARGE_TIERS = [2, 3];
const BOOSTER_CHARGE_WEIGHTS = [2, 1]; // 2x twice as likely as 3x
const MULTIPLIER_COMBINE = { 2: 5, 3: 10 }; // two of the key tier make one of the value tier
// Collectibles: collect gems, completing a set triggers a guaranteed jackpot spin.
const DEFAULT_COLLECTION_SET_SIZE = 12;
// Bank rework: a bank hit now drops one of several weighted SHAPES so placement
// reads as random instead of "always a 3/4-in-a-row". A shape is a list of cluster
// lengths laid as separate, non-touching runs; calculateScreenBankPayout then groups
// each run on its own. A lone tile (cluster [1]) pays a single unit with no combo.
// Weights are tuned so the mean units/hit stays ~= the old single-line average
// (~9.95); see the Monte-Carlo sim referenced in the slot bank-rewards plan.
const BANK_SHAPES = [
  { key: "single",    clusters: [1],    weight: 9 },  // lone tile -> 1 unit, no multiplier
  { key: "pair",      clusters: [2],    weight: 10 }, // 2-run -> 4 units
  { key: "triple",    clusters: [3],    weight: 26 }, // 3-run -> ~7.9 units
  { key: "quad",      clusters: [4],    weight: 16 }, // 4-run (horizontal) -> 16 units
  { key: "split_1_3", clusters: [1, 3], weight: 8 },  // lone tile + separated block
  { key: "split_2_3", clusters: [2, 3], weight: 14 }, // two separated blocks
  { key: "split_3_3", clusters: [3, 3], weight: 17 }, // two separated 3-blocks
];
const BANK_BUILDER_FLAT_FLOOR_CENTS = 50;
const SCREEN_BANK_BUILDER_PERCENT = 0.0012;
const DEFAULT_POINT_TAG_TIERS = {
  none: [],
  quarter: [],
  half: [],
  full: [],
};
const POINT_TAG_TIER_MULTIPLIERS = {
  none: 0,
  quarter: 0.25,
  half: 0.5,
  full: 1,
};
// Tags assigned under retired lane names map onto the point buckets so existing
// assignments survive the rename without a data migration.
const LEGACY_POINT_TAG_TIER_ALIASES = {
  advancement: "full",
  maintenance: "half",
  light: "quarter",
};
const SLOT_ROWS = 3;
const SLOT_COLS = 5;
const SLOT_CELL_COUNT = SLOT_ROWS * SLOT_COLS;
const FILLER_SYMBOLS = ["MISS"];
const TEASER_SYMBOLS = ["MISS"];
const PAYLINES = [
  [0, 1, 2], [1, 2, 3], [2, 3, 4],
  [5, 6, 7], [6, 7, 8], [7, 8, 9],
  [10, 11, 12], [11, 12, 13], [12, 13, 14],
  [0, 5, 10], [1, 6, 11], [2, 7, 12], [3, 8, 13], [4, 9, 14],
];
// Jackpot win lines grouped by how many guaranteed jackpot spins they pay. The
// engine rolls the tier first (rollJackpotSpins) and the board is then laid out
// to show a real run of the matching length, so the odds stay tunable instead of
// being a side effect of which line happens to get picked.
//   1 spin  -> 3-in-a-row (horizontal or vertical)
//   2 spins -> 4-in-a-row
//   3 spins -> 5-in-a-row
const JACKPOT_PAYLINES_BY_SPINS = {
  3: [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14]],
  2: [[0, 1, 2, 3], [1, 2, 3, 4], [5, 6, 7, 8], [6, 7, 8, 9], [10, 11, 12, 13], [11, 12, 13, 14]],
  1: PAYLINES,
};
const SLOT_SYMBOLS = new Set(["MISS", "BANK", "JACKPOT", "SPIN", "COIN", "STAR", "PAW", "GEM"]);
// "Small win" floor outcomes that pay when their icon forms a 3-in-a-row line.
const SMALL_WIN_SYMBOLS = new Set(["COIN", "STAR", "PAW", "GEM"]);
// Prize icons painted across every non-winning cell so the reels always show
// prizes (no dead MISS tiles). Weighted toward common prizes; jackpot is a rare
// tease. The fill is scrubbed so none of these accidentally form a 3-in-a-row.
const COSMETIC_FILLER_SYMBOLS = ["COIN", "COIN", "COIN", "BANK", "BANK", "STAR", "PAW", "GEM", "SPIN", "JACKPOT"];
// Win lines read as 3-in-a-row; bank occasionally runs longer for a bigger combo.
const WIN_LINE_LENGTH = 3;
// DEFAULT_MONTHLY_GOAL_CENTS now imported from slot-account-common (shared with punishment-store).
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
const DEFAULT_SOURCE_WEIGHTS = { self: 45, sponsored: 25, free: 30 };
const MAX_BANKROLL_GOAL_CENTS = 10000000;
const DEFAULT_REWARD_TIERS = [
  { id: "tier_i", label: "Tier 1", weight: 36, active: true },
  { id: "tier_ii", label: "Tier 2", weight: 24, active: true },
  { id: "tier_iii", label: "Tier 3", weight: 16, active: true },
  { id: "tier_iv", label: "Tier 4", weight: 10, active: true },
  { id: "tier_v", label: "Tier 5", weight: 8, active: true },
  { id: "tier_vi", label: "Tier 6", weight: 6, active: true },
];
const REWARD_TIER_PERCENT_TOTAL = 100;

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
    duration_minutes: 0,
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

function rewardTierPercentTotal(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .filter(tier => tier && tier.active !== false)
    .reduce((sum, tier) => sum + clampInt(tier.weight, 0, 1000000), 0);
}

function assertRewardTierPercentTotal(tiers) {
  const activeCount = (Array.isArray(tiers) ? tiers : []).filter(tier => tier && tier.active !== false).length;
  if (!activeCount) {
    const err = new Error("Keep at least one active jackpot tier.");
    err.statusCode = 400;
    throw err;
  }
  const total = rewardTierPercentTotal(tiers);
  if (total !== REWARD_TIER_PERCENT_TOTAL) {
    const err = new Error(`Tier percentages must add up to 100%. Current active total: ${total}%.`);
    err.statusCode = 400;
    throw err;
  }
}

function normalizeSourceWeights(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    self: clampInt(raw.self ?? DEFAULT_SOURCE_WEIGHTS.self, 0, 1000000),
    sponsored: clampInt(raw.sponsored ?? raw.sponsor ?? DEFAULT_SOURCE_WEIGHTS.sponsored, 0, 1000000),
    free: clampInt(raw.free ?? DEFAULT_SOURCE_WEIGHTS.free, 0, 1000000),
  };
}

function normalizeBankrollGoal(value) {
  const raw = value && typeof value === "object" ? value : {};
  const rewardId = raw.reward_id ?? raw.rewardId;
  const iconId = String(raw.icon_id || raw.iconId || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return {
    enabled: raw.enabled === true,
    reward_id: rewardId == null || rewardId === "" ? null : Number.parseInt(rewardId, 10),
    target_cents: clampInt(raw.target_cents ?? raw.targetCents ?? 0, 0, MAX_BANKROLL_GOAL_CENTS),
    icon_id: iconId || "gift",
    description: String(raw.description || "").trim().slice(0, 500),
    funded_at: raw.funded_at || raw.fundedAt || null,
    celebration_spin_claimed_at: raw.celebration_spin_claimed_at || raw.celebrationSpinClaimedAt || null,
    updated_at: raw.updated_at || raw.updatedAt || null,
  };
}

function normalizeRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function normalizeJackpotHitRate(value) {
  return normalizeRate(value, DEFAULT_JACKPOT_HIT_RATE);
}

function normalizeJackpotUpgradeRate(value) {
  return normalizeRate(value, DEFAULT_JACKPOT_UPGRADE_RATE);
}

function normalizeBankBuilderHitRate(value) {
  return normalizeRate(value, DEFAULT_BANK_BUILDER_HIT_RATE);
}

function roundToNearestFive(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPIN_COST;
  return Math.max(5, Math.round(n / 5) * 5);
}

function normalizeHours(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(16, Math.round(n * 4) / 4));
}

function normalizeProfileNotes(value) {
  return String(value == null ? "" : value).trim().slice(0, 1000);
}

function normalizeEconomyProfile(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const monthly = clampInt(
    raw.monthly_discretionary_cents ??
    raw.monthlyDiscretionaryCents ??
    raw.monthly_goal_cents ??
    raw.monthlyGoalCents ??
    DEFAULT_MONTHLY_GOAL_CENTS,
    100,
    1000000
  );
  return {
    maintenance_hours_per_day: normalizeHours(
      raw.maintenance_hours_per_day ?? raw.maintenanceHoursPerDay,
      DEFAULT_MAINTENANCE_HOURS_PER_DAY
    ),
    advancement_hours_per_day: normalizeHours(
      raw.advancement_hours_per_day ?? raw.advancementHoursPerDay,
      DEFAULT_ADVANCEMENT_HOURS_PER_DAY
    ),
    target_daily_spins: DEFAULT_TARGET_DAILY_SPINS,
    monthly_discretionary_cents: monthly,
    maintenance_notes: normalizeProfileNotes(raw.maintenance_notes ?? raw.maintenanceNotes ?? raw.maintenance_examples ?? raw.maintenanceExamples),
    advancement_notes: normalizeProfileNotes(raw.advancement_notes ?? raw.advancementNotes ?? raw.advancement_examples ?? raw.advancementExamples),
    completed_at: raw.completed_at || raw.completedAt || null,
    updated_at: raw.updated_at || raw.updatedAt || null,
  };
}

function deriveEconomySettings(profile = {}) {
  const normalized = normalizeEconomyProfile(profile);
  return {
    // Cold-start placeholder only. The live spin cost is learned from the user's
    // points-per-day history at read/spin time (see learnedSpinCost).
    spin_cost: DEFAULT_SPIN_COST,
    monthly_goal_cents: normalized.monthly_discretionary_cents,
    bankroll_pacing: {
      target_daily_spins: DEFAULT_TARGET_DAILY_SPINS,
      bank_builder_base_percent: SCREEN_BANK_BUILDER_PERCENT,
    },
    bank_builder_hit_rate: DEFAULT_BANK_BUILDER_HIT_RATE,
    jackpot_hit_rate: DEFAULT_JACKPOT_HIT_RATE,
    jackpot_upgrade_rate: DEFAULT_JACKPOT_UPGRADE_RATE,
    free_spin_tile_rate: DEFAULT_FREE_SPIN_TILE_RATE,
    miss_rate: DEFAULT_MISS_RATE,
  };
}

function normalizeCustomizationUnlocks(value = {}, profile = {}) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    simple_setup: raw.simple_setup !== false,
    tag_sorting: raw.tag_sorting === true || !!profile.completed_at,
  };
}

function normalizePointTagTiers(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  // Fold any retired lane names (maintenance/advancement/light) onto their point
  // bucket so old saved assignments carry over transparently.
  const merged = {};
  for (const [key, ids] of Object.entries(raw)) {
    const bucket = LEGACY_POINT_TAG_TIER_ALIASES[key] || key;
    if (!(bucket in DEFAULT_POINT_TAG_TIERS)) continue;
    merged[bucket] = (merged[bucket] || []).concat(Array.isArray(ids) ? ids : []);
  }
  const normalized = {};
  const claimed = new Set();
  for (const tier of Object.keys(DEFAULT_POINT_TAG_TIERS)) {
    const ids = Array.isArray(merged[tier]) ? merged[tier] : [];
    // A tag lives in at most one bucket; first bucket to claim it wins.
    const unique = [];
    for (const raw of ids) {
      const id = String(raw || "").trim();
      if (!id || claimed.has(id)) continue;
      claimed.add(id);
      unique.push(id);
    }
    normalized[tier] = unique.slice(0, 250);
  }
  return normalized;
}

function normalizeFloorWeights(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const normalized = {};
  for (const key of Object.keys(DEFAULT_FLOOR_WEIGHTS)) {
    normalized[key] = clampInt(raw[key] ?? DEFAULT_FLOOR_WEIGHTS[key], 0, 1000000);
  }
  // Never let every weight collapse to zero - fall back to a bank builder.
  if (Object.values(normalized).every(w => w <= 0)) normalized.bank = 1;
  return normalized;
}

function normalizeBoosterConfig(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const ladderRaw = Array.isArray(raw.ladder) && raw.ladder.length ? raw.ladder : DEFAULT_BOOSTER_LADDER;
  const ladder = ladderRaw
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n > 1)
    .slice(0, 8);
  return {
    ladder: ladder.length ? ladder : [...DEFAULT_BOOSTER_LADDER],
    advance_odds: normalizeRate(raw.advance_odds ?? raw.advanceOdds, DEFAULT_BOOSTER_ADVANCE_ODDS),
  };
}

function normalizeCoinConfig(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const dropRaw = Array.isArray(raw.point_drop ?? raw.pointDrop) ? (raw.point_drop ?? raw.pointDrop) : DEFAULT_COIN_POINT_DROP;
  const lo = clampInt(dropRaw[0] ?? DEFAULT_COIN_POINT_DROP[0], 1, 100000);
  const hi = clampInt(dropRaw[1] ?? DEFAULT_COIN_POINT_DROP[1], lo, 100000);
  return {
    cashback_chance: normalizeRate(raw.cashback_chance ?? raw.cashbackChance, DEFAULT_COIN_CASHBACK_CHANCE),
    point_drop: [lo, hi],
  };
}

function normalizeCollection(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    gems: clampInt(raw.gems, 0, 1000000),
    sets_completed: clampInt(raw.sets_completed ?? raw.setsCompleted, 0, 1000000),
    set_size: clampInt(raw.set_size ?? raw.setSize ?? DEFAULT_COLLECTION_SET_SIZE, 1, 1000),
  };
}

function normalizePet(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const cosmeticsRaw = Array.isArray(raw.cosmetics) ? raw.cosmetics : [];
  return {
    treats: clampInt(raw.treats, 0, 1000000),
    cosmetics: [...new Set(cosmeticsRaw.map(id => String(id || "").trim()).filter(Boolean))].slice(0, 250),
  };
}

function normalizeNextSpinModifiers(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    tier_up: clampInt(raw.tier_up ?? raw.tierUp, 0, 10),
    // Count of queued miss shields (each converts one would-be miss to a bank builder).
    miss_shield: clampInt(raw.miss_shield ?? raw.missShield, 0, 50),
  };
}

// Stash of collectible bank-multiplier charges, keyed by multiplier tier.
function normalizeMultiplierCharges(value = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const charges = {};
  for (const tier of MULTIPLIER_CHARGE_TIERS) {
    charges[tier] = clampInt(raw[tier] ?? raw[String(tier)], 0, 100000);
  }
  return charges;
}

// The tier the player has "armed" to spend each spin (0 = none). Only a tier
// that actually has charges can stay armed.
function normalizeActiveMultiplier(value, charges = {}) {
  const tier = clampInt(value, 0, 10);
  if (!MULTIPLIER_CHARGE_TIERS.includes(tier)) return 0;
  return (charges[tier] || 0) > 0 ? tier : 0;
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
      duration_minutes INTEGER NOT NULL DEFAULT 0,
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

    ALTER TABLE slot_rewards
      ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE slot_rewards
      ADD COLUMN IF NOT EXISTS public_visibility TEXT NOT NULL DEFAULT 'public',
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS uses_remaining INTEGER;

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
  const row = await upsertSlotAccountRow(pool, workspaceId, userId);
  let account = await migrateAccountPointsV2(workspaceId, row);
  account = await migrateAccountPointsV3(workspaceId, account);
  account = await migrateAccountSlotOdds(workspaceId, account);
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

// One-time heal for the bank-dominant / 1% jackpot recalibration (commit e5b9019).
// Lowering DEFAULT_JACKPOT_HIT_RATE only changed the default for NEW/derived
// settings - it did NOT migrate accounts that had already persisted an elevated
// jackpot_hit_rate (e.g. an old QA value of 0.2 = 20%). normalizeSlotSettings
// prefers the stored value over the derived default (it must, so credit-funded
// spins can force jackpot_hit_rate: 1 through the same path), so a stale stored
// 0.2 kept firing ~1 jackpot every 5 spins instead of the intended ~1 in 100.
// This pulls the engine-controlled odds back onto the current PAR sheet exactly
// once per account so the recalibration actually lands for existing players.
const SLOT_ODDS_MIGRATION_KEY = "slot_odds_par_sheet_migrated_at";

async function migrateAccountSlotOdds(workspaceId, account) {
  const settings = account && account.settings ? account.settings : {};
  if (settings[SLOT_ODDS_MIGRATION_KEY]) return account;
  const derived = deriveEconomySettings(normalizeEconomyProfile(settings.economy_profile || settings));
  const patch = {
    jackpot_hit_rate: derived.jackpot_hit_rate,
    jackpot_upgrade_rate: derived.jackpot_upgrade_rate,
    bank_builder_hit_rate: derived.bank_builder_hit_rate,
    free_spin_tile_rate: derived.free_spin_tile_rate,
    miss_rate: derived.miss_rate,
    floor_weights: { ...DEFAULT_FLOOR_WEIGHTS },
    [SLOT_ODDS_MIGRATION_KEY]: new Date().toISOString(),
  };
  const { rows: [updated] } = await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND NOT (COALESCE(settings, '{}'::jsonb) ? '${SLOT_ODDS_MIGRATION_KEY}')
     RETURNING *`,
    [workspaceId, JSON.stringify(patch)]
  );
  if (updated) return updated;
  const { rows: [current] } = await pool.query("SELECT * FROM slot_accounts WHERE workspace_id = $1", [workspaceId]);
  return current || account;
}

function normalizeSlotSettings(settings = {}) {
  const raw = settings && typeof settings === "object" ? settings : {};
  const economyProfile = normalizeEconomyProfile(raw.economy_profile || raw.economyProfile || raw);
  const derived = deriveEconomySettings(economyProfile);
  return {
    ...raw,
    economy_profile: economyProfile,
    customization_unlocks: normalizeCustomizationUnlocks(raw.customization_unlocks || raw.customizationUnlocks, economyProfile),
    point_tag_tiers: normalizePointTagTiers(raw.point_tag_tiers || raw.pointTagTiers),
    spin_cost: clampInt(raw.spin_cost ?? raw.spinCost ?? derived.spin_cost, 5, 250),
    jackpot_hit_rate: normalizeJackpotHitRate(raw.jackpot_hit_rate ?? raw.jackpotHitRate ?? derived.jackpot_hit_rate),
    jackpot_upgrade_rate: normalizeJackpotUpgradeRate(raw.jackpot_upgrade_rate ?? raw.jackpotUpgradeRate ?? derived.jackpot_upgrade_rate),
    bank_builder_hit_rate: normalizeBankBuilderHitRate(raw.bank_builder_hit_rate ?? raw.bankBuilderHitRate ?? derived.bank_builder_hit_rate),
    free_spin_tile_rate: normalizeRate(raw.free_spin_tile_rate ?? raw.freeSpinTileRate ?? derived.free_spin_tile_rate, derived.free_spin_tile_rate),
    miss_rate: normalizeRate(raw.miss_rate ?? raw.missRate ?? derived.miss_rate, derived.miss_rate),
    floor_weights: normalizeFloorWeights(raw.floor_weights || raw.floorWeights),
    booster_config: normalizeBoosterConfig(raw.booster_config || raw.boosterConfig),
    coin_config: normalizeCoinConfig(raw.coin_config || raw.coinConfig),
    collection: normalizeCollection(raw.collection),
    pet: normalizePet(raw.pet),
    next_spin_modifiers: normalizeNextSpinModifiers(raw.next_spin_modifiers || raw.nextSpinModifiers),
    multiplier_charges: normalizeMultiplierCharges(raw.multiplier_charges || raw.multiplierCharges),
    active_multiplier: normalizeActiveMultiplier(raw.active_multiplier ?? raw.activeMultiplier, normalizeMultiplierCharges(raw.multiplier_charges || raw.multiplierCharges)),
    bankroll_pacing: raw.bankroll_pacing && typeof raw.bankroll_pacing === "object" ? { ...derived.bankroll_pacing, ...raw.bankroll_pacing } : derived.bankroll_pacing,
    payment_source_weights: normalizeSourceWeights(raw.payment_source_weights || raw.paymentSourceWeights),
    reward_tiers: normalizeRewardTiers(raw.reward_tiers || raw.rewardTiers),
    reroll_credits: clampInt(raw.reroll_credits ?? raw.rerollCredits ?? 0, 0, 1000),
    jackpot_spin_credits: clampInt(raw.jackpot_spin_credits ?? raw.jackpotSpinCredits ?? 0, 0, 1000),
    monthly_goal_cents: clampInt(raw.monthly_goal_cents ?? raw.monthlyGoalCents ?? derived.monthly_goal_cents, 100, 1000000),
    bankroll_goal: normalizeBankrollGoal(raw.bankroll_goal || raw.bankrollGoal),
    shortfall_penalty: String(raw.shortfall_penalty || DEFAULT_SHORTFALL_PENALTY),
    scoring_rationale: String(raw.scoring_rationale || DEFAULT_SCORING_RATIONALE),
    next_spin_tile_override: normalizeStoredNextSpinTileOverride(raw.next_spin_tile_override || raw.nextSpinTileOverride),
  };
}

function accountWithSettings(account) {
  if (!account) return account;
  return { ...account, settings: normalizeSlotSettings(account.settings) };
}

function getSpinCost(account) {
  return normalizeSlotSettings(account && account.settings).spin_cost;
}

// Price a spin from how many points the user actually earns on a typical day.
// Averages the per-day point totals over active days in the trailing window, then
// sets the cost so a typical day buys ~SPIN_COST_TARGET_DAILY_SPINS spins (with a
// 10% leniency discount). Falls back to DEFAULT_SPIN_COST until the user has
// SPIN_COST_MIN_DAYS of earning history. Returns the cost plus the basis the UI
// shows to explain it.
// Pure pricing: turn an average points-per-day into a spin cost. Below MIN_DAYS of
// history we can't trust the average, so we hold at the default.
function spinCostForDailyPoints(avgDailyPoints, days) {
  if (!(Number(days) >= SPIN_COST_MIN_DAYS)) return DEFAULT_SPIN_COST;
  return clampInt(
    roundToNearestFive((Number(avgDailyPoints) * SPIN_COST_LENIENCY) / SPIN_COST_TARGET_DAILY_SPINS),
    5,
    250
  );
}

async function learnedSpinCost(workspaceId) {
  const { rows: [agg] } = await pool.query(
    `SELECT COALESCE(AVG(daily), 0)::float AS avg_daily, COUNT(*)::int AS days
       FROM (
         SELECT SUM(delta) AS daily
           FROM slot_point_ledger
          WHERE workspace_id = $1
            AND source_type = 'task_complete'
            AND delta > 0
            AND created_at >= date_trunc('day', NOW()) - ($2::int - 1) * INTERVAL '1 day'
          GROUP BY date_trunc('day', created_at)
       ) d`,
    [workspaceId, SPIN_COST_LEARNING_WINDOW_DAYS]
  );
  const avgDailyPoints = Math.round(Number(agg && agg.avg_daily) || 0);
  const days = Number(agg && agg.days) || 0;
  return {
    cost: spinCostForDailyPoints(avgDailyPoints, days),
    avgDailyPoints,
    days,
    learned: days >= SPIN_COST_MIN_DAYS,
    windowDays: SPIN_COST_LEARNING_WINDOW_DAYS,
    targetDailySpins: SPIN_COST_TARGET_DAILY_SPINS,
  };
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
  const durationMinutes = clampInt(body.duration_minutes ?? body.durationMinutes ?? body.duration, 0, 1440);
  const isPrivate = body.public_visibility === "private" || body.publicVisibility === "private" || body.private === true;
  const expiresRaw = body.expires_at ?? body.expiresAt;
  let expiresAt = null;
  if (expiresRaw) {
    const d = new Date(expiresRaw);
    if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
  }
  const usesRaw = body.uses_remaining ?? body.usesRemaining;
  let usesRemaining = null;
  if (usesRaw != null && usesRaw !== "") {
    const n = parseInt(usesRaw, 10);
    if (Number.isFinite(n) && n > 0) usesRemaining = Math.min(n, 9999);
  }
  // Preserve gating fields rather than hardcoding them, so an organizational
  // edit (drag, archive, share change) that round-trips the reward through this
  // normalizer does not silently wipe a reward's bank delta, cooldown, sponsor
  // state, or confirmation requirement. Callers that omit a field still get the
  // schema default (the client form sends the stored values back).
  const bankDeltaRaw = parseInt(body.bank_delta_cents ?? body.bankDeltaCents, 10);
  const bankDeltaCents = Number.isFinite(bankDeltaRaw) ? bankDeltaRaw : 0;
  const requiresConfirmation =
    body.requires_confirmation === true || body.requiresConfirmation === true;
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
    sponsor_active: (body.sponsor_active ?? body.sponsorActive) !== false,
    value_cents: valueCents,
    bank_delta_cents: bankDeltaCents,
    duration_minutes: durationMinutes,
    requires_confirmation: requiresConfirmation,
    cooldown_days: clampInt(body.cooldown_days ?? body.cooldownDays, 0, 365),
    unlock_threshold_cents: Math.max(0, parseInt(body.unlock_threshold_cents ?? body.unlockThresholdCents, 10) || 0),
    notes: String(body.notes || ""),
    public_visibility: isPrivate ? "private" : "public",
    expires_at: expiresAt,
    uses_remaining: usesRemaining,
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

function isSelfFundedPaidReward(row) {
  return !!row &&
    ["small_paid", "bank_gated"].includes(row.kind) &&
    normalizePaymentSource(row.payment_source, row.kind) === "self" &&
    reserveCostCents(row) > 0;
}

function isBankrollGoalModeActive(settings = {}) {
  const goal = normalizeSlotSettings(settings).bankroll_goal;
  return !!(goal.enabled && goal.reward_id && goal.target_cents > 0 && !goal.celebration_spin_claimed_at);
}

function isBankrollGoalExcluded(row, settings = {}) {
  return isBankrollGoalModeActive(settings) && isSelfFundedPaidReward(row);
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
  const bankrollGoalExcluded = isBankrollGoalExcluded(row, account && account.settings);
  const expired = !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
  const usesExhausted = row.uses_remaining != null && Number(row.uses_remaining) <= 0;
  const lifespanExhausted = expired || usesExhausted;
  // The jackpot only ever rolls into active tiers and sources whose weight > 0
  // (see tierOptions/sourceOptions + bucketForSourceTier). A reward assigned to a
  // deactivated tier or a zeroed-out source is therefore unwinnable; surface that
  // as a lock instead of letting it read as eligible/green in the UI.
  const settings = (account && account.settings) || {};
  const tierActive = tierOptions(settings).some(t => String(t.id) === String(row.tier_id || "tier_i"));
  const sourceEnabled = sourceOptions(settings).some(s => s.id === paymentSource && Number(s.weight) > 0);
  return {
    ...row,
    payment_source: paymentSource,
    tier_id: String(row.tier_id || "tier_i"),
    chance_shares: chanceShares,
    weight: chanceShares,
    duration_minutes: Math.max(0, parseInt(row.duration_minutes, 10) || 0),
    sponsor_splits: normalizeSponsorSplits(row.sponsor_splits),
    public_visibility: row.public_visibility === "private" ? "private" : "public",
    expires_at: row.expires_at || null,
    uses_remaining: row.uses_remaining != null ? Number(row.uses_remaining) : null,
    lifespan_exhausted: lifespanExhausted,
    eligible: !!row.active && chanceShares > 0 && tierActive && sourceEnabled && !bankCapLocked && !reserveLocked && !bankrollGoalExcluded && !lifespanExhausted,
    jackpot_type: jackpotType(row),
    bankroll_goal_excluded: bankrollGoalExcluded,
    reserve_cost_cents: threshold,
    reserve_affordable: reserveAffordable,
    reserve_shortfall_cents: Math.max(0, threshold - bankBalance),
    locked_reason: !row.active ? "inactive" :
      chanceShares <= 0 ? "zero_weight" :
      lifespanExhausted ? "expired" :
      !tierActive ? "tier_inactive" :
      !sourceEnabled ? "source_disabled" :
      bankrollGoalExcluded ? "bankroll_goal" :
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
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents,
            EXTRACT(DAY FROM NOW())::int AS day_of_month,
            EXTRACT(DAY FROM (date_trunc('month', NOW()) + INTERVAL '1 month - 1 day'))::int AS days_in_month
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND bank_delta_cents > 0
       AND (reward_snapshot->>'kind' = 'bank_builder'
            OR reward_snapshot->>'source_type' = 'slot_screen_bank_builder')
       AND created_at >= date_trunc('month', NOW())`,
    [workspaceId]
  );
  const monthlyGoal = clampInt(settings.monthly_goal_cents || DEFAULT_MONTHLY_GOAL_CENTS, MONTHLY_MIN, MONTHLY_MAX);
  // Final week = the last 7 calendar days of the month. During it, bank builders
  // value off the full monthly allotment instead of the remainder so a strong run
  // can still max the bar out. (See calculateScreenBankPayout for the pacing.)
  const dayOfMonth = month.day_of_month || 0;
  const daysInMonth = month.days_in_month || 0;
  const finalWeek = daysInMonth > 0 && dayOfMonth > daysInMonth - 7;
  return {
    today: today.cents,
    week: week.cents,
    month: month.cents,
    monthlyGoal,
    monthlyRemaining: Math.max(0, monthlyGoal - month.cents),
    finalWeek,
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

function buildBankrollGoalState(account, rewardRows, bankUsage, funding) {
  const settings = normalizeSlotSettings(account && account.settings);
  const goal = settings.bankroll_goal;
  const baseFunding = funding || {};
  const disabled = {
    enabled: false,
    reward: null,
    reward_id: null,
    target_cents: 0,
    icon_id: goal.icon_id || "gift",
    description: goal.description || "",
    ready_cents: baseFunding.ready || 0,
    pending_cents: baseFunding.pending || 0,
    total_cents: baseFunding.total || 0,
    remaining_cents: 0,
    progress_percent: 0,
    funded: false,
    claimable: false,
    completed: false,
    missing: false,
    funded_at: null,
    celebration_spin_claimed_at: null,
  };
  if (!goal.enabled) return disabled;

  const row = (rewardRows || []).find(r => String(r.id) === String(goal.reward_id));
  const ready = baseFunding.ready || 0;
  const pending = baseFunding.pending || 0;
  const total = baseFunding.total != null ? baseFunding.total : ready + pending;
  const target = Math.max(goal.target_cents || reserveCostCents(row), 0);
  const completed = !!goal.celebration_spin_claimed_at;
  const funded = target > 0 && total >= target;
  const displayAccount = {
    ...(account || {}),
    settings: {
      ...settings,
      bankroll_goal: { ...goal, enabled: false },
    },
  };
  return {
    enabled: true,
    reward: row ? rowToReward(row, displayAccount, bankUsage, total) : null,
    reward_id: goal.reward_id,
    target_cents: target,
    icon_id: goal.icon_id || "gift",
    description: goal.description || (row && row.notes) || "",
    ready_cents: ready,
    pending_cents: pending,
    total_cents: total,
    remaining_cents: Math.max(0, target - total),
    progress_percent: target > 0 ? Math.max(0, Math.min(100, Math.round((total / target) * 100))) : 0,
    funded,
    claimable: !!row && funded && !completed,
    completed,
    missing: !row,
    funded_at: goal.funded_at || null,
    celebration_spin_claimed_at: goal.celebration_spin_claimed_at || null,
  };
}

async function getState(workspaceId, userId) {
  const account = accountWithSettings(await ensureAccount(workspaceId, userId));
  const spinCostBasis = await learnedSpinCost(workspaceId);
  const spinCost = spinCostBasis.cost;
  const bankUsage = await getBankUsage(workspaceId, account.settings);
  const pendingBankDeposit = await getPendingBankDeposit(workspaceId);
  const funding = {
    ready: account.bank_balance_cents || 0,
    pending: pendingBankDeposit.cents || 0,
    total: (account.bank_balance_cents || 0) + (pendingBankDeposit.cents || 0),
  };
  const { rows: rewardRows } = await pool.query(
    "SELECT * FROM slot_rewards WHERE workspace_id = $1 AND kind <> $2 AND deleted_at IS NULL ORDER BY active DESC, sort_order ASC, id ASC",
    [workspaceId, LEGACY_BANK_BUILDER_KIND]
  );
  const bankrollGoal = buildBankrollGoalState(account, rewardRows, bankUsage, funding);
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
    bankrollGoal,
    constants: {
      spinCost,
      spinCostPoints: spinCost,
      spinCostBasis,
      pointsPerSpin: POINTS_PER_SPIN,
      pointsFormulaVersion: POINTS_FORMULA_VERSION,
      maxTaskCredits: null,
      monthlyGoalCents: account.settings.monthly_goal_cents,
      economyProfile: account.settings.economy_profile,
      customizationUnlocks: account.settings.customization_unlocks,
      pointTagTiers: account.settings.point_tag_tiers,
      profileSummary: {
        dailyRhythm: "A solid day earns a lot of spins.",
        sweetTreatsBudgetCents: account.settings.economy_profile.monthly_discretionary_cents,
      },
      jackpotHitRate: account.settings.jackpot_hit_rate,
      bankBuilderHitRate: account.settings.bank_builder_hit_rate,
      freeSpinTileRate: account.settings.free_spin_tile_rate,
      missRate: account.settings.miss_rate,
      floorWeights: account.settings.floor_weights,
      boosterConfig: account.settings.booster_config,
      coinConfig: account.settings.coin_config,
      collection: account.settings.collection,
      pet: account.settings.pet,
      nextSpinModifiers: account.settings.next_spin_modifiers,
      multiplierCharges: account.settings.multiplier_charges,
      activeMultiplier: account.settings.active_multiplier,
      paymentSourceWeights: account.settings.payment_source_weights,
      rewardTiers: account.settings.reward_tiers,
      rerollCredits: account.settings.reroll_credits,
      jackpotSpinCredits: account.settings.jackpot_spin_credits,
      bonusRewardSpinCredits: account.settings.jackpot_spin_credits,
      shortfallPenalty: account.settings.shortfall_penalty,
      scoringRationale: account.settings.scoring_rationale,
      bankrollGoalModeEnabled: isBankrollGoalModeActive(account.settings),
    },
  };
}

async function updateSettings(workspaceId, userId, body = {}) {
  const account = accountWithSettings(await ensureAccount(workspaceId, userId));
  const current = account.settings || {};
  const hasProfileUpdate = !!(body.economy_profile || body.economyProfile);
  const incomingProfile = hasProfileUpdate ? (body.economy_profile || body.economyProfile) : current.economy_profile;
  const economyProfile = normalizeEconomyProfile({
    ...(current.economy_profile || {}),
    ...(incomingProfile || {}),
    completed_at: (incomingProfile && (incomingProfile.completed_at || incomingProfile.completedAt)) ||
      (hasProfileUpdate ? new Date().toISOString() : current.economy_profile && current.economy_profile.completed_at),
    updated_at: hasProfileUpdate ? new Date().toISOString() : current.economy_profile && current.economy_profile.updated_at,
  });
  const derived = deriveEconomySettings(economyProfile);
  const rewardTiers = normalizeRewardTiers(
    body.reward_tiers || body.rewardTiers || current.reward_tiers || DEFAULT_REWARD_TIERS
  );
  // Only validate the 100% total when the tiers actually changed. Otherwise an
  // unrelated save (e.g. the Sweet Treats budget) that merely re-sends the
  // existing tiers would be rejected whenever the stored tiers drift off 100%.
  const tiersChanged =
    (!!(body.reward_tiers || body.rewardTiers)) &&
    JSON.stringify(rewardTiers) !== JSON.stringify(normalizeRewardTiers(current.reward_tiers || DEFAULT_REWARD_TIERS));
  if (tiersChanged) assertRewardTierPercentTotal(rewardTiers);
  const currentUnlocks = current.customization_unlocks || {};
  const incomingUnlocks = body.customization_unlocks || body.customizationUnlocks || {};
  const next = {
    ...current,
    economy_profile: economyProfile,
    customization_unlocks: normalizeCustomizationUnlocks({
      ...currentUnlocks,
      ...incomingUnlocks,
      tag_sorting: incomingUnlocks.tag_sorting ?? currentUnlocks.tag_sorting ?? hasProfileUpdate,
    }, economyProfile),
    point_tag_tiers: normalizePointTagTiers(
      body.point_tag_tiers || body.pointTagTiers || current.point_tag_tiers || DEFAULT_POINT_TAG_TIERS
    ),
    spin_cost: derived.spin_cost,
    jackpot_hit_rate: derived.jackpot_hit_rate,
    bank_builder_hit_rate: derived.bank_builder_hit_rate,
    free_spin_tile_rate: derived.free_spin_tile_rate,
    bankroll_pacing: derived.bankroll_pacing,
    payment_source_weights: normalizeSourceWeights(
      body.payment_source_weights || body.paymentSourceWeights || current.payment_source_weights || DEFAULT_SOURCE_WEIGHTS
    ),
    reward_tiers: rewardTiers,
    reroll_credits: clampInt(
      body.reroll_credits ?? body.rerollCredits ?? current.reroll_credits ?? 0,
      0,
      1000
    ),
    monthly_goal_cents: clampInt(
      derived.monthly_goal_cents,
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
  const saved = accountWithSettings(rows[0]);
  // When a tier is deactivated, any active reward still assigned to it becomes
  // unwinnable (the jackpot only rolls into active tiers). Migrate those rewards
  // to the lowest active tier so they stay in rotation, and report the count so
  // the caller can tell the user. Source disabling is rarer and fights kind
  // normalization, so it is surfaced via the source_disabled lock instead.
  let reassignedTier = 0;
  if (tiersChanged) {
    const activeTierIds = tierOptions(next).map(t => String(t.id));
    const fallbackTier = activeTierIds[0];
    if (fallbackTier && activeTierIds.length) {
      const res = await pool.query(
        `UPDATE slot_rewards SET tier_id=$2, updated_at=NOW()
         WHERE workspace_id=$1 AND deleted_at IS NULL AND active=TRUE
           AND NOT (tier_id = ANY($3::text[]))`,
        [workspaceId, fallbackTier, activeTierIds]
      );
      reassignedTier = res.rowCount || 0;
    }
  }
  saved.reward_reassignments = { tier: reassignedTier };
  return saved;
}

async function setBankrollGoal(workspaceId, userId, body = {}) {
  await ensureAccount(workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    let rewardRow = null;
    const rewardId = body.reward_id || body.rewardId;
    if (rewardId) {
      const { rows } = await client.query(
        "SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [workspaceId, rewardId]
      );
      rewardRow = rows[0];
      if (!rewardRow) throw notFound("Reward not found");
    } else {
      const title = String(body.title || "").trim();
      const targetCents = Math.max(0, parseInt(body.target_cents ?? body.targetCents ?? body.value_cents ?? body.valueCents, 10) || 0);
      if (!title) {
        const err = new Error("Reward or title required");
        err.statusCode = 400;
        throw err;
      }
      if (targetCents <= 0) {
        const err = new Error("Bankroll goal needs a positive target");
        err.statusCode = 400;
        throw err;
      }
      const { rows } = await client.query(
        `INSERT INTO slot_rewards
         (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,chance_shares,payment_source,tier_id,active,sponsor_active,value_cents,bank_delta_cents,requires_confirmation,cooldown_days,unlock_threshold_cents,notes)
         VALUES ($1,$2,'bank_gated','self','[]',$3,$3,'self',$4,TRUE,TRUE,$5,0,FALSE,0,$5,$6)
         RETURNING *`,
        [workspaceId, title, Math.max(0, parseInt(body.chance_shares ?? body.weight, 10) || 0), String(body.tier_id || body.tierId || "tier_i"), targetCents, String(body.notes || "Dedicated bankroll goal.")]
      );
      rewardRow = rows[0];
    }
    if (!isSelfFundedPaidReward(rewardRow)) {
      const err = new Error("Bankroll goal must be a self-funded paid reward");
      err.statusCode = 400;
      throw err;
    }
    const targetCents = Math.max(
      parseInt(body.target_cents ?? body.targetCents, 10) || 0,
      reserveCostCents(rewardRow)
    );
    if (targetCents <= 0) {
      const err = new Error("Bankroll goal needs a positive target");
      err.statusCode = 400;
      throw err;
    }
    const nextGoal = {
      enabled: true,
      reward_id: rewardRow.id,
      target_cents: Math.min(targetCents, MAX_BANKROLL_GOAL_CENTS),
      icon_id: normalizeBankrollGoal({ icon_id: body.icon_id || body.iconId }).icon_id,
      description: String(body.description || body.notes || rewardRow.notes || "").trim().slice(0, 500),
      funded_at: null,
      celebration_spin_claimed_at: null,
      updated_at: new Date().toISOString(),
    };
    await client.query(
      `UPDATE slot_accounts
       SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE workspace_id = $1`,
      [workspaceId, JSON.stringify({ bankroll_goal: nextGoal })]
    );
    await client.query("COMMIT");
    return getState(workspaceId, userId);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function clearBankrollGoal(workspaceId, userId) {
  await ensureAccount(workspaceId, userId);
  const nextGoal = {
    enabled: false,
    reward_id: null,
    target_cents: 0,
    icon_id: "gift",
    description: "",
    funded_at: null,
    celebration_spin_claimed_at: null,
    updated_at: new Date().toISOString(),
  };
  await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify({ bankroll_goal: nextGoal })]
  );
  return getState(workspaceId, userId);
}

async function setNextSpinTileOverride(workspaceId, userId, body = {}) {
  const override = normalizeNextSpinTileOverride(body, userId);
  await ensureAccount(workspaceId, userId);
  const { rows } = await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1
     RETURNING *`,
    [workspaceId, JSON.stringify({ next_spin_tile_override: override })]
  );
  return {
    ok: true,
    override,
    account: accountWithSettings(rows[0]),
  };
}

async function clearNextSpinTileOverride(workspaceId, userId) {
  await ensureAccount(workspaceId, userId);
  const { rows } = await pool.query(
    `UPDATE slot_accounts
     SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE workspace_id = $1
     RETURNING *`,
    [workspaceId, JSON.stringify({ next_spin_tile_override: null })]
  );
  return {
    ok: true,
    override: null,
    account: accountWithSettings(rows[0]),
  };
}

function statusForSelectedReward(selected, bankDelta = 0, reserveCost = 0) {
  if (!selected || selected.kind === "miss") return "miss";
  if (selected.kind === "bank_builder" || bankDelta > 0 || reserveCost > 0 || selected.requires_confirmation) return "pending";
  return "awarded";
}

// Re-roll one of the two jackpot dice (tier or paid-by) after the spin landed
// on an empty source/tier bucket. The chosen die is genuinely re-rolled while
// the other stays fixed:
//   - lands on a bucket with rewards -> swap the spin onto a fresh reward and
//     finish (awaiting cleared).
//   - lands on another empty bucket -> keep the walk-away fallback reward and
//     hand back an still-awaiting dice_reroll so the player can choose again.
// The player may re-roll EITHER die every time; by alternating dice they can
// always walk the grid to a non-empty bucket (the only true dead-end - no
// reward anywhere - is settled as a bank consolation back at spin time).
async function chooseSpinDiceReroll(workspaceId, spinId, body = {}, userId = null, rng = crypto.randomInt) {
  const die = String(body.die || body.choice || "").trim().toLowerCase();
  if (!["tier", "source"].includes(die)) {
    const err = new Error("Choose tier or source");
    err.statusCode = 400;
    throw err;
  }
  // Rebuild the live reward pool exactly as the spin did, so the re-roll draws
  // from the same eligible buckets.
  const state = await getState(workspaceId, userId);
  const drawPool = state.rewards.filter(r => r.kind !== "miss" && !r.lifespan_exhausted);
  const settings = normalizeSlotSettings(state.account.settings || {});
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM slot_spins WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [workspaceId, spinId]
    );
    const spinRow = rows[0];
    if (!spinRow) throw notFound("Spin not found");
    const snapshot = spinRow.reward_snapshot || {};
    const stages = snapshot.slot_stages || {};
    const reroll = stages.dice_reroll || {};
    if (!reroll.awaiting || !reroll.from) {
      const err = new Error("That spin has no dice re-roll waiting");
      err.statusCode = 400;
      throw err;
    }
    const rolled = rollDieReroll(drawPool, settings, reroll.from, die, rng);
    const landedFrom = { payment_source: rolled.source, tier: rolled.tier };

    if (!rolled.bucket.length) {
      // Still empty - hold the fallback reward and re-prompt from the new combo.
      const nextSnapshot = {
        ...snapshot,
        slot_stages: {
          ...stages,
          dice_reroll: { ...reroll, from: landedFrom, awaiting: true, last_die: die, last_empty: true },
        },
      };
      const { rows: held } = await client.query(
        "UPDATE slot_spins SET reward_snapshot=$3 WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [workspaceId, spinId, nextSnapshot]
      );
      await client.query("COMMIT");
      return held[0];
    }

    const selected = chooseWeighted(rolled.bucket, "chance_shares", rng) || rolled.bucket[0];
    const previousRewardId = spinRow.reward_id;
    const reserveCost = reserveCostCents(selected);
    const nextSnapshot = {
      ...snapshot,
      ...selected,
      source_type: selected.source_type,
      payment_source: selected.payment_source || (rolled.source && rolled.source.id) || defaultPaymentSourceForKind(selected.kind),
      tier_id: selected.tier_id || (rolled.tier && rolled.tier.id) || "tier_i",
      slot_stages: {
        ...stages,
        payment_source: rolled.source,
        tier: rolled.tier,
        empty_bucket: false,
        dice_reroll: {
          ...reroll,
          awaiting: false,
          last_die: die,
          to: landedFrom,
        },
        reward_spin: {
          reward_id: selected.id,
          chance_shares: selected.chance_shares || selected.weight || 0,
          bucket_size: rolled.bucket.length,
          bucket_total_shares: bucketTotalShares(rolled.bucket),
        },
      },
      screen_board: snapshot.screen_board,
      screen_payline: snapshot.screen_payline,
      bank_screen_payout: snapshot.bank_screen_payout,
      screen_override: snapshot.screen_override,
    };
    const nextStatus = statusForSelectedReward(selected, spinRow.bank_delta_cents || 0, reserveCost);
    const { rows: updatedRows } = await client.query(
      `UPDATE slot_spins
       SET reward_id=$3,
           reward_snapshot=$4,
           status=$5,
           bank_reserved_cents=$6
       WHERE workspace_id=$1 AND id=$2
       RETURNING *`,
      [workspaceId, spinId, selected.id || null, nextSnapshot, nextStatus, reserveCost]
    );
    // Hand the previously-charged fallback its use back before charging the new
    // reward, so a chain of re-rolls only ever consumes the one finally landed.
    if (previousRewardId && String(previousRewardId) !== String(selected.id)) {
      await client.query("UPDATE slot_rewards SET uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE uses_remaining + 1 END WHERE id=$1", [previousRewardId]);
    }
    if (selected.id && String(selected.id) !== String(previousRewardId)) {
      await client.query("UPDATE slot_rewards SET last_won_at=NOW(), uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE GREATEST(uses_remaining - 1, 0) END WHERE id=$1", [selected.id]);
    }
    await client.query("COMMIT");
    return updatedRows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Resolve one rung of a booster's press-your-luck gamble.
//   action "risk" -> roll advance_odds: climb a rung, or bust to nothing.
//   action "bank" -> lock the current multiplier onto the next spin (stacks).
// Reaching the top rung auto-banks. A bust ends the booster with nothing.
async function chooseSpinGamble(workspaceId, spinId, body = {}, rng = crypto.randomInt) {
  const action = String(body.action || body.choice || "").trim().toLowerCase();
  if (!["risk", "bank"].includes(action)) {
    const err = new Error("Choose risk or bank");
    err.statusCode = 400;
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM slot_spins WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [workspaceId, spinId]
    );
    const spinRow = rows[0];
    if (!spinRow) throw notFound("Spin not found");
    const snapshot = spinRow.reward_snapshot || {};
    const stages = snapshot.slot_stages || {};
    const gamble = stages.gamble ? { ...stages.gamble } : null;
    if (spinRow.status !== "gamble" || !gamble || gamble.status !== "open") {
      const err = new Error("That spin has no open gamble");
      err.statusCode = 400;
      throw err;
    }
    gamble.history = Array.isArray(gamble.history) ? [...gamble.history] : [];
    let banked = false;
    if (action === "risk") {
      const advanced = rng(1000000) < Math.floor((gamble.advance_odds || 0) * 1000000);
      if (!advanced) {
        gamble.multiplier = 1;
        gamble.status = "busted";
        gamble.history.push({ action: "risk", result: "bust" });
      } else if (gamble.rung < gamble.ladder.length - 1) {
        gamble.rung += 1;
        gamble.multiplier = gamble.ladder[gamble.rung];
        gamble.history.push({ action: "risk", result: "advance", multiplier: gamble.multiplier });
      } else {
        // Already at the top - a successful risk locks in the max.
        gamble.status = "banked";
        banked = true;
        gamble.history.push({ action: "risk", result: "maxed", multiplier: gamble.multiplier });
      }
    } else {
      gamble.status = "banked";
      banked = true;
      gamble.history.push({ action: "bank", multiplier: gamble.multiplier });
    }

    if (banked) {
      // Lock the booster onto the account, stacking with anything already queued.
      const { rows: [account] } = await client.query(
        "SELECT settings FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
        [workspaceId]
      );
      const settings = (account && account.settings) || {};
      const lockedMods = normalizeNextSpinModifiers(settings.next_spin_modifiers || {});
      const value = gamble.multiplier || 1;
      const patch = {};
      if (gamble.booster_type === "wild_hold") {
        // Wild hold grants guaranteed jackpot spins (reuses the credit machinery).
        const credits = clampInt(settings.jackpot_spin_credits ?? settings.jackpotSpinCredits ?? 0, 0, 1000);
        patch.jackpot_spin_credits = Math.min(1000, credits + value);
      } else {
        const next = { ...lockedMods };
        if (gamble.booster_type === "tier_up") next.tier_up = Math.min(10, (lockedMods.tier_up || 0) + value);
        else {
          next.miss_shield = Math.min(50, (lockedMods.miss_shield || 0) + value);
        }
        patch.next_spin_modifiers = next;
      }
      await client.query(
        `UPDATE slot_accounts
         SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at=NOW()
         WHERE workspace_id=$1`,
        [workspaceId, JSON.stringify(patch)]
      );
    }

    const nextStatus = banked ? "awarded" : gamble.status === "busted" ? "miss" : "gamble";
    const nextSnapshot = {
      ...snapshot,
      slot_stages: { ...stages, gamble },
    };
    const { rows: [updated] } = await client.query(
      `UPDATE slot_spins SET reward_snapshot=$3, status=$4 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [workspaceId, spinId, nextSnapshot, nextStatus]
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

// Combine two charges of a base tier into one of the next tier (2x->5x, 3x->10x).
async function combineMultiplierCharges(workspaceId, fromTier) {
  const base = clampInt(fromTier, 0, 10);
  const target = MULTIPLIER_COMBINE[base];
  if (!target) {
    const err = new Error("That multiplier tier cannot be combined");
    err.statusCode = 400;
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT settings FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const settings = (account && account.settings) || {};
    const charges = normalizeMultiplierCharges(settings.multiplier_charges);
    if ((charges[base] || 0) < 2) {
      const err = new Error(`Need two ${base}x charges to combine`);
      err.statusCode = 400;
      throw err;
    }
    charges[base] -= 2;
    charges[target] = (charges[target] || 0) + 1;
    const activeMultiplier = normalizeActiveMultiplier(settings.active_multiplier, charges);
    await client.query(
      `UPDATE slot_accounts SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId, JSON.stringify({ multiplier_charges: charges, active_multiplier: activeMultiplier })]
    );
    await client.query("COMMIT");
    return { ok: true, multiplier_charges: charges, active_multiplier: activeMultiplier };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Arm (or disarm with tier 0) a multiplier tier to spend one charge per spin.
async function setActiveMultiplier(workspaceId, tier) {
  const want = clampInt(tier, 0, 10);
  if (want !== 0 && !MULTIPLIER_CHARGE_TIERS.includes(want)) {
    const err = new Error("Unknown multiplier tier");
    err.statusCode = 400;
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT settings FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const settings = (account && account.settings) || {};
    const charges = normalizeMultiplierCharges(settings.multiplier_charges);
    if (want !== 0 && (charges[want] || 0) <= 0) {
      const err = new Error(`No ${want}x charges to arm`);
      err.statusCode = 400;
      throw err;
    }
    const active = normalizeActiveMultiplier(want, charges);
    await client.query(
      `UPDATE slot_accounts SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId, JSON.stringify({ active_multiplier: active })]
    );
    await client.query("COMMIT");
    return { ok: true, active_multiplier: active, multiplier_charges: charges };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function createReward(workspaceId, body) {
  const r = normalizeRewardInput(body);
  // Place new rewards at the end of their source+tier bucket so they appear after
  // existing cards rather than jumping to the front (sort_order 0).
  const { rows: [mx] } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next
       FROM slot_rewards
      WHERE workspace_id = $1 AND payment_source = $2 AND tier_id = $3 AND deleted_at IS NULL`,
    [workspaceId, r.payment_source, r.tier_id]
  );
  const sortOrder = Number(mx && mx.next) || 1000;
  const { rows } = await pool.query(
    `INSERT INTO slot_rewards
     (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,chance_shares,payment_source,tier_id,active,sponsor_active,value_cents,bank_delta_cents,duration_minutes,requires_confirmation,cooldown_days,unlock_threshold_cents,notes,public_visibility,expires_at,uses_remaining,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [workspaceId, r.title, r.kind, r.sponsor_type, JSON.stringify(r.sponsor_splits), r.weight, r.chance_shares, r.payment_source, r.tier_id, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.duration_minutes, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes, r.public_visibility, r.expires_at, r.uses_remaining, sortOrder]
  );
  return rows[0];
}

// Persist within-bucket ordering. Mirrors db.js reorderBlocks: write each
// {id, sort_order}, then if the new values collide (gap < 0.001) renumber the
// whole affected source+tier bucket to clean (i+1)*1000 spacing.
async function reorderRewards(workspaceId, items) {
  const list = (Array.isArray(items) ? items : [])
    .map(it => ({ id: parseInt(it && (it.id ?? it.reward_id), 10), sort_order: Number(it && it.sort_order) }))
    .filter(it => Number.isFinite(it.id) && Number.isFinite(it.sort_order));
  if (!list.length) return { reordered: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of list) {
      await client.query(
        "UPDATE slot_rewards SET sort_order=$3, updated_at=NOW() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",
        [workspaceId, item.id, item.sort_order]
      );
    }
    if (list.length > 1) {
      const sorted = [...list].sort((a, b) => a.sort_order - b.sort_order);
      let needsRebalance = false;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].sort_order - sorted[i - 1].sort_order < 0.001) { needsRebalance = true; break; }
      }
      if (needsRebalance) {
        const { rows: [anchor] } = await client.query(
          "SELECT payment_source, tier_id FROM slot_rewards WHERE workspace_id=$1 AND id=$2",
          [workspaceId, list[0].id]
        );
        if (anchor) {
          const { rows: bucket } = await client.query(
            `SELECT id FROM slot_rewards
             WHERE workspace_id=$1 AND payment_source=$2 AND tier_id=$3 AND deleted_at IS NULL
             ORDER BY sort_order ASC, id ASC`,
            [workspaceId, anchor.payment_source, anchor.tier_id]
          );
          for (let i = 0; i < bucket.length; i++) {
            await client.query(
              "UPDATE slot_rewards SET sort_order=$2, updated_at=NOW() WHERE workspace_id=$3 AND id=$1",
              [bucket[i].id, (i + 1) * 1000, workspaceId]
            );
          }
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { reordered: list.length };
}

async function updateReward(workspaceId, id, body) {
  const r = normalizeRewardInput(body);
  const { rows } = await pool.query(
     `UPDATE slot_rewards SET
       title=$3, kind=$4, sponsor_type=$5, sponsor_splits=$6, weight=$7, chance_shares=$8,
       payment_source=$9, tier_id=$10, active=$11, sponsor_active=$12,
       value_cents=$13, bank_delta_cents=$14, duration_minutes=$15, requires_confirmation=$16,
       cooldown_days=$17, unlock_threshold_cents=$18, notes=$19,
       public_visibility=$20, expires_at=$21, uses_remaining=$22, updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL
     RETURNING *`,
    [workspaceId, id, r.title, r.kind, r.sponsor_type, JSON.stringify(r.sponsor_splits), r.weight, r.chance_shares, r.payment_source, r.tier_id, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.duration_minutes, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes, r.public_visibility, r.expires_at, r.uses_remaining]
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

function normalizeTaskTags(value) {
  if (Array.isArray(value)) {
    return value.map(tag => {
      if (tag && typeof tag === "object") return String(tag.id || tag.name || tag.label || "").trim();
      return String(tag || "").trim();
    }).filter(Boolean);
  }
  if (typeof value === "string") return value.split(/[,\u00b7|]/).map(tag => tag.trim()).filter(Boolean);
  return [];
}

function taskPointTier(body = {}, settings = {}) {
  const normalized = normalizeSlotSettings(settings);
  const tiers = normalized.point_tag_tiers || DEFAULT_POINT_TAG_TIERS;
  const tags = normalizeTaskTags(body.tags ?? body.tag ?? body.tag_ids ?? body.tagIds);
  const tagSet = new Set(tags);
  let bestTier = null;
  let bestMultiplier = -1;
  for (const [tier, multiplier] of Object.entries(POINT_TAG_TIER_MULTIPLIERS)) {
    const matches = (tiers[tier] || []).some(tagId => tagSet.has(String(tagId)));
    if (matches && multiplier > bestMultiplier) {
      bestTier = tier;
      bestMultiplier = multiplier;
    }
  }
  const type = String(body.type ?? body.kind ?? "").trim().toLowerCase();
  if (type === "ooo") return { tier: "none", multiplier: 0, matched_tags: [] };
  if (bestTier) {
    return {
      tier: bestTier,
      multiplier: POINT_TAG_TIER_MULTIPLIERS[bestTier],
      matched_tags: (tiers[bestTier] || []).filter(tagId => tagSet.has(String(tagId))),
    };
  }
  if (type === "meeting" || type === "break") return { tier: "none", multiplier: 0, matched_tags: [] };
  // Tags still sitting in the bank (unsorted) earn full points by default.
  return { tier: "full", multiplier: POINT_TAG_TIER_MULTIPLIERS.full, matched_tags: [] };
}

async function earnTaskCredit(workspaceId, userId, body) {
  body = normalizeTaskCreditBody(body || {});
  const account = accountWithSettings(await ensureAccount(workspaceId, userId));
  const sourceKey = String(body.source_key || body.task_id || "").trim();
  if (!sourceKey) throw new Error("source_key required");
  const description = String(body.description || body.title || "Task completed");
  const pointTier = taskPointTier(body, account.settings);
  body = {
    ...body,
    point_tier: pointTier.tier,
    point_multiplier: pointTier.multiplier,
  };
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
      point_tier: pointTier.tier,
      point_multiplier: pointTier.multiplier,
      point_tag_matches: pointTier.matched_tags,
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

function tierStageForReward(settings, reward) {
  const tierId = String((reward && reward.tier_id) || "tier_i");
  return tierOptions(settings).find(tier => String(tier.id) === tierId) ||
    normalizeSlotSettings(settings).reward_tiers.find(tier => String(tier.id) === tierId) ||
    { id: tierId, label: "Tier I", weight: 0, active: true };
}

function jackpotHits(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).jackpot_hit_rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng(1000000) < Math.floor(rate * 1000000);
}

// Once a jackpot lands, decide how long its winning run is (and therefore how many
// guaranteed jackpot spins it pays). It always starts as a 3-in-a-row (1 spin);
// each climb to a longer run clears an independent jackpot_upgrade_rate roll. With
// the tuned 1% jackpot rate and a 10% climb rate this realizes ~1/100 for a
// 3-in-a-row, ~1/1000 for a 4-in-a-row (2 spins), and ~1/10000 for a 5-in-a-row
// (3 spins). Each rng draw happens only when the rate is a genuine coin flip, so a
// 0 rate (e.g. a credit-funded spin) returns 1 without disturbing the rng stream.
function rollJackpotSpins(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).jackpot_upgrade_rate;
  const climbs = () => rate > 0 && (rate >= 1 || rng(1000000) < Math.floor(rate * 1000000));
  if (!climbs()) return 1; // 3-in-a-row
  if (!climbs()) return 2; // 4-in-a-row
  return 3;                // 5-in-a-row
}

function bankBuilderHits(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).bank_builder_hit_rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng(1000000) < Math.floor(rate * 1000000);
}

function freeSpinTileHits(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).free_spin_tile_rate;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return rng(1000000) < Math.floor(rate * 1000000);
}

function missHits(settings, rng = crypto.randomInt) {
  const rate = normalizeSlotSettings(settings).miss_rate;
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

function fakeFreeSpinTileReward() {
  return reward({
    id: null,
    title: "Free full spin",
    kind: "reroll",
    source_type: "slot_free_spin_tile",
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Free spin tile awarded a full slot spin.",
  });
}

function fakeBankBuilderReward() {
  return reward({
    id: null,
    title: "Bank Builder",
    kind: "bank_builder",
    payment_source: "self",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    requires_confirmation: true,
    notes: "First-spin bank builder outcome.",
  });
}

function fakeCoinReward(coinKind, points) {
  return reward({
    id: null,
    title: coinKind === "cashback" ? "Cashback: spin refunded" : `Point drop: +${points}`,
    kind: "points",
    source_type: "slot_coin",
    coin_kind: coinKind,
    points: points || 0,
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Coin outcome paid in points.",
  });
}

function fakePetReward(petKind) {
  return reward({
    id: null,
    title: petKind === "cosmetic" ? "Pet found a cosmetic" : "Pet treat",
    kind: "pet",
    source_type: "slot_pet",
    pet_kind: petKind,
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Pet delight outcome.",
  });
}

function fakeCollectibleReward(setCompleted) {
  return reward({
    id: null,
    title: setCompleted ? "Gem set complete!" : "Collected a gem",
    kind: "collectible",
    source_type: "slot_collectible",
    set_completed: setCompleted === true,
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Collectible gem outcome.",
  });
}

function fakeBoosterReward(boosterType, gamble) {
  return reward({
    id: null,
    title: `Booster: ${boosterType}`,
    kind: "booster",
    source_type: "slot_booster",
    booster_type: boosterType,
    gamble: gamble || null,
    payment_source: "free",
    tier_id: "tier_i",
    weight: 0,
    chance_shares: 0,
    active: true,
    notes: "Booster outcome with a press-your-luck gamble.",
  });
}

function rollFloorOutcomeKind(weights, rng) {
  const entries = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0);
  if (!entries.length) return "bank";
  const total = entries.reduce((sum, [, w]) => sum + Number(w), 0);
  let roll = rng(total);
  for (const [kind, w] of entries) {
    roll -= Number(w);
    if (roll < 0) return kind;
  }
  return entries[entries.length - 1][0];
}

function buildCoinOutcome(normalized, rng) {
  const config = normalized.coin_config || normalizeCoinConfig();
  const isCashback = rng(1000000) < Math.floor(config.cashback_chance * 1000000);
  const [lo, hi] = config.point_drop;
  const points = isCashback ? 0 : lo + rng(Math.max(1, hi - lo + 1));
  return floorResult("coin", {
    selected: fakeCoinReward(isCashback ? "cashback" : "point_drop", points),
    coin: { coin_kind: isCashback ? "cashback" : "point_drop", points },
  });
}

function buildBoosterOutcome(normalized, rng) {
  const config = normalized.booster_config || normalizeBoosterConfig();
  const boosterType = BOOSTER_TYPES[rng(BOOSTER_TYPES.length)];
  // bank_multiplier no longer gambles - it drops one collectible charge (2x or 3x)
  // into the stash, awarded immediately.
  if (boosterType === "bank_multiplier") {
    const tier = chooseWeighted(
      BOOSTER_CHARGE_TIERS.map((t, i) => ({ tier: t, weight: BOOSTER_CHARGE_WEIGHTS[i] })),
      "weight",
      rng
    ) || { tier: BOOSTER_CHARGE_TIERS[0] };
    return floorResult("booster", {
      selected: fakeBoosterReward("bank_multiplier", null),
      multiplier_charge: { tier: tier.tier },
    });
  }
  // The other three boosters keep their press-your-luck coin-flip ladder.
  const ladder = BOOSTER_LADDERS[boosterType] || BOOSTER_LADDERS.tier_up;
  const gamble = {
    booster_type: boosterType,
    ladder,
    advance_odds: config.advance_odds,
    rung: 0,
    multiplier: ladder[0],
    status: "open",
    history: [],
  };
  return floorResult("booster", {
    selected: fakeBoosterReward(boosterType, gamble),
    gamble,
  });
}

function buildPetOutcome(rng) {
  const petKind = rng(4) === 0 ? "cosmetic" : "treat";
  return floorResult("pet", { selected: fakePetReward(petKind), pet: { pet_kind: petKind } });
}

function buildCollectibleOutcome(normalized) {
  const setSize = (normalized.collection && normalized.collection.set_size) || DEFAULT_COLLECTION_SET_SIZE;
  const gems = (normalized.collection && normalized.collection.gems) || 0;
  const setCompleted = (gems + 1) >= setSize;
  return floorResult("collectible", {
    selected: fakeCollectibleReward(setCompleted),
    collectible: { set_completed: setCompleted },
  });
}

// Shared shape for every non-jackpot floor outcome so spin() can treat them
// uniformly. Defaults mean "no money, no jackpot" unless the builder overrides.
function floorResult(outcome, overrides = {}) {
  return {
    outcome,
    jackpot_hit: false,
    bank_builder_hit: outcome === "bank",
    free_spin_hit: outcome === "free_spin",
    selected: null,
    source: null,
    tier: null,
    bucket: [],
    empty_bucket: false,
    reroll_credit: outcome === "free_spin",
    ...overrides,
  };
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

function bucketForSourceTier(rewards, source, tier) {
  return (rewards || []).filter(r =>
    r &&
    r.eligible &&
    normalizePaymentSource(r.payment_source, r.kind) === source.id &&
    String(r.tier_id || "tier_i") === String(tier.id) &&
    (Number(r.chance_shares ?? r.weight) || 0) > 0
  );
}

function chooseBucketAttempt(rewards, settings, rng) {
  const normalized = normalizeSlotSettings(settings);
  const source = chooseWeighted(sourceOptions(normalized), "weight", rng) || sourceOptions(normalized)[0];
  const tiers = tierOptions(normalized);
  let tier = chooseWeighted(tiers, "weight", rng) || tiers[0] || DEFAULT_REWARD_TIERS[0];
  // A banked tier_up booster bumps this jackpot toward a higher (rarer) tier.
  const tierUp = (normalized.next_spin_modifiers && normalized.next_spin_modifiers.tier_up) || 0;
  if (tierUp > 0 && tiers.length) {
    const idx = tiers.findIndex(t => String(t.id) === String(tier.id));
    if (idx >= 0) tier = tiers[Math.min(tiers.length - 1, idx + tierUp)] || tier;
  }
  return {
    source,
    tier,
    bucket: bucketForSourceTier(rewards, source, tier),
  };
}

function chooseExistingBucketAttempt(rewards, settings, rng) {
  const normalized = normalizeSlotSettings(settings);
  const attempts = [];
  for (const source of sourceOptions(normalized)) {
    for (const tier of tierOptions(normalized)) {
      const bucket = bucketForSourceTier(rewards, source, tier);
      if (!bucket.length) continue;
      attempts.push({
        source,
        tier,
        bucket,
        weight: Math.max(0, Number(source.weight) || 0) * Math.max(0, Number(tier.weight) || 0),
      });
    }
  }
  return chooseWeighted(attempts, "weight", rng) || attempts[0] || null;
}

function bucketTotalShares(bucket) {
  return (bucket || []).reduce((sum, r) => sum + (Number(r.chance_shares ?? r.weight) || 0), 0);
}

// Genuinely re-roll a single jackpot die, keeping the other die fixed at its
// current value. This is a real weighted roll across that die's active faces,
// so it can land on the same face or on another empty bucket - the caller
// (chooseSpinDiceReroll) re-prompts when `bucket` comes back empty.
function rollDieReroll(rewards, settings, from, die, rng = crypto.randomInt) {
  const normalized = normalizeSlotSettings(settings);
  let source = (from && from.payment_source) || sourceOptions(normalized)[0];
  let tier = (from && from.tier) || tierOptions(normalized)[0];
  if (die === "source") {
    source = chooseWeighted(sourceOptions(normalized), "weight", rng) || source;
  } else if (die === "tier") {
    tier = chooseWeighted(tierOptions(normalized), "weight", rng) || tier;
  }
  return { source, tier, bucket: bucketForSourceTier(rewards, source, tier) };
}

// The non-jackpot floor. A rare explicit true miss, otherwise a weighted draw
// across the "small win" outcomes (bank / coin / booster / pet+collectible /
// free spin). Bank is no longer the default for nearly every spin.
function resolveFloorOutcome(normalized, rng) {
  if (missHits(normalized, rng)) {
    return floorResult("miss", { selected: fakeMissReward() });
  }
  const kind = rollFloorOutcomeKind(normalized.floor_weights, rng);
  switch (kind) {
    case "coin":
      return buildCoinOutcome(normalized, rng);
    case "booster":
      return buildBoosterOutcome(normalized, rng);
    case "pet":
      // The "pet" bucket covers both pet delight and collectible gems.
      return rng(2) === 0 ? buildCollectibleOutcome(normalized) : buildPetOutcome(rng);
    case "free_spin":
      return floorResult("free_spin", { selected: fakeFreeSpinTileReward() });
    case "bank":
    default:
      return floorResult("bank", { selected: fakeBankBuilderReward() });
  }
}

function selectThreeStageOutcome(rewards, settings, rng = crypto.randomInt) {
  const normalized = normalizeSlotSettings(settings);
  // bankHit still governs whether a jackpot spin ALSO builds the bank on the
  // same screen (the bank-build-before-jackpot mechanic), independent of the floor.
  const bankHit = bankBuilderHits(normalized, rng);
  const hit = jackpotHits(normalized, rng);
  if (!hit) {
    return resolveFloorOutcome(normalized, rng);
  }
  const firstAttempt = chooseBucketAttempt(rewards, normalized, rng);
  let finalAttempt = firstAttempt;
  let diceReroll = null;
  if (!firstAttempt.bucket.length) {
    // The jackpot dice landed on a source/tier bucket with no rewards. Pick a
    // guaranteed-winnable bucket as the walk-away fallback, then flag the spin
    // so the player can re-roll EITHER die. The re-roll itself
    // (chooseSpinDiceReroll) is a genuine weighted roll that may land on yet
    // another empty bucket and prompt again; this fallback only protects a
    // player who leaves mid-re-roll.
    finalAttempt = chooseExistingBucketAttempt(rewards, normalized, rng);
    if (finalAttempt) {
      diceReroll = {
        reason: "empty_bucket",
        awaiting: true,
        from: {
          payment_source: firstAttempt.source,
          tier: firstAttempt.tier,
        },
      };
    }
  }
  if (!finalAttempt || !finalAttempt.bucket.length) {
    // The jackpot dice landed, but no eligible reward exists in any reachable
    // bucket (and there was nothing to offer a dice reroll into). Rather than
    // burn the spin as a flat miss, pay a bank-builder consolation so the spin
    // still lands as "something."
    return {
      outcome: "bank",
      jackpot_hit: false,
      bank_builder_hit: true,
      free_spin_hit: false,
      selected: fakeBankBuilderReward(),
      source: firstAttempt.source,
      tier: firstAttempt.tier,
      bucket: [],
      empty_bucket: true,
      reroll_credit: false,
      dice_reroll: null,
    };
  }
  const { source, tier, bucket } = finalAttempt;
  const selected = chooseWeighted(bucket, "chance_shares", rng);
  // Roll the run length AFTER the reward is chosen so the existing source/tier/
  // reward draws keep their positions in the rng stream.
  const jackpotSpins = rollJackpotSpins(normalized, rng);
  return {
    outcome: "jackpot",
    jackpot_hit: true,
    jackpot_spins: jackpotSpins,
    jackpot_level: jackpotSpins,
    bank_builder_hit: bankHit,
    free_spin_hit: false,
    selected,
    source,
    tier,
    bucket,
    empty_bucket: false,
    reroll_credit: false,
    dice_reroll: diceReroll,
  };
}

function rewardCostCents(row) {
  return Math.max((row && row.value_cents) || 0, (row && row.unlock_threshold_cents) || 0);
}

function rewardSymbol(row) {
  if (!row || row.kind === "miss") return "MISS";
  if (row.kind === "bank_builder") return "BANK";
  if (row.kind === "points" || row.source_type === "slot_coin") return "COIN";
  if (row.kind === "booster" || row.source_type === "slot_booster") return "STAR";
  if (row.kind === "pet" || row.source_type === "slot_pet") return "PAW";
  if (row.kind === "collectible" || row.source_type === "slot_collectible") return "GEM";
  if (row.source_type === "slot_free_spin_tile") return "SPIN";
  return "JACKPOT";
}

function normalizeTileSymbol(value) {
  const symbol = String(value == null ? "" : value).trim().toUpperCase();
  if (symbol === "JACK" || symbol === "JP") return "JACKPOT";
  if (symbol === "B") return "BANK";
  if (symbol === "S") return "SPIN";
  if (symbol === "M") return "MISS";
  if (symbol === "C") return "COIN";
  if (symbol === "P") return "PAW";
  if (symbol === "G") return "GEM";
  return symbol;
}

function normalizeTileBoard(value, strict = false) {
  const raw = Array.isArray(value)
    ? value
    : String(value == null ? "" : value).split(/[\s,|]+/).filter(Boolean);
  if (raw.length !== SLOT_CELL_COUNT) {
    if (!strict) return null;
    throw new Error("Tile override needs exactly 15 tiles");
  }
  const board = raw.map(normalizeTileSymbol);
  const invalid = board.find(symbol => !SLOT_SYMBOLS.has(symbol));
  if (invalid) {
    if (!strict) return null;
    throw new Error("Tiles must be MISS, BANK, JACKPOT, or SPIN");
  }
  return board;
}

function normalizeStoredNextSpinTileOverride(value) {
  if (!value || typeof value !== "object") return null;
  const tiles = normalizeTileBoard(value.tiles || value.board || value);
  if (!tiles) return null;
  return {
    tiles,
    created_at: value.created_at || null,
    created_by: value.created_by || null,
  };
}

function normalizeNextSpinTileOverride(body = {}, userId = null) {
  if (body && body.clear) return null;
  const tiles = normalizeTileBoard(body.tiles ?? body.board ?? body.pattern, true);
  return {
    tiles,
    created_at: new Date().toISOString(),
    created_by: userId || null,
  };
}

function emptyJackpotScreenResult() {
  return {
    hit: false,
    level: 0,
    spins: 0,
    payline: [],
    orientation: null,
  };
}

function jackpotSpinsForLine(line, orientation) {
  if (orientation === "horizontal") {
    if (line.length >= 5) return 3;
    if (line.length >= 4) return 2;
    if (line.length >= 3) return 1;
  }
  if (orientation === "vertical" && line.length >= 3) return 1;
  return 0;
}

function bestJackpotScreenResult(candidates) {
  const best = candidates
    .filter(candidate => candidate.spins > 0)
    .sort((a, b) =>
      b.spins - a.spins ||
      b.payline.length - a.payline.length ||
      a.payline[0] - b.payline[0]
    )[0];
  return best || emptyJackpotScreenResult();
}

function evaluateJackpotBoard(board) {
  if (!Array.isArray(board) || board.length !== SLOT_CELL_COUNT) return emptyJackpotScreenResult();
  const candidates = [];

  for (let row = 0; row < SLOT_ROWS; row++) {
    let run = [];
    for (let col = 0; col < SLOT_COLS; col++) {
      const idx = row * SLOT_COLS + col;
      if (board[idx] === "JACKPOT") run.push(idx);
      if (board[idx] !== "JACKPOT" || col === SLOT_COLS - 1) {
        const spins = jackpotSpinsForLine(run, "horizontal");
        if (spins > 0) {
          candidates.push({
            hit: true,
            level: spins,
            spins,
            payline: [...run],
            orientation: "horizontal",
          });
        }
        run = [];
      }
    }
  }

  for (let col = 0; col < SLOT_COLS; col++) {
    let run = [];
    for (let row = 0; row < SLOT_ROWS; row++) {
      const idx = row * SLOT_COLS + col;
      if (board[idx] === "JACKPOT") run.push(idx);
      if (board[idx] !== "JACKPOT" || row === SLOT_ROWS - 1) {
        const spins = jackpotSpinsForLine(run, "vertical");
        if (spins > 0) {
          candidates.push({
            hit: true,
            level: 1,
            spins,
            payline: [...run],
            orientation: "vertical",
          });
        }
        run = [];
      }
    }
  }

  return bestJackpotScreenResult(candidates);
}

function overridePayline(board, selected) {
  if (!selected || selected.kind === "miss" || selected.kind === "bank_builder") return [];
  const symbol = rewardSymbol(selected);
  if (symbol === "JACKPOT") return evaluateJackpotBoard(board).payline;
  return [];
}

function applyTileOverrideToScreen(screen, override, selected, account, bankUsage, screenBankHit) {
  const stored = normalizeStoredNextSpinTileOverride(override);
  if (!stored) return { ...screen, override: null };
  const board = [...stored.tiles];
  // Bank resolves first off the actual tiles, so a forced board pays for whatever
  // BANK tiles it carries regardless of the rolled outcome.
  return {
    board,
    payline: overridePayline(board, selected),
    payout: calculateScreenBankPayout(board, account, bankUsage),
    jackpot: evaluateJackpotBoard(board),
    override: stored,
  };
}

// All contiguous horizontal and vertical runs of a given length on the grid.
function contiguousRuns(count) {
  const runs = [];
  for (let r = 0; r < SLOT_ROWS; r++) {
    for (let c = 0; c + count <= SLOT_COLS; c++) {
      runs.push(Array.from({ length: count }, (_, k) => r * SLOT_COLS + c + k));
    }
  }
  for (let c = 0; c < SLOT_COLS; c++) {
    for (let r = 0; r + count <= SLOT_ROWS; r++) {
      runs.push(Array.from({ length: count }, (_, k) => (r + k) * SLOT_COLS + c));
    }
  }
  return runs;
}

// Drop `count` tiles of `symbol` as a single contiguous run so the adjacency
// combo in calculateScreenBankPayout fires. Falls back to a shorter run, then a
// single tile, if no run fits the open cells. Returns the number placed.
function placeSymbolCluster(board, protectedCells, symbol, count) {
  for (let want = count; want >= 2; want--) {
    const runs = contiguousRuns(want).filter(cells => cells.every(i => !protectedCells.has(i)));
    if (runs.length) {
      const cells = runs[crypto.randomInt(runs.length)];
      cells.forEach(i => { board[i] = symbol; protectedCells.add(i); });
      return cells.length;
    }
  }
  const open = Array.from({ length: SLOT_CELL_COUNT }, (_, i) => i).filter(i => !protectedCells.has(i));
  if (open.length) {
    const i = open[crypto.randomInt(open.length)];
    board[i] = symbol;
    protectedCells.add(i);
    return 1;
  }
  return 0;
}

// Lay a straight run of `length` (>=3) `symbol` tiles on open cells. Falls back
// to a shorter run, then to singles, if no straight run fits. Returns the cells.
function placeSymbolLine(board, protectedCells, symbol, length) {
  for (let want = length; want >= WIN_LINE_LENGTH; want--) {
    const runs = contiguousRuns(want).filter(cells => cells.every(i => !protectedCells.has(i) && board[i] == null));
    if (runs.length) {
      const cells = runs[crypto.randomInt(runs.length)];
      cells.forEach(i => { board[i] = symbol; protectedCells.add(i); });
      return cells;
    }
  }
  const open = Array.from({ length: SLOT_CELL_COUNT }, (_, i) => i).filter(i => !protectedCells.has(i) && board[i] == null);
  const cells = [];
  for (let k = 0; k < Math.min(WIN_LINE_LENGTH, open.length); k++) {
    const pick = open.splice(crypto.randomInt(open.length), 1)[0];
    board[pick] = symbol;
    protectedCells.add(pick);
    cells.push(pick);
  }
  return cells;
}

// True when none of `cells` sits orthogonally adjacent (same row or same column)
// to a BANK tile already on the board. calculateScreenBankPayout only groups along
// rows/columns, so a one-cell row/col gap keeps two clusters as DISTINCT groups
// (diagonal touching is fine and does not merge them).
function isSeparatedFromBank(cells, board) {
  return cells.every(idx => {
    const row = Math.floor(idx / SLOT_COLS);
    const col = idx % SLOT_COLS;
    if (col > 0 && board[idx - 1] === "BANK") return false;
    if (col < SLOT_COLS - 1 && board[idx + 1] === "BANK") return false;
    if (row > 0 && board[idx - SLOT_COLS] === "BANK") return false;
    if (row < SLOT_ROWS - 1 && board[idx + SLOT_COLS] === "BANK") return false;
    return true;
  });
}

// Place one cluster of `length` BANK tiles as a contiguous run that is both open and
// separated from any BANK already placed this spin. Degrades length -> length-1 ... -> 1
// (a lone separated open cell) so a crowded board never aborts the hit. Returns the
// placed cells, or [] only if the board has no separated open cell left at all.
function placeBankCluster(board, protectedCells, length) {
  for (let want = length; want >= 2; want--) {
    const runs = contiguousRuns(want).filter(cells =>
      cells.every(i => !protectedCells.has(i) && board[i] == null) &&
      isSeparatedFromBank(cells, board)
    );
    if (runs.length) {
      const cells = runs[crypto.randomInt(runs.length)];
      cells.forEach(i => { board[i] = "BANK"; protectedCells.add(i); });
      return cells;
    }
  }
  const open = Array.from({ length: SLOT_CELL_COUNT }, (_, i) => i)
    .filter(i => !protectedCells.has(i) && board[i] == null && isSeparatedFromBank([i], board));
  if (open.length) {
    const i = open[crypto.randomInt(open.length)];
    board[i] = "BANK";
    protectedCells.add(i);
    return [i];
  }
  return [];
}

// Drop a weighted random BANK shape (see BANK_SHAPES). Each cluster is laid largest
// first as its own separated run so the payout groups them independently. Returns the
// flat list of every BANK cell placed (used as the payline fallback). Always places at
// least one tile when called for a real bank hit, unless the board is entirely full.
function placeBankShape(board, protectedCells) {
  const shape = chooseWeighted(BANK_SHAPES) || BANK_SHAPES[0];
  const lengths = [...shape.clusters].sort((a, b) => b - a);
  const placed = [];
  for (const len of lengths) {
    const cells = placeBankCluster(board, protectedCells, len);
    placed.push(...cells);
  }
  return placed;
}

// Paint every still-empty cell with a prize icon so the reels are never dead.
// Greedy left/up check guarantees no symbol forms a 3-in-a-row, so the only
// paying pattern on the board is the intended winning line. Excluded symbols
// (the winners) appear ONLY in their line.
function fillCosmetic(board, excludeSet) {
  const pool = COSMETIC_FILLER_SYMBOLS.filter(s => !excludeSet.has(s));
  const fallback = pool.length ? pool : COSMETIC_FILLER_SYMBOLS;
  for (let i = 0; i < SLOT_CELL_COUNT; i++) {
    if (board[i] != null) continue;
    const col = i % SLOT_COLS;
    const row = Math.floor(i / SLOT_COLS);
    const safe = fallback.filter(sym => {
      const h = col >= 2 && board[i - 1] === sym && board[i - 2] === sym;
      const v = row >= 2 && board[i - SLOT_COLS] === sym && board[i - 2 * SLOT_COLS] === sym;
      return !h && !v;
    });
    const choices = safe.length ? safe : fallback;
    board[i] = choices[crypto.randomInt(choices.length)];
  }
}

function buildSpinScreen(selected, account, bankUsage, screenBankHit, jackpotSpins = 1) {
  const board = Array.from({ length: SLOT_CELL_COUNT }, () => null);
  const protectedCells = new Set();
  const selectedSymbol = rewardSymbol(selected);
  const isMiss = selected.kind === "miss";
  const canPlaceBankSymbols = !!screenBankHit;
  const exclude = new Set();
  let payline = [];

  if (!isMiss && selectedSymbol === "JACKPOT") {
    // The engine already rolled the tier; lay a run of the matching length so the
    // win reads as a real 3/4/5-in-a-row paying 1/2/3 spins.
    const lines = JACKPOT_PAYLINES_BY_SPINS[jackpotSpins] || JACKPOT_PAYLINES_BY_SPINS[1];
    const line = lines[crypto.randomInt(lines.length)];
    payline = [...line];
    line.forEach(i => { board[i] = "JACKPOT"; protectedCells.add(i); });
    exclude.add("JACKPOT");
  } else if (!isMiss && (SMALL_WIN_SYMBOLS.has(selectedSymbol) || selectedSymbol === "SPIN")) {
    // Coin / booster / pet / gem / free spin pay on a 3-in-a-row line.
    payline = placeSymbolLine(board, protectedCells, selectedSymbol, WIN_LINE_LENGTH);
    exclude.add(selectedSymbol);
  }

  if (canPlaceBankSymbols) {
    // Bank drops a weighted random shape: sometimes a lone tile (1 unit, no combo),
    // sometimes one block, sometimes separated blocks that each combo on their own.
    const bankCells = placeBankShape(board, protectedCells);
    if (!payline.length) payline = bankCells;
    exclude.add("BANK");
  }

  // Fill the rest with scrubbed prize icons - no dead tiles, no accidental wins.
  fillCosmetic(board, exclude);

  // Bankroll ALWAYS resolves first: any BANK tile on the final board pays, whether it
  // was an intentional bank shape (screenBankHit) or a cosmetic filler tile that landed
  // alongside some other reward. The payout is read from the board, not from the rolled
  // outcome, so a gem/refund/jackpot/miss screen still banks whatever BANK tiles show.
  const payout = calculateScreenBankPayout(board, account, bankUsage);
  const jackpot = evaluateJackpotBoard(board);
  return { board, payline: jackpot.payline.length ? jackpot.payline : payline, payout, jackpot };
}

function buildBankrollGoalCelebrationScreen(account, bankUsage) {
  const board = Array.from({ length: SLOT_CELL_COUNT }, () => null);
  [0, 1, 2, 3, 4].forEach(i => { board[i] = "JACKPOT"; });
  [7, 11, 13].forEach(i => { board[i] = "BANK"; });
  fillCosmetic(board, new Set(["JACKPOT", "BANK"]));
  const jackpot = evaluateJackpotBoard(board);
  return {
    board,
    payline: jackpot.payline,
    payout: emptyScreenBankPayout(account, bankUsage),
    jackpot,
    override: null,
  };
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
  // The only cap on bank-building is the monthly goal: you can bank up to your
  // full monthly discretionary target each month, with no daily or weekly throttle.
  const monthBanked = (bankUsage && bankUsage.month) || 0;
  const remainingCap = Math.max(0, monthlyGoalCents - monthBanked);
  // Remainder-based pacing: for most of the month each BANK tile is worth a
  // percent of the REMAINING headroom, not the full monthly goal. The bar fills
  // fast early (big remainder => big hits) and each hit tapers as it approaches
  // the goal. In the final week we switch the base back to the full monthly
  // allotment so a strong late run can still push the bar all the way to max.
  const finalWeek = !!(bankUsage && bankUsage.finalWeek);
  const pacingBaseCents = finalWeek ? monthlyGoalCents : remainingCap;
  const baseCents = Math.floor(pacingBaseCents * SCREEN_BANK_BUILDER_PERCENT);
  const baseUnits = positions.length;
  const horizontalBonusUnits = horizontalGroups.reduce((sum, group) => sum + group.length * (group.length - 1), 0);
  const verticalBonusUnits = verticalGroups.reduce((sum, group) => sum + group.length, 0);
  const units = baseUnits + horizontalBonusUnits + verticalBonusUnits;
  // Flat floor so a small bankroll still moves visibly: any bank hit is worth at
  // least BANK_BUILDER_FLAT_FLOOR_CENTS even when percent * base rounds tiny.
  const rawCents = units > 0
    ? Math.max(baseCents * units, BANK_BUILDER_FLAT_FLOOR_CENTS)
    : 0;
  const cents = Math.min(rawCents, remainingCap);

  return {
    source_type: "slot_screen_bank_builder",
    positions,
    horizontal_groups: horizontalGroups,
    vertical_groups: verticalGroups,
    base_cents: baseCents,
    goal_cents: monthlyGoalCents,
    pacing_base_cents: pacingBaseCents,
    monthly_remaining_cents: remainingCap,
    final_week: finalWeek,
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
  const monthBanked = (bankUsage && bankUsage.month) || 0;
  const remainingCap = Math.max(0, monthlyGoalCents - monthBanked);
  const finalWeek = !!(bankUsage && bankUsage.finalWeek);
  const pacingBaseCents = finalWeek ? monthlyGoalCents : remainingCap;
  return {
    source_type: "slot_screen_bank_builder",
    positions: [],
    horizontal_groups: [],
    vertical_groups: [],
    base_cents: Math.floor(pacingBaseCents * SCREEN_BANK_BUILDER_PERCENT),
    goal_cents: monthlyGoalCents,
    pacing_base_cents: pacingBaseCents,
    monthly_remaining_cents: remainingCap,
    final_week: finalWeek,
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
  const hasJackpotSpinCredit = settings.jackpot_spin_credits > 0;
  if (!hasRerollCredit && !hasJackpotSpinCredit && state.account.point_balance < spinCost) {
    const err = new Error("Not enough points");
    err.statusCode = 400;
    throw err;
  }
  const drawPool = state.rewards.filter(r => r.kind !== "miss" && !r.lifespan_exhausted);
  let outcome = selectThreeStageOutcome(
    drawPool,
    // A credit-funded spin is a guaranteed single jackpot: force the hit and pin
    // the upgrade rate to 0 so it can never climb to a multi-spin run and mint
    // fresh credits (which would make banked credits regenerate, not count down).
    hasJackpotSpinCredit ? { ...settings, jackpot_hit_rate: 1, jackpot_upgrade_rate: 0, bank_builder_hit_rate: 0, free_spin_tile_rate: 0 } : settings
  );
  let selected = outcome.selected;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT point_balance, settings FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const lockedSettings = normalizeSlotSettings(account && account.settings);
    const usedJackpotSpinCredit = lockedSettings.jackpot_spin_credits > 0;
    const usedRerollCredit = !usedJackpotSpinCredit && lockedSettings.reroll_credits > 0;
    // spinCost is the learned points/day cost from getState; the ledger it reads
    // isn't touched by this spin, so it's stable across the transaction.
    const lockedSpinCost = (usedRerollCredit || usedJackpotSpinCredit) ? 0 : spinCost;
    if (!account || account.point_balance < lockedSpinCost) throw new Error("Not enough points");
    const incomingMods = lockedSettings.next_spin_modifiers || normalizeNextSpinModifiers();
    // A queued miss shield turns a would-be dead spin into a bank builder.
    let missShieldUsed = false;
    if (outcome.outcome === "miss" && (incomingMods.miss_shield || 0) > 0) {
      selected = fakeBankBuilderReward();
      outcome = floorResult("bank", { selected, miss_shielded: true });
      missShieldUsed = true;
    }
    const canHitScreenBank = outcome.bank_builder_hit === true;
    const baseScreen = buildSpinScreen(selected, { ...account, settings: lockedSettings }, state.bankUsage, canHitScreenBank, outcome.jackpot_spins || 1);
    const screen = applyTileOverrideToScreen(
      baseScreen,
      lockedSettings.next_spin_tile_override,
      selected,
      { ...account, settings: lockedSettings },
      state.bankUsage,
      canHitScreenBank
    );
    const screenJackpot = screen.jackpot || evaluateJackpotBoard(screen.board);
    let effectiveOutcome = outcome;
    if (outcome.jackpot_hit && selected.kind !== "bank_builder" && !screenJackpot.hit) {
      selected = fakeMissReward();
      effectiveOutcome = {
        ...outcome,
        outcome: "miss",
        jackpot_hit: false,
        selected,
        source: null,
        tier: null,
        bucket: [],
        empty_bucket: false,
        dice_reroll: null,
      };
      screen.payline = [];
    }
    const reserveCost = effectiveOutcome.jackpot_hit && !effectiveOutcome.empty_bucket ? reserveCostCents(selected) : 0;
    const bankReserved = reserveCost;
    // Armed multiplier charge: while a tier is armed it burns one charge every
    // spin (even non-bank spins) and multiplies this spin's bank builder.
    const charges = { ...lockedSettings.multiplier_charges };
    const armedMultiplier = lockedSettings.active_multiplier || 0;
    let appliedMultiplier = 1;
    if (armedMultiplier > 1 && (charges[armedMultiplier] || 0) > 0) {
      appliedMultiplier = armedMultiplier;
      charges[armedMultiplier] = Math.max(0, charges[armedMultiplier] - 1);
    }
    // Bankroll resolves before every other reward: bank whatever BANK tiles the final
    // board shows, on any spin (bank, gem, refund, free spin, jackpot, even a miss), not
    // only when the rolled outcome was "bank". The deposit rides the spin's
    // slot_screen_bank_builder routing (source_type below) so the sweep / monthly-cap /
    // confirm machinery stays the single source of truth.
    let bankDelta = screen.payout.cents || 0;
    if (bankDelta > 0 && appliedMultiplier > 1) bankDelta = bankDelta * appliedMultiplier;
    // A multiplier-charge booster drops a fresh charge into the stash.
    let earnedChargeTier = 0;
    if (selected.kind === "booster" && effectiveOutcome.multiplier_charge) {
      earnedChargeTier = effectiveOutcome.multiplier_charge.tier;
      charges[earnedChargeTier] = (charges[earnedChargeTier] || 0) + 1;
    }
    // Disarm once the armed tier is exhausted.
    const nextActiveMultiplier = (armedMultiplier > 1 && (charges[armedMultiplier] || 0) > 0) ? armedMultiplier : 0;
    const jackpotSpinCount = effectiveOutcome.jackpot_hit ? screenJackpot.spins : 0;
    // Only an organically-won multi-spin jackpot (4/5-in-a-row) banks extra spins.
    // A credit-funded spin already forces a single 3-in-a-row, but guard here too so
    // banked credits strictly count down regardless of how the board reads back.
    let bonusJackpotSpinCredits = usedJackpotSpinCredit ? 0 : Math.max(0, jackpotSpinCount - 1);

    // Immediate-effect floor outcomes (no confirmation needed).
    let pointsDelta = 0;
    if (selected.kind === "points") {
      pointsDelta = selected.coin_kind === "cashback" ? lockedSpinCost : (selected.points || 0);
    }
    let nextPet = lockedSettings.pet;
    if (selected.kind === "pet") {
      nextPet = { ...lockedSettings.pet };
      if (selected.pet_kind === "cosmetic") {
        nextPet.cosmetics = [...new Set([...(nextPet.cosmetics || []), `cos_${(nextPet.cosmetics || []).length + 1}`])];
      } else {
        nextPet.treats = (nextPet.treats || 0) + 1;
      }
    }
    let nextCollection = lockedSettings.collection;
    let collectibleSetCompleted = false;
    if (selected.kind === "collectible") {
      const current = lockedSettings.collection || normalizeCollection();
      const setSize = current.set_size || DEFAULT_COLLECTION_SET_SIZE;
      let gems = (current.gems || 0) + 1;
      let setsCompleted = current.sets_completed || 0;
      if (gems >= setSize) {
        gems = 0;
        setsCompleted += 1;
        collectibleSetCompleted = true;
        bonusJackpotSpinCredits += 1; // completing a set earns a guaranteed jackpot spin
      }
      nextCollection = { ...current, gems, sets_completed: setsCompleted };
    }
    const gambleState = selected.kind === "booster" ? (selected.gamble || effectiveOutcome.gamble || null) : null;
    const selectedSnapshot = {
      ...selected,
      source_type: bankDelta > 0 ? "slot_screen_bank_builder" : selected.source_type,
      payment_source: selected.payment_source || (effectiveOutcome.source && effectiveOutcome.source.id) || defaultPaymentSourceForKind(selected.kind),
      tier_id: selected.tier_id || (effectiveOutcome.tier && effectiveOutcome.tier.id) || "tier_i",
      slot_stages: {
        outcome: effectiveOutcome.outcome,
        jackpot_hit: effectiveOutcome.jackpot_hit,
        jackpot_hit_rate: settings.jackpot_hit_rate,
        jackpot_level: effectiveOutcome.jackpot_hit ? screenJackpot.level : 0,
        jackpot_spins: jackpotSpinCount,
        bonus_jackpot_spin_credits: bonusJackpotSpinCredits,
        jackpot_orientation: effectiveOutcome.jackpot_hit ? screenJackpot.orientation : null,
        jackpot_payline: effectiveOutcome.jackpot_hit ? screenJackpot.payline : [],
        bank_builder_hit: effectiveOutcome.bank_builder_hit,
        bank_builder_hit_rate: settings.bank_builder_hit_rate,
        free_spin_hit: effectiveOutcome.free_spin_hit === true,
        free_spin_tile_rate: settings.free_spin_tile_rate,
        payment_source: effectiveOutcome.source,
        tier: effectiveOutcome.tier,
        empty_bucket: effectiveOutcome.empty_bucket,
        reroll_credit: effectiveOutcome.reroll_credit,
        dice_reroll: effectiveOutcome.dice_reroll,
        reward_spin: effectiveOutcome.jackpot_hit && !effectiveOutcome.empty_bucket ? {
          reward_id: selected.id,
          chance_shares: selected.chance_shares || selected.weight || 0,
          spin_count: jackpotSpinCount || 1,
          bucket_size: effectiveOutcome.bucket.length,
          bucket_total_shares: bucketTotalShares(effectiveOutcome.bucket),
        } : null,
        coin: selected.kind === "points"
          ? { coin_kind: selected.coin_kind, points: pointsDelta }
          : null,
        pet: selected.kind === "pet" ? { pet_kind: selected.pet_kind } : null,
        collectible: selected.kind === "collectible"
          ? { set_completed: collectibleSetCompleted, gems: nextCollection.gems, sets_completed: nextCollection.sets_completed }
          : null,
        gamble: gambleState,
        bank_multiplier_applied: appliedMultiplier > 1 ? appliedMultiplier : null,
        multiplier_charge_earned: earnedChargeTier || null,
        miss_shielded: missShieldUsed === true,
        tier_up_applied: effectiveOutcome.jackpot_hit && (incomingMods.tier_up || 0) > 0 ? incomingMods.tier_up : null,
      },
      screen_board: screen.board,
      screen_payline: screen.payline,
      bank_screen_payout: screen.payout,
      screen_override: screen.override,
    };
    const status = selected.kind === "booster" && gambleState
      ? "gamble"
      : bankDelta > 0
      ? "pending"
      : effectiveOutcome.reroll_credit
      ? "reroll_credit"
      : selected.kind === "miss"
      ? "miss"
      : selected.kind === "bank_builder" || bankDelta > 0 || reserveCost > 0 || selected.requires_confirmation
      ? "pending"
      : "awarded";
    const nextRerollCredits = Math.max(0, lockedSettings.reroll_credits - (usedRerollCredit ? 1 : 0)) + (effectiveOutcome.reroll_credit ? 1 : 0);
    const nextJackpotSpinCredits = Math.max(0, lockedSettings.jackpot_spin_credits - (usedJackpotSpinCredit ? 1 : 0)) + bonusJackpotSpinCredits;
    // Net point change: pay the spin cost, then add any coin payout (cashback/drop).
    const netPointChange = lockedSpinCost - pointsDelta;
    // Consume each banked modifier only when it actually fired.
    const nextModifiers = normalizeNextSpinModifiers({
      // tier_up clears once a jackpot has consumed it
      tier_up: effectiveOutcome.jackpot_hit ? 0 : incomingMods.tier_up,
      // one shield is spent per miss it converts
      miss_shield: missShieldUsed ? Math.max(0, (incomingMods.miss_shield || 0) - 1) : incomingMods.miss_shield,
    });
    await client.query(
      `UPDATE slot_accounts
       SET point_balance = point_balance - $2,
           settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb,
           updated_at=NOW()
       WHERE workspace_id=$1`,
      [workspaceId, netPointChange, JSON.stringify({
        reroll_credits: nextRerollCredits,
        jackpot_spin_credits: nextJackpotSpinCredits,
        next_spin_tile_override: null,
        next_spin_modifiers: nextModifiers,
        multiplier_charges: charges,
        active_multiplier: nextActiveMultiplier,
        pet: nextPet,
        collection: nextCollection,
      })]
    );
    const { rows } = await client.query(
      `INSERT INTO slot_spins
       (workspace_id,user_id,cost_credits,reward_id,reward_snapshot,status,bank_delta_cents,bank_reserved_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [workspaceId, userId || null, lockedSpinCost, selected.id || null, selectedSnapshot, status, bankDelta || selected.bank_delta_cents || 0, bankReserved]
    );
    if (selected.id) await client.query("UPDATE slot_rewards SET last_won_at=NOW(), uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE GREATEST(uses_remaining - 1, 0) END WHERE id=$1", [selected.id]);
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
    } else if (
      (snapshot.kind === "bank_builder" ||
        (snapshot.source_type === "slot_screen_bank_builder" && !["small_paid", "bank_gated"].includes(snapshot.kind) && !spinRow.bank_reserved_cents)) &&
      spinRow.bank_delta_cents > 0
    ) {
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

async function celebrationSpinForBankrollGoal(workspaceId, userId) {
  await ensureAccount(workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const settings = normalizeSlotSettings(account && account.settings);
    const goal = settings.bankroll_goal;
    if (!goal.enabled || !goal.reward_id) {
      const err = new Error("No active bankroll goal");
      err.statusCode = 400;
      throw err;
    }
    if (goal.celebration_spin_claimed_at) {
      const err = new Error("Bankroll goal celebration already claimed");
      err.statusCode = 400;
      throw err;
    }
    const { rows: rewardRows } = await client.query(
      "SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
      [workspaceId, goal.reward_id]
    );
    const selected = rewardRows[0];
    if (!selected || !isSelfFundedPaidReward(selected)) {
      const err = new Error("Bankroll goal reward is not available");
      err.statusCode = 400;
      throw err;
    }
    await sweepPendingBankBuildersInTx(client, workspaceId);
    const { rows: [freshAccount] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    const targetCents = Math.max(goal.target_cents || 0, reserveCostCents(selected));
    if (((freshAccount && freshAccount.bank_balance_cents) || 0) < targetCents) {
      const err = new Error("Not enough Reward Reserve for that bankroll goal");
      err.statusCode = 400;
      throw err;
    }
    const bankUsage = { today: 0, week: 0, month: 0, monthlyGoal: settings.monthly_goal_cents };
    const screen = buildBankrollGoalCelebrationScreen({ ...freshAccount, settings }, bankUsage);
    const tier = tierStageForReward(settings, selected);
    const now = new Date().toISOString();
    const nextGoal = {
      ...goal,
      enabled: true,
      reward_id: selected.id,
      target_cents: targetCents,
      icon_id: goal.icon_id || "gift",
      description: goal.description || selected.notes || "",
      funded_at: goal.funded_at || now,
      celebration_spin_claimed_at: now,
      updated_at: now,
    };
    const selectedSnapshot = {
      ...selected,
      sponsor_splits: normalizeSponsorSplits(selected.sponsor_splits),
      source_type: "bankroll_goal_celebration",
      payment_source: "self",
      tier_id: selected.tier_id || tier.id || "tier_i",
      bankroll_goal_celebration: true,
      bankroll_goal: {
        reward_id: selected.id,
        target_cents: targetCents,
        icon_id: nextGoal.icon_id,
        description: nextGoal.description,
        funded_at: nextGoal.funded_at,
        celebration_spin_claimed_at: now,
      },
      requires_jackpot_choice: false,
      slot_stages: {
        outcome: "bankroll_goal",
        jackpot_hit: true,
        jackpot_hit_rate: 1,
        jackpot_level: screen.jackpot.level || 3,
        jackpot_spins: 1,
        jackpot_orientation: screen.jackpot.orientation || "horizontal",
        jackpot_payline: screen.jackpot.payline || screen.payline || [],
        bank_builder_hit: false,
        bank_builder_hit_rate: settings.bank_builder_hit_rate,
        payment_source: { id: "self", label: "Self", weight: 0 },
        tier,
        empty_bucket: false,
        reroll_credit: false,
        dice_reroll: null,
        reward_spin: {
          reward_id: selected.id,
          chance_shares: selected.chance_shares || selected.weight || 0,
          spin_count: 1,
          bucket_size: 1,
          bucket_total_shares: Math.max(1, selected.chance_shares || selected.weight || 0),
        },
      },
      screen_board: screen.board,
      screen_payline: screen.payline,
      bank_screen_payout: screen.payout,
      screen_override: null,
    };
    await client.query(
      `UPDATE slot_accounts
       SET bank_balance_cents = GREATEST(0, bank_balance_cents - $2),
           settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb,
           updated_at=NOW()
       WHERE workspace_id=$1`,
      [workspaceId, targetCents, JSON.stringify({ bankroll_goal: nextGoal })]
    );
    const { rows: [spinRow] } = await client.query(
      `INSERT INTO slot_spins
       (workspace_id,user_id,cost_credits,reward_id,reward_snapshot,status,bank_delta_cents,bank_reserved_cents,confirmed_at)
       VALUES ($1,$2,0,$3,$4,'confirmed',0,$5,NOW())
       RETURNING *`,
      [workspaceId, userId || null, selected.id || null, selectedSnapshot, targetCents]
    );
    await client.query("UPDATE slot_rewards SET last_won_at=NOW(), uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE GREATEST(uses_remaining - 1, 0) END WHERE id=$1", [selected.id]);
    await client.query("COMMIT");
    return spinRow;
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
  setNextSpinTileOverride,
  clearNextSpinTileOverride,
  setBankrollGoal,
  clearBankrollGoal,
  chooseSpinDiceReroll,
  chooseSpinGamble,
  combineMultiplierCharges,
  setActiveMultiplier,
  createReward,
  updateReward,
  deleteReward,
  reorderRewards,
  earnTaskCredit,
  spin,
  confirmSpin,
  confirmPendingBankBuilders,
  celebrationSpinForBankrollGoal,
  chooseWeighted,
  _test: {
    buildSpinScreen,
    calculateScreenBankPayout,
    emptyScreenBankPayout,
    normalizeTileBoard,
    normalizeNextSpinTileOverride,
    applyTileOverrideToScreen,
    buildBankrollGoalState,
    buildBankrollGoalCelebrationScreen,
    rollDieReroll,
    chooseExistingBucketAttempt,
    normalizeSlotSettings,
    normalizeEconomyProfile,
    deriveEconomySettings,
    normalizePointTagTiers,
    taskPointTier,
    spinCostForDailyPoints,
    selectThreeStageOutcome,
    resolveFloorOutcome,
    rollFloorOutcomeKind,
    chooseSpinGamble,
    combineMultiplierCharges,
    setActiveMultiplier,
    normalizeMultiplierCharges,
    placeSymbolCluster,
    placeSymbolLine,
    fillCosmetic,
    chooseWeighted,
    bankBuilderHits,
    freeSpinTileHits,
    missHits,
    rollJackpotSpins,
    evaluateJackpotBoard,
    SLOT_PAR_SHEET,
    DEFAULT_FLOOR_WEIGHTS,
    DEFAULT_JACKPOT_HIT_RATE,
    DEFAULT_MISS_RATE,
  },
};
