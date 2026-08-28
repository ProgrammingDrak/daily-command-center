// Route-level contract for /api/schedule/settings, in the style of
// waiting-routes.test.js: mount the real module against a fake app + ctx and drive the
// captured handlers. The storage logic is covered in schedule-settings-store.test.js;
// what is bare without this is the thin mapping layer -- the 400 on a bad value, and the
// cross-tab broadcast, which is load-bearing and exactly the kind of line a refactor
// drops silently.
const test = require("node:test");
const assert = require("node:assert/strict");

const storePath = require.resolve("./schedule-settings-store");
const routePath = require.resolve("./routes/schedule-settings");

function mount({ store }) {
  // Swap the store for a fake, then load the route fresh so it binds to it.
  delete require.cache[routePath];
  const real = require.cache[storePath];
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: store };
  const routes = {};
  const app = {
    get: (p, h) => { routes["GET " + p] = h; },
    patch: (p, h) => { routes["PATCH " + p] = h; },
    delete: (p, h) => { routes["DELETE " + p] = h; },
  };
  const broadcasts = [];
  require(routePath)(app, { broadcast: (...a) => broadcasts.push(a) });
  if (real) require.cache[storePath] = real; else delete require.cache[storePath];
  delete require.cache[routePath];
  return { routes, broadcasts };
}

function res() {
  const out = { code: 200, body: null };
  return {
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    out,
  };
}

test("GET returns the store's merged settings", async () => {
  const { routes } = mount({ store: { getScheduleSettings: async () => ({ dayStart: "08:00", _source: "user" }) } });
  const r = res();
  await routes["GET /api/schedule/settings"]({ workspaceId: "ws-1" }, r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.dayStart, "08:00");
});

test("PATCH writes, answers with the merged value, and broadcasts on the day-state channel", async () => {
  const seen = [];
  const { routes, broadcasts } = mount({
    store: {
      updateScheduleSettings: async (ws, userId, patch) => { seen.push([ws, userId, patch]); return { dayStart: "10:00", _source: "user" }; },
    },
  });
  const r = res();
  await routes["PATCH /api/schedule/settings"](
    { workspaceId: "ws-1", session: { userId: 7 }, body: { dayStart: "10:00" } }, r
  );
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.dayStart, "10:00");
  assert.deepEqual(seen, [["ws-1", 7, { dayStart: "10:00" }]]);
  // dcc-state-changed, NOT blocks-changed: only that channel refetches /api/state/day,
  // which is the one path that re-reads schedule.day_start in another tab.
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0][0], "dcc-state-changed");
  assert.equal(broadcasts[0][2], "ws-1");
});

test("a store rejection becomes a 400, not a 500, and broadcasts nothing", async () => {
  const { routes, broadcasts } = mount({
    store: { updateScheduleSettings: async () => { throw new Error('Invalid dayStart (want "HH:MM", 00:00 through 12:00)'); } },
  });
  const r = res();
  await routes["PATCH /api/schedule/settings"](
    { workspaceId: "ws-1", session: { userId: 7 }, body: { dayStart: "25:00" } }, r
  );
  assert.equal(r.out.code, 400);
  assert.match(r.out.body.error, /Invalid dayStart/);
  assert.equal(broadcasts.length, 0);
});

test("DELETE resets and broadcasts the reset on the same channel", async () => {
  const { routes, broadcasts } = mount({
    store: { resetScheduleSettings: async () => ({ dayStart: "07:00", _source: "defaults" }) },
  });
  const r = res();
  await routes["DELETE /api/schedule/settings"]({ workspaceId: "ws-1" }, r);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.dayStart, "07:00");
  assert.equal(broadcasts[0][0], "dcc-state-changed");
  assert.equal(broadcasts[0][1].action, "reset");
});

test("a GET failure is a 500 and does not leak a stack", async () => {
  const { routes } = mount({ store: { getScheduleSettings: async () => { throw new Error("connection terminated"); } } });
  const r = res();
  await routes["GET /api/schedule/settings"]({ workspaceId: "ws-1" }, r);
  assert.equal(r.out.code, 500);
  assert.equal(r.out.body.error, "connection terminated");
});
