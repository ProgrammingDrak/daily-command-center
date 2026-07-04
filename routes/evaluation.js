// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, isValidDate, pool } = ctx;

// ── Evaluation API (task scoring engine) ──
app.use(require("../evaluation/routes")(blockDB));


// ── Migration (legacy) ──
app.post("/api/migrate", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.post("/api/migrate/dry-run", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.get("/api/migrate/status", async (req, res) => { try { const { rows: [bc] } = await pool.query("SELECT COUNT(*) as count FROM blocks WHERE deleted_at IS NULL"); const { rows: [dc] } = await pool.query("SELECT COUNT(*) as count FROM dcc_state"); res.json({ migrated: parseInt(bc.count) > 1, blockCount: parseInt(bc.count), dccStateCount: parseInt(dc.count) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/operations", async (req, res) => { if (!req.query.block_id) return res.status(400).json({ error: "block_id required" }); res.json(await blockDB.getOperations(req.query.block_id, parseInt(req.query.limit) || 50)); });

};
