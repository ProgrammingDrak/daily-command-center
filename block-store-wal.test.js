// Contract tests for the blockstore WAL's reschedule hardening: the 15-minute
// stale-replay gate in replayWAL() (guards the pre-#167 reversal, where a
// buffered reschedule replayed long after the user moved on and yanked the
// task back) and the permanence split in rescheduleBlock() (400/404 drop the
// WAL entry so a clone fallback can't double-move; 401/403/5xx/network stay
// buffered for replay). Harness pattern: recalc-times.test.js (raw source in
// a node:vm context with stubbed globals).
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

test("replayWAL dead-letters a reschedule entry older than 15 minutes without replaying it", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "reschedule", id: "b1", data: { targetDate: "2026-07-10" }, _walId: "w1", timestamp: minsAgo(16) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 0, "stale reschedule must not hit the server");
  assert.equal(wal(storage).length, 0, "entry leaves the WAL");
  assert.equal(dead(storage).length, 1, "entry lands in the dead letter");
  assert.match(dead(storage)[0].reason, /stale reschedule/);
});

test("replayWAL replays a reschedule exactly at the 15-minute boundary (gate is strictly older-than)", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "reschedule", id: "b1", data: { targetDate: "2026-07-10" }, _walId: "w1", timestamp: minsAgo(15) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 1, "boundary-age entry still replays");
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
