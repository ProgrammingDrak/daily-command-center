// POST /api/blocks/batch must authorize every op that names an existing block.
//
// The hole this guards: the handler stamped user_id/workspace_id onto `create` ops
// and passed `update` / `delete` / `reorder` straight to blockDB.batchOp with no
// ownership check, while PATCH /:id, DELETE /:id, GET /:id and POST /reorder all
// call assertBlockOwnership. db.deleteBlock's only lookup is
// `SELECT * FROM blocks WHERE id = $1` with no workspace_id predicate, so an
// authenticated session could soft-delete or mutate ANY block in ANY workspace by
// posting a batch. It predated this project but became reachable when the client's
// delete path moved onto /batch (B1, #256).
//
// routes/blocks.js is an (app, ctx) factory, so it mounts on a bare express app with
// fake stores, the same harness as slots-earn-broadcast.test.js. req.workspaceId and
// req.session come from server middleware in the real app, so they are injected here.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const FOREIGN = "ws-someone-else";
const MINE = "ws-1";

// `theirs-root` is a container in another workspace, standing in for a day_root. Its id
// shape is derivable (`day-root-<workspace>-<date>`), so reaching one needs no
// reconnaissance, which is why parent_id has to be authorized like any other reference.
function makeBlocks() {
  return {
    "mine-1": { id: "mine-1", type: "block", workspace_id: MINE, properties: {}, deleted_at: null },
    "mine-2": { id: "mine-2", type: "block", workspace_id: MINE, properties: {}, deleted_at: null },
    "mine-root": { id: "mine-root", type: "day_root", workspace_id: MINE, properties: {}, deleted_at: null },
    "mine-gone": { id: "mine-gone", type: "block", workspace_id: MINE, properties: {}, deleted_at: "2026-07-29T00:00:00Z" },
    "theirs-1": { id: "theirs-1", type: "block", workspace_id: FOREIGN, properties: {}, deleted_at: null },
    "theirs-root": { id: "theirs-root", type: "day_root", workspace_id: FOREIGN, properties: {}, deleted_at: null },
  };
}

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = MINE; req.session = { userId: 1 }; next(); });

  const blocks = makeBlocks();
  const batched = [];
  const ctx = {
    blockDB: {
      // The call the fix relies on. Tombstone-inclusive by contract, which is why it is
      // NOT the same closure as getBlock below: if the route were switched back to
      // getBlock, the tombstone test would have to keep passing for the wrong reason.
      getBlockIncludingDeleted: async (id) => blocks[id] || null,
      getBlock: async (id) => (blocks[id] && !blocks[id].deleted_at ? blocks[id] : null),
      // Faithful enough to matter: the real db.batchOp runs ops in order on one client,
      // so it raises "Block not found" for an unknown id and "Block is deleted" when an
      // update lands on a tombstone. A permissive stub would let these tests assert 200
      // for batches production rejects with a 500.
      batchOp: async (ops) => {
        batched.push(ops);
        const staged = { ...blocks };
        for (const o of ops) {
          if (!o || o.op === "create" || o.op === "reorder") continue;
          const row = staged[o.id];
          if (!row) throw new Error(`Block not found: ${o.id}`);
          if (o.op === "update" && row.deleted_at) throw new Error(`Block is deleted: ${o.id}`);
          if (o.op === "delete") staged[o.id] = { ...row, deleted_at: "2026-07-30T00:00:00Z" };
        }
        return { batchId: "b1", blocks: ops.map((o) => ({ id: (o && o.id) || "new" })) };
      },
      reorderBlocks: async () => {},
      getBlocksByDate: async () => [],
      getBlocksByTypes: async () => [],
      getDelegatedItems: async () => [],
      getUndatedTaskBlocks: async () => [],
      getBlocksByDateRange: async () => [],
      getResponsibilityBlocks: async () => [],
      getBlocksByKind: async () => [],
    },
    broadcast: () => {},
    crypto: require("node:crypto"),
    filterLegacyGcalBlocks: (b) => b,
    getScheduleBlocks: async () => [],
    getTodayStr: () => "2026-07-30",
    isAllowedSweepBlockItem: () => true,
    isValidDate: () => true,
    pool: { query: async () => ({ rows: [{ workspace_id: MINE, user_id: 1 }] }) },
  };
  require("./routes/blocks.js")(app, ctx);
  return { app, batched };
}

async function postBatch(app, operations) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/blocks/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations }),
    });
    let json = null;
    try { json = await resp.json(); } catch { /* empty body */ }
    return { status: resp.status, json };
  } finally { server.close(); }
}

// The refusal tests assert the BODY as well as the status, because express's own
// unmatched-route handler also returns a bare 404. Without that assertion these would
// all pass with the route unmounted, and the only failure would look like one broken
// happy path rather than "authorization is untested".
test("a batch delete of another workspace's block is refused", async () => {
  const { app, batched } = mountApp();
  const { status, json } = await postBatch(app, [{ op: "delete", id: "theirs-1" }]);
  assert.equal(status, 404, "must not leak that the block exists");
  assert.equal(json.error, "Block not found", "same message as an absent id, deliberately");
  assert.equal(batched.length, 0, "and must never reach batchOp");
});

test("a batch update of another workspace's block is refused", async () => {
  const { app, batched } = mountApp();
  const { status, json } = await postBatch(app, [{ op: "update", id: "theirs-1", properties: { title: "pwned" } }]);
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.equal(batched.length, 0);
});

test("a batch reorder is checked per item, not just on the first", async () => {
  // The interesting case: a legitimate own-block id first, so a naive check that only
  // looked at operations[0] or at op.id (which reorder does not have) passes.
  const { app, batched } = mountApp();
  const { status, json } = await postBatch(app, [
    { op: "reorder", items: [{ id: "mine-1", sort_order: 1000 }, { id: "theirs-1", sort_order: 2000 }] },
  ]);
  assert.equal(status, 404);
  assert.equal(json.error, "Block not found");
  assert.equal(batched.length, 0);
});

test("one foreign op poisons the whole batch, nothing is applied", async () => {
  // batchOp is transactional, so a partially-authorized batch must be rejected
  // wholesale rather than having its legal ops applied.
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [
    { op: "delete", id: "mine-1" },
    { op: "delete", id: "theirs-1" },
  ]);
  assert.equal(status, 404);
  assert.equal(batched.length, 0, "the caller's own legal delete must not go through either");
});

// ── parent_id is a reference too, and on CREATE as well ──
// This is the escalation the first version of the fix missed. Stamping our own
// workspace_id onto a create does not make its parent_id harmless: db.reorderBlocks'
// rebalance selects siblings by parent_id, so creates parented onto a foreign container
// plus one reorder with equal sort_orders renumbered that whole foreign subtree.
// Reproduced live before the guard: HTTP 200, victim's order rewritten.

test("a create parented onto another workspace's container is refused", async () => {
  const { app, batched } = mountApp();
  const { status, json } = await postBatch(app, [
    { op: "create", type: "block", parent_id: "theirs-root", properties: { title: "graft" } },
  ]);
  assert.equal(status, 404, "a create is owner-stamped, but its parent_id is still a foreign reference");
  assert.equal(json.error, "Block not found");
  assert.equal(batched.length, 0);
});

test("an update repointing parent_id at another workspace is refused", async () => {
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [
    { op: "update", id: "mine-1", parent_id: "theirs-root", properties: { title: "moved" } },
  ]);
  assert.equal(status, 404, "own row, foreign destination");
  assert.equal(batched.length, 0);
});

test("the live exploit shape is refused: two grafted creates plus a colliding reorder", async () => {
  // Verbatim shape of the request that worked before the guard.
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [
    { op: "create", id: "atk-1", type: "block", parent_id: "theirs-root", properties: { title: "a" } },
    { op: "create", id: "atk-2", type: "block", parent_id: "theirs-root", properties: { title: "b" } },
    { op: "reorder", items: [{ id: "atk-1", sort_order: 1 }, { id: "atk-2", sort_order: 1 }] },
  ]);
  assert.equal(status, 404);
  assert.equal(batched.length, 0);
});

test("a create parented onto the caller's OWN container still works", async () => {
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [
    { op: "create", type: "block", parent_id: "mine-root", properties: { title: "legit" } },
  ]);
  assert.equal(status, 200, "the common client shape must not regress");
  assert.equal(batched.length, 1);
});

test("own blocks still batch normally", async () => {
  // Distinct ids on purpose: delete-then-update of the SAME id is a batch the real
  // db.batchOp rejects (updateBlock throws "Block is deleted"), so asserting 200 on
  // that shape would only be testing a permissive mock.
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [
    { op: "delete", id: "mine-1" },
    { op: "update", id: "mine-2", properties: { title: "ok" } },
    { op: "reorder", items: [{ id: "mine-2", sort_order: 1000 }] },
  ]);
  assert.equal(status, 200);
  assert.equal(batched.length, 1);
  assert.equal(batched[0].length, 3);
});

test("an update landing on the caller's own tombstone still reports batchOp's error", async () => {
  // The guard must not swallow this: "Block is deleted" has to stay the error the
  // caller sees, which is why the pre-check only asserts ownership.
  const { app } = mountApp();
  const { status } = await postBatch(app, [{ op: "update", id: "mine-gone", properties: { title: "x" } }]);
  assert.equal(status, 500, "a plain Error from batchOp carries no statusCode");
});

test("a repeat delete of an already-tombstoned own block stays idempotent", async () => {
  // Why the check uses getBlockIncludingDeleted: a tombstone-blind lookup would
  // 404 here, breaking B1's delete path, which re-sends deletes from its WAL.
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [{ op: "delete", id: "mine-gone" }]);
  assert.equal(status, 200);
  assert.equal(batched.length, 1);
});

test("create ops need no pre-check and are still owner-stamped", async () => {
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [{ op: "create", type: "block", properties: { title: "new" } }]);
  assert.equal(status, 200);
  assert.equal(batched[0][0].workspace_id, MINE);
  assert.equal(batched[0][0].user_id, 1);
});

test("an unknown id is left to batchOp rather than pre-rejected", async () => {
  // Same `if (block)` shape as the /reorder handler: absence is not an authorization
  // question, so the pre-check skips it and batchOp raises its own "Block not found".
  // That surfaces as a 500 because it is a plain Error with no statusCode, noted here
  // rather than papered over, since it differs from DELETE /:id's explicit 404.
  const { app, batched } = mountApp();
  const { status } = await postBatch(app, [{ op: "delete", id: "does-not-exist" }]);
  assert.equal(status, 500, "batchOp owns the not-found error, and it carries no statusCode");
  assert.equal(batched.length, 1, "the pre-check let it through rather than rejecting it");
});

test("a null entry in operations does not crash the handler", async () => {
  const { app } = mountApp();
  const { status } = await postBatch(app, [null]);
  assert.notEqual(status, 500, "must not TypeError on op.op");
});
