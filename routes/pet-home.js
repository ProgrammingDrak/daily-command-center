// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, getTodayStr, isValidDate, petHomeStore, pool } = ctx;

// ── Pet Home API ──
app.get("/api/pet-home/state", async (req, res) => {
  try {
    const state = await petHomeStore.getState(req.workspaceId, req.session.userId);
    const slug = state.home.shareSlug;
    res.json({ ...state, shareUrl: slug ? petHomeStore.publicUrl(req, slug) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/pet-home/state", async (req, res) => {
  try {
    const state = await petHomeStore.updateState(req.workspaceId, req.session.userId, req.body || {});
    const slug = state.home.shareSlug;
    broadcast("pet-home-changed", { action: "state" }, req.workspaceId);
    res.json({ ...state, shareUrl: slug ? petHomeStore.publicUrl(req, slug) : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/pet-home/share", async (req, res) => {
  try {
    const home = await petHomeStore.enableShare(req.workspaceId, req.session.userId);
    res.json({ home, shareUrl: petHomeStore.publicUrl(req, home.shareSlug) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/pet-home/share/rotate", async (req, res) => {
  try {
    const home = await petHomeStore.rotateShare(req.workspaceId, req.session.userId);
    res.json({ home, shareUrl: petHomeStore.publicUrl(req, home.shareSlug) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/pet-home/feed-task", async (req, res) => {
  try {
    const result = await petHomeStore.awardTaskCare(req.workspaceId, req.session.userId, req.body || {});
    if (result.awarded) broadcast("pet-home-changed", { action: "task-feed" }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/pet-home/suggestions", async (req, res) => {
  try { res.json(await petHomeStore.listSuggestions(req.workspaceId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/pet-home/suggestions/:id/approve", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      "SELECT * FROM pet_task_suggestions WHERE id = $1 AND workspace_id = $2",
      [id, req.workspaceId]
    );
    const suggestion = rows[0];
    if (!suggestion) return res.status(404).json({ error: "Suggestion not found" });
    if (suggestion.status !== "pending") return res.status(400).json({ error: "Suggestion already reviewed" });
    const date = req.body?.date && isValidDate(req.body.date) ? req.body.date : getTodayStr();
    const suggestionDuration = Number(req.body?.duration || 30);
    const suggestionEnd = `${String(Math.floor(suggestionDuration / 60)).padStart(2, "0")}:${String(suggestionDuration % 60).padStart(2, "0")}`;
    await blockDB.ensureDayRoot(date, req.session.userId, req.workspaceId);
    const created = await blockDB.createBlock({
      type: "block",
      date,
      sort_order: Date.now(),
      user_id: req.session.userId,
      workspace_id: req.workspaceId,
      properties: {
        local_id: `pet-suggestion-${suggestion.id}`,
        kind: "task",
        title: req.body?.title || suggestion.title,
        detail: req.body?.note || suggestion.note || "",
        duration: suggestionDuration,
        start: "00:00",
        end: suggestionEnd,
        priority: req.body?.priority || "Medium",
        source: "pet_home",
        publicVisibility: "public",
        visitorName: suggestion.visitor_name,
        added_at: new Date().toISOString()
      }
    });
    const updated = await petHomeStore.markSuggestion(req.workspaceId, id, "approved", created.id);
    broadcast("blocks-changed", { action: "pet-suggestion-approved", blockIds: [created.id] }, req.workspaceId);
    broadcast("pet-home-changed", { action: "suggestion-approved" }, req.workspaceId);
    res.json({ suggestion: updated, block: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/pet-home/suggestions/:id/dismiss", async (req, res) => {
  try {
    const updated = await petHomeStore.markSuggestion(req.workspaceId, Number(req.params.id), "dismissed");
    if (!updated) return res.status(404).json({ error: "Suggestion not found" });
    broadcast("pet-home-changed", { action: "suggestion-dismissed" }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/public/pet-home/:shareSlug", async (req, res) => {
  try {
    const state = await petHomeStore.getPublicHome(req.params.shareSlug, getTodayStr());
    if (!state) return res.status(404).json({ error: "Pet home is unavailable" });
    res.json(state);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/public/pet-home/:shareSlug/encouragement", async (req, res) => {
  try {
    const result = await petHomeStore.addEncouragement(req.params.shareSlug, req.body?.visitorName, req.body?.message);
    if (!result) return res.status(404).json({ error: "Pet home is unavailable" });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/public/pet-home/:shareSlug/suggestions", async (req, res) => {
  try {
    const suggestion = await petHomeStore.addSuggestion(req.params.shareSlug, req.body?.visitorName, req.body?.title, req.body?.note);
    if (!suggestion) return res.status(404).json({ error: "Pet home is unavailable" });
    res.status(201).json(suggestion);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

};
