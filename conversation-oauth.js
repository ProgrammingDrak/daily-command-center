// OAuth public clients: exact pre-registered redirect URIs, S256, resource-bound
// opaque tokens. No shared DCC admin token or caller-selected identity is accepted.
const crypto = require("node:crypto");
const M = require("./lib/conversation-model");
const SCOPES = ["dcc.read", "dcc.work", "dcc.correct", "dcc.complete"];
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_grants (
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 client_id TEXT NOT NULL,scopes JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS conversation_oauth_codes (
 hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES conversation_grants(id),redirect_uri TEXT NOT NULL,
 challenge TEXT NOT NULL,resource TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS conversation_oauth_tokens (
 hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES conversation_grants(id),kind TEXT NOT NULL,
 resource TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ
);
ALTER TABLE conversation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON conversation_grants,conversation_oauth_codes,conversation_oauth_tokens FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON conversation_grants,conversation_oauth_codes,conversation_oauth_tokens FROM %I',r);
 END LOOP;
END $privacy$;
`;
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const secret = () => crypto.randomBytes(32).toString("base64url");
function createOAuth({ pool, baseUrl, clients = {} }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("DCC_CONVERSATION_URL must be a public HTTPS origin");
  baseUrl = base.origin;
  const resource = baseUrl + "/mcp/dcc";
  for (const c of Object.values(clients)) {
    if (!c.name || !Array.isArray(c.redirect_uris) || !c.redirect_uris.length)
      throw new Error("OAuth client configuration needs a name and redirect URIs");
    for (const uri of c.redirect_uris) {
      const u = new URL(uri);
      if (u.protocol !== "https:" || u.hash || u.username || u.password)
        throw new Error("OAuth redirects must be exact HTTPS URIs");
    }
  }
  function validateRequest(b) {
    const c = clients[b.client_id];
    if (!c || !c.redirect_uris.includes(b.redirect_uri)) throw M.fail("Unregistered OAuth client or redirect");
    if (
      b.response_type !== "code" ||
      b.code_challenge_method !== "S256" ||
      !/^[-_A-Za-z0-9]{43}$/.test(b.code_challenge || "")
    )
      throw M.fail("Authorization code with PKCE S256 required");
    if (b.resource !== resource) throw M.fail("Invalid resource");
    M.text(b.state, "OAuth state", 2048);
    const scopes = String(b.scope || "")
      .split(" ")
      .filter(Boolean);
    if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw M.fail("Invalid scope");
    return {
      clientId: b.client_id,
      redirectUri: b.redirect_uri,
      challenge: b.code_challenge,
      state: b.state,
      scopes: [...new Set(scopes)],
      resource,
      clientName: c.name
    };
  }
  async function owner(q, o) {
    if (!o?.userId || !o.workspaceId) throw M.fail("Sign in required", 401);
    const r = await q.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'", [
      o.userId,
      o.workspaceId
    ]);
    if (!r.rows.length) throw M.fail("Workspace owner required", 403);
  }
  async function tx(fn) {
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      const r = await fn(q);
      await q.query("COMMIT");
      return r;
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  async function consent(request, o) {
    // Revalidate session-bound request, never trust hidden account or scope fields.
    const v = validateRequest({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.challenge,
      code_challenge_method: "S256",
      response_type: "code",
      state: request.state,
      scope: request.scopes.join(" "),
      resource: request.resource
    });
    return tx(async (q) => {
      await owner(q, o);
      const id = crypto.randomUUID(),
        code = secret();
      await q.query(
        "INSERT INTO conversation_grants(id,user_id,workspace_id,client_id,scopes) VALUES($1,$2,$3,$4,$5)",
        [id, o.userId, o.workspaceId, v.clientId, JSON.stringify(v.scopes)]
      );
      await q.query(
        "INSERT INTO conversation_oauth_codes(hash,grant_id,redirect_uri,challenge,resource,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '5 minutes')",
        [hash(code), id, v.redirectUri, v.challenge, resource]
      );
      const redirect = new URL(v.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", v.state);
      return redirect.href;
    });
  }
  async function mint(q, g) {
    const access = secret(),
      refresh = secret();
    for (const [token, kind, seconds] of [
      [access, "access", 3600],
      [refresh, "refresh", 30 * 86400]
    ])
      await q.query(
        "INSERT INTO conversation_oauth_tokens(hash,grant_id,kind,resource,expires_at) VALUES($1,$2,$3,$4,NOW()+$5*INTERVAL '1 second')",
        [hash(token), g.id, kind, resource, seconds]
      );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: g.scopes.join(" ")
    };
  }
  async function token(b) {
    if (!clients[b.client_id] || b.resource !== resource) throw M.fail("invalid_grant", 400);
    const result = await tx(async (q) => {
      if (b.grant_type === "authorization_code") {
        if (!/^[-._~A-Za-z0-9]{43,128}$/.test(b.code_verifier || "")) throw M.fail("invalid_grant");
        const r = await q.query(
          `SELECT c.*,g.id,g.user_id,g.workspace_id,g.client_id,g.scopes,g.revoked_at FROM conversation_oauth_codes c JOIN conversation_grants g ON g.id=c.grant_id WHERE c.hash=$1 FOR UPDATE OF c,g`,
          [hash(String(b.code || ""))]
        );
        const c = r.rows[0];
        if (
          !c ||
          c.used_at ||
          c.revoked_at ||
          new Date(c.expires_at) <= new Date() ||
          c.client_id !== b.client_id ||
          c.redirect_uri !== b.redirect_uri ||
          c.resource !== b.resource ||
          crypto.createHash("sha256").update(b.code_verifier).digest("base64url") !== c.challenge
        )
          throw M.fail("invalid_grant");
        await owner(q, { userId: c.user_id, workspaceId: c.workspace_id });
        await q.query("UPDATE conversation_oauth_codes SET used_at=NOW() WHERE hash=$1", [c.hash]);
        return mint(q, c);
      }
      if (b.grant_type === "refresh_token") {
        const r = await q.query(
          `SELECT t.*,g.id,g.user_id,g.workspace_id,g.client_id,g.scopes,g.revoked_at FROM conversation_oauth_tokens t JOIN conversation_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='refresh' FOR UPDATE OF t,g`,
          [hash(String(b.refresh_token || ""))]
        );
        const t = r.rows[0];
        if (t && t.used_at && t.client_id === b.client_id && t.resource === b.resource) {
          await q.query("UPDATE conversation_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1", [t.id]);
          return { reuse: true };
        }
        if (
          !t ||
          t.revoked_at ||
          new Date(t.expires_at) <= new Date() ||
          t.client_id !== b.client_id ||
          t.resource !== b.resource
        )
          throw M.fail("invalid_grant");
        if (b.scope && b.scope !== t.scopes.join(" ")) throw M.fail("invalid_scope");
        await owner(q, { userId: t.user_id, workspaceId: t.workspace_id });
        await q.query("UPDATE conversation_oauth_tokens SET used_at=NOW() WHERE hash=$1", [t.hash]);
        return mint(q, t);
      }
      throw M.fail("unsupported_grant_type");
    });
    if (result.reuse) throw M.fail("invalid_grant");
    return result;
  }
  async function verify(raw, scope) {
    if (typeof raw !== "string" || raw.length > 256) throw M.fail("Invalid access token", 401);
    const r = await pool.query(
      `SELECT g.*,t.resource FROM conversation_oauth_tokens t JOIN conversation_grants g ON g.id=t.grant_id
     JOIN workspace_members m ON m.user_id=g.user_id AND m.workspace_id=g.workspace_id AND m.role='owner'
     WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>NOW() AND t.used_at IS NULL AND g.revoked_at IS NULL`,
      [hash(raw)]
    );
    const g = r.rows[0];
    if (!g || g.resource !== resource) throw M.fail("Invalid access token", 401);
    if (scope && !g.scopes.includes(scope)) throw M.fail("Insufficient scope", 403);
    return { userId: g.user_id, workspaceId: g.workspace_id, grantId: g.id, scopes: g.scopes };
  }
  async function list(o) {
    await owner(pool, o);
    return (
      await pool.query(
        "SELECT id,client_id,scopes,created_at,revoked_at FROM conversation_grants WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC",
        [o.userId, o.workspaceId]
      )
    ).rows;
  }
  async function revoke(id, o) {
    await owner(pool, o);
    await pool.query(
      "UPDATE conversation_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND user_id=$2 AND workspace_id=$3",
      [id, o.userId, o.workspaceId]
    );
    return { ok: true };
  }
  return {
    resource,
    baseUrl,
    validateRequest,
    consent,
    token,
    verify,
    list,
    revoke,
    metadata: {
      issuer: baseUrl,
      authorization_endpoint: baseUrl + "/oauth/dcc/authorize",
      token_endpoint: baseUrl + "/oauth/dcc/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: SCOPES
    }
  };
}
module.exports = { createOAuth, SCHEMA_SQL, SCOPES };
