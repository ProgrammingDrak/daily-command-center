// Read-only classification. Planned dates/times and estimates are never activity.
const { isBlockDone } = require('./task-timing');
const Priority = require('../public/js/task-priority');
function hasPriorActivity(task, item = {}, evidence = {}) {
  const p = task.properties || {};
  return !!(p.startedAt || p.everStarted || p.lastWorkedAt || p.activeWorkSessionId || p.actualMinutes != null || p.actualTimeUnknown || ['in_progress', 'in-progress', 'paused'].includes(p.status) || item.hasActivity || evidence.session || evidence.delegated || ['foreground', 'background', 'paused', 'completed'].includes(item.status) || (item.status === 'blocked' && item.hasActivity !== false));
}
function classify(task, item = {}, evidence = {}) {
  const p = task.properties || {};
  if (task.deleted_at || p.kind === 'responsibility_item' || task.type === 'recurring-definition') return null;
  // Preserve an active clock even when legacy status contradicts it: only an
  // explicit pause may settle that activity. No read path stops the clock.
  if (p.startedAt && ['cancelled', 'canceled', 'deleted', 'archived', 'skipped'].includes(p.status)) return 'foreground';
  if (['cancelled', 'canceled', 'deleted', 'archived', 'skipped'].includes(p.status)) return null;
  if (isBlockDone(task, evidence.dayRoot)) return 'completed';
  if (p.startedAt) return 'foreground';
  if (['background', 'blocked'].includes(item.status)) return item.status;
  // A zero/derived legacy actual is ambiguous, not proof of never having begun.
  // Keep it out of Priority Queue without inventing sessions or timestamps.
  if (hasPriorActivity(task, item, evidence)) return 'paused';
  return 'queued';
}
function orderPriority(items) {
  return Priority.group(items.map(item => ({ id: item.task.id, taskPriority: item.task.properties.taskPriority, item })))
    .flatMap(group => group.tasks.map(row => row.item));
}
module.exports = { classify, orderPriority, hasPriorActivity };
