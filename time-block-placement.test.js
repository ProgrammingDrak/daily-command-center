const test = require("node:test"), assert = require("node:assert/strict");
const P = require("./lib/time-block-placement");
const date = "2026-11-02", zone = "America/New_York";
const block = { id: "morning", name: "Deep work", start: "09:00", end: "12:00", activeDays: ["mon"] };
const task = (id, p = {}) => ({ id, type: "block", date, properties: { local_id: id, title: id, type: "task", duration: 30, ...p } });
function plan(extra = {}) { const parent = extra.parent || task("move"); return P.plan({ date, blockId: "morning", configured: [block], parent, members: [parent], rows: [], state: { schedule: { timeline: [] } }, zone, now: new Date("2026-10-28T14:00:00Z"), ...extra }); }
test("custom, repeated starts, inactive and invalid blocks preserve configured identity", () => {
  assert.deepEqual(P.choices([block, { ...block, id: "other", name: "Other" }, { ...block, id: "off", activeDays: [] }, { ...block, id: "disabled", enabled: false }, null, { ...block, start: "25:00" }], date).map(b => b.id), ["morning", "other"]);
  assert.deepEqual(P.choices([], date), []); assert.deepEqual(P.choices(undefined, date), []);
  assert.deepEqual(P.choices([block], "2026-11-03"), []);
  assert.throws(() => plan({ configured: [] }), /no longer available/);
});
test("append after existing work instead of filling earlier gaps; avoid calendar conflict", () => {
  const rows = [task("early", { start: "09:00", end: "09:30" }), task("late", { start: "10:00", end: "10:30" }), task("meeting", { type: "meeting", start: "10:30", end: "11:00" })];
  assert.deepEqual(plan({ rows }), { kind: "timed", start: "11:00", end: "11:30" });
  assert.deepEqual(rows[0].properties.start, "09:00");
});
test("full blocks and duration overflow fail without truncation", () => {
  assert.throws(() => plan({ rows: [task("full", { start: "09:00", end: "12:00" })] }), /Not enough space/);
  assert.throws(() => plan({ parent: task("move", { duration: 181 }) }), /181 minutes/);
  for (const duration of [0, null, -1, "bad"]) assert.throws(() => plan({ parent: task("move", { duration }) }), /positive task duration/);
  assert.deepEqual(plan({ parent: task("move", { duration: 180 }) }), { kind: "timed", start: "09:00", end: "12:00" });
});
test("same-block reselect excludes self and stays put; actual work is not moved", () => {
  const parent = task("move", { start: "09:30", end: "10:00", elapsedSeconds: 20 });
  assert.deepEqual(plan({ parent, rows: [parent, task("later", { start: "11:00", end: "11:30" })] }), { kind: "timed", start: "09:30", end: "10:00" });
  assert.equal(parent.properties.elapsedSeconds, 20);
  assert.throws(() => plan({ parent: task("move", { startedAt: "2026-11-02T14:00:00Z" }) }), /Pause running/);
});
test("today uses app timezone and future quarter hour, never past days", () => {
  assert.equal(plan({ now: new Date("2026-11-02T15:01:00Z") }).start, "10:15");
  assert.throws(() => plan({ now: new Date("2026-11-02T18:00:00Z") }), /Not enough space/);
  assert.throws(() => plan({ now: new Date("2026-11-03T14:00:00Z") }), /day has passed/);
});
test("timezone calendar instants and all-day fixed conflicts reserve space", () => {
  assert.equal(plan({ rows: [task("calendar", { type: "meeting", start: "2026-11-02T14:00:00Z", end: "2026-11-02T15:00:00Z" })] }).start, "10:00");
  assert.throws(() => plan({ rows: [task("calendar", { type: "meeting", all_day: true })] }), /Not enough space/);
});
test("DST transition, ambiguous minutes, overnight blocks and midnight overflow fail closed", () => {
  for (const [day, start, end] of [["2027-03-14", "01:30", "03:30"], ["2026-11-01", "01:00", "01:30"]]) assert.throws(() => plan({ date: day, configured: [{ ...block, start, end, activeDays: ["sun"] }] }), /clock/);
  assert.throws(() => plan({ configured: [{ ...block, start: "23:00", end: "01:00" }] }), /no longer available/);
  assert.throws(() => plan({ configured: [{ ...block, start: "23:30", end: "24:00" }] }), /Not enough space/);
});
test("nested work outside its parent budget fails instead of escaping the block", () => {
  const parent = task("move", { start: "08:00", end: "08:30" });
  assert.throws(() => plan({ parent, members: [parent, task("child", { start: "08:20", end: "09:00" })] }), /Nested task/);
});

test("quick tasks use their configured estimatedMinutes without inventing a duration", () => {
  const parent = task("quick", { estimatedMinutes: 45 }); delete parent.properties.duration;
  assert.equal(plan({ parent }).end, "09:45");
});
