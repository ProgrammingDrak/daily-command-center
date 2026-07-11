// responsibility-store.js — the responsibility domain, the server-side slot
// engine, and the block apply-forward engine, extracted from routes/blocks.js
// (dcc-improvements P8). This is a CODE MOVE, not a rewrite: every function
// body is verbatim; only dependency wiring changed.
//
// Two layers:
//   - Pure helpers (scoring, cadence, time math, alert parsing, task-props
//     builder) are module-level exports so they unit-test with no DB or HTTP.
//   - Operations that touch persistence come from createResponsibilityStore(),
//     a factory the caller instantiates with the deps that live in server
//     scope: blockDB, getScheduleBlocks, getTodayStr, and the shared
//     assertBlockOwnership guard. This keeps the store a plain require()-able
//     module while letting tests inject a fake blockDB.
//
// SQL was moved into db.js (getResponsibilityBlocks, findResponsibilityBySlug,
// getBlocksByKind, findResponsibilityTriggerBySlug, findResponsibilityTaskByAlertKey,
// getFutureDatesWithBlocks); this module never touches the pool directly.

const crypto = require("crypto");
const { isValidDate } = require("./lib/route-helpers");

const RESPONSIBILITY_KINDS = new Set(["responsibility_item", "responsibility_trigger"]);

// ── Responsibility model (pure) ──

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

// ── Time helpers (pure) ──

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

// ── Persistence-touching operations ──
// Factory: the caller injects blockDB, the two server-scope helpers
// (getScheduleBlocks, getTodayStr), and the shared assertBlockOwnership guard.
function createResponsibilityStore({ blockDB, getScheduleBlocks, getTodayStr, assertBlockOwnership }) {
  async function getResponsibilityBlocks(workspaceId) {
    return (await blockDB.getResponsibilityBlocks(workspaceId)).map(normalizeResponsibility);
  }

  async function getResponsibilityBlock(id, workspaceId) {
    const block = await blockDB.getBlock(id);
    if (!block) return null;
    assertBlockOwnership(block, workspaceId);
    if (!RESPONSIBILITY_KINDS.has((block.properties || {}).kind)) return null;
    return normalizeResponsibility(block);
  }

  async function findResponsibilityBySlug(slug, workspaceId) {
    const row = await blockDB.findResponsibilityBySlug(slug, workspaceId);
    return row ? normalizeResponsibility(row) : null;
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

  async function getKindedBlock(id, kind, workspaceId) {
    const block = await blockDB.getBlock(id);
    if (!block) return null;
    assertBlockOwnership(block, workspaceId);
    if ((block.properties || {}).kind !== kind) return null;
    return block;
  }

  // PIN 3: apply a top-level block diff forward across all future days that
  // already have blocks. Matches each target block by (name, blockType); skips
  // any day where the current values no longer equal the diff's originalValues
  // so per-day customizations on future days are preserved. Nested children are
  // NOT propagated in v1 — the client's diff already filters to top-level only.
  //
  // P2 atomicity (preserved on the P8 move): every future-day mutation is
  // gathered into one `ops[]` and committed via a SINGLE blockDB.batchOp(ops).
  // The read/match phase stays outside the tx (same read-then-write TOCTOU as
  // before). Do NOT revert to per-op autocommits.
  async function applyForwardDiff({ fromDate, diff, userId, workspaceId }) {
    const updates = Array.isArray(diff.updates) ? diff.updates : [];
    const creates = Array.isArray(diff.creates) ? diff.creates : [];
    const deletes = Array.isArray(diff.deletes) ? diff.deletes : [];

    // Distinct future dates that have non-deleted blocks in this workspace
    const futureDates = await blockDB.getFutureDatesWithBlocks(fromDate, workspaceId);

    const PROP_KEYS = ["name", "blockType", "start", "end", "protected", "warnThreshold", "acceptedTags"];
    function sameProps(current, expected) {
      for (const k of PROP_KEYS) {
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
    // Gather every mutation across all future days here, then apply them in ONE
    // transaction (blockDB.batchOp) below.
    const ops = [];

    for (const date of futureDates) {
      const dayBlocks = await blockDB.getBlocksByDate(date, workspaceId);
      // Top-level "block" type only; ignore nested children + other types
      const topBlocks = dayBlocks.filter(b => b.type === "block" && !b.parent_id);
      let dayTouched = false;
      let daySkipped = 0;

      // Updates
      for (const u of updates) {
        const target = topBlocks.find(b => (b.properties || {}).name === u.match.name && (b.properties || {}).blockType === u.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, u.originalValues)) { daySkipped++; continue; }
        const merged = Object.assign({}, target.properties || {}, u.newValues);
        ops.push({ op: "update", id: target.id, properties: merged });
        blocksUpdated++;
        dayTouched = true;
      }

      // Creates
      for (const c of creates) {
        const newName = c.block && c.block.properties && c.block.properties.name;
        const existing = topBlocks.find(b => (b.properties || {}).name === newName);
        if (existing) continue; // dedupe: a same-named block is already here
        ops.push({
          op: "create",
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
        const target = topBlocks.find(b => (b.properties || {}).name === d.match.name && (b.properties || {}).blockType === d.match.blockType);
        if (!target) { daySkipped++; continue; }
        if (!sameProps(target.properties || {}, d.originalValues)) { daySkipped++; continue; }
        ops.push({ op: "delete", id: target.id });
        blocksDeleted++;
        dayTouched = true;
      }

      if (dayTouched) daysUpdated++;
      else if (daySkipped > 0) { daysSkipped++; skippedDates.push(date); }
      skippedCount += daySkipped;
    }

    // Atomic: all future-day mutations commit together or none do.
    if (ops.length) await blockDB.batchOp(ops);

    return { daysUpdated, daysSkipped, blocksUpdated, blocksCreated, blocksDeleted, skippedCount, skippedDates };
  }

  return {
    getResponsibilityBlocks,
    getResponsibilityBlock,
    findResponsibilityBySlug,
    upsertResponsibility,
    loadDaySlottingContext,
    scheduleResponsibilityTask,
    attachDefaultSubtasks,
    getKindedBlock,
    applyForwardDiff,
    // pure helpers, exposed on the instance for route convenience
    buildResponsibilityTaskProps,
    taskDuration,
    responsibilityScore,
    normalizeResponsibility,
    defaultSubtasksForResponsibility,
    firstFreeSlot,
    hhmmToMinutes,
    minutesToHHMM,
    parseOffersAmpAlert,
    RESPONSIBILITY_KINDS,
  };
}

module.exports = createResponsibilityStore;
Object.assign(module.exports, {
  cadenceDays,
  localDateOnly,
  daysInMonth,
  preferredCompletionDue,
  responsibilityScore,
  normalizeResponsibility,
  taskDuration,
  defaultSubtasksForResponsibility,
  hhmmToMinutes,
  minutesToHHMM,
  firstFreeSlot,
  buildResponsibilityTaskProps,
  parseOffersAmpAlert,
  RESPONSIBILITY_KINDS,
});
