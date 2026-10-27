const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const express = require("express"),
  session = require("express-session");
const { createActivityDb } = require("./test-support/activity-db");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
test("real HTTP: discovery, consent, MCP calls and disconnect", { skip: !configured }, async (t) => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "synthetic-test-session-secret", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => {
    req.session.userId = req.body.userId;
    req.session.workspaceId = "ws-" + req.body.userId;
    req.session.username = "Synthetic " + req.body.userId;
    res.json({ ok: true });
  });
  const mount = require("./routes/conversation");
  const mounted = mount(app, ctx, {
    enabled: true,
    baseUrl: "https://dcc.example",
    clients: { chatgpt: { name: "ChatGPT", redirect_uris: ["https://chatgpt.com/callback"] } }
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (path, options = {}) => fetch(base + path, { redirect: "manual", ...options });
  let r = await call("/.well-known/oauth-protected-resource/mcp/dcc");
  assert.equal((await r.json()).resource, "https://dcc.example/mcp/dcc");
  r = await call("/.well-known/oauth-authorization-server");
  assert.deepEqual((await r.json()).code_challenge_methods_supported, ["S256"]);
  r = await call("/mcp/dcc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata=/);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const auth = {
    client_id: "chatgpt",
    response_type: "code",
    redirect_uri: "https://chatgpt.com/callback",
    scope: "dcc.read dcc.work",
    state: "synthetic-state",
    resource: "https://dcc.example/mcp/dcc",
    code_challenge_method: "S256",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url")
  };
  const url = "/oauth/dcc/authorize?" + new URLSearchParams(auth);
  r = await call(url);
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login\?next=/);
  r = await call("/test-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 1 })
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  r = await call(url, { headers: { cookie } });
  const html = await r.text();
  assert.match(html, /Allow access/);
  assert.match(html, /Synthetic 1/);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const consent = (token, origin = "https://dcc.example") =>
    call("/oauth/dcc/authorize", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: token, decision: "allow" })
    });
  assert.equal((await consent("forged")).status, 403);
  assert.equal((await consent(csrf, "https://evil.example")).status, 403);
  r = await consent(csrf);
  assert.equal(r.status, 302);
  const redirect = new URL(r.headers.get("location"));
  assert.equal(redirect.origin, "https://chatgpt.com");
  assert.equal(redirect.searchParams.get("state"), "synthetic-state");
  r = await call("/oauth/dcc/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "chatgpt",
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: auth.redirect_uri,
      resource: auth.resource
    })
  });
  assert.equal(r.status, 200);
  const credentials = await r.json();
  const rpc = async (method, params = {}, extra = {}) => {
    const response = await call("/mcp/dcc", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + credentials.access_token, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return { status: response.status, body: await response.json() };
  };
  let result = await rpc("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "test", version: "1" } });
  assert.equal(result.body.result.serverInfo.name, "dcc-account");
  result = await rpc("tools/list");
  assert.ok(result.body.result.tools.some((t) => t.name === "dcc_work"));
  assert.ok(!result.body.result.tools.some((t) => t.name === "dcc_correct_time"));
  result = await rpc("tools/call", { name: "dcc_correct_time", arguments: {} });
  assert.equal(result.status, 403);
  result = await rpc(
    "tools/call",
    { name: "dcc_current_activity", arguments: {} },
    { "x-user-id": "2", "x-workspace-id": "ws-2" }
  );
  assert.equal(result.body.result.structuredContent.revision, 0);
  await ctx.blockDB.createBlock({
    id: "http-task",
    type: "block",
    date: "2026-10-20",
    user_id: 1,
    workspace_id: "ws-1",
    properties: { local_id: "http-task", title: "HTTP Task", type: "task", status: "open" }
  });
  result = await rpc("tools/call", {
    name: "dcc_work",
    arguments: {
      action: "mention",
      taskId: "http-task",
      expectedRevision: 0,
      sourceEventId: "mention",
      at: "2026-10-20T13:00:00Z"
    }
  });
  assert.equal(result.body.result.isError, true);
  const args = {
    action: "start",
    taskId: "http-task",
    expectedRevision: 0,
    sourceEventId: "http-start",
    at: "2026-10-20T13:00:44Z"
  };
  result = await rpc("tools/call", { name: "dcc_work", arguments: args });
  assert.equal(result.body.result.isError, false);
  assert.equal(result.body.result.structuredContent.state.foreground[0].id, "http-task");
  result = await rpc("tools/call", { name: "dcc_task", arguments: { taskId: "http-task" } });
  assert.equal(result.body.result.structuredContent.task.properties.startedAt, args.at.replace("Z", ".000Z"));
  result = await rpc("tools/call", { name: "dcc_work", arguments: args });
  assert.equal(result.body.result.structuredContent.duplicate, true);
  result = await rpc("tools/list", {}, { origin: "https://evil.example" });
  assert.equal(result.status, 403);
  r = await call("/connections/conversation", { headers: { cookie } });
  const connections = await r.text();
  assert.match(connections, /Disconnect/);
  const revokeCsrf = /name="csrf" value="([^"]+)"/.exec(connections)[1],
    grantId = /name="grantId" value="([^"]+)"/.exec(connections)[1];
  r = await call("/connections/conversation/revoke", {
    method: "POST",
    headers: { cookie, origin: "https://dcc.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: revokeCsrf, grantId })
  });
  assert.equal(r.status, 302);
  result = await rpc("tools/list");
  assert.equal(result.status, 401);
  assert.equal(
    (await mounted.store.get("http-task", { userId: 1, workspaceId: "ws-1" })).task.properties.startedAt,
    "2026-10-20T13:00:44.000Z",
    "disconnect does not discard recorded work"
  );
});
