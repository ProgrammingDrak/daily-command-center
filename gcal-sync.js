/**
 * gcal-sync.js — Google Calendar Sync Engine
 *
 * Incremental sync using Google's syncToken API:
 *  1. First sync: full fetch (past 30 days → future 60 days)
 *  2. Subsequent syncs: use syncToken → only changed events
 *  3. Poll every 60 seconds
 *
 * Two-way: local edits → GCal API, GCal changes → local blocks + SSE
 */

const { google } = require("googleapis");
const crypto = require("crypto");
const gcalAuth = require("./gcal-auth");

// In-memory sync state (persisted to SQLite via gcal_sync_state)
const syncState = new Map(); // calendarId → { syncToken, pageToken }

let _pollTimer = null;
let _db = null;
let _broadcast = null;
let _syncInProgress = false;

// ── Initialization ──

function init(db, broadcastFn) {
  _db = db;
  _broadcast = broadcastFn;

  // Ensure gcal tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS gcal_events (
      gcal_event_id   TEXT NOT NULL,
      block_id        TEXT,
      calendar_id     TEXT NOT NULL,
      etag            TEXT,
      summary         TEXT,
      description     TEXT,
      location        TEXT,
      start_time      TEXT,
      end_time        TEXT,
      start_date      TEXT,
      end_date        TEXT,
      all_day         INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'confirmed',
      html_link       TEXT,
      hangout_link    TEXT,
      attendees_json  TEXT DEFAULT '[]',
      conference_json TEXT,
      organizer_json  TEXT,
      creator_json    TEXT,
      recurrence_json TEXT,
      recurring_event_id TEXT,
      visibility      TEXT,
      transparency    TEXT,
      ical_uid        TEXT,
      color_id        TEXT,
      reminders_json  TEXT,
      raw_json        TEXT,
      synced_at       TEXT NOT NULL,
      local_modified  INTEGER DEFAULT 0,
      PRIMARY KEY (gcal_event_id, calendar_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gcal_events_block
      ON gcal_events(block_id) WHERE block_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gcal_events_start
      ON gcal_events(start_time);

    CREATE TABLE IF NOT EXISTS gcal_sync_state (
      calendar_id   TEXT PRIMARY KEY,
      sync_token    TEXT,
      last_sync_at  TEXT,
      full_sync     INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gcal_calendars (
      id              TEXT PRIMARY KEY,
      summary         TEXT,
      description     TEXT,
      background_color TEXT,
      foreground_color TEXT,
      is_primary      INTEGER DEFAULT 0,
      access_role     TEXT,
      selected        INTEGER DEFAULT 1,
      updated_at      TEXT
    );
  `);

  // Load sync state from DB
  const rows = _db.prepare("SELECT * FROM gcal_sync_state").all();
  for (const row of rows) {
    syncState.set(row.calendar_id, {
      syncToken: row.sync_token,
      fullSync: !!row.full_sync,
    });
  }
}

// ── Start/Stop Polling ──

function startPolling(intervalMs = 60000) {
  if (_pollTimer) clearInterval(_pollTimer);
  // Do an initial sync immediately
  syncAll().catch((e) => console.error("[gcal-sync] Initial sync error:", e.message));
  _pollTimer = setInterval(() => {
    syncAll().catch((e) => console.error("[gcal-sync] Poll error:", e.message));
  }, intervalMs);
  console.log(`[gcal-sync] Polling started (every ${intervalMs / 1000}s)`);
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    console.log("[gcal-sync] Polling stopped");
  }
}

// ── Full Sync Cycle ──

async function syncAll() {
  if (_syncInProgress) return;
  if (!gcalAuth.isAuthenticated()) return;

  _syncInProgress = true;
  try {
    const auth = gcalAuth.getAuthClient();
    if (!auth) return;

    // Get selected calendars
    const calendars = getSelectedCalendars();
    if (!calendars.length) {
      // First time: fetch calendar list and select primary
      const fetched = await gcalAuth.fetchAndCacheCalendars(auth);
      cacheCalendarsToDb(fetched);
      // Re-fetch selected
      const selected = getSelectedCalendars();
      if (!selected.length && fetched.length) {
        // Select primary or first
        const primary = fetched.find((c) => c.primary) || fetched[0];
        _db.prepare("UPDATE gcal_calendars SET selected = 1 WHERE id = ?").run(primary.id);
      }
    }

    const selectedCals = getSelectedCalendars();
    let totalChanged = 0;

    for (const cal of selectedCals) {
      const changed = await syncCalendar(auth, cal.id);
      totalChanged += changed;
    }

    if (totalChanged > 0 && _broadcast) {
      _broadcast("gcal-sync", { changed: totalChanged, timestamp: new Date().toISOString() });
    }
  } finally {
    _syncInProgress = false;
  }
}

// ── Single Calendar Sync ──

async function syncCalendar(auth, calendarId) {
  const calendar = google.calendar({ version: "v3", auth });
  const state = syncState.get(calendarId) || { syncToken: null, fullSync: true };

  let params = {
    calendarId,
    maxResults: 250,
    singleEvents: true,
    orderBy: "startTime",
  };

  if (state.syncToken && !state.fullSync) {
    // Incremental sync
    params.syncToken = state.syncToken;
    // Remove orderBy and singleEvents for sync token requests
    delete params.orderBy;
    delete params.singleEvents;
  } else {
    // Full sync: past 30 days to future 60 days
    const now = new Date();
    const past = new Date(now);
    past.setDate(past.getDate() - 30);
    const future = new Date(now);
    future.setDate(future.getDate() + 60);
    params.timeMin = past.toISOString();
    params.timeMax = future.toISOString();
  }

  let changedCount = 0;

  try {
    let pageToken = null;
    do {
      if (pageToken) params.pageToken = pageToken;
      const res = await calendar.events.list(params);

      for (const event of res.data.items || []) {
        upsertEvent(event, calendarId);
        changedCount++;
      }

      pageToken = res.data.nextPageToken;

      // Save sync token when done
      if (res.data.nextSyncToken) {
        syncState.set(calendarId, { syncToken: res.data.nextSyncToken, fullSync: false });
        _db.prepare(`
          INSERT INTO gcal_sync_state (calendar_id, sync_token, last_sync_at, full_sync)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(calendar_id) DO UPDATE SET
            sync_token = excluded.sync_token,
            last_sync_at = excluded.last_sync_at,
            full_sync = 0
        `).run(calendarId, res.data.nextSyncToken, new Date().toISOString());
      }
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) {
      // Sync token expired — do full sync
      console.log(`[gcal-sync] Sync token expired for ${calendarId}, doing full sync`);
      syncState.set(calendarId, { syncToken: null, fullSync: true });
      _db.prepare("UPDATE gcal_sync_state SET sync_token = NULL, full_sync = 1 WHERE calendar_id = ?").run(calendarId);
      return syncCalendar(auth, calendarId);
    }
    throw err;
  }

  return changedCount;
}

// ── Event Upsert (GCal → Local) ──

function upsertEvent(gcalEvent, calendarId) {
  const now = new Date().toISOString();

  // Handle cancelled events
  if (gcalEvent.status === "cancelled") {
    // Remove from gcal_events and soft-delete block
    const existing = _db.prepare(
      "SELECT block_id FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?"
    ).get(gcalEvent.id, calendarId);

    if (existing && existing.block_id) {
      const block = _db.prepare("SELECT * FROM blocks WHERE id = ? AND deleted_at IS NULL").get(existing.block_id);
      if (block) {
        _db.prepare("UPDATE blocks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.block_id);
      }
    }
    _db.prepare("DELETE FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?").run(gcalEvent.id, calendarId);
    return;
  }

  // Parse start/end
  const isAllDay = !!(gcalEvent.start && gcalEvent.start.date);
  let startTime, endTime, startDate, endDate, dateStr;

  if (isAllDay) {
    startDate = gcalEvent.start.date;
    endDate = gcalEvent.end.date;
    dateStr = startDate;
    startTime = null;
    endTime = null;
  } else {
    const startDt = new Date(gcalEvent.start.dateTime);
    const endDt = new Date(gcalEvent.end.dateTime);
    startTime = gcalEvent.start.dateTime;
    endTime = gcalEvent.end.dateTime;
    dateStr = startDt.toISOString().slice(0, 10);

    // Convert to HH:MM for block properties
    const startHHMM = String(startDt.getHours()).padStart(2, "0") + ":" + String(startDt.getMinutes()).padStart(2, "0");
    const endHHMM = String(endDt.getHours()).padStart(2, "0") + ":" + String(endDt.getMinutes()).padStart(2, "0");
    startTime = startHHMM;
    endTime = endHHMM;
  }

  // Check if local version has been modified (don't overwrite user edits)
  const existingGcal = _db.prepare(
    "SELECT * FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?"
  ).get(gcalEvent.id, calendarId);

  if (existingGcal && existingGcal.local_modified) {
    // Only update gcal_events metadata, don't touch the block
    updateGcalEventRow(gcalEvent, calendarId, existingGcal.block_id, now);
    return;
  }

  // Get or create block
  let blockId;
  if (existingGcal && existingGcal.block_id) {
    blockId = existingGcal.block_id;
    // Update existing block
    const attendees = safeParseJSON(gcalEvent.attendees, []);
    const myResponse = attendees.find((a) => a.self)?.responseStatus || null;
    const attendeeCount = attendees.length;

    const props = {
      title: gcalEvent.summary || "(No title)",
      type: "meeting",
      start: startTime,
      end: endTime,
      source: "gcal",
      source_id: gcalEvent.id,
      calUrl: gcalEvent.htmlLink,
      detail: gcalEvent.description || "",
      hangout_link: gcalEvent.hangoutLink || (gcalEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri) || "",
      location: gcalEvent.location || "",
      rsvp_status: myResponse,
      attendee_count: attendeeCount,
      is_recurring: !!gcalEvent.recurringEventId,
      all_day: isAllDay ? 1 : 0,
      gcal_event_id: gcalEvent.id,
      gcal_calendar_id: calendarId,
      gcal_etag: gcalEvent.etag,
    };

    _db.prepare(`
      UPDATE blocks SET properties = ?, date = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(JSON.stringify(props), dateStr, now, blockId);
  } else {
    // Create new block
    blockId = "gcal-" + crypto.createHash("sha256").update(gcalEvent.id + calendarId).digest("hex").slice(0, 24);
    const attendees = safeParseJSON(gcalEvent.attendees, []);
    const myResponse = attendees.find((a) => a.self)?.responseStatus || null;

    const props = {
      title: gcalEvent.summary || "(No title)",
      type: "meeting",
      start: startTime,
      end: endTime,
      source: "gcal",
      source_id: gcalEvent.id,
      calUrl: gcalEvent.htmlLink,
      detail: gcalEvent.description || "",
      hangout_link: gcalEvent.hangoutLink || (gcalEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri) || "",
      location: gcalEvent.location || "",
      rsvp_status: myResponse,
      attendee_count: (attendees || []).length,
      is_recurring: !!gcalEvent.recurringEventId,
      all_day: isAllDay ? 1 : 0,
      gcal_event_id: gcalEvent.id,
      gcal_calendar_id: calendarId,
      gcal_etag: gcalEvent.etag,
    };

    // Ensure day root exists
    const dayRootId = `day-root-${dateStr}`;
    const dayRoot = _db.prepare("SELECT id FROM blocks WHERE id = ?").get(dayRootId);
    if (!dayRoot) {
      _db.prepare(`
        INSERT INTO blocks (id, type, date, properties, sort_order, created_at, updated_at)
        VALUES (?, 'day_root', ?, ?, 0, ?, ?)
      `).run(dayRootId, dateStr, JSON.stringify({ date: dateStr }), now, now);
    }

    // Insert or replace block (upsert)
    _db.prepare(`
      INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, created_at, updated_at)
      VALUES (?, 'schedule_item', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        properties = excluded.properties,
        date = excluded.date,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `).run(blockId, dayRootId, dateStr, JSON.stringify(props), toSortOrder(startTime), now, now);
  }

  // Update gcal_events metadata
  updateGcalEventRow(gcalEvent, calendarId, blockId, now);
}

function updateGcalEventRow(gcalEvent, calendarId, blockId, now) {
  const isAllDay = !!(gcalEvent.start && gcalEvent.start.date);
  const meetLink = gcalEvent.hangoutLink ||
    (gcalEvent.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri) || null;

  _db.prepare(`
    INSERT INTO gcal_events (
      gcal_event_id, block_id, calendar_id, etag, summary, description,
      location, start_time, end_time, start_date, end_date, all_day,
      status, html_link, hangout_link, attendees_json, conference_json,
      organizer_json, creator_json, recurrence_json, recurring_event_id,
      visibility, transparency, ical_uid, color_id, reminders_json,
      raw_json, synced_at, local_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(gcal_event_id, calendar_id) DO UPDATE SET
      block_id = excluded.block_id,
      etag = excluded.etag,
      summary = excluded.summary,
      description = excluded.description,
      location = excluded.location,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      all_day = excluded.all_day,
      status = excluded.status,
      html_link = excluded.html_link,
      hangout_link = excluded.hangout_link,
      attendees_json = excluded.attendees_json,
      conference_json = excluded.conference_json,
      organizer_json = excluded.organizer_json,
      creator_json = excluded.creator_json,
      recurrence_json = excluded.recurrence_json,
      recurring_event_id = excluded.recurring_event_id,
      visibility = excluded.visibility,
      transparency = excluded.transparency,
      ical_uid = excluded.ical_uid,
      color_id = excluded.color_id,
      reminders_json = excluded.reminders_json,
      raw_json = excluded.raw_json,
      synced_at = excluded.synced_at
  `).run(
    gcalEvent.id,
    blockId,
    calendarId,
    gcalEvent.etag || null,
    gcalEvent.summary || null,
    gcalEvent.description || null,
    gcalEvent.location || null,
    isAllDay ? null : gcalEvent.start.dateTime,
    isAllDay ? null : gcalEvent.end.dateTime,
    isAllDay ? gcalEvent.start.date : null,
    isAllDay ? gcalEvent.end.date : null,
    isAllDay ? 1 : 0,
    gcalEvent.status || "confirmed",
    gcalEvent.htmlLink || null,
    meetLink,
    JSON.stringify(gcalEvent.attendees || []),
    gcalEvent.conferenceData ? JSON.stringify(gcalEvent.conferenceData) : null,
    gcalEvent.organizer ? JSON.stringify(gcalEvent.organizer) : null,
    gcalEvent.creator ? JSON.stringify(gcalEvent.creator) : null,
    gcalEvent.recurrence ? JSON.stringify(gcalEvent.recurrence) : null,
    gcalEvent.recurringEventId || null,
    gcalEvent.visibility || null,
    gcalEvent.transparency || null,
    gcalEvent.iCalUID || null,
    gcalEvent.colorId || null,
    gcalEvent.reminders ? JSON.stringify(gcalEvent.reminders) : null,
    JSON.stringify(gcalEvent),
    new Date().toISOString()
  );
}

// ── Write Operations (Local → GCal) ──

async function updateEvent(gcalEventId, calendarId, changes) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });

  // Build patch body
  const patch = {};
  if (changes.title !== undefined) patch.summary = changes.title;
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.location !== undefined) patch.location = changes.location;

  if (changes.start || changes.end) {
    // Get existing event to preserve timezone
    const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
    const tz = existing.data.start.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (changes.start && changes.date) {
      patch.start = { dateTime: toRFC3339(changes.date, changes.start, tz), timeZone: tz };
    }
    if (changes.end && changes.date) {
      patch.end = { dateTime: toRFC3339(changes.date, changes.end, tz), timeZone: tz };
    }
  }

  const res = await calendar.events.patch({
    calendarId,
    eventId: gcalEventId,
    requestBody: patch,
  });

  // Update local state
  upsertEvent(res.data, calendarId);
  return res.data;
}

async function addAttendee(gcalEventId, calendarId, email) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = existing.data.attendees || [];

  // Don't add duplicates
  if (attendees.some((a) => a.email === email)) return existing.data;

  attendees.push({ email });
  const res = await calendar.events.patch({
    calendarId,
    eventId: gcalEventId,
    requestBody: { attendees },
    sendUpdates: "all",
  });

  upsertEvent(res.data, calendarId);
  return res.data;
}

async function removeAttendee(gcalEventId, calendarId, email) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = (existing.data.attendees || []).filter((a) => a.email !== email);

  const res = await calendar.events.patch({
    calendarId,
    eventId: gcalEventId,
    requestBody: { attendees },
    sendUpdates: "all",
  });

  upsertEvent(res.data, calendarId);
  return res.data;
}

async function rsvp(gcalEventId, calendarId, response) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId: gcalEventId });
  const attendees = existing.data.attendees || [];

  // Find self and update response
  for (const a of attendees) {
    if (a.self) {
      a.responseStatus = response; // accepted, declined, tentative
    }
  }

  const res = await calendar.events.patch({
    calendarId,
    eventId: gcalEventId,
    requestBody: { attendees },
    sendUpdates: "all",
  });

  upsertEvent(res.data, calendarId);
  return res.data;
}

async function createEvent(calendarId, eventData) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const body = {
    summary: eventData.title,
    description: eventData.description || "",
    location: eventData.location || "",
    start: eventData.allDay
      ? { date: eventData.startDate }
      : { dateTime: toRFC3339(eventData.date, eventData.start, tz), timeZone: tz },
    end: eventData.allDay
      ? { date: eventData.endDate }
      : { dateTime: toRFC3339(eventData.date, eventData.end, tz), timeZone: tz },
  };

  if (eventData.attendees && eventData.attendees.length) {
    body.attendees = eventData.attendees.map((email) => ({ email }));
  }

  if (eventData.addMeet) {
    body.conferenceData = {
      createRequest: {
        conferenceSolutionKey: { type: "hangoutsMeet" },
        requestId: crypto.randomUUID(),
      },
    };
  }

  const res = await calendar.events.insert({
    calendarId,
    requestBody: body,
    conferenceDataVersion: eventData.addMeet ? 1 : 0,
    sendUpdates: "all",
  });

  upsertEvent(res.data, calendarId);
  return res.data;
}

async function deleteEvent(gcalEventId, calendarId) {
  const auth = gcalAuth.getAuthClient();
  if (!auth) throw new Error("Not authenticated");

  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({
    calendarId,
    eventId: gcalEventId,
    sendUpdates: "all",
  });

  // Remove local data
  const existing = _db.prepare(
    "SELECT block_id FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?"
  ).get(gcalEventId, calendarId);

  if (existing && existing.block_id) {
    const now = new Date().toISOString();
    _db.prepare("UPDATE blocks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.block_id);
  }
  _db.prepare("DELETE FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?").run(gcalEventId, calendarId);
}

// ── Get GCal Event Details ──

function getGcalEvent(gcalEventId, calendarId) {
  return _db.prepare(
    "SELECT * FROM gcal_events WHERE gcal_event_id = ? AND calendar_id = ?"
  ).get(gcalEventId, calendarId);
}

function getGcalEventByBlockId(blockId) {
  return _db.prepare(
    "SELECT * FROM gcal_events WHERE block_id = ?"
  ).get(blockId);
}

// ── Calendar Management ──

function getSelectedCalendars() {
  return _db.prepare("SELECT * FROM gcal_calendars WHERE selected = 1").all();
}

function getAllCalendars() {
  return _db.prepare("SELECT * FROM gcal_calendars ORDER BY is_primary DESC, summary ASC").all();
}

function toggleCalendar(calendarId, selected) {
  _db.prepare("UPDATE gcal_calendars SET selected = ?, updated_at = ? WHERE id = ?")
    .run(selected ? 1 : 0, new Date().toISOString(), calendarId);
}

function cacheCalendarsToDb(calendars) {
  const now = new Date().toISOString();
  const stmt = _db.prepare(`
    INSERT INTO gcal_calendars (id, summary, description, background_color, foreground_color, is_primary, access_role, selected, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary = excluded.summary,
      description = excluded.description,
      background_color = excluded.background_color,
      foreground_color = excluded.foreground_color,
      is_primary = excluded.is_primary,
      access_role = excluded.access_role,
      updated_at = excluded.updated_at
  `);

  for (const cal of calendars) {
    stmt.run(
      cal.id, cal.summary, cal.description || "",
      cal.backgroundColor || "#4285f4", cal.foregroundColor || "#ffffff",
      cal.primary ? 1 : 0, cal.accessRole || "reader",
      cal.selected !== false ? 1 : 0, now
    );
  }
}

// ── Helpers ──

function toSortOrder(startTime) {
  if (!startTime) return 0;
  const [h, m] = startTime.split(":").map(Number);
  return h * 100 + m;
}

function toRFC3339(dateStr, timeStr, tz) {
  // dateStr: "YYYY-MM-DD", timeStr: "HH:MM"
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt.toISOString();
}

function safeParseJSON(val, fallback) {
  if (Array.isArray(val)) return val;
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function getSyncStatus() {
  const calendars = getSelectedCalendars();
  const states = [];
  for (const cal of calendars) {
    const state = _db.prepare("SELECT * FROM gcal_sync_state WHERE calendar_id = ?").get(cal.id);
    states.push({
      calendarId: cal.id,
      calendarName: cal.summary,
      lastSyncAt: state?.last_sync_at || null,
      hasSyncToken: !!state?.sync_token,
    });
  }
  return {
    connected: gcalAuth.isAuthenticated(),
    syncing: _syncInProgress,
    calendars: states,
  };
}

// ── Export ──

module.exports = {
  init,
  startPolling,
  stopPolling,
  syncAll,
  syncCalendar,
  updateEvent,
  addAttendee,
  removeAttendee,
  rsvp,
  createEvent,
  deleteEvent,
  getGcalEvent,
  getGcalEventByBlockId,
  getSelectedCalendars,
  getAllCalendars,
  toggleCalendar,
  cacheCalendarsToDb,
  getSyncStatus,
};
