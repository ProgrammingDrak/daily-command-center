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
      // Other tabs hold their own __state copy and their own memoized day
      // contexts; without this they keep auto-placing against the old floor
      // until a reload.
      broadcast("blocks-changed", { action: "schedule-settings-update" }, req.workspaceId);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/schedule/settings", async (req, res) => {
    try {
      const reset = await scheduleSettingsStore.resetScheduleSettings(req.workspaceId);
      broadcast("blocks-changed", { action: "schedule-settings-reset" }, req.workspaceId);
      res.json(reset);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
