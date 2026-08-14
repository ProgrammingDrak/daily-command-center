const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { SCOPES, mergeOAuthTokens } = require("./gcal-auth");

test("OAuth requests Chat read scopes and preserves a prior refresh token", () => {
  assert.equal(SCOPES.includes("https://www.googleapis.com/auth/chat.messages.readonly"), true);
  assert.deepEqual(mergeOAuthTokens(
    { refresh_token: "durable", access_token: "old", scope: "old-scope" },
    { access_token: "new", scope: "new-scope" }
  ), { refresh_token: "durable", access_token: "new", scope: "new-scope" });
});

function appFixture() {
  const calls = [];
  const session = { userId: 7 };
  const app = express();
  app.use((req, _res, next) => { req.session = session; next(); });
  require("./routes/gcal")(app, {
    REALTIME_GCAL_SYNC_ENABLED: false,
    crypto: { randomUUID: () => "nonce-1" },
    gcalAuth: {
      getAuthUrl: async (...args) => { calls.push(["url", ...args]); return "https://accounts.google.test/consent"; },
      decodeState: value => value === "good" ? { userId: 7, accountKey: "work", nonce: "nonce-1" } : { userId: 7, accountKey: "work", nonce: "wrong" },
      handleCallback: async (...args) => { calls.push(["callback", ...args]); },
    },
  });
  return { app, calls, session };
}

async function request(app, path, redirect = "manual") {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try { return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect }); }
  finally { server.close(); }
}

test("OAuth start binds a nonce to the session and leaves sync routes disabled", async () => {
  const { app, calls, session } = appFixture();
  const auth = await request(app, "/api/gcal/auth?account=work");
  assert.equal(auth.status, 302);
  assert.equal(auth.headers.get("location"), "https://accounts.google.test/consent");
  assert.equal(session.googleOAuthNonce, "nonce-1");
  assert.deepEqual(calls[0], ["url", 7, "work", "nonce-1"]);
  const sync = await request(app, "/api/gcal/sync");
  assert.equal(sync.status, 410);
});

test("OAuth callback rejects a mismatched nonce and accepts the initiating session", async () => {
  const bad = appFixture();
  bad.session.googleOAuthNonce = "nonce-1";
  assert.equal((await request(bad.app, "/api/gcal/callback?code=x&state=bad")).status, 400);
  assert.equal(bad.calls.some(call => call[0] === "callback"), false);

  const good = appFixture();
  good.session.googleOAuthNonce = "nonce-1";
  const response = await request(good.app, "/api/gcal/callback?code=code-1&state=good");
  assert.equal(response.status, 302);
  assert.deepEqual(good.calls.find(call => call[0] === "callback"), ["callback", "code-1", 7, "work"]);
  assert.equal(good.session.googleOAuthNonce, undefined);
});
