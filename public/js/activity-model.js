// Versioned, shared workout/meal contract. No network, storage or health targets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ActivityModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const TYPES = ["workout", "meal"];
  const NUTRIENTS = ["calories", "protein", "carbs", "fat"];
  const DISTANCE_METERS = { m: 1, km: 1000, mi: 1609.344 };
  function fail(message) { const e = new Error(message); e.statusCode = 400; throw e; }
  function object(v, label) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(label + " must be an object");
    return v;
  }
  function text(v, label, max = 160, required = true) {
    if (v == null && !required) return "";
    if (typeof v !== "string" || v.length > max || (required && !v.trim())) fail(label + " is required (max " + max + " characters)");
    return v.trim();
  }
  function id(v) {
    const s = text(v, "Row ID", 80);
    if (!/^[\w-]+$/.test(s)) fail("Invalid row ID");
    return s;
  }
  function number(v, label, max = 1000000, integer = false) {
    if (v == null || v === "") return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isInteger(v))) fail(label + " must be a nonnegative " + (integer ? "whole " : "") + "number up to " + max);
    return v;
  }
  function choice(v, values, label) { if (!values.includes(v)) fail("Invalid " + label); return v; }
  function list(v, label, fn) {
    if (!Array.isArray(v) || v.length > 200) fail(label + " must be a list of at most 200 rows");
    const result = v.map((x) => fn(object(x, label)));
    if (new Set(result.map(x => x.id)).size !== result.length) fail("Duplicate IDs in " + label);
    return result;
  }
  function set(x) { return { id: id(x.id), reps: number(x.reps, "Reps", 100000, true), weight: number(x.weight, "Weight", 100000), unit: choice(x.unit, ["lb", "kg"], "weight unit") }; }
  function run(x) { return { id: id(x.id), name: text(x.name, "Run name"), distance: number(x.distance, "Distance"), unit: choice(x.unit, Object.keys(DISTANCE_METERS), "distance unit"), seconds: number(x.seconds, "Elapsed seconds", 31536000) }; }
  function food(x) {
    const result = { id: id(x.id), name: text(x.name, "Food name"), portion: number(x.portion, "Portion"), portionUnit: text(x.portionUnit, "Portion unit", 60, false), nutritionState: choice(x.nutritionState, ["known", "estimated", "unknown"], "nutrition state"), source: text(x.source, "Nutrition source", 300, false) };
    NUTRIENTS.forEach(k => { result[k] = number(x[k], k); });
    if (result.nutritionState === "unknown" && NUTRIENTS.some(k => result[k] !== null)) fail("Unknown nutrition must leave nutrients blank; choose known or estimated to enter values");
    if (NUTRIENTS.some(k => result[k] !== null) && !result.source) fail("Describe the nutrition source for entered nutrients");
    return result;
  }
  function empty(taskType) { return { schemaVersion: 1, taskType, plan: taskType === "workout" ? { exercises: [], runs: [] } : { foods: [] }, actual: taskType === "workout" ? { sets: [], runs: [] } : { foods: [] }, occurredOn: null }; }
  function validDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v; }
  function hasActual(v) { return v.taskType === "meal" ? v.actual.foods.length > 0 : v.actual.sets.length + v.actual.runs.length > 0; }
  function validate(input) {
    object(input, "Record");
    if (input.schemaVersion !== 1) fail("Unsupported record version");
    const type = choice(input.taskType, TYPES, "task type"), out = empty(type);
    const plan = object(input.plan, "Plan"), actual = object(input.actual, "Actual");
    if (type === "workout") {
      out.plan.exercises = list(plan.exercises, "Exercises", x => ({ id: id(x.id), name: text(x.name, "Exercise name"), sets: list(x.sets, "Planned sets", set) }));
      out.plan.runs = list(plan.runs, "Planned runs", run);
      out.actual.sets = list(actual.sets, "Actual sets", x => {
        const exercise = out.plan.exercises.find(e => e.id === x.exerciseId);
        if (!exercise) fail("Actual set must name an exercise");
        if (x.planSetId != null && !exercise.sets.some(s => s.id === x.planSetId)) fail("Actual set references a missing planned set");
        return { ...set(x), exerciseId: exercise.id, planSetId: x.planSetId == null ? null : id(x.planSetId) };
      });
      out.actual.runs = list(actual.runs, "Actual runs", x => {
        if (x.planRunId != null && !out.plan.runs.some(r => r.id === x.planRunId)) fail("Actual run references a missing planned run");
        return { ...run(x), planRunId: x.planRunId == null ? null : id(x.planRunId) };
      });
    } else {
      out.plan.foods = list(plan.foods, "Planned foods", food);
      out.actual.foods = list(actual.foods, "Consumed foods", x => {
        if (x.planFoodId != null && !out.plan.foods.some(f => f.id === x.planFoodId)) fail("Consumed food references a missing planned food");
        return { ...food(x), planFoodId: x.planFoodId == null ? null : id(x.planFoodId) };
      });
    }
    if (input.occurredOn != null && !validDate(input.occurredOn)) fail("Invalid results date");
    out.occurredOn = input.occurredOn || null;
    if (hasActual(out) && !out.occurredOn) fail("Results date is required when logging actuals");
    if (JSON.stringify(out).length > 200000) fail("Record is too large");
    return out;
  }
  function planOnly(input) { const v = validate(input); return { ...empty(v.taskType), plan: v.plan }; }
  function weight(v, from, to) { return v == null ? null : v * (from === "kg" ? 1 : 0.45359237) / (to === "kg" ? 1 : 0.45359237); }
  function distance(v, from, to) { return v == null ? null : v * DISTANCE_METERS[from] / DISTANCE_METERS[to]; }
  function nutrition(foods) {
    return Object.fromEntries(NUTRIENTS.map(k => {
      const known = foods.filter(f => f[k] != null);
      return [k, { value: known.length ? known.reduce((s, f) => s + f[k], 0) : null, known: known.length, total: foods.length, estimated: known.filter(f => f.nutritionState === "estimated").length }];
    }));
  }
  function dateRange(from, to) {
    if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 365) fail("Choose a valid date range of up to 366 days");
    const days = [];
    for (let d = Date.parse(from + "T12:00:00Z"); d <= Date.parse(to + "T12:00:00Z"); d += 86400000) days.push(new Date(d).toISOString().slice(0, 10));
    return days;
  }
  function summarize(records, from, to, units = { weight: "lb", distance: "mi" }) {
    choice(units.weight, ["lb", "kg"], "weight unit"); choice(units.distance, ["km", "mi"], "distance unit");
    const days = dateRange(from, to).map(date => ({ date, workoutTasks: 0, completedWorkouts: 0, loggedWorkouts: 0, mealTasks: 0, loggedMeals: 0, plannedFoods: [], actualFoods: [], plannedRuns: [], actualRuns: [], exercises: {} }));
    const byDate = Object.fromEntries(days.map(d => [d.date, d]));
    for (const row of records) {
      const v = row.record, plannedDay = row.removed ? null : byDate[row.date], actualDay = byDate[v.occurredOn];
      if (v.taskType === "meal") {
        if (plannedDay) { plannedDay.mealTasks++; plannedDay.plannedFoods.push(...v.plan.foods); }
        if (actualDay && hasActual(v)) { actualDay.loggedMeals++; actualDay.actualFoods.push(...v.actual.foods); }
      } else {
        if (plannedDay) { plannedDay.workoutTasks++; if (row.completed) plannedDay.completedWorkouts++; plannedDay.plannedRuns.push(...v.plan.runs); }
        if (actualDay && hasActual(v)) {
          actualDay.loggedWorkouts++;
          actualDay.actualRuns.push(...v.actual.runs);
          for (const e of v.plan.exercises) {
            const sets = v.actual.sets.filter(s => s.exerciseId === e.id);
            if (!sets.length) continue;
            const key = e.name.trim().toLowerCase().replace(/\s+/g, " ");
            if (!Object.prototype.hasOwnProperty.call(actualDay.exercises, key)) Object.defineProperty(actualDay.exercises, key, {
              value: { name: e.name, sets: 0, reps: null, maxLoad: null, volume: null, volumeSets: 0 }, enumerable: true
            });
            const agg = actualDay.exercises[key];
            for (const s of sets) {
              agg.sets++;
              const w = weight(s.weight, s.unit, units.weight);
              if (s.reps != null) agg.reps = (agg.reps || 0) + s.reps;
              if (w != null) agg.maxLoad = agg.maxLoad == null ? w : Math.max(agg.maxLoad, w);
              if (w != null && s.reps != null) { agg.volume = (agg.volume || 0) + w * s.reps; agg.volumeSets++; }
            }
          }
        }
      }
    }
    function runs(rows) {
      const dist = rows.filter(r => r.distance != null), times = rows.filter(r => r.seconds != null);
      const paired = rows.filter(r => r.distance > 0 && r.seconds > 0);
      const pairedDistance = paired.reduce((s, r) => s + distance(r.distance, r.unit, units.distance), 0);
      return { distance: dist.length ? dist.reduce((s, r) => s + distance(r.distance, r.unit, units.distance), 0) : null,
        seconds: times.length ? times.reduce((s, r) => s + r.seconds, 0) : null,
        pace: pairedDistance ? paired.reduce((s, r) => s + r.seconds, 0) / pairedDistance : null,
        count: rows.length, paired: paired.length, distanceKnown: dist.length, timeKnown: times.length };
    }
    return days.map(d => ({ ...d, plannedFoods: undefined, actualFoods: undefined, plannedNutrition: nutrition(d.plannedFoods), actualNutrition: nutrition(d.actualFoods), plannedRuns: runs(d.plannedRuns), actualRuns: runs(d.actualRuns) }));
  }
  // Flat export preserves individual sets/foods, relations and missing fields.
  function csv(records) {
    const columns = ["taskId", "taskType", "title", "scheduledDate", "resultsDate", "completed", "removed", "archived", "phase", "kind", "id", "planId", "exerciseId", "name", "reps", "weight", "weightUnit", "distance", "distanceUnit", "elapsedSeconds", "portion", "portionUnit", "calories", "protein", "carbs", "fat", "nutritionState", "source"];
    const rows = [];
    records.forEach(r => {
      const base = { taskId: r.taskId, taskType: r.record.taskType, title: r.title, scheduledDate: r.date, resultsDate: r.record.occurredOn, completed: r.completed, removed: r.removed, archived: r.archived };
      const push = x => rows.push({ ...base, ...x });
      ["plan", "actual"].forEach(phase => {
        const v = r.record[phase];
        if (r.record.taskType === "meal") v.foods.forEach(f => push({ ...f, phase, kind: "food", planId: f.planFoodId }));
        else {
          if (phase === "plan") v.exercises.forEach(e => e.sets.forEach(s => push({ ...s, phase, kind: "set", exerciseId: e.id, name: e.name, weightUnit: s.unit })));
          else v.sets.forEach(s => push({ ...s, phase, kind: "set", name: r.record.plan.exercises.find(e => e.id === s.exerciseId)?.name, planId: s.planSetId, weightUnit: s.unit }));
          v.runs.forEach(run => push({ ...run, phase, kind: "run", planId: run.planRunId, distanceUnit: run.unit, elapsedSeconds: run.seconds }));
        }
      });
      if (!rows.some(row => row.taskId === r.taskId)) push({ kind: "empty" });
    });
    const cell = v => '"' + String(v == null ? "" : v).replace(/^(\s*[=+@-]|[\t\r\n])/, m => "'" + m).replace(/"/g, '""') + '"';
    return [columns, ...rows.map(r => columns.map(c => r[c]))].map(r => r.map(cell).join(",")).join("\r\n");
  }
  return { TYPES, NUTRIENTS, empty, validate, planOnly, hasActual, validDate, dateRange, weight, distance, nutrition, summarize, csv };
});
