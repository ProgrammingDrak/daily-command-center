/**
 * db.js — Postgres Block Database Layer
 *
 * Single source of truth for all user data in the Daily Command Center.
 * Uses pg (node-postgres) with async/await for all operations.
 *
 * Block model: every entity (task, note, action item, sticky note, etc.)
 * is a "block" with a type, parent, properties (JSONB), and sort order.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("./pg-pool");

// ── Workspace Bootstrap ──

async function _migrateGcalFilesToDb(client, users, now) {
  const credPath = path.join(__dirname, "data", "gcal-credentials.json");
  if (!fs.existsSync(credPath)) return;
  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(credPath, "utf8")); } catch { return; }
  const tokensPath = path.join(__dirname, "data", "gcal-tokens.json");
  const calendarsPath = path.join(__dirname, "data", "gcal-calendars.json");

  for (const user of users) {
    const { rows } = await client.query("SELECT user_id FROM gcal_tokens WHERE user_id = $1", [user.id]);
    if (rows.length > 0) continue;
    let tokens = null, calendars = null;
    try { if (fs.existsSync(tokensPath)) tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8")); } catch {}
    try { if (fs.existsSync(calendarsPath)) calendars = JSON.parse(fs.readFileSync(calendarsPath, "utf8")); } catch {}
    await client.query(
      `INSERT INTO gcal_tokens (user_id, credentials, tokens, calendars, updated_at) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, credentials, tokens, calendars, now]
    );
    console.log(`[workspace] Migrated GCal tokens to DB for user '${user.username}'`);
    break;
  }
}

async function ensureWorkspacesForAllUsers() {
  const { rows: users } = await pool.query("SELECT * FROM users");
  if (users.length === 0) return;
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const user of users) {
      if (!user.username) continue; // skip users without a DCC username (e.g. audit-angel users)
      const workspaceId = `ws-${user.id}`;
      const { rows: wsRows } = await client.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]);
      if (wsRows.length === 0) {
        await client.query(
          `INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, 'free', $5, $6)`,
          [workspaceId, `${user.username}'s workspace`, user.username, user.id, now, now]
        );
        console.log(`[workspace] Created workspace ${workspaceId} for user '${user.username}'`);
      }
      const { rows: memberRows } = await client.query("SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, user.id]);
      if (memberRows.length === 0) {
        await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at) VALUES ($1, $2, 'owner', $3, $4)`, [workspaceId, user.id, now, now]);
      }
      const blocksResult = await client.query("UPDATE blocks SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL", [workspaceId, user.id]);
      if (blocksResult.rowCount > 0) console.log(`[workspace] Stamped workspace_id on ${blocksResult.rowCount} blocks for '${user.username}'`);
      const paResult = await client.query("UPDATE pa_state SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL", [workspaceId, user.id]);
      if (paResult.rowCount > 0) console.log(`[workspace] Stamped workspace_id on ${paResult.rowCount} pa_state rows for '${user.username}'`);
    }
    await _migrateGcalFilesToDb(client, users, now);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Block Type Validation ──

const BLOCK_SCHEMAS = {
  day_root: { required: ["date"], optional: [] },
  schedule_item: { required: ["title", "type"], optional: ["start", "end", "priority", "source", "source_id", "done", "doneAt", "pushed", "pushedAt", "deleted", "deletedAt", "durOriginal", "durCurrent", "pinnedStart", "calUrl", "notionUrl", "completed", "detail", "meta", "estimated_minutes", "calendar_link", "prep", "gcal_event_id", "gcal_calendar_id", "gcal_etag", "hangout_link", "location", "rsvp_status", "attendee_count", "is_recurring", "all_day", "tags"] },
  consider_item: { required: ["title"], optional: ["durMin", "priority", "source", "reason", "url", "task_id", "estimated_minutes"] },
  triage_item: { required: ["title"], optional: ["type", "summary", "link", "priority", "escalation_level", "cycle_count", "notes", "first_seen_at", "last_seen_at", "dismissed"] },
  note: { required: ["html", "text"], optional: ["updatedAt"] },
  action_item: { required: ["text"], optional: ["priority", "done", "created", "scheduled", "scheduledAt"] },
  subtask: { required: ["text"], optional: ["done"] },
  pomo_state: { required: [], optional: ["title", "workMin", "mode", "total", "remaining", "running", "sessions", "soundOn", "sessionLog", "taskTime"] },
  pomo_session: { required: ["durSec", "type"], optional: ["title", "time", "stackedOn"] },
  engram: { required: ["tag", "name"], optional: ["category", "context"] },
  mood_entry: { required: ["mood"], optional: ["time", "energy", "note"] },
  sticky_note: { required: ["html", "text"], optional: ["updatedAt"] },
  trivial_task: { required: ["text"], optional: ["done", "doneAt"] },
  life_capture: { required: ["text"], optional: ["category", "mood", "context", "timestamp"] },
  pending_task: { required: ["title"], optional: ["priority", "source_task", "source_task_id", "status", "created_at"] },
  added_task: { required: ["title"], optional: ["durMin", "detail", "source", "notionUrl", "priority", "meta", "tags"] },
  schedule_block: { required: ["name", "blockType", "start", "end"], optional: ["protected", "warnThreshold", "acceptedTags"] },
  tag: { required: ["name"], optional: ["color", "description"] }
};

const VALID_TYPES = new Set(Object.keys(BLOCK_SCHEMAS));

function validateBlock(type, properties) {
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown block type: ${type}`);
  const schema = BLOCK_SCHEMAS[type];
  for (const field of schema.required) {
    if (properties[field] === undefined || properties[field] === null) throw new Error(`Block type '${type}' requires field '${field}'`);
  }
  const size = JSON.stringify(properties).length;
  if (size > 100000) throw new Error(`Block properties exceed 100KB limit (${size} bytes)`);
}

// ── Block CRUD ──

function parseBlock(row) {
  if (!row) return null;
  return { ...row, properties: typeof row.properties === "string" ? JSON.parse(row.properties) : (row.properties || {}) };
}

async function createBlock({ id, type, parent_id, date, properties, sort_order, user_id, workspace_id }, client) {
  const blockId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  const props = typeof properties === "string" ? JSON.parse(properties) : (properties || {});
  validateBlock(type, props);
  const q = client || pool;
  await q.query(
    `INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [blockId, type, parent_id || null, date || null, props, sort_order || 0, user_id || null, workspace_id || null, now, now]
  );
  await q.query(`INSERT INTO operations (block_id, op_type, after_data, timestamp) VALUES ($1, 'create', $2, $3)`, [blockId, props, now]);
  return { id: blockId, type, parent_id: parent_id || null, date: date || null, properties: props, sort_order: sort_order || 0, created_at: now, updated_at: now, deleted_at: null };
}

async function updateBlock(id, { properties, sort_order, parent_id, date }) {
  const now = new Date().toISOString();
  const { rows } = await pool.query("SELECT * FROM blocks WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) throw new Error(`Block not found: ${id}`);
  if (existing.deleted_at) throw new Error(`Block is deleted: ${id}`);
  let newProps = existing.properties;
  if (properties !== undefined) {
    const parsed = typeof properties === "string" ? JSON.parse(properties) : properties;
    validateBlock(existing.type, parsed);
    newProps = parsed;
  }
  const newSortOrder = sort_order !== undefined ? sort_order : existing.sort_order;
  const newParentId = parent_id !== undefined ? parent_id : existing.parent_id;
  const newDate = date !== undefined ? date : existing.date;
  await pool.query(`UPDATE blocks SET properties = $1, sort_order = $2, parent_id = $3, date = $4, updated_at = $5 WHERE id = $6`, [newProps, newSortOrder, newParentId, newDate, now, id]);
  await pool.query(`INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp) VALUES ($1, 'update', $2, $3, $4)`, [id, existing.properties, newProps, now]);
  return { id, type: existing.type, parent_id: newParentId, date: newDate, properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps, sort_order: newSortOrder, created_at: existing.created_at, updated_at: now, deleted_at: null };
}

async function deleteBlock(id) {
  const now = new Date().toISOString();
  const { rows } = await pool.query("SELECT * FROM blocks WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) throw new Error(`Block not found: ${id}`);
  await pool.query("UPDATE blocks SET deleted_at = $1, updated_at = $2 WHERE id = $3", [now, now, id]);
  await pool.query(`INSERT INTO operations (block_id, op_type, before_data, timestamp) VALUES ($1, 'delete', $2, $3)`, [id, existing.properties, now]);
  return { id, deleted_at: now };
}

// ── Query ──

async function getBlocksByDate(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE date = $1 AND workspace_id = $2 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [date, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE date = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [date]);
  return rows.map(parseBlock);
}

async function getBlocksByTypes(types, workspaceId) {
  const placeholders = types.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND workspace_id = $${types.length + 1} AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [...types, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, types);
  return rows.map(parseBlock);
}

async function getChildren(parentId, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE parent_id = $1 AND workspace_id = $2 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [parentId, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [parentId]);
  return rows.map(parseBlock);
}

async function getBlock(id) {
  const { rows } = await pool.query("SELECT * FROM blocks WHERE id = $1", [id]);
  return rows[0] ? parseBlock(rows[0]) : null;
}

// ── Batch Operations ──

async function batchOp(operations) {
  const batchId = crypto.randomUUID();
  const results = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const op of operations) {
      switch (op.op) {
        case "create": results.push(await createBlock(op, client)); break;
        case "update": results.push(await updateBlock(op.id, op)); break;
        case "delete": results.push(await deleteBlock(op.id)); break;
        case "reorder": await reorderBlocks(op.items); results.push({ reordered: op.items.length }); break;
        default: throw new Error(`Unknown batch operation: ${op.op}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { batchId, blocks: results };
}

// ── Reorder with Auto-Rebalance ──

async function reorderBlocks(items) {
  const now = new Date().toISOString();
  for (const item of items) {
    await pool.query("UPDATE blocks SET sort_order = $1, updated_at = $2 WHERE id = $3", [item.sort_order, now, item.id]);
  }
  if (items.length > 1) {
    const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order);
    let needsRebalance = false;
    for (let i = 1; i < sorted.length; i++) { if (sorted[i].sort_order - sorted[i - 1].sort_order < 0.001) { needsRebalance = true; break; } }
    if (needsRebalance) {
      const { rows } = await pool.query("SELECT parent_id FROM blocks WHERE id = $1", [items[0].id]);
      if (rows[0] && rows[0].parent_id) {
        const { rows: siblings } = await pool.query(`SELECT id FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC`, [rows[0].parent_id]);
        for (let i = 0; i < siblings.length; i++) { await pool.query("UPDATE blocks SET sort_order = $1, updated_at = $2 WHERE id = $3", [(i + 1) * 1000, now, siblings[i].id]); }
      }
    }
  }
}

// ── Day Root ──

async function ensureDayRoot(date, userId, workspaceId) {
  const newId = workspaceId ? `day-root-${workspaceId}-${date}` : `day-root-${date}`;
  const legacyId = `day-root-${date}`;
  const { rows: newRows } = await pool.query("SELECT id FROM blocks WHERE id = $1", [newId]);
  if (newRows.length > 0) return newId;
  if (workspaceId === "ws-1") {
    const { rows: legacyRows } = await pool.query("SELECT id FROM blocks WHERE id = $1", [legacyId]);
    if (legacyRows.length > 0) return legacyId;
  }
  await createBlock({ id: newId, type: "day_root", date, properties: { date }, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null });
  return newId;
}

// ── PA State ──

async function savePaState(date, stateJson, userId, workspaceId) {
  const now = new Date().toISOString();
  const wsId = workspaceId || (userId ? `ws-${userId}` : "ws-1");
  const stateObj = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson;
  await pool.query(
    `INSERT INTO pa_state (date, state_json, user_id, workspace_id, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(date, workspace_id) DO UPDATE SET state_json = EXCLUDED.state_json, user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at`,
    [date, stateObj, userId || null, wsId, now]
  );
}

async function getPaState(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query("SELECT * FROM pa_state WHERE date = $1 AND workspace_id = $2", [date, workspaceId])
    : await pool.query("SELECT * FROM pa_state WHERE date = $1", [date]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { ...row, state_json: typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json };
}

async function purgeSoftDeleted(olderThanDays = 30) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - olderThanDays);
  const result = await pool.query("DELETE FROM blocks WHERE deleted_at IS NOT NULL AND deleted_at < $1", [cutoff.toISOString()]);
  return result.rowCount;
}

async function getOperations(blockId, limit = 50) {
  const { rows } = await pool.query(`SELECT * FROM operations WHERE block_id = $1 ORDER BY id DESC LIMIT $2`, [blockId, limit]);
  return rows;
}

async function getBlocksByDateRange(startDate, endDate, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE date >= $1 AND date <= $2 AND workspace_id = $3 AND deleted_at IS NULL ORDER BY date ASC, sort_order ASC, created_at ASC`, [startDate, endDate, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL ORDER BY date ASC, sort_order ASC, created_at ASC`, [startDate, endDate]);
  return rows.map(parseBlock);
}

async function getPaStateRange(startDate, endDate, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM pa_state WHERE date >= $1 AND date <= $2 AND workspace_id = $3 ORDER BY date ASC`, [startDate, endDate, workspaceId])
    : await pool.query(`SELECT * FROM pa_state WHERE date >= $1 AND date <= $2 ORDER BY date ASC`, [startDate, endDate]);
  return rows.map(row => ({ ...row, state_json: typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json }));
}

module.exports = {
  pool, BLOCK_SCHEMAS, VALID_TYPES, validateBlock,
  createBlock, updateBlock, deleteBlock,
  getBlocksByDate, getBlocksByTypes, getChildren, getBlock,
  batchOp, reorderBlocks, ensureDayRoot,
  savePaState, getPaState, purgeSoftDeleted, getOperations,
  parseBlock, getBlocksByDateRange, getPaStateRange, ensureWorkspacesForAllUsers
};
