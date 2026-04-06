/**
 * gcal-auth.js — Google Calendar OAuth 2.0 Module
 *
 * Handles the full OAuth lifecycle:
 *  - Generating consent URL
 *  - Exchanging auth code for tokens
 *  - Persisting and refreshing tokens
 *  - Providing authenticated API clients
 */

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const CREDENTIALS_PATH = path.join(__dirname, "data", "gcal-credentials.json");
const TOKENS_PATH = path.join(__dirname, "data", "gcal-tokens.json");
const CALENDARS_PATH = path.join(__dirname, "data", "gcal-calendars.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

const APP_URL = process.env.APP_URL || "http://localhost:8090";
const REDIRECT_URI = `${APP_URL}/api/gcal/callback`;

// ── Credential Loading (file-based — legacy fallback) ──

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

function deleteTokens() {
  if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
}

// ── DB-backed Token Functions (per-user, Phase 3) ──

function loadTokensDb(db, userId) {
  if (!db || !userId) return loadTokens(); // file fallback
  const row = db.prepare("SELECT tokens FROM gcal_tokens WHERE user_id = ?").get(userId);
  if (!row || !row.tokens) return null;
  try { return JSON.parse(row.tokens); } catch { return null; }
}

function loadCredentialsDb(db, userId) {
  if (!db || !userId) return loadCredentials(); // file fallback
  const row = db.prepare("SELECT credentials FROM gcal_tokens WHERE user_id = ?").get(userId);
  if (!row || !row.credentials) return loadCredentials(); // file fallback
  try { return JSON.parse(row.credentials); } catch { return loadCredentials(); }
}

function saveTokensDb(db, userId, tokens) {
  if (!db || !userId) { saveTokens(tokens); return; }
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT user_id FROM gcal_tokens WHERE user_id = ?").get(userId);
  if (existing) {
    db.prepare("UPDATE gcal_tokens SET tokens = ?, updated_at = ? WHERE user_id = ?")
      .run(JSON.stringify(tokens), now, userId);
  } else {
    // No row yet — file fallback for credentials
    const creds = loadCredentials();
    db.prepare(`INSERT INTO gcal_tokens (user_id, credentials, tokens, updated_at) VALUES (?, ?, ?, ?)`)
      .run(userId, creds ? JSON.stringify(creds) : "{}", JSON.stringify(tokens), now);
  }
  saveTokens(tokens); // keep file in sync as fallback during transition
}

function deleteTokensDb(db, userId) {
  if (db && userId) {
    db.prepare("UPDATE gcal_tokens SET tokens = NULL, updated_at = ? WHERE user_id = ?")
      .run(new Date().toISOString(), userId);
  }
  deleteTokens(); // also clear file
}

function isAuthenticatedDb(db, userId) {
  const tokens = loadTokensDb(db, userId);
  return !!(tokens && tokens.refresh_token);
}

// ── OAuth Client ──

function createOAuthClient(db, userId) {
  const creds = db && userId ? loadCredentialsDb(db, userId) : loadCredentials();
  if (!creds) return null;

  // Support both "installed" and "web" credential types
  const config = creds.installed || creds.web;
  if (!config) return null;

  return new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    REDIRECT_URI
  );
}

function getAuthUrl(db, userId) {
  const client = createOAuthClient(db, userId);
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

async function handleCallback(code, db, userId) {
  const client = createOAuthClient(db, userId);
  if (!client) throw new Error("No credentials configured");

  const { tokens } = await client.getToken(code);
  if (db && userId) {
    saveTokensDb(db, userId, tokens);
  } else {
    saveTokens(tokens);
  }
  return tokens;
}

function getAuthClient(db, userId) {
  const client = createOAuthClient(db, userId);
  if (!client) return null;

  const tokens = db && userId ? loadTokensDb(db, userId) : loadTokens();
  if (!tokens) return null;

  client.setCredentials(tokens);

  // Auto-refresh and persist new tokens
  client.on("tokens", (newTokens) => {
    if (db && userId) {
      const existing = loadTokensDb(db, userId) || {};
      saveTokensDb(db, userId, { ...existing, ...newTokens });
    } else {
      const existing = loadTokens() || {};
      saveTokens({ ...existing, ...newTokens });
    }
  });

  return client;
}

function isAuthenticated(db, userId) {
  if (db && userId) return isAuthenticatedDb(db, userId);
  const tokens = loadTokens();
  return !!(tokens && tokens.refresh_token);
}

// ── Calendar List Cache ──

function loadCalendarList() {
  if (!fs.existsSync(CALENDARS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CALENDARS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCalendarList(calendars) {
  fs.writeFileSync(CALENDARS_PATH, JSON.stringify(calendars, null, 2), "utf8");
}

async function fetchAndCacheCalendars(auth) {
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.calendarList.list();
  const items = (res.data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    description: c.description || "",
    backgroundColor: c.backgroundColor,
    foregroundColor: c.foregroundColor,
    primary: !!c.primary,
    accessRole: c.accessRole,
    selected: c.selected !== false, // default to selected
  }));
  saveCalendarList({ calendars: items, fetchedAt: new Date().toISOString() });
  return items;
}

// ── Export ──

module.exports = {
  // File-based (legacy / fallback)
  loadCredentials,
  loadTokens,
  saveTokens,
  deleteTokens,
  // DB-backed (per-user, Phase 3+)
  loadTokensDb,
  loadCredentialsDb,
  saveTokensDb,
  deleteTokensDb,
  isAuthenticatedDb,
  // OAuth (accept optional db/userId for DB-backed operation)
  createOAuthClient,
  getAuthUrl,
  handleCallback,
  getAuthClient,
  isAuthenticated,
  // Calendar cache
  loadCalendarList,
  saveCalendarList,
  fetchAndCacheCalendars,
  CREDENTIALS_PATH,
  TOKENS_PATH,
  CALENDARS_PATH,
};
