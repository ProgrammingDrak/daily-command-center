const POINTS_FORMULA_VERSION = "task_points_v4";
const POINTS_PER_SPIN = 25;
const COMMUTE_POINT_RATE = 0.1;
const DEFAULT_SPIN_COST_POINTS = 25;
const LEGACY_POINTS_V2_MULTIPLIER = 10;
const POINTS_V3_BALANCE_MULTIPLIER = DEFAULT_SPIN_COST_POINTS / LEGACY_POINTS_V2_MULTIPLIER;

const EFFORT_MULTIPLIERS = {
  trivial: 0.25,
  low: 0.75,
  medium: 1.0,
  high: 1.2,
  intense: 1.4,
};

const ATTENTION_MULTIPLIERS = {
  light: 0.9,
  normal: 1.0,
  focused: 1.1,
  intense: 1.2,
};

const IMPORTANCE_MULTIPLIERS = {
  low: 0.9,
  normal: 1.0,
  important: 1.15,
  high: 1.25,
  critical: 1.4,
};

// Derived from the shared TASK_TYPES registry (public/js/task-types.js) so the
// backend and the frontend mirror (points.js) can never disagree on which
// types earn duration points. Literal fallback keeps scoring alive if the
// registry ever fails to load.
let TaskTypes = null;
try { TaskTypes = require("./public/js/task-types"); } catch (e) { /* fallback below */ }
const NON_EARNING_TYPES = new Set(
  TaskTypes ? TaskTypes.nonEarningTypes() : ["meeting", "break", "ooo", "shell"]
);
// The unconditional tier: these never earn duration points, even with a
// positive point_multiplier or a full-tier tag (unlike meeting/break, which a
// positive multiplier can rescue).
const HARD_ZERO_TYPES = new Set(
  TaskTypes && TaskTypes.hardZeroTypes ? TaskTypes.hardZeroTypes() : ["ooo", "shell"]
);
const FOCUSED_TAGS = new Set(["deep-work", "deep work", "build", "coding", "writing", "analysis"]);
const LIGHT_TAGS = new Set(["admin", "email", "errand", "chore"]);

// Tag-bucket point tiers: a tag assigned to a bucket scales a task's duration
// points by the bucket's multiplier. Source of truth mirrored by points.js
// (FE) and consumed by slot-store.js taskPointTier() (BE credit path).
const POINT_TAG_TIER_MULTIPLIERS = { none: 0, quarter: 0.25, half: 0.5, full: 1 };
// Canonical tag→bucket assignments that ship on every account so well-known
// tags carry a multiplier out of the box, no per-user config required. User
// settings override: an explicit assignment for the same tag id wins over the
// builtin (see foldBuiltinTiers). `meeting` earns half so a meeting keeps its
// non-earning TYPE (lock/fixed-time/single-path) yet still scores real points.
const BUILTIN_POINT_TAG_TIERS = { none: [], quarter: [], half: ["meeting"], full: [] };

function normalizeText(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

// Case-PRESERVING tag id extraction (ids are server UUIDs; do not lowercase).
// Mirrors slot-store.js normalizeTaskTags and points.js tierTags.
function tierTagIds(value) {
  if (Array.isArray(value)) {
    return value.map(t => (t && typeof t === "object")
      ? String(t.id || t.name || t.label || "").trim()
      : String(t == null ? "" : t).trim()).filter(Boolean);
  }
  if (typeof value === "string") return value.split(/[,·|]/).map(t => t.trim()).filter(Boolean);
  return [];
}

// Fold the builtin assignments under a user's tier config: a builtin tag id is
// added only if the user hasn't already placed it in some bucket (user wins),
// and a tag lives in at most one bucket.
function foldBuiltinTiers(userTiers) {
  const out = { none: [], quarter: [], half: [], full: [] };
  const claimed = new Set();
  for (const tier of Object.keys(out)) {
    for (const raw of (userTiers && userTiers[tier]) || []) {
      const id = String(raw || "").trim();
      if (id && !claimed.has(id)) { claimed.add(id); out[tier].push(id); }
    }
  }
  for (const tier of Object.keys(BUILTIN_POINT_TAG_TIERS)) {
    for (const raw of BUILTIN_POINT_TAG_TIERS[tier]) {
      const id = String(raw || "").trim();
      if (id && !claimed.has(id)) { claimed.add(id); out[tier].push(id); }
    }
  }
  return out;
}

// Resolve a task's tags to their highest-value point bucket (builtins folded
// under `userTiers`). Returns null when no bucket matches, so callers can apply
// their own default (unsorted tags earn full; meeting/break earn zero).
function resolvePointTag(tags, userTiers) {
  const tiers = foldBuiltinTiers(userTiers || {});
  const tagSet = new Set(tierTagIds(tags));
  let bestTier = null, bestMult = -1, matched = [];
  for (const [tier, mult] of Object.entries(POINT_TAG_TIER_MULTIPLIERS)) {
    const ids = (tiers[tier] || []).filter(id => tagSet.has(String(id)));
    if (ids.length && mult > bestMult) { bestTier = tier; bestMult = mult; matched = ids; }
  }
  return bestTier
    ? { tier: bestTier, multiplier: POINT_TAG_TIER_MULTIPLIERS[bestTier], matched_tags: matched }
    : null;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\u00b7|]/).map(normalizeText).filter(Boolean);
  return [];
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveDurationMinutes(input = {}) {
  const actual = positiveNumber(input.actual_minutes ?? input.actualMinutes);
  if (actual > 0) return Math.round(actual);
  const scheduled = positiveNumber(input.duration_minutes ?? input.durationMinutes ?? input.duration ?? input.durMin);
  if (scheduled > 0) return Math.round(scheduled);
  return 30;
}

function resolveCommuteMinutes(input = {}) {
  const total = positiveNumber(input.commute_total_minutes ?? input.commuteTotalMinutes ?? input.totalCommuteMinutes);
  if (total > 0) return Math.round(total);
  const to = positiveNumber(
    input.commute_to_minutes ??
    input.commuteToMinutes ??
    input.commute_minutes_to ??
    input.commuteMinutesTo ??
    input.commuteMinutes ??
    input.commute_minutes ??
    input.commuteTime
  );
  const back = positiveNumber(
    input.commute_back_minutes ??
    input.commuteBackMinutes ??
    input.commute_return_minutes ??
    input.commuteReturnMinutes ??
    input.returnCommuteMinutes ??
    input.commute_minutes_back ??
    input.commuteMinutesBack
  );
  return Math.round(to + back);
}

function isHighPriority(input = {}) {
  const priority = normalizeText(input.priority);
  return priority === "high" || priority === "urgent" || priority === "p1" || priority === "critical";
}

function isUrgent(input = {}) {
  const urgency = normalizeText(input.urgency);
  const priority = normalizeText(input.priority);
  return input.urgent === true ||
    urgency === "urgent" ||
    urgency === "now" ||
    urgency === "today" ||
    priority === "urgent" ||
    priority === "p1" ||
    priority === "critical";
}

function isResponsibilityTask(input = {}) {
  return input.responsibility === true ||
    input.is_responsibility === true ||
    input.responsibility_id != null ||
    input.responsibilityId != null ||
    normalizeText(input.source) === "responsibility";
}

function inferEffortTier(input = {}, durationMinutes = resolveDurationMinutes(input)) {
  const explicit = normalizeText(input.effort_tier ?? input.effortTier);
  if (EFFORT_MULTIPLIERS[explicit]) return explicit;
  const tags = normalizeTags(input.tags ?? input.tag);
  if (input.trivial === true || tags.includes("trivial")) return "trivial";
  if (tags.includes("hard") || tags.includes("difficult") || tags.includes("heavy")) return "high";
  if (tags.includes("intense")) return "intense";
  if (durationMinutes <= 10 && tags.some(tag => LIGHT_TAGS.has(tag))) return "low";
  return "medium";
}

function inferAttentionTier(input = {}) {
  const explicit = normalizeText(input.attention_tier ?? input.attentionTier);
  if (ATTENTION_MULTIPLIERS[explicit]) return explicit;
  const tags = normalizeTags(input.tags ?? input.tag);
  if (tags.some(tag => FOCUSED_TAGS.has(tag))) return "focused";
  if (tags.some(tag => LIGHT_TAGS.has(tag))) return "light";
  return "normal";
}

function inferImportanceTier(input = {}) {
  const explicit = normalizeText(input.importance_tier ?? input.importanceTier ?? input.importance);
  if (IMPORTANCE_MULTIPLIERS[explicit]) return explicit;
  const priority = normalizeText(input.priority);
  if (priority === "critical" || priority === "p1") return "critical";
  if (priority === "urgent" || priority === "high") return "high";
  if (priority === "medium" || priority === "normal") return "normal";
  if (priority === "low") return "low";
  if (isResponsibilityTask(input)) return "important";
  return "normal";
}

function resolveBountyCount(input = {}) {
  const explicit = Number(input.bounty_count ?? input.bountyCount);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(2, Math.round(explicit)));
  let count = input.bounty === true ? 1 : 0;
  if (input.partner_bounty === true || input.partnerBounty === true || input.shared_bounty === true || input.sharedBounty === true) {
    count += 1;
  }
  return Math.max(0, Math.min(2, count));
}

function isNonEarningTaskType(input = {}) {
  const type = normalizeText(input.type ?? input.kind);
  // Unconditional tier (ooo: time off; shell: its points arrive only as a
  // rollup bonus via points_override) — no multiplier check can rescue these.
  if (HARD_ZERO_TYPES.has(type)) return true;
  if (!NON_EARNING_TYPES.has(type)) return false;
  const multiplier = Number(input.point_multiplier ?? input.pointMultiplier);
  return !Number.isFinite(multiplier) || multiplier <= 0;
}

function scoreTaskPoints(input = {}) {
  const durationMinutes = resolveDurationMinutes(input);
  const commuteMinutes = resolveCommuteMinutes(input);
  const effortTier = inferEffortTier(input, durationMinutes);
  const attentionTier = inferAttentionTier(input);
  const importanceTier = inferImportanceTier(input);
  const effort = EFFORT_MULTIPLIERS[effortTier] || EFFORT_MULTIPLIERS.medium;
  const attention = ATTENTION_MULTIPLIERS[attentionTier] || ATTENTION_MULTIPLIERS.normal;
  const importance = IMPORTANCE_MULTIPLIERS[importanceTier] || IMPORTANCE_MULTIPLIERS.normal;
  const urgency = isUrgent(input) ? 1.15 : 1.0;
  const bountyCount = resolveBountyCount(input);
  const bounty = Math.pow(2, bountyCount);
  const requestedPointMultiplier = Number(input.point_multiplier ?? input.pointMultiplier);
  const pointMultiplier = Number.isFinite(requestedPointMultiplier)
    ? Math.max(0, Math.min(1, requestedPointMultiplier))
    : 1;
  const basePoints = durationMinutes * pointMultiplier;
  const commutePoints = commuteMinutes * COMMUTE_POINT_RATE * pointMultiplier;

  if (isNonEarningTaskType(input) || pointMultiplier <= 0) {
    return {
      formulaVersion: POINTS_FORMULA_VERSION,
      eligible: false,
      nonEarningReason: pointMultiplier <= 0 ? "point_tier_zero" : "non_earning_task_type",
      durationMinutes,
      commuteMinutes,
      commutePointRate: COMMUTE_POINT_RATE,
      commutePoints,
      effortTier,
      attentionTier,
      importanceTier,
      bountyCount,
      pointMultiplier,
      pointTier: input.point_tier || input.pointTier || null,
      multipliers: { points: pointMultiplier, effort, attention, importance, urgency, bounty },
      basePoints,
      rawPoints: 0,
      awardPoints: 0,
    };
  }

  const workPoints = basePoints * effort * attention * importance * urgency * bounty;
  const rawPoints = workPoints + commutePoints;
  const awardPoints = Math.max(1, Math.round(rawPoints));
  return {
    formulaVersion: POINTS_FORMULA_VERSION,
    eligible: true,
    durationMinutes,
    commuteMinutes,
    commutePointRate: COMMUTE_POINT_RATE,
    commutePoints,
    workPoints,
    effortTier,
    attentionTier,
    importanceTier,
    bountyCount,
    pointMultiplier,
    pointTier: input.point_tier || input.pointTier || null,
    multipliers: { points: pointMultiplier, effort, attention, importance, urgency, bounty },
    basePoints,
    rawPoints,
    awardPoints,
  };
}

module.exports = {
  POINTS_FORMULA_VERSION,
  POINTS_PER_SPIN,
  DEFAULT_SPIN_COST_POINTS,
  LEGACY_POINTS_V2_MULTIPLIER,
  POINTS_V3_BALANCE_MULTIPLIER,
  EFFORT_MULTIPLIERS,
  ATTENTION_MULTIPLIERS,
  IMPORTANCE_MULTIPLIERS,
  resolveDurationMinutes,
  resolveCommuteMinutes,
  inferEffortTier,
  inferAttentionTier,
  inferImportanceTier,
  isNonEarningTaskType,
  scoreTaskPoints,
  HARD_ZERO_TYPES,
  POINT_TAG_TIER_MULTIPLIERS,
  BUILTIN_POINT_TAG_TIERS,
  foldBuiltinTiers,
  resolvePointTag,
};
