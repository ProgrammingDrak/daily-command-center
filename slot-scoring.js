const POINTS_FORMULA_VERSION = "task_points_v3";
const POINTS_PER_SPIN = 25;
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

const NON_EARNING_TYPES = new Set(["meeting", "break", "ooo"]);
const FOCUSED_TAGS = new Set(["deep-work", "deep work", "build", "coding", "writing", "analysis"]);
const LIGHT_TAGS = new Set(["admin", "email", "errand", "chore"]);

function normalizeText(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
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
  return NON_EARNING_TYPES.has(normalizeText(input.type ?? input.kind));
}

function scoreTaskPoints(input = {}) {
  const durationMinutes = resolveDurationMinutes(input);
  const effortTier = inferEffortTier(input, durationMinutes);
  const attentionTier = inferAttentionTier(input);
  const importanceTier = inferImportanceTier(input);
  const effort = EFFORT_MULTIPLIERS[effortTier] || EFFORT_MULTIPLIERS.medium;
  const attention = ATTENTION_MULTIPLIERS[attentionTier] || ATTENTION_MULTIPLIERS.normal;
  const importance = IMPORTANCE_MULTIPLIERS[importanceTier] || IMPORTANCE_MULTIPLIERS.normal;
  const urgency = isUrgent(input) ? 1.15 : 1.0;
  const bountyCount = resolveBountyCount(input);
  const bounty = Math.pow(2, bountyCount);
  const basePoints = durationMinutes;

  if (isNonEarningTaskType(input)) {
    return {
      formulaVersion: POINTS_FORMULA_VERSION,
      eligible: false,
      nonEarningReason: "non_earning_task_type",
      durationMinutes,
      effortTier,
      attentionTier,
      importanceTier,
      bountyCount,
      multipliers: { effort, attention, importance, urgency, bounty },
      basePoints,
      rawPoints: 0,
      awardPoints: 0,
    };
  }

  const rawPoints = basePoints * effort * attention * importance * urgency * bounty;
  const awardPoints = Math.max(1, Math.round(rawPoints));
  return {
    formulaVersion: POINTS_FORMULA_VERSION,
    eligible: true,
    durationMinutes,
    effortTier,
    attentionTier,
    importanceTier,
    bountyCount,
    multipliers: { effort, attention, importance, urgency, bounty },
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
  inferEffortTier,
  inferAttentionTier,
  inferImportanceTier,
  isNonEarningTaskType,
  scoreTaskPoints,
};
