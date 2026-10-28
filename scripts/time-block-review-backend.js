// Opt-in synthetic PostgreSQL fixture only. Never mounted by production.
module.exports = async function mount(app) {
  if (process.env.DCC_TIME_BLOCK_REVIEW !== "1" || !process.env.DCC_TEST_DATABASE_URL) throw new Error("Disposable local test database required");
  const f = await require("../test-support/time-block-fixture").fixture(app);
  await f.config([{ id: "focus", name: "Focus & planning" }, { id: "afternoon", name: "Creative work", start: "14:00", end: "16:00" }]);
  await f.block("browser-move", { title: "Synthetic move task", duration: 30 });
  await f.block("browser-existing", { title: "Existing work", start: "09:00", end: "10:00", duration: 60 });
  app.get("/api/state/day", async (req, res) => { const date = req.query.date || f.date; const blocks = await f.choices(); res.json({ date, schedule: { timeline: [], timeBlocks: blocks, blocks }, triage: { open_items: [] }, completions: { tasks: [] } }); });
  app.post("/api/time-block-review/config", async (req, res) => { await f.config(req.body.blocks || []); res.json({ ok: true }); });
  app.get("/api/time-block-review/info", (_req, res) => res.json({ date: f.date, taskId: "browser-move" }));
  process.on("SIGTERM", async () => { await f.close(); process.exit(0); });
};
