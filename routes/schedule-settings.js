// Extracted-style route module — mounted via the routes/index pattern:
// module.exports(app, ctx). ctx carries shared server-scope helpers; see
// server.js where ctx is built.
//
// The read/write surface for the user's start of day. The value itself is a
// FLOOR on auto-placement, never a rewrite of the day's plan — see
// public/js/day-context.js dayStartMinutes for the contract every slot engine
// shares, and schedule-settings-store.js for the storage shape.
//
// Format and range are validated in ONE place (normalizeDayStart), inside the
// store, so this module never re-spells the rule. An illegal value throws and
// lands here as a 400.

const scheduleSettingsStore = require("../schedule-settings-store");

module.exports = function mount(app, ctx) {
  const { broadcast } = ctx;

  app.get("/api/schedule/settings", async (req, res) => {
    try {
      res.json(await scheduleSettingsStore.getScheduleSettings(req.workspaceId));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch("/api/schedule/settings", async (req, res) => {
    try {
      const updated = await scheduleSettingsStore.updateScheduleSettings(
        req.workspaceId,
        req.session && req.session.userId,
        req.body || {}
      );
      // dcc-state-changed, NOT blocks-changed. day_start rides on state.schedule, and
      // in public/js/sse.js only dcc-state-changed reaches refreshDccState, the one path
      // that refetches /api/state/day and reassigns __state. blocks-changed just refolds
      // the block cache, so the receiving tab would keep the old floor until a reload,
      // the opposite of why this broadcast exists. Same channel and {source, action}
      // shape triage suppressions use, which is the same kind-block read-time stamp.
      broadcast("dcc-state-changed", { source: "schedule-settings", action: "update" }, req.workspaceId);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/schedule/settings", async (req, res) => {
    try {
      const reset = await scheduleSettingsStore.resetScheduleSettings(req.workspaceId);
      broadcast("dcc-state-changed", { source: "schedule-settings", action: "reset" }, req.workspaceId);
      res.json(reset);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
