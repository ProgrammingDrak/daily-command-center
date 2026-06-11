// Service-token admin API (requires an admin session).
//   GET    /api/admin/tokens      — list (no secrets)
//   POST   /api/admin/tokens      — create { name, scope?, ttlDays? } → plaintext shown ONCE
//   DELETE /api/admin/tokens/:id  — revoke immediately
const tokenStore = require("../token-store");
const validate = require("../middleware/validate");
const schemas = require("../middleware/schemas");

module.exports = function mount(app, ctx) {
  const { requireAdmin, route } = ctx;

  app.get("/api/admin/tokens", requireAdmin, route(() => tokenStore.listTokens()));

  app.post("/api/admin/tokens", requireAdmin, validate(schemas.tokenCreate), route(async (req, res) => {
    const created = await tokenStore.createToken(req.body);
    res.status(201).json({ ...created, note: "Store this token now — it cannot be retrieved again." });
  }));

  app.delete("/api/admin/tokens/:id", requireAdmin, route(async (req) => {
    const ok = await tokenStore.revokeToken(req.params.id);
    if (!ok) { const e = new Error("token not found or already revoked"); e.statusCode = 404; throw e; }
    return { ok: true };
  }));
};
