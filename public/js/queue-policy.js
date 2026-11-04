/* global window */
// Shared read-only policy for server snapshots and cached/offline rendering.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DCCQueuePolicy = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_LEASE_MS = 15 * 60 * 1000;
  const tips = {
    foreground: 'Your current task, including a paused break. Pause holds its place and freezes work time. Resume continues it; starting another task switches foreground.',
    needs: 'Tasks explicitly brought to your attention by a notification, a check-back timer you set, or a worker asking for review or an unblock. This is not a general backlog.',
    priority: 'Work that needs doing but is not currently being worked on by you or a background worker. Ordered Very high, High, Medium, Low, then Very low; your order is preserved within each priority.',
    background: 'Work currently executing in Claude or another task/process, supported by a fresh worker report. Open, paused, stopped or unverified work belongs in Priority. Requests for your input belong in Needs You. Explicitly snoozed requests also wait here until their check-back time; snoozing is not worker execution.',
    completed: 'Verified completed tasks and work iterations. A completed iteration can have a linked next step; it does not mean the broader goal is finished.'
  };
  function execution(reports = [], now = Date.now()) {
    const live = reports.filter(report => {
      const e = report.execution;
      const observed = Date.parse(e?.observedAt), until = Date.parse(e?.validUntil);
      return report.phase === 'working' && typeof report.work?.source === 'string' && !!report.work.source &&
        typeof report.work?.id === 'string' && !!report.work.id && e?.state === 'running' &&
        Number.isFinite(observed) && observed <= now && until > now && until > observed && until - observed <= MAX_LEASE_MS;
    });
    // observedAt: the newest check-in among the same live reports (never a rejected one).
    if (live.length) return {state:'running',validUntil:new Date(Math.max(...live.map(r=>Date.parse(r.execution.validUntil)))).toISOString(),
      observedAt:new Date(Math.max(...live.map(r=>Date.parse(r.execution.observedAt)))).toISOString(),workers:live.map(r=>r.work)};
    if (reports.some(r=>r.execution?.state==='running')) return {state:'stale',validUntil:null,workers:[]};
    if (reports.some(r=>r.execution?.state==='stopped' || r.phase==='paused')) return {state:'stopped',validUntil:null,workers:[]};
    return {state:'unknown',validUntil:null,workers:[]};
  }
  function reviewRequested(reports = []) {
    return reports.some(report => ['needs-review','blocked'].includes(report.phase) &&
      Array.isArray(report.reviewActions) && report.reviewActions.some(action=>typeof action==='string' && !!action.trim()));
  }
  function presentation(item, now = Date.now()) {
    if (item.status==null||['completed','foreground'].includes(item.status)) return item;
    const evidence = execution(item.delegated || [],now);
    const due=Date.parse(item.dueAt), until=Date.parse(item.snoozedUntil);
    const snoozed=Number.isFinite(until)&&until===due&&until>now;
    return {...item,status:snoozed||evidence.state==='running'?'background':'queued',execution:evidence,
      snoozed,needsYou:!snoozed&&(!!item.needsReview||(Number.isFinite(due)&&due<=now))};
  }
  // The Working Queue lane split, shared by the owner page and the shared-link
  // projection so a task can never sit in different lanes on the two surfaces.
  // `group` is TaskPriority.group (browser: DCC.TaskPriority.group; Node:
  // require('./task-priority').group); Priority keeps its level order.
  function lanes(items, group) {
    if (typeof group !== 'function') throw new TypeError('lanes() needs TaskPriority.group');
    const all = items || [];
    return {
      foreground: all.filter(i=>i.status==='foreground'),
      needs: all.filter(i=>i.needsYou&&i.status!=='foreground'),
      priority: group(all.filter(i=>i.status==='queued'&&!i.needsYou).map(i=>({id:i.task.id,taskPriority:i.taskPriority,item:i}))).flatMap(g=>g.tasks.map(row=>row.item)),
      background: all.filter(i=>i.status==='background'&&!i.needsYou),
      completed: all.filter(i=>i.status==='completed')
    };
  }
  return {MAX_LEASE_MS,tips,execution,reviewRequested,presentation,lanes};
});
