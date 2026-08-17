"use strict";

// Pure Waiting-item lifecycle helpers shared by the read overlay, HTTP routes,
// and tests. The durable discriminator stays `delegated_item` so existing rows
// and clients remain compatible while the user-facing concept becomes Waiting.

const ATTENTION_THRESHOLD = 70;
const DEFAULT_CHECK_IN_DAYS = 7;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function dateFromIso(value, timeZone = "America/New_York") {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).reduce((out, part) => {
    if (part.type !== "literal") out[part.type] = part.value;
    return out;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(dateStr, days) {
  if (!validDate(dateStr)) return null;
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.round(Number(days) || 0)));
  return date.toISOString().slice(0, 10);
}

function dayNumber(dateStr) {
  return validDate(dateStr) ? Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 86400000) : null;
}

function checkInDays(props) {
  const explicit = Number(props && props.checkInDays);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(365, Math.round(explicit));
  const legacy = String((props && props.checkInCadence) || "").toLowerCase();
  if (legacy === "daily") return 1;
  if (legacy === "monthly") return 30;
  return DEFAULT_CHECK_IN_DAYS;
}

function isOpen(item) {
  const props = (item && item.properties) || {};
  return !props.completedAt && props.status !== "done" && props.status !== "unblocked";
}

function isTaskDependency(itemOrProps) {
  const props = itemOrProps && itemOrProps.properties
    ? itemOrProps.properties
    : (itemOrProps || {});
  return props.blockerType === "task" && !!props.blockerBlockId && !!props.linkedBlockId;
}

function inferReason(props) {
  if (["blocked", "delegated", "both"].includes(props.waitingReason)) return props.waitingReason;
  if ((props.delegatee && props.delegatee.name) || props.source === "slack-delegate") return "delegated";
  return "blocked";
}

function normalizeProperties(input, existing = {}) {
  const props = { ...existing, ...(input || {}), kind: "delegated_item" };
  props.waitingReason = inferReason(props);
  props.myTask = String(props.myTask || props.title || "").trim().slice(0, 300);
  props.title = String(props.title || "").trim().slice(0, 300);
  props.delegatee = props.delegatee && typeof props.delegatee === "object"
    ? {
        name: String(props.delegatee.name || "").trim().slice(0, 160) || null,
        kind: String(props.delegatee.kind || "person").trim().slice(0, 40) || "person",
      }
    : { name: null, kind: "person" };
  props.contact = props.contact && typeof props.contact === "object"
    ? {
        channel: String(props.contact.channel || "other").trim().toLowerCase().slice(0, 40) || "other",
        address: String(props.contact.address || "").trim().slice(0, 300),
        sourceRef: String(props.contact.sourceRef || props.contact.source_ref || "").trim().slice(0, 1000),
        threadTs: String(props.contact.threadTs || props.contact.thread_ts || "").trim().slice(0, 80),
        messageTs: String(props.contact.messageTs || props.contact.message_ts || "").trim().slice(0, 80),
      }
    : { channel: "other", address: "", sourceRef: "", threadTs: "", messageTs: "" };
  props.checkInDays = checkInDays(props);
  props.blockerType = props.blockerType === "task" ? "task" : (props.blockerType || null);
  props.blockerBlockId = String(props.blockerBlockId || "").trim().slice(0, 200) || null;
  props.linkedBlockId = String(props.linkedBlockId || "").trim().slice(0, 200) || null;
  if (props.checkInDate != null && !validDate(props.checkInDate)) props.checkInDate = null;
  if (props.snoozedUntil != null && !validDate(props.snoozedUntil)) props.snoozedUntil = null;
  props.status = props.status || "open";
  return props;
}

function dueDate(item, timeZone = "America/New_York") {
  const props = normalizeProperties((item && item.properties) || {});
  if (validDate(props.checkInDate)) return props.checkInDate;
  const anchor = dateFromIso(props.lastCheckedAt || item && item.created_at || props.createdAt, timeZone);
  return anchor ? addDays(anchor, props.checkInDays) : null;
}

function blockerText(item) {
  const props = normalizeProperties((item && item.properties) || {});
  const who = props.delegatee && props.delegatee.name;
  const what = props.title;
  if (who && what) return `Blocked by ${who}: ${what}`;
  if (who) return `Waiting on ${who}`;
  if (what) return what;
  return "Waiting on an external dependency";
}

function attentionFor(item, asOfDate, opts = {}) {
  if (!item || !isOpen(item) || !validDate(asOfDate)) return null;
  const props = normalizeProperties(item.properties || {});
  // Task dependencies resolve from the prerequisite task's completion event.
  // They never produce person-style cadence reminders or message drafts.
  if (isTaskDependency(props)) return null;
  const due = dueDate({ ...item, properties: props }, opts.timeZone);
  if (!due) return null;
  if (validDate(props.snoozedUntil) && props.snoozedUntil > asOfDate) return null;

  const dueDay = dayNumber(due);
  const todayDay = dayNumber(asOfDate);
  const anchorDate = dateFromIso(props.lastCheckedAt || item.created_at || props.createdAt, opts.timeZone) || due;
  const anchorDay = dayNumber(anchorDate);
  const total = Math.max(1, dueDay - anchorDay);
  const elapsed = Math.max(0, todayDay - anchorDay);
  const score = todayDay >= dueDay ? 100 : Math.max(0, Math.min(99, Math.round((elapsed / total) * 100)));
  if (score < (opts.threshold == null ? ATTENTION_THRESHOLD : Number(opts.threshold))) return null;

  const phase = todayDay > dueDay ? "overdue" : (todayDay === dueDay ? "due" : "early");
  const cycleKey = `waiting:${item.id}:${due}`;
  return {
    id: item.id,
    waitingReason: props.waitingReason,
    task: props.myTask || props.title || "Waiting task",
    blocker: blockerText({ ...item, properties: props }),
    delegatee: props.delegatee,
    contact: props.contact,
    notes: String(props.notes || "").slice(0, 1000),
    priority: props.priority || "Medium",
    checkInDate: due,
    checkInDays: props.checkInDays,
    snoozedUntil: props.snoozedUntil || null,
    attentionScore: score,
    phase,
    cycleKey,
    draftEligible: todayDay >= dueDay,
    checkInScheduledFor: props.checkInScheduledFor || null,
    checkInTaskId: props.checkInTaskId || null,
    linkedBlockId: props.linkedBlockId || null,
    linkedTagId: props.linkedTagId || null,
    sourceRef: props.contact.sourceRef || props.source_id || "",
  };
}

function internalDraft(attention) {
  const name = attention && attention.delegatee && attention.delegatee.name;
  const greeting = name ? `Hi ${name},` : "Hi,";
  const dependency = String((attention && attention.blocker) || "this dependency")
    .replace(/^Blocked by [^:]+:\s*/i, "")
    .replace(/^Waiting on\s+/i, "");
  const task = String((attention && attention.task) || "the task");
  return `${greeting}\n\nQuick check-in on ${dependency} for ${task}. Could you let me know where this stands and whether you need anything from me?\n\nThanks.`;
}

function triageId(attention) {
  return `waiting-checkin:${attention.id}:${attention.checkInDate}`;
}

function triageItem(attention, nowIso) {
  const channel = String((attention.contact && attention.contact.channel) || "other").toLowerCase();
  const type = channel === "gmail" || channel === "email" ? "email" : (channel === "slack" ? "slack" : "waiting_checkin");
  const preview = internalDraft(attention);
  return {
    id: triageId(attention),
    source: "waiting_checkin",
    source_id: attention.cycleKey,
    type,
    title: `Check in: ${attention.task}`,
    summary: attention.blocker,
    priority: attention.priority || "Medium",
    link: attention.sourceRef || "",
    source_ref: attention.sourceRef || "",
    waiting_item_id: attention.id,
    waiting_cycle_key: attention.cycleKey,
    check_in_date: attention.checkInDate,
    contact: attention.contact,
    draft_id: `internal:${attention.cycleKey}`,
    draft_type: "internal",
    draft_preview: preview,
    draft_status: "internal",
    action_label: "Copy draft",
    recommended_action: "review_copy_send",
    estimated_minutes: 5,
    created_at: nowIso || new Date().toISOString(),
    first_seen_at: nowIso || new Date().toISOString(),
    status: "open",
  };
}

function attentionItems(items, asOfDate, opts = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => attentionFor(item, asOfDate, opts))
    .filter(Boolean)
    .sort((a, b) => b.attentionScore - a.attentionScore || a.checkInDate.localeCompare(b.checkInDate));
}

function mergeTriage(triage, waitingRows, asOfDate, opts = {}) {
  const base = triage && typeof triage === "object" ? triage : { open_items: [], resolved_items: [], cycle_count: 0 };
  const rows = Array.isArray(waitingRows) ? waitingRows : [];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const due = attentionItems(rows, asOfDate, { ...opts, threshold: 100 }).filter((item) => item.draftEligible);
  const dueByWaitingId = new Map(due.map((item) => [String(item.id), item]));
  const open = [];
  const currentByTriageId = new Map();

  for (const item of Array.isArray(base.open_items) ? base.open_items : []) {
    const waitingId = String(item && item.waiting_item_id || "");
    if (!waitingId) { open.push(item); continue; }
    const waiting = byId.get(waitingId);
    const current = dueByWaitingId.get(waitingId);
    if (!waiting || !current || !isOpen(waiting) || item.waiting_cycle_key !== current.cycleKey) continue;
    open.push(item);
    currentByTriageId.set(item.id, item);
  }

  for (const item of due) {
    const id = triageId(item);
    const existing = currentByTriageId.get(id);
    if (existing) continue;
    open.push(triageItem(item, opts.nowIso));
  }
  return { ...base, open_items: open };
}

function completeCycleProperties(item, cycleKey, completedAt, timeZone = "America/New_York") {
  const props = normalizeProperties((item && item.properties) || {});
  const currentDue = dueDate({ ...item, properties: props }, timeZone);
  const expected = currentDue ? `waiting:${item.id}:${currentDue}` : null;
  if (!expected || cycleKey !== expected) return { status: "skipped_stale", properties: props, expectedCycleKey: expected };
  if (props.lastCompletedCycleKey === cycleKey) return { status: "skipped_duplicate", properties: props, expectedCycleKey: expected };
  const completedDate = dateFromIso(completedAt, timeZone);
  return {
    status: "completed",
    expectedCycleKey: expected,
    properties: {
      ...props,
      lastCheckedAt: completedAt,
      lastCompletedCycleKey: cycleKey,
      checkInDate: addDays(completedDate, props.checkInDays),
      snoozedUntil: null,
      checkInScheduledFor: null,
      checkInTaskId: null,
      status: "open",
    },
  };
}

module.exports = {
  ATTENTION_THRESHOLD,
  DEFAULT_CHECK_IN_DAYS,
  addDays,
  attentionFor,
  attentionItems,
  blockerText,
  checkInDays,
  completeCycleProperties,
  dateFromIso,
  dueDate,
  inferReason,
  internalDraft,
  isOpen,
  isTaskDependency,
  mergeTriage,
  normalizeProperties,
  triageId,
  triageItem,
  validDate,
};
