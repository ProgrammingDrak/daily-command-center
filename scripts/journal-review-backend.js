// Opt-in disposable backend for ui-review-server.mjs (DCC_JOURNAL_REVIEW=1).
// Production block + journal routes and the production account-binding middleware
// run against an in-memory PGlite database seeded with synthetic users only.
// Never imported by server.js.
//
// Sessions are a cookie naming one of the synthetic users, standing in for the
// production express-session cookie. Everything after req.session is the real
// stack, including /public/js/app-config.js's DCC_ACCOUNT_CONTEXT, which pins a
// tab to the account that loaded it.
module.exports = async function mountJournalReview(app) {
  if (process.env.DCC_JOURNAL_REVIEW !== "1" || !process.env.DCC_PGLITE_MODULE) throw new Error("Journal review requires DCC_JOURNAL_REVIEW=1 and an in-memory PGlite database");
  const { createActivityDb } = require("../test-support/activity-db");
  const ctx = await createActivityDb();
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  Object.assign(ctx, { APP_TIME_ZONE: "UTC", getTodayStr: () => date, getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: rows => rows, isValidDate: d => /^\d{4}-\d{2}-\d{2}$/.test(d), broadcast() {} });
  const USERS = { 1: "ws-1", 2: "ws-2", 3: "ws-1" };
  const faults = { journalPut: null, journalGet: null };

  app.use((req, _res, next) => {
    const m = /(?:^|;\s*)dcc_review_user=(\d+)/.exec(req.headers.cookie || "");
    const user = m && USERS[m[1]] ? Number(m[1]) : null;
    if (user) { req.session = { userId: user }; req.workspaceId = USERS[user]; }
    next();
  });
  // Same template as server.js /public/js/app-config.js.
  app.get("/public/js/app-config.js", (req, res) => {
    res.type("application/javascript").setHeader("Cache-Control", "no-store");
    res.send(`window.DCC_APP_TIME_ZONE="UTC";window.DCC_DELTA_SYNC_ENABLED=true;window.DCC_ACCOUNT_CONTEXT=${JSON.stringify(req.session?.userId && req.workspaceId ? { userId: Number(req.session.userId), workspaceId: req.workspaceId } : null)};`);
  });
  app.post("/api/review/journal/session", (req, res) => {
    const user = Number(req.body?.user);
    if (user && !USERS[user]) return res.status(400).json({ error: "unknown synthetic user" });
    // 30-day persistent cookie, like server.js's session cookie, so a browser
    // restart keeps the sign-in exactly as production does.
    res.setHeader("Set-Cookie", user ? `dcc_review_user=${user}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax` : "dcc_review_user=; Path=/; Max-Age=0");
    res.json({ ok: true, user: user || null });
  });
  // Fault injection for the browser check (500/401/slow responses), applied
  // in front of the real journal routes.
  app.post("/api/review/journal/faults", (req, res) => { Object.assign(faults, req.body || {}); res.json(faults); });
  app.use("/api/journal", async (req, res, next) => {
    const f = req.method === "PUT" ? faults.journalPut : req.method === "GET" ? faults.journalGet : null;
    if (!f) return next();
    if (f.delayMs) await new Promise(r => setTimeout(r, f.delayMs));
    if (f.status) return res.status(f.status).json({ error: "Injected review fault", ...(f.code ? { code: f.code } : {}) });
    next();
  });
  app.use(require("../lib/account-binding"));
  require("../routes/journal")(app, ctx);
  require("../routes/blocks")(app, ctx);
  // Real compact-sync routes so a reload restores tasks from the synthetic DB
  // (same minimal day projection as scripts/glasses-review-server.mjs).
  require("../routes/sync")(app, { ...ctx, prepareScheduledDay: async () => {},
    resolveOwnerStrict: require("../middleware/resolve-owner").resolveOwnerStrict,
    readTriageSuppressionsForWorkspace: async () => [],
    buildDayResponse: async d => ({ date: d, triage: { open_items: [], suppressed_items: [] },
      schedule: { timeline: [], timeBlocks: [], blocks: [], tasks_couldnt_fit: [], end_time: "17:30" } }) });
  app.get("/api/journal-review-info", (_req, res) => res.json({ synthetic: true, storage: "memory", date }));
  // Server-side truth for assertions: raw rows, synthetic database only.
  app.get("/api/review/journal/rows", async (_req, res) => {
    const pages = await ctx.pool.query("SELECT task_id, journal_id, owner_user_id, workspace_id, revision, ink, body FROM task_journal_pages ORDER BY task_id");
    const blocks = await ctx.pool.query("SELECT id, user_id, workspace_id, properties FROM blocks WHERE properties->>'type'='journal' ORDER BY id");
    res.json({ pages: pages.rows, blocks: blocks.rows });
  });
  console.log("Journal review: synthetic users only; production block/journal routes and account binding.");
  return ctx;
};
