// Multi-tenant routing for routes/slack-events.js + lib/slack-actors.js.
//
// slack-events.test.js pins the ORIGINAL single-tenant behavior through the env
// fallback actor and must keep passing untouched. This file pins the part that is
// new: one Slack app serving everyone, a reaction routed by WHO REACTED, and a
// reactor with no DCC account dropped having written nothing.
//
// Every test here runs with NO env identity (DRAKE_SLACK_USER_ID and
// SLACK_USER_TOKEN both blank) so the only way an event can land is through the
// slack_identities table or an email auto-link. That is deliberate: it means a
// regression in the table path cannot hide behind the env fallback.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const mount = require("./routes/slack-events.js");
const { createSecretBox, generateKey } = require("./lib/secret-box.js");

const SECRET = "test-signing-secret";
const TEAM = "T_CLEVER";
const OTHER_TEAM = "T_OUTSIDE";
const BOT_TOKEN = "xoxb-test";

// opts.identities: pre-linked rows. opts.users: DCC accounts available to match
// by email. opts.allowlist: SLACK_TEAM_ALLOWLIST (unset disables auto-linking).
// opts.env: give the harness an env identity too, for the mixed-roster cases.
function makeHarness(opts = {}) {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.SLACK_DELEGATE_IMPORT_AFTER = "2026-01-01T00:00:00.000Z";
  process.env.SLACK_RECONCILE_ENABLED = "0";
  process.env.SLACK_BOT_TOKEN = opts.botToken === undefined ? BOT_TOKEN : opts.botToken;
  process.env.DCC_SERVICE_USER_ID = "1";
  process.env.DCC_SERVICE_WORKSPACE_ID = "ws-1";
  delete process.env.ANTHROPIC_API_KEY;
  // Tier 2: without a key the route cannot open a stored grant, so an identity
  // carrying `userTokenEnc` would still resolve as bot tier.
  if (opts.encKey) process.env.SLACK_TOKEN_ENC_KEY = opts.encKey;
  else delete process.env.SLACK_TOKEN_ENC_KEY;
  if (opts.allowlist === undefined) delete process.env.SLACK_TEAM_ALLOWLIST;
  else process.env.SLACK_TEAM_ALLOWLIST = opts.allowlist;
  if (opts.env) {
    process.env.DRAKE_SLACK_USER_ID = opts.env.slackUserId;
    process.env.SLACK_USER_TOKEN = opts.env.userToken || "xoxp-env";
  } else {
    process.env.DRAKE_SLACK_USER_ID = "";
    process.env.SLACK_USER_TOKEN = "";
  }

  const blocks = [];
  const identities = (opts.identities || []).map((row) => ({
    slack_user_id: row.slackUserId,
    slack_team_id: row.teamId || TEAM,
    user_id: row.userId,
    workspace_id: row.workspaceId || `ws-${row.userId}`,
    slack_host: row.slackHost || "cleverrealestate.slack.com",
    user_token_enc: row.userTokenEnc || null,
    linked_via: row.linkedVia || "email",
  }));
  const users = opts.users || [];                    // [{ id, email }]
  const calls = { fetch: [], usersInfo: [], reactionsAdd: [], searches: [], broadcast: [], credit: [], completion: [] };
  let seq = 0;

  // Slack profiles the bot token can see, keyed by member id.
  const profiles = opts.profiles || {};

  global.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.fetch.push({ url: href, init });
    const auth = (init.headers && init.headers.Authorization) || "";
    if (href.includes("users.info")) {
      const id = new URL(href).searchParams.get("user");
      calls.usersInfo.push({ id, auth });
      // A transient failure must be distinguishable from a confirmed absence.
      if (opts.usersInfoFails) {
        return { ok: false, status: 429, json: async () => ({ ok: false, error: "ratelimited" }) };
      }
      const profile = profiles[id];
      if (!profile) return { ok: true, status: 200, json: async () => ({ ok: false, error: "user_not_found" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, user: {
        id, team_id: profile.teamId || TEAM, deleted: !!profile.deleted, is_bot: !!profile.isBot,
        profile: { email: profile.email },
      } }) };
    }
    if (href.includes("search.messages")) {
      calls.searches.push({ query: new URL(href).searchParams.get("query"), auth });
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: { matches: [], paging: { pages: 1 } } }) };
    }
    if (href.includes("reactions.add")) {
      calls.reactionsAdd.push({ auth, body: Object.fromEntries(new URLSearchParams(init.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (href.includes("reactions.get")) {
      const ts = new URL(href).searchParams.get("timestamp");
      return { ok: true, status: 200, json: async () => ({ ok: true, message: {
        ts, text: "Confirm the Q3 vendor numbers before the QBR", user: "U_MIKE",
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const ctx = {
    crypto,
    getTodayStr: () => "2026-07-28",
    APP_TIME_ZONE: "America/New_York",
    broadcast: (ev, payload, workspaceId) => calls.broadcast.push({ ev, payload, workspaceId }),
    slotStore: {
      earnTaskCredit: async (ws, uid, body) => { calls.credit.push({ ws, uid, body }); return { awarded: true }; },
      revokeTaskCredit: async () => ({ revoked: true }),
    },
    blockDB: {
      getBlock: async (id) => blocks.find(b => b.id === id) || null,
      getBlockIncludingDeleted: async (id) => blocks.find(b => b.id === id) || null,
      getTaskTimeEntries: async () => [],
      // Mirrors the mock in slack-events.test.js: the completion path writes
      // through this durable primitive, not straight to updateBlock.
      setTaskCompletion: async ({ taskRef, completed, completedAt, mutationId, userId, workspaceId }) => {
        calls.completion.push({ taskRef, completed, userId, workspaceId });
        const b = blocks.find(x => x.id === taskRef || (x.properties || {}).local_id === taskRef);
        if (!b) throw new Error("not found " + taskRef);
        const props = { ...(b.properties || {}) };
        if (completed) {
          props.status = "done";
          props.done = true;
          props.completed = true;
          props.completedAt = completedAt;
          props.doneAt = completedAt;
        } else {
          props.status = "open";
          delete props.done;
          delete props.completed;
          delete props.completedAt;
          delete props.doneAt;
        }
        props._completionMutationId = mutationId;
        b.properties = props;
        return { task: b, affectedTasks: [b], revision: mutationId, persistenceTarget: "task_row", duplicate: false, broadcastIds: [b.id] };
      },
      createItineraryTask: async ({ date, properties, userId, workspaceId }) => {
        const b = { id: `blk-${++seq}`, date, type: "block", properties, user_id: userId, workspace_id: workspaceId };
        blocks.push(b); return { id: b.id };
      },
      createBlock: async ({ id, type, date, properties, user_id, workspace_id }) => {
        const b = { id: id || `blk-${++seq}`, date, type, properties, user_id, workspace_id };
        blocks.push(b); return { id: b.id };
      },
      updateBlock: async (id, { properties }) => {
        const b = blocks.find(x => x.id === id);
        if (!b) throw new Error("not found " + id);
        b.properties = properties; return { id };
      },
      deleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        if (b) { b.deleted = true; b.deleted_at = "2026-07-28T00:00:00Z"; }
        return { id };
      },
      undeleteBlock: async (id) => {
        const b = blocks.find(x => x.id === id);
        b.deleted = false; b.deleted_at = null; return b;
      },
      ensureDayRoot: async () => "day-root",
    },
    pool: {
      query: async (sql, params = []) => {
        if (/CREATE TABLE IF NOT EXISTS slack_identities/.test(sql)) return { rows: [] };
        if (/INSERT INTO slack_identities/.test(sql)) {
          const [slackUserId, teamId, userId, workspaceId, host, linkedVia] = params;
          const existing = identities.find(r => r.slack_user_id === slackUserId);
          if (existing) {
            existing.user_id = userId; existing.workspace_id = workspaceId;
            existing.linked_via = linkedVia || existing.linked_via;
          } else {
            identities.push({
              slack_user_id: slackUserId, slack_team_id: teamId, user_id: userId,
              workspace_id: workspaceId, slack_host: host, user_token_enc: null,
              linked_via: linkedVia || "email",
            });
          }
          return { rows: [] };
        }
        if (/UPDATE slack_identities SET linked_via = 'claim'/.test(sql)) {
          const hit = identities.find(r => r.slack_user_id === params[0] && r.linked_via === params[1]);
          if (hit) hit.linked_via = "claim";
          return { rows: [] };
        }
        if (/DELETE FROM slack_identities WHERE user_id/.test(sql)) {
          const gone = identities.filter(r => Number(r.user_id) === Number(params[0]));
          for (const r of gone) identities.splice(identities.indexOf(r), 1);
          return { rows: gone.map(r => ({ slack_user_id: r.slack_user_id })) };
        }
        if (/FROM slack_identities WHERE slack_user_id/.test(sql)) {
          return { rows: identities.filter(r => r.slack_user_id === params[0]) };
        }
        if (/FROM slack_identities WHERE workspace_id/.test(sql)) {
          return { rows: identities.filter(r => r.workspace_id === params[0] && r.linked_via !== "pending") };
        }
        if (/FROM slack_identities WHERE user_id/.test(sql)) {
          return { rows: identities.filter(r => Number(r.user_id) === Number(params[0])) };
        }
        // Matched loosely on purpose: the roster query grew a pending filter and a
        // matcher pinned to the old exact text silently returned an empty roster.
        if (/FROM slack_identities/.test(sql) && /ORDER BY user_id/.test(sql)) {
          return { rows: identities.filter(r => r.linked_via !== "pending").slice().sort((a, b) => a.user_id - b.user_id) };
        }
        if (/FROM users WHERE id = \$1/.test(sql)) {
          const hit = users.find(u => Number(u.id) === Number(params[0]));
          return { rows: hit ? [{ email: String(hit.email || "").toLowerCase() }] : [] };
        }
        if (/FROM users WHERE lower\(email\)/.test(sql)) {
          const hit = users.find(u => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
          return { rows: hit ? [{ id: hit.id }] : [] };
        }
        if (/FROM workspace_members/.test(sql)) {
          const hit = users.find(u => Number(u.id) === Number(params[0]));
          return { rows: hit && hit.workspaceId ? [{ workspace_id: hit.workspaceId }] : [] };
        }
        if (sql.includes("idempotency_key")) {
          // The workspace fence is the whole point: the idempotency key is the
          // same string for everyone who reacts to a message.
          const hit = blocks.find(b => b.properties
            && b.properties.idempotency_key === params[0]
            && b.workspace_id === params[1]
            && b.type !== "time_entry");
          return { rows: hit ? [{ id: hit.id, date: hit.date, properties: hit.properties, deleted_at: hit.deleted_at || null, workspace_id: hit.workspace_id }] : [] };
        }
        return { rows: [] };
      },
    },
  };

  let handler;
  const app = { post: (path, fn) => { if (path === "/api/slack/events") handler = fn; } };
  const api = mount(app, ctx);
  return { handler, api, ctx, blocks, calls, identities };
}

function sign(rawBody, ts) {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
}
async function post(handler, obj) {
  const rawBody = JSON.stringify(obj);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = { status() { return res; }, json() { return res; }, end() { return res; } };
  handler({
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sign(rawBody, ts) },
    rawBody: Buffer.from(rawBody, "utf8"),
    body: obj,
  }, res);
  await new Promise(r => setTimeout(r, 90));
}

const envelope = (event, teamId = TEAM) => ({ type: "event_callback", team_id: teamId, event });
const reaction = (name, user, ts, evTs = "1720000000.000000") =>
  ({ type: "reaction_added", user, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: evTs });
const removal = (name, user, ts, evTs = "1720000900.000000") =>
  ({ type: "reaction_removed", user, reaction: name, item: { type: "message", channel: "C1", ts }, event_ts: evTs });

// ── dropping non-users ────────────────────────────────────────────────────

test("a reactor with no DCC account is dropped and nothing is written", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    profiles: { U_SAM: { email: "sam.ortiz@partnerco.com" } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_SAM", "drop.1")));
  assert.equal(h.blocks.length, 0, "no task, no tombstone, no row of any kind");
  assert.equal(h.identities.length, 0, "an unmatched reactor is never linked");
  assert.equal(h.calls.broadcast.length, 0);
});

test("auto-linking is off entirely when SLACK_TEAM_ALLOWLIST is unset (fail closed)", async () => {
  const h = makeHarness({
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    profiles: { U_NORA: { email: "nora.vance@movewithclever.com" } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "noallow.1")));
  assert.equal(h.blocks.length, 0, "a matching email is not enough without an allowlisted team");
  assert.equal(h.calls.usersInfo.length, 0, "and Slack is never even asked");
});

test("a reaction from a team outside the allowlist is refused even when the email matches", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    profiles: { U_NORA: { email: "nora.vance@movewithclever.com", teamId: OTHER_TEAM } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "foreign.1"), OTHER_TEAM));
  assert.equal(h.blocks.length, 0);
  assert.equal(h.identities.length, 0);
});

test("an unknown reactor is asked about once, then served from the negative cache", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [],
    profiles: { U_SAM: { email: "sam.ortiz@partnerco.com" } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_SAM", "cache.1")));
  await post(h.handler, envelope(reaction("bookmark", "U_SAM", "cache.2")));
  await post(h.handler, envelope(reaction("bookmark", "U_SAM", "cache.3")));
  assert.equal(h.calls.usersInfo.length, 1, "three reactions must not become three users.info calls");
  assert.equal(h.blocks.length, 0);
});

// ── auto-linking and routing ──────────────────────────────────────────────

test("a teammate's first 🔖 links them by email and lands on their own day", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    profiles: { U_NORA: { email: "Nora.Vance@movewithclever.com" } },   // case-insensitive match
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "link.1")));

  assert.equal(h.identities.length, 1);
  assert.equal(h.identities[0].slack_user_id, "U_NORA");
  assert.equal(h.identities[0].user_id, 4);
  assert.equal(h.identities[0].workspace_id, "ws-4");
  assert.equal(h.identities[0].linked_via, "email");

  assert.equal(h.blocks.length, 1);
  assert.equal(h.blocks[0].workspace_id, "ws-4", "the task belongs to Nora's workspace");
  assert.equal(h.blocks[0].user_id, 4);
  assert.equal(h.blocks[0].properties.idempotency_key, "slack-bookmark:C1:link.1");
  assert.equal(h.calls.broadcast[0].workspaceId, "ws-4", "and the SSE goes to her workspace only");
});

test("a linked identity routes without another users.info call", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    profiles: { U_NORA: { email: "nora.vance@movewithclever.com" } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "known.1")));
  assert.equal(h.calls.usersInfo.length, 0, "the row is the answer");
  assert.equal(h.blocks[0].workspace_id, "ws-4");
});

test("two people bookmarking the SAME message get two tasks in two workspaces", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [
      { slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" },
      { slackUserId: "U_ALEX", userId: 7, workspaceId: "ws-7" },
    ],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "shared.1")));
  await post(h.handler, envelope(reaction("bookmark", "U_ALEX", "shared.1")));

  assert.equal(h.blocks.length, 2, "one task each, not one shared task");
  assert.deepEqual(h.blocks.map(b => b.workspace_id).sort(), ["ws-4", "ws-7"]);
  // Same deterministic key on both: only the workspace fence separates them.
  assert.deepEqual(
    [...new Set(h.blocks.map(b => b.properties.idempotency_key))],
    ["slack-bookmark:C1:shared.1"]
  );
});

test("one person's un-🔖 cannot delete another person's task for the same message", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [
      { slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" },
      { slackUserId: "U_ALEX", userId: 7, workspaceId: "ws-7" },
    ],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "fence.1")));
  await post(h.handler, envelope(reaction("bookmark", "U_ALEX", "fence.1")));
  await post(h.handler, envelope(removal("bookmark", "U_NORA", "fence.1")));

  const nora = h.blocks.find(b => b.workspace_id === "ws-4");
  const alex = h.blocks.find(b => b.workspace_id === "ws-7");
  assert.equal(nora.deleted, true, "Nora's own task is cancelled");
  assert.equal(alex.deleted, undefined, "Alex's task is untouched");
});

test("⌛ then ✅ credits points to the reacting teammate, not the service account", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "pts.1")));
  await post(h.handler, envelope(reaction("hourglass", "U_NORA", "pts.1", "1720000000.000000")));
  await post(h.handler, envelope(reaction("white_check_mark", "U_NORA", "pts.1", "1720001200.000000")));

  assert.equal(h.calls.credit.length, 1);
  assert.equal(h.calls.credit[0].ws, "ws-4");
  assert.equal(h.calls.credit[0].uid, 4);
  assert.equal(h.calls.credit[0].body.actual_minutes, 20);

  // The completion write is the authoritative one, so it needs the same fence as
  // the credit call. Asserting only the credit would miss a regression that sent
  // the durable write under the env actor while the points went to the teammate.
  const done = h.calls.completion.filter(c => c.completed);
  assert.equal(done.length, 1);
  assert.equal(done[0].workspaceId, "ws-4");
  assert.equal(done[0].userId, 4);
});

// ── bot-tier limits ───────────────────────────────────────────────────────

test("a bot-tier actor posts reactions with the bot token", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "tier.1")));
  await post(h.handler, envelope(reaction("white_check_mark", "U_NORA", "tier.1", "1720001200.000000")));
  await post(h.handler, envelope(removal("white_check_mark", "U_NORA", "tier.1", "1720001300.000000")));

  assert.equal(h.calls.reactionsAdd.length, 1, "the 🔖 goes back on after an un-✅");
  assert.equal(h.calls.reactionsAdd[0].auth, `Bearer ${BOT_TOKEN}`, "no user token exists, so the bot speaks");
  assert.equal(h.calls.reactionsAdd[0].body.name, "bookmark");
});

// ── Tier 2: the sweep is gated on SCOPES, not on having a token ─────────────

test("a user-tier actor with only reaction scopes is skipped by the hasmy: sweep", async () => {
  // The gate used to read `if (actor.tokens.user)`. A Tier 2 grant is deliberately
  // minimal — reactions only — so that actor HAS a token and still cannot call
  // search.messages. Under the old gate the sweep would attempt it and fail
  // missing_scope every five minutes, per actor, forever.
  const key = generateKey();
  const sealed = createSecretBox(key).sealJson({
    v: 1, token: "xoxp-nora", scopes: ["reactions:read", "reactions:write"], slackUserId: "U_NORA",
  });
  const h = makeHarness({
    allowlist: TEAM, encKey: key,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", linkedVia: "oauth", userTokenEnc: sealed }],
  });
  const stats = await h.api.runReconciliation();
  assert.equal(h.calls.searches.length, 0, "no search is attempted at all");
  assert.equal(stats.actors, 1);
  assert.equal(stats.bookmarks, 0);
  assert.equal(stats.delegates, 0);
});

test("a user-tier actor that DOES hold search:read still sweeps", async () => {
  const key = generateKey();
  const sealed = createSecretBox(key).sealJson({
    v: 1, token: "xoxp-wide", scopes: ["reactions:read", "reactions:write", "search:read"], slackUserId: "U_WIDE",
  });
  const h = makeHarness({
    allowlist: TEAM, encKey: key,
    identities: [{ slackUserId: "U_WIDE", userId: 5, workspaceId: "ws-5", linkedVia: "oauth", userTokenEnc: sealed }],
  });
  await h.api.runReconciliation();
  assert.deepEqual(h.calls.searches.map(c => c.query), ["hasmy::bookmark:", "hasmy::busts_in_silhouette:"],
    "the gate must not have become a blanket refusal");
  // And it searched as THEM, on the token from their own grant.
  assert.ok(h.calls.searches.every(c => c.auth === "Bearer xoxp-wide"));
});

test("reconciliation skips the hasmy: sweep for bot-tier actors instead of erroring", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
  });
  const stats = await h.api.runReconciliation();
  assert.equal(h.calls.searches.length, 0, "search.messages has no bot equivalent, so it is not attempted");
  assert.equal(stats.actors, 1);
  assert.equal(stats.bookmarks, 0);
  assert.equal(stats.delegates, 0);
});

test("reconciliation sweeps a user-tier actor and skips the bot-tier one in the same pass", async () => {
  const h = makeHarness({
    env: { slackUserId: "U_DRAKE", userToken: "xoxp-env" },
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
  });
  await h.api.runReconciliation();
  assert.deepEqual(
    h.calls.searches.map(s => s.query),
    ["hasmy::bookmark:", "hasmy::busts_in_silhouette:"],
    "exactly one actor can run the sweep"
  );
  assert.deepEqual([...new Set(h.calls.searches.map(s => s.auth))], ["Bearer xoxp-env"]);
});

test("reconciliation reports no_actors rather than throwing when nothing is linked", async () => {
  const h = makeHarness({ allowlist: TEAM });
  const stats = await h.api.runReconciliation();
  assert.equal(stats.skipped, "no_actors");
  assert.equal(h.calls.searches.length, 0);
});

// ── env fallback still wins ───────────────────────────────────────────────

test("the env identity resolves before any DB or Slack lookup", async () => {
  const h = makeHarness({
    env: { slackUserId: "U_DRAKE", userToken: "xoxp-env" },
    allowlist: TEAM,
    profiles: { U_DRAKE: { email: "drake.shadwell@movewithclever.com" } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_DRAKE", "env.1")));
  assert.equal(h.calls.usersInfo.length, 0, "the env actor is never looked up");
  assert.equal(h.identities.length, 0, "and is never written to the table");
  assert.equal(h.blocks[0].workspace_id, "ws-1");
});

test("a bot-only deployment with no identities ignores every reaction", async () => {
  const h = makeHarness({ botToken: "", allowlist: TEAM });
  await post(h.handler, envelope(reaction("bookmark", "U_ANYONE", "none.1")));
  assert.equal(h.blocks.length, 0);
});

// ── the manual claim handshake ─────────────────────────────────────────────
// The fallback for an account with no email to match on. A claim grants nothing
// on its own; the reaction is the proof.

test("a pending claim is inert until a reaction arrives from that account", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", linkedVia: "pending" }],
  });
  // Not an actor yet: the reconciliation roster must not see it.
  const stats = await h.api.runReconciliation();
  assert.equal(stats.skipped, "no_actors", "a pending claim is not a linked identity");

  // The first reaction from that account both confirms the claim and does its work.
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "claim.1")));
  assert.equal(h.identities[0].linked_via, "claim", "the reaction promoted the claim");
  assert.equal(h.blocks.length, 1);
  assert.equal(h.blocks[0].workspace_id, "ws-4");
});

test("a pending claim does not receive projections meant for its workspace", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", linkedVia: "pending" }],
  });
  const actor = await h.api.actors.actorForWorkspace("ws-4");
  assert.equal(actor, null, "an unconfirmed claim must not speak for the workspace");
});

test("claimPending refuses an ID already linked to someone else", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
    users: [{ id: 7, email: "alex@movewithclever.com", workspaceId: "ws-7" }],
  });
  const result = await h.api.actors.claimPending(7, "U_NORA", "ws-7");
  assert.equal(result.ok, false);
  assert.match(result.error, /already linked/i);
  assert.equal(h.identities[0].user_id, 4, "the existing link is untouched");
});

test("claimPending refuses when Slack's email contradicts the DCC account", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 7, email: "alex@movewithclever.com", workspaceId: "ws-7" }],
    profiles: { U_NORA: { email: "nora.vance@movewithclever.com" } },
  });
  const result = await h.api.actors.claimPending(7, "U_NORA", "ws-7");
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/i);
  assert.equal(h.identities.length, 0);
});

test("claimPending accepts when Slack exposes no email, which is the case it exists for", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 7, email: null, workspaceId: "ws-7" }],
  });
  const result = await h.api.actors.claimPending(7, "U_ALEX", "ws-7");
  assert.equal(result.ok, true);
  assert.equal(h.identities.length, 1);
  assert.equal(h.identities[0].linked_via, "pending", "still only a claim, not a link");
});

test("claiming replaces a person's previous identity rather than accumulating", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_OLD", userId: 7, workspaceId: "ws-7" }],
    users: [{ id: 7, email: null, workspaceId: "ws-7" }],
  });
  await h.api.actors.claimPending(7, "U_NEW", "ws-7");
  assert.deepEqual(h.identities.map(r => r.slack_user_id), ["U_NEW"]);
});

test("unlinkUser removes the identity and stops routing", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4" }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "unlink.1")));
  assert.equal(h.blocks.length, 1);
  assert.equal(await h.api.actors.unlinkUser(4), 1);
  assert.equal(h.identities.length, 0);
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "unlink.2")));
  assert.equal(h.blocks.length, 1, "no new task once unlinked");
});

// ── the hijack the security lane caught ────────────────────────────────────
// The guard used to read `if (mine && mine !== identity.email)`, so it SKIPPED
// the comparison whenever the CLAIMING account had no email. users.email is
// nullable and the public password-registration path never sets it, so a
// self-registered account could claim any colleague's member ID and the victim's
// own next reaction would activate the hijack onto the attacker's workspace.

test("claimPending refuses when the claimant has no email but Slack knows the target's", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    // The attacker: a password-registered account, email never populated.
    users: [{ id: 9, email: null, workspaceId: "ws-9" }],
    // Slack DOES know whose member ID this is, and it is not the attacker's.
    profiles: { U_VICTIM: { email: "victim@movewithclever.com" } },
  });
  const result = await h.api.actors.claimPending(9, "U_VICTIM", "ws-9");
  assert.equal(result.ok, false, "a claim that cannot be proven must be refused");
  assert.match(result.error, /no email address/i);
  assert.equal(h.identities.length, 0, "and no pending row may be written");
});

test("a victim's reaction cannot activate someone else's claim on their member ID", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 9, email: null, workspaceId: "ws-9" }],
    profiles: { U_VICTIM: { email: "victim@movewithclever.com" } },
  });
  await h.api.actors.claimPending(9, "U_VICTIM", "ws-9");   // refused above
  await post(h.handler, envelope(reaction("bookmark", "U_VICTIM", "hijack.1")));
  // Nothing was written for the attacker. The victim is simply unlinked, which is
  // the correct outcome: they get auto-linked once their DCC account has an email.
  assert.equal(h.blocks.length, 0);
  assert.equal(h.identities.length, 0);
});

test("a pending claim does not promote on a reaction from a non-allowlisted team", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", linkedVia: "pending" }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "team.1"), OTHER_TEAM));
  assert.equal(h.identities[0].linked_via, "pending", "the claim stays unproven");
  assert.equal(h.blocks.length, 0, "and the reaction writes nothing");
});

// ── gaps the test-quality lane called out ──────────────────────────────────

test("autoLink refuses when the profile's team disagrees with the allowlisted event team", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
    // The event arrives from the allowlisted TEAM, but Slack says this member
    // belongs to a different workspace. Trusting either one alone would link a
    // reaction from one Slack workspace into an account from another.
    profiles: { U_NORA: { email: "nora.vance@movewithclever.com", teamId: OTHER_TEAM } },
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "mismatch.1"), TEAM));
  assert.equal(h.identities.length, 0, "no link on a team mismatch");
  assert.equal(h.blocks.length, 0, "and nothing written");
});

test("statusForUser reports absent, pending and linked as three distinct states", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    identities: [
      { slackUserId: "U_PEND", userId: 5, workspaceId: "ws-5", linkedVia: "pending" },
      { slackUserId: "U_LIVE", userId: 6, workspaceId: "ws-6", linkedVia: "email" },
    ],
  });
  const absent = await h.api.actors.statusForUser(99);
  assert.equal(absent.connected, false);
  assert.equal(absent.pending, false);

  // The whole point of a claim: it must never read as connected.
  const pending = await h.api.actors.statusForUser(5);
  assert.equal(pending.connected, false, "an unconfirmed claim is not a connection");
  assert.equal(pending.pending, true);
  assert.equal(pending.tier, null);

  const linked = await h.api.actors.statusForUser(6);
  assert.equal(linked.connected, true);
  assert.equal(linked.pending, false);
  assert.equal(linked.tier, "bot");
});

test("claimPending refuses when Slack cannot be reached, rather than falling through", async () => {
  // A rate limit or outage used to look identical to "this profile has no email",
  // which is the one case the manual claim is allowed to accept. That made the
  // ownership check bypassable by simply retrying until Slack hiccupped.
  const h = makeHarness({
    allowlist: TEAM,
    usersInfoFails: true,
    users: [{ id: 9, email: null, workspaceId: "ws-9" }],
  });
  const result = await h.api.actors.claimPending(9, "U_ANYONE", "ws-9");
  assert.equal(result.ok, false);
  assert.match(result.error, /could not check/i);
  assert.equal(h.identities.length, 0, "no claim recorded on an unverifiable lookup");
});

test("autoLink drops the event when Slack cannot be reached", async () => {
  const h = makeHarness({
    allowlist: TEAM,
    usersInfoFails: true,
    users: [{ id: 4, email: "nora.vance@movewithclever.com", workspaceId: "ws-4" }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "flaky.1")));
  assert.equal(h.identities.length, 0, "no link guessed from a failed lookup");
  assert.equal(h.blocks.length, 0);
});

test("a WARM-CACHED identity is still team-checked (the cold-start test missed this)", async () => {
  // The first version of the team gate sat after the cache lookup, so the very
  // first reaction cached the actor and every later reaction short-circuited past
  // the check. Each test harness starts cold, so unit tests passed while the live
  // server still routed a foreign-workspace reaction. This warms the cache first.
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", teamId: TEAM }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "warm.1"), TEAM));
  assert.equal(h.blocks.length, 1, "own team works and warms the cache");

  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "warm.2"), OTHER_TEAM));
  assert.equal(h.blocks.length, 1, "a warm cache must not bypass the team gate");
});

test("an already-linked identity is dropped when the event team is not its own", async () => {
  // Deep QA caught this: the team was only checked while LINKING, so a linked id
  // routed from any workspace. Member ids are workspace-scoped, so the same id
  // elsewhere is a different person.
  const h = makeHarness({
    allowlist: TEAM,
    identities: [{ slackUserId: "U_NORA", userId: 4, workspaceId: "ws-4", teamId: TEAM }],
  });
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "team.x"), OTHER_TEAM));
  assert.equal(h.blocks.length, 0, "a foreign-workspace event must not reach a linked account");

  // ...and the same identity still works from its own team.
  await post(h.handler, envelope(reaction("bookmark", "U_NORA", "team.y"), TEAM));
  assert.equal(h.blocks.length, 1);
  assert.equal(h.blocks[0].workspace_id, "ws-4");
});
