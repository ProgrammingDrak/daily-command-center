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
    dur: () => 30,
    openAddModal() {},
    openDeleteConfirm() {},
  };
  vm.createContext(context);
  vm.runInContext(scheduleSource.slice(start, end), context);
  return Array.from(context.buildTaskRadialItems({ id: "task-1", title: "Task" }, {}), item => item.label);
}

test("compact task radial keeps notes and delete reachable", () => {
  const labels = radialLabels(false);
  assert.ok(labels.includes("Notes & actions"));
  assert.ok(labels.includes("Delete task"));
});

test("compact meeting radial keeps notes and delete reachable", () => {
  const labels = radialLabels(true);
  assert.ok(labels.includes("Notes & actions"));
  assert.ok(labels.includes("Delete task"));
});

test("timeline meetings render a compact-only radial trigger", () => {
  assert.match(itinerarySource, /btn-task-radial'\+\(isMeeting\(ev\)\?' btn-meeting-radial'/);
  assert.match(cssSource, /\.btn-meeting-radial\{display:none\}/);
});

test("card compact mode responds to container width, not only viewport width", () => {
  assert.match(cssSource, /@container \(max-width:760px\)[\s\S]*?\.card \.btn-task-radial\{display:inline-flex !important/);
});

test("narrow desktop list rows retain notes and delete as visible buttons", () => {
  const start = cssSource.indexOf("/* Responsive rows keep");
  const end = cssSource.indexOf("/* Touch devices", start);
  const responsiveRows = cssSource.slice(start, end);
  assert.match(responsiveRows, /\.it-list-actions \.notes-btn\{display:inline-flex !important/);
  assert.match(responsiveRows, /\.it-list-actions \.btn-del-task\{display:inline-flex !important/);
  assert.match(responsiveRows, /grid-template-columns:repeat\(2,38px\)/);
});

test("narrow timeline cards retain notes and delete in the container layout", () => {
  const start = cssSource.indexOf("/* Responsive rows keep");
  const end = cssSource.indexOf("/* Touch devices", start);
  const narrowContainer = cssSource.slice(start, end);
  assert.match(narrowContainer, /\.card \.notes-btn\{display:inline-flex !important/);
  assert.match(narrowContainer, /\.card \.btn-del-task\{display:inline-flex !important/);
});
