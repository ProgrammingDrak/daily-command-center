"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { compactState } = require("./state-projection");
const { safeCursor, parseHistoryCursor, isGlobalBlock, isAllDayBlockOnDate } = require("./sync-store");
const blockStoreSource = fs.readFileSync(path.join(__dirname, "public", "js", "block-store.js"), "utf8");

function makeDeltaStore(fetchImpl) {
  const storage = new Map();
  const events = [];
  const context = {
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => "compact-sync-client" },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { onLine: true },
    document: { addEventListener() {}, visibilityState: "visible" },
    addEventListener() {},
    dispatchEvent: (event) => { events.push(event); },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: fetchImpl,
    DCC_DELTA_SYNC_ENABLED: true,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(blockStoreSource, context);
  return { store: context.blockStore, events };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test("compact state excludes historical ledgers and keeps active fields", () => {
  const compact = compactState({
    date: "2026-08-31",
    meta: { skill_runs: Array(100).fill({ large: true }) },
    mutations: Array(100).fill({ large: true }),
    triage: { open_items: [{ id: "open" }], resolved_items: [{ id: "old" }], cycle_count: 4 },
    completions: { tasks: [
      { task_id: "review", needs_review: true },
      { task_id: "done", needs_review: false },
      { task_id: "reviewed", needs_review: true, reviewed: true },
    ] },
    schedule: { timeline: [{ id: "legacy" }], working_hours: { start: "07:00" } },
  });
  assert.deepEqual(compact.triage.open_items, [{ id: "open" }]);
  assert.equal(compact.triage.resolved_items, undefined);
  assert.equal(compact.meta, undefined);
  assert.equal(compact.mutations, undefined);
  assert.deepEqual(compact.completions.tasks.map((row) => row.task_id), ["review"]);
  assert.equal(compact.schedule.timeline, undefined);
  assert.deepEqual(compact.schedule.working_hours, { start: "07:00" });
});

test("archive projection keeps the legacy timeline only when requested", () => {
  const compact = compactState({
    date: "2026-05-01",
    schedule: { timeline: [{ id: "legacy" }] },
    meetings: [{ id: "meeting" }],
  }, { archive: true });
  assert.deepEqual(compact.schedule.timeline, [{ id: "legacy" }]);
  assert.deepEqual(compact.meetings, [{ id: "meeting" }]);
});

test("sync cursors reject unsafe values", () => {
  assert.equal(safeCursor("42"), 42);
  assert.throws(() => safeCursor("-1"), /non-negative/);
  assert.throws(() => safeCursor("1.5"), /non-negative/);
  assert.deepEqual(parseHistoryCursor("2026-08-31T12:00:00.123456Z|42"), {
    beforeAt: "2026-08-31T12:00:00.123456Z",
    beforeId: "42",
  });
  assert.throws(() => parseHistoryCursor("not-a-cursor"), /invalid history cursor/);
});

test("global classification matches BlockStore partitions", () => {
  assert.equal(isGlobalBlock({ type: "block", date: null, properties: {} }), true);
  assert.equal(isGlobalBlock({ type: "block", date: null, properties: { kind: "triage_suppression" } }), false);
  assert.equal(isGlobalBlock({ type: "tag", date: null, properties: {} }), true);
  assert.equal(isGlobalBlock({ type: "block", date: "2026-08-31", properties: { tags: ["pinned"] } }), true);
  assert.equal(isGlobalBlock({ type: "block", date: "2026-08-31", properties: {} }), false);
  assert.equal(isAllDayBlockOnDate({ properties: {
    all_day: true,
    all_day_start: "2026-08-30",
    all_day_end: "2026-09-02",
  } }, "2026-08-31"), true);
  assert.equal(isAllDayBlockOnDate({ properties: {
    all_day: true,
    all_day_start: "2026-08-30",
    all_day_end: "2026-08-31",
  } }, "2026-08-31"), false);
});

test("forced overlay refresh survives a transient delta failure", async () => {
  const urls = [];
  let pullCount = 0;
  const { store } = makeDeltaStore(async (url) => {
    urls.push(String(url));
    if (String(url).includes("/api/sync/bootstrap")) {
      return jsonResponse({
        workspaceId: "ws-1", date: "2026-08-31", cursor: 1,
        blocks: [], globals: [], dayState: { version: "initial" },
      });
    }
    pullCount++;
    if (pullCount === 1) throw new Error("temporary network failure");
    return jsonResponse({
      cursor: 2, blocks: [], deletedBlockIds: [], hasMore: false,
      dayState: { version: "fresh" },
    });
  });

  await store.loadDay("2026-08-31");
  await assert.rejects(store.handleDccStateChanged({}), /temporary network failure/);
  await store.pullSyncChanges("2026-08-31");
  const pullUrls = urls.filter((url) => url.includes("/api/sync/pull"));
  assert.equal(pullUrls.length, 2);
  assert.match(pullUrls[0], /includeState=1/);
  assert.match(pullUrls[1], /includeState=1/);
});

test("date navigation waits for the active pull and discards its old-day result", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const { store } = makeDeltaStore(async (url) => {
    const value = String(url);
    calls.push(value);
    const date = new URL(value, "https://dcc.test").searchParams.get("date");
    if (date === "2026-08-30") await gate;
    return jsonResponse({
      workspaceId: "ws-1", date, cursor: date === "2026-08-30" ? 1 : 2,
      blocks: [{ id: `root-${date}`, type: "day_root", date, properties: {} }],
      globals: [], dayState: { date },
    });
  });

  const first = store.loadDay("2026-08-30");
  const second = store.loadDay("2026-08-31");
  releaseFirst();
  assert.equal(await first, null);
  const current = await second;
  assert.deepEqual(Array.from(current, (block) => block.id), ["root-2026-08-31"]);
  assert.deepEqual(calls.map((url) => new URL(url, "https://dcc.test").searchParams.get("date")), [
    "2026-08-30", "2026-08-31",
  ]);
});

test("hot paths use compact projections and server cursor routes", () => {
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const db = fs.readFileSync(path.join(__dirname, "db.js"), "utf8");
  const schema = fs.readFileSync(path.join(__dirname, "pg-schema.js"), "utf8");
  const syncRoute = fs.readFileSync(path.join(__dirname, "routes", "sync.js"), "utf8");
  const syncStore = fs.readFileSync(path.join(__dirname, "sync-store.js"), "utf8");
  const sse = fs.readFileSync(path.join(__dirname, "public", "js", "sse.js"), "utf8");
  assert.match(server, /getDccStateCompact\(dateStr, ws\)/);
  assert.match(server, /MAX_PUBLIC_SSE_CLIENTS/);
  assert.match(server, /MAX_PUBLIC_SSE_PER_WORKSPACE/);
  assert.match(db, /async function getDccStateCompact/);
  assert.doesNotMatch(db.match(/async function getDccStateRange[\s\S]*?\n\}/)[0], /SELECT \*/);
  assert.match(db.match(/async function getDccStateRange[\s\S]*?\n\}/)[0], /glymphatic_brief/);
  assert.match(syncRoute, /\/api\/sync\/bootstrap/);
  assert.match(syncRoute, /\/api\/sync\/pull/);
  assert.match(syncRoute, /\/api\/triage\/history/);
  assert.doesNotMatch(syncRoute, /writeJSON\(/);
  assert.doesNotMatch(syncRoute, /await blockDB\.createBlock/);
  assert.match(syncRoute, /MAX_RESOLUTION_EVENTS/);
  assert.match(syncRoute, /snapshot\.dayState = await buildDayResponse/);
  assert.match(syncRoute, /delta\.dayState = await buildDayResponse/);
  assert.match(syncRoute, /req\.query\.includeState === "1"/);
  assert.ok(syncRoute.indexOf("resolvedEvents.length > MAX_RESOLUTION_EVENTS") < syncRoute.indexOf("materializeMeetings"));
  assert.match(syncStore, /JSON\.stringify\(normalized\)/);
  assert.match(sse, /dcc-sync-day-state[\s\S]*?if\(isEditing\(\)\)/);
  assert.match(syncStore, /dayStateChanged/);
  assert.match(schema, /CREATE TRIGGER trg_dcc_state_sync_event[\s\S]*?dcc_capture_sync_event\(\)/);
});
