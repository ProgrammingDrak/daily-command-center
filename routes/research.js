const { createStore } = require("../research-store");
const { fail } = require("../lib/wishlist-model");
module.exports = function mount(app, ctx) {
  const store = createStore(ctx);
  const route =
    (run, write = false) =>
    async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const actor = { userId: Number(req.session?.userId), workspaceId: req.workspaceId };
        if (!Number.isSafeInteger(actor.userId) || actor.userId < 1 || !actor.workspaceId)
          throw fail("Sign in to open Research & Ideas", 401);
        const owner = actor.userId + ":" + actor.workspaceId;
        if (req.get("x-dcc-research-owner") && req.get("x-dcc-research-owner") !== owner)
          throw fail("Account changed. Reopen Research & Ideas.", 401);
        res.set("X-DCC-Research-Owner", owner);
        if (
          write &&
          (req.get("x-dcc-wishlist") !== "1" ||
            req.get("sec-fetch-site") === "cross-site" ||
            (req.get("origin") && req.get("origin") !== req.protocol + "://" + req.get("host")))
        )
          throw fail("Use the Research & Ideas controls in DCC", 403);
        const result = await run(req, actor);
        if (write) ctx.broadcast?.("research-changed", { id: req.params.id || result.id }, actor.workspaceId);
        res.json(result);
      } catch (e) {
        if (!e.statusCode) console.error("[research]", e.code || e.name);
        res
          .status(e.statusCode || 503)
          .json({ error: e.statusCode ? e.message : "Research service unavailable. Retry shortly." });
      }
    };
  app.post(
    "/api/research/search",
    route((r, a) => store.search(a, r.body))
  );
  app.get(
    "/api/research/activity",
    route((r, a) =>
      store.activity(a, {
        ...(r.query.id ? { id: r.query.id } : {}),
        offset: Number(r.query.offset || 0),
        questions: r.query.questions === "true"
      })
    )
  );
  app.get(
    "/api/research/blocks/:blockId",
    route((r, a) => store.forBlock(a, r.params.blockId))
  );
  app.get(
    "/api/research/project-choices",
    route(
      async (_r, a) =>
        (await require("../project-store").createProjectStore(ctx).listOrganization(a.workspaceId)).projects
    )
  );
  app.get(
    "/api/research/task-choices",
    route((r, a) => store.searchTasks(a, r.query.q))
  );
  app.post(
    "/api/research",
    route((r, a) => store.create(a, r.body), true)
  );
  app.put(
    "/api/research/links",
    route((r, a) => store.link(a, r.body), true)
  );
  app.get(
    "/api/research/:id",
    route((r, a) => store.get(a, r.params.id))
  );
  app.patch(
    "/api/research/:id",
    route((r, a) => store.save(a, r.params.id, r.body), true)
  );
  app.put(
    "/api/research/:id/entries",
    route((r, a) => store.entry(a, r.params.id, r.body), true)
  );
  app.post(
    "/api/research/:id/action",
    route(async (r, a) => {
      const result = await store.action(a, r.params.id, r.body);
      if (!result.duplicate)
        ctx.broadcast?.("blocks-changed", { action: "research-action", blockIds: [result.id] }, a.workspaceId);
      return result;
    }, true)
  );
};
