// Contract tests for resolveRole (access-store.js), the authorization primitive
// this whole feature rests on: every /api/coach request resolves through it.
//
// It shipped with ZERO tests, and that was not a gap in coverage so much as a
// gap in evidence: seven separate authorization-destroying mutations to it left
// the entire branch suite green, including ignoring the block veto, swapping the
// viewer and owner parameters, and making the catch return "manager" so a
// database blip grants universal access. None of those look like bugs from any
// other file.
//
// Harness: the repo's require-cache mock pool (social-guards.test.js,
// open-tasks-query.test.js). access-store does `const pool = require("./pg-pool")`
// at module scope, so swapping the cache entry before require gives a recorder
// with no database.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadWithMockPool(modulePath, mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const target = require.resolve(modulePath);
  delete require.cache[poolPath];
  delete require.cache[target];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  const mod = require(target);
  delete require.cache[poolPath];
  delete require.cache[target];
  return mod;
}

const recorder = (rows = []) => {
  const log = [];
  return { log, async query(sql, params = []) { log.push({ sql: String(sql), params }); return { rows }; } };
};

test("a block beats a live grant, and the veto rides inside the one query", async () => {
  // The bug social-store.areFriends already shipped once: friendships rows are
  // directed, so an accepted row survives a block. If the veto were a separate
  // call, a caller could take the role and skip it.
  const pool = recorder([{ role: "manager", blocked: true }]);
  const store = loadWithMockPool("./access-store", pool);
  assert.equal(await store.resolveRole(7, 9), "none", "a blocked manager keeps NOTHING");
  assert.equal(pool.log.length, 1, "one query, so the block cannot be skipped");
  const { sql, params } = pool.log[0];
  assert.match(sql, /status='blocked'/, "the block check must travel with the role");
  assert.match(sql, /requester_id=\$1 AND addressee_id=\$2/);
  assert.match(sql, /requester_id=\$2 AND addressee_id=\$1/, "a block is undirected");
  assert.match(sql, /owner_user_id=\$2/, "$2 is the OWNER");
  assert.match(sql, /grantee_user_id=\$1/, "$1 is the VIEWER");
  assert.deepEqual(params, [7, 9], "viewer first, owner second: swapping them inverts the grant");
});

test("resolveRole fails closed on every non-answer", async () => {
  const ok = loadWithMockPool("./access-store", recorder([{ role: "coach", blocked: false }]));
  assert.equal(await ok.resolveRole(7, 9), "coach");
  assert.equal(await ok.resolveRole("abc", 9), "none", "a non-numeric id is not an identity");
  assert.equal(await ok.resolveRole(null, 9), "none");

  const noRow = loadWithMockPool("./access-store", recorder([{ role: null, blocked: false }]));
  assert.equal(await noRow.resolveRole(7, 9), "none", "a stranger is not a viewer");

  const junk = loadWithMockPool("./access-store", recorder([{ role: "WIZARD", blocked: false }]));
  assert.equal(await junk.resolveRole(7, 9), "none", "an unrecognised role in the table is not a role");

  const down = loadWithMockPool("./access-store", { async query() { throw new Error("db down"); } });
  assert.equal(await down.resolveRole(7, 9), "none", "a thrown error must DENY, not surface at the guard");
});

test("self resolves to owner without reading the table at all", async () => {
  // Deliberately seed a row that would DENY if it were consulted. Your access to
  // your own day must never depend on a grant row, so a bug in grant plumbing
  // cannot lock you out of your own itinerary.
  const pool = recorder([{ role: "viewer", blocked: true }]);
  const store = loadWithMockPool("./access-store", pool);
  assert.equal(await store.resolveRole(7, 7), "owner");
  assert.equal(pool.log.length, 0, "your own access must never depend on a row");
});

test("canActFor answers the capability, not just the role", async () => {
  const coach = loadWithMockPool("./access-store", recorder([{ role: "coach", blocked: false }]));
  const adjust = await coach.canActFor(7, 9, "adjust_points");
  assert.equal(adjust.allowed, true);
  assert.equal(adjust.role, "coach");
  const del = await coach.canActFor(7, 9, "delete_task");
  assert.equal(del.allowed, false, "a coach is not a manager");
});

// ── grant + revoke: the owner-only invariants ────────────────────────────────

test("granting refuses self, an ungrantable role, and a blocked person", async () => {
  const store = loadWithMockPool("./access-store", recorder([]));
  await assert.rejects(() => store.grantAccess({ ownerUserId: 7, granteeUserId: 7, role: "coach" }),
    e => e.statusCode === 400, "self-grant");
  await assert.rejects(() => store.grantAccess({ ownerUserId: 7, granteeUserId: 9, role: "owner" }),
    e => e.statusCode === 400, "owner is not grantable");
  await assert.rejects(() => store.grantAccess({ ownerUserId: 7, granteeUserId: 9, role: "admin" }),
    e => e.statusCode === 400, "an invented role is not grantable");
  await assert.rejects(() => store.grantAccess({ ownerUserId: 7, granteeUserId: NaN, role: "coach" }),
    e => e.statusCode === 400, "a non-numeric grantee");

  // A blocked person cannot be handed access at all: refused BEFORE the write, so
  // no confusing row exists for resolveRole to have to veto later.
  const blocked = loadWithMockPool("./access-store", recorder([{ blocked: 1 }]));
  await assert.rejects(() => blocked.grantAccess({ ownerUserId: 7, granteeUserId: 9, role: "coach" }),
    e => e.statusCode === 403, "granting to a blocked person");
});

test("revoke is a hard delete, so no read needs an is-it-still-valid predicate", async () => {
  const pool = recorder([{ role: "coach" }]);
  const store = loadWithMockPool("./access-store", pool);
  const out = await store.revokeAccess({ ownerUserId: 7, granteeUserId: 9 });
  assert.equal(out.revoked, true);
  assert.equal(out.previousRole, "coach");
  const del = pool.log.find(l => /DELETE FROM access_grants/.test(l.sql));
  assert.ok(del, "revoke must DELETE, not stamp a revoked_at that every read must remember");
  assert.match(del.sql, /owner_user_id=\$1 AND grantee_user_id=\$2/, "scoped to the owner's own grant");
  assert.deepEqual(del.params, [7, 9]);
});

test("listGrantedToMe hides an owner who has blocked the grantee", async () => {
  const pool = recorder([]);
  const store = loadWithMockPool("./access-store", pool);
  await store.listGrantedToMe(7);
  const { sql } = pool.log[0];
  assert.match(sql, /NOT EXISTS/, "the block veto must be in the query");
  assert.match(sql, /status='blocked'/);
  assert.match(sql, /grantee_user_id=\$1/);
});
