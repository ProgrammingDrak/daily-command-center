// Contract tests for stepDuration in public/js/state.js: the shared snap-then-step
// math behind every +/- duration button (itinerary card, reschedule popover,
// mobile duration sheet, Done-modal work sessions).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const stateSource = fs.readFileSync(require.resolve("./public/js/state.js"), "utf8");
const start = stateSource.indexOf("function stepDuration(");
const end = stateSource.indexOf("function isMeeting(", start);
assert.ok(start >= 0 && end > start, "stepDuration is present in state.js");
const context = {};
vm.createContext(context);
vm.runInContext(stateSource.slice(start, end), context);

function step(current, delta, opts) {
  context.__args = [current, delta, opts];
  return vm.runInContext("stepDuration(__args[0],__args[1],__args[2])", context);
}

test("plus snaps up to the grid before it walks it", () => {
  assert.equal(step(5, 15), 15);
  assert.equal(step(20, 15), 30);
  assert.equal(step(50, 15), 60);
});

test("plus on a grid value advances one full rung", () => {
  assert.equal(step(15, 15), 30);
  assert.equal(step(30, 15), 45);
  assert.equal(step(0, 15), 15);
});

test("minus snaps down to the grid before it walks it", () => {
  assert.equal(step(50, -15), 45);
  assert.equal(step(45, -15), 30);
  assert.equal(step(31, -15), 30);
});

test("minus holds at or below the grain instead of collapsing to zero", () => {
  assert.equal(step(5, -15), 5);
  assert.equal(step(15, -15), 15);
  assert.equal(step(1, -15), 1);
});

test("an explicit min floors the result without clobbering a smaller current value", () => {
  assert.equal(step(30, -15, { min: 15 }), 15);
  assert.equal(step(15, -15, { min: 15 }), 15);
  assert.equal(step(7, -15, { min: 5 }), 7);
  assert.equal(step(20, 15, { min: 15 }), 30);
});

test("minus never raises the value, even under an explicit min", () => {
  for (const min of [1, 5, 15]) {
    for (const current of [1, 5, 7, 15, 20, 31, 45, 50, 90]) {
      assert.ok(step(current, -15, { min }) <= current,
        `minus on ${current} with min ${min} raised it to ${step(current, -15, { min })}`);
    }
  }
});

test("every result stays a usable positive duration", () => {
  for (const delta of [15, -15]) {
    for (const current of [0, 1, 5, 15, 50]) {
      assert.ok(step(current, delta) >= 1, `${current} ${delta} produced a non-positive duration`);
    }
  }
});

test("non-numeric input degrades to the first grid rung", () => {
  assert.equal(step(undefined, 15), 15);
  assert.equal(step(NaN, 15), 15);
});
