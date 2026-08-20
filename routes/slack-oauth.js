// Extracted-style route module: module.exports(app, ctx).
//
// Per-user Slack authorization — the two routes that turn a DCC user into a
// user-tier Slack actor, so the ✅ the mirror posts on their behalf is genuinely
// theirs rather than the app's. See lib/slack-oauth.js for why a bot token cannot
// do this.
//
// Deliberately the same shape as routes/gcal.js: a GET that 302s to the provider,
// and a GET callback guarded by a triple state check. The differences from gcal
// are called out where they happen.
module.exports = function mount(app, ctx) {
  const { route } = ctx;

  // Resolved lazily, not at mount time. routes/slack-events.js publishes both
  // ctx.slackOAuth and ctx.slackActors during ITS mount, and route module order
  // is not guaranteed — the /api/me/* handlers in server.js read ctx.slackActors
  // the same way for the same reason.
  const oauth = () => ctx.slackOAuth;
  const actors = () => ctx.slackActors;

  function unavailable(res, message) {
    res.status(503).json({ error: message });
    return true;
  }

  // ── start ────────────────────────────────────────────────────────────────
  //
  // A redirecting GET rather than a JSON endpoint, so the Settings UI can be a
  // plain <a href> with no fetch and no CORS story — the same reason
  // /api/gcal/auth is shaped this way.
  app.get("/api/slack/auth", async (req, res) => {
    const userId = req.session && req.session.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const o = oauth();
    if (!o || !o.configured()) {
      return unavailable(res, "Slack OAuth is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)");
    }
    // Refuse BEFORE sending anyone to Slack. Without the key we could complete the
    // consent screen and then fail to store the grant, which burns the user's
    // authorization and teaches them the feature is broken.
    if (!o.hasEncryptionKey()) {
      return unavailable(res, "Slack OAuth is not configured on this server (SLACK_TOKEN_ENC_KEY)");
    }
    const nonce = ctx.crypto.randomUUID();
    req.session.slackOAuthNonce = nonce;
    const url = o.getAuthUrl(userId, nonce);
    if (!url) return unavailable(res, "Slack OAuth is not configured on this server");
    return res.redirect(url);
  });

  // ── callback ─────────────────────────────────────────────────────────────
  //
  // In AUTH_PUBLIC (server.js) but NOT sessionless: the session cookie is
  // sameSite "lax", which explicitly rides a top-level GET navigation, so Slack's
  // redirect arrives with it. Membership in AUTH_PUBLIC only stops the auth
  // middleware 302ing to /login before this handler can answer with its own
  // specific error. Same arrangement as /api/gcal/callback.
  app.get("/api/slack/callback", async (req, res) => {
    const o = oauth();
    if (!o || !o.configured()) return unavailable(res, "Slack OAuth is not configured on this server");

    // Slack reports a declined consent screen here rather than by not calling back.
    if (req.query.error) {
      return res.redirect(`/?slack=denied&reason=${encodeURIComponent(String(req.query.error).slice(0, 60))}`);
    }
    if (!req.query.code) return res.status(400).json({ error: "Missing OAuth code" });

    // The triple check, copied from routes/gcal.js: the nonce has to be the one
    // THIS server put in THIS session, and the state's userId has to be that
    // session's user. The state itself is unsigned, so both halves are load-bearing.
    const state = o.decodeState(req.query.state);
    const sessionUserId = req.session && req.session.userId;
    if (!sessionUserId || !state.userId || Number(state.userId) !== Number(sessionUserId)
        || !state.nonce || state.nonce !== (req.session && req.session.slackOAuthNonce)) {
      return res.status(400).json({ error: "Invalid OAuth state" });
    }
    // Single use, so a replayed callback URL cannot re-link.
    delete req.session.slackOAuthNonce;

    try {
      const grant = await o.exchangeCode(req.query.code);
      const a = actors();
      if (!a) return unavailable(res, "Slack capture is not configured on this server");
      const result = await a.linkOauthUser(
        sessionUserId, grant.slackUserId, grant.teamId, o.sealGrant(grant), req.workspaceId || null
      );
      if (!result.ok) {
        return res.redirect(`/?slack=error&reason=${encodeURIComponent(result.error.slice(0, 120))}`);
      }
      return res.redirect("/?slack=connected");
    } catch (error) {
      // The token never reaches a log line: `error.message` here is Slack's error
      // code or a local failure, never the credential.
      console.error("[slack-oauth] callback failed:", error.message);
      return res.redirect(`/?slack=error&reason=${encodeURIComponent(error.code || "exchange_failed")}`);
    }
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  //
  // DELETE /api/me/slack/claim (server.js) already unlinks, and unlinkUser is a
  // hard DELETE, so it covers an OAuth link too. Exposed here as well because
  // "connected via OAuth" and "claimed a member ID" are different things to a
  // user and they should not have to know they share a route.
  app.post("/api/slack/disconnect", route(async (req) => {
    const userId = req.session && req.session.userId;
    if (!userId) { const e = new Error("Not authenticated"); e.statusCode = 401; throw e; }
    const a = actors();
    if (!a) { const e = new Error("Slack capture is not configured on this server"); e.statusCode = 503; throw e; }
    await a.unlinkUser(userId);
    return { ok: true };
  }));
};
