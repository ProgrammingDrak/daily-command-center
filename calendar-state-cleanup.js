/**
 * One-time Google Calendar state cleanup.
 *
 * Rewrites saved PA timeline calendar items from the live, synced Google
 * Calendar blocks so deleted events no longer survive in old state snapshots.
 */

const pool = require("./pg-pool");

const RUN_KEY = "calendar-state-gcal-authoritative-20260513";
const LOOKBACK_DAYS = 90;
const LOOKAHEAD_DAYS = 365;

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function isCalendarItem(item) {
  return !!item && (item.source === "calendar" || item.source === "gcal" || !!item.gcal_calendar_id || !!item.gcal_event_id);
}

function cleanTitle(value) {
  return String(value || "Untitled").trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeKey(item) {
  const title = cleanTitle(item.title || item.label);
  return item.dedupeKey || `title:${title}|${item.start || ""}|${item.end || ""}`;
}

function identityKey(item) {
  const eventId = item.gcal_event_id || item.source_id;
  if (eventId) return ["id", item.gcal_account_key || "default", item.gcal_calendar_id || "", eventId].join("|");
  return `dedupe|${dedupeKey(item)}`;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function localIso(dateStr, time) {
  return dateStr && time ? `${dateStr}T${time}:00` : null;
}

function dateWindow(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const end = new Date(now);
  end.setDate(end.getDate() + LOOKAHEAD_DAYS);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function buildLiveItem(row, dateStr) {
  const props = parseJson(row.properties, {});
  if (!props || props.source !== "gcal" || props.all_day || !props.start || !props.end) return null;
  const eventId = row.gcal_event_id || props.gcal_event_id || props.source_id;
  const start = toIso(row.gcal_start_time) || localIso(dateStr, props.start);
  const end = toIso(row.gcal_end_time) || localIso(dateStr, props.end);
  if (!start || !end) return null;
  const title = props.title || row.summary || "(No title)";
  const detail = props.detail || props.description || row.description || "";
  const item = {
    id: row.id,
    type: "meeting",
    label: title,
    start,
    end,
    source: "gcal",
    source_id: eventId,
    category: "Meetings",
    completed: false,
    description: detail,
    notes: detail,
    calendar_link: props.calUrl || row.html_link || null,
    hangout_link: props.hangout_link || row.hangout_link || null,
    location: props.location || row.location || "",
    rsvp_status: props.rsvp_status || null,
    attendee_count: props.attendee_count || 0,
    is_recurring: !!props.is_recurring,
    all_day: !!props.all_day,
    gcal_event_id: eventId,
    gcal_calendar_id: props.gcal_calendar_id || row.calendar_id || null,
    gcal_calendar_name: props.gcal_calendar_name || row.calendar_summary || null,
    gcal_account_key: props.gcal_account_key || row.account_key || "default",
  };
  item.dedupeKey = row.ical_uid ? `ical:${row.ical_uid}|${item.start}|${item.end}` : dedupeKey(item);
  return item;
}

async function ensureMaintenanceTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      key TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL,
      result JSONB NOT NULL DEFAULT '{}'
    )
  `);
}

async function loadLiveTimeline(dateStr, userId, workspaceId) {
  const params = [dateStr];
  let ownerWhere = "";
  if (workspaceId) {
    params.push(workspaceId);
    ownerWhere = `AND b.workspace_id = $${params.length}`;
  } else if (userId) {
    params.push(userId);
    ownerWhere = `AND b.user_id = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT b.id, b.properties,
           g.gcal_event_id, g.html_link, g.hangout_link, g.location, g.description, g.summary,
           g.ical_uid, g.start_time AS gcal_start_time, g.end_time AS gcal_end_time,
           g.calendar_id, g.account_key, c.summary AS calendar_summary
    FROM blocks b
    LEFT JOIN gcal_events g ON g.block_id = b.id
    LEFT JOIN gcal_calendars c ON c.id = g.calendar_id AND c.account_key = g.account_key
    WHERE b.date = $1
      ${ownerWhere}
      AND b.deleted_at IS NULL
      AND b.type IN ('schedule_item', 'block')
      AND (b.properties->>'source' = 'gcal' OR b.properties ? 'gcal_event_id' OR g.block_id IS NOT NULL)
    ORDER BY b.sort_order ASC, b.created_at ASC
  `, params);

  const seen = new Set();
  const live = [];
  for (const row of rows) {
    const item = buildLiveItem(row, dateStr);
    if (!item) continue;
    const key = identityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    live.push(item);
  }
  return live;
}

function reconcileTimeline(timeline, liveTimeline, stats) {
  const liveById = new Map(liveTimeline.map(item => [identityKey(item), item]));
  const liveByDedupe = new Map(liveTimeline.map(item => [dedupeKey(item), item]));
  const used = new Set();
  const next = [];

  for (const item of timeline || []) {
    if (!isCalendarItem(item)) {
      next.push(item);
      continue;
    }
    const replacement = liveById.get(identityKey(item)) || liveByDedupe.get(dedupeKey(item));
    if (!replacement) {
      stats.removed += 1;
      continue;
    }
    const key = identityKey(replacement);
    if (used.has(key)) {
      stats.removed += 1;
      continue;
    }
    next.push({ ...item, ...replacement, completed: !!(item.completed || replacement.completed) });
    used.add(key);
    stats.replaced += 1;
  }

  for (const item of liveTimeline) {
    const key = identityKey(item);
    if (!used.has(key)) {
      next.push(item);
      used.add(key);
      stats.added += 1;
    }
  }

  return next.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
}

async function fullSyncAuthenticatedUsers(gcalSync) {
  const { rows } = await pool.query(`
    SELECT DISTINCT user_id AS id FROM gcal_tokens WHERE tokens IS NOT NULL
    UNION
    SELECT DISTINCT user_id AS id FROM gcal_account_tokens WHERE tokens IS NOT NULL
    ORDER BY id
  `);
  let syncedUsers = 0;
  let changedEvents = 0;
  for (const user of rows) {
    const changed = await gcalSync.syncAll(user.id, { forceFull: true });
    syncedUsers += 1;
    changedEvents += changed || 0;
    console.log(`[calendar-cleanup] Full GCal sync user=${user.id} changed=${changed || 0}`);
  }
  return { syncedUsers, changedEvents };
}

async function rewritePaStateWindow(startDate, endDate) {
  const { rows } = await pool.query(
    `SELECT date, state_json, user_id, workspace_id
     FROM pa_state
     WHERE date >= $1 AND date <= $2
     ORDER BY date ASC`,
    [startDate, endDate]
  );

  const stats = { scanned: rows.length, updated: 0, removed: 0, added: 0, replaced: 0 };
  for (const row of rows) {
    const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
    const state = parseJson(row.state_json, null);
    if (!state || !state.schedule || !Array.isArray(state.schedule.timeline)) continue;

    const before = JSON.stringify(state.schedule.timeline);
    const live = await loadLiveTimeline(dateStr, row.user_id, row.workspace_id);
    const nextTimeline = reconcileTimeline(state.schedule.timeline, live, stats);
    const after = JSON.stringify(nextTimeline);
    if (before === after) continue;

    state.schedule.timeline = nextTimeline;
    state.meetings = live.map(item => ({
      id: item.gcal_event_id || item.source_id,
      event_id: item.gcal_event_id || item.source_id,
      block_id: item.id,
      title: item.label,
      start: item.start,
      end: item.end,
      calUrl: item.calendar_link,
      myResponseStatus: item.rsvp_status,
      description: item.description,
      gcal_calendar_id: item.gcal_calendar_id,
      gcal_calendar_name: item.gcal_calendar_name,
      gcal_account_key: item.gcal_account_key,
    }));

    await pool.query(
      `UPDATE pa_state SET state_json = $1, updated_at = NOW() WHERE date = $2 AND workspace_id = $3`,
      [state, dateStr, row.workspace_id]
    );
    stats.updated += 1;
  }
  return stats;
}

async function runOnce({ gcalSync, now = new Date() }) {
  await ensureMaintenanceTable();
  const lockResult = await pool.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [RUN_KEY]);
  if (!lockResult.rows[0]?.locked) {
    console.log("[calendar-cleanup] Another cleanup runner owns the lock; skipping.");
    return null;
  }

  try {
    const existing = await pool.query("SELECT ran_at, result FROM maintenance_runs WHERE key = $1", [RUN_KEY]);
    if (existing.rows.length) {
      console.log(`[calendar-cleanup] Already ran at ${existing.rows[0].ran_at.toISOString()}; skipping.`);
      return existing.rows[0].result;
    }

    const { startDate, endDate } = dateWindow(now);
    const backupName = `pa_state_calendar_cleanup_backup_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    console.log(`[calendar-cleanup] Window ${startDate} to ${endDate}`);
    await pool.query(`CREATE TABLE ${backupName} AS SELECT * FROM pa_state`);
    console.log(`[calendar-cleanup] Backup table created: ${backupName}`);

    const syncStats = await fullSyncAuthenticatedUsers(gcalSync);
    const stateStats = await rewritePaStateWindow(startDate, endDate);
    const result = { backupName, startDate, endDate, ...syncStats, ...stateStats };

    await pool.query(
      "INSERT INTO maintenance_runs (key, ran_at, result) VALUES ($1, NOW(), $2)",
      [RUN_KEY, result]
    );
    console.log(`[calendar-cleanup] Done ${JSON.stringify(result)}`);
    return result;
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [RUN_KEY]);
  }
}

module.exports = { runOnce };
