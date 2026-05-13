const { DEFAULT_EVALUATION_SETTINGS } = require("./defaults");

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeProbability(value) {
  const n = num(value, 0);
  if (n > 1) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function mergeSettings(settings = {}) {
  return {
    ...DEFAULT_EVALUATION_SETTINGS,
    ...settings,
    costWeights: {
      ...DEFAULT_EVALUATION_SETTINGS.costWeights,
      ...(settings.costWeights || {}),
    },
    categories: {
      ...DEFAULT_EVALUATION_SETTINGS.categories,
      ...(settings.categories || {}),
    },
  };
}

function normalizeOutcome(outcome = {}, categoryConfig) {
  const probability = normalizeProbability(outcome.probability ?? outcome.p);
  const label = String(outcome.label || outcome.name || "Outcome");
  const unitValue = num(categoryConfig.outcomeUnitValue, 1);
  const value = outcome.value_usd != null
    ? num(outcome.value_usd, 0)
    : outcome.value != null
      ? num(outcome.value, 0) * unitValue
      : outcome.utility != null
        ? num(outcome.utility, 0) * unitValue
        : 0;
  return {
    label,
    probability,
    value,
    weightedValue: probability * value,
  };
}

function scoreEvaluation(input = {}, settings = {}) {
  const merged = mergeSettings(settings);
  const categoryKey = String(input.category || "work");
  const category = merged.categories[categoryKey] || merged.categories.work;
  const timeHours = Math.max(0, num(input.time_hours ?? input.timeHours, 0));
  const energy = Math.max(0, num(input.energy, 0));
  const attention = Math.max(0, num(input.attention, 0));
  const moneyUsd = Math.max(0, num(input.money_usd ?? input.moneyUsd, 0));
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes.map(o => normalizeOutcome(o, category)) : [];
  const ev = outcomes.reduce((sum, outcome) => sum + outcome.weightedValue, 0);
  const inputCost =
    timeHours * num(merged.costWeights.timeHour, 0) +
    energy * num(merged.costWeights.energyPoint, 0) +
    attention * num(merged.costWeights.attentionPoint, 0) +
    moneyUsd * num(merged.costWeights.moneyDollar, 1);
  const netEv = ev - inputCost;
  const roi = inputCost > 0 ? netEv / inputCost : null;
  const evPerHour = timeHours > 0 ? netEv / timeHours : null;
  const probabilityTotal = outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
  const warnings = [];

  if (!outcomes.length) warnings.push("Add at least one outcome.");
  if (outcomes.length && Math.abs(probabilityTotal - 1) > 0.05) warnings.push("Outcome probabilities should add up to roughly 100%.");
  if (inputCost === 0) warnings.push("Input cost is zero, so ROI is not meaningful.");
  if (moneyUsd > ev && moneyUsd > 0) warnings.push("Money at risk is greater than gross EV.");
  if (netEv < 0) warnings.push("Net EV is negative after input costs.");

  return {
    version: merged.version,
    category: categoryKey,
    ev,
    inputCost,
    netEv,
    roi,
    evPerHour,
    probabilityTotal,
    warnings,
    outcomes,
    inputs: { timeHours, energy, attention, moneyUsd },
  };
}

module.exports = {
  scoreEvaluation,
  normalizeProbability,
  mergeSettings,
};
