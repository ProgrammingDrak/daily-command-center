#!/usr/bin/env node

require("dotenv/config");

const { Pool } = require("pg");

function redactedTarget(raw) {
  try {
    const url = new URL(raw);
    const db = url.pathname ? url.pathname.replace(/^\//, "") : "";
    return `${url.protocol}//${url.hostname}${db ? `/${db}` : ""}`;
  } catch {
    return "invalid DATABASE_URL";
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[check-db] DATABASE_URL is missing.");
    console.error("[check-db] Set it in your shell or in a local .env file before starting Daily Command Center.");
    console.error("[check-db] Production already has it on Render; this check is for local startup.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    ssl: !databaseUrl.includes("localhost") ? { rejectUnauthorized: false } : false,
  });

  try {
    await pool.query("SELECT 1");
    console.log(`[check-db] Database reachable: ${redactedTarget(databaseUrl)}`);
  } catch (err) {
    console.error(`[check-db] Database connection failed: ${err.code || err.name || "DatabaseError"}`);
    console.error(`[check-db] Target: ${redactedTarget(databaseUrl)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[check-db] Unexpected failure: ${err.message}`);
  process.exit(1);
});
