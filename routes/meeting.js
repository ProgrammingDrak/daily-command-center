// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { broadcast, getTodayStr, isValidDate, meetingAutomation } = ctx;

// ── Meeting Automation ──
app.get("/api/meetings/:blockId/automation", async (req, res) => {
  try {
    res.json(await meetingAutomation.getAutomation(req.params.blockId, req.workspaceId));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/prep", async (req, res) => {
  try {
    const result = await meetingAutomation.generatePrep(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      extraSources: Array.isArray(req.body?.sources) ? req.body.sources : [],
    });
    broadcast("blocks-changed", { action: "meeting-prep", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/transcript/ingest", async (req, res) => {
  try {
    const result = await meetingAutomation.ingestTranscript(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      transcriptText: req.body?.transcriptText || req.body?.text || "",
      sources: Array.isArray(req.body?.sources) ? req.body.sources : [],
    });
    broadcast("blocks-changed", { action: "meeting-transcript", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/actions/approve", async (req, res) => {
  try {
    const result = await meetingAutomation.approveActions(req.params.blockId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      actionIds: Array.isArray(req.body?.actionIds) ? req.body.actionIds : [],
    });
    broadcast("blocks-changed", { action: "meeting-actions-approved", blockIds: [req.params.blockId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Place an approved action onto a day (detach from the meeting, make it a real
// day task). The UI offers this right after approval; declining just skips it.
app.post("/api/meetings/:blockId/actions/:actionId/place", async (req, res) => {
  try {
    const result = await meetingAutomation.placeApprovedAction(req.params.blockId, req.params.actionId, {
      workspaceId: req.workspaceId,
      userId: req.session.userId,
      date: req.body?.date,
      start: req.body?.start || null,
    });
    broadcast("blocks-changed", { action: "meeting-action-placed", blockIds: [req.params.blockId, req.params.actionId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});


};
