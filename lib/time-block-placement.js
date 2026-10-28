"use strict";
const crypto = require("node:crypto");
const TB = require("../public/js/time-blocks");
const TM = require("../public/js/task-model");
const { duration: legacyDuration } = require("./review-tomorrow");
const { isBlockDone } = require("./task-timing");
function duration(row) { const p = row.properties || {}; return legacyDuration({ ...row, properties: { ...p, duration: p.duration ?? p.estimatedMinutes } }); }
const { instantToLocalKey, localKeyToInstant } = require("./scheduled-recurrence");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const format = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
function reject(message) { const error = new Error(message); error.statusCode = 409; error.code = "TIME_BLOCK_PLACEMENT"; throw error; }
function choices(blocks, date) {
  return TB.forDate((Array.isArray(blocks) ? blocks : []).filter(b => b && b.enabled !== false && b.disabled !== true), date);
}
async function readBlocks(ctx, workspaceId, client) {
  if (!workspaceId) reject("Sign in before choosing a time block.");
  const { rows } = await (client || ctx.pool).query("SELECT id, properties FROM blocks WHERE type='schedule_block' AND workspace_id=$1 AND deleted_at IS NULL ORDER BY sort_order, id", [workspaceId]);
  return rows.map(row => ({ ...(typeof row.properties === "string" ? JSON.parse(row.properties) : row.properties), id: row.id }));
}
// Wall-clock plans cannot disambiguate a repeated minute. Refuse a DST transition
// interval rather than silently changing duration or choosing an occurrence.
function checkClock(date, start, end, zone) {
  const key = n => n === 1440 ? new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10) + "T00:00" : date + "T" + format(n);
  const a = localKeyToInstant(key(start), zone), b = localKeyToInstant(key(end), zone);
  if (instantToLocalKey(a, zone) !== key(start) || instantToLocalKey(b, zone) !== key(end) || (b - a) / 60000 !== end - start) reject("This block crosses a clock change. Choose another block or set a time manually.");
  for (const [n, instant] of [[start, a], [end, b]]) {
    for (const delta of [-120, -60, -30, 30, 60, 120]) if (instantToLocalKey(new Date(+instant + delta * 60000), zone) === key(n)) reject("This block has an ambiguous clock time. Choose another block or set a time manually.");
  }
}
function plan({ date, blockId, configured, parent, members, rows, state, zone, now = new Date() }) {
  const matches = choices(configured, date).filter(b => b.id === blockId);
  if (matches.length !== 1) reject("That time block is no longer available on this day. Choose another block.");
  const block = matches[0], start = TB.minutes(block.start), end = TB.minutes(block.end, true);
  const today = instantToLocalKey(now, zone).slice(0, 10);
  if (date < today) reject("This day has passed. Choose today or a future day.");
  checkClock(date, start, end, zone);
  const p = parent.properties || {}, d = duration(parent);
  if (!d) reject("Set a positive task duration before choosing a time block.");
  if (members.some(row => { const v = row.properties || {}; return v.startedAt || v.done || v.completed || ["done", "completed", "in_progress"].includes(v.status); })) reject("Pause running work or choose an unfinished task before moving it into a block.");
  const oldStart = TB.minutes(p.start), oldEnd = TB.minutes(p.end, true);
  if (members.some(row => {
    if (row.id === parent.id) return false;
    const v = row.properties || {}, s = TB.minutes(v.start), e = TB.minutes(v.end, true);
    return (row.date && row.date !== parent.date) || v.all_day || (s !== null && (oldStart === null || e === null || s < oldStart || e > oldStart + d));
  })) reject("Nested task timing needs manual placement.");
  const ids = new Set(members.map(row => row.id)), localIds = new Set(members.map(row => row.properties?.local_id).filter(Boolean));
  const minute = (value, isEnd) => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.includes("T")) {
      const instant = new Date(value);
      if (!Number.isFinite(+instant)) reject("A calendar time is invalid. Refresh the day before moving.");
      const key = instantToLocalKey(instant, zone);
      return key.slice(0, 10) < date ? 0 : key.slice(0, 10) > date ? 1440 : TB.minutes(key.slice(11));
    }
    return TB.minutes(value, isEnd);
  };
  const occupied = [];
  function add(v, fixed) {
    if (v.transparency === "transparent") return;
    if (v.all_day && fixed) { occupied.push({ s: 0, e: 1440, fixed: true }); return; }
    if (!v.start) return;
    const s = minute(v.start, false), e = minute(v.end, true);
    if (s === null || e === null || e <= s) reject("A scheduled task has invalid timing. Fix its time before moving into a block.");
    occupied.push({ s, e, fixed });
  }
  rows.filter(row => !row.deleted_at && !ids.has(row.id) && TM.isTaskRow(row)).forEach(row => {
    const v = row.properties || {};
    add(v, ["meeting", "oneone", "ooo", "break"].includes(v.type || v.kind) || ["calendar", "gcal"].includes(v.source) || !!v.calendar_id);
  });
  ((state.schedule || {}).timeline || []).filter(v => v && !ids.has(v.id) && !localIds.has(v.id)).forEach(v => add(v, ["meeting", "oneone", "ooo", "break"].includes(v.type)));
  const floor = date === today ? Math.max(start, Math.ceil((TB.minutes(instantToLocalKey(now, zone).slice(11)) + (now.getSeconds() ? 1 : 0)) / 15) * 15) : start;
  const free = (s, e) => !occupied.some(v => s < v.e && e > v.s);
  // Re-selecting the block is a no-op when this task already occupies a valid slot.
  if (parent.date === date && oldStart !== null && oldStart >= floor && oldEnd === oldStart + d && oldEnd <= end && free(oldStart, oldEnd)) return { kind: "timed", start: p.start, end: p.end };
  let cursor = occupied.filter(v => !v.fixed && v.s < end && v.e > start).reduce((n, v) => Math.max(n, v.e), floor);
  let changed = true;
  while (changed) { changed = false; for (const v of occupied) if (cursor < v.e && cursor + d > v.s) { cursor = v.e; changed = true; } }
  if (cursor + d > end || cursor + d >= 1440) reject("Not enough space in " + block.name + " for " + d + " minutes. Choose another block or set a time manually.");
  return { kind: "timed", start: format(cursor), end: format(cursor + d) };
}
async function load(ctx, req, parent, members, client) {
  const date = req.body.targetDate;
  const configured = await readBlocks(ctx, req.workspaceId, client);
  const state = await ctx.buildDayResponse(date, req.session.userId, req.workspaceId, { client, scheduleOnly: true });
  const rows = await ctx.blockDB.getBlocksByDate(date, req.workspaceId, client);
  const sourceRows = parent.date === date ? rows : await ctx.blockDB.getBlocksByDate(parent.date || req.body.fromDate, req.workspaceId, client);
  const overlay = sourceRows.find(row => row.type === "day_root")?.properties || {};
  if (members.some(row => isBlockDone(row, overlay))) reject("Completed work needs manual placement so its actual history stays intact.");
  const placement = plan({ date, blockId: req.body.placement.blockId, configured, parent, members, rows, state, zone: ctx.APP_TIME_ZONE });
  return { placement, fingerprint: hash([configured, state.schedule, rows, members, overlay]) };
}
module.exports = { choices, readBlocks, plan, load, reject };
