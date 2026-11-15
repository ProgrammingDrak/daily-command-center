/* global document, window */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const { createClerkMcpAuth } = require("./clerk-mcp-auth");
const { createActivityDb } = require("./test-support/activity-db");
const configured = !!(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
test(
  "Clerk HTTP boundary: account isolation, approval, reduction, disconnect and reconnect",
  { skip: !configured },
  async (t) => {
    const ctx = await createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
    await ctx.pool.query("UPDATE users SET external_id='clerk-'||id");
    const baseUrl = "https://dcc.example",
      issuer = "https://clerk.example";
    const scopes = [
      "dcc.tasks.read",
      "dcc.tasks.write",
      "dcc.organization.read",
      "dcc.organization.write",
      "dcc.repeats.read",
      "dcc.repeats.write"
    ];
    const tokens = new Map();
    const retired = new Set();
    let outage = false;
    function mint(raw, subject = "clerk-1", extra = {}) {
      tokens.set(raw, {
        object: "clerk_idp_oauth_access_token",
        id: "oat-" + raw,
        client_id: "https://chatgpt.com/oauth/client.json",
        subject,
        scopes: [...scopes],
        aud: [baseUrl + "/mcp/dcc"],
        expiration: Math.floor(Date.now() / 1000) + 3600,
        created_at: Math.floor(Date.now() / 1000),
        family: subject,
        ...extra
      });
    }
    mint("one");
    mint("two", "clerk-2");
    mint("rotated");
    mint("wrong-audience", "clerk-1", { aud: ["https://other.example/mcp"] });
    const oauth = createClerkMcpAuth({
      pool: ctx.pool,
      baseUrl,
      issuer,
      secretKey: "test-only-secret",
      encryptionKey: "42".repeat(32),
      clientIds: ["https://chatgpt.com/oauth/client.json"],
      fetch: async (url, options = {}) => {
        if (outage) return new globalThis.Response("{}", { status: 503 });
        if (url === issuer + "/.well-known/oauth-authorization-server")
          return globalThis.Response.json({
            issuer,
            authorization_endpoint: issuer + "/oauth/authorize",
            token_endpoint: issuer + "/oauth/token",
            client_id_metadata_document_supported: true,
            code_challenge_methods_supported: ["S256"]
          });
        if (url.includes("/access_tokens/verify")) {
          const raw = JSON.parse(options.body).access_token;
          const token = tokens.get(raw);
          return globalThis.Response.json(
            token ? { ...token, revoked: retired.has(token.family), expired: false } : { active: false }
          );
        }
        if (url.includes("/revoke_token")) {
          const token = tokens.get(JSON.parse(options.body).token);
          retired.add(token.family);
          return new globalThis.Response(null, { status: 204 });
        }
        if (url.includes("/oauth_applications?"))
          return globalThis.Response.json({
            data: [{ id: "oauthapp-test", client_id: "https://chatgpt.com/oauth/client.json" }]
          });
        throw new Error("Unexpected test URL " + url);
      }
    });
    const app = express();
    app.use("/public", express.static(require("node:path").join(__dirname, "public")));
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: "isolated-http-test-session", resave: false, saveUninitialized: false }));
    app.post("/test-login", (req, res) => {
      req.session.userId = req.body.userId;
      req.session.workspaceId = "ws-" + req.body.userId;
      req.session.username = "Synthetic " + req.body.userId;
      res.json({ ok: true });
    });
    require("./routes/conversation")(app, ctx, { enabled: true, provider: "clerk", oauth, baseUrl });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const local = "http://127.0.0.1:" + server.address().port;
    async function call(name, args = {}, token = "one") {
      const r = await fetch(local + "/mcp/dcc", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      });
      const b = await r.json();
      return {
        r,
        b,
        result: b.result?.structuredContent,
        error: b.result?.isError ? JSON.parse(b.result.content[0].text) : null
      };
    }
    async function login(userId) {
      const r = await fetch(local + "/test-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId })
      });
      return r.headers.get("set-cookie").split(";")[0];
    }
    async function settings(cookie) {
      return (
        await fetch(local + "/api/me/chat-connections", { headers: { cookie, accept: "application/json" } })
      ).json();
    }
    async function post(path, body, cookie) {
      return fetch(local + path, {
        method: "POST",
        headers: { cookie, origin: baseUrl, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    await t.test("untrusted database roles cannot access MCP connection or approval tables", async () => {
      const q = await ctx.pool.connect();
      const role = "mcp_untrusted_" + require("node:crypto").randomBytes(6).toString("hex");
      try {
        const schema = (await q.query("SELECT current_schema() AS name")).rows[0].name;
        await q.query(`CREATE ROLE "${role}" NOLOGIN`);
        await q.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await q.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON mcp_connections,mcp_connection_tokens,mcp_approvals,mcp_action_log TO "${role}"`
        );
        await q.query("BEGIN");
        await q.query(`SET LOCAL ROLE "${role}"`);
        for (const table of ["mcp_connections", "mcp_connection_tokens", "mcp_approvals", "mcp_action_log"])
          assert.equal((await q.query(`SELECT * FROM ${table}`)).rows.length, 0);
        await assert.rejects(
          q.query(
            "INSERT INTO mcp_action_log(id,user_id,workspace_id,connection_id,operation,outcome) VALUES('bad',1,'ws-1','bad','bad','bad')"
          ),
          { code: "42501" }
        );
        await q.query("ROLLBACK");
      } finally {
        await q.query("ROLLBACK");
        await q.query(`DROP OWNED BY "${role}"`);
        await q.query(`DROP ROLE "${role}"`);
        q.release();
      }
    });
    const cookie = await login(1),
      otherCookie = await login(2);
    await t.test("accept only provider OAuth tokens and reject impersonation", async () => {
      assert.equal((await call("dcc_profile", {}, "wrong-audience")).r.status, 401);
      assert.equal((await call("dcc_profile", {}, "a.jwt.token")).r.status, 401);
      assert.equal((await call("dcc_profile", {}, "service-secret")).r.status, 401);
      const profile = (await call("dcc_profile")).result;
      assert.ok(profile.id);
      assert.deepEqual((await call("dcc_profile", {}, "rotated")).result, profile);
      assert.notEqual((await call("dcc_profile", {}, "two")).result.id, profile.id);
      const unauth = await fetch(local + "/mcp/dcc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(unauth.status, 401);
    });
    const created = (await call("dcc_tasks_create", { sourceEventId: "create-own", input: { title: "Own task" } }))
      .result;
    assert.equal(created.saveStatus, "verified_saved");
    const ownId = created.task.id;
    const foreign = (
      await call("dcc_tasks_create", { sourceEventId: "create-other", input: { title: "Foreign task" } }, "two")
    ).result.task.id;
    await ctx.blockDB.createBlock({
      id: "null-owned",
      type: "block",
      workspace_id: "ws-1",
      user_id: null,
      properties: { title: "Unowned", type: "task", kind: "backlog" }
    });
    await t.test("scope all reads, writes, replay and references to account", async () => {
      assert.equal((await call("dcc_tasks_get", { id: foreign })).error.status, 404);
      assert.equal((await call("dcc_tasks_get", { id: "null-owned" })).error.status, 404);
      assert.equal(
        (await call("dcc_tasks_create", { sourceEventId: "bad-parent", input: { title: "No", parentId: foreign } }))
          .error.status,
        404
      );
      assert.equal((await call("dcc_files_list", { taskId: foreign })).r.status, 403);
      const list = (await call("dcc_tasks_list")).result;
      assert.ok(list.tasks.every((x) => x.id !== foreign && x.id !== "null-owned"));
      const replay = (await call("dcc_tasks_create", { sourceEventId: "create-own", input: { title: "Own task" } }))
        .result;
      assert.deepEqual(replay, created);
    });
    await t.test("a disconnect after token verification still prevents mutation commit", async () => {
      const original = oauth.verify;
      let armed = true;
      oauth.verify = async (raw, scope) => {
        const identity = await original(raw, scope);
        if (armed && scope === "dcc.tasks.write") {
          armed = false;
          await ctx.pool.query("UPDATE mcp_connections SET revoked_at=NOW() WHERE id=$1", [identity.grantId]);
        }
        return identity;
      };
      try {
        const result = await call("dcc_tasks_create", {
          sourceEventId: "race-denied",
          input: { title: "Must not save" }
        });
        assert.equal(result.error.status, 401);
        assert.equal(
          (await ctx.pool.query("SELECT id FROM blocks WHERE properties->>'title'='Must not save'")).rows.length,
          0
        );
      } finally {
        oauth.verify = original;
        await ctx.pool.query("UPDATE mcp_connections SET revoked_at=NULL WHERE subject='clerk-1'");
      }
    });
    await t.test("read aliases cannot be converted into writes by their arguments", async () => {
      const result = await call("dcc_tasks_list", {
        action: "create",
        sourceEventId: "injected",
        input: { title: "No" }
      });
      assert.equal(result.error.status, 400);
    });
    await t.test("imports remain unsaved until an authenticated exact approval", async () => {
      const manifest = require("./project-store").previewImport({
        text: "- Install a test shelf",
        projectName: "Approval fixture"
      });
      const pending = (await call("dcc_organization_import", { sourceEventId: "import-reviewed", input: { manifest } }))
        .result;
      assert.equal(pending.saveStatus, "pending_approval");
      assert.equal(
        (await ctx.pool.query("SELECT id FROM blocks WHERE properties->>'title'='Approval fixture'")).rows.length,
        0
      );
      const csrf = (await settings(cookie)).csrf;
      const approved = await post(pending.reviewUrl, { csrf, decision: "approve" }, cookie);
      assert.equal(approved.status, 200);
      const saved = await approved.json();
      assert.ok(saved.result.projectId);
      assert.equal((await ctx.blockDB.getBlock(saved.result.projectId)).user_id, 1);
    });
    await t.test("saved DCC access choices cap a newly connected provider token", async () => {
      await ctx.pool.query(
        "INSERT INTO users(id,username,password_hash,external_id,created_at,updated_at) VALUES(4,'limited','synthetic','clerk-4',NOW(),NOW()); INSERT INTO workspaces(id,name,slug,owner_id,created_at,updated_at) VALUES('ws-4','Limited','limited',4,NOW(),NOW()); INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('ws-4',4,'owner',NOW()); INSERT INTO conversation_preferences(user_id,workspace_id,scopes) VALUES(4,'ws-4','[\"dcc.tasks.read\"]')"
      );
      mint("limited", "clerk-4");
      assert.equal((await call("dcc_tasks_list", {}, "limited")).r.status, 200);
      assert.equal(
        (await call("dcc_tasks_create", { sourceEventId: "excessive", input: { title: "No" } }, "limited")).r.status,
        403
      );
    });
    let review;
    await t.test("assistant stages deletion; only the matching browser can commit exact manifest", async () => {
      const prepared = (await call("dcc_bulk_cleanup_prepare", { sourceEventId: "cleanup-one", ids: [ownId] })).result;
      review = (await call("dcc_bulk_cleanup_run", { jobId: prepared.jobId })).result;
      assert.equal(review.saveStatus, "pending_approval");
      assert.equal((await ctx.blockDB.getBlock(ownId)).deleted_at, null);
      const wrong = await post(
        review.reviewUrl,
        { decision: "approve", csrf: (await settings(otherCookie)).csrf },
        otherCookie
      );
      assert.equal(wrong.status, 404);
      const unauth = await post(review.reviewUrl, { decision: "approve", csrf: "x" }, "");
      assert.equal(unauth.status, 401);
      const csrf = (await settings(cookie)).csrf;
      if (process.env.CHROMIUM_PATH) {
        const browser = await require("playwright-core").chromium.launch({
          executablePath: process.env.CHROMIUM_PATH,
          headless: true,
          args: ["--no-sandbox"]
        });
        try {
          const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
          const [cookieName, cookieValue] = cookie.split("=");
          await page.context().addCookies([{ name: cookieName, value: cookieValue, url: local }]);
          await page.goto(local + review.reviewUrl);
          await page.getByRole("heading", { name: "Delete selected tasks" }).waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
          await page.screenshot({ path: "/tmp/dcc-approval-mobile.png" });
        } finally {
          await browser.close();
        }
      }
      assert.equal((await post(review.reviewUrl, { decision: "approve", csrf: "bad" }, cookie)).status, 403);
      const r = await post(review.reviewUrl, { decision: "approve", csrf }, cookie);
      assert.equal(r.status, 200);
      const saved = await r.json();
      assert.equal(saved.saveStatus, "verified_saved");
      assert.ok((await ctx.blockDB.getBlock(ownId)).deleted_at);
      assert.equal((await call("dcc_approval_status", { approvalId: review.approvalId })).result.status, "approved");
      assert.equal((await post(review.reviewUrl, { decision: "approve", csrf }, cookie)).status, 200);
    });
    await t.test("stale and expired manifests cannot commit", async () => {
      const task = (await call("dcc_tasks_create", { sourceEventId: "stale-task", input: { title: "Before" } })).result
        .task;
      const job = (await call("dcc_bulk_cleanup_prepare", { sourceEventId: "stale-job", ids: [task.id] })).result;
      const pending = (await call("dcc_bulk_cleanup_run", { jobId: job.jobId })).result;
      await ctx.blockDB.updateBlock(task.id, {
        properties: { ...(await ctx.blockDB.getBlock(task.id)).properties, title: "After" }
      });
      const csrf = (await settings(cookie)).csrf;
      assert.equal((await post(pending.reviewUrl, { decision: "approve", csrf }, cookie)).status, 409);
      await ctx.pool.query("UPDATE mcp_approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [
        pending.approvalId
      ]);
      assert.equal((await post(pending.reviewUrl, { decision: "approve", csrf }, cookie)).status, 409);
      assert.equal((await ctx.blockDB.getBlock(task.id)).deleted_at, null);
    });
    await t.test("one approval commits every bounded cleanup batch", async () => {
      const ids = [];
      for (let i = 0; i < 30; i++) {
        const id = "batch-" + i;
        ids.push(id);
        await ctx.blockDB.createBlock({
          id,
          type: "block",
          workspace_id: "ws-1",
          user_id: 1,
          properties: { title: "Batch " + i, type: "task", kind: "backlog" }
        });
      }
      const job = (await call("dcc_bulk_cleanup_prepare", { sourceEventId: "many-records", ids })).result;
      const pending = (await call("dcc_bulk_cleanup_run", { jobId: job.jobId })).result;
      const csrf = (await settings(cookie)).csrf;
      const response = await post(pending.reviewUrl, { csrf, decision: "approve" }, cookie);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.result.processed, 30);
      assert.equal(result.result.status, "completed");
      assert.equal(
        (await ctx.pool.query("SELECT id FROM blocks WHERE id=ANY($1::text[]) AND deleted_at IS NULL", [ids])).rows
          .length,
        0
      );
    });
    await t.test("permission reductions survive rotated tokens; no task write can expand access", async () => {
      const info = await settings(cookie);
      const id = info.grants[0].id;
      assert.equal(
        (await post("/connections/conversation/permissions", { csrf: info.csrf, grantId: id, tasks: "read" }, cookie))
          .status,
        200
      );
      assert.equal(
        (await call("dcc_tasks_create", { sourceEventId: "denied", input: { title: "No" } }, "rotated")).r.status,
        403
      );
      assert.equal(
        (await post("/connections/conversation/permissions", { csrf: info.csrf, grantId: id, tasks: "write" }, cookie))
          .status,
        409
      );
    });
    await t.test("disconnect blocks locally through provider outage, then retires refresh family", async () => {
      const info = await settings(cookie),
        id = info.grants[0].id;
      outage = true;
      let response = await post("/connections/conversation/revoke", { csrf: info.csrf, grantId: id }, cookie);
      assert.equal((await response.json()).revocationPending, true);
      assert.equal((await call("dcc_profile")).r.status, 401);
      outage = false;
      assert.equal((await call("dcc_profile")).r.status, 401);
      assert.equal(
        (await post("/connections/conversation/reconnect", { csrf: info.csrf, grantId: id }, cookie)).status,
        409
      );
      response = await post("/connections/conversation/revoke", { csrf: info.csrf, grantId: id }, cookie);
      assert.equal((await response.json()).revocationPending, false);
      assert.equal(
        (await post("/connections/conversation/reconnect", { csrf: info.csrf, grantId: id }, cookie)).status,
        200
      );
      assert.equal((await call("dcc_profile", {}, "rotated")).r.status, 401);
      mint("fresh", "clerk-1", { family: "new-grant", created_at: Date.now() / 1000 + 1 });
      assert.ok((await call("dcc_profile", {}, "fresh")).result.id);
      assert.equal((await call("dcc_tasks_list", {}, "two")).r.status, 200);
    });
  }
);
