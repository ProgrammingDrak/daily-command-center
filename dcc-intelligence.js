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
  // Carry it forward across a UI refresh so rebuilding the triage/tasks view does
  // not wipe the pages.
  if (previousCurrent && Array.isArray(previousCurrent.pages) && previousCurrent.pages.length) {
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
  };
  return {
    ...base,
    last_updated_at: runAt,
    last_updated_by: "deep-sweep-ingest",
    triage: {
      ...base.triage,
      open_items: mergeOpenItems(base.triage.open_items, normalized.openItems),
    },
    meetings: mergeMeetings(base.meetings, normalized.meetings),
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

module.exports = {
  refreshDccState,
  ingestDeepSweepPacket,
  normalizeDeepPacket,
  runReaders,
  buildBrief,
};
