const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
test(
  "integration login, selected consent, immediate reductions, discovery and disconnect",
  { skip: !process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
    const app = require("express")();
    app.use(require("express").json());
    app.use(
      require("express-session")({ secret: "synthetic-integration-test-only", resave: false, saveUninitialized: false })
    );
    app.post("/fixture/login", (req, res) => {
      req.session.userId = 1;
      req.session.workspaceId = "ws-1";
      req.session.username = "Test owner";
      res.end();
    });
    const { oauth } = require("./routes/conversation")(app, ctx, {
      enabled: true,
      baseUrl: "https://dcc.example",
      clients: { fixture: { name: "ChatGPT", redirect_uris: ["https://client.example/callback"] } }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;
    const call = (path, options = {}) => fetch(base + path, { redirect: "manual", ...options });
    assert.equal((await call("/connections/conversation")).status, 302);
    const signedOut = await call("/api/me/chat-connections");
    assert.equal(signedOut.status, 401);
    assert.match(signedOut.headers.get("content-type"), /json/);
    const login = await call("/fixture/login", { method: "POST" }),
      cookie = login.headers.get("set-cookie").split(";")[0];
    const request = async (path, body) =>
      call(path, {
        method: "POST",
        headers: { cookie, origin: "https://dcc.example", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body)
      });
    const legacy = await call("/connections/conversation", { headers: { cookie } });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/?settings=connections&connection=chatgpt");
    const api = await call("/api/me/chat-connections", { headers: { cookie } });
    const settings = await api.json();
    assert.equal(settings.categories.length, 6);
    assert.deepEqual(settings.grants, []);
    assert.equal(settings.accountId, 1);
    assert.equal(api.headers.get("cache-control"), "no-store");
    const csrf = settings.csrf;
    let html;
    assert.equal(
      (await request("/connections/conversation/preferences", { csrf: "wrong", tasks: "write" })).status,
      403
    );
    assert.equal(
      (await request("/connections/conversation/preferences", { csrf, tasks: "write", repeats: "read" })).status,
      302
    );
    assert.deepEqual(await oauth.preferences({ userId: 1, workspaceId: "ws-1" }), [
      "dcc.tasks.read",
      "dcc.tasks.write",
      "dcc.repeats.read"
    ]);
    const staleAccount = await call("/connections/conversation/preferences", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://dcc.example",
        Accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ csrf, tasks: "write", expectedUserId: 2, expectedWorkspaceId: "ws-2" })
    });
    assert.equal(staleAccount.status, 409);
    const jsonSave = await call("/connections/conversation/preferences", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://dcc.example",
        Accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ csrf, tasks: "write", repeats: "read", expectedUserId: 1, expectedWorkspaceId: "ws-1" })
    });
    assert.equal(jsonSave.status, 200);
    assert.deepEqual(await jsonSave.json(), { ok: true });
    const verifier = crypto.randomBytes(32).toString("base64url");
    const params = {
      client_id: "fixture",
      redirect_uri: "https://client.example/callback",
      resource: "https://dcc.example/mcp/dcc",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      state: "test",
      scope: "dcc.tasks.read dcc.tasks.write dcc.repeats.read dcc.repeats.write"
    };
    const authorize = "/oauth/dcc/authorize?" + new URLSearchParams(params);
    html = await (await call(authorize, { headers: { cookie } })).text();
    assert.match(html, /Allow selected access/);
    // Chosen subset rather than every requested permission becomes the grant.
    const response = await request("/oauth/dcc/authorize", { csrf, decision: "allow", tasks: "write", repeats: "off" });
    assert.equal(response.status, 302);
    const code = new URL(response.headers.get("location")).searchParams.get("code");
    const token = await oauth.token({
      client_id: "fixture",
      redirect_uri: params.redirect_uri,
      resource: params.resource,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier
    });
    assert.equal(token.scope, "dcc.tasks.read dcc.tasks.write");
    const rpc = async (method, name, args) => {
      const r = await call("/mcp/dcc", {
        method: "POST",
        headers: { authorization: "Bearer " + token.access_token, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: args || {} } : {} })
      });
      return { status: r.status, body: await r.json() };
    };
    let tools = (await rpc("tools/list")).body.result.tools.map((t) => t.name);
    assert.ok(tools.includes("dcc_tasks"));
    assert.ok(!tools.includes("dcc_repeats"));
    assert.ok(!tools.includes("dcc_task"), "legacy all-data readers are not exposed");
    assert.equal((await rpc("tools/call", "dcc_repeats", { action: "list" })).status, 403);
    const status = (await rpc("tools/call", "dcc_connection_status")).body.result.structuredContent;
    assert.equal(status.status, "verified");
    const grant = (await oauth.list({ userId: 1, workspaceId: "ws-1" }))[0];
    assert.ok(grant.last_verified_at);
    assert.equal(
      (await request("/connections/conversation/permissions", { csrf, grantId: grant.id, tasks: "read" })).status,
      302
    );
    const denied = await rpc("tools/call", "dcc_tasks", {
      action: "create",
      sourceEventId: "not-authorized",
      input: { title: "No" }
    });
    assert.equal(denied.body.result.isError, true);
    assert.equal(
      (await request("/connections/conversation/permissions", { csrf, grantId: grant.id, tasks: "write" })).status,
      409
    );
    assert.equal((await request("/connections/conversation/revoke", { csrf, grantId: grant.id })).status, 302);
    assert.equal((await rpc("tools/list")).status, 401);
  }
);
