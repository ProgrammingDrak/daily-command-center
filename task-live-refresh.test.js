const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const persistenceSource = fs.readFileSync(require.resolve("./public/js/persistence.js"), "utf8");
const sseSource = fs.readFileSync(require.resolve("./public/js/sse.js"), "utf8");
const blockStoreSource = fs.readFileSync(require.resolve("./public/js/block-store.js"), "utf8");

test("completion is projected before an already-folded task is skipped", () => {
  const loopStart = persistenceSource.indexOf("if(_tmReady)addedBlocks.forEach(block=>{");
  const loopEnd = persistenceSource.indexOf("const task=TM.fromBlock(block);", loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart, "task fold loop must remain discoverable");
  const loop = persistenceSource.slice(loopStart, loopEnd);
  const seed = loop.indexOf('if(p.done===true||p.status==="done")');
  const duplicateGuard = loop.indexOf("if(scheduled.find(e=>e.id===taskId))return;");
  assert.ok(seed >= 0, "row completion seed must exist");
  assert.ok(duplicateGuard > seed, "completion must be projected before the duplicate guard");
});

test("refolding twice rebuilds from the immutable baseline instead of accumulating tasks", () => {
  const start = persistenceSource.indexOf("function refoldTaskStateFromBlockCache()");
  const end = persistenceSource.indexOf("\nasync function switchToDate", start);
  assert.ok(start >= 0 && end > start, "refold helper must remain discoverable");
  const context = {
    JSON,
    INIT_SCHED: [{ id: "base" }],
    INIT_CONSIDER: [{ id: "consider-base" }],
    INIT_BACKLOG: [{ id: "backlog-base" }],
    scheduled: [{ id: "stale" }],
    consider: [{ id: "stale-consider" }],
    backlog: [{ id: "stale-backlog" }],
    reloadPersistedEdits() { context.scheduled.push({ id: "block-task" }); },
  };
  vm.createContext(context);
  vm.runInContext(persistenceSource.slice(start, end), context);
  vm.runInContext("refoldTaskStateFromBlockCache(); refoldTaskStateFromBlockCache();", context);
  assert.deepEqual(context.scheduled.map((x) => x.id), ["base", "block-task"]);
  assert.deepEqual(context.consider.map((x) => x.id), ["consider-base"]);
  assert.deepEqual(context.backlog.map((x) => x.id), ["backlog-base"]);
});

function coordinatorFactory() {
  const start = sseSource.indexOf("function createTaskRefreshCoordinator(opts)");
  const end = sseSource.indexOf("\n  window.createTaskRefreshCoordinator", start);
  assert.ok(start >= 0 && end > start, "task refresh coordinator must remain discoverable");
  const context = {};
  vm.createContext(context);
  vm.runInContext(sseSource.slice(start, end), context);
  return context.createTaskRefreshCoordinator;
}

function harness(overrides) {
  let clock = 0;
  let visible = true;
  let safe = true;
  let date = "2026-08-07";
  let loads = 0;
  let applies = 0;
  const intervals = [];
  const visibilityListeners = [];
  const factory = coordinatorFactory();
  const values = {
    intervalMs: 60000,
    now: () => clock,
    isVisible: () => visible,
    canRefresh: () => safe,
    getDate: () => date,
    loadDay: async () => { loads++; return []; },
    apply: async () => { applies++; },
    onError: () => {},
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    addVisibilityListener: (fn) => visibilityListeners.push(fn),
    ...(overrides || {}),
  };
  const coordinator = factory(values);
  return {
    coordinator,
    intervals,
    visibilityListeners,
    counts: () => ({ loads, applies }),
    advance: (ms) => { clock += ms; },
    setVisible: (v) => { visible = v; },
    setSafe: (v) => { safe = v; },
    setDate: (v) => { date = v; },
  };
}

test("passive task refresh starts exactly one 60-second timer and one visibility listener", () => {
  const h = harness();
  h.coordinator.start();
  h.coordinator.start();
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 60000);
  assert.equal(h.visibilityListeners.length, 1);
});

test("timer refresh is visible-only and skips unsafe interaction windows", async () => {
  const h = harness();
  h.coordinator.start();
  h.advance(60000);
  h.setVisible(false);
  h.intervals[0].fn();
  await Promise.resolve();
  assert.deepEqual(h.counts(), { loads: 0, applies: 0 });

  h.setVisible(true);
  h.setSafe(false);
  h.intervals[0].fn();
  await Promise.resolve();
  assert.deepEqual(h.counts(), { loads: 0, applies: 0 });

  h.setSafe(true);
  h.intervals[0].fn();
  await h.coordinator.refresh("join-timer");
  assert.deepEqual(h.counts(), { loads: 1, applies: 1 });
});

test("overlapping refresh attempts share one load", async () => {
  let release;
  let loads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    loadDay: async () => { loads++; await gate; return []; },
  });
  const first = h.coordinator.refresh("manual");
  const second = h.coordinator.refresh("manual");
  assert.equal(loads, 1);
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(loads, 1);
});

test("a response for a date that is no longer viewed is discarded", async () => {
  let release;
  let applies = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    loadDay: async () => { await gate; return []; },
    apply: async () => { applies++; },
  });
  const refresh = h.coordinator.refresh("manual");
  h.setDate("2026-08-08");
  release();
  assert.equal(await refresh, false);
  assert.equal(applies, 0);
});

test("a mutation that starts during refresh prevents the stale response from applying", async () => {
  let release;
  let generation = 0;
  let safe = true;
  let applies = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    canRefresh: () => safe,
    getMutationGeneration: () => generation,
    loadDay: async () => { await gate; return [{ id: "stale-open-row" }]; },
    apply: async () => { applies++; },
  });
  const refresh = h.coordinator.refresh("timer");
  generation++;
  safe = false;
  release();
  assert.equal(await refresh, false);
  assert.equal(applies, 0);
});

function makeBlockStore(fetchImpl, initialStorage, timeoutImpl) {
  const storage = new Map();
  Object.entries(initialStorage || {}).forEach(([key, value]) => storage.set(key, String(value)));
  const context = {
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => "task-1" },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { onLine: true },
    document: { addEventListener() {}, visibilityState: "visible" },
    addEventListener() {},
    setTimeout: timeoutImpl || (() => 0),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: fetchImpl,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(blockStoreSource, context);
  return context.blockStore;
}

test("initial hydration is allowed with a persisted WAL so boot does not render an empty cache", async () => {
  const store = makeBlockStore(async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: "boot-task", type: "block", date: "2026-08-07", properties: { status: "open" } }],
  }), {
    "blockstore-wal": JSON.stringify([{ op: "update", id: "boot-task", data: { properties: { status: "done" } }, _walId: "w1" }]),
  });
  const loaded = await store.loadDay("2026-08-07");
  assert.ok(Array.isArray(loaded));
  assert.equal(store.get("boot-task").id, "boot-task");
});

test("WAL replay starts a fresh hydration when the initial boot GET is still in flight", async () => {
  let releaseInitial;
  let dayGets = 0;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
  const store = makeBlockStore(async (url, init) => {
    if (init && init.method) {
      return { ok: true, status: 200, json: async () => ({ id: "boot-task", properties: { status: "done" } }) };
    }
    dayGets++;
    if (String(url).includes("date=") && dayGets === 1) await initialGate;
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: "boot-task", type: "block", date: "2026-08-07", properties: { status: dayGets === 1 ? "open" : "done" } }],
    };
  }, {
    "blockstore-wal": JSON.stringify([{ op: "update", id: "boot-task", data: { properties: { status: "done" } }, _walId: "w1" }]),
  });

  const initialLoad = store.loadDay("2026-08-07");
  await store.replayWAL();
  assert.ok(dayGets >= 2, "post-replay hydration must not reuse the pre-replay GET");
  assert.equal(store.get("boot-task").properties.status, "done");
  releaseInitial();
  assert.equal(await initialLoad, null);
  assert.equal(store.get("boot-task").properties.status, "done");
});

test("post-replay global hydration evicts a dateless row deleted by the WAL", async () => {
  let globalGets = 0;
  const store = makeBlockStore(async (url, init) => {
    if (init && init.method === "DELETE") return { ok: true, status: 200, json: async () => ({ id: "global-task" }) };
    if (String(url).includes("type=")) {
      globalGets++;
      return {
        ok: true,
        status: 200,
        json: async () => globalGets === 1
          ? [{ id: "global-task", type: "block", date: null, properties: { status: "open" } }]
          : [],
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  }, {
    "blockstore-wal": JSON.stringify([{ op: "delete", id: "global-task", _walId: "w1" }]),
  });

  await store.loadDay("2026-08-07");
  await store.loadGlobals();
  assert.ok(store.get("global-task"));
  await store.replayWAL();
  assert.equal(store.get("global-task"), null);
  assert.equal(globalGets, 2);
});

test("post-replay hydration retries both partitions after one generation race", async () => {
  let globalGets = 0;
  let store;
  const fetchImpl = async (url, init) => {
    if (init && init.method === "DELETE") return { ok: true, status: 200, json: async () => ({ id: "global-task" }) };
    if (init && init.method === "POST") return { ok: true, status: 200, json: async () => ({}) };
    if (String(url).includes("type=")) {
      globalGets++;
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (globalGets === 1) return [{ id: "global-task", type: "block", date: null, properties: {} }];
          if (globalGets === 2) await store.reorder([]); // invalidate the first post-replay pair
          return [];
        },
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  const timeoutImpl = (fn, delay) => {
    if (delay !== 2000) fn(); // do not run block-store's automatic boot replay
    return 1;
  };
  store = makeBlockStore(fetchImpl, {
    "blockstore-wal": JSON.stringify([{ op: "delete", id: "global-task", _walId: "w1" }]),
  }, timeoutImpl);

  await store.loadDay("2026-08-07");
  await store.loadGlobals();
  await store.replayWAL();
  assert.equal(globalGets, 3, "the invalidated first pair must be retried");
  assert.equal(store.get("global-task"), null);
});

test("BlockStore coalesces same-day reads and rejects a snapshot crossed by a write", async () => {
  let releaseDay;
  let dayGets = 0;
  const dayGate = new Promise((resolve) => { releaseDay = resolve; });
  const store = makeBlockStore(async (url, init) => {
    if (!init || !init.method) {
      dayGets++;
      await dayGate;
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "task-1", type: "block", date: "2026-08-07", properties: { status: "open" } }],
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "task-1", type: "block", date: "2026-08-07", properties: { status: "done" } }),
    };
  });

  const first = store.loadDay("2026-08-07");
  const second = store.loadDay("2026-08-07");
  assert.equal(dayGets, 1, "same-day callers must share one request");

  await store.createBlock("block", { status: "done" }, { date: "2026-08-07" });
  releaseDay();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(store.get("task-1").properties.status, "done", "stale GET must not replace the acknowledged write");
});

test("a foreign row refresh invalidates an older full-day snapshot", async () => {
  let releaseDay;
  let dayGets = 0;
  const gate = new Promise((resolve) => { releaseDay = resolve; });
  const store = makeBlockStore(async (url) => {
    if (String(url).includes("/api/blocks/task-1")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "task-1", type: "block", date: "2026-08-07", properties: { status: "done" } }),
      };
    }
    dayGets++;
    if (dayGets > 1) await gate;
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: "task-1", type: "block", date: "2026-08-07", properties: { status: "open" } }],
    };
  });
  await store.loadDay("2026-08-07");
  const staleDay = store.loadDay("2026-08-07");
  await store.handleBlocksChanged({ blockIds: ["task-1"], clientId: "other-tab" });
  releaseDay();
  assert.equal(await staleDay, null);
  assert.equal(store.get("task-1").properties.status, "done");
});

test("rapid A to B to A navigation starts a fresh final A request", async () => {
  const resolvers = [];
  const requests = [];
  const store = makeBlockStore((url) => new Promise((resolve) => {
    requests.push(String(url));
    resolvers.push((id) => resolve({
      ok: true,
      status: 200,
      json: async () => [{ id, type: "block", date: id.startsWith("A") ? "2026-08-07" : "2026-08-08", properties: {} }],
    }));
  }));
  const firstA = store.loadDay("2026-08-07");
  const b = store.loadDay("2026-08-08");
  const finalA = store.loadDay("2026-08-07");
  assert.equal(requests.length, 3, "returning to A must not reuse the superseded first A request");

  resolvers[2]("A-final");
  assert.ok(Array.isArray(await finalA));
  resolvers[1]("B-stale");
  resolvers[0]("A-stale");
  assert.equal(await b, null);
  assert.equal(await firstA, null);
  assert.ok(store.get("A-final"));
  assert.equal(store.get("B-stale"), null);
});

test("foreign events are coalesced and replayed after optimistic writes drain", async () => {
  const start = sseSource.indexOf("function scheduleDeferredBlockFlush()");
  const end = sseSource.indexOf("\n  const taskRefresh=", start);
  assert.ok(start >= 0 && end > start, "block event coordinator must remain discoverable");
  const timers = [];
  const handled = [];
  let pending = true;
  const context = {
    console: { log() {} },
    deferredBlockEvent: false,
    deferredBlockTimer: null,
    deferredBlockRetryMs: 500,
    deferredBlockOverflow: false,
    deferredBlockIds: new Set(),
    deferredUndeletedIds: new Set(),
    MAX_DEFERRED_BLOCK_IDS: 500,
    window: {
      __RESCHEDULE_IN_FLIGHT__: false,
      location: { reload() { context.reloads = (context.reloads || 0) + 1; } },
      blockStore: {
        CLIENT_ID: "self",
        hasPendingWrites: () => pending,
        getMutationGeneration: () => 0,
        handleBlocksChanged: async (msg) => handled.push([...msg.blockIds]),
      },
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    refoldTaskStateFromBlockCache() { context.refolds = (context.refolds || 0) + 1; },
    render() { context.renders = (context.renders || 0) + 1; },
  };
  vm.createContext(context);
  vm.runInContext(sseSource.slice(start, end), context);

  await vm.runInContext('handleBlockEvent({blockIds:["a"]})', context);
  await vm.runInContext('handleBlockEvent({blockIds:["a","b"]})', context);
  assert.equal(timers.length, 1, "one retry timer serves every queued event");
  assert.deepEqual(handled, []);

  pending = false;
  await timers.shift()();
  assert.deepEqual(handled, [["a", "b"]]);
  assert.equal(context.refolds, 1);
  assert.equal(context.renders, 1);
});
