/**
 * access-store.js — per-owner delegated access: who may act on whose data.
 *
 * The one question this module answers: given a VIEWER and an OWNER, what role
 * does the viewer hold over that owner's data? Everything else in the app asks
 * capabilities.can(tier, capability, { role }) with the answer.
 *
 * Design rules, every one of them a lesson this codebase has already paid for:
 *
 *  - PER-OWNER AND DIRECTIONAL. A row is (owner, grantee, role). Marcus coaching
 *    Drake is not Drake coaching Marcus, and resolveRole is always asked about a
 *    specific pair. There is no global "is a coach".
 *
 *  - A BLOCK REVOKES A GRANT, and that veto lives HERE rather than at each call
 *    site. social-store.areFriends shipped without it and a blocked user kept
 *    passing every friend gate, because friendships rows are directed and the
 *    accepted row survives a block. Same shape, same trap: the veto is inside
 *    resolveRole so a future route physically cannot forget it.
 *
 *  - SELF IS "owner", ALWAYS. Resolving your own id returns the top role without
 *    reading the table, so your access to your own day can never depend on a row
 *    existing, and a bug in grant plumbing can never lock you out of your own
 *    itinerary.
 *
 *  - GRANTING IS OWNER-ONLY. Every mutation here takes the owner id as the actor
 *    and writes rows for that owner alone. No role can grant. There is no
 *    function in this file a coach could call to widen their own access, and
 *    capabilities.js deliberately has no `grant_access` capability to hand out.
 *
 *  - REVOKE DELETES. access_grants holds only live grants, so no read needs an
 *    "is it still valid" predicate. The history lives in access_grant_events.
 */

const pool = require("./pg-pool");
const capabilities = require("./capabilities");

/** Append to the audit ledger. Never throws into the caller's transaction path:
 *  a missing audit row is bad, a failed revoke because of one is worse. */
async function recordGrantEvent({ ownerUserId, granteeUserId, actorUserId, eventType, role = null, previousRole = null, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO access_grant_events
         (owner_user_id, grantee_user_id, actor_user_id, event_type, role, previous_role, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ownerUserId, granteeUserId, actorUserId, eventType, role, previousRole, JSON.stringify(metadata)]
    );
  } catch (e) {
    console.error("[access] audit write failed (non-fatal):", e.message);
  }
}

/**
 * The role `viewerUserId` holds over `ownerUserId`'s data.
 *
 * Returns one of capabilities.ROLES. "owner" for self, "none" for a stranger, a
 * blocked pair, or anything unrecognised. FAILS CLOSED: any error resolves to
 * "none" rather than leaving a caller to decide what a thrown error means about
 * authorization.
 */
async function resolveRole(viewerUserId, ownerUserId) {
  const viewer = Number(viewerUserId);
  const owner = Number(ownerUserId);
  if (!Number.isFinite(viewer) || !Number.isFinite(owner)) return "none";
  // Self, before any table read: your own access is never a row that could be
  // missing, wrong, or revoked by someone else.
  if (viewer === owner) return "owner";
  try {
    // ONE query, so the block check cannot be skipped by a caller that only
    // wanted the role. A blocked pair resolves to "none" no matter what grant
    // row exists.
    // Two scalar subqueries, so exactly one row comes back whether or not a
    // grant exists, and the block check travels WITH the role rather than being
    // a second call a caller could skip.
    const { rows } = await pool.query(
      `SELECT
         (SELECT role FROM access_grants
           WHERE owner_user_id=$2 AND grantee_user_id=$1) AS role,
         EXISTS (
           SELECT 1 FROM friendships
            WHERE status='blocked'
              AND ((requester_id=$1 AND addressee_id=$2)
                OR (requester_id=$2 AND addressee_id=$1))
         ) AS blocked`,
      [viewer, owner]
    );
    const row = rows[0];
    if (!row || row.blocked || !row.role) return "none";
    return capabilities.normalizeRole(row.role);
  } catch (e) {
    console.error("[access] resolveRole failed, denying:", e.message);
    return "none";
  }
}

/** Convenience: resolve the role and answer a capability in one step. */
async function canActFor(viewerUserId, ownerUserId, capability, tier = "user") {
  const role = await resolveRole(viewerUserId, ownerUserId);
  return { allowed: capabilities.can(tier, capability, { role }), role };
}

/** Grant or change a role. OWNER ONLY: `ownerUserId` is both the subject and the
 *  actor, so there is no parameter a coach could supply to act as the owner. */
async function grantAccess({ ownerUserId, granteeUserId, role, note = "" }) {
  const owner = Number(ownerUserId);
  const grantee = Number(granteeUserId);
  if (!Number.isFinite(owner) || !Number.isFinite(grantee)) {
    const e = new Error("owner and grantee are required"); e.statusCode = 400; throw e;
  }
  if (owner === grantee) {
    const e = new Error("You already have full access to your own day"); e.statusCode = 400; throw e;
  }
  if (!capabilities.isGrantableRole(role)) {
    const e = new Error("Role must be one of: " + capabilities.GRANTABLE_ROLES.join(", "));
    e.statusCode = 400; throw e;
  }
  // A blocked person cannot be handed access. Checked BEFORE the write so the
  // row never exists, rather than relying on resolveRole to veto it later: a
  // grant row for a blocked user is a confusing thing to find in the table.
  const { rows: blockedRows } = await pool.query(
    `SELECT 1 FROM friendships
      WHERE status='blocked'
        AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
      LIMIT 1`,
    [owner, grantee]
  );
  if (blockedRows.length) {
    const e = new Error("Unblock this person before granting them access"); e.statusCode = 403; throw e;
  }
  const existing = await pool.query(
    "SELECT role FROM access_grants WHERE owner_user_id=$1 AND grantee_user_id=$2",
    [owner, grantee]
  );
  const previousRole = existing.rows[0] ? existing.rows[0].role : null;
  const { rows } = await pool.query(
    `INSERT INTO access_grants (owner_user_id, grantee_user_id, role, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_user_id, grantee_user_id)
       DO UPDATE SET role=EXCLUDED.role, note=EXCLUDED.note, updated_at=NOW()
     RETURNING *`,
    [owner, grantee, String(role).toLowerCase(), String(note || "").slice(0, 280)]
  );
  await recordGrantEvent({
    ownerUserId: owner, granteeUserId: grantee, actorUserId: owner,
    eventType: previousRole ? "role_changed" : "granted",
    role: rows[0].role, previousRole
  });
  return { grant: rows[0], changed: true, previousRole };
}

/** Revoke. Owner-only, and a hard delete so no read needs a validity predicate. */
async function revokeAccess({ ownerUserId, granteeUserId }) {
  const owner = Number(ownerUserId);
  const grantee = Number(granteeUserId);
  const { rows } = await pool.query(
    "DELETE FROM access_grants WHERE owner_user_id=$1 AND grantee_user_id=$2 RETURNING role",
    [owner, grantee]
  );
  if (rows.length) {
    await recordGrantEvent({
      ownerUserId: owner, granteeUserId: grantee, actorUserId: owner,
      eventType: "revoked", previousRole: rows[0].role
    });
  }
  return { revoked: rows.length > 0, previousRole: rows[0] ? rows[0].role : null };
}

/** People the owner has given access to. Names joined so no UI needs a lookup
 *  per row, same as social-store's friend lists. */
async function listGrants(ownerUserId) {
  const { rows } = await pool.query(
    `SELECT g.id, g.grantee_user_id, g.role, g.note, g.created_at, g.updated_at,
            COALESCE(NULLIF(pr.display_name, ''), u.username) AS name,
            u.username
       FROM access_grants g
       JOIN users u ON u.id = g.grantee_user_id
       LEFT JOIN user_profiles pr ON pr.user_id = g.grantee_user_id
      WHERE g.owner_user_id=$1
      ORDER BY g.created_at DESC`,
    [ownerUserId]
  );
  return rows;
}

/** The inverse: whose data this user has been given access to. This is what
 *  powers a coach's own "people I look after" list. */
async function listGrantedToMe(granteeUserId) {
  const { rows } = await pool.query(
    `SELECT g.id, g.owner_user_id, g.role, g.created_at,
            COALESCE(NULLIF(pr.display_name, ''), u.username) AS name,
            u.username
       FROM access_grants g
       JOIN users u ON u.id = g.owner_user_id
       LEFT JOIN user_profiles pr ON pr.user_id = g.owner_user_id
      WHERE g.grantee_user_id=$1
        -- A block hides the relationship from BOTH directions, matching
        -- resolveRole, so a blocked coach does not keep seeing the owner listed.
        AND NOT EXISTS (
          SELECT 1 FROM friendships f
           WHERE f.status='blocked'
             AND ((f.requester_id=$1 AND f.addressee_id=g.owner_user_id)
               OR (f.requester_id=g.owner_user_id AND f.addressee_id=$1))
        )
      ORDER BY g.created_at DESC`,
    [granteeUserId]
  );
  return rows;
}

/** Audit trail for one owner. */
async function listGrantEvents(ownerUserId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT e.*, COALESCE(NULLIF(pr.display_name, ''), u.username) AS grantee_name
       FROM access_grant_events e
       JOIN users u ON u.id = e.grantee_user_id
       LEFT JOIN user_profiles pr ON pr.user_id = e.grantee_user_id
      WHERE e.owner_user_id=$1
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [ownerUserId, Math.max(1, Math.min(Number(limit) || 50, 200))]
  );
  return rows;
}

module.exports = {
  resolveRole,
  canActFor,
  grantAccess,
  revokeAccess,
  listGrants,
  listGrantedToMe,
  listGrantEvents,
  recordGrantEvent,
};
