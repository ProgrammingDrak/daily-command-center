const express = require("express");
const { createIngress, createBudget, limited } = require("../lib/conversation-limits");
const crypto = require("node:crypto");
const { createOAuth, SCOPES } = require("../conversation-oauth");
const { createConversationStore } = require("../conversation-store");
const M = require("../lib/conversation-model");
const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const descriptions = {
  "dcc.read": "Find current, completed, and recurring tasks; read timing and audit history.",
  "dcc.work": "Start and pause focused work; track background processing separately.",
  "dcc.correct": "Correct time allocation, including existing calendar meetings and unknown intervals.",
  "dcc.complete": "Mark an explicitly selected task complete.",
  "dcc.delegate":
    "Link or create explicitly delegated tasks and report background progress or human review needs; never start focus or send external messages."
};
const envelope = {
  sourceEventId: {
    type: "string",
    description: "Stable identity of the explicit user instruction. Reuse exactly on transport retry."
  },
  expectedRevision: { type: "integer", minimum: 0 },
  at: { type: "string", description: "User-confirmed instant with explicit timezone offset." }
};
const tools = [
  {
    name: "dcc_delegate",
    description:
      "Register or update an explicit delegated work handoff (coding, email draft, research, small job). Never register hypothetical discussion, status questions or artifact retrieval. Reuse stable source+work ID; resolve/link an existing canonical task before allowing creation. Working/reporting never credits foreground effort. Deliverables requiring review/send/approval/deploy use needs-review or blocked with concise reviewActions. Completed is accepted only after the canonical task was explicitly completed with dcc_complete_task. No external message is sent and review status grants no permission. Preserve exact sourceEventId, at and envelope on transport retry; sequence increases only on meaningful progress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...envelope,
        action: { enum: ["delegated-register", "delegated-update"] },
        taskId: { type: "string" },
        delegation: {
          type: "object",
          additionalProperties: false,
          properties: {
            work: {
              type: "object",
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                id: { type: "string" },
                kind: { enum: ["coding", "email-draft", "research", "other"] },
                repository: { type: "string" },
                worktreeId: { type: "string" },
                codingTaskId: { type: "string" }
              },
              required: ["source", "id", "kind"]
            },
            sequence: { type: "integer", minimum: 1 },
            phase: { enum: ["working", "paused", "blocked", "needs-review", "completed"] },
            note: { type: "string", maxLength: 1000 },
            reviewActions: { type: "array", maxItems: 5, items: { type: "string", maxLength: 240 } },
            intent: { enum: ["explicit-work-handoff"] },
            createIfMissing: { type: "boolean" },
            title: { type: "string", maxLength: 200 },
            parentTaskId: { type: "string" }
          },
          required: ["work", "sequence", "phase", "note", "reviewActions"]
        }
      },
      required: ["action", "sourceEventId", "expectedRevision", "at", "delegation"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },

  {
    name: "dcc_working_queue",
    description:
      "Read the same Working Queue as DCC: one foreground, ordered tasks, retained context, paused/blocked/background status and manual Needs You check-backs. Read revision before commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_queue",
    description:
      "Control DCC Working Queue only on explicit instruction: add/remove/reorder existing tasks, keep context, bring forward (start), send background, pause/block/unblock, snooze or dismiss check-backs. Queue order never changes itinerary scheduling. Background time is not focused effort. Read dcc_task for guided preview and dcc_working_queue for revision; exact retries keep sourceEventId and at. Completion uses dcc_complete_task.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        action: {
          enum: [
            "queue-add",
            "queue-remove",
            "queue-reorder",
            "queue-note",
            "queue-priority",
            "start",
            "pause",
            "background-start",
            "queue-block",
            "queue-unblock",
            "queue-snooze",
            "queue-dismiss"
          ]
        },
        taskId: { type: "string" },
        order: { type: "array", items: { type: "string" }, maxItems: 100 },
        taskPriority: { enum: ["Low", "Medium", "High"] },
        note: { type: "string", maxLength: 4000 },
        remindMinutes: { type: ["integer", "null"], minimum: 1, maximum: 1440 },
        generation: { type: "string" },
        guided: { type: "object" }
      },
      required: ["action", "sourceEventId", "expectedRevision", "at"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },

  {
    name: "dcc_calendar_events",
    description:
      "Read existing calendar occurrences for a date before allocating meeting time. Returns stable calendarEventId; never creates tasks. Calendar data may need refreshing in DCC.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string" } },
      required: ["date"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_search_tasks",
    description:
      "Search existing tasks first, including completed and recurring tasks. Paginate before concluding no match. A mention or question never starts work. No task creation.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, offset: { type: "integer", minimum: 0 } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_current_activity",
    description: "Read foreground task, background processing, timezone, and revision before any change.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_task",
    description:
      "Read canonical task, planned values, actuals and recorded sessions. Unknown actuals are null, not zero.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_activity_history",
    description: "Read the last 100 explicit commands and corrections.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_work",
    description:
      "Only after an explicit user instruction: start atomically pauses previous foreground; pause; background-start pauses focused effort for that task; background-stop ends processing. Task mentions, questions, and assistant processing never imply start. Read after writing; resolve conflicts by rereading, never silently replace expectedRevision.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        action: { type: "string", enum: ["start", "pause", "background-start", "background-stop"] },
        taskId: { type: "string" }
      },
      required: ["sourceEventId", "expectedRevision", "at", "action", "taskId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "dcc_complete_task",
    description:
      "Complete an explicitly selected task only when the user says done. Does not infer actual effort from planned duration.",
    inputSchema: {
      type: "object",
      properties: { ...envelope, taskId: { type: "string" }, guided: { type: "object" } },
      required: ["sourceEventId", "expectedRevision", "at", "taskId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "dcc_correct_time",
    description:
      "Correct a closed session using explicit user-confirmed intervals. Partition the complete source interval; preserve unidentified gaps as unknown. Use an existing calendar event ID for a meeting, never create a duplicate ordinary task. Read the result after writing.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        correctedWindow: {
          type: "object",
          description:
            "Only when the user explicitly corrects the original recorded start/end. Otherwise omit: allocation must preserve the source interval.",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false
        },
        entryId: { type: "string" },
        reason: { type: "string" },
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["focused", "meeting", "unknown"] },
              taskId: { type: "string" },
              calendarEventId: { type: "string" },
              start: { type: "string" },
              end: { type: "string" }
            },
            required: ["kind", "start", "end"],
            additionalProperties: false
          }
        }
      },
      required: ["sourceEventId", "expectedRevision", "at", "entryId", "reason", "parts"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }
];
const scopeFor = (name) =>
  name === "dcc_delegate"
    ? "dcc.delegate"
    : name === "dcc_work" || name === "dcc_queue"
      ? "dcc.work"
      : name === "dcc_correct_time"
        ? "dcc.correct"
        : name === "dcc_complete_task"
          ? "dcc.complete"
          : "dcc.read";
module.exports = function mount(app, ctx, config = {}) {
  const enabled =
    config.enabled ??
    (process.env.DCC_CONVERSATION_ENABLED === "true" && process.env.DCC_CONVERSATION_REMOTE_ENABLED !== "false");
  if (!enabled) {
    // Machine discovery must not fall through to the interactive login page.
    // This discloses no client/account configuration and never instantiates OAuth.
    app.all(
      [
        "/mcp/dcc",
        "/oauth/dcc/authorize",
        "/oauth/dcc/token",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp/dcc"
      ],
      (_req, res) =>
        res.status(503).set("Cache-Control", "no-store").json({
          error: "conversation_remote_disabled",
          message: "Remote DCC connection is not enabled. Account pairing requires approved server setup first."
        })
    );
    return null;
  }
  app.use(createIngress(config.limits));
  const accountBudget = createBudget({ limit: 120, ...config.limits?.account });
  const oauth = createOAuth({
    pool: ctx.pool,
    baseUrl: config.baseUrl || process.env.DCC_CONVERSATION_URL,
    clients: config.clients || JSON.parse(process.env.DCC_CONVERSATION_CLIENTS || "{}")
  });
  const store = createConversationStore(ctx);
  const route = (fn) => async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      const ready = await ctx.pool.query(
        "SELECT 1 FROM pg_indexes WHERE indexname='conversation_one_foreground_per_user' AND schemaname=current_schema()"
      );
      if (!ready.rows.length) throw M.fail("Conversational tracking is awaiting its foreground migration review", 503);
      await fn(req, res);
    } catch (e) {
      if (res.headersSent) return next(e);
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Conversation service unavailable" });
    }
  };
  const owner = (req) => ({ userId: req.session?.userId, workspaceId: req.session?.workspaceId });
  function csrf(req) {
    if (
      req.get("origin") !== oauth.baseUrl ||
      !req.session?.conversationCsrf ||
      req.body.csrf !== req.session.conversationCsrf
    )
      throw M.fail("Invalid consent request", 403);
  }
  function page(res, title, body) {
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    res.set("Referrer-Policy", "same-origin");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:17px system-ui;max-width:640px;margin:48px auto;padding:24px;color:#17362c;background:#f7faf8}h1{font-size:28px}li{margin:14px 0}button{font:inherit;padding:12px 20px;margin:8px 10px 8px 0;border-radius:8px;border:1px solid #007f56;background:#fff;color:#005e40}button[value=allow]{background:#007f56;color:#fff}code{overflow-wrap:anywhere}section{border-top:1px solid #ccd8d2;margin-top:24px;padding-top:16px}a{color:#006844}</style><main><h1>${escape(title)}</h1>${body}</main></html>`
      );
  }
  const form = express.urlencoded({ extended: false, limit: "12kb" });
  app.get(
    "/.well-known/oauth-authorization-server",
    route(async (_req, res) => res.json(oauth.metadata))
  );
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/dcc"])
    app.get(
      path,
      route(async (_req, res) =>
        res.json({
          resource: oauth.resource,
          authorization_servers: [oauth.baseUrl],
          scopes_supported: SCOPES,
          bearer_methods_supported: ["header"]
        })
      )
    );
  app.get(
    "/oauth/dcc/authorize",
    route(async (req, res) => {
      const request = oauth.validateRequest(req.query);
      if (!req.session?.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      // Use the same signed-in workspace selected by DCC; no query/header identity.
      if (!req.session.workspaceId) {
        const r = await ctx.pool.query(
          "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id LIMIT 1",
          [req.session.userId]
        );
        req.session.workspaceId = r.rows[0]?.workspace_id;
      }
      await oauth.list(owner(req));
      req.session.conversationCsrf = crypto.randomBytes(24).toString("base64url");
      req.session.conversationConsent = {
        ...request,
        userId: req.session.userId,
        workspaceId: req.session.workspaceId,
        expiresAt: Date.now() + 300000
      };
      page(
        res,
        "Connect " + request.clientName,
        `<p>Signed in as <strong>${escape(req.session.username || "DCC account " + req.session.userId)}</strong>, workspace <strong>${escape(req.session.workspaceId)}</strong>.</p><p>This client requests:</p><ul>${request.scopes.map((s) => "<li>" + escape(descriptions[s]) + "</li>").join("")}</ul><p>You can disconnect at any time from Conversational connections. This consent does not change existing tasks.</p><form method="post" action="/oauth/dcc/authorize"><input type="hidden" name="csrf" value="${escape(req.session.conversationCsrf)}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form>`
      );
    })
  );
  app.post(
    "/oauth/dcc/authorize",
    form,
    route(async (req, res) => {
      csrf(req);
      const request = req.session.conversationConsent;
      if (
        !request ||
        request.expiresAt < Date.now() ||
        request.userId !== req.session.userId ||
        request.workspaceId !== req.session.workspaceId
      )
        throw M.fail("Consent expired or account changed", 409);
      delete req.session.conversationConsent;
      if (req.body.decision !== "allow") {
        const u = new URL(request.redirectUri);
        u.searchParams.set("error", "access_denied");
        u.searchParams.set("state", request.state);
        return res.redirect(u.href);
      }
      res.redirect(await oauth.consent(request, owner(req)));
    })
  );
  app.post(
    "/oauth/dcc/token",
    form,
    route(async (req, res) => {
      res.json(await oauth.token(req.body || {}));
    })
  );
  app.get(
    "/connections/conversation",
    route(async (req, res) => {
      if (!req.session?.userId) return res.redirect("/login?next=%2Fconnections%2Fconversation");
      if (!req.session.workspaceId) {
        const r = await ctx.pool.query(
          "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' ORDER BY workspace_id LIMIT 1",
          [req.session.userId]
        );
        req.session.workspaceId = r.rows[0]?.workspace_id;
      }
      const grants = await oauth.list(owner(req));
      req.session.conversationCsrf = crypto.randomBytes(24).toString("base64url");
      page(
        res,
        "Conversational connections",
        `<p>Connect your DCC account from ChatGPT Plugins → Add custom MCP server. Use <code>${escape(oauth.resource)}</code> and OAuth. Install and enable the resulting plugin, then authorize your account.</p><p>Creating a DCC account alone does not install a ChatGPT plugin. Availability depends on your ChatGPT account and workspace. A new account uses this same consent flow.</p><p>Ask to find a task first, then say “starting [task],” “pause,” or “done.” Questions and mentions never start timers. Background processing is separate from focused effort.</p><p><a href="/">Return to DCC</a></p>${grants.map((g) => `<section><strong>${escape(g.client_id)}</strong><p>${g.scopes.map((s) => escape(descriptions[s])).join("<br>")}</p>${g.revoked_at ? "<p>Disconnected</p>" : `<form method="post" action="/connections/conversation/revoke"><input type="hidden" name="csrf" value="${escape(req.session.conversationCsrf)}"><input type="hidden" name="grantId" value="${escape(g.id)}"><button>Disconnect</button></form>`}</section>`).join("") || "<p>No connected clients.</p>"}`
      );
    })
  );
  app.post(
    "/connections/conversation/revoke",
    form,
    route(async (req, res) => {
      csrf(req);
      await oauth.revoke(req.body.grantId, owner(req));
      res.redirect("/connections/conversation");
    })
  );
  app.all(
    "/mcp/dcc",
    route(async (req, res) => {
      if (req.get("origin") && req.get("origin") !== oauth.baseUrl) throw M.fail("Origin not allowed", 403);
      let identity;
      const raw = String(req.get("authorization") || "");
      try {
        identity = await oauth.verify(raw.startsWith("Bearer ") ? raw.slice(7) : "");
      } catch (e) {
        res.set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${oauth.baseUrl}/.well-known/oauth-protected-resource/mcp/dcc"`
        );
        throw e;
      }
      if (!accountBudget(String(identity.userId))) return limited(res);
      if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
      const b = req.body;
      if (!b || Array.isArray(b) || b.jsonrpc !== "2.0" || typeof b.method !== "string")
        return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      if (b.id === undefined) {
        if (b.method === "notifications/initialized") return res.status(202).end();
        return res.status(400).end();
      }
      const reply = (result) => res.json({ jsonrpc: "2.0", id: b.id, result });
      if (b.method === "initialize")
        return reply({
          protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(b.params?.protocolVersion)
            ? b.params.protocolVersion
            : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dcc-account", version: "0.1.0" },
          instructions:
            "Resolve existing tasks before acting. Only explicit user start/pause/done/correction instructions authorize activity changes. Preserve unknown time and plan versus actual. Confirm writes using dcc_task or dcc_current_activity."
        });
      if (b.method === "ping") return reply({});
      if (b.method === "tools/list")
        return reply({
          tools: tools
            .filter((t) => identity.scopes.includes(scopeFor(t.name)))
            .map((t) => ({ ...t, securitySchemes: [{ type: "oauth2", scopes: [scopeFor(t.name)] }] }))
        });
      if (b.method !== "tools/call")
        return res.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
      const name = b.params?.name,
        args = b.params?.arguments || {};
      if (!tools.some((t) => t.name === name))
        return res.json({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Unknown tool" } });
      identity = await oauth.verify(raw.slice(7), scopeFor(name));
      try {
        let result;
        if (name === "dcc_search_tasks") result = await store.search(args, identity);
        if (name === "dcc_current_activity" || name === "dcc_working_queue") result = await store.state(identity);
        if (name === "dcc_calendar_events") result = await store.calendarEvents(args, identity);
        if (name === "dcc_task") result = await store.get(M.text(args.taskId, "taskId"), identity);
        if (name === "dcc_activity_history") result = { events: await store.history(identity) };
        if (name === "dcc_work" && !["start", "pause", "background-start", "background-stop"].includes(args.action))
          throw M.fail("Unsupported work action");
        if (
          name === "dcc_queue" &&
          ![
            "queue-add",
            "queue-remove",
            "queue-reorder",
            "queue-note",
            "queue-priority",
            "start",
            "pause",
            "background-start",
            "queue-block",
            "queue-unblock",
            "queue-snooze",
            "queue-dismiss"
          ].includes(args.action)
        )
          throw M.fail("Unsupported queue action");
        if (name === "dcc_delegate" && !["delegated-register", "delegated-update"].includes(args.action))
          throw M.fail("Unsupported delegated work action");
        if (["dcc_delegate", "dcc_queue", "dcc_work", "dcc_complete_task", "dcc_correct_time"].includes(name)) {
          result = await store.execute(
            {
              ...args,
              ...(name === "dcc_complete_task"
                ? { action: "done" }
                : name === "dcc_correct_time"
                  ? { action: "correct" }
                  : {})
            },
            identity
          );
          ctx.broadcast?.(
            "blocks-changed",
            {
              action: "conversation",
              sourceEventId: args.sourceEventId,
              blockIds: [
                ...(result.affectedTasks || []).map((r) => r.id),
                ...(result.entries || []).map((r) => r.id),
                ...(result.sourceEntry ? [result.sourceEntry.id] : [])
              ]
            },
            identity.workspaceId
          );
          // A write grant does not imply permission to read unrelated queue rows,
          // private reports or audit snapshots, including on idempotent replay.
          if (!identity.scopes.includes("dcc.read"))
            result = {
              ok: result.ok,
              sourceEventId: result.sourceEventId,
              ...(result.task?.id ? { taskId: result.task.id } : {}),
              revision: (result.currentState || result.state).revision,
              duplicate: result.duplicate === true
            };
        }
        reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        reply({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: e.statusCode ? e.message : "Activity could not be saved",
                status: e.statusCode || 500
              })
            }
          ],
          isError: true
        });
      }
    })
  );
  return { oauth, store };
};
module.exports.tools = tools;
