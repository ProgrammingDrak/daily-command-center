"use strict";

const pool = require("./pg-pool");
const blockDB = require("./db");

const GLOBAL_TYPES = ["sticky_note", "trivial_task", "life_capture", "pending_task", "schedule_block", "tag"];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

function safeCursor(value) {
  const cursor = Number(value || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    const error = new Error("cursor must be a non-negative integer");
    error.status = 400;
    error.code = "invalid_cursor";
    throw error;
  }
  return cursor;
}

function safeLimit(value) {
  const limit = Number(value || DEFAULT_LIMIT);
  return Number.isSafeInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, limit)) : DEFAULT_LIMIT;
}

function dateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isGlobalBlock(row) {
  const props = row && row.properties || {};
  return GLOBAL_TYPES.includes(row.type)
    || (row.type === "block" && !row.date)
    || (row.type === "block" && Array.isArray(props.tags) && props.tags.includes("pinned"));
}

async function readDayBlocks(client, workspaceId, date) {
  const { rows } = await client.query(
    `SELECT * FROM blocks
      WHERE workspace_id = $2 AND deleted_at IS NULL
        AND (date = $1 OR (properties->>'all_day' = 'true'
          AND CASE WHEN properties->>'all_day_start' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_start')::date END <= $1
          AND CASE WHEN properties->>'all_day_end' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_end')::date END > $1))
      ORDER BY date ASC, sort_order ASC, created_at ASC`,
    [date, workspaceId]
  );
  return rows.map(blockDB.parseBlock);
}

async function readGlobalBlocks(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT * FROM blocks
      WHERE workspace_id = $1 AND deleted_at IS NULL
        AND (
          type = ANY($2::text[])
          OR (type = 'block' AND date IS NULL)
          OR (type = 'block' AND properties->'tags' ? 'pinned')
        )
      ORDER BY sort_order ASC, created_at ASC`,
    [workspaceId, GLOBAL_TYPES]
  );
  return rows.map(blockDB.parseBlock);
}

async function bootstrap({ workspaceId, date }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: cursorRows } = await client.query(
      "SELECT COALESCE(MAX(seq), 0)::bigint AS cursor FROM sync_events WHERE workspace_id = $1",
      [workspaceId]
    );
    const cursor = Number(cursorRows[0]?.cursor || 0);
    const [dccRow, blocks, globals] = await Promise.all([
      blockDB.getDccStateCompact(date, workspaceId, client),
      readDayBlocks(client, workspaceId, date),
      readGlobalBlocks(client, workspaceId),
    ]);
    await client.query("COMMIT");
    return {
      schemaVersion: 1,
      workspaceId,
      date,
      cursor,
      dayState: dccRow ? dccRow.state_json : null,
      blocks,
      globals,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pull({ workspaceId, date, cursor: rawCursor, limit: rawLimit }) {
  const cursor = safeCursor(rawCursor);
  const limit = safeLimit(rawLimit);
  const { rows: floorRows } = await pool.query(
    "SELECT pruned_through_seq FROM sync_prune_watermarks WHERE workspace_id = $1",
    [workspaceId]
  );
  const floor = Number(floorRows[0]?.pruned_through_seq || 0);
  if (cursor && cursor <= floor) {
    const error = new Error("sync cursor expired");
    error.status = 410;
    error.code = "cursor_expired";
    throw error;
  }

  const { rows: events } = await pool.query(
    `SELECT seq, entity_type, entity_id, operation, entity_date
       FROM sync_events
      WHERE workspace_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [workspaceId, cursor, limit + 1]
  );
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const nextCursor = page.length ? Number(page[page.length - 1].seq) : cursor;

  const latest = new Map();
  for (const event of page) latest.set(`${event.entity_type}:${event.entity_id}`, event);
  const blockEvents = [...latest.values()].filter((event) => event.entity_type === "blocks");
  const blockIds = blockEvents.map((event) => event.entity_id);
  let changedRows = [];
  if (blockIds.length) {
    const { rows } = await pool.query(
      "SELECT * FROM blocks WHERE workspace_id = $1 AND id = ANY($2::text[])",
      [workspaceId, blockIds]
    );
    changedRows = rows.map(blockDB.parseBlock);
  }
  const rowById = new Map(changedRows.map((row) => [row.id, row]));
  const blocks = [];
  const deletedBlockIds = [];
  for (const event of blockEvents) {
    const row = rowById.get(event.entity_id);
    if (event.operation === "delete" || !row || row.deleted_at) {
      deletedBlockIds.push(event.entity_id);
      continue;
    }
    const rowDate = dateString(row.date);
    if (rowDate === date || isGlobalBlock(row)) blocks.push(row);
  }

  const stateChanged = [...latest.values()].some(
    (event) => event.entity_type === "dcc_state" && dateString(event.entity_date) === date
  );
  const dccRow = stateChanged ? await blockDB.getDccStateCompact(date, workspaceId) : null;
  return {
    schemaVersion: 1,
    cursor: nextCursor,
    hasMore,
    blocks,
    deletedBlockIds: [...new Set(deletedBlockIds)],
    dayState: dccRow ? dccRow.state_json : null,
  };
}

async function recordTriageHistory(workspaceId, events, client) {
  const q = client || pool;
  let recorded = 0;
  for (const raw of Array.isArray(events) ? events : []) {
    if (!raw || !raw.id) continue;
    const resolvedAt = raw.resolved_at || raw.received_at || raw.last_seen_at;
    if (!resolvedAt || Number.isNaN(new Date(resolvedAt).getTime())) continue;
    const result = await q.query(
      `INSERT INTO triage_history
        (workspace_id, triage_id, resolved_at, resolution, title, source, item_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(workspace_id, triage_id, resolved_at) DO NOTHING`,
      [workspaceId, String(raw.id), resolvedAt, String(raw.resolved_reason || raw.reason || "done"),
        String(raw.title || ""), String(raw.source || raw.type || ""), raw]
    );
    recorded += result.rowCount;
  }
  return recorded;
}

async function listTriageHistory(workspaceId, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  let beforeAt = null;
  let beforeId = null;
  if (options.before) {
    const [encodedAt, encodedId] = String(options.before).split("|");
    beforeAt = encodedAt ? new Date(Number(encodedAt)).toISOString() : null;
    beforeId = Number(encodedId || 0);
  }
  const { rows } = await pool.query(
    `SELECT id, triage_id, resolved_at, resolution, title, source, item_json
       FROM triage_history
      WHERE workspace_id = $1
        AND ($2::timestamptz IS NULL OR (resolved_at, id) < ($2::timestamptz, $3::bigint))
      ORDER BY resolved_at DESC, id DESC
      LIMIT $4`,
    [workspaceId, beforeAt, beforeId, limit + 1]
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? `${new Date(last.resolved_at).getTime()}|${last.id}` : null,
  };
}

async function pruneSyncEvents(days = 30) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT workspace_id, MAX(seq)::bigint AS max_seq
         FROM sync_events
        WHERE created_at < NOW() - ($1::text || ' days')::interval
        GROUP BY workspace_id`,
      [Math.max(1, Number(days) || 30)]
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO sync_prune_watermarks(workspace_id, pruned_through_seq, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT(workspace_id) DO UPDATE SET
           pruned_through_seq = GREATEST(sync_prune_watermarks.pruned_through_seq, EXCLUDED.pruned_through_seq),
           updated_at = NOW()`,
        [row.workspace_id, row.max_seq]
      );
    }
    const result = await client.query(
      "DELETE FROM sync_events WHERE created_at < NOW() - ($1::text || ' days')::interval",
      [Math.max(1, Number(days) || 30)]
    );
    await client.query("COMMIT");
    return result.rowCount;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  bootstrap,
  pull,
  recordTriageHistory,
  listTriageHistory,
  pruneSyncEvents,
  safeCursor,
  isGlobalBlock,
};
