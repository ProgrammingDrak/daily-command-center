// resolve-owner.js — the ONE place that decides which user/workspace a write
// belongs to. Replaces four hand-rolled copies of the fallback chain that had
// drifted apart (different precedence, different workspace defaults).
//
// Two modes, matching the two real situations:
//
//   resolveOwnerStrict(req)  — interactive/targeted writes (quick-task, brief
//     materialize, blocks quick-add). Session identity wins; in production a
//     request with no resolvable identity is REFUSED (the DCC service token is
//     global — guessing "first workspace owner" would let a token call write
//     onto an arbitrary user's itinerary). Dev keeps the single-user lookup
//     convenience. Async (may consult workspace_members).
//
//   resolveOwnerLenient(req) — scheduled ingest paths (day-state, deep-sweep,
//     triage-check, brief-decision). Service identity wins (a token-authed
//     ingest attributes to the service target, not whatever session cookie
//     happens to ride along), null userId is tolerated (historical behavior;
//     saveDccState accepts it), workspace defaults to "ws-1". Sync — callable
//     from persistDccDay without an async cascade.
//
// If you need a third precedence order, you are probably wrong — extend a mode
// here instead of inlining a new chain in a route.

const { pool } = require("../pg-pool");

function headerOwner(req) {
  return Number(req.headers["x-user-id"] || process.env.DCC_SERVICE_USER_ID || 0) || null;
}

function headerWorkspace(req) {
  return req.headers["x-workspace-id"] || process.env.DCC_SERVICE_WORKSPACE_ID || null;
}

function resolveOwnerLenient(req) {
  const userId = req.dccServiceAuth?.userId || req.session?.userId || headerOwner(req);
  const workspaceId = req.dccServiceAuth?.workspaceId || req.workspaceId
    || headerWorkspace(req) || "ws-1";
  return { userId, workspaceId };
}

async function resolveOwnerStrict(req) {
  let userId = req.session?.userId || req.dccServiceAuth?.userId || headerOwner(req);
  let workspaceId = req.workspaceId || req.dccServiceAuth?.workspaceId || headerWorkspace(req);
  if (!userId) {
    if (process.env.NODE_ENV === "production") {
      const err = new Error("owner required: supply an x-user-id header or set DCC_SERVICE_USER_ID");
      err.status = 400;
      throw err;
    }
    const { rows } = await pool.query(
      "SELECT user_id FROM workspace_members WHERE role='owner'" + (workspaceId ? " AND workspace_id=$1" : "") + " ORDER BY user_id LIMIT 1",
      workspaceId ? [workspaceId] : []
    );
    userId = rows[0] ? rows[0].user_id : 1;
  }
  if (!workspaceId) {
    const { rows } = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' LIMIT 1", [userId]);
    workspaceId = rows[0] ? rows[0].workspace_id : `ws-${userId}`;
  }
  return { userId, workspaceId };
}

module.exports = { resolveOwnerStrict, resolveOwnerLenient };
