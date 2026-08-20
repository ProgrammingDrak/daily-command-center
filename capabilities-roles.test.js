// Contract tests for the two-axis capability model (capabilities.js).
//
// This file exists because the previous model was a single global tier ladder,
// and P6 adds a second axis that is PER-OWNER. The dangerous failure is not a
// crash: it is a capability quietly reachable by someone who was never granted
// it, or the public share page silently gaining powers because the two axes got
// mixed. Every test here is about a boundary, not about plumbing.
const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("./capabilities.js");

// ── back-compat: the public share page must not move ─────────────────────────

test("the tier-only answers are unchanged from the pre-grants model", () => {
  // A LITERAL table, not derived from CAPABILITY_MIN_TIER: deriving it would
  // pass for any table and pin nothing, which is exactly the self-referential
  // trap that let a broken cap test survive earlier in this project.
  const expected = {
    guest: { react: true, comment: true, sponsor_reward: true, place_bounty: false },
    user: { react: true, comment: true, sponsor_reward: true, place_bounty: true },
    paid: { react: true, comment: true, sponsor_reward: true, place_bounty: true }
  };
  for (const [tier, caps] of Object.entries(expected)) {
    for (const [name, want] of Object.entries(caps)) {
      assert.equal(cap.can(tier, name), want, `${tier} ${name}`);
    }
  }
});

test("the PUBLIC capability map carries only the four tier capabilities", () => {
  // An anonymous link holder must not be shipped role capability names. If this
  // grows a key, the public share payload grew with it.
  assert.deepEqual(
    Object.keys(cap.capabilityMap("guest")).sort(),
    ["comment", "place_bounty", "react", "sponsor_reward"]
  );
  // And a second argument must not be able to widen it.
  assert.deepEqual(
    Object.keys(cap.capabilityMap("guest", { role: "manager" })).sort(),
    ["comment", "place_bounty", "react", "sponsor_reward"]
  );
});

test("a two-argument can() call ignores roles entirely", () => {
  // Every pre-existing call site passes two arguments. If a default role ever
  // leaked in, the public share page would inherit coach powers.
  assert.equal(cap.can("guest", "adjust_points"), false);
  assert.equal(cap.can("paid", "adjust_points"), false, "no tier buys a coach power");
  assert.equal(cap.can("paid", "view_itinerary"), false);
  assert.equal(cap.can("paid", "delete_task"), false);
});

// ── fail closed ──────────────────────────────────────────────────────────────

test("unknown capabilities, tiers and roles all deny", () => {
  assert.equal(cap.can("user", "nonsense_capability", { role: "manager" }), false);
  assert.equal(cap.can("wizard", "place_bounty"), false, "unknown tier denies");
  assert.equal(cap.can("guest", "adjust_points", { role: "supreme_leader" }), false);
  assert.equal(cap.can("guest", "adjust_points", { role: null }), false);
  assert.equal(cap.can("guest", "adjust_points", {}), false);
  assert.equal(cap.can("guest", "adjust_points"), false);
  assert.equal(cap.normalizeRole("nonsense"), "none");
  assert.equal(cap.normalizeRole(undefined), "none");
});

test("there is no grant_access capability, so no role can widen access", () => {
  // The escalation this omission prevents: if granting were a capability, some
  // future edit would hand it to `manager` and a manager could appoint further
  // managers on someone else's account.
  assert.equal(cap.CAPABILITY_MIN_ROLE.grant_access, undefined);
  assert.equal(cap.CAPABILITY_MIN_TIER.grant_access, undefined);
  for (const role of cap.ROLES) {
    assert.equal(cap.can("paid", "grant_access", { role }), false, role + " must not grant access");
  }
});

// ── the role ladder ──────────────────────────────────────────────────────────

test("each role reaches exactly its own rung and everything below", () => {
  // The literal expected matrix. A reordering of ROLE_RANK or a changed
  // CAPABILITY_MIN_ROLE entry has to update this table, which is the point.
  const matrix = {
    none:      { view_itinerary: false, comment: false, adjust_points: false, approve_sponsorship: false, assign_task: false, edit_task: false, delete_task: false },
    viewer:    { view_itinerary: true,  comment: false, adjust_points: false, approve_sponsorship: false, assign_task: false, edit_task: false, delete_task: false },
    commenter: { view_itinerary: true,  comment: true,  adjust_points: false, approve_sponsorship: false, assign_task: false, edit_task: false, delete_task: false },
    coach:     { view_itinerary: true,  comment: true,  adjust_points: true,  approve_sponsorship: true,  assign_task: true,  edit_task: false, delete_task: false },
    manager:   { view_itinerary: true,  comment: true,  adjust_points: true,  approve_sponsorship: true,  assign_task: true,  edit_task: true,  delete_task: true },
    owner:     { view_itinerary: true,  comment: true,  adjust_points: true,  approve_sponsorship: true,  assign_task: true,  edit_task: true,  delete_task: true }
  };
  // SELF-ENFORCING COVERAGE. The first version listed five of the seven role
  // capabilities, so approve_sponsorship could be loosened to viewer -- or
  // deleted outright -- with the whole suite green. Tying the columns to the
  // table means the next capability added without a column fails here instead of
  // shipping untested.
  for (const role of Object.keys(matrix)) {
    assert.deepEqual(Object.keys(matrix[role]).sort(), Object.keys(cap.CAPABILITY_MIN_ROLE).sort(),
      `the ${role} row does not cover every role capability`);
  }
  // canForOwner, not can(): the delegated axis is role-only, which is what makes
  // a `comment: false` for a viewer meaningful at all (can() would say true via
  // the public tier).
  for (const [role, caps] of Object.entries(matrix)) {
    for (const [name, want] of Object.entries(caps)) {
      assert.equal(cap.canForOwner(name, role), want, `${role} ${name}`);
    }
  }
});

test("a coach cannot edit or delete: those are the manager rungs", () => {
  // Called out separately because it is the single most likely thing to be
  // loosened by accident, and the difference between "adjusts my points" and
  // "deletes my tasks" is the difference between the two roles existing.
  assert.equal(cap.can("user", "adjust_points", { role: "coach" }), true);
  assert.equal(cap.can("user", "edit_task", { role: "coach" }), false);
  assert.equal(cap.can("user", "delete_task", { role: "coach" }), false);
});

test("owner outranks manager, so self-access never needs a grant", () => {
  assert.ok(cap.ROLE_RANK.owner > cap.ROLE_RANK.manager);
  for (const name of Object.keys(cap.CAPABILITY_MIN_ROLE)) {
    assert.equal(cap.can("user", name, { role: "owner" }), true, "owner should reach " + name);
  }
});

test("only the four intermediate roles are grantable", () => {
  assert.deepEqual(cap.GRANTABLE_ROLES, ["viewer", "commenter", "coach", "manager"]);
  assert.equal(cap.isGrantableRole("owner"), false, "owner is not a gift");
  assert.equal(cap.isGrantableRole("none"), false, "absence is not a grant");
  assert.equal(cap.isGrantableRole("coach"), true);
  assert.equal(cap.isGrantableRole("COACH"), true, "case-insensitive");
  assert.equal(cap.isGrantableRole("admin"), false);
  assert.equal(cap.isGrantableRole(undefined), false);
});

// ── the two axes compose without leaking into each other ─────────────────────

test("the two axes answer different questions and must not be confused", () => {
  // `comment` is in BOTH tables, and that is exactly where the danger was: on the
  // PUBLIC axis a guest may comment on a shared list, so can() says true for
  // everyone. A delegated guard built on can() would therefore have authorized
  // every signed-in stranger against every owner.
  assert.equal(cap.can("guest", "comment"), true, "public share: a guest may comment");
  assert.equal(cap.canForOwner("comment", "none"), false, "delegated: a stranger may not");
  assert.equal(cap.canForOwner("comment", "commenter"), true, "delegated: a commenter may");
  // And a tier-only capability is not delegatable at all.
  assert.equal(cap.canForOwner("place_bounty", "manager"), false);
  assert.equal(cap.isDelegatable("place_bounty"), false);
  assert.equal(cap.isDelegatable("adjust_points"), true);
});

test("capabilityMapFor is the full union and reflects the role", () => {
  const coach = cap.capabilityMapFor({ tier: "user", role: "coach" });
  assert.equal(coach.adjust_points, true);
  assert.equal(coach.delete_task, false);
  assert.equal(coach.place_bounty, true, "tier capabilities still present");
  const stranger = cap.capabilityMapFor({ tier: "user", role: "none" });
  assert.equal(stranger.view_itinerary, false);
  assert.equal(stranger.adjust_points, false);
  // Same key set regardless of role, so a client can read a stable shape.
  assert.deepEqual(Object.keys(coach).sort(), Object.keys(stranger).sort());
  // And it degrades rather than throwing on no argument at all.
  assert.equal(cap.capabilityMapFor().adjust_points, false);
});
