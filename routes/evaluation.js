// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, isValidDate, pool } = ctx;

// ── Evaluation API (task scoring engine) ──
app.use(require("../evaluation/routes")(blockDB));


// ── Migration (legacy) ──
app.get("/api/operations", async (req, res) => { if (!req.query.block_id) return res.status(400).json({ error: "block_id required" }); res.json(await blockDB.getOperations(req.query.block_id, parseInt(req.query.limit) || 50)); });

};
