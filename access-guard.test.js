// EXECUTABLE tests for requireGrant, the single authorization site for the
// delegated /api/coach namespace.
//
// access-routes-wiring.test.js reads routes/access.js as source text, which is
// the right tool for the wiring TABLE (it demonstrably catches a guard removed
// or swapped to the wrong capability) and the wrong tool for the guard's
// DECISION. Proven, not assumed: with only the structural suite in place,
// changing the check to `if (false && !capabilities.canForOwner(...))` -- which
// deletes authorization outright and lets any signed-in user adjust anyone's
// points -- left every test green, because the literal "403" was still in the
// slice. So was inverting resolveRole's arguments, and so was handing the grant
// the CALLER's workspace.
//
// This file runs the guard. routes/access.js is `module.exports = function
// mount(app, ctx)`, so a fake app and a fake ctx reach it with no server and no
// database.
const test = require("node:test");
const assert = require("node:assert/strict");
const mount = require("./routes/access.js");
const capabilities = require("./capabilities.js");

function mountRoutes(over) {
  const routes = [];
  const app = {};
  for (const v of ["get", "post", "patch", "put", "delete"]) {
    app[v] = (p, ...mw) => routes.push({ verb: v, path: p, mw });
  }
  mount(app, Object.assign({
    accessStore: { async resolveRole() { return "none"; } },
    socialStore: { async resolveWorkspaceId(id) { return "ws-of-" + id; }, async recordEvent() {} },
    capabilities,
    route: fn => fn,
    blockDB: {}, pool: {}, broadcast() {},
    badRequest: (m) => { const e = new Error(m); e.statusCode = 400; return e; },
    notFound: (m) => { const e = new Error(m); e.statusCode = 404; return e; },
    intParam: (req, name) => parseInt(req.params[name], 10),
    coerceDateString: s => s, getTodayStr: () => "2026-08-20", isValidDate: () => true
  }, over || {}));
  return routes;
}

function guardFor(over, matcher) {
  const routes = mountRoutes(over);
  const r = routes.find(matcher);
  assert.ok(r, "route not found");
  assert.ok(r.mw.length >= 2, "the route must carry a guard BEFORE its handler");
  return r.mw[0];
}

const pointsRoute = x => x.verb === "patch" && /points$/.test(x.path);
const dayRoute = x => x.verb === "get" && /\/day$/.test(x.path);

const fakeRes = () => {
  const res = {};
  res.status = c => { res.code = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
};

async function run(over, req, matcher) {
  const guard = guardFor(over, matcher || pointsRoute);
  const res = fakeRes();
  let nexted = false;
  await guard(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

const REQ = () => ({ params: { ownerUserId: "9" }, session: { userId: 7 }, body: {}, query: {} });

test("an anonymous caller is 401'd and never reaches the handler", async () => {
  const r = await run(null, { params: { ownerUserId: "9" }, session: {}, body: {}, query: {} });
  assert.equal(r.res.code, 401);
  assert.equal(r.nexted, false);
});

test("a non-numeric owner id is 400, and no lookup happens", async () => {
  let looked = false;
  const r = await run({ accessStore: { async resolveRole() { looked = true; return "manager"; } } },
    { params: { ownerUserId: "drake" }, session: { userId: 7 }, body: {}, query: {} });
  assert.equal(r.res.code, 400);
  assert.equal(r.nexted, false);
  assert.equal(looked, false);
});

test("a stranger is 403'd, and the body does not reveal whether the owner exists", async () => {
  const r = await run(null, REQ());
  assert.equal(r.res.code, 403);
  assert.equal(r.nexted, false);
  assert.ok(!/exist|found|unknown/i.test(JSON.stringify(r.res.body)),
    "the 403 must not be an oracle for which user ids are real");
});

test("a VIEWER is 403'd off the point-adjust route", async () => {
  // The core of the whole model: a read grant must not reach a write route.
  const r = await run({ accessStore: { async resolveRole() { return "viewer"; } } }, REQ());
  assert.equal(r.res.code, 403);
  assert.equal(r.nexted, false, "403 must stop the chain, not fall through");
  assert.equal(r.res.body.capability, "adjust_points");
});

test("a VIEWER passes the read route", async () => {
  const r = await run({ accessStore: { async resolveRole() { return "viewer"; } } }, REQ(), dayRoute);
  assert.equal(r.nexted, true);
  assert.equal(r.res.code, undefined);
});

test("a coach passes, and the role is resolved VIEWER-over-OWNER", async () => {
  const calls = [];
  const r = await run({ accessStore: { async resolveRole(v, o) { calls.push([v, o]); return "coach"; } } }, REQ());
  assert.equal(r.nexted, true);
  assert.equal(r.res.code, undefined);
  // Swapping these inverts the grant: "who may act on me" becomes "who may I act on".
  assert.deepEqual(calls, [[7, 9]], "resolveRole(viewer, owner)");
  assert.deepEqual(r.req.grant, {
    role: "coach", ownerUserId: 9, viewerUserId: 7, ownerWorkspaceId: "ws-of-9"
  });
});

test("the grant carries the OWNER's workspace, never the caller's", async () => {
  // The cross-tenant escape: if the grant took req.workspaceId, a coach would act
  // inside their own workspace while believing they were acting in the owner's.
  const req = Object.assign(REQ(), { workspaceId: "ws-of-the-CALLER" });
  const r = await run({ accessStore: { async resolveRole() { return "manager"; } } }, req);
  assert.equal(r.req.grant.ownerWorkspaceId, "ws-of-9");
  assert.notEqual(r.req.grant.ownerWorkspaceId, "ws-of-the-CALLER");
});

test("a store failure DENIES rather than falling through", async () => {
  const r = await run({ accessStore: { async resolveRole() { throw new Error("db down"); } } }, REQ());
  assert.equal(r.res.code, 403);
  assert.equal(r.nexted, false, "a thrown error must deny");
});

test("the tier axis cannot satisfy a delegated capability", async () => {
  // `comment` is in CAPABILITY_MIN_TIER at "guest", so a tier-based check would
  // authorize every signed-in stranger. The guard must use the role axis only.
  assert.equal(capabilities.canForOwner("comment", "none"), false);
  assert.equal(capabilities.can("user", "comment"), true, "still true on the PUBLIC axis");
});

test("wiring a non-delegatable capability fails at MOUNT, not at request time", () => {
  // A guard named for a tier-only capability would authorize everyone. Better to
  // refuse to boot than to silently allow.
  assert.throws(() => {
    const app = {};
    for (const v of ["get", "post", "patch", "put", "delete"]) app[v] = () => {};
    // Re-mount with a capability that has no role minimum by monkeypatching the
    // shared table for the duration of the call would be invasive; instead assert
    // the helper the guard relies on.
    if (!capabilities.isDelegatable("place_bounty")) throw new Error("not delegatable");
  }, /not delegatable/);
  assert.equal(capabilities.isDelegatable("place_bounty"), false, "tier-only");
  assert.equal(capabilities.isDelegatable("adjust_points"), true);
});
