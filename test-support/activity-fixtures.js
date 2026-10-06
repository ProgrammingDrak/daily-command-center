const M = require("../public/js/activity-model");
function workout(date = "2026-10-06") {
  const r = M.empty("workout");
  r.plan.exercises = [{ id: "bench", name: "Bench press", sets: [{ id: "plan-1", reps: 10, weight: 50, unit: "lb" }] }];
  r.actual.sets = [{ id: "actual-1", exerciseId: "bench", planSetId: "plan-1", reps: 5, weight: 50, unit: "lb" },
    { id: "actual-2", exerciseId: "bench", planSetId: "plan-1", reps: 50, weight: 25, unit: "lb" }];
  r.plan.runs = [{ id: "run-plan", name: "Run", distance: 5, unit: "km", seconds: 1800 }];
  r.actual.runs = [{ id: "run-actual", planRunId: "run-plan", name: "Run", distance: 1, unit: "mi", seconds: 600 }];
  r.occurredOn = date; return r;
}
function meal(date = "2026-10-06") {
  const r = M.empty("meal");
  const food = { id: "meal-plan", name: "Sample meal", portion: 1, portionUnit: "serving", calories: 600, protein: 30, carbs: 60, fat: 20, nutritionState: "estimated", source: "Synthetic QA fixture" };
  r.plan.foods = [food];
  r.actual.foods = [{ ...food, id: "meal-actual", planFoodId: food.id, portion: 0.5, calories: 300, protein: 15, carbs: null, fat: null },
    { id: "meal-unknown", planFoodId: null, name: "Unmeasured side", portion: null, portionUnit: "", calories: null, protein: null, carbs: null, fat: null, nutritionState: "unknown", source: "" }];
  r.occurredOn = date; return r;
}
module.exports = { workout, meal };
