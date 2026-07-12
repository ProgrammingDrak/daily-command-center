// Contract tests for the Phase 9 runtime logic that lives in browser files
// (schedule-tab.js, unfinished-tasks.js) and so isn't otherwise exercised by the
// node suite: skipType (registry-driven skip set), _habitStreakCount (consecutive
// prior-day streak), and convertTaskType (type change + wrap-flag + child-keep).
// Harness pattern mirrors schedule-tab-shell-exclusion.test.js: slice the pure
// functions into a node:vm context with stubbed globals.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TaskTypes = require("./public/js/task-types");
const stSrc = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const unfSrc = fs.readFileSync(require.resolve("./public/js/unfinished-tasks.js"), "utf8");
// col-0 closing brace for top-level fns; single-line grab for _prevDate.
const slice = (src, name) => src.match(new RegExp("function " + name + "[\\s\\S]*?\\n\\}"))[0];
const sliceLine = (src, name) => src.match(new RegExp("function " + name + "[^\\n]*"))[0];

// ── skipType (unfinished-tasks.js) ──────────────────────────────────────────
function skipTypeCtx(withRegistry) {
  const block = unfSrc.match(/const SKIP_RAW[\s\S]*?function skipType[\s\S]*?\n {2}\}/)[0];
  const context = { window: withRegistry ? { TaskTypes } : {} };
  vm.createContext(context);
  vm.runInContext(block + "\nthis.skipType = skipType;", context);
  return context.skipType;
}

test("skipType: fixed types + calendar-raw types skip; work types don't (registry loaded)", () => {
  const skip = skipTypeCtx(true);
  for (const t of ["meeting", "oneone", "ooo", "break"]) assert.equal(skip(t), true, t + " (fixed) skips");
  for (const t of ["focus", "focus_time", "free_time", "prep"]) assert.equal(skip(t), true, t + " (raw) skips");
  for (const t of ["task", "triage", "habit", "wrap", "shell"]) assert.equal(skip(t), false, t + " does NOT skip");
});

test("skipType: falls back to the literal fixed set when the registry isn't loaded", () => {
  const skip = skipTypeCtx(false);
  for (const t of ["meeting", "oneone", "ooo", "break", "focus", "prep"]) assert.equal(skip(t), true, t + " skips via fallback");
  assert.equal(skip("task"), false);
  assert.equal(skip("habit"), false);
});

// ── _habitStreakCount (schedule-tab.js) ─────────────────────────────────────
function streakCtx() {
  const source = [sliceLine(stSrc, "_prevDate"), slice(stSrc, "_habitStreakCount")].join("\n");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source + "\nthis._habitStreakCount=_habitStreakCount;this._prevDate=_prevDate;", context);
  return context;
}
function dayMap(today, offsets, key) {
  // Build a Map(dateStr -> Set(key)) using UTC stepping (matches _prevDate).
  const m = new Map();
  for (const off of offsets) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - off);
    m.set(d.toISOString().slice(0, 10), new Set([key]));
  }
  return m;
}

test("_habitStreakCount: counts consecutive prior days and stops at the first gap", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  // days back 1,2 present, 3 missing, 4 present -> streak is 2.
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 4], "x"), T, "x"), 2);
});

test("_habitStreakCount: unbroken run counts every day; empty map / today-only is 0", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 3, 4, 5], "y"), T, "y"), 5);
  assert.equal(ctx._habitStreakCount(new Map(), T, "y"), 0);
  assert.equal(ctx._habitStreakCount(dayMap(T, [0], "y"), T, "y"), 0); // today doesn't count (prior days only)
});

test("_habitStreakCount: a different key doesn't borrow another habit's streak", () => {
  const ctx = streakCtx();
  const T = "2026-07-11";
  assert.equal(ctx._habitStreakCount(dayMap(T, [1, 2, 3], "y"), T, "z"), 0);
});

test("_prevDate: steps exactly one calendar day across a month boundary (UTC-stable)", () => {
  const ctx = streakCtx();
  assert.equal(ctx._prevDate("2026-08-01"), "2026-07-31");
  assert.equal(ctx._prevDate("2026-03-01"), "2026-02-28"); // non-leap
  assert.equal(ctx._prevDate("2026-07-11"), "2026-07-10");
});

// ── convertTaskType (schedule-tab.js) ───────────────────────────────────────
function convertCtx(tasks) {
  const persists = [];
  const context = {
    window: { TaskTypes },
    scheduled: tasks,
    childrenOf: () => [],
    _persistEvProps: (ev, patch) => persists.push({ id: ev.id, patch }),
    recalcTimes: () => {},
    render: () => {},
    showToast: () => {},
  };
  vm.createContext(context);
  vm.runInContext(slice(stSrc, "convertTaskType") + "\nthis.convertTaskType=convertTaskType;", context);
  return { context, persists };
}

test("convertTaskType: task -> shell sets type + isWrap and persists both", () => {
  const ev = { id: "t1", type: "task" };
  const { context, persists } = convertCtx([ev]);
  context.convertTaskType("t1", "shell");
  assert.equal(ev.type, "shell");
  assert.equal(ev.isWrap, true); // shell has dragMovesSubtree
  assert.equal(persists.length, 1);
  assert.equal(persists[0].id, "t1");
  assert.equal(persists[0].patch.type, "shell");
  assert.equal(persists[0].patch.isWrap, true);
});

test("convertTaskType: shell -> task clears the wrap flag", () => {
  const ev = { id: "t2", type: "shell", isWrap: true };
  const { context, persists } = convertCtx([ev]);
  context.convertTaskType("t2", "task");
  assert.equal(ev.type, "task");
  assert.ok(!ev.isWrap);
  assert.equal(persists[0].patch.isWrap, false);
});

test("convertTaskType: refuses a fixed/calendar target and is a no-op on same type", () => {
  const ev = { id: "t3", type: "task" };
  const { context, persists } = convertCtx([ev]);
  context.convertTaskType("t3", "meeting"); // fixed target rejected
  assert.equal(ev.type, "task");
  context.convertTaskType("t3", "task"); // same type no-op
  assert.equal(ev.type, "task");
  assert.equal(persists.length, 0);
});
