// createBlock's fresh-insert exit used to hand-list the columns it returned
// instead of using the `RETURNING *` row, so every column nobody remembered to
// add was simply absent from the object callers got back. Two were: `user_id`
// and `workspace_id`. The two OTHER exits (the ON CONFLICT re-read and the
// idempotency winner) both normalize through parseBlock and carried them, so a
// replayed create knew its tenant and a first one did not.
//
// That asymmetry broke meeting follow-ups. meeting-automation's
// approvedActionMatches() scopes with
// `String(action.workspace_id || "") !== String(workspaceId || "")`, so the block
// approveActions had just created read as belonging to no workspace and failed
// its own match. placeProposedAction (POST /api/meetings/:id/actions/:id/schedule,
// the Loose Ends "Today" button) approves-then-places in ONE call and trusts that
// returned object, so it threw 409 "Could not approve meeting action" for any
// proposal not already approved. The Recap tab survived only because
// placeApprovedAction re-fetches through getBlock.
//
// These tests pin the INVARIANT, not the two names that happened to be missing:
// every column the INSERT writes must come back out. A twelfth column added to
// `blocks` and forgotten in the return fails here on day one.
//
// Harness: the require.cache pool injection used by batchop-tx.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadDbWithMock(mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const dbPath = require.resolve("./db");
  delete require.cache[poolPath];
  delete require.cache[dbPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  return require("./db");
}

// Answers only what createBlock asks on the plain path: the INSERT ... RETURNING *
// and the operations-log INSERT. Passing an explicit sort_order keeps
// nextSortOrderForDay out of it, exactly as approveActions does.
//
// The row is BUILT FROM the statement's own column list rather than hand-written,
// which is what makes the round-trip assertion below meaningful: the mock cannot
// quietly agree with a return value that has drifted from the INSERT.
function makeMockPool() {
  let lastInsert = null;
  return {
    lastInsert: () => lastInsert,
    async query(sql, params = []) {
      const text = String(sql).trim();
      if (text.startsWith("INSERT INTO blocks")) {
        const cols = text.match(/INSERT INTO blocks \(([^)]+)\)/)[1].split(",").map(c => c.trim());
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i] === undefined ? null : params[i]; });
        row.deleted_at = null;
        lastInsert = { cols, params, row };
        return { rows: [row] };
      }
      if (text.startsWith("INSERT INTO operations")) return { rows: [] };
      throw new Error("unexpected query: " + text.slice(0, 60));
    },
  };
}

test("every column a fresh create writes comes back out of it", async () => {
  const pool = makeMockPool();
  const db = loadDbWithMock(pool);
  const created = await db.createBlock({
    type: "block",
    parent_id: "mtg-1",
    date: "2026-08-20",
    properties: { title: "Follow up", tags: ["action-item"] },
    sort_order: 500,
    user_id: 7,
    workspace_id: "ws-1",
  });

  const { cols, params } = pool.lastInsert();
  for (let i = 0; i < cols.length; i++) {
    // `properties` is deliberately the caller's parsed object, not the row's copy.
    if (cols[i] === "properties") continue;
    assert.deepEqual(created[cols[i]], params[i], `${cols[i]} must survive the create`);
  }
  assert.equal(created.deleted_at, null);
  // The two that were actually missing, named so the regression is unmissable.
  assert.equal(created.workspace_id, "ws-1");
  assert.equal(created.user_id, 7);
  // Reference identity, which is why this exit re-attaches props instead of
  // taking the row's copy.
  assert.equal(created.properties.title, "Follow up");
});

test("an unscoped create returns a null tenant, never a missing one", async () => {
  const db = loadDbWithMock(makeMockPool());
  const created = await db.createBlock({
    type: "block", date: "2026-08-20", properties: {}, sort_order: 0,
  });
  assert.ok("workspace_id" in created, "the key must exist even when the tenant is null");
  assert.ok("user_id" in created, "the key must exist even when the owner is null");
  assert.equal(created.workspace_id, null);
  assert.equal(created.user_id, null);
});

test("the real approvedActionMatches accepts the block approveActions just created", async () => {
  const pool = makeMockPool();
  const db = loadDbWithMock(pool);
  // Load meeting-automation AFTER db.js is mocked so it closes over this db.
  delete require.cache[require.resolve("./meeting-automation")];
  const { approvedActionMatches } = require("./meeting-automation");
  assert.equal(typeof approvedActionMatches, "function", "meeting-automation must export the predicate under test");

  const workspaceId = "ws-1";
  const proposal = { id: "prop-1", parent_id: "mtg-1" };
  // The properties approveActions stamps onto the action it mints.
  const action = await db.createBlock({
    type: "block",
    parent_id: proposal.parent_id,
    date: "2026-08-20",
    properties: {
      title: "Follow up",
      meetingAutomation: { meetingBlockId: proposal.parent_id, proposedActionId: proposal.id },
    },
    sort_order: 500,
    user_id: 7,
    workspace_id: workspaceId,
  });

  assert.equal(
    approvedActionMatches(action, proposal, workspaceId), true,
    "a just-approved action must not read as another workspace's"
  );
});
