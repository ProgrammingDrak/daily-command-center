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
  const queueStore = require("./conversation-store").createConversationStore({ ...ctx, now: () => now });
  await queueStore.execute(
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
  app.use(
    require("express-session")({ secret: "synthetic-event-consent-fixture", resave: false, saveUninitialized: false })
  );
  app.post("/fixture/login", (req, res) => {
    req.session.userId = 1;
    req.session.workspaceId = "ws-1";
    req.session.username = "Synthetic owner";
    res.end();
  });
  const mount = require("./routes/conversation");
  const mounted = mount(app, ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: { fixture: { name: "Synthetic ChatGPT", redirect_uris: ["https://client.example/callback"] } },
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
  let disabledVerifications = 0;
  const validEventOptions = {
    eventsKey: key,
    eventWorker: false,
    eventOptions: {
      transport: {
        verify: async () => {
          disabledVerifications++;
        },
        deliver: async () => ({ status: 200 })
      }
    }
  };
  const disabled = mount(off, ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: {},
    ...validEventOptions,
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
  const offSubscribe = await fetch("http://127.0.0.1:" + offServer.address().port + "/mcp/dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer http-grant" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/subscribe", params })
  });
  assert.equal((await offSubscribe.json()).error.code, -32601);
  assert.equal(disabledVerifications, 0);
  assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM dcc_event_subscriptions")).rows[0].n, 0);
  const previousFlag = process.env.DCC_EVENTS_ENABLED;
  try {
    delete process.env.DCC_EVENTS_ENABLED;
    const defaultOff = mount(express(), ctx, {
      enabled: true,
      baseUrl: "https://dcc.example",
      clients: {},
      ...validEventOptions
    });
    assert.equal(defaultOff.events, null, "absence of the flag is independently default-off with a valid key");
    defaultOff.close();
  } finally {
    if (previousFlag === undefined) delete process.env.DCC_EVENTS_ENABLED;
    else process.env.DCC_EVENTS_ENABLED = previousFlag;
  }
  const invalid = mount(express(), ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: {},
    eventsEnabled: true,
    eventsKey: "invalid"
  });
  assert.equal(invalid.events, null, "bad event configuration cannot bring down existing DCC tools");
  invalid.close();
  // Exercise the current permission catalog through real consent and reduction.
  const base = "http://127.0.0.1:" + server.address().port;
  const login = await fetch(base + "/fixture/login", { method: "POST" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const settings = await (await fetch(base + "/api/me/chat-connections", { headers: { cookie } })).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorization = {
    client_id: "fixture",
    redirect_uri: "https://client.example/callback",
    resource: "https://dcc.example/mcp/dcc",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    state: "synthetic-event-consent",
    scope: "dcc.read dcc.events"
  };
  const consent = await fetch(base + "/oauth/dcc/authorize?" + new URLSearchParams(authorization), {
    headers: { cookie },
    redirect: "manual"
  });
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /name="legacy"[^>]*value="dcc.events"/);
  assert.match(html, /Subscribe this chat to check-back deadlines/);
  const selected = new URLSearchParams({ csrf: settings.csrf, decision: "allow" });
  selected.append("legacy", "dcc.read");
  selected.append("legacy", "dcc.events");
  const form = (path, body) =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: "https://dcc.example", "content-type": "application/x-www-form-urlencoded" },
      body
    });
  const allowed = await form("/oauth/dcc/authorize", selected);
  assert.equal(allowed.status, 302);
  const code = new URL(allowed.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const exchange = await form(
    "/oauth/dcc/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "fixture",
      redirect_uri: authorization.redirect_uri,
      resource: authorization.resource,
      code,
      code_verifier: verifier
    })
  );
  assert.equal(exchange.status, 200);
  const token = await exchange.json();
  assert.deepEqual(token.scope.split(" ").sort(), ["dcc.events", "dcc.read"]);
  assert.equal((await call("events/list", {}, token.access_token)).result.events[0].name, E.NAME);
  const authorizedSub = (await call("events/subscribe", params, token.access_token)).result;
  assert.ok(authorizedSub.id);
  const grantId = (await ctx.pool.query("SELECT grant_id FROM dcc_event_subscriptions WHERE id=$1", [authorizedSub.id]))
    .rows[0].grant_id;
  await queueStore.execute(
    {
      action: "background-start",
      taskId: "http-task",
      remindMinutes: 1,
      sourceEventId: "consent-background",
      expectedRevision: (await queueStore.state(identity)).revision,
      at: new Date(now).toISOString()
    },
    identity
  );
  assert.equal(
    (
      await form(
        "/connections/conversation/permissions",
        new URLSearchParams({ csrf: settings.csrf, grantId, legacy: "dcc.read" })
      )
    ).status,
    302
  );
  assert.deepEqual((await call("events/list", {}, token.access_token)).result.events, []);
  assert.equal((await call("events/subscribe", params, token.access_token)).error.code, -32001);
  now += 61000;
  await mounted.events.tick();
  assert.equal(deliveries, 0, "removing only event scope stops the existing due subscription");
  const grant = (await ctx.pool.query("SELECT scopes,revoked_at FROM conversation_grants WHERE id=$1", [grantId]))
    .rows[0];
  assert.deepEqual(grant.scopes, ["dcc.read"]);
  assert.equal(grant.revoked_at, null, "the grant remains connected");
});
