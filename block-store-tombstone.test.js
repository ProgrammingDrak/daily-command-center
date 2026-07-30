// Contract tests for the CLIENT half of the delete contract in public/js/block-store.js:
// the `_tombstones` set, the batchOp delete-result guard, and the deleted_at check in
// handleBlocksChanged. All three exist to stop a row this tab deleted from coming back
// into the cache, which is the user-visible "it reappeared until I refreshed" symptom.
//
// Without these tests a revert of any of the three is invisible to CI: delete-subtree
// stubs blockStore out wholesale, so nothing else exercises this file's delete paths.
//
// Harness pattern: block-store-wal.test.js (raw source in a node:vm context with an
// in-memory localStorage and a stubbed fetch), extended so fetch can answer per-URL --
// a batch POST and a subsequent GET /api/blocks/:id need different bodies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/block-store.js"), "utf8");

const DAY = "2026-07-29";
const TOMB = "2026-07-29T12:00:00.000Z";

// `routes` maps a substring of the request URL to a body (or a function of the call).
function makeStore({ routes = {}, method } = {}) {
  const storage = new Map();
  const fetchCalls = [];
  const context = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) },
    navigator: { onLine: true },
    addEventListener: () => {},
    removeEventListener: () => {},
    document: { addEventListener: () => {}, visibilityState: "visible" },
    fetch: async (url, init) => {
      fetchCalls.push({ url, method: (init && init.method) || "GET" });
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      const body = key ? routes[key] : {};
      const resolved = typeof body === "function" ? body() : body;
      // A route may answer with a status instead of a body ({ __status: 404 }), which
      // is what A2's tombstone 404 looks like on the wire.
      const status = (resolved && resolved.__status) || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => resolved,
      };
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  if (method) void method;
  return { store: context.window.blockStore, fetchCalls, storage };
}

const liveBlock = (id) => ({ id, type: "block", date: DAY, properties: { local_id: "t-" + id }, deleted_at: null });
const getCalls = (calls, id) => calls.filter((c) => c.method === "GET" && c.url.includes("/api/blocks/" + id));

test("a batch delete evicts the row instead of caching db.deleteBlock's bare stub", async () => {
  // db.deleteBlock returns { id, deleted_at } with no type and no properties. Caching
  // that would file a typeless, propertyless "block" into the day cache under the very
  // id just deleted, so the row reads as present again.
  const { store } = makeStore({
    routes: {
      "/api/blocks/batch": { blocks: [{ id: "B1", deleted_at: TOMB }] },
      "/api/blocks": liveBlock("B1"),
    },
  });
  await store.createBlock("block", { local_id: "t-B1" }, { date: DAY });
  assert.ok(store.get("B1"), "row is cached before the delete");

  await store.batchOp([{ op: "delete", id: "B1" }]);
  assert.strictEqual(store.get("B1"), null, "the delete-op result must not be cached back");
});

test("a batch create still caches its rows", async () => {
  // The deleted_at guard must not throw the create results out with the delete stubs.
  const { store } = makeStore({
    routes: { "/api/blocks/batch": { blocks: [liveBlock("B9")] } },
  });
  await store.batchOp([{ op: "create", type: "block", date: DAY, properties: { local_id: "t-B9" } }]);
  assert.ok(store.get("B9"), "a restored row lands in the cache");
});

test("an SSE broadcast naming an id this tab deleted is not re-fetched", async () => {
  // GET /api/blocks/:id has no deleted_at filter yet (A2 adds the 404), so re-fetching
  // our own tombstone is how the row used to come back.
  const { store, fetchCalls } = makeStore({
    routes: {
      "/api/blocks/batch": { blocks: [{ id: "B1", deleted_at: TOMB }] },
      "/api/blocks": liveBlock("B1"),
    },
  });
  await store.createBlock("block", { local_id: "t-B1" }, { date: DAY });
  await store.batchOp([{ op: "delete", id: "B1" }]);

  const before = getCalls(fetchCalls, "B1").length;
  await store.handleBlocksChanged({ clientId: "some-other-tab", blockIds: ["B1"] });
  assert.strictEqual(getCalls(fetchCalls, "B1").length, before, "no GET for a tombstoned id");
  assert.strictEqual(store.get("B1"), null);
});

test("deleteBlock also tombstones, so its own broadcast cannot resurrect the row", async () => {
  const { store, fetchCalls } = makeStore({ routes: { "/api/blocks": liveBlock("B4") } });
  await store.createBlock("block", { local_id: "t-B4" }, { date: DAY });
  await store.deleteBlock("B4");

  const before = getCalls(fetchCalls, "B4").length;
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B4"] });
  assert.strictEqual(getCalls(fetchCalls, "B4").length, before);
  assert.strictEqual(store.get("B4"), null);
});

test("a foreign tab's delete evicts on deleted_at rather than caching the tombstone", async () => {
  // No local tombstone covers another tab's delete, so the fetched row's own
  // deleted_at is the only signal. This is the bigger half of the hole.
  const { store } = makeStore({
    routes: { "/api/blocks/B2": { id: "B2", type: "block", date: DAY, properties: {}, deleted_at: TOMB } },
  });
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B2"] });
  assert.strictEqual(store.get("B2"), null, "a soft-deleted row must never enter the cache");
});

// ── A2 (Track A): the route now 404s on a tombstone ──
// Added from Track A with Drake's explicit go, because A2's server change is what
// creates the case. Measured both ways against a real browser before and after: on
// origin/main the foreign delete purged the cache, and with A2's 404 alone it did not.

test("a foreign tab's delete evicts on a 404 too, now that the route hides tombstones", async () => {
  // The A2 shape. There is no row to read deleted_at off any more, so the status IS
  // the signal. A bare `catch {}` here leaves the deleted row rendering in this tab
  // until a reload — delete on your phone, desktop keeps showing it.
  const { store } = makeStore({
    routes: { "/api/blocks/B6": liveBlock("B6"), "/api/blocks/B7": { __status: 404 } },
  });
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B6"] });
  assert.ok(store.get("B6"), "control: a live row still caches");

  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B7"] });
  assert.strictEqual(store.get("B7"), null);
});

test("a 404 evicts a row this tab already had cached", async () => {
  // The case that actually bites: the row is in the day cache from a normal load, then
  // another tab deletes it. Eviction has to happen, not just "we declined to add it".
  let deleted = false;
  const { store } = makeStore({
    routes: {
      "/api/blocks/B8": () => (deleted ? { __status: 404 } : liveBlock("B8")),
      "/api/blocks": liveBlock("B8"),
    },
  });
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B8"] });
  assert.ok(store.get("B8"), "cached from the first broadcast");

  deleted = true;
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B8"] });
  assert.strictEqual(store.get("B8"), null, "the 404 must evict, not merely decline");
});

test("a NON-404 failure does not evict a live row", async () => {
  // The dangerous over-correction. Offline, a 500, or SSE racing a redeploy must stay
  // swallowed: evicting on those blanks rows that are perfectly alive, and the user
  // watches their day empty itself during a deploy.
  let broken = false;
  const { store } = makeStore({
    routes: { "/api/blocks/B10": () => (broken ? { __status: 500 } : liveBlock("B10")) },
  });
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B10"] });
  assert.ok(store.get("B10"));

  broken = true;
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B10"] });
  assert.ok(store.get("B10"), "a server error is not evidence the row is gone");
});

test("a live row from a foreign broadcast is still cached normally", async () => {
  const { store } = makeStore({ routes: { "/api/blocks/B3": liveBlock("B3") } });
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B3"] });
  assert.ok(store.get("B3"), "the tombstone guard must not block ordinary updates");
});

test("re-caching a row clears its tombstone so a genuine restore is not suppressed", async () => {
  const { store, fetchCalls } = makeStore({
    routes: { "/api/blocks": liveBlock("B5"), "/api/blocks/B5": liveBlock("B5") },
  });
  await store.createBlock("block", { local_id: "t-B5" }, { date: DAY });
  await store.deleteBlock("B5");
  assert.strictEqual(store.get("B5"), null);

  // A local write puts the id back (loadDay only ever returns live rows), which must
  // un-tombstone it -- otherwise this tab ignores that id's broadcasts until reload.
  await store.createBlock("block", { local_id: "t-B5" }, { date: DAY });
  const before = getCalls(fetchCalls, "B5").length;
  await store.handleBlocksChanged({ clientId: "other", blockIds: ["B5"] });
  assert.strictEqual(getCalls(fetchCalls, "B5").length, before + 1, "the id is fetched again once live");
  assert.ok(store.get("B5"));
});

test("own-client broadcasts are still ignored outright", async () => {
  const { store, fetchCalls } = makeStore({ routes: { "/api/blocks/B6": liveBlock("B6") } });
  await store.handleBlocksChanged({ clientId: store.CLIENT_ID, blockIds: ["B6"] });
  assert.strictEqual(getCalls(fetchCalls, "B6").length, 0, "we already applied our own change");
});
