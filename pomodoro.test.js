const test = require("node:test"),
  assert = require("node:assert/strict"),
  M = require("./public/js/pomodoro-model");
const make = () => M.create({ id: "t", title: "Write" }, "plan");
test("four 20-minute sections require objectives and explicit progression", () => {
  let p = make(),
    now = 1000;
  assert.throws(() => M.change(p, "start", p.objectives, now), /objective/);
  for (let i = 0; i < 4; i++) {
    const objectives = [...p.objectives];
    objectives[i] = "Goal " + i;
    p = M.change(p, "start", objectives, now);
    assert.equal(p.deadline, now + 1200000);
    assert.throws(() => M.change(p, "start", objectives, now), /already started/);
    assert.throws(() => M.change(p, "next", objectives, now + 1199999), /Wait/);
    assert.equal(M.remaining(p, now + 1200000), 0);
    now += 1200000;
    p = M.change(p, "next", objectives, now);
    assert.equal(p.section, i + 1);
    assert.equal(p.status, i === 3 ? "complete" : "ready");
  }
  assert.ok(M.valid(p));
  assert.throws(() => M.change(p, "start", p.objectives, now), /complete/);
});
test("pause/resume, future edits, serialization and sleep preserve exact remaining time", () => {
  let p = M.change(make(), "start", ["First", "", "", ""], 100);
  p = M.change(p, "pause", p.objectives, 50100);
  assert.equal(p.remaining, 1150000);
  p = M.change(p, "save", ["First", "Second", "", ""], 999999);
  assert.equal(p.remaining, 1150000);
  p = M.change(p, "start", p.objectives, 1000000);
  assert.equal(p.deadline, 2150000);
  p = M.change(p, "save", ["First", "New second", "", ""], 1001000);
  assert.equal(p.deadline, 2150000);
  p = JSON.parse(JSON.stringify(p));
  assert.ok(M.valid(p));
  assert.equal(M.remaining(p, 1001000), 1149000);
  assert.ok(M.elapsed(p, 999999999));
  assert.equal(p.section, 0);
  assert.throws(() => M.change(p, "pause", p.objectives, 999999999), /no longer/);
});
test("malformed plans and objective bounds are rejected without mutating the source", () => {
  const p = make();
  assert.ok(M.valid(p));
  for (const bad of [
    null,
    {},
    { ...p, section: 4 },
    { ...p, remaining: -1 },
    { ...p, objectives: [] },
    { ...p, status: "running", deadline: NaN }
  ])
    assert.ok(!M.valid(bad));
  assert.throws(() => M.change(p, "save", ["x".repeat(501), "", "", ""], 0));
  assert.equal(p.revision, 0);
});
test("ending early preserves the task identity without pretending all sections elapsed", () => {
  const p = M.change(make(), "start", ["First", "", "", ""], 100);
  const ended = M.change(p, "end", p.objectives, 200);
  assert.equal(ended.status, "cancelled");
  assert.equal(ended.section, 0);
  assert.equal(ended.taskId, "t");
  assert.ok(M.valid(ended));
  assert.throws(() => M.change(ended, "start", ended.objectives, 300), /complete/);
});

test("expired section cannot persist a blank current objective", () => {
  const p = M.change(make(), "start", ["First", "", "", ""], 100);
  for (const action of ["save", "next", "end"]) {
    assert.throws(() => M.change(p, action, ["", "Next", "", ""], 1200100), /Keep an objective/);
    assert.ok(M.valid(p));
  }
  const next = M.change(p, "next", p.objectives, 1200100);
  assert.ok(M.valid(next));
});
