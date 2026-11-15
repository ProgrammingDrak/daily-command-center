const crypto = require("node:crypto");
const express = require("express");
const P = require("../lib/chat-permissions");
const page = require("../lib/chat-integration-page");
module.exports = function mount(app, ctx, { oauth = null, enabled = false, clientsReady = false, approvals = null, executeApproved = null, providerHint = null } = {}) {
  const connectionTable=(oauth?.provider||providerHint)==='clerk'?'mcp_connections':'conversation_grants';
  const form = express.urlencoded({ extended: false, limit: "12kb" });
  const installUrl=(()=>{try{const u=new URL(process.env.DCC_CHATGPT_INSTALL_URL);return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.username&&!u.password&&u.pathname.startsWith('/plugins/')?u.href:null;}catch{return null;}})();
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
  app.get('/api/me/chat-workspaces',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!req.session?.userId)return res.status(401).json({error:'Sign in required'});
    try {
      req.session.conversationCsrf ||= crypto.randomBytes(24).toString('base64url');
      const workspaces=(await ctx.pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id",[req.session.userId])).rows;
      res.json({accountId:req.session.userId,csrf:req.session.conversationCsrf,workspaces});
    }catch{res.status(503).json({error:'Workspace selection unavailable'});}
  });
  app.post('/connections/conversation/workspace',form,async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!req.session?.userId)return res.status(401).json({error:'Sign in required'});
    if(req.get('origin')!==(oauth?.baseUrl||`${req.protocol}://${req.get('host')}`)||!req.session.conversationCsrf||req.body.csrf!==req.session.conversationCsrf)return res.status(403).json({error:'Invalid request'});
    try {
      const member=await ctx.pool.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'",[req.session.userId,req.body.workspaceId]);
      if(!member.rows.length)return res.status(403).json({error:'Workspace owner required'});
      if(oauth?.bind) await oauth.bind(oauth.clientIds[0],{userId:req.session.userId,workspaceId:req.body.workspaceId});
      req.session.workspaceId=req.body.workspaceId;
      res.json({ok:true,accountId:req.session.userId,workspaceId:req.body.workspaceId});
    }catch(e){res.status(e.statusCode||503).json({error:e.statusCode?e.message:'Workspace selection unavailable'});}
  });
  const run = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session?.userId)
        return json(req)
          ? res.status(401).json({ error: "Sign in to DCC to manage connections." })
          : res.redirect("/login?next=" + encodeURIComponent(destination));
      if (!req.session.workspaceId) {
        const r = await ctx.pool.query(
          "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id",
          [req.session.userId]
        );
        if (r.rows.length !== 1) return res.status(409).json({error:'Select a workspace before managing connections.',workspaceSelectionRequired:true});
        req.session.workspaceId = r.rows[0].workspace_id;
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
              `SELECT id,client_id,scopes,created_at,revoked_at,last_verified_at FROM ${connectionTable} WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC`,
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
        clientsReady,
        provider:oauth?.provider || providerHint || 'legacy',
        installUrl,
        hostApprovalPolicy:'not_verified',
        state:!enabled || grants.some(g=>!g.revoked_at && g.connection_state==='temporarily_unavailable') ? 'temporarily_unavailable' : grants.some(g=>!g.revoked_at && g.connection_state==='reconnect_required') ? 'reconnect_required' : grants.some(g=>!g.revoked_at && g.last_verified_at) ? 'verified' : grants.some(g=>!g.revoked_at) ? 'authorized' : grants.length ? 'disconnected' : 'not_connected'
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
      if (oauth) {
        const result=await oauth.revoke(req.body.grantId, actor);
        if(approvals) await ctx.pool.query("UPDATE mcp_approvals SET status='disconnected' WHERE connection_id=$1 AND user_id=$2 AND workspace_id=$3 AND status='pending'",[req.body.grantId,actor.userId,actor.workspaceId]);
        if (json(req)) return res.json(result);
      }
      else
        await ctx.pool.query(
          `UPDATE ${connectionTable} SET revoked_at=COALESCE(revoked_at,NOW())${connectionTable==='mcp_connections'?',revocation_pending=TRUE':''} WHERE id=$1 AND user_id=$2 AND workspace_id=$3`,
          [req.body.grantId, actor.userId, actor.workspaceId]
        );
      if(!oauth && connectionTable==='mcp_connections' && json(req))return res.json({ok:true,revocationPending:true});
      saved(req, res);
    })
  );
  app.post('/connections/conversation/upgrade',form,run(async(req,res,actor)=>{
    if(!oauth?.requestUpgrade)return fail(req,res,409,'Reconnect to request additional access.');
    await oauth.requestUpgrade(req.body.grantId,P.selected(req.body),actor);
    saved(req,res);
  }));
  app.post('/connections/conversation/bind',form,run(async(req,res,actor)=>{
    if(!oauth?.bind) return fail(req,res,409,'Workspace binding requires the Clerk connection.');
    await oauth.bind(req.body.clientId,actor);
    saved(req,res);
  }));
  app.post('/connections/conversation/reconnect',form,run(async(req,res,actor)=>{
    if(!oauth?.reconnect) return fail(req,res,409,'Reconnect in ChatGPT.');
    await oauth.reconnect(req.body.grantId,actor);
    saved(req,res);
  }));
  app.get('/api/me/chat-actions',run(async(req,res,actor)=>{
    const rows=(await ctx.pool.query(`SELECT a.operation,a.outcome,a.approval_id,a.created_at,a.affected_ids,COALESCE(c.client_id,g.client_id,'DCC') AS client FROM mcp_action_log a LEFT JOIN mcp_connections c ON c.id=a.connection_id AND c.user_id=a.user_id LEFT JOIN conversation_grants g ON g.id=a.connection_id AND g.user_id=a.user_id WHERE a.user_id=$1 AND a.workspace_id=$2 ORDER BY a.created_at DESC LIMIT 100`,[actor.userId,actor.workspaceId])).rows;
    res.json({actions:rows});
  }));
  if(approvals) {
    app.get('/connections/conversation/approvals/:id',run(async(req,res,actor)=>{
      const a=await approvals.get(req.params.id,actor);
      res.set('Content-Security-Policy',"default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      res.type('html').send(page.approval({review:a,account:req.session.username,workspace:actor.workspaceId,csrf:req.session.conversationCsrf}));
    }));
    app.post('/connections/conversation/approvals/:id',form,run(async(req,res,actor)=>{
      if(!oauth) return fail(req,res,503,'Connection service unavailable.');
      const result=await approvals.decide(req.params.id,actor,req.body.decision,{revalidate:oauth.revalidate,execute:executeApproved});
      ctx.broadcast?.('blocks-changed',{action:'approved-mcp-change',approvalId:req.params.id},actor.workspaceId);
      ctx.broadcastQueueChange?.(actor.userId,actor.workspaceId);
      if(json(req)) return res.json(result);
      res.type('html').send(page.layout('<p><a href="/">Return to DCC</a></p>',result.status==='approved'?'Changes saved':'Change declined'));
    }));
  }

};
