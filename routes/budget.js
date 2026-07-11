// Budget Tank API — extracted-route style (see routes/slots.js).
// All mutations broadcast "slot-changed" with a budget-* action: the tank and
// the slot machine feed the same economy, so one SSE channel refreshes both.

module.exports = function mount(app, ctx) {
  const { broadcast, budgetStore, slotStore, socialStore, blockDB, crypto, getTodayStr } = ctx;

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
  //
  // ATOMICITY (P2, deliberate): the money move (bank debit + tank_claimed_period
  // stamp) is committed atomically inside claimTankBlock's tx. The enqueue is
  // intentionally left best-effort OUTSIDE that tx and NOT rolled in, because:
  //   1. enqueueReward is socialStore's (a separate store/tx boundary); pulling
  //      it into budget-store's client would couple the two stores for no gain.
  //   2. The sourceId ("tank-<period>-<blockId>") is idempotent, and this handler
  //      re-runs enqueueReward on the duplicate path too (claimTankBlock returns
  //      duplicate:true but still yields result.block). So a claim whose enqueue
  //      failed self-heals on the next claim POST — the missing queue item is
  //      created, never double-created. Best-effort is safe here; a debit can
  //      never be stranded, only its (recoverable) queue item can lag.
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
        // Debit is already committed; a re-claim will re-enqueue idempotently (see above).
        console.warn("[budget-claim] enqueue failed (recoverable on retry):", e.message);
      }
      broadcast("slot-changed", { action: "budget-claim" }, req.workspaceId);
      res.json({ claimed: result.claimed, duplicate: !!result.duplicate, debited_cents: result.debited_cents || 0, reward_queue_item: rewardQueueItem });
    } catch (e) {
      res.status(e.statusCode || 400).json({ error: e.message });
    }
  });

  // Period rollover: sweep the leftover to the investments ledger, drop a real
  // "Transfer $X to brokerage" task on today's itinerary, and rebuild the tank
  // for the new period (carry = unhit blocks sink to the bottom; fresh = they
  // return to the reward catalog only).
  app.post("/api/budget/rollover", async (req, res) => {
    try {
      // The transfer task is created INSIDE the store's rollover tx (onSwept),
      // so a failure there rolls the sweep back instead of stranding swept money
      // with no task. The route stays thin: hand over the callback, broadcast the
      // committed result, respond.
      const today = getTodayStr();
      const result = await budgetStore.rolloverPeriod(req.workspaceId, req.session.userId, {
        ...(req.body || {}),
        onSwept: async (client, { swept_cents, closing_period }) => {
          const rootId = await blockDB.ensureDayRoot(today, req.session.userId, req.workspaceId, client);
          const block = await blockDB.createBlock({
            id: "budget-sweep-" + req.workspaceId + "-" + closing_period + "-" + crypto.randomUUID().slice(0, 8),
            type: "block",
            parent_id: rootId,
            date: today,
            properties: {
              title: "Transfer $" + (swept_cents / 100).toFixed(2) + " to brokerage (budget sweep " + closing_period + ")",
              type: "task",
              durMin: 15,
              priority: "High",
              source: "budget_sweep",
            },
            sort_order: Date.now(),
            user_id: req.session.userId,
            workspace_id: req.workspaceId,
          }, client);
          await budgetStore.setInvestmentTaskBlock(req.workspaceId, closing_period, block.id, client);
          return { id: block.id, date: today };
        },
      });
      if (result.task) {
        result.task_block_id = result.task.id;
        broadcast("blocks-changed", { action: "create", id: result.task.id, date: result.task.date }, req.workspaceId);
      }
      broadcast("slot-changed", { action: "budget-rollover" }, req.workspaceId);
      res.json(result);
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
