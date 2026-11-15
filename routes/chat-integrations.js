const crypto = require("node:crypto");
const express = require("express");
const P = require("../lib/chat-permissions");
const page = require("../lib/chat-integration-page");
module.exports = function mount(app, ctx, { oauth = null, enabled = false, clientsReady = false } = {}) {
  const form = express.urlencoded({ extended: false, limit: "12kb" });
  const destination = "/?settings=connections&connection=chatgpt";
  const json = (req) => req.path.startsWith("/api/") || String(req.get("accept") || "").includes("application/json");
  const fail = (req, res, status, message) =>
    json(req)
      ? res.status(status).json({ error: message })
      : res
          .status(status)
          .type("html")
          .send(
            page.layout(
              `<p role="alert">${page.esc(message)}</p><a href="${destination.replace(/&/g, "&amp;")}">Return to DCC</a>`
            )
          );
  const saved = (req, res) => (json(req) ? res.json({ ok: true }) : res.redirect(destination));
  const run = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session?.userId)
        return json(req)
          ? res.status(401).json({ error: "Sign in to DCC to manage connections." })
          : res.redirect("/login?next=" + encodeURIComponent(destination));
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
      if (!allowed.rows.length) return fail(req, res, 403, "Workspace owner required");
      if (
        req.method !== "GET" &&
        ((req.body.expectedUserId !== undefined && req.body.expectedUserId !== actor.userId) ||
          (req.body.expectedWorkspaceId !== undefined && req.body.expectedWorkspaceId !== actor.workspaceId))
      )
        return fail(req, res, 409, "Your DCC account changed. Reopen Connections before saving.");
      req.session.conversationCsrf ||= crypto.randomBytes(24).toString("base64url");
      if (
        req.method !== "GET" &&
        (!req.session.conversationCsrf ||
          req.body.csrf !== req.session.conversationCsrf ||
          req.get("origin") !== (oauth?.baseUrl || `${req.protocol}://${req.get("host")}`))
      )
        return fail(req, res, 403, "Invalid consent request");
      await fn(req, res, actor);
    } catch (error) {
      const status = error.statusCode || 400;
      fail(req, res, status, status >= 500 ? "Connection management is temporarily unavailable." : error.message);
    }
  };
  app.get(
    "/connections/conversation",
    run(async (_req, res) => res.redirect(destination))
  );
  app.get(
    "/api/me/chat-connections",
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
      res.json({
        grants,
        preferences: prefs.rows[0]?.scopes || P.defaults(),
        categories: P.categories,
        legacyDescriptions: P.legacyDescriptions,
        csrf: req.session.conversationCsrf,
        accountId: actor.userId,
        account: req.session.username || "DCC account",
        workspace: actor.workspaceId,
        resource: oauth?.resource || `${req.protocol}://${req.get("host")}/mcp/dcc`,
        enabled,
        clientsReady
      });
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
      saved(req, res);
    })
  );
  app.post(
    "/connections/conversation/permissions",
    form,
    run(async (req, res, actor) => {
      if (!oauth) return fail(req, res, 503, "This server is not ready to connect ChatGPT yet.");
      await oauth.reduce(req.body.grantId, P.selected(req.body), actor);
      saved(req, res);
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
      saved(req, res);
    })
  );
};
