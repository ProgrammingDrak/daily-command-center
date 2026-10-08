module.exports = function mount(app, { pool, route, broadcast, socialStore }) {
  const store = require("../commitment-store").createStore({ pool });
  app.use("/api/commitments", (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    res.set("Vary", "Cookie");
    if (!req.session?.userId) return res.status(401).json({ error: "Sign in first" });
    next();
  });
  app.get("/api/commitments", route(req => store.list(req.session.userId, req.query.date)));
  app.get("/api/commitments/:id", route(req => store.read(req.params.id, req.session.userId)));
  async function announce(result, req) {
    if (!broadcast || !socialStore) return;
    const people = new Set([req.session.userId, result.owner_user_id,
      ...(result.members || []).map(m => m.user_id),
      ...(["invite", "revoke"].includes(req.body?.kind) ? [Number(req.body.userId)] : [])]);
    for (const userId of people) if (userId) {
      try { broadcast("commitments-changed", { id: result.id }, await socialStore.resolveWorkspaceId(userId)); }
      catch (e) { console.error("[commitments] refresh notification failed:", e.message); }
    }
  }
  app.post("/api/commitments", route(async req => {
    const result = await store.create(req.session.userId, req.workspaceId, req.body || {});
    await announce(result, req); return result;
  }));
  app.post("/api/commitments/:id/actions", route(async req => {
    const result = await store.act(req.session.userId, req.params.id, req.body || {});
    await announce(result, req); return result;
  }));
};
