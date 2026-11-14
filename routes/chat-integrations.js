const crypto = require("node:crypto");
const express = require("express");
const P = require("../lib/chat-permissions");
const page = require("../lib/chat-integration-page");
module.exports = function mount(app, ctx, { oauth = null, enabled = false, clientsReady = false } = {}) {
  const form = express.urlencoded({ extended: false, limit: "12kb" });
  const run = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session?.userId) return res.redirect("/login?next=%2Fconnections%2Fconversation");
      if (!req.session.workspaceId) {
        const r = await ctx.pool.query(
          "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id LIMIT 1",
          [req.session.userId]
        );
        req.session.workspaceId = r.rows[0]?.workspace_id;
      }
      const actor = { userId: req.session.userId, workspaceId: req.session.workspaceId };
      const allowed = await ctx.pool.query(
        "SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'",
        [actor.userId, actor.workspaceId]
      );
      if (!allowed.rows.length) return res.status(403).send("Workspace owner required");
      req.session.conversationCsrf ||= crypto.randomBytes(24).toString("base64url");
      if (
        req.method !== "GET" &&
        (!req.session.conversationCsrf ||
          req.body.csrf !== req.session.conversationCsrf ||
          req.get("origin") !== (oauth?.baseUrl || `${req.protocol}://${req.get("host")}`))
      )
        return res.status(403).send("Invalid consent request");
      await fn(req, res, actor);
    } catch (error) {
      res
        .status(error.statusCode || 400)
        .type("html")
        .send(
          page.layout(
            `<p role="alert">${page.esc(error.statusCode >= 500 ? "Connection management is temporarily unavailable." : error.message)}</p><a href="/connections/conversation">Return to integrations</a>`
          )
        );
    }
  };
  app.get(
    "/connections/conversation",
    run(async (req, res, actor) => {
      const grants = oauth
        ? await oauth.list(actor)
        : (
            await ctx.pool.query(
              "SELECT id,client_id,scopes,created_at,revoked_at,last_verified_at FROM conversation_grants WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC",
              [actor.userId, actor.workspaceId]
            )
          ).rows;
      const prefs = await ctx.pool.query(
        "SELECT scopes FROM conversation_preferences WHERE user_id=$1 AND workspace_id=$2",
        [actor.userId, actor.workspaceId]
      );
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
      );
      res
        .type("html")
        .send(
          page.management({
            grants,
            preferences: prefs.rows[0]?.scopes || P.defaults(),
            csrf: req.session.conversationCsrf,
            account: req.session.username || "DCC account",
            workspace: actor.workspaceId,
            resource: oauth?.resource || `${req.protocol}://${req.get("host")}/mcp/dcc`,
            enabled,
            clientsReady,
            notice: req.query.saved === "1" ? "Saved. Additional access still requires authorization." : null
          })
        );
    })
  );
  app.post(
    "/connections/conversation/preferences",
    form,
    run(async (req, res, actor) => {
      const scopes = P.selected(req.body);
      await ctx.pool.query(
        "INSERT INTO conversation_preferences(user_id,workspace_id,scopes) VALUES($1,$2,$3) ON CONFLICT(user_id,workspace_id) DO UPDATE SET scopes=EXCLUDED.scopes",
        [actor.userId, actor.workspaceId, JSON.stringify(scopes)]
      );
      res.redirect("/connections/conversation?saved=1");
    })
  );
  app.post(
    "/connections/conversation/permissions",
    form,
    run(async (req, res, actor) => {
      if (!oauth) return res.status(503).send("Remote integration is disabled; access changes require operator setup.");
      await oauth.reduce(req.body.grantId, P.selected(req.body), actor);
      res.redirect("/connections/conversation?saved=1");
    })
  );
  app.post(
    "/connections/conversation/revoke",
    form,
    run(async (req, res, actor) => {
      if (oauth) await oauth.revoke(req.body.grantId, actor);
      else
        await ctx.pool.query(
          "UPDATE conversation_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND user_id=$2 AND workspace_id=$3",
          [req.body.grantId, actor.userId, actor.workspaceId]
        );
      res.redirect("/connections/conversation");
    })
  );
};
