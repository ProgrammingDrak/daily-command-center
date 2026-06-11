// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, isValidDate, pool } = ctx;

// ── Evaluation API (task scoring engine) ──
app.use(require("../evaluation/routes")(blockDB));

// ── PA State API ──
app.get("/api/pa-state/range", async (req, res) => { try { const { start, end } = req.query; if (!start || !end || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: "Provide ?start=&end=" }); const states = await blockDB.getPaStateRange(start, end, req.workspaceId); const result = {}; for (const s of states) result[s.date] = s.state_json; res.json(result); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/pa-state/:date", async (req, res) => { if (!isValidDate(req.params.date)) return res.status(400).json({ error: "Invalid date" }); const state = await blockDB.getPaState(req.params.date, req.workspaceId); res.json(state || { date: req.params.date, state_json: null }); });
app.post("/api/pa-state/ingest", async (req, res) => { try { const { date, ...stateData } = req.body; if (!date || !isValidDate(date)) return res.status(400).json({ error: "Valid date required" }); let userId = req.session.userId || null, workspaceId = req.workspaceId || null; if (!userId) { workspaceId = req.headers["x-workspace-id"] || "ws-1"; const { rows } = await pool.query("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1", [workspaceId]); userId = rows[0] ? rows[0].user_id : 1; } await blockDB.savePaState(date, stateData, userId, workspaceId); broadcast("pa-state-changed", { date }); res.json({ ok: true, date }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ── Migration (legacy) ──
app.post("/api/migrate", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.post("/api/migrate/dry-run", async (req, res) => { res.json({ ok: true, message: "Data is now in Postgres." }); });
app.get("/api/migrate/status", async (req, res) => { try { const { rows: [bc] } = await pool.query("SELECT COUNT(*) as count FROM blocks WHERE deleted_at IS NULL"); const { rows: [dc] } = await pool.query("SELECT COUNT(*) as count FROM dcc_state"); res.json({ migrated: parseInt(bc.count) > 1, blockCount: parseInt(bc.count), dccStateCount: parseInt(dc.count) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/operations", async (req, res) => { if (!req.query.block_id) return res.status(400).json({ error: "block_id required" }); res.json(await blockDB.getOperations(req.query.block_id, parseInt(req.query.limit) || 50)); });

};
