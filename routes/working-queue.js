const { route } = require("../lib/route-helpers");
const { createConversationStore } = require("../conversation-store");
module.exports = function mount(app, ctx, config = {}) {
  const store = createConversationStore(ctx);
  app.use("/api/working-queue", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.session?.userId || !req.workspaceId)
      return res.status(401).json({ error: "Sign in to use Working Queue" });
    if (!(config.enabled ?? process.env.DCC_CONVERSATION_ENABLED === "true"))
      return res.status(503).json({ error: "Working Queue is not available yet" });
    try {
      const ready = await ctx.pool.query(
        "SELECT 1 FROM pg_indexes WHERE indexname='conversation_one_foreground_per_user' AND schemaname=current_schema()"
      );
      if (!ready.rows.length)
        return res.status(503).json({ error: "Working Queue is awaiting its foreground migration review" });
      req.queueOwner = { userId: req.session.userId, workspaceId: req.workspaceId };
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get(
    "/api/working-queue",
    route((req) => store.state(req.queueOwner))
  );
  app.get(
    "/api/working-queue/tasks",
    route((req) => store.search(req.query, req.queueOwner))
  );
  app.get('/api/working-queue/tasks/:id/notes', route(req => store.taskNotes(req.params.id, req.queueOwner)));
  app.put('/api/working-queue/tasks/:id/notes', route(async req => {
    const result=await store.taskNotes(req.params.id, req.queueOwner, req.body);
    ctx.broadcast?.('blocks-changed',{action:'task-notes',blockIds:[...new Set([result.taskId,result.noteBlockId].filter(Boolean))]},req.workspaceId);
    return result;
  }));
  app.get('/api/working-queue/tasks/:id/tree', route(req => store.taskTree(req.params.id, req.queueOwner)));
  app.get('/api/working-queue/tasks/:id/completion-preview', route(req => store.completionPreview(req.params.id, req.queueOwner)));
  app.post(
    "/api/working-queue",
    route(async (req) => {
      const result = await store.execute(req.body, req.queueOwner);
      ctx.broadcast?.(
        "blocks-changed",
        { action: "working-queue", blockIds: (result.affectedTasks || []).map((row) => row.id) },
        req.workspaceId
      );
      return result;
    })
  );
  return store;
};
