const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const scheduleTab = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const index = fs.readFileSync(require.resolve("./index.html"), "utf8");
const css = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");
const slice = (name) => {
  const match = scheduleTab.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"));
  if (!match) throw new Error("Could not find " + name);
  return match[0];
};

function pt(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function contextFor(names) {
  const context = { Date, Number, Math, String, pt };
  vm.createContext(context);
  vm.runInContext(names.map(slice).join("\n"), context);
  return context;
}

test("progress range uses working hours and expands for early or late work", () => {
  const context = contextFor(["_progressRange"]);
  context.items = [
    { start: "06:30", end: "07:00" },
    { start: "17:15", end: "18:00" },
  ];
  context.state = { schedule: { working_hours: { start: "07:00", end: "17:30" } } };
  const result = JSON.parse(vm.runInContext("JSON.stringify(_progressRange(items,state))", context));
  assert.deepEqual(result, { start: 390, end: 1080, total: 690 });
});

test("current-time line lands at the correct point on today's axis", () => {
  const context = contextFor(["_progressLocalDateKey", "_progressNowPercent"]);
  context.now = new Date(2026, 8, 3, 12, 15);
  assert.equal(vm.runInContext('_progressNowPercent("2026-09-03",now,420,1050)', context), 50);
  assert.equal(vm.runInContext('_progressNowPercent("2026-09-02",now,420,1050)', context), null);
  context.afterHours = new Date(2026, 8, 3, 20, 0);
  assert.equal(vm.runInContext('_progressNowPercent("2026-09-03",afterHours,420,1050)', context), null);
});

test("retired stat strip is gone and the progress bar exposes its useful controls", () => {
  assert.doesNotMatch(index, /class="stats"|id="stat-popover"|id="s-(?:time|tasks|done|points)"/);
  for (const id of ["pstart", "pend", "pnow", "ptrack"]) assert.match(index, new RegExp('id="' + id + '"'));
  assert.match(scheduleTab, /openAddModal\(ev\.id,ev\.title\)/);
  assert.match(css, /\.progress-now\{[^}]*background:#0075eb/);
});

test("a task segment opens that task's details modal", () => {
  let opened = null;
  const children = [];
  const context = {
    f12: (value) => value,
    ms: (value) => value + "m",
    openAddModal: (id, title) => { opened = { id, title }; },
    document: {
      createElement: (tagName) => ({
        tagName,
        style: {},
        listeners: {},
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(slice("addPS"), context);
  context.track = { appendChild: (node) => children.push(node) };
  context.task = { id: "task-1", title: "Focus block", start: "09:00", end: "10:00" };
  vm.runInContext('addPS(track,540,600,"Focus block","#60a5fa",false,600,task)', context);
  assert.equal(children[0].tagName, "button");
  children[0].listeners.click();
  assert.deepEqual(opened, { id: "task-1", title: "Focus block" });
});
