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
  const { broadcast, budgetStore, rewardVaultStore, slotStore, socialStore, blockDB, crypto, getTodayStr } = ctx;

  async function enqueueResolvedReward({ userId, workspaceId, reward, sourceType, sourceId }) {
    if (!reward) return null;
    const enqueued = await socialStore.enqueueReward({
      ownerUserId: userId,
      workspaceId,
      rewardDefinitionId: reward.id || null,
      titleSnapshot: reward.title || "Reward",
      sourceType,
      sourceId,
      sponsorUserId: null,
      valueSnapshot: reward.value_cents || 0,
      chanceSharesSnapshot: reward.chance_shares || reward.weight || null,
      tierSnapshot: reward.tier_id || null,
      durationMinutesSnapshot: reward.duration_minutes ?? null,
    });
    return enqueued && enqueued.item || null;
  }

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

  // Money Changer: one point -> one canonical Bank Unit. Client sends a
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

  // Reward Vault: one catalog shared by quick-add, checkpoints, wheels, and the
  // casino. Definitions remain separate from the tank instances they create.
  app.get("/api/budget/vault", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const state = await rewardVaultStore.listVault(workspaceId, userId);
    const earned = await socialStore.earnMilestoneSponsorships(userId, state.milestones && state.milestones.progress.total || 0);
    if (earned.length) broadcast("slot-changed", { action: "sponsorship-earned" }, workspaceId);
    return { ...state, sponsored_milestones_earned: earned.length };
  }));

  app.post("/api/budget/vault", route(async (req, res) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const item = await rewardVaultStore.createVaultItem(workspaceId, userId, req.body || {});
    broadcast("slot-changed", { action: "reward-vault-create" }, workspaceId);
    res.status(201).json({ item });
  }));

  app.put("/api/budget/vault/:id", route(async (req) => {
    const { workspaceId } = await resolveOwnerStrict(req);
    const item = await rewardVaultStore.updateVaultItem(workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "reward-vault-update" }, workspaceId);
    return { item };
  }));

  app.delete("/api/budget/vault/:id", route(async (req) => {
    const { workspaceId } = await resolveOwnerStrict(req);
    const result = await rewardVaultStore.archiveVaultItem(workspaceId, req.params.id);
    broadcast("slot-changed", { action: "reward-vault-archive" }, workspaceId);
    return result;
  }));

  app.post("/api/budget/vault/:id/quick-add", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await rewardVaultStore.quickAdd(workspaceId, userId, req.params.id);
    broadcast("slot-changed", { action: "reward-vault-quick-add" }, workspaceId);
    return result;
  }));

  app.post("/api/budget/milestones", route(async (req, res) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const milestone = await rewardVaultStore.createMilestone(workspaceId, userId, req.body || {});
    broadcast("slot-changed", { action: "reward-milestone-create" }, workspaceId);
    res.status(201).json({ milestone });
  }));

  app.put("/api/budget/milestones/:id", route(async (req) => {
    const { workspaceId } = await resolveOwnerStrict(req);
    const milestone = await rewardVaultStore.updateMilestone(workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "reward-milestone-update" }, workspaceId);
    return { milestone };
  }));

  app.delete("/api/budget/milestones/:id", route(async (req) => {
    const { workspaceId } = await resolveOwnerStrict(req);
    const result = await rewardVaultStore.deleteMilestone(workspaceId, req.params.id);
    broadcast("slot-changed", { action: "reward-milestone-delete" }, workspaceId);
    return result;
  }));

  app.post("/api/budget/milestones/:id/resolve", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await rewardVaultStore.resolveMilestone(workspaceId, userId, req.params.id, req.body || {});
    const queueItem = await enqueueResolvedReward({
      userId, workspaceId, reward: result.reward, sourceType: "self_care",
      sourceId: "self-care-" + result.period_key + "-" + req.params.id,
    });
    broadcast("slot-changed", { action: "reward-milestone-resolve" }, workspaceId);
    return { ...result, reward_queue_item: queueItem };
  }));

  app.post("/api/budget/overflow/spin", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = await rewardVaultStore.overflowSpin(workspaceId, userId, {
      ...(req.body || {}), sweepPendingBankBuilders: slotStore.sweepPendingBankBuildersInTx,
    });
    let queueItem = null;
    if (result.spin) {
      const reward = result.reward || { id: result.spin.reward_definition_id, title: result.spin.title, value_cents: result.spin.amount_cents };
      queueItem = await enqueueResolvedReward({
        userId, workspaceId, reward, sourceType: "overflow_wheel",
        sourceId: "overflow-" + result.spin.id,
      });
    }
    broadcast("slot-changed", { action: "budget-overflow-spin" }, workspaceId);
    return { ...result, reward_queue_item: queueItem };
  }));

  app.get("/api/budget/sponsor-link", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const link = await rewardVaultStore.getSponsorLink(workspaceId, userId);
    return { link };
  }));

  app.post("/api/budget/sponsor-link/rotate", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const link = await rewardVaultStore.rotateSponsorLink(workspaceId, userId);
    return { link, url: req.protocol + "://" + req.get("host") + "/sponsor/" + link.token };
  }));

  app.delete("/api/budget/sponsor-link", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    return rewardVaultStore.revokeSponsorLink(workspaceId, userId);
  }));

  // Signed-in friends see sponsor-visible cards only.
  app.get("/api/social/users/:ownerUserId/reward-vault", route(async (req) => {
    const ownerUserId = Number.parseInt(req.params.ownerUserId, 10);
    if (!await socialStore.areFriends(req.session.userId, ownerUserId)) {
      const err = new Error("Friendship required"); err.statusCode = 403; throw err;
    }
    const workspaceId = await socialStore.resolveWorkspaceId(ownerUserId);
    return rewardVaultStore.listVault(workspaceId, ownerUserId, { sponsorView: true });
  }));

  app.get("/api/public/sponsor/:token", route(async (req) => {
    const link = await rewardVaultStore.resolveSponsorToken(req.params.token);
    return rewardVaultStore.listVault(link.workspace_id, link.owner_user_id, { sponsorView: true });
  }));

  app.post("/api/public/sponsor/:token/offers", route(async (req, res) => {
    const link = await rewardVaultStore.resolveSponsorToken(req.params.token);
    const body = req.body || {};
    if (!String(body.sponsorName || "").trim()) {
      const err = new Error("sponsorName required"); err.statusCode = 400; throw err;
    }
    const routes = Array.isArray(body.routes) ? body.routes : [];
    if (!routes.length) {
      const err = new Error("Choose at least one earning route"); err.statusCode = 400; throw err;
    }
    const first = routes[0] || {};
    const result = await socialStore.requestSponsorship({
      ownerUserId: link.owner_user_id,
      sponsorUserId: null,
      sponsorName: String(body.sponsorName).trim().slice(0, 120),
      targetType: first.type === "casino" ? "slot_machine" : "task",
      targetId: first.targetId || (first.thresholdBankUnits ? "bank-units:" + first.thresholdBankUnits : "guest-offer"),
      rewardDefinitionId: body.rewardDefinitionId || null,
      rewardTitle: body.rewardTitle,
      valueCents: body.valueCents || 0,
      chanceShares: body.chanceShares || 1,
      note: body.note || "",
      workspaceId: link.workspace_id,
      routes,
    });
    res.status(201).json(result);
  }));
};
