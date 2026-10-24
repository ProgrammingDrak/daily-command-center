// Disposable synthetic data only. This module is never mounted in production.
module.exports = async function (app) {
  if (process.env.DCC_TASK_ACTION_REVIEW !== "1" || !process.env.DCC_PGLITE_MODULE)
    throw new Error("Explicit in-memory review required");
  const ctx = await require("../test-support/activity-db").createActivityDb();
  await require("../slot-store").ensureSchema();
  const date = new Date().toISOString().slice(0, 10);
  Object.assign(ctx, {
    ...require("../lib/route-helpers"),
    capabilities: require("../capabilities"),
    accessStore: require("../access-store"),
    socialStore: require("../social-store"),
    getTodayStr: () => date,
    APP_TIME_ZONE: "UTC",
    getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: (r) => r,
    broadcast() {}
  });
  app.use((req, res, next) => {
    const cookie = String(req.headers.cookie || "").match(/(?:^|; )fixtureActor=(\d+)/);
    req.session = { userId: cookie ? Number(cookie[1]) : 1 };
    req.workspaceId = req.session.userId === 2 ? "ws-2" : "ws-1";
    next();
  });
  app.get("/public/js/app-config.js", (req, res) =>
    res
      .type("js")
      .send(
        'window.DCC_APP_TIME_ZONE="UTC";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT=' +
          JSON.stringify({ userId: req.session.userId, workspaceId: req.workspaceId }) +
          ";"
      )
  );
  app.get("/unified-fixture", (req, res) =>
    res.sendFile(require("node:path").resolve(__dirname, "../public-todo.html"))
  );
  let ids;
  async function reset() {
    await ctx.pool.query("TRUNCATE task_action_requests,blocks,todo_task_reactions,access_grants,friendships CASCADE");
    const create = (title, extra = {}) =>
      ctx.blockDB.createItineraryTask({
        date,
        userId: 1,
        workspaceId: "ws-1",
        properties: { kind: "task", type: "task", title, start: "09:00", end: "09:30", duration: 30, ...extra }
      });
    const work = await create("DEMO · Shared itinerary task", { taskPriority: "High" }),
      done = await create("DEMO · Finished task", {
        completed: true,
        completedAt: date + "T08:00:00Z",
        start: "10:00",
        end: "10:30"
      }),
      loose = await create("DEMO · Unscheduled", { untimed: true, start: null, end: null, taskPriority: "Low" });
    await ctx.pool.query(
      "INSERT INTO access_grants(owner_user_id,grantee_user_id,role,task_permissions) VALUES(1,3,'manager',$1)",
      [
        {
          edit: "suggest",
          complete: "execute",
          schedule: "execute",
          delegate: "suggest",
          react: "execute",
          reward: "execute",
          bounty: "execute"
        }
      ]
    );
    ids = { work: work.id, done: done.id, loose: loose.id, date };
    return ids;
  }
  app.post("/api/review/task-actions/reset", ctx.route(reset));
  app.get(
    "/api/review/task-actions/state",
    ctx.route(async () => ({ ids, rows: (await ctx.pool.query("SELECT * FROM blocks WHERE deleted_at IS NULL")).rows }))
  );
  require("../routes/blocks")(app, ctx);
  require("../routes/task-actions")(app, ctx);
  require("../routes/access")(app, ctx);
  app.get(
    "/api/public/todo-share/unified-fixture",
    ctx.route(async (req) => {
      const rows = await ctx.blockDB.getBlocksByDate(date, "ws-1");
      const tasks = rows
        .filter((r) => r.type === "block")
        .map((r) => {
          const p = r.properties;
          return {
            id: r.id,
            blockId: r.id,
            title: p.title,
            start: p.start,
            end: p.end,
            untimed: !!p.untimed,
            status: ctx.blockDB.isCompletedTaskProps(p) ? "done" : "open",
            durationMinutes: p.duration,
            itemType: "task",
            taskPriority: p.taskPriority,
            reactions: {},
            viewerReactions: [],
            comments: [],
            sponsorships: []
          };
        });
      const access = await ctx.taskActionStore
        .access(req.session.userId, 1)
        .catch(() => ({ role: "public", modes: {} }));
      return {
        date,
        tasks,
        workspaceName: "Synthetic owner",
        blocks: [],
        calendars: [],
        capabilities: { react: true, comment: true, sponsor_reward: true, place_bounty: true },
        taskAccess: { ownerUserId: 1, role: access.role, modes: access.modes },
        updatedAt: new Date().toISOString()
      };
    })
  );
  await reset();
  console.log("Unified task review: synthetic in-memory fixtures only");
};
