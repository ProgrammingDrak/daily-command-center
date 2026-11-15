/**
 * token-store.js — Postgres-backed service tokens with rotation/revocation.
 *
 * Replaces the single static SECRET_DCC_TOKEN env var as the primary auth for
 * service endpoints (the env vars still work as a fallback — see server.js).
 * Tokens are stored as SHA-256 hashes; the plaintext is shown exactly once at
 * creation. Each token has a scope ("dcc", "sweep", or "all"), an optional
 * expiry, and can be revoked instantly via the admin API — no redeploy needed.
 *
 * Table is created lazily on first use so pg-schema.js (and the deploy
 * DB-risk guardrail) is untouched.
 */
const crypto = require("crypto");

const TOKEN_PREFIX = "dcc_";

function hashToken(plain) {
  return crypto.createHash("sha256").update(String(plain), "utf8").digest("hex");
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS service_tokens (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        user_id INTEGER REFERENCES users(id), workspace_id TEXT REFERENCES workspaces(id), actions JSONB
      );
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id);
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS actions JSONB;
      ALTER TABLE service_tokens ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON service_tokens FROM PUBLIC;
      DO $service_privacy$ DECLARE r TEXT; BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
          EXECUTE format('REVOKE ALL ON service_tokens FROM %I',r);
        END LOOP;
      END $service_privacy$;`;

function createTokenStore(pool) {
  let ensured = null;
  function ensureTable() {
    if (!ensured) {
      ensured = pool.query(SCHEMA_SQL).catch((e) => {
        ensured = null;
        throw e;
      });
    }
    return ensured;
  }

  return {
    hashToken,
    /** Create a token. Returns { id, name, scope, expiresAt, token } — token plaintext is shown only here. */
    async createToken({ name, scope = "all", ttlDays = 30, userId, workspaceId, actions }) {
      if (!name || !String(name).trim()) {
        const e = new Error("name required");
        e.statusCode = 400;
        throw e;
      }
      if (!["dcc", "sweep", "all"].includes(scope)) {
        const e = new Error("scope must be dcc, sweep, or all");
        e.statusCode = 400;
        throw e;
      }
      if (
        !Number.isSafeInteger(userId) ||
        userId < 1 ||
        !workspaceId ||
        !Array.isArray(actions) ||
        !actions.length ||
        actions.some((a) => typeof a !== "string" || !/^(GET|POST|PATCH|DELETE) \/api\/[a-z0-9/_-]+$/.test(a))
      )
        throw Object.assign(new Error("Account, workspace and exact allowed actions required"), { statusCode: 400 });
      if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 30)
        throw Object.assign(new Error("ttlDays must be 1–30"), { statusCode: 400 });
      const membership = await pool.query(
        "SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'",
        [userId, workspaceId]
      );
      if (!membership.rows.length) throw Object.assign(new Error("Workspace owner required"), { statusCode: 403 });
      await ensureTable();
      const token = TOKEN_PREFIX + crypto.randomBytes(24).toString("hex");
      const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null;
      const {
        rows: [row]
      } = await pool.query(
        "INSERT INTO service_tokens (name, token_hash, scope, expires_at,user_id,workspace_id,actions) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, scope, created_at, expires_at",
        [String(name).trim(), hashToken(token), scope, expiresAt, userId, workspaceId, JSON.stringify(actions)]
      );
      return { ...row, token };
    },
    async authenticateToken(plain, scope, action) {
      if (!plain || typeof plain !== "string") return null;
      await ensureTable();
      const row = (
        await pool.query(
          "SELECT t.* FROM service_tokens t JOIN workspace_members m ON m.user_id=t.user_id AND m.workspace_id=t.workspace_id AND m.role='owner' WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>NOW()",
          [hashToken(plain)]
        )
      ).rows[0];
      if (
        !row ||
        !row.user_id ||
        !row.workspace_id ||
        !Array.isArray(row.actions) ||
        !row.actions.includes(action) ||
        (row.scope !== scope && row.scope !== "all")
      )
        return null;
      await pool.query("UPDATE service_tokens SET last_used_at=NOW() WHERE id=$1", [row.id]);
      return { userId: row.user_id, workspaceId: row.workspace_id, source: "service-token:" + row.id };
    },
    /** List tokens (never returns hashes or plaintext). */
    async listTokens() {
      await ensureTable();
      const { rows } = await pool.query(
        "SELECT id, name, scope, created_at, expires_at, revoked_at, last_used_at,user_id,workspace_id,actions FROM service_tokens ORDER BY id"
      );
      return rows;
    },
    /** Revoke immediately. Returns true if a live token was revoked. */
    async revokeToken(id) {
      await ensureTable();
      const { rowCount } = await pool.query(
        "UPDATE service_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        [Number(id)]
      );
      return rowCount > 0;
    }
  };
}

module.exports = createTokenStore(require("./pg-pool"));
module.exports.createTokenStore = createTokenStore;
module.exports.hashToken = hashToken;

module.exports.SCHEMA_SQL = SCHEMA_SQL;
