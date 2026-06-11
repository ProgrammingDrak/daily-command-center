// Extracted from server.js — mounted as module.exports(app, ctx).
//
// Realtime Google Calendar sync is disabled (REALTIME_GCAL_SYNC_ENABLED is
// hardcoded false in server.js). The original handlers referenced `gcalAuth`
// and `gcalSync` modules that no longer exist in this repo, so they could
// never run — the guard below 410'd every request first. The dead handlers
// were removed; recover them from git history (pre routes/ split) if the
// feature ever comes back. `gcal-auth.js` still exists for the OAuth pieces.

module.exports = function mount(app, ctx) {
  const { REALTIME_GCAL_SYNC_ENABLED } = ctx;

  app.use("/api/gcal", (req, res, next) => {
    if (REALTIME_GCAL_SYNC_ENABLED) return next();
    res.status(410).json({ error: "Realtime Google Calendar sync is disabled. Legacy cached calendar blocks are hidden from DCC views." });
  });
};
