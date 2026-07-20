// Contract test for captureShellTemplate() in public/js/state.js: capturing a
// live shell's subtree produces the reusable templateTree (ordered children,
// per-node duration/priority/type/edge) that a repeat responsibility replays.
// Slices the one function out of state.js and runs it in a vm with stubbed tree
// helpers (same string-surgery spirit as recalc-times.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const captureSrc = stateSource.match(/function captureShellTemplate[\s\S]*?\n}/)[0];

function makeCtx() {
  const context = {
    console,
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    relOf: (ev) => (ev && ev.wrapId ? "ride-along" : (ev && ev.subtaskOf ? "subtask" : null)),
    childrenOf: (id, pool) => (pool || []).filter((c) => (c.wrapId || c.subtaskOf) === id),
    isDeleted: (ev) => !!ev.deleted,
  };
  context.dur = (ev) => context.pt(ev.end) - context.pt(ev.start);
  vm.createContext(context);
  vm.runInContext(captureSrc, context);
  return context;
}

test("captureShellTemplate: root has no duration; children keep order, duration, edge", () => {
  const pool = [
    { id: "sh", title: "Morning ops", type: "shell", start: "09:00", end: "10:05", priority: "High", isWrap: true },
    { id: "r1", title: "Triage inbox", type: "task", start: "09:00", end: "09:20", priority: "High", wrapId: "sh" },
    { id: "r2", title: "Standup", type: "task", start: "09:20", end: "09:35", priority: "Medium", wrapId: "sh" },
    { id: "sub", title: "note", type: "task", start: "09:00", end: "09:00", subtaskOf: "sh" },
    { id: "other", title: "elsewhere", type: "task", start: "11:00", end: "11:30" },
  ];
  const ctx = makeCtx();
  const tpl = ctx.captureShellTemplate("sh", pool);
  assert.equal(tpl.version, 1);
  assert.equal(tpl.root.type, "shell");
  assert.equal(tpl.root.title, "Morning ops");
  assert.ok(!("durationMin" in tpl.root)); // shell derives its length from children
  assert.equal(tpl.root.children.length, 3); // two ride-alongs + one subtask, not "other"
  assert.equal(tpl.root.children[0].title, "Triage inbox");
  assert.equal(tpl.root.children[0].edge, "wrap");
  assert.equal(tpl.root.children[0].durationMin, 20);
  assert.equal(tpl.root.children[1].durationMin, 15);
  assert.equal(tpl.root.children[2].edge, "subtask");
});

test("captureShellTemplate: skips deleted children and survives a cycle", () => {
  const pool = [
    { id: "sh", title: "Sh", type: "shell", start: "09:00", end: "09:20", wrapId: "sh" /* self-cycle */ },
    { id: "a", title: "a", type: "task", start: "09:00", end: "09:20", wrapId: "sh" },
    { id: "d", title: "gone", type: "task", start: "09:00", end: "09:10", wrapId: "sh", deleted: true },
  ];
  const ctx = makeCtx();
  const tpl = ctx.captureShellTemplate("sh", pool);
  const titles = tpl.root.children.map((c) => c.title);
  assert.ok(titles.includes("a"));
  assert.ok(!titles.includes("gone")); // deleted excluded
});
