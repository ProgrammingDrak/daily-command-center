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

const pool = require("../pg-pool");

function resolveOwnerLenient(req) {
  const userId = req.dccServiceAuth?.userId || req.session?.userId;
  const workspaceId = req.dccServiceAuth?.workspaceId || req.workspaceId || req.session?.workspaceId;
  if (!userId || !workspaceId) throw Object.assign(new Error("Authenticated account and workspace required"),{statusCode:401});
  return { userId, workspaceId };
}

async function resolveOwnerStrict(req) {
  let userId = req.session?.userId || req.dccServiceAuth?.userId;
  let workspaceId = req.dccServiceAuth?.workspaceId || req.workspaceId || req.session?.workspaceId;
  if (!userId) throw Object.assign(new Error('Authenticated account required'),{statusCode:401});
  if (!workspaceId) {
    const { rows } = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ", [userId]);
    if(rows.length!==1)throw Object.assign(new Error('Select a workspace'),{statusCode:409});
    workspaceId=rows[0].workspace_id;
  }
  return { userId, workspaceId };
}

module.exports = { resolveOwnerStrict, resolveOwnerLenient };
