// Presentation-only projections for the shared activity page. Inputs are the
// existing public day projection (already the share allowlist) and the owner's
// Working Queue snapshot. Queue membership never grants access, and no queue
// note, worker report, reminder or actuals field may leave this file.
//
// Lanes, worker leases, priority order and "completed today" come from the same
// modules the owner Working Queue uses. This file only allowlists, maps owner
// lanes to viewer lanes (VIEWER_LANE) and adds today's shared plan. Do not
// re-derive queue policy here; queue-lanes-parity.test.js fails if you do.
const Policy = require('../public/js/queue-policy');
const Priority = require('../public/js/task-priority');
const CompletedFilter = require('../public/js/completed-queue-filter');
const { TIME_ONLY_FEED_TYPES } = require('./public-feed-type');

// v1 (PR #444): kept behind DCC_SHARE_ACTIVITY_V2=false as the rollback path.
function projectPublicQueue(publicTasks, snapshot) {
  const allowed = new Map(publicTasks.filter(task => task.blockId && !task.redacted).map(task => [String(task.blockId), task]));
  const priorityRank = new Map((snapshot.priorityOrder || []).filter(id => allowed.has(String(id))).map((id, index) => [id, index]));
  const tasks = [];
  for (const item of snapshot.items || []) {
    const task = allowed.get(String(item.task.id));
    if (!task || !['foreground', 'background', 'blocked', 'paused', 'queued', 'completed'].includes(item.status)) continue;
    const lane = item.status === 'completed' ? 'completed' : item.status === 'foreground' ? 'foreground'
      : item.needsYou ? 'needs-you' : item.status === 'queued' ? 'priority' : 'background';
    tasks.push({ ...task, status: item.status === 'completed' ? 'done' : task.status === 'done' ? 'open' : task.status, queue: { lane, status: item.onBreak ? "paused" : item.status, priority: item.taskPriority,
      order: lane === 'priority' ? priorityRank.get(item.task.id) ?? tasks.length : tasks.length } });
  }
  return tasks;
}

// v2 lanes, in display priority. A task appears in exactly one.
const ACTIVITY_LANES = ['now', 'running', 'next', 'later', 'done'];
// Public day-task fields a shared card may carry. Everything else is dropped.
const PUBLIC_TASK_FIELDS = ['id', 'blockId', 'date', 'title', 'itemType', 'itemTypeLabel', 'kind', 'source', 'calendar',
  'gcalCalendarId', 'tags', 'start', 'end', 'untimed', 'durationMinutes', 'points', 'createdByGuest',
  'reactions', 'viewerReactions', 'comments', 'sponsorships'];
// Viewer-facing activity keys. Nothing else is ever added to `activity`.
const ACTIVITY_FIELDS = ['lane', 'source', 'order', 'startedAt', 'confirmedAt', 'priority', 'completedAt', 'onBreak'];
// The one owner-lane -> viewer-lane map. Needs You and snoozed requests are the
// owner's inbox, so viewers see them as Up next. A worker the owner policy counts
// as running reads as Running even when it also asks for review (viewerLane).
const VIEWER_LANE = { foreground: 'now', needs: 'next', priority: 'next', background: 'next', completed: 'done' };
// Compatibility for pages loaded before this release. Needs You is never exposed.
const V1_LANE = { now: 'foreground', running: 'background', next: 'priority', later: 'priority', done: 'completed' };

function viewerLane(ownerLane, item) {
  if ((ownerLane === 'background' || ownerLane === 'needs') && item.execution?.state === 'running') return 'running';
  return VIEWER_LANE[ownerLane];
}

function minuteIso(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

// "HH:MM" (or "H:MM...") -> minutes past midnight; Infinity when absent.
function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : Infinity;
}

function pick(task) {
  const out = {};
  for (const key of PUBLIC_TASK_FIELDS) if (task[key] !== undefined) out[key] = task[key];
  return out;
}

// Returns { tasks, nextChangeAt }. nextChangeAt is the earliest instant a shown
// card changes lane with no write (a worker lease lapsing), so viewers can
// refetch then instead of waiting for a poll.
// Options: now (pass the instant the snapshot was built with), timeZone (app
// zone), today (the shared date is today: Done is limited to today's
// completions), localMinutes (minutes past midnight now, for dropping ended
// meetings from Later today; omit for other days).
function projectPublicActivity(publicTasks, snapshot, { now = Date.now(), localMinutes = null, timeZone, today = localMinutes != null } = {}) {
  // 1. The share allowlist comes first. Queue rows outside it never reach policy code.
  const allowed = new Map((publicTasks || []).filter(task => task && task.blockId && !task.redacted)
    .map(task => [String(task.blockId), task]));
  const seen = new Set();
  const visible = (snapshot.items || []).filter(item => {
    const id = String(item?.task?.id ?? '');
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // 2. The owner's own lane split.
  const owner = Policy.lanes(visible, Priority.group);
  const placed = new Set();
  const rows = Object.fromEntries(ACTIVITY_LANES.map(lane => [lane, []]));
  let nextChangeAt = Infinity;
  const ownerOrder = ['foreground', 'background', 'needs', 'priority', 'completed'];
  const viewerItems = [];
  for (const ownerLane of ownerOrder) for (const item of owner[ownerLane]) viewerItems.push({ item, lane: viewerLane(ownerLane, item) });
  // Snapshot order within each viewer lane, then TaskPriority grouping for Up next.
  const rank = new Map(visible.map((item, index) => [item, index]));
  viewerItems.sort((a, b) => rank.get(a.item) - rank.get(b.item));
  const next = Priority.group(viewerItems.filter(v => v.lane === 'next')
    .map(v => ({ id: v.item.task.id, taskPriority: v.item.taskPriority, v }))).flatMap(g => g.tasks.map(row => row.v));
  // 3. Completed: the owner's "completed" filter (today in the app zone), or every
  // allowlisted completion when the shared date is another day.
  const completed = CompletedFilter.select(owner.completed, today ? 'today' : 'all', now, timeZone).rows;
  for (const item of owner.completed) placed.add(String(item.task.id));

  function push(lane, task, activity) {
    placed.add(String(task.blockId));
    rows[lane].push({ ...pick(task), status: lane === 'done' ? 'done' : (task.status === 'done' ? 'open' : task.status), activity: { lane, ...activity } });
  }
  for (const { item, lane } of viewerItems.filter(v => v.lane === 'now' || v.lane === 'running')) {
    const task = allowed.get(String(item.task.id));
    // A paused foreground task stays in Now as a break (same as the owner page).
    if (lane === 'now') push(lane, task, { source: 'queue', startedAt: item.onBreak ? null : minuteIso(item.task?.properties?.startedAt),
      priority: item.taskPriority || null, ...(item.onBreak ? { onBreak: true } : {}) });
    else {
      push(lane, task, { source: 'queue', confirmedAt: minuteIso(item.execution.observedAt), priority: item.taskPriority || null });
      const until = Date.parse(item.execution.validUntil);
      if (Number.isFinite(until)) nextChangeAt = Math.min(nextChangeAt, until);
    }
  }
  for (const { item } of next) push('next', allowed.get(String(item.task.id)), { source: 'queue', priority: item.taskPriority || null });
  for (const item of completed) push('done', allowed.get(String(item.task.id)), { source: 'queue', completedAt: minuteIso(item.completedAt) });

  // 4. Today's shared plan: the same day allowlist the page exports, minus queue members.
  const plan = [];
  for (const [id, task] of allowed) {
    if (placed.has(id) || task.subtaskOf || task.triageBlock) continue;
    if (task.status === 'done') { push('done', task, { source: 'plan', completedAt: null }); continue; }
    if (task.untimed || !Number.isFinite(minutesOfDay(task.start))) continue;
    // Meetings, breaks and OOO never get "done"; once their end passes they are history.
    if (localMinutes != null && TIME_ONLY_FEED_TYPES.has(task.itemType) && minutesOfDay(task.end) <= localMinutes) continue;
    plan.push(task);
  }
  plan.sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));
  for (const task of plan) push('later', task, { source: 'plan' });

  const tasks = [];
  for (const lane of ACTIVITY_LANES) rows[lane].forEach((task, order) => {
    tasks.push({ ...task, activity: { ...task.activity, order }, queue: { lane: V1_LANE[lane], order } });
  });
  return { tasks, nextChangeAt: Number.isFinite(nextChangeAt) ? new Date(nextChangeAt).toISOString() : null };
}

module.exports = { projectPublicQueue, projectPublicActivity, minutesOfDay, ACTIVITY_LANES, ACTIVITY_FIELDS, PUBLIC_TASK_FIELDS, VIEWER_LANE };
