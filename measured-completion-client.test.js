const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const scheduleSource = fs.readFileSync("public/js/schedule.js", "utf8");
const helperSource = scheduleSource.match(/function _applyMeasuredCompletionToEv\(ev,completedAt\)\{[\s\S]*?function _doneRowProps\(props,completedAt\)\{[\s\S]*?\n\}/);
assert.ok(helperSource, "measured completion helpers must remain available in schedule.js");

function harness() {
  const window = {};
  const context = { window, self: window, refreshOpenAddModalDetails: () => {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/js/measured-task-window.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("public/js/points.js", "utf8"), context);
  vm.runInContext(helperSource[0], context);
  return context;
}

test("DCC completion updates the in-memory task before rendering and crediting", () => {
  const ctx = harness();
  ctx.ev = {
    id: "t-1", title: "Measured", startedAt: "2026-07-28T15:32:00Z",
    start: "15:55", end: "16:30", actualMinutes: null,
  };
  vm.runInContext('_applyMeasuredCompletionToEv(ev,"2026-07-28T15:46:00Z")', ctx);
  assert.equal(ctx.ev.start, "11:30");
  assert.equal(ctx.ev.end, "11:50");
  assert.equal(ctx.ev.pointsDurationMinutes, 20);
  const payload = ctx.window.TaskPoints.buildPayload(ctx.ev, {});
  assert.equal(payload.points_duration_minutes, 20);
  assert.equal(ctx.window.TaskPoints.estimate(payload).awardPoints, 20);
});

test("DCC row completion persists the rounded schedule and scoring metadata", () => {
  const ctx = harness();
  ctx.props = {
    title: "Measured", startedAt: "2026-07-28T15:32:00Z",
    start: "15:55", end: "16:30", duration: 35, estimatedMinutes: 35,
  };
  const next = vm.runInContext('_doneRowProps(props,"2026-07-28T15:46:00Z")', ctx);
  assert.equal(next.start, "11:30");
  assert.equal(next.end, "11:50");
  assert.equal(next.duration, 20);
  assert.equal(next.durationMinutes, 20);
  assert.equal(next.estimatedMinutes, 20);
  assert.equal(next.pointsDurationMinutes, 20);
  assert.equal(next.points, 20);
  assert.equal(next.pointsBreakdown.durationMinutes, 20);
  assert.equal(next.actualMinutes, undefined, "server reconciliation still owns exact elapsed timing");
});

test("DCC completion uses the server-provided app timezone", () => {
  const ctx = harness();
  ctx.window.DCC_APP_TIME_ZONE = "America/Los_Angeles";
  ctx.props = {
    title: "Measured", startedAt: "2026-07-28T15:32:00Z",
    start: "15:55", end: "16:30", duration: 35,
  };
  const next = vm.runInContext('_doneRowProps(props,"2026-07-28T15:46:00Z")', ctx);
  assert.equal(next.start, "08:30");
  assert.equal(next.end, "08:50");
});

test("realtime modal refresh reads the updated block without replacing the notes editor", () => {
  const featuresSource = fs.readFileSync("public/js/features.js", "utf8");
  const details = featuresSource.match(/(function _amBuildDetails\(ev\)\{[\s\S]*?\n\})\n\n\/\/ C4/);
  const refresh = featuresSource.match(/(function refreshOpenAddModalDetails\(opts\) \{[\s\S]*?\n\})\n\n\/\/ Modal/);
  assert.ok(details && refresh);
  const elements = {
    "add-modal-overlay": { classList: { contains: () => true } },
    "am-details-section": { innerHTML: "", style: {} },
  };
  const freshBlock = {
    id: "row-1", date: "2026-07-28",
    properties: { local_id: "task-1", duration: 20, start: "11:30", end: "11:50" },
  };
  const window = {
    location: { origin: "http://localhost:8090" },
    DCC: {
      esc: value => String(value == null ? "" : value),
      TaskModel: { fromBlock: block => ({ ...block.properties, id: block.properties.local_id, durMin: block.properties.duration }) },
    },
    blockStore: { get: id => id === "row-1" ? freshBlock : null },
  };
  const ctx = {
    window, URL, document: { getElementById: id => elements[id] || null },
    _addModalTaskId: "task-1", _addModalBlockId: "row-1",
    taskAnchorById: () => ({ ev: { id: "task-1", duration: 35, start: "15:55", end: "16:30" } }),
    dur: ev => ev.duration, ms: value => value + "m", f12: value => value,
  };
  vm.createContext(ctx);
  vm.runInContext(details[1] + "\n" + refresh[1], ctx);
  vm.runInContext("refreshOpenAddModalDetails({fromBlockStore:true})", ctx);
  assert.match(elements["am-details-section"].innerHTML, /20m/);
  assert.match(elements["am-details-section"].innerHTML, /11:30 - 11:50/);
  assert.doesNotMatch(elements["am-details-section"].innerHTML, /15:55/);
});
