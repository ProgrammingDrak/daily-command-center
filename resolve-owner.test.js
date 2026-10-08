// resolve-owner.test.js — precedence contract for middleware/resolve-owner.js.
// These orders are load-bearing: ingest paths attribute token-authed writes to
// the service target (service-first); interactive paths trust the session and
// refuse to guess in production. A change that flips an order should fail here.
const { test } = require("node:test");
const assert = require("node:assert");
const { resolveOwnerStrict, resolveOwnerLenient } = require("./middleware/resolve-owner");

test("lenient: service identity beats session (ingest attribution)", () => {
  const r = resolveOwnerLenient({ dccServiceAuth: { userId: 7, workspaceId: "ws-7" }, session: { userId: 1 }, headers: {} });
  assert.equal(r.userId, 7);
  assert.equal(r.workspaceId, "ws-7");
});

test("lenient: session, then x-user-id header, then null; ws-1 default", () => {
  assert.equal(resolveOwnerLenient({ session: { userId: 1 }, headers: {} }).userId, 1);
  const h = resolveOwnerLenient({ headers: { "x-user-id": "3" } });
  assert.equal(h.userId, 3);
  assert.equal(h.workspaceId, "ws-1");
  assert.equal(resolveOwnerLenient({ headers: {} }).userId, null);
});

test("strict: session beats service identity (interactive writes)", async () => {
  const r = await resolveOwnerStrict({ session: { userId: 1 }, workspaceId: "ws-1", dccServiceAuth: { userId: 7 }, headers: {} });
  assert.equal(r.userId, 1);
});

test("strict: refuses to guess identity in production", async (t) => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { process.env.NODE_ENV = prev; });
  await assert.rejects(() => resolveOwnerStrict({ headers: {} }), (e) => e.status === 400);
});

test("strict: user-only service requests resolve the owned workspace using the exported pool",async(t)=>{
 const pool=require("./pg-pool");const previous=pool.query;const calls=[];
 pool.query=async(sql,args)=>{calls.push({sql,args});return {rows:[{workspace_id:"ws-owned"}]};};
 t.after(()=>{pool.query=previous;});
 const owner=await resolveOwnerStrict({headers:{"x-user-id":"1"}});
 assert.deepEqual(owner,{userId:1,workspaceId:"ws-owned"});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,[1]);assert.match(calls[0].sql,/workspace_members WHERE user_id=\$1 AND role='owner'/);
});
