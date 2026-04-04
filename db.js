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

  // Add user_id columns to existing tables (idempotent — fails silently if already present)
  try { db.exec("ALTER TABLE blocks ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}
  try { db.exec("ALTER TABLE pa_state ADD COLUMN user_id INTEGER REFERENCES users(id)"); } catch {}

  return db;
}

let _db = null;
function getDB() {
  if (!_db) _db = initDB();
  return _db;
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

function createBlock(db, { id, type, parent_id, date, properties, sort_order, user_id }) {
  const blockId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  const props = typeof properties === "string" ? properties : JSON.stringify(properties || {});
  const parsedProps = JSON.parse(props);

  validateBlock(type, parsedProps);

  const stmt = db.prepare(`
    INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(blockId, type, parent_id || null, date || null, props, sort_order || 0, user_id || null, now, now);

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

function getBlocksByDate(db, date, userId) {
  const rows = db.prepare(`
    SELECT * FROM blocks WHERE date = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC
  `).all(date, userId);
  return rows.map(parseBlock);
}

function getBlocksByTypes(db, types, userId) {
  const placeholders = types.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM blocks WHERE type IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC
  `).all(...types, userId);
  return rows.map(parseBlock);
}

function getChildren(db, parentId, userId) {
  const userFilter = userId ? "AND user_id = ?" : "";
  const args = userId ? [parentId, userId] : [parentId];
  const rows = db.prepare(`
    SELECT * FROM blocks WHERE parent_id = ? ${userFilter} AND deleted_at IS NULL
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

function ensureDayRoot(db, date, userId) {
  const deterministicId = `day-root-${date}`;
  const existing = db.prepare("SELECT id FROM blocks WHERE id = ?").get(deterministicId);
  if (existing) return deterministicId;

  createBlock(db, {
    id: deterministicId,
    type: "day_root",
    date,
    properties: { date },
    sort_order: 0,
    user_id: userId || null
  });
  return deterministicId;
}

// ── PA State ──

function savePaState(db, date, stateJson, userId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pa_state (date, state_json, user_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET state_json = excluded.state_json, user_id = excluded.user_id, updated_at = excluded.updated_at
  `).run(date, typeof stateJson === "string" ? stateJson : JSON.stringify(stateJson), userId || null, now);
}

function getPaState(db, date, userId) {
  const row = userId
    ? db.prepare("SELECT * FROM pa_state WHERE date = ? AND user_id = ?").get(date, userId)
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

function getBlocksByDateRange(db, startDate, endDate, userId) {
  const rows = db.prepare(`
    SELECT * FROM blocks WHERE date >= ? AND date <= ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY date ASC, sort_order ASC, created_at ASC
  `).all(startDate, endDate, userId);
  return rows.map(parseBlock);
}

function getPaStateRange(db, startDate, endDate, userId) {
  const rows = userId
    ? db.prepare(`SELECT * FROM pa_state WHERE date >= ? AND date <= ? AND user_id = ? ORDER BY date ASC`).all(startDate, endDate, userId)
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
  getPaStateRange
};
