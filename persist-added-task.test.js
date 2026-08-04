// Regression tests for persistAddedTask's untimed-duration guard: dur(item) is
// end-start, and real pt() returns 0 for a missing time, so an untimed item
// (the schedule popover's "future day, no time" create path) computes dur 0 —
// finite, which is why the guard needs its >0 clause, not just isFinite. The
// guard must fall back to item.durMin instead of persisting duration 0.
// Harness pattern: recalc-times.test.js (raw source sliced into a node:vm
// context with stubbed globals).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const scheduleSource = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const persistSource = scheduleSource.match(/function persistAddedTask[\s\S]*?\n\}/)[0];

function makeContext(opts = {}) {
  const created = [];
  const localStore = {};
  const context = {
    console,
    window: opts.blockstore
      ? { USE_BLOCKSTORE: { addedTasks: true }, blockStore: { createBlock: (type, props, o) => { created.push({ type, props, o }); } } }
      : {},
    // Mirror state.js exactly: pt returns 0 for a missing time, so an untimed
    // item's dur is 0 (finite) — the guard's >0 clause is what production hits.
    pt: (t) => { if (!t) return 0; const [h, m] = String(t).split(":").map(Number); return h * 60 + m; },
    dur: function (ev) { return this.pt(ev.end) - this.pt(ev.start); },
    viewDate: "2026-07-08",
    __state: { date: "2026-07-08" },
    ADDED_KEY: "pa-added-tasks-2026-07-08",
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = v; },
    },
    scheduleIDBSave: () => {},
    Date,
    JSON,
    Number,
  };
  context.dur = context.dur.bind(context);
  vm.createContext(context);
  vm.runInContext(persistSource, context);
  return { context, created, localStore };
}

test("untimed item (no start/end) persists durMin, not NaN/0 — blockstore path", () => {
  const { context, created } = makeContext({ blockstore: true });
  context.persistAddedTask({ id: "t1", title: "untimed", type: "task", durMin: 45 }, "2026-07-15");
  assert.equal(created.length, 1);
  assert.equal(created[0].props.duration, 45);
  assert.equal(created[0].o.date, "2026-07-15");
});

test("timed item still persists its computed end-start duration — blockstore path", () => {
  const { context, created } = makeContext({ blockstore: true });
  context.persistAddedTask({ id: "t2", title: "timed", type: "task", durMin: 45, start: "09:00", end: "10:00" });
  assert.equal(created.length, 1);
  assert.equal(created[0].props.duration, 60);
});

test("untimed item falls back to durMin on the localStorage path too", () => {
  const { context, localStore } = makeContext({ blockstore: false });
  context.persistAddedTask({ id: "t3", title: "untimed", type: "task", durMin: 45 }, "2026-07-15");
  const arr = JSON.parse(localStore["pa-added-tasks-2026-07-15"]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].durMin, 45);
});

test("untimed item with no durMin defaults to 30", () => {
  const { context, created } = makeContext({ blockstore: true });
  context.persistAddedTask({ id: "t4", title: "bare", type: "task" }, "2026-07-15");
  assert.equal(created[0].props.duration, 30);
});

// C5b: an item that is ALREADY done when it is persisted carries its completion onto the row
// it creates, rather than being marked done afterwards in the day's `_done` overlay.
// prep.js's distraction log is the caller: doing it after the fact would have to race this
// async create for a row id that does not exist yet.
test("an already-done item carries its completion onto the row it creates (C5b)", () => {
  const { context, created } = makeContext({ blockstore: true });
  vm.runInContext('persistAddedTask({id:"d1",title:"Slack rabbit hole",durMin:15,status:"done",done:true,completedAt:"2026-08-04T12:00:00Z"})', context);
  assert.equal(created[0].props.status, "done");
  assert.equal(created[0].props.done, true);
  assert.equal(created[0].props.completedAt, "2026-08-04T12:00:00Z");
  // ...and an ordinary create still says nothing about completion, so the pass-through cannot
  // quietly mark every new task done.
  vm.runInContext('persistAddedTask({id:"d2",title:"Ordinary",durMin:30})', context);
  assert.equal(created[1].props.status, undefined);
  assert.equal(created[1].props.done, undefined);
  assert.equal(created[1].props.completedAt, undefined);
});
