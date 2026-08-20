// Wiring tests for routes/access.js.
//
// The capability MODEL is tested in capabilities-roles.test.js and the role
// RESOLUTION in access-store. What neither covers is the wiring: a route wrapped
// in the wrong capability, or in none at all, is a hole that every other test
// passes straight over. A `requireGrant("view_itinerary")` on the point-adjust
// endpoint would let a plain viewer rewrite what the owner's work is worth, and
// nothing about that is visible from either side of the boundary.
//
// So this file reads the route table as SOURCE and asserts the shape of it. That
// makes it a structural test rather than a behavioural one, which is the right
// tool here: the thing being protected is a decision made at wiring time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const SRC = fs.readFileSync(require.resolve("./routes/access.js"), "utf8");
const capabilities = require("./capabilities.js");

// Every app.<verb>("<path>", ...) declaration, with the rest of its line.
function routeDeclarations() {
  const out = [];
  const re = /app\.(get|post|patch|delete|put)\(\s*"([^"]+)"\s*,([^\n]*)/g;
  let m;
  while ((m = re.exec(SRC))) out.push({ verb: m[1], path: m[2], rest: m[3] });
  return out;
}

const ROUTES = routeDeclarations();

test("the route table was actually parsed", () => {
  // Guard the guard: if the regex stops matching, every assertion below would
  // vacuously pass over an empty array. This is the do-nothing-verification trap
  // that has already bitten this project three times.
  assert.ok(ROUTES.length >= 8, "expected at least 8 routes, parsed " + ROUTES.length);
  assert.ok(ROUTES.some(r => r.path.startsWith("/api/coach/")), "no coach routes parsed");
  assert.ok(ROUTES.some(r => r.path.startsWith("/api/access/")), "no access routes parsed");
});

// ── every delegated route is guarded, with a capability that exists ──────────

test("every /api/coach route is wrapped in requireGrant", () => {
  const coachRoutes = ROUTES.filter(r => r.path.startsWith("/api/coach/"));
  assert.ok(coachRoutes.length >= 3, "expected the coach namespace to have routes");
  for (const r of coachRoutes) {
    assert.match(r.rest, /requireGrant\("/, `${r.verb.toUpperCase()} ${r.path} is UNGUARDED`);
  }
});

test("every guarded capability is one capabilities.js actually knows", () => {
  // A typo'd capability name fails closed (can() returns false), so the endpoint
  // would 403 for everyone including the owner. Silent and confusing, so pin it.
  const named = [...SRC.matchAll(/requireGrant\("([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(named.length >= 3);
  for (const name of named) {
    const known = capabilities.CAPABILITY_MIN_ROLE[name] || capabilities.CAPABILITY_MIN_TIER[name];
    assert.ok(known, `requireGrant("${name}") names a capability that does not exist`);
  }
});

test("each delegated route demands the capability it actually needs", () => {
  // The literal expected wiring. Changing a route's capability has to change
  // this table too, which is the entire point: it makes a loosened guard a
  // deliberate edit rather than a quiet one.
  const expected = {
    "GET /api/coach/:ownerUserId/capabilities": "view_itinerary",
    "GET /api/coach/:ownerUserId/day": "view_itinerary",
    "PATCH /api/coach/:ownerUserId/tasks/:taskId/points": "adjust_points"
  };
  for (const [key, capability] of Object.entries(expected)) {
    const [verb, path] = key.split(" ");
    const found = ROUTES.find(r => r.verb === verb.toLowerCase() && r.path === path);
    assert.ok(found, "route not found: " + key);
    assert.match(found.rest, new RegExp('requireGrant\\("' + capability + '"\\)'),
      `${key} should demand ${capability}`);
  }
});

test("a write capability is never guarded by a read capability", () => {
  // The specific mistake this catches: point adjustment guarded by
  // view_itinerary, which every viewer has.
  const writeVerbs = new Set(["post", "patch", "put", "delete"]);
  const readOnlyCaps = new Set(["view_itinerary"]);
  for (const r of ROUTES.filter(x => x.path.startsWith("/api/coach/") && writeVerbs.has(x.verb))) {
    const m = /requireGrant\("([^"]+)"\)/.exec(r.rest);
    assert.ok(m, `${r.verb} ${r.path} has no guard`);
    assert.ok(!readOnlyCaps.has(m[1]),
      `${r.verb.toUpperCase()} ${r.path} is a WRITE guarded by the read capability ${m[1]}`);
  }
});

// ── granting stays owner-only, by signature ─────────────────────────────────

test("the grant endpoints take their owner from the session, never from input", () => {
  // This is the anti-escalation invariant as a test. If a grant route ever read
  // an owner id out of the body or the path, one user could write grants on
  // another user's account, and every capability check downstream would then be
  // working from a poisoned row.
  const grantBlock = SRC.slice(SRC.indexOf('app.get("/api/access/grants"'), SRC.indexOf("// ── The delegated-action guard"));
  assert.ok(grantBlock.length > 200, "failed to slice the grant-management block");
  // Each owner argument must be the session user.
  const ownerArgs = [...grantBlock.matchAll(/ownerUserId:\s*([^,\n]+)/g)].map(m => m[1].trim());
  assert.ok(ownerArgs.length >= 2, "expected the grant + revoke calls to name an owner");
  for (const arg of ownerArgs) {
    assert.equal(arg, "req.session.userId", "grant owner must come from the session, got: " + arg);
  }
  // And no owner id may be read from request input anywhere in that block.
  assert.ok(!/owner[Uu]ser[Ii]d\s*[:=]\s*(parseInt\()?\s*(req\.body|req\.params|req\.query)/.test(grantBlock),
    "a grant endpoint reads an owner id from request input");
});

test("no coach route can create or change a grant", () => {
  // The coach namespace must never contain a grant mutation, whatever role the
  // caller holds: granting is not a capability at all (see capabilities.js).
  const coachBlock = SRC.slice(SRC.indexOf("// ── The delegated-action guard"));
  assert.ok(coachBlock.length > 200, "failed to slice the coach block");
  assert.ok(!/grantAccess\(/.test(coachBlock), "a coach route calls grantAccess");
  assert.ok(!/revokeAccess\(/.test(coachBlock), "a coach route calls revokeAccess");
});

// ── the guard's own shape ───────────────────────────────────────────────────

test("the guard denies before it does anything else", () => {
  const guard = SRC.slice(SRC.indexOf("function requireGrant"), SRC.indexOf("// What the caller may do"));
  assert.ok(guard.length > 200, "failed to slice requireGrant");
  // Unauthenticated is 401, unauthorized is 403, and a missing owner id is 400.
  assert.match(guard, /401/, "no unauthenticated branch");
  assert.match(guard, /403/, "no unauthorized branch");
  // The role comes from the store, which is where the block veto lives; the
  // guard must not read a role off the request.
  assert.match(guard, /accessStore\.resolveRole\(/, "the guard must resolve the role via the store");
  assert.ok(!/req\.(body|query|params)\.role/.test(guard), "the guard reads a role from request input");
  // A thrown error must deny, not fall through to the handler.
  assert.match(guard, /catch[\s\S]*403/, "a guard error must deny");
  // The owner's workspace must come from the ownership table, not the caller.
  assert.match(guard, /resolveWorkspaceId\(ownerUserId\)/, "workspace must resolve from the owner");
  assert.ok(!/req\.workspaceId/.test(guard), "the guard uses the CALLER's workspace");
});

test("the point-adjust handler scopes its lookup to the owner's workspace", () => {
  // Without the workspace predicate in the WHERE clause, a coach could reach a
  // task id belonging to someone else entirely by guessing it.
  const handler = SRC.slice(SRC.indexOf('/tasks/:taskId/points"'));
  assert.match(handler, /workspace_id=\$1/, "the task lookup is not workspace-scoped");
  assert.match(handler, /req\.grant\.ownerWorkspaceId/, "it must use the GRANT's workspace");
  // And it must record who did it.
  // The FULL assignment, not just the key name: /pointsAdjustedBy/ alone also
  // matches pointsAdjustedByRole, so deleting the field that records WHO made
  // the change passed. Found by mutation-testing this very file.
  assert.match(handler, /pointsAdjustedBy:\s*req\.grant\.viewerUserId/, "the change is not attributed to the actor on the row");
  assert.match(handler, /pointsAdjustedFrom:\s*previous/, "the previous value is not recorded");
  assert.match(handler, /eventType:\s*"points_adjusted"/, "the change is not written to the ledger");
  assert.match(handler, /actorUserId:\s*req\.grant\.viewerUserId/, "the ledger entry is not attributed");
});
