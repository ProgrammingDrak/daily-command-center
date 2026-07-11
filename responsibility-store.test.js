// Tests for responsibility-store.js (dcc-improvements P8).
// Two layers, matching the module:
//   1. Pure helpers — scoring, cadence, time math, alert parsing, task-props —
//      tested directly, no DB or HTTP.
//   2. Factory operations — tested against a hand-rolled fake blockDB that
//      records calls, so we can assert the SLOT + APPLY-FORWARD behaviour and,
//      critically, that apply-forward preserves the P2 atomicity shape (gather
//      every mutation into ONE blockDB.batchOp, never per-op autocommits).

const test = require("node:test");
const assert = require("node:assert/strict");

const createResponsibilityStore = require("./responsibility-store");
const {
  cadenceDays, responsibilityScore, preferredCompletionDue,
  firstFreeSlot, minutesToHHMM, hhmmToMinutes,
  buildResponsibilityTaskProps, parseOffersAmpAlert, normalizeResponsibility,
} = require("./responsibility-store");

// ── Pure: cadence ──
test("cadenceDays maps named + numeric + as_needed cadences", () => {
  assert.equal(cadenceDays({ cadence: "daily" }), 1);
  assert.equal(cadenceDays({ cadence: "weekly" }), 7);
  assert.equal(cadenceDays({ cadence: "biweekly" }), 14);
  assert.equal(cadenceDays({ cadence: "monthly" }), 30);
  assert.equal(cadenceDays({ cadence: "quarterly" }), 90);
  assert.equal(cadenceDays({ cadenceDays: 3 }), 3);          // explicit number wins
  assert.equal(cadenceDays({ cadence: "every 5 days" }), 5); // regex fallback
  assert.equal(cadenceDays({ cadence: "as_needed" }), 0);
  assert.equal(cadenceDays({}), 7);                          // default weekly
});

// ── Pure: scoring ──
test("responsibilityScore: archived/done score 0", () => {
  assert.equal(responsibilityScore({ status: "archived", cadence: "daily" }), 0);
  assert.equal(responsibilityScore({ status: "done", cadence: "daily" }), 0);
  assert.equal(responsibilityScore(null), 0);
});

test("responsibilityScore: overdue is clamped to 100", () => {
  const at = new Date("2026-07-11T00:00:00");
  const score = responsibilityScore({ cadence: "daily", lastCompletedAt: "2026-07-01T00:00:00" }, at);
  assert.equal(score, 100); // 10 elapsed / 1-day cadence = 1000 -> clamp 100
});

test("responsibilityScore: partial elapse + boost, no double-past-100", () => {
  const at = new Date("2026-07-11T00:00:00");
  // 3 elapsed / 7-day cadence = round(42.857) = 43, +20 boost = 63
  const score = responsibilityScore({ cadence: "weekly", createdAt: "2026-07-08T00:00:00", boost: 20 }, at);
  assert.equal(score, 63);
});

test("responsibilityScore: as_needed with no preferred cadence is 0", () => {
  assert.equal(responsibilityScore({ cadence: "as_needed" }, new Date("2026-07-11T00:00:00")), 0);
});

// ── Pure: preferred completion ──
test("preferredCompletionDue: weekly matches only on the target weekday", () => {
  const at = new Date(2026, 6, 11); // local, so getDay() is stable
  const today = at.getDay();
  assert.equal(preferredCompletionDue({ preferredCompletionCadence: "weekly", preferredDayOfWeek: today }, at), true);
  assert.equal(preferredCompletionDue({ preferredCompletionCadence: "weekly", preferredDayOfWeek: (today + 1) % 7 }, at), false);
});

test("preferredCompletionDue: none/absent is false", () => {
  assert.equal(preferredCompletionDue({}, new Date(2026, 6, 11)), false);
  assert.equal(preferredCompletionDue({ preferredCompletionCadence: "none" }, new Date(2026, 6, 11)), false);
});

test("responsibilityScore: preferred-due floor overrides a low elapsed base", () => {
  const at = new Date(2026, 6, 11);
  const today = at.getDay();
  // Fresh (elapsed ~0 -> base 0) but preferred-due today -> floored at 85.
  const score = responsibilityScore(
    { cadence: "weekly", createdAt: at.toISOString(), preferredCompletionCadence: "weekly", preferredDayOfWeek: today },
    at
  );
  assert.equal(score, 85);
});

// ── Pure: time math + free-slot finder ──
test("hhmm <-> minutes round-trips", () => {
  assert.equal(hhmmToMinutes("09:30"), 570);
  assert.equal(minutesToHHMM(570), "09:30");
  assert.equal(hhmmToMinutes("bad"), 0);
});

test("firstFreeSlot: places before a later blocker, jumps past an overlapping one, null when no room", () => {
  assert.equal(firstFreeSlot(540, 30, [], 1020), 540);                         // empty day
  assert.equal(firstFreeSlot(540, 30, [{ s: 600, e: 660 }], 1020), 540);       // fits before the blocker
  assert.equal(firstFreeSlot(540, 60, [{ s: 540, e: 600 }], 1020), 600);       // overlaps start -> jump past
  assert.equal(firstFreeSlot(1000, 120, [], 1020), null);                      // past dayEnd + 60 grace
});

test("firstFreeSlot: unsorted blockers are handled (sorted internally)", () => {
  assert.equal(firstFreeSlot(540, 30, [{ s: 660, e: 720 }, { s: 540, e: 600 }], 1020), 600);
});

// ── Pure: task-props ──
test("buildResponsibilityTaskProps: urgent + explicit priority + slot times", () => {
  const resp = { id: "r1", properties: { title: "Do thing", area: "ops", domain: "professional", capacityBucket: "work_admin" } };
  const urgent = buildResponsibilityTaskProps(resp, { duration: 30, slot: 600, localId: "l1", sourceProps: { urgent: true } });
  assert.equal(urgent.priority, "High");
  assert.equal(urgent.kind, "responsibility_task");
  assert.equal(urgent.start, "10:00");
  assert.equal(urgent.end, "10:30");
  assert.equal(urgent.responsibilityId, "r1");
  const explicit = buildResponsibilityTaskProps(resp, { duration: 15, slot: 540, localId: "l2", sourceProps: { priority: "Low", title: "Override" } });
  assert.equal(explicit.priority, "Low");
  assert.equal(explicit.title, "Override");
});

test("buildResponsibilityTaskProps: score-derived priority ladder when no urgent/explicit priority", () => {
  // as_needed => score is exactly the boost (deterministic, no elapsed term), so
  // this pins the 90/60 thresholds of the default priority branch.
  const mk = (boost) => ({ id: "r", properties: { title: "T", cadence: "as_needed", boost } });
  const pri = (boost) => buildResponsibilityTaskProps(mk(boost), { duration: 30, slot: 540, localId: "x", sourceProps: {} }).priority;
  assert.equal(pri(95), "High");   // score >= 90
  assert.equal(pri(70), "Medium"); // 60 <= score < 90
  assert.equal(pri(0), "Low");     // score < 60
});

// ── Pure: alert parsing ──
test("parseOffersAmpAlert: extracts urls + builds alertKey, null on non-match", () => {
  const text = "Offers AMP Error: New deal entered the AMP with zero expected matches\n" +
    "Address: 123 Main St, Austin TX\n" +
    "AMP: https://amp.listwithclever.dev/deals/456\n" +
    "https://app.hubspot.com/contacts/3298701/record/0-3/789\n" +
    "Config lookup: TX / cash";
  const alert = parseOffersAmpAlert(text);
  assert.equal(alert.alertType, "offers_amp_zero_expected_matches");
  assert.equal(alert.ampUrl, "https://amp.listwithclever.dev/deals/456");
  assert.equal(alert.hubspotUrl, "https://app.hubspot.com/contacts/3298701/record/0-3/789");
  assert.equal(alert.alertKey, alert.hubspotUrl); // hubspot url preferred as the key
  assert.equal(parseOffersAmpAlert("just a normal note"), null);
});

test("normalizeResponsibility stamps importanceScore into properties", () => {
  const out = normalizeResponsibility({ id: "r", properties: { cadence: "daily", lastCompletedAt: "2026-01-01T00:00:00" } });
  assert.equal(typeof out.properties.importanceScore, "number");
  assert.equal(out.properties.importanceScore, 100);
});

// ── Factory: fake blockDB ──
function makeFakeBlockDB(seed = {}) {
  const calls = { batchOp: [], createItineraryTask: [], createBlock: [], updateBlock: [], ensureDayRoot: [], getBlocksByDate: [] };
  const state = {
    blocksByDate: seed.blocksByDate || {},
    futureDates: seed.futureDates || [],
    bySlug: seed.bySlug || {},
    responsibilities: seed.responsibilities || [],
  };
  const api = {
    calls, state,
    async getResponsibilityBlocks() { return state.responsibilities; },
    async findResponsibilityBySlug(slug) { return state.bySlug[slug] || null; },
    async getBlocksByDate(date) { calls.getBlocksByDate.push(date); return state.blocksByDate[date] || []; },
    async getFutureDatesWithBlocks() { return state.futureDates; },
    async getBlock(id) {
      if (String(id).startsWith("root-")) return { id, properties: {} };
      return (seed.blocks && seed.blocks[id]) || null;
    },
    async createBlock(payload) { calls.createBlock.push(payload); return { id: "new-" + calls.createBlock.length, ...payload }; },
    async updateBlock(id, fields) { calls.updateBlock.push({ id, fields }); return { id, ...fields }; },
    async createItineraryTask(args) { calls.createItineraryTask.push(args); if (args.ensureRoot !== false) await api.ensureDayRoot(args.date); return { id: "task-" + calls.createItineraryTask.length, properties: args.properties, date: args.date }; },
    async ensureDayRoot(date) { calls.ensureDayRoot.push(date); return "root-" + date; },
    async batchOp(ops) { calls.batchOp.push(ops); return { batchId: "b", blocks: ops.map((o, i) => o.op === "delete" ? { id: o.id, deleted_at: "now" } : { id: o.id || ("c" + i) }) }; },
  };
  return api;
}

function makeStore(fake) {
  return createResponsibilityStore({
    blockDB: fake,
    getScheduleBlocks: async () => [{ blockType: "work", start: "09:00", end: "17:00" }],
    getTodayStr: () => "2026-07-11",
    assertBlockOwnership: () => {},
  });
}

// ── Factory: scheduling ──
test("scheduleResponsibilityTask: creates one itinerary task at the first free slot + attaches default subtasks", async () => {
  const fake = makeFakeBlockDB({ blocksByDate: { "2026-07-12": [] } });
  const store = makeStore(fake);
  const responsibility = { id: "r1", properties: { title: "Task", estimatedMinutes: 30, kind: "responsibility_item" } };
  const out = await store.scheduleResponsibilityTask({ responsibility, date: "2026-07-12", userId: 1, workspaceId: "ws-1" });
  assert.equal(out.created, true);
  assert.equal(fake.calls.createItineraryTask.length, 1);
  const props = fake.calls.createItineraryTask[0].properties;
  assert.equal(props.kind, "responsibility_task");
  assert.equal(props.start, "09:00"); // future day -> starts at dayStart
  assert.equal(props.duration, 30);
  // default subtasks (none configured -> the generic three) get attached to the root
  assert.equal(fake.calls.ensureDayRoot.length, 1);
  assert.equal(fake.calls.updateBlock.length, 1);
  assert.ok(fake.calls.updateBlock[0].fields.properties._subtasks);
});

test("scheduleResponsibilityTask: existing open task + not forced -> duplicate, no create", async () => {
  const fake = makeFakeBlockDB({
    blocksByDate: { "2026-07-12": [{ id: "x", properties: { responsibilityId: "r1", kind: "responsibility_task" } }] },
  });
  const store = makeStore(fake);
  const out = await store.scheduleResponsibilityTask({
    responsibility: { id: "r1", properties: { title: "T", kind: "responsibility_item" } },
    date: "2026-07-12", userId: 1, workspaceId: "ws-1",
  });
  assert.equal(out.duplicate, true);
  assert.equal(out.created, false);
  assert.equal(fake.calls.createItineraryTask.length, 0);
});

// ── Factory: upsert ──
test("upsertResponsibility: new slug -> createBlock; existing slug -> updateBlock preserving createdAt", async () => {
  const fresh = makeFakeBlockDB();
  const s1 = makeStore(fresh);
  const created = await s1.upsertResponsibility({ properties: { title: "Weekly review" }, userId: 1, workspaceId: "ws-1" });
  assert.equal(fresh.calls.createBlock.length, 1);
  assert.equal(fresh.calls.updateBlock.length, 0);
  assert.equal(typeof created.properties.importanceScore, "number"); // normalized

  const existingBlock = { id: "e1", properties: { slug: "weekly-review", title: "old", createdAt: "2020-01-01T00:00:00Z" } };
  const withExisting = makeFakeBlockDB({ bySlug: { "weekly-review": existingBlock } });
  const s2 = makeStore(withExisting);
  await s2.upsertResponsibility({ properties: { title: "Weekly review", detail: "x" }, userId: 1, workspaceId: "ws-1" });
  assert.equal(withExisting.calls.updateBlock.length, 1);
  assert.equal(withExisting.calls.createBlock.length, 0);
  assert.equal(withExisting.calls.updateBlock[0].fields.properties.createdAt, "2020-01-01T00:00:00Z");
});

// ── Factory: apply-forward — the P2 atomicity guarantee ──
test("applyForwardDiff: gathers mutations from MULTIPLE future days into ONE batchOp; skips drifted days; preserves merged keys", async () => {
  const fake = makeFakeBlockDB({
    // Two matching days + one drifted day: the batch must contain ops from BOTH
    // matching days, proving a single cross-day gather (not one batch per day —
    // that regression would still produce one batchOp on a single-mutating-day
    // fixture, which is why the fixture mutates two distinct days).
    futureDates: ["2026-07-12", "2026-07-13", "2026-07-14"],
    blocksByDate: {
      "2026-07-12": [{ id: "b1", type: "block", parent_id: null, properties: { name: "Deep Work", blockType: "work", start: "09:00", end: "11:00" } }],
      // start drifted -> customized, must be skipped
      "2026-07-13": [{ id: "b2", type: "block", parent_id: null, properties: { name: "Deep Work", blockType: "work", start: "08:00", end: "10:00" } }],
      "2026-07-14": [{ id: "b3", type: "block", parent_id: null, properties: { name: "Deep Work", blockType: "work", start: "09:00", end: "11:00" } }],
    },
  });
  const store = makeStore(fake);
  const diff = {
    updates: [{
      match: { name: "Deep Work", blockType: "work" },
      originalValues: { name: "Deep Work", blockType: "work", start: "09:00", end: "11:00" },
      newValues: { end: "12:00" },
    }],
  };
  const result = await store.applyForwardDiff({ fromDate: "2026-07-11", diff, userId: 1, workspaceId: "ws-1" });

  // ATOMICITY: exactly ONE batchOp, carrying ops from BOTH matching days.
  // (A per-day-batch regression would produce batchOp.length === 2 here.)
  assert.equal(fake.calls.batchOp.length, 1);
  const ops = fake.calls.batchOp[0];
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map(o => o.id).sort(), ["b1", "b3"]);
  assert.ok(ops.every(o => o.op === "update"));
  // merge must carry the untouched original keys through, not just newValues
  assert.equal(ops[0].properties.end, "12:00");
  assert.equal(ops[0].properties.name, "Deep Work");
  assert.equal(ops[0].properties.start, "09:00");

  assert.equal(result.daysUpdated, 2);
  assert.equal(result.daysSkipped, 1);
  assert.equal(result.blocksUpdated, 2);
  assert.deepEqual(result.skippedDates, ["2026-07-13"]);
});

test("applyForwardDiff: creates (with same-name dedupe) + deletes ride the same single batchOp", async () => {
  const fake = makeFakeBlockDB({
    futureDates: ["2026-07-12"],
    blocksByDate: {
      "2026-07-12": [
        { id: "del1", type: "block", parent_id: null, properties: { name: "Old Block", blockType: "break", start: "12:00", end: "13:00" } },
        { id: "dup1", type: "block", parent_id: null, properties: { name: "Exists", blockType: "work" } },
      ],
    },
  });
  const store = makeStore(fake);
  const diff = {
    creates: [
      { block: { properties: { name: "New Block" }, sort_order: 0 } },
      { block: { properties: { name: "Exists" } } }, // same-name -> deduped/skipped
    ],
    deletes: [{
      match: { name: "Old Block", blockType: "break" },
      originalValues: { name: "Old Block", blockType: "break", start: "12:00", end: "13:00" },
    }],
  };
  const result = await store.applyForwardDiff({ fromDate: "2026-07-11", diff, userId: 1, workspaceId: "ws-1" });

  assert.equal(fake.calls.batchOp.length, 1);
  const ops = fake.calls.batchOp[0];
  const creates = ops.filter(o => o.op === "create");
  const deletes = ops.filter(o => o.op === "delete");
  assert.equal(creates.length, 1);                 // "Exists" was deduped
  assert.equal(creates[0].properties.name, "New Block");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].id, "del1");
  assert.equal(result.blocksCreated, 1);
  assert.equal(result.blocksDeleted, 1);
});

test("applyForwardDiff: empty diff makes NO batchOp call", async () => {
  const fake = makeFakeBlockDB({ futureDates: ["2026-07-12"], blocksByDate: { "2026-07-12": [] } });
  const store = makeStore(fake);
  const result = await store.applyForwardDiff({ fromDate: "2026-07-11", diff: {}, userId: 1, workspaceId: "ws-1" });
  assert.equal(fake.calls.batchOp.length, 0);
  assert.equal(result.daysUpdated, 0);
});
