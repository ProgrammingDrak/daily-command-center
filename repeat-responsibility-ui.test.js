const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const clientSource = fs.readFileSync(path.join(__dirname, "public/js/responsibilities.js"), "utf8");
const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule-tab.js"), "utf8");

test("editor contains the two modes and the complete scheduled recurrence controls", () => {
  for (const id of [
    "resp-repeat-type", "resp-scheduled-fields", "resp-schedule-pattern", "resp-schedule-start-date",
    "resp-schedule-time-zone", "resp-schedule-frequency", "resp-schedule-interval", "resp-schedule-times",
    "resp-schedule-weekdays", "resp-schedule-month-mode", "resp-schedule-month-days",
    "resp-schedule-ordinal", "resp-schedule-ordinal-weekday", "resp-schedule-months",
    "resp-schedule-end-type", "resp-schedule-end-date", "resp-schedule-end-count",
    "resp-schedule-date-times", "resp-schedule-preview",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  assert.match(html, /value="readiness"[^>]*>Readiness-based/);
  assert.match(html, /value="scheduled"[^>]*>Scheduled/);
  assert.match(html, /surface in triage at 75%/i);
});

test("library filters and occurrence scope prompt expose both modes and all edit scopes", () => {
  assert.match(html, /option value="readiness">Readiness/);
  assert.match(html, /option value="scheduled">Scheduled/);
  assert.match(html, /id="repeat-occurrence-scope"/);
  assert.match(html, /value="occurrence">Only this occurrence/);
  assert.match(html, /value="following">This and following occurrences/);
  assert.match(html, /value="series">Every open occurrence in the series/);
  assert.match(clientSource, /\/series-change/);
  assert.match(scheduleSource, /Repeat options/);
});

async function clientWindow(items, globals = {}) {
  const document = {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
  };
  const DCC = {
    esc: (value) => String(value == null ? "" : value),
    TaskModel: { selectNotDeleted: (rows) => rows || [], selectOpen: (rows) => rows || [] },
  };
  const window = {
    DCC,
    urgency: {
      DUE_THRESHOLD: 75,
      scoreClass: () => "yellow",
      timing: () => ({ cadence: 7, elapsed: 5, remaining: 2, progress: 71 }),
    },
  };
  const context = {
    window, DCC, document, scheduled: [], console, Intl, Date, Math, JSON,
    encodeURIComponent, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ items }) }),
    ...globals,
  };
  vm.createContext(context);
  vm.runInContext(clientSource, context, { filename: "responsibilities.js" });
  await window.loadResponsibilities();
  return window;
}

async function dueItems(items) {
  return (await clientWindow(items)).getDueRepeatResponsibilities();
}

test("browser triage excludes readiness 74, includes 75, and always excludes scheduled repeats", async () => {
  const base = { kind: "responsibility_item", status: "active", cadence: "weekly", cadenceDays: 7, title: "Review" };
  const due = await dueItems([
    { id: "r74", properties: { ...base, importanceScore: 74 } },
    { id: "r75", properties: { ...base, importanceScore: 75 } },
    { id: "scheduled", properties: { ...base, repeatType: "scheduled", importanceScore: 100 } },
  ]);
  assert.deepEqual(Array.from(due, (item) => item.id), ["r75"]);
});

test("scheduled fields are conditionally switched and previewed through the validation endpoint", () => {
  assert.match(clientSource, /scheduleFields\.style\.display=scheduled\?"":"none"/);
  assert.match(clientSource, /\.resp-readiness-field/);
  assert.match(clientSource, /\/api\/responsibilities\/preview/);
  assert.match(clientSource, /nextOccurrences/);
  assert.match(clientSource, /#resp-scheduled-fields input,#resp-scheduled-fields select,#resp-scheduled-fields textarea/);
});

test("collapsed scheduled cards expose cadence and the next scheduled time", async () => {
  const window = await clientWindow([]);
  const labels = window.scheduledResponsibilityLabels({
    recurrenceSummary: "Every week on Thu at 09:00 (America/New_York)",
    nextOccurrences: [{ instant: "2026-08-13T13:00:00.000Z" }],
  });
  assert.equal(labels.repeats, "Repeats every week on Thu at 09:00 (America/New_York)");
  assert.match(labels.next, /^Next scheduled /);
  assert.match(labels.next, /Aug 13/);
  assert.match(clientSource, /repeat-resp-schedule-summary/);
});

test("manager separates cadence-based and as-needed responsibilities", async () => {
  for (const id of [
    "repeat-responsibilities-timed", "repeat-responsibilities-timed-count",
    "repeat-responsibilities-as-needed", "repeat-responsibilities-as-needed-count",
    "repeat-responsibilities-as-needed-list",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  assert.match(html, /Scheduled or cadence-based/);
  assert.match(html, /100 = due now/);

  const window = await clientWindow([]);
  const cadence = { id: "cadence", properties: { cadence: "weekly", importanceScore: 100 } };
  const scheduled = { id: "scheduled", properties: { repeatType: "scheduled", cadence: "as_needed", importanceScore: 0 } };
  const asNeeded = { id: "as-needed", properties: { cadence: "as_needed", importanceScore: 0 } };
  const groups = window.splitRepeatResponsibilityItems([cadence, scheduled, asNeeded]);
  assert.deepEqual(Array.from(groups.timed, (item) => item.id), ["cadence", "scheduled"]);
  assert.deepEqual(Array.from(groups.asNeeded, (item) => item.id), ["as-needed"]);
  assert.match(clientSource, /Number\(bp\.importanceScore\|\|0\)-Number\(ap\.importanceScore\|\|0\)/);
});

test("future responsibility scheduling forwards the selected date and parent start to every default subtask", () => {
  assert.match(clientSource,
    /addSubtask\(info\.localId,t,\{date:info\.dateStr,parentStart:info\.start\}\)/,
    "the picker callback must keep each child on the same day as its parent");
  assert.equal((clientSource.match(/addSubtask\(info\.localId,t,\{date:info\.dateStr,parentStart:info\.start\}\)/g)||[]).length, 2,
    "both scheduling and schedule-then-complete paths must preserve the parent placement");
});

test("future responsibility children wait for the parent write acknowledgement", async () => {
  let pickerOptions;
  let releaseParent;
  const parentPersisted = new Promise((resolve) => { releaseParent = resolve; });
  const children = [];
  const item = {
    id: "laundry",
    properties: {
      title: "Do Laundry",
      estimatedMinutes: 30,
      defaultSubtasks: ["Wash", "Dry", "Fold"],
    },
  };
  const window = await clientWindow([item], {
    openSchedulePicker(_title, _duration, options) { pickerOptions = options; },
    addSubtask(parentId, title, placement) { children.push({ parentId, title, placement }); },
  });

  window.scheduleRepeatResponsibility("laundry");
  assert.ok(pickerOptions && typeof pickerOptions.onScheduled === "function");
  const callback = pickerOptions.onScheduled({
    localId: "future-parent",
    dateStr: "2026-08-14",
    start: "08:00",
    persisted: parentPersisted,
  });
  await Promise.resolve();
  assert.equal(children.length, 0, "no child write begins while the parent create is pending");

  releaseParent();
  await callback;
  assert.deepEqual(children.map((child) => child.title), ["Wash", "Dry", "Fold"]);
  assert.ok(children.every((child) => child.parentId === "future-parent"));
  assert.ok(children.every((child) => child.placement.date === "2026-08-14"));
});
