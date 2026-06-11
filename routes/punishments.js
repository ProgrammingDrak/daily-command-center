// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { broadcast, punishmentStore, route } = ctx;

// ── Punishments Wheel API ──
// Flat weighted mirror of the rewards spinner. See punishment-store.js.
app.get("/api/punishment/state", route(req =>
  punishmentStore.getPunishmentState(req.workspaceId, req.session.userId)));

app.post("/api/punishment/punishments", route(async (req) => {
  const row = await punishmentStore.createPunishment(req.workspaceId, req.session.userId, req.body || {});
  broadcast("punishment-changed", { action: "create" }, req.workspaceId);
  return row;
}));

app.put("/api/punishment/punishments/:id", route(async (req) => {
  const row = await punishmentStore.updatePunishment(req.workspaceId, req.params.id, req.body || {});
  broadcast("punishment-changed", { action: "update" }, req.workspaceId);
  return row;
}));

app.delete("/api/punishment/punishments/:id", route(async (req) => {
  const result = await punishmentStore.deletePunishment(req.workspaceId, req.params.id);
  broadcast("punishment-changed", { action: "delete" }, req.workspaceId);
  return result;
}));

app.post("/api/punishment/punishments/reorder", route(async (req) => {
  const result = await punishmentStore.reorderPunishments(req.workspaceId, (req.body && req.body.items) || req.body || []);
  broadcast("punishment-changed", { action: "reorder" }, req.workspaceId);
  return result;
}));

app.post("/api/punishment/owe", route(async (req) => {
  const result = await punishmentStore.addOwedSpin(req.workspaceId, req.session.userId, (req.body && req.body.count) || 1);
  broadcast("punishment-changed", { action: "owe" }, req.workspaceId);
  return result;
}));

app.post("/api/punishment/spin", route(async (req) => {
  const result = await punishmentStore.spinPunishment(req.workspaceId, req.session.userId);
  broadcast("punishment-changed", { action: "spin" }, req.workspaceId);
  return result;
}));

app.post("/api/punishment/spins/:id/done", route(async (req) => {
  const row = await punishmentStore.resolvePunishment(req.workspaceId, req.params.id);
  broadcast("punishment-changed", { action: "resolve" }, req.workspaceId);
  return row;
}));

// Create or link the partner who receives money punishments.
app.post("/api/punishment/partner", route(async (req) => {
  const body = req.body || {};
  const mode = body.mode === "link" ? "link" : "create";
  const partner = mode === "link"
    ? await punishmentStore.linkExistingPartner(req.workspaceId, req.session.userId, body.username)
    : await punishmentStore.createPartner(req.workspaceId, req.session.userId, { username: body.username, password: body.password });
  broadcast("punishment-changed", { action: "partner-link" }, req.workspaceId);
  return { partner };
}));

app.delete("/api/punishment/partner", route(async (req) => {
  const result = await punishmentStore.unlinkPartner(req.workspaceId);
  broadcast("punishment-changed", { action: "partner-unlink" }, req.workspaceId);
  return result;
}));

};
