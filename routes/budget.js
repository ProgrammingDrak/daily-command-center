// Budget Tank API — extracted-route style (see routes/slots.js).
// All mutations broadcast "slot-changed" with a budget-* action: the tank and
// the slot machine feed the same economy, so one SSE channel refreshes both.

module.exports = function mount(app, ctx) {
  const { broadcast, budgetStore, slotStore, socialStore } = ctx;

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

  // Claim an unlocked block: debit the reserve, stamp the period, then drop it
  // into the reward queue exactly like a slot win (same enqueue, same
  // scheduling path). The enqueue sourceId is period-scoped so double claims
  // return the existing queue item instead of a copy.
  app.post("/api/budget/blocks/:id/claim", async (req, res) => {
    try {
      const result = await budgetStore.claimTankBlock(req.workspaceId, req.session.userId, req.params.id, {
        sweepPendingBankBuilders: slotStore.sweepPendingBankBuildersInTx,
      });
      const b = result.block;
      let rewardQueueItem = null;
      try {
        const enq = await socialStore.enqueueReward({
          ownerUserId: req.session.userId,
          workspaceId: req.workspaceId,
          rewardDefinitionId: b.id,
          titleSnapshot: b.title || "Budget Tank block",
          sourceType: "budget_tank",
          sourceId: "tank-" + result.period_key + "-" + b.id,
          sponsorUserId: null,
          valueSnapshot: b.value_cents || 0,
          chanceSharesSnapshot: b.chance_shares || null,
          tierSnapshot: b.tier_id || null,
          durationMinutesSnapshot: b.duration_minutes ?? null,
        });
        rewardQueueItem = (enq && enq.item) || null;
      } catch (e) {
        console.warn("[budget-claim] enqueue failed:", e.message);
      }
      broadcast("slot-changed", { action: "budget-claim" }, req.workspaceId);
      res.json({ claimed: result.claimed, duplicate: !!result.duplicate, debited_cents: result.debited_cents || 0, reward_queue_item: rewardQueueItem });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  // Money Changer: points -> bank at the configured rate. Client sends a
  // per-attempt source_key (reused on retry) — the ledger index dedupes.
  app.post("/api/budget/convert", async (req, res) => {
    try {
      const result = await budgetStore.convertPointsToBank(req.workspaceId, req.session.userId, req.body || {});
      broadcast("slot-changed", { action: "budget-convert" }, req.workspaceId);
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
