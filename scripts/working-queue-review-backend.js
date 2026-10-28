// Opt-in disposable account for the full-app pet/queue browser regression.
// Never mounted by production or connected to an existing database schema.
module.exports = async function mount(app) {
  if (process.env.DCC_WORKING_QUEUE_REVIEW !== "1" || !process.env.DCC_TEST_DATABASE_URL)
    throw new Error("An explicit disposable localhost database is required");
  const ctx = await require("../test-support/activity-db").createActivityDb();
  process.env.DCC_CONVERSATION_ENABLED = "true";
  process.env.DCC_CONVERSATION_REMOTE_ENABLED = "false";
  await ctx.pool.query(require("../conversation-store").FOREGROUND_INDEX_SQL);
  const date = new Date().toISOString().slice(0, 10);
  Object.assign(ctx, {
    APP_TIME_ZONE: "UTC", getTodayStr: () => date, getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: rows => rows, isValidDate: require("../public/js/activity-model").validDate,
    broadcast() {}
  });
  app.use((req, _res, next) => { req.session = { userId: 1 }; req.workspaceId = "ws-1"; next(); });
  require("../routes/working-queue")(app, ctx);
  require("../routes/blocks")(app, ctx);
  app.post("/api/queue-review/seed", require("../lib/route-helpers").route(async req => {
    const properties={...req.body.properties}, startedAt=properties.startedAt;
    delete properties.startedAt;
    const row=await ctx.blockDB.createBlock({...req.body,properties,user_id:1,workspace_id:"ws-1"});
    const store=require("../conversation-store").createConversationStore(ctx),owner={userId:1,workspaceId:"ws-1"};
    const result=await store.execute({action:"start",taskId:row.id,sourceEventId:"fixture:"+row.id,expectedRevision:(await store.state(owner)).revision,at:startedAt},owner);
    return result.task;
  }));
  app.post("/api/queue-review/reset", async (_req, res) => {
    // Each viewport gets an independent empty synthetic account state.
    await ctx.pool.query("TRUNCATE conversation_events,conversation_state,work_rotations,delegated_work,operations,blocks CASCADE");
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => {
    const fs = require("node:fs"), path = require("node:path");
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    res.type("html").send(html.replace("<head>", '<head><script>window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};</script>'));
  });
  process.on("SIGTERM", async () => { await ctx.close(); process.exit(0); });
};
