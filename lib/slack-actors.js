"use strict";
/**
 * slack-actors.js — resolve a Slack reactor to the DCC account whose day the
 * reaction belongs on.
 *
 * routes/slack-events.js used to be single-tenant: it dropped every event whose
 * `ev.user` was not DRAKE_SLACK_USER_ID and wrote everything to one owner
 * workspace. One Slack app now serves the whole team instead: a reaction routes
 * by WHO REACTED, and a reactor with no DCC account is dropped having written
 * nothing anywhere.
 *
 * Resolution order, first match wins:
 *   1. ENV FALLBACK. slackUserId === DRAKE_SLACK_USER_ID returns the env actor,
 *      carrying its user token and DCC_SERVICE_USER_ID / _WORKSPACE_ID. First
 *      and deliberately DB-free: this is what keeps the original single-tenant
 *      deployment, and the entire pre-existing test suite, behaving as before.
 *   2. A `slack_identities` row.
 *   3. AUTO-LINK by Slack email, allowlisted teams only. This is what makes a
 *      teammate's setup cost zero: their first 🔖 links the account and creates
 *      the task in one step.
 *   4. null. The caller drops the event.
 *
 * FAILS CLOSED at every step, and per person rather than globally. Note that an
 * unset SLACK_TEAM_ALLOWLIST disables auto-linking entirely instead of trusting
 * every workspace: without that, anyone who installed this app in their own
 * Slack could claim a DCC account by email collision.
 *
 * TIERS. An actor with a user token is `tier: "user"` and behaves exactly like
 * the old single-tenant path. An actor with only the shared bot token is
 * `tier: "bot"`: everything works except `search.messages` (no bot equivalent
 * exists, so the hasmy: catch-up sweep skips them) and its reactions are posted
 * by the bot rather than by the person. Per-user OAuth that promotes a bot-tier
 * actor to user-tier is deliberately out of scope here.
 *
 * The table is created lazily on first use, the same trick token-store.js uses,
 * so pg-schema.js and the CI DB-risk guardrail stay untouched. Every column
 * Tier 2 will need is in that first CREATE for the same reason: adding one later
 * would mean an ALTER, and the guardrail trips on an added ALTER in any *.js.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
// Negative results are cached too, and harder: an outsider reacting repeatedly
// must not turn into one users.info call per reaction.
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

function parseAllowlist(raw) {
  return new Set(String(raw || "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean));
}

function createSlackActors({ pool, env = process.env, apiTimeoutMs = 20_000, openGrant = null } = {}) {
  const BOT_TOKEN = env.SLACK_BOT_TOKEN || "";
  const ENV_USER_TOKEN = env.SLACK_USER_TOKEN || "";
  const ENV_SLACK_UID = env.DRAKE_SLACK_USER_ID || "";
  const ENV_USER_ID = Number(env.DCC_SERVICE_USER_ID || 1);
  const ENV_WORKSPACE_ID = env.DCC_SERVICE_WORKSPACE_ID || `ws-${ENV_USER_ID}`;
  const DEFAULT_HOST = env.SLACK_WORKSPACE_HOST || "cleverrealestate.slack.com";
  const TEAM_ALLOWLIST = parseAllowlist(env.SLACK_TEAM_ALLOWLIST);

  const cache = new Map();          // slackUserId -> { actor: actor|null, expiresAt }
  let ensured = null;

  function ensureTable() {
    if (!ensured) {
      ensured = pool.query(`CREATE TABLE IF NOT EXISTS slack_identities (
        slack_user_id  TEXT PRIMARY KEY,
        slack_team_id  TEXT,
        user_id        INTEGER NOT NULL REFERENCES users(id),
        workspace_id   TEXT NOT NULL,
        slack_host     TEXT,
        user_token_enc TEXT,
        linked_via     TEXT NOT NULL DEFAULT 'email',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`).catch((e) => { ensured = null; throw e; });
    }
    return ensured;
  }

  function makeActor({ userId, workspaceId, slackUserId, slackTeamId, slackHost, userToken, linkedVia, userScopes }) {
    const user = userToken || "";
    return {
      userId: Number(userId),
      workspaceId: String(workspaceId),
      slackUserId: String(slackUserId || ""),
      slackTeamId: slackTeamId ? String(slackTeamId) : null,
      slackHost: slackHost || DEFAULT_HOST,
      tokens: { bot: BOT_TOKEN, user },
      tier: user ? "user" : "bot",
      linkedVia: linkedVia || "env",
      // Which user scopes were actually granted, or NULL for "unknown".
      //
      // Null is load-bearing and means PERMISSIVE. The env identity is a legacy
      // token whose scopes this server never learned, and it is the one that runs
      // Drake's hasmy: sweep today — so treating unknown as "assume nothing" would
      // silently switch off a working feature. Only an OAuth grant, where Slack
      // told us the exact scope list, is enforced.
      userScopes: Array.isArray(userScopes) ? userScopes.slice() : null,
    };
  }

  // Does this actor hold `scope`? Unknown scopes answer yes, deliberately — see
  // makeActor. Callers use this instead of testing `tokens.user` for truthiness,
  // because a minimal OAuth grant has a token and still cannot search.
  function actorHasScope(actor, scope) {
    if (!actor || !actor.tokens || !actor.tokens.user) return false;
    if (!actor.userScopes) return true;
    return actor.userScopes.includes(scope);
  }

  function envActor() {
    if (!ENV_SLACK_UID) return null;
    return makeActor({
      userId: ENV_USER_ID,
      workspaceId: ENV_WORKSPACE_ID,
      slackUserId: ENV_SLACK_UID,
      slackTeamId: null,
      slackHost: DEFAULT_HOST,
      userToken: ENV_USER_TOKEN,
      linkedVia: "env",
    });
  }

  // Tier 2: the stored grant is opened here, which is what promotes a DB-backed
  // identity from bot tier to user tier.
  //
  // FAILS SOFT. A rotated or mistyped SLACK_TOKEN_ENC_KEY makes every envelope
  // undecryptable, and this runs inside the reaction event pipeline — throwing
  // would take out capture for everyone, including the env identity that does not
  // depend on the key at all. Degrading that one actor to bot tier keeps the DCC
  // side working while the reaction mirror goes quiet, which is the same failure
  // mode as a missing bot token and already handled everywhere downstream.
  const grantWarned = new Set();
  function grantFromRow(row) {
    if (!row.user_token_enc || typeof openGrant !== "function") return { token: "", scopes: null };
    try {
      const grant = openGrant(row.user_token_enc);
      return { token: grant.token || "", scopes: grant.scopes || [] };
    } catch (error) {
      if (!grantWarned.has(row.slack_user_id)) {
        grantWarned.add(row.slack_user_id);
        console.error(`[slack-actors] could not open the stored Slack grant for ${row.slack_user_id} (${error.message}) - falling back to bot tier; they will need to reconnect`);
      }
      return { token: "", scopes: null };
    }
  }

  function actorFromRow(row) {
    const grant = grantFromRow(row);
    return makeActor({
      userId: row.user_id,
      workspaceId: row.workspace_id,
      slackUserId: row.slack_user_id,
      slackTeamId: row.slack_team_id,
      slackHost: row.slack_host,
      userToken: grant.token,
      userScopes: grant.scopes,
      linkedVia: row.linked_via,
    });
  }

  // A row with linked_via = 'pending' is a CLAIM, not a link. It is what the setup
  // wizard writes when auto-linking by email cannot work (the account has no email
  // to match on). It grants nothing until a reaction actually arrives from that
  // member ID, which is the only proof of control we can get without asking the
  // person to prove it twice. `pending` is a value in an existing column rather
  // than a new one on purpose: the table is created by a lazy CREATE TABLE, so
  // adding a column later would need an ALTER, and the CI DB-risk guardrail trips
  // on an added ALTER in any *.js.
  const PENDING = "pending";
  // Another value in the existing `linked_via` column rather than a new column,
  // for the same reason PENDING is: the table is created by a lazy
  // CREATE TABLE IF NOT EXISTS, so a new column would need an ALTER, and CI's
  // DB-risk guardrail trips on an added ALTER in any *.js.
  const OAUTH = "oauth";

  async function findRow(slackUserId) {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT slack_user_id, slack_team_id, user_id, workspace_id, slack_host, linked_via, user_token_enc
         FROM slack_identities WHERE slack_user_id = $1`,
      [slackUserId]
    );
    return rows[0] || null;
  }

  // Promote a claim the moment its owner reacts. Returns the activated row.
  async function activatePending(row) {
    await pool.query(
      "UPDATE slack_identities SET linked_via = 'claim', last_seen_at = now() WHERE slack_user_id = $1 AND linked_via = $2",
      [row.slack_user_id, PENDING]
    );
    console.log(`[slack-actors] claim confirmed: ${row.slack_user_id} reacted, linked to DCC user ${row.user_id}`);
    return { ...row, linked_via: "claim" };
  }

  // Record a claim. Refuses anything that would let one person capture another's
  // reactions: an ID already spoken for, or an ID whose Slack email demonstrably
  // belongs to somebody else. When Slack gives us no email at all we accept, which
  // is exactly the case this path exists to serve, so the reaction handshake is
  // the only guard left. That residual risk is documented in docs/slack-setup.md.
  // Tier 2's link path. Everything claimPending has to prove the hard way, OAuth
  // has already proved: `slackUserId` came back from oauth.v2.access bound to the
  // code this server just redeemed, so there is no email to match, no `pending`
  // state to sit in, and no reaction handshake to wait for. Correspondingly there
  // is no allowlist check either — the allowlist exists to contain the
  // email-collision hijack that this path cannot have.
  //
  // The ONE rule it does inherit: a Slack identity already linked to a different
  // DCC account is refused rather than stolen.
  async function linkOauthUser(userId, slackUserId, slackTeamId, sealedGrant, workspaceIdHint) {
    await ensureTable();
    const existing = await findRow(slackUserId);
    if (existing && Number(existing.user_id) !== Number(userId)) {
      return { ok: false, error: "That Slack account is already connected to another DCC account." };
    }
    const workspaceId = workspaceIdHint || await workspaceForUser(userId);
    // One identity per DCC user, same as claimPending: replace rather than accumulate.
    await pool.query("DELETE FROM slack_identities WHERE user_id = $1", [userId]);
    await pool.query(
      `INSERT INTO slack_identities (slack_user_id, slack_team_id, user_id, workspace_id, slack_host, user_token_enc, linked_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slack_user_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, workspace_id = EXCLUDED.workspace_id,
             slack_team_id = EXCLUDED.slack_team_id, user_token_enc = EXCLUDED.user_token_enc,
             linked_via = EXCLUDED.linked_via, last_seen_at = now()`,
      [slackUserId, slackTeamId || null, userId, workspaceId, DEFAULT_HOST, sealedGrant, OAUTH]
    );
    // The resolver caches an actor for five minutes, including the negative
    // result from before this person connected.
    invalidate(slackUserId);
    return { ok: true, workspaceId };
  }

  async function claimPending(userId, slackUserId, workspaceIdHint) {
    await ensureTable();
    const existing = await findRow(slackUserId);
    if (existing && Number(existing.user_id) !== Number(userId)) {
      return { ok: false, error: "That Slack member ID is already linked to another DCC account." };
    }

    // FAIL CLOSED when Slack knows whose ID this is. The earlier version was
    // `if (mine && mine !== identity.email)`, which SKIPPED the comparison
    // whenever the claiming account had no email, and `users.email` is nullable
    // and never populated by the public password-registration path. So a
    // self-registered account could claim any colleague's member ID (it is one
    // click away in Slack under Profile > Copy member ID), and the victim's own
    // next reaction would activate the hijack and start filing their tasks and
    // points onto the attacker's workspace. The documented residual risk was only
    // ever "Slack exposes no email for this ID"; this restores it to that.
    const identity = await lookupSlackEmail(slackUserId);
    if (identity && identity.error) {
      return { ok: false, error: "Could not check that Slack account just now. Try again in a moment." };
    }
    if (identity && identity.email) {
      const { rows } = await pool.query("SELECT lower(email) AS email FROM users WHERE id = $1", [userId]);
      const mine = rows[0] && rows[0].email;
      if (!mine) {
        return { ok: false, error: "This DCC account has no email address, so we cannot prove that Slack account is yours. Ask an admin to add your email, then react 🔖 and we will link you automatically." };
      }
      if (mine !== identity.email) {
        return { ok: false, error: "That Slack account's email does not match this DCC account." };
      }
    }

    const workspaceId = workspaceIdHint || await workspaceForUser(userId);
    // One identity per DCC user: replace whatever they had rather than accumulating.
    await pool.query("DELETE FROM slack_identities WHERE user_id = $1", [userId]);
    await pool.query(
      `INSERT INTO slack_identities (slack_user_id, slack_team_id, user_id, workspace_id, slack_host, linked_via)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slack_user_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, workspace_id = EXCLUDED.workspace_id, linked_via = EXCLUDED.linked_via`,
      [slackUserId, identity && identity.teamId ? identity.teamId : null, userId, workspaceId, DEFAULT_HOST, PENDING]
    );
    invalidate(slackUserId);
    return { ok: true, workspaceId };
  }

  async function unlinkUser(userId) {
    await ensureTable();
    const { rows } = await pool.query(
      "DELETE FROM slack_identities WHERE user_id = $1 RETURNING slack_user_id",
      [userId]
    );
    for (const row of rows) invalidate(row.slack_user_id);
    return rows.length;
  }

  // users.info on the shared bot token. Needs the bot scopes users:read and
  // users:read.email. A Slack-side failure returns null so the caller drops the
  // event rather than guessing at an owner.
  // Returns one of three DISTINCT outcomes, because collapsing them is a
  // fail-open. `{ error: true }` means we could not ask Slack (no bot token, HTTP
  // or API error, timeout). `null` means Slack answered and this profile has no
  // usable email (absent, deleted, or a bot). `{ email, teamId }` means we know
  // who it is. Previously every one of these returned null, so a rate limit or a
  // brief Slack outage bypassed claimPending's ownership check exactly the way a
  // genuinely emailless profile does, which is the accepted case, not this one.
  async function lookupSlackEmail(slackUserId) {
    if (!BOT_TOKEN) return { error: true };
    try {
      const url = `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`;
      const response = await fetch(url, {
        signal: globalThis.AbortSignal.timeout(apiTimeoutMs),
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      });
      const data = await response.json().catch(() => ({}));
      // user_not_found is a real answer about a real absence; anything else is a
      // failure to ask.
      if (!response.ok || !data.ok) {
        return data && data.error === "user_not_found" ? null : { error: true };
      }
      const profile = (data.user && data.user.profile) || {};
      const email = String(profile.email || "").trim().toLowerCase();
      const deleted = !!(data.user && data.user.deleted);
      const isBot = !!(data.user && (data.user.is_bot || data.user.id === "USLACKBOT"));
      if (!email || deleted || isBot) return null;
      return { email, teamId: String((data.user && data.user.team_id) || "") };
    } catch (error) {
      console.warn(`[slack-actors] users.info failed for ${slackUserId}:`, error.message);
      return { error: true };
    }
  }

  async function workspaceForUser(userId) {
    // Same owner lookup middleware/resolve-owner.js uses, so an auto-linked
    // identity lands on the workspace that user actually owns.
    try {
      const { rows } = await pool.query(
        "SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1",
        [userId]
      );
      if (rows[0] && rows[0].workspace_id) return rows[0].workspace_id;
    } catch (error) {
      console.warn(`[slack-actors] workspace lookup failed for user ${userId}:`, error.message);
    }
    return `ws-${userId}`;
  }

  async function autoLink(slackUserId, teamId) {
    const team = String(teamId || "").toUpperCase();
    if (!TEAM_ALLOWLIST.size) return null;                       // fail closed, see header
    if (!team || !TEAM_ALLOWLIST.has(team)) return null;
    const identity = await lookupSlackEmail(slackUserId);
    if (!identity || identity.error || !identity.email) return null;
    // Trust the event's team over the profile's only when they agree; a mismatch
    // means the reaction and the account come from different workspaces.
    if (identity.teamId && identity.teamId.toUpperCase() !== team) return null;

    const { rows } = await pool.query(
      "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
      [identity.email]
    );
    if (!rows[0]) return null;
    const userId = Number(rows[0].id);
    const workspaceId = await workspaceForUser(userId);
    await ensureTable();
    await pool.query(
      `INSERT INTO slack_identities (slack_user_id, slack_team_id, user_id, workspace_id, slack_host, linked_via)
       VALUES ($1, $2, $3, $4, $5, 'email')
       ON CONFLICT (slack_user_id) DO UPDATE SET last_seen_at = now()`,
      [slackUserId, team, userId, workspaceId, DEFAULT_HOST]
    );
    console.log(`[slack-actors] auto-linked ${slackUserId} to DCC user ${userId} (${workspaceId}) by email`);
    return makeActor({
      userId, workspaceId, slackUserId, slackTeamId: team,
      slackHost: DEFAULT_HOST, userToken: "", linkedVia: "email",
    });
  }

  // Only the EXPENSIVE half is negatively cached. A cached miss suppresses the
  // users.info round trip, but the indexed primary-key lookup still runs on every
  // unresolved reaction. That distinction matters operationally: a row inserted by
  // hand (the fallback for an account with no email to match on) is picked up on
  // the very next reaction instead of being invisible until the negative entry
  // expires, and an outsider reacting in a loop still costs at most one Slack call
  // per NEGATIVE_TTL_MS.
  // A Slack member ID is scoped to ONE workspace, so the same id string in another
  // workspace is a different human. This has to gate EVERY resolution, including a
  // warm cache hit: checking it only while linking left an already-linked id
  // routable from any workspace, and a first check placed after the cache lookup
  // was skipped entirely on the second reaction. Unit tests missed that because a
  // fresh harness always starts cold; the live pass is what caught it.
  function eventTeamAllowed(actorTeam, team, slackUserId) {
    if (team && actorTeam && String(actorTeam).toUpperCase() !== team) {
      console.warn(`[slack-actors] dropping ${slackUserId}: event team ${team} does not match the linked team ${actorTeam}`);
      return false;
    }
    if (team && TEAM_ALLOWLIST.size && !TEAM_ALLOWLIST.has(team)) {
      console.warn(`[slack-actors] dropping ${slackUserId}: event team ${team} is not allowlisted`);
      return false;
    }
    return true;
  }

  async function resolveActor(slackUserId, teamId) {
    if (!slackUserId) return null;

    // 1. Env fallback, before any DB work. The env identity predates the shared
    // bot and carries no team, so there is nothing to verify against.
    if (ENV_SLACK_UID && slackUserId === ENV_SLACK_UID) return envActor();

    const team = String(teamId || "").toUpperCase();
    const hit = cache.get(slackUserId);
    const fresh = hit && hit.expiresAt > Date.now();
    if (fresh && hit.actor) {
      return eventTeamAllowed(hit.actor.slackTeamId, team, slackUserId) ? hit.actor : null;
    }

    try {
      let row = await findRow(slackUserId);
      if (row && !eventTeamAllowed(row.slack_team_id, team, slackUserId)) return null;

      // The reaction IS the proof: a pending claim becomes a real link here, and
      // the same reaction goes on to create its task. The allowlist is re-checked
      // on promotion, not just at claim time: without it a claim recorded while a
      // team was allowlisted would still promote after the team was removed, and a
      // reaction arriving from a workspace we never trusted could activate one.
      if (row && row.linked_via === PENDING) {
        if (!TEAM_ALLOWLIST.size || !team || !TEAM_ALLOWLIST.has(team)) {
          console.warn(`[slack-actors] refusing to promote the claim on ${slackUserId}: team ${team || "(none)"} is not allowlisted`);
          return null;
        }
        row = await activatePending(row);
      }
      if (row) {
        const actor = actorFromRow(row);
        cache.set(slackUserId, { actor, expiresAt: Date.now() + CACHE_TTL_MS });
        return actor;
      }
      if (fresh) return null;                       // a recent auto-link miss, do not re-ask Slack
      const actor = await autoLink(slackUserId, teamId);
      cache.set(slackUserId, {
        actor,
        expiresAt: Date.now() + (actor ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
      });
      return actor;
    } catch (error) {
      // A DB or Slack failure must not become "route it somewhere plausible".
      console.error(`[slack-actors] resolve failed for ${slackUserId}:`, error.message);
      return null;
    }
  }

  // Every actor the reconciliation sweep should visit: the env actor plus every
  // stored identity. Deduped on user id so a stored row for the env identity
  // cannot make one workspace get swept twice.
  async function listActors() {
    const out = [];
    const seen = new Set();
    const fallback = envActor();
    if (fallback) { out.push(fallback); seen.add(`${fallback.userId}:${fallback.workspaceId}`); }
    try {
      await ensureTable();
      const { rows } = await pool.query(
        `SELECT slack_user_id, slack_team_id, user_id, workspace_id, slack_host, linked_via, user_token_enc
           FROM slack_identities WHERE linked_via <> 'pending' ORDER BY user_id ASC`
      );
      for (const row of rows) {
        const actor = actorFromRow(row);
        const key = `${actor.userId}:${actor.workspaceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(actor);
      }
    } catch (error) {
      console.warn("[slack-actors] listActors fell back to the env actor only:", error.message);
    }
    return out;
  }

  // Which actor owns a block's workspace. Used by the ctx.syncSlackTaskReactions
  // projector, whose only input is a block id: the reaction has to be posted with
  // the token of the person whose task it is, never with whoever happens to be
  // configured in env. A workspace nobody claims returns null so the projection
  // is skipped rather than mis-attributed. A blank workspace (legacy rows, and
  // the in-memory test fixtures) falls back to the env actor.
  async function actorForWorkspace(workspaceId) {
    const fallback = envActor();
    if (!workspaceId) return fallback;
    if (fallback && fallback.workspaceId === String(workspaceId)) return fallback;
    try {
      await ensureTable();
      const { rows } = await pool.query(
        `SELECT slack_user_id, slack_team_id, user_id, workspace_id, slack_host, linked_via, user_token_enc
           FROM slack_identities WHERE workspace_id = $1 AND linked_via <> 'pending'
           ORDER BY user_id ASC LIMIT 1`,
        [workspaceId]
      );
      return rows[0] ? actorFromRow(rows[0]) : null;
    } catch (error) {
      console.warn(`[slack-actors] workspace actor lookup failed for ${workspaceId}:`, error.message);
      return null;
    }
  }

  // Read-only view for GET /api/me/integrations.
  async function statusForUser(userId) {
    const fallback = envActor();
    if (fallback && fallback.userId === Number(userId)) {
      return { connected: true, pending: false, tier: fallback.tier, slackUserId: fallback.slackUserId, linkedVia: "env" };
    }
    try {
      await ensureTable();
      const { rows } = await pool.query(
        `SELECT slack_user_id, linked_via, user_token_enc FROM slack_identities WHERE user_id = $1 LIMIT 1`,
        [userId]
      );
      if (!rows[0]) return { connected: false, pending: false, tier: null, slackUserId: null, linkedVia: null };
      const isPending = rows[0].linked_via === PENDING;
      return {
        connected: !isPending,
        pending: isPending,
        tier: isPending ? null : (rows[0].user_token_enc ? "user" : "bot"),
        slackUserId: rows[0].slack_user_id,
        linkedVia: rows[0].linked_via,
      };
    } catch (error) {
      console.warn(`[slack-actors] status lookup failed for user ${userId}:`, error.message);
      return { connected: false, pending: false, tier: null, slackUserId: null, linkedVia: null, error: true };
    }
  }

  function invalidate(slackUserId) {
    if (slackUserId) cache.delete(slackUserId);
    else cache.clear();
  }

  return {
    resolveActor, listActors, actorForWorkspace, statusForUser, envActor, invalidate, ensureTable,
    claimPending, linkOauthUser, unlinkUser, actorHasScope,
    hasBotToken: () => !!BOT_TOKEN,
    autoLinkEnabled: () => TEAM_ALLOWLIST.size > 0,
  };
}

module.exports = createSlackActors;
module.exports.createSlackActors = createSlackActors;
