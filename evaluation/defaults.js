const DEFAULT_EVALUATION_SETTINGS = {
  version: "ev_calculator_v1",
  costWeights: {
    timeHour: 25,
    energyPoint: 10,
    attentionPoint: 12,
    moneyDollar: 1,
  },
  categories: {
    work: { label: "Work", outcomeUnitValue: 50 },
    financial: { label: "Financial", outcomeUnitValue: 1 },
    personal: { label: "Personal", outcomeUnitValue: 35 },
    health: { label: "Health", outcomeUnitValue: 45 },
    relationship: { label: "Relationship", outcomeUnitValue: 40 },
    learning: { label: "Learning", outcomeUnitValue: 30 },
  },
};

module.exports = { DEFAULT_EVALUATION_SETTINGS };
