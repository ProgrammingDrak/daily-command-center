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
    window: {},
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

test("compact task radial contains contextual actions only", () => {
  const labels = radialLabels(false);
  assert.ok(!labels.includes("Complete without notes"));
  assert.deepEqual(labels, ["Subtask…", "Unscheduled", "Convert…", "Delegate / block", "Blocked by task", "Repeat", "Solo", "Whenever", "Lock"]);
  assert.ok(!labels.includes("Back"));
});

test("compact meeting radial keeps Prep without duplicate task-bar actions", () => {
  const labels = radialLabels(true);
  assert.ok(!labels.includes("Complete without notes"));
  assert.deepEqual(labels, ["Prep"]);
});

test("Change task retains delegation and dependencies with the correct identities", () => {
  const calls=[];
  const context={window:{openTaskDependencyModal:id=>calls.push(["dependency",id])},scheduled:[],childrenOf:()=>[],convertTaskToDelegated:id=>calls.push(["delegate",id])};
  vm.createContext(context);
  vm.runInContext(scheduleSource.slice(scheduleSource.indexOf("function buildTaskChangeItems"),scheduleSource.indexOf("// Sub-fan: convert")),context);
  const items=context.buildTaskChangeItems({id:"local-task",_blockId:"stored-block",untimed:true},{});
  items.find(item=>item.label==="Delegate / block").onPick();
  items.find(item=>item.label==="Blocked by task").onPick();
  assert.deepEqual(calls,[["delegate","local-task"],["dependency","stored-block"]]);
  assert.ok(!items.some(item=>/Delete|Notes|Duration|Start work|Add task/.test(item.label)));
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
