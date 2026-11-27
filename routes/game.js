// routes/game.js — XP / streak game API (Phase 1).
//
// Starting and completing a task keep using the existing routes
// (POST /api/blocks/:id/work and POST /api/tasks/:taskRef/completion). Those
// routes call the game hooks and return a `game` field with the XP that landed.
//
//   GET  /api/game/summary                       today XP, week XP, tier, streak, lives, Big 3
//   GET  /api/game/config                        the XP numbers (for UI copy)
//   GET  /api/game/intentions/:date              Big 3 + minimum day for a date
//   PUT  /api/game/intentions/:date              { big3: [taskId…≤3], minimumDay: "text" }
//   POST /api/game/intentions/:date/minimum-day  { done: true|false }
//   POST /api/dcc/game/close-day                 close finished days (session or bearer token)
"use strict";

const CONFIG = require("../game/config");
const R = require("../game/rules");

module.exports = function mountGame(app, ctx) {
  const { resolveOwnerStrict } = ctx;
  const game = ctx.gameStore;

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err.status || err.statusCode || 500;
      if (status >= 500) console.error("[game]", req.method, req.path, err);
      res.status(status).json({ error: status >= 500 ? "Game request failed" : err.message });
    }
  };

  const dateParam = (req) => {
    const date = req.params.date === "today" ? R.localDate(Date.now(), CONFIG.TIME_ZONE) : req.params.date;
    if (!R.isDateStr(date)) {
      const err = new Error("date must be YYYY-MM-DD or 'today'");
      err.status = 400;
      throw err;
    }
    return date;
  };

  app.get("/api/game/summary", handle(async (req) => game.summary(await resolveOwnerStrict(req))));

  app.get("/api/game/config", handle(async () => ({
    timeZone: CONFIG.TIME_ZONE, xp: CONFIG.XP, tiers: CONFIG.TIERS, lives: CONFIG.STREAK.LIVES_PER_WEEK, big3Max: CONFIG.BIG3_MAX,
  })));

  app.get("/api/game/intentions/:date", handle(async (req) => {
    const { workspaceId } = await resolveOwnerStrict(req);
    return game.getIntentions(workspaceId, dateParam(req));
  }));

  app.put("/api/game/intentions/:date", handle(async (req) => {
    const owner = await resolveOwnerStrict(req);
    const body = req.body || {};
    return game.setIntentions({ ...owner, date: dateParam(req), big3: body.big3, minimumDay: body.minimumDay });
  }));

  app.post("/api/game/intentions/:date/minimum-day", handle(async (req) => {
    const owner = await resolveOwnerStrict(req);
    return game.setMinimumDayDone({ ...owner, date: dateParam(req), done: (req.body || {}).done !== false });
  }));

  app.post("/api/dcc/game/close-day", handle(async (req) => {
    const owner = await resolveOwnerStrict(req);
    const out = await game.closeDays(owner);
    return { ok: true, closed: out.closed, streak: out.state };
  }));
};

// Shared best-effort hook runner for the task routes: the game must never
// break starting or completing a task.
module.exports.safeHook = async function safeHook(label, fn) {
  try {
    return (await fn()) || [];
  } catch (err) {
    console.error(`[game] ${label} hook failed (non-fatal):`, err.message);
    return [];
  }
};
