const express = require("express");
const { createIngress, createBudget, limited } = require("../lib/conversation-limits");
const crypto = require("node:crypto");
const permissions = require("../lib/chat-permissions");
const integrationPage = require("../lib/chat-integration-page");
const { createOAuth, SCOPES } = require("../conversation-oauth");
const { createConversationStore } = require("../conversation-store");
const M = require("../lib/conversation-model");
const wishlistMcp = require("../lib/wishlist-mcp");
const { createProjectStore } = require("../project-store");
const envelope = {
  sourceEventId: {
    type: "string",
    description: "Stable identity of the explicit user instruction. Reuse exactly on transport retry."
  },
  expectedRevision: { type: "integer", minimum: 0 },
  at: { type: "string", description: "User-confirmed instant with explicit timezone offset." }
};
const tools = [
  ...wishlistMcp.tools,
  ...require("../lib/chat-control-tools").tools,
  {
    name: "dcc_save_someday_idea",
    description: "Save a task to DCC Someday on explicit request. Given a link or location, look up the idea when possible, give it an actionable title, retain the original link, and add a verified venue/neighborhood and a short planning note when available. Leave unknown details blank; ask if an ambiguous place materially changes the idea. Use existing user-provided tags such as With Fae when requested. Do not assign a date. Reuse sourceEventId on retry.",
    inputSchema: {
      type: "object",
      required: ["title", "sourceEventId"],
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 300 },
        sourceEventId: envelope.sourceEventId,
        detail: { type: "string", maxLength: 5000 },
        sourceUrl: { type: "string" },
        location: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        duration: { type: "integer", minimum: 1, maximum: 1440 }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "dcc_reconciliation_receipt",
    description:
      "Read back one source-message decision, including dropped occurrences and both iteration records. not_found is no recorded commit; an in-flight request may still finish. verified_saved confirms the stored result; stale_conflict means a later edit superseded it. Retry the exact original envelope after transport uncertainty.",
    inputSchema: {
      type: "object",
      properties: { sourceEventId: { type: "string" } },
      required: ["sourceEventId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_completion_review",
    description:
      "At the existing morning/evening review, offer up to five unfinished tasks with Done, Still working, Drop it, or Progress made → next iteration. These are questions, never inferred completions. Preserve unanswered choices; do not add a notification schedule. A calendar event or timer ending is not evidence. Use returned canonical ID and version for each explicit answer.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Local review date YYYY-MM-DD; defaults to account timezone today." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_reconcile_task",
    description:
      "Act on the user's explicit outcome: Done, Still working, reversible Drop it, Progress made → next iteration, or Undo. Read/search first; ask a narrow choice for ambiguous titles or remaining scope. Meaningful progress can close an iteration: summarize what got done and create/link a specific successor with remaining work; never claim the broader goal is accomplished. Do not fragment tiny updates automatically. Select the concrete subtask or recurring occurrence. The server refuses parent cascades and active timers. Preserve this exact source-message envelope on retry. Report pending until saveStatus is verified_saved; save_uncertain requires exact retry/readback, stale_conflict requires review. Undo references the earlier sourceEventId and refuses later edits. New dcc.reconcile consent is required; existing grants are not expanded.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        taskId: { type: "string" },
        reconciliation: {
          type: "object",
          properties: {
            choice: { enum: ["done", "still_working", "drop", "step_done", "undo"] },
            expectedTaskVersion: { type: "string" },
            outcome: { type: "string", description: "Concise accomplishment summary; required for done or step_done." },
            completedTitle: { type: "string", description: "Readable title for this completed iteration." },
            nextStep: {
              type: "object",
              properties: {
                title: { type: "string" },
                summary: { type: "string", description: "Concise remaining work." },
                taskId: { type: "string" },
                expectedTaskVersion: { type: "string" }
              },
              additionalProperties: false
            },
            reviewDate: { type: "string" },
            undoEventId: { type: "string" },
            completedAt: {
              type: "string",
              description:
                "Only an explicitly known completion instant. Otherwise at is report time, actual completion time remains unknown."
            }
          },
          required: ["choice", "expectedTaskVersion"],
          additionalProperties: false
        }
      },
      required: ["sourceEventId", "expectedRevision", "at", "taskId", "reconciliation"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  {
    name: "dcc_delegate",
    description:
      "Register or update an explicit delegated work handoff (coding, email draft, research, small job). Never register hypothetical discussion, status questions or artifact retrieval. Reuse stable source+work ID; resolve/link an existing canonical task before allowing creation. Working/reporting never credits foreground effort. Deliverables requiring review/send/approval/deploy use needs-review or blocked with concise reviewActions. Completed is accepted only after the canonical task was explicitly completed with dcc_complete_task. No external message is sent and review status grants no permission. Preserve exact sourceEventId, at and envelope on transport retry; sequence increases on meaningful progress or a newly observed execution-state check. Background requires explicit execution state running with observedAt and validUntil (at most 15 minutes); phase working alone is not proof of liveness. Report stopped/unknown honestly, and use needs-review or blocked with reviewActions for human attention. No polling or notifications are created automatically.",
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
            execution: {type:"object",description:"Explicit host observation; never infer from open chat/task status. Omit when unverified.",properties:{state:{enum:["running","stopped","unknown"]},observedAt:{type:"string"},validUntil:{type:"string",description:"Required only for running; expires within 15 minutes of observedAt."}},required:["state","observedAt"],additionalProperties:false},
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
      "Read the same Working Queue as DCC: one human foreground task, ordered inactive Priority tasks, fresh worker execution in Background, and explicit review/blockers or due manual check-backs in Needs You. Retains context and history. Read revision before commands.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "dcc_queue",
    description:
      "Control DCC Working Queue only on explicit instruction: add/remove/reorder existing tasks, keep context, bring forward (start), send background, pause/block/unblock, snooze or dismiss check-backs. queue-snooze defers any Needs You item for remindMinutes (1-1440); send generation only when the item has one. A snoozed item waits in Background (attention snoozed, no focused time; snooze does not start or stop workers) and returns to Needs You at expiry with its review/blocked reason intact; dismissing the snooze reveals that reason now. Return idle work to Priority with queue-return, preserving identity, order and history; do not remove/re-add. queue-return is refused while review is pending or the item is snoozed. The command cannot stop a worker or dismiss pending review. Queue order never changes itinerary scheduling. Background time is not focused effort. Read dcc_task for guided preview and dcc_working_queue for revision; exact retries keep sourceEventId and at. Completion uses dcc_complete_task.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        action: {
          enum: [
            "queue-add",
            "queue-remove",
            "queue-return",
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
      "Only after an explicit user instruction: start atomically pauses previous foreground; pause; background-start pauses focused effort for that task; background-stop clears DCC processing bookkeeping; it does not stop an external worker. Background placement requires fresh delegated execution evidence. Task mentions, questions, and assistant processing never imply start. Read after writing; resolve conflicts by rereading, never silently replace expectedRevision.",
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
      "When the user explicitly reports finished work, read the canonical task, resolve ambiguity, then complete that exact scope. Supply the read reconciliationVersion and a concise outcome. Parent completion with unfinished children is refused. Use dcc_reconcile_task for progress plus a next iteration, drop or undo. at is report time; do not invent exact completion time or effort. Only saveStatus verified_saved confirms persistence; preserve the exact source message envelope on retry.",
    inputSchema: {
      type: "object",
      properties: {
        ...envelope,
        taskId: { type: "string" },
        expectedTaskVersion: { type: "string" },
        outcome: { type: "string" },
        completedAt: { type: "string" }
      },
      required: ["sourceEventId", "expectedRevision", "at", "taskId", "expectedTaskVersion", "outcome"],
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
const scopeFor = (name) => wishlistMcp.scopeFor(name) || (
  require('../lib/chat-control-tools').categoryFor[name] ? `dcc.${require('../lib/chat-control-tools').categoryFor[name]}.read` :
  name === 'dcc_connection_status' ? permissions.scopes :
  name === 'dcc_working_queue' ? ['dcc.read','dcc.queue.read'] :
  name === 'dcc_correct_time' ? ['dcc.correct','dcc.time.write'] :
  ['dcc_queue','dcc_work'].includes(name) ? ['dcc.work','dcc.queue.write'] :
  name === 'dcc_delegate' ? ['dcc.delegate','dcc.queue.write'] :
  name === "dcc_save_someday_idea" ? "dcc.capture" :
  name === "dcc_reconcile_task"
    ? "dcc.reconcile"
    : name === "dcc_delegate"
      ? "dcc.delegate"
      : name === "dcc_work" || name === "dcc_queue"
        ? "dcc.work"
        : name === "dcc_correct_time"
          ? "dcc.correct"
          : name === "dcc_complete_task"
            ? "dcc.complete"
            : "dcc.read");
module.exports = function mount(app, ctx, config = {}) {
  const enabled =
    config.enabled ??
    (process.env.DCC_CONVERSATION_ENABLED === "true" && process.env.DCC_CONVERSATION_REMOTE_ENABLED !== "false");
  if (!enabled) {
    require("./chat-integrations")(app, ctx);
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
  let control;
  require("./chat-integrations")(app, ctx, { oauth, enabled, clientsReady: Object.keys(config.clients || JSON.parse(process.env.DCC_CONVERSATION_CLIENTS || "{}")).length > 0 });
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
      req.session.conversationCsrf ||= crypto.randomBytes(24).toString("base64url");
      req.session.conversationConsent = {
        ...request,
        userId: req.session.userId,
        workspaceId: req.session.workspaceId,
        expiresAt: Date.now() + 300000
      };
      const prefs = await oauth.preferences(owner(req));
      // Existing legacy-only clients keep explicit legacy choices; modern clients
      // begin with the user's preferences intersected with requested authority.
      const granted = request.scopes.some(s => !permissions.legacy.includes(s))
        ? prefs.filter(s => request.scopes.includes(s)) : request.scopes;
      const callbackOrigin = new URL(request.redirectUri).origin;
      res.set("Content-Security-Policy", `default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`);
      res.set('Referrer-Policy','same-origin');
      res.type('html').send(integrationPage.consent({request,csrf:req.session.conversationCsrf,granted,account:req.session.username || 'DCC account',workspace:req.session.workspaceId}));
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
      const chosen = permissions.selected(req.body, request.scopes);
      if (!chosen.length) throw M.fail('Select at least one permission');
      res.redirect(await oauth.consent({ ...request, scopes: chosen }, owner(req)));
    })
  );
  app.post(
    "/oauth/dcc/token",
    form,
    route(async (req, res) => {
      res.json(await oauth.token(req.body || {}));
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
            "Resolve existing tasks before acting. Only explicit user start/pause/done/correction instructions authorize activity changes. Preserve unknown time and plan versus actual. For explicit completion use dcc_complete_task after reading the canonical task/version. For meaningful progress, summarize accomplishments and remaining scope with dcc_reconcile_task step_done, keeping the goal open. At existing morning/evening reviews call dcc_completion_review and offer its choices without inferring completion. Confirm reconciliation with dcc_reconciliation_receipt; only verified_saved means saved."
        });
      if (b.method === "ping") return reply({});
      if (b.method === "tools/list")
        return reply({
          tools: tools
            .filter((t) => (Array.isArray(scopeFor(t.name)) ? scopeFor(t.name) : [scopeFor(t.name)]).some(s => identity.scopes.includes(s)))
            .map((t) => ({ ...t, securitySchemes: (Array.isArray(scopeFor(t.name)) ? scopeFor(t.name) : [scopeFor(t.name)]).filter(s=>identity.scopes.includes(s)).map(s=>({type:'oauth2',scopes:[s]})) }))
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
        if (wishlistMcp.scopeFor(name)) result = await wishlistMcp.run(ctx, name, args, identity);
        const category = require('../lib/chat-control-tools').categoryFor[name];
        if (name === 'dcc_connection_status') result = {accountId:identity.userId,workspaceId:identity.workspaceId,status:'verified',permissions:permissions.categories.map(c=>({category:c.id,level:permissions.level(identity.scopes,c.id)})),legacyScopes:identity.scopes.filter(s=>permissions.legacy.includes(s))};
        if (category && name !== 'dcc_time_records') {
          control ||= require('../chat-control-store').createChatControlStore(ctx);
          result = await control[name === 'dcc_bulk_cleanup' ? 'bulk' : category](args,identity);
        }
        if (name === 'dcc_time_records') {
          const offset = Number(args.offset || 0);
          if (!Number.isInteger(offset) || offset < 0) throw M.fail('Invalid offset');
          const entries = await ctx.pool.query("SELECT id,date,properties FROM blocks WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL AND (type='time_entry' OR properties->>'kind'='time_entry') ORDER BY date DESC,id LIMIT 51 OFFSET $3", [identity.workspaceId,identity.userId,offset]);
          result = {entries:entries.rows.slice(0,50),nextOffset:entries.rows.length>50?offset+50:null};
        }
        if (name === "dcc_save_someday_idea") {
          const sourceEventId = M.text(args.sourceEventId, "sourceEventId", 200);
          const id = "someday-" + M.digest(JSON.stringify([identity.workspaceId, identity.userId, sourceEventId]));
          const idea = await createProjectStore(ctx).createTask({
            id, title: M.text(args.title, "title", 300), detail: args.detail, tags: args.tags,
            location: args.location, sourceUrl: args.sourceUrl, duration: args.duration,
            someday: true, source: "conversation"
          }, identity);
          if (idea.deleted_at) throw M.fail("This idea was deleted", 409);
          if (!idea._resolvedExisting) ctx.broadcast?.("blocks-changed", { action: "someday-capture", blockIds: [idea.id] }, identity.workspaceId);
          result = { ok: true, taskId: idea.id, duplicate: idea._resolvedExisting === true };
        }
        if (name === "dcc_reconciliation_receipt")
          result = await store.reconciliationReceipt(args.sourceEventId, identity);
        if (name === "dcc_completion_review") result = await store.completionReview(args, identity);
        if (name === "dcc_search_tasks") result = await store.search(args, identity);
        if (name === "dcc_current_activity" || name === "dcc_working_queue") {
          result = await store.state(identity);
          if (!identity.scopes.includes('dcc.read')) result = {revision:result.revision,queue:{items:(result.queue?.items||[]).map(item=>({status:item.status,taskId:item.task?.id,title:item.task?.properties?.title,taskPriority:item.taskPriority,blocked:item.blocked,needsYou:item.needsYou}))}};
        }
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
            "queue-return",
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
        if (
          [
            "dcc_reconcile_task",
            "dcc_delegate",
            "dcc_queue",
            "dcc_work",
            "dcc_complete_task",
            "dcc_correct_time"
          ].includes(name)
        ) {
          result = await store.execute(
            {
              ...(name === "dcc_complete_task"
                ? {
                    sourceEventId: args.sourceEventId,
                    expectedRevision: args.expectedRevision,
                    at: args.at,
                    taskId: args.taskId,
                    reconciliation: {
                      choice: "done",
                      expectedTaskVersion: args.expectedTaskVersion,
                      outcome: args.outcome,
                      ...(args.completedAt ? { completedAt: args.completedAt } : {})
                    }
                  }
                : args),
              ...(name === "dcc_reconcile_task"
                ? { action: "reconcile" }
                : name === "dcc_complete_task"
                  ? { action: "reconcile" }
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
                ...(result.reconciliation?.afterRows || []).map((r) => r.id),
                ...(result.entries || []).map((r) => r.id),
                ...(result.sourceEntry ? [result.sourceEntry.id] : [])
              ]
            },
            identity.workspaceId
          );
          ctx.broadcastQueueChange?.(identity.userId, identity.workspaceId);
          // A write grant does not imply permission to read unrelated queue rows,
          // private reports or audit snapshots, including on idempotent replay.
          if (!identity.scopes.includes("dcc.read"))
            result = {
              ok: result.ok,
              ...(result.saveStatus ? { saveStatus: result.saveStatus } : {}),
              sourceEventId: result.sourceEventId,
              ...(result.task?.id ? { taskId: result.task.id } : {}),
              revision: (result.currentState || result.state).revision,
              duplicate: result.duplicate === true
            };
        }
        await oauth.verified(identity.grantId);
        reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        reply({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: e.statusCode ? e.message : wishlistMcp.scopeFor(name) ? "Wishlist request could not be confirmed" : "Activity could not be saved",
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
