// Undo a committed coordinator completion through the canonical completion writer.
// Retain measured effort; reopening is not evidence that a timer should restart.
const M = require('./conversation-model');
const Q = require('./working-queue');
const { isBlockDone } = require('./task-timing');
const version = row => M.digest({ properties: row.properties, date: row.date, parent_id: row.parent_id, deleted_at: row.deleted_at || null });
function receipt(result, command, now) {
  const rows = result.affectedTasks.filter(row => result.responsibilityTransitions?.some(t => t.id === row.id && !isBlockDone({properties:t.before || {}})));
  if (!rows.length) return null;
  return { sourceEventId: command.sourceEventId, taskId: command.taskId, expectedRevision: result.state.revision,
    // Transport allowance. The UI offers five seconds starting at acknowledgement.
    expiresAt: now + 30000, rows: rows.map(row => ({ id: row.id, version: version(row) })) };
}
async function undo(q, owner, queue, b, ctx, readTask) {
  const event = (await q.query('SELECT result FROM conversation_events WHERE user_id=$1 AND workspace_id=$2 AND source_event_id=$3', [owner.userId, owner.workspaceId, b.undoEventId])).rows[0]?.result;
  const saved = event?.undo;
  if (!saved || saved.taskId !== b.taskId || saved.expectedRevision !== b.expectedRevision)
    throw M.fail('Completion changed. Refresh the task before reopening it.', 409);
  if ((ctx.now || Date.now)() > saved.expiresAt) throw M.fail('Undo expired. Reopen the task from its details.', 409);
  const rows = [];
  for (const expected of saved.rows) {
    const current = await readTask(q, expected.id, owner);
    if (!isBlockDone(current) || version(current) !== expected.version)
      throw M.fail('Task changed after completion. Review it before reopening.', 409);
    rows.push(current);
  }
  const transitions = [], touchedTaskIds = [];
  for (const row of rows) {
    const result = await ctx.blockDB.setTaskCompletion({ taskRef: row.id, completed: false,
      expectedRevision: row.properties._completionRevision || null,
      mutationId: 'queue-undo:' + M.digest(b.sourceEventId + ':' + row.id).slice(0, 40),
      userId: owner.userId, workspaceId: owner.workspaceId, transactionClient: q, includeDescendants: false });
    transitions.push(...(result.responsibilityTransitions || []));
    for (const changed of result.affectedTasks) {
      touchedTaskIds.push(changed.id);
      Q.setStatus(queue, changed, 'paused', b);
    }
  }
  return { task: await readTask(q, b.taskId, owner), touchedTaskIds, responsibilityTransitions: transitions };
}
module.exports = { receipt, undo, version };
