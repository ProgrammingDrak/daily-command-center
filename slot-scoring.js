const POINTS_FORMULA_VERSION = "task_points_v2";
const POINTS_PER_SPIN = 10;
const DEFAULT_SPIN_COST_POINTS = 10;

const EFFORT_MULTIPLIERS = {
  trivial: 0.35,
  low: 0.75,
  medium: 1.15,
  high: 1.35,
  intense: 1.55,
};

const ATTENTION_MULTIPLIERS = {
  light: 0.85,
  normal: 1.0,
  focused: 1.15,
  intense: 1.3,
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
  return input.urgent === true || normalizeText(input.urgency) === "urgent" || isHighPriority(input);
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
  if (isHighPriority(input) || isUrgent(input) || isResponsibilityTask(input) || durationMinutes >= 90) return "high";
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

function isNonEarningTaskType(input = {}) {
  return NON_EARNING_TYPES.has(normalizeText(input.type ?? input.kind));
}

function scoreTaskPoints(input = {}) {
  const durationMinutes = resolveDurationMinutes(input);
  const effortTier = inferEffortTier(input, durationMinutes);
  const attentionTier = inferAttentionTier(input);
  const effort = EFFORT_MULTIPLIERS[effortTier] || EFFORT_MULTIPLIERS.medium;
  const attention = ATTENTION_MULTIPLIERS[attentionTier] || ATTENTION_MULTIPLIERS.normal;
  const urgency = isUrgent(input) ? 1.2 : 1.0;
  const bounty = input.bounty === true ? 2.0 : 1.0;
  const basePoints = durationMinutes / 5;

  if (isNonEarningTaskType(input)) {
    return {
      formulaVersion: POINTS_FORMULA_VERSION,
      eligible: false,
      nonEarningReason: "non_earning_task_type",
      durationMinutes,
      effortTier,
      attentionTier,
      multipliers: { effort, attention, urgency, bounty },
      basePoints,
      rawPoints: 0,
      awardPoints: 0,
    };
  }

  const rawPoints = basePoints * effort * attention * urgency * bounty;
  const awardPoints = Math.max(1, Math.round(rawPoints));
  return {
    formulaVersion: POINTS_FORMULA_VERSION,
    eligible: true,
    durationMinutes,
    effortTier,
    attentionTier,
    multipliers: { effort, attention, urgency, bounty },
    basePoints,
    rawPoints,
    awardPoints,
  };
}

module.exports = {
  POINTS_FORMULA_VERSION,
  POINTS_PER_SPIN,
  DEFAULT_SPIN_COST_POINTS,
  EFFORT_MULTIPLIERS,
  ATTENTION_MULTIPLIERS,
  resolveDurationMinutes,
  inferEffortTier,
  inferAttentionTier,
  isNonEarningTaskType,
  scoreTaskPoints,
};
