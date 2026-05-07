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

async function loadCredentials(userId) {
  if (!userId) return null;
  const { rows } = await pool.query("SELECT credentials FROM gcal_tokens WHERE user_id = $1", [userId]);
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

async function deleteTokens(userId) {
  if (!userId) return;
  await pool.query("UPDATE gcal_tokens SET tokens = NULL, updated_at = $1 WHERE user_id = $2", [new Date().toISOString(), userId]);
}

async function isAuthenticated(userId) {
  const tokens = await loadTokens(userId);
  return !!(tokens && tokens.refresh_token);
}

async function createOAuthClient(userId) {
  const creds = await loadCredentials(userId);
  const config = (creds && (creds.installed || creds.web)) || getEnvOAuthConfig();
  if (!config) return null;
  return new google.auth.OAuth2(config.client_id, config.client_secret, REDIRECT_URI);
}

async function getAuthUrl(userId) {
  const client = await createOAuthClient(userId);
  if (!client) return null;
  return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}

async function handleCallback(code, userId) {
  const client = await createOAuthClient(userId);
  if (!client) throw new Error("No credentials configured");
  const { tokens } = await client.getToken(code);
  await saveTokens(userId, tokens);
  return tokens;
}

async function getAuthClient(userId) {
  const client = await createOAuthClient(userId);
  if (!client) return null;
  const tokens = await loadTokens(userId);
  if (!tokens) return null;
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    loadTokens(userId).then((existing) => {
      saveTokens(userId, { ...(existing || {}), ...newTokens });
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
  loadTokens, loadCredentials, saveTokens, deleteTokens, isAuthenticated,
  createOAuthClient, getAuthUrl, handleCallback, getAuthClient, fetchAndCacheCalendars,
};
