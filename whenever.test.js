// Tests for the Whenever lane (public/js/whenever.js): chores with no set time that
// live in a header pill's pool until you pull one into your day.
//
// What these pin, in order of how badly each would hurt:
//   1. Do it now AWAITS the date write before placing. The placement pins the start
//      through savePinnedStarts, which only writes rows already on the viewed day, so
//      placing first leaves the end-of-day slot stored and the task jumps back there
//      on reload. In the browser this looked right until the reload, which is exactly
//      the kind of bug a page check misses
//   2. a row added this session resolves its block id before scheduling; without it
//      addToSchedule CREATES a dated copy and the original returns to the pool
//   3. Done is Do it now + the normal toggleDone, not a Whenever-only completion
//   4. "x" writes through persistRowProp against the row, and Undo restores the stage
//   5. the pool reads the stored stage from task-model.js, beside the fold rule
// Harness: the real file in a node:vm context with stubbed page globals, the same
// raw-source pattern itinerary-fold.test.js and launcher-urgent-menu.test.js use.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const W = require("./public/js/whenever.js");
const TaskModel = require("./public/js/task-model.js");
const source = fs.readFileSync(require.resolve("./public/js/whenever.js"), "utf8");

const TODAY = "2026-10-05";

// ── pure half ──

test("the stored stage comes from task-model.js, where the fold rule lives", () => {
  assert.equal(W.STAGE, TaskModel.WHENEVER_STAGE);
  assert.equal(W.STAGE, "Whenever");
  assert.ok(["sage", "teal", "amber", "violet"].includes(W.PILL_STYLE), "PILL_STYLE must be a value dashboard.css defines");
  const css = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");
  assert.match(css, new RegExp("\\.whenever-theme--" + W.PILL_STYLE + "\\{"));
});

test("the pool is the Whenever stage only, quick wins first, then oldest first", () => {
  const items = [
    { id: "a", stage: "Whenever", title: "Laundry", durMin: 30, createdAt: "2026-10-01T10:00:00Z" },
    { id: "b", stage: "Backlog", title: "Solo task", durMin: 5 },
    { id: "c", stage: "Whenever", title: "Mail", durMin: 5, createdAt: "2026-10-03T10:00:00Z" },
    { id: "d", stage: "Whenever", title: "Plants", durMin: 15, createdAt: "2026-10-04T10:00:00Z" },
    { id: "e", stage: "Whenever", title: "Dishes", durMin: 15, createdAt: "2026-10-02T10:00:00Z" },
    { id: "f", stage: "Priority", title: "Hot", durMin: 5 },
  ];
  assert.deepEqual(W.selectWhenever(items).map(t => t.id), ["c", "e", "d", "a"]);
  assert.deepEqual(items.map(t => t.id), ["a", "b", "c", "d", "e", "f"], "selection must not reorder the caller's array");
  assert.deepEqual(W.selectWhenever(null), []);
});

test("Surprise me never repeats the last pick when there is a choice", () => {
  assert.equal(W.pickIndex(0, -1, () => 0.5), -1);
  assert.equal(W.pickIndex(1, 0, () => 0.9), 0);
  for (let last = 0; last < 4; last++) {
    for (const r of [0, 0.24, 0.5, 0.99]) {
      const i = W.pickIndex(4, last, () => r);
      assert.ok(i >= 0 && i < 4);
      assert.notEqual(i, last, "rand " + r + " repeated index " + last);
    }
  }
});

// ── browser half, against stubbed page globals ──

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function makePage(opts) {
  opts = opts || {};
  const log = [];
  const rows = [
    { id: "row-laundry", date: null, type: "block", properties: { kind: "backlog", local_id: "wh-laundry", stage: "Whenever", title: "Laundry" } },
  ];
  const ctx = {
    console, Promise, setTimeout,
    window: { blockStore: { getByType: type => (type === "block" ? rows : []) } },
    backlog: [{ id: "wh-laundry", title: "Laundry", stage: "Whenever", durMin: 15 }],
    scheduled: [],
    viewDate: opts.viewDate || TODAY,
    _resolvedTodayDate: () => TODAY,
    f12: hhmm => hhmm,
    showToast: (msg, type, dur, action) => log.push(["toast", msg, action && action.label]),
    render: () => {},
    switchToDate: async date => { log.push(["switch", date]); ctx.viewDate = date; },
    addToSchedule: id => {
      const item = ctx.backlog.find(t => t.id === id);
      log.push(["addToSchedule", id, item && item._blockId]);
      ctx.scheduled.push({ id, title: item.title, start: "17:00" });
      return opts.write ? opts.write.promise.then(() => log.push(["write landed"])) : undefined;
    },
    rescheduleTaskToDate: async (id, date, o) => {
      log.push(["place", id, date, !!(o && o.silent)]);
      ctx.scheduled.find(e => e.id === id).start = "13:15";
      return ctx.scheduled.find(e => e.id === id);
    },
    toggleDone: id => log.push(["toggleDone", id]),
    persistRowProp: (id, key, value, ev, o) => { log.push(["persistRowProp", id, key, value, o && o.row && o.row.id]); return Promise.resolve(); },
    refoldTaskStateFromBlockCache: () => log.push(["refold"]),
  };
  vm.createContext(ctx);
  vm.runInContext(opts.source || source, ctx);
  return { ctx, log, api: ctx.DCC.Whenever };
}

test("Do it now waits for the date write to land before it places and pins", async () => {
  const run = async (src) => {
    const write = deferred();
    const page = makePage({ write, source: src });
    const done = page.api.doNow("wh-laundry");
    // Let every microtask that does not depend on the write run.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const placedEarly = page.log.some(e => e[0] === "place");
    write.resolve();
    await done;
    return { page, placedEarly };
  };
  const ok = await run();
  assert.equal(ok.placedEarly, false, "placement ran before the row was on today");
  const order = ok.page.log.map(e => e[0]).filter(k => k !== "toast");
  assert.deepEqual(order, ["addToSchedule", "write landed", "place"]);
  assert.deepEqual(ok.page.log.find(e => e[0] === "place"), ["place", "wh-laundry", TODAY, true]);
  assert.deepEqual(ok.page.log.find(e => e[0] === "toast"), ["toast", "Up next: Laundry at 13:15", undefined]);

  // Guard the guard: without the await, the placement races the write and this fails.
  const mutated = source.replace("await Promise.resolve(addToSchedule(item.id));", "addToSchedule(item.id);");
  assert.notEqual(mutated, source, "mutation target moved");
  const broken = await run(mutated);
  assert.equal(broken.placedEarly, true, "mutation must prove the ordering assertion can fail");
});

test("Do it now resolves a session-added row's block id so the row is re-dated, not copied", async () => {
  const page = makePage();
  assert.equal(page.ctx.backlog[0]._blockId, undefined);
  await page.api.doNow("wh-laundry");
  assert.deepEqual(page.log.find(e => e[0] === "addToSchedule"), ["addToSchedule", "wh-laundry", "row-laundry"]);
});

test("Do it now moves to today first when you are looking at another day", async () => {
  const page = makePage({ viewDate: "2026-10-09" });
  await page.api.doNow("wh-laundry");
  const order = page.log.map(e => e[0]);
  assert.ok(order.indexOf("switch") < order.indexOf("addToSchedule"), order.join(","));
  assert.deepEqual(page.log.find(e => e[0] === "switch"), ["switch", TODAY]);
});

test("Done lands it on today, then checks it off through the normal toggleDone", async () => {
  const page = makePage();
  assert.equal(await page.api.markDone("wh-laundry"), true);
  const order = page.log.map(e => e[0]).filter(k => k !== "toast");
  assert.deepEqual(order, ["addToSchedule", "place", "toggleDone"]);
  assert.deepEqual(page.log.find(e => e[0] === "toggleDone"), ["toggleDone", "wh-laundry"]);
  assert.equal(page.log.filter(e => e[0] === "toast").length, 0, "toggleDone already toasts the points");
});

test("x sends it back to the Task Library through persistRowProp, and Undo restores it", async () => {
  const page = makePage();
  page.api.release("wh-laundry");
  assert.deepEqual(page.log.find(e => e[0] === "persistRowProp"), ["persistRowProp", "wh-laundry", "stage", "Backlog", "row-laundry"]);
  assert.equal(page.ctx.backlog[0].stage, "Backlog");
  assert.equal(W.selectWhenever(page.ctx.backlog).length, 0);
  const toast = page.log.find(e => e[0] === "toast");
  assert.deepEqual(toast.slice(0, 3), ["toast", "Moved to the Task Library", "Undo"]);
  await Promise.resolve();
  assert.ok(page.log.some(e => e[0] === "refold"), "the itinerary refolds once the stage write lands");
});

test("Undo on the x toast puts the chore back in the pool", () => {
  const page = makePage();
  let undo = null;
  page.ctx.showToast = (msg, type, dur, action) => { if (action) undo = action; };
  page.api.release("wh-laundry");
  assert.ok(undo && typeof undo.onClick === "function", "the toast must carry an Undo action");
  undo.onClick();
  const writes = page.log.filter(e => e[0] === "persistRowProp").map(e => e[3]);
  assert.deepEqual(writes, ["Backlog", "Whenever"]);
  assert.equal(page.ctx.backlog[0].stage, "Whenever");
  assert.equal(W.selectWhenever(page.ctx.backlog).length, 1);
});

test("a pool item with no resolvable row refuses instead of pretending to save", () => {
  const page = makePage();
  page.ctx.window.blockStore = { getByType: () => [] };
  page.api.release("wh-laundry");
  assert.equal(page.log.some(e => e[0] === "persistRowProp"), false);
  assert.equal(page.ctx.backlog[0].stage, "Whenever", "memory must not drift from the row");
  assert.match(page.log.find(e => e[0] === "toast")[1], /Could not update/);
});

// ── wiring contracts ──

test("the header carries one capsule after Waiting: Unscheduled, then Whenever, both opening the drawer", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const header = html.slice(html.indexOf('id="date-nav"'), html.indexOf('id="date-picker-drop"'));
  assert.match(header, /waiting-pill-nav[\s\S]*id="untimed-pill"[\s\S]*id="unscheduled-pill-nav"[\s\S]*id="whenever-pill-nav"/);
  assert.match(header, /id="unscheduled-pill-nav"[^>]*aria-controls="tm-whenever-section"[^>]*data-placement="unplanned"/,
    "the Unscheduled segment is the drop target the itinerary's Unplanned zone used to be");
  assert.match(header, /id="whenever-pill-nav"[^>]*aria-controls="tm-whenever-section"/);
  for (const id of ["unscheduled-pill-nav-count", "whenever-pill-nav-count", "untimed-count", "unscheduled-count",
    "whenever-count", "unscheduled-list", "whenever-list", "whenever-add", "whenever-pick", "unscheduled-tip", "whenever-tip"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing #" + id);
  }
  // Unscheduled first: it is the half that wants action. Each half explains itself.
  const drawer = html.slice(html.indexOf('id="tm-whenever-section"'));
  assert.ok(drawer.indexOf('id="unscheduled-sub"') < drawer.indexOf('id="whenever-sub"'));
  assert.match(drawer, /aria-describedby="unscheduled-tip"[\s\S]*role="tooltip" id="unscheduled-tip">[^<]*schedule/i);
  assert.match(drawer, /aria-describedby="whenever-tip"[\s\S]*role="tooltip" id="whenever-tip">[^<]*free minute/i);
  // Loaded after task-model.js (it reads the stage there) and before schedule.js
  // (the add-bar destination reads the label at load).
  const at = name => html.indexOf('src="/public/js/' + name);
  assert.ok(at("task-model.js") < at("whenever.js") && at("whenever.js") < at("schedule.js"));
});

test("the work list no longer renders the Unscheduled group or counts it", () => {
  const tab = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
  const start = tab.indexOf("function buildListView(){");
  const list = tab.slice(start, tab.indexOf("\nfunction ", start + 1));
  assert.match(list, /const groups=model\.groups\.filter\(g=>g!==model\.unscheduledGroup\);/);
  assert.match(list, /section\("Work list",\[\.\.\.activeIds\]\.filter\(id=>!unscheduledIds\.has\(id\)\)\.length\);/);
  // Removing the zone must not strand its mover: the radial and the pill both reach it.
  const change = tab.slice(tab.indexOf("function buildTaskChangeItems"), tab.indexOf("// Sub-fan: convert this task"));
  assert.match(change, /if\(!ev\.untimed\)\s*items\.push\(\{icon:"🗂"[\s\S]*moveTaskToUnplanned\(ev\.id\)/);
});

test("the pill count rebuilds every render, and the change-task radial offers Whenever", () => {
  const features = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
  assert.match(features, /whenever:\s*\{build:\(\)=>\{if\(typeof buildWhenever==="function"\)buildWhenever\(\);\},\s*isVisible:\(\)=>true\}/);
  const tab = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
  const start = tab.indexOf("function buildTaskChangeItems");
  const end = tab.indexOf("// Sub-fan: convert this task", start);
  assert.ok(start !== -1 && end > start, "buildTaskChangeItems moved");
  const change = tab.slice(start, end);
  assert.match(change, /moveTaskToWhenever\(ev\.id\)/);
});

test("a row's modal replaces the Tasks drawer instead of opening underneath it", () => {
  const src = fs.readFileSync(require.resolve("./public/js/side-drawers.js"), "utf8");
  const start = src.indexOf("const REPLACES_DRAWER");
  const end = src.indexOf("function openTasks(", start);
  assert.ok(start > 0 && end > start, "modalReplacesDrawer moved");
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + "\nthis.f = modalReplacesDrawer; this.SEL = REPLACES_DRAWER;", ctx);
  const sel = ctx.SEL.split(",");
  const el = (cls, opts) => ({
    classList: { contains: c => c === "open" ? !!(opts && opts.open) : false },
    matches: s => s.split(",").some(one => one === "." + cls),
    closest: s => (opts && opts.inDrawer && s === "#tasks-drawer") ? {} : null,
  });
  const classes = sel.map(s => s.slice(1));
  for (const cls of ["sched-picker-overlay", "add-modal-overlay", "done-modal-overlay", "del-confirm-overlay"]) {
    assert.ok(classes.includes(cls), cls + " opens from a row and sits under the drawer");
  }
  for (const cls of classes) {
    assert.equal(ctx.f([{ target: el(cls, { open: true }) }]), true, cls);
    assert.equal(ctx.f([{ target: el(cls, { open: false }) }]), false, cls + " closing must not close the drawer");
  }
  // Waiting's modal is styled ABOVE the drawer (1050) and edits it in place, and the
  // repeat manager's "open" panel lives INSIDE the drawer. Neither may close it.
  assert.equal(sel.includes(".delegated-modal-overlay"), false);
  assert.equal(ctx.f([{ target: el("add-modal-overlay", { open: true, inDrawer: true }) }]), false);
  assert.equal(ctx.f([{ target: { nodeType: 3 } }, null]), false, "text nodes and holes are ignored");

  // The reason the rule exists: every one of these is stacked under the drawer.
  const css = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");
  const z = cls => Number((css.match(new RegExp("\\." + cls + "\\{[^}]*z-index:(\\d+)")) || [])[1]);
  const drawerZ = z("side-drawer-body");
  assert.ok(drawerZ > 0, "drawer z-index moved");
  classes.forEach(cls =>
    assert.ok(z(cls) < drawerZ, cls + " is now above the drawer; revisit whether it should still replace it"));
  // And the rule is actually wired: an open modal closes the drawer without stealing focus.
  assert.match(src, /modalReplacesDrawer\(records\)\) closeTasks\(\{ keepFocus: true \}\)/);
});

test("a drag inside the drawer reorders against the drawer's rows and keeps everyone's position", () => {
  const tab = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
  const a = tab.indexOf("function _unscheduledRowIds(");
  const b = tab.indexOf("function _reorderUnscheduled(");
  assert.ok(a > 0 && b > 0, "reorder helpers moved");
  const src = tab.slice(a, tab.indexOf("\n}\n", a) + 3) + tab.slice(b, tab.indexOf("\n}\n", b) + 3);
  const row = id => ({ dataset: { id }, classList: { contains: c => c === "it-list-item" } });
  const saved = [];
  const ctx = {
    document: { querySelectorAll: sel => (sel.includes("#unscheduled-list") ? ["a", "b", "c"].map(row) : []) },
    saveUnscheduledOrder: ids => saved.push(ids.slice()),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx._reorderUnscheduled("c", "a", false, false);
  assert.deepEqual(Array.from(saved[0]), ["c", "a", "b"], "every row keeps its place; only the dragged one moves");
});

test("the pill's Unscheduled count is open ROOTS: not sub-steps, not done rows", () => {
  const tab = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
  const s = tab.indexOf("function renderUnscheduledInto(");
  assert.ok(s > 0, "renderUnscheduledInto moved");
  const src = tab.slice(s, tab.indexOf("\nwindow.renderUnscheduledInto", s));
  const nodes = [
    { ev: { id: "a" }, depth: 0 }, { ev: { id: "a1" }, depth: 1 },
    { ev: { id: "b", done: true }, depth: 0 }, { ev: { id: "c" }, depth: 0 },
  ];
  const DCC = { TaskModel: {}, TimeBlocks: {} };
  const rendered = [];
  const ctx = {
    window: { DCC }, DCC, isDone: ev => !!ev.done, _isSubRow: n => n.depth > 0,
    _itineraryListModel: () => ({ unscheduledGroup: { nodes }, unfPool: [], isTodayView: true }),
    _orderUnscheduledNodes: n => n,
    createTaskListRowRenderer: () => (ev, idx, mode) => ({ ev, idx, mode }),
    document: { createDocumentFragment: () => ({ appendChild: x => rendered.push(x) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.r = renderUnscheduledInto;", ctx);
  const counts = ctx.r({ innerHTML: "", appendChild() {} });
  assert.deepEqual({ ...counts }, { open: 2, total: 4 });
  assert.deepEqual(rendered.map(r => r.mode), ["open", "open", "done", "open"], "done rows render as done, not as unchecked");
});

test("addWheneverTask files a collision-proof dateless row on the Whenever stage", () => {
  const src = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
  const s0 = src.indexOf("function addNewTask(");
  const body = src.slice(s0, src.indexOf("// ======== UNIVERSAL TASK ADD BAR", s0));
  const persisted = [];
  const ctx = {
    window: { DCC: { Whenever: { STAGE: "Whenever", LABEL: "Whenever" } } }, backlog: [],
    persistBacklogItem: i => persisted.push(i), ms: m => m + "m", log() {}, render() {}, Date, Math, String,
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  assert.equal(ctx.addWheneverTask("   "), null);
  assert.equal(persisted.length, 0, "a blank title files nothing");
  const a = ctx.addWheneverTask("Laundry"), b = ctx.addWheneverTask("Laundry");
  assert.notEqual(a.id, b.id, "two adds in one session must not share a local_id");
  assert.match(a.id, /^wh-\d+-[a-z0-9]+$/);
  assert.deepEqual(persisted.map(i => i.stage), ["Whenever", "Whenever"]);
  assert.equal(W.selectWhenever(ctx.backlog).length, 2, "both land in the pool");
  assert.equal(a.durMin, 15, "chores default to 15 minutes");
  // The plain Task Library add shares the creator, and with it the collision-proof id.
  const c = ctx.addNewTask("Solo task", 30);
  assert.match(c.id, /^custom-\d+-[a-z0-9]+$/);
  assert.equal(c.stage, "");
});

test("moveTaskToWhenever files the row on the Whenever stage, then refolds after the write", async () => {
  const src = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
  const s0 = src.indexOf("async function moveTaskToWhenever(");
  const body = src.slice(s0, src.indexOf("\n}\n", s0) + 3);
  const log = [];
  let release;
  const ctx = {
    window: { DCC: { Whenever: { STAGE: "Whenever", LABEL: "Whenever" } } },
    // Only t1's write is held open (to prove the refold waits for it); any other id
    // resolves at once, so a missing refusal fails the test instead of hanging it.
    _moveTaskToBacklogStage: (id, stage, msg) => {
      log.push(["move", id, stage, msg]);
      return id === "t1" ? new Promise(r => { release = r; }) : Promise.resolve();
    },
    refoldTaskStateFromBlockCache: () => log.push(["refold"]),
    render: () => log.push(["render"]),
    scheduled: [{ id: "t1" }, { id: "p1" }, { id: "c1", subtaskOf: "p1" }],
    childrenOf: (id, pool) => pool.filter(e => e.subtaskOf === id),
    showToast: msg => log.push(["toast", msg]),
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  // A parent would strand its subtasks on today: refused, nothing written.
  assert.equal(await ctx.moveTaskToWhenever("p1"), false);
  assert.deepEqual(log, [["toast", "Finish or move its subtasks first"]]);
  log.length = 0;
  const done = ctx.moveTaskToWhenever("t1");
  await Promise.resolve();
  assert.deepEqual(log.map(e => e[0]), ["move"], "no refold before the unschedule write lands");
  assert.deepEqual(log[0], ["move", "t1", "Whenever", "Moved to Whenever"]);
  release(); await done;
  assert.deepEqual(log.map(e => e[0]), ["move", "refold", "render"]);
});
