// Contract tests for the shell-template materializer glue in public/js/schedule.js:
// attachTemplateChildren (edge routing + recursion) and _shellAlreadyOnDay (the
// idempotency guard materializeShellTemplate relies on). Slices the two functions
// out of schedule.js and runs them in a vm with stubbed primitives (same
// string-surgery spirit as recalc-times.test.js / shell-template-capture.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const attachSrc = src.match(/function attachTemplateChildren[\s\S]*?\n}/)[0];
const dedupeSrc = src.match(/function _shellAlreadyOnDay[\s\S]*?\n}/)[0];

test("attachTemplateChildren: routes wrap->addStackedTask, subtask->addSubtask, and recurses", () => {
  const calls = [];
  let seq = 0;
  const context = {
    console,
    addStackedTask: (parentId, title, dur, opts) => { calls.push({ fn: "stacked", parentId, title, dur, opts }); return { id: "sk-" + (++seq) }; },
    addSubtask: (parentId, title) => { calls.push({ fn: "subtask", parentId, title }); return { id: "st-" + (++seq) }; },
  };
  vm.createContext(context);
  vm.runInContext(attachSrc, context);

  context.attachTemplateChildren("root-1", [
    { title: "Ride A", edge: "wrap", durationMin: 20, priority: "High", detail: "d" },
    { title: "Step B", edge: "subtask", children: [
      { title: "Nested ride", edge: "wrap", durationMin: 10 },
    ] },
  ]);

  // Top-level wrap child -> addStackedTask with its duration + opts.
  const rideA = calls.find(c => c.title === "Ride A");
  assert.equal(rideA.fn, "stacked");
  assert.equal(rideA.parentId, "root-1");
  assert.equal(rideA.dur, 20);
  assert.equal(rideA.opts.priority, "High");
  assert.equal(rideA.opts.detail, "d");
  // Subtask child -> addSubtask.
  const stepB = calls.find(c => c.title === "Step B");
  assert.equal(stepB.fn, "subtask");
  assert.equal(stepB.parentId, "root-1");
  // Recursion: the nested ride attaches under the created subtask's id, not the root.
  const nested = calls.find(c => c.title === "Nested ride");
  assert.equal(nested.fn, "stacked");
  assert.equal(nested.parentId, stepB && ("st-" + 2)); // Step B was the 2nd created node
  assert.equal(nested.dur, 10);
});

test("attachTemplateChildren: ignores empty/invalid nodes and non-arrays", () => {
  const calls = [];
  const context = { console, addStackedTask: (p, t) => { calls.push(t); return { id: "x" }; }, addSubtask: () => ({ id: "y" }) };
  vm.createContext(context);
  vm.runInContext(attachSrc, context);
  context.attachTemplateChildren("root", [null, { title: "" }, { edge: "wrap" }, { title: "Real", edge: "wrap", durationMin: 5 }]);
  assert.deepEqual(calls, ["Real"]); // only the node with a title
  // non-array is a no-op (no throw)
  context.attachTemplateChildren("root", undefined);
});

test("_shellAlreadyOnDay: true only when a live rollup with that responsibilityId is on the day", () => {
  const rollupIds = new Set(["sh"]);
  const context = {
    console,
    isDeleted: (e) => !!e.deleted,
    window: { TaskTypes: { isRollup: (e) => rollupIds.has(e.id) } },
  };
  context.scheduled = [
    { id: "sh", responsibilityId: "r1", type: "shell" },
    { id: "t1", responsibilityId: "r2", type: "task" }, // linked but not a rollup
  ];
  vm.createContext(context);
  vm.runInContext(dedupeSrc, context);

  assert.equal(context._shellAlreadyOnDay("r1"), true);  // live shell for r1
  assert.equal(context._shellAlreadyOnDay("r2"), false); // r2's block isn't a rollup
  assert.equal(context._shellAlreadyOnDay("r3"), false); // nothing for r3
  assert.equal(context._shellAlreadyOnDay(""), false);   // no id

  // A deleted shell no longer counts (so a re-drop is allowed).
  context.scheduled[0].deleted = true;
  assert.equal(context._shellAlreadyOnDay("r1"), false);
});
