const { performance } = require("node:perf_hooks");
const { route } = require("../lib/route-helpers");
const { createConversationStore } = require("../conversation-store");
module.exports = function mount(app, ctx, config = {}) {
  const store = createConversationStore(ctx);
  function replyRead(res, value, result, start) {
    const durationMs = Number((performance.now() - start).toFixed(1));
    res.setHeader("Server-Timing", (result === "unchanged" ? "queue-unchanged" : "queue-snapshot") + ";dur=" + durationMs);
    if (process.env.DCC_QUEUE_READ_METRICS === "1") {
      console.log("[working-queue-read]", JSON.stringify({ event: "working_queue_read", result, durationMs }));
    }
    return value;
  }
  app.use("/api/working-queue", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.session?.userId || !req.workspaceId)
      return res.status(401).json({ error: "Sign in to use Working Queue" });
    if (!(config.enabled ?? process.env.DCC_CONVERSATION_ENABLED === "true"))
      return res.status(503).json({ error: "Working Queue is not available yet" });
    req.queueOwner = { userId: req.session.userId, workspaceId: req.workspaceId };
    const scope = req.get("X-DCC-Queue-Scope");
    const expected = encodeURIComponent(JSON.stringify([req.queueOwner.userId, req.queueOwner.workspaceId]));
    if (scope && scope !== expected)
      return res.status(409).json({ error: "Queue account changed. Reload to continue.", code: "queue_scope_changed" });
    try {
      const ready = await ctx.pool.query(
        "SELECT 1 FROM pg_indexes WHERE indexname='conversation_one_foreground_per_user' AND schemaname=current_schema()"
      );
      if (!ready.rows.length)
        return res.status(503).json({ error: "Working Queue is awaiting its foreground migration review" });
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get(
    "/api/working-queue/completion-review",
    route((req) => store.completionReview(req.query, req.queueOwner))
  );
  app.get(
    "/api/working-queue/task/:id",
    route((req) => store.get(req.params.id, req.queueOwner))
  );
  app.get(
    "/api/working-queue",
    route(async (req, res) => {
      const start = performance.now();
      if (!req.get("X-DCC-Queue-Scope")) {
        return replyRead(res, await store.state(req.queueOwner), "legacy", start);
      }
      if (process.env.DCC_QUEUE_CONDITIONAL_READS !== "0") {
        try {
          const value = await store.browserState(req.queueOwner, req.get("X-DCC-Queue-Version"));
          return replyRead(res, value, value.unchanged ? "unchanged" : "snapshot", start);
        } catch (error) {
          if (error.status || error.statusCode) throw error;
          // Keep the old read path available if the validator cannot run.
          console.warn("[working-queue] conditional read unavailable", error.code || error.name);
        }
      }
      const state = await store.state(req.queueOwner);
      return replyRead(res, { state }, "fallback", start);
    })
  );
  app.get(
    "/api/working-queue/tasks",
    route((req) => store.searchQueueTasks(req.query, req.queueOwner))
  );
  app.get(
    "/api/working-queue/tasks/:id/completion-preview",
    route((req) => store.completionPreview(req.params.id, req.queueOwner))
  );
  app.post(
    "/api/working-queue",
    route(async (req, res) => {
      const start = performance.now();
      const result = await store.execute(req.body, req.queueOwner);
      res.setHeader("Server-Timing", "queue-command;dur=" + (performance.now() - start).toFixed(1));
      ctx.broadcast?.(
        "blocks-changed",
        {
          action: "working-queue",
          blockIds: [
            ...new Set([
              ...(result.affectedTasks || []).map((row) => row.id),
              ...(result.reconciliation?.afterRows || []).map((row) => row.id)
            ])
          ]
        },
        req.workspaceId
      );
      ctx.broadcastQueueChange?.(req.queueOwner.userId, req.workspaceId);
      return result;
    })
  );
  return store;
};
