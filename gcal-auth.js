/**
 * gcal-auth.js — Google Calendar OAuth 2.0 Module (Postgres-backed)
 *
 * Handles the full OAuth lifecycle:
 *  - Generating consent URL
 *  - Exchanging auth code for tokens
 *  - Persisting and refreshing tokens (Postgres)
 *  - Providing authenticated API clients
 */

const { google } = require("googleapis");
const pool = require("./pg-pool");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8090";
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_URL}/api/gcal/callback`;
const DEFAULT_ACCOUNT_KEY = "default";
const WORK_ACCOUNT_KEY = "work";
const WORK_ACCOUNT_EMAIL = process.env.GOOGLE_WORK_ACCOUNT_EMAIL || "drake.shadwell@movewithclever.com";

function getEnvOAuthConfig() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  return {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
  };
}

async function loadTokens(userId) {
  if (!userId) return null;
  const { rows } = await pool.query("SELECT tokens FROM gcal_tokens WHERE user_id = $1", [userId]);
  if (!rows[0] || !rows[0].tokens) return null;
  return typeof rows[0].tokens === "string" ? JSON.parse(rows[0].tokens) : rows[0].tokens;
}

async function ensureMultiAccountSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gcal_account_tokens (
      user_id       INTEGER NOT NULL REFERENCES users(id),
      account_key   TEXT NOT NULL,
      account_email TEXT,
      credentials   JSONB NOT NULL DEFAULT '{}',
      tokens        JSONB,
      updated_at    TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, account_key)
    );

    ALTER TABLE gcal_calendars
      ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE gcal_calendars
      ADD COLUMN IF NOT EXISTS account_email TEXT;
    ALTER TABLE gcal_sync_state
      ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE gcal_events
      ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT 'default';
  `);
}

function normalizeAccountKey(accountKey) {
  return accountKey === WORK_ACCOUNT_KEY ? WORK_ACCOUNT_KEY : DEFAULT_ACCOUNT_KEY;
}

function accountEmailFor(accountKey) {
  return normalizeAccountKey(accountKey) === WORK_ACCOUNT_KEY ? WORK_ACCOUNT_EMAIL : null;
}

function encodeState(userId, accountKey) {
  return Buffer.from(JSON.stringify({ userId, accountKey: normalizeAccountKey(accountKey) })).toString("base64url");
}

function decodeState(state) {
  if (!state) return {};
  try { return JSON.parse(Buffer.from(String(state), "base64url").toString("utf8")); }
  catch { return {}; }
}

async function loadAccountTokens(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  if (key === DEFAULT_ACCOUNT_KEY) return loadTokens(userId);
  await ensureMultiAccountSchema();
  const { rows } = await pool.query(
    "SELECT tokens FROM gcal_account_tokens WHERE user_id = $1 AND account_key = $2",
    [userId, key]
  );
  if (!rows[0] || !rows[0].tokens) return null;
  return typeof rows[0].tokens === "string" ? JSON.parse(rows[0].tokens) : rows[0].tokens;
}

async function loadCredentials(userId) {
  if (!userId) return null;
  const { rows } = await pool.query("SELECT credentials FROM gcal_tokens WHERE user_id = $1", [userId]);
  if (!rows[0] || !rows[0].credentials) return null;
  return typeof rows[0].credentials === "string" ? JSON.parse(rows[0].credentials) : rows[0].credentials;
}

async function loadAccountCredentials(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  if (key === DEFAULT_ACCOUNT_KEY) return loadCredentials(userId);
  await ensureMultiAccountSchema();
  const { rows } = await pool.query(
    "SELECT credentials FROM gcal_account_tokens WHERE user_id = $1 AND account_key = $2",
    [userId, key]
  );
  if (!rows[0] || !rows[0].credentials) return null;
  return typeof rows[0].credentials === "string" ? JSON.parse(rows[0].credentials) : rows[0].credentials;
}

async function saveTokens(userId, tokens) {
  if (!userId) return;
  const now = new Date().toISOString();
  const { rows } = await pool.query("SELECT user_id FROM gcal_tokens WHERE user_id = $1", [userId]);
  if (rows.length > 0) {
    await pool.query("UPDATE gcal_tokens SET tokens = $1, updated_at = $2 WHERE user_id = $3", [tokens, now, userId]);
  } else {
    await pool.query(`INSERT INTO gcal_tokens (user_id, credentials, tokens, updated_at) VALUES ($1, $2, $3, $4)`, [userId, {}, tokens, now]);
  }
}

async function saveAccountTokens(userId, accountKey, tokens) {
  const key = normalizeAccountKey(accountKey);
  if (key === DEFAULT_ACCOUNT_KEY) return saveTokens(userId, tokens);
  if (!userId) return;
  await ensureMultiAccountSchema();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO gcal_account_tokens (user_id, account_key, account_email, credentials, tokens, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(user_id, account_key)
     DO UPDATE SET account_email = EXCLUDED.account_email, tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
    [userId, key, accountEmailFor(key), {}, tokens, now]
  );
}

async function deleteTokens(userId) {
  if (!userId) return;
  await pool.query("UPDATE gcal_tokens SET tokens = NULL, updated_at = $1 WHERE user_id = $2", [new Date().toISOString(), userId]);
}

async function deleteAccountTokens(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  if (key === DEFAULT_ACCOUNT_KEY) return deleteTokens(userId);
  await ensureMultiAccountSchema();
  await pool.query(
    "UPDATE gcal_account_tokens SET tokens = NULL, updated_at = $1 WHERE user_id = $2 AND account_key = $3",
    [new Date().toISOString(), userId, key]
  );
}

async function isAuthenticated(userId) {
  const tokens = await loadTokens(userId);
  return !!(tokens && tokens.refresh_token);
}

async function isAccountAuthenticated(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const tokens = await loadAccountTokens(userId, accountKey);
  return !!(tokens && tokens.refresh_token);
}

async function listAuthenticatedAccounts(userId) {
  await ensureMultiAccountSchema();
  const accounts = [];
  if (await isAuthenticated(userId)) {
    accounts.push({ key: DEFAULT_ACCOUNT_KEY, email: null, label: "Personal Google" });
  }
  const { rows } = await pool.query(
    "SELECT account_key, account_email FROM gcal_account_tokens WHERE user_id = $1 AND tokens IS NOT NULL",
    [userId]
  );
  for (const row of rows) {
    accounts.push({
      key: row.account_key,
      email: row.account_email || accountEmailFor(row.account_key),
      label: row.account_key === WORK_ACCOUNT_KEY ? "Work Google" : row.account_key,
    });
  }
  return accounts;
}

async function createOAuthClient(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const creds = await loadAccountCredentials(userId, accountKey);
  const config = (creds && (creds.installed || creds.web)) || getEnvOAuthConfig();
  if (!config) return null;
  return new google.auth.OAuth2(config.client_id, config.client_secret, REDIRECT_URI);
}

async function getAuthUrl(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  const client = await createOAuthClient(userId, key);
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES,
    state: encodeState(userId, key),
    ...(accountEmailFor(key) ? { login_hint: accountEmailFor(key) } : {}),
  });
}

async function handleCallback(code, userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  const client = await createOAuthClient(userId, key);
  if (!client) throw new Error("No credentials configured");
  const { tokens } = await client.getToken(code);
  await saveAccountTokens(userId, key, tokens);
  return tokens;
}

async function getAuthClient(userId, accountKey = DEFAULT_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  const client = await createOAuthClient(userId, key);
  if (!client) return null;
  const tokens = await loadAccountTokens(userId, key);
  if (!tokens) return null;
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    loadAccountTokens(userId, key).then((existing) => {
      saveAccountTokens(userId, key, { ...(existing || {}), ...newTokens });
    }).catch((err) => console.error("[gcal-auth] Token refresh save error:", err.message));
  });
  return client;
}

async function fetchAndCacheCalendars(auth) {
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.calendarList.list();
  return (res.data.items || []).map((c) => ({
    id: c.id, summary: c.summary, description: c.description || "",
    backgroundColor: c.backgroundColor, foregroundColor: c.foregroundColor,
    primary: !!c.primary, accessRole: c.accessRole, selected: c.selected !== false,
  }));
}

module.exports = {
  DEFAULT_ACCOUNT_KEY, WORK_ACCOUNT_KEY, WORK_ACCOUNT_EMAIL,
  ensureMultiAccountSchema, normalizeAccountKey, decodeState,
  loadTokens, loadCredentials, saveTokens, deleteTokens, isAuthenticated,
  loadAccountTokens, loadAccountCredentials, saveAccountTokens, deleteAccountTokens, isAccountAuthenticated, listAuthenticatedAccounts,
  createOAuthClient, getAuthUrl, handleCallback, getAuthClient, fetchAndCacheCalendars,
};
