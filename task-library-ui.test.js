const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createProjectStore} = require("./project-store");

const read = file => fs.readFileSync(path.join(__dirname, file), "utf8");

test("All Tasks and Someday open the shared task queue instead of the library table", () => {
  const html = read("index.html");
  const drawer = read("public/js/side-drawers.js");
  const script = read("public/js/task-library.js");
  for (const pill of ["all-tasks", "someday"]) {
    assert.match(html, new RegExp('id="' + pill + '-pill-nav"[^>]*aria-controls="tasks-drawer"'));
  }
  assert.match(html, /id="task-collection-root"/);
  assert.doesNotMatch(html, /id="tm-task-library-section"/);
  assert.match(drawer, /window.DCCTaskLibrary.show\(kind\)/);
  assert.match(script, /renderItineraryListRow/);
});

test("the collection recognizes itinerary completion for the matching date and workspace", async () => {
  const first = {id:"a", type:"block", date:"2026-11-04", properties:{local_id:"shared", title:"Finished", status:"open"}};
  const second = {...first, id:"b", date:"2026-11-05", properties:{...first.properties, title:"Still open"}};
  const day = {date:first.date, completion:{ids:["shared"]}};
  const store = createProjectStore({
    pool:{query:async (sql, params) => {
      assert.equal(params[0], "ws-1");
      return {rows:sql.includes("projectOrder") ? [first,second] : sql.includes("AS completion") ? [day] : []};
    }},
    blockDB:{parseBlock:row=>row,getDelegatedItems:async () => []},
  });
  const library = await store.listLibrary("ws-1");
  assert.deepEqual(library.tasks.map(task => task.id), ["a","b"]);
  assert.deepEqual(library.completedTaskIds, ["a"]);
  assert.equal(first.properties.status, "open");
});
