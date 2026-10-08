// A browser tab is pinned to the account that served app-config. Session
// replacement in another tab must not turn an old queued intent into a write
// for the new account. Service principals keep their existing scoped contract.
module.exports = function accountBinding(req, res, next) {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/auth/")
      || req.dccServiceAuth || !req.session?.userId) return next();
  const user = req.get("X-DCC-User");
  const workspace = req.get("X-DCC-Workspace");
  const required = /^\/api\/(blocks|tasks|commitments)(?:\/|$)/.test(req.path);
  if ((required || user || workspace) && (user !== String(req.session.userId) || workspace !== req.workspaceId)) {
    return res.status(409).json({ error: "This tab belongs to another account or needs a reload. Your queued work has been kept.", code: "ACCOUNT_CHANGED" });
  }
  next();
};
