const test = require("node:test"),
  assert = require("node:assert/strict");
const { targetFromEnvironment, bindService, trustedDevelopment } = require("./lib/service-access");
test("service identity has no account-1 fallback and cannot be overridden", () => {
  assert.equal(targetFromEnvironment({}), null);
  const target = targetFromEnvironment({ DCC_SERVICE_USER_ID: "4", DCC_SERVICE_WORKSPACE_ID: "ws-4" });
  assert.equal(target.userId, 4);
  assert.throws(
    () => bindService({ headers: { "x-user-id": "1" } }, target),
    (e) => e.statusCode === 403
  );
  assert.throws(
    () => bindService({ headers: { "x-workspace-id": "ws-1" } }, target),
    (e) => e.statusCode === 403
  );
  const req = { headers: {} };
  bindService(req, target);
  assert.deepEqual(req.dccServiceAuth, target);
});
test("token-free local access requires explicit disposable mode and a local development database", () => {
  const req = { socket: { remoteAddress: "127.0.0.1" } };
  const env = {
    NODE_ENV: "development",
    DCC_LOCAL_AUTH: "1",
    DCC_LOCAL_DISPOSABLE_DATABASE: "1",
    DATABASE_URL: "postgres://localhost/dcc_test_access"
  };
  assert.equal(trustedDevelopment(req, env), true);
  for (const change of [
    { NODE_ENV: "production" },
    { DATABASE_URL: "postgres://production.example/dcc_test_access" },
    { DATABASE_URL: "postgres://localhost/production" },
    { DCC_LOCAL_DISPOSABLE_DATABASE: "0" },
    { DCC_LOCAL_AUTH: "0" }
  ])
    assert.equal(trustedDevelopment(req, { ...env, ...change }), false);
  assert.equal(trustedDevelopment({ socket: { remoteAddress: "192.0.2.1" } }, env), false);
});
