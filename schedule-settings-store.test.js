// Contract tests for schedule-settings-store.js — the start-of-day setting.
// blockDB is injected (the store takes a `deps` argument precisely so this suite
// never reaches a real pool), so these run without Postgres.
const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("./schedule-settings-store");

// A blockDB fake with the three methods the store touches.
function makeFakeBlockDB(rows = []) {
  const state = { rows: rows.slice(), created: [], updated: [], deleted: [] };
  return {
    state,
    async getBlocksByKind(kind, workspaceId) {
      return state.rows.filter((r) => (r.properties || {}).kind === kind && r.workspace_id === workspaceId);
    },
    async createBlock(row) {
      const created = { id: "blk-" + (state.rows.length + 1), ...row };
      state.created.push(created);
      state.rows.push(created);
      return created;
    },
    async updateBlock(id, patch) {
      const row = state.rows.find((r) => r.id === id);
      Object.assign(row, patch);
      state.updated.push({ id, patch });
      return row;
    },
    async deleteBlock(id) {
      state.deleted.push(id);
      state.rows = state.rows.filter((r) => r.id !== id);
    },
  };
}
const deps = (fake) => ({ blockDB: fake });

test("an unset workspace reads the 07:00 default", async () => {
  const fake = makeFakeBlockDB();
  assert.deepEqual(await store.getScheduleSettings("ws-1", deps(fake)), {
    dayStart: "07:00", _source: "defaults", _block_id: null,
  });
  assert.equal(await store.getDayStartMinutes("ws-1", deps(fake)), 420);
});

test("a write creates one block, and reads back as the user's value", async () => {
  const fake = makeFakeBlockDB();
  const out = await store.updateScheduleSettings("ws-1", 7, { dayStart: "09:30" }, deps(fake));
  assert.equal(out.dayStart, "09:30");
  assert.equal(out._source, "user");
  assert.equal(fake.state.created.length, 1);
  assert.equal(fake.state.created[0].properties.kind, "schedule_settings");
  assert.equal(fake.state.created[0].workspace_id, "ws-1");
  assert.equal(fake.state.created[0].user_id, 7);
  assert.equal(await store.getDayStartMinutes("ws-1", deps(fake)), 570);
});

test("a second write UPDATES the existing block rather than adding another", async () => {
  const fake = makeFakeBlockDB();
  await store.updateScheduleSettings("ws-1", 7, { dayStart: "09:30" }, deps(fake));
  await store.updateScheduleSettings("ws-1", 7, { dayStart: "08:00" }, deps(fake));
  assert.equal(fake.state.created.length, 1);
  assert.equal(fake.state.updated.length, 1);
  assert.equal((await store.getScheduleSettings("ws-1", deps(fake))).dayStart, "08:00");
});

// Validation lives in ONE place (day-context.js normalizeDayStart). The store's job
// is to refuse rather than persist, so the route can answer 400.
test("an illegal value throws and persists nothing", async () => {
  const fake = makeFakeBlockDB();
  for (const bad of ["7:00", "25:00", "12:01", "", null, undefined, 420, {}]) {
    await assert.rejects(
      () => store.updateScheduleSettings("ws-1", 7, { dayStart: bad }, deps(fake)),
      /Invalid dayStart/
    );
  }
  assert.equal(fake.state.created.length, 0);
});

// A broken stored value must not brick auto-placement — it reads as the default.
test("a malformed STORED value degrades to the default instead of throwing", async () => {
  const fake = makeFakeBlockDB([
    { id: "b1", workspace_id: "ws-1", properties: { kind: "schedule_settings", dayStart: "garbage" } },
  ]);
  const out = await store.getScheduleSettings("ws-1", deps(fake));
  assert.equal(out.dayStart, "07:00");
  assert.equal(out._source, "defaults");
});

test("settings are scoped to the workspace", async () => {
  const fake = makeFakeBlockDB();
  await store.updateScheduleSettings("ws-1", 7, { dayStart: "10:00" }, deps(fake));
  assert.equal((await store.getScheduleSettings("ws-1", deps(fake))).dayStart, "10:00");
  assert.equal((await store.getScheduleSettings("ws-2", deps(fake))).dayStart, "07:00");
});

test("reset deletes the override and is idempotent", async () => {
  const fake = makeFakeBlockDB();
  await store.updateScheduleSettings("ws-1", 7, { dayStart: "10:00" }, deps(fake));
  assert.equal((await store.resetScheduleSettings("ws-1", deps(fake))).dayStart, "07:00");
  assert.equal(fake.state.deleted.length, 1);
  assert.equal((await store.resetScheduleSettings("ws-1", deps(fake))).dayStart, "07:00");
  assert.equal(fake.state.deleted.length, 1, "second reset is a no-op");
});

// The route wiring in routes/blocks.js hands the store whatever blockDB it was given,
// including harness fakes that predate this feature.
test("a blockDB without getBlocksByKind reads as the default, not a crash", async () => {
  const out = await store.getScheduleSettings("ws-1", { blockDB: {} });
  assert.equal(out.dayStart, "07:00");
});
