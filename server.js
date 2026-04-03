/**
 * Daily Command Center — Express API Server
 *
 * Single server that:
 *  - Serves the dashboard as static files (replaces npx http-server)
 *  - Provides REST API for reading all state data (replaces Python render injection)
 *  - Handles dashboard state persistence (replaces sync-server.js)
 *  - Broadcasts live updates via Server-Sent Events
 *  - Watches state files for changes from scheduled tasks
 *
 * Port: 8090 (single process, replaces both 8090 + 8091)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const blockDB = require("./db");
const migration = require("./migrate");
const gcalAuth = require("./gcal-auth");
const gcalSync = require("./gcal-sync");

const app = express();
const PORT = process.env.PORT || 8090;

// ── Path Configuration ──
// Everything is local under data/ — no external dependencies
const PROJECT_DIR = __dirname;
const DATA_DIR = path.join(PROJECT_DIR, "data");
// State files (day-state, tomorrow-state, upcoming-meetings)
const STATE_DIR = path.join(DATA_DIR, "state");
const DAY_STATE_FILE = path.join(STATE_DIR, "day-state.json");
const TOMORROW_STATE_FILE = path.join(STATE_DIR, "tomorrow-state.json");
const UPCOMING_FILE = path.join(STATE_DIR, "upcoming-meetings.json");
const LOCAL_UI_STATE_FILE = path.join(STATE_DIR, "local-ui-state.json");
const ARCHIVE_DIR = path.join(STATE_DIR, "archive");
const DAYS_DIR = path.join(STATE_DIR, "days");
// Second Brain (recent day states, engrams, globals)
const BRAIN_DIR = path.join(DATA_DIR, "brain");
const RECENT_DIR = path.join(BRAIN_DIR, "recent");
const ENGRAMS_DIR = path.join(BRAIN_DIR, "engrams");
const GLOBALS_FILE = path.join(BRAIN_DIR, "globals.json");
const MANIFEST_FILE = path.join(RECENT_DIR, "manifest.json");
// Meeting prep HTML files
const PREP_DIR = path.join(DATA_DIR, "prep");
// Config (user-context.yaml, PA activity log)
const USER_CONTEXT_FILE = path.join(DATA_DIR, "config", "user-context.yaml");
const PA_LOG_FILE = path.join(DATA_DIR, "config", "pa-activity-log.md");

// Ensure directories exist
[RECENT_DIR, ENGRAMS_DIR, DAYS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Middleware ──
app.use(express.json({ limit: "5mb" }));

// ── SSE: Server-Sent Events for live updates ──
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("data: connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcast(eventType, data) {
  const payload = JSON.stringify({ type: eventType, ...data });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// ── File Watching ──
// Watch key state files and broadcast SSE on change
const WATCHED_FILES = [DAY_STATE_FILE, TOMORROW_STATE_FILE, UPCOMING_FILE];
const watchDebounce = {};

WATCHED_FILES.forEach((filePath) => {
  try {
    fs.watch(filePath, { persistent: false }, (eventType) => {
      // Debounce: ignore rapid successive changes
      const now = Date.now();
      if (watchDebounce[filePath] && now - watchDebounce[filePath] < 1000) return;
      watchDebounce[filePath] = now;
      const name = path.basename(filePath, ".json");
      console.log(`[watch] ${name} changed, broadcasting SSE`);
      broadcast("file-changed", { file: name });
    });
  } catch {
    // File might not exist yet — that's fine
  }
});

// ── SQLite (initialized early for use in helpers) ──
const db = blockDB.getDB();

// ── Helpers ──
function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function updateManifest(date) {
  const manifest = readJSON(MANIFEST_FILE, { dates: [] });
  if (!manifest.dates.includes(date)) {
    manifest.dates.unshift(date);
    manifest.dates.sort().reverse();
  }
  manifest.lastUpdated = new Date().toISOString();
  writeJSON(MANIFEST_FILE, manifest);
}

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function archiveDayState(date, data) {
  // Dual-write to archive/{year}/Q{n}/{MM}-{MonthName}/{date}.json
  const ARCHIVE_ROOT = path.join(BRAIN_DIR, "archive");
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return;
  const [, year, mm] = match;
  const month = parseInt(mm, 10);
  const quarter = Math.ceil(month / 3);
  const monthFolder = `${mm}-${MONTH_NAMES[month]}`;
  const destDir = path.join(ARCHIVE_ROOT, year, `Q${quarter}`, monthFolder);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `${date}.json`);
  // Merge with existing (preserve fields not in new data)
  const existing = readJSON(destFile, {});
  const merged = { ...existing, ...data, source: "api-save", savedAt: new Date().toISOString() };
  writeJSON(destFile, merged);
  console.log(`[archive] Wrote ${date} to ${year}/Q${quarter}/${monthFolder}/`);
}

function pruneRecent() {
  // Remove recent/ files older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(RECENT_DIR)) return;
  for (const fname of fs.readdirSync(RECENT_DIR)) {
    if (!fname.endsWith(".json") || fname === "manifest.json") continue;
    const dateStr = fname.replace(".json", "");
    const ts = new Date(dateStr + "T00:00:00").getTime();
    if (ts && ts < cutoff) {
      fs.unlinkSync(path.join(RECENT_DIR, fname));
      console.log(`[prune] Removed old recent file: ${fname}`);
    }
  }
}

// ── Per-Day State Helpers ──

function getTodayStr() {
  // Get today's date in America/New_York timezone
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

function getETOffset(dateStr) {
  // Compute the UTC offset for a date in America/New_York (e.g., "-04:00" for EDT, "-05:00" for EST)
  const dt = new Date(dateStr + "T12:00:00Z");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(dt);
  const tzPart = parts.find(p => p.type === "timeZoneName");
  if (tzPart) {
    // "GMT-4" or "GMT-5" → "-04:00" or "-05:00"
    const m = tzPart.value.match(/GMT([+-]?\d+)/);
    if (m) {
      const hrs = parseInt(m[1], 10);
      return (hrs <= 0 ? "-" : "+") + String(Math.abs(hrs)).padStart(2, "0") + ":00";
    }
  }
  return "-04:00"; // fallback EDT
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function getDayFilePath(dateStr) {
  return path.join(DAYS_DIR, dateStr + ".json");
}

function getMeetingsFromSQLite(dateStr) {
  const offset = getETOffset(dateStr);
  const rows = db.prepare(`
    SELECT b.id, b.properties, g.attendees_json, g.gcal_event_id, g.html_link
    FROM blocks b
    LEFT JOIN gcal_events g ON g.block_id = b.id
    WHERE b.date = ? AND b.type = 'schedule_item' AND b.deleted_at IS NULL
    ORDER BY b.sort_order ASC
  `).all(dateStr);

  const meetings = [];
  const meetingTimeline = [];

  for (const row of rows) {
    let props;
    try { props = JSON.parse(row.properties); } catch { continue; }
    if (props.source !== "gcal" || props.all_day) continue;
    if (!props.start || !props.end) continue;

    // Parse attendees from gcal_events
    let attendees = [];
    if (row.attendees_json) {
      try {
        const raw = JSON.parse(row.attendees_json);
        attendees = raw
          .filter(a => !a.self && !a.resource)
          .map(a => a.email);
      } catch {}
    }

    const startISO = `${dateStr}T${props.start}:00${offset}`;
    const endISO = `${dateStr}T${props.end}:00${offset}`;
    const eventId = row.gcal_event_id || props.source_id || row.id;

    meetings.push({
      id: eventId,
      title: props.title || "(No title)",
      start: startISO,
      end: endISO,
      attendees,
      calUrl: props.calUrl || row.html_link || null,
      linkedDocUrl: null,
      linkedDocTitle: null,
      myResponseStatus: props.rsvp_status || null,
    });

    meetingTimeline.push({
      id: "mtg-" + row.id,
      type: "meeting",
      label: props.title || "(No title)",
      start: startISO,
      end: endISO,
      source: "calendar",
      source_id: eventId,
      category: "Meetings",
      completed: false,
    });
  }

  // Deduplicate by title + start (same event from multiple calendars)
  const seen = new Map();
  const dedupedMeetings = [];
  const dedupedTimeline = [];
  for (let i = 0; i < meetings.length; i++) {
    const key = meetings[i].title + "|" + meetings[i].start;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // Keep the one where user accepted, or the first one
      if (meetings[i].myResponseStatus === "accepted" && meetings[existing].myResponseStatus !== "accepted") {
        dedupedMeetings[existing] = meetings[i];
        dedupedTimeline[existing] = meetingTimeline[i];
      }
    } else {
      seen.set(key, dedupedMeetings.length);
      dedupedMeetings.push(meetings[i]);
      dedupedTimeline.push(meetingTimeline[i]);
    }
  }

  return { meetings: dedupedMeetings, meetingTimeline: dedupedTimeline };
}

function buildSkeletonState(dateStr) {
  return {
    date: dateStr,
    last_updated_at: new Date().toISOString(),
    last_updated_by: "skeleton",
    watermarks: {},
    triage: { open_items: [], resolved_items: [], cycle_count: 0 },
    completions: { tasks: [] },
    schedule: {
      working_hours: { start: "07:00", end: "17:30" },
      timeline: [],
      tasks_scheduled: [],
      tasks_couldnt_fit: [],
      stats: {},
    },
  };
}

function buildDayResponse(dateStr) {
  const dayFile = getDayFilePath(dateStr);

  // Read enrichment from per-day JSON (or create skeleton)
  let enrichment = readJSON(dayFile, null);
  if (!enrichment) {
    enrichment = buildSkeletonState(dateStr);
    writeJSON(dayFile, enrichment);
  }

  // Live meetings from SQLite
  const { meetings, meetingTimeline } = getMeetingsFromSQLite(dateStr);

  // Merge: enrichment + live meetings
  const result = { ...enrichment, date: dateStr, meetings };

  // Merge meeting timeline entries into schedule.timeline
  if (result.schedule && result.schedule.timeline) {
    const existingSourceIds = new Set(
      result.schedule.timeline.filter(t => t.source === "calendar").map(t => t.source_id)
    );
    for (const mtg of meetingTimeline) {
      if (!existingSourceIds.has(mtg.source_id)) {
        result.schedule.timeline.push(mtg);
      }
    }
    result.schedule.timeline.sort((a, b) => a.start.localeCompare(b.start));
  } else {
    result.schedule = { ...(result.schedule || {}), timeline: meetingTimeline };
  }

  // Read schedule blocks from SQLite
  result.schedule.blocks = getScheduleBlocks();

  return result;
}

function getScheduleBlocks(){
  try {
    const db = blockDB.getDB();
    const rows = db.prepare(
      "SELECT id, parent_id, sort_order, properties FROM blocks WHERE type='schedule_block' AND deleted_at IS NULL ORDER BY sort_order"
    ).all();
    return rows.map(r => ({ ...JSON.parse(r.properties), id: r.id, parent_id: r.parent_id, sort_order: r.sort_order }));
  } catch(e){ return []; }
}

function seedScheduleBlocksFromYAML(){
  try {
    const db = blockDB.getDB();
    const existing = db.prepare("SELECT COUNT(*) as cnt FROM blocks WHERE type='schedule_block' AND deleted_at IS NULL").get();
    if(existing.cnt > 0) return; // already seeded

    if(!fs.existsSync(USER_CONTEXT_FILE)) return;
    const raw = fs.readFileSync(USER_CONTEXT_FILE, "utf8");
    const match = raw.match(/\bblocks:\s*\n((?:\s+-[\s\S]*?)*)(?=\n\s{2}\S|\n\S|\s*$)/m);
    if(!match) return;
    const blocks = [];
    let current = null;
    for(const line of match[1].split("\n")){
      const nm = line.match(/^\s+-\s+name:\s+"?([^"\n]+)"?\s*$/);
      const tp = line.match(/^\s+type:\s+(\w+)/);
      const st = line.match(/^\s+start:\s+"?(\d{2}:\d{2})"?/);
      const en = line.match(/^\s+end:\s+"?(\d{2}:\d{2})"?/);
      if(nm){ current = { name: nm[1].trim() }; blocks.push(current); }
      else if(tp && current) current.blockType = tp[1];
      else if(st && current) current.start = st[1];
      else if(en && current) current.end = en[1];
    }
    const valid = blocks.filter(b => b.name && b.blockType && b.start && b.end);
    const db = blockDB.getDB();
    valid.forEach((b, i) => {
      blockDB.createBlock(db, {
        type: "schedule_block",
        properties: { name: b.name, blockType: b.blockType, start: b.start, end: b.end, protected: false, warnThreshold: 0 },
        sort_order: i
      });
    });
    if(valid.length) console.log("[seed] Migrated " + valid.length + " schedule blocks from YAML to SQLite");
  } catch(e){ console.error("[seed] Error seeding schedule blocks:", e.message); }
}

function ensureSkeletonDays() {
  const today = getTodayStr();

  // Generate skeletons for next 14 days
  for (let i = 0; i < 14; i++) {
    const dateStr = addDays(today, i);
    const dayFile = getDayFilePath(dateStr);
    if (!fs.existsSync(dayFile)) {
      writeJSON(dayFile, buildSkeletonState(dateStr));
    }
  }

  // Archive days older than 14 days
  if (fs.existsSync(DAYS_DIR)) {
    const cutoffDate = addDays(today, -14);
    for (const fname of fs.readdirSync(DAYS_DIR)) {
      if (!fname.endsWith(".json")) continue;
      const dateStr = fname.replace(".json", "");
      if (dateStr < cutoffDate) {
        const data = readJSON(path.join(DAYS_DIR, fname), null);
        if (data) {
          archiveDayState(dateStr, data);
          // Also save to recent/ for brain
          const recentFile = path.join(RECENT_DIR, fname);
          writeJSON(recentFile, data);
          updateManifest(dateStr);
        }
        fs.unlinkSync(path.join(DAYS_DIR, fname));
        console.log(`[days] Archived and removed ${fname}`);
      }
    }
  }

  console.log(`[days] Skeleton check complete — ${today} + 13 days`);
}

// ── GET: State Endpoints (replace render-script injection) ──

// Day state — per-day files with live calendar merge
app.get("/api/state/day", (req, res) => {
  try {
    const dateStr = req.query.date || getTodayStr();
    res.json(buildDayResponse(dateStr));
  } catch (e) {
    console.error("[api/state/day] Error:", e.message);
    // Fallback: try legacy day-state.json
    res.json(readJSON(DAY_STATE_FILE, null));
  }
});

// Tomorrow — same logic, just +1 day
app.get("/api/state/tomorrow", (req, res) => {
  try {
    const tomorrowStr = addDays(getTodayStr(), 1);
    res.json(buildDayResponse(tomorrowStr));
  } catch (e) {
    console.error("[api/state/tomorrow] Error:", e.message);
    res.json(readJSON(TOMORROW_STATE_FILE, null));
  }
});

// Upcoming meetings (next 10 business days)
app.get("/api/state/upcoming", (req, res) => {
  const data = readJSON(UPCOMING_FILE, []);
  res.json(data);
});

// Archive states (last 7 days)
app.get("/api/state/archives", (req, res) => {
  const archives = {};
  if (fs.existsSync(ARCHIVE_DIR)) {
    const files = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((f) => f.endsWith(".json") && f.length === 15) // YYYY-MM-DD.json
      .sort()
      .reverse()
      .slice(0, 7);
    for (const fname of files) {
      const data = readJSON(path.join(ARCHIVE_DIR, fname), null);
      if (data) archives[fname.replace(".json", "")] = data;
    }
  }
  res.json(archives);
});

// Local UI state (notes, actions, dismissed — extracted from previous session)
app.get("/api/state/local", (req, res) => {
  const data = readJSON(LOCAL_UI_STATE_FILE, null);
  res.json(data);
});

// ── GET: Second Brain Endpoints ──

// Recent day states (for date picker and history)
app.get("/api/brain/recent", (req, res) => {
  const data = {};
  if (fs.existsSync(RECENT_DIR)) {
    for (const fname of fs.readdirSync(RECENT_DIR).sort()) {
      if (!fname.endsWith(".json") || fname === "manifest.json") continue;
      const entry = readJSON(path.join(RECENT_DIR, fname), null);
      if (entry) data[fname.replace(".json", "")] = entry;
    }
  }
  res.json(data);
});

// Global state (sticky notes, life captures)
app.get("/api/brain/globals", (req, res) => {
  const data = readJSON(GLOBALS_FILE, {});
  res.json(data);
});

// Engram data (index + taxonomy + co-occurrence)
app.get("/api/brain/engrams", (req, res) => {
  const indexFile = path.join(ENGRAMS_DIR, "index.json");
  const taxonomyFile = path.join(ENGRAMS_DIR, "taxonomy.json");
  const cooccurrenceFile = path.join(ENGRAMS_DIR, "co-occurrence.json");

  const index = readJSON(indexFile, {});
  const cooccurrence = readJSON(cooccurrenceFile, {});

  let taxonomy = readJSON(taxonomyFile, null);
  if (!taxonomy) {
    // Create default taxonomy (same as render script)
    taxonomy = {
      categories: [
        { id: "activity", label: "Activities", icon: "\u26a1", color: "#3b82f6" },
        { id: "people", label: "People", icon: "\ud83d\udc64", color: "#8b5cf6" },
        { id: "book", label: "Books", icon: "\ud83d\udcda", color: "#f59e0b" },
        { id: "media", label: "Media", icon: "\ud83c\udfac", color: "#ec4899" },
        { id: "meeting", label: "Meetings", icon: "\ud83d\udcc5", color: "#06b6d4" },
        { id: "project", label: "Projects", icon: "\ud83c\udfd7\ufe0f", color: "#10b981" },
        { id: "place", label: "Places", icon: "\ud83d\udccd", color: "#ef4444" },
        { id: "topic", label: "Topics", icon: "\ud83d\udca1", color: "#f97316" },
        { id: "wellness", label: "Wellness", icon: "\ud83c\udf3f", color: "#22c55e" },
        { id: "custom", label: "Custom", icon: "\ud83c\udff7\ufe0f", color: "#6b7280" },
      ],
    };
    writeJSON(taxonomyFile, taxonomy);
  }

  res.json({ index, taxonomy, cooccurrence });
});

// Journal tags from user-context.yaml
app.get("/api/brain/tags", (req, res) => {
  if (!fs.existsSync(USER_CONTEXT_FILE)) return res.json({});
  try {
    const raw = fs.readFileSync(USER_CONTEXT_FILE, "utf8");
    // Simple YAML extraction for journal_tags (avoids PyYAML dependency)
    // The tags section is a YAML map of arrays. Parse it minimally.
    const match = raw.match(/^journal_tags:\s*\n([\s\S]*?)(?=^\S|\Z)/m);
    if (!match) return res.json({});

    const tags = {};
    let currentKey = null;
    for (const line of match[1].split("\n")) {
      const keyMatch = line.match(/^\s{2}(\w+):\s*$/);
      const itemMatch = line.match(/^\s{4}-\s+"?([^"]+)"?\s*$/);
      if (keyMatch) {
        currentKey = keyMatch[1];
        tags[currentKey] = [];
      } else if (itemMatch && currentKey) {
        tags[currentKey].push(itemMatch[1]);
      }
    }
    res.json(tags);
  } catch (e) {
    console.error("[tags] Error parsing user-context.yaml:", e.message);
    res.json({});
  }
});

// Meeting prep HTML files
app.get("/api/prep", (req, res) => {
  if (!fs.existsSync(PREP_DIR)) return res.json({});
  const files = {};
  for (const fname of fs.readdirSync(PREP_DIR)) {
    if (!fname.endsWith(".html")) continue;
    try {
      files[fname] = fs.readFileSync(path.join(PREP_DIR, fname), "utf8");
    } catch {
      // skip unreadable files
    }
  }
  res.json(files);
});

// Single prep file by name
app.get("/api/prep/:filename", (req, res) => {
  const filePath = path.join(PREP_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.type("html").send(fs.readFileSync(filePath, "utf8"));
});

// PA activity log — most recent overnight-oracle entry
app.get("/api/pa-log", (req, res) => {
  if (!fs.existsSync(PA_LOG_FILE)) {
    return res.json({ html: '<div style="color:var(--text-muted);padding:24px">pa-activity-log.md not found.</div>' });
  }
  const raw = fs.readFileSync(PA_LOG_FILE, "utf8");
  const match = raw.match(
    /(### (\d{4}-\d{2}-\d{2}T[\d:+\-]+) -- (?:overnight-oracle|pa-offpeak|clever-assistant)[^\n]*\n)([\s\S]*?)(?=\n---|\Z)/
  );
  if (!match) {
    return res.json({ html: '<div style="color:var(--text-muted);padding:24px">No overnight review found in log.</div>' });
  }

  const ts = match[2];
  const body = match[3].trim();

  // Convert markdown-ish body to HTML (mirrors render script logic)
  const lines = body.split("\n");
  const parts = [];
  let inUl = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("- ")) {
      if (!inUl) {
        parts.push('<ul style="margin:4px 0 8px 16px;padding:0;list-style:disc">');
        inUl = true;
      }
      const item = stripped.slice(2).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      parts.push(`  <li style="margin:3px 0;font-size:12px;line-height:1.5">${item}</li>`);
    } else {
      if (inUl) {
        parts.push("</ul>");
        inUl = false;
      }
      if (!stripped) {
        parts.push('<div style="height:6px"></div>');
      } else {
        const fmt = stripped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        parts.push(`<div style="font-size:12px;line-height:1.5;margin:2px 0">${fmt}</div>`);
      }
    }
  }
  if (inUl) parts.push("</ul>");

  const html = `<div style="margin-bottom:12px">
  <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">
    Last off-peak sweep ran <strong style="color:var(--text)">${ts}</strong>
  </div>
  <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px">
    ${parts.join("\n")}
  </div>
</div>`;

  res.json({ html, timestamp: ts });
});

// ── POST: Dashboard State Persistence (from sync-server.js) ──

// Save day-state to The Second Brain
app.post("/api/save-day", (req, res) => {
  const body = req.body;
  const date = body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Missing or invalid date (expected YYYY-MM-DD)" });
  }
  body.savedAt = new Date().toISOString();
  const filePath = path.join(RECENT_DIR, `${date}.json`);
  writeJSON(filePath, body);
  updateManifest(date);
  // Dual-write to archive (mirrors render script behavior)
  archiveDayState(date, body);
  // Prune recent files older than 30 days (runs on save, lightweight)
  pruneRecent();
  console.log(`[sync] Saved day-state: ${date}`);
  broadcast("save", { source: "day", date });
  res.json({ ok: true, date, file: `recent/${date}.json` });
});

// Save globals
app.post("/api/save-globals", (req, res) => {
  const body = req.body;
  body.savedAt = new Date().toISOString();
  writeJSON(GLOBALS_FILE, body);
  console.log("[sync] Saved globals");
  broadcast("save", { source: "globals" });
  res.json({ ok: true, file: "globals.json" });
});

// Save engram index
app.post("/api/save-engram-index", (req, res) => {
  const body = req.body;
  body.savedAt = new Date().toISOString();
  const engramIndexFile = path.join(ENGRAMS_DIR, "index.json");
  writeJSON(engramIndexFile, body);
  console.log("[sync] Saved engram index");
  broadcast("save", { source: "engrams" });
  res.json({ ok: true, file: "engrams/index.json" });
});

// ── POST: Ingest from Scheduled Tasks ──
// Section-level merge: PA-owned sections overwrite, user-owned sections preserve
// Writes to per-day file + legacy day-state.json for backward compatibility
app.post("/api/ingest/day-state", (req, res) => {
  const incoming = req.body;
  if (!incoming || !incoming.date) {
    return res.status(400).json({ error: "Missing date in payload" });
  }

  // Read from per-day file (primary) or legacy file (fallback)
  const dayFile = getDayFilePath(incoming.date);
  const existing = readJSON(dayFile, null) || readJSON(DAY_STATE_FILE, {});

  // PA-owned sections: overwrite from incoming
  // Note: meetings excluded — they always come live from SQLite
  const PA_SECTIONS = [
    "schedule", "triage", "watermarks",
    "notifications", "assessment", "sweep_stats", "meta", "report_card",
    "clean_tidy", "orchestrator", "mutations", "completions", "personal",
  ];
  // User-owned sections: preserve existing, incoming doesn't overwrite
  const USER_SECTIONS = [
    "done", "pushed", "deleted", "durChanges", "notes", "actions",
    "sessions", "mood", "reviewed", "subtasks",
  ];

  const merged = { ...existing };

  // Overwrite PA sections from incoming
  for (const key of PA_SECTIONS) {
    if (key in incoming) merged[key] = incoming[key];
  }

  // Preserve user sections (don't overwrite with incoming)
  for (const key of USER_SECTIONS) {
    if (key in existing && !(key in incoming)) {
      merged[key] = existing[key];
    }
    if (key in incoming && !(key in existing)) {
      merged[key] = incoming[key];
    }
  }

  // Always update top-level metadata
  merged.date = incoming.date;
  merged.last_updated_at = new Date().toISOString();
  merged.last_updated_by = incoming.last_updated_by || "scheduled-task";

  // Strip meetings from stored file — they come from SQLite on read
  delete merged.meetings;
  delete merged.meetings_tomorrow;

  // Write to per-day file (primary)
  writeJSON(dayFile, merged);

  // Legacy dual-write for backward compatibility (until PA tasks fully migrated)
  writeJSON(DAY_STATE_FILE, { ...merged, meetings: incoming.meetings || [] });

  console.log(`[ingest] Merged day-state for ${incoming.date} → ${dayFile}`);
  broadcast("ingest", { source: "day-state", date: incoming.date });
  res.json({ ok: true, date: incoming.date });
});

// ── POST: Clean and Tidy Approval Actions ──
app.post("/api/clean-tidy/approve", (req, res) => {
  const { ids, action } = req.body;
  if (!ids || !Array.isArray(ids) || !["approve", "deny"].includes(action)) {
    return res.status(400).json({ error: "Expected { ids: string[], action: 'approve'|'deny' }" });
  }
  const state = readJSON(DAY_STATE_FILE, {});
  const ct = state.clean_tidy || {};
  const pending = ct.pending_approvals || [];
  let changed = 0;
  for (const item of pending) {
    if (ids.includes(item.id) && item.status === "pending") {
      item.status = action === "approve" ? "approved" : "denied";
      item.resolved_at = new Date().toISOString();
      changed++;
    }
  }
  if (changed) {
    state.clean_tidy = ct;
    state.last_updated_at = new Date().toISOString();
    state.last_updated_by = "dcc-approval";
    writeJSON(DAY_STATE_FILE, state);
    broadcast("ingest", { source: "clean-tidy-approval", changed });
    console.log(`[clean-tidy] ${action}d ${changed} items`);
  }
  res.json({ ok: true, action, changed });
});

// ── GET: Health Check ──
app.get("/api/health", (req, res) => {
  const manifest = readJSON(MANIFEST_FILE, { dates: [] });
  const dayState = readJSON(DAY_STATE_FILE, null);
  res.json({
    status: "ok",
    server: "daily-command-center",
    port: PORT,
    sseClients: sseClients.size,
    brainDir: BRAIN_DIR,
    dataDir: DATA_DIR,
    datesStored: manifest.dates.length,
    lastUpdated: manifest.lastUpdated || null,
    dayStateDate: dayState ? dayState.date : null,
    uptime: process.uptime(),
  });
});

// ── Static File Serving ──
// Serve modular CSS/JS from public/ — no caching during development
app.use("/public", express.static(path.join(PROJECT_DIR, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  },
}));
// ── Block API (SQLite-backed) ──

// Validate date format
function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }

// POST /api/blocks — Create block(s)
app.post("/api/blocks", (req, res) => {
  try {
    const body = req.body;
    // Support single or array
    const items = Array.isArray(body) ? body : [body];
    const results = [];
    for (const item of items) {
      results.push(blockDB.createBlock(db, item));
    }
    broadcast("blocks-changed", { action: "create", blockIds: results.map(r => r.id), clientId: body._clientId });
    res.json(results.length === 1 ? results[0] : results);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/blocks/:id — Update block (full properties replacement)
app.patch("/api/blocks/:id", (req, res) => {
  try {
    const result = blockDB.updateBlock(db, req.params.id, req.body);
    broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId });
    res.json(result);
  } catch (e) {
    const status = e.message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// DELETE /api/blocks/:id — Soft-delete block
app.delete("/api/blocks/:id", (req, res) => {
  try {
    const result = blockDB.deleteBlock(db, req.params.id);
    broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id], clientId: req.query._clientId });
    res.json(result);
  } catch (e) {
    const status = e.message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/blocks/batch — Atomic multi-block operation
app.post("/api/blocks/batch", (req, res) => {
  try {
    const { operations, _clientId } = req.body;
    if (!Array.isArray(operations)) return res.status(400).json({ error: "operations must be an array" });
    const result = blockDB.batchOp(db, operations);
    broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b.id || b.reordered).filter(Boolean), clientId: _clientId });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/blocks?date=X or ?type=X,Y
app.get("/api/blocks", (req, res) => {
  try {
    if (req.query.date) {
      if (!isValidDate(req.query.date)) return res.status(400).json({ error: "Invalid date format" });
      // Ensure day_root exists
      blockDB.ensureDayRoot(db, req.query.date);
      const blocks = blockDB.getBlocksByDate(db, req.query.date);
      res.json(blocks);
    } else if (req.query.type) {
      const types = req.query.type.split(",").filter(t => blockDB.VALID_TYPES.has(t));
      if (!types.length) return res.status(400).json({ error: "No valid types specified" });
      const blocks = blockDB.getBlocksByTypes(db, types);
      res.json(blocks);
    } else {
      res.status(400).json({ error: "Provide ?date=YYYY-MM-DD or ?type=type1,type2" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/blocks/range — Get blocks across a date range (for Calendar view)
// IMPORTANT: Must be defined BEFORE /api/blocks/:id to avoid "range" matching as :id
app.get("/api/blocks/range", (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end || !isValidDate(start) || !isValidDate(end)) {
      return res.status(400).json({ error: "Provide ?start=YYYY-MM-DD&end=YYYY-MM-DD" });
    }
    const blocks = blockDB.getBlocksByDateRange(db, start, end);
    res.json(blocks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/blocks/:id — Get single block
app.get("/api/blocks/:id", (req, res) => {
  const block = blockDB.getBlock(db, req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  res.json(block);
});

// GET /api/blocks/:id/children — Get child blocks
app.get("/api/blocks/:id/children", (req, res) => {
  try {
    const children = blockDB.getChildren(db, req.params.id);
    res.json(children);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/blocks/reorder — Update sort_order for multiple blocks
app.post("/api/blocks/reorder", (req, res) => {
  try {
    const { items, _clientId } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array of {id, sort_order}" });
    blockDB.reorderBlocks(db, items);
    broadcast("blocks-changed", { action: "reorder", blockIds: items.map(i => i.id), clientId: _clientId });
    res.json({ ok: true, reordered: items.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/pa-state/range — Get PA states across a date range (for Calendar view)
// IMPORTANT: Must be defined BEFORE /api/pa-state/:date to avoid "range" matching as :date
app.get("/api/pa-state/range", (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end || !isValidDate(start) || !isValidDate(end)) {
      return res.status(400).json({ error: "Provide ?start=YYYY-MM-DD&end=YYYY-MM-DD" });
    }
    const states = blockDB.getPaStateRange(db, start, end);
    const result = {};
    for (const s of states) result[s.date] = s.state_json;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pa-state/:date — Get PA-owned state
app.get("/api/pa-state/:date", (req, res) => {
  if (!isValidDate(req.params.date)) return res.status(400).json({ error: "Invalid date" });
  const state = blockDB.getPaState(db, req.params.date);
  res.json(state || { date: req.params.date, state_json: null });
});

// POST /api/pa-state/ingest — Scheduled task writes PA state
app.post("/api/pa-state/ingest", (req, res) => {
  try {
    const { date, ...stateData } = req.body;
    if (!date || !isValidDate(date)) return res.status(400).json({ error: "Valid date required" });
    blockDB.savePaState(db, date, stateData);
    broadcast("pa-state-changed", { date });
    res.json({ ok: true, date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/migrate — Run full migration
app.post("/api/migrate", (req, res) => {
  try {
    const { localStorageDump, dryRun } = req.body || {};
    const manifest = migration.runMigration(db, {
      dryRun: !!dryRun,
      localStorageDump: localStorageDump || null
    });
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// POST /api/migrate/dry-run — Preview migration without committing
app.post("/api/migrate/dry-run", (req, res) => {
  try {
    const { localStorageDump } = req.body || {};
    const manifest = migration.runMigration(db, {
      dryRun: true,
      localStorageDump: localStorageDump || null
    });
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/migrate/status — Check if migration has been run
app.get("/api/migrate/status", (req, res) => {
  try {
    const blockCount = db.prepare("SELECT COUNT(*) as count FROM blocks WHERE deleted_at IS NULL").get();
    const paCount = db.prepare("SELECT COUNT(*) as count FROM pa_state").get();
    res.json({
      migrated: blockCount.count > 1, // >1 because day_root auto-creates
      blockCount: blockCount.count,
      paStateCount: paCount.count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/operations?block_id=X — Get operation history
app.get("/api/operations", (req, res) => {
  if (!req.query.block_id) return res.status(400).json({ error: "block_id required" });
  const ops = blockDB.getOperations(db, req.query.block_id, parseInt(req.query.limit) || 50);
  res.json(ops);
});

// ── Google Calendar Integration ──
// Initialize GCal sync engine
gcalSync.init(db, broadcast);

// OAuth flow
app.get("/api/gcal/auth", (req, res) => {
  const url = gcalAuth.getAuthUrl();
  if (!url) return res.status(500).json({ error: "No credentials configured. Place gcal-credentials.json in data/" });
  res.redirect(url);
});

app.get("/api/gcal/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing auth code");
    await gcalAuth.handleCallback(code);
    // Start sync after auth
    gcalSync.startPolling();
    res.redirect("/?gcal=connected");
  } catch (e) {
    console.error("[gcal] OAuth callback error:", e.message);
    res.status(500).send("OAuth error: " + e.message);
  }
});

app.get("/api/gcal/status", (req, res) => {
  res.json(gcalSync.getSyncStatus());
});

app.post("/api/gcal/disconnect", (req, res) => {
  gcalAuth.deleteTokens();
  gcalSync.stopPolling();
  res.json({ ok: true });
});

// Calendar management
app.get("/api/gcal/calendars", async (req, res) => {
  try {
    const calendars = gcalSync.getAllCalendars();
    if (calendars.length) return res.json(calendars);
    // If no cached calendars, try fetching
    if (gcalAuth.isAuthenticated()) {
      const auth = gcalAuth.getAuthClient();
      const fetched = await gcalAuth.fetchAndCacheCalendars(auth);
      gcalSync.cacheCalendarsToDb(fetched);
      return res.json(gcalSync.getAllCalendars());
    }
    res.json([]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/gcal/calendars/:id/toggle", (req, res) => {
  try {
    const { selected } = req.body;
    gcalSync.toggleCalendar(req.params.id, selected);
    // Trigger sync for newly selected calendar
    if (selected) {
      gcalSync.syncAll().catch(e => console.error("[gcal] Toggle sync error:", e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Event details (joined block + gcal metadata)
app.get("/api/gcal/event/:blockId", (req, res) => {
  try {
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    const block = blockDB.getBlock(db, req.params.blockId);
    res.json({
      block: block || null,
      gcal: {
        ...gcalData,
        attendees: JSON.parse(gcalData.attendees_json || "[]"),
        conference: gcalData.conference_json ? JSON.parse(gcalData.conference_json) : null,
        organizer: gcalData.organizer_json ? JSON.parse(gcalData.organizer_json) : null,
        creator: gcalData.creator_json ? JSON.parse(gcalData.creator_json) : null,
        recurrence: gcalData.recurrence_json ? JSON.parse(gcalData.recurrence_json) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update event (title, time, description) → pushes to GCal
app.patch("/api/gcal/event/:blockId", async (req, res) => {
  try {
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    const result = await gcalSync.updateEvent(gcalData.gcal_event_id, gcalData.calendar_id, req.body);
    broadcast("gcal-sync", { action: "update", blockId: req.params.blockId });
    res.json({ ok: true, event: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add attendee
app.post("/api/gcal/event/:blockId/attendees", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    const result = await gcalSync.addAttendee(gcalData.gcal_event_id, gcalData.calendar_id, email);
    broadcast("gcal-sync", { action: "attendee-add", blockId: req.params.blockId });
    res.json({ ok: true, event: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove attendee
app.delete("/api/gcal/event/:blockId/attendees/:email", async (req, res) => {
  try {
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    const result = await gcalSync.removeAttendee(gcalData.gcal_event_id, gcalData.calendar_id, req.params.email);
    broadcast("gcal-sync", { action: "attendee-remove", blockId: req.params.blockId });
    res.json({ ok: true, event: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RSVP
app.post("/api/gcal/event/:blockId/rsvp", async (req, res) => {
  try {
    const { response } = req.body;
    if (!["accepted", "declined", "tentative"].includes(response)) {
      return res.status(400).json({ error: "response must be accepted, declined, or tentative" });
    }
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    const result = await gcalSync.rsvp(gcalData.gcal_event_id, gcalData.calendar_id, response);
    broadcast("gcal-sync", { action: "rsvp", blockId: req.params.blockId });
    res.json({ ok: true, event: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create event
app.post("/api/gcal/events", async (req, res) => {
  try {
    const { calendarId, ...eventData } = req.body;
    if (!calendarId) return res.status(400).json({ error: "calendarId required" });
    if (!eventData.title) return res.status(400).json({ error: "title required" });
    const result = await gcalSync.createEvent(calendarId, eventData);
    broadcast("gcal-sync", { action: "create" });
    res.json({ ok: true, event: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete event
app.delete("/api/gcal/event/:blockId", async (req, res) => {
  try {
    const gcalData = gcalSync.getGcalEventByBlockId(req.params.blockId);
    if (!gcalData) return res.status(404).json({ error: "GCal event not found" });
    await gcalSync.deleteEvent(gcalData.gcal_event_id, gcalData.calendar_id);
    broadcast("gcal-sync", { action: "delete", blockId: req.params.blockId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger manual sync
app.post("/api/gcal/sync", async (req, res) => {
  try {
    await gcalSync.syncAll();
    res.json({ ok: true, status: gcalSync.getSyncStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve other static assets from project dir
app.use(express.static(PROJECT_DIR, {
  extensions: ["html"],
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  },
}));

// Fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(PROJECT_DIR, "index.html"));
});

// ── Soft-delete purge (daily) ──
// Purge blocks soft-deleted more than 30 days ago
setInterval(() => {
  try {
    const purged = blockDB.purgeSoftDeleted(db, 30);
    if (purged > 0) console.log(`[Purge] Removed ${purged} soft-deleted blocks older than 30 days`);
  } catch (e) {
    console.warn("[Purge] Error:", e.message);
  }
}, 24 * 60 * 60 * 1000); // Every 24 hours

// Run once on startup too
try {
  const purged = blockDB.purgeSoftDeleted(db, 30);
  if (purged > 0) console.log(`[Purge] Startup: removed ${purged} soft-deleted blocks`);
} catch (e) {}

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  Daily Command Center`);
  console.log(`  ────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/health`);
  console.log(`  SSE:        http://localhost:${PORT}/api/events`);
  console.log(`  Blocks API: http://localhost:${PORT}/api/blocks`);
  console.log(`  Data Dir:   ${DATA_DIR}`);
  console.log(`  SQLite DB:  ${path.join(DATA_DIR, "blocks.db")}`);
  console.log(`  Brain Dir:  ${BRAIN_DIR}`);

  // Start GCal sync if authenticated
  if (gcalAuth.isAuthenticated()) {
    console.log(`  GCal:       Connected — starting sync`);
    gcalSync.startPolling();
  } else {
    console.log(`  GCal:       Not connected — visit /api/gcal/auth to connect`);
  }

  // Bootstrap per-day skeleton files (rolling 14-day window)
  try {
    ensureSkeletonDays();
    console.log(`  Days:       ${DAYS_DIR}`);
  } catch (e) {
    console.error(`  Days:       Bootstrap error — ${e.message}`);
  }

  // Seed schedule blocks from YAML if not already in SQLite
  try { seedScheduleBlocksFromYAML(); } catch(e) {
    console.error(`  Blocks:     Seed error — ${e.message}`);
  }

  // Re-check skeletons every 6 hours (handles midnight rollover)
  setInterval(() => {
    try { ensureSkeletonDays(); } catch (e) {
      console.error("[days] Periodic skeleton error:", e.message);
    }
  }, 6 * 60 * 60 * 1000);

  console.log();
});
