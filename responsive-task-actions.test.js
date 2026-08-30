const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const itinerarySource = fs.readFileSync(require.resolve("./public/js/itinerary-card.js"), "utf8");
const cssSource = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");

function radialLabels(meeting) {
  const start = scheduleSource.indexOf("function openTaskNotes");
  const end = scheduleSource.indexOf("// Sub-fan:", start);
  const context = {
    isMeeting: () => meeting,
    now: () => 0,
    pt: () => 1,
    dur: () => 30,
    openAddModal() {},
    openDeleteConfirm() {},
  };
  vm.createContext(context);
  vm.runInContext(scheduleSource.slice(start, end), context);
  return Array.from(context.buildTaskRadialItems({ id: "task-1", title: "Task" }, {}), item => item.label);
}

test("compact task radial omits duplicate completion", () => {
  const labels = radialLabels(false);
  assert.ok(!labels.includes("Complete without notes"));
  assert.ok(labels.includes("Notes & actions"));
  assert.ok(labels.includes("Delete task"));
});

test("compact meeting radial omits duplicate completion", () => {
  const labels = radialLabels(true);
  assert.ok(!labels.includes("Complete without notes"));
  assert.ok(labels.includes("Notes & actions"));
  assert.ok(labels.includes("Delete task"));
});

test("timeline meetings render the same radial action trigger as tasks", () => {
  assert.match(itinerarySource, /Radial on every row now, meetings included/);
  assert.match(itinerarySource, /aria-label="'\+\(isMeeting\(ev\)\?'Meeting prep and actions':'Task actions'\)/);
});

test("compact card mode responds to container width", () => {
  const start = cssSource.indexOf("/* A card can be narrow inside a split pane");
  const end = cssSource.indexOf("/* Touch devices", start);
  const compactCards = cssSource.slice(start, end);
  assert.match(compactCards, /@container \(max-width:760px\)/);
  assert.match(compactCards, /\.card \.btn-task-radial\{display:inline-flex !important/);
  assert.match(compactCards, /\.card \.btn-del-task\{display:inline-flex !important/);
});

test("narrow list rows keep actions and delete visible", () => {
  const start = cssSource.indexOf("/* Narrow app panes and phone-sized windows");
  const end = cssSource.indexOf("/* A card can be narrow inside a split pane", start);
  const responsiveRows = cssSource.slice(start, end);
  assert.match(responsiveRows, /grid-template-columns:repeat\(2,38px\)/);
  assert.match(responsiveRows, /\.it-list-actions \.btn-task-radial\{display:inline-flex !important/);
  assert.match(responsiveRows, /\.it-list-actions \.btn-del-task\{display:inline-flex !important/);
});
