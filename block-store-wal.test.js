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
      // fetchBodyFn lets a test answer with something DERIVED from the request — needed
      // for the client-minted-id cases, where the server echoes back the id the client
      // sent and a fixed fetchBody could not match it. `opts` is read at call time, so a
      // test can also mutate these between phases (send fails, then reconnect succeeds).
      const body = opts.fetchBodyFn ? opts.fetchBodyFn(url, init) : (opts.fetchBody || {});
      return { ok: true, status: 200, json: async () => body };
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

test("replayWAL does not age-gate an update, and a create well inside 24h still replays", async () => {
  // The reschedule gate is 15 minutes and the create gate is 24 hours (B2); an update
  // has no gate at all. A create at 60 minutes must sail through both, or the create
  // cap would be silently doing the reschedule cap's job.
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [
    { op: "update", id: "b2", data: { title: "x" }, _walId: "w2", timestamp: minsAgo(60) },
    { op: "create", data: { id: "c1", type: "task", properties: {} }, _walId: "w3", timestamp: minsAgo(60) },
  ]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 2, "old update and hour-old create both still replay");
  assert.equal(dead(storage).length, 0);
});

// ── B2: client-minted ids, create replay semantics, batch permanence ──

const hoursAgo = (h) => new Date(FIXED_NOW - h * 60 * 60 * 1000).toISOString();

test("createBlock mints the row id itself and caches under that final id", async () => {
  const { store, fetchCalls } = makeStore({
    fetchBodyFn: (_url, init) => ({ ...JSON.parse(init.body), created_at: "x", updated_at: "x", deleted_at: null }),
  });
  const block = await store.createBlock("task", { title: "Write the thing" }, { date: "2026-07-08" });
  const sent = JSON.parse(fetchCalls[0].init.body);
  assert.ok(sent.id, "the POST carries a client-minted id");
  assert.ok(!String(sent.id).startsWith("tmp-"), "and it is a real id, not a placeholder to be swapped");
  assert.equal(block.id, sent.id);
  assert.equal(store.get(sent.id).id, sent.id, "the row is cached under the id it will keep forever");
});

test("an ack-lost create replays with the SAME id, which is what stops it duplicating", async () => {
  // The duplicate generator this phase exists to kill: walRemove only runs on ack, so a
  // create the server COMMITTED but whose ack was lost stays buffered and replays. When
  // the server minted the id, the replay got a fresh uuid and nothing linked the two
  // rows — one lost ack, two tasks. A client-minted id makes the replay land on the
  // same primary key, where A3's ON CONFLICT (id) DO NOTHING absorbs it.
  const opts = { fetchReject: true };
  const { store, storage, fetchCalls } = makeStore(opts);

  const optimistic = await store.createBlock("task", { title: "Write the thing" }, { date: "2026-07-08" });
  assert.equal(wal(storage).length, 1, "a lost ack leaves the create buffered");
  const firstSent = JSON.parse(fetchCalls[0].init.body);
  assert.equal(optimistic.id, firstSent.id, "cache and payload agree on the id");
  assert.equal(wal(storage)[0].data.id, firstSent.id, "and the WAL remembers it, so the replay can reuse it");

  // Reconnect. The server already has this row, so it answers with the existing one.
  delete opts.fetchReject;
  opts.fetchBodyFn = (_url, init) => ({ ...JSON.parse(init.body), _resolvedExisting: true, deleted_at: null });
  await store.replayWAL();

  const replaySent = JSON.parse(fetchCalls[fetchCalls.length - 1].init.body);
  assert.equal(replaySent.id, firstSent.id, "the replay reuses the original id");
  assert.equal(wal(storage).length, 0, "a replay answered by the existing row is SUCCESS and clears the entry");
  assert.equal(dead(storage).length, 0, "and it is success, not a dead letter");
});

test("a create answered with a tombstone does not resurrect the row in cache", async () => {
  // Reachable: create a task, lose the ack, delete the task, then the WAL replays the
  // create. db.createBlock's fallback is tombstone-inclusive on purpose, so the response
  // is the deleted row. Caching it live is exactly the resurrection B1 fixed for batch.
  const { store, fetchCalls } = makeStore({
    fetchBodyFn: (_url, init) => ({ ...JSON.parse(init.body), deleted_at: "2026-07-08T11:00:00.000Z", _resolvedExisting: true }),
  });
  await store.createBlock("task", { title: "already deleted" }, { date: "2026-07-08" });
  const sent = JSON.parse(fetchCalls[0].init.body);
  assert.equal(store.get(sent.id), null, "a row carrying deleted_at must not be left in the cache");
});

test("replayWAL dead-letters a create older than 24h instead of retrying it forever", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "create", data: { id: "c1", type: "task", properties: {} }, _walId: "w1", timestamp: hoursAgo(25) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 0, "a stale create must not hit the server");
  assert.equal(wal(storage).length, 0, "entry leaves the WAL");
  assert.equal(dead(storage).length, 1, "entry lands in the dead letter");
  assert.match(dead(storage)[0].reason, /stale create/);
});

test("replayWAL replays a create exactly at the 24h boundary (gate is strictly older-than)", async () => {
  const { store, storage, fetchCalls } = makeStore();
  seedWal(storage, [{ op: "create", data: { id: "c1", type: "task", properties: {} }, _walId: "w1", timestamp: hoursAgo(24) }]);
  await store.replayWAL();
  assert.equal(fetchCalls.length, 1, "boundary-age entry still replays");
  assert.equal(dead(storage).length, 0);
  assert.equal(wal(storage).length, 0, "replayed entry is removed on success");
});

test("replayWAL dead-letters a batch that 404s rather than re-queueing it forever", async () => {
  // /api/blocks/batch started returning 404 when #260 made it authorize every id it
  // references and #262 made a tombstone 404. B1 had already made /batch the canonical
  // client delete path, so without "batch" in the permanent list this is the common
  // path pinning a permanent "N edits pending" banner.
  const { store, storage } = makeStore({ fetchStatus: 404 });
  seedWal(storage, [{ op: "batch", data: { operations: [{ op: "delete", id: "gone" }] }, _walId: "w1", timestamp: minsAgo(1) }]);
  await store.replayWAL();
  assert.equal(wal(storage).length, 0, "a 404 batch must not stay queued");
  assert.equal(dead(storage).length, 1, "it dead-letters instead");
  assert.match(dead(storage)[0].reason, /404/);
});

test("replayWAL keeps a batch buffered on a 503, so the fix does not over-drop", async () => {
  const { store, storage } = makeStore({ fetchStatus: 503 });
  seedWal(storage, [{ op: "batch", data: { operations: [{ op: "delete", id: "b1" }] }, _walId: "w1", timestamp: minsAgo(1) }]);
  await store.replayWAL();
  assert.equal(wal(storage).length, 1, "a server blip is retryable and must stay buffered");
  assert.equal(dead(storage).length, 0);
});

test("undeleteBlock posts to /undelete, clears the WAL on ack, and re-caches the row", async () => {
  const { store, storage, fetchCalls } = makeStore({ fetchBody: { id: "b1", type: "task", properties: {}, deleted_at: null } });
  const block = await store.undeleteBlock("b1");
  assert.match(fetchCalls[0].url, /\/api\/blocks\/b1\/undelete$/);
  assert.equal(block.id, "b1");
  assert.equal(store.get("b1").id, "b1", "the revived row is cached again");
  assert.equal(wal(storage).length, 0, "acked, so nothing stays buffered");
});

test("a lost undelete ack stays buffered, so a restore is not silently lost", async () => {
  // Without this the overlay un-hides the task optimistically while the server still has
  // deleted_at set, and the next reload makes the task vanish again -- the same
  // vanish-after-reload class B1 and the rest of B2 exist to close.
  const { store, storage } = makeStore({ fetchReject: true });
  const result = await store.undeleteBlock("b1");
  assert.equal(result, null, "the caller is told it did not land");
  assert.equal(wal(storage).length, 1, "and it is buffered for replay");
  assert.equal(wal(storage)[0].op, "undelete");
  assert.equal(wal(storage)[0].id, "b1");
});

test("replayWAL replays a buffered undelete, and dead-letters it on a 404", async () => {
  // Replay is safe because undeleteBlock just clears deleted_at. A 404 means the row is
  // gone for real (hard-deleted, or past the 30-day purgeSoftDeleted sweep), so there is
  // nothing left to revive and retrying can only fail again.
  const ok = makeStore();
  seedWal(ok.storage, [{ op: "undelete", id: "b1", _walId: "w1", timestamp: minsAgo(1) }]);
  await ok.store.replayWAL();
  assert.match(ok.fetchCalls[0].url, /\/api\/blocks\/b1\/undelete$/);
  assert.equal(wal(ok.storage).length, 0, "a successful replay clears the entry");

  const gone = makeStore({ fetchStatus: 404 });
  seedWal(gone.storage, [{ op: "undelete", id: "b1", _walId: "w1", timestamp: minsAgo(1) }]);
  await gone.store.replayWAL();
  assert.equal(wal(gone.storage).length, 0, "a 404 undelete must not retry forever");
  assert.equal(dead(gone.storage).length, 1, "it dead-letters instead");
});

test("undeleteBlock clears the local tombstone, or the row stays invisible", async () => {
  // deleteBlock adds to _tombstones and handleBlocksChanged SKIPS a tombstoned id. Without
  // clearing it here, the tab that performed the restore keeps hiding the row until a
  // reload -- and it sees no broadcast of its own, so A2's undeletedIds cannot help it.
  const { store } = makeStore({ fetchBody: { id: "b1", type: "task", properties: {}, deleted_at: null } });
  await store.deleteBlock("b1");
  await store.undeleteBlock("b1");
  // Prove it through the observable path rather than by reaching into the closure: a
  // foreign broadcast naming b1 must now re-fetch and re-cache it.
  await store.handleBlocksChanged({ clientId: "someone-else", blockIds: ["b1"] });
  assert.equal(store.get("b1") && store.get("b1").id, "b1", "the id is no longer suppressed");
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
