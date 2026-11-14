const { createStore } = require("../wishlist-store");
const M = require("../lib/wishlist-model");

function sameOrigin(req) {
  const origin = req.get("origin");
  return (
    req.get("x-dcc-wishlist") === "1" &&
    req.get("sec-fetch-site") !== "cross-site" &&
    (!origin || origin === req.protocol + "://" + req.get("host"))
  );
}

module.exports = function mount(app, ctx) {
  const store = createStore(ctx);
  const route =
    (run, write = false) =>
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const userId = Number(req.session?.userId);
        if (!Number.isSafeInteger(userId) || userId < 1 || !req.workspaceId)
          throw M.fail("Sign in to open Wishlists", 401);
        if (write && !sameOrigin(req)) throw M.fail("Use the Wishlist controls in DCC", 403);
        const result = await run(req, { userId, workspaceId: req.workspaceId });
        res.json(result);
      } catch (error) {
        if (res.headersSent) return next(error);
        if (!error.statusCode) console.error("[wishlists]", error.code || error.name);
        res
          .status(error.statusCode || 503)
          .json({ error: error.statusCode ? error.message : "Wishlist service unavailable. Retry shortly." });
      }
    };
  app.get(
    "/api/wishlists",
    route((_req, actor) => store.list(actor))
  );
  app.post(
    "/api/wishlists",
    route(async (req, actor) => {
      const result = await store.create(actor, req.body);
      if (result.convertedTaskId)
        ctx.broadcast?.(
          "blocks-changed",
          {
            action: "wishlist-conversion",
            blockIds: [result.convertedTaskId]
          },
          actor.workspaceId
        );
      return result;
    }, true)
  );
  app.get(
    "/api/wishlists/task-choices",
    route((req, actor) => store.searchTasks(actor, req.query.q))
  );
  app.get(
    "/api/wishlists/:wishlistId",
    route((req, actor) => store.get(actor, req.params.wishlistId))
  );
  app.post(
    "/api/wishlists/:wishlistId/next-task",
    route(async (req, actor) => {
      const result = await store.addTask(actor, req.params.wishlistId, req.body);
      if (!result.duplicate)
        ctx.broadcast?.(
          "blocks-changed",
          { action: "wishlist-next-task", blockIds: [result.taskId] },
          actor.workspaceId
        );
      return result;
    }, true)
  );
  app.patch(
    "/api/wishlists/:wishlistId",
    route((req, actor) => store.save(actor, req.params.wishlistId, "overview", null, req.body), true)
  );
  app.put(
    "/api/wishlists/:wishlistId/:kind/:recordId",
    route((req, actor) => {
      if (!Object.hasOwn(M.records, req.params.kind)) throw M.fail("Unknown record type", 404);
      return store.save(actor, req.params.wishlistId, req.params.kind, req.params.recordId, req.body);
    }, true)
  );
};
