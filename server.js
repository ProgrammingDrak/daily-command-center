/**
 * Daily Command Center — Express API Server (Postgres-backed)
 *
 * Single server that:
 *  - Serves the dashboard as static files
 *  - Provides REST API for reading all state data
 *  - Handles dashboard state persistence
 *  - Broadcasts live updates via Server-Sent Events
 *  - Watches state files for changes from scheduled tasks
 *
 * Port: process.env.PORT || 8090
 */

require("dotenv/config");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const pool = require("./pg-pool");
const blockDB = require("./db");
const migration = require("./migrate");
const auth = require("./auth");
const VaultStore = require("./vault-store");
const SyncManager = require("./sync-manager");
const slotStore = require("./slot-store");
const meetingAutomation = require("./meeting-automation");
const dccIntelligence = require("./dcc-intelligence");

const app = express();
app.set("trust proxy", 1); // required for secure cookies behind hosted reverse proxies
const PORT = process.env.PORT || 8090;
const APP_TIME_ZONE = process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York";
const LOCAL_AUTH_ENABLED = process.env.NODE_ENV !== "production" && process.env.DCC_LOCAL_AUTH === "1";
const LOCAL_AUTH_USERNAME = process.env.SEED_USERNAME || "drake";
const LOCAL_AUTH_PASSWORD = process.env.SEED_PASSWORD || "clever123";
const LOCAL_AUTH_USER_ID = Number(process.env.DCC_LOCAL_USER_ID || 1);
const LOCAL_AUTH_WORKSPACE_ID = process.env.DCC_LOCAL_WORKSPACE_ID || `ws-${LOCAL_AUTH_USER_ID}`;

const PROJECT_DIR = __dirname;
const DATA_DIR = path.join(PROJECT_DIR, "data");
const STATE_DIR = path.join(DATA_DIR, "state");
const DAY_STATE_FILE = path.join(STATE_DIR, "day-state.json");
const TOMORROW_STATE_FILE = path.join(STATE_DIR, "tomorrow-state.json");
const LOCAL_UI_STATE_FILE = path.join(STATE_DIR, "local-ui-state.json");
const ARCHIVE_DIR = path.join(STATE_DIR, "archive");
const DAYS_DIR = path.join(STATE_DIR, "days");
const BRAIN_DIR = path.join(DATA_DIR, "brain");
const RECENT_DIR = path.join(BRAIN_DIR, "recent");
const ENGRAMS_DIR = path.join(BRAIN_DIR, "engrams");
const GLOBALS_FILE = path.join(BRAIN_DIR, "globals.json");
const MANIFEST_FILE = path.join(RECENT_DIR, "manifest.json");
const PREP_DIR = path.join(DATA_DIR, "prep");
const USER_CONTEXT_FILE = path.join(DATA_DIR, "config", "user-context.yaml");
const DCC_LOG_FILE = path.join(DATA_DIR, "config", "pa-activity-log.md");
// ── Vault configuration (Phase 1) ──
// VAULT_REPO_URL: https URL of the private GitHub repo that backs the vault.
//                 If unset, the vault runs local-only (no push/pull).
// VAULT_GITHUB_PAT: fine-grained PAT with contents:write on the vault repo.
//                   Injected into the clone URL as x-access-token.
// VAULT_BRANCH: git branch (default "main").
// VAULT_DIR: filesystem path to the working copy. Defaults to ./vault
//            (gitignored). On Render, the container filesystem is
//            ephemeral — clone happens on every cold boot.
const VAULT_DIR = process.env.VAULT_DIR || path.join(PROJECT_DIR, "vault");
const VAULT_INDEX_FILE = path.join(DATA_DIR, ".vault-index.json");
const SYNC_QUEUE_FILE = path.join(DATA_DIR, ".sync-queue.json");
const VAULT_REPO_URL = process.env.VAULT_REPO_URL || null;
const VAULT_BRANCH = process.env.VAULT_BRANCH || "main";

[RECENT_DIR, ENGRAMS_DIR, DAYS_DIR].forEach((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

let vault = null;
let syncMgr = null;

app.use(express.json({ limit: "5mb" }));

// ── Session Setup ──
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    console.warn("[session] SESSION_SECRET is not set; generated sessions will be invalidated on restart.");
  }
  const secretFile = path.join(DATA_DIR, ".session-secret");
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, "utf8").trim();
  const generatedSecret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretFile, generatedSecret, "utf8");
  return generatedSecret;
}

const sessionSecret = getSessionSecret();

const sessionOptions = {
  secret: sessionSecret, resave: false, saveUninitialized: false, name: "dcc_session",
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: "lax" }
};
if (!LOCAL_AUTH_ENABLED) {
  sessionOptions.store = new pgSession({ pool: pool, tableName: "session", createTableIfMissing: true, pruneSessionInterval: 15 * 60 });
}
app.use(session(sessionOptions));

// ── Auth Middleware ──
const AUTH_PUBLIC = new Set(["/login", "/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/register", "/api/gcal/callback"]);
const DCC_ENDPOINTS = new Set(["/api/dcc-state/ingest", "/api/ingest/day-state", "/api/dcc/refresh", "/api/dcc/deep-sweep/ingest", "/api/clean-tidy/approve"]);
function isLocalhost(req) { const addr = req.socket.remoteAddress; return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"; }
function hasDccToken(req) { const dccToken = process.env.SECRET_DCC_TOKEN || process.env.SECRET_PA_TOKEN; if (!dccToken) return false; const authHeader = req.headers.authorization || ""; return authHeader.startsWith("Bearer ") ? authHeader.slice(7) === dccToken : false; }
function hasSweepWriteToken(req) { const token = process.env.SECRET_SWEEP_SUITE_TOKEN || process.env.SECRET_DCC_TOKEN || process.env.SECRET_PA_TOKEN; if (!token) return false; const authHeader = req.headers.authorization || ""; return authHeader.startsWith("Bearer ") ? authHeader.slice(7) === token : false; }
function isSweepBlockWrite(req) { return req.method === "POST" && req.path === "/api/blocks" && hasSweepWriteToken(req); }
function attachSweepServiceAuth(req) {
  const userId = Number(req.headers["x-user-id"] || process.env.DCC_SERVICE_USER_ID || 1);
  const workspaceId = req.headers["x-workspace-id"] || process.env.DCC_SERVICE_WORKSPACE_ID || `ws-${userId}`;
  req.dccServiceAuth = { userId, workspaceId, source: "sweep-suite" };
  req.workspaceId = workspaceId;
}
function isAllowedSweepBlockItem(item) { const props = item && item.properties; return item && item.type === "block" && props && props.kind === "sweep_suite_task"; }

app.use((req, res, next) => {
  if (AUTH_PUBLIC.has(req.path)) return next();
  if (isSweepBlockWrite(req)) { attachSweepServiceAuth(req); return next(); }
  if (DCC_ENDPOINTS.has(req.path) && (isLocalhost(req) || hasDccToken(req))) return next();
  if (!req.session.userId) { if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" }); return res.redirect("/login"); }
  next();
});

// ── Workspace Middleware ──
app.use(async (req, res, next) => {
  if (req.dccServiceAuth) { req.workspaceId = req.dccServiceAuth.workspaceId; return next(); }
  if (!req.session.userId) return next();
  if (req.session.workspaceId) { req.workspaceId = req.session.workspaceId; return next(); }
  try {
    const { rows } = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1", [req.session.userId]);
    req.workspaceId = rows[0] ? rows[0].workspace_id : `ws-${req.session.userId}`;
    req.session.workspaceId = req.workspaceId;
    next();
  } catch (err) { next(err); }
});

// ── Auth Routes ──
function sendAuthPage(req, res) {
  if (req.session.userId) return res.redirect("/");
  res.sendFile(path.join(PROJECT_DIR, "login.html"));
}

app.get("/login", sendAuthPage);
app.get("/register", sendAuthPage);

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (LOCAL_AUTH_ENABLED && username === LOCAL_AUTH_USERNAME && password === LOCAL_AUTH_PASSWORD) {
    req.session.userId = LOCAL_AUTH_USER_ID;
    req.session.username = LOCAL_AUTH_USERNAME;
    req.session.workspaceId = LOCAL_AUTH_WORKSPACE_ID;
    return res.json({ ok: true, username: LOCAL_AUTH_USERNAME, workspaceId: LOCAL_AUTH_WORKSPACE_ID, local: true });
  }
  try {
    const user = await auth.findUserByUsername(username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Invalid username or password" });
    req.session.userId = user.id; req.session.username = user.username; req.session.workspaceId = null;
    res.json({ ok: true, username: user.username });
  } catch (e) {
    if (LOCAL_AUTH_ENABLED) return res.status(401).json({ error: "Invalid local username or password" });
    throw e;
  }
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await auth.registerUser({ username, password });
    req.session.userId = result.user.id; req.session.username = result.user.username; req.session.workspaceId = result.workspaceId;
    res.status(201).json({ ok: true, username: result.user.username, workspaceId: result.workspaceId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── SSE ──
const sseClients = new Map();
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("data: connected\n\n");
  const wsId = req.workspaceId || "__global";
  if (!sseClients.has(wsId)) sseClients.set(wsId, new Set());
  sseClients.get(wsId).add(res);
  req.on("close", () => { const clients = sseClients.get(wsId); if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(wsId); } });
});

function broadcast(eventType, data, workspaceId) {
  const payload = JSON.stringify({ type: eventType, ...data });
  let targets;
  if (workspaceId) { targets = sseClients.get(workspaceId) || new Set(); }
  else { targets = new Set(); for (const s of sseClients.values()) s.forEach(c => targets.add(c)); }
  for (const client of targets) { client.write(`data: ${payload}\n\n`); }
}

// ── File Watching ──
[DAY_STATE_FILE, TOMORROW_STATE_FILE].forEach((filePath) => {
  const watchDebounce = {};
  try { fs.watch(filePath, { persistent: false }, () => { const now = Date.now(); if (watchDebounce[filePath] && now - watchDebounce[filePath] < 1000) return; watchDebounce[filePath] = now; broadcast("file-changed", { file: path.basename(filePath, ".json") }); }); } catch {}
});

// ── Helpers ──
function readJSON(filePath, fallback) { try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; } }
function writeJSON(filePath, data) { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8"); }
function updateManifest(date) { const m = readJSON(MANIFEST_FILE, { dates: [] }); if (!m.dates.includes(date)) { m.dates.unshift(date); m.dates.sort().reverse(); } m.lastUpdated = new Date().toISOString(); writeJSON(MANIFEST_FILE, m); }
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function archiveDayState(date, data) { const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!match) return; const [, year, mm] = match; const month = parseInt(mm, 10); const quarter = Math.ceil(month / 3); const monthFolder = `${mm}-${MONTH_NAMES[month]}`; const destDir = path.join(BRAIN_DIR, "archive", year, `Q${quarter}`, monthFolder); if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); const destFile = path.join(destDir, `${date}.json`); const existing = readJSON(destFile, {}); writeJSON(destFile, { ...existing, ...data, source: "api-save", savedAt: new Date().toISOString() }); }
function pruneRecent() { const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; if (!fs.existsSync(RECENT_DIR)) return; for (const fname of fs.readdirSync(RECENT_DIR)) { if (!fname.endsWith(".json") || fname === "manifest.json") continue; const ts = new Date(fname.replace(".json", "") + "T00:00:00").getTime(); if (ts && ts < cutoff) { fs.unlinkSync(path.join(RECENT_DIR, fname)); } } }
function getTodayStr() { return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function addDays(dateStr, n) { const d = new Date(dateStr + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function getDayFilePath(dateStr) { return path.join(DAYS_DIR, dateStr + ".json"); }

async function getMeetingsFromDB(dateStr, userId, workspaceId) {
  const offset = getETOffset(dateStr);
  const { rows } = workspaceId
    ? await pool.query(`SELECT b.id, b.properties, g.attendees_json, g.gcal_event_id, g.html_link FROM blocks b LEFT JOIN gcal_events g ON g.block_id = b.id WHERE b.date = $1 AND b.workspace_id = $2 AND b.type IN ('schedule_item','block') AND b.deleted_at IS NULL ORDER BY b.sort_order ASC`, [dateStr, workspaceId])
    : await pool.query(`SELECT b.id, b.properties, g.attendees_json, g.gcal_event_id, g.html_link FROM blocks b LEFT JOIN gcal_events g ON g.block_id = b.id WHERE b.date = $1 AND b.user_id = $2 AND b.type IN ('schedule_item','block') AND b.deleted_at IS NULL ORDER BY b.sort_order ASC`, [dateStr, userId]);
  const meetings = [], meetingTimeline = [];
  for (const row of rows) {
    const props = typeof row.properties === "string" ? JSON.parse(row.properties) : row.properties;
    if (!props || props.source !== "gcal" || props.all_day || !props.start || !props.end) continue;
    let attendees = [];
    if (row.attendees_json) { const parsed = Array.isArray(row.attendees_json) ? row.attendees_json : []; attendees = parsed.filter(a => !a.self && !a.resource).map(a => a.email); }
    const startISO = `${dateStr}T${props.start}:00${offset}`, endISO = `${dateStr}T${props.end}:00${offset}`;
    const eventId = row.gcal_event_id || props.source_id || row.id;
    meetings.push({ id: eventId, title: props.title || "(No title)", start: startISO, end: endISO, attendees, calUrl: props.calUrl || row.html_link || null, linkedDocUrl: null, linkedDocTitle: null, myResponseStatus: props.rsvp_status || null });
    meetingTimeline.push({ id: "mtg-" + row.id, block_id: row.id, type: "meeting", label: props.title || "(No title)", start: startISO, end: endISO, source: "calendar", source_id: eventId, category: "Meetings", completed: false });
  }
  const seen = new Map(), dedupedMeetings = [], dedupedTimeline = [];
  for (let i = 0; i < meetings.length; i++) { const key = meetings[i].title + "|" + meetings[i].start; const existing = seen.get(key); if (existing !== undefined) { if (meetings[i].myResponseStatus === "accepted" && meetings[existing].myResponseStatus !== "accepted") { dedupedMeetings[existing] = meetings[i]; dedupedTimeline[existing] = meetingTimeline[i]; } } else { seen.set(key, dedupedMeetings.length); dedupedMeetings.push(meetings[i]); dedupedTimeline.push(meetingTimeline[i]); } }
  return { meetings: dedupedMeetings, meetingTimeline: dedupedTimeline };
}

function buildSkeletonState(dateStr) { return { date: dateStr, last_updated_at: new Date().toISOString(), last_updated_by: "skeleton", watermarks: {}, triage: { open_items: [], resolved_items: [], cycle_count: 0 }, sweep: { source_health: [], readers: [], open_item_count: 0, meetings_count: 0 }, glymphatic_brief: { history: [], current: null }, completions: { tasks: [] }, schedule: { working_hours: { start: "07:00", end: "17:30" }, timeline: [], tasks_scheduled: [], tasks_couldnt_fit: [], stats: {} } }; }

async function buildDayResponse(dateStr, userId, workspaceId) {
  const dayFile = getDayFilePath(dateStr);
  let enrichment = readJSON(dayFile, null);
  const isSkeleton = !enrichment || !enrichment.schedule || !enrichment.schedule.timeline || enrichment.schedule.timeline.length === 0;
  if (isSkeleton) {
    const dccRow = await blockDB.getDccState(dateStr, workspaceId || (userId ? `ws-${userId}` : "ws-1"));
    if (dccRow && dccRow.state_json) {
      enrichment = dccRow.state_json;
      writeJSON(dayFile, enrichment);
    } else if (!enrichment) {
      enrichment = buildSkeletonState(dateStr);
      writeJSON(dayFile, enrichment);
    }
  }
  const result = { ...enrichment, date: dateStr };
  if (!result.schedule) result.schedule = { timeline: [] };
  if (!Array.isArray(result.schedule.timeline)) result.schedule.timeline = [];
  result.schedule.blocks = await getScheduleBlocks(userId, workspaceId);
  return result;
}

async function getScheduleBlocks(userId, workspaceId) {
  try {
    const { rows } = workspaceId
      ? await pool.query("SELECT id, parent_id, sort_order, properties FROM blocks WHERE type='schedule_block' AND workspace_id=$1 AND deleted_at IS NULL ORDER BY sort_order", [workspaceId])
      : userId ? await pool.query("SELECT id, parent_id, sort_order, properties FROM blocks WHERE type='schedule_block' AND user_id=$1 AND deleted_at IS NULL ORDER BY sort_order", [userId])
      : await pool.query("SELECT id, parent_id, sort_order, properties FROM blocks WHERE type='schedule_block' AND deleted_at IS NULL ORDER BY sort_order");
    return rows.map(r => { const props = typeof r.properties === "string" ? JSON.parse(r.properties) : r.properties; return { ...props, id: r.id, parent_id: r.parent_id, sort_order: r.sort_order }; });
  } catch(e) { return []; }
}

async function seedScheduleBlocksFromYAML(userId, workspaceId) {
  try {
    const { rows: [existing] } = workspaceId
      ? await pool.query("SELECT COUNT(*) as cnt FROM blocks WHERE type='schedule_block' AND workspace_id=$1 AND deleted_at IS NULL", [workspaceId])
      : userId ? await pool.query("SELECT COUNT(*) as cnt FROM blocks WHERE type='schedule_block' AND user_id=$1 AND deleted_at IS NULL", [userId])
      : await pool.query("SELECT COUNT(*) as cnt FROM blocks WHERE type='schedule_block' AND deleted_at IS NULL");
    if (parseInt(existing.cnt) > 0) return;
    if (!fs.existsSync(USER_CONTEXT_FILE)) return;
    const raw = fs.readFileSync(USER_CONTEXT_FILE, "utf8");
    const match = raw.match(/\bblocks:\s*\r?\n((?:[ \t]+.*\r?\n?)*)/m);
    if (!match) return;
    const blocks = []; let current = null;
    for (const line of match[1].split(/\r?\n/)) {
      const nm = line.match(/^\s+-\s+name:\s+"?([^"\n]+)"?\s*$/); const tp = line.match(/^\s+type:\s+(\w+)/);
      const st = line.match(/^\s+start:\s+"?(\d{2}:\d{2})"?/); const en = line.match(/^\s+end:\s+"?(\d{2}:\d{2})"?/);
      if (nm) { current = { name: nm[1].trim() }; blocks.push(current); }
      else if (tp && current) current.blockType = tp[1]; else if (st && current) current.start = st[1]; else if (en && current) current.end = en[1];
    }
    const valid = blocks.filter(b => b.name && b.blockType && b.start && b.end);
    for (let i = 0; i < valid.length; i++) { await blockDB.createBlock({ type: "schedule_block", properties: { name: valid[i].name, blockType: valid[i].blockType, start: valid[i].start, end: valid[i].end, protected: false, warnThreshold: 0 }, sort_order: i, user_id: userId || null, workspace_id: workspaceId || null }); }
    if (valid.length) console.log("[seed] Migrated " + valid.length + " schedule blocks from YAML");
  } catch(e) { console.error("[seed] Error seeding schedule blocks:", e.message); }
}

function ensureSkeletonDays() {
  const today = getTodayStr();
  for (let i = 0; i < 14; i++) { const dateStr = addDays(today, i); const dayFile = getDayFilePath(dateStr); if (!fs.existsSync(dayFile)) writeJSON(dayFile, buildSkeletonState(dateStr)); }
  if (fs.existsSync(DAYS_DIR)) { const cutoffDate = addDays(today, -14); for (const fname of fs.readdirSync(DAYS_DIR)) { if (!fname.endsWith(".json")) continue; const dateStr = fname.replace(".json", ""); if (dateStr < cutoffDate) { const data = readJSON(path.join(DAYS_DIR, fname), null); if (data) { archiveDayState(dateStr, data); writeJSON(path.join(RECENT_DIR, fname), data); updateManifest(dateStr); } fs.unlinkSync(path.join(DAYS_DIR, fname)); } } }
}

// ── State Endpoints ──
app.get("/api/state/day", async (req, res) => {
  const dateStr = req.query.date || getTodayStr();
  try { res.json(await buildDayResponse(dateStr, req.session.userId, req.workspaceId)); }
  catch (e) { res.json(readJSON(getDayFilePath(dateStr), readJSON(DAY_STATE_FILE, null))); }
});
app.get("/api/state/tomorrow", async (req, res) => {
  const dateStr = addDays(getTodayStr(), 1);
  try { res.json(await buildDayResponse(dateStr, req.session.userId, req.workspaceId)); }
  catch (e) { res.json(readJSON(getDayFilePath(dateStr), readJSON(TOMORROW_STATE_FILE, null))); }
});
app.get("/api/state/upcoming", (req, res) => { res.json(readJSON(UPCOMING_FILE, [])); });
app.get("/api/state/archives", async (req, res) => {
  try {
    // Query Postgres for all dates that have blocks (the source of truth since the migration)
    const result = await pool.query(
      "SELECT DISTINCT date FROM blocks WHERE deleted_at IS NULL AND date IS NOT NULL AND date < CURRENT_DATE ORDER BY date DESC LIMIT 90"
    );
    const archives = {};
    for (const row of result.rows) {
      // pg returns date as a Date object; format as YYYY-MM-DD
      const d = row.date instanceof Date
        ? row.date.toISOString().split("T")[0]
        : String(row.date).split("T")[0];
      // Lightweight stub — the frontend only needs the key for nav;
      // switchToDate() fetches full data via /api/state/day?date=...
      archives[d] = { date: d };
    }
    // Also include any legacy flat-file archives not yet in Postgres
    if (fs.existsSync(ARCHIVE_DIR)) {
      for (const fname of fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json") && f.length === 15)) {
        const dateStr = fname.replace(".json", "");
        if (!archives[dateStr]) {
          const data = readJSON(path.join(ARCHIVE_DIR, fname), null);
          if (data) archives[dateStr] = data;
        }
      }
    }
    res.json(archives);
  } catch (e) {
    console.error("[archives] Postgres query failed, falling back to flat files:", e.message);
    // Fallback to the old flat-file approach
    const archives = {};
    if (fs.existsSync(ARCHIVE_DIR)) {
      for (const fname of fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json") && f.length === 15).sort().reverse().slice(0, 7)) {
        const data = readJSON(path.join(ARCHIVE_DIR, fname), null);
        if (data) archives[fname.replace(".json", "")] = data;
      }
    }
    res.json(archives);
  }
});
app.get("/api/state/local", (req, res) => { res.json(readJSON(LOCAL_UI_STATE_FILE, null)); });

// ── Brain Endpoints ──
// /api/brain/recent retired with reconcileWithServer (Phase 6).
app.get("/api/brain/globals", (req, res) => { res.json(readJSON(GLOBALS_FILE, {})); });
app.get("/api/brain/engrams", (req, res) => {
  const index = readJSON(path.join(ENGRAMS_DIR, "index.json"), {}); const cooccurrence = readJSON(path.join(ENGRAMS_DIR, "co-occurrence.json"), {});
  let taxonomy = readJSON(path.join(ENGRAMS_DIR, "taxonomy.json"), null);
  if (!taxonomy) { taxonomy = { categories: [ { id: "activity", label: "Activities", icon: "\u26a1", color: "#3b82f6" }, { id: "people", label: "People", icon: "\ud83d\udc64", color: "#8b5cf6" }, { id: "book", label: "Books", icon: "\ud83d\udcda", color: "#f59e0b" }, { id: "media", label: "Media", icon: "\ud83c\udfac", color: "#ec4899" }, { id: "meeting", label: "Meetings", icon: "\ud83d\udcc5", color: "#06b6d4" }, { id: "project", label: "Projects", icon: "\ud83c\udfd7\ufe0f", color: "#10b981" }, { id: "place", label: "Places", icon: "\ud83d\udccd", color: "#ef4444" }, { id: "topic", label: "Topics", icon: "\ud83d\udca1", color: "#f97316" }, { id: "wellness", label: "Wellness", icon: "\ud83c\udf3f", color: "#22c55e" }, { id: "custom", label: "Custom", icon: "\ud83c\udff7\ufe0f", color: "#6b7280" } ] }; writeJSON(path.join(ENGRAMS_DIR, "taxonomy.json"), taxonomy); }
  res.json({ index, taxonomy, cooccurrence });
});
app.get("/api/brain/tags", (req, res) => { if (!fs.existsSync(USER_CONTEXT_FILE)) return res.json({}); try { const raw = fs.readFileSync(USER_CONTEXT_FILE, "utf8"); const match = raw.match(/^journal_tags:\s*\n([\s\S]*?)(?=^\S|\Z)/m); if (!match) return res.json({}); const tags = {}; let currentKey = null; for (const line of match[1].split("\n")) { const keyMatch = line.match(/^\s{2}(\w+):\s*$/); const itemMatch = line.match(/^\s{4}-\s+"?([^"]+)"?\s*$/); if (keyMatch) { currentKey = keyMatch[1]; tags[currentKey] = []; } else if (itemMatch && currentKey) tags[currentKey].push(itemMatch[1]); } res.json(tags); } catch (e) { res.json({}); } });
app.get("/api/prep", (req, res) => { if (!fs.existsSync(PREP_DIR)) return res.json({}); const files = {}; for (const fname of fs.readdirSync(PREP_DIR)) { if (!fname.endsWith(".html")) continue; try { files[fname] = fs.readFileSync(path.join(PREP_DIR, fname), "utf8"); } catch {} } res.json(files); });
app.get("/api/prep/:filename", (req, res) => { const fp = path.join(PREP_DIR, req.params.filename); if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" }); res.type("html").send(fs.readFileSync(fp, "utf8")); });
app.get("/api/dcc-log", (req, res) => { if (!fs.existsSync(DCC_LOG_FILE)) return res.json({ html: '<div style="color:var(--text-muted);padding:24px">dcc activity log not found.</div>' }); const raw = fs.readFileSync(DCC_LOG_FILE, "utf8"); const match = raw.match(/(### (\d{4}-\d{2}-\d{2}T[\d:+\-]+) -- (?:overnight-oracle|pa-offpeak|clever-assistant|dcc-refresh)[^\n]*\n)([\s\S]*?)(?=\n---|\Z)/); if (!match) return res.json({ html: '<div style="color:var(--text-muted);padding:24px">No overnight review found.</div>' }); const ts = match[2], body = match[3].trim(); const lines = body.split("\n"), parts = []; let inUl = false; for (const line of lines) { const stripped = line.trim(); if (stripped.startsWith("- ")) { if (!inUl) { parts.push('<ul style="margin:4px 0 8px 16px;padding:0;list-style:disc">'); inUl = true; } parts.push(`<li style="margin:3px 0;font-size:12px;line-height:1.5">${stripped.slice(2).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</li>`); } else { if (inUl) { parts.push("</ul>"); inUl = false; } if (!stripped) parts.push('<div style="height:6px"></div>'); else parts.push(`<div style="font-size:12px;line-height:1.5;margin:2px 0">${stripped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</div>`); } } if (inUl) parts.push("</ul>"); res.json({ html: `<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Last DCC sweep ran <strong style="color:var(--text)">${ts}</strong></div><div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px">${parts.join("\n")}</div></div>`, timestamp: ts }); });

// ── POST: State Persistence ──
// /api/save-day retired Phase 6 -- BlockStore is the source of truth, no client calls this.
// /api/brain/recent (legacy reconcileWithServer endpoint) similarly retired.
app.post("/api/save-globals", (req, res) => { const body = req.body; body.savedAt = new Date().toISOString(); writeJSON(GLOBALS_FILE, body); broadcast("save", { source: "globals" }); res.json({ ok: true }); });
app.post("/api/save-engram-index", (req, res) => { const body = req.body; body.savedAt = new Date().toISOString(); writeJSON(path.join(ENGRAMS_DIR, "index.json"), body); broadcast("save", { source: "engrams" }); res.json({ ok: true }); });

app.post("/api/ingest/day-state", async (req, res) => {
  const incoming = req.body; if (!incoming || !incoming.date) return res.status(400).json({ error: "Missing date" });
  const dayFile = getDayFilePath(incoming.date); const existing = readJSON(dayFile, null) || readJSON(DAY_STATE_FILE, {});
  const DCC_SECTIONS = ["schedule", "triage", "watermarks", "notifications", "assessment", "sweep", "sweep_stats", "glymphatic_brief", "meta", "report_card", "clean_tidy", "orchestrator", "mutations", "completions", "personal"];
  const USER_SECTIONS = ["done", "pushed", "deleted", "durChanges", "notes", "actions", "sessions", "mood", "reviewed", "subtasks"];
  const merged = { ...existing };
  for (const key of DCC_SECTIONS) { if (key in incoming) merged[key] = incoming[key]; }
  for (const key of USER_SECTIONS) { if (key in existing && !(key in incoming)) merged[key] = existing[key]; if (key in incoming && !(key in existing)) merged[key] = incoming[key]; }
  merged.date = incoming.date; merged.last_updated_at = new Date().toISOString(); merged.last_updated_by = incoming.last_updated_by || "scheduled-task";
  delete merged.meetings; delete merged.meetings_tomorrow;
  writeJSON(dayFile, merged); writeJSON(DAY_STATE_FILE, { ...merged, meetings: incoming.meetings || [] });
  try { await blockDB.saveDccState(incoming.date, merged, req.session.userId || null, req.workspaceId || req.headers["x-workspace-id"] || "ws-1"); } catch(e) { console.error("[dcc-state ingest] save failed:", e.message); }
  broadcast("dcc-state-changed", { source: "day-state", date: incoming.date }, req.workspaceId || req.headers["x-workspace-id"]);
  res.json({ ok: true, date: incoming.date });
});

app.post("/api/clean-tidy/approve", (req, res) => {
  const { ids, action } = req.body; if (!ids || !Array.isArray(ids) || !["approve", "deny"].includes(action)) return res.status(400).json({ error: "Expected { ids, action }" });
  const state = readJSON(DAY_STATE_FILE, {}); const ct = state.clean_tidy || {}; const pending = ct.pending_approvals || []; let changed = 0;
  for (const item of pending) { if (ids.includes(item.id) && item.status === "pending") { item.status = action === "approve" ? "approved" : "denied"; item.resolved_at = new Date().toISOString(); changed++; } }
  if (changed) { state.clean_tidy = ct; state.last_updated_at = new Date().toISOString(); state.last_updated_by = "dcc-approval"; writeJSON(DAY_STATE_FILE, state); broadcast("ingest", { source: "clean-tidy-approval", changed }); }
  res.json({ ok: true, action, changed });
});

app.get("/api/health", async (req, res) => {
  const dbConfig = typeof pool.getConfigStatus === "function"
    ? pool.getConfigStatus()
    : { configured: !!process.env.DATABASE_URL };
  try {
    await pool.query("SELECT 1");
    const m = readJSON(MANIFEST_FILE, { dates: [] });
    const ds = readJSON(DAY_STATE_FILE, null);
    res.json({
      status: "ok",
      server: "daily-command-center",
      database: "ok",
      databaseConfigured: dbConfig.configured,
      port: PORT,
      sseClients: sseClients.size,
      datesStored: m.dates.length,
      lastUpdated: m.lastUpdated || null,
      dayStateDate: ds ? ds.date : null,
      uptime: process.uptime(),
    });
  } catch (e) {
    res.status(503).json({
      status: "error",
      server: "daily-command-center",
      database: "error",
      databaseConfigured: dbConfig.configured,
      databaseError: typeof pool.describeError === "function" ? pool.describeError(e) : (e.code || e.name || "DatabaseError"),
    });
  }
});

app.use("/public", express.static(path.join(PROJECT_DIR, "public"), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); res.setHeader("Pragma", "no-cache"); } }));

// ── Block API ──
function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function assertBlockOwnership(block, workspaceId) { if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) { const err = new Error("Block not found"); err.statusCode = 404; throw err; } }
const RESPONSIBILITY_KINDS = new Set(["responsibility_item", "responsibility_trigger"]);

function cadenceDays(props) {
  const n = Number(props.cadenceDays || props.cadence_days || 0);
  if (n > 0) return n;
  const raw = String(props.cadence || "").toLowerCase();
  if (raw === "daily") return 1;
  if (raw === "weekly") return 7;
  if (raw === "biweekly") return 14;
  if (raw === "monthly") return 30;
  if (raw === "quarterly") return 90;
  const m = raw.match(/(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 7;
}

function responsibilityScore(props, at = new Date()) {
  if (!props || props.status === "archived" || props.status === "done") return 0;
  const days = cadenceDays(props);
  const anchor = props.lastCompletedAt || props.createdAt || props.created_at || props.added_at;
  const start = anchor ? new Date(anchor) : at;
  const elapsedDays = Math.max(0, (at - start) / 86400000);
  const base = days ? Math.round((elapsedDays / days) * 100) : 0;
  const boost = Number(props.importanceBoost || props.boost || 0);
  return Math.max(0, Math.min(100, base + boost));
}

function normalizeResponsibility(block) {
  const properties = block.properties || {};
  const importanceScore = responsibilityScore(properties);
  return { ...block, properties: { ...properties, importanceScore } };
}

function taskDuration(props) {
  return Math.max(15, Number(props.estimatedMinutes || props.duration || props.durationMin || 30));
}

async function getResponsibilityBlocks(workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND workspace_id = $1
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND deleted_at IS NULL
         ORDER BY created_at ASC`
      );
  return rows.map(blockDB.parseBlock).map(normalizeResponsibility);
}

async function getResponsibilityBlock(id, workspaceId) {
  const block = await blockDB.getBlock(id);
  if (!block) return null;
  assertBlockOwnership(block, workspaceId);
  if (!RESPONSIBILITY_KINDS.has((block.properties || {}).kind)) return null;
  return normalizeResponsibility(block);
}

async function findResponsibilityBySlug(slug, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND workspace_id=$2 AND deleted_at IS NULL
         LIMIT 1`,
        [slug, workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND deleted_at IS NULL
         LIMIT 1`,
        [slug]
      );
  return rows[0] ? normalizeResponsibility(blockDB.parseBlock(rows[0])) : null;
}

async function upsertResponsibility({ properties, userId, workspaceId }) {
  const slug = properties.slug || String(properties.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const existing = slug ? await findResponsibilityBySlug(slug, workspaceId) : null;
  const nowIso = new Date().toISOString();
  const props = {
    kind: "responsibility_item",
    title: properties.title,
    slug,
    domain: properties.domain || "professional",
    area: properties.area || "general",
    cadenceDays: Number(properties.cadenceDays || 7),
    capacityBucket: properties.capacityBucket || "work_admin",
    estimatedMinutes: Number(properties.estimatedMinutes || 30),
    status: properties.status || "active",
    defaultSubtasks: Array.isArray(properties.defaultSubtasks) ? properties.defaultSubtasks : [],
    createdAt: properties.createdAt || nowIso,
    updatedAt: nowIso,
    ...properties
  };
  if (existing) {
    return normalizeResponsibility(await blockDB.updateBlock(existing.id, { properties: { ...existing.properties, ...props, createdAt: existing.properties.createdAt || props.createdAt } }));
  }
  return normalizeResponsibility(await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null }));
}

function defaultSubtasksForResponsibility(props, alertProps = {}) {
  const configured = Array.isArray(props.defaultSubtasks) ? props.defaultSubtasks.filter(Boolean) : [];
  if (configured.length) return configured;
  if (alertProps.alertType === "offers_amp_zero_expected_matches") {
    return [
      "Open AMP deal link",
      "Open HubSpot deal link",
      "Check Matching & Delays config for the listed combo",
      "Record root cause or resolution note",
      "Escalate/update product team if config or automation needs a fix"
    ];
  }
  return ["Review current state", "Record outcome", "Decide next action"];
}

function hhmmToMinutes(s) {
  if (!s || !/^\d{2}:\d{2}$/.test(s)) return 0;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function firstFreeSlot(start, duration, blockers, dayEnd) {
  let cursor = start;
  for (const b of blockers.sort((a, b) => a.s - b.s)) {
    if (cursor + duration <= b.s) return cursor;
    if (cursor < b.e) cursor = b.e;
  }
  return cursor + duration <= dayEnd + 60 ? cursor : null;
}

async function scheduleResponsibilityTask({ responsibility, date, userId, workspaceId, sourceProps = {}, force = false }) {
  const props = responsibility.properties || {};
  const dateStr = date && isValidDate(date) ? date : getTodayStr();
  const duration = taskDuration({ ...props, ...sourceProps });
  const blocks = await blockDB.getBlocksByDate(dateStr, workspaceId);
  const existing = blocks.find(b => {
    const p = b.properties || {};
    return p.responsibilityId === responsibility.id && p.kind === "responsibility_task" && !p.completedAt;
  });
  if (existing && !force) return { block: existing, created: false, duplicate: true };
  const dayBlocks = await getScheduleBlocks(userId, workspaceId);
  const workBlocks = dayBlocks.filter(b => (b.blockType || b.type) === "work");
  const dayStart = workBlocks[0] ? hhmmToMinutes(workBlocks[0].start) : 9 * 60;
  const dayEnd = workBlocks.length ? hhmmToMinutes(workBlocks[workBlocks.length - 1].end) : 17 * 60;
  const nowMin = dateStr === getTodayStr() ? (new Date().getHours() * 60 + new Date().getMinutes()) : dayStart;
  const blockers = blocks
    .filter(b => (b.properties || {}).start && (b.properties || {}).end)
    .map(b => ({ s: hhmmToMinutes(b.properties.start), e: hhmmToMinutes(b.properties.end) }));
  const slot = firstFreeSlot(Math.max(dayStart, nowMin), duration, blockers, dayEnd) || Math.max(dayStart, nowMin);
  const localId = "resp-task-" + crypto.randomUUID().slice(0, 12);
  const title = sourceProps.title || props.nextTaskTitle || props.title;
  const score = responsibilityScore(props);
  const taskProps = {
    kind: "responsibility_task",
    local_id: localId,
    title,
    duration,
    start: minutesToHHMM(slot),
    end: minutesToHHMM(slot + duration),
    priority: score >= 90 ? "High" : score >= 60 ? "Medium" : "Low",
    meta: "Responsibility · " + (props.area || props.domain || "general") + " · " + duration + "m",
    detail: sourceProps.detail || props.description || "",
    source: "responsibility",
    tags: ["responsibility", props.domain, props.area, props.capacityBucket].filter(Boolean),
    responsibilityId: responsibility.id,
    responsibilityTitle: props.title,
    capacityBucket: props.capacityBucket || null,
    responsibilityScore: score,
    alertKey: sourceProps.alertKey || null,
    alertType: sourceProps.alertType || null,
    ampUrl: sourceProps.ampUrl || null,
    hubspotUrl: sourceProps.hubspotUrl || null,
    createdAt: new Date().toISOString()
  };
  const block = await blockDB.createBlock({ type: "block", date: dateStr, properties: taskProps, sort_order: slot, user_id: userId || null, workspace_id: workspaceId || null });

  const subtasks = defaultSubtasksForResponsibility(props, sourceProps);
  if (subtasks.length) {
    const rootId = await blockDB.ensureDayRoot(dateStr, userId, workspaceId);
    const root = await blockDB.getBlock(rootId);
    const rootProps = root.properties || {};
    const allSubtasks = { ...(rootProps._subtasks || {}) };
    allSubtasks[localId] = subtasks.map((text, i) => ({ id: "st-" + Date.now() + "-" + i, text, done: false, created: new Date().toISOString() }));
    await blockDB.updateBlock(rootId, { properties: { ...rootProps, _subtasks: allSubtasks } });
  }
  return { block, created: true };
}

function parseOffersAmpAlert(text) {
  const raw = text || "";
  if (!/Offers AMP Error|zero expected matches|New deal entered the AMP with zero expected matches/i.test(raw)) return null;
  const ampUrl = (raw.match(/https?:\/\/amp\.listwithclever\.dev\/deals\/\d+/i) || [null])[0];
  const hubspotUrl = (raw.match(/https?:\/\/app\.hubspot\.com\/contacts\/3298701\/record\/0-3\/\d+/i) || [null])[0];
  const address = (raw.match(/Address:\s*([^\n]+)/i) || [null, ""])[1].trim();
  const config = (raw.match(/Config lookup:\s*([^\n]+)/i) || [null, ""])[1].trim();
  const alertKey = hubspotUrl || ampUrl || crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return {
    alertType: "offers_amp_zero_expected_matches",
    alertKey,
    title: "Investigate Offers AMP zero expected matches" + (address ? ": " + address.split(",")[0] : ""),
    detail: [address && "Address: " + address, ampUrl && "AMP: " + ampUrl, hubspotUrl && "HubSpot: " + hubspotUrl, config && "Config lookup: " + config].filter(Boolean).join("\n"),
    ampUrl,
    hubspotUrl,
    address,
    config
  };
}

app.post("/api/blocks", async (req, res) => { try { const body = req.body, userId = req.session.userId || (req.dccServiceAuth && req.dccServiceAuth.userId) || null; const workspaceId = req.workspaceId || (req.dccServiceAuth && req.dccServiceAuth.workspaceId) || null; const items = Array.isArray(body) ? body : [body]; if (req.dccServiceAuth && !items.every(isAllowedSweepBlockItem)) return res.status(403).json({ error: "Sweep Suite token may only create sweep_suite_task blocks" }); const results = []; for (const item of items) results.push(await blockDB.createBlock({ ...item, user_id: userId, workspace_id: workspaceId })); broadcast("blocks-changed", { action: "create", blockIds: results.map(r => r.id), clientId: body._clientId }, workspaceId); res.json(results.length === 1 ? results[0] : results); } catch (e) { res.status(400).json({ error: e.message }); } });
app.patch("/api/blocks/:id", async (req, res) => { try { const existing = await blockDB.getBlock(req.params.id); if (!existing) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(existing, req.workspaceId); const result = await blockDB.updateBlock(req.params.id, req.body); broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId }, req.workspaceId); res.json(result); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });
app.delete("/api/blocks/:id", async (req, res) => { try { const existing = await blockDB.getBlock(req.params.id); if (!existing) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(existing, req.workspaceId); const result = await blockDB.deleteBlock(req.params.id); broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id] }, req.workspaceId); res.json(result); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });
app.post("/api/blocks/batch", async (req, res) => { try { const { operations, _clientId } = req.body; if (!Array.isArray(operations)) return res.status(400).json({ error: "operations must be an array" }); const opsWithUser = operations.map(op => op.op === "create" ? { ...op, user_id: req.session.userId, workspace_id: req.workspaceId } : op); const result = await blockDB.batchOp(opsWithUser); broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b.id || b.reordered).filter(Boolean), clientId: _clientId }, req.workspaceId); res.json(result); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get("/api/blocks", async (req, res) => { try { if (req.query.date) { if (!isValidDate(req.query.date)) return res.status(400).json({ error: "Invalid date" }); await blockDB.ensureDayRoot(req.query.date, req.session.userId, req.workspaceId); res.json(await blockDB.getBlocksByDate(req.query.date, req.workspaceId)); } else if (req.query.type) { const types = req.query.type.split(",").filter(t => blockDB.VALID_TYPES.has(t)); if (!types.length) return res.status(400).json({ error: "No valid types" }); res.json(await blockDB.getBlocksByTypes(types, req.workspaceId)); } else { res.status(400).json({ error: "Provide ?date= or ?type=" }); } } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/blocks/range", async (req, res) => { try { const { start, end } = req.query; if (!start || !end || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: "Provide ?start=&end=" }); res.json(await blockDB.getBlocksByDateRange(start, end, req.workspaceId)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/blocks/:id", async (req, res) => { const block = await blockDB.getBlock(req.params.id); if (!block) return res.status(404).json({ error: "Block not found" }); try { assertBlockOwnership(block, req.workspaceId); } catch { return res.status(404).json({ error: "Block not found" }); } res.json(block); });
app.get("/api/blocks/:id/children", async (req, res) => { try { const parent = await blockDB.getBlock(req.params.id); if (!parent) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(parent, req.workspaceId); res.json(await blockDB.getChildren(req.params.id, req.workspaceId)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); } });
app.post("/api/blocks/reorder", async (req, res) => { try { const { items, _clientId } = req.body; if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" }); for (const item of items) { const block = await blockDB.getBlock(item.id); if (block) assertBlockOwnership(block, req.workspaceId); } await blockDB.reorderBlocks(items); broadcast("blocks-changed", { action: "reorder", blockIds: items.map(i => i.id), clientId: _clientId }, req.workspaceId); res.json({ ok: true, reordered: items.length }); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });

// ── Responsibilities API ──
app.get("/api/responsibilities", async (req, res) => {
  try {
    const items = await getResponsibilityBlocks(req.workspaceId);
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/responsibilities", async (req, res) => {
  try {
    const body = req.body || {};
    const incoming = body.properties || body;
    if (!incoming.title || !String(incoming.title).trim()) return res.status(400).json({ error: "title required" });
    const created = await upsertResponsibility({
      userId: req.session.userId,
      workspaceId: req.workspaceId,
      properties: { ...incoming, title: String(incoming.title).trim() }
    });
    broadcast("blocks-changed", { action: "responsibility-upsert", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch("/api/responsibilities/:id", async (req, res) => {
  try {
    const existing = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Responsibility not found" });
    const incoming = (req.body && req.body.properties) || req.body || {};
    const merged = { ...existing.properties, ...incoming, kind: existing.properties.kind, updatedAt: new Date().toISOString() };
    const updated = normalizeResponsibility(await blockDB.updateBlock(req.params.id, { properties: merged }));
    broadcast("blocks-changed", { action: "responsibility-update", blockIds: [updated.id] }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.delete("/api/responsibilities/:id", async (req, res) => {
  try {
    const existing = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Responsibility not found" });
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "responsibility-delete", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/:id/schedule", async (req, res) => {
  try {
    const responsibility = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") return res.status(404).json({ error: "Responsibility not found" });
    const result = await scheduleResponsibilityTask({
      responsibility,
      date: (req.body && req.body.date) || getTodayStr(),
      userId: req.session.userId,
      workspaceId: req.workspaceId,
      sourceProps: (req.body && req.body.task) || {},
      force: !!(req.body && req.body.force)
    });
    broadcast("blocks-changed", { action: "responsibility-schedule", blockIds: [result.block.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/:id/complete", async (req, res) => {
  try {
    const responsibility = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") return res.status(404).json({ error: "Responsibility not found" });
    const at = (req.body && req.body.completedAt) || new Date().toISOString();
    const updated = normalizeResponsibility(await blockDB.updateBlock(req.params.id, {
      properties: {
        ...responsibility.properties,
        lastCompletedAt: at,
        updatedAt: at,
        lastCompletedTaskId: req.body && req.body.taskId || null
      }
    }));
    broadcast("blocks-changed", { action: "responsibility-complete", blockIds: [updated.id] }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/auto-schedule", async (req, res) => {
  try {
    const threshold = Number((req.body && req.body.threshold) || 70);
    const limit = Math.max(1, Math.min(10, Number((req.body && req.body.limit) || 3)));
    const buckets = Array.isArray(req.body && req.body.capacityBuckets) ? new Set(req.body.capacityBuckets) : null;
    const items = (await getResponsibilityBlocks(req.workspaceId))
      .filter(b => (b.properties || {}).kind === "responsibility_item")
      .filter(b => (b.properties || {}).status !== "archived")
      .filter(b => !buckets || buckets.has((b.properties || {}).capacityBucket))
      .filter(b => responsibilityScore(b.properties) >= threshold)
      .sort((a, b) => responsibilityScore(b.properties) - responsibilityScore(a.properties))
      .slice(0, limit);
    const scheduled = [];
    for (const item of items) {
      const result = await scheduleResponsibilityTask({
        responsibility: item,
        date: (req.body && req.body.date) || getTodayStr(),
        userId: req.session.userId,
        workspaceId: req.workspaceId
      });
      scheduled.push(result);
    }
    broadcast("blocks-changed", { action: "responsibility-auto-schedule", blockIds: scheduled.map(s => s.block.id) }, req.workspaceId);
    res.json({ scheduled });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/responsibilities/capture", async (req, res) => {
  try {
    const text = String((req.body && (req.body.text || req.body.rawCapture)) || "");
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    const alert = parseOffersAmpAlert(text);
    if (alert) {
      const responsibility = await upsertResponsibility({
        userId: req.session.userId,
        workspaceId: req.workspaceId,
        properties: {
          title: "Product Development: Bug Management",
          slug: "product-development-bug-management",
          domain: "professional",
          area: "bug_management",
          cadenceDays: 7,
          capacityBucket: "work_admin",
          estimatedMinutes: 30,
          status: "active",
          defaultSubtasks: defaultSubtasksForResponsibility({}, alert)
        }
      });
      const triggerSlug = "offers-amp-zero-expected-matches";
      const existingTrigger = (await pool.query(
        `SELECT id FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_trigger' AND properties->>'slug'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
        [triggerSlug, req.workspaceId || null]
      )).rows[0];
      if (!existingTrigger) {
        await blockDB.createBlock({
          type: "block",
          parent_id: responsibility.id,
          properties: {
            kind: "responsibility_trigger",
            slug: triggerSlug,
            title: "Offers AMP zero expected matches",
            channel: "#offers_product",
            responsibilityId: responsibility.id,
            alertType: "offers_amp_zero_expected_matches",
            createdAt: new Date().toISOString()
          },
          user_id: req.session.userId,
          workspace_id: req.workspaceId
        });
      }
      const existing = alert.alertKey
        ? (await pool.query(
            `SELECT * FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_task' AND properties->>'alertKey'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
            [alert.alertKey, req.workspaceId || null]
          )).rows[0]
        : null;
      if (existing) return res.json({ responsibility, task: blockDB.parseBlock(existing), duplicate: true });
      const task = await scheduleResponsibilityTask({
        responsibility,
        date: (req.body && req.body.date) || getTodayStr(),
        userId: req.session.userId,
        workspaceId: req.workspaceId,
        sourceProps: alert,
        force: true
      });
      res.json({ responsibility, task: task.block, duplicate: false, parsed: alert });
      return;
    }
    const responsibility = await upsertResponsibility({
      userId: req.session.userId,
      workspaceId: req.workspaceId,
      properties: {
        title: text.split(/\r?\n/)[0].slice(0, 120),
        rawCapture: text,
        domain: "other",
        area: "inbox",
        status: "inbox",
        cadenceDays: 7,
        capacityBucket: "work_admin",
        estimatedMinutes: 30
      }
    });
    res.json({ responsibility, duplicate: false, parsed: null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PIN 3: apply a top-level block diff forward across all future days that
// already have blocks. Matches each target block by (name, blockType); skips
// any day where the current values no longer equal the diff's originalValues
// so per-day customizations on future days are preserved. Nested children are
// NOT propagated in v1 — the client's diff already filters to top-level only.
app.post("/api/blocks/apply-forward", async (req, res) => {
  try {
    const { fromDate, diff } = req.body || {};
    if (!fromDate || !isValidDate(fromDate)) return res.status(400).json({ error: "Invalid fromDate" });
    if (!diff || typeof diff !== "object") return res.status(400).json({ error: "Missing diff" });
    const updates = Array.isArray(diff.updates) ? diff.updates : [];
    const creates = Array.isArray(diff.creates) ? diff.creates : [];
    const deletes = Array.isArray(diff.deletes) ? diff.deletes : [];
    const userId = req.session.userId || null;
    const workspaceId = req.workspaceId || null;

    // Distinct future dates that have non-deleted blocks in this workspace
    const futureDatesResult = await pool.query(
      "SELECT DISTINCT date FROM blocks WHERE deleted_at IS NULL AND date > $1 AND ($2::text IS NULL OR workspace_id = $2) ORDER BY date ASC",
      [fromDate, workspaceId]
    );
    const futureDates = futureDatesResult.rows.map(r => r.date instanceof Date ? r.date.toISOString().split("T")[0] : String(r.date).split("T")[0]);

    const PROP_KEYS = ["name","blockType","start","end","protected","warnThreshold","acceptedTags"];
    function sameProps(current, expected){
      for (const k of PROP_KEYS){
        const cv = current[k] === undefined ? null : current[k];
        const ev = expected[k] === undefined ? null : expected[k];
        if (JSON.stringify(cv) !== JSON.stringify(ev)) return false;
      }
      return true;
    }

    let daysUpdated = 0;
    let daysSkipped = 0;
    let blocksUpdated = 0;
    let blocksCreated = 0;
    let blocksDeleted = 0;
    let skippedCount = 0;
    const skippedDates = [];

    for (const date of futureDates) {
      const dayBlocks = await blockDB.getBlocksByDate(date, workspaceId);
      // Top-level "block" type only; ignore nested children + other types
      const topBlocks = dayBlocks.filter(b => b.type === "block" && !b.parent_id);
      let dayTouched = false;
      let daySkipped = 0;

      // Updates
      for (const u of updates) {
        const target = topBlocks.find(b => (b.properties||{}).name === u.match.name && (b.properties||{}).blockType === u.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, u.originalValues)) { daySkipped++; continue; }
        const merged = Object.assign({}, target.properties || {}, u.newValues);
        await blockDB.updateBlock(target.id, { properties: merged });
        blocksUpdated++;
        dayTouched = true;
      }

      // Creates
      for (const c of creates) {
        const newName = c.block && c.block.properties && c.block.properties.name;
        const existing = topBlocks.find(b => (b.properties||{}).name === newName);
        if (existing) continue; // dedupe: a same-named block is already here
        await blockDB.createBlock({
          type: "block",
          parent_id: null,
          date: date,
          properties: c.block.properties,
          sort_order: c.block.sort_order || 0,
          user_id: userId,
          workspace_id: workspaceId
        });
        blocksCreated++;
        dayTouched = true;
      }

      // Deletes
      for (const d of deletes) {
        const target = topBlocks.find(b => (b.properties||{}).name === d.match.name && (b.properties||{}).blockType === d.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, d.originalValues)) { daySkipped++; continue; }
        await blockDB.deleteBlock(target.id);
        blocksDeleted++;
        dayTouched = true;
      }

      if (dayTouched) daysUpdated++;
      else if (daySkipped > 0) { daysSkipped++; skippedDates.push(date); }
      skippedCount += daySkipped;
    }

    broadcast("blocks-changed", { action: "apply-forward", fromDate, daysUpdated }, workspaceId);
    res.json({ daysUpdated, daysSkipped, blocksUpdated, blocksCreated, blocksDeleted, skippedCount, skippedDates });
  } catch (e) {
    console.error("[apply-forward] error:", e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// ── Delegated Items API (PIN 10.A) ──
// Wraps blockDB CRUD, stamping properties.kind = "delegated_item" on create.
// GET list uses a dedicated db query; mutations reuse the generic
// createBlock/updateBlock/deleteBlock primitives. PATCH and DELETE both
// verify the target's kind discriminator so these routes can't be used
// to modify tags or other type:"block" data.
app.get("/api/delegated-items", async (req, res) => {
  try {
    const items = await blockDB.getDelegatedItems(req.workspaceId);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/delegated-items", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.properties || typeof body.properties !== "object") {
      return res.status(400).json({ error: "properties required" });
    }
    const props = { ...body.properties, kind: "delegated_item" };
    if (!props.title || typeof props.title !== "string" || !props.title.trim()) {
      return res.status(400).json({ error: "properties.title required" });
    }
    const created = await blockDB.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: props,
      sort_order: 0,
      user_id: req.session.userId,
      workspace_id: req.workspaceId
    });
    broadcast("blocks-changed", { action: "delegated-create", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch("/api/delegated-items/:id", async (req, res) => {
  try {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) return res.status(404).json({ error: "Delegated item not found" });
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") {
      return res.status(404).json({ error: "Delegated item not found" });
    }
    const incoming = (req.body && req.body.properties) || {};
    // Preserve kind discriminator — clients cannot unset it via PATCH
    const merged = { ...existing.properties, ...incoming, kind: "delegated_item" };
    const result = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "delegated-update", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.delete("/api/delegated-items/:id", async (req, res) => {
  try {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) return res.status(404).json({ error: "Delegated item not found" });
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") {
      return res.status(404).json({ error: "Delegated item not found" });
    }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// ── Evaluation API (task scoring engine) ──
app.use(require("./evaluation/routes")(blockDB));

// ── PA State API ──
app.get("/api/pa-state/range", async (req, res) => { try { const { start, end } = req.query; if (!start || !end || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: "Provide ?start=&end=" }); const states = await blockDB.getPaStateRange(start, end, req.workspaceId); const result = {}; for (const s of states) result[s.date] = s.state_json; res.json(result); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/pa-state/:date", async (req, res) => { if (!isValidDate(req.params.date)) return res.status(400).json({ error: "Invalid date" }); const state = await blockDB.getPaState(req.params.date, req.workspaceId); res.json(state || { date: req.params.date, state_json: null }); });
app.post("/api/pa-state/ingest", async (req, res) => { try { const { date, ...stateData } = req.body; if (!date || !isValidDate(date)) return res.status(400).json({ error: "Valid date required" }); let userId = req.session.userId || null, workspaceId = req.workspaceId || null; if (!userId) { workspaceId = req.headers["x-workspace-id"] || "ws-1"; const { rows } = await pool.query("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1", [workspaceId]); userId = rows[0] ? rows[0].user_id : 1; } await blockDB.savePaState(date, stateData, userId, workspaceId); broadcast("pa-state-changed", { date }); res.json({ ok: true, date }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ── Migration (legacy) ──
app.post("/api/migrate", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.post("/api/migrate/dry-run", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.get("/api/migrate/status", async (req, res) => { try { const { rows: [bc] } = await pool.query("SELECT COUNT(*) as count FROM blocks WHERE deleted_at IS NULL"); const { rows: [dc] } = await pool.query("SELECT COUNT(*) as count FROM dcc_state"); res.json({ migrated: parseInt(bc.count) > 1, blockCount: parseInt(bc.count), dccStateCount: parseInt(dc.count) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/operations", async (req, res) => { if (!req.query.block_id) return res.status(400).json({ error: "block_id required" }); res.json(await blockDB.getOperations(req.query.block_id, parseInt(req.query.limit) || 50)); });

// ── Meeting Automation ──
app.get("/api/meetings/:blockId/automation", async (req, res) => {
  try {
    res.json(await meetingAutomation.getAutomation(req.params.blockId, req.workspaceId));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/prep", async (req, res) => {
  try {
    const result = await meetingAutomation.generatePrep(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      extraSources: Array.isArray(req.body?.sources) ? req.body.sources : [],
    });
    broadcast("blocks-changed", { action: "meeting-prep", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/transcript/ingest", async (req, res) => {
  try {
    const result = await meetingAutomation.ingestTranscript(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      transcriptText: req.body?.transcriptText || req.body?.text || "",
      sources: Array.isArray(req.body?.sources) ? req.body.sources : [],
    });
    broadcast("blocks-changed", { action: "meeting-transcript", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/actions/approve", async (req, res) => {
  try {
    const result = await meetingAutomation.approveActions(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      actionIds: Array.isArray(req.body?.actionIds) ? req.body.actionIds : [],
    });
    broadcast("blocks-changed", { action: "meeting-actions-approved", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/automation/morning", async (req, res) => {
  try {
    const date = req.query.date || getTodayStr();
    if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date" });
    const result = await meetingAutomation.runMorning(date, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
    });
    broadcast("blocks-changed", { action: "meeting-morning-prep", date }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── GCal ──
app.get("/api/gcal/auth", async (req, res) => { const userId = req.session.userId || 1; const account = gcalAuth.normalizeAccountKey(req.query.account); const url = await gcalAuth.getAuthUrl(userId, account); if (!url) return res.status(500).json({ error: "No credentials configured" }); res.redirect(url); });
app.get("/api/gcal/callback", async (req, res) => { try { const { code, state } = req.query; if (!code) return res.status(400).send("Missing auth code"); const parsed = gcalAuth.decodeState(state); const userId = parsed.userId || req.session.userId || 1; const account = gcalAuth.normalizeAccountKey(parsed.accountKey); await gcalAuth.handleCallback(code, userId, account); gcalSync.startPolling(); res.redirect(`/?gcal=connected&account=${encodeURIComponent(account)}`); } catch (e) { res.status(500).send("OAuth error: " + e.message); } });
app.get("/api/gcal/status", async (req, res) => { res.json(await gcalSync.getSyncStatus()); });
app.post("/api/gcal/disconnect", async (req, res) => { const account = gcalAuth.normalizeAccountKey(req.query.account || req.body?.account); await gcalAuth.deleteAccountTokens(req.session.userId || 1, account); if (!(await gcalAuth.listAuthenticatedAccounts(req.session.userId || 1)).length) gcalSync.stopPolling(); res.json({ ok: true }); });
app.get("/api/gcal/calendars", async (req, res) => { try { const userId = req.session.userId || 1; const existing = await gcalSync.getAllCalendars(); const accounts = await gcalAuth.listAuthenticatedAccounts(userId); for (const account of accounts) { const hasRows = existing.some((c) => (c.account_key || gcalAuth.DEFAULT_ACCOUNT_KEY) === account.key); if (hasRows) continue; const authClient = await gcalAuth.getAuthClient(userId, account.key); if (!authClient) continue; const fetched = await gcalAuth.fetchAndCacheCalendars(authClient); await gcalSync.cacheCalendarsToDb(fetched, account); } res.json(await gcalSync.getAllCalendars()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/gcal/calendars/:id/toggle", async (req, res) => { try { await gcalSync.toggleCalendar(req.params.id, req.body.selected, req.body.accountKey); if (req.body.selected) gcalSync.syncAll().catch(e => console.error("[gcal] Toggle sync error:", e.message)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get("/api/gcal/event/:blockId", async (req, res) => { try { const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); const block = await blockDB.getBlock(req.params.blockId); res.json({ block: block || null, gcal: { ...gcalData, attendees: gcalData.attendees_json || [], conference: gcalData.conference_json || null, organizer: gcalData.organizer_json || null, creator: gcalData.creator_json || null, recurrence: gcalData.recurrence_json || null } }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.patch("/api/gcal/event/:blockId", async (req, res) => { try { const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); const result = await gcalSync.updateEvent(gcalData.gcal_event_id, gcalData.calendar_id, req.body); broadcast("gcal-sync", { action: "update", blockId: req.params.blockId }); res.json({ ok: true, event: result }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/gcal/event/:blockId/attendees", async (req, res) => { try { const { email } = req.body; if (!email) return res.status(400).json({ error: "email required" }); const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); const result = await gcalSync.addAttendee(gcalData.gcal_event_id, gcalData.calendar_id, email); broadcast("gcal-sync", { action: "attendee-add", blockId: req.params.blockId }); res.json({ ok: true, event: result }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete("/api/gcal/event/:blockId/attendees/:email", async (req, res) => { try { const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); const result = await gcalSync.removeAttendee(gcalData.gcal_event_id, gcalData.calendar_id, req.params.email); broadcast("gcal-sync", { action: "attendee-remove", blockId: req.params.blockId }); res.json({ ok: true, event: result }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/gcal/event/:blockId/rsvp", async (req, res) => { try { const { response } = req.body; if (!["accepted", "declined", "tentative"].includes(response)) return res.status(400).json({ error: "Invalid response" }); const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); const result = await gcalSync.rsvp(gcalData.gcal_event_id, gcalData.calendar_id, response); broadcast("gcal-sync", { action: "rsvp", blockId: req.params.blockId }); res.json({ ok: true, event: result }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/gcal/events", async (req, res) => { try { const { calendarId, ...eventData } = req.body; if (!calendarId || !eventData.title) return res.status(400).json({ error: "calendarId and title required" }); const result = await gcalSync.createEvent(calendarId, eventData); broadcast("gcal-sync", { action: "create" }); res.json({ ok: true, event: result }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete("/api/gcal/event/:blockId", async (req, res) => { try { const gcalData = await gcalSync.getGcalEventByBlockId(req.params.blockId); if (!gcalData) return res.status(404).json({ error: "GCal event not found" }); await gcalSync.deleteEvent(gcalData.gcal_event_id, gcalData.calendar_id); broadcast("gcal-sync", { action: "delete", blockId: req.params.blockId }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/api/gcal/sync", async (req, res) => { try { await gcalSync.syncAll(); res.json({ ok: true, status: await gcalSync.getSyncStatus() }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ── Slot Rewards API ──
app.get("/api/slot/state", async (req, res) => {
  try {
    res.json(await slotStore.getState(req.workspaceId, req.session.userId));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.put("/api/slot/settings", async (req, res) => {
  try {
    const account = await slotStore.updateSettings(req.workspaceId, req.session.userId, req.body || {});
    broadcast("slot-changed", { action: "settings-update" }, req.workspaceId);
    res.json(account);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/rewards", async (req, res) => {
  try {
    const reward = await slotStore.createReward(req.workspaceId, req.body || {});
    broadcast("slot-changed", { action: "reward-create" }, req.workspaceId);
    res.status(201).json(reward);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.put("/api/slot/rewards/:id", async (req, res) => {
  try {
    const reward = await slotStore.updateReward(req.workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "reward-update" }, req.workspaceId);
    res.json(reward);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.delete("/api/slot/rewards/:id", async (req, res) => {
  try {
    const result = await slotStore.deleteReward(req.workspaceId, req.params.id);
    broadcast("slot-changed", { action: "reward-delete" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/earn-task", async (req, res) => {
  try {
    const result = await slotStore.earnTaskCredit(req.workspaceId, req.session.userId, req.body || {});
    if (result.awarded) broadcast("slot-changed", { action: "credit-earned" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spin", async (req, res) => {
  try {
    const spin = await slotStore.spin(req.workspaceId, req.session.userId);
    broadcast("slot-changed", { action: "spin" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spins/:id/confirm", async (req, res) => {
  try {
    const spin = await slotStore.confirmSpin(req.workspaceId, req.params.id);
    broadcast("slot-changed", { action: "spin-confirm" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/bank-builders/confirm", async (req, res) => {
  try {
    const result = await slotStore.confirmPendingBankBuilders(req.workspaceId);
    broadcast("slot-changed", { action: "bank-builders-confirm" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

// ── Vault API (Phase 1) ──
// The vault is a git-backed markdown store that holds long-term memory.
// Postgres is working memory (intraday state). These endpoints expose the
// in-memory VaultStore index and typed graph; writes route through the
// SyncManager for durable commit+push.
function vaultReady(res) {
  if (!vault || !vault.ready) { res.status(503).json({ error: "vault not ready" }); return false; }
  return true;
}

app.get("/api/vault/status", (req, res) => {
  const sync = syncMgr ? syncMgr.getStatus() : { status: "disabled" };
  res.json({
    vault: vault && vault.ready ? vault.indexSummary() : { ready: false },
    sync,
    remote: VAULT_REPO_URL ? "configured" : "none",
  });
});

app.get("/api/vault/nodes", (req, res) => {
  if (!vaultReady(res)) return;
  const { type, subtype, has, since } = req.query;
  res.json(vault.list({ type, subtype, hasField: has, sinceDate: since }));
});

app.get("/api/vault/node/*", (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  const node = vault.get(slug);
  if (!node) return res.status(404).json({ error: "not found" });
  res.json(node);
});

app.put("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  const { frontmatter, body, message } = req.body || {};
  try {
    const node = await vault.write(slug, { frontmatter: frontmatter || {}, body: body || "" });
    if (syncMgr) syncMgr.notifyChange({ slug, message });
    res.json(node);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/vault/node/*", async (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  try {
    const removed = await vault.delete(slug);
    if (!removed) return res.status(404).json({ error: "not found" });
    if (syncMgr) syncMgr.notifyChange({ slug, message: `delete ${slug}` });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/vault/graph/*", (req, res) => {
  if (!vaultReady(res)) return;
  const slug = req.params[0];
  res.json(vault.graph(slug));
});

app.post("/api/vault/flush", async (req, res) => {
  if (!syncMgr) return res.status(503).json({ error: "sync disabled" });
  try { await syncMgr.flushAndPush(); res.json(syncMgr.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Static + Fallback ──
app.use(express.static(PROJECT_DIR, { extensions: ["html"], etag: false, lastModified: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); res.setHeader("Pragma", "no-cache"); } }));
app.get("/", (req, res) => { res.sendFile(path.join(PROJECT_DIR, "index.html")); });

// ── Startup ──
let defaultUserId = 1;

async function initVault() {
  let remoteUrl = VAULT_REPO_URL;
  if (remoteUrl && process.env.VAULT_GITHUB_PAT && remoteUrl.startsWith("https://github.com/")) {
    // Inject PAT for non-interactive auth (Railway env). Never log this.
    remoteUrl = remoteUrl.replace("https://github.com/", `https://x-access-token:${process.env.VAULT_GITHUB_PAT}@github.com/`);
  }
  syncMgr = new SyncManager({
    vaultDir: VAULT_DIR,
    queueFile: SYNC_QUEUE_FILE,
    remoteUrl,
    branch: VAULT_BRANCH,
  });
  syncMgr.on("status", (s) => broadcast("vault-sync-status", s));
  await syncMgr.init();
  vault = new VaultStore({ vaultDir: VAULT_DIR, indexFile: VAULT_INDEX_FILE });
  vault.on("vault-changed", (evt) => {
    broadcast("vault-changed", evt);
    if (evt.source !== "local") {
      // External edit (Obsidian via git pull or manual). No commit needed.
      return;
    }
  });
  await vault.init();
  const summary = vault.indexSummary();
  console.log(`  Vault:      ${summary.totalNodes} nodes, ${summary.totalEdges} edges (${VAULT_REPO_URL ? "remote" : "local-only"})`);
}

async function shutdown() {
  try { if (syncMgr) await syncMgr.close(); } catch (e) { console.error("[sync] shutdown:", e.message); }
  try { if (vault) await vault.close(); } catch (e) { console.error("[vault] shutdown:", e.message); }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, async () => {
  console.log(`\n  Daily Command Center`);
  console.log(`  --------------------`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Database:   Postgres (via DATABASE_URL)`);
  console.log(`  Auth:       ${LOCAL_AUTH_ENABLED ? `Local dev login (${LOCAL_AUTH_USERNAME})` : "Session-based -- login at /login"}`);

  try {
    await blockDB.ensureDccStateTable();
    const defaultUser = await auth.ensureDefaultUser();
    if (defaultUser) { defaultUserId = defaultUser.id; const wsId = `ws-${defaultUserId}`; await pool.query("UPDATE blocks SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL", [defaultUserId, wsId]); await pool.query("UPDATE dcc_state SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL", [defaultUserId, wsId]); }
    await blockDB.ensureWorkspacesForAllUsers();
  } catch (e) { console.error("[auth] Startup error:", e.message); }

  try { await gcalSync.init(broadcast, defaultUserId); const gcalAccounts = await gcalAuth.listAuthenticatedAccounts(defaultUserId); if (gcalAccounts.length) { console.log(`  GCal:       Connected (${gcalAccounts.map(a => a.key).join(", ")})`); gcalSync.startPolling(); } else { console.log(`  GCal:       Not connected`); } } catch (e) { console.error("[gcal] Init error:", e.message); }

  try { await initVault(); } catch (e) { console.error("[vault] Init error:", e.message); }
  try { await slotStore.ensureSchema(); } catch (e) { console.error("[slots] Schema error:", e.message); }

  try { ensureSkeletonDays(); } catch (e) {}
  try { await seedScheduleBlocksFromYAML(defaultUserId, `ws-${defaultUserId}`); } catch(e) {}
  try { const purged = await blockDB.purgeSoftDeleted(30); if (purged > 0) console.log(`[Purge] Startup: removed ${purged}`); } catch(e) {}

  setInterval(() => { try { ensureSkeletonDays(); } catch (e) {} }, 6 * 60 * 60 * 1000);
  setInterval(async () => { try { await blockDB.purgeSoftDeleted(30); } catch (e) {} }, 24 * 60 * 60 * 1000);
  console.log();
});
