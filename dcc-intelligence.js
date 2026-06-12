const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SOURCE_CONFIG_FILE = path.join("config", "dcc-sources.json");

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableId(prefix, parts) {
  const hash = crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function parseMinute(value) {
  if (!value) return null;
  const raw = String(value);
  const hhmm = raw.includes("T") ? raw.slice(11, 16) : raw.slice(0, 5);
  const parts = hhmm.split(":").map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

function formatMinute(mins) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function normalizePriority(value) {
  const raw = String(value || "normal").toLowerCase();
  if (["urgent", "critical", "high", "p1"].includes(raw)) return "High";
  if (["low", "p3", "p4"].includes(raw)) return "Low";
  return "Medium";
}

function urgencyPriority(score) {
  const n = Number(score);
  if (Number.isFinite(n)) {
    if (n >= 75) return "High";
    if (n <= 34) return "Low";
  }
  return "Medium";
}

function addMinutesHHMM(start, minutes) {
  const startMin = parseMinute(start);
  if (startMin == null) return "";
  return formatMinute(startMin + (parseInt(minutes, 10) || 30));
}

function sourceHealth(id, status, detail, count) {
  return {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    status,
    detail,
    count: count || 0,
    checked_at: new Date().toISOString(),
  };
}

function normalizeTriageItem(source, raw) {
  const title = raw.title || raw.subject || raw.text || raw.name || "Untitled item";
  const sourceId = raw.source_id || raw.id || raw.url || title;
  return {
    id: raw.id || stableId(source, [sourceId, title]),
    source,
    source_id: sourceId,
    type: raw.type || source,
    title,
    summary: raw.summary || raw.notes || raw.body || raw.description || "",
    priority: normalizePriority(raw.priority || raw.escalation_level),
    link: raw.link || raw.url || raw.source_link || "",
    created_at: raw.created_at || raw.createdAt || new Date().toISOString(),
    status: raw.status || "open",
  };
}

function normalizeTriageCheckItem(raw, index) {
  const source = String(raw.source || raw.channel || raw.type || "triage-check").toLowerCase();
  const sourceId = raw.source_id || raw.thread_id || raw.message_id || raw.id || raw.source_url || raw.source_ref || raw.title || `item-${index}`;
  const urgencyScore = Math.max(0, Math.min(100, Number(raw.urgency_score ?? raw.urgency ?? raw.score ?? 50) || 50));
  const priority = raw.priority ? normalizePriority(raw.priority) : urgencyPriority(urgencyScore);
  const sourceUrl = raw.source_url || raw.source_ref || raw.link || raw.url || "";
  const draftUrl = raw.draft_url || raw.draft_link || "";
  const reason = raw.needs_attention_reason || raw.reason || raw.summary || "";
  const title = raw.title || raw.subject || raw.text || `Review ${source} response`;
  return {
    id: raw.id || stableId("triage-check", [source, sourceId, draftUrl, title]),
    source: "triage-check",
    source_id: `${source}|${sourceId}`,
    type: source === "gmail" || source === "email" ? "email_needs_response" : (source === "slack" ? "slack_mention" : "unanswered_dm"),
    title,
    summary: reason,
    priority,
    urgency_score: urgencyScore,
    needs_attention_reason: reason,
    link: sourceUrl,
    source_url: sourceUrl,
    link_label: raw.link_label || "Open source",
    draft_link: draftUrl,
    draft_url: draftUrl,
    draft_id: raw.draft_id || draftUrl || "",
    draft_type: raw.draft_type || (source === "gmail" || source === "email" ? "gmail" : source),
    action_label: raw.action_label || "Review draft",
    recommended_action: raw.recommended_action || "review_edit_send",
    deadline: raw.deadline || raw.due_at || "",
    created_at: raw.created_at || raw.createdAt || new Date().toISOString(),
    status: raw.status || "open",
    queue_label: raw.queue_label || "Triage Check",
    triage_check: true,
  };
}

function normalizeSuggestedTask(raw, index) {
  const title = raw.title || raw.name || raw.text || "Untitled suggestion";
  return {
    id: raw.id || stableId("deep-task", [raw.source_item_id, title, index == null ? "" : String(index)]),
    title,
    priority: normalizePriority(raw.priority),
    duration_minutes: parseInt(raw.duration_minutes || raw.durMin || raw.length_minutes || 30, 10) || 30,
    recommended_start: raw.recommended_start || raw.start || "",
    confidence: raw.confidence || raw.source || "deep sweep",
    reason: raw.reason || raw.summary || raw.detail || "",
    tags: asArray(raw.tags).length ? raw.tags : ["DCC", "deep-sweep"],
    source_item_id: raw.source_item_id || raw.source_id || raw.id || null,
  };
}

function dedupeBy(items, keyFn) {
  const seen = new Map();
  for (const item of asArray(items)) {
    const key = keyFn(item);
    if (!key) continue;
    seen.set(key, { ...seen.get(key), ...item });
  }
  return Array.from(seen.values());
}

async function readConfiguredSource(sourceId, config, itemKey) {
  const section = config[sourceId] || {};
  if (section.enabled === false) {
    return { items: [], health: sourceHealth(sourceId, "disabled", "Reader disabled in DCC source config.", 0) };
  }
  const items = asArray(section[itemKey] || section.items).map((item) => normalizeTriageItem(sourceId, item));
  if (!section.enabled && items.length === 0) {
    return { items, health: sourceHealth(sourceId, "unconfigured", "No DCC source config found yet.", 0) };
  }
  return { items, health: sourceHealth(sourceId, "ok", items.length ? "Configured items imported." : "Configured, no open items.", items.length) };
}

async function readCalendar({ state }) {
  const meetings = asArray(state.meetings);
  const calendarItems = asArray(state.schedule && state.schedule.timeline)
    .filter((item) => item.source === "calendar" || item.type === "meeting");
  const seen = new Set();
  const merged = [];
  for (const item of [...meetings, ...calendarItems]) {
    const key = item.id || item.source_id || `${item.title || item.label}|${item.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return {
    meetings: merged,
    health: sourceHealth("calendar", "ok", merged.length ? "Calendar signal loaded from DCC schedule." : "No meetings found for this day.", merged.length),
  };
}

async function runReaders({ state, dataDir }) {
  const config = readJSON(path.join(dataDir, SOURCE_CONFIG_FILE), {});
  const [gmail, slack, notion, custom, calendar] = await Promise.all([
    readConfiguredSource("gmail", config, "items"),
    readConfiguredSource("slack", config, "items"),
    readConfiguredSource("notion", config, "tasks"),
    readConfiguredSource("custom", config, "items"),
    readCalendar({ state }),
  ]);

  return {
    openItems: [...gmail.items, ...slack.items, ...notion.items, ...custom.items],
    meetings: calendar.meetings,
    health: [gmail.health, slack.health, calendar.health, notion.health, custom.health],
  };
}

function mergeOpenItems(existing, incoming) {
  const byKey = new Map();
  for (const item of asArray(existing)) {
    const key = `${item.source || item.type || "unknown"}|${item.source_id || item.id || item.title}`;
    byKey.set(key, item);
  }
  for (const item of incoming) {
    const key = `${item.source || item.type || "unknown"}|${item.source_id || item.id || item.title}`;
    byKey.set(key, { ...byKey.get(key), ...item, status: "open" });
  }
  return Array.from(byKey.values()).filter((item) => item.status !== "resolved");
}

function taskFromTriage(item, index) {
  return {
    id: stableId("triage-task", [item.id, item.title]),
    title: item.source === "notion" ? item.title : `Review: ${item.title}`,
    priority: item.priority || "Medium",
    duration_minutes: item.priority === "High" ? 30 : 20,
    recommended_start: formatMinute(9 * 60 + index * 30),
    confidence: "reader signal",
    reason: item.summary || `Pulled from ${item.source || item.type || "DCC"} triage.`,
    tags: ["DCC", item.source || item.type || "triage"],
    source_item_id: item.id,
  };
}

function taskFromMeeting(meeting, index) {
  const startMin = parseMinute(meeting.start) || (10 * 60 + index * 60);
  return {
    id: stableId("meeting-prep", [meeting.id, meeting.source_id, meeting.title || meeting.label, meeting.start]),
    title: `Prep: ${meeting.title || meeting.label || "Meeting"}`,
    priority: "Medium",
    duration_minutes: 15,
    recommended_start: formatMinute(Math.max(7 * 60, startMin - 45)),
    confidence: "calendar",
    reason: "Calendar meeting found for today; reserve a quick prep block if useful.",
    tags: ["DCC", "calendar", "prep"],
    source_item_id: meeting.id || meeting.source_id || null,
  };
}

function buildBrief({ state, openItems, meetings, health }) {
  const existingBrief = state.glymphatic_brief || {};
  const previousCurrent = existingBrief.current || null;
  const deepContext = state.glymphatic_context || {};
  const highSignalItems = openItems
    .filter((item) => item.status !== "resolved")
    .sort((a, b) => (a.priority === "High" ? -1 : 1) - (b.priority === "High" ? -1 : 1));
  const triageTasks = highSignalItems.slice(0, 6).map(taskFromTriage);
  const meetingTasks = meetings
    .filter((meeting) => meeting.start)
    .slice(0, 4)
    .map(taskFromMeeting);
  const deepTasks = asArray(deepContext.suggested_tasks).map(normalizeSuggestedTask);
  const suggestedTasks = dedupeBy([...deepTasks, ...meetingTasks, ...triageTasks], (task) => task.id || task.title).slice(0, 12);
  const readySources = health.filter((h) => h.status === "ok").length;
  const deepSummary = deepContext.summary ? `${deepContext.summary} ` : "";
  const summary = `${deepSummary}${openItems.length} open reader items and ${meetings.length} calendar meetings are ready for review. Suggestions stay review-first until you add them to the itinerary.`;
  const current = {
    id: stableId("dcc-brief", [state.date, new Date().toISOString().slice(0, 13)]),
    date: state.date,
    title: "DCC Brief",
    generated_at: new Date().toISOString(),
    summary,
    source_health: health,
    triage: {
      summary: `${readySources}/${health.length} readers checked in. Review the highest-signal items before scheduling.`,
      items: openItems.slice(0, 8).map((item) => ({
        id: item.id,
        channel: item.source || item.type || "triage",
        title: item.title,
        summary: item.summary,
        priority: item.priority,
        source_link: item.link,
        draft_status: item.draft_link ? "drafted" : "needs_draft",
        draft_link: item.draft_link || "",
      })),
    },
    retro: deepContext.retro || (previousCurrent && previousCurrent.retro ? previousCurrent.retro : null),
    lessons: asArray(deepContext.lessons).length ? asArray(deepContext.lessons) : (previousCurrent && previousCurrent.lessons ? previousCurrent.lessons : []),
    disregarded: asArray(deepContext.disregarded).length ? asArray(deepContext.disregarded) : (previousCurrent && previousCurrent.disregarded ? previousCurrent.disregarded : []),
    suggested_tasks: suggestedTasks,
  };
  // The four-page brief is authored by the brain's glymphatic collector, not here.
  // Prefer freshly ingested pages from the deep-sweep context, then carry forward
  // across a UI refresh so rebuilding the triage/tasks view does not wipe them.
  const contextPages = asArray(deepContext.pages);
  if (contextPages.length) {
    current.pages = contextPages;
  } else if (previousCurrent && Array.isArray(previousCurrent.pages) && previousCurrent.pages.length) {
    current.pages = previousCurrent.pages;
  }
  return {
    current,
    history: previousCurrent ? [previousCurrent, ...asArray(existingBrief.history)].slice(0, 5) : asArray(existingBrief.history).slice(0, 5),
  };
}

async function refreshDccState({ date, state, dataDir }) {
  const base = {
    ...state,
    date,
    triage: { open_items: [], resolved_items: [], cycle_count: 0, ...(state.triage || {}) },
    schedule: { working_hours: { start: "07:00", end: "17:30" }, timeline: [], tasks_scheduled: [], tasks_couldnt_fit: [], stats: {}, ...(state.schedule || {}) },
    watermarks: { ...(state.watermarks || {}) },
    mutations: asArray(state.mutations),
    completions: state.completions || { tasks: [] },
    meta: { ...(state.meta || {}) },
  };
  const readerResult = await runReaders({ state: base, dataDir });
  const deepHealth = asArray(base.glymphatic_context && base.glymphatic_context.source_health);
  if (base.deep_sweep && base.deep_sweep.last_packet_at) {
    deepHealth.unshift(sourceHealth("deep-sweep", "ok", `Imported ${base.deep_sweep.last_source || "deep sweep"} packet.`, asArray(base.glymphatic_context && base.glymphatic_context.suggested_tasks).length));
  }
  const health = dedupeBy([...readerResult.health, ...deepHealth], (item) => item.id);
  const openItems = mergeOpenItems(base.triage.open_items, readerResult.openItems);
  const runAt = new Date().toISOString();
  const sweep = {
    last_run_at: runAt,
    readers: health.map((item) => ({ id: item.id, status: item.status, count: item.count, checked_at: item.checked_at })),
    source_health: health,
    open_item_count: openItems.length,
    meetings_count: readerResult.meetings.length,
  };
  const brief = buildBrief({ state: base, openItems, meetings: readerResult.meetings, health });
  const nextState = {
    ...base,
    last_updated_at: runAt,
    last_updated_by: "dcc-refresh",
    sweep,
    watermarks: {
      ...base.watermarks,
      dcc_refresh: runAt,
    },
    triage: {
      ...base.triage,
      open_items: openItems,
      cycle_count: (base.triage.cycle_count || 0) + 1,
    },
    meetings: readerResult.meetings,
    glymphatic_brief: brief,
    meta: {
      ...base.meta,
      dcc_refresh: {
        last_run_at: runAt,
        source_count: health.length,
      },
    },
    mutations: [
      ...base.mutations,
      { id: stableId("mutation", [date, runAt]), type: "dcc-refresh", at: runAt, open_items: openItems.length, suggested_tasks: brief.current.suggested_tasks.length },
    ].slice(-100),
  };
  return { state: nextState, sweep, brief };
}

function normalizeDeepPacket(packet, fallbackSource) {
  const raw = packet && packet.packet ? packet.packet : packet;
  const source = raw.source || raw.source_id || fallbackSource || "deep-sweep";
  const triageRoot = raw.triage || {};
  const briefRoot = raw.glymphatic_brief && raw.glymphatic_brief.current ? raw.glymphatic_brief.current : (raw.brief || raw.glymphatic_brief || {});
  const openItems = [
    ...asArray(raw.open_items),
    ...asArray(raw.triage_items),
    ...asArray(raw.items),
    ...asArray(triageRoot.open_items),
    ...asArray(triageRoot.items),
  ].map((item) => normalizeTriageItem(source, { ...item, source: item.source || source }));
  const suggestedTasks = [
    ...asArray(raw.suggested_tasks),
    ...asArray(briefRoot.suggested_tasks),
  ].map(normalizeSuggestedTask);
  const meetings = [...asArray(raw.meetings), ...asArray(briefRoot.meetings)];
  const sourceHealth = [
    ...asArray(raw.source_health),
    ...asArray(briefRoot.source_health),
    ...asArray(raw.sweep && raw.sweep.source_health),
  ];
  return {
    id: raw.id || stableId("deep-packet", [source, raw.generated_at || raw.created_at || new Date().toISOString()]),
    source,
    generated_at: raw.generated_at || raw.created_at || new Date().toISOString(),
    summary: raw.summary || briefRoot.summary || "",
    openItems,
    suggestedTasks,
    meetings,
    lessons: asArray(raw.lessons).length ? raw.lessons : asArray(briefRoot.lessons),
    disregarded: asArray(raw.disregarded).length ? raw.disregarded : asArray(briefRoot.disregarded),
    retro: raw.retro || briefRoot.retro || null,
    sourceHealth,
    pages: asArray(raw.pages).length ? asArray(raw.pages) : asArray(briefRoot.pages),
  };
}

function mergeMeetings(existing, incoming) {
  return dedupeBy([...asArray(existing), ...asArray(incoming)], (meeting) => meeting.id || meeting.source_id || `${meeting.title || meeting.label}|${meeting.start}`);
}

function ingestDeepSweepPacket({ date, state, packet, source }) {
  const normalized = normalizeDeepPacket(packet || {}, source);
  const runAt = new Date().toISOString();
  const base = {
    ...state,
    date,
    triage: { open_items: [], resolved_items: [], cycle_count: 0, ...(state.triage || {}) },
    mutations: asArray(state.mutations),
  };
  const existingContext = base.glymphatic_context || {};
  const nextContext = {
    ...existingContext,
    last_packet_id: normalized.id,
    last_packet_at: normalized.generated_at,
    last_ingested_at: runAt,
    last_source: normalized.source,
    summary: normalized.summary || existingContext.summary || "",
    suggested_tasks: dedupeBy([...asArray(existingContext.suggested_tasks), ...normalized.suggestedTasks], (task) => task.id || task.title).slice(0, 24),
    lessons: dedupeBy([...asArray(existingContext.lessons), ...normalized.lessons], (item) => item.id || item.title || item.text || JSON.stringify(item)).slice(0, 24),
    disregarded: dedupeBy([...asArray(existingContext.disregarded), ...normalized.disregarded], (item) => item.id || item.title || item.text || JSON.stringify(item)).slice(0, 24),
    retro: normalized.retro || existingContext.retro || null,
    source_health: normalized.sourceHealth,
    pages: normalized.pages.length ? normalized.pages : asArray(existingContext.pages),
  };
  const mergedOpenItems = mergeOpenItems(base.triage.open_items, normalized.openItems);
  const mergedMeetings = mergeMeetings(base.meetings, normalized.meetings);
  // Rebuild the brief immediately so an ingested packet (including its pages)
  // renders on the next reload without requiring a separate /api/dcc/refresh.
  const rebuiltBrief = buildBrief({
    state: { ...base, glymphatic_context: nextContext },
    openItems: mergedOpenItems,
    meetings: mergedMeetings,
    health: asArray(nextContext.source_health),
  });
  return {
    ...base,
    last_updated_at: runAt,
    last_updated_by: "deep-sweep-ingest",
    triage: {
      ...base.triage,
      open_items: mergedOpenItems,
    },
    meetings: mergedMeetings,
    glymphatic_brief: rebuiltBrief,
    glymphatic_context: nextContext,
    deep_sweep: {
      ...(base.deep_sweep || {}),
      last_packet_id: normalized.id,
      last_packet_at: normalized.generated_at,
      last_ingested_at: runAt,
      last_source: normalized.source,
      packet_count: ((base.deep_sweep && base.deep_sweep.packet_count) || 0) + 1,
      recent_packets: [
        { id: normalized.id, source: normalized.source, generated_at: normalized.generated_at, ingested_at: runAt, summary: normalized.summary },
        ...asArray(base.deep_sweep && base.deep_sweep.recent_packets),
      ].slice(0, 10),
    },
    mutations: [
      ...base.mutations,
      { id: stableId("mutation", [date, normalized.id, runAt]), type: "deep-sweep-ingest", at: runAt, packet_id: normalized.id, source: normalized.source, open_items: normalized.openItems.length, suggested_tasks: normalized.suggestedTasks.length },
    ].slice(-100),
  };
}

function normalizeTriageCheckPacket(packet) {
  const raw = packet || {};
  const items = [
    ...asArray(raw.items),
    ...asArray(raw.triage_items),
    ...asArray(raw.needs_attention),
    ...asArray(raw.attention_items),
  ];
  return {
    id: raw.id || stableId("triage-check-packet", [raw.source || "triage-check", raw.generated_at || raw.created_at || new Date().toISOString()]),
    source: raw.source || "triage-check",
    generated_at: raw.generated_at || raw.created_at || new Date().toISOString(),
    items: items.filter((item) => item && item.needs_attention !== false).map(normalizeTriageCheckItem),
    omitted_count: Number(raw.omitted_count || raw.no_attention_count || 0) || 0,
  };
}

function ingestTriageCheckPacket({ date, state, packet }) {
  const normalized = normalizeTriageCheckPacket(packet);
  const runAt = new Date().toISOString();
  const base = {
    ...state,
    date,
    triage: { open_items: [], resolved_items: [], cycle_count: 0, ...(state.triage || {}) },
    sweep: { source_health: [], readers: [], open_item_count: 0, meetings_count: 0, ...(state.sweep || {}) },
    mutations: asArray(state.mutations),
  };
  const mergedOpenItems = mergeOpenItems(base.triage.open_items, normalized.items);
  return {
    ...base,
    last_updated_at: runAt,
    last_updated_by: "triage-check-ingest",
    triage: {
      ...base.triage,
      open_items: mergedOpenItems,
      cycle_count: (base.triage.cycle_count || 0) + 1,
      last_triage_check_at: runAt,
    },
    sweep: {
      ...base.sweep,
      open_item_count: mergedOpenItems.length,
      last_triage_check: {
        id: normalized.id,
        source: normalized.source,
        generated_at: normalized.generated_at,
        ingested_at: runAt,
        attention_items: normalized.items.length,
      },
      source_health: [
        sourceHealth("triage-check", "ok", normalized.items.length ? `Added ${normalized.items.length} attention item(s).` : "Checked; no attention items published to DCC.", normalized.items.length),
        ...asArray(base.sweep.source_health).filter((h) => h.id !== "triage-check"),
      ],
    },
    mutations: [
      ...base.mutations,
      { id: stableId("mutation", [date, normalized.id, runAt]), type: "triage-check-ingest", at: runAt, packet_id: normalized.id, open_items: normalized.items.length, omitted_count: normalized.omitted_count },
    ].slice(-100),
  };
}

function frontPageTasks(state) {
  const current = state && state.glymphatic_brief && state.glymphatic_brief.current;
  const pages = asArray(current && current.pages);
  const front = pages.find((page) => page && page.id === "front");
  return asArray(front && front.tomorrow);
}

function briefDecisions(state) {
  return (state && state.glymphatic_brief && state.glymphatic_brief.decisions) || {};
}

function buildMaterializedBriefTask({ task, decision, targetDate }) {
  const duration = parseInt(task.duration || task.duration_minutes || task.durationMinutes || 30, 10) || 30;
  const start = decision.time || task.suggested_start || task.recommended_start || task.start || "";
  const end = start ? addMinutesHHMM(start, duration) : "";
  const priority = normalizePriority(task.priority);
  return {
    local_id: `gb-${targetDate}-${String(task.id || task.title).replace(/[^a-z0-9-]+/gi, "-").slice(0, 48)}`,
    kind: "glymphatic_itinerary_proposal",
    title: task.title || "Untitled Brief task",
    detail: task.reason || task.detail || "",
    meta: `Glymphatic Brief · ${duration}m`,
    source: "glymphatic-brief",
    source_id: task.id || null,
    glymphatic_task_id: task.id || null,
    glymphatic_decision: decision.action,
    status: "pending_approval",
    priority,
    project: task.project || "",
    duration,
    start,
    end,
    _pinnedStart: start || undefined,
    tags: asArray(task.tags).length ? task.tags : ["glymphatic", "brief"],
    createdAt: new Date().toISOString(),
  };
}

function materializeBriefPlan({ sourceState, targetDate, existingBlocks = [] }) {
  const tasks = frontPageTasks(sourceState);
  const decisions = briefDecisions(sourceState);
  const existingIds = new Set(asArray(existingBlocks).map((block) => {
    const props = (block && block.properties) || {};
    return props.glymphatic_task_id || props.source_id || null;
  }).filter(Boolean));
  const items = [];
  const skipped = [];
  const unreviewed = [];
  const alreadyExisting = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;
    const decision = decisions[task.id];
    if (!decision) {
      unreviewed.push(task);
      continue;
    }
    if (decision.action === "backlog" || decision.action === "drop") {
      skipped.push({ task, decision });
      continue;
    }
    if (decision.action !== "accept" && decision.action !== "schedule") {
      skipped.push({ task, decision });
      continue;
    }
    if (existingIds.has(task.id)) {
      alreadyExisting.push({ task, decision });
      continue;
    }
    items.push({ task, decision, properties: buildMaterializedBriefTask({ task, decision, targetDate }) });
  }

  return {
    items,
    counts: {
      created: 0,
      pending: items.length,
      skipped: skipped.length,
      alreadyExisting: alreadyExisting.length,
      unreviewed: unreviewed.length,
      total: tasks.length,
    },
    skipped,
    unreviewed,
    alreadyExisting,
  };
}

module.exports = {
  refreshDccState,
  ingestDeepSweepPacket,
  ingestTriageCheckPacket,
  normalizeDeepPacket,
  runReaders,
  buildBrief,
  materializeBriefPlan,
  frontPageTasks,
};
