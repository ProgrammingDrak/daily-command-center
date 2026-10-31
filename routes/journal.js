const { route } = require("../lib/route-helpers");
const { createJournalStore } = require("../journal-store");

module.exports = function mountJournal(app, ctx) {
  const store = createJournalStore(ctx);
  // Session AND workspace ownership, never bearer/header-selected identity or
  // grants -- the same gate as private activity records.
  async function owner(req, res, next) {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.session?.userId || !req.workspaceId) return res.status(401).json({ error: "Sign in to open your journal", code: "SIGNED_OUT" });
    try {
      const { rows } = await ctx.pool.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [req.workspaceId, req.session.userId]);
      if (!rows.length) return res.status(403).json({ error: "Only the workspace owner can open journal pages" });
      req.journalOwner = { workspaceId: req.workspaceId, userId: req.session.userId };
      next();
    } catch (e) { next(e); }
  }
  app.use("/api/journal", owner);
  app.get("/api/journal/tasks/:id", route(req => store.get(req.params.id, req.journalOwner)));
  // No blocks-changed broadcast: page content is not task state, and other tabs
  // learn of a newer revision through their own revision check.
  app.put("/api/journal/tasks/:id", route(req => store.save(req.params.id, req.body || {}, req.journalOwner)));
  app.post("/api/journal/tasks/:id/undo", route(req => store.undo(req.params.id, req.body || {}, req.journalOwner)));
};
