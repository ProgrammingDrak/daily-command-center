// Opt-in disposable backend for ui-review-server.mjs. Uses production activity
// and block routes against an isolated database. Never imported by server.js.
module.exports = async function mountActivityReview(app) {
  if (process.env.DCC_ACTIVITY_REVIEW !== "1" || !process.env.DCC_PGLITE_MODULE) throw new Error("Activity review requires an explicit in-memory database runtime");
  const { createActivityDb } = require("../test-support/activity-db");
  const { createActivityStore } = require("../activity-store");
  const { workout, meal } = require("../test-support/activity-fixtures");
  const ctx = await createActivityDb();
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  Object.assign(ctx, { APP_TIME_ZONE: "UTC", getTodayStr: () => date, getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: rows => rows, isValidDate: require("../public/js/activity-model").validDate,
    broadcast() {} });
  app.use((req, _res, next) => {
    const mode = req.headers["x-review-session"];
    if (mode !== "none") { req.session = { userId: mode === "other" ? 2 : mode === "viewer" ? 3 : 1 }; req.workspaceId = mode === "other" ? "ws-2" : "ws-1"; }
    next();
  });
  if(process.env.DCC_COMBINED_REVIEW==='1') {
    app.get('/public/js/app-config.js',(req,res)=>res.type('js').set('Cache-Control','no-store').send('window.DCC_APP_TIME_ZONE="UTC";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT='+JSON.stringify({userId:req.session?.userId,workspaceId:req.workspaceId})+';'));
    app.get('/api/me',(req,res)=>res.json({id:req.session?.userId,username:req.session?.userId===2?'Riley-demo':'Morgan-demo',onboardingState:{dailyCommandCenterTour:{version:2,completedAt:'2026-01-01T00:00:00Z'}}}));
    app.use(require('../lib/account-binding'));
  }
  if (process.env.DCC_SHARED_TASK_REVIEW === "1") await require("./shared-task-review-backend")(app,ctx,date);
  if(process.env.DCC_COMBINED_REVIEW==='1')require("./combined-collaboration-review")(app,ctx);
  require("../routes/activity")(app, ctx);
  require("../routes/blocks")(app, ctx);
  const store = createActivityStore(ctx), owner = { userId: 1, workspaceId: "ws-1" };
  const strength = await store.create({ title: "DEMO · Strength & run", date, record: workout(date) }, owner);
  await store.create({ title: "DEMO · Partial meal log", date, record: meal(date) }, owner);
  const earlier = new Date(Date.parse(date + "T12:00:00Z") - 2 * 86400000).toISOString().slice(0, 10);
  const prior = workout(earlier); prior.actual.sets[1].reps = 20;
  await store.create({ title: "DEMO · Earlier workout", date: earlier, record: prior }, owner);
  await ctx.pool.query("UPDATE blocks SET properties=properties || $2::jsonb WHERE id=$1", [strength.taskId, JSON.stringify({ status: "done", completedAt: date + "T12:00:00Z" })]);
  app.get("/api/activity-review-info", (_req, res) => res.json({ synthetic: true, storage: "memory", date, taskId: strength.taskId }));
  console.log("Activity review: synthetic fixtures only; private records use production routes.");
  return ctx;
};
