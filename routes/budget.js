// Budget Tank API — extracted-route style (see routes/slots.js).
// All mutations broadcast "slot-changed" with a budget-* action: the tank and
// the slot machine feed the same economy, so one SSE channel refreshes both.

module.exports = function mount(app, ctx) {
  const { broadcast, budgetStore } = ctx;

  app.get("/api/budget/state", async (req, res) => {
    try {
      res.json(await budgetStore.getBudgetState(req.workspaceId, req.session.userId));
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.put("/api/budget/config", async (req, res) => {
    try {
      const settings = await budgetStore.updateBudgetConfig(req.workspaceId, req.session.userId, req.body || {});
      broadcast("slot-changed", { action: "budget-config" }, req.workspaceId);
      res.json({ settings });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  app.post("/api/budget/blocks", async (req, res) => {
    try {
      const block = await budgetStore.addTankBlock(req.workspaceId, req.session.userId, req.body || {});
      broadcast("slot-changed", { action: "budget-block" }, req.workspaceId);
      res.json({ block });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  app.put("/api/budget/blocks/:id", async (req, res) => {
    try {
      const block = await budgetStore.updateTankBlock(req.workspaceId, req.params.id, req.body || {});
      broadcast("slot-changed", { action: "budget-block" }, req.workspaceId);
      res.json({ block });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  app.delete("/api/budget/blocks/:id", async (req, res) => {
    try {
      const result = await budgetStore.removeTankBlock(req.workspaceId, req.params.id, {
        keepReward: req.query.keep_reward === "1" || req.query.keep_reward === "true",
      });
      broadcast("slot-changed", { action: "budget-block" }, req.workspaceId);
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  app.post("/api/budget/blocks/reorder", async (req, res) => {
    try {
      const result = await budgetStore.reorderTank(req.workspaceId, (req.body || {}).items);
      broadcast("slot-changed", { action: "budget-reorder" }, req.workspaceId);
      res.json(result);
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });
};
