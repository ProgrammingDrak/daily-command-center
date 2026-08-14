"use strict";

const express = require("express");
const audioStore = require("../meeting-audio-store");

module.exports = function mount(app, ctx) {
  const { blockDB } = ctx;
  const rawAudio = express.raw({ type: ["audio/mp4", "audio/x-m4a", "application/octet-stream"], limit: "100mb" });

  app.put("/api/dcc/meeting-audio/:slug", rawAudio, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Audio body is required" });
      const expiresAt = String(req.get("X-Audio-Expires-At") || "").trim() || null;
      const hotAudio = await audioStore.putHotAudio(req.params.slug, req.body, { expiresAt });
      res.json({ ok: true, hot_audio: hotAudio });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/api/dcc/meeting-audio/:slug", async (req, res) => {
    try {
      const ref = { key: audioStore.keyFor(req.params.slug) };
      res.redirect(302, await audioStore.presignHotAudio(ref));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.delete("/api/dcc/meeting-audio/:slug", async (req, res) => {
    try {
      const ref = { key: audioStore.keyFor(req.params.slug) };
      await audioStore.deleteHotAudio(ref);
      res.json({ ok: true });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/meetings/:blockId/audio", async (req, res) => {
    try {
      const block = await blockDB.getBlock(req.params.blockId);
      if (!block || !req.workspaceId || String(block.workspace_id) !== String(req.workspaceId)) {
        return res.status(404).type("text/plain").send("Meeting audio unavailable");
      }
      const artifact = block && block.properties && block.properties.recording_artifact;
      const hotAudio = artifact && artifact.hot_audio;
      if (!hotAudio || artifact.status === "compacted") return res.status(404).type("text/plain").send("Full meeting audio is no longer retained here.");
      if (hotAudio.expires_at && Date.parse(hotAudio.expires_at) <= Date.now()) {
        return res.status(410).type("text/plain").send("The full-audio holding period has ended.");
      }
      res.redirect(302, await audioStore.presignHotAudio(hotAudio));
    } catch (error) {
      res.status(error.statusCode || 500).type("text/plain").send(error.message || "Meeting audio unavailable");
    }
  });
};
