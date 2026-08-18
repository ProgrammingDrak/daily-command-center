const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, file), "utf8");

test("the backlog surface is replaced by the Task Library shell", () => {
  const html = read("index.html");
  assert.match(html, /id="tm-task-library-section"/);
  assert.match(html, /id="task-library-root"/);
  assert.match(html, /public\/css\/task-library\.css/);
  assert.match(html, /public\/js\/task-library\.js/);
  assert.match(html, /Task Library \(Solo\)/);
});

test("the Task Library exposes project, filter, grouping, import, and itinerary actions", () => {
  const script = read("public/js/task-library.js");
  for (const contract of [
    "tlb-project-strip",
    "tlb-add-filter",
    "tlb-group",
    "tlb-manage-facets",
    "tlb-import",
    "tlb-save-view",
    "data-schedule-task",
    "tlb-continue",
    "openSchedulePopover",
    "rescheduleBlock",
  ]) assert.ok(script.includes(contract), `missing ${contract}`);
});

test("the library table has responsive full-screen behavior", () => {
  const css = read("public/css/task-library.css");
  assert.match(css, /#tasks-drawer\.solo\[data-solo-section="tm-task-library-section"\]/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.tlb-table-scroll/);
});
