// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, getTodayStr, isValidDate, petHomeStore, pool, socialStore } = ctx;

// ── Pet visits ──
// Send your pet to a friend's home, carrying a note. The FRIEND GATE lives here
// rather than in pet-home-store: that store has no social dependency today and
// keeping it that way means its tests never need the friendship tables. A visit
// is also the first thing in the pet system that writes to somebody ELSE's
// workspace, so the consent check belongs at the HTTP boundary where the actor
// is unambiguous.
app.post("/api/pet-home/visit", async (req, res) => {
  try {
    const body = req.body || {};
    const toUserId = parseInt(body.toUserId, 10);
    const fromUserId = req.session.userId;
    if (!Number.isFinite(toUserId)) return res.status(400).json({ error: "toUserId required" });
    if (toUserId === fromUserId) return res.status(400).json({ error: "Your pet already lives here" });
    // BOTH checks, and the same 403 for each so the response never reveals that a
    // block exists. areFriends alone was not enough: friendships rows are
    // directed, so blockUser inserts a second row and leaves the original
    // 'accepted' one intact. areFriends is fixed to let a block veto, and this
    // explicit isBlocked call is the belt to that braces -- this endpoint writes
    // into somebody else's workspace, which is the last place to rely on one
    // predicate being right.
    if (await socialStore.isBlocked(fromUserId, toUserId)
        || !(await socialStore.areFriends(fromUserId, toUserId))) {
      return res.status(403).json({ error: "You can only send your pet to a friend" });
    }
    // Resolve the recipient's workspace through the OWNERSHIP table, not through
    // pet_homes.user_id: that column is nullable, non-unique, and records
    // whoever first opened the home rather than who owns it.
    const toWorkspaceId = await socialStore.resolveWorkspaceId(toUserId);
    // The visiting pet's name comes from the SENDER's stored home rather than the
    // request body. That stops a caller naming the pet inline, though the sender
    // can still rename their own pet, so `actor_name` is a display label and NOT
    // a trustworthy identity -- which is why the visit also records the sender's
    // username for the recipient to see.
    const { rows: mine } = await pool.query(
      "SELECT pet FROM pet_homes WHERE workspace_id = $1", [req.workspaceId]
    );
    const result = await petHomeStore.sendPetVisit({
      fromUserId,
      fromUsername: req.session.username || "",
      fromPetName: (mine[0] && mine[0].pet && mine[0].pet.name) || "A friend's pet",
      toUserId,
      toWorkspaceId,
      message: body.message,
      onDate: getTodayStr()
    });
    res.status(result.visited ? 201 : 200).json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not send your pet right now" });
  }
});

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
