// Contract tests for sequential shell layout in public/js/drag.js: a shell has
// no length of its own — its span is the SUM of its children, which chain
// back-to-back from the shell's anchor, and adding/removing a child grows or
// shrinks the shell and shifts everything after it.
// Harness mirrors recalc-times.test.js (raw source in a node:vm context).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dragSource = fs.readFileSync(require.resolve("./public/js/drag.js"), "utf8");

// Minimal TaskTypes stub: only "shell" is a sequential, duration-from-children
// rollup; everything else is a plain task.
const TaskTypes = {
  rule(evOrType, key) {
    const type = typeof evOrType === "string" ? evOrType : (evOrType && (evOrType.type || evOrType.kind));
    if (type === "shell") {
      if (key === "childLayout") return "sequential";
      if (key === "durationFromChildren") return true;
      if (key === "dragMovesSubtree") return true;
    }
    return undefined;
  },
  isRollup(evOrType) {
    const type = typeof evOrType === "string" ? evOrType : (evOrType && (evOrType.type || evOrType.kind));
    return type === "shell";
  },
};

function makeDay(scheduled) {
  const context = {
    console,
    window: { __TAGS__: null, TaskTypes },
    scheduled,
    INIT_SCHED: scheduled.slice(),
    __state: { schedule: { blocks: [] } },
    viewMode: "planning",
    pt: (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; },
    fmt: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
    dur: function (ev) { return this.pt(ev.end) - this.pt(ev.start); },
    isDone: (ev) => !!ev.done,
    isDeleted: (ev) => !!ev.deleted,
    isPushed: (ev) => !!ev.pushed,
    isNested: (ev) => !!(ev.wrapId || ev.subtaskOf),
    isMeeting: (ev) => ev.type === "meeting" || ev.type === "oneone",
    parentIdOf: (ev) => ev.wrapId || ev.subtaskOf || null,
    childrenOf: (id, pool) => (pool || scheduled).filter((c) => (c.wrapId || c.subtaskOf) === id),
    isWrap: (ev) => !!ev.isWrap,
    loadPinnedStarts: () => ({}),
    savePinnedStarts: () => {},
  };
  context.dur = context.dur.bind(context);
  vm.createContext(context);
  vm.runInContext(dragSource, context);
  return context;
}

const t = (id, start, end, extra) => Object.assign({ id, title: id, type: "task", start, end }, extra);
const shell = (id, start, extra) => Object.assign({ id, title: id, type: "shell", start, end: start, isWrap: true }, extra);
const find = (sched, id) => sched.find((e) => e.id === id);

test("shell span = sum of children; children chain back-to-back from the anchor", () => {
  const sched = [
    shell("sh", "09:00"),
    t("r1", "09:00", "09:20", { wrapId: "sh" }), // 20m
    t("r2", "09:00", "09:15", { wrapId: "sh" }), // 15m
    t("r3", "09:00", "09:30", { wrapId: "sh" }), // 30m
    t("z", "12:00", "12:30"),                    // trailing top-level task
  ];
  const ctx = makeDay(sched);
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").start, "09:00");
  assert.equal(find(sched, "sh").end, "10:05");   // 09:00 + (20+15+30) = 65m
  assert.equal(find(sched, "r1").start, "09:00");
  assert.equal(find(sched, "r1").end, "09:20");
  assert.equal(find(sched, "r2").start, "09:20"); // chains off r1
  assert.equal(find(sched, "r2").end, "09:35");
  assert.equal(find(sched, "r3").start, "09:35"); // chains off r2
  assert.equal(find(sched, "r3").end, "10:05");
  assert.equal(find(sched, "z").start, "10:05");  // top-level task shifts after the shell's derived end
});

test("adding a child grows the shell and pushes following tasks later", () => {
  const sched = [
    shell("sh", "09:00"),
    t("r1", "09:00", "09:20", { wrapId: "sh" }),
    t("z", "10:00", "10:30"),
  ];
  const ctx = makeDay(sched);
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").end, "09:20");
  assert.equal(find(sched, "z").start, "09:20");
  // Add a 45m child (as the materializer / addStackedTask would).
  sched.push(t("r2", "09:00", "09:45", { wrapId: "sh" }));
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").end, "10:05");    // 20 + 45 = 65m
  assert.equal(find(sched, "r2").start, "09:20");
  assert.equal(find(sched, "z").start, "10:05");   // pushed later by the grown shell
});

test("deleting a child shrinks the shell and pulls following tasks earlier", () => {
  const sched = [
    shell("sh", "09:00"),
    t("r1", "09:00", "09:20", { wrapId: "sh" }),
    t("r2", "09:00", "09:30", { wrapId: "sh" }),
    t("z", "11:00", "11:30"),
  ];
  const ctx = makeDay(sched);
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").end, "09:50");    // 20 + 30 = 50m
  assert.equal(find(sched, "z").start, "09:50");
  find(sched, "r2").deleted = true;
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").end, "09:20");    // only r1 (20m) remains
  assert.equal(find(sched, "z").start, "09:20");   // pulled earlier
});

test("empty shell is zero-length and consumes no time", () => {
  const sched = [
    shell("sh", "09:00"),
    t("z", "10:00", "10:30"),
  ];
  const ctx = makeDay(sched);
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").end, "09:00");    // no children => zero span
  assert.equal(find(sched, "z").start, "09:00");   // task packs right up to the empty shell
});

test("a pinned shell holds its start and still derives its length from children", () => {
  const sched = [
    t("a", "09:00", "09:30"),
    shell("sh", "10:00", { _pinnedStart: "10:00" }),
    t("r1", "10:00", "10:40", { wrapId: "sh" }), // 40m
  ];
  const ctx = makeDay(sched);
  ctx.recalcTimes();
  assert.equal(find(sched, "sh").start, "10:00"); // pin holds
  assert.equal(find(sched, "sh").end, "10:40");   // derived from the 40m child
  assert.equal(find(sched, "r1").start, "10:00");
  assert.equal(find(sched, "r1").end, "10:40");
});
