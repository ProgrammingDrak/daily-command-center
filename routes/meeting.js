// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { broadcast, getTodayStr, isValidDate, meetingAutomation } = ctx;

// ── Meeting Automation ──
app.get("/api/meetings/actions/proposed", async (req, res) => {
  try {
    res.json({ items: await meetingAutomation.listProposedActions({ workspaceId: req.workspaceId, limit: req.query?.limit }) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

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
    broadcast("blocks-changed", { action: "meeting-prep", blockIds: [req.params.blockId], clientId: req.body?._clientId }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// In-place user edit of a prep/summary doc (the block-editor autosave path). The
// generic PATCH /api/blocks/:id can't be used: db.updateBlock replaces properties
// wholesale, which would drop the artifact's kind/meetingBlockId/sources. This
// delegates to updateArtifactContent, which merges over the existing properties.
// Echoes clientId so the origin tab's own broadcast is suppressed (sse.js) and the
// live editor isn't stomped by its own save.
app.patch("/api/meetings/:blockId/artifact", async (req, res) => {
  try {
    const kind = req.body?.kind;
    if (kind !== "meeting_prep" && kind !== "meeting_summary") {
      return res.status(400).json({ error: "kind must be meeting_prep or meeting_summary" });
    }
    const result = await meetingAutomation.updateArtifactContent(req.params.blockId, kind, {
      html: req.body?.html,
      blocks: req.body?.blocks,
      markdown: req.body?.markdown,
    }, { workspaceId: req.workspaceId, userId: req.session.userId });
    broadcast("blocks-changed", { action: "meeting-artifact-edit", blockIds: [req.params.blockId], clientId: req.body?._clientId }, req.workspaceId);
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
    broadcast("blocks-changed", { action: "meeting-transcript", blockIds: [req.params.blockId], clientId: req.body?._clientId }, req.workspaceId);
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

app.post("/api/meetings/:blockId/actions/:actionId/dismiss", async (req, res) => {
  try {
    const result = await meetingAutomation.dismissProposedAction(req.params.blockId, req.params.actionId, {
      workspaceId: req.workspaceId,
    });
    broadcast("blocks-changed", { action: "meeting-action-dismissed", blockIds: [req.params.blockId, req.params.actionId] }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post("/api/meetings/:blockId/actions/:actionId/schedule", async (req, res) => {
  try {
    const result = await meetingAutomation.placeProposedAction(req.params.blockId, req.params.actionId, {
      workspaceId: req.workspaceId,
      userId: req.session && req.session.userId,
      date: req.body && req.body.date,
      start: req.body && req.body.start,
    });
    broadcast("blocks-changed", { action: "meeting-action-scheduled", blockIds: [req.params.blockId, result.actionBlockId].filter(Boolean) }, req.workspaceId);
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
