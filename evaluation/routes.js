/**
 * evaluation/routes.js
 *
 * HTTP surface for the evaluation engine. Mount via:
 *   app.use(require("./evaluation/routes")(blockDB))
 *
 * Endpoints:
 *   GET    /api/evaluation/settings              → merged settings (defaults ⊕ user)
 *   PATCH  /api/evaluation/settings              → deep-merge update; returns merged
 *   DELETE /api/evaluation/settings              → reset to defaults
 *   POST   /api/evaluation/score                 → score an ad-hoc evaluation (no persistence)
 *   POST   /api/blocks/:id/evaluation            → write properties.evaluation on a block
 *   GET    /api/blocks/:id/evaluation            → read it back
 *   GET    /api/blocks/:id/score                 → score the block's stored evaluation
 *   DELETE /api/blocks/:id/evaluation            → strip properties.evaluation from the block
 *
 * Block routes never modify other properties — only properties.evaluation.
 * If the block doesn't exist, has been deleted, or belongs to another
 * workspace, all routes return 404.
 */

const express = require("express");
const { evaluate, ValidationError } = require("./scoring");
const settingsStore = require("./settings-store");

function workspaceMatches(block, workspaceId) {
  if (!block.workspace_id || !workspaceId) return true;
  return block.workspace_id === workspaceId;
}

function handleValidationError(res, e) {
  if (e instanceof ValidationError) {
    return res.status(400).json({ error: e.message, path: e.path });
  }
  return res.status(500).json({ error: e.message });
}

module.exports = function createEvaluationRoutes(blockDB) {
  const router = express.Router();

  // ── Settings ──
  router.get("/api/evaluation/settings", async (req, res) => {
    try {
      const settings = await settingsStore.getSettings(req.workspaceId);
      res.json(settings);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch("/api/evaluation/settings", async (req, res) => {
    try {
      const patch = req.body || {};
      const updated = await settingsStore.updateSettings(
        req.workspaceId,
        req.session && req.session.userId,
        patch
      );
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/evaluation/settings", async (req, res) => {
    try {
      const reset = await settingsStore.resetSettings(req.workspaceId);
      res.json(reset);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Ad-hoc scoring (no persistence) ──
  // Lets the skill evaluate a what-if without touching any block.
  router.post("/api/evaluation/score", async (req, res) => {
    try {
      const settings = await settingsStore.getSettings(req.workspaceId);
      const score = evaluate(req.body || {}, settings);
      res.json(score);
    } catch (e) {
      handleValidationError(res, e);
    }
  });

  // ── Per-block evaluation ──
  router.post("/api/blocks/:id/evaluation", async (req, res) => {
    try {
      const existing = await blockDB.getBlock(req.params.id);
      if (!existing || !workspaceMatches(existing, req.workspaceId)) {
        return res.status(404).json({ error: "Block not found" });
      }
      const settings = await settingsStore.getSettings(req.workspaceId);
      // Validate before writing — a bad evaluation should never persist.
      evaluate(req.body || {}, settings);

      const stamped = {
        ...(req.body || {}),
        evaluated_at: new Date().toISOString(),
        evaluated_by:
          (req.session && req.session.userId) || req.body.evaluated_by || null,
      };
      const merged = { ...(existing.properties || {}), evaluation: stamped };
      const result = await blockDB.updateBlock(req.params.id, { properties: merged });
      res.json({ block: result, evaluation: stamped });
    } catch (e) {
      handleValidationError(res, e);
    }
  });

  router.get("/api/blocks/:id/evaluation", async (req, res) => {
    try {
      const block = await blockDB.getBlock(req.params.id);
      if (!block || !workspaceMatches(block, req.workspaceId)) {
        return res.status(404).json({ error: "Block not found" });
      }
      const evaluation = (block.properties || {}).evaluation || null;
      res.json({ evaluation });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/api/blocks/:id/score", async (req, res) => {
    try {
      const block = await blockDB.getBlock(req.params.id);
      if (!block || !workspaceMatches(block, req.workspaceId)) {
        return res.status(404).json({ error: "Block not found" });
      }
      const evaluation = (block.properties || {}).evaluation;
      if (!evaluation) {
        return res
          .status(404)
          .json({ error: "Block has no evaluation yet", evaluated: false });
      }
      const settings = await settingsStore.getSettings(req.workspaceId);
      const score = evaluate(evaluation, settings);
      res.json({ evaluated: true, score, evaluated_at: evaluation.evaluated_at });
    } catch (e) {
      handleValidationError(res, e);
    }
  });

  router.delete("/api/blocks/:id/evaluation", async (req, res) => {
    try {
      const existing = await blockDB.getBlock(req.params.id);
      if (!existing || !workspaceMatches(existing, req.workspaceId)) {
        return res.status(404).json({ error: "Block not found" });
      }
      const { evaluation: _drop, ...rest } = existing.properties || {};
      const result = await blockDB.updateBlock(req.params.id, { properties: rest });
      res.json({ block: result, evaluation: null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
