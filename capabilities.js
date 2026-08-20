/**
 * Capability / entitlement layer.
 *
 * Two independent axes, deliberately kept separate:
 *
 *   TIER   - what you are globally: guest (no account), user (signed in), paid.
 *            Answers "may this visitor react to a shared list at all".
 *   ROLE   - what a specific OWNER has granted you over THEIR data:
 *            none < viewer < commenter < coach < manager.
 *            Answers "may this person adjust Drake's points".
 *
 * A capability is granted when EITHER axis satisfies it. That is what keeps the
 * public share page byte-identical: every existing call site passes two
 * arguments, `role` defaults to "none", and the role table simply never fires.
 * Grants are additive, never a new default. (See build-patterns
 * one-projection-many-surfaces: "opt-in option, never a new default".)
 *
 * Invariants this file is responsible for, each one learned the hard way:
 *
 *  - FAIL CLOSED. An unknown capability, tier or role is a denial, never an
 *    allow. `can()` returning false for a typo'd capability name is the correct
 *    behavior and is tested.
 *  - A ROLE IS DIRECTIONAL AND PER-OWNER. "Marcus coaches Drake" says nothing
 *    about Drake coaching Marcus, and nothing about Marcus coaching anyone else.
 *    This module never resolves a role itself; the caller passes one in, because
 *    resolving it requires knowing WHICH owner's data is being touched. See
 *    access-store.js resolveRole().
 *  - GRANTING IS NEVER A GRANTED POWER. No role, including manager, can create
 *    or revoke a grant. Only the owner can. There is deliberately no
 *    `grant_access` capability in this table: if it existed, someone would
 *    eventually give it to a role and build privilege escalation by accident.
 *  - SELF IS NOT GATED BY ROLE. An owner acting on their own data is resolved as
 *    role "owner", above manager, so no grant is ever required to touch your own
 *    itinerary.
 */

const TIERS = ["guest", "user", "paid"];
const TIER_RANK = { guest: 0, user: 1, paid: 2 };

// Ordered least to most. "owner" is the implicit top: it is what resolveRole
// returns when viewer and owner are the same person, so an owner never depends
// on a grant row existing.
const ROLES = ["none", "viewer", "commenter", "coach", "manager", "owner"];
const ROLE_RANK = { none: 0, viewer: 1, commenter: 2, coach: 3, manager: 4, owner: 5 };

// Roles an owner may actually hand out. `none` is the absence of a grant and
// `owner` is not grantable, so neither belongs in the UI or the API.
const GRANTABLE_ROLES = ["viewer", "commenter", "coach", "manager"];

// What a global tier alone can do. UNCHANGED from the tier-only version: these
// are the public-share capabilities, and changing one here changes what an
// anonymous link holder may do.
const CAPABILITY_MIN_TIER = {
  react: "guest",
  comment: "guest",
  sponsor_reward: "guest",
  place_bounty: "user",
};

// What a per-owner grant can do, over that owner's data only. A capability
// absent from this table can NEVER be reached through a grant, whatever the
// role: that is why `grant_access` does not appear.
const CAPABILITY_MIN_ROLE = {
  // Read the owner's real itinerary, not just the single shared day.
  view_itinerary: "viewer",
  // Comment as an identified collaborator rather than a guest.
  comment: "commenter",
  // Change what a task is worth. Attributed, and ledgered.
  adjust_points: "coach",
  // Approve or reject a sponsorship offer on the owner's behalf.
  approve_sponsorship: "coach",
  // Put a task straight on the itinerary instead of into triage for approval.
  assign_task: "coach",
  // Edit or reschedule the owner's existing tasks.
  edit_task: "manager",
  // Delete them.
  delete_task: "manager",
};

function resolveTier(req) {
  // Future: derive "paid" from req.session.plan once billing exists.
  if (req && req.session && req.session.userId) return "user";
  return "guest";
}

function normalizeRole(role) {
  const key = String(role || "none").toLowerCase();
  return ROLE_RANK[key] === undefined ? "none" : key;
}

function isGrantableRole(role) {
  return GRANTABLE_ROLES.indexOf(String(role || "").toLowerCase()) !== -1;
}

/**
 * May a visitor do `capability`?
 *
 * `opts.role` is the role THIS viewer holds over THE OWNER whose data is being
 * touched. Omitted, it defaults to "none" and this behaves exactly as the
 * tier-only version did, which is what keeps every public-share call site
 * unchanged.
 */
function can(tier, capability, opts) {
  const needTier = CAPABILITY_MIN_TIER[capability];
  const needRole = CAPABILITY_MIN_ROLE[capability];
  // Fail closed: a capability in neither table is not a capability.
  if (!needTier && !needRole) return false;
  if (needTier && (TIER_RANK[tier] ?? -1) >= (TIER_RANK[needTier] ?? Infinity)) return true;
  if (!needRole) return false;
  const role = normalizeRole(opts && opts.role);
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[needRole] ?? Infinity);
}

/**
 * The map the PUBLIC share payload carries. Deliberately still tier-only and
 * therefore byte-identical to the pre-grants version: an anonymous link holder
 * has no grant, so shipping them `adjust_points: false` would only widen the
 * payload and advertise capabilities that surface cannot reach.
 */
function capabilityMap(tier) {
  const out = {};
  for (const capability of Object.keys(CAPABILITY_MIN_TIER)) {
    out[capability] = can(tier, capability);
  }
  return out;
}

/** The full map, both axes, for AUTHENTICATED surfaces where a grant can apply.
 *  Separate function rather than an option on capabilityMap, so the public
 *  payload cannot grow role keys by someone passing an extra argument. */
function capabilityMapFor({ tier, role } = {}) {
  const out = {};
  const names = new Set([
    ...Object.keys(CAPABILITY_MIN_TIER),
    ...Object.keys(CAPABILITY_MIN_ROLE),
  ]);
  for (const capability of names) out[capability] = can(tier, capability, { role });
  return out;
}

module.exports = {
  TIERS,
  TIER_RANK,
  ROLES,
  ROLE_RANK,
  GRANTABLE_ROLES,
  CAPABILITY_MIN_TIER,
  CAPABILITY_MIN_ROLE,
  resolveTier,
  normalizeRole,
  isGrantableRole,
  can,
  capabilityMap,
  capabilityMapFor,
};
