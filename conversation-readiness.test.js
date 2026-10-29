const test = require("node:test");
const assert = require("node:assert/strict");
const { checkConversationReadiness } = require("./scripts/check-conversation-readiness");
const base = "https://dcc.example";
test("disabled remote routes return explicit 503 without OAuth, session, or database access", () => {
  const registrations = [];
  const app = { all: (paths, handler) => registrations.push({ paths, handler }) };
  const ctx = {
    get pool() {
      throw new Error("Database must not be accessed");
    }
  };
  assert.equal(require("./routes/conversation")(app, ctx, { enabled: false }), null);
  const [{ paths, handler }] = registrations;
  for (const path of [
    "/mcp/dcc",
    "/oauth/dcc/token",
    "/.well-known/oauth-protected-resource/mcp/dcc",
    "/.well-known/oauth-authorization-server"
  ])
    assert.ok(paths.includes(path));
  let status, body;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    set(name, value) {
      assert.equal(name, "Cache-Control");
      assert.equal(value, "no-store");
      return this;
    },
    json(value) {
      body = value;
    }
  };
  handler({}, res);
  assert.equal(status, 503);
  assert.equal(body.error, "conversation_remote_disabled");
  assert.ok(!JSON.stringify(body).includes("client_id"));
});
function protocol({ redirect = false, disabled = false, wrongAudience = false, authenticated = false } = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, undefined);
    let status = 200,
      json;
    if (url.endsWith("/api/health")) json = { status: "ok", revision: "a".repeat(40) };
    else if (redirect) return new Response("", { status: 302, headers: { location: base + "/login" } });
    else if (disabled) {
      status = 503;
      json = { error: "conversation_remote_disabled" };
    } else if (url.includes("oauth-protected-resource"))
      json = {
        resource: wrongAudience ? "https://other.example/mcp" : base + "/mcp/dcc",
        authorization_servers: [base]
      };
    else if (url.includes("oauth-authorization-server"))
      json = {
        issuer: base,
        authorization_endpoint: base + "/oauth/dcc/authorize",
        token_endpoint: base + "/oauth/dcc/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      };
    else
      return new Response("{}", {
        status: authenticated ? 200 : 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/dcc"`
        }
      });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
}
test("readiness rejects login redirects, disabled surface, wrong resource and unauthenticated access", async () => {
  for (const fixture of [{ redirect: true }, { disabled: true }, { wrongAudience: true }, { authenticated: true }]) {
    const result = await checkConversationReadiness(base, { fetchImpl: protocol(fixture) });
    assert.equal(result.status, "setup_required");
  }
});
test("healthy protocol ingress does not claim account or lifecycle connection", async () => {
  const result = await checkConversationReadiness(base, { fetchImpl: protocol() });
  assert.equal(result.status, "ingress_ready");
  assert.equal(result.accountConnection, "not_verified");
  assert.equal(result.assistantLifecycleHook, "not_verified");
  await assert.rejects(checkConversationReadiness("https://user:secret@dcc.example", { fetchImpl: protocol() }));
});
