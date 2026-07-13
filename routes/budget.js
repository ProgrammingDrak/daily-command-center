// Budget Tank API — extracted-route style (see routes/slots.js).
// All mutations broadcast "slot-changed" with a budget-* action: the tank and
// the slot machine feed the same economy, so one SSE channel refreshes both.
//
// Handlers use the shared route() wrapper (lib/route-helpers) instead of a
// per-handler try/catch, and resolveOwnerStrict wherever an owner userId is
// actually consumed (state/config/create/claim/rollover/convert). The pure
// by-id / workspace-scoped mutations (block update/delete/reorder) keep
// req.workspaceId — they resolve no owner. Error-shape note: route() defaults an
// unclassified throw to 500 (the old catch defaulted to 400); explicit
// client-error paths are unchanged. P2 atomicity is untouched: rollover still
// creates the transfer task inside the store's tx via onSwept, and claim's
// enqueue stays best-effort OUTSIDE the tx (idempotent, self-heals on retry).

const { route } = require("../lib/route-helpers");
const { resolveOwnerStrict } = require("../middleware/resolve-owner");

module.exports = function mount(app, ctx) {
  const { broadcast, budgetStore, slotStore, socialStore, blockDB, crypto, getTodayStr } = ctx;

  app.get("/api/budget/state", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    return budgetStore.getBudgetState(workspaceId, userId);
  }));

  app.put("/api/budget/config", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const settings = await budgetStore.updateBudgetConfig(workspaceId, userId, req.body || {});
    broadcast("slot-changed", { action: "budget-config" }, workspaceId);
    return { settings };
  }));

  app.post("/api/budget/blocks", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const block = await budgetStore.addTankBlock(workspaceId, userId, req.body || {});
    broadcast("slot-changed", { action: "budget-block" }, workspaceId);
    return { block };
  }));

  app.put("/api/budget/blocks/:id", route(async (req) => {
    const block = await budgetStore.updateTankBlock(req.workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "budget-block" }, req.workspaceId);
    return { block };
  }));

  app.delete("/api/budget/blocks/:id", route(async (req) => {
    const result = await budgetStore.removeTankBlock(req.workspaceId, req.params.id, {
      keepReward: req.query.keep_reward === "1" || req.query.keep_reward === "true",
    });
    broadcast("slot-changed", { action: "budget-block" }, req.workspaceId);
    return result;
  }));

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
  app.post("/api/budget/blocks/:id/claim", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await budgetStore.claimTankBlock(workspaceId, userId, req.params.id, {
      sweepPendingBankBuilders: slotStore.sweepPendingBankBuildersInTx,
    });
    const b = result.block;
    let rewardQueueItem = null;
    try {
      const enq = await socialStore.enqueueReward({
        ownerUserId: userId,
        workspaceId: workspaceId,
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
    broadcast("slot-changed", { action: "budget-claim" }, workspaceId);
    return { claimed: result.claimed, duplicate: !!result.duplicate, debited_cents: result.debited_cents || 0, reward_queue_item: rewardQueueItem };
  }));

  // Period rollover: sweep the leftover to the investments ledger, drop a real
  // "Transfer $X to brokerage" task on today's itinerary, and rebuild the tank
  // for the new period (carry = unhit blocks sink to the bottom; fresh = they
  // return to the reward catalog only).
  app.post("/api/budget/rollover", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    // The transfer task is created INSIDE the store's rollover tx (onSwept),
    // so a failure there rolls the sweep back instead of stranding swept money
    // with no task. The route stays thin: hand over the callback, broadcast the
    // committed result, respond.
    const today = getTodayStr();
    const result = await budgetStore.rolloverPeriod(workspaceId, userId, {
      ...(req.body || {}),
      onSwept: async (client, { swept_cents, closing_period }) => {
        const rootId = await blockDB.ensureDayRoot(today, userId, workspaceId, client);
        const block = await blockDB.createBlock({
          id: "budget-sweep-" + workspaceId + "-" + closing_period + "-" + crypto.randomUUID().slice(0, 8),
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
          user_id: userId,
          workspace_id: workspaceId,
        }, client);
        await budgetStore.setInvestmentTaskBlock(workspaceId, closing_period, block.id, client);
        return { id: block.id, date: today };
      },
    });
    if (result.task) {
      result.task_block_id = result.task.id;
      broadcast("blocks-changed", { action: "create", id: result.task.id, date: result.task.date }, workspaceId);
    }
    broadcast("slot-changed", { action: "budget-rollover" }, workspaceId);
    return result;
  }));

  // Money Changer: points -> bank at the configured rate. Client sends a
  // per-attempt source_key (reused on retry) — the ledger index dedupes.
  app.post("/api/budget/convert", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await budgetStore.convertPointsToBank(workspaceId, userId, req.body || {});
    broadcast("slot-changed", { action: "budget-convert" }, workspaceId);
    return result;
  }));

  app.post("/api/budget/blocks/reorder", route(async (req) => {
    const result = await budgetStore.reorderTank(req.workspaceId, (req.body || {}).items);
    broadcast("slot-changed", { action: "budget-reorder" }, req.workspaceId);
    return result;
  }));
};
