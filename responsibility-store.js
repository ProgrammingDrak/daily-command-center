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
// The recurrence lifecycle (pause / skip / anchor / resolve) lives in
// lib/recurrence.js so it stays pure and testable. This module owns the reads
// and writes; that one owns the decisions. See its header for the invariant.
const recurrence = require("./lib/recurrence");
const scheduledRecurrence = require("./lib/scheduled-recurrence");

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

// localDateOnly / daysInMonth moved to lib/recurrence.js when the cadence math
// did. They are reachable as recurrence.localDateOnly / recurrence.daysInMonth
// (and this module re-exports `recurrence`); keeping stale copies here would let a
// future caller pick the wrong one and quietly re-fork the math.

// Delegates to lib/recurrence.js, which evaluates the preferred day in the
// USER's timezone when one is supplied instead of the Node process's. Signature
// is back-compatible: no tz means host-local, exactly as before.
function preferredCompletionDue(props, at = new Date(), tz = null) {
  return recurrence.preferredCompletionDue(props, at, tz);
}

// The 0-100 urgency of a responsibility.
//
// D1 changed two things here, both of them the point of the phase:
//
//   1. A SUPPRESSED item scores 0. Suppressed means archived/done, paused,
//      skipped this cycle, or -- the big one -- an instance of it is already in
//      flight. THAT is the pause: while a task for this responsibility is
//      sitting on some day waiting to be done, the timer stops and the item is
//      not re-offered, on any day, no matter how much time has elapsed. Before
//      D1 the only "already scheduled" checks were scoped to the day you
//      happened to be looking at, so scheduling for tomorrow silenced nothing.
//
//   2. The preferred-day floor is GUARDED by lastCompletedAt. It used to apply
//      unconditionally, which is why clicking Done on a triage card made the
//      identical card reappear milliseconds later and keep reappearing all day.
function responsibilityScore(props, at = new Date(), tz = null) {
  if (!props) return 0;
  if (props.repeatType === "scheduled") return 0;
  if (recurrence.isSuppressed(props, at, tz)) return 0;
  const days = cadenceDays(props);
  let base = 0;
  if (days) {
    // anchorMode picks the window start: "completion" (default) measures from
    // your last completion, "calendar" from the current calendar boundary.
    const start = recurrence.periodStart(props, days, at, tz);
    // Calendar mode measures from the boundary and deliberately ignores
    // lastCompletedAt, so unlike completion mode it has to check satisfaction
    // explicitly -- otherwise a completed occurrence keeps getting LOUDER through
    // the rest of its period and the card returns the instant it is checked off,
    // which is the very bug this phase exists to kill.
    if (String(props.anchorMode || "completion") === "calendar") {
      const done = props.lastCompletedAt ? new Date(props.lastCompletedAt) : null;
      if (done && !Number.isNaN(done.getTime()) && done >= start) return 0;
    }
    const elapsedDays = Math.max(0, (at - start) / 86400000);
    base = Math.round((elapsedDays / days) * 100);
  }
  if (recurrence.preferredFloorApplies(props, at, tz)) {
    base = Math.max(base, Number(props.preferredCompletionScore || recurrence.PREFERRED_FLOOR));
  }
  const boost = Number(props.importanceBoost || props.boost || 0);
  return Math.max(0, Math.min(100, base + boost));
}

// Stamp the DERIVED view of a responsibility for the client.
//
// `suppressed` and `preferredDue` are here so the browser stops re-deriving the
// same decisions from its own copy of the date math. It had three copies and they
// drifted: the client's preferred-day predicate never got the completed-occurrence
// guard, so the reappear-after-Done bug survived client-side even though the
// server-side fix was correct, and the client's pause check never expired a dated
// pause. One decider, computed in the USER's zone, read as a flag.
function normalizeResponsibility(block, at = new Date(), tz = null) {
  const properties = block.properties || {};
  if (properties.repeatType === "scheduled") {
    let scheduleRule = properties.scheduleRule;
    let recurrenceSummary = "Scheduled repeat";
    let nextOccurrences = [];
    let recurrenceError = null;
    try {
      scheduleRule = scheduledRecurrence.normalizeScheduleRule(scheduleRule, { defaultTimeZone: tz || null });
      recurrenceSummary = scheduledRecurrence.scheduleSummary(scheduleRule);
      nextOccurrences = scheduledRecurrence.nextOccurrences(scheduleRule, { after: at, targetTimeZone: tz || scheduleRule.timeZone, limit: 5 });
    } catch (error) {
      recurrenceError = error.message || String(error);
    }
    return {
      ...block,
      properties: {
        ...properties,
        repeatType: "scheduled",
        scheduleRule,
        // Scheduled work climbs from 0 to 100 during the week before its next
        // occurrence. Once created, an overdue occurrence is managed by the
        // ordinary task elevation flow, while the definition points forward.
        importanceScore: nextOccurrences[0]
          ? Math.max(0, Math.min(100, Math.round(100 - ((new Date(nextOccurrences[0].instant) - at) / (7 * 86400000)) * 100)))
          : 0,
        suppressed: false,
        preferredDue: false,
        recurrenceSummary,
        nextOccurrences,
        recurrenceError,
      },
    };
  }
  return {
    ...block,
    properties: {
      ...properties,
      importanceScore: responsibilityScore(properties, at, tz),
      suppressed: recurrence.isSuppressed(properties, at, tz),
      preferredDue: recurrence.preferredFloorApplies(properties, at, tz),
    },
  };
}

// The properties to WRITE back for a block we read through normalizeResponsibility.
// importanceScore / suppressed / preferredDue are derived-for-display; persisting
// them freezes a stale answer into the row (and its operations-log entry) that
// misleads the next reader of a raw block.
function writableProps(props) {
  const clean = { ...(props || {}) };
  delete clean.importanceScore;
  delete clean.suppressed;
  delete clean.preferredDue;
  delete clean.recurrenceSummary;
  delete clean.nextOccurrences;
  delete clean.recurrenceError;
  return clean;
}

function taskDuration(props) {
  // Durations are granular to the minute (floor 1). Only the UI presets snap to 15.
  return Math.max(1, Math.round(Number(props.estimatedMinutes || props.duration || props.durationMin || 30)));
}

function invalidScheduled(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateScheduledTaskBounds(props, rule) {
  const template = normalizeTemplateTree(props.templateTree);
  const shellDuration = template ? (function total(node, isRoot = false) {
    const own = !isRoot && node.edge !== "subtask" ? Math.max(1, Number(node.durationMin) || 30) : 0;
    return own + (node.children || []).reduce((sum, child) => sum + total(child), 0);
  })(template.root, true) : 0;
  const duration = template ? shellDuration : taskDuration(props);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) throw invalidScheduled("Scheduled duration must be between 1 and 1440 minutes");
  if (rule.patternType === "calendar") {
    for (const time of rule.times) {
      if (hhmmToMinutes(time) + duration > 1440) throw invalidScheduled("Scheduled tasks cannot cross midnight");
    }
  } else {
    for (const key of rule.dateTimes) {
      if (hhmmToMinutes(key.slice(11)) + duration > 1440) throw invalidScheduled("Scheduled tasks cannot cross midnight");
    }
  }
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

// Validate + clamp a saved shell template (the reusable structure a repeat
// responsibility drops back onto a day). Enforces a shell root, coerces per-node
// duration/priority/edge, and caps node count + depth so a malformed tree can't
// fan out into hundreds of blocks. Pure; returns null when the tree is unusable.
function normalizeTemplateTree(tree, opts = {}) {
  if (!tree || typeof tree !== "object" || !tree.root) return null;
  const MAX_NODES = opts.maxNodes || 200;
  const MAX_DEPTH = opts.maxDepth || 6;
  const PRIORITIES = ["High", "Medium", "Low"];
  let count = 0;
  function node(n, depth, isRoot) {
    if (!n || typeof n !== "object") return null;
    if (++count > MAX_NODES) return null;
    const out = {
      title: String(n.title || "").slice(0, 300),
      type: isRoot ? "shell" : (typeof n.type === "string" && n.type ? n.type : "task"),
      priority: PRIORITIES.includes(n.priority) ? n.priority : "Medium",
      detail: typeof n.detail === "string" ? n.detail.slice(0, 2000) : ""
    };
    if (!isRoot) {
      out.edge = n.edge === "subtask" ? "subtask" : "wrap";
      out.durationMin = Math.max(1, Math.min(1440, Math.round(Number(n.durationMin) || 30)));
    }
    const kids = (depth < MAX_DEPTH && Array.isArray(n.children)) ? n.children : [];
    out.children = kids.map(k => node(k, depth + 1, false)).filter(Boolean);
    return out;
  }
  const root = node(tree.root, 0, true);
  if (!root || !root.title) return null;
  return { version: 1, root };
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
function createResponsibilityStore({ blockDB, getScheduleBlocks, getTodayStr, assertBlockOwnership, getDayStartMinutes = async () => null, appTimeZone = "America/New_York" }) {
  // Read the day_root row for a date WITHOUT creating one. ensureDayRoot()
  // would insert a row as a side effect of a read, which a GET must never do,
  // so the id derivation (and its ws-1 legacy fallback) is mirrored here as a
  // plain primary-key lookup. Keep in sync with db.js ensureDayRoot.
  //
  // `cache` is a per-pass Map, NOT a store-lifetime one: several definitions
  // usually share a day, so one read per day per pass is worth memoizing, but
  // the store is instantiated once for the process, so a persistent cache would
  // pin the FIRST properties it ever saw and never notice a later completion.
  async function readDayRoot(dateStr, workspaceId, cache = null) {
    // An unvalidated date reaches this from POST /:id/instance and gets
    // interpolated into a primary key, so junk like "ws-3-2026-07-29" could aim
    // the lookup at another workspace's row. Reject anything that is not a date.
    if (!isValidDate(dateStr)) return null;
    const cacheKey = `${workspaceId || ""}|${dateStr}`;
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
    const primary = workspaceId ? `day-root-${workspaceId}-${dateStr}` : `day-root-${dateStr}`;
    // NO try/catch: a failed read must NOT be reported as "no completions on this
    // day". That lie is destructive here -- for a past-dated instance it resolves
    // to "gone", clears the pointer, and permanently discards a completion that
    // lived only in the day overlay. resolveOpenInstances' per-item catch leaves
    // the definition paused instead, and the next read retries.
    let root = await blockDB.getBlock(primary);
    // The legacy un-prefixed row belongs to ws-1 only -- the SAME gate db.js
    // ensureDayRoot applies. Falling back unconditionally let any other workspace
    // settle its cadence from ws-1's _done / _deleted overlays.
    if (!root && (!workspaceId || workspaceId === "ws-1")) root = await blockDB.getBlock(`day-root-${dateStr}`);
    if (root) assertBlockOwnership(root, workspaceId);
    if (cache) cache.set(cacheKey, root);
    return root;
  }

  // Resolve the in-flight instance's ROW, whichever id shape the definition holds.
  //
  // This is the difference between the pause working and not working. The browser
  // schedules through insertTaskNow / materializeShellTemplate, whose onScheduled
  // callback reports ONE client-minted id as both localId and blockId -- and
  // blockStore.createBlock posts no id, so the row's primary key is a server UUID
  // and that client id survives only in properties.local_id. A bare getBlock()
  // therefore missed, resolveInstanceState read "no row" as "gone", and the pause
  // was erased by the very next read (the one registerOpenInstance itself
  // triggers). The headline behavior -- schedule for tomorrow, today goes quiet --
  // was working only through the server-side /schedule endpoint.
  async function findInstanceBlock({ instanceId, localId, instanceDate, workspaceId, dayCache }) {
    if (instanceId) {
      const row = await blockDB.getBlock(instanceId);
      // A row in another workspace is not our instance. Treat it as absent so a
      // bogus stamp self-heals instead of leaking that row's state back to us.
      if (row && !(row.workspace_id && workspaceId && row.workspace_id !== workspaceId)) return row;
    }
    if (!localId) return null;
    // The stamped day first (cheap, and usually right): several definitions share a
    // day, so one query per day per pass. Keep soft-deleted rows -- "deleted" is a
    // signal the resolver needs, not noise.
    if (isValidDate(instanceDate)) {
      const cacheKey = `${workspaceId || ""}|${instanceDate}`;
      let dayRows = dayCache && dayCache.get(cacheKey);
      if (!dayRows) {
        dayRows = await blockDB.getBlocksByDateIncludingDeleted(instanceDate, workspaceId);
        if (dayCache) dayCache.set(cacheKey, dayRows);
      }
      const hit = dayRows.find(b => String((b.properties || {}).local_id) === String(localId));
      if (hit) return hit;
    }
    // DATE-INDEPENDENT fallback. The stamped day can be stale or absent -- nothing
    // re-stamps the definition when the task is dragged or rescheduled to another
    // day, and a stamp can arrive with no date at all. Without this, a live
    // instance on a different day resolves to "gone" and the pause is dropped while
    // the task is sitting right there.
    if (!blockDB.findBlockByLocalId) return null;
    const found = await blockDB.findBlockByLocalId(localId, workspaceId);
    if (found && found.workspace_id && workspaceId && found.workspace_id !== workspaceId) return null;
    return found || null;
  }

  // THE RECONCILER -- the derived half of the one-open-instance invariant.
  //
  // For every definition that thinks an instance is in flight, look at what
  // actually became of that instance and settle the definition accordingly:
  //   done -> clear the pause and reset the cadence clock from the completion
  //   gone -> clear the pause, leave the clock alone (urgency resumes intact)
  //   open -> leave it paused
  //
  // Why a resolver instead of firing events at completion time: four separate
  // UI paths mark a task done and only ONE of them ever told the server (see
  // ANALYSIS.md Phase 7 -- _autoCompleteShellAncestors was the worst, meaning
  // no shell responsibility ever reset its cadence). An event hook has to be
  // wired into every path and stays wrong the moment a fifth appears. Reading
  // the instance's persisted state has no paths to miss. It also self-heals
  // rows left inconsistent by a failed write, which the old fire-and-forget
  // POST could not: a transient 500 was console.warn'd and the reset was gone.
  //
  // Runs on the read every client already makes, so the itinerary and the
  // triage strip converge without anyone scheduling a sweep.
  async function resolveOpenInstances(items, workspaceId) {
    const pending = items.filter(b => (b.properties || {}).repeatType !== "scheduled" && recurrence.hasOpenInstance(b.properties || {}));
    if (!pending.length) return items;
    const today = getTodayStr();
    const settled = new Map();
    // One read per day for THIS pass only, never store-lifetime: the store is
    // instantiated once per process, so a persistent cache would pin the first
    // properties it ever saw and never notice a later completion.
    const dayRoots = new Map();
    const dayRows = new Map();
    for (const item of pending) {
      const props = item.properties || {};
      try {
        const instanceId = props.openInstanceBlockId || null;
        const localId = props.openInstanceLocalId || null;
        const instanceBlock = await findInstanceBlock({ instanceId, localId, instanceDate: props.openInstanceDate, workspaceId, dayCache: dayRows });
        // Prefer the row's own date over the client-supplied one: the past-dated
        // safety valve must not depend on a value a caller can omit or forge.
        const instanceDate = (instanceBlock && instanceBlock.date) || props.openInstanceDate || null;
        const root = instanceDate ? await readDayRoot(instanceDate, workspaceId, dayRoots) : null;
        const { state, completedAt } = recurrence.resolveInstanceState({
          instanceBlock,
          dayRootProps: root ? (root.properties || {}) : null,
          keys: [localId, instanceId, instanceBlock && instanceBlock.id],
          instanceDate,
          todayStr: today,
        });
        if (state === "open") continue;
        const base = writableProps(props);
        const next = state === "done"
          ? recurrence.applyCompletion(base, { completedAt, taskId: (instanceBlock && instanceBlock.id) || instanceId })
          : recurrence.clearOpenInstance(base);
        const updated = await blockDB.updateBlock(item.id, { properties: next });
        settled.set(item.id, updated.properties || next);
      } catch (e) {
        // A definition we cannot settle stays paused rather than taking the
        // whole responsibilities read down with it.
        console.warn("[responsibility-store] instance resolve failed", item.id, e && e.message);
      }
    }
    if (!settled.size) return items;
    return items.map(b => (settled.has(b.id) ? { ...b, properties: settled.get(b.id) } : b));
  }

  // `tz` is the caller's IANA zone, threaded from the client so the
  // preferred-day floor is evaluated on the USER's calendar day rather than the
  // Node process's. Without it the server and browser disagreed for a 5-6 hour
  // window every day and the client trusted the server's answer.
  async function getResponsibilityBlocks(workspaceId, { tz = null } = {}) {
    const raw = await blockDB.getResponsibilityBlocks(workspaceId);
    const resolved = await resolveOpenInstances(raw, workspaceId);
    const at = new Date();
    return resolved.map(b => normalizeResponsibility(b, at, tz));
  }

  async function getResponsibilityBlock(id, workspaceId, { tz = null, client = null } = {}) {
    const block = await blockDB.getBlock(id, client);
    if (!block) return null;
    assertBlockOwnership(block, workspaceId);
    if (!RESPONSIBILITY_KINDS.has((block.properties || {}).kind)) return null;
    return normalizeResponsibility(block, new Date(), tz);
  }

  async function findResponsibilityBySlug(slug, workspaceId) {
    const row = await blockDB.findResponsibilityBySlug(slug, workspaceId);
    return row ? normalizeResponsibility(row) : null;
  }

  // ── Lifecycle writers ──
  // One writer per transition, all of them going through lib/recurrence.js so
  // the property shape is decided in exactly one place. The HTTP routes and the
  // db.js updateBlock hook both land here rather than hand-rolling merges.

  // Shared shape for all six: resolve the definition (reusing the row the route
  // already loaded rather than re-reading it), apply the pure transition to its
  // WRITABLE props, persist, and hand back the freshly normalized row. `tz` is
  // threaded uniformly so every response's derived score is computed on the user's
  // calendar day, and `at` is captured once so a transition cannot straddle
  // midnight relative to its own scoring.
  async function applyLifecycle(id, workspaceId, { existing = null, tz = null, client = null }, transition) {
    const current = existing || await getResponsibilityBlock(id, workspaceId, { tz, client });
    if (!current) return null;
    const at = new Date();
    const next = transition(writableProps(current.properties), at);
    return normalizeResponsibility(await blockDB.updateBlock(id, { properties: next }, client), at, tz);
  }

  async function markResponsibilityComplete(id, workspaceId, { completedAt, taskId, existing, tz } = {}) {
    return applyLifecycle(id, workspaceId, { existing, tz }, (props) =>
      recurrence.applyCompletion(props, { completedAt, taskId }));
  }

  // Un-checking a task must put the cadence clock back. Before D1 it left the
  // reset in place, so an accidental check-off permanently moved the next
  // occurrence a full cycle out with no way to undo it.
  async function markResponsibilityIncomplete(id, workspaceId, { blockId, localId, date, existing, tz } = {}) {
    return applyLifecycle(id, workspaceId, { existing, tz }, (props) =>
      recurrence.applyUncompletion(props, { blockId, localId, date }));
  }

  // Skip / pause / resume: the escapes that did not exist. Drake's only options
  // were Complete (lying about having done it), a browser-local one-day snooze,
  // or an irreversible Remove.
  async function skipResponsibilityCycle(id, workspaceId, { tz = null, existing } = {}) {
    return applyLifecycle(id, workspaceId, { existing, tz }, (props, at) =>
      recurrence.applySkip(props, at, tz));
  }

  async function pauseResponsibility(id, workspaceId, { until = null, existing, tz } = {}) {
    // A malformed `until` string-compares either above every real date (an
    // accidental permanent pause) or below it (a silent no-op), so anything that
    // is not a date becomes an explicit indefinite pause.
    const safeUntil = until && isValidDate(String(until).slice(0, 10)) ? until : null;
    if ((existing && existing.properties || {}).repeatType === "scheduled") {
      return withSeriesLock(id, workspaceId, (client) => applyLifecycle(id, workspaceId, { tz, client }, (props) =>
        recurrence.applyPause(props, safeUntil)));
    }
    return applyLifecycle(id, workspaceId, { existing, tz }, (props) => recurrence.applyPause(props, safeUntil));
  }

  async function resumeResponsibility(id, workspaceId, { existing, tz } = {}) {
    if ((existing && existing.properties || {}).repeatType === "scheduled") {
      return withSeriesLock(id, workspaceId, (client) => applyLifecycle(id, workspaceId, { tz, client }, (props) =>
        recurrence.applyResume(props)));
    }
    return applyLifecycle(id, workspaceId, { existing, tz }, (props) => recurrence.applyResume(props));
  }

  // Stamp the in-flight instance onto the definition. Called by the server
  // scheduler below AND by the client after it mints an instance locally
  // (public/js/responsibilities.js does its own insert via insertTaskNow, so the
  // server scheduler is not on that path). `blockId` may legitimately be a client
  // local_id rather than a row id -- findInstanceBlock resolves either.
  async function setOpenInstance(id, workspaceId, { blockId, localId, date, existing, tz } = {}) {
    const safeDate = date && isValidDate(date) ? date : null;
    return applyLifecycle(id, workspaceId, { existing, tz }, (props) =>
      recurrence.applySchedule(props, { blockId, localId, date: safeDate }));
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
    props.repeatType = properties.repeatType === "scheduled" ? "scheduled" : "readiness";
    if (props.repeatType === "scheduled") {
      props.scheduleRule = scheduledRecurrence.normalizeScheduleRule(properties.scheduleRule, {
        defaultTimeZone: appTimeZone,
        today: getTodayStr(),
      });
      validateScheduledTaskBounds(props, props.scheduleRule);
      if (!props.repeatIdentityId && existing) props.repeatIdentityId = (existing.properties || {}).repeatIdentityId || existing.id;
      if (!props.materializedThrough) props.materializedThrough = scheduledRecurrence.addDays(getTodayStr(), -1);
      // Scheduled occurrences are independent. Carrying readiness lifecycle
      // pointers into this mode would suppress the series after its first task.
      delete props.openInstanceBlockId;
      delete props.openInstanceLocalId;
      delete props.openInstanceDate;
      delete props.openInstanceAt;
      delete props.skipUntil;
    } else {
      delete props.scheduleRule;
      delete props.repeatIdentityId;
      delete props.materializedThrough;
    }
    // A saved shell structure round-trips through the spread above; validate and
    // clamp it here (or drop it if malformed) so a bad tree never persists.
    if (properties.templateTree) {
      const t = normalizeTemplateTree(properties.templateTree);
      if (t) props.templateTree = t; else delete props.templateTree;
    }
    if (existing) {
      // writableProps: `existing` came back from normalizeResponsibility, so merging
      // it raw would persist the derived importanceScore/suppressed/preferredDue.
      return normalizeResponsibility(await blockDB.updateBlock(existing.id, { properties: { ...writableProps(existing.properties), ...props, createdAt: existing.properties.createdAt || props.createdAt } }), new Date(), appTimeZone);
    }
    return normalizeResponsibility(await blockDB.createBlock({ type: "block", properties: props, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null }), new Date(), appTimeZone);
  }

  // Load a day's existing blocks and work-hour bounds once, plus the blockers
  // array the free-slot finder consumes. Shared by the responsibility scheduler
  // and the task-group scheduler so a batch pays for the day-load a single time
  // instead of once per item (the auto-schedule N+1). Callers grow `blockers`
  // as they place tasks so sequential items land in sequential free slots.
  async function loadDaySlottingContext(dateStr, userId, workspaceId) {
    // Load INCLUDING soft-deleted rows so we can honor a user's delete: if they
    // removed today's instance of a responsibility, the auto-scheduler must not
    // resurrect it today (mirrors meeting-materializer's tombstone rule). Live
    // rows drive blockers and dedup exactly as before.
    // All three reads are independent, so issue them together. The first one cannot use
    // an index (every blocks index is partial on deleted_at IS NULL) and sequential-scans,
    // so it already dominates this function; stacking two more serial round trips behind
    // it is latency for nothing.
    const [allBlocks, dayBlocks, floorMin] = await Promise.all([
      blockDB.getBlocksByDateIncludingDeleted(dateStr, workspaceId),
      getScheduleBlocks(userId, workspaceId),
      getDayStartMinutes(workspaceId),
    ]);
    const blocks = allBlocks.filter(b => !b.deleted_at);
    const deletedResponsibilityIds = new Set(
      allBlocks
        .filter(b => b.deleted_at && (b.properties || {}).kind === "responsibility_task" && (b.properties || {}).responsibilityId)
        .map(b => b.properties.responsibilityId)
    );
    const workBlocks = dayBlocks.filter(b => (b.blockType || b.type) === "work");
    // The user's start of day is a FLOOR on top of the derived bound, never a
    // replacement for it: a 05:00 work block still bounds the day, it just stops
    // pulling auto-placement into the small hours. Same contract the client engine
    // applies in public/js/day-context.js buildDayContext, which is the point --
    // one floor, four slot engines, no fifth spelling of it.
    // A null floor means "not wired" (the DI default, and every test stub), which
    // must mean NO clamp rather than a silently invented 07:00 policy.
    const derivedStart = workBlocks[0] ? hhmmToMinutes(workBlocks[0].start) : 9 * 60;
    const dayStart = floorMin == null ? derivedStart : Math.max(floorMin, derivedStart);
    // Clamped up to dayStart for the same reason the client does it in
    // public/js/day-context.js buildDayContext: raising dayStart past the end of a
    // short plan would otherwise invert the window here while the client's stayed
    // valid, and firstFreeSlot's `|| Math.max(dayStart, nowMin)` fallback would place
    // a task the client had already refused. Same clamp, same shape, both engines.
    const dayEnd = Math.max(dayStart, workBlocks.length ? hhmmToMinutes(workBlocks[workBlocks.length - 1].end) : 17 * 60);
    const blockers = blocks
      .filter(b => (b.properties || {}).start && (b.properties || {}).end)
      .map(b => ({ s: hhmmToMinutes(b.properties.start), e: hhmmToMinutes(b.properties.end) }));
    // allBlocks is exposed (tombstones included) so a caller needing a no-resurrect
    // check on this day can reuse THIS load instead of issuing a second one. The day
    // load cannot use an index — every index on `blocks` is partial on
    // `deleted_at IS NULL` — so it sequential-scans, and a second copy is not free.
    // Additive: `blocks` stays the live-only list every existing caller destructures.
    return { allBlocks, blocks, dayStart, dayEnd, blockers, deletedResponsibilityIds };
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
    // THE PAUSE. Record the in-flight instance on the definition, whatever day
    // it landed on. This is the fix for the primary bug: the old code wrote
    // nothing back here, so a responsibility scheduled for tomorrow was still
    // offered on today's strip on the very next render. Non-fatal -- a task on
    // the day beats a failed stamp, and resolveOpenInstances settles the
    // definition on the next read either way.
    try {
      const next = recurrence.applySchedule(writableProps(props), { blockId: block.id, localId, date: dateStr });
      await blockDB.updateBlock(responsibility.id, { properties: next });
    } catch (e) {
      console.warn("[responsibility-store] open-instance stamp failed", responsibility.id, e && e.message);
    }
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

  function scheduledIdentity(seriesId, occurrenceKey) {
    return `repeat:${seriesId}:${occurrenceKey}`;
  }

  function shiftTime(value, delta) {
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return value;
    return minutesToHHMM(hhmmToMinutes(value) + delta);
  }

  function scheduledBaseProps(responsibility, occurrence, rootId) {
    const props = responsibility.properties || {};
    return {
      responsibilityId: responsibility.id,
      responsibilityTitle: props.title,
      repeatMode: "scheduled",
      repeatSeriesId: responsibility.id,
      repeatIdentityId: props.repeatIdentityId || responsibility.id,
      repeatOccurrenceKey: occurrence.occurrenceKey,
      repeatOccurrenceInstant: occurrence.instant,
      repeatOccurrenceRootId: rootId,
      repeatTimeZone: occurrence.timeZone,
      source: "responsibility",
      tags: ["responsibility", "scheduled-repeat", props.domain, props.area, props.capacityBucket].filter(Boolean),
      capacityBucket: props.capacityBucket || null,
      status: "open",
      createdAt: new Date().toISOString(),
    };
  }

  // Build one generated occurrence as block rows. A shell's entire tree is in
  // the returned array so createItineraryTasks can commit it atomically.
  function scheduledRowsForOccurrence(responsibility, occurrence) {
    const props = responsibility.properties || {};
    const duration = taskDuration(props);
    const startMin = hhmmToMinutes(occurrence.start);
    const rootId = crypto.randomUUID();
    const rootLocalId = `repeat-${crypto.randomUUID().slice(0, 12)}`;
    const base = scheduledBaseProps(responsibility, occurrence, rootId);
    const template = normalizeTemplateTree(props.templateTree);
    const key = scheduledIdentity(props.repeatIdentityId || responsibility.id, occurrence.occurrenceKey);
    if (!template) {
      const root = {
        date: occurrence.date,
        id: rootId,
        properties: {
          ...base,
          kind: "scheduled_repeat_task",
          local_id: rootLocalId,
          idempotency_key: key,
          title: props.nextTaskTitle || props.title,
          detail: props.description || "",
          type: "task",
          duration,
          start: occurrence.start,
          end: minutesToHHMM(startMin + duration),
          priority: props.priority || "Medium",
          meta: `Scheduled repeat · ${props.area || props.domain || "general"} · ${duration}m`,
        },
      };
      const children = defaultSubtasksForResponsibility(props, {}).map((title) => ({
        date: occurrence.date,
        id: crypto.randomUUID(),
        parent_id: rootId,
        properties: {
          ...base,
          kind: "scheduled_repeat_task",
          local_id: `repeat-child-${crypto.randomUUID().slice(0, 12)}`,
          title,
          detail: "",
          type: "task",
          duration: 0,
          start: occurrence.start,
          end: occurrence.start,
          priority: "Medium",
          meta: "Scheduled repeat subtask",
          subtaskOf: rootLocalId,
          rel: "subtask",
        },
      }));
      return [root, ...children];
    }

    const rows = [];
    let cursor = startMin;
    function appendNode(node, parentRowId, parentLocalId, isRoot) {
      const rowId = isRoot ? rootId : crypto.randomUUID();
      const localId = isRoot ? rootLocalId : `repeat-child-${crypto.randomUUID().slice(0, 12)}`;
      const timed = isRoot || node.edge !== "subtask";
      const nodeDuration = isRoot ? 0 : Math.max(1, Number(node.durationMin) || 30);
      const nodeStart = timed ? minutesToHHMM(cursor) : null;
      if (!isRoot && timed) cursor += nodeDuration;
      const properties = {
        ...base,
        kind: "scheduled_repeat_task",
        local_id: localId,
        title: node.title,
        detail: node.detail || "",
        type: isRoot ? "shell" : (node.type || "task"),
        duration: nodeDuration,
        priority: node.priority || (isRoot ? "High" : "Medium"),
        meta: isRoot ? "Scheduled repeat shell" : "Scheduled repeat step",
      };
      if (isRoot) {
        properties.idempotency_key = key;
        properties.start = occurrence.start;
        properties.end = occurrence.start;
        properties.isWrap = true;
      } else if (node.edge === "subtask") {
        properties.subtaskOf = parentLocalId;
        properties.rel = "subtask";
      } else {
        properties.wrapId = parentLocalId;
        properties.rel = "ride_along";
        properties.start = nodeStart;
        properties.end = minutesToHHMM(hhmmToMinutes(nodeStart) + nodeDuration);
      }
      const row = { date: occurrence.date, id: rowId, parent_id: parentRowId || null, properties };
      rows.push(row);
      for (const child of node.children || []) appendNode(child, rowId, localId, false);
      return row;
    }
    const rootRow = appendNode(template.root, null, null, true);
    const elapsed = Math.max(0, cursor - startMin);
    if (startMin + elapsed > 1440) throw badLifecycle("Scheduled shell work cannot cross midnight");
    rootRow.properties.duration = elapsed;
    rootRow.properties.end = minutesToHHMM(startMin + elapsed);
    return rows;
  }

  function withSeriesLock(id, workspaceId, work) {
    return typeof blockDB.withRepeatSeriesLock === "function"
      ? blockDB.withRepeatSeriesLock(id, workspaceId, work)
      : work(null);
  }

  function activeScheduledDefinition(block) {
    const props = (block && block.properties) || {};
    return !!block && !block.deleted_at && props.kind === "responsibility_item" && props.repeatType === "scheduled"
      && (props.status || "active") === "active" && !recurrence.isPaused(props, new Date(), appTimeZone);
  }

  function sameWorkspace(block, workspaceId) {
    return block && (block.workspace_id || null) === (workspaceId || null);
  }

  async function materializeDefinitionForDate(id, { date, userId, workspaceId, targetTimeZone, allowPast = false, outputDate = null, occurrenceKey = null }) {
    return withSeriesLock(id, workspaceId, async (client) => {
      // Re-read after taking the shared series lock. This makes an update or
      // deletion authoritative over a day load that began a moment earlier.
      const responsibility = await blockDB.getBlock(id, client);
      if (!sameWorkspace(responsibility, workspaceId) || !activeScheduledDefinition(responsibility)) return [];
      if (!allowPast && date < getTodayStr()) return [];
      const props = responsibility.properties || {};
      const rule = scheduledRecurrence.normalizeScheduleRule(props.scheduleRule, {
        defaultTimeZone: appTimeZone, today: getTodayStr(),
      });
      validateScheduledTaskBounds(props, rule);
      let occurrences = scheduledRecurrence.occurrencesForDate(rule, date, {
        targetTimeZone: targetTimeZone || appTimeZone, today: getTodayStr(),
      });
      if (occurrenceKey) occurrences = occurrences.filter((occurrence) => occurrence.occurrenceKey === occurrenceKey);
      if (!occurrences.length) return [];
      const identityId = props.repeatIdentityId || responsibility.id;
      const keys = occurrences.map((occurrence) => scheduledIdentity(identityId, occurrence.occurrenceKey));
      const existing = await blockDB.getBlocksByIdempotencyKeys(workspaceId, keys, client);
      const reserved = new Set(existing.filter((row) => !row.deleted_at || !(row.properties || {}).recurrenceSupersededBy)
        .map((row) => (row.properties || {}).idempotency_key).filter(Boolean));
      const missing = occurrences.filter((occurrence) => !reserved.has(scheduledIdentity(identityId, occurrence.occurrenceKey)));
      if (!missing.length) return [];
      const rows = missing.flatMap((occurrence) => scheduledRowsForOccurrence(responsibility, occurrence));
      if (outputDate && isValidDate(outputDate)) rows.forEach((row) => { row.date = outputDate; });
      try {
        return await blockDB.createItineraryTasks(rows, { userId, workspaceId }, client);
      } catch (error) {
        if (blockDB.isIdempotencyConflict && blockDB.isIdempotencyConflict(error)) return [];
        throw error;
      }
    });
  }

  async function materializeScheduledRepeatsForDate({ date, userId, workspaceId, targetTimeZone = appTimeZone }) {
    if (!isValidDate(date)) return [];
    const definitions = (await blockDB.getResponsibilityBlocks(workspaceId)).filter(activeScheduledDefinition);
    const created = [];
    for (const definition of definitions) {
      try {
        created.push(...await materializeDefinitionForDate(definition.id, { date, userId, workspaceId, targetTimeZone }));
      } catch (error) {
        console.warn("[scheduled-repeat] materialization failed", definition.id, error.message);
      }
    }
    return created;
  }

  // Catch every series up through today before its list is shown. A sleeping
  // server may wake after one or more scheduled moments; those dated tasks are
  // still created and immediately enter the ordinary carryover/elevation flow.
  async function catchUpScheduledRepeats({ userId, workspaceId, throughDate = getTodayStr(), targetTimeZone = appTimeZone }) {
    if (!isValidDate(throughDate)) return [];
    const definitions = (await blockDB.getResponsibilityBlocks(workspaceId)).filter(activeScheduledDefinition);
    const created = [];
    for (const listed of definitions) {
      await withSeriesLock(listed.id, workspaceId, async (client) => {
        const responsibility = await blockDB.getBlock(listed.id, client);
        if (!sameWorkspace(responsibility, workspaceId) || !activeScheduledDefinition(responsibility)) return;
        const props = responsibility.properties || {};
        const rule = scheduledRecurrence.normalizeScheduleRule(props.scheduleRule, { defaultTimeZone: appTimeZone, today: getTodayStr() });
        let cursor = props.materializedThrough || scheduledRecurrence.addDays(throughDate, -1);
        if (cursor < scheduledRecurrence.addDays(rule.startDate || throughDate, -1)) cursor = scheduledRecurrence.addDays(rule.startDate, -1);
        for (let guard = 0; cursor < throughDate && guard < 730; guard++) {
          cursor = scheduledRecurrence.addDays(cursor, 1);
          const occurrences = scheduledRecurrence.occurrencesForDate(rule, cursor, { targetTimeZone, today: getTodayStr() });
          if (!occurrences.length) continue;
          const identityId = props.repeatIdentityId || responsibility.id;
          const keys = occurrences.map((occurrence) => scheduledIdentity(identityId, occurrence.occurrenceKey));
          const existing = await blockDB.getBlocksByIdempotencyKeys(workspaceId, keys, client);
          const reserved = new Set(existing.filter((row) => !row.deleted_at || !(row.properties || {}).recurrenceSupersededBy)
            .map((row) => (row.properties || {}).idempotency_key).filter(Boolean));
          const rows = occurrences.filter((occurrence) => !reserved.has(scheduledIdentity(identityId, occurrence.occurrenceKey)))
            .flatMap((occurrence) => scheduledRowsForOccurrence(responsibility, occurrence));
          if (rows.length) created.push(...await blockDB.createItineraryTasks(rows, { userId, workspaceId }, client));
        }
        // Persist only the last day actually scanned. Very old series are
        // caught up in bounded batches instead of silently skipping history.
        const fresh = await blockDB.getBlock(responsibility.id, client);
        await blockDB.updateBlock(responsibility.id, { properties: { ...(fresh.properties || {}), materializedThrough: cursor, updatedAt: new Date().toISOString() } }, client);
      });
    }
    return created;
  }

  function definitionChanges(existingProps, changes) {
    const raw = changes && changes.properties && typeof changes.properties === "object" ? changes.properties : (changes || {});
    const next = { ...writableProps(existingProps), ...raw, kind: "responsibility_item", repeatType: "scheduled", updatedAt: new Date().toISOString() };
    delete next.id;
    next.scheduleRule = scheduledRecurrence.normalizeScheduleRule(raw.scheduleRule || next.scheduleRule, {
      defaultTimeZone: appTimeZone,
      today: getTodayStr(),
    });
    if (raw.templateTree !== undefined) {
      const template = normalizeTemplateTree(raw.templateTree);
      if (template) next.templateTree = template; else delete next.templateTree;
    }
    return next;
  }

  function isCompleted(row) {
    const props = (row && row.properties) || {};
    return props.status === "done" || !!props.completedAt;
  }

  function groupSeriesRows(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = (row.properties || {}).repeatOccurrenceKey;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }

  function openGroup(group) {
    const root = group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || group[0];
    return !isCompleted(root);
  }

  async function changeScheduledSeriesLocked({ id, workspaceId, userId, action, scope, occurrenceKey, blockId, changes = {}, client = null }) {
    if (!["update", "delete"].includes(action)) throw badLifecycle("action must be update or delete");
    if (!["occurrence", "following", "series"].includes(scope)) throw badLifecycle("scope must be occurrence, following, or series");
    const definition = await getResponsibilityBlock(id, workspaceId, { tz: appTimeZone, client });
    if (!definition || (definition.properties || {}).repeatType !== "scheduled") return null;
    if (scope !== "series" && !scheduledRecurrence.validLocalKey(occurrenceKey)) throw badLifecycle("occurrenceKey must be YYYY-MM-DDTHH:mm");
    const today = getTodayStr();
    const rows = await blockDB.getRepeatSeriesBlocks(id, workspaceId, { includeDeleted: false }, client);
    const groups = groupSeriesRows(rows);
    const operations = [];
    const rematerializeDates = new Set();
    const replacementTargets = [];
    let newDefinitionId = null;

    if (scope === "occurrence") {
      const group = groups.get(occurrenceKey) || [];
      const target = blockId ? group.find((row) => row.id === blockId) : group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id);
      if (!target) throw badLifecycle("Scheduled occurrence not found", 404);
      if (action === "delete") {
        for (const row of group) operations.push({ op: "delete", id: row.id });
      } else {
        const taskChanges = changes.task && typeof changes.task === "object" ? changes.task : changes;
        if (taskChanges.date != null && !isValidDate(taskChanges.date)) throw badLifecycle("Date must be YYYY-MM-DD");
        if (taskChanges.start != null && !scheduledRecurrence.validTime(taskChanges.start)) throw badLifecycle("Start time must be HH:MM");
        const targetDate = isValidDate(taskChanges.date) ? taskChanges.date : target.date;
        const nextStart = scheduledRecurrence.validTime(taskChanges.start) ? taskChanges.start : (target.properties || {}).start;
        const nextDuration = taskChanges.durationMinutes == null ? Number((target.properties || {}).duration || 30) : Number(taskChanges.durationMinutes);
        if (!Number.isFinite(nextDuration) || nextDuration < 1 || nextDuration > 1440) throw badLifecycle("Duration must be between 1 and 1440 minutes");
        if (hhmmToMinutes(nextStart) + nextDuration > 1440) throw badLifecycle("Scheduled tasks cannot cross midnight");
        const delta = hhmmToMinutes(nextStart) - hhmmToMinutes((target.properties || {}).start);
        for (const row of group) {
          const props = { ...(row.properties || {}), recurrenceOverride: true };
          if (row.id === target.id) {
            if (taskChanges.title != null) props.title = String(taskChanges.title).slice(0, 300);
            if (taskChanges.detail != null) props.detail = String(taskChanges.detail).slice(0, 2000);
            if (taskChanges.durationMinutes != null && props.type !== "shell") props.duration = Math.max(1, Number(taskChanges.durationMinutes) || props.duration || 30);
          }
          if (props.start) props.start = shiftTime(props.start, delta);
          if (props.end) props.end = shiftTime(props.end, delta);
          if (row.id === target.id && props.type !== "shell" && taskChanges.durationMinutes != null) props.end = minutesToHHMM(hhmmToMinutes(props.start) + props.duration);
          operations.push({ op: "update", id: row.id, properties: props, date: targetDate });
        }
      }
    }

    if (scope === "following") {
      const oldProps = writableProps(definition.properties || {});
      const truncatedRule = { ...oldProps.scheduleRule, effectiveUntil: occurrenceKey };
      operations.push({ op: "update", id, properties: { ...oldProps, scheduleRule: truncatedRule, updatedAt: new Date().toISOString() } });
      for (const [key, group] of groups) {
        if (key >= occurrenceKey && openGroup(group)) {
          for (const row of group) {
            if (action === "update") operations.push({
              op: "update", id: row.id,
              properties: { ...(row.properties || {}), recurrenceSupersededBy: newDefinitionId || "pending" },
            });
            operations.push({ op: "delete", id: row.id });
          }
          if (action === "update") {
            const root = group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || group[0];
            replacementTargets.push({ sourceKey: key, outputDate: root.date });
          }
        }
      }
      if (action === "update") {
        newDefinitionId = crypto.randomUUID();
        const nextProps = definitionChanges(oldProps, changes);
        validateScheduledTaskBounds(nextProps, nextProps.scheduleRule);
        nextProps.repeatIdentityId = oldProps.repeatIdentityId || id;
        nextProps.slug = `${oldProps.slug || "scheduled-repeat"}-from-${occurrenceKey.replace(/[^0-9]/g, "")}`;
        nextProps.createdAt = new Date().toISOString();
        const selectedGroup = groups.get(occurrenceKey) || [];
        const selectedRoot = selectedGroup.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || selectedGroup[0];
        const selectedInstant = selectedRoot && (selectedRoot.properties || {}).repeatOccurrenceInstant;
        const boundaryDate = selectedInstant
          ? scheduledRecurrence.instantToLocalKey(new Date(selectedInstant), nextProps.scheduleRule.timeZone).slice(0, 10)
          : occurrenceKey.slice(0, 10);
        const oldTimes = oldProps.scheduleRule.patternType === "dates"
          ? (oldProps.scheduleRule.dateTimes || []).filter((key) => key.slice(0, 10) === occurrenceKey.slice(0, 10)).map((key) => key.slice(11))
          : (oldProps.scheduleRule.times || []);
        const newTimes = nextProps.scheduleRule.patternType === "dates"
          ? (nextProps.scheduleRule.dateTimes || []).filter((key) => key.slice(0, 10) === boundaryDate).map((key) => key.slice(11))
          : (nextProps.scheduleRule.times || []);
        const oldIndex = Math.max(0, oldTimes.indexOf(occurrenceKey.slice(11)));
        const mappedTime = newTimes[Math.min(oldIndex, Math.max(0, newTimes.length - 1))] || occurrenceKey.slice(11);
        nextProps.scheduleRule = { ...nextProps.scheduleRule, effectiveFrom: `${boundaryDate}T${mappedTime}` };
        delete nextProps.scheduleRule.effectiveUntil;
        if (oldProps.scheduleRule && oldProps.scheduleRule.end && oldProps.scheduleRule.end.type === "after"
            && nextProps.scheduleRule.end && nextProps.scheduleRule.end.type === "after") {
          // The editor's count is the total series count. Preserve that meaning
          // across a split by carrying only the unconsumed remainder forward.
          const total = Number(nextProps.scheduleRule.end.count || oldProps.scheduleRule.end.count);
          const used = scheduledRecurrence.occurrenceCountBefore(oldProps.scheduleRule, occurrenceKey, { defaultTimeZone: appTimeZone, today });
          nextProps.scheduleRule.end.count = Math.max(1, total - used);
        }
        for (const target of replacementTargets) {
          const sourceDate = target.sourceKey.slice(0, 10);
          const sourceTime = target.sourceKey.slice(11);
          const sourceTimes = oldProps.scheduleRule.patternType === "dates"
            ? (oldProps.scheduleRule.dateTimes || []).filter((key) => key.slice(0, 10) === sourceDate).map((key) => key.slice(11))
            : (oldProps.scheduleRule.times || []);
          const candidateDate = target.sourceKey === occurrenceKey ? boundaryDate : sourceDate;
          const candidateTimes = nextProps.scheduleRule.patternType === "dates"
            ? (nextProps.scheduleRule.dateTimes || []).filter((key) => key.slice(0, 10) === candidateDate).map((key) => key.slice(11))
            : (nextProps.scheduleRule.times || []);
          const ordinal = Math.max(0, sourceTimes.indexOf(sourceTime));
          const candidateTime = candidateTimes[Math.min(ordinal, Math.max(0, candidateTimes.length - 1))] || sourceTime;
          const candidateInstant = scheduledRecurrence.localKeyToInstant(`${candidateDate}T${candidateTime}`, nextProps.scheduleRule.timeZone);
          target.date = scheduledRecurrence.instantToLocalKey(candidateInstant, appTimeZone).slice(0, 10);
          target.occurrenceKey = `${candidateDate}T${candidateTime}`;
        }
        operations.push({ op: "create", id: newDefinitionId, type: "block", parent_id: null, date: null, properties: nextProps, sort_order: 0, user_id: userId, workspace_id: workspaceId });
      }
    }

    if (scope === "series") {
      if (action === "delete") {
        operations.push({ op: "delete", id });
        for (const [, group] of groups) {
          const root = group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || group[0];
          if (root.date >= today && openGroup(group)) for (const row of group) operations.push({ op: "delete", id: row.id });
        }
      } else {
        const nextProps = definitionChanges(definition.properties || {}, changes);
        validateScheduledTaskBounds(nextProps, nextProps.scheduleRule);
        operations.push({ op: "update", id, properties: nextProps });
        for (const [, group] of groups) {
          const root = group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || group[0];
          if (root.date < today || !openGroup(group)) continue;
          rematerializeDates.add(root.date);
          const wanted = scheduledRecurrence.occurrencesForDate(nextProps.scheduleRule, root.date, { targetTimeZone: appTimeZone, today });
          const occurrence = wanted.find((item) => item.occurrenceKey === (root.properties || {}).repeatOccurrenceKey);
          if (!occurrence) {
            for (const row of group) operations.push({ op: "delete", id: row.id });
            continue;
          }
          if ((root.properties || {}).recurrenceOverride) continue;
          const oldStart = (root.properties || {}).start;
          const delta = hhmmToMinutes(occurrence.start) - hhmmToMinutes(oldStart);
          for (const row of group) {
            const props = { ...(row.properties || {}) };
            if (row.id === root.id) {
              props.title = nextProps.nextTaskTitle || nextProps.title;
              props.detail = nextProps.description || props.detail || "";
              if (props.type !== "shell") props.duration = taskDuration(nextProps);
            }
            if (props.start) props.start = shiftTime(props.start, delta);
            if (props.end) props.end = shiftTime(props.end, delta);
            props.repeatOccurrenceInstant = occurrence.instant;
            props.repeatTimeZone = occurrence.timeZone;
            props.repeatOccurrenceKey = occurrence.occurrenceKey;
            if (row.id === root.id && props.type !== "shell") props.end = minutesToHHMM(hhmmToMinutes(props.start) + props.duration);
            operations.push({ op: "update", id: row.id, properties: props, date: occurrence.date });
          }
        }
      }
    }

    // The replacement id is known only after the following-series branch has
    // built it. Replace the temporary marker before the atomic batch commits.
    if (newDefinitionId) {
      for (const op of operations) {
        if (op.op === "update" && op.properties && op.properties.recurrenceSupersededBy === "pending") {
          op.properties.recurrenceSupersededBy = newDefinitionId;
        }
      }
    }
    const result = operations.length ? await blockDB.batchOp(operations, client) : { blocks: [] };
    if (action === "update") {
      const activeId = newDefinitionId || id;
      rematerializeDates.add(today);
      const updated = await getResponsibilityBlock(activeId, workspaceId, { tz: appTimeZone, client });
      return {
        definition: updated,
        newDefinitionId,
        blocks: result.blocks,
        rematerializeDates: [...rematerializeDates].sort(),
        replacementTargets,
      };
    }
    return { deleted: true, newDefinitionId: null, blocks: result.blocks };
  }

  async function changeScheduledSeries(args) {
    const result = await withSeriesLock(args.id, args.workspaceId, (client) => changeScheduledSeriesLocked({ ...args, client }));
    if (result && result.definition) {
      for (const target of result.replacementTargets || []) {
        await materializeDefinitionForDate(result.definition.id, {
          date: target.date,
          outputDate: target.outputDate,
          occurrenceKey: target.occurrenceKey,
          allowPast: true,
          userId: args.userId,
          workspaceId: args.workspaceId,
          targetTimeZone: appTimeZone,
        });
      }
      for (const date of result.rematerializeDates || []) {
        await materializeDefinitionForDate(result.definition.id, {
          date, userId: args.userId, workspaceId: args.workspaceId, targetTimeZone: appTimeZone,
        });
      }
      delete result.rematerializeDates;
      delete result.replacementTargets;
    }
    return result;
  }

  async function convertScheduledToReadiness({ id, workspaceId, changes = {} }) {
    return withSeriesLock(id, workspaceId, async (client) => {
      const definition = await getResponsibilityBlock(id, workspaceId, { tz: appTimeZone, client });
      if (!definition || (definition.properties || {}).repeatType !== "scheduled") return null;
      const rows = await blockDB.getRepeatSeriesBlocks(id, workspaceId, { includeDeleted: false }, client);
      const props = {
        ...writableProps(definition.properties || {}),
        ...(changes.properties || changes),
        repeatType: "readiness",
        updatedAt: new Date().toISOString(),
      };
      delete props.scheduleRule;
      delete props.repeatIdentityId;
      delete props.materializedThrough;
      const operations = [{ op: "update", id, properties: props }];
      const today = getTodayStr();
      for (const [, group] of groupSeriesRows(rows)) {
        const root = group.find((row) => (row.properties || {}).repeatOccurrenceRootId === row.id) || group[0];
        if (root.date >= today && openGroup(group)) for (const row of group) operations.push({ op: "delete", id: row.id });
      }
      await blockDB.batchOp(operations, client);
      return getResponsibilityBlock(id, workspaceId, { tz: appTimeZone, client });
    });
  }

  function badLifecycle(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
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
      // Load INCLUDING soft-deleted rows. Live rows drive update/delete matching
      // exactly as before, but the CREATE dedupe below has to see tombstones:
      // otherwise a block the user deliberately deleted on a future day gets
      // recreated by the next apply-forward. Same no-resurrect rule
      // meeting-materializer.js established and #253 made the house style.
      const allDayBlocks = await blockDB.getBlocksByDateIncludingDeleted(date, workspaceId);
      const dayBlocks = allDayBlocks.filter(b => !b.deleted_at);
      // Top-level "block" type only; ignore nested children + other types
      const topBlocks = dayBlocks.filter(b => b.type === "block" && !b.parent_id);
      const tombstonedNames = new Set(
        allDayBlocks
          .filter(b => b.deleted_at && b.type === "block" && !b.parent_id)
          .map(b => (b.properties || {}).name)
          .filter(Boolean)
      );
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
        if (newName && tombstonedNames.has(newName)) continue; // no-resurrect: the user deleted it here
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
    materializeScheduledRepeatsForDate,
    catchUpScheduledRepeats,
    changeScheduledSeries,
    convertScheduledToReadiness,
    attachDefaultSubtasks,
    getKindedBlock,
    applyForwardDiff,
    // recurrence lifecycle (D1)
    resolveOpenInstances,
    setOpenInstance,
    markResponsibilityComplete,
    markResponsibilityIncomplete,
    skipResponsibilityCycle,
    pauseResponsibility,
    resumeResponsibility,
    readDayRoot,
    findInstanceBlock,
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
  preferredCompletionDue,
  responsibilityScore,
  normalizeResponsibility,
  taskDuration,
  defaultSubtasksForResponsibility,
  hhmmToMinutes,
  minutesToHHMM,
  firstFreeSlot,
  buildResponsibilityTaskProps,
  normalizeTemplateTree,
  parseOffersAmpAlert,
  writableProps,
  scheduledRecurrence,
  RESPONSIBILITY_KINDS,
  // recurrence lifecycle: re-exported so callers get one import surface
  recurrence,
  DUE_THRESHOLD: recurrence.DUE_THRESHOLD,
});
