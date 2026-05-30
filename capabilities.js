/**
 * Capability / tier entitlement layer.
 *
 * Single source of truth for what each visitor tier may do on a shared todo
 * list. The client never re-implements this table; it reads the resolved
 * `capabilities` map off the share payload (see buildPublicTodoShare).
 *
 * Tiers:
 *   guest - no account (identified only by a hashed actor key)
 *   user  - signed in
 *   paid  - reserved for a future paid plan; currently identical to `user`
 *
 * Nothing is paywalled yet. To gate a capability behind `paid` later, change
 * its entry in CAPABILITY_MIN_TIER to "paid".
 */

const TIERS = ["guest", "user", "paid"];
const TIER_RANK = { guest: 0, user: 1, paid: 2 };

const CAPABILITY_MIN_TIER = {
  react: "guest",
  comment: "guest",
  sponsor_reward: "guest",
  place_bounty: "user",
};

function resolveTier(req) {
  // Future: derive "paid" from req.session.plan once billing exists.
  if (req && req.session && req.session.userId) return "user";
  return "guest";
}

function can(tier, capability) {
  const need = CAPABILITY_MIN_TIER[capability];
  if (!need) return false;
  return (TIER_RANK[tier] ?? -1) >= (TIER_RANK[need] ?? Infinity);
}

function capabilityMap(tier) {
  const out = {};
  for (const capability of Object.keys(CAPABILITY_MIN_TIER)) {
    out[capability] = can(tier, capability);
  }
  return out;
}

module.exports = {
  TIERS,
  TIER_RANK,
  CAPABILITY_MIN_TIER,
  resolveTier,
  can,
  capabilityMap,
};
