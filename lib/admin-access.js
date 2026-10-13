// Preserve the existing site-admin username allowlist; workspace roles are separate.
module.exports = function createAdminAccess(adminUsernames) {
  function isAdminSession(req) {
    return adminUsernames.has(String(req.session?.username || "").toLowerCase());
  }

  function requireAdmin(req, res, next) {
    if (isAdminSession(req)) return next();
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Admin access required" });
    return res.status(403).send("Admin access required");
  }

  return { isAdminSession, requireAdmin };
};
