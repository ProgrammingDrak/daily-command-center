// Read-only classification. Planned dates/times and estimates are never activity.
const { isBlockDone } = require("./task-timing");
const Policy = require("../public/js/queue-policy");
const Priority = require("../public/js/task-priority");
function hasPriorActivity(task, item = {}, evidence = {}) {
  const p = task.properties || {};
  return !!(
    p.startedAt ||
    p.everStarted ||
    p.lastWorkedAt ||
    p.activeWorkSessionId ||
    p.actualMinutes != null ||
    p.actualTimeUnknown ||
    ["in_progress", "in-progress", "paused"].includes(p.status) ||
    item.hasActivity ||
    evidence.session ||
    evidence.delegated ||
    ["foreground", "background", "paused", "completed"].includes(item.status) ||
    (item.status === "blocked" && item.hasActivity !== false)
  );
}
function isForegroundBreak(task, item = {}) {
  const p = task.properties || {};
  return item.status === "foreground" && Number.isFinite(Date.parse(item.breakStartedAt)) &&
    !p.startedAt && item.breakOperationId === (p.workStateOperationId || null) &&
    (item.breakCompletionRevision ?? null) === (p._completionRevision || null) && !isBlockDone(task);
}
function classify(task, _item = {}, evidence = {}) {
  const p = task.properties || {};
  if (task.deleted_at || p.kind === "responsibility_item" || task.type === "recurring-definition") return null;
  // Preserve an active clock even when legacy status contradicts it: only an
  // explicit pause may settle that activity. No read path stops the clock.
  if (p.startedAt && ["cancelled", "canceled", "deleted", "archived", "skipped"].includes(p.status))
    return "foreground";
  if (["cancelled", "canceled", "deleted", "archived", "skipped"].includes(p.status)) return null;
  if (isBlockDone(task, evidence.dayRoot)) return "completed";
  if (p.startedAt || isForegroundBreak(task, _item)) return "foreground";
  if (Policy.execution(evidence.reports || [], evidence.now ?? Date.now()).state === "running") return "background";
  // History is preserved, but it is not evidence of current execution.
  return "queued";
}
function orderPriority(items) {
  return Priority.group(
    items.map((item) => ({ id: item.task.id, taskPriority: item.task.properties.taskPriority, item }))
  ).flatMap((group) => group.tasks.map((row) => row.item));
}
module.exports = { classify, orderPriority, hasPriorActivity, isForegroundBreak };
