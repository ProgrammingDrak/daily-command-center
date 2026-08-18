// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.
//
// The responsibility domain, the server-side slot engine, and the block
// apply-forward engine were extracted to responsibility-store.js (dcc-improvements
// P8); their SQL moved into db.js. This module is now the thin HTTP layer:
// resolve the owner, call a store/db function, broadcast, return JSON. Handlers
// use the shared route() wrapper (lib/route-helpers) instead of hand-rolling a
// try/catch, and resolveOwnerStrict instead of hand-rolling the owner fallback.
//
// ERROR-SHAPE NORMALIZATION (documented, per the P8 brief): route() maps an
// unclassified thrown error to HTTP 500; the old per-handler catch defaulted to
// 400. Every explicit client-error path (validation returns, ownership 404s that
// set err.statusCode) is preserved unchanged — only the default for an
// UNEXPECTED throw shifts 400 -> 500, which is the correct code for a server
// fault. A few handlers keep an explicit try/catch on purpose: the ones that
// enrich errors via apiErrorMessage (freeform-JSON upserts) and apply-forward
// (which logs context + returns 500), because route()'s bare message would drop
// that behavior. reschedule keeps its own handler intact as the atomic-delegation
// reference pattern.

const validate = require("../middleware/validate");
const schemas = require("../middleware/schemas");
const { collectSubtreeBlockIds } = require("../lib/reschedule");
const { resolveOwnerStrict } = require("../middleware/resolve-owner");
const { route } = require("../lib/route-helpers");
const createTaskTiming = require("../lib/task-timing");
const TaskModel = require("../public/js/task-model");
const createMaterializeGuard = require("../lib/materialize-guard");
const { dedupeStatus } = createMaterializeGuard;
const createResponsibilityStore = require("../responsibility-store");
const triageSuppressions = require("../triage-suppressions");
const {
  firstFreeSlot, minutesToHHMM, hhmmToMinutes, taskDuration,
  buildResponsibilityTaskProps, parseOffersAmpAlert,
  normalizeResponsibility, defaultSubtasksForResponsibility,
  DUE_THRESHOLD, writableProps, scheduledRecurrence,
} = require("../responsibility-store");

const completionMetrics = {
  accepted: 0,
  duplicate: 0,
  replayed: 0,
  conflicted: 0,
  rejected: 0,
  legacyFallback: 0,
};

module.exports = function mount(app, ctx) {
  const { APP_TIME_ZONE, blockDB, broadcast, crypto, filterLegacyGcalBlocks, getScheduleBlocks, getTodayStr, isAllowedSweepBlockItem, isValidDate, pool, waitingItems: waitingItemsFromCtx } = ctx;
  const waitingItems = waitingItemsFromCtx || require("../waiting-items");

  // ── Local helpers ──
  function assertBlockOwnership(block, workspaceId) { if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) { const err = new Error("Block not found"); err.statusCode = 404; throw err; } }
  function apiErrorMessage(e) {
    return [e && e.message, e && e.detail, e && e.code].filter(Boolean).join(" · ") || "Request failed";
  }
  const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const activeTaskDependency = row => {
    const props = (row && row.properties) || {};
    return waitingItems.isTaskDependency(props) && !row.deleted_at && ["open", "ready"].includes(props.status || "open");
  };
  function clientError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
  async function taskDependencyContext(props, workspaceId, ignoreWaitingId, client) {
    const blockedId = String(props.linkedBlockId || "").trim();
    const blockerId = String(props.blockerBlockId || "").trim();
    if (!blockedId || !blockerId) throw clientError("Blocked task and prerequisite task are required");
    if (blockedId === blockerId) throw clientError("A task cannot block itself");
    const [blocked, blocker, rows] = await Promise.all([
      blockDB.findUniqueLiveBlockByReference(blockedId, workspaceId, client, !!client),
      blockDB.findUniqueLiveBlockByReference(blockerId, workspaceId, client, !!client),
      blockDB.getDelegatedItems(workspaceId, client),
    ]);
    if (!blocked || !blocker) throw clientError("Linked task not found", 404);
    assertBlockOwnership(blocked, workspaceId);
    assertBlockOwnership(blocker, workspaceId);
    if (!blockDB.isTaskRow(blocked) || !blockDB.isTaskRow(blocker)) throw clientError("Both sides of a dependency must be tasks");
    if (isCompleted(blocked)) throw clientError("A completed task cannot be blocked");
    if (isCompleted(blocker)) throw clientError("Choose an open prerequisite task");

    const active = rows.filter(activeTaskDependency).filter(row => row.id !== ignoreWaitingId);
    if (active.some(row => String((row.properties || {}).linkedBlockId) === blocked.id
      && String((row.properties || {}).blockerBlockId) === blocker.id)) {
      throw clientError("That dependency already exists", 409);
    }
    const outgoing = new Map();
    for (const row of active) {
      const relation = row.properties || {};
      const from = String(relation.blockerBlockId || "");
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(String(relation.linkedBlockId || ""));
    }
    const seen = new Set();
    const stack = [blocked.id];
    while (stack.length) {
      const current = stack.pop();
      if (current === blocker.id) throw clientError("That link would create a dependency cycle", 409);
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of outgoing.get(current) || []) stack.push(next);
    }
    const subtree = await blockDB.getSubtree([blocked.id], workspaceId, client);
    const blockedTree = subtree.length ? subtree : [blocked];
    if (blockedTree.some(row => String(row.id) === String(blocker.id))) {
      throw clientError("A task inside the blocked task cannot be its prerequisite", 409);
    }
    return { blocked, blocker, subtree: blockedTree };
  }
  async function setDependencyMarker(rows, waitingId, client) {
    const ids = [];
    for (const row of rows) {
      const properties = { ...(row.properties || {}) };
      const current = Array.isArray(properties.dependencyWaitingItemIds)
        ? properties.dependencyWaitingItemIds.map(String)
        : (properties.dependencyWaitingItemId ? [String(properties.dependencyWaitingItemId)] : []);
      const next = waitingId ? [...new Set(current.concat(String(waitingId)))] : [];
      if (next.length) {
        properties.dependencyWaitingItemIds = next;
        properties.dependencyWaitingItemId = next[0];
      } else {
        delete properties.dependencyWaitingItemIds;
        delete properties.dependencyWaitingItemId;
      }
      await blockDB.updateBlock(row.id, { properties, date: waitingId ? null : row.date }, client);
      ids.push(row.id);
    }
    return ids;
  }

  // The responsibility domain + slot engine + apply-forward engine live in
  // responsibility-store.js; instantiate it here with the server-scope deps.
  const respStore = createResponsibilityStore({ blockDB, getScheduleBlocks, getTodayStr, assertBlockOwnership, appTimeZone: ctx.APP_TIME_ZONE });

  // The shared no-resurrection contract (lib/materialize-guard.js). Used here by the
  // task-group schedule route; routes/dcc.js and meeting-materializer.js hold the
  // other consumers.
  const materializeGuard = createMaterializeGuard({ blockDB });

  // ── E1 (Track E: Slack Reactions) — DECLARED OVERLAP, two read call sites ──
  // A ⏳ timer started from Slack could only ever be closed by the ✅ reaction, so
  // checking the task off anywhere else recorded no time. reconcileTiming derives
  // the close on read: any done row still carrying a startedAt with no
  // actualMinutes gets finalized. In-memory candidate filter first, so a day with
  // no orphaned timer costs zero queries. See lib/task-timing.js.
  const taskTiming = createTaskTiming({ pool, blockDB, timeZone: ctx.APP_TIME_ZONE });
  const { reconcileTiming, startWork, pauseWork, completeWork, reopenWork } = taskTiming;

  async function syncSlack(blockOrId) {
    if (typeof ctx.syncSlackTaskReactions !== "function") return;
    try { await ctx.syncSlackTaskReactions(blockOrId); }
    catch (error) { console.error("[blocks] Slack reaction sync failed (non-fatal):", error.message); }
  }

  function isWorkTaskRow(block) {
    const props = (block && block.properties) || {};
    return !!block && (TaskModel.foldsIntoItinerary(block)
      || (TaskModel.isTaskRow(block) && props.kind === "backlog"));
  }

  async function stampSlackDeleteBoundary(block, atMs, client) {
    const props = (block && block.properties) || {};
    if (!block || block.deleted_at || props.source !== "slack-bookmark") return block;
    const nextProps = { ...props, slackBookmarkChangedAt: new Date(atMs).toISOString() };
    const written = await blockDB.updateBlock(block.id, { properties: nextProps }, client);
    block.properties = (written && written.properties) || nextProps;
    return block;
  }

  async function normalizeCompletionWork(result, completed, { atMs, actor, mutationId } = {}) {
    if (!result || result.persistenceTarget !== "task_row") return result;
    const initial = Array.isArray(result.affectedTasks) && result.affectedTasks.length
      ? result.affectedTasks
      : (result.task ? [result.task] : []);
    const refreshed = [];
    for (const row of initial) {
      if (!row || row.type !== "block" || row.deleted_at) continue;
      const actionId = mutationId ? `${mutationId}:${row.id}` : null;
      if (completed) await completeWork({ block: row, atMs, actor, actionId, normalizeExisting: true });
      else await reopenWork({ block: row, atMs, actor, actionId });
      const fresh = await blockDB.getBlockIncludingDeleted(row.id);
      if (fresh) refreshed.push(fresh);
    }
    if (refreshed.length) {
      result.affectedTasks = refreshed;
      const targetId = result.task && result.task.id;
      result.task = refreshed.find(row => row.id === targetId) || result.task;
    }
    return result;
  }

  function isCompleted(block) {
    const props = (block && block.properties) || {};
    return props.status === "done" || props.done === true || !!props.completedAt;
  }

  // The itinerary task is the durable lifecycle handle for a scheduled Sweep item.
  // Completion upgrades its placement link to done, reopen restores scheduled, and
  // deleting unfinished work releases only the placement link back to triage.
  async function transitionLinkedTriage(block, reason, atMs) {
    const props = (block && block.properties) || {};
    const triageId = String(props.triageId || props.triage_id || "").trim();
    if (!triageId || typeof blockDB.getBlocksByKind !== "function") return null;
    const workspaceId = block.workspace_id || null;
    const rows = await blockDB.getBlocksByKind(triageSuppressions.SUPPRESSION_KIND, workspaceId);
    const active = rows
      .map((row) => ({ row, suppression: triageSuppressions.suppressionFromBlock(row) }))
      .filter(({ suppression }) => suppression && suppression.active && suppression.triage_id === triageId);
    if (reason === "release") {
      let released = 0;
      for (const { row, suppression } of active) {
        if (suppression.reason !== "scheduled") continue;
        await blockDB.updateBlock(row.id, {
          properties: { ...(row.properties || {}), active: false, reopenedAt: new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString() },
        });
        released += 1;
      }
      if (released) broadcast("dcc-state-changed", { source: "triage-suppression", action: "remove" }, workspaceId);
      return released;
    }
    const deleted = active.find(({ suppression }) => suppression.reason === "deleted");
    if (deleted) return deleted.suppression;
    const nextReason = reason === "scheduled" ? "scheduled" : "done";
    const at = new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString();
    if (active.length) {
      let last = null;
      for (const { row } of active) {
        const nextProps = {
          ...(row.properties || {}), reason: nextReason, at,
          task_id: String(props.local_id || block.id || "").slice(0, 300),
          scheduled_for: String(block.date || "").slice(0, 80), active: true,
        };
        last = await blockDB.updateBlock(row.id, { properties: nextProps });
      }
      const suppression = triageSuppressions.suppressionFromBlock(last);
      broadcast("dcc-state-changed", { source: "triage-suppression", action: "update" }, workspaceId);
      return suppression;
    }
    const created = await blockDB.createBlock({
      type: "block",
      properties: triageSuppressions.buildSuppressionProperties({
        triageId, key: String(props.triageKey || ""), itemTitle: props.triageTitle || props.title || "",
        reason: nextReason, at, taskId: props.local_id || block.id, scheduledFor: block.date || "",
        itemSnapshot: {
          id: triageId, title: props.triageTitle || props.title || "", type: props.triageType || "",
          source_ref: props.triageSourceRef || "", received_at: props.triageReceivedAt || "",
          conversation_id: props.triageConversationId || "",
        },
      }),
      user_id: block.user_id || null,
      workspace_id: workspaceId,
    });
    const suppression = triageSuppressions.suppressionFromBlock(created);
    broadcast("dcc-state-changed", { source: "triage-suppression", action: "add" }, workspaceId);
    return suppression;
  }
  // Never let a read fail on a reconcile: the itinerary must still render.
  async function withReconciledTiming(blocks, req) {
    try { await reconcileTiming(blocks, { userId: req.session && req.session.userId, workspaceId: req.workspaceId }); }
    catch (e) { console.error("[blocks] timing reconcile failed (non-fatal):", e.message); }
    return blocks;
  }

  // ── A3: idempotency on the generic create paths ──────────────────────────
  //
  // POST /api/blocks and POST /api/blocks/batch were the last create paths with no
  // idempotency handling at all: routes/dcc.js honors a key on all three of its
  // writers, and these two would happily mint a second row for a request the server
  // had already committed. That is the duplicate every agent retry and every WAL
  // replay produces today.
  //
  // Goes through lib/materialize-guard.js rather than db.findByIdempotencyKey
  // directly, because A2 made that module the single home for "a soft-deleted match
  // is STILL a match". A fourth hand-rolled copy of that rule is exactly what A2
  // removed. Its lookup is deliberately DATE-BLIND, which agrees with A3's unique
  // index: a key is workspace-global identity, not a per-day one.
  //
  // Inert for a request carrying no key, which is the overwhelming majority.
  //
  // NOT "every client create", and the difference matters: two live UI paths already
  // send one, both predating this phase. public/js/responsibilities.js sends
  // `resp:<id>:<date>` on a flat responsibility complete and public/js/schedule.js
  // sends `resp-shell:<id>:<date>` on shell materialization, both through
  // schedulePickerFields -> persistAddedTask -> blockStore.createBlock -> POST
  // /api/blocks. So this phase flips those two from unhandled to deduped.
  //
  // That is what those keys MEAN — `resp:<id>:<date>` is an identity claim of one
  // instance per responsibility per day, and D1's one-open-instance work already
  // suppresses the second — but it IS a behavior change on a live path, not a no-op.
  // The residual: on a genuine same-day repeat the server now answers with the first
  // row while the client has already rendered a second item under a fresh local id,
  // so the UI shows a ghost until reload. Fixing that means teaching the client to
  // drop its optimistic row when the response comes back `_dedupe`, which is
  // public/js/responsibilities.js and schedule.js — Track C's files. Handed over.
  function idemKeyOf(item) {
    if (!item) return null;
    const props = typeof item.properties === "string" ? safeParseProps(item.properties) : (item.properties || {});
    // snake_case only — see db.js createBlock. Accepting `idempotencyKey` in the
    // properties bag would dedupe at the route with no unique index behind it.
    const key = props.idempotency_key || null;
    return key ? String(key) : null;
  }
  function safeParseProps(raw) { try { return JSON.parse(raw) || {}; } catch { return {}; } }

  function completionRetryable(status) {
    return status === 401 || status === 403 || status >= 500;
  }

  function logCompletion(req, fields) {
    const record = {
      event: "task_completion",
      at: new Date().toISOString(),
      workspaceId: req.workspaceId || null,
      userId: req.session && req.session.userId || null,
      ...fields,
      metrics: { ...completionMetrics },
    };
    console.log("[task-completion] " + JSON.stringify(record));
  }

  // ★ LIVE MATCHES ONLY, and this is the one place in the codebase where that is the
  // right reading of a key. Everywhere else — routes/dcc.js's three writers, the
  // meeting materializer, the task-group guard — a tombstone is still a match, because
  // those callers are AGENTS re-deriving an item the user already removed, and
  // re-creating it is the resurrection bug lib/materialize-guard.js exists to stop.
  //
  // These two routes are the human client's own write path, and there a keyed create
  // whose only match is a tombstone means RESTORE, not resurrect. Concretely:
  // public/js/state.js undoDeleteTask replays the deleted subtree as
  // `{op:"create", ..., properties: r.properties}` with the original properties bag,
  // idempotency_key included. Skipping on the tombstone would find the tombstone OF THE
  // VERY ROW BEING RESTORED, create nothing, and hand the client back a dead id — undo
  // silently failing on every task carrying a key (199 of 3,106 rows on the prod
  // restore: slack-bookmark, day-review, quick-task, and now task groups).
  //
  // The safe direction is also the simple one: these routes deduped on NOTHING before
  // this phase, so a live-match skip is strictly better than main and a tombstone skip
  // would be strictly worse. Never make a route worse than the version you found.
  //
  // B2 replaces that undo with POST /:id/undelete, which is the real fix; this stays
  // correct either way, because a restore through /undelete never reaches a create.
  // `seen` defaults to null rather than a shared Map: a module-scope Map used as a
  // default arg is one `seen.set` away from becoming a process-lifetime cache keyed by
  // idempotency key with no workspace in the key — a cross-tenant leak with nothing to
  // catch it. Every other seen-map in this repo is function-local; keep it that way.
  async function resolveIdempotentCreate(workspaceId, item, seen = null, { tombstoneIsAMatch = false } = {}) {
    const key = idemKeyOf(item);
    if (!key) return { key: null, existing: null };
    // `seen` carries keys minted EARLIER IN THIS SAME REQUEST: findForDedupe reads
    // through the pool, so inside a batch's open transaction it cannot see rows this
    // very request just inserted, and two items sharing a key would both pass the
    // lookup and then collide on the index.
    if (seen && seen.has(key)) return { key, existing: seen.get(key) };
    const hit = await materializeGuard.findForDedupe(workspaceId, { idempotencyKey: key });
    if (!hit) return { key, existing: null };
    return { key, existing: (tombstoneIsAMatch || !hit.deleted_at) ? hit : null };
  }

  // The answer a matched key produces: the row itself, which is what an idempotent
  // create MEANS — same request, same result. The verdict string comes from the shared
  // dedupeStatus() rather than being re-derived here, so this endpoint cannot drift
  // from the vocabulary routes/dcc.js already answers with. HTTP stays 200: a new
  // status code is one Track B's replay classifier would read as transient and retry
  // forever.
  function markDeduped(row) {
    const { _resolvedExisting, ...rest } = row;
    return { ...rest, _dedupe: dedupeStatus(row) };
  }

  // A dedupe answer is a row the CALLER DID NOT SUPPLY, so a scope-limited token has
  // to be re-authorized against it. The sweep gate on the handler below validates the
  // item being CREATED (`isAllowedSweepBlockItem`); without this, honoring a key would
  // hand a write-only Sweep Suite token any row in the workspace it names, just by
  // guessing that row's key — and several key vocabularies are guessable to a
  // semi-insider (`slack-bookmark:<channel>:<ts>` is readable off any Slack message,
  // and `day-review:<date>:<id>` / `tg:<group>:<date>:<i>` are structured). It would
  // also read back tombstones, which A2 deliberately made GET /:id 404 on.
  //
  // 404 rather than 403, matching assertBlockOwnership: the fact being withheld is
  // that a row with this key exists at all.
  function assertServiceScope(req, row) {
    if (!req.dccServiceAuth || isAllowedSweepBlockItem(row)) return;
    const err = new Error("Block not found");
    err.statusCode = 404;
    throw err;
  }

  // ── Block API ──
  app.post("/api/blocks", validate(schemas.blockCreate), route(async (req, res) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    if (items.some(item => waitingItems.isTaskDependency(
      typeof (item && item.properties) === "string" ? safeParseProps(item.properties) : ((item && item.properties) || {})
    ))) {
      res.status(409).json({ error: "Create task dependencies through the Waiting API" });
      return;
    }
    if (req.dccServiceAuth && !items.every(isAllowedSweepBlockItem)) { res.status(403).json({ error: "Sweep Suite token may only create sweep_suite_task blocks" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const results = [];
    const createdIds = [];
    const seen = new Map();
    // A SERVICE TOKEN IS AN AGENT, so the no-resurrect rule still binds it here. This
    // endpoint is BOTH the human client's write path (persistAddedTask) and the Sweep
    // Suite token's ONLY reachable write, and the two want opposite answers to the same
    // tombstone: a person re-creating a keyed row is restoring it, a sweep replaying
    // the same key is re-deriving something the user deliberately deleted — the exact
    // caller class lib/materialize-guard.js exists for. `req.dccServiceAuth` is the
    // discriminator, and it costs nothing to use it.
    // (/api/blocks/batch needs no such split: no attach site in server.js routes to
    // it — there are FIVE, not one, and none is /api/blocks/batch — so it is
    // session-only and stays live-only for undo.)
    const agentRules = { tombstoneIsAMatch: !!req.dccServiceAuth };
    try {
      for (const item of items) {
        const { key, existing } = await resolveIdempotentCreate(workspaceId, item, seen, agentRules);
        if (existing) { assertServiceScope(req, existing); results.push(markDeduped(existing)); continue; }
        const row = await blockDB.createBlock({ ...item, user_id: userId, workspace_id: workspaceId });
        if (key) seen.set(key, row);
        // db.createBlock answers a lost race itself — the index caught a writer that
        // committed between our lookup and our insert, and it re-read the winner. Say so
        // in the response and keep the id out of the broadcast, exactly as for a match
        // the lookup found: nothing was created either way. Scope-checked for the same
        // reason: the winner is another writer's row and may be another writer's kind.
        if (row._resolvedExisting) { assertServiceScope(req, row); results.push(markDeduped(row)); continue; }
        results.push(row);
        createdIds.push(row.id);
      }
    } finally {
      // IN A FINALLY, because this loop is not a transaction. Each item autocommits, so
      // by the time a later item throws — assertServiceScope on a foreign dedupe hit,
      // or any db error — the earlier rows ARE in the database. Announcing them on the
      // way out is not tidiness: a create nobody broadcast is invisible to every other
      // tab and device until a reload, while the caller was told the request failed.
      //
      // Only ids this request actually created. Broadcasting a "create" for a deduped
      // row would make every other tab re-fetch a row that did not change.
      if (createdIds.length) broadcast("blocks-changed", { action: "create", blockIds: createdIds, clientId: body._clientId }, workspaceId);
    }
    return results.length === 1 ? results[0] : results;
  }));

  // Completion is a state transition, not a full-document block edit. This route is
  // the single durable boundary used by every browser completion surface.
  app.post("/api/tasks/:taskRef/completion", async (req, res) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    res.setHeader("X-Request-Id", requestId);
    const body = req.body || {};
    try {
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const result = await blockDB.setTaskCompletion({
        taskRef: req.params.taskRef,
        completed: body.completed,
        completedAt: body.completedAt || null,
        taskDate: body.taskDate || null,
        mutationId: body.mutationId,
        expectedRevision: body.expectedRevision ?? null,
        userId,
        workspaceId,
      });
      const recordedMs = Number.isFinite(Date.parse(body.completedAt || ""))
        ? Date.parse(body.completedAt)
        : Date.now();
      await normalizeCompletionWork(result, body.completed, {
        atMs: recordedMs,
        actor: userId ? `dcc:${userId}` : "dcc",
        mutationId: body.mutationId,
      });
      if (result.duplicate) completionMetrics.duplicate++;
      else if (body._replay) completionMetrics.replayed++;
      else completionMetrics.accepted++;
      if (result.persistenceTarget === "legacy_overlay") completionMetrics.legacyFallback++;
      if (result.task) await transitionLinkedTriage(result.task, isCompleted(result.task) ? "done" : "scheduled", Date.parse(body.completedAt || ""));
      const blockIds = result.broadcastIds || (result.task && result.task.id ? [result.task.id] : []);
      if (blockIds.length) {
        broadcast("blocks-changed", {
          action: "completion", blockIds, clientId: body._clientId,
          mutationId: body.mutationId, dependencyTransitions: result.dependencyTransitions || [],
        }, workspaceId);
      }
      for (const row of result.affectedTasks || []) await syncSlack(row);
      logCompletion(req, {
        requestId, mutationId: body.mutationId || null, taskRef: req.params.taskRef,
        resolvedTaskId: result.task && result.task.id || null, taskDate: body.taskDate || null,
        persistenceTarget: result.persistenceTarget, result: result.duplicate ? "duplicate" : "accepted",
        affectedCount: (result.affectedTasks || []).length, durationMs: Date.now() - startedAt,
      });
      res.json({
        ok: true, mutationId: body.mutationId, persistenceTarget: result.persistenceTarget,
        task: result.task, affectedTasks: result.affectedTasks || [], revision: result.revision,
        duplicate: !!result.duplicate, requestId, dependencyTransitions: result.dependencyTransitions || [],
      });
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      if (status === 409) completionMetrics.conflicted++; else completionMetrics.rejected++;
      logCompletion(req, {
        requestId, mutationId: body.mutationId || null, taskRef: req.params.taskRef,
        taskDate: body.taskDate || null, result: status === 409 ? "conflicted" : "rejected",
        code: error.publicCode || "COMPLETION_FAILED", status, durationMs: Date.now() - startedAt,
      });
      res.status(status).json({
        error: error.message,
        code: error.publicCode || "COMPLETION_FAILED",
        retryable: completionRetryable(status),
        requestId,
        ...(error.currentTask ? { currentTask: error.currentTask } : {}),
      });
    }
  });

  app.post("/api/blocks/:id/work", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if (!isWorkTaskRow(existing)) {
      res.status(409).json({ error: "This row is not a trackable task", code: "WORK_NOT_TRACKABLE" });
      return;
    }
    const body = req.body || {};
    if (body.action !== "start" && body.action !== "pause") {
      res.status(400).json({ error: "action must be start or pause" });
      return;
    }
    if (body.actionId != null && !/^[A-Za-z0-9:_-]{1,160}$/.test(String(body.actionId))) {
      res.status(400).json({ error: "Invalid work action id" });
      return;
    }
    const atMs = body.at == null ? Date.now() : Date.parse(body.at);
    if (!Number.isFinite(atMs)) { res.status(400).json({ error: "at must be an ISO timestamp" }); return; }
    const actor = req.session && req.session.userId ? `dcc:${req.session.userId}` : "dcc";
    const operation = body.action === "start" ? startWork : pauseWork;
    const result = await operation({ block: existing, atMs, actor, actionId: body.actionId || null });
    const block = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (result.reason === "not-trackable") {
      res.status(409).json({ error: "This task type does not track active work", code: "WORK_NOT_TRACKABLE" });
      return;
    }
    if (result.reason === "completed") {
      res.status(409).json({ error: "Completed work must be reopened before it can be started", code: "WORK_ALREADY_COMPLETED" });
      return;
    }
    broadcast("blocks-changed", {
      action: "work", workAction: body.action, blockIds: [req.params.id], clientId: body._clientId,
    }, req.workspaceId);
    await syncSlack(block);
    return { ok: true, changed: !!result.changed, reason: result.reason || null, block };
  }));

  app.get("/api/blocks/:id/work", route(async (req, res) => {
    const block = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!block || block.deleted_at) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(block, req.workspaceId);
    if (!isWorkTaskRow(block)) {
      res.status(409).json({ error: "This row is not a trackable task", code: "WORK_NOT_TRACKABLE" });
      return;
    }
    const sessions = await taskTiming.getSessions(block, { workspaceId: req.workspaceId });
    return { block, sessions };
  }));

  // The mutation routes below fetch TOMBSTONE-INCLUDED on purpose, and say so by
  // calling getBlockIncludingDeleted rather than getBlock. The two db functions behave
  // identically today (getBlock never filtered deleted_at), so this is a statement of
  // contract, not a behavior change: these call sites want the deleted row, because a
  // repeat DELETE must stay idempotent and because updateBlock's own "Block is deleted"
  // is the error the caller should see — not a 404 that reads as "never existed".
  // Authorization must also not be skippable by deleting a row first.
  app.patch("/api/blocks/:id", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const requestedProps = typeof (req.body && req.body.properties) === "string"
      ? safeParseProps(req.body.properties) : ((req.body && req.body.properties) || {});
    if (waitingItems.isTaskDependency(existing)
        || waitingItems.isTaskDependency(requestedProps)) {
      res.status(409).json({ error: "Update task dependencies through the Waiting API" });
      return;
    }
    // Compatibility window for already-open clients and their old WAL entries.
    // Ignore the stale full properties snapshot and delegate only the completion
    // intent to the same narrow transaction as the dedicated endpoint.
    if (req.body && req.body.completionIntent) {
      if (!Object.prototype.hasOwnProperty.call(req.body, "completionBaseRevision")) {
        res.status(400).json({
          error: "completionBaseRevision is required for completion transitions",
          code: "COMPLETION_BASE_REQUIRED",
        });
        return;
      }
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const props = typeof req.body.properties === "string"
        ? safeParseProps(req.body.properties) : (req.body.properties || {});
      const mutationId = req.body.completionMutationId || crypto.randomUUID();
      const result = await blockDB.setTaskCompletion({
        taskRef: req.params.id,
        completed: req.body.completionIntent === "complete",
        completedAt: props.completedAt || props.doneAt || null,
        taskDate: req.body.date || existing.date || null,
        mutationId,
        expectedRevision: req.body.completionBaseRevision,
        userId,
        workspaceId,
      });
      const recordedMs = Number.isFinite(Date.parse(props.completedAt || props.doneAt || ""))
        ? Date.parse(props.completedAt || props.doneAt)
        : Date.now();
      await normalizeCompletionWork(result, req.body.completionIntent === "complete", {
        atMs: recordedMs,
        actor: userId ? `dcc:${userId}` : "dcc",
        mutationId,
      });
      if (result.task) await transitionLinkedTriage(result.task, isCompleted(result.task) ? "done" : "scheduled", Date.parse(props.completedAt || props.doneAt || ""));
      const blockIds = result.broadcastIds || [req.params.id];
      broadcast("blocks-changed", {
        action: "completion", blockIds, clientId: req.body._clientId, mutationId,
        dependencyTransitions: result.dependencyTransitions || [],
      }, workspaceId);
      for (const row of result.affectedTasks || []) await syncSlack(row);
      return result.task;
    }
    const result = await blockDB.updateBlock(req.params.id, req.body);
    if (!isCompleted(existing) && isCompleted(result)) await transitionLinkedTriage(result, "done", Date.now());
    else if (isCompleted(existing) && !isCompleted(result)) await transitionLinkedTriage(result, "scheduled", Date.now());
    broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId }, req.workspaceId);
    await syncSlack(result);
    return result;
  }));

  app.delete("/api/blocks/:id", route(async (req, res) => {
    let existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    let result;
    let props = existing.properties || {};
    const closedDependencyIds = [];
    const releasedDependencyTaskIds = [];
    // A tombstone cannot acquire a new dependency because dependency creation only
    // accepts live tasks. Keep repeat DELETE idempotent without requiring a transaction.
    // Non-task rows are likewise outside the dependency graph by construction.
    const dependencyAware = !existing.deleted_at && TaskModel.isTaskRow(existing);
    const client = dependencyAware ? await pool.connect() : null;
    try {
      if (client) {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-dependencies:${req.workspaceId || "global"}`]);
      }
      const waitingRows = dependencyAware ? await blockDB.getDelegatedItems(req.workspaceId, client) : [];
      const blocking = waitingRows.filter(activeTaskDependency)
        .filter(row => String((row.properties || {}).blockerBlockId) === String(existing.id));
      if (blocking.length) {
        throw clientError(`This task unlocks ${blocking.length} other task${blocking.length === 1 ? "" : "s"}. Change or remove those dependencies first.`, 409);
      }
      const dependentRelations = waitingRows.filter(activeTaskDependency)
        .filter(row => String((row.properties || {}).linkedBlockId) === String(existing.id));

      const deleteAt = Date.now();
      await stampSlackDeleteBoundary(existing, deleteAt);
      if (props.startedAt) {
        await pauseWork({ block: existing, atMs: deleteAt, actor: "dcc:delete", actionId: `delete:${existing.id}:${existing.updated_at || props.startedAt}` });
      }
      if (client) {
        existing = await blockDB.getBlockIncludingDeleted(req.params.id, client, true);
        if (!existing) throw clientError("Block not found", 404);
        assertBlockOwnership(existing, req.workspaceId);
        props = existing.properties || {};
      }

      if (props.kind === "responsibility_item" && props.repeatType === "scheduled") {
        result = await respStore.changeScheduledSeries({
          id: req.params.id,
          workspaceId: req.workspaceId,
          userId: req.session && req.session.userId,
          action: "delete",
          scope: "series",
        });
      } else if (dependentRelations.length) {
        const subtree = await blockDB.getSubtree([existing.id], req.workspaceId, client);
        const activeRelationIds = new Set(dependentRelations.map(row => String(row.id)));
        for (const row of (subtree.length ? subtree : [existing])) {
          const next = { ...(row.properties || {}) };
          const remaining = (Array.isArray(next.dependencyWaitingItemIds)
            ? next.dependencyWaitingItemIds : [next.dependencyWaitingItemId]).filter(Boolean)
            .map(String).filter(id => !activeRelationIds.has(id));
          if (remaining.length) {
            next.dependencyWaitingItemIds = remaining;
            next.dependencyWaitingItemId = remaining[0];
          } else {
            delete next.dependencyWaitingItemIds;
            delete next.dependencyWaitingItemId;
          }
          await blockDB.updateBlock(row.id, { properties: next }, client);
          releasedDependencyTaskIds.push(row.id);
        }
        for (const relation of dependentRelations) {
          const at = new Date().toISOString();
          await blockDB.updateBlock(relation.id, { properties: waitingItems.normalizeProperties({
            status: "done", completedAt: at, closureReason: "dependent-deleted", snoozedUntil: null,
          }, relation.properties || {}) }, client);
          closedDependencyIds.push(relation.id);
        }
        result = await blockDB.deleteBlock(req.params.id, client);
      } else {
        result = await blockDB.deleteBlock(req.params.id, client || undefined);
      }
      if (client) await client.query("COMMIT");
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* preserve delete error */ }
      }
      throw error;
    } finally {
      if (client) client.release();
    }
    await transitionLinkedTriage(existing, "release", Date.now());
    broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id].concat(closedDependencyIds, releasedDependencyTaskIds), clientId: req.query._clientId }, req.workspaceId);
    await syncSlack({ ...existing, deleted_at: result.deleted_at || new Date().toISOString(), properties: existing.properties || props });
    return result;
  }));

  // Clear a tombstone: the server half of undo. B1 (#256) made deletion immediate and
  // replaced the 8-second client timer with a server call, which is what lets an undo
  // survive a reload or a device switch — but the call had nothing to reach until now.
  //
  // db.undeleteBlock takes no workspaceId and does no tenant check (matching
  // deleteBlock/updateBlock — this repo authorizes at the route layer), so the fetch +
  // assertBlockOwnership here is the ONLY thing standing between a caller and any row
  // in any workspace. It must stay above the call, and it must be the tombstone-inclusive
  // fetch: the row we are restoring is deleted by definition, so GET-style filtering
  // would 404 every legitimate undo.
  //
  // Idempotent, because db.undeleteBlock is: undeleting a live row returns it unchanged.
  app.post("/api/blocks/:id/undelete", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const result = await blockDB.undeleteBlock(req.params.id);
    if (!isCompleted(result)) await transitionLinkedTriage(result, "scheduled", Date.now());
    // `undeletedIds` is the signal Track B asked for: block-store.js keeps a local
    // _tombstones set that makes handleBlocksChanged SKIP re-fetching an id it believes
    // is deleted, so a restore performed in another tab would stay invisible until a
    // reload unless the client can see which ids to un-tombstone. Carried separately
    // from blockIds so a handler can act on it without parsing `action`.
    broadcast("blocks-changed", {
      action: "undelete",
      blockIds: [req.params.id],
      undeletedIds: [req.params.id],
      clientId: (req.body && req.body._clientId) || undefined,
    }, req.workspaceId);
    await syncSlack(result);
    return result;
  }));

  app.post("/api/blocks/batch", route(async (req, res) => {
    const { operations, _clientId } = req.body;
    if (!Array.isArray(operations)) { res.status(400).json({ error: "operations must be an array" }); return; }
    const batchCompletion = operations.some(op => op && op.op === "update" && op.completionIntent);
    if (batchCompletion) {
      res.status(409).json({
        error: "Complete tasks through the task completion endpoint",
        code: "COMPLETION_ENDPOINT_REQUIRED",
      });
      return;
    }
    const { userId, workspaceId } = await resolveOwnerStrict(req);

    for (const op of operations) {
      if (!op || typeof op !== "object") continue;
      const opProps = typeof op.properties === "string" ? safeParseProps(op.properties) : (op.properties || {});
      if ((op.op === "create" || op.op === "update") && waitingItems.isTaskDependency(opProps)) {
        res.status(409).json({ error: "Mutate task dependencies through the Waiting API" });
        return;
      }
      if ((op.op === "update" || op.op === "delete") && op.id) {
        const target = await blockDB.getBlockIncludingDeleted(op.id);
        if (target && waitingItems.isTaskDependency(target)) {
          res.status(409).json({ error: "Mutate task dependencies through the Waiting API" });
          return;
        }
      }
    }

    // AUTHORIZE every block id this batch REFERENCES, before batchOp opens its
    // transaction. update / delete / reorder arrive with caller-supplied ids and were
    // previously passed straight through, so an authenticated session could
    // soft-delete or mutate any block in ANY workspace by posting a batch. Every
    // sibling route (PATCH, DELETE, GET /:id, /reorder) already checks this; batch was
    // the one gap, and it stopped being dormant when the client's canonical delete
    // path moved onto /batch.
    //
    // `parent_id` counts, and on CREATE too. Stamping our own workspace_id onto a
    // create does not make it harmless: parent_id is a reference to a row we may not
    // own, and db.reorderBlocks' rebalance selects siblings by parent_id. So two
    // creates parented onto another workspace's day_root plus one reorder with equal
    // sort_orders would trip needsRebalance and renumber that whole foreign subtree.
    // Verified end to end before this guard existed: HTTP 200, and the victim's
    // itinerary order was rewritten. Day-root ids are `day-root-<workspace>-<date>`,
    // so a target needs no reconnaissance. (db.reorderBlocks is also scoped now, so
    // this is belt and braces, but the reference itself does not belong here.)
    //
    // Tombstone-inclusive on purpose: a repeat delete of an already-deleted row must
    // stay idempotent rather than 404, and updateBlock's own "Block is deleted" error
    // must remain the one the caller sees. An id that resolves to nothing is not
    // pre-rejected (same `if (block)` shape as /reorder below); batchOp owns that
    // case and raises its own "Block not found".
    for (const op of operations) {
      if (!op || typeof op !== "object") continue;
      const ids = [];
      if (op.op === "reorder") {
        if (Array.isArray(op.items)) for (const item of op.items) if (item && item.id) ids.push(item.id);
      } else if (op.op !== "create" && op.id) {
        ids.push(op.id);
      }
      if (op.parent_id) ids.push(op.parent_id);
      for (const id of ids) {
        const block = await blockDB.getBlockIncludingDeleted(id);
        if (block) assertBlockOwnership(block, workspaceId);
      }
    }

    const opsWithUser = operations.map(op => op && op.op === "create" ? { ...op, user_id: userId, workspace_id: workspaceId } : op);
    const deletedBlocks = [];
    for (const op of opsWithUser) {
      if (!op || op.op !== "delete" || !op.id) continue;
      const block = await blockDB.getBlockIncludingDeleted(op.id);
      if (block) deletedBlocks.push(block);
    }
    let batchOps = opsWithUser;
    let publicResultIndexes = null;
    const dependencyBroadcastIds = [];
    let dependencyClient = null;
    const dependencyDeletes = deletedBlocks.filter(block => !block.deleted_at && TaskModel.isTaskRow(block));
    if (dependencyDeletes.length) {
      dependencyClient = await pool.connect();
      try {
        await dependencyClient.query("BEGIN");
        await dependencyClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-dependencies:${workspaceId || "global"}`]);
        const deleteIds = new Set(dependencyDeletes.map(block => String(block.id)));
        const activeDependencies = (await blockDB.getDelegatedItems(workspaceId, dependencyClient)).filter(activeTaskDependency);
        const blocking = activeDependencies.filter(relation => {
          const p = relation.properties || {};
          return deleteIds.has(String(p.blockerBlockId)) && !deleteIds.has(String(p.linkedBlockId));
        });
        if (blocking.length) {
          throw clientError("A task in this delete still unlocks another task. Remove that dependency first.", 409);
        }

        const relationsByDependent = new Map();
        for (const relation of activeDependencies) {
          const linkedId = String((relation.properties || {}).linkedBlockId || "");
          if (!deleteIds.has(linkedId)) continue;
          if (!relationsByDependent.has(linkedId)) relationsByDependent.set(linkedId, []);
          relationsByDependent.get(linkedId).push(relation);
        }
        const expanded = [];
        const publicIndexes = [];
        const updatedTaskIds = new Set();
        const closedRelationIds = new Set();
        for (const op of opsWithUser) {
          if (op && op.op === "delete" && op.id && relationsByDependent.has(String(op.id))) {
            for (const relation of relationsByDependent.get(String(op.id))) {
              const subtree = await blockDB.getSubtree([op.id], workspaceId, dependencyClient);
              for (const row of subtree) {
                if (updatedTaskIds.has(row.id)
                    || String((row.properties || {}).dependencyWaitingItemId || "") !== String(relation.id)) continue;
                const properties = { ...(row.properties || {}) };
                delete properties.dependencyWaitingItemId;
                expanded.push({ op: "update", id: row.id, properties });
                updatedTaskIds.add(row.id);
                dependencyBroadcastIds.push(row.id);
              }
              if (!closedRelationIds.has(relation.id)) {
                const at = new Date().toISOString();
                expanded.push({ op: "update", id: relation.id, properties: waitingItems.normalizeProperties({
                  status: "done", completedAt: at, closureReason: "dependent-deleted", snoozedUntil: null,
                }, relation.properties || {}) });
                closedRelationIds.add(relation.id);
                dependencyBroadcastIds.push(relation.id);
              }
            }
          }
          publicIndexes.push(expanded.length);
          expanded.push(op);
        }
        batchOps = expanded;
        publicResultIndexes = publicIndexes;
        for (const block of dependencyDeletes) {
          const deleteAt = Date.now();
          await stampSlackDeleteBoundary(block, deleteAt);
          if ((block.properties || {}).startedAt) {
            await pauseWork({ block, atMs: deleteAt, actor: "dcc:delete", actionId: `batch-delete:${block.id}:${block.updated_at || (block.properties || {}).startedAt}` });
          }
        }
        for (const block of dependencyDeletes) {
          await blockDB.getBlockIncludingDeleted(block.id, dependencyClient, true);
        }
      } catch (error) {
        try { await dependencyClient.query("ROLLBACK"); } catch { /* preserve dependency error */ }
        dependencyClient.release();
        throw error;
      }
    }

    // A3 idempotency, resolved BEFORE batchOp opens its transaction. It has to
    // happen out here: findForDedupe reads through the pool and could not see the
    // transaction's own uncommitted rows, and a create dropped inside batchOp would
    // desynchronise the results array from the operations array.
    //
    // This is the path that matters most. B1 made /batch the client's canonical
    // write route, so a lost ack means the WAL replays the whole batch — and today
    // that mints a duplicate of everything in it. With keys, the replay resolves to
    // the rows the first attempt already committed.
    //
    // Deduped creates are REMOVED from the ops handed to batchOp and spliced back
    // into the response at their original index, so `result.blocks[i]` still answers
    // `operations[i]` for every caller that pairs them up.
    async function runBatch(ops, transactionClient) {
      const resolved = new Map();   // original index -> row already on disk
      const echoes = new Map();     // original index -> index of the earlier op in THIS batch that mints it
      const firstForKey = new Map();
      const toRun = [];
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || op.op !== "create") { toRun.push({ i, op }); continue; }
        // Through resolveIdempotentCreate, NOT findForDedupe directly — this route is
        // where the live-only rule matters MOST, and calling the guard raw here is how
        // the two endpoints silently drifted apart once already. undoDeleteTask replays
        // its restored subtree through blockStore.batchOp -> POST /api/blocks/batch, so
        // a tombstone-inclusive match on THIS path is the one that finds the tombstone
        // of the row being restored and quietly restores nothing.
        //
        // No `seen` map: a key repeated inside ONE batch cannot be answered by a lookup
        // (the row it refers to is not committed yet), so `firstForKey` below handles
        // that instead — run the first, echo its result into the later slots once
        // batchOp returns. Letting both run would put two rows with one key inside a
        // single transaction, where the conflict is unrecoverable: the retry re-reads
        // the same uncommitted nothing and loops.
        const { key, existing } = await resolveIdempotentCreate(workspaceId, op);
        if (key && firstForKey.has(key)) { echoes.set(i, firstForKey.get(key)); continue; }
        // Scope-checked even though no service token can reach /batch today. That
        // fact is a property of five separate attach sites in server.js, and this
        // change set has now shipped three bugs whose root cause was an invariant
        // asserted in a comment rather than enforced in code. assertServiceScope is a
        // no-op for a session, so enforcing it here costs nothing and cannot rot.
        if (existing) { assertServiceScope(req, existing); resolved.set(i, markDeduped(existing)); continue; }
        if (key) firstForKey.set(key, i);
        toRun.push({ i, op });
      }
      const raw = toRun.length ? await blockDB.batchOp(toRun.map(t => t.op), transactionClient) : { batchId: null, blocks: [] };
      const byIndex = new Map();
      toRun.forEach((t, n) => byIndex.set(t.i, raw.blocks[n]));
      const rowAt = (i) => {
        if (resolved.has(i)) return resolved.get(i);
        if (echoes.has(i)) { const src = byIndex.get(echoes.get(i)); if (src) assertServiceScope(req, src); return src ? markDeduped(src) : undefined; }
        const row = byIndex.get(i);
        // db.createBlock's ON CONFLICT (id) path returns an existing row rather than
        // inserting — B2's replayed client-minted ids land here — so normalize that to
        // the same `_dedupe` verdict a key match produces. One vocabulary for "this
        // was found, not created", whichever identity resolved it.
        if (row && row._resolvedExisting) { assertServiceScope(req, row); return markDeduped(row); }
        return row;
      };
      const blocks = [];
      for (let i = 0; i < ops.length; i++) { const row = rowAt(i); if (row !== undefined) blocks.push(row); }
      return { batchId: raw.batchId, blocks };
    }

    let result;
    try {
      result = await runBatch(batchOps, dependencyClient);
      if (dependencyClient) await dependencyClient.query("COMMIT");
    } catch (err) {
      // A concurrent writer won the key between our lookup and the insert. batchOp is
      // fully transactional, so the rollback left nothing behind and re-resolving is
      // clean: the winner is committed and visible now, so the retry dedupes against
      // it instead of colliding. Exactly ONE retry — a second conflict is no longer
      // the narrow race this handles and should surface rather than spin.
      if (dependencyClient) {
        try { await dependencyClient.query("ROLLBACK"); } catch { /* preserve batch error */ }
        throw err;
      }
      if (!blockDB.isIdempotencyConflict(err)) throw err;
      result = await runBatch(batchOps, null);
    } finally {
      if (dependencyClient) dependencyClient.release();
    }

    if (publicResultIndexes) {
      result = { ...result, blocks: publicResultIndexes.map(index => result.blocks[index]).filter(block => block !== undefined) };
    }

    for (const block of deletedBlocks) await transitionLinkedTriage(block, "release", Date.now());

    broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b && (b.id || b.reordered)).filter(Boolean).concat(dependencyBroadcastIds), clientId: _clientId }, req.workspaceId);
    for (const block of deletedBlocks) await syncSlack({ ...block, deleted_at: new Date().toISOString() });
    for (const block of result.blocks || []) if (block && block.id && !block.deleted_at) await syncSlack(block);
    return result;
  }));

  app.get("/api/blocks", route(async (req, res) => {
    if (req.query.date) {
      if (!isValidDate(req.query.date)) { res.status(400).json({ error: "Invalid date" }); return; }
      await blockDB.ensureDayRoot(req.query.date, req.session.userId, req.workspaceId);
      await respStore.catchUpScheduledRepeats({
        userId: req.session.userId, workspaceId: req.workspaceId,
        throughDate: getTodayStr(), targetTimeZone: ctx.APP_TIME_ZONE,
      });
      // Catch-up above creates only dates that were genuinely missed after a
      // schedule existed. The requested day is then materialized directly when
      // it is today or future, while unrelated historical days stay untouched.
      await respStore.materializeScheduledRepeatsForDate({
        date: req.query.date,
        userId: req.session.userId,
        workspaceId: req.workspaceId,
        targetTimeZone: ctx.APP_TIME_ZONE,
      });
      return withReconciledTiming(filterLegacyGcalBlocks(await blockDB.getBlocksByDate(req.query.date, req.workspaceId)), req);
    } else if (req.query.type) {
      const types = req.query.type.split(",").filter(t => blockDB.VALID_TYPES.has(t));
      if (!types.length) { res.status(400).json({ error: "No valid types" }); return; }
      return filterLegacyGcalBlocks(await blockDB.getBlocksByTypes(types, req.workspaceId));
    }
    res.status(400).json({ error: "Provide ?date= or ?type=" });
  }));

  app.get("/api/blocks/range", route(async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end || !isValidDate(start) || !isValidDate(end)) { res.status(400).json({ error: "Provide ?start=&end=" }); return; }
    // Reconciled here too, not just on the day read: block-store's getTimeEntries
    // serves the CURRENT date from the day cache but every OTHER date from the
    // range cache, so Day Review's planned-vs-actual for a past day comes through
    // THIS path. Reconciling only the day GET would leave the exact surface this
    // reconciler exists to feed showing nothing. reconcileTiming groups day_root
    // overlays by date, so a multi-day array works unchanged.
    return withReconciledTiming(filterLegacyGcalBlocks(await blockDB.getBlocksByDateRange(start, end, req.workspaceId)), req);
  }));

  // dcc_state rows keyed by date for the client range cache. db.getDccStateRange
  // existed but was never routed — loadDateRange (day-review, Catch up, the
  // Unfinished section) 404'd here and silently returned an empty cache.
  app.get("/api/dcc-state/range", route(async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end || !isValidDate(start) || !isValidDate(end)) { res.status(400).json({ error: "Provide ?start=&end=" }); return; }
    const rows = await blockDB.getDccStateRange(start, end, req.workspaceId);
    const out = {};
    for (const r of rows) { const key = (r.date instanceof Date) ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10); out[key] = r.state_json; }
    return out;
  }));

  // The carryover/catch-up lane's pool, resolved server-side. This replaces the
  // client's multi-day archive scan (unfinished-tasks.js collectUnfinished), which
  // pulled EVERY block on every archived day through /api/blocks/range and rebuilt
  // the task predicate in JS, one day at a time.
  //
  // Returns { rows, overlays, scanned }: roots plus their live descendants, and the
  // day_root overlay slice (done ids + locked ids) per date. Done-ness is applied by
  // the caller, deliberately — see db.getCarryoverPool. `days=all` lifts the window
  // for the modal's "Show older" sweep.
  //
  // The path is `/api/tasks/*` rather than `/api/blocks/*` because it is the first
  // member of the canonical TASK surface this project is migrating toward, where the
  // rest of this file is the raw BLOCK surface. Said out loud here so the next
  // endpoint knows the namespace is deliberate and not a one-off.
  //
  // Track C's hunk in Track A's file (Coordination log, 2026-07-31). Distinct from
  // A2's undelete / GET /:id / task-group work and A3's create paths.
  app.get("/api/tasks/open", route(async (req, res) => {
    const before = req.query.before || getTodayStr();
    if (!isValidDate(before)) { res.status(400).json({ error: "Invalid ?before= date" }); return; }
    const rawDays = String(req.query.days == null ? "" : req.query.days);
    const days = rawDays === "all" ? null : Math.min(3650, Math.max(1, parseInt(rawDays, 10) || 14));
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const result = await blockDB.getCarryoverPool(req.workspaceId, before, { days, limit });
    const rows = filterLegacyGcalBlocks(result.rows);
    // BOTH wrappers the sibling reads use, not just the filter. The legacy-gcal filter
    // keeps a legacy row that never rendered in the lane from appearing now. The timing
    // reconcile matters for a subtler reason: the collector this replaces called
    // loadDateRange across the whole lookback on every list build, and /api/blocks/range
    // is wrapped in reconcileTiming, so that sweep was what settled orphaned hourglass
    // timers on past days. Drop it and nothing settles them until Day Review is opened
    // for each day individually. Bounded at 25 rows per read, and idempotent.
    //
    // The SCRATCH ARRAY is not a style choice, it is the contract. reconcileTiming
    // rebuilds its completion map from the day_root rows inside the array it is given,
    // and this pool has none (it selects three task types) -- hand it `rows` alone and
    // every overlay-completed row reads as NOT done, so instead of settling timers it
    // calls clearTiming on legitimately derived ones and deletes the time_entry Day
    // Review reads. Strictly worse than omitting the wrapper. It also PUSHES any
    // time_entry it mints into that array, which must not surface as a phantom lane row
    // now that the client no longer filters by type. Both problems end at the scratch.
    await withReconciledTiming(rows.concat(result.dayRoots || []), req);
    // reconcileTiming mutates block.properties in place, so `rows` already carries any
    // settlement. dayRoots is internal plumbing and never goes over the wire.
    return {
      rows,
      overlays: result.overlays,
      scanned: result.scanned,
      // The LIMIT lands on the RAW pool, before the caller applies its done filter, and
      // it drops the OLDEST rows. Say so rather than let the caller render an exact
      // count it cannot trust -- "Show older" is the one surface whose whole purpose is
      // reaching old work, so under-reporting there is the worst place to be silent.
      truncated: result.rows.length >= limit
    };
  }));

  // A tombstone is GONE to a reader. This is the READ contract that makes the delete
  // contract observable: until now the route happily served a soft-deleted row, so
  // every consumer had to remember to check deleted_at itself, and any consumer that
  // forgot silently resurrected the row into its own view. Deliberately route-level,
  // not in db.getBlock — the mutation routes above still need to see the dead row.
  // 404 rather than 410 so a deleted id is indistinguishable from an absent one, which
  // is also what the ownership failure below returns.
  app.get("/api/blocks/:id", route(async (req, res) => {
    const block = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!block || block.deleted_at) { res.status(404).json({ error: "Block not found" }); return; }
    try { assertBlockOwnership(block, req.workspaceId); } catch { res.status(404).json({ error: "Block not found" }); return; }
    return block;
  }));

  app.get("/api/blocks/:id/children", route(async (req, res) => {
    // Same read contract: a deleted parent has no children to serve. getChildren
    // already filters deleted_at on its own rows.
    const parent = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!parent || parent.deleted_at) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(parent, req.workspaceId);
    return blockDB.getChildren(req.params.id, req.workspaceId);
  }));

  app.post("/api/blocks/reorder", route(async (req, res) => {
    const { items, _clientId } = req.body;
    if (!Array.isArray(items)) { res.status(400).json({ error: "items must be an array" }); return; }
    // Tombstone-inclusive so a deleted row cannot dodge the ownership check, matching
    // the authorization loop /batch runs (#260). Unknown ids stay permitted here;
    // reorderBlocks ignores them.
    for (const item of items) { const block = await blockDB.getBlockIncludingDeleted(item.id); if (block) assertBlockOwnership(block, req.workspaceId); }
    await blockDB.reorderBlocks(items);
    broadcast("blocks-changed", { action: "reorder", blockIds: items.map(i => i.id), clientId: _clientId }, req.workspaceId);
    return { ok: true, reordered: items.length };
  }));

  // ── Reschedule: move a task (and its whole subtask subtree) to another date ──
  // A TRUE MOVE: the parent block and every descendant keep their ids and just
  // change `date`, all in one transaction, with a single broadcast. Replaces the
  // old clone-new-id + soft-delete-old flow that duplicated tasks, stranded
  // subtasks, and (via its per-write broadcasts) made the UI snap back.
  // Subtasks link by LOCAL id (properties.subtaskOf / .wrapId == parent local_id),
  // not the DB parent_id column, so the subtree is discovered by walking those.
  // A lightweight "reschedule_tombstone" is left on the origin day so the amber
  // "Rescheduled away" list can render without a cross-date scan.
  //
  // Kept as an explicit handler (not routed through route()) on purpose: this is
  // the atomic-delegation reference pattern — bespoke HH:MM validation + the
  // load-bearing subtree move should not be churned by the P8 extraction.
  app.post("/api/blocks/:id/reschedule", async (req, res) => {
    try {
      const { targetDate, parentStart, parentEnd, placement, _clientId } = req.body || {};
      if (!targetDate || !isValidDate(targetDate)) return res.status(400).json({ error: "Invalid targetDate" });
      // parentStart/parentEnd are written straight into properties.start/end; guard the
      // format so a hand-crafted call can't poison a task's time fields with junk.
      const isHHMM = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (parentStart != null && !isHHMM(parentStart)) return res.status(400).json({ error: "Invalid parentStart (want HH:MM)" });
      if (parentEnd != null && !isHHMM(parentEnd)) return res.status(400).json({ error: "Invalid parentEnd (want HH:MM)" });
      const place = placement || ((parentStart || parentEnd) ? { kind: "timed", start: parentStart, end: parentEnd } : null);
      if (place && place.kind !== "timed" && place.kind !== "all_day") return res.status(400).json({ error: "Invalid placement kind" });
      if (place && place.kind === "timed" && (!isHHMM(place.start) || !isHHMM(place.end))) {
        return res.status(400).json({ error: "Timed placement requires HH:MM start and end" });
      }
      if (place && place.kind === "timed") {
        const toMin = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
        if (toMin(place.end) <= toMin(place.start)) return res.status(400).json({ error: "Placement end must be after start" });
      }
      if (place && place.kind === "all_day") {
        if (!isValidDate(place.endDate) || place.endDate <= targetDate) return res.status(400).json({ error: "All-day endDate must be after targetDate" });
      }
      // Tombstone-inclusive: rescheduling a deleted task must fail with the explicit
      // "Block is deleted" the move path raises, not a 404 that reads as "never existed".
      const parent = await blockDB.getBlockIncludingDeleted(req.params.id);
      if (!parent) return res.status(404).json({ error: "Block not found" });
      assertBlockOwnership(parent, req.workspaceId);
      if (parent.deleted_at) return res.status(400).json({ error: "Block is deleted" });
      const parentProps = parent.properties || {};
      const calendarOwned = ["calendar", "gcal"].includes(String(parentProps.source || "").toLowerCase()) || !!parentProps.calendar_id;
      if (calendarOwned && (parentProps.type === "meeting" || parentProps.kind === "meeting" || parentProps.type === "oneone")) {
        return res.status(409).json({ error: "Calendar meetings must be moved in their source calendar" });
      }
      // A day_root is the day's container, not a task on it. Its children by parent_id
      // are every task on that date (migration 001: 1328 such edges), so now that the
      // subtree walk reads parent_id as well as the local-id links, moving one would
      // re-date the entire day. Refused here AND seeded around in
      // lib/reschedule.js — an invariant enforced at one call site and merely asserted
      // at the other is this project's most repeated bug shape.
      if (parent.type === "day_root") return res.status(400).json({ error: "Cannot reschedule a day container" });
      // Undated blocks exist (e.g. task-bar pending_tasks live on a day only via
      // day-state), so accept the caller's viewed day as the origin. The move
      // stamps a real date on them, healing the anomaly.
      const bodyFromDate = req.body && req.body.fromDate;
      if (bodyFromDate != null && !isValidDate(bodyFromDate)) return res.status(400).json({ error: "Invalid fromDate" });
      const fromDate = parent.date || bodyFromDate;
      if (!fromDate) return res.status(400).json({ error: "Block has no source date to move from" });
      const dateChanged = fromDate !== targetDate;
      if (!dateChanged && !place) return res.status(400).json({ error: "Already on that date" });
      const parentLocalId = (parent.properties || {}).local_id || null;

      // Gather the origin day's task rows (plus undated linked strays) and walk the
      // nesting tree. The walk reads BOTH edge spaces — the subtaskOf/wrapId local-id
      // links and the parent_id column — because neither one is complete on real data;
      // lib/reschedule.js carries the measurements. An undated row only moves if the
      // walk actually links it into this parent's subtree.
      const dayBlocks = await blockDB.getRescheduleSubtreePool(fromDate, req.workspaceId);
      const subtreeIds = collectSubtreeBlockIds(dayBlocks, parent);
      const byId = new Map(dayBlocks.map(b => [b.id, b]));
      byId.set(parent.id, parent); // parent may lack local_id and be absent from dayBlocks
      const now = new Date().toISOString();
      const toMin = v => v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : null;
      const toHHMM = n => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
      const oldParentStart = toMin(parentProps.start);
      const newParentStart = place && place.kind === "timed" ? toMin(place.start) : oldParentStart;
      const timeDelta = oldParentStart != null && newParentStart != null ? newParentStart - oldParentStart : 0;
      const dateDelta = Math.round((new Date(targetDate + "T12:00:00Z") - new Date(fromDate + "T12:00:00Z")) / 86400000);
      const shiftDate = (value, delta) => {
        if (!value || !delta) return value;
        const d = new Date(String(value).slice(0, 10) + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      const oldParentEnd = toMin(parentProps.end);
      const newParentEnd = place && place.kind === "timed" ? toMin(place.end) : oldParentEnd;
      const isShell = parentProps.type === "shell" || parentProps.kind === "shell";
      if (isShell && place && place.kind === "timed" && oldParentStart != null && oldParentEnd != null &&
          newParentEnd - newParentStart !== oldParentEnd - oldParentStart) {
        return res.status(400).json({ error: "Shell duration is derived from its children" });
      }
      const moves = subtreeIds.map(bid => {
        const b = byId.get(bid);
        const properties = { ...((b && b.properties) || {}) };
        if (bid === parent.id) {
          if (dateChanged) properties.rescheduledFrom = { date: fromDate, at: now };
          if (place && place.kind === "timed") {
            properties.start = place.start; properties.end = place.end; properties._pinnedStart = place.start;
            delete properties.all_day; delete properties.all_day_start; delete properties.all_day_end;
          } else if (place && place.kind === "all_day") {
            properties.all_day = true; properties.all_day_start = targetDate; properties.all_day_end = place.endDate;
            delete properties.start; delete properties.end; delete properties._pinnedStart;
          }
        } else {
          if (timeDelta && properties.start && properties.end) {
            const startMin = toMin(properties.start), endMin = toMin(properties.end);
            if (startMin != null && endMin != null) {
              const shiftedStart = startMin + timeDelta, shiftedEnd = endMin + timeDelta;
              if (shiftedStart < 0 || shiftedEnd > 1439 || shiftedEnd <= shiftedStart) {
                const err = new Error("Placement would move nested work outside the day"); err.statusCode = 400; throw err;
              }
              properties.start = toHHMM(shiftedStart); properties.end = toHHMM(shiftedEnd);
            }
          }
          if (dateDelta && properties.all_day) {
            properties.all_day_start = shiftDate(properties.all_day_start, dateDelta);
            properties.all_day_end = shiftDate(properties.all_day_end, dateDelta);
          }
        }
        const rowDate = bid === parent.id
          ? targetDate
          : (dateChanged ? shiftDate((b && b.date) || fromDate, dateDelta) : ((b && b.date) || targetDate));
        return {
          id: bid,
          date: rowDate,
          properties,
          expectedDate: b ? b.date : parent.date,
          expectedUpdatedAt: b ? b.updated_at : parent.updated_at,
        };
      });
      if (place && place.kind === "timed" && (parentProps.isWrap || parentProps.type === "wrap" || parentProps.kind === "wrap")) {
        const latestChildEnd = moves.slice(1).reduce((latest, move) => Math.max(latest, toMin((move.properties || {}).end) || -1), -1);
        if (latestChildEnd > toMin(place.end)) return res.status(400).json({ error: "Wrap cannot end before its latest timed child" });
      }

      // One tombstone per (moved task, origin day) so the amber list stays clean
      // across repeated reschedules. Reuse an existing one instead of piling up.
      //
      // Its own query rather than a scan of `dayBlocks`: a tombstone is not a task, and it
      // only appeared in that pool because it happens to carry a local_id. Depending on
      // that meant any future tightening of the pool's task predicate would silently
      // restart the pile-up.
      const creates = [];
      const existingTomb = dateChanged ? await blockDB.getRescheduleTombstone(fromDate, parent.id, req.workspaceId) : null;
      if (dateChanged && !existingTomb) {
        creates.push({
          type: "block",
          date: fromDate,
          user_id: parent.user_id || req.session.userId || null,
          workspace_id: parent.workspace_id || req.workspaceId || null,
          properties: {
            local_id: "resched-tomb-" + parent.id,
            kind: "reschedule_tombstone",
            title: (parent.properties || {}).title || "Task",
            priority: (parent.properties || {}).priority || "Medium",
            movedBlockId: parent.id,
            sourceLocalId: parentLocalId,
            rescheduledFrom: { date: fromDate },
            rescheduledTo: targetDate,
            at: now
          }
        });
      }

      const result = await blockDB.rescheduleBlocks(moves, creates);
      const movedIds = moves.map(m => m.id);
      const created = result.blocks.slice(moves.length); // tombstone(s) appended after moves
      broadcast("blocks-changed", { action: "reschedule", blockIds: result.blocks.map(b => b.id), clientId: _clientId }, req.workspaceId);
      res.json({ moved: movedIds, blocks: result.blocks.slice(0, moves.length), created, parentId: parent.id, fromDate, targetDate, count: movedIds.length });
    } catch (e) {
      const body = { error: e.message };
      if (e.code) body.code = e.code;
      res.status(e.statusCode || e.status || 400).json(body);
    }
  });

  // Quick-task route removed from blocks.js 2026-07: it duplicated (and shadowed)
  // the richer handler in routes/dcc.js, which preserves source_id / notes /
  // idempotency_key (needed for the Slack-bookmark deeplink + dedup). dcc.js is
  // now the single POST /api/dcc/quick-task handler.

  // ── Responsibilities API ──
  // `tz` is the browser's IANA zone (Intl.DateTimeFormat().resolvedOptions()).
  // The preferred-completion-day floor is a CALENDAR-DAY test, so computing it
  // in the Node process's zone gave the wrong answer for a 5-6 hour window
  // every day on a UTC host with a US-Central user -- and the client trusted
  // this server value over its own. Optional, so an older client is unaffected.
  app.get("/api/responsibilities", route(async (req) => {
    await respStore.catchUpScheduledRepeats({
      userId: req.session.userId, workspaceId: req.workspaceId,
      throughDate: getTodayStr(), targetTimeZone: ctx.APP_TIME_ZONE,
    });
    return { items: await respStore.getResponsibilityBlocks(req.workspaceId, { tz: (req.query && req.query.tz) || null }) };
  }));

  // Kept an explicit try/catch (not route()) so the enriched apiErrorMessage
  // (message · detail · code) survives — these accept freeform properties JSON
  // where the PG detail/code is a real debugging aid.
  app.post("/api/responsibilities", async (req, res) => {
    try {
      const body = req.body || {};
      const incoming = body.properties || body;
      if (!incoming.title || !String(incoming.title).trim()) return res.status(400).json({ error: "title required" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const created = await respStore.upsertResponsibility({
        userId, workspaceId,
        properties: { ...incoming, title: String(incoming.title).trim() }
      });
      if ((created.properties || {}).repeatType === "scheduled") {
        await respStore.catchUpScheduledRepeats({ userId, workspaceId, throughDate: getTodayStr(), targetTimeZone: ctx.APP_TIME_ZONE });
      }
      broadcast("blocks-changed", { action: "responsibility-upsert", blockIds: [created.id] }, workspaceId);
      res.json(created);
    } catch (e) { console.error("[responsibilities:create]", e); res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.post("/api/responsibilities/preview", route(async (req) => {
    const rule = scheduledRecurrence.normalizeScheduleRule((req.body && req.body.scheduleRule) || req.body, {
      defaultTimeZone: ctx.APP_TIME_ZONE,
      today: getTodayStr(),
    });
    return {
      scheduleRule: rule,
      summary: scheduledRecurrence.scheduleSummary(rule),
      nextOccurrences: scheduledRecurrence.nextOccurrences(rule, { targetTimeZone: ctx.APP_TIME_ZONE, limit: 5 }),
    };
  }));

  app.patch("/api/responsibilities/:id", async (req, res) => {
    try {
      const existing = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId);
      if (!existing) return res.status(404).json({ error: "Responsibility not found" });
      const incoming = (req.body && req.body.properties) || req.body || {};
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      let updated;
      const wasScheduled = (existing.properties || {}).repeatType === "scheduled";
      const becomesScheduled = incoming.repeatType === "scheduled" || (incoming.repeatType == null && wasScheduled);
      const staysScheduled = wasScheduled && becomesScheduled;
      if (staysScheduled) {
        const changed = await respStore.changeScheduledSeries({
          id: req.params.id, workspaceId, userId, action: "update", scope: "series",
          changes: { properties: incoming },
        });
        updated = changed.definition;
      } else if (wasScheduled && !becomesScheduled) {
        updated = await respStore.convertScheduledToReadiness({
          id: req.params.id, workspaceId, userId,
          changes: { ...incoming, repeatType: "readiness", kind: existing.properties.kind },
        });
      } else {
        const merged = { ...writableProps(existing.properties), ...incoming, kind: existing.properties.kind, updatedAt: new Date().toISOString() };
        updated = await respStore.upsertResponsibility({ properties: merged, userId, workspaceId });
        if (!wasScheduled && becomesScheduled) {
          await respStore.catchUpScheduledRepeats({ userId, workspaceId, throughDate: getTodayStr(), targetTimeZone: ctx.APP_TIME_ZONE });
        }
      }
      broadcast("blocks-changed", { action: "responsibility-update", blockIds: [updated.id] }, req.workspaceId);
      res.json(updated);
    } catch (e) { console.error("[responsibilities:update]", e); res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.delete("/api/responsibilities/:id", route(async (req, res) => {
    const existing = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) { res.status(404).json({ error: "Responsibility not found" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const result = (existing.properties || {}).repeatType === "scheduled"
      ? await respStore.changeScheduledSeries({ id: req.params.id, workspaceId, userId, action: "delete", scope: "series" })
      : await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "responsibility-delete", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

  app.post("/api/responsibilities/:id/series-change", route(async (req, res) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const body = req.body || {};
    const result = await respStore.changeScheduledSeries({
      id: req.params.id,
      userId,
      workspaceId,
      action: body.action,
      scope: body.scope,
      occurrenceKey: body.occurrenceKey,
      blockId: body.blockId || null,
      changes: body.changes || {},
    });
    if (!result) { res.status(404).json({ error: "Scheduled responsibility not found" }); return; }
    broadcast("blocks-changed", {
      action: "responsibility-series-change",
      blockIds: [req.params.id, result.newDefinitionId, ...(result.blocks || []).map((block) => block && block.id)].filter(Boolean),
    }, workspaceId);
    return result;
  }));

  app.post("/api/responsibilities/:id/schedule", route(async (req, res) => {
    // Resolve the owner first and use the resolved workspaceId for BOTH the
    // ownership read and the write, matching auto-schedule/capture (avoids a
    // read-vs-write workspace asymmetry on the null-workspace path).
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const responsibility = await respStore.getResponsibilityBlock(req.params.id, workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") { res.status(404).json({ error: "Responsibility not found" }); return; }
    const result = await respStore.scheduleResponsibilityTask({
      responsibility,
      date: (req.body && req.body.date) || getTodayStr(),
      userId, workspaceId,
      sourceProps: (req.body && req.body.task) || {},
      force: !!(req.body && req.body.force)
    });
    broadcast("blocks-changed", { action: "responsibility-schedule", blockIds: [result.block.id] }, workspaceId);
    return result;
  }));

  // ── Recurrence lifecycle (D1) ──
  // Five sibling handlers, all thin: validate the id is a responsibility_item,
  // delegate the property transition to responsibility-store (which delegates
  // the shape to lib/recurrence.js), broadcast, return. The old /complete body
  // hand-rolled its own property merge; it now shares the one writer so
  // previousCompletedAt gets recorded and the open-instance pause gets cleared.
  // `tz` on a lifecycle POST is the caller's IANA zone, same contract as the GET:
  // the date gates (skipUntil / pausedUntil) and the preferred-day floor are
  // calendar-day tests, so they have to be evaluated on the USER's day.
  const respTz = (req) => (req.body && req.body.tz) || (req.query && req.query.tz) || null;

  async function respLifecycle(req, res, action, run) {
    const tz = respTz(req);
    const responsibility = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId, { tz });
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") {
      res.status(404).json({ error: "Responsibility not found" });
      return null;
    }
    // The row is handed to the writer so it is read once per request, not twice.
    const updated = await run(responsibility, tz);
    if (!updated) { res.status(404).json({ error: "Responsibility not found" }); return null; }
    broadcast("blocks-changed", { action, blockIds: [updated.id] }, req.workspaceId);
    return updated;
  }

  app.post("/api/responsibilities/:id/complete", route(async (req, res) => respLifecycle(req, res, "responsibility-complete", (existing, tz) =>
    respStore.markResponsibilityComplete(req.params.id, req.workspaceId, {
      completedAt: (req.body && req.body.completedAt) || new Date().toISOString(),
      taskId: (req.body && req.body.taskId) || null,
      existing, tz,
    })
  )));

  // Un-checking a task puts the cadence clock back where it was. Without this
  // an accidental check-off silently pushed the next occurrence a full cycle out
  // with no way to undo it.
  app.post("/api/responsibilities/:id/uncomplete", route(async (req, res) => respLifecycle(req, res, "responsibility-uncomplete", (existing, tz) =>
    respStore.markResponsibilityIncomplete(req.params.id, req.workspaceId, {
      blockId: (req.body && req.body.blockId) || null,
      localId: (req.body && req.body.localId) || null,
      date: (req.body && req.body.date) || null,
      existing, tz,
    })
  )));

  // Skip this cycle -- distinct from Complete on purpose, so the item can be
  // dismissed without claiming it was done. Urgency keeps accruing underneath.
  app.post("/api/responsibilities/:id/skip", route(async (req, res) => respLifecycle(req, res, "responsibility-skip", (existing, tz) =>
    respStore.skipResponsibilityCycle(req.params.id, req.workspaceId, { existing, tz })
  )));

  // `until` is validated at the edge, matching every other date-taking handler in
  // this file: an un-dated value string-compares either above every real date (a
  // silent permanent pause) or below it (a silent no-op), and neither deserves a 200.
  app.post("/api/responsibilities/:id/pause", route(async (req, res) => {
    const until = (req.body && req.body.until) || null;
    if (until && until !== "forever" && !isValidDate(until)) { res.status(400).json({ error: "until must be YYYY-MM-DD" }); return; }
    return respLifecycle(req, res, "responsibility-pause", (existing, tz) =>
      respStore.pauseResponsibility(req.params.id, req.workspaceId, { until: until === "forever" ? null : until, existing, tz }));
  }));

  app.post("/api/responsibilities/:id/resume", route(async (req, res) => respLifecycle(req, res, "responsibility-resume", (existing, tz) =>
    respStore.resumeResponsibility(req.params.id, req.workspaceId, { existing, tz })
  )));

  // Register an instance the CLIENT minted. public/js/responsibilities.js
  // schedules through insertTaskNow/materializeShellTemplate rather than
  // POST /:id/schedule, so the server scheduler's stamp is not on that path and
  // the browser reports the instance here instead. `blockId` is usually the
  // browser's local_id rather than a row id; the reconciler resolves either shape.
  app.post("/api/responsibilities/:id/instance", route(async (req, res) => {
    const date = (req.body && req.body.date) || null;
    if (date && !isValidDate(date)) { res.status(400).json({ error: "date must be YYYY-MM-DD" }); return; }
    return respLifecycle(req, res, "responsibility-instance", (existing, tz) =>
      respStore.setOpenInstance(req.params.id, req.workspaceId, {
        blockId: (req.body && req.body.blockId) || null,
        localId: (req.body && req.body.localId) || null,
        date, existing, tz,
      }));
  }));

  app.post("/api/responsibilities/auto-schedule", route(async (req) => {
    const threshold = Number((req.body && req.body.threshold) || DUE_THRESHOLD);
    const limit = Math.max(1, Math.min(10, Number((req.body && req.body.limit) || 3)));
    const buckets = Array.isArray(req.body && req.body.capacityBuckets) ? new Set(req.body.capacityBuckets) : null;
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    // Filter and sort on the score getResponsibilityBlocks ALREADY stamped with the
    // caller's zone, instead of recomputing it zone-less. Recomputing evaluated the
    // pause/skip date gates against the Node process's calendar day, so on a UTC
    // host a Skip set on a US evening read as lapsed and this endpoint would
    // re-materialize a task the user had just dismissed.
    const score = (b) => Number((b.properties || {}).importanceScore || 0);
    const items = (await respStore.getResponsibilityBlocks(workspaceId, { tz: respTz(req) }))
      .filter(b => (b.properties || {}).kind === "responsibility_item")
      .filter(b => (b.properties || {}).status !== "archived")
      .filter(b => !buckets || buckets.has((b.properties || {}).capacityBucket))
      .filter(b => score(b) >= threshold)
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
    // Load the day once and thread its growing blockers array through every
    // placement, so N responsibilities cost one day-load instead of N.
    const date = (req.body && req.body.date) || getTodayStr();
    const dateStr = isValidDate(date) ? date : getTodayStr();
    const dayCtx = await respStore.loadDaySlottingContext(dateStr, userId, workspaceId);
    const scheduled = [];
    for (const item of items) {
      // Honor a delete: if the user removed today's instance, don't auto-resurrect
      // it. The explicit POST /:id/schedule path is intentionally exempt.
      if (dayCtx.deletedResponsibilityIds && dayCtx.deletedResponsibilityIds.has(item.id)) continue;
      const result = await respStore.scheduleResponsibilityTask({ responsibility: item, date, userId, workspaceId, dayCtx });
      scheduled.push(result);
    }
    broadcast("blocks-changed", { action: "responsibility-auto-schedule", blockIds: scheduled.map(s => s.block.id) }, workspaceId);
    return { scheduled };
  }));

  app.post("/api/responsibilities/capture", route(async (req, res) => {
    const text = String((req.body && (req.body.text || req.body.rawCapture)) || "");
    if (!text.trim()) { res.status(400).json({ error: "text required" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const alert = parseOffersAmpAlert(text);
    if (alert) {
      const responsibility = await respStore.upsertResponsibility({
        userId, workspaceId,
        properties: {
          title: "Product Development: Bug Management",
          slug: "product-development-bug-management",
          domain: "professional",
          area: "bug_management",
          cadenceDays: 7,
          capacityBucket: "work_admin",
          estimatedMinutes: 30,
          status: "active",
          defaultSubtasks: defaultSubtasksForResponsibility({}, alert)
        }
      });
      const triggerSlug = "offers-amp-zero-expected-matches";
      const existingTrigger = await blockDB.findResponsibilityTriggerBySlug(triggerSlug, workspaceId);
      if (!existingTrigger) {
        await blockDB.createBlock({
          type: "block",
          parent_id: responsibility.id,
          properties: {
            kind: "responsibility_trigger",
            slug: triggerSlug,
            title: "Offers AMP zero expected matches",
            channel: "#offers_product",
            responsibilityId: responsibility.id,
            alertType: "offers_amp_zero_expected_matches",
            createdAt: new Date().toISOString()
          },
          user_id: userId,
          workspace_id: workspaceId
        });
      }
      const existing = alert.alertKey
        ? await blockDB.findResponsibilityTaskByAlertKey(alert.alertKey, workspaceId)
        : null;
      if (existing) { res.json({ responsibility, task: existing, duplicate: true }); return; }
      const task = await respStore.scheduleResponsibilityTask({
        responsibility,
        date: (req.body && req.body.date) || getTodayStr(),
        userId, workspaceId,
        sourceProps: alert,
        force: true
      });
      res.json({ responsibility, task: task.block, duplicate: false, parsed: alert });
      return;
    }
    const responsibility = await respStore.upsertResponsibility({
      userId, workspaceId,
      properties: {
        title: text.split(/\r?\n/)[0].slice(0, 120),
        rawCapture: text,
        domain: "other",
        area: "inbox",
        status: "inbox",
        cadenceDays: 7,
        capacityBucket: "work_admin",
        estimatedMinutes: 30
      }
    });
    return { responsibility, duplicate: false, parsed: null };
  }));

  // ── Menus + Preset Task Groups ──────────────────────────────────────────────
  // Menus are user-defined named pools (kind:"task_menu"); a Repeat Responsibility
  // records membership via properties.menus[] (an array of menu block ids).
  // A task group (kind:"task_group") is a batch of items; each item is either a
  // fixed task or a placeholder that draws from one or more menus. Adding a group
  // to a day batch-creates its tasks into free slots; placeholders land as
  // placeholder_task blocks that the user clicks to swap for a responsibility.
  function normalizeGroupItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map((it) => {
      const base = { local_id: it.local_id || ("tgi-" + crypto.randomUUID().slice(0, 12)), duration: Math.max(1, Math.round(Number(it.duration || 30))), priority: it.priority || "Medium" };
      if (it.isPlaceholder) return { ...base, isPlaceholder: true, placeholderMenus: Array.isArray(it.placeholderMenus) ? it.placeholderMenus : [], label: String(it.label || "Placeholder").trim() };
      return { ...base, isPlaceholder: false, title: String(it.title || "").trim(), detail: it.detail || "" };
    }).filter(it => it.isPlaceholder || it.title);
  }

  // ── Menus ──
  app.get("/api/task-menus", route(async (req) => ({ items: await blockDB.getBlocksByKind("task_menu", req.workspaceId) })));

  app.post("/api/task-menus", async (req, res) => {
    try {
      const incoming = (req.body && req.body.properties) || req.body || {};
      const title = String(incoming.title || "").trim();
      if (!title) return res.status(400).json({ error: "title required" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const nowIso = new Date().toISOString();
      const props = { kind: "task_menu", title, slug: slugify(title), color: incoming.color || null, status: "active", createdAt: nowIso, updatedAt: nowIso };
      const created = await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null });
      broadcast("blocks-changed", { action: "task-menu-upsert", blockIds: [created.id] }, workspaceId);
      res.json(created);
    } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.patch("/api/task-menus/:id", async (req, res) => {
    try {
      const existing = await respStore.getKindedBlock(req.params.id, "task_menu", req.workspaceId);
      if (!existing) return res.status(404).json({ error: "Menu not found" });
      const incoming = (req.body && req.body.properties) || req.body || {};
      const merged = { ...existing.properties, ...incoming, kind: "task_menu", updatedAt: new Date().toISOString() };
      if (incoming.title) merged.slug = slugify(incoming.title);
      const updated = await blockDB.updateBlock(req.params.id, { properties: merged });
      broadcast("blocks-changed", { action: "task-menu-update", blockIds: [updated.id] }, req.workspaceId);
      res.json(updated);
    } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.delete("/api/task-menus/:id", route(async (req, res) => {
    const existing = await respStore.getKindedBlock(req.params.id, "task_menu", req.workspaceId);
    if (!existing) { res.status(404).json({ error: "Menu not found" }); return; }
    const menuId = req.params.id;
    // Strip this menu id from every responsibility's menus[] and every group's
    // placeholder placeholderMenus[], then delete the menu — ALL in one tx, so
    // we never leave refs stripped with the menu surviving (or the menu deleted
    // with dangling refs still pointing at it). Reads stay outside the tx.
    const touched = [];
    const ops = [];
    for (const r of await respStore.getResponsibilityBlocks(req.workspaceId)) {
      const menus = Array.isArray(r.properties.menus) ? r.properties.menus : [];
      if (menus.includes(menuId)) {
        ops.push({ op: "update", id: r.id, properties: { ...r.properties, menus: menus.filter(m => m !== menuId), updatedAt: new Date().toISOString() } });
        touched.push(r.id);
      }
    }
    for (const g of await blockDB.getBlocksByKind("task_group", req.workspaceId)) {
      const items = Array.isArray(g.properties.items) ? g.properties.items : [];
      let changed = false;
      const next = items.map(it => {
        if (it && it.isPlaceholder && Array.isArray(it.placeholderMenus) && it.placeholderMenus.includes(menuId)) {
          changed = true;
          return { ...it, placeholderMenus: it.placeholderMenus.filter(m => m !== menuId) };
        }
        return it;
      });
      if (changed) { ops.push({ op: "update", id: g.id, properties: { ...g.properties, items: next, updatedAt: new Date().toISOString() } }); touched.push(g.id); }
    }
    ops.push({ op: "delete", id: menuId }); // delete last so its result is last
    const batch = await blockDB.batchOp(ops);
    const result = batch.blocks[batch.blocks.length - 1]; // deleteBlock's { id, deleted_at }
    broadcast("blocks-changed", { action: "task-menu-delete", blockIds: [menuId, ...touched] }, req.workspaceId);
    return result;
  }));

  // ── Task groups ──
  app.get("/api/task-groups", route(async (req) => ({ items: await blockDB.getBlocksByKind("task_group", req.workspaceId) })));

  app.post("/api/task-groups", async (req, res) => {
    try {
      const incoming = (req.body && req.body.properties) || req.body || {};
      const title = String(incoming.title || "").trim();
      if (!title) return res.status(400).json({ error: "title required" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const nowIso = new Date().toISOString();
      const props = { kind: "task_group", title, slug: slugify(title), status: incoming.status || "active", items: normalizeGroupItems(incoming.items), createdAt: nowIso, updatedAt: nowIso };
      const created = await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null });
      broadcast("blocks-changed", { action: "task-group-upsert", blockIds: [created.id] }, workspaceId);
      res.json(created);
    } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.patch("/api/task-groups/:id", async (req, res) => {
    try {
      const existing = await respStore.getKindedBlock(req.params.id, "task_group", req.workspaceId);
      if (!existing) return res.status(404).json({ error: "Task group not found" });
      const incoming = (req.body && req.body.properties) || req.body || {};
      const merged = { ...existing.properties, ...incoming, kind: "task_group", updatedAt: new Date().toISOString() };
      if (incoming.title) merged.slug = slugify(incoming.title);
      if (incoming.items) merged.items = normalizeGroupItems(incoming.items);
      const updated = await blockDB.updateBlock(req.params.id, { properties: merged });
      broadcast("blocks-changed", { action: "task-group-update", blockIds: [updated.id] }, req.workspaceId);
      res.json(updated);
    } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.delete("/api/task-groups/:id", route(async (req, res) => {
    const existing = await respStore.getKindedBlock(req.params.id, "task_group", req.workspaceId);
    if (!existing) { res.status(404).json({ error: "Task group not found" }); return; }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "task-group-delete", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

  // Batch-add every item in a group onto a day's itinerary. Threads a growing
  // blockers array so sequential items land in sequential free slots (no pile-up).
  app.post("/api/task-groups/:id/schedule", route(async (req) => {
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const group = await respStore.getKindedBlock(req.params.id, "task_group", workspaceId);
    if (!group) { const err = new Error("Task group not found"); err.statusCode = 404; throw err; }
    const dateStr = (req.body && req.body.date && isValidDate(req.body.date)) ? req.body.date : getTodayStr();

    // Adding a group to a day is not idempotent by nature — every item gets a fresh
    // local_id and a fresh free slot, so #253 left this route able to double-book the
    // entire group on any repeat hit, with no key to dedupe on. The group id stamped on
    // each created row IS that key. Tombstone-inclusive on purpose: a group whose tasks
    // the user deleted must not silently come back the next time the route is hit.
    // `force: true` is the deliberate re-add (mirroring respStore.scheduleResponsibilityTask's
    // own force flag), so the guard blocks the accident without blocking the intent.
    //
    // The check-then-act below stops the SEQUENTIAL repeat; A3 closed the concurrent
    // one underneath it with per-item idempotency keys (see the create loop), so two
    // simultaneous POSTs can no longer both plant the group.
    //
    // A3 DECLINED the unique index this comment used to ask for, because it cannot
    // work: taskGroupId is stamped on EVERY item a group mints, so a unique index on
    // (workspace_id, date, taskGroupId) would make a two-item group unaddable on an
    // empty database — the second item collides with the first. Measured on the prod
    // restore, the three "duplicate" tuples that index would have to clear are two
    // real double-books plus one perfectly ordinary two-item group. The key that IS
    // unique per row is (group, date, item index), which is what gets stamped.
    // ONE day load for both the guard and the slotting context. The tombstone-inclusive
    // read cannot use an index (every blocks index is partial on deleted_at IS NULL), so
    // it sequential-scans; loadDaySlottingContext exists precisely so a batch pays for
    // that once, and issuing a second copy here would have undercut its whole purpose.
    const dayCtx = await respStore.loadDaySlottingContext(dateStr, userId, workspaceId);

    if (!(req.body && req.body.force)) {
      const existing = await materializeGuard.findForDedupe(workspaceId, {
        rows: dayCtx.allBlocks,
        match: (row) => String((row.properties || {}).taskGroupId || "") === String(group.id),
      });
      // `duplicate: true` + the row under a named key is this repo's established shape
      // for "already there" (see /api/responsibilities/capture just above,
      // responsibility-store scheduleResponsibilityTask, budget-store, social-store).
      // `deleted` distinguishes "already on this day" from "you removed these", which
      // is what lets the client offer a re-add instead of a dead end.
      if (existing) {
        return { created: [], duplicate: true, deleted: !!existing.deleted_at, task: existing, date: dateStr };
      }
    }

    const items = Array.isArray(group.properties.items) ? group.properties.items : [];
    // ONE spelling of the key format. The mint site and the conflict-recovery lookup
    // both need it, and a drift between two copies fails silently: the lookup returns
    // null and the handler answers `{duplicate: true, task: null}`, the dead end the
    // `task` field exists to avoid. Same reason routes/slack-events.js keeps its
    // `slack-bookmark:` format in one helper beside its writer.
    const tgKey = (i) => `tg:${group.id}:${dateStr}:${i}`;
    const { dayStart, dayEnd, blockers } = dayCtx;
    const nowMin = dateStr === getTodayStr() ? (new Date().getHours() * 60 + new Date().getMinutes()) : dayStart;
    const pending = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const duration = Math.max(1, Math.round(Number(item.duration || 30)));
      const slot = firstFreeSlot(Math.max(dayStart, nowMin), duration, blockers, dayEnd) || Math.max(dayStart, nowMin);
      blockers.push({ s: slot, e: slot + duration });
      const common = {
        local_id: (item.isPlaceholder ? "ph-task-" : "tg-task-") + crypto.randomUUID().slice(0, 12),
        duration,
        start: minutesToHHMM(slot),
        end: minutesToHHMM(slot + duration),
        priority: item.priority || "Medium",
        source: "task_group",
        taskGroupId: group.id,
        createdAt: new Date().toISOString()
      };
      // A3: the per-item key that makes this add structurally single-shot. (group,
      // date, item index) is the one tuple that is genuinely unique per row, so
      // A3's UNIQUE index over live keys refuses the second of two concurrent adds
      // instead of double-booking the day.
      //
      // NOT stamped on a `force` re-add: force means "yes, again, deliberately",
      // and a deterministic key would refuse the exact thing the flag exists to
      // permit. Those rows stay unkeyed, and the taskGroupId guard above still sees
      // them, so the accidental repeat is caught either way.
      if (!(req.body && req.body.force)) common.idempotency_key = tgKey(i);
      let props;
      if (item.isPlaceholder) {
        const menus = Array.isArray(item.placeholderMenus) ? item.placeholderMenus : [];
        props = { ...common, kind: "placeholder_task", isPlaceholder: true, placeholderMenus: menus, title: (item.label || "Placeholder") + " — pick a task", meta: "Placeholder · " + (item.label || "menu") + " · " + duration + "m", tags: ["placeholder"] };
      } else {
        props = { ...common, title: item.title, detail: item.detail || "", meta: "Preset · " + (group.properties.title || "group") + " · " + duration + "m", tags: ["task-group"] };
      }
      pending.push({ date: dateStr, properties: props, sortOrder: slot });
    }

    // ONE transaction for the whole group (db.createItineraryTasks), replacing a loop
    // of independent creates. With keys in play that stops being a style question: a
    // losing racer must plant NOTHING, and a per-item loop would leave whatever it had
    // already committed before the conflicting item. Atomic, so the loser rolls back
    // to empty and gets the same "already there" answer the guard above would have
    // given it a moment earlier.
    let created;
    try {
      created = await blockDB.createItineraryTasks(pending, { userId: userId || null, workspaceId: workspaceId || null });
    } catch (err) {
      if (!blockDB.isIdempotencyConflict(err)) throw err;
      const winner = await materializeGuard.findForDedupe(workspaceId, { idempotencyKey: tgKey(0) });
      return { created: [], duplicate: true, deleted: !!(winner && winner.deleted_at), task: winner || null, date: dateStr };
    }
    broadcast("blocks-changed", { action: "task-group-schedule", blockIds: created.map(b => b.id) }, workspaceId);
    return { created };
  }));

  // Resolve a scheduled placeholder_task in place: rewrite its properties to a
  // responsibility_task at the SAME slot (reusing buildResponsibilityTaskProps),
  // keeping its local_id and duration so the timeline layout is unchanged.
  app.post("/api/task-groups/resolve-placeholder", route(async (req) => {
    const { placeholderBlockId, responsibilityId } = req.body || {};
    if (!placeholderBlockId || !responsibilityId) { const err = new Error("placeholderBlockId and responsibilityId required"); err.statusCode = 400; throw err; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    // Tombstone-inclusive for the ownership check, then refused: resolving a deleted
    // placeholder would rewrite a row the user removed back into a live-looking
    // responsibility task, which is the resurrection this phase exists to close.
    // getBlock served the dead row silently before, so this was reachable.
    const ph = await blockDB.getBlockIncludingDeleted(placeholderBlockId);
    if (!ph) { const err = new Error("Placeholder not found"); err.statusCode = 404; throw err; }
    assertBlockOwnership(ph, workspaceId);
    if (ph.deleted_at) { const err = new Error("Placeholder not found"); err.statusCode = 404; throw err; }
    const phProps = ph.properties || {};
    if (!phProps.isPlaceholder && phProps.kind !== "placeholder_task") { const err = new Error("Block is not a placeholder"); err.statusCode = 400; throw err; }
    const responsibility = await respStore.getResponsibilityBlock(responsibilityId, workspaceId);
    if (!responsibility) { const err = new Error("Responsibility not found"); err.statusCode = 404; throw err; }
    const dateStr = ph.date || (req.body && req.body.date) || getTodayStr();
    const duration = Math.max(1, Math.round(Number(phProps.duration || taskDuration(responsibility.properties))));
    const slot = hhmmToMinutes(phProps.start);
    const localId = phProps.local_id;
    const taskProps = buildResponsibilityTaskProps(responsibility, { duration, slot, localId, sourceProps: {} });
    taskProps.taskGroupId = phProps.taskGroupId || null;
    const updated = await blockDB.updateBlock(placeholderBlockId, { properties: taskProps });
    await respStore.attachDefaultSubtasks(localId, responsibility.properties, {}, dateStr, userId, workspaceId);
    broadcast("blocks-changed", { action: "placeholder-resolve", blockIds: [placeholderBlockId] }, workspaceId);
    return updated;
  }));

  // PIN 3: apply a top-level block diff forward across all future days that
  // already have blocks. The engine (gather ops -> single blockDB.batchOp,
  // P2-hardened) lives in responsibility-store.js; this handler keeps its own
  // try/catch so the contextual console.error + explicit 500 survive.
  app.post("/api/blocks/apply-forward", async (req, res) => {
    try {
      const { fromDate, diff } = req.body || {};
      if (!fromDate || !isValidDate(fromDate)) return res.status(400).json({ error: "Invalid fromDate" });
      if (!diff || typeof diff !== "object") return res.status(400).json({ error: "Missing diff" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const result = await respStore.applyForwardDiff({ fromDate, diff, userId, workspaceId });
      broadcast("blocks-changed", { action: "apply-forward", fromDate, daysUpdated: result.daysUpdated }, workspaceId);
      res.json(result);
    } catch (e) {
      console.error("[apply-forward] error:", e && e.message ? e.message : e);
      res.status(e.statusCode || e.status || 500).json({ error: e && e.message ? e.message : String(e) });
    }
  });

  // ── Waiting Items API (legacy discriminator: delegated_item) ──
  // GET list uses a dedicated db query; mutations reuse the generic
  // createBlock/updateBlock/deleteBlock primitives. PATCH and DELETE both
  // verify the target's kind discriminator so these routes can't be used
  // to modify tags or other type:"block" data.
  app.get(["/api/delegated-items", "/api/waiting-items"], route(async (req) => blockDB.getDelegatedItems(req.workspaceId)));

  app.get("/api/waiting-items/attention", route(async (req) => {
    const date = isValidDate(req.query.date) ? req.query.date : getTodayStr();
    const rows = await blockDB.getDelegatedItems(req.workspaceId);
    const items = waitingItems.attentionItems(rows, date, { timeZone: APP_TIME_ZONE });
    return {
      date,
      items,
      draft_items: items.filter((item) => item.draftEligible).map((item) => ({
        ...item,
        ...waitingItems.triageItem(item, `${item.checkInDate}T12:00:00.000Z`),
        received_at: `${item.checkInDate}T12:00:00.000Z`,
      })),
    };
  }));

  app.post(["/api/delegated-items", "/api/waiting-items"], route(async (req, res) => {
    const body = req.body || {};
    if (!body.properties || typeof body.properties !== "object") { res.status(400).json({ error: "properties required" }); return; }
    const props = waitingItems.normalizeProperties(body.properties);
    const newBlocker = body.newBlocker && typeof body.newBlocker === "object" ? body.newBlocker : null;
    if (newBlocker && props.blockerType === "task" && props.linkedBlockId && !props.blockerBlockId) {
      props.blockerBlockId = "__new_prerequisite__";
    }
    // The slimmed modal anchors items on myTask; title survives for legacy items.
    const named = v => typeof v === "string" && v.trim();
    if (!named(props.title) && !named(props.myTask) && !named(newBlocker && newBlocker.title)) { res.status(400).json({ error: "properties.title or properties.myTask required" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    if (waitingItems.isTaskDependency(props)) {
      const client = await pool.connect();
      let created;
      let createdBlocker = null;
      let affected = [];
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-dependencies:${workspaceId || "global"}`]);
        if (newBlocker) {
          const title = String(newBlocker.title || "").trim().slice(0, 300);
          if (!title) throw clientError("New prerequisite title is required");
          const duration = Math.max(1, Math.min(1440, Number(newBlocker.duration) || 30));
          const priority = ["Low", "Medium", "High"].includes(newBlocker.priority) ? newBlocker.priority : "Medium";
          const localId = `dependency-prerequisite-${crypto.randomUUID()}`;
          createdBlocker = await blockDB.createBlock({
            type: "block", parent_id: null, date: null, sort_order: null,
            user_id: userId, workspace_id: workspaceId,
            properties: {
              kind: "backlog", local_id: localId, title, type: "task", source: "manual",
              priority, stage: "Backlog", status: "open", duration, durMin: duration,
              added_at: new Date().toISOString(),
            },
          }, client);
          props.blockerBlockId = createdBlocker.id;
          props.title = title;
        }
        const context = await taskDependencyContext(props, workspaceId, null, client);
        props.blockerBlockId = context.blocker.id;
        props.linkedBlockId = context.blocked.id;
        props.title = String((context.blocker.properties || {}).title || props.title || "Prerequisite").slice(0, 300);
        props.myTask = String((context.blocked.properties || {}).title || props.myTask || "Blocked task").slice(0, 300);
        props.status = "open";
        props.checkInDate = null;
        props.snoozedUntil = null;
        created = await blockDB.createBlock({
          type: "block", parent_id: null, date: null, properties: props, sort_order: 0,
          user_id: userId, workspace_id: workspaceId,
        }, client);
        affected = await setDependencyMarker(context.subtree, created.id, client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if (error && error.code === "23505" && error.constraint === "idx_blocks_task_dependency_edge") {
          throw clientError("That dependency already exists", 409);
        }
        throw error;
      } finally {
        client.release();
      }
      broadcast("blocks-changed", { action: "task-dependency-create", blockIds: [created.id].concat(createdBlocker ? [createdBlocker.id] : [], affected) }, workspaceId);
      return created;
    }
    const created = await blockDB.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: props,
      sort_order: 0,
      user_id: userId,
      workspace_id: workspaceId
    });
    broadcast("blocks-changed", { action: "delegated-create", blockIds: [created.id] }, workspaceId);
    return created;
  }));

  // Both delegated-item mutations mirror the block PATCH/DELETE contract above:
  // tombstone-inclusive fetch, so authorization cannot be dodged and a repeat delete
  // stays idempotent, with updateBlock raising "Block is deleted" on a dead PATCH.
  app.patch(["/api/delegated-items/:id", "/api/waiting-items/:id"], route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Delegated item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Delegated item not found" }); return; }
    const incoming = (req.body && req.body.properties) || {};
    // Preserve kind discriminator — clients cannot unset it via PATCH
    const merged = waitingItems.normalizeProperties(incoming, existing.properties || {});
    const newBlocker = req.body && req.body.newBlocker && typeof req.body.newBlocker === "object"
      ? req.body.newBlocker : null;
    if (newBlocker && waitingItems.isTaskDependency(existing)) {
      merged.blockerType = "task";
      merged.blockerBlockId = "__new_prerequisite__";
      merged.linkedBlockId = (existing.properties || {}).linkedBlockId;
    }
    const existingIsDependency = waitingItems.isTaskDependency(existing);
    const mergedIsDependency = waitingItems.isTaskDependency(merged);
    if (existingIsDependency !== mergedIsDependency) {
      throw clientError("Task dependencies must be created or removed as a complete link");
    }
    if (mergedIsDependency) {
      const client = await pool.connect();
      let result;
      let createdBlocker = null;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-dependencies:${req.workspaceId || "global"}`]);
        if (newBlocker) {
          const { userId, workspaceId } = await resolveOwnerStrict(req);
          const title = String(newBlocker.title || "").trim().slice(0, 300);
          if (!title) throw clientError("New prerequisite title is required");
          const duration = Math.max(1, Math.min(1440, Number(newBlocker.duration) || 30));
          const priority = ["Low", "Medium", "High"].includes(newBlocker.priority) ? newBlocker.priority : "Medium";
          createdBlocker = await blockDB.createBlock({
            type: "block", parent_id: null, date: null, sort_order: null,
            user_id: userId, workspace_id: workspaceId,
            properties: {
              kind: "backlog", local_id: `dependency-prerequisite-${crypto.randomUUID()}`,
              title, type: "task", source: "manual", priority, stage: "Backlog",
              status: "open", duration, durMin: duration, added_at: new Date().toISOString(),
            },
          }, client);
          merged.blockerBlockId = createdBlocker.id;
          merged.title = title;
        }
        const context = await taskDependencyContext(merged, req.workspaceId, existing.id, client);
        if (String(context.blocked.id) !== String((existing.properties || {}).linkedBlockId || "")) {
          throw clientError("Remove this dependency before linking a different blocked task", 409);
        }
        merged.blockerBlockId = context.blocker.id;
        merged.linkedBlockId = context.blocked.id;
        merged.title = String((context.blocker.properties || {}).title || merged.title || "Prerequisite").slice(0, 300);
        merged.myTask = String((context.blocked.properties || {}).title || merged.myTask || "Blocked task").slice(0, 300);
        merged.status = (existing.properties || {}).status || "open";
        if (String((existing.properties || {}).blockerBlockId || "") !== String(merged.blockerBlockId || "")) {
          merged.status = "open";
          delete merged.readyAt;
        }
        result = await blockDB.updateBlock(req.params.id, { properties: merged }, client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      broadcast("blocks-changed", { action: "delegated-update", blockIds: [req.params.id].concat(createdBlocker ? [createdBlocker.id] : []) }, req.workspaceId);
      return result;
    }
    const result = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "delegated-update", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

  app.post("/api/waiting-items/:id/snooze", route(async (req, res) => {
    const until = req.body && req.body.until;
    if (!isValidDate(until)) { res.status(400).json({ error: "until must be YYYY-MM-DD" }); return; }
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at || (existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Waiting item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const properties = waitingItems.normalizeProperties({ snoozedUntil: until }, existing.properties || {});
    const updated = await blockDB.updateBlock(existing.id, { properties });
    broadcast("blocks-changed", { action: "waiting-snooze", blockIds: [existing.id] }, req.workspaceId);
    return updated;
  }));

  app.post("/api/waiting-items/:id/check-ins/schedule", route(async (req, res) => {
    const date = req.body && req.body.date;
    const taskBlockId = String(req.body && req.body.taskBlockId || "").trim();
    if (!isValidDate(date) || !taskBlockId) { res.status(400).json({ error: "date and taskBlockId are required" }); return; }
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at || (existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Waiting item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const task = await blockDB.getBlock(taskBlockId);
    if (!task || task.deleted_at || task.date !== date || !["block", "added_task"].includes(task.type)) { res.status(400).json({ error: "Scheduled check-in task not found on the requested date" }); return; }
    assertBlockOwnership(task, req.workspaceId);
    const properties = waitingItems.normalizeProperties({
      checkInDate: date,
      checkInScheduledFor: date,
      checkInTaskId: taskBlockId,
      snoozedUntil: null,
      status: "open",
    }, existing.properties || {});
    const updated = await blockDB.updateBlock(existing.id, { properties });
    broadcast("blocks-changed", { action: "waiting-check-in-scheduled", blockIds: [existing.id, taskBlockId], date }, req.workspaceId);
    return updated;
  }));

  app.post("/api/waiting-items/:id/check-ins/complete", route(async (req, res) => {
    const cycleKey = String(req.body && req.body.cycleKey || "").trim();
    const completedAt = String(req.body && req.body.completedAt || new Date().toISOString());
    if (Number.isNaN(new Date(completedAt).getTime())) { res.status(400).json({ error: "completedAt must be a valid timestamp" }); return; }
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at || (existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Waiting item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const completion = waitingItems.completeCycleProperties(existing, cycleKey, completedAt, APP_TIME_ZONE);
    if (completion.status !== "completed") return { ok: true, status: completion.status, expectedCycleKey: completion.expectedCycleKey };
    const updated = await blockDB.updateBlock(existing.id, { properties: completion.properties });
    broadcast("blocks-changed", { action: "waiting-check-in-complete", blockIds: [existing.id] }, req.workspaceId);
    return { ok: true, status: "completed", item: updated };
  }));

  // Finish the work itself, not merely the current check-in cycle. Close the
  // Waiting record and complete its linked task too when one still exists.
  app.post("/api/waiting-items/:id/complete", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at || (existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Waiting item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if (waitingItems.isTaskDependency(existing) && (existing.properties || {}).status !== "ready") {
      res.status(409).json({ error: "Complete the prerequisite before completing this blocked task" });
      return;
    }
    const completedAt = String(req.body && req.body.completedAt || new Date().toISOString());
    if (Number.isNaN(new Date(completedAt).getTime())) { res.status(400).json({ error: "completedAt must be a valid timestamp" }); return; }

    const properties = waitingItems.normalizeProperties({
      status: "done",
      completedAt,
      completedBy: "waiting",
      snoozedUntil: null,
      checkInScheduledFor: null,
      checkInTaskId: null,
    }, existing.properties || {});

    const linkedBlockId = String((existing.properties || {}).linkedBlockId || "").trim();
    let linkedTask = linkedBlockId
      ? await blockDB.findUniqueLiveBlockByReference(linkedBlockId, req.workspaceId)
      : null;
    let updated;
    let blockIds = [existing.id];
    let dependencyTransitions = [];
    if (linkedTask && !linkedTask.deleted_at) {
      assertBlockOwnership(linkedTask, req.workspaceId);
      if (!isWorkTaskRow(linkedTask)) { res.status(400).json({ error: "Linked block is not a task" }); return; }
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const mutationId = `waiting:${existing.id}:${Date.parse(completedAt)}`;
      const result = await blockDB.setTaskCompletion({
        taskRef: linkedTask.id,
        completed: true,
        completedAt,
        taskDate: linkedTask.date || null,
        mutationId,
        expectedRevision: (linkedTask.properties || {})._completionRevision || null,
        userId,
        workspaceId,
        companionUpdates: [{ id: existing.id, properties, expectedUpdatedAt: existing.updated_at }],
      });
      await normalizeCompletionWork(result, true, {
        atMs: Date.parse(completedAt), actor: userId ? `dcc:${userId}` : "dcc", mutationId,
      });
      linkedTask = result.task;
      dependencyTransitions = result.dependencyTransitions || [];
      updated = (result.companionBlocks || []).find(row => row.id === existing.id) || existing;
      blockIds = result.broadcastIds || [existing.id, linkedTask.id];
      if (linkedTask) await transitionLinkedTriage(linkedTask, "done", Date.parse(completedAt));
      for (const row of result.affectedTasks || []) await syncSlack(row);
    } else {
      linkedTask = null;
      updated = await blockDB.updateBlock(existing.id, { properties });
    }
    broadcast("blocks-changed", { action: "waiting-completed", blockIds, dependencyTransitions, date: linkedTask && linkedTask.date || null }, req.workspaceId);
    return { ok: true, status: "completed", item: updated, task: linkedTask, dependencyTransitions };
  }));

  app.post("/api/waiting-items/:id/unblock", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing || existing.deleted_at || (existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Waiting item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const existingProps = existing.properties || {};
    const destination = String(req.body && req.body.destination || "schedule").toLowerCase();
    const taskBlockId = String(req.body && req.body.taskBlockId || existingProps.linkedBlockId || "").trim();
    const date = req.body && req.body.date;
    if (!taskBlockId || !["schedule", "backlog"].includes(destination)) { res.status(400).json({ error: "taskBlockId and a valid destination are required" }); return; }
    if (waitingItems.isTaskDependency(existing) && taskBlockId !== String(existingProps.linkedBlockId || "")) {
      res.status(400).json({ error: "Task dependency actions must target the linked blocked task" });
      return;
    }
    if (destination === "schedule" && !isValidDate(date)) { res.status(400).json({ error: "date is required when scheduling" }); return; }
    const task = await blockDB.getBlock(taskBlockId);
    if (!task || task.deleted_at || (destination === "schedule" && task.date !== date)) { res.status(400).json({ error: "Underlying task was not placed at the requested destination" }); return; }
    assertBlockOwnership(task, req.workspaceId);
    const now = new Date().toISOString();
    const properties = waitingItems.normalizeProperties({
      status: "unblocked",
      completedAt: now,
      unblockedAt: now,
      unblockedTaskId: taskBlockId,
      unblockedDestination: destination,
      snoozedUntil: null,
    }, existing.properties || {});
    if (waitingItems.isTaskDependency(existing)) {
      const subtree = await blockDB.getSubtree([task.id], req.workspaceId);
      const client = await pool.connect();
      let updated;
      try {
        await client.query("BEGIN");
        updated = await blockDB.updateBlock(existing.id, { properties }, client);
        for (const row of (subtree.length ? subtree : [task])) {
          const next = { ...(row.properties || {}) };
          const remaining = (Array.isArray(next.dependencyWaitingItemIds)
            ? next.dependencyWaitingItemIds : [next.dependencyWaitingItemId]).filter(Boolean)
            .map(String).filter(id => id !== String(existing.id));
          if (remaining.length) {
            next.dependencyWaitingItemIds = remaining;
            next.dependencyWaitingItemId = remaining[0];
          } else {
            delete next.dependencyWaitingItemIds;
            delete next.dependencyWaitingItemId;
          }
          await blockDB.updateBlock(row.id, { properties: next, date: destination === "backlog" ? null : row.date }, client);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const affectedIds = (subtree.length ? subtree : [task]).map(row => row.id);
      broadcast("blocks-changed", { action: "waiting-unblocked", blockIds: [existing.id].concat(affectedIds), date: destination === "schedule" ? date : null }, req.workspaceId);
      return { ok: true, status: "unblocked", item: updated, task };
    }
    const updated = await blockDB.updateBlock(existing.id, { properties });
    broadcast("blocks-changed", { action: "waiting-unblocked", blockIds: [existing.id, taskBlockId], date }, req.workspaceId);
    return { ok: true, status: "unblocked", item: updated, task };
  }));

  app.delete(["/api/delegated-items/:id", "/api/waiting-items/:id"], route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Delegated item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Delegated item not found" }); return; }
    const affectedIds = [];
    if (waitingItems.isTaskDependency(existing)) {
      const linked = await blockDB.findUniqueLiveBlockByReference((existing.properties || {}).linkedBlockId, req.workspaceId);
      const client = await pool.connect();
      let result;
      try {
        await client.query("BEGIN");
        if (linked) {
          const subtree = await blockDB.getSubtree([linked.id], req.workspaceId);
          for (const row of (subtree.length ? subtree : [linked])) {
            const next = { ...(row.properties || {}) };
            const remaining = (Array.isArray(next.dependencyWaitingItemIds)
              ? next.dependencyWaitingItemIds : [next.dependencyWaitingItemId]).filter(Boolean)
              .map(String).filter(id => id !== String(existing.id));
            if (remaining.length) {
              next.dependencyWaitingItemIds = remaining;
              next.dependencyWaitingItemId = remaining[0];
            } else {
              delete next.dependencyWaitingItemIds;
              delete next.dependencyWaitingItemId;
            }
            await blockDB.updateBlock(row.id, { properties: next, date: null }, client);
            affectedIds.push(row.id);
          }
        }
        result = await blockDB.deleteBlock(req.params.id, client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id].concat(affectedIds) }, req.workspaceId);
      return result;
    }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id].concat(affectedIds) }, req.workspaceId);
    return result;
  }));

};
