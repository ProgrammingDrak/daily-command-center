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
const { setImmediate } = require("node:timers");

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
  const storage = opts.storage || new Map();
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
    navigator: { onLine: true, ...(opts.locks ? { locks: opts.locks } : {}) },
    addEventListener: () => {},
    removeEventListener: () => {},
    document: { addEventListener: () => {}, visibilityState: "visible" },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (opts.fetchImpl) return await opts.fetchImpl(url, init);
      // fetchStatus may be a FUNCTION of the url, so a test can fail one endpoint while
      // letting others answer. A blanket status makes some assertions vacuous: 409-ing
      // everything also 409s the follow-up GET, so a "the row is not cached" assertion
      // passes because nothing could be fetched, not because the code suppressed it.
      const _st = typeof opts.fetchStatus === "function" ? opts.fetchStatus(url, init) : opts.fetchStatus;
      if (_st && _st !== 200) {
        const errorBody = typeof opts.errorBody === "function" ? opts.errorBody(url, init) : opts.errorBody;
        return { ok: false, status: _st, statusText: "err", json: async () => errorBody || ({ error: "nope" }) };
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

function makeSharedLocks() {
  const tails = new Map();
  return {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const current = previous.catch(() => {}).then(callback);
      tails.set(name, current);
      return current.finally(() => { if (tails.get(name) === current) tails.delete(name); });
    },
  };
}

const WAL_KEY = "blockstore-wal";
const DEAD_KEY = "blockstore-wal-dead-letter";
const wal = (storage) => JSON.parse(storage.get(WAL_KEY) || "[]");
const dead = (storage) => JSON.parse(storage.get(DEAD_KEY) || "[]");
const minsAgo = (m) => new Date(FIXED_NOW - m * 60 * 1000).toISOString();

function seedWal(storage, entries) {
  storage.set(WAL_KEY, JSON.stringify(entries));
}

test("setTaskCompletion clears its WAL only after authoritative acknowledgement", async () => {
  const initial = { id: "b1", type: "block", date: "2026-07-08", properties: { title: "Keep", status: "open", detail: "Keep too" } };
  const { store, storage, fetchCalls } = makeStore({
    fetchBodyFn: (url, init) => {
      if (!String(url).includes("/completion")) return initial;
      const sent = JSON.parse(init.body);
      return { ok: true, mutationId: sent.mutationId, persistenceTarget: "task_row", revision: "rev-2", affectedTasks: [],
        task: { ...initial, properties: { ...initial.properties, status: "done", done: true, completedAt: sent.completedAt, _completionRevision: "rev-2" } } };
    },
  });
  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;
  const result = await store.setTaskCompletion("b1", true, { taskDate: "2026-07-08", completedAt: "2026-07-08T12:00:00Z" });
  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/tasks/b1/completion");
  assert.equal(JSON.parse(fetchCalls[0].init.body).completed, true);
  assert.equal(wal(storage).length, 0);
  assert.equal(store.get("b1").properties.status, "done");
  assert.equal(store.get("b1").properties.detail, "Keep too");
  assert.equal(store.get("b1")._completionState, undefined);
});

test("a permanent completion rejection rolls back optimistic state and rejects", async () => {
  const initial = { id: "b1", type: "block", date: "2026-07-08", properties: { title: "T", status: "open" } };
  const { store, storage, fetchCalls } = makeStore({
    fetchImpl: async (url) => {
      if (!String(url).includes("/completion")) return { ok: true, status: 200, json: async () => initial };
      return { ok: false, status: 400, statusText: "bad", json: async () => ({
        error: "Invalid completion", code: "COMPLETION_STATE_REQUIRED", retryable: false, requestId: "req-1",
      }) };
    },
  });
  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;
  await assert.rejects(store.setTaskCompletion("b1", true, { taskDate: "2026-07-08" }), /Invalid completion/);
  assert.equal(wal(storage).length, 0);
  assert.equal(dead(storage).length, 1);
  assert.equal(store.get("b1").properties.status, "open");
});

for (const status of [401, 403]) {
  test(`completion auth rejection ${status} rolls back instead of promising a retry`, async () => {
    const initial = { id: "b1", type: "block", date: "2026-07-08", properties: { title: "T", status: "open" } };
    const { store, storage } = makeStore({
      fetchImpl: async (url) => {
        if (!String(url).includes("/completion")) return { ok: true, status: 200, json: async () => initial };
        return { ok: false, status, statusText: "auth", json: async () => ({
          error: status === 401 ? "Authentication required" : "Workspace access denied",
          code: status === 401 ? "AUTH_REQUIRED" : "WORKSPACE_FORBIDDEN",
          retryable: false,
          requestId: `auth-${status}`,
        }) };
      },
    });
    await store.handleBlocksChanged({ blockIds: ["b1"] });

    await assert.rejects(store.setTaskCompletion("b1", true, { taskDate: "2026-07-08" }), /required|denied/);
    assert.equal(wal(storage).length, 0, "auth rejection must not stay queued");
    assert.equal(dead(storage).length, 1, "auth rejection remains available for diagnostics");
    assert.equal(store.get("b1").properties.status, "open", "optimistic completion rolls back");
  });
}

test("a transient completion remains visibly pending and survives reload replay", async () => {
  const storage = new Map();
  const initial = { id: "b1", type: "block", date: "2026-07-08", properties: { title: "T", status: "open" } };
  const first = makeStore({ storage, fetchImpl: async (url) => {
    if (!String(url).includes("/completion")) return { ok: true, status: 200, json: async () => initial };
    throw new TypeError("network down");
  } });
  await first.store.handleBlocksChanged({ blockIds: ["b1"] });
  const pending = await first.store.setTaskCompletion("b1", true, { taskDate: "2026-07-08", completedAt: "2026-07-08T12:00:00Z" });
  assert.equal(pending.pending, true);
  assert.equal(wal(storage).length, 1);
  assert.equal(first.store.get("b1").properties.status, "done");
  assert.equal(first.store.get("b1")._completionState, "pending");

  const second = makeStore({ storage, fetchBodyFn: (url, init) => {
    if (!String(url).includes("/completion")) return initial;
    const sent = JSON.parse(init.body);
    return { ok: true, mutationId: sent.mutationId, persistenceTarget: "task_row", revision: "rev-2", affectedTasks: [],
      task: { ...initial, properties: { ...initial.properties, status: "done", done: true, completedAt: sent.completedAt, _completionRevision: "rev-2" } } };
  } });
  await second.store.replayWAL();
  assert.equal(wal(storage).length, 0);
  assert.equal(second.store.get("b1").properties.status, "done");
  assert.equal(second.store.get("b1")._completionState, undefined);
});

test("startup migrates a pending full-properties completion into a narrow intent", () => {
  const storage = new Map();
  seedWal(storage, [{
    op: "update", id: "b1", _walId: "old-1", timestamp: minsAgo(1),
    data: { properties: { title: "Stale", status: "done", done: true, completedAt: "2026-07-08T12:00:00Z" },
      completionIntent: "complete", completionMutationId: "legacy-1", completionBaseRevision: "rev-1", date: "2026-07-08" },
  }]);
  makeStore({ storage });
  const entry = wal(storage)[0];
  assert.equal(entry.op, "completion");
  assert.deepEqual({ ...entry.data }, {
    completed: true, completedAt: "2026-07-08T12:00:00Z", taskDate: "2026-07-08",
    mutationId: "legacy-1", expectedRevision: "rev-1",
  });
  assert.equal("properties" in entry.data, false);
});

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

test("a newer reopen supersedes an ack-lost completion and stays ordered per row", async () => {
  let rejectFirst;
  let requestCount = 0;
  const opts = {
    fetchImpl: async (_url, init) => {
      if (!init || init.method !== "PATCH") {
        return { ok: true, status: 200, json: async () => ({
          id: "b1", type: "block", date: null,
          properties: { title: "Original", status: "open", kind: "backlog" },
        }) };
      }
      requestCount++;
      if (requestCount === 1) {
        return await new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08", properties: sent.properties,
      }) };
    },
  };
  const { store, storage, fetchCalls } = makeStore(opts);
  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;

  const complete = store.updateBlock("b1", { status: "done", done: true }, { completionIntent: "complete" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1, "the completion starts immediately");

  const reopen = store.updateBlock("b1", { status: "open" }, { completionIntent: "reopen" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1, "the reopen waits behind the same-row completion");
  assert.equal(wal(storage).length, 1, "only the newest full-row update remains buffered");
  assert.equal(wal(storage)[0].data.completionIntent, "reopen");

  rejectFirst(new TypeError("ack lost"));
  await Promise.all([complete, reopen]);

  assert.equal(fetchCalls.length, 2);
  assert.equal(JSON.parse(fetchCalls[0].init.body).completionIntent, "complete");
  assert.equal(JSON.parse(fetchCalls[1].init.body).completionIntent, "reopen");
  assert.equal(wal(storage).length, 0, "the acknowledged reopen clears the only surviving entry");
});

test("an ordinary edit inherits a still-buffered completion before superseding it", async () => {
  let rejectFirst;
  let requestCount = 0;
  const opts = {
    fetchImpl: async (_url, init) => {
      if (!init || init.method !== "PATCH") {
        return { ok: true, status: 200, json: async () => ({
          id: "b1", type: "block", date: null,
          properties: { title: "Original", status: "open", kind: "backlog" },
        }) };
      }
      requestCount++;
      if (requestCount === 1) {
        return await new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08",
        properties: sent.completionIntent === "complete"
          ? { ...sent.properties, status: "done", done: true }
          : { ...sent.properties, status: "open" },
      }) };
    },
  };
  const { store, storage, fetchCalls } = makeStore(opts);
  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;

  const complete = store.updateBlock(
    "b1",
    {
      title: "Original", status: "done", done: true,
      completedAt: "2026-07-08T11:00:00.000Z",
      _doneStampedDate: "2026-07-08", _wasBacklog: true,
    },
    { completionIntent: "complete", date: "2026-07-08" }
  );
  await new Promise(resolve => setImmediate(resolve));
  const rename = store.updateBlock("b1", {
    title: "Renamed", status: "done", done: true,
    completedAt: "2026-07-08T11:00:00.000Z",
    _doneStampedDate: "2026-07-08", _wasBacklog: true,
  });

  assert.equal(wal(storage).length, 1);
  assert.equal(wal(storage)[0].data.completionIntent, "complete", "the rename carries the pending transition");
  assert.equal(wal(storage)[0].data.date, "2026-07-08", "and keeps top-level promotion metadata");
  rejectFirst(new TypeError("ack lost"));
  await Promise.all([complete, rename]);

  const renameBody = JSON.parse(fetchCalls[1].init.body);
  assert.equal(renameBody.completionIntent, "complete");
  assert.equal(renameBody.date, "2026-07-08");
  assert.equal(renameBody.properties.completedAt, "2026-07-08T11:00:00.000Z");
  assert.equal(renameBody.properties._doneStampedDate, "2026-07-08");
  assert.equal(renameBody.properties._wasBacklog, true);
  assert.equal("kind" in renameBody.properties, false, "completion keeps the Backlog promotion's kind removal");
  assert.equal(store.get("b1").properties.status, "done");
  assert.equal(store.get("b1").properties.title, "Renamed");
  assert.equal(wal(storage).length, 0);
});

test("a coalesced rename survives a completion conflict rebase", async () => {
  let rejectCompletion;
  let patchCount = 0;
  let getCount = 0;
  const { store, storage, fetchCalls } = makeStore({
    fetchImpl: async (_url, init) => {
      if (!init || init.method !== "PATCH") {
        getCount++;
        return { ok: true, status: 200, json: async () => getCount === 1
          ? {
              id: "b1", type: "block", date: "2026-07-08",
              properties: {
                title: "Original", detail: "Old detail", notes: "Original notes",
                status: "open", _completionRevision: "base-r0",
              },
            }
          : {
              id: "b1", type: "block", date: "2026-07-08",
              properties: {
                title: "Remote title", detail: "Remote detail", notes: "Remote notes",
                status: "open", _completionRevision: "remote-r2",
              },
            } };
      }
      patchCount++;
      if (patchCount === 1) {
        return await new Promise((_resolve, reject) => { rejectCompletion = reject; });
      }
      if (patchCount === 2) {
        return { ok: false, status: 409, json: async () => ({
          error: "Task completion changed since this edit was created", code: "COMPLETION_CONFLICT",
        }) };
      }
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08",
        properties: sent.properties,
      }) };
    },
  });
  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;

  const complete = store.updateBlock("b1", {
    title: "Original", detail: "Old detail", notes: "Timed completion notes",
    status: "done", done: true,
    completedAt: "2026-07-08T11:00:00.000Z",
  }, { completionIntent: "complete" });
  await new Promise(resolve => setImmediate(resolve));
  const rename = store.updateBlock("b1", {
    title: "Local rename", detail: "Old detail", notes: "User edited notes",
    status: "done", done: true,
    completedAt: "2026-07-08T11:00:00.000Z",
  });

  rejectCompletion(new TypeError("ack lost"));
  await Promise.all([complete, rename]);

  assert.equal(fetchCalls.length, 4, "completion, combined conflict, refresh, retry");
  const retry = JSON.parse(fetchCalls[3].init.body);
  assert.equal("completionIntent" in retry, false, "the stale inherited completion loses to remote reopen");
  assert.equal("completionBaseRevision" in retry, false);
  assert.equal(retry.properties.title, "Local rename", "the later local edit remains intentional");
  assert.equal(retry.properties.detail, "Remote detail", "unchanged stale fields still rebase to latest");
  assert.equal(retry.properties.notes, "User edited notes", "a later overlapping edit wins over completion");
  assert.equal(retry.properties.status, "open", "the intervening explicit reopen remains authoritative");
  assert.equal("done" in retry.properties, false);
  assert.equal("completedAt" in retry.properties, false);
  assert.equal(wal(storage).length, 0);
});

test("a stale cross-device completion replay is dead-lettered on revision conflict", async () => {
  const { store, storage, fetchCalls } = makeStore({
    fetchStatus: 409,
    errorBody: { error: "Task completion changed since this edit was created", code: "COMPLETION_CONFLICT" },
  });
  seedWal(storage, [{
    op: "update", id: "b1",
    data: {
      properties: { status: "done", done: true },
      completionIntent: "complete", completionMutationId: "old-mutation",
      completionBaseRevision: "old-revision",
    },
    _walId: "old-device-complete", timestamp: minsAgo(1),
  }]);

  await store.replayWAL();

  assert.equal(fetchCalls.length, 1, "stale replay is never refreshed and retried");
  assert.equal(wal(storage).length, 0);
  assert.equal(dead(storage).length, 1);
  assert.match(dead(storage)[0].reason, /409/);
});

test("a live completion conflict refreshes the revision and retries once", async () => {
  let patchCount = 0;
  let getCount = 0;
  const { store, storage, fetchCalls } = makeStore({
    fetchImpl: async (url, init) => {
      if (!init || init.method !== "PATCH") {
        getCount++;
        return { ok: true, status: 200, json: async () => ({
          id: "b1", type: "block", date: "2026-07-08",
          properties: getCount === 1
            ? {
                title: "Stale title", detail: "Old detail", status: "done", done: true,
                _doneStampedDate: "2026-07-08", _wasBacklog: true,
                _completionRevision: "client-old",
              }
            : {
                title: "Newer title", detail: "Keep me", status: "done", done: true,
                _doneStampedDate: "2026-07-08", _wasBacklog: true,
                _completionRevision: "server-latest",
              },
        }) };
      }
      patchCount++;
      if (patchCount === 1) {
        return { ok: false, status: 409, json: async () => ({
          error: "Task completion changed since this edit was created", code: "COMPLETION_CONFLICT",
        }) };
      }
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08",
        properties: { ...sent.properties, status: "open", _completionRevision: "reopen-new" },
      }) };
    },
  });

  await store.handleBlocksChanged({ blockIds: ["b1"] });
  fetchCalls.length = 0;
  const result = await store.updateBlock(
    "b1",
    { title: "Stale title", detail: "Old detail", status: "open", kind: "backlog" },
    { completionIntent: "reopen", date: null }
  );

  assert.equal(fetchCalls.length, 3, "PATCH conflict, GET current row, PATCH retry");
  const retry = JSON.parse(fetchCalls[2].init.body);
  assert.equal(retry.completionBaseRevision, "server-latest");
  assert.equal(retry.properties.title, "Newer title", "retry rebases onto current unrelated fields");
  assert.equal(retry.properties.detail, "Keep me");
  assert.equal(retry.properties.status, "open");
  assert.equal(retry.properties.kind, "backlog", "completion-time Backlog promotion is reversed");
  assert.equal("done" in retry.properties, false);
  assert.equal("_doneStampedDate" in retry.properties, false);
  assert.equal("_wasBacklog" in retry.properties, false);
  assert.equal(result.properties.status, "open");
  assert.equal(wal(storage).length, 0);
});

test("a cache-miss completion uses its freshly fetched row as CAS and delta base", async () => {
  let patchCount = 0;
  const fetchedBase = {
    id: "b1", type: "block", date: "2026-07-08",
    properties: {
      title: "Old title", detail: "Keep-current", status: "open",
      _completionRevision: "reopen-r2",
    },
  };
  const { store, storage, fetchCalls } = makeStore({
    fetchImpl: async (_url, init) => {
      if (!init || init.method !== "PATCH") {
        return { ok: true, status: 200, json: async () => ({
          id: "b1", type: "block", date: "2026-07-08",
          properties: {
            title: "Concurrent title", detail: "Keep-current", status: "open",
            _completionRevision: "newer-r3",
          },
        }) };
      }
      patchCount++;
      if (patchCount === 1) {
        return { ok: false, status: 409, json: async () => ({
          error: "Task completion changed since this edit was created", code: "COMPLETION_CONFLICT",
        }) };
      }
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08",
        properties: { ...sent.properties, _completionRevision: "complete-r4" },
      }) };
    },
  });

  const result = await store.updateBlock("b1", {
    title: "Old title", detail: "Keep-current", status: "done", done: true,
    completedAt: "2026-07-08T12:00:00.000Z",
    _completionRevision: "reopen-r2",
  }, { completionIntent: "complete", _completionBaseBlock: fetchedBase });

  assert.equal(fetchCalls.length, 3);
  const first = JSON.parse(fetchCalls[0].init.body);
  assert.equal(first.completionBaseRevision, "reopen-r2");
  assert.equal("_completionBaseBlock" in first, false, "client-only base never reaches the API");
  const retry = JSON.parse(fetchCalls[2].init.body);
  assert.equal(retry.completionBaseRevision, "newer-r3");
  assert.equal(retry.properties.title, "Concurrent title", "unchanged stale fields rebase to latest");
  assert.equal(retry.properties.status, "done");
  assert.equal(retry.properties.completedAt, "2026-07-08T12:00:00.000Z");
  assert.equal(result.properties._completionRevision, "complete-r4");
  assert.equal(wal(storage).length, 0);
});

test("a legacy base-less completion WAL entry is dead-lettered on protocol rejection", async () => {
  const { store, storage, fetchCalls } = makeStore({
    fetchStatus: 400,
    errorBody: {
      error: "completionBaseRevision is required for completion transitions",
      code: "COMPLETION_BASE_REQUIRED",
    },
  });
  seedWal(storage, [{
    op: "update", id: "b1",
    data: {
      properties: { status: "open" },
      completionIntent: "reopen", completionMutationId: "legacy-reopen",
    },
    _walId: "legacy-base-less", timestamp: minsAgo(1),
  }]);

  await store.replayWAL();

  assert.equal(fetchCalls.length, 1);
  assert.equal(wal(storage).length, 0);
  assert.equal(dead(storage).length, 1);
  assert.match(dead(storage)[0].reason, /400/);
});

test("a live reopen is ordered after an in-flight completion replay", async () => {
  let resolveReplay;
  let requestCount = 0;
  const opts = {
    fetchImpl: async (_url, init) => {
      requestCount++;
      const sent = JSON.parse(init.body);
      if (requestCount === 1) {
        return await new Promise(resolve => {
          resolveReplay = () => resolve({ ok: true, status: 200, json: async () => ({
            id: "b1", type: "block", date: "2026-07-08", properties: sent.properties,
          }) });
        });
      }
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08", properties: { status: "open", title: "Latest" },
      }) };
    },
  };
  const { store, storage, fetchCalls } = makeStore(opts);
  seedWal(storage, [{
    op: "update", id: "b1",
    data: { properties: { status: "done", done: true }, completionIntent: "complete" },
    _walId: "old-complete", timestamp: minsAgo(1),
  }]);

  const replay = store.replayWAL();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  const reopen = store.updateBlock("b1", { status: "open", title: "Latest" }, { completionIntent: "reopen" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1, "the live reopen waits for the same-row replay");
  assert.equal(wal(storage).length, 1);
  assert.equal(wal(storage)[0].data.completionIntent, "reopen");

  resolveReplay();
  await Promise.all([replay, reopen]);

  assert.equal(fetchCalls.length, 2);
  assert.equal(JSON.parse(fetchCalls[0].init.body).completionIntent, "complete");
  assert.equal(JSON.parse(fetchCalls[1].init.body).completionIntent, "reopen");
  assert.equal(store.get("b1").properties.status, "open");
  assert.equal(wal(storage).length, 0);
});

test("the origin-wide row lock orders a second tab's reopen after stale replay", async () => {
  const storage = new Map();
  const locks = makeSharedLocks();
  let resolveReplay;
  const replayTab = makeStore({
    storage, locks,
    fetchImpl: async (_url, init) => await new Promise(resolve => {
      const sent = JSON.parse(init.body);
      resolveReplay = () => resolve({ ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08", properties: sent.properties,
      }) });
    }),
  });
  const liveTab = makeStore({
    storage, locks,
    fetchImpl: async (_url, init) => {
      const sent = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        id: "b1", type: "block", date: "2026-07-08", properties: sent.properties,
      }) };
    },
  });
  seedWal(storage, [{
    op: "update", id: "b1",
    data: { properties: { status: "done", done: true }, completionIntent: "complete", completionMutationId: "old" },
    _walId: "old-complete", timestamp: minsAgo(1),
  }]);

  const replay = replayTab.store.replayWAL();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replayTab.fetchCalls.length, 1);
  const reopen = liveTab.store.updateBlock("b1", { status: "open" }, { completionIntent: "reopen" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(liveTab.fetchCalls.length, 0, "the other tab waits on the origin-wide row lock");

  resolveReplay();
  await Promise.all([replay, reopen]);

  assert.equal(liveTab.fetchCalls.length, 1);
  assert.equal(JSON.parse(liveTab.fetchCalls[0].init.body).completionIntent, "reopen");
  assert.equal(liveTab.store.get("b1").properties.status, "open");
  assert.equal(wal(storage).length, 0);
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
  // Assert the id EXISTS before asserting it matches. Pre-change the payload carried no
  // id at all, so a bare equality here passed as undefined === undefined -- the assertion
  // that states this phase's whole mechanism was the one assertion that could not fail.
  assert.ok(replaySent.id, "the replay must carry an id at all");
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
  const res = await store.undeleteBlock("b1");
  assert.match(fetchCalls[0].url, /\/api\/blocks\/b1\/undelete$/);
  assert.equal(res.ok, true);
  assert.equal(res.block.id, "b1");
  assert.equal(store.get("b1").id, "b1", "the revived row is cached again");
  assert.equal(wal(storage).length, 0, "acked, so nothing stays buffered");
});

test("a lost undelete ack stays buffered and is reported as not-yet, not as rejected", async () => {
  // Without buffering, the overlay un-hides the task optimistically while the server still
  // has deleted_at set, and the next reload makes the task vanish again -- the same
  // vanish-after-reload class B1 and the rest of B2 exist to close. `permanent: false` is
  // what tells the caller to keep the optimistic restore rather than undoing it.
  const { store, storage } = makeStore({ fetchReject: true });
  const res = await store.undeleteBlock("b1");
  assert.equal(res.ok, false, "the caller is told it did not land");
  assert.equal(res.permanent, false, "but it is retryable, so the UI keeps the restore");
  assert.equal(wal(storage).length, 1, "and it is buffered for replay");
  assert.equal(wal(storage)[0].op, "undelete");
  assert.equal(wal(storage)[0].id, "b1");
});

test("a 409 undelete is PERMANENT: dropped, not retried, and reported as rejected", async () => {
  // db.undeleteBlock raises 409 when clearing deleted_at would collide with a LIVE row
  // holding the same idempotency key. The twin does not go away on retry, so retrying
  // pins a permanent "N edits pending" banner -- the exact failure this phase fixed for
  // "batch". db.js names B2 as the phase that must handle it, and prod has 32 duplicate
  // key groups of this shape.
  const { store, storage } = makeStore({ fetchStatus: 409 });
  const res = await store.undeleteBlock("b1");
  assert.equal(res.ok, false);
  assert.equal(res.permanent, true, "the caller must be able to tell never from not-yet");
  assert.equal(wal(storage).length, 0, "a conflict that cannot resolve must not stay queued");

  // And the same verdict via a replayed entry, since that is the path that would loop.
  const replayed = makeStore({ fetchStatus: 409 });
  seedWal(replayed.storage, [{ op: "undelete", id: "b1", _walId: "w1", timestamp: minsAgo(1) }]);
  await replayed.store.replayWAL();
  assert.equal(wal(replayed.storage).length, 0, "the replay does not re-queue it");
  assert.equal(dead(replayed.storage).length, 1, "it dead-letters instead");
});

test("a rejected undelete puts the tombstone BACK, so the cache stops serving the row", async () => {
  // 409 ONLY the undelete. With a blanket 409 the follow-up GET fails too, so `get` is null
  // whether or not the tombstone came back and the assertion cannot fail -- it would be
  // testing the stub's inability to answer rather than the code.
  const { store } = makeStore({
    fetchStatus: (url) => (String(url).endsWith("/undelete") ? 409 : 200),
    fetchBody: { id: "b1", type: "task", properties: {}, deleted_at: null },
  });
  await store.undeleteBlock("b1");
  // The row is still deleted server-side, so a foreign broadcast naming it must not
  // re-cache it as live -- the GET below WOULD succeed and cache it if the id were not
  // tombstoned again.
  await store.handleBlocksChanged({ clientId: "someone-else", blockIds: ["b1"] });
  assert.equal(store.get("b1"), null, "a refused restore must not leave the row cached");
});

test("a 409 batch stays buffered while source-owned reschedule conflicts are terminal", async () => {
  // The mirror of the 503 batch control above. The 404 widening is guarded in both
  // directions; without this, widening the 409 rule to every op (or copying the line into
  // the shared list) would silently dead-letter retryable writes, which is data loss with
  // a diagnostic breadcrumb instead of a retry.
  const { store, storage } = makeStore({ fetchStatus: 409 });
  seedWal(storage, [{ op: "batch", data: { operations: [{ op: "delete", id: "b1" }] }, _walId: "w1", timestamp: minsAgo(1) }]);
  await store.replayWAL();
  assert.equal(wal(storage).length, 1, "a 409 batch is retryable");
  assert.equal(dead(storage).length, 0);

  const sourceOwned = makeStore({ fetchStatus: 409 });
  seedWal(sourceOwned.storage, [{ op: "reschedule", id: "m1", data: { targetDate: "2026-07-10" }, _walId: "w2", timestamp: minsAgo(1) }]);
  await sourceOwned.store.replayWAL();
  assert.equal(wal(sourceOwned.storage).length, 0, "a source-authority rejection does not retry forever");
  assert.equal(dead(sourceOwned.storage).length, 1);
});

test("cancelBufferedWrite refuses to cancel a write that already replayed", async () => {
  // The return value is load-bearing: `buffered` is a snapshot from failure time, and
  // replayWAL fires on `online` with no delay, so the queued write can land before the user
  // clicks Undo. Saying "cancelled" when the write is already gone is what would make Undo
  // skip its real work and leave the server disagreeing with the UI.
  const { store, storage } = makeStore({ fetchReject: true });
  const held = await store.batchOp([{ op: "delete", id: "b1" }]);
  assert.equal(held.buffered, true);
  assert.equal(store.cancelBufferedWrite(held.walId, ["b1"]), true, "still pending, so it cancels");
  assert.equal(store.cancelBufferedWrite(held.walId, ["b1"]), false, "already gone, so it reports that honestly");
  assert.equal(store.cancelBufferedWrite(undefined, ["b1"]), false, "and a missing walId is never a successful cancel");
  assert.equal(wal(storage).length, 0);
});

test("a dead-lettered undelete re-tombstones the row, so the client stops showing it as back", async () => {
  // The client has already told the user "Task restored" on the strength of a retry that is
  // now being abandoned. Without this the task silently vanishes on the next load instead.
  // 409 the undelete ONLY. A blanket status fails the follow-up GET too, which makes the
  // absence assertion below pass no matter what the code did -- the same way the sibling
  // test above was vacuous before it was fixed.
  const { store, storage } = makeStore({
    fetchStatus: (url) => (String(url).endsWith("/undelete") ? 409 : 200),
    fetchBody: { id: "b1", type: "task", properties: {}, deleted_at: null },
  });
  seedWal(storage, [{ op: "undelete", id: "b1", _walId: "w1", timestamp: minsAgo(1) }]);
  await store.replayWAL();
  assert.equal(dead(storage).length, 1, "the entry is abandoned");
  // Now a foreign broadcast must NOT re-cache b1 as live: the server still has it deleted.
  // That GET WOULD succeed and cache the row if the dead-letter path had not re-tombstoned it.
  await store.handleBlocksChanged({ clientId: "someone-else", blockIds: ["b1"] });
  assert.equal(store.get("b1"), null, "the row is back under its tombstone");
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
  // batchOp adds to _tombstones and handleBlocksChanged SKIPS a tombstoned id. Without
  // clearing it in undeleteBlock, the tab that performed the restore keeps hiding the row
  // until a reload -- and it sees no broadcast of its own, so A2's undeletedIds cannot
  // help it.
  //
  // The undelete's OWN ack must be non-cacheable here or this test cannot fail: cacheSet
  // unconditionally clears the tombstone too, so a cacheable ack would clear it even with
  // the up-front delete removed. Answer the undelete with {} and let only the later
  // GET be cacheable, so the up-front clear is the single thing under test. Entering via
  // batchOp rather than deleteBlock also matches the path state.js actually takes.
  const { store } = makeStore({
    fetchBodyFn: (url) => String(url).endsWith("/undelete")
      ? {}
      : { id: "b1", type: "task", properties: {}, deleted_at: null },
  });
  await store.batchOp([{ op: "delete", id: "b1" }]);
  await store.undeleteBlock("b1");
  // Prove it through the observable path rather than by reaching into the closure: a
  // foreign broadcast naming b1 must now re-fetch and re-cache it.
  await store.handleBlocksChanged({ clientId: "someone-else", blockIds: ["b1"] });
  assert.equal(store.get("b1") && store.get("b1").id, "b1", "the id is no longer suppressed");
});

test("batchOp reports whether the write landed, and cancelBufferedWrite abandons it", async () => {
  // The signal undoDeleteTask needs: before this, batchOp returned the same empty-blocks
  // shape on success-with-nothing and on total failure, so no caller could tell a write
  // that landed from one still sitting in the WAL.
  const ok = makeStore({ fetchBody: { blocks: [{ id: "b1", deleted_at: "2026-07-08T00:00:00.000Z" }] } });
  const landed = await ok.store.batchOp([{ op: "delete", id: "b1" }]);
  assert.equal(landed.ok, true, "an acknowledged batch exposes an explicit success verdict");
  assert.equal(landed.buffered, false, "a write that acked is not buffered");
  assert.equal(wal(ok.storage).length, 0);

  const down = makeStore({ fetchReject: true });
  const held = await down.store.batchOp([{ op: "delete", id: "b1" }]);
  assert.equal(held.ok, false, "a buffered batch exposes an explicit failure verdict");
  assert.match(held.error.message, /network down/);
  assert.equal(held.buffered, true, "a write that failed IS still buffered");
  assert.ok(held.walId, "and it names its own WAL entry so a caller can abandon it");
  assert.equal(wal(down.storage).length, 1);

  down.store.cancelBufferedWrite(held.walId, ["b1"]);
  assert.equal(wal(down.storage).length, 0, "the abandoned write is gone from the WAL");
  assert.equal(dead(down.storage).length, 0, "and NOT dead-lettered -- it did not fail permanently, it is unwanted");
  // The tombstone the abandoned delete had optimistically added is cleared too.
  await down.store.handleBlocksChanged({ clientId: "someone-else", blockIds: ["b1"] });
  assert.ok(down.fetchCalls.some((c) => String(c.url).includes("/api/blocks/b1")), "b1 is no longer suppressed");
});

test("rescheduleBlock drops the WAL entry and stamps e.permanent on a 400", async () => {
  const { store, storage } = makeStore({ fetchStatus: 400 });
  await assert.rejects(
    () => store.rescheduleBlock("b1", "2026-07-10", { fromDate: "2026-07-08" }),
    (e) => e.permanent === true
  );
  assert.equal(wal(storage).length, 0, "permanent rejection must not stay buffered");
});

test("rescheduleBlock treats a source-authority 409 as permanent", async () => {
  const { store, storage } = makeStore({ fetchStatus: 409 });
  await assert.rejects(
    () => store.rescheduleBlock("meeting-1", "2026-07-10", { placement: { kind: "timed", start: "09:00", end: "10:00" } }),
    (e) => e.permanent === true
  );
  assert.equal(wal(storage).length, 0);
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

test("rescheduleBlock retries a stale subtree snapshot once and clears the WAL on success", async () => {
  let attempts = 0;
  const { store, storage } = makeStore({
    fetchStatus: (url) => String(url).includes("/reschedule") && ++attempts === 1 ? 409 : 200,
    errorBody: { error: "Task changed while it was being moved", code: "RESCHEDULE_STALE" },
    fetchBody: { moved: ["b1"], blocks: [], created: [] },
  });
  const result = await store.rescheduleBlock("b1", "2026-07-10", { fromDate: "2026-07-08" });
  assert.deepEqual(result.moved, ["b1"]);
  assert.equal(attempts, 2, "the stale plan is rebuilt exactly once");
  assert.equal(wal(storage).length, 0, "the original intent is acknowledged, not left to replay");
});

test("rapid moves of one task are sent in click order while different tasks stay parallel", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let requestNo = 0;
  const { store, fetchCalls } = makeStore({
    fetchBodyFn: async (url) => {
      requestNo++;
      if (String(url).includes("/b1/reschedule") && requestNo === 1) await firstGate;
      return { moved: [], blocks: [], created: [] };
    },
  });

  const first = store.rescheduleBlock("b1", "2026-07-10", {});
  const second = store.rescheduleBlock("b1", "2026-07-11", {});
  const other = store.rescheduleBlock("b2", "2026-07-12", {});
  await Promise.resolve();
  await Promise.resolve();

  const urlsBeforeRelease = fetchCalls.map((call) => String(call.url));
  assert.equal(urlsBeforeRelease.filter((url) => url.includes("/b1/reschedule")).length, 1,
    "the second move of b1 waits for its predecessor");
  assert.equal(urlsBeforeRelease.filter((url) => url.includes("/b2/reschedule")).length, 1,
    "an unrelated task is not globally serialized");

  releaseFirst();
  await Promise.all([first, second, other]);
  const b1Bodies = fetchCalls
    .filter((call) => String(call.url).includes("/b1/reschedule"))
    .map((call) => JSON.parse(call.init.body).targetDate);
  assert.deepEqual(b1Bodies, ["2026-07-10", "2026-07-11"], "the newest click lands last");
});
