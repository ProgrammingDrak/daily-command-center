"use strict";

// Slack per-user OAuth — "Tier 2".
//
// WHY THIS EXISTS. `reactions.add` attributes the reaction to whoever owns the
// token, and Slack has no impersonation parameter for reactions (unlike
// chat.postMessage, which historically had `as_user`). So a bot token can only
// ever produce the app's ✅, which is ambiguous on a message several people have
// reacted to. The only way to get a reaction that genuinely reads as a given
// person is a user token belonging to them. That is ONE app with N user
// authorizations — not a bot each.
//
// It also retires machinery rather than adding to it. `oauth.v2.access` returns
// `authed_user.id` cryptographically bound to the code we just redeemed, so the
// email-matching / pending-claim / reaction-handshake trust dance in
// lib/slack-actors.js becomes unnecessary for anyone who connects this way, along
// with SLACK_TEAM_ALLOWLIST and the users.info lookup that needs a bot token.
//
// Shape follows gcal-auth.js (the repo's other OAuth module) with two deliberate
// departures: tokens are ENCRYPTED (see lib/secret-box.js), and the redirect URI
// is read from env at module scope rather than derived from a request Host header,
// because it must byte-match what Slack has registered.
//
// NOT IMPLEMENTED: token rotation. Slack `xoxp-` tokens do not expire unless the
// app opts into rotation, so gcal's entire refresh/expiry apparatus is skipped. If
// rotation is ever switched on, `authed_user.refresh_token` and `expires_in` are
// already carried into the stored envelope — a refresh path would read them there.

const { createSecretBox } = require("./secret-box");

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const ACCESS_URL = "https://slack.com/api/oauth.v2.access";

// Minimal by decision: the mirror needs to add and remove reactions and read
// which ones are present. Enrichment (conversations.replies) and the hasmy:
// catch-up sweep (search.messages) would need history and search scopes, which
// turn the consent screen into "this app can read your messages" — a far harder
// ask, and worth nothing today because prod has no ANTHROPIC_API_KEY and
// enrichment has never run. Slack re-prompts for added scopes later, so widening
// this costs one more authorization and no code.
const DEFAULT_USER_SCOPES = "reactions:read,reactions:write";

function createSlackOAuth({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const CLIENT_ID = env.SLACK_CLIENT_ID || "";
  const CLIENT_SECRET = env.SLACK_CLIENT_SECRET || "";
  const APP_URL = env.APP_URL || env.RENDER_EXTERNAL_URL || "http://localhost:8090";
  const REDIRECT_URI = env.SLACK_REDIRECT_URI || `${APP_URL}/api/slack/callback`;
  const USER_SCOPES = String(env.SLACK_USER_SCOPES || DEFAULT_USER_SCOPES)
    .split(",").map(s => s.trim()).filter(Boolean);

  const configured = () => !!(CLIENT_ID && CLIENT_SECRET);

  // The key is resolved LAZILY and cached, so a server with OAuth switched off
  // boots fine without one, while a server with OAuth ON fails loudly the first
  // time it would otherwise have to store a credential.
  //
  // Deliberately NOT the generate-and-persist-to-disk fallback that
  // server.js getSessionSecret uses off-production: a regenerated session secret
  // just logs people out, but a regenerated token key silently bricks every
  // stored token while appearing to work.
  let boxCache;
  function box() {
    if (boxCache === undefined) {
      boxCache = env.SLACK_TOKEN_ENC_KEY
        ? createSecretBox(env.SLACK_TOKEN_ENC_KEY, "SLACK_TOKEN_ENC_KEY")
        : null;
    }
    if (!boxCache) {
      const error = new Error("SLACK_TOKEN_ENC_KEY is not configured, so a Slack user token cannot be stored");
      error.statusCode = 503;
      throw error;
    }
    return boxCache;
  }

  // base64url JSON, exactly as gcal-auth.js encodeState/decodeState. Unsigned on
  // purpose: the security is the nonce having to match the one this server put in
  // the session, plus state.userId having to match the session's user. decode
  // returns {} rather than throwing so the caller's guard fails closed.
  function encodeState(userId, nonce) {
    return Buffer.from(JSON.stringify({ userId, nonce: String(nonce || "") })).toString("base64url");
  }
  function decodeState(state) {
    if (!state) return {};
    try {
      const parsed = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
      // Anything that is not an object becomes {} so the caller's guard can read
      // `.userId` safely. A catch alone is not enough: `?state=<base64 of "null">`
      // is VALID JSON, so it parses to null and then throws a TypeError on the
      // property read — a 500 where a 400 belongs. gcal-auth.js decodeState has
      // the same hole; a test here caught it before this copy shipped it.
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }

  function getAuthUrl(userId, nonce) {
    if (!configured()) return null;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      // USER scopes only. Sending `scope` would ask to change the app's BOT
      // scopes, which would force a workspace-level reinstall and could disturb
      // the event subscriptions that already work.
      user_scope: USER_SCOPES.join(","),
      redirect_uri: REDIRECT_URI,
      state: encodeState(userId, nonce),
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  // Hand-rolled rather than an SDK, matching lib/slack-actors.js lookupSlackEmail:
  // timeout via AbortSignal, and `data.ok` checked separately from the HTTP status
  // because Slack answers 200 with `{ok:false}`.
  async function exchangeCode(code) {
    if (!configured()) {
      const error = new Error("Slack OAuth is not configured on this server");
      error.statusCode = 503;
      throw error;
    }
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: String(code),
      redirect_uri: REDIRECT_URI,
    });
    const response = await fetchImpl(ACCESS_URL, {
      method: "POST",
      signal: globalThis.AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(`Slack oauth.v2.access failed: ${data.error || response.status}`);
      error.code = data.error || `http_${response.status}`;
      throw error;
    }
    const authed = data.authed_user || {};
    if (!authed.id || !authed.access_token) {
      // A bot-only grant lands here: the person approved the app but no user
      // token came back, so there is nothing to store and nothing to say we
      // succeeded about.
      const error = new Error("Slack returned no user token — the authorization granted only bot scopes");
      error.code = "no_user_token";
      throw error;
    }
    return {
      slackUserId: String(authed.id),
      teamId: String((data.team && data.team.id) || ""),
      teamName: String((data.team && data.team.name) || ""),
      token: String(authed.access_token),
      scopes: String(authed.scope || "").split(",").map(s => s.trim()).filter(Boolean),
      refreshToken: authed.refresh_token ? String(authed.refresh_token) : null,
      expiresIn: Number(authed.expires_in) || null,
    };
  }

  // What actually lands in `user_token_enc`. Versioned so the envelope can grow.
  function sealGrant(grant, atIso = new Date().toISOString()) {
    return box().sealJson({
      v: 1,
      token: grant.token,
      scopes: grant.scopes,
      slackUserId: grant.slackUserId,
      teamId: grant.teamId,
      grantedAt: atIso,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.expiresIn ? { expiresIn: grant.expiresIn } : {}),
    });
  }

  function openGrant(sealed) {
    const grant = box().openJson(sealed);
    return {
      token: String(grant.token || ""),
      scopes: Array.isArray(grant.scopes) ? grant.scopes : [],
      slackUserId: String(grant.slackUserId || ""),
      teamId: String(grant.teamId || ""),
      grantedAt: grant.grantedAt || null,
    };
  }

  return {
    configured, getAuthUrl, encodeState, decodeState, exchangeCode,
    sealGrant, openGrant,
    redirectUri: () => REDIRECT_URI,
    userScopes: () => USER_SCOPES.slice(),
    hasEncryptionKey: () => !!env.SLACK_TOKEN_ENC_KEY,
  };
}

module.exports = { createSlackOAuth, DEFAULT_USER_SCOPES };
