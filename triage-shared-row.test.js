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

test("Triage renders through the normal task list without a second row builder", () => {
  assert.match(scheduleSource, /groups\.forEach[\s\S]*?emitNode\(node,_isSubRow\(node\)\?0:rank\+\+,isDone\(node\.ev\)/);
  assert.match(scheduleSource, /renderItineraryListRow\(ev,/);
  assert.doesNotMatch(triageSource, /function buildScheduleTriageCard|function buildRecurringTriageCard|renderItineraryListRow\(/);
  assert.match(scheduleSource, /DCC\.TimeBlocks\.groupItineraryTree/);
  assert.match(scheduleSource, /class="it-list-duration" title="Estimated completion time"/);
});

test("shared controls appear only when their capability callback exists", () => {
  assert.match(rowSource, /typeof opts\.onComplete!=="function" \? ''/);
  assert.match(rowSource, /typeof opts\.onSchedule==="function"/);
  assert.match(rowSource, /typeof opts\.onRadial==="function"/);
  assert.match(rowSource, /typeof opts\.onDelete==="function"/);
  assert.match(rowSource, /typeof opts\.onAdd==="function"/);
});

test("Triage source ingestion creates durable tasks before rendering controls", () => {
  assert.match(triageSource, /api\/triage\/tasks\/materialize/);
  assert.match(triageSource, /await window\.blockStore\.handleBlocksChanged\(/);
  assert.match(triageSource, /reloadPersistedEdits\(\)/);
  assert.match(scheduleSource, /onDelete:[^\n]*openDeleteConfirm\(ev\.id\)/);
  assert.match(scheduleSource, /itineraryActionButtonsHtml\(ev,isDoneRow\)/);
  assert.match(scheduleSource, /placeBounty\(bb\.dataset\.bountyId\)/);
  assert.doesNotMatch(scheduleSource, /handleItineraryTriageDrop/);
});

test("the detailed Triage tab remains separate and obsolete strip CSS is gone", () => {
  assert.match(triageSource, /function buildTriageCard\(/);
  assert.match(triageSource, /class="tri-card/);
  assert.doesNotMatch(dashboardCss, /\.schedule-triage-card/);
  assert.doesNotMatch(dashboardCss, /\.schedule-triage-summary/);
});

test("materialized tasks reconcile through delta sync and remain retryable until cached", async () => {
  const vm = require("node:vm");
  for (const hydrated of [true, false]) {
    let syncCalls = 0;
    let resolveRender;
    const rendered = new Promise(resolve => { resolveRender = resolve; });
    const context = {
      Set, Intl, viewDate: "2026-09-08",
      activeTriageItems: () => [{ id: "source", title: "Reply" }],
      triageDuration: () => 15,
      triageTaskProps: id => ({ triageId: id }),
      fetch: async () => ({ ok: true, json: async () => ({ blocks: [{ id: "task", date: null, props: {} }] }) }),
      window: { blockStore: {
        getCurrentDate: () => "2026-09-08",
        handleBlocksChanged: async event => {
          syncCalls++;
          assert.equal(event.blockIds[0], "task");
        },
        get: () => hydrated ? { id: "task" } : null
      } },
      buildListView: () => resolveRender(),
      reloadPersistedEdits: () => {}
    };
    vm.createContext(context);
    vm.runInContext(between(triageSource, "const _triageMaterializedSources", "function buildScheduled()"), context);
    vm.runInContext("buildScheduleTriage()", context);
    await rendered;
    assert.equal(syncCalls, 1);
    assert.equal(vm.runInContext('_triageMaterializedSources.has("item:source")', context), hydrated);
    assert.equal(Boolean(vm.runInContext("triageTaskLoadState().error", context)), !hydrated);
  }
});
