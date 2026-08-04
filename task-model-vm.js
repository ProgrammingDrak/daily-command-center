// Test helper: install the REAL TaskModel into a node:vm context (C6a).
//
// Most of the browser-side harnesses in this repo slice a region of state.js /
// drag.js / schedule.js into a vm context and hand it stubbed globals. Those files
// now route every set-derivation through `DCC.TaskModel`, so the context needs one.
//
// It must be the REAL module, running INSIDE the context, and both halves matter:
//
//   • real, not a stub — C5b's most expensive lesson was four harness fakes that
//     were gentler than production (a resolver missing its last clause, an options
//     fake gating on truthiness where production gates on `!== undefined`). A
//     hand-written `selectOpen` in a harness would be a different program, and the
//     partition invariants would be asserted against the harness, not the code.
//   • inside the context, not `require()`d — TaskModel resolves `isDone` /
//     `isDeleted` / `loadTrivialFlags` off the enclosing scope, and a require()d
//     copy sees node's globals, never the context's stubs. Run it in the context
//     and `typeof isDone === "function"` finds the harness's resolver.
//
// Call after vm.createContext(ctx). The stubs it reads are resolved lazily at
// selector-call time, so they can be assigned before or after this.
const fs = require("node:fs");
const vm = require("node:vm");

const TASK_MODEL_SRC = fs.readFileSync(require.resolve("./public/js/task-model.js"), "utf8");

function installTaskModel(ctx) {
  vm.runInContext(TASK_MODEL_SRC, ctx);
  if (!ctx.DCC || !ctx.DCC.TaskModel) throw new Error("installTaskModel: TaskModel did not attach to the context");
  return ctx.DCC.TaskModel;
}

module.exports = { installTaskModel, TASK_MODEL_SRC };
