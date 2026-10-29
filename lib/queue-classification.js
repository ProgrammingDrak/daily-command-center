// Read-only classification. Planned dates/times and estimates are never activity.
const { isBlockDone } = require('./task-timing');
const Priority = require('../public/js/task-priority');
function classify(task, item = {}, evidence = {}) {
  const p = task.properties || {};
  if (task.deleted_at || ['cancelled', 'canceled', 'deleted', 'archived', 'skipped'].includes(p.status) || p.kind === 'responsibility_item' || task.type === 'recurring-definition') return null;
  if (isBlockDone(task, evidence.dayRoot)) return 'completed';
  if (p.startedAt) return 'foreground';
  if (['background', 'blocked'].includes(item.status)) return item.status;
  // A zero/derived legacy actual is ambiguous, not proof of never having begun.
  // Keep it out of Priority Queue without inventing sessions or timestamps.
  if (p.everStarted || p.lastWorkedAt || p.activeWorkSessionId || p.actualMinutes != null || p.actualTimeUnknown || ['in_progress', 'in-progress', 'paused'].includes(p.status) || item.hasActivity || evidence.session || evidence.delegated || ['foreground', 'paused', 'completed'].includes(item.status)) return 'paused';
  return 'queued';
}
function orderPriority(items) {
  return Priority.group(items.map(item => ({ id: item.task.id, taskPriority: item.task.properties.taskPriority, item })))
    .flatMap(group => group.tasks.map(row => row.item));
}
module.exports = { classify, orderPriority };
