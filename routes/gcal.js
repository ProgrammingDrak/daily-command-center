// Extracted from server.js — mounted as module.exports(app, ctx).
//
// Realtime Google Calendar sync is disabled, but the Google OAuth connection is
// also used by read-only Workspace features such as meeting-chat signals. Keep
// auth + callback alive while every sync/calendar-data route remains 410.

module.exports = function mount(app, ctx) {
  const { REALTIME_GCAL_SYNC_ENABLED, crypto, gcalAuth } = ctx;

  app.get("/api/gcal/auth", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const nonce = crypto.randomUUID();
      req.session.googleOAuthNonce = nonce;
      const url = await gcalAuth.getAuthUrl(userId, req.query.account, nonce);
      if (!url) return res.status(503).json({ error: "Google OAuth credentials are not configured" });
      return res.redirect(url);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gcal/callback", async (req, res) => {
    try {
      if (!req.query.code) return res.status(400).json({ error: "Missing OAuth code" });
      const state = gcalAuth.decodeState(req.query.state);
      if (!req.session?.userId || !state.userId || Number(state.userId) !== Number(req.session.userId) ||
          !state.nonce || state.nonce !== req.session.googleOAuthNonce) {
        return res.status(400).json({ error: "Invalid OAuth state" });
      }
      delete req.session.googleOAuthNonce;
      await gcalAuth.handleCallback(req.query.code, state.userId, state.accountKey);
      return res.redirect("/?google=connected");
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.use("/api/gcal", (req, res, next) => {
    if (REALTIME_GCAL_SYNC_ENABLED) return next();
    res.status(410).json({ error: "Realtime Google Calendar sync is disabled. Legacy cached calendar blocks are hidden from DCC views." });
  });
};
