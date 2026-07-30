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
const createMaterializeGuard = require("../lib/materialize-guard");
const createResponsibilityStore = require("../responsibility-store");
const {
  firstFreeSlot, minutesToHHMM, hhmmToMinutes, taskDuration,
  buildResponsibilityTaskProps, parseOffersAmpAlert,
  normalizeResponsibility, defaultSubtasksForResponsibility,
  DUE_THRESHOLD, writableProps,
} = require("../responsibility-store");

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, crypto, filterLegacyGcalBlocks, getScheduleBlocks, getTodayStr, isAllowedSweepBlockItem, isValidDate, pool } = ctx;

  // ── Local helpers ──
  function assertBlockOwnership(block, workspaceId) { if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) { const err = new Error("Block not found"); err.statusCode = 404; throw err; } }
  function apiErrorMessage(e) {
    return [e && e.message, e && e.detail, e && e.code].filter(Boolean).join(" · ") || "Request failed";
  }
  const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // The responsibility domain + slot engine + apply-forward engine live in
  // responsibility-store.js; instantiate it here with the server-scope deps.
  const respStore = createResponsibilityStore({ blockDB, getScheduleBlocks, getTodayStr, assertBlockOwnership });

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
  const { reconcileTiming } = createTaskTiming({ pool, blockDB, timeZone: ctx.APP_TIME_ZONE });
  // Never let a read fail on a reconcile: the itinerary must still render.
  async function withReconciledTiming(blocks, req) {
    try { await reconcileTiming(blocks, { userId: req.session && req.session.userId, workspaceId: req.workspaceId }); }
    catch (e) { console.error("[blocks] timing reconcile failed (non-fatal):", e.message); }
    return blocks;
  }

  // ── Block API ──
  app.post("/api/blocks", validate(schemas.blockCreate), route(async (req, res) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    if (req.dccServiceAuth && !items.every(isAllowedSweepBlockItem)) { res.status(403).json({ error: "Sweep Suite token may only create sweep_suite_task blocks" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const results = [];
    for (const item of items) results.push(await blockDB.createBlock({ ...item, user_id: userId, workspace_id: workspaceId }));
    broadcast("blocks-changed", { action: "create", blockIds: results.map(r => r.id), clientId: body._clientId }, workspaceId);
    return results.length === 1 ? results[0] : results;
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
    const result = await blockDB.updateBlock(req.params.id, req.body);
    broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId }, req.workspaceId);
    return result;
  }));

  app.delete("/api/blocks/:id", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id], clientId: req.query._clientId }, req.workspaceId);
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
    return result;
  }));

  app.post("/api/blocks/batch", route(async (req, res) => {
    const { operations, _clientId } = req.body;
    if (!Array.isArray(operations)) { res.status(400).json({ error: "operations must be an array" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);

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
    const result = await blockDB.batchOp(opsWithUser);
    broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b.id || b.reordered).filter(Boolean), clientId: _clientId }, req.workspaceId);
    return result;
  }));

  app.get("/api/blocks", route(async (req, res) => {
    if (req.query.date) {
      if (!isValidDate(req.query.date)) { res.status(400).json({ error: "Invalid date" }); return; }
      await blockDB.ensureDayRoot(req.query.date, req.session.userId, req.workspaceId);
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
      const { targetDate, parentStart, parentEnd, _clientId } = req.body || {};
      if (!targetDate || !isValidDate(targetDate)) return res.status(400).json({ error: "Invalid targetDate" });
      // parentStart/parentEnd are written straight into properties.start/end; guard the
      // format so a hand-crafted call can't poison a task's time fields with junk.
      const isHHMM = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (parentStart != null && !isHHMM(parentStart)) return res.status(400).json({ error: "Invalid parentStart (want HH:MM)" });
      if (parentEnd != null && !isHHMM(parentEnd)) return res.status(400).json({ error: "Invalid parentEnd (want HH:MM)" });
      // Tombstone-inclusive: rescheduling a deleted task must fail with the explicit
      // "Block is deleted" the move path raises, not a 404 that reads as "never existed".
      const parent = await blockDB.getBlockIncludingDeleted(req.params.id);
      if (!parent) return res.status(404).json({ error: "Block not found" });
      assertBlockOwnership(parent, req.workspaceId);
      // Undated blocks exist (e.g. task-bar pending_tasks live on a day only via
      // day-state), so accept the caller's viewed day as the origin. The move
      // stamps a real date on them, healing the anomaly.
      const bodyFromDate = req.body && req.body.fromDate;
      if (bodyFromDate != null && !isValidDate(bodyFromDate)) return res.status(400).json({ error: "Invalid fromDate" });
      const fromDate = parent.date || bodyFromDate;
      if (!fromDate) return res.status(400).json({ error: "Block has no source date to move from" });
      if (fromDate === targetDate) return res.status(400).json({ error: "Already on that date" });
      const parentLocalId = (parent.properties || {}).local_id || null;

      // Gather the origin day's task blocks and walk the subtaskOf/wrapId tree.
      // Undated task blocks ride along as walk candidates: they only move if their
      // subtaskOf/wrapId chain links them into the parent's subtree.
      const dayBlocks = [
        ...(await blockDB.getBlocksByDate(fromDate, req.workspaceId)),
        ...(await blockDB.getUndatedTaskBlocks(req.workspaceId))
      ].filter(b => b.type === "block" && (b.properties || {}).local_id);
      const subtreeIds = collectSubtreeBlockIds(dayBlocks, parent);
      const byId = new Map(dayBlocks.map(b => [b.id, b]));
      byId.set(parent.id, parent); // parent may lack local_id and be absent from dayBlocks
      const now = new Date().toISOString();
      const moves = subtreeIds.map(bid => {
        const b = byId.get(bid);
        if (bid !== parent.id) return { id: bid, date: targetDate };
        const properties = { ...((b && b.properties) || {}), rescheduledFrom: { date: fromDate, at: now } };
        if (parentStart) { properties.start = parentStart; properties._pinnedStart = parentStart; }
        if (parentEnd) properties.end = parentEnd;
        return { id: bid, date: targetDate, properties };
      });

      // One tombstone per (moved task, origin day) so the amber list stays clean
      // across repeated reschedules. Reuse an existing one instead of piling up.
      const creates = [];
      const existingTomb = dayBlocks.find(b => (b.properties || {}).kind === "reschedule_tombstone" && (b.properties || {}).movedBlockId === parent.id);
      if (!existingTomb) {
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
      res.json({ moved: movedIds, created, parentId: parent.id, fromDate, targetDate, count: movedIds.length });
    } catch (e) { res.status(e.statusCode || e.status || 400).json({ error: e.message }); }
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
  app.get("/api/responsibilities", route(async (req) => ({
    items: await respStore.getResponsibilityBlocks(req.workspaceId, { tz: (req.query && req.query.tz) || null }),
  })));

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
      broadcast("blocks-changed", { action: "responsibility-upsert", blockIds: [created.id] }, workspaceId);
      res.json(created);
    } catch (e) { console.error("[responsibilities:create]", e); res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.patch("/api/responsibilities/:id", async (req, res) => {
    try {
      const existing = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId);
      if (!existing) return res.status(404).json({ error: "Responsibility not found" });
      const incoming = (req.body && req.body.properties) || req.body || {};
      // writableProps: `existing` is normalized, so a raw merge would persist the
      // derived importanceScore / suppressed / preferredDue into the row and its
      // operations-log entry, freezing a stale answer for the next raw reader.
      const merged = { ...writableProps(existing.properties), ...incoming, kind: existing.properties.kind, updatedAt: new Date().toISOString() };
      const updated = normalizeResponsibility(await blockDB.updateBlock(req.params.id, { properties: merged }));
      broadcast("blocks-changed", { action: "responsibility-update", blockIds: [updated.id] }, req.workspaceId);
      res.json(updated);
    } catch (e) { console.error("[responsibilities:update]", e); res.status(e.statusCode || e.status || 400).json({ error: apiErrorMessage(e) }); }
  });

  app.delete("/api/responsibilities/:id", route(async (req, res) => {
    const existing = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) { res.status(404).json({ error: "Responsibility not found" }); return; }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "responsibility-delete", blockIds: [req.params.id] }, req.workspaceId);
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
    // entire group on a double-click or a client retry, with no key to dedupe on.
    // The group id stamped on each created row IS that key. Tombstone-inclusive on
    // purpose: a group whose tasks the user deleted must not silently come back the
    // next time the route is hit. `force: true` is the deliberate re-add (mirroring
    // respStore.scheduleResponsibilityTask's own force flag), so the guard blocks the
    // accident without blocking the intent.
    if (!(req.body && req.body.force)) {
      const existing = await materializeGuard.findForDedupe(workspaceId, {
        date: dateStr,
        match: (row) => String((row.properties || {}).taskGroupId || "") === String(group.id),
      });
      if (existing) {
        return {
          created: [],
          skipped: true,
          status: materializeGuard.dedupeStatus(existing),
          existingId: existing.id,
          date: dateStr,
        };
      }
    }

    const items = Array.isArray(group.properties.items) ? group.properties.items : [];
    const { dayStart, dayEnd, blockers } = await respStore.loadDaySlottingContext(dateStr, userId, workspaceId);
    const nowMin = dateStr === getTodayStr() ? (new Date().getHours() * 60 + new Date().getMinutes()) : dayStart;
    const created = [];
    for (const item of items) {
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
      let props;
      if (item.isPlaceholder) {
        const menus = Array.isArray(item.placeholderMenus) ? item.placeholderMenus : [];
        props = { ...common, kind: "placeholder_task", isPlaceholder: true, placeholderMenus: menus, title: (item.label || "Placeholder") + " — pick a task", meta: "Placeholder · " + (item.label || "menu") + " · " + duration + "m", tags: ["placeholder"] };
      } else {
        props = { ...common, title: item.title, detail: item.detail || "", meta: "Preset · " + (group.properties.title || "group") + " · " + duration + "m", tags: ["task-group"] };
      }
      const block = await blockDB.createItineraryTask({ date: dateStr, properties: props, userId: userId || null, workspaceId: workspaceId || null, sortOrder: slot, ensureRoot: false });
      created.push(block);
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

  // ── Delegated Items API (PIN 10.A) ──
  // Wraps blockDB CRUD, stamping properties.kind = "delegated_item" on create.
  // GET list uses a dedicated db query; mutations reuse the generic
  // createBlock/updateBlock/deleteBlock primitives. PATCH and DELETE both
  // verify the target's kind discriminator so these routes can't be used
  // to modify tags or other type:"block" data.
  app.get("/api/delegated-items", route(async (req) => blockDB.getDelegatedItems(req.workspaceId)));

  app.post("/api/delegated-items", route(async (req, res) => {
    const body = req.body || {};
    if (!body.properties || typeof body.properties !== "object") { res.status(400).json({ error: "properties required" }); return; }
    const props = { ...body.properties, kind: "delegated_item" };
    // The slimmed modal anchors items on myTask; title survives for legacy items.
    const named = v => typeof v === "string" && v.trim();
    if (!named(props.title) && !named(props.myTask)) { res.status(400).json({ error: "properties.title or properties.myTask required" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
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
  app.patch("/api/delegated-items/:id", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Delegated item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Delegated item not found" }); return; }
    const incoming = (req.body && req.body.properties) || {};
    // Preserve kind discriminator — clients cannot unset it via PATCH
    const merged = { ...existing.properties, ...incoming, kind: "delegated_item" };
    const result = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "delegated-update", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

  app.delete("/api/delegated-items/:id", route(async (req, res) => {
    const existing = await blockDB.getBlockIncludingDeleted(req.params.id);
    if (!existing) { res.status(404).json({ error: "Delegated item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Delegated item not found" }); return; }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

};
