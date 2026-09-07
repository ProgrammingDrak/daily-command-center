// Contract tests for durable, versioned BlockStore replay. Reschedules never
// expire now: the server's mutation version rejects stale intents safely, so a
// temporary outage cannot silently discard the user's requested move.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/block-store.js"), "utf8");

// Clock is frozen inside the vm so the 15-minute boundary is exercised
// deterministically instead of racing a live Date.now() with sub-ms margin.
const FIXED_NOW = Date.parse("2026-07-08T12:00:00.000Z");
class FrozenDate extends Date {
  constructor(...a) { a.length ? super(...a) : super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
}
FrozenDate.parse = Date.parse;
FrozenDate.UTC = Date.UTC;

// Fresh vm context per test: in-memory localStorage, controllable fetch, and
// the browser globals block-store.js touches at load (listeners are inert).
function makeStore(opts = {}) {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const fetchCalls = [];
  const context = {
    console,
    Date: FrozenDate,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) },
    navigator: { onLine: true },
    addEventListener: () => {},
    removeEventListener: () => {},
    document: { addEventListener: () => {}, visibilityState: "visible" },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (opts.fetchImpl) return opts.fetchImpl(url, init, fetchCalls);
      if (opts.fetchStatus && opts.fetchStatus !== 200) {
        return { ok: false, status: opts.fetchStatus, statusText: "err", json: async () => ({ error: "nope" }) };
      }
      if (opts.fetchReject) throw new TypeError("network down");
      return { ok: true, status: 200, json: async () => (opts.fetchBody || {}) };
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { store: context.window.blockStore, storage, fetchCalls, context };
}

const WAL_KEY = "blockstore-wal";
const DEAD_KEY = "blockstore-wal-dead-letter";
const wal = (storage) => JSON.parse(storage.get(WAL_KEY) || "[]");
const dead = (storage) => JSON.parse(storage.get(DEAD_KEY) || "[]");
const minsAgo = (m) => new Date(FIXED_NOW - m * 60 * 1000).toISOString();

function seedWal(storage, entries) {
  storage.set(WAL_KEY, JSON.stringify(entries));
}

test("replayWAL replays an old versioned reschedule instead of discarding the user's intent", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "reschedule", id: "b1", data: { targetDate: "2026-07-10", mutationVersion: 123 }, _walId: "w1", timestamp: minsAgo(60) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 1, "durable intent must reach the server");
  assert.equal(dead(storage).length, 0);
  assert.equal(wal(storage).length, 0, "replayed entry is removed on success");
});

test("replayWAL does not age-gate non-reschedule ops", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "update", id: "b2", data: { title: "x" }, _walId: "w2", timestamp: minsAgo(60) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 1, "old update still replays");
  assert.equal(dead(storage).length, 0);
});

test("rescheduleBlock drops the WAL entry and stamps e.permanent on a 400", async () => {
  const { store, storage } = makeStore({ fetchStatus: 400 });
  await assert.rejects(
    () => store.rescheduleBlock("b1", "2026-07-10", { fromDate: "2026-07-08" }),
    (e) => e.permanent === true
  );
  assert.equal(wal(storage).length, 0, "permanent rejection must not stay buffered");
});

test("rescheduleBlock keeps the WAL entry and marks non-permanent on a 401 auth blip", async () => {
  const { store, storage } = makeStore({ fetchStatus: 401 });
  await assert.rejects(
    () => store.rescheduleBlock("b1", "2026-07-10", {}),
    (e) => e.permanent === false
  );
  assert.equal(wal(storage).length, 1, "auth blip stays buffered for replay");
  assert.equal(wal(storage)[0].op, "reschedule");
});

test("rescheduleBlock keeps the WAL entry on a 503 and on a network error", async () => {
  const s503 = makeStore({ fetchStatus: 503 });
  await assert.rejects(() => s503.store.rescheduleBlock("b1", "2026-07-10", {}), (e) => !e.permanent);
  assert.equal(wal(s503.storage).length, 1);

  const sNet = makeStore({ fetchReject: true });
  await assert.rejects(() => sNet.store.rescheduleBlock("b1", "2026-07-10", {}), (e) => !e.permanent);
  assert.equal(wal(sNet.storage).length, 1);
});

test("rescheduleBlock stamps every move with a positive monotonic mutation version", async () => {
  const { store, fetchCalls } = makeStore();
  await store.rescheduleBlock("b1", "2026-07-10", {});
  await store.rescheduleBlock("b1", "2026-07-11", {});
  const bodies = fetchCalls.map(call => JSON.parse(call.init.body));
  assert.ok(Number.isSafeInteger(bodies[0].mutationVersion));
  assert.ok(bodies[1].mutationVersion > bodies[0].mutationVersion);
});

test("completion mutations stay in the WAL across a network failure and replay", async () => {
  const failed = makeStore({ fetchReject: true });
  await failed.store.setTaskCompletions("day-root-1", [{ id: "task-1", completed: true }]);
  assert.equal(wal(failed.storage).length, 1);
  assert.equal(wal(failed.storage)[0].op, "completion");

  failed.context.fetch = async (url, init) => {
    failed.fetchCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: "day-root-1", type: "day_root", properties: { _done: { ids: ["task-1"] } } }) };
  };
  await failed.store.replayWAL();
  assert.equal(wal(failed.storage).length, 0);
});

test("day-root property patches are durable without replacing completion state", async () => {
  const failed = makeStore({ fetchReject: true });
  await failed.store.patchBlockProperties("day-root-1", { _pomoState: { running: true } });
  assert.equal(wal(failed.storage).length, 1);
  assert.equal(wal(failed.storage)[0].op, "properties-patch");
  assert.deepEqual(wal(failed.storage)[0].data.patch, { _pomoState: { running: true } });
});

test("an older completion response cannot overwrite a newer optimistic click", async () => {
  const pending = [];
  const root = { id: "root", type: "day_root", date: "2026-08-08", properties: { date: "2026-08-08", _done: { ids: [], at: {}, mutations: {} } } };
  const harness = makeStore({
    fetchImpl: async (url) => {
      if (url.startsWith("/api/blocks?date=")) return { ok: true, status: 200, json: async () => [root] };
      return new Promise(resolve => pending.push(resolve));
    }
  });
  await harness.store.loadDay("2026-08-08");
  const first = harness.store.setTaskCompletions("root", [{ id: "task", completed: true }]);
  const second = harness.store.setTaskCompletions("root", [{ id: "task", completed: false }]);
  const bodies = harness.fetchCalls.slice(1).map(call => JSON.parse(call.init.body));
  const v1 = bodies[0].changes[0].version;
  const v2 = bodies[1].changes[0].version;
  pending[1]({ ok: true, status: 200, json: async () => ({ ...root, properties: { ...root.properties, _done: { ids: [], at: {}, mutations: { task: v2 } } } }) });
  await second;
  pending[0]({ ok: true, status: 200, json: async () => ({ ...root, properties: { ...root.properties, _done: { ids: ["task"], at: { task: new Date(v1).toISOString() }, mutations: { task: v1 } } } }) });
  await first;
  assert.equal(harness.store.get("root").properties._done.ids.includes("task"), false);
  assert.equal(harness.store.get("root").properties._done.mutations.task, v2);
});
