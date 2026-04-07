/**
 * pg-pool.js — Postgres connection pool (replaces better-sqlite3 getDB())
 *
 * Uses DATABASE_URL from environment. Works for:
 *   - Railway production (internal networking)
 *   - Local dev (Railway public TCP endpoint)
 *   - Claude skills (same connection string)
 */

const { Pool } = require("pg");

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

module.exports = pool;
