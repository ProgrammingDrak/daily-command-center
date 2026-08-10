const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const start = stateSource.indexOf("function _findTaskBlockForDate(");
const end = stateSource.indexOf("async function _removeTaskBlockFromDate", start);
assert.ok(start >= 0 && end > start, "completion target resolver is present");
const resolverSource = stateSource.slice(start, end);

function resolve(blocks, id, date, ev) {
  const context = {
    window: {
      blockStore: {
        getByType(type) {
          return type === "block" ? blocks : [];
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(resolverSource, context);
  context.id = id;
  context.date = date;
  context.ev = ev;
  return vm.runInContext("_findTaskBlockForDate(id,date,ev)", context);
}

test("row-id-keyed meeting completion resolves its own row, not the first block on the day", () => {
  const date = "2026-08-10";
  const responsibility = {
    id: "responsibility-row", type: "block", date,
    properties: { kind: "responsibility_task", title: "Scaffold" },
  };
  const meeting = {
    id: "meeting-row", type: "block", date,
    properties: { type: "meeting", source: "calendar", title: "Kickoff" },
  };

  const found = resolve([responsibility, meeting], meeting.id, date, {
    id: meeting.id,
    _blockId: meeting.id,
    type: "meeting",
  });

  assert.equal(found.id, meeting.id);
});

test("API task keyed by row id does not collide with an unrelated same-day block", () => {
  const date = "2026-08-10";
  const unrelated = {
    id: "group-row", type: "block", date,
    properties: { kind: "task_group", title: "Template" },
  };
  const task = {
    id: "api-task-row", type: "block", date,
    properties: { kind: "task", title: "API task" },
  };

  const found = resolve([unrelated, task], task.id, date, {
    id: task.id,
    _blockId: task.id,
    type: "task",
  });

  assert.equal(found.id, task.id);
});

test("local-id-keyed task still resolves through local_id", () => {
  const date = "2026-08-10";
  const task = {
    id: "task-row", type: "block", date,
    properties: { local_id: "local-task", title: "Local task" },
  };

  assert.equal(resolve([task], "local-task", date, {
    id: "local-task",
    _blockId: task.id,
  }).id, task.id);
});
