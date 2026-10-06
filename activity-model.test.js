const test = require("node:test"), assert = require("node:assert/strict");
const M = require("./public/js/activity-model"), T = require("./public/js/task-types");
const { workout, meal } = require("./test-support/activity-fixtures");
const row = (record, extra = {}) => ({ taskId: "t1", title: "Fixture", date: "2026-10-06", completed: true, record, ...extra });
test("shared Today date follows the boot-loaded DCC day even when UTC is different", () => {
  const vm = require("node:vm"), fs = require("node:fs");
  const context = { window: { __DCC_STATE__: { date: "2026-10-08" } }, document: { addEventListener() {} } };
  vm.runInNewContext('let __todayDate = "2026-10-05";\n' + fs.readFileSync("public/js/core.js", "utf8"), context);
  assert.equal(context.window.DCC.dates.todayKey(), "2026-10-05");
});
test("workout and meal retain ordinary task movement, completion and earning semantics", () => {
  for (const type of M.TYPES) for (const key of ["earnsOwnPoints", "movable", "fixedTime", "actualTimeMode", "completionTimeMode"]) assert.equal(T.get(type)[key], T.get("task")[key]);
});
test("picker persistence carries only the saved activity plan reference", () => {
  const { taskBlockProps } = require("./public/js/task-serialize");
  const props = taskBlockProps({ type: "workout", activityPlanSourceId: "series-1", publicVisibility: "public", actual: workout().actual });
  assert.equal(props.type, "workout"); assert.equal(props.activityPlanSourceId, "series-1");
  assert.equal(props.publicVisibility, "private"); assert.equal(props.actual, undefined);
});
test("multiple actual sets retain their relation to one plan and do not rewrite it", () => {
  const v = M.validate(workout()); assert.equal(v.actual.sets.length, 2); assert.equal(v.plan.exercises[0].sets[0].reps, 10);
  const [day] = M.summarize([row(v)], "2026-10-06", "2026-10-06", { weight: "lb", distance: "mi" });
  assert.equal(day.exercises["bench press"].volume, 1500); assert.equal(day.exercises["bench press"].reps, 55);
  assert.equal(day.actualRuns.distance, 1); assert.equal(day.actualRuns.pace, 600);
});
test("freeform exercise names cannot collide with object prototype keys", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    const r = workout(); r.plan.exercises[0].name = name;
    const [d] = M.summarize([row(r)], "2026-10-06", "2026-10-06");
    assert.equal(d.exercises[name.toLowerCase()].volume, 1500);
  }
  assert.equal({}.volume, undefined);
});
test("unit conversion normalizes load, distance and pace without mixing exercise scores", () => {
  const r = workout(); r.actual.sets.push({ id: "kg-set", exerciseId: "bench", planSetId: null, reps: 2, weight: 10, unit: "kg" });
  const [d] = M.summarize([row(r)], "2026-10-06", "2026-10-06", { weight: "kg", distance: "km" });
  assert.ok(Math.abs(d.exercises["bench press"].volume - (1500 * 0.45359237 + 20)) < 1e-9);
  assert.equal(d.actualRuns.distance, 1.609344); assert.ok(Math.abs(d.actualRuns.pace - 600 / 1.609344) < 1e-9);
  assert.equal(d.plannedRuns.distance, 5); assert.equal(d.volume, undefined);
});
test("run pace only includes complete positive distance/time pairs and weights by distance", () => {
  const r = workout(); r.actual.runs.push({ id: "long", planRunId: null, name: "Run", distance: 2, unit: "mi", seconds: 1800 }, { id: "missing", planRunId: null, name: "Run", distance: 3, unit: "mi", seconds: null });
  const [d] = M.summarize([row(r)], "2026-10-06", "2026-10-06"); assert.equal(d.actualRuns.pace, 800); assert.equal(d.actualRuns.paired, 2); assert.equal(d.actualRuns.count, 3);
});
test("meals report partial known values, estimates and unknowns, never copy planned totals", () => {
  const [d] = M.summarize([row(M.validate(meal()))], "2026-10-06", "2026-10-06");
  assert.equal(d.plannedNutrition.calories.value, 600); assert.deepEqual(d.actualNutrition.calories, { value: 300, known: 1, total: 2, estimated: 1 });
  assert.equal(d.actualNutrition.carbs.value, null); assert.equal(d.actualNutrition.carbs.known, 0);
  const r = meal(); r.actual.foods[0].carbs = 0; assert.equal(M.nutrition(r.actual.foods).carbs.value, 0);
});
test("moving a task preserves the results day; removed tasks retain logged history", () => {
  const days = M.summarize([row(workout(), { date: "2026-10-07" })], "2026-10-06", "2026-10-07");
  assert.equal(days[0].loggedWorkouts, 1); assert.equal(days[1].loggedWorkouts, 0); assert.equal(days[1].workoutTasks, 1);
  const [removed] = M.summarize([row(workout(), { removed: true })], "2026-10-06", "2026-10-06");
  assert.equal(removed.workoutTasks, 0); assert.equal(removed.loggedWorkouts, 1);
});
test("empty date and empty nutrition do not become zeros", () => {
  const [d] = M.summarize([], "2026-10-06", "2026-10-06"); assert.equal(d.actualNutrition.calories.value, null); assert.equal(d.actualRuns.pace, null); assert.deepEqual(d.exercises, {});
});
test("reused plans reset all actuals and results dates without aliasing input", () => {
  for (const r of [workout(), meal()]) { const p = M.planOnly(r); assert.equal(M.hasActual(p), false); assert.equal(p.occurredOn, null); assert.deepEqual(p.plan, r.plan); assert.notEqual(p.plan, r.plan); }
});
test("invalid numbers, links, units, dates, duplicate rows and version are rejected", () => {
  for (const change of [r => { r.actual.sets[0].reps = -1; }, r => { r.actual.sets[0].reps = 1.1; }, r => { r.actual.sets[0].weight = Infinity; }, r => { r.actual.sets[0].weight = "10"; }, r => { r.actual.sets[0].unit = "stone"; }, r => { r.actual.sets[0].planSetId = "missing"; }, r => { r.actual.sets[0].exerciseId = "missing"; }, r => { r.occurredOn = "2026-02-30"; }, r => { r.occurredOn = null; }, r => { r.actual.sets[1].id = r.actual.sets[0].id; }, r => { r.schemaVersion = 2; }]) { const r = workout(); change(r); assert.throws(() => M.validate(r)); }
  const r = meal(); r.actual.foods[0].source = ""; assert.throws(() => M.validate(r), /source/); r.actual.foods[0].nutritionState = "unknown"; assert.throws(() => M.validate(r), /Unknown/);
  assert.throws(() => M.dateRange("2026-10-07", "2026-10-06")); assert.throws(() => M.dateRange("2020-01-01", "2026-01-01"));
});
test("CSV preserves individual sets, units, unknown fields, quoted strings and formula safety", () => {
  const csv = M.csv([row(workout(), { title: '=HYPERLINK("x")' }), row(meal(), { taskId: "t2" })]);
  assert.match(csv, /'=HYPERLINK/); assert.match(csv, /"actual-1","plan-1"/); assert.match(csv, /"actual-2","plan-1"/); assert.match(csv, /"meal-unknown"/);
});
