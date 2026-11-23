const { createStore } = require("../places-store");
const { fail } = require("../lib/places-model");

module.exports = function mount(app, ctx) {
  const store = createStore(ctx);
  const router = ctx.placesRouter || require("../lib/places-providers").createRouter();
  const routingByOwner = new Set();
  const root = "/api/places";
  require("./places-share").mountShare(app, ctx, store);
  function route(run, mutation = false) {
    return async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const actor = { userId: Number(req.session?.userId), workspaceId: req.workspaceId };
        if (!Number.isSafeInteger(actor.userId) || actor.userId < 1 || !actor.workspaceId) throw fail("Sign in to open Places", 401);
        const account = actor.userId + ":" + actor.workspaceId;
        if ((mutation && req.get("x-dcc-places-owner") !== account) ||
            (req.get("x-dcc-places-owner") && req.get("x-dcc-places-owner") !== account))
          throw fail("The account changed. Reopen Places to continue.", 401);
        res.set("X-DCC-Places-Owner", account);
        if (mutation && (req.get("x-dcc-places") !== "1" || req.get("sec-fetch-site") === "cross-site" ||
            (req.get("origin") && req.get("origin") !== (req.protocol + "://" + req.get("host")))))
          throw fail("Use the Places controls in DCC", 403);
        res.json(await run(req, actor));
      } catch (error) {
        if (!error.statusCode) console.error("[places]", error.code || error.name);
        res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : "Places is unavailable. Retry shortly." });
      }
    };
  }
  const shareOwner = actor => actor.userId + ":" + actor.workspaceId;
  app.get(root, route(async (req, actor) => ({ ...await store.list(actor), routingAvailable: router.available,
    shareToPlaces: req.session.placesShareOwner === shareOwner(actor) })));
  app.post(root + "/share-preference", route(async (req, actor) => {
    await store.authorize(actor);
    if (typeof req.body?.enabled !== "boolean") throw fail("Choose a share destination");
    req.session.placesShareOwner = req.body.enabled ? shareOwner(actor) : null;
    return { shareToPlaces: req.body.enabled };
  }, true));
  app.post(root + "/trips/:id/route", route(async (req, actor) => {
    const payload = await store.routeInputs(actor, req.params.id, req.body?.day, req.body?.mode);
    if (routingByOwner.has(actor.workspaceId)) throw fail("A route lookup is already running.", 429);
    routingByOwner.add(actor.workspaceId);
    try { return { ...await router.route(payload.points, payload.mode), stopIds: payload.stopIds, revision: payload.revision }; }
    finally { routingByOwner.delete(actor.workspaceId); }
  }, true));
  app.get(root + "/trips/:id/preview", route((req, actor) => store.review(actor, req.params.id, req.query.date)));
  app.get(root + "/trips/:id/proposal", route((req, actor) => store.proposal(actor, req.params.id, req.query.strategy)));
  app.get(root + "/related", route((req, actor) => store.related(actor, req.query.q)));
  app.put(root + "/mutations/:requestId", route(async (req, actor) => {
    const result = await store.mutate(actor, req.params.requestId, req.body);
    if (result.blockIds?.length && !result.replayed)
      ctx.broadcast?.("blocks-changed", { action: "places", blockIds: result.blockIds }, actor.workspaceId);
    return result;
  }, true));
};
