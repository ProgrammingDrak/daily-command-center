/**
 * gcal-sync.js — Google Calendar Sync Engine (Postgres-backed)
 *
 * Incremental sync using Google's syncToken API:
 *  1. First sync: full fetch (past 30 days -> future 60 days)
 *  2. Subsequent syncs: use syncToken -> only changed events
 *  3. Poll every 60 seconds
 *
 * Two-way: local edits -> GCal API, GCal changes -> local blocks + SSE
 */

const { google } = require("googleapis");
const crypto = require("crypto");
const gcalAuth = require("./gcal-auth");
const pool = require("./pg-pool");

const syncState = new Map();
const calendarListRefreshAt = new Map();
const CALENDAR_LIST_REFRESH_MS = 15 * 60 * 1000;
const APP_TIME_ZONE = process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York";
const GENERATED_CALENDAR_RE = /\b(time\s*blocking|daily command center|dcc generated|dcc time|codex packet)\b/i;
let _pollTimer = null;
let _broadcast = null;
let _syncInProgress = false;
let _defaultUserId = null;

async function init(broadcastFn, defaultUserId) {
  _broadcast = broadcastFn;
  _defaultUserId = defaultUserId || null;
  await gcalAuth.ensureMultiAccountSchema();
  const { rows } = await pool.query("SELECT * FROM gcal_sync_state");
  for (const row of rows) {
    syncState.set(syncKey(row.account_key || gcalAuth.DEFAULT_ACCOUNT_KEY, row.calendar_id), { syncToken: row.sync_token, fullSync: !!row.full_sync });
  }
}

function startPolling(intervalMs = 60000) {
  if (_pollTimer) clearInterval(_pollTimer);
  syncAll(_defaultUserId, { forceFull: true }).catch((e) => console.error("[gcal-sync] Initial sync error:", e.message));
  _pollTimer = setInterval(() => { syncAll(_defaultUserId).catch((e) => console.error("[gcal-sync] Poll error:", e.message)); }, intervalMs);
  console.log(`[gcal-sync] Polling started (every ${intervalMs / 1000}s)`);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; console.log("[gcal-sync] Polling stopped"); }
}

async function syncAll(userId, options = {}) {
  if (_syncInProgress) return;
  const uid = userId || _defaultUserId;
  const accounts = await gcalAuth.listAuthenticatedAccounts(uid);
  if (!accounts.length) return;
  _syncInProgress = true;
  let totalChanged = 0;
  try {
    for (const account of accounts) {
      const auth = await gcalAuth.getAuthClient(uid, account.key);
      if (!auth) continue;
      const fetched = await refreshCalendarsIfDue(auth, account, !!options.forceFull);
      let calendars = await getSelectedCalendars(account.key);
      if (!calendars.length) {
        if (!calendars.length && fetched.length) {
          const primary = fetched.find((c) => c.primary) || fetched[0];
          await pool.query("UPDATE gcal_calendars SET selected = TRUE WHERE id = $1 AND account_key = $2", [primary.id, account.key]);
        }
      }
      const selectedCals = await getSelectedCalendars(account.key);
      for (const cal of selectedCals) { totalChanged += await syncCalendar(auth, cal.id, account.key, cal.summary, options); }
    }
    if (totalChanged > 0 && _broadcast) _broadcast("gcal-sync", { changed: totalChanged, timestamp: new Date().toISOString() });
    return totalChanged;
  } finally { _syncInProgress = false; }
}

async function refreshCalendarsIfDue(auth, account, force = false) {
  const accountKey = gcalAuth.normalizeAccountKey(account.key);
  const lastRefresh = calendarListRefreshAt.get(accountKey) || 0;
  if (!force && Date.now() - lastRefresh < CALENDAR_LIST_REFRESH_MS) return [];
  const fetched = await gcalAuth.fetchAndCacheCalendars(auth);
  await cacheCalendarsToDb(fetched, account);
  calendarListRefreshAt.set(accountKey, Date.now());
  return fetched;
}

function syncKey(accountKey, calendarId) {
  return `${gcalAuth.normalizeAccountKey(accountKey)}:${calendarId}`;
}

async function syncCalendar(auth, calendarId, accountKey = gcalAuth.DEFAULT_ACCOUNT_KEY, calendarName = null, options = {}) {
  const account = gcalAuth.normalizeAccountKey(accountKey);
  const calendar = google.calendar({ version: "v3", auth });
  const state = syncState.get(syncKey(account, calendarId)) || { syncToken: null, fullSync: true };
  let params = { calendarId, maxResults: 250, singleEvents: true, orderBy: "startTime", timeZone: APP_TIME_ZONE };
  const seenEventIds = new Set();
  let fullSyncWindow = null;
  if (state.syncToken && !state.fullSync && !options.forceFull) {
    params.syncToken = state.syncToken;
    delete params.orderBy;
  } else {
    const now = new Date(); const past = new Date(now); past.setDate(past.getDate() - 30);
    const future = new Date(now); future.setDate(future.getDate() + 60);
    params.timeMin = past.toISOString(); params.timeMax = future.toISOString();
    fullSyncWindow = { startDate: params.timeMin.slice(0, 10), endDate: params.timeMax.slice(0, 10) };
  }
  let changedCount = 0;
  try {
    let pageToken = null;
    do {
      if (pageToken) params.pageToken = pageToken;
      const res = await calendar.events.list(params);
      for (const event of res.data.items || []) {
        if (event && event.id && event.status !== "cancelled") seenEventIds.add(event.id);
        try {
          await upsertEvent(event, calendarId, account, calendarName);
          changedCount++;
        } catch (err) {
          console.error("[gcal-sync] Event import error:", {
            accountKey: account,
            calendarId,
            eventId: event && event.id,
            summary: event && event.summary,
            message: err.message,
            detail: err.detail,
            where: err.where,
            code: err.code,
          });
          throw err;
        }
      }
      pageToken = res.data.nextPageToken;
      if (res.data.nextSyncToken) {
        syncState.set(syncKey(account, calendarId), { syncToken: res.data.nextSyncToken, fullSync: false });
        await pool.query(
          `INSERT INTO gcal_sync_state (calendar_id, sync_token, last_sync_at, full_sync, account_key) VALUES ($1, $2, $3, FALSE, $4)
           ON CONFLICT(calendar_id, account_key) DO UPDATE SET sync_token = EXCLUDED.sync_token, last_sync_at = EXCLUDED.last_sync_at, full_sync = FALSE`,
          [calendarId, res.data.nextSyncToken, new Date().toISOString(), account]
        );
      }
    } while (pageToken);
    if (fullSyncWindow) {
      changedCount += await pruneMissingEvents(calendarId, account, fullSyncWindow, Array.from(seenEventIds));
    }
  } catch (err) {
    if (err.code === 410) {
      console.log(`[gcal-sync] Sync token expired for ${calendarId}, doing full sync`);
      syncState.set(syncKey(account, calendarId), { syncToken: null, fullSync: true });
      await pool.query("UPDATE gcal_sync_state SET sync_token = NULL, full_sync = TRUE WHERE calendar_id = $1 AND account_key = $2", [calendarId, account]);
      return syncCalendar(auth, calendarId, account, calendarName, { ...options, forceFull: true });
    }
    throw err;
  }
  return changedCount;
}

async function pruneMissingEvents(calendarId, accountKey, window, seenEventIds) {
  const account = gcalAuth.normalizeAccountKey(accountKey);
  const { rows } = await pool.query(
    `SELECT g.gcal_event_id, g.block_id
     FROM gcal_events g
     JOIN blocks b ON b.id = g.block_id
     WHERE g.calendar_id = $1
       AND g.account_key = $2
       AND b.deleted_at IS NULL
       AND b.date BETWEEN $3::date AND $4::date
       AND NOT (g.gcal_event_id = ANY($5::text[]))`,
    [calendarId, account, window.startDate, window.endDate, seenEventIds]
  );
  if (!rows.length) return 0;

  const now = new Date().toISOString();
  const blockIds = rows.map(row => row.block_id).filter(Boolean);
  const eventIds = rows.map(row => row.gcal_event_id);
  if (blockIds.length) {
    await pool.query("UPDATE blocks SET deleted_at = $1, updated_at = $1 WHERE id = ANY($2::text[])", [now, blockIds]);
  }
  await pool.query(
    "DELETE FROM gcal_events WHERE calendar_id = $1 AND account_key = $2 AND gcal_event_id = ANY($3::text[])",
    [calendarId, account, eventIds]
  );
  console.log(`[gcal-sync] Pruned ${rows.length} stale event(s) from ${calendarId} (${account})`);
  return rows.length;
}

async function upsertEvent(gcalEvent, calendarId, accountKey = gcalAuth.DEFAULT_ACCOUNT_KEY, calendarName = null) {
  const account = gcalAuth.normalizeAccountKey(accountKey);
  const sourceCalendarName = calendarName || await getCalendarSummary(calendarId, account);
  const now = new Date().toISOString();
  if (gcalEvent.status === "cancelled") {
    const { rows } = await pool.query("SELECT block_id FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEvent.id, calendarId, account]);
    if (rows[0] && rows[0].block_id) {
      const { rows: br } = await pool.query("SELECT * FROM blocks WHERE id = $1 AND deleted_at IS NULL", [rows[0].block_id]);
      if (br.length > 0) await pool.query("UPDATE blocks SET deleted_at = $1, updated_at = $2 WHERE id = $3", [now, now, rows[0].block_id]);
    }
    await pool.query("DELETE FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEvent.id, calendarId, account]);
    return;
  }
  const isAllDay = !!(gcalEvent.start && gcalEvent.start.date);
  let startTime, endTime, dateStr;
  if (isAllDay) { dateStr = gcalEvent.start.date; startTime = null; endTime = null; }
  else {
    const startParts = zonedDateTimeParts(gcalEvent.start.dateTime);
    const endParts = zonedDateTimeParts(gcalEvent.end.dateTime);
    dateStr = startParts.date;
    startTime = startParts.time;
    endTime = endParts.time;
  }
  const { rows: gcalRows } = await pool.query("SELECT * FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEvent.id, calendarId, account]);
  const existingGcal = gcalRows[0];
  if (existingGcal && existingGcal.local_modified) { await updateGcalEventRow(gcalEvent, calendarId, existingGcal.block_id, now, account); return; }

  const attendees = safeParseJSON(gcalEvent.attendees, []);
  const myResponse = attendees.find((a) => a.self)?.responseStatus || null;
  const meetLink = gcalEvent.hangoutLink || (gcalEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri) || "";
  const props = {
    title: gcalEvent.summary || "(No title)", type: "meeting", start: startTime, end: endTime,
    source: "gcal", source_id: gcalEvent.id, calUrl: gcalEvent.htmlLink, detail: gcalEvent.description || "",
    hangout_link: meetLink, location: gcalEvent.location || "", rsvp_status: myResponse,
    attendee_count: attendees.length, is_recurring: !!gcalEvent.recurringEventId, all_day: isAllDay ? 1 : 0,
    gcal_event_id: gcalEvent.id, gcal_calendar_id: calendarId, gcal_calendar_name: sourceCalendarName,
    gcal_account_key: account, gcal_etag: gcalEvent.etag,
  };

  let blockId;
  if (existingGcal && existingGcal.block_id) {
    blockId = existingGcal.block_id;
    await pool.query(`UPDATE blocks SET properties = $1, date = $2, sort_order = $3, updated_at = $4 WHERE id = $5 AND deleted_at IS NULL`, [jsonbParam(props), dateStr, toSortOrder(startTime), now, blockId]);
  } else {
    blockId = "gcal-" + crypto.createHash("sha256").update(gcalEvent.id + calendarId + account).digest("hex").slice(0, 24);
    const userId = _defaultUserId || null; const workspaceId = userId ? `ws-${userId}` : null;
    const dayRootId = workspaceId && workspaceId !== "ws-1" ? `day-root-${workspaceId}-${dateStr}` : `day-root-${dateStr}`;
    const { rows: dr } = await pool.query("SELECT id FROM blocks WHERE id = $1", [dayRootId]);
    if (dr.length === 0) {
      await pool.query(`INSERT INTO blocks (id, type, date, properties, sort_order, user_id, workspace_id, created_at, updated_at) VALUES ($1, 'day_root', $2, $3, 0, $4, $5, $6, $7)`, [dayRootId, dateStr, jsonbParam({ date: dateStr }), userId, workspaceId, now, now]);
    }
    await pool.query(
      `INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at) VALUES ($1, 'block', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(id) DO UPDATE SET properties = EXCLUDED.properties, date = EXCLUDED.date, sort_order = EXCLUDED.sort_order, updated_at = EXCLUDED.updated_at, deleted_at = NULL`,
      [blockId, dayRootId, dateStr, jsonbParam(props), toSortOrder(startTime), userId, workspaceId, now, now]
    );
  }
  await updateGcalEventRow(gcalEvent, calendarId, blockId, now, account);
}

async function updateGcalEventRow(gcalEvent, calendarId, blockId, now, accountKey = gcalAuth.DEFAULT_ACCOUNT_KEY) {
  const account = gcalAuth.normalizeAccountKey(accountKey);
  const isAllDay = !!(gcalEvent.start && gcalEvent.start.date);
  const meetLink = gcalEvent.hangoutLink || (gcalEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri) || null;
  await pool.query(
    `INSERT INTO gcal_events (gcal_event_id, block_id, calendar_id, etag, summary, description, location, start_time, end_time, start_date, end_date, all_day, status, html_link, hangout_link, attendees_json, conference_json, organizer_json, creator_json, recurrence_json, recurring_event_id, visibility, transparency, ical_uid, color_id, reminders_json, raw_json, synced_at, local_modified, account_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,FALSE,$29)
     ON CONFLICT(gcal_event_id, calendar_id, account_key) DO UPDATE SET block_id=EXCLUDED.block_id, etag=EXCLUDED.etag, summary=EXCLUDED.summary, description=EXCLUDED.description, location=EXCLUDED.location, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, all_day=EXCLUDED.all_day, status=EXCLUDED.status, html_link=EXCLUDED.html_link, hangout_link=EXCLUDED.hangout_link, attendees_json=EXCLUDED.attendees_json, conference_json=EXCLUDED.conference_json, organizer_json=EXCLUDED.organizer_json, creator_json=EXCLUDED.creator_json, recurrence_json=EXCLUDED.recurrence_json, recurring_event_id=EXCLUDED.recurring_event_id, visibility=EXCLUDED.visibility, transparency=EXCLUDED.transparency, ical_uid=EXCLUDED.ical_uid, color_id=EXCLUDED.color_id, reminders_json=EXCLUDED.reminders_json, raw_json=EXCLUDED.raw_json, synced_at=EXCLUDED.synced_at`,
    [gcalEvent.id, blockId, calendarId, gcalEvent.etag||null, gcalEvent.summary||null, gcalEvent.description||null, gcalEvent.location||null,
     isAllDay?null:gcalEvent.start.dateTime, isAllDay?null:gcalEvent.end.dateTime, isAllDay?gcalEvent.start.date:null, isAllDay?gcalEvent.end.date:null,
     isAllDay, gcalEvent.status||"confirmed", gcalEvent.htmlLink||null, meetLink,
     jsonbParam(gcalEvent.attendees || []), jsonbParam(gcalEvent.conferenceData), jsonbParam(gcalEvent.organizer), jsonbParam(gcalEvent.creator), jsonbParam(gcalEvent.recurrence),
     gcalEvent.recurringEventId||null, gcalEvent.visibility||null, gcalEvent.transparency||null, gcalEvent.iCalUID||null, gcalEvent.colorId||null,
     jsonbParam(gcalEvent.reminders), jsonbParam(gcalEvent), new Date().toISOString(), account]
  );
}

async function updateEvent(gcalEventId, calendarId, changes) {
  const accountKey = changes.accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  const patch = {};
  if (changes.title !== undefined) patch.summary = changes.title;
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.location !== undefined) patch.location = changes.location;
  if (changes.start || changes.end) {
    const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
    const tz = existing.data.start.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (changes.start && changes.date) patch.start = { dateTime: toRFC3339(changes.date, changes.start), timeZone: tz };
    if (changes.end && changes.date) patch.end = { dateTime: toRFC3339(changes.date, changes.end), timeZone: tz };
  }
  const res = await calendar.events.patch({ calendarId, eventId: gcalEventId, requestBody: patch });
  await upsertEvent(res.data, calendarId, accountKey); return res.data;
}

async function addAttendee(gcalEventId, calendarId, email, accountKey = null) {
  accountKey = accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = existing.data.attendees || [];
  if (attendees.some((a) => a.email === email)) return existing.data;
  attendees.push({ email });
  const res = await calendar.events.patch({ calendarId, eventId: gcalEventId, requestBody: { attendees }, sendUpdates: "all" });
  await upsertEvent(res.data, calendarId, accountKey); return res.data;
}

async function removeAttendee(gcalEventId, calendarId, email, accountKey = null) {
  accountKey = accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = (existing.data.attendees || []).filter((a) => a.email !== email);
  const res = await calendar.events.patch({ calendarId, eventId: gcalEventId, requestBody: { attendees }, sendUpdates: "all" });
  await upsertEvent(res.data, calendarId, accountKey); return res.data;
}

async function rsvp(gcalEventId, calendarId, response, accountKey = null) {
  accountKey = accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = existing.data.attendees || [];
  for (const a of attendees) { if (a.self) a.responseStatus = response; }
  const res = await calendar.events.patch({ calendarId, eventId: gcalEventId, requestBody: { attendees }, sendUpdates: "all" });
  await upsertEvent(res.data, calendarId, accountKey); return res.data;
}

async function createEvent(calendarId, eventData) {
  const accountKey = eventData.accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    summary: eventData.title, description: eventData.description || "", location: eventData.location || "",
    start: eventData.allDay ? { date: eventData.startDate } : { dateTime: toRFC3339(eventData.date, eventData.start), timeZone: tz },
    end: eventData.allDay ? { date: eventData.endDate } : { dateTime: toRFC3339(eventData.date, eventData.end), timeZone: tz },
  };
  if (eventData.attendees && eventData.attendees.length) body.attendees = eventData.attendees.map((email) => ({ email }));
  if (eventData.addMeet) body.conferenceData = { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" }, requestId: crypto.randomUUID() } };
  const res = await calendar.events.insert({ calendarId, requestBody: body, conferenceDataVersion: eventData.addMeet ? 1 : 0, sendUpdates: "all" });
  await upsertEvent(res.data, calendarId, accountKey); return res.data;
}

async function deleteEvent(gcalEventId, calendarId, accountKey = null) {
  accountKey = accountKey || await accountKeyForCalendar(calendarId);
  const auth = await gcalAuth.getAuthClient(_defaultUserId, accountKey);
  if (!auth) throw new Error("Not authenticated");
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId, eventId: gcalEventId, sendUpdates: "all" });
  const account = gcalAuth.normalizeAccountKey(accountKey);
  const { rows } = await pool.query("SELECT block_id FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEventId, calendarId, account]);
  if (rows[0] && rows[0].block_id) {
    const now = new Date().toISOString();
    await pool.query("UPDATE blocks SET deleted_at = $1, updated_at = $2 WHERE id = $3", [now, now, rows[0].block_id]);
  }
  await pool.query("DELETE FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEventId, calendarId, account]);
}

async function getGcalEvent(gcalEventId, calendarId, accountKey = null) {
  const account = accountKey ? gcalAuth.normalizeAccountKey(accountKey) : null;
  const { rows } = account
    ? await pool.query("SELECT * FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2 AND account_key = $3", [gcalEventId, calendarId, account])
    : await pool.query("SELECT * FROM gcal_events WHERE gcal_event_id = $1 AND calendar_id = $2", [gcalEventId, calendarId]);
  return rows[0] || null;
}

async function getGcalEventByBlockId(blockId) {
  const { rows } = await pool.query("SELECT * FROM gcal_events WHERE block_id = $1", [blockId]);
  return rows[0] || null;
}

async function accountKeyForCalendar(calendarId) {
  const { rows } = await pool.query("SELECT account_key FROM gcal_calendars WHERE id = $1 LIMIT 1", [calendarId]);
  return rows[0]?.account_key || gcalAuth.DEFAULT_ACCOUNT_KEY;
}

async function getCalendarSummary(calendarId, accountKey = gcalAuth.DEFAULT_ACCOUNT_KEY) {
  const { rows } = await pool.query(
    "SELECT summary FROM gcal_calendars WHERE id = $1 AND account_key = $2 LIMIT 1",
    [calendarId, gcalAuth.normalizeAccountKey(accountKey)]
  );
  return rows[0]?.summary || "";
}

async function getSelectedCalendars(accountKey = null) {
  if (accountKey) {
    const { rows } = await pool.query("SELECT * FROM gcal_calendars WHERE selected = TRUE AND account_key = $1", [gcalAuth.normalizeAccountKey(accountKey)]);
    return rows;
  }
  const { rows } = await pool.query("SELECT * FROM gcal_calendars WHERE selected = TRUE");
  return rows;
}
async function getAllCalendars() { const { rows } = await pool.query("SELECT * FROM gcal_calendars ORDER BY account_key ASC, is_primary DESC, summary ASC"); return rows; }
async function toggleCalendar(calendarId, selected, accountKey = null) {
  const now = new Date().toISOString();
  if (accountKey) {
    await pool.query("UPDATE gcal_calendars SET selected = $1, updated_at = $2 WHERE id = $3 AND account_key = $4", [!!selected, now, calendarId, gcalAuth.normalizeAccountKey(accountKey)]);
    return;
  }
  await pool.query("UPDATE gcal_calendars SET selected = $1, updated_at = $2 WHERE id = $3", [!!selected, now, calendarId]);
}

async function cacheCalendarsToDb(calendars, account = { key: gcalAuth.DEFAULT_ACCOUNT_KEY, email: null }) {
  const now = new Date().toISOString();
  const accountKey = gcalAuth.normalizeAccountKey(account.key);
  const fetchedIds = [];
  for (const cal of calendars) {
    fetchedIds.push(cal.id);
    const defaultSelected = cal.selected !== false && !GENERATED_CALENDAR_RE.test(cal.summary || "");
    await pool.query(
      `INSERT INTO gcal_calendars (id, summary, description, background_color, foreground_color, is_primary, access_role, selected, updated_at, account_key, account_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id, account_key) DO UPDATE SET summary=EXCLUDED.summary, description=EXCLUDED.description, background_color=EXCLUDED.background_color, foreground_color=EXCLUDED.foreground_color, is_primary=EXCLUDED.is_primary, access_role=EXCLUDED.access_role, updated_at=EXCLUDED.updated_at, account_email=EXCLUDED.account_email`,
      [cal.id, cal.summary, cal.description||"", cal.backgroundColor||"#4285f4", cal.foregroundColor||"#ffffff", !!cal.primary, cal.accessRole||"reader", defaultSelected, now, accountKey, account.email || null]
    );
  }
  if (fetchedIds.length) {
    await pool.query(
      "UPDATE gcal_calendars SET selected = FALSE, updated_at = $2 WHERE account_key = $1 AND NOT (id = ANY($3::text[]))",
      [accountKey, now, fetchedIds]
    );
  }
}

function toSortOrder(startTime) { if (!startTime) return 0; const [h, m] = startTime.split(":").map(Number); return h * 100 + m; }
function toRFC3339(dateStr, timeStr) { return new Date(`${dateStr}T${timeStr}:00`).toISOString(); }
function jsonbParam(value) { return value == null ? null : JSON.stringify(value); }
function safeParseJSON(val, fallback) { if (Array.isArray(val)) return val; if (typeof val === "object" && val !== null) return val; if (!val) return fallback; try { return JSON.parse(val); } catch { return fallback; } }
function zonedDateTimeParts(value, timeZone = APP_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid calendar date: ${value}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

async function getSyncStatus() {
  const calendars = await getSelectedCalendars();
  const accounts = await gcalAuth.listAuthenticatedAccounts(_defaultUserId);
  const states = [];
  for (const cal of calendars) {
    const { rows } = await pool.query("SELECT * FROM gcal_sync_state WHERE calendar_id = $1 AND account_key = $2", [cal.id, cal.account_key || gcalAuth.DEFAULT_ACCOUNT_KEY]);
    states.push({ calendarId: cal.id, calendarName: cal.summary, accountKey: cal.account_key || gcalAuth.DEFAULT_ACCOUNT_KEY, lastSyncAt: rows[0]?.last_sync_at || null, hasSyncToken: !!rows[0]?.sync_token });
  }
  return { connected: accounts.length > 0, accounts, syncing: _syncInProgress, calendars: states };
}

module.exports = {
  init, startPolling, stopPolling, syncAll, syncCalendar,
  updateEvent, addAttendee, removeAttendee, rsvp, createEvent, deleteEvent,
  getGcalEvent, getGcalEventByBlockId, getSelectedCalendars, getAllCalendars,
  toggleCalendar, cacheCalendarsToDb, getSyncStatus,
};
