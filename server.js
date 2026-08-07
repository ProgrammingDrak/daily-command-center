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
const auth = require("./auth");
const VaultStore = require("./vault-store");
const SyncManager = require("./sync-manager");
const slotStore = require("./slot-store");
const punishmentStore = require("./punishment-store");
const socialStore = require("./social-store");
const budgetStore = require("./budget-store");
const { badRequest, notFound } = require("./slot-account-common");
const routeHelpers = require("./lib/route-helpers");
const tokenStore = require("./token-store");
const validate = require("./middleware/validate");
const schemas = require("./middleware/schemas");
const { resolveOwnerStrict, resolveOwnerLenient } = require("./middleware/resolve-owner");
const { coerceDateString, isValidDate, addMinutesHHMM, intParam, route } = routeHelpers;
const { scoreTaskPoints, resolvePointTag } = require("./slot-scoring");
const capabilities = require("./capabilities");
const petHomeStore = require("./pet-home-store");
const meetingAutomation = require("./meeting-automation");
const dccIntelligence = require("./dcc-intelligence");
const triageSuppressions = require("./triage-suppressions");

// ── Clerk (managed login widget) via the shared drake-auth kit — optional.
// With no keys, social login is simply hidden and the existing
// username/password flow is unaffected. ──
const { createClerkAuth } = require("drake-auth/server");
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || null;
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || null;

const app = express();
app.set("trust proxy", 1); // required for secure cookies behind hosted reverse proxies
const PORT = process.env.PORT || 8090;
const APP_TIME_ZONE = process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York";
const LOCAL_AUTH_ENABLED = process.env.NODE_ENV !== "production" && process.env.DCC_LOCAL_AUTH === "1";
const LOCAL_AUTH_USERNAME = process.env.SEED_USERNAME || "drake";
const LOCAL_AUTH_PASSWORD = process.env.SEED_PASSWORD || "clever123";
const LOCAL_AUTH_USER_ID = Number(process.env.DCC_LOCAL_USER_ID || 1);
const LOCAL_AUTH_WORKSPACE_ID = process.env.DCC_LOCAL_WORKSPACE_ID || `ws-${LOCAL_AUTH_USER_ID}`;
const REALTIME_GCAL_SYNC_ENABLED = false;
const ADMIN_USERNAMES = new Set(
  String(process.env.DCC_ADMIN_USERNAMES || process.env.ADMIN_USERNAMES || LOCAL_AUTH_USERNAME)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
);

const PROJECT_DIR = __dirname;
const DATA_DIR = path.join(PROJECT_DIR, "data");
const STATE_DIR = path.join(DATA_DIR, "state");
const DAY_STATE_FILE = path.join(STATE_DIR, "day-state.json");
const TOMORROW_STATE_FILE = path.join(STATE_DIR, "tomorrow-state.json");
const LOCAL_UI_STATE_FILE = path.join(STATE_DIR, "local-ui-state.json");
const UPCOMING_FILE = path.join(STATE_DIR, "upcoming-meetings.json");
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
//            ephemeral — clone happens on every cold boot. Clones are shallow
//            (--depth 1) with GIT_LFS_SKIP_SMUDGE=1 (see sync-manager.js), so
//            git history and LFS media are not pulled on boot.
// Meetings-dashboard proxy env (GET /meetings/:blockId/dashboard):
//   GH_VAULT_REPO: owner/repo backing meeting dashboards (default ProgrammingDrak/meeting-vault).
//   GH_VAULT_TOKEN: PAT with contents:read on that repo.
//   GH_VAULT_PATH_PREFIX: path prefix for dashboards (default "meetings").
//                 Set to "work/meetings" for the unified mycelium vault (A4 cutover).
const VAULT_DIR = process.env.VAULT_DIR || path.join(PROJECT_DIR, "vault");
const VAULT_INDEX_FILE = path.join(DATA_DIR, ".vault-index.json");
const SYNC_QUEUE_FILE = path.join(DATA_DIR, ".sync-queue.json");
const VAULT_REPO_URL = process.env.VAULT_REPO_URL || null;
const VAULT_BRANCH = process.env.VAULT_BRANCH || "main";
// B2: base64 git-crypt key (A2) unlocks the sensitive dirs at boot; the PIN
// gates reading/writing them from the tab (session-scoped, 30 min). Both are
// write-only Railway env vars — never sent to the browser.
const VAULT_GITCRYPT_KEY_B64 = process.env.VAULT_GITCRYPT_KEY_B64 || null;
const VAULT_SENSITIVE_PIN = process.env.VAULT_SENSITIVE_PIN || null;

[RECENT_DIR, ENGRAMS_DIR, DAYS_DIR].forEach((dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

let vault = null;
let syncMgr = null;

// verify callback stashes the raw body so the Slack Events route can HMAC it
// (express.json otherwise consumes the stream before any route runs).
app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ── Session Setup ──
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    // Render's filesystem is ephemeral: a file-backed secret regenerates on every
    // restart, silently invalidating all sessions. Fail loudly instead.
    throw new Error("[session] SESSION_SECRET must be set in production (file-backed fallback would invalidate sessions on every restart).");
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
const AUTH_PUBLIC = new Set(["/login", "/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/register", "/api/auth/config", "/api/auth/clerk-sync", "/api/gcal/callback", "/vendor/drake-auth/browser.js", "/api/slack/events"]);
const DCC_ENDPOINTS = new Set(["/api/dcc-state/ingest", "/api/ingest/day-state", "/api/dcc/refresh", "/api/dcc/deep-sweep/ingest", "/api/dcc/triage-check/ingest", "/api/dcc/brief/materialize", "/api/dcc/quick-task", "/api/dcc/meeting-artifacts", "/api/dcc/slack-reconcile"]);
function isPublicRoute(req) { return req.path.startsWith("/pet/") || req.path.startsWith("/todo/") || req.path.startsWith("/api/public/") || req.path.startsWith("/public/"); }
function isLocalhost(req) { const addr = req.socket.remoteAddress; return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"; }
// On Render the app runs behind a same-host reverse proxy, so EVERY request's
// socket peer is 127.0.0.1 — trusting localhost there would open the DCC service
// endpoints to the public internet. So localhost is only trusted off-production;
// in production these endpoints require a bearer token (or a real session).
function trustLocalhost(req) { return process.env.NODE_ENV !== "production" && isLocalhost(req); }
function hasDccToken(req) { const dccToken = process.env.SECRET_DCC_TOKEN || process.env.SECRET_PA_TOKEN; if (!dccToken) return false; const authHeader = req.headers.authorization || ""; return authHeader.startsWith("Bearer ") ? authHeader.slice(7) === dccToken : false; }
function hasSweepWriteToken(req) { const token = process.env.SECRET_SWEEP_SUITE_TOKEN || process.env.SECRET_DCC_TOKEN || process.env.SECRET_PA_TOKEN; if (!token) return false; const authHeader = req.headers.authorization || ""; return authHeader.startsWith("Bearer ") ? authHeader.slice(7) === token : false; }
function isDccStateIngest(req) { return req.method === "POST" && req.path === "/api/ingest/day-state"; }
// DB-backed service tokens (token-store.js, rotatable/revocable via
// /api/admin/tokens) with the legacy env-var tokens kept as a fallback.
async function hasServiceToken(req, scope) {
  if (scope === "sweep" ? hasSweepWriteToken(req) : hasDccToken(req)) return true; // env fallback
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  try { return await tokenStore.verifyToken(authHeader.slice(7), scope); }
  catch (e) { console.error("[token-store] verify failed:", e.message); return false; }
}
function attachSweepServiceAuth(req) {
  const userId = Number(req.headers["x-user-id"] || process.env.DCC_SERVICE_USER_ID || 1);
  const workspaceId = req.headers["x-workspace-id"] || process.env.DCC_SERVICE_WORKSPACE_ID || `ws-${userId}`;
  req.dccServiceAuth = { userId, workspaceId, source: "sweep-suite" };
  req.workspaceId = workspaceId;
}
function isAllowedSweepBlockItem(item) { const props = item && item.properties; return item && item.type === "block" && props && props.kind === "sweep_suite_task"; }
function getRequestOrigin(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const proxyIp = req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || forwardedFor;
  return String(proxyIp || req.ip || req.socket?.remoteAddress || "").slice(0, 80) || null;
}
function isAdminSession(req) {
  return ADMIN_USERNAMES.has(String(req.session?.username || "").toLowerCase());
}

function previousDateStr(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function requireAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Admin access required" });
  return res.status(403).send("Admin access required");
}

app.use(async (req, res, next) => {
  try {
    if (AUTH_PUBLIC.has(req.path)) return next();
    if (isPublicRoute(req)) return next();
    if (req.method === "POST" && req.path === "/api/blocks" && await hasServiceToken(req, "sweep")) { attachSweepServiceAuth(req); return next(); }
    if (isDccStateIngest(req) && ((await hasServiceToken(req, "dcc")) || (await hasServiceToken(req, "sweep")))) { attachSweepServiceAuth(req); return next(); }
    if (req.method === "POST" && req.path === "/api/dcc/quick-task" && (trustLocalhost(req) || await hasServiceToken(req, "dcc"))) { attachSweepServiceAuth(req); return next(); }
    // Weekly review digest (B6): the morning-heartbeat hook POSTs this to
    // generate + save notes/reviews/<week>.md. Same DCC-service-token path as
    // quick-task (no session on a headless run); the digest never contains
    // sensitive content, and a token request is `locked` so the gate holds.
    if (req.method === "POST" && req.path === "/api/vault/digest" && (trustLocalhost(req) || await hasServiceToken(req, "dcc"))) { attachSweepServiceAuth(req); return next(); }
    // A Codex chat can transcribe one uploaded journal image and hand the
    // validated source-backed payload to Mycelium without a browser session.
    if (req.method === "POST" && req.path === "/api/vault/journal-image-ingest" && (trustLocalhost(req) || await hasServiceToken(req, "dcc"))) { attachSweepServiceAuth(req); return next(); }
    if (req.method === "POST" && req.path === "/api/dcc/meeting-artifacts" && (trustLocalhost(req) || (await hasServiceToken(req, "dcc")) || (await hasServiceToken(req, "sweep")))) { attachSweepServiceAuth(req); return next(); }
    if (DCC_ENDPOINTS.has(req.path) && (trustLocalhost(req) || await hasServiceToken(req, "dcc"))) return next();
    if (!req.session.userId) { if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" }); return res.redirect("/login"); }
    next();
  } catch (err) { next(err); }
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

// Recording-review dashboard proxy. Streams a meeting's vaulted dashboard.html
// from the private meeting-vault repo, behind DCC login, so the vault token
// never reaches the browser. dashboard_ref on the meeting block is the vault
// slug (set by the recording-review orchestrator via /api/dcc/meeting-artifacts).
app.get("/meetings/:blockId/dashboard", async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect("/login");
  try {
    const block = await blockDB.getBlock(req.params.blockId);
    const ref = block && block.properties && block.properties.dashboard_ref;
    if (!ref) return res.status(404).type("text/plain").send("No recording-review dashboard is attached to this meeting yet.");
    const token = process.env.GH_VAULT_TOKEN;
    if (!token) return res.status(503).type("text/plain").send("Meeting vault not configured (GH_VAULT_TOKEN unset).");
    const repo = process.env.GH_VAULT_REPO || "ProgrammingDrak/meeting-vault";
    // Path prefix under which meeting dashboards live in the vault repo. Default
    // "meetings" preserves the legacy meeting-vault layout exactly. Mycelium's
    // unified vault nests them under work/meetings, so A4's cutover sets
    // GH_VAULT_PATH_PREFIX=work/meetings once this deploys (the A4 enabler).
    const prefix = (process.env.GH_VAULT_PATH_PREFIX || "meetings").replace(/^\/+|\/+$/g, "");
    const slug = String(ref).replace(/[^A-Za-z0-9._-]/g, "");
    const url = `https://api.github.com/repos/${repo}/contents/${prefix}/${encodeURIComponent(slug)}/dashboard.html`;
    const ghResp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json", "User-Agent": "dcc-meeting-vault-proxy" } });
    if (!ghResp.ok) return res.status(502).type("text/plain").send(`Vault fetch failed (${ghResp.status}).`);
    const html = await ghResp.text();
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "private, max-age=300");
    res.send(html);
  } catch (e) {
    console.error("[meeting-dashboard proxy] failed:", e);
    res.status(500).type("text/plain").send("Dashboard proxy error.");
  }
});

app.post("/api/auth/login", validate(schemas.login), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (LOCAL_AUTH_ENABLED && username === LOCAL_AUTH_USERNAME && password === LOCAL_AUTH_PASSWORD) {
    req.session.userId = LOCAL_AUTH_USER_ID;
    req.session.username = LOCAL_AUTH_USERNAME;
    req.session.workspaceId = LOCAL_AUTH_WORKSPACE_ID;
    await recordLoginEvent(req, { userId: LOCAL_AUTH_USER_ID, username: LOCAL_AUTH_USERNAME, workspaceId: LOCAL_AUTH_WORKSPACE_ID });
    return res.json({ ok: true, username: LOCAL_AUTH_USERNAME, workspaceId: LOCAL_AUTH_WORKSPACE_ID, local: true });
  }
  try {
    const user = await auth.findUserByUsername(username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Invalid username or password" });
    req.session.userId = user.id; req.session.username = user.username; req.session.workspaceId = null;
    const { rows } = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1", [user.id]);
    await recordLoginEvent(req, { userId: user.id, username: user.username, workspaceId: rows[0]?.workspace_id || null });
    res.json({ ok: true, username: user.username });
  } catch (e) {
    if (LOCAL_AUTH_ENABLED) return res.status(401).json({ error: "Invalid local username or password" });
    throw e;
  }
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get("/api/me", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, display_name, onboarding_state FROM users WHERE id = $1",
      [req.session.userId]
    );
    const user = rows[0] || {};
    // Identity fields (id + workspaceId) let an automation/skill uniquely pin
    // which person's profile it is operating on after a username/password login.
    res.json({
      userId: user.id || req.session.userId || null,
      username: user.username || req.session.username || "",
      displayName: user.display_name || null,
      workspaceId: req.workspaceId || req.session.workspaceId || null,
      onboardingState: user.onboarding_state || {},
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/me/onboarding", async (req, res) => {
  try {
    const incoming = req.body && typeof req.body === "object" ? req.body : {};
    const updates = incoming.onboardingState && typeof incoming.onboardingState === "object"
      ? incoming.onboardingState
      : incoming;
    const currentResult = await pool.query(
      "SELECT onboarding_state FROM users WHERE id = $1",
      [req.session.userId]
    );
    const current = currentResult.rows[0]?.onboarding_state || {};
    const currentTour = current.dailyCommandCenterTour || {};
    const next = {
      ...current,
      ...updates,
      dailyCommandCenterTour: {
        ...currentTour,
        ...(updates.dailyCommandCenterTour || {}),
      },
    };
    const { rows } = await pool.query(
      `UPDATE users
       SET onboarding_state = $1::jsonb, updated_at = $2
       WHERE id = $3
       RETURNING onboarding_state`,
      [JSON.stringify(next), new Date().toISOString(), req.session.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, onboardingState: rows[0].onboarding_state || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/register", validate(schemas.register), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await auth.registerUser({ username, password });
    req.session.userId = result.user.id; req.session.username = result.user.username; req.session.workspaceId = result.workspaceId;
    await recordLoginEvent(req, { userId: result.user.id, username: result.user.username, workspaceId: result.workspaceId });
    res.status(201).json({ ok: true, username: result.user.username, workspaceId: result.workspaceId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Managed-widget login via drake-auth: mounts GET /api/auth/config and
// POST /api/auth/clerk-sync (token verify + verified-email-only identity live
// in the package). DCC supplies find-or-create over its own users table and
// mints its own dcc_session so every existing route keeps working off
// req.session.userId. Google vs email-code is Clerk application config.
const clerkAuth = createClerkAuth({
  publishableKey: CLERK_PUBLISHABLE_KEY,
  secretKey: CLERK_SECRET_KEY,
  findOrCreateUser: async ({ externalId, email, displayName, avatarUrl, provider }) => {
    const { user, workspaceId } = await auth.findOrCreateExternalUser({ externalId, email, displayName, avatarUrl, provider });
    return { userId: user.id, username: user.username, workspaceId };
  },
  onSession: async (req, { userId, username, workspaceId }) => {
    req.session.userId = userId;
    req.session.username = username;
    req.session.workspaceId = workspaceId;
    await recordLoginEvent(req, { userId, username, workspaceId });
  },
});
app.use(clerkAuth.router);

// The login page loads the shared sign-in module while unauthenticated, so
// this path is in AUTH_PUBLIC.
app.get("/vendor/drake-auth/browser.js", (req, res) => res.sendFile(require.resolve("drake-auth/browser")));

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
// The date half is caller-supplied and reaches here unvalidated from several routes
// (`GET /api/state/day` passes `req.query.date` straight through), and `path.join`
// NORMALIZES `../`, so without this guard the caller chooses the file: a traversal date
// both discloses any readable .json and, on the write paths, creates one anywhere the
// process can write. Guarding the path builder rather than each route means a route
// added later inherits it. Throwing (rather than coercing to today) keeps a malformed
// date an error instead of silently serving the wrong day.
function getDayFilePath(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) throw new Error(`invalid day date: ${dateStr}`);
  return path.join(DAYS_DIR, dateStr + ".json");
}
// Single source of truth for a meeting's stable identity (shared with the backfill
// script). Injected into the materializer and passed into the routes ctx below.
const meetingIdentity = require("./meeting-identity");
function blockProps(block) {
  const props = block && block.properties;
  if (!props) return {};
  if (typeof props === "string") {
    try { return JSON.parse(props); } catch { return {}; }
  }
  return props;
}
function isLegacyGcalBlock(block) {
  if (REALTIME_GCAL_SYNC_ENABLED) return false;
  const props = blockProps(block);
  const source = String(props.source || "").toLowerCase();
  return source === "gcal" || !!props.gcal_event_id || !!props.gcal_calendar_id || !!props.gcal_account_key;
}
// Only suppress legacy `source:"gcal"` blocks on live (today/future) days. These
// predate the calendar-meeting materializer (which writes `source:"calendar"`) and
// are a separate, older population. On past/archive dates a legacy gcal copy may be
// the only record of that day's schedule, so keep it there; otherwise reviewing a
// past day could show a blank schedule. Dateless blocks (?type= globals) are treated
// as live, preserving prior behavior.
function isLiveBlockDate(dateStr) {
  return !dateStr || dateStr >= getTodayStr();
}
function filterLegacyGcalBlocks(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter(block => !(isLiveBlockDate(block && block.date) && isLegacyGcalBlock(block)))
    : blocks;
}
async function ensureFeedbackTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_messages (
      id           SERIAL PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      user_id      INTEGER REFERENCES users(id),
      message      TEXT NOT NULL,
      page_path    TEXT,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at  TIMESTAMPTZ
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_feedback_messages_workspace_created ON feedback_messages(workspace_id, created_at DESC)");
}

async function ensureLoginEventsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_events (
      id           SERIAL PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      user_id      INTEGER REFERENCES users(id),
      username     TEXT,
      event_type   TEXT NOT NULL DEFAULT 'login',
      ip_address   TEXT,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_login_events_workspace_created ON login_events(workspace_id, created_at DESC)");
}

async function recordLoginEvent(req, { userId, username, workspaceId, eventType = "login" }) {
  try {
    await ensureLoginEventsTable();
    await pool.query(
      `INSERT INTO login_events (workspace_id, user_id, username, event_type, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        workspaceId || null,
        userId || null,
        username || null,
        eventType,
        getRequestOrigin(req),
        String(req.headers["user-agent"] || "").slice(0, 500) || null,
      ]
    );
  } catch (e) {
    console.error("[auth] Could not record login event:", e.message);
  }
}

function buildSkeletonState(dateStr) { return { date: dateStr, last_updated_at: new Date().toISOString(), last_updated_by: "skeleton", watermarks: {}, triage: { open_items: [], resolved_items: [], cycle_count: 0 }, sweep: { source_health: [], readers: [], open_item_count: 0, meetings_count: 0 }, glymphatic_brief: { history: [], current: null }, completions: { tasks: [] }, schedule: { working_hours: { start: "07:00", end: "17:30" }, timeline: [], tasks_scheduled: [], tasks_couldnt_fit: [], stats: {} } }; }

// PHASE C5b STEP 4: Postgres wins, and this function no longer WRITES anything.
//
// The bug it fixes: the file used to win whenever it carried a non-empty
// `schedule.timeline`, and `getDayFilePath` is `data/state/days/<date>.json` with NO
// workspace segment, so on Railway's ephemeral filesystem a file written by an earlier
// boot — or by a different workspace — shadowed the correct Postgres row for everybody.
//
// C5a built this, had it rejected by review three times, and PULLED it, because the
// function cannot be fixed alone. All four blockers are resolved here rather than worked
// around, and each one is why a line below looks the way it does:
//
//   1. "A successful read with NO ROW cannot mean empty", because
//      `routes/social-todo.js appendPublicShareTriageItem` was a FILE-ONLY writer holding
//      the sole copy of guest-submitted tasks. FIXED AT THE WRITER, in this same change:
//      it now saves to Postgres as well. That was a live data-loss bug on its own — the
//      only copy of a guest's task lived on an ephemeral filesystem and did not survive a
//      redeploy (0 such items have ever reached the DB on prod, which is the evidence).
//      A no-row read can now honestly mean "no day".
//   2. "Any write from here is amplification on a path reached ANONYMOUSLY"
//      (`buildPublicTodoShare` calls it as `buildDayResponse(date, null,
//      share.workspace_id)`). FIXED BY NOT WRITING. A read builds a response; that is all.
//      It also closes a cross-tenant leak: a guest hitting workspace A's share for date X
//      wrote A's state into the shared unscoped file, which workspace B then read.
//   3. "REMOVING the DB-to-file write is worse, because six handlers in routes/dcc.js read
//      this file as BASE state and then full-replace the Postgres row" — so with no
//      rehydration the boot skeleton gets promoted over the real day. FIXED IN THOSE SIX
//      HANDLERS, in this same change: `readDccDayState` reads Postgres first. That was the
//      crux, and it is why this could never be one file's diff.
//   4. "A failed read collapsed into the same branch as an empty one lets an outage mint a
//      skeleton, serve it as a real day, and persist it." FIXED BY THROWING: an outage with
//      no file to fall back on is an error, not an empty Tuesday. Both `/api/state/day` and
//      `/api/state/tomorrow` already catch and serve the file mirror.
//
// STILL OPEN, and it is Track A's (A4) to close: `getDayFilePath` has no workspace segment,
// so the FALLBACK path is still shared across tenants. Latent today — only ws-1 has any
// `dcc_state` row on prod — but ws-3 exists in `blocks`, and a workspace with no row for a
// date reads whatever the last workspace left in that file. The fix is a file layout change,
// which is not this phase's to make.
async function buildDayResponse(dateStr, userId, workspaceId) {
  const ws = workspaceId || (userId ? `ws-${userId}` : "ws-1");
  let enrichment = null;
  let dbFailed = false;
  try {
    const dccRow = await blockDB.getDccState(dateStr, ws);
    if (dccRow && dccRow.state_json) enrichment = dccRow.state_json;
  } catch (e) {
    dbFailed = true;
    console.error(`[day-response] Postgres read failed for ${dateStr} (${ws}):`, e.message);
  }
  if (!enrichment) enrichment = readJSON(getDayFilePath(dateStr), null);
  // The outage branch, kept separate from the empty-day branch on purpose (blocker 4). A
  // skeleton served here would be indistinguishable from a real empty day to every caller.
  if (!enrichment && dbFailed) throw new Error(`Day state unavailable for ${dateStr}: Postgres read failed and no file mirror exists`);
  // A genuinely absent day. Built, served, and NOT written (blocker 2).
  if (!enrichment) enrichment = buildSkeletonState(dateStr);
  const result = { ...enrichment, date: dateStr };
  if (!result.schedule) result.schedule = { timeline: [] };
  if (!Array.isArray(result.schedule.timeline)) result.schedule.timeline = [];
  // Meetings are materialized into real task blocks at ingest (meeting-materializer.js)
  // and render on every date through the client-side block fold; historical dates were
  // backfilled by scripts/backfill-meeting-blocks.mjs. meetings[] stays in state as the
  // ingest payload (data.js reads it for meeting-prep), but is no longer synthesized
  // into read-time timeline ghosts. Strip any stale type:"meeting"/"oneone" item a saved
  // day file still carries in its timeline so it can't double-render against the block.
  result.schedule.timeline = (result.schedule.timeline || []).filter(
    (item) => !(item && (item.type === "meeting" || item.type === "oneone"))
  );
  // Concurrent, not sequential: neither reads the other's result, and this is the
  // hottest read path in the app (both state endpoints, plus the anonymous share poll
  // through buildPublicTodoShare). Both swallow their own errors and resolve to [],
  // so Promise.all adds no rejection path.
  const [scheduleBlocks, suppressions] = await Promise.all([
    getScheduleBlocks(userId, workspaceId),
    readTriageSuppressionsForWorkspace(ws),
  ]);
  result.schedule.blocks = scheduleBlocks;
  // Apply the durable triage suppressions on the way out, so a handled item is gone on
  // every device and every day, not just in the tab that handled it. This is also the
  // half that heals the rows already on prod: state written before suppressions existed
  // still carries the full open list, and filtering on read means nobody waits for the
  // next publish to see their own decisions. `suppressed_items` rides along scoped to
  // THIS date, because the client renders one day's "Completed" list and its Undo from
  // it (see the scoping note in triage-suppressions.js).
  result.triage = triageSuppressions.applyTriageSuppressions(result.triage, suppressions, { date: dateStr, timeZone: APP_TIME_ZONE });
  // The `result._deleted` surfacing query that used to sit here is GONE (A2 step 6).
  // #253 added it for exactly one consumer, carryover-review.js, so that pass would not
  // re-offer a timeline task the user had deleted. C1 (#261) deleted carryover-review.js
  // and its replacement, catch-up.js, does not read the field. Verified zero readers
  // before removing: every other `_deleted` reference in the repo (persistence.js,
  // state.js, lib/recurrence.js, routes/social-todo.js, scripts/fold-diff.mjs) reads the
  // overlay off the day_root BLOCK's properties, which is a different source and is
  // untouched. This was a second per-day query on every day-response read, for nobody.
  return result;
}

// Same best-effort contract routes/dcc.js uses: suppressions are an overlay, and an
// unreadable overlay must degrade to "show the raw triage list" rather than fail the
// whole day response.
async function readTriageSuppressionsForWorkspace(workspaceId) {
  try {
    const blocks = await blockDB.getBlocksByKind(triageSuppressions.SUPPRESSION_KIND, workspaceId);
    return triageSuppressions.suppressionsFromBlocks(blocks);
  } catch (e) {
    console.error("[day-response] triage suppression read failed (non-fatal):", e.message);
    return [];
  }
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
    for (let i = 0; i < valid.length; i++) { await blockDB.createBlock({ type: "schedule_block", properties: { name: valid[i].name, blockType: valid[i].blockType, start: valid[i].start, end: valid[i].end, protected: false, warnThreshold: 0 }, sort_order: (i + 1) * 1000, user_id: userId || null, workspace_id: workspaceId || null }); }
    if (valid.length) console.log("[seed] Migrated " + valid.length + " schedule blocks from YAML");
  } catch(e) { console.error("[seed] Error seeding schedule blocks:", e.message); }
}

function ensureSkeletonDays() {
  const today = getTodayStr();
  for (let i = 0; i < 14; i++) { const dateStr = addDays(today, i); const dayFile = getDayFilePath(dateStr); if (!fs.existsSync(dayFile)) writeJSON(dayFile, buildSkeletonState(dateStr)); }
  if (fs.existsSync(DAYS_DIR)) { const cutoffDate = addDays(today, -14); for (const fname of fs.readdirSync(DAYS_DIR)) { if (!fname.endsWith(".json")) continue; const dateStr = fname.replace(".json", ""); if (dateStr < cutoffDate) { const data = readJSON(path.join(DAYS_DIR, fname), null); if (data) { archiveDayState(dateStr, data); writeJSON(path.join(RECENT_DIR, fname), data); updateManifest(dateStr); } fs.unlinkSync(path.join(DAYS_DIR, fname)); } } }
}

// ── State Endpoints ──
// The degraded answer for a day whose state could not be read, and it answers for the day
// that was ASKED FOR. Found by curl, not by the suite (C5b): `buildDayResponse` now THROWS
// when Postgres is down and no file mirror exists, instead of minting and persisting a
// skeleton — and these two catches used to fall through to `DAY_STATE_FILE` /
// `TOMORROW_STATE_FILE`, which hold whatever day was last published. So asking for
// 2027-03-09 during an outage answered with 2026-06-03's state, stamped with 2026-06-03. A
// client cannot defend against that: `data.js transformState` reads `state.date`, sees a past
// date, treats the timeline as archive and renders that unrelated day's items under the
// heading you were looking at.
//
// So the per-date file is still tried, and after that it is an EMPTY day for the right date,
// carrying `_unavailable` so a surface can say "couldn't load" rather than "nothing planned".
// Never written: an unpersisted skeleton cannot become the base state a later full-replace
// promotes over the real day, which is the whole reason blocker 4 existed.
// The file-mirror ladder, in ONE place. `routes/dcc.js readDccDayState` needs exactly this
// and had a hand-copy of it, which had already drifted in a way that mattered: this version
// stamps the requested date onto the per-date file result and that one returned the file's
// own `date`, so a mirror with a stale `date` field fed a full-replace `saveDccState` under
// the wrong day there and was normalized here. Shared through ctx like the other day-state
// primitives (`getDayFilePath`, `readJSON`, `buildSkeletonState`).
//
// Returns null when nothing on disk is about this date. `legacyFile` is a "last published
// day" file (`DAY_STATE_FILE` / `TOMORROW_STATE_FILE`) with no workspace segment and no date
// guarantee, so its own `date` is the only thing that makes it relevant.
function readDayStateMirror(dateStr, legacyFile) {
  const own = readJSON(getDayFilePath(dateStr), null);
  if (own) return { ...own, date: dateStr };
  const legacy = readJSON(legacyFile, null);
  return (legacy && legacy.date === dateStr) ? legacy : null;
}

function dayStateUnavailable(dateStr, legacyFile, err) {
  console.error(`[day-response] serving a degraded day for ${dateStr}:`, err && err.message);
  return readDayStateMirror(dateStr, legacyFile) || { ...buildSkeletonState(dateStr), _unavailable: true };
}

app.get("/api/state/day", async (req, res) => {
  const dateStr = req.query.date || getTodayStr();
  // Reject a malformed date as a 400 here, so getDayFilePath's throw cannot land in the
  // catch below and turn into a 500 (or, worse, a second traversal attempt).
  //
  // res.status().json(), NOT the imported `badRequest`. That helper is
  // `(message) => httpError(message, 400)` — it BUILDS an error for a caller to THROW
  // (`throw badRequest("...")`, as routes/social-todo.js uses it), it does not send a
  // response. `return badRequest(res, "Invalid date")` therefore sent nothing and the
  // request HUNG FOREVER. Caught by probing the guard with curl rather than by a test:
  // the ingest-route test covers routes/dcc.js's guard, which was written with
  // res.status(400).json() and worked, so the suite stayed green while this one hung.
  if (!isValidDate(dateStr)) return res.status(400).json({ error: "Invalid date" });
  try { res.json(await buildDayResponse(dateStr, req.session.userId, req.workspaceId)); }
  catch (e) { res.json(dayStateUnavailable(dateStr, DAY_STATE_FILE, e)); }
});
app.get("/api/state/tomorrow", async (req, res) => {
  const dateStr = addDays(getTodayStr(), 1);
  try { res.json(await buildDayResponse(dateStr, req.session.userId, req.workspaceId)); }
  catch (e) { res.json(dayStateUnavailable(dateStr, TOMORROW_STATE_FILE, e)); }
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
app.get("/api/prep/:filename", (req, res) => { const safeName = path.basename(req.params.filename); if (safeName !== req.params.filename || !safeName.endsWith(".html")) return res.status(400).json({ error: "Invalid filename" }); const fp = path.join(PREP_DIR, safeName); if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" }); res.type("html").send(fs.readFileSync(fp, "utf8")); });
app.get("/api/dcc-log", (req, res) => { if (!fs.existsSync(DCC_LOG_FILE)) return res.json({ html: '<div style="color:var(--text-muted);padding:24px">dcc activity log not found.</div>' }); const raw = fs.readFileSync(DCC_LOG_FILE, "utf8"); const match = raw.match(/(### (\d{4}-\d{2}-\d{2}T[\d:+\-]+) -- (?:overnight-oracle|pa-offpeak|clever-assistant|dcc-refresh)[^\n]*\n)([\s\S]*?)(?=\n---|\Z)/); if (!match) return res.json({ html: '<div style="color:var(--text-muted);padding:24px">No overnight review found.</div>' }); const ts = match[2], body = match[3].trim(); const lines = body.split("\n"), parts = []; let inUl = false; for (const line of lines) { const stripped = line.trim(); if (stripped.startsWith("- ")) { if (!inUl) { parts.push('<ul style="margin:4px 0 8px 16px;padding:0;list-style:disc">'); inUl = true; } parts.push(`<li style="margin:3px 0;font-size:12px;line-height:1.5">${stripped.slice(2).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</li>`); } else { if (inUl) { parts.push("</ul>"); inUl = false; } if (!stripped) parts.push('<div style="height:6px"></div>'); else parts.push(`<div style="font-size:12px;line-height:1.5;margin:2px 0">${stripped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</div>`); } } if (inUl) parts.push("</ul>"); res.json({ html: `<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Last DCC sweep ran <strong style="color:var(--text)">${ts}</strong></div><div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px">${parts.join("\n")}</div></div>`, timestamp: ts }); });

app.post("/api/feedback", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const pagePath = String(req.body?.pagePath || req.body?.path || "").slice(0, 500);
    if (!message) return res.status(400).json({ error: "Feedback message is required" });
    if (message.length > 4000) return res.status(400).json({ error: "Feedback message is too long" });
    await ensureFeedbackTable();
    const { rows } = await pool.query(
      `INSERT INTO feedback_messages (workspace_id, user_id, message, page_path, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, workspace_id, user_id, message, page_path, created_at`,
      [req.workspaceId || null, req.session.userId || null, message, pagePath || null, String(req.headers["user-agent"] || "").slice(0, 500) || null]
    );
    res.status(201).json({ ok: true, feedback: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/activity", requireAdmin, async (req, res) => {
  try {
    await ensureFeedbackTable();
    await ensureLoginEventsTable();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 80, 1), 200);
    const activitySql = `SELECT id, workspace_id, user_id, username, event_type, ip_address, user_agent, created_at
       FROM login_events
       ORDER BY created_at DESC, id DESC
       LIMIT $1`;
    const feedbackSql = `SELECT id, workspace_id, user_id, message, page_path, created_at, resolved_at
       FROM feedback_messages
       ORDER BY created_at DESC, id DESC
       LIMIT $1`;
    const [{ rows: activityRows }, { rows: feedbackRows }] = await Promise.all([
      pool.query(activitySql, [limit]),
      pool.query(feedbackSql, [limit]),
    ]);
    const activity = activityRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      workspaceId: row.workspace_id,
      timestamp: row.created_at,
      origin: row.ip_address || "Unknown",
    }));
    res.json({
      workspaceId: null,
      summary: {
        activityCount: activity.length,
        feedbackCount: feedbackRows.length,
        latestActivityAt: activity[0]?.timestamp || null,
        latestFeedbackAt: feedbackRows[0]?.created_at || null,
      },
      activity,
      feedback: feedbackRows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST: State Persistence ──
app.post("/api/save-globals", (req, res) => { const body = req.body; body.savedAt = new Date().toISOString(); writeJSON(GLOBALS_FILE, body); broadcast("save", { source: "globals" }); res.json({ ok: true }); });
app.post("/api/save-engram-index", (req, res) => { const body = req.body; body.savedAt = new Date().toISOString(); writeJSON(path.join(ENGRAMS_DIR, "index.json"), body); broadcast("save", { source: "engrams" }); res.json({ ok: true }); });

// DCC ingest + brief routes extracted to routes/dcc.js (mounted below).

// WHICH COMMIT IS SERVING. Everything else here answers "is it alive", and the CI
// canary job polls this endpoint for exactly that — which is why a green canary has
// twice now meant nothing: A2 merged during a Railway incident where NO deployment
// was created at all, every job went green, and the old container kept answering
// "ok" happily. C1 hit the same trap with a 17-minute queue. With no version marker
// there was no question the canary could ask that would tell the difference.
//
// Railway injects RAILWAY_GIT_COMMIT_SHA at build time. The fallbacks cover other
// hosts (Render's SOURCE_VERSION, a generic GIT_COMMIT_SHA) and local runs report
// null rather than lying. `curl $PROD/api/health | jq -r .revision` now answers
// "did my merge actually deploy" for a SERVER-only change, which previously needed
// a behavioral probe because there was no asset to grep.
const REVISION = process.env.RAILWAY_GIT_COMMIT_SHA
  || process.env.GIT_COMMIT_SHA
  || process.env.SOURCE_VERSION
  || null;

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
      revision: REVISION,
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
      revision: REVISION,
      databaseError: typeof pool.describeError === "function" ? pool.describeError(e) : (e.code || e.name || "DatabaseError"),
    });
  }
});

app.get("/public/js/app-config.js", (req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(`window.DCC_APP_TIME_ZONE=${JSON.stringify(APP_TIME_ZONE)};`);
});
app.use("/public", express.static(path.join(PROJECT_DIR, "public"), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); res.setHeader("Pragma", "no-cache"); } }));

// Calendar meetings -> durable task blocks (see meeting-materializer.js).
const meetingMaterializer = require("./meeting-materializer")({
  blockDB, scoreTaskPoints, resolvePointTag, meetingIdentity, APP_TIME_ZONE,
});

// ── Route modules ──
// Shared context handed to each route module. Plain consts are captured by
// value (they never change); vault/syncMgr are getters because startup
// initializes them after routes mount.
const ctx = {
  APP_TIME_ZONE, DAY_STATE_FILE, DCC_ENDPOINTS, REALTIME_GCAL_SYNC_ENABLED, SyncManager, VAULT_REPO_URL, VaultStore, auth, badRequest, blockDB, broadcast, buildDayResponse, buildSkeletonState, capabilities, crypto, filterLegacyGcalBlocks, getDayFilePath, getRequestOrigin, getScheduleBlocks, getTodayStr, isAllowedSweepBlockItem, meetingAutomation, notFound, path, petHomeStore, pool, punishmentStore, budgetStore, readDayStateMirror, readJSON, readTriageSuppressionsForWorkspace, requireAdmin, scoreTaskPoints, session, slotStore, socialStore, updateManifest, writeJSON,
  dccIntelligence, resolveOwnerStrict, resolveOwnerLenient, previousDateStr, DATA_DIR,
  meetingMaterializer, meetingIdentity, VAULT_SENSITIVE_PIN,
  ...routeHelpers,
  get vault() { return vault; },
  get syncMgr() { return syncMgr; },
};
require("./routes/social-todo")(app, ctx);
require("./routes/pet-home")(app, ctx);
require("./routes/blocks")(app, ctx);
require("./routes/dcc")(app, ctx);
require("./routes/evaluation")(app, ctx);
require("./routes/meeting")(app, ctx);
require("./routes/gcal")(app, ctx);
require("./routes/slots")(app, ctx);
require("./routes/budget")(app, ctx);
require("./routes/punishments")(app, ctx);
require("./routes/vault")(app, ctx);
require("./routes/admin-tokens")(app, ctx);
require("./routes/admin-model")(app, ctx);
require("./routes/slack-events")(app, ctx);

// ── Static + Fallback ──
app.get("/pet/:shareSlug", (req, res) => { res.sendFile(path.join(PROJECT_DIR, "public-pet.html")); });
app.get("/todo/:token", (req, res) => { res.sendFile(path.join(PROJECT_DIR, "public-todo.html")); });
app.use(express.static(PROJECT_DIR, { extensions: ["html"], etag: false, lastModified: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); res.setHeader("Pragma", "no-cache"); } }));
app.get("/", (req, res) => { res.sendFile(path.join(PROJECT_DIR, "index.html")); });
app.get("/admin", requireAdmin, (req, res) => { res.sendFile(path.join(PROJECT_DIR, "admin.html")); });

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
    // A2 git-crypt: unlock the sensitive dirs during syncMgr.init(), which the
    // line below awaits BEFORE VaultStore.init() indexes — order per UNLOCK.md.
    gitcryptKeyB64: VAULT_GITCRYPT_KEY_B64,
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

// ── Global error handler (last middleware) ──
// Catches anything routes didn't. Full error goes to the server log; the client
// gets a generic message in production so Postgres/internal details never leak.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  const message = process.env.NODE_ENV === "production" ? "Internal server error" : String((err && err.message) || err);
  res.status(err && err.status ? err.status : 500).json({ error: message });
});

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
    await ensureFeedbackTable();
    await ensureLoginEventsTable();
    const defaultUser = await auth.ensureDefaultUser();
    if (defaultUser) { defaultUserId = defaultUser.id; const wsId = `ws-${defaultUserId}`; await pool.query("UPDATE blocks SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL", [defaultUserId, wsId]); await pool.query("UPDATE dcc_state SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL", [defaultUserId, wsId]); }
    await blockDB.ensureWorkspacesForAllUsers();
    const triageBackfilled = await blockDB.backfillLegacyTriageSuppressions();
    if (triageBackfilled > 0) console.log(`[triage] Backfilled ${triageBackfilled} legacy suppression(s)`);
  } catch (e) { console.error("[auth] Startup error:", e.message); }

  console.log(`  GCal:       Realtime sync disabled; hiding legacy cached calendar blocks`);

  try { await initVault(); } catch (e) { console.error("[vault] Init error:", e.message); }
  try { await slotStore.ensureSchema(); } catch (e) { console.error("[slots] Schema error:", e.message); }

  try { ensureSkeletonDays(); } catch (e) {}
  // Time-block containers (Morning Work/Lunch/etc.) removed 2026-07 -- no longer seeded.
  try { const purged = await blockDB.purgeSoftDeleted(30); if (purged > 0) console.log(`[Purge] Startup: removed ${purged}`); } catch(e) {}

  setInterval(() => { try { ensureSkeletonDays(); } catch (e) {} }, 6 * 60 * 60 * 1000);
  setInterval(async () => { try { await blockDB.purgeSoftDeleted(30); } catch (e) {} }, 24 * 60 * 60 * 1000);
  console.log();
});
