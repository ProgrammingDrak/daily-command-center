// TEST HELPER: install the REAL TaskModel into a node:vm context (C6a).
// Named `-fixture` to match carryover-fixture.js, the repo root's one existing test-only
// module, so it is not mistaken for a production one.
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

// state.js's accessor, which its five bare tree globals and several other functions call.
// Six harnesses slice state.js regions that reach it, so it is installed here too -- SLICED
// FROM state.js rather than retyped, so a change to how state.js reaches the layer cannot
// leave the harnesses resolving it a different way.
const STATE_SRC = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const TM_ACCESSOR = (() => {
  const m = STATE_SRC.match(/function _TM\(\)\{[^\n]*\}/);
  if (!m) throw new Error("task-model-vm-fixture: could not slice `_TM` out of state.js");
  return m[0];
})();

function installTaskModel(ctx) {
  vm.runInContext(TASK_MODEL_SRC, ctx);
  if (!ctx.DCC || !ctx.DCC.TaskModel) throw new Error("installTaskModel: TaskModel did not attach to the context");
  // Only define _TM if the harness has not already sliced or stubbed one.
  if (typeof ctx._TM !== "function") vm.runInContext(TM_ACCESSOR, ctx);
  return ctx.DCC.TaskModel;
}

module.exports = { installTaskModel, TASK_MODEL_SRC, TM_ACCESSOR };
