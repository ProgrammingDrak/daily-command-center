/**
 * db.js — Postgres Block Database Layer
 *
 * Single source of truth for all user data in the Daily Command Center.
 * Uses pg (node-postgres) with async/await for all operations.
 *
 * Block model: every entity (task, note, action item, sticky note, etc.)
 * is a "block" with a type, parent, properties (JSONB), and sort order.
 */

const crypto = require("crypto");
const pool = require("./pg-pool");

// ── Workspace Bootstrap ──

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
      const dccResult = await client.query("UPDATE dcc_state SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL", [workspaceId, user.id]);
      if (dccResult.rowCount > 0) console.log(`[workspace] Stamped workspace_id on ${dccResult.rowCount} dcc_state rows for '${user.username}'`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Block Type Validation ──

// ── Unified Block Architecture ──
// All user data uses type = 'block'. Properties JSONB is freeform.
// Code interprets blocks by checking property presence, not type labels.
// Legacy type names ('added_task', 'schedule_item', etc.) accepted for backward compat.
const BLOCK_SCHEMAS = { block: { required: [], optional: [] }, day_root: { required: ["date"], optional: [] } };
const VALID_TYPES = new Set(["block", "day_root",
  // time_entry — actual time-tracking segments (planned-vs-actual day review).
  // Stored under the day_root with a date, so it loads with getBlocksByDate/range.
  "time_entry",
  // Legacy types — accepted during migration transition, all treated as 'block'
  "schedule_item", "consider_item", "triage_item", "note", "action_item", "subtask",
  "pomo_state", "pomo_session", "engram", "mood_entry", "sticky_note", "trivial_task",
  "life_capture", "pending_task", "added_task", "schedule_block", "tag"
]);

function validateBlock(type, properties) {
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown block type: ${type}`);
  const size = JSON.stringify(properties).length;
  if (size > 100000) throw new Error(`Block properties exceed 100KB limit (${size} bytes)`);
}

// ── Block CRUD ──

// Postgres returns DATE columns as JS Date objects, which JSON-stringify to
// "YYYY-MM-DDT00:00:00.000Z". Clients compare block.date to the "YYYY-MM-DD"
// they pass in, so round-tripping the timestamp would silently drop every
// same-day block. Normalize to the bare date string here.
function normalizeDate(v) {
  if (!v) return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function parseBlock(row) {
  if (!row) return null;
  return {
    ...row,
    date: normalizeDate(row.date),
    properties: typeof row.properties === "string" ? JSON.parse(row.properties) : (row.properties || {}),
  };
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
  return { id, type: existing.type, parent_id: newParentId, date: normalizeDate(newDate), properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps, sort_order: newSortOrder, created_at: existing.created_at, updated_at: now, deleted_at: null };
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

// Undated task blocks that could ride along in a reschedule subtree walk.
// Only blocks holding a subtaskOf/wrapId link can ever join a subtree
// (lib/reschedule.js walks those keys), so filter to them here — the broader
// date-IS-NULL set also matches every delegated item (type='block', date null,
// kind='delegated_item'), a standing list that would bloat every reschedule.
async function getUndatedTaskBlocks(workspaceId) {
  const linked = `(properties->>'subtaskOf' IS NOT NULL OR properties->>'wrapId' IS NOT NULL)`;
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE date IS NULL AND type = 'block' AND ${linked} AND workspace_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE date IS NULL AND type = 'block' AND ${linked} AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`);
  return rows.map(parseBlock);
}

async function getBlocksByTypes(types, workspaceId) {
  const placeholders = types.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND workspace_id = $${types.length + 1} AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [...types, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, types);
  return rows.map(parseBlock);
}

// PIN 10.A: delegated items are type="block" with properties.kind="delegated_item".
// Sorted by checkInAt ascending (nulls last) so upcoming check-ins surface first.
async function getDelegatedItems(workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' = 'delegated_item'
           AND workspace_id = $1
           AND deleted_at IS NULL
         ORDER BY (properties->>'checkInAt') ASC NULLS LAST, created_at DESC`,
        [workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' = 'delegated_item'
           AND deleted_at IS NULL
         ORDER BY (properties->>'checkInAt') ASC NULLS LAST, created_at DESC`
      );
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

// ── Reschedule (atomic subtree move) ──

// Move a parent block and its whole subtask subtree to another date in ONE
// transaction, optionally creating side blocks (a "rescheduled away" tombstone)
// in the same commit. This replaces the old clone-new-id + soft-delete-old
// design, which could half-fail and strand or duplicate subtasks. `moves` is
// [{ id, date, properties? }] (properties omitted => keep existing). `creates`
// is [createBlock-shaped payloads] run on the same client.
//
// NOTE: batchOp() can't be reused here — its "update" branch calls updateBlock(),
// which uses `pool` directly, so batched updates run OUTSIDE the transaction.
async function rescheduleBlocks(moves, creates) {
  const now = new Date().toISOString();
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const m of moves) {
      const { rows } = await client.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [m.id]);
      const existing = rows[0];
      if (!existing) throw new Error(`Block not found: ${m.id}`);
      if (existing.deleted_at) throw new Error(`Block is deleted: ${m.id}`);
      let newProps = existing.properties;
      if (m.properties !== undefined) {
        const parsed = typeof m.properties === "string" ? JSON.parse(m.properties) : m.properties;
        validateBlock(existing.type, parsed);
        newProps = parsed;
      }
      const newDate = m.date !== undefined ? m.date : existing.date;
      await client.query(`UPDATE blocks SET properties = $1, date = $2, updated_at = $3 WHERE id = $4`, [newProps, newDate, now, m.id]);
      await client.query(`INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp) VALUES ($1, 'update', $2, $3, $4)`, [m.id, existing.properties, newProps, now]);
      results.push({ id: m.id, type: existing.type, parent_id: existing.parent_id, date: normalizeDate(newDate), properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps, sort_order: existing.sort_order, created_at: existing.created_at, updated_at: now, deleted_at: null });
    }
    for (const c of (creates || [])) {
      results.push(await createBlock(c, client));
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { blocks: results };
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

// ── DCC State ──

async function ensureDccStateTable() {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.dcc_state') IS NULL AND to_regclass('public.pa_state') IS NOT NULL THEN
        ALTER TABLE pa_state RENAME TO dcc_state;
      END IF;
      IF to_regclass('public.idx_pa_state_workspace') IS NOT NULL AND to_regclass('public.idx_dcc_state_workspace') IS NULL THEN
        ALTER INDEX idx_pa_state_workspace RENAME TO idx_dcc_state_workspace;
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dcc_state (
      date         DATE NOT NULL,
      state_json   JSONB NOT NULL,
      user_id      INTEGER REFERENCES users(id),
      workspace_id TEXT NOT NULL DEFAULT 'ws-1',
      updated_at   TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (date, workspace_id)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_dcc_state_workspace ON dcc_state(workspace_id, date)");
}

async function saveDccState(date, stateJson, userId, workspaceId) {
  const now = new Date().toISOString();
  const wsId = workspaceId || (userId ? `ws-${userId}` : "ws-1");
  const stateObj = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson;
  await pool.query(
    `INSERT INTO dcc_state (date, state_json, user_id, workspace_id, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(date, workspace_id) DO UPDATE SET state_json = EXCLUDED.state_json, user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at`,
    [date, stateObj, userId || null, wsId, now]
  );
}

async function getDccState(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query("SELECT * FROM dcc_state WHERE date = $1 AND workspace_id = $2", [date, workspaceId])
    : await pool.query("SELECT * FROM dcc_state WHERE date = $1", [date]);
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

async function getDccStateRange(startDate, endDate, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM dcc_state WHERE date >= $1 AND date <= $2 AND workspace_id = $3 ORDER BY date ASC`, [startDate, endDate, workspaceId])
    : await pool.query(`SELECT * FROM dcc_state WHERE date >= $1 AND date <= $2 ORDER BY date ASC`, [startDate, endDate]);
  return rows.map(row => ({ ...row, state_json: typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json }));
}

module.exports = {
  pool, BLOCK_SCHEMAS, VALID_TYPES, validateBlock,
  createBlock, updateBlock, deleteBlock,
  getBlocksByDate, getUndatedTaskBlocks, getBlocksByTypes, getChildren, getBlock,
  getDelegatedItems,
  batchOp, rescheduleBlocks, reorderBlocks, ensureDayRoot,
  ensureDccStateTable, saveDccState, getDccState, purgeSoftDeleted, getOperations,
  parseBlock, getBlocksByDateRange, getDccStateRange, ensureWorkspacesForAllUsers
};
