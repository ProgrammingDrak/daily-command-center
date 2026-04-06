/**
 * db.js — SQLite Block Database Layer
 *
 * Single source of truth for all user data in the Daily Command Center.
 * Uses better-sqlite3 for synchronous, ACID-compliant writes.
 *
 * Block model: every entity (task, note, action item, sticky note, etc.)
 * is a "block" with a type, parent, properties (JSON), and sort order.
 */

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "data", "blocks.db");

// ── Schema ──

function initDB() {
  const db = new Database(DB_PATH);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      parent_id   TEXT,
      date        TEXT,
      properties  TEXT NOT NULL DEFAULT '{}',
      sort_order  REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      FOREIGN KEY (parent_id) REFERENCES blocks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_type_date
      ON blocks(type, date) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_blocks_parent
      ON blocks(parent_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_blocks_date
      ON blocks(date) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS operations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id    TEXT NOT NULL,
      op_type     TEXT NOT NULL,
      before_data TEXT,
      after_data  TEXT,
      timestamp   TEXT NOT NULL,
      batch_id    TEXT
    );

    CREATE TABLE IF NOT EXISTS pa_state (
      date        TEXT PRIMARY KEY,
      state_json  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);

  // ── Workspace tables (Phase 1) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      owner_id   INTEGER NOT NULL REFERENCES users(id),
      plan       TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id      INTEGER NOT NULL REFERENCES users(id),
      role         TEXT NOT NULL DEFAULT 'viewer',
      invited_by   INTEGER REFERENCES users(id),
      accepted_at  TEXT,
      created_at   TEXT NOT NULL,
      UNIQUE(workspace_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS page_shares (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id     TEXT NOT NULL REFERENCES blocks(id),
      token        TEXT NOT NULL UNIQUE,
      access_level TEXT NOT NULL DEFAULT 'view',
      created_by   INTEGER REFERENCES users(id),
      expires_at   TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gcal_tokens (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id),
      credentials  TEXT NOT NULL,
      tokens       TEXT,
      calendars    TEXT,
      updated_at   TEXT NOT NULL
    );
  `);

  // Add user_id columns to existing tables (idempotent — fails silently if already present)
  try { db.exec("ALTER TABLE blocks ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}
  try { db.exec("ALTER TABLE pa_state ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}

  // Add workspace_id columns (Phase 1 — idempotent)
  try { db.exec("ALTER TABLE blocks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)"); } catch {}
  try { db.exec("ALTER TABLE pa_state ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)"); } catch {}
  // GCal tables may not exist yet (created by gcal-sync.js) — these are no-ops until they exist
  try { db.exec("ALTER TABLE gcal_events ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}
  try { db.exec("ALTER TABLE gcal_sync_state ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}
  try { db.exec("ALTER TABLE gcal_calendars ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}

  // Workspace indexes
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_workspace_date ON blocks(workspace_id, date) WHERE deleted_at IS NULL"); } catch {}

  // ── pa_state PK rebuild (Phase 3 — one-time, guarded) ──
  // Changes PK from single (date) → composite (date, workspace_id).
  // Required for ON CONFLICT(date, workspace_id) to correctly scope PA state per workspace.
  const paStatePk = db.pragma("table_info(pa_state)").filter(c => c.pk > 0).map(c => c.name);
  if (!paStatePk.includes("workspace_id")) {
    // Auto-backup before destructive change
    try { fs.copyFileSync(DB_PATH, DB_PATH + ".pre-workspace-migration"); } catch {}
    db.transaction(() => {
      db.exec(`
        CREATE TABLE pa_state_new (
          date         TEXT NOT NULL,
          state_json   TEXT NOT NULL,
          user_id      INTEGER REFERENCES users(id),
          workspace_id TEXT NOT NULL DEFAULT 'ws-1',
          updated_at   TEXT NOT NULL,
          PRIMARY KEY (date, workspace_id)
        )
      `);
      // COALESCE handles: already-set workspace_id > derive from user_id > fall back to ws-1
      db.exec(`
        INSERT INTO pa_state_new (date, state_json, user_id, workspace_id, updated_at)
        SELECT date, state_json, user_id,
          COALESCE(workspace_id, 'ws-' || user_id, 'ws-1'),
          updated_at
        FROM pa_state
      `);
      db.exec("DROP TABLE pa_state");
      db.exec("ALTER TABLE pa_state_new RENAME TO pa_state");
    })();
    console.log("[db] pa_state schema upgraded to composite PK (date, workspace_id)");
  }

  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pa_state_workspace ON pa_state(workspace_id, date)"); } catch {}

  return db;
}

let _db = null;
function getDB() {
  if (!_db) _db = initDB();
  return _db;
}

// ── Workspace Bootstrap ──

/**
 * Migrates GCal flat files → gcal_tokens table (one-time, per user).
 * Only runs if gcal-credentials.json exists and no DB row exists for the user.
 * The flat files are single-user, so we only migrate to the first user.
 */
function _migrateGcalFilesToDb(db, users, now) {
  const credPath = path.join(__dirname, "data", "gcal-credentials.json");
  if (!fs.existsSync(credPath)) return;

  const credentials = fs.readFileSync(credPath, "utf8");
  const tokensPath = path.join(__dirname, "data", "gcal-tokens.json");
  const calendarsPath = path.join(__dirname, "data", "gcal-calendars.json");

  for (const user of users) {
    const existing = db.prepare("SELECT user_id FROM gcal_tokens WHERE user_id = ?").get(user.id);
    if (existing) continue; // already migrated

    let tokens = null;
    let calendars = null;
    try { if (fs.existsSync(tokensPath)) tokens = fs.readFileSync(tokensPath, "utf8"); } catch {}
    try { if (fs.existsSync(calendarsPath)) calendars = fs.readFileSync(calendarsPath, "utf8"); } catch {}

    db.prepare(`
      INSERT INTO gcal_tokens (user_id, credentials, tokens, calendars, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, credentials, tokens, calendars, now);
    console.log(`[workspace] Migrated GCal tokens to DB for user '${user.username}'`);
    break; // Flat files have no user context — only migrate to the first user
  }
}

/**
 * Ensures every user has a workspace and that all their blocks/pa_state rows
 * have workspace_id stamped. Idempotent — safe to call on every startup.
 *
 * Also performs one-time GCal token file → DB migration.
 */
function ensureWorkspacesForAllUsers(db) {
  const users = db.prepare("SELECT * FROM users").all();
  if (users.length === 0) return;

  const now = new Date().toISOString();

  db.transaction(() => {
    for (const user of users) {
      const workspaceId = `ws-${user.id}`;

      // Create workspace if not exists
      const existingWs = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
      if (!existingWs) {
        db.prepare(`
          INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'free', ?, ?)
        `).run(workspaceId, `${user.username}'s workspace`, user.username, user.id, now, now);
        console.log(`[workspace] Created workspace ${workspaceId} for user '${user.username}'`);
      }

      // Create owner membership if not exists
      const existingMember = db.prepare(
        "SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).get(workspaceId, user.id);
      if (!existingMember) {
        db.prepare(`
          INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at)
          VALUES (?, ?, 'owner', ?, ?)
        `).run(workspaceId, user.id, now, now);
      }

      // Stamp blocks that belong to this user but lack workspace_id
      const blocksUpdated = db.prepare(
        "UPDATE blocks SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL"
      ).run(workspaceId, user.id);
      if (blocksUpdated.changes > 0) {
        console.log(`[workspace] Stamped workspace_id on ${blocksUpdated.changes} blocks for '${user.username}'`);
      }

      // Stamp pa_state rows that belong to this user but lack workspace_id
      const paUpdated = db.prepare(
        "UPDATE pa_state SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL"
      ).run(workspaceId, user.id);
      if (paUpdated.changes > 0) {
        console.log(`[workspace] Stamped workspace_id on ${paUpdated.changes} pa_state rows for '${user.username}'`);
      }
    }

    _migrateGcalFilesToDb(db, users, now);
  })();
}

// ── Block Type Validation ──

const BLOCK_SCHEMAS = {
  day_root: {
    required: ["date"],
    optional: []
  },
  schedule_item: {
    required: ["title", "type"],
    optional: [
      "start", "end", "priority", "source", "source_id",
      "done", "doneAt", "pushed", "pushedAt", "deleted", "deletedAt",
      "durOriginal", "durCurrent", "pinnedStart",
      "calUrl", "notionUrl", "completed", "detail", "meta",
      "estimated_minutes", "calendar_link", "prep",
      // GCal integration fields
      "gcal_event_id", "gcal_calendar_id", "gcal_etag",
      "hangout_link", "location", "rsvp_status",
      "attendee_count", "is_recurring", "all_day"
    ]
  },
  consider_item: {
    required: ["title"],
    optional: ["durMin", "priority", "source", "reason", "url", "task_id", "estimated_minutes"]
  },
  triage_item: {
    required: ["title"],
    optional: [
      "type", "summary", "link", "priority", "escalation_level",
      "cycle_count", "notes", "first_seen_at", "last_seen_at", "dismissed"
    ]
  },
  note: {
    required: ["html", "text"],
    optional: ["updatedAt"]
  },
  action_item: {
    required: ["text"],
    optional: ["priority", "done", "created", "scheduled", "scheduledAt"]
  },
  subtask: {
    required: ["text"],
    optional: ["done"]
  },
  pomo_state: {
    required: [],
    optional: [
      "title", "workMin", "mode", "total", "remaining", "running",
      "sessions", "soundOn", "sessionLog", "taskTime"
    ]
  },
  pomo_session: {
    required: ["durSec", "type"],
    optional: ["title", "time", "stackedOn"]
  },
  engram: {
    required: ["tag", "name"],
    optional: ["category", "context"]
  },
  mood_entry: {
    required: ["mood"],
    optional: ["time", "energy", "note"]
  },
  sticky_note: {
    required: ["html", "text"],
    optional: ["updatedAt"]
  },
  trivial_task: {
    required: ["text"],
    optional: ["done", "doneAt"]
  },
  life_capture: {
    required: ["text"],
    optional: ["category", "mood", "context", "timestamp"]
  },
  pending_task: {
    required: ["title"],
    optional: ["priority", "source_task", "source_task_id", "status", "created_at"]
  },
  added_task: {
    required: ["title"],
    optional: ["durMin", "detail", "source", "notionUrl", "priority", "meta"]
  },
  schedule_block: {
    required: ["name", "blockType", "start", "end"],
    optional: ["protected", "warnThreshold"]
  }
};

const VALID_TYPES = new Set(Object.keys(BLOCK_SCHEMAS));

function validateBlock(type, properties) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown block type: ${type}`);
  }
  const schema = BLOCK_SCHEMAS[type];
  for (const field of schema.required) {
    if (properties[field] === undefined || properties[field] === null) {
      throw new Error(`Block type '${type}' requires field '${field}'`);
    }
  }
  // Size check: 100KB max per block
  const size = JSON.stringify(properties).length;
  if (size > 100000) {
    throw new Error(`Block properties exceed 100KB limit (${size} bytes)`);
  }
}

// ── Block CRUD ──

function createBlock(db, { id, type, parent_id, date, properties, sort_order, user_id, workspace_id }) {
  const blockId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  const props = typeof properties === "string" ? properties : JSON.stringify(properties || {});
  const parsedProps = JSON.parse(props);

  validateBlock(type, parsedProps);

  const stmt = db.prepare(`
    INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(blockId, type, parent_id || null, date || null, props, sort_order || 0, user_id || null, workspace_id || null, now, now);

  // Log operation
  db.prepare(`
    INSERT INTO operations (block_id, op_type, after_data, timestamp)
    VALUES (?, 'create', ?, ?)
  `).run(blockId, props, now);

  return {
    id: blockId, type, parent_id: parent_id || null, date: date || null,
    properties: parsedProps, sort_order: sort_order || 0,
    created_at: now, updated_at: now, deleted_at: null
  };
}

function updateBlock(db, id, { properties, sort_order, parent_id, date }) {
  const now = new Date().toISOString();

  // Fetch existing
  const existing = db.prepare("SELECT * FROM blocks WHERE id = ?").get(id);
  if (!existing) throw new Error(`Block not found: ${id}`);
  if (existing.deleted_at) throw new Error(`Block is deleted: ${id}`);

  // If properties provided, validate and replace (full replacement, no merge)
  let newProps = existing.properties;
  if (properties !== undefined) {
    const propsStr = typeof properties === "string" ? properties : JSON.stringify(properties);
    const parsed = JSON.parse(propsStr);
    validateBlock(existing.type, parsed);
    newProps = propsStr;
  }

  const newSortOrder = sort_order !== undefined ? sort_order : existing.sort_order;
  const newParentId = parent_id !== undefined ? parent_id : existing.parent_id;
  const newDate = date !== undefined ? date : existing.date;

  db.prepare(`
    UPDATE blocks SET properties = ?, sort_order = ?, parent_id = ?, date = ?, updated_at = ?
    WHERE id = ?
  `).run(newProps, newSortOrder, newParentId, newDate, now, id);

  // Log operation
  db.prepare(`
    INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp)
    VALUES (?, 'update', ?, ?, ?)
  `).run(id, existing.properties, newProps, now);

  return {
    id, type: existing.type, parent_id: newParentId, date: newDate,
    properties: JSON.parse(newProps), sort_order: newSortOrder,
    created_at: existing.created_at, updated_at: now, deleted_at: null
  };
}

function deleteBlock(db, id) {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM blocks WHERE id = ?").get(id);
  if (!existing) throw new Error(`Block not found: ${id}`);

  db.prepare("UPDATE blocks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);

  db.prepare(`
    INSERT INTO operations (block_id, op_type, before_data, timestamp)
    VALUES (?, 'delete', ?, ?)
  `).run(id, existing.properties, now);

  return { id, deleted_at: now };
}

// ── Query ──

function parseBlock(row) {
  return {
    ...row,
    properties: JSON.parse(row.properties || "{}")
  };
}

function getBlocksByDate(db, date, workspaceId) {
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM blocks WHERE date = ? AND workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`).all(date, workspaceId)
    : db.prepare(`SELECT * FROM blocks WHERE date = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`).all(date);
  return rows.map(parseBlock);
}

function getBlocksByTypes(db, types, workspaceId) {
  const placeholders = types.map(() => "?").join(",");
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`).all(...types, workspaceId)
    : db.prepare(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`).all(...types);
  return rows.map(parseBlock);
}

function getChildren(db, parentId, workspaceId) {
  const wsFilter = workspaceId ? "AND workspace_id = ?" : "";
  const args = workspaceId ? [parentId, workspaceId] : [parentId];
  const rows = db.prepare(`
    SELECT * FROM blocks WHERE parent_id = ? ${wsFilter} AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC
  `).all(...args);
  return rows.map(parseBlock);
}

function getBlock(db, id) {
  const row = db.prepare("SELECT * FROM blocks WHERE id = ?").get(id);
  return row ? parseBlock(row) : null;
}

// ── Batch Operations ──

function batchOp(db, operations) {
  const batchId = crypto.randomUUID();
  const results = [];

  const runBatch = db.transaction(() => {
    for (const op of operations) {
      switch (op.op) {
        case "create":
          results.push(createBlock(db, op));
          break;
        case "update":
          results.push(updateBlock(db, op.id, op));
          break;
        case "delete":
          results.push(deleteBlock(db, op.id));
          break;
        case "reorder":
          reorderBlocks(db, op.items);
          results.push({ reordered: op.items.length });
          break;
        default:
          throw new Error(`Unknown batch operation: ${op.op}`);
      }
    }
  });

  runBatch();
  return { batchId, blocks: results };
}

// ── Reorder with Auto-Rebalance ──

function reorderBlocks(db, items) {
  // items: [{ id, sort_order }]
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE blocks SET sort_order = ?, updated_at = ? WHERE id = ?");
  for (const item of items) {
    stmt.run(item.sort_order, now, item.id);
  }

  // Check if rebalance is needed (gap < 0.001 between any adjacent items)
  if (items.length > 1) {
    const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order);
    let needsRebalance = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].sort_order - sorted[i - 1].sort_order < 0.001) {
        needsRebalance = true;
        break;
      }
    }
    if (needsRebalance) {
      // Rebalance all siblings to integer spacing
      const parentId = db.prepare("SELECT parent_id FROM blocks WHERE id = ?").get(items[0].id);
      if (parentId) {
        const siblings = db.prepare(`
          SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL
          ORDER BY sort_order ASC
        `).all(parentId.parent_id);
        siblings.forEach((sib, i) => {
          stmt.run((i + 1) * 1000, now, sib.id);
        });
      }
    }
  }
}

// ── Day Root (auto-created) ──

function ensureDayRoot(db, date, userId, workspaceId) {
  // New workspaces get a workspace-scoped ID; ws-1 (original) falls back to legacy format
  const newId = workspaceId ? `day-root-${workspaceId}-${date}` : `day-root-${date}`;
  const legacyId = `day-root-${date}`;

  // Check new-format ID first
  if (db.prepare("SELECT id FROM blocks WHERE id = ?").get(newId)) return newId;
  // Backward compat: fall back to legacy ID for ws-1 (original single-user data)
  if (workspaceId === "ws-1" && db.prepare("SELECT id FROM blocks WHERE id = ?").get(legacyId)) return legacyId;

  createBlock(db, {
    id: newId,
    type: "day_root",
    date,
    properties: { date },
    sort_order: 0,
    user_id: userId || null,
    workspace_id: workspaceId || null
  });
  return newId;
}

// ── PA State ──

function savePaState(db, date, stateJson, userId, workspaceId) {
  const now = new Date().toISOString();
  // Derive workspaceId from userId if not provided (backward compat)
  const wsId = workspaceId || (userId ? `ws-${userId}` : "ws-1");
  db.prepare(`
    INSERT INTO pa_state (date, state_json, user_id, workspace_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, workspace_id) DO UPDATE SET
      state_json = excluded.state_json,
      user_id    = excluded.user_id,
      updated_at = excluded.updated_at
  `).run(date, typeof stateJson === "string" ? stateJson : JSON.stringify(stateJson), userId || null, wsId, now);
}

function getPaState(db, date, workspaceId) {
  const row = workspaceId
    ? db.prepare("SELECT * FROM pa_state WHERE date = ? AND workspace_id = ?").get(date, workspaceId)
    : db.prepare("SELECT * FROM pa_state WHERE date = ?").get(date);
  if (!row) return null;
  return { ...row, state_json: JSON.parse(row.state_json) };
}

// ── Soft Delete Purge ──

function purgeSoftDeleted(db, olderThanDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffStr = cutoff.toISOString();
  const result = db.prepare("DELETE FROM blocks WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoffStr);
  return result.changes;
}

// ── Operations History ──

function getOperations(db, blockId, limit = 50) {
  return db.prepare(`
    SELECT * FROM operations WHERE block_id = ? ORDER BY id DESC LIMIT ?
  `).all(blockId, limit);
}

// ── Range Queries (for Calendar View) ──

function getBlocksByDateRange(db, startDate, endDate, workspaceId) {
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM blocks WHERE date >= ? AND date <= ? AND workspace_id = ? AND deleted_at IS NULL ORDER BY date ASC, sort_order ASC, created_at ASC`).all(startDate, endDate, workspaceId)
    : db.prepare(`SELECT * FROM blocks WHERE date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date ASC, sort_order ASC, created_at ASC`).all(startDate, endDate);
  return rows.map(parseBlock);
}

function getPaStateRange(db, startDate, endDate, workspaceId) {
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM pa_state WHERE date >= ? AND date <= ? AND workspace_id = ? ORDER BY date ASC`).all(startDate, endDate, workspaceId)
    : db.prepare(`SELECT * FROM pa_state WHERE date >= ? AND date <= ? ORDER BY date ASC`).all(startDate, endDate);
  return rows.map(row => ({
    ...row,
    state_json: JSON.parse(row.state_json)
  }));
}

// ── Export ──

module.exports = {
  getDB,
  BLOCK_SCHEMAS,
  VALID_TYPES,
  validateBlock,
  createBlock,
  updateBlock,
  deleteBlock,
  getBlocksByDate,
  getBlocksByTypes,
  getChildren,
  getBlock,
  batchOp,
  reorderBlocks,
  ensureDayRoot,
  savePaState,
  getPaState,
  purgeSoftDeleted,
  getOperations,
  parseBlock,
  getBlocksByDateRange,
  getPaStateRange,
  ensureWorkspacesForAllUsers
};
