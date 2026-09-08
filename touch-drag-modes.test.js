// Regression coverage for the drag MODES, now one gesture on every device.
//
// History: the desktop mid-row nest band (25%-75% of the row) swallowed nearly
// every drop. #345 fixed that for touch by picking the mode from the sideways
// offset. Desktop kept the band, where a 64px row leaves ~16px reorder edges no
// cursor reliably hits, so most drops nested and reorder felt gone. Both paths
// now resolve through _dragMode, so vertical always reorders and nesting is an
// explicit sideways drag (or Shift on a mouse).
//
// These tests see CLASSES and DATA. They cannot see whether CSS then paints the
// indicator: `overflow:hidden` on the row clipped the blue silhouette away for
// a whole release with this suite green. That guard lives in
// scripts/smoke-ci.mjs ("reorder drop indicator is visible"), in a real browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");
const tabsSource = fs.readFileSync(require.resolve("./public/js/tabs.js"), "utf8");
const touchSource = fs.readFileSync(require.resolve("./public/js/touch-drag.js"), "utf8");

function sourceFunction(source, name) {
  const match = source.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"));
  assert.ok(match, "expected to find " + name);
  return match[0];
}

function makeDragDay(scheduled) {
  const context = {
    console,
    document: { querySelectorAll: () => [] },
    window: { blockStore: { _blocks: [], getByType: () => [], get: () => null, updateBlock: () => {} } },
    DCC: { TaskModel: {
      ridersOf: (id, pool) => pool.filter((task) => task.wrapId === id),
      subtasksOf: (id, pool) => pool.filter((task) => task.subtaskOf === id),
      childrenOf: (id, pool) => pool.filter((task) => task.wrapId === id || task.subtaskOf === id),
      selectActive: (pool) => pool.filter((task) => !task.done && !task.deleted),
      selectOpen: (pool) => pool.filter((task) => !task.done && !task.deleted),
      selectTimedActive: (pool) => pool.filter((task) => !task.done && !task.deleted && !task.untimed),
      selectNotDeleted: (pool) => pool.filter((task) => !task.deleted),
    } },
    scheduled,
    INIT_SCHED: scheduled.slice(),
    __state: { schedule: { blocks: [] } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: (ev) => {
      const [sh, sm] = ev.start.split(":").map(Number);
      const [eh, em] = ev.end.split(":").map(Number);
      return (eh * 60 + em) - (sh * 60 + sm);
    },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
    isNested: (ev) => !!(ev.wrapId || ev.subtaskOf),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    isFixed: (ev) => ["meeting", "oneone", "break", "ooo"].includes(ev.type),
    parentIdOf: (ev) => (ev && (ev.wrapId || ev.subtaskOf)) || null,
    relOf: (ev) => ev ? (ev.wrapId ? "ride-along" : (ev.subtaskOf ? "subtask" : null)) : null,
    isWrap: (ev) => !!ev.isWrap,
    userMovable: () => true,
    now: () => 9 * 60,
    loadPinnedStarts: () => ({}),
    savePinnedStarts: () => {},
    saveTaskOrder: () => {},
    syncAddedTaskTimes: () => {},
    showToast: () => {},
    log: () => {},
    render: () => {},
  };
  vm.createContext(context);
  vm.runInContext(dragSource, context);
  return context;
}

// A row element that records the drop-feedback classes dOver puts on it.
function fakeRow(height) {
  const classes = new Set();
  return {
    classes,
    getBoundingClientRect: () => ({ top: 0, left: 0, height }),
    classList: {
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

// clientX is the LIFT POINT. Omit it to model a drag that never recorded one
// (the backlog card, a preset task group, a week-calendar event).
function startDrag(context, id, clientX) {
  context.dStart(
    { dataTransfer: { effectAllowed: "", setData() {} }, target: { closest: () => null }, clientX },
    id,
  );
}

// A real mouse DragEvent: no dccMode, a cursor, and an optional Shift.
function mouseEvt(row, clientY, clientX, shiftKey) {
  return { preventDefault() {}, shiftKey: !!shiftKey, clientY, clientX, currentTarget: row, target: row };
}

function twoTasks() {
  return [
    { id: "target", title: "Target", type: "task", start: "09:00", end: "09:30" },
    { id: "moved", title: "Moved", type: "task", start: "10:00", end: "10:30" },
  ];
}

test("touch reorder mode drops mid-row WITHOUT nesting", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  // Dead center of the row — the exact spot desktop treats as "wrap inside".
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 50, "reorder");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId ?? null, null);
  assert.equal(moved.subtaskOf ?? null, null);
});

test("touch nest mode nests from a row EDGE, where desktop would only reorder", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 8, "nest");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId, "target");
  assert.equal(moved.subtaskOf ?? null, null);
});

test("touch sub mode nests as a subtask with no Shift key", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => (key === "childEdge" ? "any" : false) };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "moved");
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 50, "sub");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.subtaskOf, "target");
  assert.equal(moved.wrapId ?? null, null);
});

test("mouse drag straight down reorders, even at the row's dead centre", () => {
  // The old contract nested here. A vertical-only drag must never re-parent: that
  // was the whole complaint, and it is the same rule touch already follows.
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved", 300);
  context.dDrop(mouseEvt(fakeRow(100), 50, 300), "target");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId ?? null, null);
  assert.equal(moved.subtaskOf ?? null, null);
});

test("mouse drag LEFT nests, RIGHT nests as a subtask", () => {
  const nested = (() => {
    const tasks = twoTasks();
    const context = makeDragDay(tasks);
    startDrag(context, "moved", 300);
    context.dDrop(mouseEvt(fakeRow(100), 8, 240), "target");   // -60px selects Nest
    return tasks.find((t) => t.id === "moved");
  })();
  assert.equal(nested.wrapId, "target", "60px left is a ride-along nest, from a row EDGE");
  assert.equal(nested.subtaskOf ?? null, null);

  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => (key === "childEdge" ? "any" : false) };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "moved", 300);
  context.dDrop(mouseEvt(fakeRow(100), 50, 440), "target");    // +140px = past SUB_PX
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.subtaskOf, "target", "140px right is a subtask nest, with no Shift");
  assert.equal(moved.wrapId ?? null, null);
});

test("Shift is still the desktop shorthand for a subtask nest", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => (key === "childEdge" ? "any" : false) };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "moved", 300);
  // No sideways offset at all: Shift alone selects the subtask nest.
  context.dDrop(mouseEvt(fakeRow(100), 50, 300, true), "target");
  assert.equal(tasks.find((t) => t.id === "moved").subtaskOf, "target");
});

test("a drag that recorded no lift point reorders instead of guessing", () => {
  // The backlog card, a preset task group and a week-calendar event all set
  // dragId without going through dStart. Without the guard, `clientX - null`
  // coerces to clientX itself, so a cursor anywhere right of the window's left
  // edge reads as "sub" and re-parents a task nobody asked to re-parent.
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  context.window.TaskTypes = { rule: (ev, key) => (key === "childEdge" ? "any" : false) };
  context.window.PointPlan = { ensure() {}, reconcile() {} };
  // reparentAsSubtask MUST be wired: without it the sub branch is a silent no-op
  // and this test passes for the wrong reason no matter what mode resolves.
  vm.runInContext(sourceFunction(tabsSource, "reparentAsSubtask"), context);
  startDrag(context, "moved");                    // no clientX

  // The mode itself, so the assertion cannot be satisfied by a missing dependency.
  assert.equal(context._dragMode({ clientX: 900, shiftKey: false }), "reorder");

  context.dDrop(mouseEvt(fakeRow(100), 50, 900), "target");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId ?? null, null);
  assert.equal(moved.subtaskOf ?? null, null);
});

test("touch reorder feedback is the blue bar, not the purple nest overlay", () => {
  const tasks = twoTasks();
  const context = makeDragDay(tasks);
  startDrag(context, "moved");
  const row = fakeRow(100);
  context.window.DCC_DRAG.over(row, "target", 50, "reorder");
  assert.equal(row.classes.has("drag-over-nest"), false);
  assert.ok(row.classes.has("drag-over-top") || row.classes.has("drag-over-bottom"));

  const nestRow = fakeRow(100);
  context.window.DCC_DRAG.over(nestRow, "target", 8, "nest");
  assert.ok(nestRow.classes.has("drag-over-nest"));
  assert.equal(nestRow.classes.has("drag-over-nest-sub"), false);

  const subRow = fakeRow(100);
  context.window.DCC_DRAG.over(subRow, "target", 8, "sub");
  assert.ok(subRow.classes.has("drag-over-nest-sub"));
});

test("an Unscheduled row is never offered a nest it will not get", () => {
  // dDrop gates nesting on !wasUntimed, so dOver must not paint the purple "wrap
  // inside" overlay for an untimed row. Otherwise the drag promises a nest and the
  // drop schedules the task top-level instead, which reads as the app ignoring you.
  const tasks = twoTasks();
  tasks.find((t) => t.id === "moved").untimed = true;
  const context = makeDragDay(tasks);
  startDrag(context, "moved");

  const row = fakeRow(100);
  context.window.DCC_DRAG.over(row, "target", 50, "nest");
  assert.equal(row.classes.has("drag-over-nest"), false, "no nest promise for an untimed row");
  assert.ok(row.classes.has("drag-over-top") || row.classes.has("drag-over-bottom"));

  // And the drop agrees: it schedules top-level rather than nesting.
  context.window.DCC_DRAG.drop(fakeRow(100), "target", 50, "nest");
  const moved = tasks.find((t) => t.id === "moved");
  assert.equal(moved.wrapId ?? null, null);
  assert.equal(moved.subtaskOf ?? null, null);
});

test("_modeForDx pins the exact reorder / nest / sub boundaries", () => {
  const { _modeForDx } = makeDragDay(twoTasks());
  assert.equal(_modeForDx(-200), "nest");
  assert.equal(_modeForDx(-48), "nest");
  assert.equal(_modeForDx(-47), "reorder");
  assert.equal(_modeForDx(0), "reorder");
  assert.equal(_modeForDx(47), "reorder");
  assert.equal(_modeForDx(48), "sub");
  assert.equal(_modeForDx(400), "sub");
});

test("touch reads the thresholds from drag.js instead of keeping a second copy", () => {
  // Two copies of 48/112 is the drift this consolidation removes. If touch-drag.js
  // ever grows its own numbers again, retuning the gesture silently changes one
  // platform and not the other.
  // Declarations, not mentions: the comment above modeFor names drag.js's constants.
  assert.equal(/(?:var|let|const)\s+(?:NEST|SUB)_PX/.test(touchSource), false,
    "no threshold constants declared in touch-drag.js");
  assert.match(touchSource, /DCC_DRAG\.modeForPoint\(x, y\)/);

  // And the facade really exposes it, with the same answers.
  const { window: win, _modeForDx } = makeDragDay(twoTasks());
  assert.equal(typeof win.DCC_DRAG.modeForDx, "function");
  [-5, 0, 47, 48, 111, 112, 500].forEach((dx) => {
    assert.equal(win.DCC_DRAG.modeForDx(dx), _modeForDx(dx));
  });
});

test("mouse hover feedback agrees with the mouse drop, at every offset", () => {
  // _dragMode is read in two places: dOver decides what to SHOW, dDrop decides
  // what to DO. This pins the hover half, so the promise and the outcome cannot
  // part ways -- the reason _nestZone is one function and not two copies.
  const context = makeDragDay(twoTasks());
  startDrag(context, "moved", 300);

  const straight = fakeRow(100);
  context.dOver(mouseEvt(straight, 50, 300), "target");
  assert.equal(straight.classes.has("drag-over-nest"), false, "dead centre must not promise a nest");
  assert.ok(straight.classes.has("drag-over-top") || straight.classes.has("drag-over-bottom"));

  const right = fakeRow(100);
  context.dOver(mouseEvt(right, 8, 240), "target");
  assert.ok(right.classes.has("drag-over-nest"), "60px left nests from a row EDGE");
  assert.equal(right.classes.has("drag-over-nest-sub"), false);

  startDrag(context, "moved", 300);
  const far = fakeRow(100);
  context.dOver(mouseEvt(far, 50, 440), "target");
  assert.ok(far.classes.has("drag-over-nest-sub"), "140px right is the subtask overlay");

  const shifted = fakeRow(100);
  context.dOver(mouseEvt(shifted, 50, 300, true), "target");
  assert.ok(shifted.classes.has("drag-over-nest-sub"), "Shift alone is the subtask overlay");
});

test("the touch gesture picks its mode from the sideways offset, reorder by default", () => {
  assert.match(touchSource, /function modeFor\(x, y\)/);
  // With the facade missing, reorder: a missing dependency must not re-parent.
  assert.match(touchSource, /modeForPoint !== "function"\) return "reorder";/);
  // Both the hover feedback and the drop must carry the same mode.
  assert.match(touchSource, /DCC_DRAG\.over\(tgt, tgtId, e\.clientY, mode\)/);
  assert.match(touchSource, /DCC_DRAG\.drop\(tgt, tgt\.dataset\.id, e\.clientY, mode\)/);
});

test("finger reorder is gated on pointer type ONLY, not on viewport width", () => {
  // A width test used to sit next to the pointerType check. A touch laptop or a
  // tablet wider than 540px passed one and failed the other, and native HTML5
  // drag never fires for touch input, so finger reorder was impossible there --
  // silently, with no affordance missing and nothing in the console.
  assert.match(touchSource, /if \(e\.pointerType === "mouse"\) return;/);
  assert.equal(/isTouchMode/.test(touchSource), false, "no viewport-width gate on the lift");
});

for (const [dx, expected] of [[-48, 'nest'], [48, 'sub']]) {
  test(`${expected} tolerates 32px vertical drift, resets at 33px, and requires a fresh swipe`, () => {
    const c = makeDragDay(twoTasks());
    const api = c.window.DCC_DRAG;
    api.begin('moved', null, 300);
    assert.equal(api.modeForPoint(300 + dx, 100), expected);
    assert.equal(api.modeForPoint(300, 132), expected, 'horizontal wobble does not cancel the selection');
    assert.equal(api.modeForPoint(300, 133), 'reorder');
    assert.equal(api.modeForPoint(300, 133), 'reorder', 'hover and drop resolve identically');
    assert.equal(api.modeForPoint(300 + Math.sign(dx) * 47, 133), 'reorder');
    assert.equal(api.modeForPoint(300 + dx, 133), expected);
    api.end();
    api.begin('moved', null, 300);
    assert.equal(api.modeForPoint(300, 100), 'reorder', 'a new drag forgets the old mode');
  });
}

test('mouse hover and release keep Nest through small vertical movement', () => {
  const tasks = twoTasks(), c = makeDragDay(tasks), row = fakeRow(100);
  startDrag(c, 'moved', 300);
  c.dOver(mouseEvt(row, 40, 250), 'target');
  c.dOver(mouseEvt(row, 65, 290), 'target');
  assert.ok(row.classes.has('drag-over-nest'));
  c.dDrop(mouseEvt(row, 65, 290), 'target');
  assert.equal(tasks.find(t => t.id === 'moved').wrapId, 'target');
});

function blockTarget(start = '19:00') {
  const el = fakeRow(36);
  el.dataset = { blockId: 'evening', blockStart: start };
  el.classList.add('time-block-drop-zone');
  return el;
}

function blockDay(tasks) {
  const c = makeDragDay(tasks);
  const rows = new Map(tasks.map(t => [t.id, { id: t.id, properties: { ...t } }]));
  tasks.forEach(t => { t._blockId = t.id; });
  c.window.blockStore.get = id => rows.get(id);
  c.window.blockStore.updateBlock = (id, properties) => rows.set(id, { id, properties });
  c._setUserSetStart = (ev, id, on) => { ev._userSetStart = on; };
  const scheduleSource = fs.readFileSync(require.resolve('./public/js/schedule.js'), 'utf8');
  vm.runInContext(sourceFunction(scheduleSource, 'pinStartTime'), c);
  return { c, rows };
}

for (const origin of ['scheduled', 'unscheduled', 'subtask', 'ride-along']) {
  test(`${origin} task drops at an empty block start with duration and persisted promotion`, () => {
    const tasks = twoTasks();
    const moved = tasks[1];
    if (origin === 'unscheduled') { moved.untimed = true; moved.start = '00:00'; moved.end = '00:30'; }
    if (origin === 'subtask') { moved.subtaskOf = 'target'; moved.start = moved.end = '00:00'; }
    if (origin === 'ride-along') moved.wrapId = 'target';
    const { c, rows } = blockDay(tasks), api = c.window.DCC_DRAG, el = blockTarget();
    api.begin('moved', null, 300);
    api.over(el, undefined, 18, 'nest');
    assert.ok(el.classes.has('drag-over-block'), 'target needs no task id');
    api.drop(el, undefined, 18, 'nest');
    assert.equal(moved.start, '19:00');
    assert.equal(moved.end, '19:30');
    assert.equal(moved.untimed, false);
    assert.equal(moved.wrapId ?? null, null);
    assert.equal(moved.subtaskOf ?? null, null);
    assert.equal(moved._pinnedStart, '19:00');
    assert.equal(rows.get('moved').properties.start, '19:00');
    assert.equal(rows.get('moved').properties.subtaskOf, null);
    assert.equal(rows.get('moved').properties.duration, 30);
    assert.equal(api.activeId(), null);
  });
}

test('moving a parent to a block carries children by the same time delta', () => {
  const tasks = twoTasks();
  tasks.push({ id: 'child', type: 'task', wrapId: 'moved', start: '10:05', end: '10:15' });
  const { c, rows } = blockDay(tasks);
  c.window.DCC_DRAG.begin('moved', null, 300);
  c.window.DCC_DRAG.drop(blockTarget(), undefined, 18, 'reorder');
  assert.equal(tasks.find(t => t.id === 'child').start, '19:05');
  assert.equal(tasks.find(t => t.id === 'child').end, '19:15');
  assert.equal(rows.get('child').properties.start, '19:05');
});

test('locked tasks and invalid block times never get scheduled', () => {
  for (const locked of [false, true]) {
    const tasks = twoTasks(), { c } = blockDay(tasks);
    tasks[1]._locked = locked;
    c.window.DCC_DRAG.begin('moved', null, 300);
    c.window.DCC_DRAG.drop(blockTarget(locked ? '19:00' : '24:00'), undefined, 18, 'reorder');
    assert.equal(tasks[1].start, '10:00');
  }
});
