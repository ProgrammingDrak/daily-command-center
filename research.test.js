const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
async function fixture() {
  delete require.cache[require.resolve("./db")];
  delete require.cache[require.resolve("./pg-schema")];
  return createActivityDb();
}
const { createStore } = require("./research-store");
const mcp = require("./lib/research-mcp");
const W = require("./lib/wishlist-model");
const configured = Boolean(process.env.DCC_TEST_DATABASE_URL || process.env.DCC_PGLITE_MODULE);
const actor = { userId: 1, workspaceId: "ws-1" };
const other = { userId: 2, workspaceId: "ws-2" };
const scopes = [
  "dcc.research.read",
  "dcc.research.write",
  "dcc.tasks.read",
  "dcc.tasks.write",
  "dcc.organization.read",
  "dcc.organization.write"
];
const envelope = (data, revision) => ({ data, revision, mutationId: randomUUID() });
const edge = (fromId, toId, relation = "related", extra = {}) => ({
  id: randomUUID(),
  mutationId: randomUUID(),
  revision: 0,
  fromId,
  toId,
  relation,
  ...extra
});

test("Research schemas reject unsafe sources, malformed money, revisions and unknown fields", () => {
  assert.throws(() => W.parse(W.overview.partial(), { productUrl: "javascript:alert(1)" }));
  assert.throws(() => W.parse(W.overview.partial(), { receipt: "https://user:pass@example.test/receipt" }));
  assert.throws(() => W.parse(W.overview.partial(), { price: "NaN" }));
  assert.throws(() => W.parse(W.overview.partial(), { quantity: 0 }));
  assert.throws(() => W.parse(W.overview.partial(), { madeUp: true }));
  assert.equal(mcp.scopeFor("dcc_create_research"), "dcc.research.write");
  assert.equal(mcp.scopeFor("dcc_read_research"), "dcc.research.read");
  assert.equal(require("./lib/chat-permissions").defaults()[0], "dcc.tasks.read");
  for (const tool of mcp.tools) assert.equal(tool.inputSchema.additionalProperties, false);
});

test(
  "Embroidery acceptance: persistent reusable research, product lifecycle, explicit canonical work and intact Wishlists",
  { skip: !configured },
  async (t) => {
    const ctx = await fixture();
    t.after(() => ctx.close());
    const store = createStore(ctx);
    const make = (kind, title) => store.create(actor, { id: randomUUID(), kind, title });
    const idea = await make("idea", "Embroidered Apparel Business");
    assert.ok(idea.id);
    assert.equal(idea.lifecycle, "Captured");
    assert.equal((await store.create(actor, { id: idea.id, kind: "idea", title: idea.title })).duplicate, true);
    await assert.rejects(store.create(actor, { id: idea.id, kind: "idea", title: "Changed retry" }), {
      statusCode: 409
    });
    await store.save(
      actor,
      idea.id,
      envelope(
        {
          description:
            "Explore selling small batches of embroidered jackets alongside Fae's Renaissance fair merchandise.",
          category: "Business",
          tags: ["Fae", "Apparel"],
          reviewOn: "2027-01-01"
        },
        idea.revision
      )
    );
    const research = [];
    for (const title of [
      "Embroidery machine comparisons",
      "Anime licensing and intellectual property",
      "Blank jacket sourcing",
      "Startup costs and profitability",
      "Renaissance fair vendor requirements"
    ]) {
      const r = await make("research", title);
      research.push(r);
      await store.link(actor, edge(idea.id, r.id, "research"));
    }
    const second = await make("idea", "Another apparel concept");
    await store.link(actor, edge(second.id, research[0].id, "research"));
    const requirements = [];
    for (const title of [
      "Embroidery machine",
      "Blank jackets",
      "Embroidery thread",
      "Stabilizers",
      "Hoops and accessories"
    ]) {
      const r = await make("requirement", title);
      requirements.push(r);
      await store.link(
        actor,
        edge(idea.id, r.id, "requires", { data: { quantity: 2, estimatedUnitCost: "25", currency: "USD" } })
      );
    }
    const products = [];
    for (const title of ["Synthetic fixture machine A", "Synthetic fixture machine B", "Synthetic fixture machine C"]) {
      const r = await make("product", title);
      products.push(r);
      await store.link(actor, edge(requirements[0].id, r.id, "candidate"));
    }
    await store.link(actor, edge(requirements[1].id, products[0].id, "candidate"));
    const product = products[0];
    await store.save(
      actor,
      product.id,
      envelope(
        {
          manufacturer: "Fixture maker",
          price: "123.45",
          currency: "USD",
          priceObservedOn: "2026-01-01",
          specifications: "Fixture only: 4 hoops",
          pros: "Test comparison",
          cons: "Unverified claim",
          productUrl: "https://example.test/fixture"
        },
        product.revision
      )
    );
    const question = {
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      data: { entryType: "Question", title: "What hoop size is needed?", source: "User question" }
    };
    await store.entry(actor, research[0].id, question);
    assert.equal((await store.entry(actor, research[0].id, question)).duplicate, true);
    const finding = {
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      data: {
        entryType: "Evidence",
        title: "Synthetic measurement only",
        notes: "Not actual product research",
        url: "https://example.test/fixture",
        checkedOn: "2026-01-02",
        source: "Test fixture"
      }
    };
    await store.entry(actor, research[0].id, finding);
    await assert.rejects(
      store.entry(actor, research[0].id, {
        ...finding,
        mutationId: randomUUID(),
        revision: 1,
        data: { notes: "Overwrite original evidence" }
      }),
      { statusCode: 409 }
    );
    await store.entry(actor, research[0].id, {
      id: question.id,
      mutationId: randomUUID(),
      revision: 1,
      data: { state: "Resolved" }
    });
    assert.equal((await store.activity(actor, { questions: true })).entries.length, 0);
    const decision = {
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      data: { entryType: "Decision", title: "Revisit after measurement", supersedesId: finding.id }
    };
    await store.entry(actor, research[0].id, decision);
    const linked = await createStore(ctx).get(actor, idea.id);
    assert.equal(linked.links.filter((e) => e.relation === "research").length, 5);
    assert.equal(linked.links.filter((e) => e.relation === "requires").length, 5);
    assert.equal((await store.get(actor, research[0].id)).links.filter((e) => e.record.kind === "idea").length, 2);
    assert.equal((await store.get(actor, product.id)).links.filter((e) => e.relation === "candidate").length, 2);
    assert.equal(linked.links.find((e) => e.relation === "requires").details.quantity, 2);
    assert.equal(
      (await ctx.pool.query("SELECT count(*)::int AS n FROM blocks WHERE type<>'wishlist_attachment'")).rows[0].n,
      0
    );
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM work_rotations")).rows[0].n, 0);
    const action = { id: randomUUID(), mutationId: randomUUID(), action: "purchase-task" };
    await assert.rejects(store.action(actor, product.id, action), { statusCode: 409 });
    let p = await store.get(actor, product.id);
    await store.save(actor, p.id, envelope({ purchaseStatus: "Selected" }, p.revision));
    const task = await store.action(actor, product.id, action);
    assert.equal((await store.action(actor, product.id, action)).id, task.id);
    assert.equal((await ctx.blockDB.getBlock(task.id)).date, null);
    await assert.rejects(store.action(actor, product.id, { ...action, id: randomUUID(), mutationId: randomUUID() }), {
      statusCode: 409
    });
    assert.equal((await store.forBlock(actor, task.id)).links[0].record.id, product.id);
    for (const status of ["To Buy", "Ordered", "Owned"]) {
      p = await store.get(actor, product.id);
      await store.save(
        actor,
        p.id,
        envelope(
          {
            purchaseStatus: status,
            ...(status === "Owned"
              ? { purchasePrice: "120", purchasedOn: "2026-11-19", purchaseVendor: "Fixture seller" }
              : {})
          },
          p.revision
        )
      );
    }
    p = await createStore(ctx).get(actor, product.id);
    assert.equal(p.purchaseStatus, "Owned");
    assert.equal(p.price, "123.45");
    assert.equal(p.purchasePrice, "120");
    assert.equal(p.priceObservedOn, "2026-01-01");
    const project = await store.action(actor, idea.id, {
      id: randomUUID(),
      mutationId: randomUUID(),
      action: "project"
    });
    assert.equal((await ctx.blockDB.getBlock(project.id)).properties.kind, "project");
    assert.equal((await store.get(actor, idea.id)).lifecycle, "Active Project");
    assert.equal((await store.forBlock(actor, project.id)).links[0].record.id, idea.id);
    await ctx.blockDB.deleteBlock(project.id);
    const replacement = await store.action(actor, idea.id, {
      id: randomUUID(),
      mutationId: randomUUID(),
      action: "project"
    });
    assert.notEqual(replacement.id, project.id);
    assert.equal((await store.get(actor, idea.id)).links.filter((e) => e.relation === "project").length, 1);
    const history = await store.activity(actor, { id: product.id });
    assert.ok(history.entries.some((h) => h.data.purchaseStatus === "Selected"));
    assert.ok(history.entries.some((h) => h.data.price === "123.45"));
    assert.ok(history.entries.some((h) => h.data.purchaseStatus === "Owned"));
    const snapshot = await store.get(actor, idea.id);
    await store.save(actor, idea.id, envelope({ archived: true }, snapshot.revision));
    assert.equal((await store.search(actor, { kind: "idea", archived: true })).records.length, 1);
    let archived = await store.get(actor, idea.id);
    await store.save(actor, idea.id, envelope({ archived: false }, archived.revision));
    assert.equal((await store.get(actor, idea.id)).links.length, 11);
    assert.equal(
      (await store.search(actor, { tag: "Apparel", category: "Business", kind: "idea" })).records[0].id,
      idea.id
    );
    assert.equal((await store.search(actor, { status: [] })).records.length, 0);
    assert.equal((await store.search(actor, { query: "Synthetic measurement" })).records[0].id, research[0].id);
    const page = await store.search(actor, { limit: 2 });
    assert.equal(page.records.length, 2);
    assert.equal(page.nextOffset, 2);
    const next = await store.search(actor, { limit: 2, offset: page.nextOffset });
    assert.ok(!page.records.some((a) => next.records.some((b) => a.id === b.id)));
    assert.equal(
      (await store.search(actor, { purchases: true })).records.find((r) => r.id === product.id).purchaseStatus,
      "Owned"
    );
    await ctx.pool.query("UPDATE wishlists SET updated_at='2026-01-01' WHERE id=$1", [second.id]);
    assert.equal((await store.search(actor, { kind: "idea", dormantBefore: "2026-08-01" })).records[0].id, second.id);
    const legacy = require("./wishlist-store").createStore(ctx);
    const old = await legacy.create(actor, { id: randomUUID(), title: "Original Wishlist" });
    await assert.rejects(store.create(actor, { id: old.id, kind: "idea", title: old.title }), { statusCode: 409 });
    assert.equal((await store.get(actor, old.id)).kind, "wishlist");
    assert.deepEqual(
      (await legacy.list(actor)).filter((r) => r.id === old.id).map((r) => r.title),
      ["Original Wishlist"]
    );
    assert.ok(!(await legacy.list(actor)).some((r) => r.id === idea.id));
    const baseline = (await ctx.pool.query("SELECT id,data FROM wishlists ORDER BY id")).rows;
    await ctx.pool.query(require("./research-schema").SCHEMA_SQL);
    await ctx.pool.query(require("./research-schema").SCHEMA_SQL);
    assert.deepEqual((await ctx.pool.query("SELECT id,data FROM wishlists ORDER BY id")).rows, baseline);
  }
);

test(
  "Research ownership, relationship integrity, concurrency, mutation binding and transaction rollback",
  { skip: !configured },
  async (t) => {
    const ctx = await fixture();
    t.after(() => ctx.close());
    const s = createStore(ctx);
    const a = await s.create(actor, { id: randomUUID(), kind: "idea", title: "Owner one" });
    const b = await s.create(other, { id: randomUUID(), kind: "research", title: "Owner two" });
    await assert.rejects(s.get(other, a.id), { statusCode: 404 });
    await assert.rejects(s.get({ userId: 3, workspaceId: "ws-1" }, a.id), { statusCode: 404 });
    await assert.rejects(
      s.create({ userId: 3, workspaceId: "ws-1" }, { id: randomUUID(), kind: "idea", title: "Viewer write" }),
      { statusCode: 404 }
    );
    await assert.rejects(s.link(actor, edge(a.id, b.id)), { statusCode: 404 });
    await assert.rejects(
      ctx.pool.query("INSERT INTO research_links(id,from_id,to_id,relation) VALUES($1,$2,$3,'related')", [
        randomUUID(),
        a.id,
        b.id
      ]),
      { code: "23514" }
    );
    await assert.rejects(s.link(actor, edge(a.id, a.id)), { statusCode: 400 });
    await assert.rejects(
      ctx.pool.query("INSERT INTO research_links(id,from_id,to_id,relation) VALUES($1,$2,$3,'related')", [
        randomUUID(),
        a.id,
        randomUUID()
      ]),
      /no rows|foreign key/i
    );
    const r = await s.create(actor, { id: randomUUID(), kind: "research", title: "Reusable" });
    const e = edge(a.id, r.id, "research");
    await s.link(actor, e);
    assert.equal((await s.link(actor, e)).duplicate, true);
    await assert.rejects(s.link(actor, { ...e, data: { notes: "Different retry" } }), { statusCode: 409 });
    await assert.rejects(s.link(actor, edge(r.id, a.id, "research")), { statusCode: 409 });
    await s.link(actor, { ...e, revision: 1, mutationId: randomUUID(), active: false });
    assert.equal((await s.get(actor, r.id)).links.length, 0);
    const relink = await s.link(actor, edge(a.id, r.id, "research"));
    assert.equal(relink.id, e.id);
    assert.equal(relink.revision, 3);
    assert.equal((await s.get(actor, r.id)).links.length, 1);
    const results = await Promise.allSettled([
      s.save(actor, a.id, envelope({ description: "One" }, a.revision)),
      s.save(actor, a.id, envelope({ description: "Two" }, a.revision))
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 409);
    const before = (await ctx.pool.query("SELECT count(*)::int AS n FROM blocks")).rows[0].n;
    const failing = createStore({
      ...ctx,
      pool: {
        async connect() {
          const q = await ctx.pool.connect();
          return {
            release: () => q.release(),
            query(sql, args) {
              if (sql.startsWith("INSERT INTO research_mutations")) throw new Error("Injected receipt failure");
              return q.query(sql, args);
            }
          };
        }
      }
    });
    const action = { id: randomUUID(), mutationId: randomUUID(), action: "task" };
    await assert.rejects(failing.action(actor, a.id, action), /receipt failure/);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM blocks")).rows[0].n, before);
    assert.equal(
      (await ctx.pool.query("SELECT count(*)::int AS n FROM research_links WHERE id=$1", [action.id])).rows[0].n,
      0
    );
    assert.ok((await s.action(actor, a.id, action)).id);
    const mcpActor = { ...actor, scopes };
    await assert.rejects(
      mcp.run(
        ctx,
        "dcc_create_research",
        { id: randomUUID(), kind: "idea", title: "Denied" },
        { ...actor, scopes: ["dcc.wishlist.write"] }
      ),
      { statusCode: 403 }
    );
    await assert.rejects(
      mcp.run(
        ctx,
        "dcc_research_action",
        { recordId: a.id, id: randomUUID(), mutationId: randomUUID(), action: "task" },
        { ...actor, scopes: ["dcc.research.write"] }
      ),
      { statusCode: 403 }
    );
    await assert.rejects(
      require("./lib/wishlist-mcp").run(
        ctx,
        "dcc_read_wishlist",
        { wishlistId: a.id },
        { ...actor, scopes: ["dcc.wishlist.read"] }
      ),
      { statusCode: 403 }
    );
    assert.equal((await mcp.run(ctx, "dcc_read_research", { id: r.id }, mcpActor)).title, "Reusable");
    const privateResult = await mcp.run(
      ctx,
      "dcc_create_research",
      { id: randomUUID(), kind: "idea", title: "Write only" },
      { ...actor, scopes: ["dcc.research.write"] }
    );
    assert.equal(privateResult.title, undefined);
    assert.ok(privateResult.id);
    const requirement = await s.create(actor, { id: randomUUID(), kind: "requirement", title: "Private requirement" });
    const legacyList = await require("./lib/wishlist-mcp").run(
      ctx,
      "dcc_read_wishlist",
      {},
      { ...actor, scopes: ["dcc.wishlist.read"] }
    );
    assert.equal(
      legacyList.wishlists.some((r) => r.id === requirement.id),
      false
    );
  }
);

test(
  "Research HTTP and OAuth MCP use identical records and reject cross-origin/unauthorized writes",
  { skip: !configured },
  async (t) => {
    const ctx = await fixture();
    t.after(() => ctx.close());
    await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
    const app = express();
    app.use(express.json());
    app.use(
      require("express-session")({ secret: "synthetic-research-test-session", resave: false, saveUninitialized: false })
    );
    app.post("/test-login", (req, res) => {
      req.session.userId = req.body.userId;
      req.session.workspaceId = "ws-" + req.body.userId;
      res.json({ ok: true });
    });
    app.use((req, _res, next) => {
      req.workspaceId = req.session.workspaceId;
      next();
    });
    const mounted = require("./routes/conversation")(app, ctx, {
      enabled: true,
      baseUrl: "https://dcc.example",
      clients: { fixture: { name: "Fixture", redirect_uris: ["https://example.test/callback"] } }
    });
    require("./routes/research")(app, ctx);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;
    const login = await fetch(base + "/test-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 1 })
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const call = (path, method = "GET", body, extra = {}) =>
      fetch(base + path, {
        method,
        headers: { cookie, "content-type": "application/json", "x-dcc-wishlist": "1", ...extra },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    assert.equal((await call("/api/research/search", "POST", {}, { cookie: "" })).status, 401);
    assert.equal((await call("/api/research/search", "POST", {}, { "x-dcc-research-owner": "2:ws-2" })).status, 401);
    assert.equal((await call("/api/research", "POST", {}, { origin: "https://evil.test" })).status, 403);
    const id = randomUUID();
    assert.equal((await call("/api/research", "POST", { id, kind: "idea", title: "Saved in UI" })).status, 200);
    const verifier = randomBytes(32).toString("base64url");
    const request = mounted.oauth.validateRequest({
      client_id: "fixture",
      response_type: "code",
      redirect_uri: "https://example.test/callback",
      scope: scopes.join(" "),
      state: "fixture-state",
      resource: "https://dcc.example/mcp/dcc",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url")
    });
    const redirect = new URL(await mounted.oauth.consent(request, actor));
    const tokens = await mounted.oauth.token({
      client_id: "fixture",
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: "https://example.test/callback",
      resource: "https://dcc.example/mcp/dcc"
    });
    const rpc = async (name, args = {}, method = "tools/call") => {
      const r = await call(
        "/mcp/dcc",
        "POST",
        { jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name, arguments: args } : {} },
        { authorization: "Bearer " + tokens.access_token, "x-workspace-id": "ws-2", "x-user-id": "2" }
      );
      return { status: r.status, body: await r.json() };
    };
    const listed = await rpc("", {}, "tools/list");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.result.tools.some((t) => t.name === "dcc_create_research"));
    assert.equal((await rpc("dcc_read_research", { id })).body.result.structuredContent.title, "Saved in UI");
    const record = (await call("/api/research/" + id)).status;
    assert.equal(record, 200);
    const detail = await (await call("/api/research/" + id)).json();
    const update = { id, ...envelope({ description: "Updated by MCP", tags: ["Continuity"] }, detail.revision) };
    assert.ok((await rpc("dcc_update_research", update)).body.result.structuredContent.revision);
    assert.equal((await (await call("/api/research/" + id)).json()).description, "Updated by MCP");
    assert.equal((await rpc("dcc_update_research", update)).body.result.structuredContent.duplicate, true);
    const created = await rpc("dcc_create_research", {
      id: randomUUID(),
      kind: "research",
      title: "Independent research"
    });
    const linkedId = created.body.result.structuredContent.id;
    const relation = edge(id, linkedId, "research");
    await rpc("dcc_link_research", relation);
    assert.equal((await (await call("/api/research/" + linkedId)).json()).links[0].record.id, id);
    const entry = {
      recordId: linkedId,
      id: randomUUID(),
      mutationId: randomUUID(),
      revision: 0,
      data: { entryType: "Question", title: "Still unanswered?" }
    };
    await rpc("dcc_append_research", entry);
    assert.equal(
      (await rpc("dcc_research_activity", { questions: true })).body.result.structuredContent.entries.length,
      1
    );
    await ctx.pool.query("UPDATE conversation_grants SET scopes=$1", [JSON.stringify(["dcc.research.read"])]);
    assert.ok(!(await rpc("", {}, "tools/list")).body.result.tools.some((t) => t.name === "dcc_update_research"));
    assert.equal((await rpc("dcc_create_research", { id: randomUUID(), kind: "idea", title: "Denied" })).status, 403);
    await ctx.pool.query("UPDATE conversation_grants SET scopes=$1", [JSON.stringify(["dcc.research.write"])]);
    assert.equal((await rpc("dcc_read_research", { id })).status, 403);
    assert.equal(
      (await rpc("dcc_research_action", { recordId: id, id: randomUUID(), mutationId: randomUUID(), action: "task" }))
        .body.result.isError,
      true
    );
  }
);
