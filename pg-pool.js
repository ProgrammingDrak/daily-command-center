/**
 * pg-pool.js — Postgres connection pool (replaces better-sqlite3 getDB())
 *
 * Uses DATABASE_URL from environment. Works for:
 *   - Render production with a Supabase Postgres connection string
 *   - Local dev with any reachable Postgres endpoint
 *   - Claude/Codex skills using the same connection string
 */

const { Pool } = require("pg");

function getDatabaseConfigStatus() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return {
      configured: false,
      reason: "DATABASE_URL is not set",
    };
  }

  try {
    const url = new URL(raw);
    return {
      configured: true,
      host: url.hostname || null,
      database: url.pathname ? url.pathname.replace(/^\//, "") : null,
      ssl: !raw.includes("localhost"),
    };
  } catch {
    return {
      configured: false,
      reason: "DATABASE_URL is invalid",
    };
  }
}

function describeDatabaseError(err) {
  if (!err) return "Unknown database error";
  const status = getDatabaseConfigStatus();
  if (!status.configured) return status.reason;
  if (err.code) return err.code;
  return err.name || "DatabaseError";
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
});

pool.on("error", (err) => {
  console.error("[pg-pool] Unexpected error on idle client:", err.message);
});

pool.getConfigStatus = getDatabaseConfigStatus;
pool.describeError = describeDatabaseError;

module.exports = pool;
