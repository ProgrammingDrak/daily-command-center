// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { broadcast, requireAdmin, slotStore, socialStore } = ctx;

// ── Slot Rewards API ──
app.get("/api/slot/state", async (req, res) => {
  try {
    res.json(await slotStore.getState(req.workspaceId, req.session.userId));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.put("/api/slot/settings", async (req, res) => {
  try {
    const account = await slotStore.updateSettings(req.workspaceId, req.session.userId, req.body || {});
    broadcast("slot-changed", { action: "settings-update" }, req.workspaceId);
    res.json(account);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.put("/api/slot/bankroll-goal", async (req, res) => {
  try {
    const state = await slotStore.setBankrollGoal(req.workspaceId, req.session.userId, req.body || {});
    broadcast("slot-changed", { action: "bankroll-goal-update" }, req.workspaceId);
    res.json(state);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.delete("/api/slot/bankroll-goal", async (req, res) => {
  try {
    const state = await slotStore.clearBankrollGoal(req.workspaceId, req.session.userId);
    broadcast("slot-changed", { action: "bankroll-goal-clear" }, req.workspaceId);
    res.json(state);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/bankroll-goal/celebration-spin", async (req, res) => {
  try {
    const spin = await slotStore.celebrationSpinForBankrollGoal(req.workspaceId, req.session.userId);
    broadcast("slot-changed", { action: "bankroll-goal-celebration" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.put("/api/slot/admin/next-spin-tiles", requireAdmin, async (req, res) => {
  try {
    const result = await slotStore.setNextSpinTileOverride(req.workspaceId, req.session.userId, req.body || {});
    broadcast("slot-changed", { action: "next-spin-tiles-update" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.delete("/api/slot/admin/next-spin-tiles", requireAdmin, async (req, res) => {
  try {
    const result = await slotStore.clearNextSpinTileOverride(req.workspaceId, req.session.userId);
    broadcast("slot-changed", { action: "next-spin-tiles-clear" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/rewards", async (req, res) => {
  try {
    const reward = await slotStore.createReward(req.workspaceId, req.body || {});
    broadcast("slot-changed", { action: "reward-create" }, req.workspaceId);
    res.status(201).json(reward);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/rewards/reorder", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await slotStore.reorderRewards(req.workspaceId, body.items || body.rewards || []);
    broadcast("slot-changed", { action: "reward-reorder" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.put("/api/slot/rewards/:id", async (req, res) => {
  try {
    const reward = await slotStore.updateReward(req.workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "reward-update" }, req.workspaceId);
    res.json(reward);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.delete("/api/slot/rewards/:id", async (req, res) => {
  try {
    const result = await slotStore.deleteReward(req.workspaceId, req.params.id);
    broadcast("slot-changed", { action: "reward-delete" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/earn-task", async (req, res) => {
  try {
    const result = await slotStore.earnTaskCredit(req.workspaceId, req.session.userId, req.body || {});
    if (result.awarded) broadcast("slot-changed", { action: "credit-earned" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spin", async (req, res) => {
  try {
    const spin = await slotStore.spin(req.workspaceId, req.session.userId);
    broadcast("slot-changed", { action: "spin" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spins/:id/dice-reroll", async (req, res) => {
  try {
    const spin = await slotStore.chooseSpinDiceReroll(req.workspaceId, req.params.id, req.body || {}, req.session.userId);
    broadcast("slot-changed", { action: "spin-dice-reroll" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spins/:id/gamble", async (req, res) => {
  try {
    const spin = await slotStore.chooseSpinGamble(req.workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "spin-gamble" }, req.workspaceId);
    res.json(spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/multiplier/combine", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await slotStore.combineMultiplierCharges(req.workspaceId, body.from ?? body.tier);
    broadcast("slot-changed", { action: "multiplier-combine" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/multiplier/activate", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await slotStore.setActiveMultiplier(req.workspaceId, body.tier ?? 0);
    broadcast("slot-changed", { action: "multiplier-activate" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/spins/:id/confirm", async (req, res) => {
  try {
    const spin = await slotStore.confirmSpin(req.workspaceId, req.params.id, req.body || {});
    broadcast("slot-changed", { action: "spin-confirm" }, req.workspaceId);
    // A confirmed, redeemable win flows into the unified reward queue. Bank
    // builders, misses, and dry spins are not rewards, so they never queue.
    // Idempotent on sourceId = spin.id: a double-confirm cannot double-queue.
    let rewardQueueItem = null;
    if (socialStore.isQueueableSpinWin(spin)) {
      const snap = spin.reward_snapshot || {};
      try {
        const enq = await socialStore.enqueueReward({
          ownerUserId: req.session.userId,
          workspaceId: req.workspaceId,
          rewardDefinitionId: spin.reward_id,
          titleSnapshot: snap.title || "Reward",
          sourceType: "slot_spin",
          sourceId: String(spin.id),
          valueSnapshot: snap.value_cents || 0,
          chanceSharesSnapshot: snap.chance_shares || null,
          tierSnapshot: snap.tier_id || null,
          durationMinutesSnapshot: snap.duration_minutes ?? snap.durationMinutes ?? null,
        });
        // Surface the queue item so the win decision screen can act on it
        // (Go do it now / Bank / Schedule) without a follow-up fetch.
        rewardQueueItem = (enq && enq.item) || null;
        broadcast("slot-changed", { action: "reward-queued" }, req.workspaceId);
      } catch (e) { console.warn("[reward-queue] enqueue failed:", e.message); }
    }
    res.json(rewardQueueItem ? { ...spin, reward_queue_item: rewardQueueItem } : spin);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

app.post("/api/slot/bank-builders/confirm", async (req, res) => {
  try {
    const result = await slotStore.confirmPendingBankBuilders(req.workspaceId);
    broadcast("slot-changed", { action: "bank-builders-confirm" }, req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: e.message });
  }
});

};
