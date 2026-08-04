// Contract tests for C5b step 5: `schedule.timeline` is an ARCHIVE source, not a live one.
//
// The timeline was the itinerary's original home and is the second of the two homes this
// project collapses. For a current day it was worse than redundant, it WON: the fold skips
// any row whose id is already in `scheduled` (persistence.js:
// `if(!taskId||scheduled.find(e=>e.id===taskId))return`), so a task with both a timeline
// item and a block row rendered from the timeline copy — which carries no `_blockId`, so no
// row-properties write could resolve it, and whatever times the publisher last stamped.
//
// Measured on prod 2026-08-04 across all 61 `dcc_state` rows before flipping it: 0 timeline
// items on any date >= today, newest non-empty timeline anywhere 2026-05-27. So this is the
// invariant going forward rather than a change to what renders today.
//
// Harness: transformState is sliced out of data.js and run in a node:vm context, because the
// module evaluates INIT_SCHED at load and reaches for browser globals.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/data.js"), "utf8");

function slice(re, what) {
  const m = SRC.match(re);
  if (!m) throw new Error("timeline-demoted.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

// The helpers transformState calls on the timeline path, plus transformState itself.
const DEPS = [
  slice(/function isRetiredCalendarStateItem\([\s\S]*?\n\}/, "isRetiredCalendarStateItem"),
  slice(/function triageActionLink\([\s\S]*?\n\}/, "triageActionLink"),
  slice(/function triageActionLabel\([\s\S]*?\n\}/, "triageActionLabel"),
  slice(/function _dataTodayStr\(\) \{[\s\S]*?\n\}/, "_dataTodayStr"),
  slice(/function transformState\(state\) \{[\s\S]*?\n\}\n/, "transformState"),
].join("\n");

// Dates derived from the clock the code under test will read, never hardcoded — a fixture
// with a literal "2026-08-04" passes or fails depending on the day the suite runs.
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

const item = (id, label) => ({
  id, label, type: "task", start: "2026-08-04T09:00:00-04:00", end: "2026-08-04T09:30:00-04:00",
});

function run(state) {
  const warnings = [];
  const ctx = { console: { warn: (m) => warnings.push(String(m)), log: () => {} }, window: {} };
  vm.createContext(ctx);
  vm.runInContext(DEPS + "\nglobalThis.__out = transformState(globalThis.__state);", Object.assign(ctx, { __state: state }));
  return { sched: [...ctx.__out.sched].map((e) => e.id), warnings };
}

test("an ARCHIVE day still renders its timeline — those items are the only record of it", () => {
  const out = run({ date: dayOffset(-30), schedule: { timeline: [item("tl-1", "Old task")] } });
  assert.deepEqual(out.sched, ["tl-1"]);
  assert.deepEqual(out.warnings, [], "nothing is being dropped, so nothing is reported");
});

test("yesterday is archive too — the boundary is today, not 'a while ago'", () => {
  assert.deepEqual(run({ date: dayOffset(-1), schedule: { timeline: [item("tl-1", "x")] } }).sched, ["tl-1"]);
});

test("TODAY does not render timeline items — the block rows are the itinerary", () => {
  const out = run({ date: dayOffset(0), schedule: { timeline: [item("tl-1", "x"), item("tl-2", "y")] } });
  assert.deepEqual(out.sched, []);
});

test("a FUTURE day does not either", () => {
  assert.deepEqual(run({ date: dayOffset(7), schedule: { timeline: [item("tl-1", "x")] } }).sched, []);
});

test("anything dropped is COUNTED and logged, never silently hidden", () => {
  const out = run({ date: dayOffset(0), schedule: { timeline: [item("tl-1", "x"), item("tl-2", "y")] } });
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /2 timeline item\(s\)/);
  assert.match(out.warnings[0], new RegExp(dayOffset(0)));
});

test("an EMPTY timeline on today logs nothing — this is the shape prod is actually in", () => {
  const out = run({ date: dayOffset(0), schedule: { timeline: [] } });
  assert.deepEqual(out.sched, []);
  assert.deepEqual(out.warnings, [], "a warning on every ordinary page load would be noise");
});

test("a day with NO date renders its timeline — fail toward keeping the record", () => {
  // buildDayResponse always stamps `date`, so this is a guard rather than a live path. The
  // polarity matters anyway: defaulting an unclassifiable day to "today" would blank it.
  assert.deepEqual(run({ schedule: { timeline: [item("tl-1", "x")] } }).sched, ["tl-1"]);
  assert.deepEqual(run({ date: "not-a-date", schedule: { timeline: [item("tl-1", "x")] } }).sched, ["tl-1"]);
});

test("the other sections are untouched by the demotion", () => {
  // The timeline is one of five things transformState reads. Narrowing it must not narrow
  // the day's other data on a current day.
  const out = run({
    date: dayOffset(0),
    schedule: { timeline: [item("tl-1", "x")], tasks_couldnt_fit: [{ task_id: "cf-1", title: "Didn't fit" }] },
    triage: { open_items: [{ id: "tr-1", type: "email", title: "Reply" }] },
    notifications: [{ id: "n-1" }],
  });
  assert.deepEqual(out.sched, []);
  const full = vm.runInNewContext(
    DEPS + "\ntransformState(__state)",
    { console: { warn: () => {} }, window: {}, __state: { date: dayOffset(0), schedule: { timeline: [item("tl-1", "x")], tasks_couldnt_fit: [{ task_id: "cf-1", title: "Didn't fit" }] }, triage: { open_items: [{ id: "tr-1", type: "email", title: "Reply" }] }, notifications: [{ id: "n-1" }] } }
  );
  assert.equal(full.consider.length, 1, "tasks_couldnt_fit still becomes the Consider list");
  assert.equal(full.triageItems.length, 1, "triage still comes through");
  assert.equal(full.notifications.length, 1, "so do notifications");
});
