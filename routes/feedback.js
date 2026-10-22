// Feedback stays in the existing table; only the existing site-admin session can read it.
module.exports = function mountFeedback(app, { pool, requireAdmin, ensureFeedbackTable }) {
  app.post("/api/feedback", async (req, res) => {
    try {
      const message = String(req.body?.message || "").trim();
      const pagePath = String(req.body?.pagePath || req.body?.path || "").slice(0, 500);
      if (!message) return res.status(400).json({ error: "Feedback message is required" });
      if (message.length > 4000) return res.status(400).json({ error: "Feedback message is too long" });
      await ensureFeedbackTable();
      const { rows } = await pool.query(
        `INSERT INTO feedback_messages (workspace_id, user_id, message, page_path, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, workspace_id, user_id, message, page_path, created_at`,
        [req.workspaceId || null, req.session.userId || null, message, pagePath || null, String(req.headers["user-agent"] || "").slice(0, 500) || null]
      );
      res.status(201).json({ ok: true, feedback: rows[0] });
    } catch (err) {
      console.error("[feedback] Submission failed:", err.message);
      res.status(500).json({ error: "Could not save feedback. Please try again." });
    }
  });

  app.get("/api/admin/feedback", requireAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    let beforeTime = null;
    let beforeId = null;
    if (req.query.before) {
      const parts = String(req.query.before).split("|");
      if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parts[0]) ||
          !Number.isFinite(Date.parse(parts[0])) || !/^[1-9]\d*$/.test(parts[1]) || Number(parts[1]) > 2147483647) {
        return res.status(400).json({ error: "Invalid feedback cursor" });
      }
      [beforeTime, beforeId] = parts;
    }
    try {
      await ensureFeedbackTable();
      const [page, summary] = await Promise.all([
        pool.query(`SELECT f.id, f.workspace_id, f.user_id, f.message, f.page_path, f.created_at, f.resolved_at,
            u.username, u.display_name,
            to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
          FROM feedback_messages f LEFT JOIN users u ON u.id = f.user_id
          WHERE ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::integer))
          ORDER BY f.created_at DESC, f.id DESC LIMIT $1`, [limit + 1, beforeTime, beforeId]),
        pool.query("SELECT COUNT(*)::integer AS total, MAX(created_at) AS latest_at FROM feedback_messages"),
      ]);
      const items = page.rows.slice(0, limit);
      const last = items[items.length - 1];
      res.json({
        feedback: items.map(({ cursor_time: _cursor, ...item }) => item),
        nextCursor: page.rows.length > limit && last ? `${last.cursor_time}|${last.id}` : null,
        summary: { total: summary.rows[0]?.total || 0, latestFeedbackAt: summary.rows[0]?.latest_at || null },
      });
    } catch (err) {
      console.error("[feedback] Inbox read failed:", err.message);
      res.status(500).json({ error: "Could not load feedback. Please try again." });
    }
  });
};
