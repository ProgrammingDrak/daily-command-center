// Disposable PostgreSQL + production routes, shared by HTTP and browser tests.
const express = require("express");
const { createActivityDb } = require("./activity-db");
const P = require("../lib/time-block-placement");
async function fixture(app = express()) {
  const ctx = await createActivityDb(), date = "2099-11-02";
  Object.assign(ctx, { APP_TIME_ZONE: "America/New_York", getTodayStr: () => "2026-10-28", getScheduleBlocks: async () => [],
    filterLegacyGcalBlocks: rows => rows, isValidDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value), broadcast() {},
    buildDayResponse: async value => ({ date: value, schedule: { timeline: [], day_start: "07:00" } }) });
  app.use(express.json());
  app.use((req, _res, next) => { const other = req.headers["x-review-session"] === "other"; req.workspaceId = other ? "ws-2" : "ws-1"; req.session = { userId: other ? 2 : 1 }; next(); });
  require("../routes/blocks")(app, ctx);
  // Repeats have dedicated aggregate tests; synthetic fixture contains no series.
  ctx.prepareScheduledDay = async () => {};
  async function block(id, properties, type = "block", day = date, ws = "ws-1") {
    return ctx.blockDB.createBlock({ id, type, date: day, workspace_id: ws, user_id: ws === "ws-1" ? 1 : 2, properties: { ...(type === "block" ? { local_id: id, title: id, type: "task", duration: 30 } : {}), ...properties } });
  }
  async function config(items) {
    await ctx.pool.query("DELETE FROM blocks WHERE type='schedule_block'");
    for (const [i, item] of items.entries()) await block(item.id || "configured-" + i, { name: "Focus", start: "09:00", end: "12:00", activeDays: ["mon","tue","wed","thu","fri","sat","sun"], ...item }, "schedule_block", null);
  }
  return { app, ctx, date, block, config, choices: () => P.readBlocks(ctx, "ws-1"), close: ctx.close };
}
module.exports = { fixture };
