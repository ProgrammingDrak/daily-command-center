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

function parseHistoryCursor(value) {
  if (!value) return { beforeAt: null, beforeId: null };
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d+)$/.exec(String(value));
  if (!match || Number.isNaN(Date.parse(match[1]))) {
    const error = new Error("invalid history cursor");
    error.status = 400;
    error.code = "invalid_cursor";
    throw error;
  }
  return { beforeAt: match[1], beforeId: match[2] };
}

function dateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isGlobalBlock(row) {
  const props = row && row.properties || {};
  if (props.kind === "triage_suppression") return false;
  return GLOBAL_TYPES.includes(row.type)
    || (row.type === "block" && !row.date)
    || (row.type === "block" && Array.isArray(props.tags) && props.tags.includes("pinned"));
}

function isAllDayBlockOnDate(row, date) {
  const props = row && row.properties || {};
  const start = String(props.all_day_start || "");
  const end = String(props.all_day_end || "");
  const allDay = props.all_day === true || props.all_day === "true";
  return allDay && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
    && start <= date && end > date;
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
        AND COALESCE(properties->>'kind', '') <> 'triage_suppression'
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
    const [blocks, globals] = await Promise.all([
      readDayBlocks(client, workspaceId, date),
      readGlobalBlocks(client, workspaceId),
    ]);
    await client.query("COMMIT");
    return {
      schemaVersion: 1,
      workspaceId,
      date,
      cursor,
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
  if (floor > 0 && cursor <= floor) {
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
    if (rowDate === date || isAllDayBlockOnDate(row, date) || isGlobalBlock(row)) blocks.push(row);
    else deletedBlockIds.push(event.entity_id);
  }

  const stateChanged = [...latest.values()].some(
    (event) => event.entity_type === "dcc_state" && dateString(event.entity_date) === date
  );
  return {
    schemaVersion: 1,
    cursor: nextCursor,
    hasMore,
    blocks,
    deletedBlockIds: [...new Set(deletedBlockIds)],
    dayStateChanged: stateChanged,
  };
}

async function recordTriageHistory(workspaceId, events, client) {
  const q = client || pool;
  const normalized = [];
  for (const raw of Array.isArray(events) ? events : []) {
    if (!raw || !raw.id) continue;
    const resolvedAt = raw.resolved_at || raw.received_at || raw.last_seen_at;
    if (!resolvedAt || Number.isNaN(new Date(resolvedAt).getTime())) continue;
    normalized.push({
      triage_id: String(raw.id),
      resolved_at: resolvedAt,
      resolution: String(raw.resolved_reason || raw.reason || "done"),
      title: String(raw.title || ""),
      source: String(raw.source || raw.type || ""),
      item_json: raw,
    });
  }
  if (!normalized.length) return 0;
  const result = await q.query(
    `INSERT INTO triage_history
      (workspace_id, triage_id, resolved_at, resolution, title, source, item_json)
     SELECT $1, item->>'triage_id', (item->>'resolved_at')::timestamptz,
            item->>'resolution', item->>'title', item->>'source', item->'item_json'
       FROM jsonb_array_elements($2::jsonb) AS input(item)
     ON CONFLICT(workspace_id, triage_id, resolved_at) DO NOTHING`,
    [workspaceId, JSON.stringify(normalized)]
  );
  return result.rowCount;
}

async function listTriageHistory(workspaceId, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const { beforeAt, beforeId } = parseHistoryCursor(options.before);
  const { rows } = await pool.query(
    `SELECT id, triage_id, resolved_at, resolution, title, source, item_json,
            to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_cursor_at
       FROM triage_history
      WHERE workspace_id = $1
        AND ($2::timestamptz IS NULL OR (resolved_at, id) < ($2::timestamptz, $3::bigint))
      ORDER BY resolved_at DESC, id DESC
      LIMIT $4`,
    [workspaceId, beforeAt, beforeId, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const items = page.map(({ resolved_cursor_at: ignored, ...row }) => row);
  return {
    items,
    nextCursor: hasMore && last ? `${last.resolved_cursor_at}|${last.id}` : null,
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
  parseHistoryCursor,
  isGlobalBlock,
  isAllDayBlockOnDate,
};
