// Operator/service access is separate from account OAuth. No identity headers.
function failure(message) {
  const e = new Error(message);
  e.statusCode = 403;
  return e;
}
function targetFromEnvironment(env = process.env) {
  const userId = Number(env.DCC_SERVICE_USER_ID),
    workspaceId = env.DCC_SERVICE_WORKSPACE_ID;
  if (!Number.isSafeInteger(userId) || userId < 1 || !workspaceId) return null;
  return { userId, workspaceId, source: "configured-service" };
}
function bindService(req, identity) {
  if (!identity) throw failure("Service account binding is required");
  if (
    (req.headers["x-user-id"] && String(req.headers["x-user-id"]) !== String(identity.userId)) ||
    (req.headers["x-workspace-id"] && req.headers["x-workspace-id"] !== identity.workspaceId)
  )
    throw failure("Service credentials cannot select another account");
  req.dccServiceAuth = identity;
  req.workspaceId = identity.workspaceId;
}
function trustedDevelopment(req, env = process.env) {
  if (env.NODE_ENV === "production" || env.DCC_LOCAL_AUTH !== "1" || env.DCC_LOCAL_DISPOSABLE_DATABASE !== "1")
    return false;
  const addr = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) return false;
  try {
    const url = new URL(env.DATABASE_URL);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      /^dcc_(test|dev|review)(_|$)/.test(url.pathname.slice(1))
    );
  } catch {
    return false;
  }
}
module.exports = { targetFromEnvironment, bindService, trustedDevelopment };
