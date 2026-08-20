// routes/slack-oauth.js + lib/slack-oauth.js — the per-user authorization flow.
//
// Harness shape follows gcal-auth-routes.test.js: the OAuth module is stubbed, so
// these run with no DB and no network and can drive every rejection branch. The
// state check is the security boundary — the state blob is UNSIGNED, so it is the
// session nonce plus the userId match that do the work, and each half is pinned
// separately here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mountOauth = require("./routes/slack-oauth.js");
const { createSlackOAuth } = require("./lib/slack-oauth.js");
const { generateKey } = require("./lib/secret-box.js");

function mount(opts = {}) {
  const routes = {};
  const app = {
    get: (p, fn) => { routes["GET " + p] = fn; },
    post: (p, fn) => { routes["POST " + p] = fn; },
  };
  const linked = [];
  const unlinked = [];
  const ctx = {
    crypto,
    route: (fn) => async (req, res) => {
      try { const out = await fn(req, res); if (out !== undefined) res.json(out); }
      catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
    },
    slackOAuth: opts.oauth === null ? null : (opts.oauth || stubOauth(opts)),
    slackActors: opts.actors === null ? null : (opts.actors || {
      linkOauthUser: async (userId, slackUserId, teamId, sealed, ws) => {
        linked.push({ userId, slackUserId, teamId, sealed, ws });
        return opts.linkResult || { ok: true, workspaceId: ws || "ws-1" };
      },
      unlinkUser: async (userId) => { unlinked.push(userId); },
    }),
  };
  mountOauth(app, ctx);
  return { routes, ctx, linked, unlinked };
}

function stubOauth(opts = {}) {
  return {
    configured: () => opts.configured !== false,
    hasEncryptionKey: () => opts.hasKey !== false,
    getAuthUrl: (userId, nonce) => `https://slack.example/authorize?state=${userId}:${nonce}`,
    // Mirrors the real decodeState, including its non-object coercion — a stub
    // that is more forgiving than production hides exactly the crash this suite
    // exists to catch.
    decodeState: (s) => {
      try {
        const p = JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
        return p && typeof p === "object" && !Array.isArray(p) ? p : {};
      } catch { return {}; }
    },
    exchangeCode: async () => {
      if (opts.exchangeError) { const e = new Error("boom"); e.code = opts.exchangeError; throw e; }
      return { slackUserId: "U_NORA", teamId: "T1", token: "xoxp-nora", scopes: ["reactions:read", "reactions:write"] };
    },
    sealGrant: () => "v1.sealed.envelope.here",
  };
}

const encodeState = (userId, nonce) => Buffer.from(JSON.stringify({ userId, nonce })).toString("base64url");

function mockRes() {
  const r = { code: 200, body: null, redirect: null };
  const res = {
    status(c) { r.code = c; return res; },
    json(o) { r.body = o; return res; },
    redirect(u) { r.redirect = u; return res; },
  };
  return { res, r };
}
async function call(routes, key, req) {
  const { res, r } = mockRes();
  await routes[key](req, res);
  return r;
}

// ══ GET /api/slack/auth ══════════════════════════════════════════════════════

test("the start route redirects to Slack and parks a nonce in the session", async () => {
  const h = mount();
  const session = { userId: 7 };
  const r = await call(h.routes, "GET /api/slack/auth", { session });
  assert.ok(session.slackOAuthNonce, "the nonce the callback will demand");
  assert.ok(r.redirect.startsWith("https://slack.example/authorize"));
  assert.ok(r.redirect.includes(`7:${session.slackOAuthNonce}`));
});

test("the start route refuses an anonymous caller", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/auth", { session: {} });
  assert.equal(r.code, 401);
});

test("the start route 503s when client credentials are absent", async () => {
  const h = mount({ configured: false });
  const r = await call(h.routes, "GET /api/slack/auth", { session: { userId: 7 } });
  assert.equal(r.code, 503);
  assert.match(r.body.error, /SLACK_CLIENT_ID/);
  assert.equal(r.redirect, null, "nobody is sent to Slack");
});

// Sending someone to Slack without somewhere to put the result spends their
// authorization and then throws it away, and they have no way to tell why.
test("the start route refuses BEFORE Slack when the encryption key is missing", async () => {
  const h = mount({ hasKey: false });
  const session = { userId: 7 };
  const r = await call(h.routes, "GET /api/slack/auth", { session });
  assert.equal(r.code, 503);
  assert.match(r.body.error, /SLACK_TOKEN_ENC_KEY/);
  assert.equal(r.redirect, null);
  assert.equal(session.slackOAuthNonce, undefined, "and no half-started flow is left in the session");
});

// ══ GET /api/slack/callback — the state boundary ═════════════════════════════

test("a valid callback links the account and lands on the success redirect", async () => {
  const h = mount();
  const session = { userId: 7, slackOAuthNonce: "n-1" };
  const r = await call(h.routes, "GET /api/slack/callback", {
    session, workspaceId: "ws-7", query: { code: "c", state: encodeState(7, "n-1") },
  });
  assert.equal(r.redirect, "/?slack=connected");
  assert.deepEqual(h.linked, [{ userId: 7, slackUserId: "U_NORA", teamId: "T1", sealed: "v1.sealed.envelope.here", ws: "ws-7" }]);
  assert.equal(session.slackOAuthNonce, undefined, "single use");
});

test("a replayed callback URL is refused", async () => {
  const h = mount();
  const session = { userId: 7, slackOAuthNonce: "n-1" };
  const req = { session, query: { code: "c", state: encodeState(7, "n-1") } };
  await call(h.routes, "GET /api/slack/callback", req);
  const second = await call(h.routes, "GET /api/slack/callback", req);
  assert.equal(second.code, 400);
  assert.equal(h.linked.length, 1, "the replay linked nothing");
});

test("a state naming a DIFFERENT user is refused", async () => {
  // The state blob is unsigned, so without this check a crafted state would let
  // one signed-in user attach someone else's Slack account.
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" },
    query: { code: "c", state: encodeState(99, "n-1") },
  });
  assert.equal(r.code, 400);
  assert.equal(h.linked.length, 0);
});

test("a wrong nonce is refused even when the userId matches", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" },
    query: { code: "c", state: encodeState(7, "n-OTHER") },
  });
  assert.equal(r.code, 400);
  assert.equal(h.linked.length, 0);
});

test("a callback with no nonce in the session is refused", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7 }, query: { code: "c", state: encodeState(7, "n-1") },
  });
  assert.equal(r.code, 400);
});

test("a garbage or absent state is refused, not crashed on", async () => {
  const h = mount();
  for (const state of ["!!!not-base64!!!", "", undefined, Buffer.from("null").toString("base64url")]) {
    const r = await call(h.routes, "GET /api/slack/callback", {
      session: { userId: 7, slackOAuthNonce: "n-1" }, query: { code: "c", state },
    });
    assert.equal(r.code, 400, `state ${JSON.stringify(state)}`);
  }
  assert.equal(h.linked.length, 0);
});

test("a signed-out callback is refused", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: {}, query: { code: "c", state: encodeState(7, "n-1") },
  });
  assert.equal(r.code, 400);
});

test("a missing code is refused", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" }, query: { state: encodeState(7, "n-1") },
  });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /Missing OAuth code/);
});

test("a declined consent screen redirects rather than erroring", async () => {
  const h = mount();
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" }, query: { error: "access_denied" },
  });
  assert.match(r.redirect, /^\/\?slack=denied/);
  assert.match(r.redirect, /access_denied/);
});

test("a failed exchange redirects with the reason and links nothing", async () => {
  const h = mount({ exchangeError: "invalid_code" });
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" }, query: { code: "c", state: encodeState(7, "n-1") },
  });
  assert.match(r.redirect, /slack=error/);
  assert.match(r.redirect, /invalid_code/);
  assert.equal(h.linked.length, 0);
});

test("an account already connected elsewhere is reported, not stolen", async () => {
  const h = mount({ linkResult: { ok: false, error: "That Slack account is already connected to another DCC account." } });
  const r = await call(h.routes, "GET /api/slack/callback", {
    session: { userId: 7, slackOAuthNonce: "n-1" }, query: { code: "c", state: encodeState(7, "n-1") },
  });
  assert.match(r.redirect, /slack=error/);
  assert.match(decodeURIComponent(r.redirect), /already connected to another DCC account/);
});

// ══ disconnect ═══════════════════════════════════════════════════════════════

test("disconnect unlinks the caller and only the caller", async () => {
  const h = mount();
  const { res, r } = mockRes();
  await h.routes["POST /api/slack/disconnect"]({ session: { userId: 7 } }, res);
  assert.deepEqual(h.unlinked, [7]);
  assert.deepEqual(r.body, { ok: true });
});

test("disconnect refuses an anonymous caller", async () => {
  const h = mount();
  const { res, r } = mockRes();
  await h.routes["POST /api/slack/disconnect"]({ session: {} }, res);
  assert.equal(r.code, 401);
  assert.deepEqual(h.unlinked, []);
});

// ══ the real module, not the stub ════════════════════════════════════════════

test("the real module builds a user_scope URL and never asks for bot scopes", async () => {
  // Sending `scope` would ask to change the app's BOT scopes, forcing a
  // workspace-level reinstall and risking the event subscriptions that already work.
  const o = createSlackOAuth({ env: {
    SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec",
    APP_URL: "https://dcc.test", SLACK_TOKEN_ENC_KEY: generateKey(),
  } });
  const url = new URL(o.getAuthUrl(7, "n-1"));
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("user_scope"), "reactions:read,reactions:write");
  assert.equal(url.searchParams.get("scope"), null, "no bot scopes requested");
  assert.equal(url.searchParams.get("redirect_uri"), "https://dcc.test/api/slack/callback");
});

// Exercised against the REAL decodeState, not the stub: `?state=<base64 of
// "null">` is VALID JSON, so a catch-only guard parses it to null and the
// caller's `state.userId` read throws a TypeError — a 500 where a 400 belongs.
// gcal-auth.js decodeState has this hole today; a route test could not catch it
// because the route test stubs decodeState out.
test("the real decodeState coerces every non-object to an empty object", async () => {
  const o = createSlackOAuth({ env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec" } });
  const b64 = (v) => Buffer.from(v).toString("base64url");
  for (const raw of ["null", "true", "42", '"a string"', "[1,2]"]) {
    const out = o.decodeState(b64(raw));
    assert.equal(typeof out, "object", `${raw} must decode to an object`);
    assert.ok(out && !Array.isArray(out), `${raw} must not decode to null or an array`);
    assert.equal(out.userId, undefined, `${raw} must not present a userId`);
  }
  // And a real state still survives the coercion.
  assert.deepEqual(o.decodeState(o.encodeState(7, "n-1")), { userId: 7, nonce: "n-1" });
  assert.deepEqual(o.decodeState("!!!not-base64!!!"), {});
  assert.deepEqual(o.decodeState(""), {});
  assert.deepEqual(o.decodeState(undefined), {});
});

test("the redirect URI comes from env, never from a request header", async () => {
  // It has to byte-match what Slack has registered, so deriving it from a Host
  // header would break on any alternate hostname.
  const o = createSlackOAuth({ env: {
    SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec",
    SLACK_REDIRECT_URI: "https://explicit.test/cb", APP_URL: "https://ignored.test",
  } });
  assert.equal(o.redirectUri(), "https://explicit.test/cb");
});

test("the exchange reads the USER token, not the bot token", async () => {
  let sent = null;
  const o = createSlackOAuth({
    env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec", APP_URL: "https://d.test", SLACK_TOKEN_ENC_KEY: generateKey() },
    fetchImpl: async (url, init) => {
      sent = { url, body: init.body };
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        access_token: "xoxb-BOT-must-not-be-used",
        team: { id: "T1", name: "Clever" },
        authed_user: { id: "U_NORA", access_token: "xoxp-nora", scope: "reactions:read,reactions:write" },
      }) };
    },
  });
  const grant = await o.exchangeCode("the-code");
  assert.equal(grant.token, "xoxp-nora");
  assert.equal(grant.slackUserId, "U_NORA");
  assert.equal(grant.teamId, "T1");
  assert.deepEqual(grant.scopes, ["reactions:read", "reactions:write"]);
  assert.match(sent.url, /oauth\.v2\.access$/);
  assert.match(sent.body, /client_secret=sec/);
});

test("a bot-only grant is an error rather than a silent no-op", async () => {
  const o = createSlackOAuth({
    env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec", SLACK_TOKEN_ENC_KEY: generateKey() },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, access_token: "xoxb-only", team: { id: "T1" } }) }),
  });
  await assert.rejects(() => o.exchangeCode("c"), (e) => e.code === "no_user_token");
});

test("Slack's ok:false is an error even on HTTP 200", async () => {
  const o = createSlackOAuth({
    env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec" },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_code" }) }),
  });
  await assert.rejects(() => o.exchangeCode("c"), (e) => e.code === "invalid_code");
});

test("a sealed grant round-trips through the envelope", async () => {
  const o = createSlackOAuth({ env: {
    SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec", SLACK_TOKEN_ENC_KEY: generateKey(),
  } });
  const sealed = o.sealGrant({ slackUserId: "U1", teamId: "T1", token: "xoxp-1", scopes: ["reactions:write"] });
  assert.ok(!sealed.includes("xoxp-1"), "the token is not readable in the stored value");
  const opened = o.openGrant(sealed);
  assert.equal(opened.token, "xoxp-1");
  assert.deepEqual(opened.scopes, ["reactions:write"]);
  assert.equal(opened.slackUserId, "U1");
});

test("sealing without an encryption key throws a 503 rather than storing plaintext", async () => {
  const o = createSlackOAuth({ env: { SLACK_CLIENT_ID: "cid", SLACK_CLIENT_SECRET: "sec" } });
  assert.equal(o.hasEncryptionKey(), false);
  assert.throws(() => o.sealGrant({ token: "xoxp-1", scopes: [] }), (e) => e.statusCode === 503);
});
