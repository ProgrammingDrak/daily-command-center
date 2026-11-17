const { test } = require("node:test");
const assert = require("node:assert");
const { createTokenStore, hashToken } = require("./token-store");

function stubPool() {
  const calls = [];
  const responses = [];
  return {
    calls,
    queueRow(row) { responses.push({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }); },
    query(sql, params) {
      calls.push({ sql, params });
      if (/CREATE TABLE/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve(responses.shift() || { rows: [], rowCount: 0 });
    },
  };
}

test("hashToken is deterministic sha256 hex", () => {
  assert.strictEqual(hashToken("abc"), hashToken("abc"));
  assert.match(hashToken("abc"), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hashToken("abc"), hashToken("abd"));
});

test("createToken returns plaintext once and stores only the hash", async () => {
  const pool = stubPool();
  const store = createTokenStore(pool);
  pool.queueRow({ owner: true });
  pool.queueRow({ id: 1, name: "sweep bot", scope: "sweep", created_at: "x", expires_at: null });
  const out = await store.createToken({ name: "sweep bot", scope: "sweep",userId:1,workspaceId:"ws-1",actions:["POST /api/dcc/quick-task"] });
  assert.match(out.token, /^dcc_[0-9a-f]{48}$/);
  const insert = pool.calls.find((c) => /INSERT INTO service_tokens/.test(c.sql));
  assert.strictEqual(insert.params[1], hashToken(out.token));
  assert.ok(!insert.params.includes(out.token), "plaintext must not be stored");
});

test("createToken rejects bad scope and missing name", async () => {
  const store = createTokenStore(stubPool());
  await assert.rejects(() => store.createToken({ name: "x", scope: "root" }), /scope/);
  await assert.rejects(() => store.createToken({ name: "  " }), /name required/);
});

test("service authentication requires account binding, current membership and exact action",async()=>{
 const pool=stubPool(),store=createTokenStore(pool);
 assert.equal(await store.authenticateToken('missing','dcc','POST /api/dcc/quick-task'),null);
 pool.queueRow({id:7,scope:'all'});
 assert.equal(await store.authenticateToken('global','dcc','POST /api/dcc/quick-task'),null);
 pool.queueRow({id:7,scope:'dcc',user_id:1,workspace_id:'ws-1',actions:['POST /api/dcc/quick-task']});
 assert.deepEqual(await store.authenticateToken('bound','dcc','POST /api/dcc/quick-task'),{userId:1,workspaceId:'ws-1',source:'service-token:7'});
 pool.queueRow({id:7,scope:'dcc',user_id:1,workspace_id:'ws-1',actions:['POST /api/dcc/quick-task']});
 assert.equal(await store.authenticateToken('bound','dcc','POST /api/dcc/refresh'),null);
});

test("revokeToken returns false when nothing live matched", async () => {
  const pool = stubPool();
  const store = createTokenStore(pool);
  assert.strictEqual(await store.revokeToken(99), false);
});
