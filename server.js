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

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8090;

// ── Path Configuration ──
// PROJECT_DIR: where this server.js lives (local repo — serves HTML/CSS/JS)
const PROJECT_DIR = __dirname;
// DATA_ROOT: the original DCC directory on Google Drive (The Second Brain, meeting-prep)
// Falls back to __dirname for backwards compat if .env isn't set
const DATA_ROOT = process.env.DATA_ROOT || PROJECT_DIR;
// WORKSPACE_ROOT: the Clever PA workspace (contains .clever-pa/)
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(DATA_ROOT, "..", "..");
// PA home: .clever-pa/
const PA_HOME = path.join(WORKSPACE_ROOT, ".clever-pa");
// The Second Brain: lives on Google Drive under the original DCC directory
const BRAIN_DIR = path.join(DATA_ROOT, "The Second Brain");
const RECENT_DIR = path.join(BRAIN_DIR, "recent");
const ENGRAMS_DIR = path.join(BRAIN_DIR, "engrams");
const GLOBALS_FILE = path.join(BRAIN_DIR, "globals.json");
const MANIFEST_FILE = path.join(RECENT_DIR, "manifest.json");
// PA state files
const STATE_DIR = path.join(PA_HOME, "state");
const DAY_STATE_FILE = path.join(STATE_DIR, "day-state.json");
const TOMORROW_STATE_FILE = path.join(STATE_DIR, "tomorrow-state.json");
const UPCOMING_FILE = path.join(STATE_DIR, "upcoming-meetings.json");
const LOCAL_UI_STATE_FILE = path.join(STATE_DIR, "local-ui-state.json");
const ARCHIVE_DIR = path.join(STATE_DIR, "archive");
// Meeting prep: lives on Google Drive under the original DCC directory
const PREP_DIR = path.join(DATA_ROOT, "meeting-prep");
// User config
const USER_CONTEXT_FILE = path.join(PA_HOME, "user-context.yaml");
// PA activity log
const PA_LOG_FILE = path.join(WORKSPACE_ROOT, "claude-school", "pa-activity-log.md");

// Ensure directories exist
[RECENT_DIR, ENGRAMS_DIR].forEach((dir) => {
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

// ── GET: State Endpoints (replace render-script injection) ──

// Day state (the central hub)
app.get("/api/state/day", (req, res) => {
  const data = readJSON(DAY_STATE_FILE, null);
  res.json(data);
});

// Tomorrow pre-plan
app.get("/api/state/tomorrow", (req, res) => {
  const data = readJSON(TOMORROW_STATE_FILE, null);
  res.json(data);
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
    /(### (\d{4}-\d{2}-\d{2}T[\d:+\-]+) -- (?:overnight-oracle|pa-offpeak)[^\n]*\n)([\s\S]*?)(?=\n---|\Z)/
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
app.post("/api/ingest/day-state", (req, res) => {
  const incoming = req.body;
  if (!incoming || !incoming.date) {
    return res.status(400).json({ error: "Missing date in payload" });
  }

  const existing = readJSON(DAY_STATE_FILE, {});

  // PA-owned sections: overwrite from incoming
  const PA_SECTIONS = [
    "schedule", "triage", "meetings", "watermarks", "notifications",
    "assessment", "sweep_stats", "meta",
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
    // If incoming has user section data AND existing doesn't, take incoming
    if (key in incoming && !(key in existing)) {
      merged[key] = incoming[key];
    }
    // If both have it, keep existing (user wins)
  }

  // Always update top-level metadata
  merged.date = incoming.date;
  merged.last_updated_at = new Date().toISOString();
  merged.last_updated_by = incoming.last_updated_by || "scheduled-task";

  writeJSON(DAY_STATE_FILE, merged);
  console.log(`[ingest] Merged day-state for ${incoming.date}`);
  broadcast("ingest", { source: "day-state", date: incoming.date });
  res.json({ ok: true, date: incoming.date });
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
    paHome: PA_HOME,
    datesStored: manifest.dates.length,
    lastUpdated: manifest.lastUpdated || null,
    dayStateDate: dayState ? dayState.date : null,
    uptime: process.uptime(),
  });
});

// ── Static File Serving ──
// Serve modular CSS/JS from public/
app.use("/public", express.static(path.join(PROJECT_DIR, "public")));
// Serve other static assets (meeting-prep/, snapshots/, etc.) from project dir
app.use(express.static(PROJECT_DIR, { extensions: ["html"] }));

// Fallback: serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(PROJECT_DIR, "index.html"));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  Daily Command Center`);
  console.log(`  ────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/health`);
  console.log(`  SSE:        http://localhost:${PORT}/api/events`);
  console.log(`  PA Home:    ${PA_HOME}`);
  console.log(`  Brain Dir:  ${BRAIN_DIR}\n`);
});
