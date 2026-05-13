const express = require("express");
const { scoreEvaluation } = require("./scoring");
const settingsStore = require("./settings-store");

module.exports = function evaluationRoutes(blockDB) {
  const router = express.Router();

  router.get("/api/evaluation/settings", async (req, res) => {
    try {
      res.json(await settingsStore.getSettings(blockDB, req.workspaceId));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch("/api/evaluation/settings", async (req, res) => {
    try {
      const block = await settingsStore.saveSettings(blockDB, req.workspaceId, req.session.userId, req.body || {});
      res.json(block.properties.settings);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/evaluation/settings", async (req, res) => {
    try {
      res.json(await settingsStore.deleteSettings(blockDB, req.workspaceId));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/evaluation/score", async (req, res) => {
    try {
      const settings = await settingsStore.getSettings(blockDB, req.workspaceId);
      res.json(scoreEvaluation(req.body || {}, settings));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};
