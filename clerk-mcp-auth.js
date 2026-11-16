// Clerk is the issuer; DCC remains the authority for account/workspace access.
const crypto = require("node:crypto");
const M = require("./lib/conversation-model");
const P = require("./lib/chat-permissions");
const { createSecretBox } = require("./lib/secret-box");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_connections (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 scopes JSONB NOT NULL, scope_limit JSONB, pending_scopes JSONB, upgrade_after TIMESTAMPTZ, profile_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_verified_at TIMESTAMPTZ,
 authorized_after TIMESTAMPTZ, revoked_at TIMESTAMPTZ, revocation_pending BOOLEAN NOT NULL DEFAULT FALSE,
 UNIQUE(issuer,subject,client_id)
);
CREATE TABLE IF NOT EXISTS mcp_connection_tokens (
 token_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
 token_enc TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connection_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mcp_connections,mcp_connection_tokens FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON mcp_connections,mcp_connection_tokens FROM %I',r);
 END LOOP;
END $privacy$;`;
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
function httpsOrigin(value, label) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Error(`${label} must be an HTTPS origin`);
  return u.origin;
}
// Only provider-verified time of the original OAuth authorization can prove
// fresh consent. A refresh can issue an access token with a newer created_at.
function hasFreshConsent(token, after) {
  return Number.isFinite(token.authorization_granted_at) &&
    token.authorization_granted_at * 1000 > new Date(after).getTime();
}

function createClerkMcpAuth({
  pool,
  baseUrl,
  issuer,
  secretKey,
  encryptionKey,
  clientIds,
  fetch: request = globalThis.fetch
}) {
  baseUrl = httpsOrigin(baseUrl, "DCC_CONVERSATION_URL");
  issuer = httpsOrigin(issuer, "CLERK_MCP_ISSUER");
  if (!secretKey || !Array.isArray(clientIds) || !clientIds.length)
    throw new Error("Clerk MCP needs a secret key and an explicit client allowlist");
  const box = createSecretBox(encryptionKey, "MCP revocation");
  const resource = baseUrl + "/mcp/dcc";
  let metadata;
  async function api(path, body) {
    let response;
    try {
      response = await request("https://api.clerk.com/v1" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          "Clerk-API-Version": "2026-08-20"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw M.fail("Authorization provider temporarily unavailable", 503);
    }
    if (response.status === 404 || response.status === 401) throw M.fail("Invalid access token", 401);
    if (!response.ok) throw M.fail("Authorization provider temporarily unavailable", 503);
    return response.status === 204 ? null : response.json();
  }
  async function discovery() {
    if (metadata && metadata.until > Date.now()) return metadata.value;
    let data;
    try {
      const r = await request(issuer + "/.well-known/oauth-authorization-server", {
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error();
      data = await r.json();
    } catch {
      throw M.fail("Authorization provider temporarily unavailable", 503);
    }
    if (
      data.issuer !== issuer ||
      data.client_id_metadata_document_supported !== true ||
      !data.code_challenge_methods_supported?.includes("S256")
    )
      throw M.fail("Clerk MCP setup is incomplete", 503);
    for (const name of ["authorization_endpoint", "token_endpoint"]) {
      const u = new URL(data[name]);
      if (u.origin !== issuer || u.protocol !== "https:") throw M.fail("Invalid authorization metadata", 503);
    }
    metadata = { value: data, until: Date.now() + 300000 };
    return data;
  }
  async function owner(q, actor) {
    const r = await q.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'", [
      actor.userId,
      actor.workspaceId
    ]);
    if (!r.rows.length) throw M.fail("Workspace owner required", 403);
  }
  async function verify(raw, scope) {
    if (typeof raw !== "string" || !raw || raw.length > 4096 || raw.split(".").length === 3)
      throw M.fail("Opaque OAuth access token required", 401);
    const known = (
      await pool.query(
        "SELECT c.revoked_at FROM mcp_connection_tokens t JOIN mcp_connections c ON c.id=t.connection_id WHERE t.token_hash=$1",
        [hash(raw)]
      )
    ).rows[0];
    if (known?.revoked_at) throw M.fail("Connection disconnected", 401);
    const t = await api("/oauth_applications/access_tokens/verify", { access_token: raw });
    if (
      t?.object !== "clerk_idp_oauth_access_token" ||
      t.revoked ||
      t.expired ||
      !t.expiration ||
      t.expiration * 1000 <= Date.now() ||
      !Array.isArray(t.aud) ||
      !t.aud.includes(resource) ||
      !clientIds.includes(t.client_id) ||
      !t.subject ||
      !Array.isArray(t.scopes)
    )
      throw M.fail("Invalid access token", 401);
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `mcp:${issuer}:${t.subject}:${t.client_id}`
      ]);
      const user = (await q.query("SELECT id FROM users WHERE external_id=$1", [t.subject])).rows;
      if (user.length !== 1) throw M.fail("Sign in to DCC to link this account before connecting", 403);
      let c = (
        await q.query("SELECT * FROM mcp_connections WHERE issuer=$1 AND subject=$2 AND client_id=$3 FOR UPDATE", [
          issuer,
          t.subject,
          t.client_id
        ])
      ).rows[0];
      if (c?.authorized_after && !hasFreshConsent(t, c.authorized_after))
        throw M.fail("Use a newly authorized connection", 401);
      if (c?.revoked_at) throw M.fail("Connection disconnected. Reconnect from DCC Connections.", 401);
      if (!c) {
        const owned = (
          await q.query(
            "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id",
            [user[0].id]
          )
        ).rows;
        if (owned.length !== 1) throw M.fail("Select your workspace in DCC Connections before connecting", 409);
        const id = crypto.randomUUID();
        const chosen =
          (
            await q.query("SELECT scopes FROM conversation_preferences WHERE user_id=$1 AND workspace_id=$2", [
              user[0].id,
              owned[0].workspace_id
            ])
          ).rows[0]?.scopes ?? P.defaults();
        c = (
          await q.query(
            "INSERT INTO mcp_connections(id,issuer,subject,client_id,user_id,workspace_id,scopes,profile_id,scope_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              id,
              issuer,
              t.subject,
              t.client_id,
              user[0].id,
              owned[0].workspace_id,
              JSON.stringify(t.scopes.filter((s) => P.scopes.includes(s))),
              "dcc-profile-" + hash(JSON.stringify([issuer, t.subject, owned[0].workspace_id])),
              JSON.stringify(chosen)
            ]
          )
        ).rows[0];
      }
      if (c.user_id !== user[0].id) throw M.fail("Account binding changed", 403);
      await owner(q, { userId: c.user_id, workspaceId: c.workspace_id });
      if (
        c.pending_scopes &&
        hasFreshConsent(t, c.upgrade_after) &&
        c.pending_scopes.every((s) => t.scopes.includes(s))
      ) {
        c.scope_limit = c.pending_scopes;
        await q.query(
          "UPDATE mcp_connections SET scope_limit=pending_scopes,authorized_after=upgrade_after,pending_scopes=NULL,upgrade_after=NULL WHERE id=$1",
          [c.id]
        );
      }
      const scopes = t.scopes.filter((s) => P.scopes.includes(s) && (c.scope_limit ?? P.defaults()).includes(s));
      if (scope && !(Array.isArray(scope) ? scope : [scope]).some((s) => scopes.includes(s)))
        throw M.fail("Insufficient scope", 403);
      await q.query("UPDATE mcp_connections SET scopes=$1 WHERE id=$2", [JSON.stringify(scopes), c.id]);
      await q.query(
        "INSERT INTO mcp_connection_tokens(token_hash,connection_id,token_enc) VALUES($1,$2,$3) ON CONFLICT(token_hash) DO NOTHING",
        [hash(raw), c.id, box.seal(raw)]
      );
      await q.query("COMMIT");
      return {
        userId: c.user_id,
        workspaceId: c.workspace_id,
        grantId: c.id,
        profileId: c.profile_id,
        scopes,
        requestedScopes: c.pending_scopes ?? c.scope_limit ?? P.defaults(),
        provider: "clerk"
      };
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  async function list(actor) {
    await owner(pool, actor);
    const connections = (
      await pool.query(
        "SELECT id,client_id,scopes,created_at,revoked_at,last_verified_at,revocation_pending FROM mcp_connections WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC",
        [actor.userId, actor.workspaceId]
      )
    ).rows;
    for (const c of connections) {
      c.connection_state = c.revoked_at
        ? "disconnected"
        : !c.scopes.length
          ? "not_connected"
          : c.last_verified_at
            ? "verified"
            : "authorized";
      if (!c.revoked_at && c.scopes.length) {
        try {
          await revalidate(c.id, actor);
        } catch (e) {
          c.connection_state =
            e.publicCode === "awaiting_refresh"
              ? "authorized"
              : e.statusCode === 503
                ? "temporarily_unavailable"
                : "reconnect_required";
        }
      }
    }
    return connections;
  }
  async function revalidate(id, actor, q = pool) {
    const c = (
      await q.query("SELECT * FROM mcp_connections WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE", [
        id,
        actor.userId,
        actor.workspaceId
      ])
    ).rows[0];
    if (!c || c.revoked_at) throw M.fail("Connection disconnected", 401);
    await owner(q, actor);
    const tokens = (
      await q.query(
        "SELECT token_enc FROM mcp_connection_tokens WHERE connection_id=$1 AND token_enc IS NOT NULL ORDER BY created_at DESC",
        [id]
      )
    ).rows;
    let awaitingRefresh = false;
    for (const row of tokens) {
      let t;
      try {
        t = await api("/oauth_applications/access_tokens/verify", { access_token: box.open(row.token_enc) });
      } catch (e) {
        if (e.statusCode === 401) continue;
        throw e;
      }
      if (
        t?.object === "clerk_idp_oauth_access_token" &&
        !t.revoked &&
        (t.expired || t.expiration * 1000 <= Date.now())
      )
        awaitingRefresh = true;
      if (
        t?.object === "clerk_idp_oauth_access_token" &&
        !t.revoked &&
        (!c.authorized_after || hasFreshConsent(t, c.authorized_after)) &&
        !t.expired &&
        t.expiration * 1000 > Date.now() &&
        (Array.isArray(t.aud) && t.aud.includes(resource)) &&
        t.subject === c.subject &&
        t.client_id === c.client_id
      ) {
        return {
          ...actor,
          grantId: id,
          provider: "clerk",
          scopes: t.scopes.filter((s) => P.scopes.includes(s) && (c.scope_limit ?? P.defaults()).includes(s))
        };
      }
    }
    if (awaitingRefresh) {
      const e = M.fail("Open DCC in ChatGPT to renew access before approving this change", 409);
      e.publicCode = "awaiting_refresh";
      throw e;
    }
    throw M.fail("Reconnect required before approving this change", 401);
  }
  async function revoke(id, actor) {
    await owner(pool, actor);
    const c = (
      await pool.query(
        "UPDATE mcp_connections SET revocation_pending=(revoked_at IS NULL OR revocation_pending),revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND user_id=$2 AND workspace_id=$3 RETURNING *",
        [id, actor.userId, actor.workspaceId]
      )
    ).rows[0];
    if (!c) throw M.fail("Connection not found", 404);
    if (!c.revocation_pending) return { ok: true, revocationPending: false };
    const tokens = (
      await pool.query("SELECT token_enc FROM mcp_connection_tokens WHERE connection_id=$1 AND token_enc IS NOT NULL", [
        id
      ])
    ).rows;
    try {
      let app;
      for (let offset = 0; offset < 10000 && !app; offset += 100) {
        const clients = await api("/oauth_applications?limit=100&offset=" + offset);
        app = (clients.data || []).find((a) => a.client_id === c.client_id);
        if ((clients.data || []).length < 100) break;
      }
      if (!app || !tokens.length) throw M.fail("Provider revocation pending", 503);
      for (const token of tokens) {
        const raw = box.open(token.token_enc);
        const state = await api("/oauth_applications/access_tokens/verify", { access_token: raw });
        if (state?.revoked) continue;
        if (state?.object !== "clerk_idp_oauth_access_token" || state.subject !== c.subject ||
            state.client_id !== c.client_id || !Array.isArray(state.aud) || !state.aud.includes(resource))
          throw M.fail("Provider revocation pending", 503);
        await api(`/oauth_applications/${encodeURIComponent(app.id)}/revoke_token`, { token: raw });
      }
      await pool.query(
        `WITH disconnected AS (
          UPDATE mcp_connections SET revocation_pending=FALSE
          WHERE id=$1 AND revoked_at=$2 AND revocation_pending RETURNING id
        )
        UPDATE mcp_connection_tokens SET token_enc=NULL WHERE connection_id IN (SELECT id FROM disconnected)`,
        [id, c.revoked_at]
      );
      return { ok: true, revocationPending: false };
    } catch {
      return { ok: true, revocationPending: true };
    }
  }
  async function reduce(id, scopes, actor) {
    await owner(pool, actor);
    const result = await pool.query(
      `UPDATE mcp_connections SET scope_limit=$1,scopes=$1,pending_scopes=NULL,upgrade_after=NULL
       WHERE id=$2 AND user_id=$3 AND workspace_id=$4 AND revoked_at IS NULL AND scopes @> $1::jsonb
       RETURNING id`,
      [JSON.stringify(scopes), id, actor.userId, actor.workspaceId]
    );
    if (!result.rows.length) throw M.fail("Connection changed or additional access requires new authorization", 409);
    return { ok: true };
  }
  async function requestUpgrade(id, scopes, actor) {
    await owner(pool, actor);
    if (!Array.isArray(scopes) || scopes.some((s) => !P.scopes.includes(s))) throw M.fail("Invalid scope");
    const result = await pool.query(
      "UPDATE mcp_connections SET pending_scopes=$1,upgrade_after=NOW(),scope_limit=(SELECT COALESCE(jsonb_agg(scope), '[]'::jsonb) FROM jsonb_array_elements_text(scopes) AS scope WHERE $1::jsonb ? scope),scopes=(SELECT COALESCE(jsonb_agg(scope), '[]'::jsonb) FROM jsonb_array_elements_text(scopes) AS scope WHERE $1::jsonb ? scope) WHERE id=$2 AND user_id=$3 AND workspace_id=$4 AND revoked_at IS NULL RETURNING id",
      [JSON.stringify(scopes), id, actor.userId, actor.workspaceId]
    );
    if (!result.rows.length) throw M.fail("Connection not found", 404);
    return { ok: true };
  }
  async function verified(id) {
    await pool.query("UPDATE mcp_connections SET last_verified_at=NOW() WHERE id=$1 AND revoked_at IS NULL", [id]);
  }
  async function bind(clientId, actor) {
    await owner(pool, actor);
    if (!clientIds.includes(clientId)) throw M.fail("Unsupported client", 400);
    const user = (await pool.query("SELECT external_id FROM users WHERE id=$1", [actor.userId])).rows[0];
    if (!user?.external_id) throw M.fail("Sign in with Clerk before connecting", 409);
    const existing = (
      await pool.query("SELECT * FROM mcp_connections WHERE issuer=$1 AND subject=$2 AND client_id=$3", [
        issuer,
        user.external_id,
        clientId
      ])
    ).rows[0];
    if (existing) {
      if (existing.workspace_id === actor.workspaceId) return { ok: true };
      if (!existing.revoked_at || existing.revocation_pending)
        throw M.fail("Disconnect the existing workspace before rebinding", 409);
      await pool.query(
        "UPDATE mcp_connections SET workspace_id=$1,profile_id=$2,revoked_at=NULL,authorized_after=NOW(),scopes='[]',scope_limit=(SELECT scopes FROM conversation_preferences WHERE user_id=$4 AND workspace_id=$1),pending_scopes=NULL,upgrade_after=NULL,last_verified_at=NULL WHERE id=$3 AND revoked_at IS NOT NULL AND revocation_pending=FALSE",
        [
          actor.workspaceId,
          "dcc-profile-" + hash(JSON.stringify([issuer, user.external_id, actor.workspaceId])),
          existing.id,
          actor.userId
        ]
      );
      return { ok: true };
    }
    const chosen =
      (
        await pool.query("SELECT scopes FROM conversation_preferences WHERE user_id=$1 AND workspace_id=$2", [
          actor.userId,
          actor.workspaceId
        ])
      ).rows[0]?.scopes ?? P.defaults();
    await pool.query(
      "INSERT INTO mcp_connections(id,issuer,subject,client_id,user_id,workspace_id,scopes,profile_id,scope_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        crypto.randomUUID(),
        issuer,
        user.external_id,
        clientId,
        actor.userId,
        actor.workspaceId,
        "[]",
        "dcc-profile-" + hash(JSON.stringify([issuer, user.external_id, actor.workspaceId])),
        JSON.stringify(chosen)
      ]
    );
    return { ok: true };
  }
  async function reconnect(id, actor) {
    await owner(pool, actor);
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      const c = (
        await q.query("SELECT * FROM mcp_connections WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE", [
          id,
          actor.userId,
          actor.workspaceId
        ])
      ).rows[0];
      if (!c || !c.revoked_at) throw M.fail("Disconnect before reconnecting", 409);
      if (c.revocation_pending) throw M.fail("Retry disconnect to finish provider revocation before reconnecting", 409);
      await q.query(
        "UPDATE mcp_connections SET revoked_at=NULL,authorized_after=NOW(),pending_scopes=NULL,upgrade_after=NULL,scopes='[]',last_verified_at=NULL WHERE id=$1",
        [id]
      );
      await q.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  return {
    provider: "clerk",
    baseUrl,
    issuer,
    resource,
    verify,
    list,
    revalidate,
    revoke,
    reduce,
    verified,
    discovery,
    clientIds,
    bind,
    reconnect,
    requestUpgrade
  };
}
module.exports = { createClerkMcpAuth, SCHEMA_SQL };
