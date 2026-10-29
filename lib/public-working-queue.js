// A presentation-only intersection. Never serialize private queue context or tasks.
function projectPublicQueue(publicTasks, snapshot) {
  const allowed = new Map(publicTasks.filter(task => task.blockId && !task.redacted).map(task => [String(task.blockId), task]));
  const priorityRank = new Map((snapshot.priorityOrder || []).filter(id => allowed.has(String(id))).map((id, index) => [id, index]));
  const tasks = [];
  for (const item of snapshot.items || []) {
    const task = allowed.get(String(item.task.id));
    if (!task || !['foreground', 'background', 'blocked', 'paused', 'queued', 'completed'].includes(item.status)) continue;
    const lane = item.status === 'completed' ? 'completed' : item.status === 'foreground' ? 'foreground'
      : item.needsYou ? 'needs-you' : item.status === 'queued' ? 'priority' : 'background';
    tasks.push({ ...task, status: item.status === 'completed' ? 'done' : task.status === 'done' ? 'open' : task.status, queue: { lane, status: item.status, priority: item.taskPriority,
      order: lane === 'priority' ? priorityRank.get(item.task.id) ?? tasks.length : tasks.length } });
  }
  return tasks;
}
module.exports = { projectPublicQueue };
