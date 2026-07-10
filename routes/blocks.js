// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

const validate = require("../middleware/validate");
const schemas = require("../middleware/schemas");
const { collectSubtreeBlockIds } = require("../lib/reschedule");
const { resolveOwnerStrict } = require("../middleware/resolve-owner");

module.exports = function mount(app, ctx) {
  const { APP_TIME_ZONE, DCC_ENDPOINTS, addMinutesHHMM, blockDB, broadcast, crypto, filterLegacyGcalBlocks, getScheduleBlocks, getTodayStr, isAllowedSweepBlockItem, isValidDate, pool, session } = ctx;

// ── Block API ──
function assertBlockOwnership(block, workspaceId) { if (block.workspace_id && workspaceId && block.workspace_id !== workspaceId) { const err = new Error("Block not found"); err.statusCode = 404; throw err; } }
const RESPONSIBILITY_KINDS = new Set(["responsibility_item", "responsibility_trigger"]);

function cadenceDays(props) {
  const raw = String(props.cadence || "").toLowerCase();
  if (raw === "as_needed" || raw === "as-needed" || raw === "as needed") return 0;
  const n = Number(props.cadenceDays || props.cadence_days || 0);
  if (n > 0) return n;
  if (raw === "daily") return 1;
  if (raw === "weekly") return 7;
  if (raw === "biweekly") return 14;
  if (raw === "monthly") return 30;
  if (raw === "quarterly") return 90;
  const m = raw.match(/(\d+)/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 7;
}

function localDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function preferredCompletionDue(props, at = new Date()) {
  if (!props) return false;
  const cadence = String(props.preferredCompletionCadence || props.preferredCadence || "none").toLowerCase();
  if (!cadence || cadence === "none") return false;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  if (cadence === "weekly") {
    const day = Math.max(0, Math.min(6, Number(props.preferredDayOfWeek || 0)));
    return at.getDay() === day;
  }
  if (cadence === "monthly") {
    const target = Math.max(1, Math.min(31, Number(props.preferredDayOfMonth || 1)));
    return at.getDate() === Math.min(target, daysInMonth(at.getFullYear(), at.getMonth()));
  }
  if (cadence === "yearly") {
    const month = Math.max(1, Math.min(12, Number(props.preferredMonth || 1)));
    const target = Math.max(1, Math.min(31, Number(props.preferredMonthDay || 1)));
    return at.getMonth() + 1 === month && at.getDate() === Math.min(target, daysInMonth(at.getFullYear(), month - 1));
  }
  if (cadence === "custom") {
    const anchorRaw = props.preferredCustomAnchor || props.preferredDate || "";
    const every = Math.max(1, Number(props.preferredCustomDays || props.preferredEveryDays || 1));
    const anchor = anchorRaw ? new Date(`${anchorRaw}T00:00:00`) : null;
    if (!anchor || Number.isNaN(anchor.getTime())) return false;
    const diff = Math.floor((localDateOnly(at) - localDateOnly(anchor)) / 86400000);
    return diff >= 0 && diff % every === 0;
  }
  return false;
}

function responsibilityScore(props, at = new Date()) {
  if (!props || props.status === "archived" || props.status === "done") return 0;
  const days = cadenceDays(props);
  let base = 0;
  if (days) {
    const anchor = props.lastCompletedAt || props.createdAt || props.created_at || props.added_at;
    const start = anchor ? new Date(anchor) : at;
    const elapsedDays = Math.max(0, (at - start) / 86400000);
    base = Math.round((elapsedDays / days) * 100);
  }
  if (preferredCompletionDue(props, at)) base = Math.max(base, Number(props.preferredCompletionScore || 85));
  const boost = Number(props.importanceBoost || props.boost || 0);
  return Math.max(0, Math.min(100, base + boost));
}

function normalizeResponsibility(block) {
  const properties = block.properties || {};
  const importanceScore = responsibilityScore(properties);
  return { ...block, properties: { ...properties, importanceScore } };
}

function taskDuration(props) {
  // Durations are granular to the minute (floor 1). Only the UI presets snap to 15.
  return Math.max(1, Math.round(Number(props.estimatedMinutes || props.duration || props.durationMin || 30)));
}

async function getResponsibilityBlocks(workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND workspace_id = $1
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND deleted_at IS NULL
         ORDER BY created_at ASC`
      );
  return rows.map(blockDB.parseBlock).map(normalizeResponsibility);
}

async function getResponsibilityBlock(id, workspaceId) {
  const block = await blockDB.getBlock(id);
  if (!block) return null;
  assertBlockOwnership(block, workspaceId);
  if (!RESPONSIBILITY_KINDS.has((block.properties || {}).kind)) return null;
  return normalizeResponsibility(block);
}

async function findResponsibilityBySlug(slug, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND workspace_id=$2 AND deleted_at IS NULL
         LIMIT 1`,
        [slug, workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND deleted_at IS NULL
         LIMIT 1`,
        [slug]
      );
  return rows[0] ? normalizeResponsibility(blockDB.parseBlock(rows[0])) : null;
}

async function upsertResponsibility({ properties, userId, workspaceId }) {
  const slug = properties.slug || String(properties.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const existing = slug ? await findResponsibilityBySlug(slug, workspaceId) : null;
  const nowIso = new Date().toISOString();
  const props = {
    kind: "responsibility_item",
    title: properties.title,
    slug,
    domain: properties.domain || "professional",
    area: properties.area || "general",
    cadence: properties.cadence || (properties.asNeeded ? "as_needed" : "custom"),
    cadenceDays: properties.cadence === "as_needed" ? null : Number(properties.cadenceDays || 7),
    capacityBucket: properties.capacityBucket || "work_admin",
    estimatedMinutes: Number(properties.estimatedMinutes || 30),
    status: properties.status || "active",
    defaultSubtasks: Array.isArray(properties.defaultSubtasks) ? properties.defaultSubtasks : [],
    menus: Array.isArray(properties.menus) ? properties.menus : [],
    createdAt: properties.createdAt || nowIso,
    updatedAt: nowIso,
    ...properties
  };
  if (existing) {
    return normalizeResponsibility(await blockDB.updateBlock(existing.id, { properties: { ...existing.properties, ...props, createdAt: existing.properties.createdAt || props.createdAt } }));
  }
  return normalizeResponsibility(await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null }));
}

function defaultSubtasksForResponsibility(props, alertProps = {}) {
  const configured = Array.isArray(props.defaultSubtasks) ? props.defaultSubtasks.filter(Boolean) : [];
  if (configured.length) return configured;
  if (alertProps.alertType === "offers_amp_zero_expected_matches") {
    return [
      "Open AMP deal link",
      "Open HubSpot deal link",
      "Check Matching & Delays config for the listed combo",
      "Record root cause or resolution note",
      "Escalate/update product team if config or automation needs a fix"
    ];
  }
  return ["Review current state", "Record outcome", "Decide next action"];
}

function hhmmToMinutes(s) {
  if (!s || !/^\d{2}:\d{2}$/.test(s)) return 0;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function firstFreeSlot(start, duration, blockers, dayEnd) {
  let cursor = start;
  for (const b of blockers.sort((a, b) => a.s - b.s)) {
    if (cursor + duration <= b.s) return cursor;
    if (cursor < b.e) cursor = b.e;
  }
  return cursor + duration <= dayEnd + 60 ? cursor : null;
}

// Load a day's existing blocks and work-hour bounds once, plus the blockers
// array the free-slot finder consumes. Shared by the responsibility scheduler
// and the task-group scheduler so a batch pays for the day-load a single time
// instead of once per item (the auto-schedule N+1). Callers grow `blockers`
// as they place tasks so sequential items land in sequential free slots.
async function loadDaySlottingContext(dateStr, userId, workspaceId) {
  const blocks = await blockDB.getBlocksByDate(dateStr, workspaceId);
  const dayBlocks = await getScheduleBlocks(userId, workspaceId);
  const workBlocks = dayBlocks.filter(b => (b.blockType || b.type) === "work");
  const dayStart = workBlocks[0] ? hhmmToMinutes(workBlocks[0].start) : 9 * 60;
  const dayEnd = workBlocks.length ? hhmmToMinutes(workBlocks[workBlocks.length - 1].end) : 17 * 60;
  const blockers = blocks
    .filter(b => (b.properties || {}).start && (b.properties || {}).end)
    .map(b => ({ s: hhmmToMinutes(b.properties.start), e: hhmmToMinutes(b.properties.end) }));
  return { blocks, dayStart, dayEnd, blockers };
}

async function scheduleResponsibilityTask({ responsibility, date, userId, workspaceId, sourceProps = {}, force = false, dayCtx = null }) {
  const props = responsibility.properties || {};
  const dateStr = date && isValidDate(date) ? date : getTodayStr();
  const duration = taskDuration({ ...props, ...sourceProps });
  // Reuse a batch-provided day context when auto-scheduling many at once;
  // otherwise load this day once for the single-task path.
  const ctx = dayCtx || await loadDaySlottingContext(dateStr, userId, workspaceId);
  const existing = ctx.blocks.find(b => {
    const p = b.properties || {};
    return p.responsibilityId === responsibility.id && p.kind === "responsibility_task" && !p.completedAt;
  });
  if (existing && !force) return { block: existing, created: false, duplicate: true };
  const nowMin = dateStr === getTodayStr() ? (new Date().getHours() * 60 + new Date().getMinutes()) : ctx.dayStart;
  const slot = firstFreeSlot(Math.max(ctx.dayStart, nowMin), duration, ctx.blockers, ctx.dayEnd) || Math.max(ctx.dayStart, nowMin);
  ctx.blockers.push({ s: slot, e: slot + duration });
  const localId = "resp-task-" + crypto.randomUUID().slice(0, 12);
  const taskProps = buildResponsibilityTaskProps(responsibility, { duration, slot, localId, sourceProps });
  // ensureRoot:false — attachDefaultSubtasks below ensures the day root, as before.
  const block = await blockDB.createItineraryTask({ date: dateStr, properties: taskProps, userId: userId || null, workspaceId: workspaceId || null, sortOrder: slot, ensureRoot: false });
  await attachDefaultSubtasks(localId, props, sourceProps, dateStr, userId, workspaceId);
  return { block, created: true };
}

// Build the `responsibility_task` properties for a given slot. Shared by the
// schedule endpoint and the placeholder-resolve endpoint so both produce an
// identical task shape (DRY — see also attachDefaultSubtasks).
function buildResponsibilityTaskProps(responsibility, { duration, slot, localId, sourceProps = {} }) {
  const props = responsibility.properties || {};
  const title = sourceProps.title || props.nextTaskTitle || props.title;
  const score = responsibilityScore(props);
  const priority = sourceProps.priority || (sourceProps.urgent ? "High" : null) || (score >= 90 ? "High" : score >= 60 ? "Medium" : "Low");
  return {
    kind: "responsibility_task",
    local_id: localId,
    title,
    duration,
    start: minutesToHHMM(slot),
    end: minutesToHHMM(slot + duration),
    priority,
    meta: "Responsibility · " + (props.area || props.domain || "general") + " · " + duration + "m",
    detail: sourceProps.detail || props.description || "",
    source: sourceProps.source || "responsibility",
    tags: ["responsibility", props.domain, props.area, props.capacityBucket].filter(Boolean),
    responsibilityId: responsibility.id,
    responsibilityTitle: props.title,
    capacityBucket: props.capacityBucket || null,
    responsibilityScore: score,
    alertKey: sourceProps.alertKey || null,
    alertType: sourceProps.alertType || null,
    ampUrl: sourceProps.ampUrl || null,
    hubspotUrl: sourceProps.hubspotUrl || null,
    createdAt: new Date().toISOString()
  };
}

// Attach a responsibility's default subtasks onto the day root's _subtasks map,
// keyed by the task's local_id. Extracted from scheduleResponsibilityTask.
async function attachDefaultSubtasks(localId, props, sourceProps, dateStr, userId, workspaceId) {
  const subtasks = defaultSubtasksForResponsibility(props, sourceProps);
  if (!subtasks.length) return;
  const rootId = await blockDB.ensureDayRoot(dateStr, userId, workspaceId);
  const root = await blockDB.getBlock(rootId);
  const rootProps = root.properties || {};
  const allSubtasks = { ...(rootProps._subtasks || {}) };
  allSubtasks[localId] = subtasks.map((text, i) => ({ id: "st-" + Date.now() + "-" + i, text, done: false, created: new Date().toISOString() }));
  await blockDB.updateBlock(rootId, { properties: { ...rootProps, _subtasks: allSubtasks } });
}

function parseOffersAmpAlert(text) {
  const raw = text || "";
  if (!/Offers AMP Error|zero expected matches|New deal entered the AMP with zero expected matches/i.test(raw)) return null;
  const ampUrl = (raw.match(/https?:\/\/amp\.listwithclever\.dev\/deals\/\d+/i) || [null])[0];
  const hubspotUrl = (raw.match(/https?:\/\/app\.hubspot\.com\/contacts\/3298701\/record\/0-3\/\d+/i) || [null])[0];
  const address = (raw.match(/Address:\s*([^\n]+)/i) || [null, ""])[1].trim();
  const config = (raw.match(/Config lookup:\s*([^\n]+)/i) || [null, ""])[1].trim();
  const alertKey = hubspotUrl || ampUrl || crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return {
    alertType: "offers_amp_zero_expected_matches",
    alertKey,
    title: "Investigate Offers AMP zero expected matches" + (address ? ": " + address.split(",")[0] : ""),
    detail: [address && "Address: " + address, ampUrl && "AMP: " + ampUrl, hubspotUrl && "HubSpot: " + hubspotUrl, config && "Config lookup: " + config].filter(Boolean).join("\n"),
    ampUrl,
    hubspotUrl,
    address,
    config
  };
}

app.post("/api/blocks", validate(schemas.blockCreate), async (req, res) => { try { const body = req.body, userId = req.session.userId || (req.dccServiceAuth && req.dccServiceAuth.userId) || null; const workspaceId = req.workspaceId || (req.dccServiceAuth && req.dccServiceAuth.workspaceId) || null; const items = Array.isArray(body) ? body : [body]; if (req.dccServiceAuth && !items.every(isAllowedSweepBlockItem)) return res.status(403).json({ error: "Sweep Suite token may only create sweep_suite_task blocks" }); const results = []; for (const item of items) results.push(await blockDB.createBlock({ ...item, user_id: userId, workspace_id: workspaceId })); broadcast("blocks-changed", { action: "create", blockIds: results.map(r => r.id), clientId: body._clientId }, workspaceId); res.json(results.length === 1 ? results[0] : results); } catch (e) { res.status(400).json({ error: e.message }); } });
app.patch("/api/blocks/:id", async (req, res) => { try { const existing = await blockDB.getBlock(req.params.id); if (!existing) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(existing, req.workspaceId); const result = await blockDB.updateBlock(req.params.id, req.body); broadcast("blocks-changed", { action: "update", blockIds: [req.params.id], clientId: req.body._clientId }, req.workspaceId); res.json(result); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });
app.delete("/api/blocks/:id", async (req, res) => { try { const existing = await blockDB.getBlock(req.params.id); if (!existing) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(existing, req.workspaceId); const result = await blockDB.deleteBlock(req.params.id); broadcast("blocks-changed", { action: "delete", blockIds: [req.params.id], clientId: req.query._clientId }, req.workspaceId); res.json(result); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });
app.post("/api/blocks/batch", async (req, res) => { try { const { operations, _clientId } = req.body; if (!Array.isArray(operations)) return res.status(400).json({ error: "operations must be an array" }); const opsWithUser = operations.map(op => op.op === "create" ? { ...op, user_id: req.session.userId, workspace_id: req.workspaceId } : op); const result = await blockDB.batchOp(opsWithUser); broadcast("blocks-changed", { action: "batch", blockIds: result.blocks.map(b => b.id || b.reordered).filter(Boolean), clientId: _clientId }, req.workspaceId); res.json(result); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get("/api/blocks", async (req, res) => { try { if (req.query.date) { if (!isValidDate(req.query.date)) return res.status(400).json({ error: "Invalid date" }); await blockDB.ensureDayRoot(req.query.date, req.session.userId, req.workspaceId); res.json(filterLegacyGcalBlocks(await blockDB.getBlocksByDate(req.query.date, req.workspaceId))); } else if (req.query.type) { const types = req.query.type.split(",").filter(t => blockDB.VALID_TYPES.has(t)); if (!types.length) return res.status(400).json({ error: "No valid types" }); res.json(filterLegacyGcalBlocks(await blockDB.getBlocksByTypes(types, req.workspaceId))); } else { res.status(400).json({ error: "Provide ?date= or ?type=" }); } } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/blocks/range", async (req, res) => { try { const { start, end } = req.query; if (!start || !end || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: "Provide ?start=&end=" }); res.json(filterLegacyGcalBlocks(await blockDB.getBlocksByDateRange(start, end, req.workspaceId))); } catch (e) { res.status(500).json({ error: e.message }); } });
// dcc_state rows keyed by date for the client range cache. db.getDccStateRange
// existed but was never routed — loadDateRange (day-review, Catch up, the
// Unfinished section) 404'd here and silently returned an empty cache.
app.get("/api/dcc-state/range", async (req, res) => { try { const { start, end } = req.query; if (!start || !end || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: "Provide ?start=&end=" }); const rows = await blockDB.getDccStateRange(start, end, req.workspaceId); const out = {}; for (const r of rows) { const key = (r.date instanceof Date) ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10); out[key] = r.state_json; } res.json(out); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/blocks/:id", async (req, res) => { const block = await blockDB.getBlock(req.params.id); if (!block) return res.status(404).json({ error: "Block not found" }); try { assertBlockOwnership(block, req.workspaceId); } catch { return res.status(404).json({ error: "Block not found" }); } res.json(block); });
app.get("/api/blocks/:id/children", async (req, res) => { try { const parent = await blockDB.getBlock(req.params.id); if (!parent) return res.status(404).json({ error: "Block not found" }); assertBlockOwnership(parent, req.workspaceId); res.json(await blockDB.getChildren(req.params.id, req.workspaceId)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); } });
app.post("/api/blocks/reorder", async (req, res) => { try { const { items, _clientId } = req.body; if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" }); for (const item of items) { const block = await blockDB.getBlock(item.id); if (block) assertBlockOwnership(block, req.workspaceId); } await blockDB.reorderBlocks(items); broadcast("blocks-changed", { action: "reorder", blockIds: items.map(i => i.id), clientId: _clientId }, req.workspaceId); res.json({ ok: true, reordered: items.length }); } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); } });

// ── Reschedule: move a task (and its whole subtask subtree) to another date ──
// A TRUE MOVE: the parent block and every descendant keep their ids and just
// change `date`, all in one transaction, with a single broadcast. Replaces the
// old clone-new-id + soft-delete-old flow that duplicated tasks, stranded
// subtasks, and (via its per-write broadcasts) made the UI snap back.
// Subtasks link by LOCAL id (properties.subtaskOf / .wrapId == parent local_id),
// not the DB parent_id column, so the subtree is discovered by walking those.
// A lightweight "reschedule_tombstone" is left on the origin day so the amber
// "Rescheduled away" list can render without a cross-date scan.
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
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// Quick-task route removed from blocks.js 2026-07: it duplicated (and shadowed)
// the richer handler in routes/dcc.js, which preserves source_id / notes /
// idempotency_key (needed for the Slack-bookmark deeplink + dedup). dcc.js is
// now the single POST /api/dcc/quick-task handler.

// ── Responsibilities API ──
app.get("/api/responsibilities", async (req, res) => {
  try {
    const items = await getResponsibilityBlocks(req.workspaceId);
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function apiErrorMessage(e) {
  return [e && e.message, e && e.detail, e && e.code].filter(Boolean).join(" · ") || "Request failed";
}

app.post("/api/responsibilities", async (req, res) => {
  try {
    const body = req.body || {};
    const incoming = body.properties || body;
    if (!incoming.title || !String(incoming.title).trim()) return res.status(400).json({ error: "title required" });
    const created = await upsertResponsibility({
      userId: req.session.userId,
      workspaceId: req.workspaceId,
      properties: { ...incoming, title: String(incoming.title).trim() }
    });
    broadcast("blocks-changed", { action: "responsibility-upsert", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { console.error("[responsibilities:create]", e); res.status(400).json({ error: apiErrorMessage(e) }); }
});

app.patch("/api/responsibilities/:id", async (req, res) => {
  try {
    const existing = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Responsibility not found" });
    const incoming = (req.body && req.body.properties) || req.body || {};
    const merged = { ...existing.properties, ...incoming, kind: existing.properties.kind, updatedAt: new Date().toISOString() };
    const updated = normalizeResponsibility(await blockDB.updateBlock(req.params.id, { properties: merged }));
    broadcast("blocks-changed", { action: "responsibility-update", blockIds: [updated.id] }, req.workspaceId);
    res.json(updated);
  } catch (e) { console.error("[responsibilities:update]", e); res.status(e.statusCode || 400).json({ error: apiErrorMessage(e) }); }
});

app.delete("/api/responsibilities/:id", async (req, res) => {
  try {
    const existing = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Responsibility not found" });
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "responsibility-delete", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/:id/schedule", async (req, res) => {
  try {
    const responsibility = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") return res.status(404).json({ error: "Responsibility not found" });
    const result = await scheduleResponsibilityTask({
      responsibility,
      date: (req.body && req.body.date) || getTodayStr(),
      userId: req.session.userId,
      workspaceId: req.workspaceId,
      sourceProps: (req.body && req.body.task) || {},
      force: !!(req.body && req.body.force)
    });
    broadcast("blocks-changed", { action: "responsibility-schedule", blockIds: [result.block.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/:id/complete", async (req, res) => {
  try {
    const responsibility = await getResponsibilityBlock(req.params.id, req.workspaceId);
    if (!responsibility || responsibility.properties.kind !== "responsibility_item") return res.status(404).json({ error: "Responsibility not found" });
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
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.post("/api/responsibilities/auto-schedule", async (req, res) => {
  try {
    const threshold = Number((req.body && req.body.threshold) || 70);
    const limit = Math.max(1, Math.min(10, Number((req.body && req.body.limit) || 3)));
    const buckets = Array.isArray(req.body && req.body.capacityBuckets) ? new Set(req.body.capacityBuckets) : null;
    const items = (await getResponsibilityBlocks(req.workspaceId))
      .filter(b => (b.properties || {}).kind === "responsibility_item")
      .filter(b => (b.properties || {}).status !== "archived")
      .filter(b => !buckets || buckets.has((b.properties || {}).capacityBucket))
      .filter(b => responsibilityScore(b.properties) >= threshold)
      .sort((a, b) => responsibilityScore(b.properties) - responsibilityScore(a.properties))
      .slice(0, limit);
    // Load the day once and thread its growing blockers array through every
    // placement, so N responsibilities cost one day-load instead of N (the old
    // per-item getBlocksByDate + getScheduleBlocks N+1).
    const date = (req.body && req.body.date) || getTodayStr();
    const dateStr = isValidDate(date) ? date : getTodayStr();
    const dayCtx = await loadDaySlottingContext(dateStr, req.session.userId, req.workspaceId);
    const scheduled = [];
    for (const item of items) {
      const result = await scheduleResponsibilityTask({
        responsibility: item,
        date,
        userId: req.session.userId,
        workspaceId: req.workspaceId,
        dayCtx
      });
      scheduled.push(result);
    }
    broadcast("blocks-changed", { action: "responsibility-auto-schedule", blockIds: scheduled.map(s => s.block.id) }, req.workspaceId);
    res.json({ scheduled });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/responsibilities/capture", async (req, res) => {
  try {
    const text = String((req.body && (req.body.text || req.body.rawCapture)) || "");
    if (!text.trim()) return res.status(400).json({ error: "text required" });
    const alert = parseOffersAmpAlert(text);
    if (alert) {
      const responsibility = await upsertResponsibility({
        userId: req.session.userId,
        workspaceId: req.workspaceId,
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
      const existingTrigger = (await pool.query(
        `SELECT id FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_trigger' AND properties->>'slug'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
        [triggerSlug, req.workspaceId || null]
      )).rows[0];
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
          user_id: req.session.userId,
          workspace_id: req.workspaceId
        });
      }
      const existing = alert.alertKey
        ? (await pool.query(
            `SELECT * FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_task' AND properties->>'alertKey'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
            [alert.alertKey, req.workspaceId || null]
          )).rows[0]
        : null;
      if (existing) return res.json({ responsibility, task: blockDB.parseBlock(existing), duplicate: true });
      const task = await scheduleResponsibilityTask({
        responsibility,
        date: (req.body && req.body.date) || getTodayStr(),
        userId: req.session.userId,
        workspaceId: req.workspaceId,
        sourceProps: alert,
        force: true
      });
      res.json({ responsibility, task: task.block, duplicate: false, parsed: alert });
      return;
    }
    const responsibility = await upsertResponsibility({
      userId: req.session.userId,
      workspaceId: req.workspaceId,
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
    res.json({ responsibility, duplicate: false, parsed: null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Menus + Preset Task Groups ──────────────────────────────────────────────
// Menus are user-defined named pools (kind:"task_menu"); a Repeat Responsibility
// records membership via properties.menus[] (an array of menu block ids).
// A task group (kind:"task_group") is a batch of items; each item is either a
// fixed task or a placeholder that draws from one or more menus. Adding a group
// to a day batch-creates its tasks into free slots; placeholders land as
// placeholder_task blocks that the user clicks to swap for a responsibility.

const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function getBlocksByKind(kind, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE type='block' AND properties->>'kind'=$1 AND workspace_id=$2 AND deleted_at IS NULL ORDER BY created_at ASC`, [kind, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE type='block' AND properties->>'kind'=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [kind]);
  return rows.map(blockDB.parseBlock);
}

async function getKindedBlock(id, kind, workspaceId) {
  const block = await blockDB.getBlock(id);
  if (!block) return null;
  assertBlockOwnership(block, workspaceId);
  if ((block.properties || {}).kind !== kind) return null;
  return block;
}

// ── Menus ──
app.get("/api/task-menus", async (req, res) => {
  try { res.json({ items: await getBlocksByKind("task_menu", req.workspaceId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/task-menus", async (req, res) => {
  try {
    const incoming = (req.body && req.body.properties) || req.body || {};
    const title = String(incoming.title || "").trim();
    if (!title) return res.status(400).json({ error: "title required" });
    const nowIso = new Date().toISOString();
    const props = { kind: "task_menu", title, slug: slugify(title), color: incoming.color || null, status: "active", createdAt: nowIso, updatedAt: nowIso };
    const created = await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: req.session.userId || null, workspace_id: req.workspaceId || null });
    broadcast("blocks-changed", { action: "task-menu-upsert", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { res.status(400).json({ error: apiErrorMessage(e) }); }
});

app.patch("/api/task-menus/:id", async (req, res) => {
  try {
    const existing = await getKindedBlock(req.params.id, "task_menu", req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Menu not found" });
    const incoming = (req.body && req.body.properties) || req.body || {};
    const merged = { ...existing.properties, ...incoming, kind: "task_menu", updatedAt: new Date().toISOString() };
    if (incoming.title) merged.slug = slugify(incoming.title);
    const updated = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "task-menu-update", blockIds: [updated.id] }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: apiErrorMessage(e) }); }
});

app.delete("/api/task-menus/:id", async (req, res) => {
  try {
    const existing = await getKindedBlock(req.params.id, "task_menu", req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Menu not found" });
    const menuId = req.params.id;
    // Strip this menu id from every responsibility's menus[] and every group's
    // placeholder placeholderMenus[] so no dangling references remain.
    const touched = [];
    for (const r of await getResponsibilityBlocks(req.workspaceId)) {
      const menus = Array.isArray(r.properties.menus) ? r.properties.menus : [];
      if (menus.includes(menuId)) {
        await blockDB.updateBlock(r.id, { properties: { ...r.properties, menus: menus.filter(m => m !== menuId), updatedAt: new Date().toISOString() } });
        touched.push(r.id);
      }
    }
    for (const g of await getBlocksByKind("task_group", req.workspaceId)) {
      const items = Array.isArray(g.properties.items) ? g.properties.items : [];
      let changed = false;
      const next = items.map(it => {
        if (it && it.isPlaceholder && Array.isArray(it.placeholderMenus) && it.placeholderMenus.includes(menuId)) {
          changed = true;
          return { ...it, placeholderMenus: it.placeholderMenus.filter(m => m !== menuId) };
        }
        return it;
      });
      if (changed) { await blockDB.updateBlock(g.id, { properties: { ...g.properties, items: next, updatedAt: new Date().toISOString() } }); touched.push(g.id); }
    }
    const result = await blockDB.deleteBlock(menuId);
    broadcast("blocks-changed", { action: "task-menu-delete", blockIds: [menuId, ...touched] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// ── Task groups ──
app.get("/api/task-groups", async (req, res) => {
  try { res.json({ items: await getBlocksByKind("task_group", req.workspaceId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function normalizeGroupItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it, i) => {
    const base = { local_id: it.local_id || ("tgi-" + crypto.randomUUID().slice(0, 12)), duration: Math.max(1, Math.round(Number(it.duration || 30))), priority: it.priority || "Medium" };
    if (it.isPlaceholder) return { ...base, isPlaceholder: true, placeholderMenus: Array.isArray(it.placeholderMenus) ? it.placeholderMenus : [], label: String(it.label || "Placeholder").trim() };
    return { ...base, isPlaceholder: false, title: String(it.title || "").trim(), detail: it.detail || "" };
  }).filter(it => it.isPlaceholder || it.title);
}

app.post("/api/task-groups", async (req, res) => {
  try {
    const incoming = (req.body && req.body.properties) || req.body || {};
    const title = String(incoming.title || "").trim();
    if (!title) return res.status(400).json({ error: "title required" });
    const nowIso = new Date().toISOString();
    const props = { kind: "task_group", title, slug: slugify(title), status: incoming.status || "active", items: normalizeGroupItems(incoming.items), createdAt: nowIso, updatedAt: nowIso };
    const created = await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: req.session.userId || null, workspace_id: req.workspaceId || null });
    broadcast("blocks-changed", { action: "task-group-upsert", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { res.status(400).json({ error: apiErrorMessage(e) }); }
});

app.patch("/api/task-groups/:id", async (req, res) => {
  try {
    const existing = await getKindedBlock(req.params.id, "task_group", req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Task group not found" });
    const incoming = (req.body && req.body.properties) || req.body || {};
    const merged = { ...existing.properties, ...incoming, kind: "task_group", updatedAt: new Date().toISOString() };
    if (incoming.title) merged.slug = slugify(incoming.title);
    if (incoming.items) merged.items = normalizeGroupItems(incoming.items);
    const updated = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "task-group-update", blockIds: [updated.id] }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: apiErrorMessage(e) }); }
});

app.delete("/api/task-groups/:id", async (req, res) => {
  try {
    const existing = await getKindedBlock(req.params.id, "task_group", req.workspaceId);
    if (!existing) return res.status(404).json({ error: "Task group not found" });
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "task-group-delete", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// Batch-add every item in a group onto a day's itinerary. Threads a growing
// blockers array so sequential items land in sequential free slots (no pile-up).
app.post("/api/task-groups/:id/schedule", async (req, res) => {
  try {
    const group = await getKindedBlock(req.params.id, "task_group", req.workspaceId);
    if (!group) return res.status(404).json({ error: "Task group not found" });
    const userId = req.session.userId, workspaceId = req.workspaceId;
    const dateStr = (req.body && req.body.date && isValidDate(req.body.date)) ? req.body.date : getTodayStr();
    const items = Array.isArray(group.properties.items) ? group.properties.items : [];
    const { dayStart, dayEnd, blockers } = await loadDaySlottingContext(dateStr, userId, workspaceId);
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
    res.json({ created });
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// Resolve a scheduled placeholder_task in place: rewrite its properties to a
// responsibility_task at the SAME slot (reusing buildResponsibilityTaskProps),
// keeping its local_id and duration so the timeline layout is unchanged.
app.post("/api/task-groups/resolve-placeholder", async (req, res) => {
  try {
    const { placeholderBlockId, responsibilityId } = req.body || {};
    if (!placeholderBlockId || !responsibilityId) return res.status(400).json({ error: "placeholderBlockId and responsibilityId required" });
    const ph = await blockDB.getBlock(placeholderBlockId);
    if (!ph) return res.status(404).json({ error: "Placeholder not found" });
    assertBlockOwnership(ph, req.workspaceId);
    const phProps = ph.properties || {};
    if (!phProps.isPlaceholder && phProps.kind !== "placeholder_task") return res.status(400).json({ error: "Block is not a placeholder" });
    const responsibility = await getResponsibilityBlock(responsibilityId, req.workspaceId);
    if (!responsibility) return res.status(404).json({ error: "Responsibility not found" });
    const dateStr = ph.date || (req.body && req.body.date) || getTodayStr();
    const duration = Math.max(1, Math.round(Number(phProps.duration || taskDuration(responsibility.properties))));
    const slot = hhmmToMinutes(phProps.start);
    const localId = phProps.local_id;
    const taskProps = buildResponsibilityTaskProps(responsibility, { duration, slot, localId, sourceProps: {} });
    taskProps.taskGroupId = phProps.taskGroupId || null;
    const updated = await blockDB.updateBlock(placeholderBlockId, { properties: taskProps });
    await attachDefaultSubtasks(localId, responsibility.properties, {}, dateStr, req.session.userId, req.workspaceId);
    broadcast("blocks-changed", { action: "placeholder-resolve", blockIds: [placeholderBlockId] }, req.workspaceId);
    res.json(updated);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

// PIN 3: apply a top-level block diff forward across all future days that
// already have blocks. Matches each target block by (name, blockType); skips
// any day where the current values no longer equal the diff's originalValues
// so per-day customizations on future days are preserved. Nested children are
// NOT propagated in v1 — the client's diff already filters to top-level only.
app.post("/api/blocks/apply-forward", async (req, res) => {
  try {
    const { fromDate, diff } = req.body || {};
    if (!fromDate || !isValidDate(fromDate)) return res.status(400).json({ error: "Invalid fromDate" });
    if (!diff || typeof diff !== "object") return res.status(400).json({ error: "Missing diff" });
    const updates = Array.isArray(diff.updates) ? diff.updates : [];
    const creates = Array.isArray(diff.creates) ? diff.creates : [];
    const deletes = Array.isArray(diff.deletes) ? diff.deletes : [];
    const userId = req.session.userId || null;
    const workspaceId = req.workspaceId || null;

    // Distinct future dates that have non-deleted blocks in this workspace
    const futureDatesResult = await pool.query(
      "SELECT DISTINCT date FROM blocks WHERE deleted_at IS NULL AND date > $1 AND ($2::text IS NULL OR workspace_id = $2) ORDER BY date ASC",
      [fromDate, workspaceId]
    );
    const futureDates = futureDatesResult.rows.map(r => r.date instanceof Date ? r.date.toISOString().split("T")[0] : String(r.date).split("T")[0]);

    const PROP_KEYS = ["name","blockType","start","end","protected","warnThreshold","acceptedTags"];
    function sameProps(current, expected){
      for (const k of PROP_KEYS){
        const cv = current[k] === undefined ? null : current[k];
        const ev = expected[k] === undefined ? null : expected[k];
        if (JSON.stringify(cv) !== JSON.stringify(ev)) return false;
      }
      return true;
    }

    let daysUpdated = 0;
    let daysSkipped = 0;
    let blocksUpdated = 0;
    let blocksCreated = 0;
    let blocksDeleted = 0;
    let skippedCount = 0;
    const skippedDates = [];

    for (const date of futureDates) {
      const dayBlocks = await blockDB.getBlocksByDate(date, workspaceId);
      // Top-level "block" type only; ignore nested children + other types
      const topBlocks = dayBlocks.filter(b => b.type === "block" && !b.parent_id);
      let dayTouched = false;
      let daySkipped = 0;

      // Updates
      for (const u of updates) {
        const target = topBlocks.find(b => (b.properties||{}).name === u.match.name && (b.properties||{}).blockType === u.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, u.originalValues)) { daySkipped++; continue; }
        const merged = Object.assign({}, target.properties || {}, u.newValues);
        await blockDB.updateBlock(target.id, { properties: merged });
        blocksUpdated++;
        dayTouched = true;
      }

      // Creates
      for (const c of creates) {
        const newName = c.block && c.block.properties && c.block.properties.name;
        const existing = topBlocks.find(b => (b.properties||{}).name === newName);
        if (existing) continue; // dedupe: a same-named block is already here
        await blockDB.createBlock({
          type: "block",
          parent_id: null,
          date: date,
          properties: c.block.properties,
          sort_order: c.block.sort_order || 0,
          user_id: userId,
          workspace_id: workspaceId
        });
        blocksCreated++;
        dayTouched = true;
      }

      // Deletes
      for (const d of deletes) {
        const target = topBlocks.find(b => (b.properties||{}).name === d.match.name && (b.properties||{}).blockType === d.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, d.originalValues)) { daySkipped++; continue; }
        await blockDB.deleteBlock(target.id);
        blocksDeleted++;
        dayTouched = true;
      }

      if (dayTouched) daysUpdated++;
      else if (daySkipped > 0) { daysSkipped++; skippedDates.push(date); }
      skippedCount += daySkipped;
    }

    broadcast("blocks-changed", { action: "apply-forward", fromDate, daysUpdated }, workspaceId);
    res.json({ daysUpdated, daysSkipped, blocksUpdated, blocksCreated, blocksDeleted, skippedCount, skippedDates });
  } catch (e) {
    console.error("[apply-forward] error:", e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// ── Delegated Items API (PIN 10.A) ──
// Wraps blockDB CRUD, stamping properties.kind = "delegated_item" on create.
// GET list uses a dedicated db query; mutations reuse the generic
// createBlock/updateBlock/deleteBlock primitives. PATCH and DELETE both
// verify the target's kind discriminator so these routes can't be used
// to modify tags or other type:"block" data.
app.get("/api/delegated-items", async (req, res) => {
  try {
    const items = await blockDB.getDelegatedItems(req.workspaceId);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/delegated-items", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.properties || typeof body.properties !== "object") {
      return res.status(400).json({ error: "properties required" });
    }
    const props = { ...body.properties, kind: "delegated_item" };
    // The slimmed modal anchors items on myTask; title survives for legacy items.
    const named = v => typeof v === "string" && v.trim();
    if (!named(props.title) && !named(props.myTask)) {
      return res.status(400).json({ error: "properties.title or properties.myTask required" });
    }
    const created = await blockDB.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: props,
      sort_order: 0,
      user_id: req.session.userId,
      workspace_id: req.workspaceId
    });
    broadcast("blocks-changed", { action: "delegated-create", blockIds: [created.id] }, req.workspaceId);
    res.json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch("/api/delegated-items/:id", async (req, res) => {
  try {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) return res.status(404).json({ error: "Delegated item not found" });
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") {
      return res.status(404).json({ error: "Delegated item not found" });
    }
    const incoming = (req.body && req.body.properties) || {};
    // Preserve kind discriminator — clients cannot unset it via PATCH
    const merged = { ...existing.properties, ...incoming, kind: "delegated_item" };
    const result = await blockDB.updateBlock(req.params.id, { properties: merged });
    broadcast("blocks-changed", { action: "delegated-update", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.delete("/api/delegated-items/:id", async (req, res) => {
  try {
    const existing = await blockDB.getBlock(req.params.id);
    if (!existing) return res.status(404).json({ error: "Delegated item not found" });
    assertBlockOwnership(existing, req.workspaceId);
    if ((existing.properties || {}).kind !== "delegated_item") {
      return res.status(404).json({ error: "Delegated item not found" });
    }
    const result = await blockDB.deleteBlock(req.params.id);
    broadcast("blocks-changed", { action: "delegated-delete", blockIds: [req.params.id] }, req.workspaceId);
    res.json(result);
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

};
