const { route } = require("../lib/route-helpers");
const { createActivityStore } = require("../activity-store");
const Model = require("../public/js/activity-model");

module.exports = function mountActivity(app, ctx) {
  const store = createActivityStore(ctx);
  // Session AND workspace ownership, never bearer/header-selected identity or grants.
  async function owner(req, res, next) {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.session?.userId || !req.workspaceId) return res.status(401).json({ error: "Sign in to view private activity records" });
    try {
      const { rows } = await ctx.pool.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [req.workspaceId, req.session.userId]);
      if (!rows.length) return res.status(403).json({ error: "Only the workspace owner can access activity records" });
      req.activityOwner = { workspaceId: req.workspaceId, userId: req.session.userId };
      next();
    } catch (e) { next(e); }
  }
  app.use("/api/activity", owner);
  function range(req) { return { from: req.query.from, to: req.query.to, includeArchived: req.query.includeArchived === "true" }; }
  app.get("/api/activity", route(async req => ({ records: await store.list(range(req), req.activityOwner) })));
  app.post("/api/activity/tasks", route(async req => {
    const result = await store.create(req.body || {}, req.activityOwner);
    ctx.broadcast("blocks-changed", { action: "activity-create", blockIds: [result.taskId] }, req.workspaceId);
    return result;
  }));
  app.get("/api/activity/export", route(async (req, res) => {
    const records = await store.list(range(req), req.activityOwner);
    if (req.query.format === "csv") {
      res.setHeader("Content-Disposition", 'attachment; filename="dcc-activity.csv"');
      return res.type("text/csv").send(Model.csv(records));
    }
    res.setHeader("Content-Disposition", 'attachment; filename="dcc-activity.json"');
    return res.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), records });
  }));
  app.get("/api/activity/tasks/:id", route(req => store.get(req.params.id, req.activityOwner)));
  app.put("/api/activity/tasks/:id", route(async req => {
    const result = await store.save(req.params.id, req.body || {}, req.activityOwner);
    ctx.broadcast("blocks-changed", { action: "activity-record", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));
  for (const action of ["archive", "restore", "undo"]) {
    app.post(`/api/activity/tasks/:id/${action}`, route(req => store.change(req.params.id, req.body || {}, req.activityOwner, action)));
  }
};
