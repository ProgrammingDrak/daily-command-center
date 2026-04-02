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

const REDIRECT_URI = "http://localhost:8090/api/gcal/callback";

// ── Credential Loading ──

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

// ── OAuth Client ──

function createOAuthClient() {
  const creds = loadCredentials();
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

function getAuthUrl() {
  const client = createOAuthClient();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const client = createOAuthClient();
  if (!client) throw new Error("No credentials configured");

  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  return tokens;
}

function getAuthClient() {
  const client = createOAuthClient();
  if (!client) return null;

  const tokens = loadTokens();
  if (!tokens) return null;

  client.setCredentials(tokens);

  // Auto-refresh and persist new tokens
  client.on("tokens", (newTokens) => {
    const existing = loadTokens() || {};
    const merged = { ...existing, ...newTokens };
    saveTokens(merged);
  });

  return client;
}

function isAuthenticated() {
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
  loadCredentials,
  loadTokens,
  saveTokens,
  deleteTokens,
  createOAuthClient,
  getAuthUrl,
  handleCallback,
  getAuthClient,
  isAuthenticated,
  loadCalendarList,
  saveCalendarList,
  fetchAndCacheCalendars,
  CREDENTIALS_PATH,
  TOKENS_PATH,
  CALENDARS_PATH,
};
