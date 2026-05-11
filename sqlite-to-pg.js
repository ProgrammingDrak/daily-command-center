/**
 * sqlite-to-pg.js — One-time data migration from SQLite to Postgres
 *
 * Reads data/blocks.db (read-only) and inserts into Postgres.
 * Handles type conversions: JSON TEXT → JSONB, INTEGER → BOOLEAN, etc.
 * Idempotent: uses ON CONFLICT DO NOTHING to skip existing rows.
 *
 * Usage: node sqlite-to-pg.js
 * Requires: DATABASE_URL in .env
 */

require("dotenv/config");
const Database = require("better-sqlite3");
const path = require("path");
const pool = require("./pg-pool");

const DB_PATH = path.join(__dirname, "data", "blocks.db");

// Returns a JSON string safe for pg JSONB params (pg would mis-encode JS arrays as Postgres arrays)
function toJsonb(val) {
  if (val == null) return null;
  if (typeof val === "string") {
    // Try to parse and re-serialize to ensure valid JSON
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === "string") {
        // Double-encoded — parse once more
        try { return JSON.stringify(JSON.parse(parsed)); } catch { return JSON.stringify(parsed); }
      }
      return JSON.stringify(parsed);
    } catch { return null; }
  }
  try { return JSON.stringify(val); } catch { return null; }
}

async function migrateTable(sqliteDb, tableName, { columns, transform, conflictKey }) {
  const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();
  if (rows.length === 0) {
    console.log(`  [${tableName}] 0 rows — skipping`);
    return 0;
  }

  const batchSize = 200;
  const conflict = conflictKey ? ` ON CONFLICT (${conflictKey}) DO NOTHING` : "";
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map(transform);

    // Build one multi-row INSERT per batch: VALUES ($1,$2,...),($N+1,$N+2,...)
    const params = [];
    const rowPlaceholders = batch.map((row) => {
      const start = params.length + 1;
      columns.forEach((c) => params.push(row[c]));
      return `(${columns.map((_, j) => `$${start + j}`).join(", ")})`;
    });

    await pool.query(
      `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${rowPlaceholders.join(", ")}${conflict}`,
      params
    );
    inserted += batch.length;
  }

  console.log(`  [${tableName}] ${inserted}/${rows.length} rows migrated`);
  return inserted;
}

async function migrateStateTable(sqliteDb) {
  const table = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dcc_state', 'pa_state') ORDER BY CASE name WHEN 'dcc_state' THEN 0 ELSE 1 END LIMIT 1").get();
  if (!table) {
    console.log("  [dcc_state] No state table found in SQLite — skipping");
    return 0;
  }
  const sourceName = table.name;
  const rows = sqliteDb.prepare(`SELECT * FROM ${sourceName}`).all();
  if (rows.length === 0) {
    console.log(`  [${sourceName}] 0 rows — skipping`);
    return 0;
  }
  let inserted = 0;
  for (const row of rows) {
    await pool.query(
      `INSERT INTO dcc_state (date, state_json, user_id, workspace_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date, workspace_id) DO NOTHING`,
      [row.date, toJsonb(row.state_json) ?? "{}", row.user_id, row.workspace_id, row.updated_at]
    );
    inserted++;
  }
  console.log(`  [dcc_state] ${inserted}/${rows.length} rows migrated from ${sourceName}`);
  return inserted;
}

async function run() {
  console.log("[migrate] Opening SQLite:", DB_PATH);
  const sqliteDb = new Database(DB_PATH, { readonly: true });

  console.log("[migrate] Starting migration...\n");

  // 1. users
  await migrateTable(sqliteDb, "users", {
    columns: ["id", "username", "password_hash", "created_at", "updated_at"],
    transform: (r) => r,
    conflictKey: "id",
  });

  // 2. workspaces
  await migrateTable(sqliteDb, "workspaces", {
    columns: ["id", "name", "slug", "owner_id", "plan", "created_at", "updated_at"],
    transform: (r) => r,
    conflictKey: "id",
  });

  // 3. blocks
  await migrateTable(sqliteDb, "blocks", {
    columns: [
      "id", "type", "parent_id", "date", "properties", "sort_order",
      "created_at", "updated_at", "deleted_at", "user_id", "workspace_id",
    ],
    transform: (r) => ({
      ...r,
      properties: toJsonb(r.properties) ?? "{}",
    }),
    conflictKey: "id",
  });

  // 4. workspace_members
  await migrateTable(sqliteDb, "workspace_members", {
    columns: ["id", "workspace_id", "user_id", "role", "invited_by", "accepted_at", "created_at"],
    transform: (r) => r,
    conflictKey: "id",
  });

  // 5. page_shares
  try {
    await migrateTable(sqliteDb, "page_shares", {
      columns: ["id", "block_id", "token", "access_level", "created_by", "expires_at", "created_at"],
      transform: (r) => r,
      conflictKey: "id",
    });
  } catch (e) {
    if (e.message.includes("no such table")) {
      console.log("  [page_shares] Table does not exist in SQLite — skipping");
    } else throw e;
  }

  // 6. operations
  await migrateTable(sqliteDb, "operations", {
    columns: ["id", "block_id", "op_type", "before_data", "after_data", "timestamp", "batch_id"],
    transform: (r) => ({
      ...r,
      before_data: toJsonb(r.before_data),
      after_data: toJsonb(r.after_data),
    }),
    conflictKey: "id",
  });

  // 7. dcc_state
  await migrateStateTable(sqliteDb);

  // 8. gcal_tokens
  try {
    await migrateTable(sqliteDb, "gcal_tokens", {
      columns: ["user_id", "credentials", "tokens", "calendars", "updated_at"],
      transform: (r) => ({
        ...r,
        credentials: toJsonb(r.credentials),
        tokens: toJsonb(r.tokens),
        calendars: toJsonb(r.calendars),
      }),
      conflictKey: "user_id",
    });
  } catch (e) {
    if (e.message.includes("no such table")) {
      console.log("  [gcal_tokens] Table does not exist in SQLite — skipping");
    } else throw e;
  }

  // 9. gcal_events
  try {
    await migrateTable(sqliteDb, "gcal_events", {
      columns: [
        "gcal_event_id", "block_id", "calendar_id", "etag", "summary", "description",
        "location", "start_time", "end_time", "start_date", "end_date", "all_day",
        "status", "html_link", "hangout_link", "attendees_json", "conference_json",
        "organizer_json", "creator_json", "recurrence_json", "recurring_event_id",
        "visibility", "transparency", "ical_uid", "color_id", "reminders_json",
        "raw_json", "synced_at", "local_modified", "user_id",
      ],
      transform: (r) => ({
        ...r,
        all_day: !!r.all_day,
        local_modified: !!r.local_modified,
        attendees_json: toJsonb(r.attendees_json) ?? "[]",
        conference_json: toJsonb(r.conference_json),
        organizer_json: toJsonb(r.organizer_json),
        creator_json: toJsonb(r.creator_json),
        recurrence_json: toJsonb(r.recurrence_json),
        reminders_json: toJsonb(r.reminders_json),
        raw_json: toJsonb(r.raw_json),
      }),
      conflictKey: "gcal_event_id, calendar_id",
    });
  } catch (e) {
    if (e.message.includes("no such table")) {
      console.log("  [gcal_events] Table does not exist in SQLite — skipping");
    } else throw e;
  }

  // 10. gcal_sync_state
  try {
    await migrateTable(sqliteDb, "gcal_sync_state", {
      columns: ["calendar_id", "sync_token", "last_sync_at", "full_sync", "user_id"],
      transform: (r) => ({
        ...r,
        full_sync: !!r.full_sync,
      }),
      conflictKey: "calendar_id",
    });
  } catch (e) {
    if (e.message.includes("no such table")) {
      console.log("  [gcal_sync_state] Table does not exist in SQLite — skipping");
    } else throw e;
  }

  // 11. gcal_calendars
  try {
    await migrateTable(sqliteDb, "gcal_calendars", {
      columns: [
        "id", "summary", "description", "background_color", "foreground_color",
        "is_primary", "access_role", "selected", "updated_at", "user_id",
      ],
      transform: (r) => ({
        ...r,
        is_primary: !!r.is_primary,
        selected: !!r.selected,
      }),
      conflictKey: "id",
    });
  } catch (e) {
    if (e.message.includes("no such table")) {
      console.log("  [gcal_calendars] Table does not exist in SQLite — skipping");
    } else throw e;
  }

  // Reset sequences for SERIAL columns to max(id) + 1
  console.log("\n[migrate] Resetting SERIAL sequences...");
  const serialTables = [
    { table: "users", col: "id" },
    { table: "operations", col: "id" },
    { table: "workspace_members", col: "id" },
    { table: "page_shares", col: "id" },
  ];
  for (const { table, col } of serialTables) {
    try {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${table}', '${col}'), COALESCE(MAX(${col}), 0) + 1, false) FROM ${table}`
      );
      console.log(`  [${table}] sequence reset`);
    } catch (e) {
      console.log(`  [${table}] sequence reset skipped: ${e.message}`);
    }
  }

  sqliteDb.close();
  console.log("\n[migrate] Migration complete.");
  await pool.end();
}

run().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
