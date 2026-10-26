const { route } = require("../lib/route-helpers");
const { createGuidedStore } = require("../guided-store");
module.exports = function mountGuided(app, ctx) {
  const store = createGuidedStore(ctx);
  app.use("/api/guided", async (req,res,next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.session?.userId || !req.workspaceId) return res.status(401).json({ error: "Sign in to access guided conversations" });
    try {
      const { rows } = await ctx.pool.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [req.workspaceId,req.session.userId]);
      if (!rows.length) return res.status(403).json({error:"Only the workspace owner can access guided conversations"});
      req.guidedOwner = {workspaceId:req.workspaceId,userId:req.session.userId}; next();
    } catch (e) { next(e); }
  });
  app.get("/api/guided", route(req => store.list(req.guidedOwner)));
  app.post("/api/guided/definitions", route(req => store.saveDefinition(req.body||{},req.guidedOwner)));
  app.put("/api/guided/definitions/:id", route(req => store.saveDefinition(req.body||{},req.guidedOwner,req.params.id)));
  app.get("/api/guided/definitions/:id/versions", route(async req => ({versions:await store.versions(req.params.id,req.guidedOwner)})));
  app.post("/api/guided/definitions/:id/rollback", route(req => store.rollback(req.params.id,req.body||{},req.guidedOwner)));
  app.post("/api/guided/tasks/:id/apply-feedback", route(req => store.applyFeedback(req.params.id,req.body||{},req.guidedOwner)));
  app.post("/api/guided/tasks", route(async req => {
    const result=await store.createTask(req.body||{},req.guidedOwner);
    ctx.broadcast("blocks-changed",{action:"guided-create",blockIds:[result.taskId]},req.workspaceId); return result;
  }));
  app.post("/api/guided/tasks/:id/definition", route(req => store.attach(req.params.id,req.body||{},req.guidedOwner)));
  app.get("/api/guided/tasks/:id", route(req => store.get(req.params.id,req.guidedOwner)));
  app.post("/api/guided/tasks/:id/actions", route(async req => {
    const result=await store.act(req.params.id,req.body||{},req.guidedOwner);
    ctx.broadcast("blocks-changed",{action:"guided-progress",blockIds:[result.taskId]},req.workspaceId); return result;
  }));
};
