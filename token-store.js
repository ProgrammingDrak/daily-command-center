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

function createTokenStore(pool) {
  let ensured = null;
  function ensureTable() {
    if (!ensured) {
      ensured = pool.query(`CREATE TABLE IF NOT EXISTS service_tokens (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ
      )`).catch((e) => { ensured = null; throw e; });
    }
    return ensured;
  }

  return {
    hashToken,
    /** Create a token. Returns { id, name, scope, expiresAt, token } — token plaintext is shown only here. */
    async createToken({ name, scope = "all", ttlDays = null }) {
      if (!name || !String(name).trim()) { const e = new Error("name required"); e.statusCode = 400; throw e; }
      if (!["dcc", "sweep", "all"].includes(scope)) { const e = new Error("scope must be dcc, sweep, or all"); e.statusCode = 400; throw e; }
      await ensureTable();
      const token = TOKEN_PREFIX + crypto.randomBytes(24).toString("hex");
      const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null;
      const { rows: [row] } = await pool.query(
        "INSERT INTO service_tokens (name, token_hash, scope, expires_at) VALUES ($1,$2,$3,$4) RETURNING id, name, scope, created_at, expires_at",
        [String(name).trim(), hashToken(token), scope, expiresAt]
      );
      return { ...row, token };
    },
    /** True if `plain` matches an active (unrevoked, unexpired) token covering `scope`. */
    async verifyToken(plain, scope = "dcc") {
      if (!plain || typeof plain !== "string") return false;
      await ensureTable();
      const { rows: [row] } = await pool.query(
        `SELECT id, scope FROM service_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [hashToken(plain)]
      );
      if (!row) return false;
      if (row.scope !== "all" && row.scope !== scope) return false;
      pool.query("UPDATE service_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
      return true;
    },
    /** List tokens (never returns hashes or plaintext). */
    async listTokens() {
      await ensureTable();
      const { rows } = await pool.query(
        "SELECT id, name, scope, created_at, expires_at, revoked_at, last_used_at FROM service_tokens ORDER BY id"
      );
      return rows;
    },
    /** Revoke immediately. Returns true if a live token was revoked. */
    async revokeToken(id) {
      await ensureTable();
      const { rowCount } = await pool.query(
        "UPDATE service_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [Number(id)]
      );
      return rowCount > 0;
    },
  };
}

module.exports = createTokenStore(require("./pg-pool"));
module.exports.createTokenStore = createTokenStore;
module.exports.hashToken = hashToken;
