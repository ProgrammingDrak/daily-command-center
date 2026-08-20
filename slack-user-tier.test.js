// Tier 2 in lib/slack-actors.js: a stored grant is what promotes a DB-backed
// identity from bot tier to user tier, and the granted scopes are what decide
// whether that actor may run the hasmy: sweep.
//
// Two properties here are load-bearing and easy to get wrong:
//   - an UNDECRYPTABLE grant must fail SOFT, because this code runs inside the
//     reaction event pipeline and a throw would take out capture for everyone
//   - UNKNOWN scopes must stay permissive, because the env identity is a legacy
//     token whose scopes this server never learned and it runs Drake's sweep today
const { test } = require("node:test");
const assert = require("node:assert/strict");
const createSlackActors = require("./lib/slack-actors.js");
const { createSecretBox, generateKey } = require("./lib/secret-box.js");

const KEY = generateKey();
const box = createSecretBox(KEY);
const sealGrant = (grant) => box.sealJson({ v: 1, ...grant });
const openGrant = (sealed) => box.openJson(sealed);

// One identity row, shaped as the table returns it.
function harness({ rows = [], openGrant: opener = openGrant, env = {} } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM slack_identities WHERE slack_user_id/i.test(sql) || /FROM slack_identities\s+WHERE workspace_id/i.test(sql)) {
        return { rows: rows.filter(r => !params || params.includes(r.slack_user_id) || params.includes(r.workspace_id)) };
      }
      if (/FROM slack_identities/i.test(sql)) return { rows };
      if (/FROM workspace_members/i.test(sql)) return { rows: [{ workspace_id: "ws-4" }] };
      return { rows: [] };
    },
  };
  const actors = createSlackActors({
    pool,
    openGrant: opener,
    env: { SLACK_WORKSPACE_HOST: "clever.slack.com", ...env },
  });
  return { actors, queries, pool };
}

const row = (over = {}) => ({
  slack_user_id: "U_NORA", slack_team_id: "T1", user_id: 4, workspace_id: "ws-4",
  slack_host: "clever.slack.com", linked_via: "oauth", user_token_enc: null, ...over,
});

test("a stored grant promotes the identity to user tier with a real token", async () => {
  const sealed = sealGrant({ token: "xoxp-nora", scopes: ["reactions:read", "reactions:write"], slackUserId: "U_NORA" });
  const h = harness({ rows: [row({ user_token_enc: sealed })] });
  const actor = await h.actors.actorForWorkspace("ws-4");
  assert.equal(actor.tier, "user");
  assert.equal(actor.tokens.user, "xoxp-nora");
  assert.deepEqual(actor.userScopes, ["reactions:read", "reactions:write"]);
  assert.equal(actor.linkedVia, "oauth");
});

test("no stored grant stays bot tier, exactly as before Tier 2", async () => {
  const h = harness({ rows: [row({ linked_via: "email" })] });
  const actor = await h.actors.actorForWorkspace("ws-4");
  assert.equal(actor.tier, "bot");
  assert.equal(actor.tokens.user, "");
  assert.equal(actor.userScopes, null, "unknown, not empty — empty would mean 'granted nothing'");
});

test("with no opener wired, stored grants are ignored entirely", async () => {
  // This is the pre-OAuth deployment: the column may hold a value but nothing can
  // open it, and the safe reading is bot tier rather than a crash.
  const sealed = sealGrant({ token: "xoxp-nora", scopes: ["reactions:write"] });
  const h = harness({ rows: [row({ user_token_enc: sealed })], openGrant: null });
  const actor = await h.actors.actorForWorkspace("ws-4");
  assert.equal(actor.tier, "bot");
  assert.equal(actor.tokens.user, "");
});

test("an undecryptable grant FAILS SOFT to bot tier instead of throwing", async () => {
  // A rotated or mistyped SLACK_TOKEN_ENC_KEY makes every envelope unreadable.
  // Throwing here would propagate into the reaction pipeline and stop capture for
  // everyone, including the env identity that does not depend on the key at all.
  const otherKey = createSecretBox(generateKey());
  const foreign = otherKey.sealJson({ v: 1, token: "xoxp-nope", scopes: [] });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const h = harness({ rows: [row({ user_token_enc: foreign })] });
    const actor = await h.actors.actorForWorkspace("ws-4");
    assert.equal(actor.tier, "bot");
    assert.equal(actor.tokens.user, "");
    assert.ok(errors.some(m => m.includes("could not open the stored Slack grant")));
    assert.ok(errors.some(m => m.includes("reconnect")), "the log says how to recover");
  } finally { console.error = realError; }
});

test("the undecryptable-grant warning is logged once per identity, not per lookup", async () => {
  const foreign = createSecretBox(generateKey()).sealJson({ v: 1, token: "x", scopes: [] });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const h = harness({ rows: [row({ user_token_enc: foreign })] });
    await h.actors.actorForWorkspace("ws-4");
    h.actors.invalidate("U_NORA");
    await h.actors.actorForWorkspace("ws-4");
    h.actors.invalidate("U_NORA");
    await h.actors.actorForWorkspace("ws-4");
    assert.equal(errors.filter(m => m.includes("could not open")).length, 1,
      "a reconcile loop every five minutes would otherwise fill the log");
  } finally { console.error = realError; }
});

// ══ the scope gate ═══════════════════════════════════════════════════════════

test("actorHasScope enforces a known scope list", () => {
  const { actors } = harness();
  const minimal = { tokens: { user: "xoxp-1" }, userScopes: ["reactions:read", "reactions:write"] };
  assert.equal(actors.actorHasScope(minimal, "reactions:write"), true);
  // The whole reason the gate changed: this actor HAS a user token and still
  // cannot search, so gating on token presence would fail missing_scope every
  // five minutes forever.
  assert.equal(actors.actorHasScope(minimal, "search:read"), false);
});

test("unknown scopes stay permissive, so the env identity keeps sweeping", () => {
  const { actors } = harness();
  const legacy = { tokens: { user: "xoxp-legacy" }, userScopes: null };
  assert.equal(actors.actorHasScope(legacy, "search:read"), true);
  assert.equal(actors.actorHasScope(legacy, "anything:at-all"), true);
});

test("a bot-tier actor has no user scope at all", () => {
  const { actors } = harness();
  assert.equal(actors.actorHasScope({ tokens: { user: "" }, userScopes: null }, "search:read"), false);
  assert.equal(actors.actorHasScope(null, "search:read"), false);
  assert.equal(actors.actorHasScope({}, "search:read"), false);
});

test("the env identity reports unknown scopes rather than an empty list", () => {
  const { actors } = harness({ env: { DRAKE_SLACK_USER_ID: "U_DRAKE", SLACK_USER_TOKEN: "xoxp-legacy" } });
  const env = actors.envActor();
  assert.equal(env.tier, "user");
  assert.equal(env.userScopes, null);
  assert.equal(actors.actorHasScope(env, "search:read"), true, "Drake's sweep must keep working untouched");
});

// ══ linkOauthUser ════════════════════════════════════════════════════════════

test("linking stores the sealed grant and marks the row as oauth", async () => {
  const h = harness();
  const sealed = sealGrant({ token: "xoxp-nora", scopes: ["reactions:write"] });
  const out = await h.actors.linkOauthUser(4, "U_NORA", "T1", sealed, "ws-4");
  assert.deepEqual(out, { ok: true, workspaceId: "ws-4" });

  const insert = h.queries.find(q => /INSERT INTO slack_identities/i.test(q.sql));
  assert.ok(insert, "a row is written");
  assert.ok(insert.params.includes(sealed), "the sealed grant is what lands in the column");
  assert.ok(insert.params.includes("oauth"), "linked_via records how, without needing a new column");
  assert.ok(!insert.params.some(p => String(p).includes("xoxp-")), "the raw token never reaches the query");
});

test("linking replaces the caller's previous identity rather than accumulating", async () => {
  const h = harness();
  await h.actors.linkOauthUser(4, "U_NORA", "T1", sealGrant({ token: "t", scopes: [] }), "ws-4");
  const del = h.queries.find(q => /DELETE FROM slack_identities WHERE user_id/i.test(q.sql));
  assert.ok(del, "one Slack identity per DCC user, same rule as claimPending");
  assert.deepEqual(del.params, [4]);
});

test("linking refuses a Slack account already connected to someone else", async () => {
  const h = harness({ rows: [row({ user_id: 99 })] });
  const out = await h.actors.linkOauthUser(4, "U_NORA", "T1", sealGrant({ token: "t", scopes: [] }), "ws-4");
  assert.equal(out.ok, false);
  assert.match(out.error, /already connected to another DCC account/);
  assert.ok(!h.queries.some(q => /INSERT INTO slack_identities/i.test(q.sql)), "and writes nothing");
});

test("linking clears the resolver's negative cache for that member", async () => {
  // resolveActor caches a MISS for ten minutes. Without the invalidate, someone
  // who just connected would keep being dropped until that expired — they would
  // connect, react, and see nothing happen.
  //
  // Driven through resolveActor rather than by spying on invalidate: the internal
  // closure is what linkOauthUser calls, so a spy on the exported one passes
  // whether the invalidate is there or not.
  const rows = [];
  const h = harness({ rows });
  const sealed = sealGrant({ token: "xoxp-nora", scopes: ["reactions:write"], slackUserId: "U_NORA" });

  assert.equal(await h.actors.resolveActor("U_NORA", "T1"), null, "not connected yet, and the miss is cached");

  await h.actors.linkOauthUser(4, "U_NORA", "T1", sealed, "ws-4");
  rows.push(row({ user_token_enc: sealed }));

  const actor = await h.actors.resolveActor("U_NORA", "T1");
  assert.ok(actor, "the very next reaction resolves");
  assert.equal(actor.tier, "user");
  assert.equal(actor.tokens.user, "xoxp-nora");
});
