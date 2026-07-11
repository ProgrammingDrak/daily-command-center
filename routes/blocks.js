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
const createResponsibilityStore = require("../responsibility-store");
const {
  firstFreeSlot, minutesToHHMM, hhmmToMinutes, taskDuration,
  buildResponsibilityTaskProps, parseOffersAmpAlert,
  normalizeResponsibility, defaultSubtasksForResponsibility,
} = require("../responsibility-store");

module.exports = function mount(app, ctx) {
  const { blockDB, broadcast, crypto, filterLegacyGcalBlocks, getScheduleBlocks, getTodayStr, isAllowedSweepBlockItem, isValidDate } = ctx;

  // ── Local helpers ──
  function assertBlockOwnership(block, workspaceId) { if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) { const err = new Error("Block not found"); err.statusCode = 404; throw err; } }
  function apiErrorMessage(e) {
    return [e && e.message, e && e.detail, e && e.code].filter(Boolean).join(" · ") || "Request failed";
  }
  const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // The responsibility domain + slot engine + apply-forward engine live in
  // responsibility-store.js; instantiate it here with the server-scope deps.
  const respStore = createResponsibilityStore({ blockDB, getScheduleBlocks, getTodayStr, assertBlockOwnership });

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

  app.patch("/api/blocks/:id", route(async (req, res) => {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const result = await blockDB.updateBlock(req.params.id, req.body);
    broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId }, req.workspaceId);
    return result;
  }));

  app.delete("/api/blocks/:id", route(async (req, res) => {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id], clientId: req.query._clientId }, req.workspaceId);
    return result;
  }));

  app.post("/api/blocks/batch", route(async (req, res) => {
    const { operations, _clientId } = req.body;
    if (!Array.isArray(operations)) { res.status(400).json({ error: "operations must be an array" }); return; }
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const opsWithUser = operations.map(op => op.op === "create" ? { ...op, user_id: userId, workspace_id: workspaceId } : op);
    const result = await blockDB.batchOp(opsWithUser);
    broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b.id || b.reordered).filter(Boolean), clientId: _clientId }, req.workspaceId);
    return result;
  }));

  app.get("/api/blocks", route(async (req, res) => {
    if (req.query.date) {
      if (!isValidDate(req.query.date)) { res.status(400).json({ error: "Invalid date" }); return; }
      await blockDB.ensureDayRoot(req.query.date, req.session.userId, req.workspaceId);
      return filterLegacyGcalBlocks(await blockDB.getBlocksByDate(req.query.date, req.workspaceId));
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
    return filterLegacyGcalBlocks(await blockDB.getBlocksByDateRange(start, end, req.workspaceId));
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

  app.get("/api/blocks/:id", route(async (req, res) => {
    const block = await blockDB.getBlock(req.params.id);
    if (!block) { res.status(404).json({ error: "Block not found" }); return; }
    try { assertBlockOwnership(block, req.workspaceId); } catch { res.status(404).json({ error: "Block not found" }); return; }
    return block;
  }));

  app.get("/api/blocks/:id/children", route(async (req, res) => {
    const parent = await blockDB.getBlock(req.params.id);
    if (!parent) { res.status(404).json({ error: "Block not found" }); return; }
    assertBlockOwnership(parent, req.workspaceId);
    return blockDB.getChildren(req.params.id, req.workspaceId);
  }));

  app.post("/api/blocks/reorder", route(async (req, res) => {
    const { items, _clientId } = req.body;
    if (!Array.isArray(items)) { res.status(400).json({ error: "items must be an array" }); return; }
    for (const item of items) { const block = await blockDB.getBlock(item.id); if (block) assertBlockOwnership(block, req.workspaceId); }
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
      const parent = await blockDB.getBlock(req.params.id);
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
  app.get("/api/responsibilities", route(async (req) => ({ items: await respStore.getResponsibilityBlocks(req.workspaceId) })));

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
      const merged = { ...existing.properties, ...incoming, kind: existing.properties.kind, updatedAt: new Date().toISOString() };
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

  app.post("/api/responsibilities/:id/complete", route(async (req, res) => {
    const responsibility = await respStore.getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") { res.status(404).json({ error: "Responsibility not found" }); return; }
    const at = (req.body && req.body.completedAt) || new Date().toISOString();
    const updated = normalizeResponsibility(await blockDB.updateBlock(req.params.id, {
      properties: {
        ...responsibility.properties,
        lastCompletedAt: at,
        updatedAt: at,
        lastCompletedTaskId: req.body && req.body.taskId || null
      }
    }));
    broadcast("blocks-changed", { action: "responsibility-complete", blockIds: [updated.id] }, req.workspaceId);
    return updated;
  }));

  app.post("/api/responsibilities/auto-schedule", route(async (req) => {
    const threshold = Number((req.body && req.body.threshold) || 70);
    const limit = Math.max(1, Math.min(10, Number((req.body && req.body.limit) || 3)));
    const buckets = Array.isArray(req.body && req.body.capacityBuckets) ? new Set(req.body.capacityBuckets) : null;
    const { userId, workspaceId } = await resolveOwnerStrict(req);
    const items = (await respStore.getResponsibilityBlocks(workspaceId))
      .filter(b => (b.properties || {}).kind === "responsibility_item")
      .filter(b => (b.properties || {}).status !== "archived")
      .filter(b => !buckets || buckets.has((b.properties || {}).capacityBucket))
      .filter(b => respStore.responsibilityScore(b.properties) >= threshold)
      .sort((a, b) => respStore.responsibilityScore(b.properties) - respStore.responsibilityScore(a.properties))
      .slice(0, limit);
    // Load the day once and thread its growing blockers array through every
    // placement, so N responsibilities cost one day-load instead of N.
    const date = (req.body && req.body.date) || getTodayStr();
    const dateStr = isValidDate(date) ? date : getTodayStr();
    const dayCtx = await respStore.loadDaySlottingContext(dateStr, userId, workspaceId);
    const scheduled = [];
    for (const item of items) {
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
    const ph = await blockDB.getBlock(placeholderBlockId);
    if (!ph) { const err = new Error("Placeholder not found"); err.statusCode = 404; throw err; }
    assertBlockOwnership(ph, workspaceId);
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

  app.patch("/api/delegated-items/:id", route(async (req, res) => {
    const existing = await blockDB.getBlock(req.params.id);
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
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) { res.status(404).json({ error: "Delegated item not found" }); return; }
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") { res.status(404).json({ error: "Delegated item not found" }); return; }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id] }, req.workspaceId);
    return result;
  }));

};
