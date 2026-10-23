const path = require('node:path');

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

  // Static serving decodes and normalizes paths after Express route matching.
  function guardAdminPage(req, res, next) {
    let pathname;
    try { pathname = path.posix.normalize(decodeURIComponent(req.path)).replace(/\/+$/, '').toLowerCase(); }
    catch { return res.status(400).send('Invalid path'); }
    if (pathname === '/admin' || pathname === '/admin.html') {
      res.set('Cache-Control', 'no-store');
      return requireAdmin(req, res, next);
    }
    next();
  }

  return { isAdminSession, requireAdmin, guardAdminPage };
};
