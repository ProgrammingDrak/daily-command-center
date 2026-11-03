const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const E = require("./mcp-events");
const key = Buffer.alloc(32, 7).toString("base64");
const secret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
const configured = !!(process.env.DCC_TEST_DATABASE_URL || process.env.DCC_PGLITE_MODULE);
test("HTTP MCP Events discovery, consent scopes, subscribe and unsubscribe", { skip: !configured }, async (t) => {
  const ctx = await require("./test-support/activity-db").createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
  let now = Date.now(),
    deliveries = 0;
  const identity = { userId: 1, workspaceId: "ws-1" };
  await ctx.blockDB.createBlock({
    id: "http-task",
    type: "block",
    user_id: 1,
    workspace_id: "ws-1",
    properties: { local_id: "http-task", type: "task", title: "Synthetic", status: "open" }
  });
  await require("./conversation-store")
    .createConversationStore({ ...ctx, now: () => now })
    .execute(
      {
        action: "queue-add",
        taskId: "http-task",
        sourceEventId: "http-add",
        expectedRevision: 0,
        at: new Date(now).toISOString()
      },
      identity
    );
  for (const [id, scopes] of [
    ["http-grant", ["dcc.read", "dcc.events"]],
    ["read-grant", ["dcc.read"]]
  ]) {
    await ctx.pool.query(
      "INSERT INTO conversation_grants(id,user_id,workspace_id,client_id,scopes) VALUES($1,1,'ws-1','synthetic',$2)",
      [id, JSON.stringify(scopes)]
    );
    await ctx.pool.query(
      "INSERT INTO conversation_oauth_tokens(hash,grant_id,kind,resource,expires_at) VALUES($1,$2,'access','https://dcc.example/mcp/dcc',NOW()+INTERVAL '1 hour')",
      [crypto.createHash("sha256").update(id).digest("hex"), id]
    );
  }
  const express = require("express"),
    app = express();
  app.use(express.json());
  const mount = require("./routes/conversation");
  const mounted = mount(app, ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: {},
    eventsEnabled: true,
    eventsKey: key,
    eventWorker: false,
    eventOptions: {
      now: () => now,
      transport: {
        verify: async () => {},
        deliver: async () => {
          deliveries++;
          return { status: 200 };
        }
      }
    }
  });
  t.after(() => mounted.close());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = async (method, params, token = "http-grant") => {
    const r = await fetch("http://127.0.0.1:" + server.address().port + "/mcp/dcc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return r.json();
  };
  assert.ok((await call("initialize", {})).result.capabilities.events);
  assert.equal((await call("events/list", {})).result.events[0].name, E.NAME);
  assert.deepEqual((await call("events/list", {}, "read-grant")).result.events, []);
  const params = {
    name: E.NAME,
    arguments: { task_id: "http-task" },
    delivery: { mode: "webhook", url: "https://callback.example/http", secret }
  };
  assert.equal((await call("events/subscribe", params, "read-grant")).error.code, -32001);
  const sub = (await call("events/subscribe", params)).result;
  assert.ok(sub.id);
  assert.equal((await call("events/subscribe", params)).result.id, sub.id);
  assert.equal(deliveries, 0, "subscribing alone never runs a timer or sends progress");
  assert.deepEqual(
    (await call("events/unsubscribe", { ...params, delivery: { mode: "webhook", url: params.delivery.url } })).result,
    {}
  );
  // Default-off servers do not advertise an event capability or accept subscriptions.
  const off = express();
  off.use(express.json());
  const disabled = mount(off, ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: {},
    eventsEnabled: false
  });
  const offServer = await new Promise((resolve) => {
    const s = off.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => disabled.close());
  t.after(() => new Promise((resolve) => offServer.close(resolve)));
  const response = await fetch("http://127.0.0.1:" + offServer.address().port + "/mcp/dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer http-grant" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
  });
  assert.equal((await response.json()).result.capabilities.events, undefined);
  const invalid = mount(express(), ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: {},
    eventsEnabled: true,
    eventsKey: "invalid"
  });
  assert.equal(invalid.events, null, "bad event configuration cannot bring down existing DCC tools");
  invalid.close();
});
