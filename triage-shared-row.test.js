const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const TaskModel = require("./public/js/task-model.js");
const read = file => fs.readFileSync(path.join(__dirname, file), "utf8");
const rowSource = read("public/js/itinerary-card.js");
const scheduleSource = read("public/js/schedule-tab.js");
const triageSource = read("public/js/triage.js");
const scheduleCoreSource = read("public/js/schedule.js");
const responsibilitySource = read("public/js/responsibilities.js");
const dashboardCss = read("public/css/dashboard.css");
const optimizationCss = read("public/css/ui-optimization.css");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `${start} not found`);
  assert.ok(to > from, `${end} not found after ${start}`);
  return source.slice(from, to);
}

test("triage projects into a private untimed task without mutating its source", () => {
  const item = {
    id: "inbox-7",
    title: "Reply to the partner",
    priority: "urgent",
    estimated_minutes: "25",
    source_url: "https://example.test/thread",
    summary: "Needs an answer",
  };
  const before = structuredClone(item);
  const task = TaskModel.fromTriageItem(item);

  assert.deepEqual(item, before);
  assert.equal(task.id, "triage-inbox-7");
  assert.equal(task.title, item.title);
  assert.equal(task.untimed, true);
  assert.equal(task.durMin, 25);
  assert.equal(task.durationMinutes, 25);
  assert.equal(task.priority, "High");
  assert.equal(task.publicVisibility, "private");
  assert.equal(task.source_id, item.source_url);
  assert.equal(task.__triage.sourceId, item.id);
  assert.equal(task.__triage.item, item);
});

test("triage duration accepts existing field spellings and keeps a five minute floor", () => {
  assert.equal(TaskModel.fromTriageItem({ id: "a", durationMinutes: 45 }).durMin, 45);
  assert.equal(TaskModel.fromTriageItem({ id: "b", estimatedMinutes: 1 }).durMin, 5);
  assert.equal(TaskModel.fromTriageItem({ id: "c" }).durMin, 5);
});

test("due responsibilities project into recurring untimed task rows", () => {
  const item = { id: "resp-4", title: "Water plants", estimatedMinutes: 15 };
  const task = TaskModel.fromDueResponsibility(item);

  assert.equal(task.id, "responsibility-resp-4");
  assert.equal(task.title, item.title);
  assert.equal(task.untimed, true);
  assert.equal(task.durMin, 15);
  assert.equal(task.source, "responsibility");
  assert.equal(task.publicVisibility, "private");
  assert.equal(task.__responsibility.sourceId, item.id);
});

test("all itinerary task families use one list row renderer", () => {
  const triageBuilder = between(triageSource, "function buildScheduleTriageCard", "function buildRecurringTriageCard");
  const recurringBuilder = between(triageSource, "function buildRecurringTriageCard", "let _itineraryTriageEvents");

  assert.match(scheduleSource, /renderItineraryListRow\(ev,/);
  assert.match(triageBuilder, /renderItineraryListRow\(ev,/);
  assert.match(recurringBuilder, /renderItineraryListRow\(ev,/);
  for (const className of ["it-list-utility", "it-list-main", "it-list-actions"]) {
    assert.match(rowSource, new RegExp(`class="${className}"`));
  }
});

test("triage rows show estimated duration without a synthetic clock range", () => {
  const triageBuilder = between(triageSource, "function _triageRowMeta", "function buildRecurringTriageCard");
  const recurringBuilder = between(triageSource, "function buildRecurringTriageCard", "let _itineraryTriageEvents");

  assert.match(triageBuilder, /class="it-list-duration"/);
  assert.match(recurringBuilder, /class="it-list-duration"/);
  assert.doesNotMatch(triageBuilder, /class="start-time/);
  assert.doesNotMatch(recurringBuilder, /class="start-time/);
  assert.match(optimizationCss, /\.it-list-duration/);
});

test("shared controls appear only when their capability callback exists", () => {
  assert.match(rowSource, /typeof opts\.onComplete!=="function" \? ''/);
  assert.match(rowSource, /typeof opts\.onSchedule==="function"/);
  assert.match(rowSource, /typeof opts\.onRadial==="function"/);
  assert.match(rowSource, /typeof opts\.onDelete==="function"/);
  assert.match(rowSource, /typeof opts\.onAdd==="function"/);
});

test("triage actions retain durable source handlers", () => {
  const builder = between(triageSource, "function buildScheduleTriageCard", "function buildRecurringTriageCard");
  const scheduler = between(triageSource, "async function scheduleTriageItem", "window.scheduleTriageOnDate");
  assert.match(builder, /onComplete:\(\)=>dismissTriage/);
  assert.match(builder, /onCompleteWithNotes:[^\n]*openDoneModal/);
  assert.match(builder, /onSchedule:\(\)=>scheduleTriageItem/);
  assert.match(builder, /onDelete:\(\)=>deleteTriageItem/);
  assert.match(scheduler, /if\(info&&info\.persisted\)await info\.persisted;/);
  assert.ok(scheduler.indexOf("await info.persisted") < scheduler.indexOf("await record("));
  assert.match(scheduler, /catch\(e\)[\s\S]*Task could not be created/);
  assert.doesNotMatch(scheduler.slice(scheduler.indexOf("catch(e)")), /recordTriageScheduled/);
});

test("triage reorder and placement reuse itinerary movement primitives", () => {
  assert.match(scheduleSource, /handleItineraryTriageDrop\(movedId,targetId,e\)/);
  assert.match(triageSource, /saveUnscheduledOrder\(/);
  assert.match(triageSource, /targetId:target\.id,after:after,orderWins:true/);
  assert.match(scheduleCoreSource, /_reorderActive\(newItem\.id,opts\.targetId,!!opts\.after\)/);
  assert.match(scheduleCoreSource, /source_id:item\.source_id\|\|""/);
  assert.match(scheduleCoreSource, /triageKey:item\.triageKey\|\|null/);
});

test("recurring triage exposes schedule complete skip and pause actions", () => {
  const radial = between(triageSource, "function _openResponsibilityRowRadial", "function _triageRowMeta");
  for (const label of ["Schedule…", "Complete", "Skip this cycle", "Pause"]) {
    assert.match(radial, new RegExp(`label:"${label}"`));
  }
  assert.match(responsibilitySource, /function scheduleRepeatResponsibility\(id,opts\)/);
});

test("the detailed Triage tab remains separate and obsolete strip CSS is gone", () => {
  assert.match(triageSource, /function buildTriageCard\(/);
  assert.match(triageSource, /class="tri-card/);
  assert.doesNotMatch(dashboardCss, /\.schedule-triage-card/);
  assert.doesNotMatch(dashboardCss, /\.schedule-triage-summary/);
});
