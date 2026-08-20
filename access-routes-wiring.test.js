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
  // A COMPLETENESS check, not a magic number. The floor used to equal the exact
  // route count, so a route the regex failed to parse (a single-quoted path, a
  // declaration prettier wrapped onto two lines) kept the count at 8 and was
  // silently exempt from every assertion below.
  const declared = (SRC.match(/app\.(?:get|post|patch|delete|put)\(/g) || []).length;
  assert.ok(declared >= 8, "expected at least 8 route declarations, found " + declared);
  assert.equal(ROUTES.length, declared,
    "a route declaration was not parsed -- every assertion below would skip it");
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
  // Exclude interpolations: the mount-time error message in routes/access.js
  // contains the literal text requireGrant("${capability}"), which a naive regex
  // happily reports as a capability named "${capability}".
  const named = [...SRC.matchAll(/requireGrant\("([^"$]+)"\)/g)].map(m => m[1]);
  assert.ok(named.length >= 3);
  for (const name of named) {
    // CAPABILITY_MIN_ROLE specifically. Accepting a tier-only name would bless a
    // guard that authorizes every signed-in user, which is exactly what
    // requireGrant("comment") would have done.
    assert.ok(capabilities.CAPABILITY_MIN_ROLE[name],
      `requireGrant("${name}") is not a role-gated capability`);
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

test("the guard reads its role only from the store, never from request input", () => {
  // NARROWED on purpose. This used to assert that the strings 401/403 appear in
  // the slice, which cannot fail when the guard stops denying: changing the
  // check to `if (false && !canForOwner(...))` deletes authorization outright
  // and every one of those assertions still passed. The guard's DECISIONS are
  // now executed in access-guard.test.js. What source text can still usefully
  // prove is that no role arrives from the request.
  const guard = SRC.slice(SRC.indexOf("function requireGrant"), SRC.indexOf("// What the caller may do"));
  assert.ok(guard.length > 200, "failed to slice requireGrant");
  assert.match(guard, /accessStore\.resolveRole\(viewerUserId, ownerUserId\)/,
    "the role must be resolved viewer-over-owner via the store");
  assert.ok(!/req\.(body|query|params)\.role/.test(guard), "the guard reads a role from request input");
  assert.match(guard, /canForOwner\(/, "delegated checks must use the role-only axis");
  assert.match(guard, /resolveWorkspaceId\(ownerUserId\)/, "workspace must resolve from the owner");
  assert.ok(!/req\.workspaceId/.test(guard), "the guard uses the CALLER's workspace");
});

test("the point-adjust LOOKUP is scoped to the owner's workspace", () => {
  // Sliced to the lookup only. The first version passed SRC.indexOf() with ONE
  // argument, so the slice ran to end-of-file and `req.grant.ownerWorkspaceId`
  // in the broadcast line satisfied an assertion about the QUERY: binding the
  // query to req.workspaceId instead left the suite green.
  const start = SRC.indexOf('/tasks/:taskId/points"');
  const handler = SRC.slice(start, SRC.indexOf("previous = Number(", start));
  assert.ok(handler.length > 200, "failed to slice the point-adjust lookup");
  assert.match(handler, /\[\s*req\.grant\.ownerWorkspaceId\s*,/,
    "the workspace parameter must be bound from the GRANT, not the caller's session");
  assert.ok(!/req\.workspaceId/.test(handler), "the lookup uses the CALLER's workspace");
  assert.match(handler, /FOR UPDATE/, "the row must be locked before it is read");
  assert.match(handler, /foldsIntoItinerary/, "the write must be scoped to tasks like the read is");
});

test("the point-adjust handler attributes and ledgers the change", () => {
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

// ── the day projection ───────────────────────────────────────────────────────

test("the coach day reads BLOCKS, not the materialized timeline", () => {
  // The bug this pins: state.schedule.timeline is the materialized PLAN and is
  // empty on a day nobody planned, so a coach opening an unplanned day saw
  // "nothing scheduled" while the owner had three tasks. Found by seeding real
  // tasks and getting zero rows back.
  const handler = SRC.slice(SRC.indexOf('/day", requireGrant'), SRC.indexOf("// ── Write:"));
  assert.ok(handler.length > 200, "failed to slice the day handler");
  assert.match(handler, /getBlocksByDate\(/, "the day must read blocks");
  assert.match(handler, /TaskModel\.fromBlock/, "and project them through the canonical projection");
  // foldsIntoItinerary, not isTaskRow: task-model.js documents isTaskRow as "far
  // too wide" for a task LIST, and the itinerary this mirrors uses the narrower
  // predicate.
  assert.match(handler, /TaskModel\.foldsIntoItinerary/, "filtered by the itinerary's own predicate");
  assert.match(handler, /deriveEnd: true/, "a read-only view never recalcs, so it must derive end");
  // Strip comments first: the handler EXPLAINS why buildDayResponse was removed,
  // so a naive search finds the word in the prose that documents its absence.
  const code = handler.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/buildDayResponse\(/.test(code),
    "the day must not rebuild the owner's full state packet");
  assert.ok(!/\bstate\b\s*[,}]/.test(code),
    "the response must not carry the owner's full day state");
  // It must not go back to deriving the list from the timeline.
  assert.ok(!/schedule\s*\|\|\s*\{\}\)\.timeline/.test(handler),
    "the task list must not come from the materialized timeline");
});

test("the coach day is sorted chronologically, untimed last", () => {
  const handler = SRC.slice(SRC.indexOf('/day", requireGrant'), SRC.indexOf("// ── Write:"));
  assert.match(handler, /\.sort\(/, "the day must be ordered");
  assert.match(handler, /99:99/, "untimed tasks must sort last, not first");
});
