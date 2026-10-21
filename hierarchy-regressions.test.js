const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const TM = require("./public/js/task-model");
const { installTaskModel } = require("./task-model-vm-fixture");
const { planParentChange } = require("./lib/task-hierarchy");
const { collectSubtreeBlockIds, findSubtreeRoots } = require("./lib/reschedule");
const source = (name) => fs.readFileSync(require.resolve("./public/js/" + name + ".js"), "utf8");
const fn = (name, file) => source(file).match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const pt = (s) => Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]);
const fmt = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const tree = (n, mixed = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: "n" + i,
    title: "Node " + i,
    type: "task",
    start: "09:00",
    end: i ? "09:00" : "09:30",
    notes: "note " + i,
    ...(i ? { [mixed && i % 2 ? "wrapId" : "subtaskOf"]: "n" + (i - 1) } : {})
  }));
const rowsOf = (tasks) =>
  tasks.map((e) => ({
    id: "row-" + e.id,
    type: "block",
    date: "2026-10-07",
    parent_id: TM.parentIdOf(e) ? "row-" + TM.parentIdOf(e) : null,
    properties: { ...e, local_id: e.id }
  }));
function browserContext(tasks) {
  const rows = rowsOf(tasks),
    writes = [];
  const c = {
    console,
    scheduled: tasks,
    INIT_SCHED: tasks.slice(),
    __state: { schedule: { blocks: [] } },
    viewMode: "planning",
    pt,
    fmt,
    dur: (e) => pt(e.end) - pt(e.start),
    isDone: (e) => !!e.done,
    isDeleted: (e) => !!e.deleted,
    isPushed: (e) => !!e.pushed,
    isNested: TM.isNested,
    parentIdOf: TM.parentIdOf,
    relOf: TM.relOf,
    childrenOf: TM.childrenOf,
    isWrap: (e) => !!e.isWrap,
    isMeeting: () => false,
    isFixed: () => false,
    userMovable: () => true,
    document: { querySelectorAll: () => [] },
    window: {
      blockStore: {
        getByType: () => rows,
        get: (id) => rows.find((r) => r.id === id),
        updateBlock: (id, p) => {
          rows.find((r) => r.id === id).properties = p;
          writes.push({ id, p });
        }
      }
    },
    loadPinnedStarts: () => ({}),
    savePinnedStarts() {},
    saveTaskOrder() {},
    syncAddedTaskTimes() {},
    render() {},
    log() {},
    showToast() {},
    manualDone: new Set(),
    doneAt: {}
  };
  tasks.forEach((e) => {
    e._blockId = "row-" + e.id;
  });
  vm.createContext(c);
  installTaskModel(c);
  vm.runInContext(source("drag"), c);
  vm.runInContext(fn("reparentAsSubtask", "tabs"), c);
  return { c, rows, writes };
}
test("20,000 mixed levels render, collapse and reload without missing a node", () => {
  const tasks = tree(20000, true),
    projected = rowsOf(tasks).map((r) => TM.fromBlock(r));
  const nodes = TM.selectTree(projected, { pool: projected });
  assert.equal(nodes.length, tasks.length);
  assert.equal(nodes.at(-1).depth, 19999);
  assert.equal(new Set(nodes.map((n) => n.ev.id)).size, tasks.length);
  assert.equal(nodes.at(-1).ev.notes, "note 19999");
  assert.equal(TM.selectTree(projected, { pool: projected, isCollapsed: (id) => id === "n40" }).length, 41);
  assert.equal(TM.descendantsOf("n0", projected).length, 19999);
  assert.equal(TM.isAncestor("n0", "n19999", projected), true);
});
test("cyclic legacy data renders each reachable node once and does not count a root as a descendant", () => {
  const tasks = tree(1000, true);
  tasks[0].wrapId = "n999";
  const nodes = TM.selectTree(tasks, { pool: tasks });
  assert.equal(nodes.length, 1000);
  assert.equal(new Set(nodes.map((n) => n.ev.id)).size, 1000);
  assert.equal(TM.descendantsOf("n0", tasks).length, 999);
});
test("progress and optimistic completion cover 12,000 levels with exact rollback", () => {
  const tasks = tree(12000);
  tasks[60].done = true;
  const { c } = browserContext(tasks);
  c.manualDone.add("n60");
  c.doneAt.n60 = "already";
  c.isDone = (e) => c.manualDone.has(e.id);
  vm.runInContext(fn("subtaskProgress", "state"), c);
  assert.deepEqual(JSON.parse(JSON.stringify(c.subtaskProgress("n0", tasks))), { done: 1, total: 11999 });
  vm.runInContext(
    fn("_optimisticallyCompleteSubtasks", "schedule") + "\n" + fn("_rollbackOptimisticSubtasks", "schedule"),
    c
  );
  const changed = c._optimisticallyCompleteSubtasks("n0", "2026-10-07T12:00:00Z");
  assert.equal(changed.length, 11998);
  assert.equal(c.manualDone.size, 11999);
  c._rollbackOptimisticSubtasks(changed);
  assert.deepEqual([...c.manualDone], ["n60"]);
  assert.equal(c.doneAt.n60, "already");
});
test("drag a wrap into a nested subtask; IDs, descendant edges, notes and reload survive", () => {
  const tasks = tree(80, true);
  tasks.push(
    { id: "parent", title: "Parent", type: "task", start: "10:00", end: "10:30" },
    { id: "parent-step", title: "Parent step", type: "task", subtaskOf: "parent", start: "10:00", end: "10:00" }
  );
  tasks[0].isWrap = true;
  const { c, rows } = browserContext(tasks),
    row = { getBoundingClientRect: () => ({ top: 0, height: 100 }), classList: { remove() {}, add() {}, toggle() {} } };
  c.dStart({ dataTransfer: { setData() {} }, target: { closest: () => null }, clientX: 300 }, "n0");
  c.dDrop({ preventDefault() {}, shiftKey: true, clientX: 300, clientY: 50, currentTarget: row }, "parent-step");
  assert.equal(tasks.find((e) => e.id === "n0").subtaskOf, "parent-step");
  const reload = rows.map((r) => TM.fromBlock(r)),
    nodes = TM.selectTree(reload, { pool: reload });
  assert.equal(nodes.length, 82);
  assert.equal(nodes.find((n) => n.ev.id === "n79").depth, 81);
  for (let i = 1; i < 80; i++) {
    const ev = reload.find((e) => e.id === "n" + i);
    assert.equal(TM.parentIdOf(ev), "n" + (i - 1));
    assert.equal(ev.notes, "note " + i);
  }
  assert.equal(rows.find((r) => r.id === "row-n0").properties.duration, 0);
});
test("explicit reparent, promote and reflow carry a 200-level mixed subtree", () => {
  const tasks = tree(200, true);
  tasks.push({ id: "target", title: "Target", type: "task", start: "11:00", end: "11:30", _userSetStart: true });
  const { c, rows } = browserContext(tasks);
  assert.equal(c.reparentAsSubtask("n0", "target"), true);
  assert.equal(tasks.find((e) => e.id === "n199").start, "11:00");
  assert.equal(c.reparentAsSubtask("target", "n199"), false, "cycle is rejected beyond the old 50-level guard");
  c.promoteToTopLevel("n0");
  const root = tasks.find((e) => e.id === "n0"),
    leaf = tasks.find((e) => e.id === "n199");
  assert.equal(TM.parentIdOf(root), null);
  assert.equal(root.start, leaf.start);
  assert.equal(rows.find((r) => r.id === "row-n0").properties.duration, 30);
  assert.equal(TM.descendantsOf("n0", tasks).length, 199);
});
test("both edges reparent at depth 100 and preserve untimed state across reload", () => {
  for (const childEdge of ["subtask", "wrap"]) {
    const tasks = tree(101);
    tasks.forEach((e) => (e.untimed = true));
    tasks.push({ id: "child", title: "Child", type: "task", start: "09:00", end: "09:30", untimed: true });
    const { c, rows } = browserContext(tasks);
    assert.equal(c.reparentAsSubtask("child", "n100", { childEdge }), true);
    const row = rows.find((r) => r.id === "row-child"),
      ev = TM.fromBlock(row);
    assert.equal(TM.parentIdOf(ev), "n100");
    assert.equal(ev.untimed, true);
    assert.equal(row.properties.start, null);
    assert.equal(row.properties.duration, childEdge === "subtask" ? 0 : 30);
  }
});
test("capture and materialize 2,000 levels without recursion or dropped children", () => {
  const tasks = tree(2000, true),
    { c } = browserContext(tasks);
  vm.runInContext(fn("captureShellTemplate", "state"), c);
  const template = c.captureShellTemplate("n0", tasks);
  let node = template.root,
    n = 0;
  while (node) {
    n++;
    node = node.children[0];
  }
  assert.equal(n, 2000);
  const made = [];
  c.addSubtask = (pid, title, opts) => {
    const id = "copy" + made.length;
    made.push({ id, pid, title, opts });
    return { id };
  };
  c.addStackedTask = c.addSubtask;
  vm.runInContext(fn("attachTemplateChildren", "schedule"), c);
  c.attachTemplateChildren("copy-root", template.root.children);
  assert.equal(made.length, 1999);
  assert.equal(made.at(-1).pid, "copy1997");
});
test("database parent planning rejects cycles and synchronizes both aliases at arbitrary depth", () => {
  const rows = rowsOf(tree(1000, true)),
    leaf = rows.at(-1),
    root = rows[0];
  assert.throws(
    () =>
      planParentChange(root, { ...root.properties, subtaskOf: leaf.properties.local_id }, undefined, rows, root.date),
    /cycle/
  );
  assert.throws(
    () => planParentChange(leaf, { ...leaf.properties, wrapId: leaf.id, subtaskOf: null }, undefined, rows, leaf.date),
    /own parent/
  );
  const target = { id: "target", type: "block", date: root.date, properties: { local_id: "target-local" } };
  rows.push(target);
  const plan = planParentChange(
    leaf,
    { ...leaf.properties, wrapId: null, subtaskOf: "target-local" },
    undefined,
    rows,
    leaf.date
  );
  assert.equal(plan.parentId, "target");
  assert.equal(plan.properties.rel, "subtask");
  assert.equal(plan.properties.notes, "note 999");
  const promote = planParentChange(leaf, { ...plan.properties, subtaskOf: null }, undefined, rows, leaf.date);
  assert.equal(promote.parentId, null);
  assert.throws(
    () =>
      planParentChange(leaf, { ...leaf.properties, wrapId: null, subtaskOf: "target" }, undefined, rows, "2026-10-08"),
    /same task pool/
  );
});
test("subtree moves include row-ID edges, respect canonical reparenting and keep deep descendants", () => {
  const rows = rowsOf(tree(2000, true));
  rows[1].properties.wrapId = rows[0].id;
  rows[1].parent_id = null;
  assert.equal(collectSubtreeBlockIds(rows, rows[0]).length, 2000);
  const other = { id: "other", type: "block", properties: { local_id: "other" } };
  rows.push(other);
  rows[1].properties.wrapId = "other";
  rows[1].parent_id = rows[0].id;
  assert.deepEqual(collectSubtreeBlockIds(rows, rows[0]), [rows[0].id]);
  assert.equal(collectSubtreeBlockIds(rows, other).length, 2000);
  assert.ok(findSubtreeRoots(rows).includes(rows[0]));
});

test("public shared-view rendering is also iterative at 20,000 levels", () => {
  const guest = source("public-todo-share").match(/function guestTree\(tasks\)\{[\s\S]*?\n {2}\}/)[0];
  const build = new Function(guest + ";return guestTree;")();
  const tasks = tree(20000, true),
    nodes = build(tasks);
  assert.equal(nodes.length, 20000);
  assert.equal(nodes.at(-1).depth, 19999);
  tasks[0].subtaskOf = "n19999";
  assert.equal(build(tasks).length, 20000);
});
