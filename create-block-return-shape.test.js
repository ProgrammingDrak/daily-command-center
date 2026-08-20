// createBlock's fresh-insert exit hand-builds its return value instead of using
// the `RETURNING *` row, so every column it forgets is simply absent from the
// object the caller gets back. It forgot `workspace_id` (and `user_id`), and the
// two OTHER exits — the ON CONFLICT re-read (parseBlock) and the idempotency
// winner (findByIdempotencyKey) — both carry them. Callers therefore saw the
// tenant on a replayed create and `undefined` on a first one.
//
// That asymmetry broke meeting follow-ups: meeting-automation's
// approvedActionMatches() scopes with
// `String(action.workspace_id || "") !== String(workspaceId || "")`, so the block
// approveActions had just created read as belonging to no workspace and failed
// its own match. placeProposedAction (POST /api/meetings/:id/actions/:id/schedule,
// the Loose Ends "Today" button) approves-then-places in ONE call and trusts that
// returned object, so it threw 409 "Could not approve meeting action" for any
// proposal that had not already been approved. The Recap tab's two-step path
// survived only because placeApprovedAction re-fetches through getBlock.
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
function makeMockPool() {
  return {
    async query(sql, params = []) {
      const text = String(sql).trim();
      if (text.startsWith("INSERT INTO blocks")) {
        const [id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at] = params;
        return { rows: [{ id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at, deleted_at: null }] };
      }
      if (text.startsWith("INSERT INTO operations")) return { rows: [] };
      throw new Error("unexpected query: " + text.slice(0, 60));
    },
  };
}

test("a fresh createBlock returns the row's tenant, not an undefined one", async () => {
  const db = loadDbWithMock(makeMockPool());
  const created = await db.createBlock({
    type: "block",
    parent_id: "mtg-1",
    date: "2026-08-20",
    properties: { title: "Follow up", tags: ["action-item"] },
    sort_order: 500,
    user_id: 7,
    workspace_id: "ws-1",
  });
  assert.equal(created.workspace_id, "ws-1", "workspace_id must survive the create");
  assert.equal(created.user_id, 7, "user_id must survive the create");
});

test("the approved-action scoping meeting-automation applies passes on that row", async () => {
  const db = loadDbWithMock(makeMockPool());
  const workspaceId = "ws-1";
  const action = await db.createBlock({
    type: "block",
    parent_id: "mtg-1",
    date: "2026-08-20",
    properties: {
      title: "Follow up",
      meetingAutomation: { meetingBlockId: "mtg-1", proposedActionId: "prop-1" },
    },
    sort_order: 500,
    user_id: 7,
    workspace_id: workspaceId,
  });
  // Verbatim from meeting-automation.js approvedActionMatches().
  const scoped = !(!action || action.deleted_at ||
    String(action.workspace_id || "") !== String(workspaceId || ""));
  assert.equal(scoped, true, "a just-approved action must not read as another workspace's");
});
