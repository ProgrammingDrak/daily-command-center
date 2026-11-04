// Presentation-only projections for the shared activity page. Inputs are the
// existing public day projection (already the share allowlist) and the owner's
// Working Queue snapshot. Queue membership never grants access, and no queue
// note, worker report, reminder or actuals field may leave this file.

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
const QUEUE_STATUSES = new Set(['foreground', 'background', 'blocked', 'paused', 'queued', 'completed']);
// Compatibility for pages loaded before this release. Needs You is never exposed.
const V1_LANE = { now: 'foreground', running: 'background', next: 'priority', later: 'priority', done: 'completed' };

function minuteIso(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function liveRunning(item, now) {
  if (item.execution?.state !== 'running') return null;
  const until = Date.parse(item.execution.validUntil);
  if (!Number.isFinite(until) || until <= now) return null;
  // Only the observation instant is read from worker reports; source, id, notes
  // and review actions stay behind.
  const observed = (item.delegated || [])
    .filter(report => report?.execution?.state === 'running' && Date.parse(report.execution.validUntil) > now)
    .map(report => Date.parse(report.execution.observedAt))
    .filter(Number.isFinite);
  return { until, confirmedAt: observed.length ? Math.max(...observed) : null };
}

function laneFor(item, now) {
  if (item.status === 'completed') return { lane: 'done' };
  if (item.status === 'foreground') return { lane: 'now' };
  const running = liveRunning(item, now);
  if (running) return { lane: 'running', running };
  // Priority, paused, blocked, snoozed and Needs You all read as "up next".
  return { lane: 'next' };
}

function pick(task) {
  const out = {};
  for (const key of PUBLIC_TASK_FIELDS) if (task[key] !== undefined) out[key] = task[key];
  return out;
}

function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : Infinity;
}
function startMinutes(task) { return clockMinutes(task.start); }
// Meetings, breaks and OOO never get "done"; once their end passes they are history.
const TIME_ONLY_TYPES = new Set(['calendar', 'break', 'ooo']);

// Returns { tasks, nextChangeAt }. nextChangeAt is the earliest instant a shown
// card changes lane with no write (a worker lease lapsing), so viewers can
// refetch then instead of waiting for a poll.
// localMinutes: minutes past midnight in the app time zone when the shared day is
// today; omit for other days.
function projectPublicActivity(publicTasks, snapshot, { now = Date.now(), localMinutes = null } = {}) {
  const allowed = new Map((publicTasks || []).filter(task => task && task.blockId && !task.redacted)
    .map(task => [String(task.blockId), task]));
  const priorityRank = new Map((snapshot.priorityOrder || []).map(String).filter(id => allowed.has(id)).map((id, index) => [id, index]));
  const lanes = Object.fromEntries(ACTIVITY_LANES.map(lane => [lane, []]));
  const placed = new Set();
  let nextChangeAt = Infinity;

  (snapshot.items || []).forEach((item, index) => {
    const id = String(item?.task?.id ?? '');
    const task = allowed.get(id);
    if (!task || placed.has(id) || !QUEUE_STATUSES.has(item.status)) return;
    const { lane, running } = laneFor(item, now);
    const activity = { lane, source: 'queue' };
    if (lane === 'now') activity.startedAt = minuteIso(item.task?.properties?.startedAt);
    if (lane === 'running') {
      activity.confirmedAt = minuteIso(running.confirmedAt);
      nextChangeAt = Math.min(nextChangeAt, running.until);
    }
    if (lane !== 'done') activity.priority = item.taskPriority || null;
    if (lane === 'done') activity.completedAt = minuteIso(item.completedAt);
    activity.sort = lane === 'next' ? (priorityRank.has(id) ? priorityRank.get(id) : 100000 + index)
      : lane === 'done' ? -(Date.parse(activity.completedAt) || 0) : index;
    placed.add(id);
    lanes[lane].push({ ...pick(task), status: lane === 'done' ? 'done' : (task.status === 'done' ? 'open' : task.status), activity });
  });

  // Today's shared plan: the same day allowlist the page exports, minus queue members.
  for (const [id, task] of allowed) {
    if (placed.has(id) || task.subtaskOf || task.triageBlock) continue;
    if (task.status === 'done') {
      lanes.done.push({ ...pick(task), status: 'done', activity: { lane: 'done', source: 'plan', completedAt: null, sort: 0 } });
    } else if (!task.untimed && Number.isFinite(startMinutes(task))) {
      if (localMinutes != null && TIME_ONLY_TYPES.has(task.itemType) && clockMinutes(task.end) <= localMinutes) continue;
      lanes.later.push({ ...pick(task), activity: { lane: 'later', source: 'plan', sort: startMinutes(task) } });
    } else continue;
    placed.add(id);
  }

  const tasks = [];
  for (const lane of ACTIVITY_LANES) {
    lanes[lane].sort((a, b) => a.activity.sort - b.activity.sort);
    lanes[lane].forEach((task, order) => {
      const { sort: _sort, ...activity } = task.activity;
      tasks.push({ ...task, activity: { ...activity, order }, queue: { lane: V1_LANE[lane], order } });
    });
  }
  return { tasks, nextChangeAt: Number.isFinite(nextChangeAt) ? new Date(nextChangeAt).toISOString() : null };
}

module.exports = { projectPublicQueue, projectPublicActivity, ACTIVITY_LANES, PUBLIC_TASK_FIELDS };
