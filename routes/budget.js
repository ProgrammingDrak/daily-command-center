// routes/budget.js — Budget Battle Pass: sequential monthly spending tiers.
// Stored as kind-discriminated blocks (type:'block', properties.kind), the
// same pattern routes/blocks.js already uses for responsibility_item,
// task_menu, task_group, and delegated_item — not new VALID_TYPES entries.
// Money amounts are plain dollar numbers (matches the shape Drake specified),
// not cents like the slot-rewards tables.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, pool } = ctx;

  const MONTH_RE = /^\d{4}-\d{2}$/;

  function assertOwnership(block, workspaceId) {
    if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) {
      const err = new Error("Not found");
      err.statusCode = 404;
      throw err;
    }
  }

  async function findPassByMonth(month, workspaceId) {
    const { rows } = await pool.query(
      `SELECT * FROM blocks
       WHERE type='block' AND properties->>'kind'='budget_pass' AND properties->>'month'=$1
         AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL
       LIMIT 1`,
      [month, workspaceId || null]
    );
    return rows[0] ? blockDB.parseBlock(rows[0]) : null;
  }

  async function getPassTiers(passId, workspaceId) {
    return (await blockDB.getChildren(passId, workspaceId)).filter(b => (b.properties || {}).kind === "budget_tier");
  }

  async function getTier(id, workspaceId) {
    const block = await blockDB.getBlock(id);
    if (!block) return null;
    assertOwnership(block, workspaceId);
    if ((block.properties || {}).kind !== "budget_tier") return null;
    return block;
  }

  // "2026-07" -> "2026-06". Handles January rollunder via JS Date normalization.
  function prevMonth(month) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  }

  function tierTotalSpent(tiers) {
    return tiers.reduce((s, t) => s + Number((t.properties || {}).spent || 0), 0);
  }

  // Activates the next queued tier after `afterSortOrder` (sequential unlock).
  async function unlockNextTier(passId, workspaceId, afterSortOrder) {
    const tiers = await getPassTiers(passId, workspaceId);
    const next = tiers
      .filter(t => (t.properties || {}).status === "queued" && t.sort_order > afterSortOrder)
      .sort((a, b) => a.sort_order - b.sort_order)[0];
    if (!next) return null;
    const nowIso = new Date().toISOString();
    return blockDB.updateBlock(next.id, { properties: { ...next.properties, status: "active", unlocked_at: nowIso } });
  }

  async function maybeCompletePass(passId, workspaceId) {
    const tiers = await getPassTiers(passId, workspaceId);
    if (!tiers.length || !tiers.every(t => (t.properties || {}).status === "completed")) return;
    const pass = await blockDB.getBlock(passId);
    if (!pass || pass.properties.status === "complete") return;
    await blockDB.updateBlock(passId, { properties: { ...pass.properties, status: "complete", completed_at: new Date().toISOString() } });
  }

  // ── Pass ──

  app.get("/api/budget/pass", async (req, res) => {
    try {
      const month = String(req.query.month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
      const pass = await findPassByMonth(month, req.workspaceId);
      if (!pass) return res.json({ pass: null, tiers: [] });
      const tiers = await getPassTiers(pass.id, req.workspaceId);
      res.json({ pass, tiers });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  app.post("/api/budget/pass", async (req, res) => {
    try {
      const body = req.body || {};
      const month = String(body.month || "");
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
      const poolAmount = Number(body.pool);
      if (!Number.isFinite(poolAmount) || poolAmount < 0) return res.status(400).json({ error: "pool must be a non-negative number" });
      const tiersIn = Array.isArray(body.tiers) ? body.tiers : [];
      if (!tiersIn.length) return res.status(400).json({ error: "at least one tier required" });

      const workspaceId = req.workspaceId;
      const userId = req.session.userId;
      if (await findPassByMonth(month, workspaceId)) return res.status(409).json({ error: `A pass already exists for ${month}` });

      // Starting a new month's pass implicitly closes the previous one and
      // rolls any total-budget overage into this month's carry_debt (decision #3).
      let carryDebt = 0;
      const prior = await findPassByMonth(prevMonth(month), workspaceId);
      if (prior && prior.properties.status !== "closed") {
        const priorTiers = await getPassTiers(prior.id, workspaceId);
        const effectivePool = Number(prior.properties.pool || 0) - Number(prior.properties.carry_debt || 0);
        carryDebt = Math.max(0, tierTotalSpent(priorTiers) - effectivePool);
        await blockDB.updateBlock(prior.id, { properties: { ...prior.properties, status: "closed", closed_at: new Date().toISOString() } });
      }

      const nowIso = new Date().toISOString();
      const passProps = {
        kind: "budget_pass", month, pool: poolAmount, income_source: body.income_source || "manual",
        carry_debt: carryDebt, status: "active", template_id: body.template_id || null,
        created_at: nowIso, updated_at: nowIso
      };
      const pass = await blockDB.createBlock({ type: "block", properties: passProps, sort_order: 0, user_id: userId, workspace_id: workspaceId });

      const tiers = [];
      for (let i = 0; i < tiersIn.length; i++) {
        const t = tiersIn[i] || {};
        const title = String(t.title || "").trim();
        if (!title) continue;
        const cap = Number(t.cap);
        if (!Number.isFinite(cap) || cap < 0) return res.status(400).json({ error: `tier "${title}" needs a non-negative cap` });
        const tierProps = {
          kind: "budget_tier", title, category: String(t.category || ""), cap, spent: 0,
          status: i === 0 ? "active" : "queued", tags: Array.isArray(t.tags) ? t.tags : [],
          unlocked_at: i === 0 ? nowIso : null, completed_at: null, transactions: []
        };
        tiers.push(await blockDB.createBlock({ type: "block", parent_id: pass.id, properties: tierProps, sort_order: (i + 1) * 1000, user_id: userId, workspace_id: workspaceId }));
      }
      broadcast("blocks-changed", { action: "budget-pass-create", blockIds: [pass.id, ...tiers.map(t => t.id)] }, workspaceId);
      res.json({ pass, tiers });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });

  // ── Tiers ──

  app.patch("/api/budget/tier/:id/spend", async (req, res) => {
    try {
      const tier = await getTier(req.params.id, req.workspaceId);
      if (!tier) return res.status(404).json({ error: "Tier not found" });
      const amount = Math.round(Number((req.body || {}).amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount must be a positive number" });
      if (tier.properties.status !== "active") return res.status(400).json({ error: "Only the active tier can log spending" });

      const nowIso = new Date().toISOString();
      const note = String((req.body || {}).note || "").slice(0, 500);
      const spent = Math.round((Number(tier.properties.spent || 0) + amount) * 100) / 100;
      const transactions = [...(tier.properties.transactions || []), { amount, note, at: nowIso }];
      const completesTier = spent >= tier.properties.cap;
      let props = { ...tier.properties, spent, transactions };
      if (completesTier) props = { ...props, status: "completed", completed_at: nowIso };
      const updated = await blockDB.updateBlock(tier.id, { properties: props });

      // Persist this tier's own completion before checking siblings/pass state,
      // so unlockNextTier/maybeCompletePass see the up-to-date row (not stale data).
      let unlockedNext = null;
      let passCompleted = false;
      if (completesTier) {
        unlockedNext = await unlockNextTier(tier.parent_id, req.workspaceId, tier.sort_order);
        if (!unlockedNext) { await maybeCompletePass(tier.parent_id, req.workspaceId); passCompleted = true; }
      }
      broadcast("blocks-changed", { action: "budget-tier-spend", blockIds: [tier.id] }, req.workspaceId);
      res.json({ tier: updated, unlockedNext, passCompleted });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });

  app.patch("/api/budget/tier/:id/complete", async (req, res) => {
    try {
      const tier = await getTier(req.params.id, req.workspaceId);
      if (!tier) return res.status(404).json({ error: "Tier not found" });
      if (tier.properties.status !== "active") return res.status(400).json({ error: "Only the active tier can be closed" });

      const nowIso = new Date().toISOString();
      const updated = await blockDB.updateBlock(tier.id, { properties: { ...tier.properties, status: "completed", completed_at: nowIso } });
      const unlockedNext = await unlockNextTier(tier.parent_id, req.workspaceId, tier.sort_order);
      let passCompleted = false;
      if (!unlockedNext) { await maybeCompletePass(tier.parent_id, req.workspaceId); passCompleted = true; }
      broadcast("blocks-changed", { action: "budget-tier-complete", blockIds: [tier.id] }, req.workspaceId);
      res.json({ tier: updated, unlockedNext, passCompleted });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });

  // ── Templates ──

  app.get("/api/budget/templates", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM blocks WHERE type='block' AND properties->>'kind'='budget_template'
           AND ($1::text IS NULL OR workspace_id=$1) AND deleted_at IS NULL ORDER BY created_at ASC`,
        [req.workspaceId || null]
      );
      res.json({ items: rows.map(blockDB.parseBlock) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/budget/templates", async (req, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      if (!title) return res.status(400).json({ error: "title required" });
      const tiers = (Array.isArray(body.tiers) ? body.tiers : [])
        .map(t => ({ title: String(t.title || "").trim(), category: String(t.category || ""), cap: Number(t.cap) || 0, tags: Array.isArray(t.tags) ? t.tags : [] }))
        .filter(t => t.title);
      if (!tiers.length) return res.status(400).json({ error: "at least one tier required" });
      const nowIso = new Date().toISOString();
      const created = await blockDB.createBlock({
        type: "block",
        properties: { kind: "budget_template", title, tiers, created_at: nowIso, updated_at: nowIso },
        sort_order: 0, user_id: req.session.userId, workspace_id: req.workspaceId
      });
      broadcast("blocks-changed", { action: "budget-template-create", blockIds: [created.id] }, req.workspaceId);
      res.json(created);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
};
