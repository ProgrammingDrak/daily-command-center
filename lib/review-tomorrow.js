"use strict";

// Plans are pure; the existing rescheduler remains the only task mover.
const crypto = require("node:crypto");
const TaskModel = require("../public/js/task-model");
const TaskTypes = require("../public/js/task-types");
const { buildDayContext, findSlot, dayStartMinutes } = require("../public/js/day-context");
const { createSubtreeCollector, findSubtreeRoots } = require("./reschedule");
const { doneIdsFromOverlay, isBlockDone } = require("./task-timing");
const { instantToLocalKey } = require("./scheduled-recurrence");
const LIMIT = 2000;
const minutes = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const format = value => String(Math.floor(value / 60)).padStart(2, "0") + ":" + String(value % 60).padStart(2, "0");
const addDay = date => new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const version = row => [row.id, row.date || null, row.updated_at || null, row.properties || {}];
function overlay(root) {
  const p = (root && root.properties) || {}, locks = p._lockedTasks || [];
  return { done: [...doneIdsFromOverlay(p)], locked: Array.isArray(locks) ? locks : Object.keys(locks) };
}
function done(row, overlays) {
  const ov = overlays[row.date] || {};
  return isBlockDone(row, { _done: { ids: ov.done || [] } }) || (row.properties || {}).status === "completed";
}
function groupOverlays(overlays, date) {
  return { ...overlays, null: overlays[date] || {} };
}
function holdReason(row, overlays) {
  const p = row.properties || {}, ov = overlays[row.date] || {};
  if (p.locked || p._locked || p.userSetStart || p._userSetStart ||
      (ov.locked || []).includes(row.id) || (ov.locked || []).includes(p.local_id)) return "Locked or fixed by you";
  if (TaskTypes.isFixed(p.type || p.kind) || ["calendar", "gcal"].includes(String(p.source || "").toLowerCase()) ||
      p.calendar_id || p.gcal_calendar_id || p.gcal_account_key) return "Calendar or fixed appointment";
  if (p.all_day) return "All-day task: choose its dates manually";
  if (p.repeatMode === "scheduled") return "Scheduled repeat: its next occurrence is independent";
  if (p.delegatedItemId || p.waitingItemId || ["waiting", "blocked"].includes(p.status)) return "Waiting or blocked";
  if (p.startedAt && !done(row, overlays)) return "Work timer is running: pause it first";
  return null;
}
function duration(row) {
  const p = row.properties || {}, s = minutes(p.start), e = minutes(p.end);
  const d = p.duration != null ? Number(p.duration) : p.durMin != null ? Number(p.durMin) : s !== null && e > s ? e - s : null;
  return Number.isInteger(d) && d > 0 && d <= 1440 ? d : null;
}
function context(date, state, blocks, timeZone = "America/New_York") {
  const sched = (state && state.schedule) || {};
  const localMinute = value => {
    if (typeof value !== "string" || !value.includes("T")) return value;
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) throw new Error("Invalid fixed appointment time");
    const key = instantToLocalKey(instant, timeZone);
    return key.slice(0, 10) < date ? 0 : key.slice(0, 10) > date ? 1440 : minutes(key.slice(11));
  };
  const timeline = (sched.timeline || []).map(item => item && ["ooo", "break"].includes(item.type) ? { ...item, start: localMinute(item.start), end: localMinute(item.end) } : item);
  const ctx = buildDayContext(date, { ...state, schedule: { ...sched, timeline } }, blocks);
  const schedule = (state && state.schedule) || {}, hours = schedule.working_hours || {};
  // Strict, identical bounds for preview and application. Time Blocks are dividers.
  ctx.dayStart = Math.max(dayStartMinutes(state), minutes(hours.start) ?? 9 * 60);
  ctx.dayEnd = minutes(hours.end) ?? minutes(schedule.end_time) ?? 17 * 60 + 30;
  blocks.forEach(b => {
    const p = b.properties || {};
    if (p.all_day && TaskTypes.isFixed(p.type || p.kind) && p.transparency !== "transparent") ctx.meetings.push({ s: ctx.dayStart, e: ctx.dayEnd });
  });
  return ctx;
}
function scheduleFingerprint(ctx) {
  return hash([ctx.dateStr, ctx.dayStart, ctx.dayEnd, ctx.meetings,
    ctx.blocks.filter(b => !b.deleted_at && ["block", "schedule_item", "added_task"].includes(b.type) && minutes((b.properties || {}).end) > minutes((b.properties || {}).start) && minutes((b.properties || {}).start) !== null)
      .map(b => [b.id, b.properties.start, b.properties.end]).sort((a, b) => a[0].localeCompare(b[0]))]);
}
function sourceFingerprint(members, overlays) {
  return hash(members.map(row => [version(row), done(row, overlays), holdReason(row, overlays)]).sort((a, b) => a[0][0].localeCompare(b[0][0])));
}
function buildPlan({ sourceDate, rows, overlays = {}, subtreePools = {}, targetState, targetBlocks, selectedIds = null, truncated = false, days = 14, timeZone = "America/New_York" }) {
  const targetDate = addDay(sourceDate), ctx = context(targetDate, targetState, targetBlocks, timeZone);
  const targetFingerprint = hash([scheduleFingerprint(ctx), targetBlocks.map(version).sort((a, b) => a[0].localeCompare(b[0]))]);
  const selected = selectedIds && new Set(selectedIds);
  const open = rows.filter(r => !r.deleted_at && r.date && r.date <= sourceDate && TaskModel.isTaskRow(r) && !done(r, overlays));
  const canonicalRows = [...new Map([...rows, ...Object.values(subtreePools).flat()].map(row => [row.id, row])).values()];
  const openIds = new Set(open.map(row => row.id));
  const candidates = findSubtreeRoots(canonicalRows).filter(row => openIds.has(row.id)), covered = new Set();
  const collectOpen = createSubtreeCollector(open);
  candidates.forEach(row => collectOpen(row).forEach(id => covered.add(id)));
  const ambiguous = new Set(open.filter(row => !covered.has(row.id)).map(row => row.id));
  candidates.push(...open.filter(row => ambiguous.has(row.id)));
  const priority = { urgent: 0, high: 1, medium: 2, low: 3 };
  candidates.sort((a, b) => {
    const ap = a.properties || {}, bp = b.properties || {};
    return (priority[String(ap.priority || "Medium").toLowerCase()] ?? 2) - (priority[String(bp.priority || "Medium").toLowerCase()] ?? 2) ||
      a.date.localeCompare(b.date) || (duration(a) || 0) - (duration(b) || 0) || String(a.id).localeCompare(String(b.id));
  });
  const collectors = new Map(), membersById = new Map(), owners = new Map();
  candidates.forEach(row => {
    const pool = subtreePools[row.date] || rows.filter(r => r.date === row.date);
    if (!collectors.has(row.date)) collectors.set(row.date, createSubtreeCollector(pool));
    const byId = new Map(pool.map(r => [r.id, r])); byId.set(row.id, row);
    const members = collectors.get(row.date)(row).map(id => byId.get(id));
    membersById.set(row.id, members);
    members.forEach(member => owners.set(member.id, (owners.get(member.id) || 0) + 1));
  });
  const items = candidates.map(row => {
    const members = membersById.get(row.id), effectiveOverlays = groupOverlays(overlays, row.date);
    const reason = ambiguous.has(row.id) || members.some(r => owners.get(r.id) > 1) ? "Ambiguous nesting: schedule manually" :
      members.map(r => holdReason(r, effectiveOverlays)).find(Boolean) ||
      (members.some(r => r.date && r.date !== row.date) ? "Nested tasks span multiple dates: schedule manually" : null) ||
      (!duration(row) ? "Set a duration before scheduling" : null);
    const included = !reason && (!selected || selected.has(row.id)), d = duration(row);
    const slot = included ? findSlot({ duration: d }, ctx, { anchorNow: false, endSlackMinutes: 0 }) : null;
    const oldStart = minutes((row.properties || {}).start);
    const unsafeTree = included && slot && members.some(r => {
      if (r.id === row.id) return false;
      const p = r.properties || {}, start = minutes(p.start), end = minutes(p.end);
      return start !== null && end > start && (oldStart === null || start < oldStart || end > oldStart + d);
    });
    const placement = included ? slot && !unsafeTree ? { kind: "timed", start: slot.start, end: slot.end } : { kind: "unplanned" } : null;
    const guard = { sourceDate, expectedDate: row.date, sourceFingerprint: sourceFingerprint(members, effectiveOverlays), targetScheduleFingerprint: scheduleFingerprint(ctx), bounds: { start: ctx.dayStart, end: ctx.dayEnd } };
    if (placement && placement.kind === "timed") {
      const delta = oldStart === null ? 0 : minutes(slot.start) - oldStart;
      ctx.blocks = ctx.blocks.concat(members.map(r => ({ id: r.id, type: r.type, properties: r.id === row.id ? { start: slot.start, end: slot.end } :
        minutes((r.properties || {}).start) !== null && minutes((r.properties || {}).end) !== null ? { start: format(minutes(r.properties.start) + delta), end: format(minutes(r.properties.end) + delta) } : {} })));
    }
    return { id: row.id, title: (row.properties || {}).title || "Task", sourceDate: row.date, priority: (row.properties || {}).priority || "Medium", duration: d, subtreeCount: members.length,
      included, held: reason, placement, overflowReason: included && placement.kind === "unplanned" ? unsafeTree ? "Nested timing needs manual placement" : "No room within work hours" : null, reviewGuard: guard };
  });
  return { sourceDate, targetDate, timeZone, days, bounds: { start: format(ctx.dayStart), end: format(ctx.dayEnd) }, items, truncated, fingerprint: hash([targetFingerprint, items]) };
}
async function loadPlan(ctx, req, selectedIds, days = 14) {
  const { blockDB, buildDayResponse, getTodayStr } = ctx;
  const sourceDate = getTodayStr(), targetDate = addDay(sourceDate);
  const [pool, state, blocks] = await Promise.all([
    blockDB.getCarryoverPool(req.workspaceId, targetDate, { days, limit: LIMIT, includeUntimed: true }),
    buildDayResponse(targetDate, req.session.userId, req.workspaceId, { scheduleOnly: true }), blockDB.getBlocksByDate(targetDate, req.workspaceId),
  ]);
  const overlays = { ...pool.overlays };
  (pool.dayRoots || []).forEach(root => { overlays[root.date] = overlay(root); });
  // Read the canonical pools, including undated and otherwise hidden descendants.
  const dates = [...new Set(pool.rows.filter(r => !done(r, overlays)).map(r => r.date))].filter(Boolean), subtreePools = {};
  for (let offset = 0; offset < dates.length; offset += 4) {
    await Promise.all(dates.slice(offset, offset + 4).map(async date => { subtreePools[date] = await blockDB.getRescheduleSubtreePool(date, req.workspaceId); }));
  }
  return buildPlan({ sourceDate, rows: pool.rows, overlays, subtreePools, targetState: state, targetBlocks: blocks, selectedIds, days, timeZone: ctx.APP_TIME_ZONE,
    truncated: pool.rows.length >= LIMIT });
}
function reject(message) { const e = new Error(message); e.statusCode = 409; e.code = "REVIEW_PLAN_CHANGED"; throw e; }
async function validateMove(ctx, req, parent, members, placement, guard, client) {
  const { blockDB, buildDayResponse, getTodayStr } = ctx;
  if (!guard || guard.sourceDate !== getTodayStr() || req.body.targetDate !== addDay(guard.sourceDate) || guard.expectedDate !== parent.date) reject("The review date changed. Refresh the preview.");
  const [sourceRows, state, blocks] = await Promise.all([
    blockDB.getBlocksByDate(parent.date, req.workspaceId, client),
    buildDayResponse(req.body.targetDate, req.session.userId, req.workspaceId, { client, scheduleOnly: true }),
    blockDB.getBlocksByDate(req.body.targetDate, req.workspaceId, client),
  ]);
  const overlays = groupOverlays({ [parent.date]: overlay(sourceRows.find(r => r.type === "day_root")) }, parent.date);
  if (done(parent, overlays) || members.some(r => holdReason(r, overlays)) || members.some(r => r.date && r.date !== parent.date)) reject("A task was completed, fixed, or locked. Refresh the preview.");
  if (guard.sourceFingerprint !== sourceFingerprint(members, overlays)) reject("A task or subtask changed. Refresh the preview.");
  if (!placement || !["timed", "unplanned"].includes(placement.kind)) reject("Review moves require a previewed placement.");
  const day = context(req.body.targetDate, state, blocks, ctx.APP_TIME_ZONE);
  if (!guard.bounds || guard.bounds.start !== day.dayStart || guard.bounds.end !== day.dayEnd || guard.targetScheduleFingerprint !== scheduleFingerprint(day)) reject("Tomorrow's schedule or work hours changed. Refresh the preview.");
  if (placement.kind === "timed") {
    const start = minutes(placement.start), end = minutes(placement.end);
    const slot = findSlot({ duration: end - start }, { ...day, dayStart: start }, { anchorNow: false, endSlackMinutes: 0 });
    if (start < day.dayStart || end > day.dayEnd || end - start !== duration(parent) || !slot || slot.start !== placement.start) reject("The task no longer fits. Refresh the preview.");
  }
  return members.filter(r => done(r, overlays)).map(r => r.id);
}
module.exports = { buildPlan, loadPlan, validateMove, context, addDay, duration, holdReason, overlay, sourceFingerprint };
