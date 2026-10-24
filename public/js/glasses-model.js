// Compact display adapter. Task identity, hierarchy and section membership stay in TaskModel.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./task-model'), require('./time-blocks'), require('./task-queues'));
  else root.GlassesModel = factory(root.DCC.TaskModel, root.DCC.TimeBlocks, root.DCC.TaskQueues);
})(typeof self !== 'undefined' ? self : this, function (TM, TB, Q) {
  'use strict';
  const list = v => Array.isArray(v) ? v : [];
  const minutes = time => { const m = /^(\d\d?):(\d\d)$/.exec(time || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  function clock(timeZone, now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: Number(p.hour) * 60 + Number(p.minute), time: p.hour + ':' + p.minute };
  }
  // Same canonical sort_order / created_at / id tie breaks as schedule._orderFromRows.
  function order(a, b) { return (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)); }
  function fromBlock(block, overlay = {}, parentKeys) {
    const p = block.properties || {}, ev = !block.date && p.kind === 'backlog' ? TM.fromBacklogBlock(block, parentKeys) : TM.fromBlock(block, { deriveEnd: true });
    return Object.assign(ev, { taskId: block.id, date: block.date || null, completed: p.done === true || p.status === 'done' || !!p.completedAt || (list(overlay.done).includes(ev.id) || list(overlay.done).includes(block.id)), completionRevision: p._completionRevision || null });
  }
  function project(snapshot, carry = { rows: [], overlays: {} }, options = {}) {
    const date = snapshot.date, all = [...new Map(list(snapshot.blocks).concat(list(snapshot.globals)).map(b => [b.id, b])).values()].sort(order);
    const props = all.find(b => b.type === 'day_root' && b.date === date)?.properties || {};
    const done = list(props._done?.ids), hidden = new Set(list(props._deleted).concat(list(props._pushed?.ids)));
    const datedIds = new Set(all.filter(b => b.date).map(b => b.properties?.local_id).filter(Boolean));
    const backlog = TM.selectUnscheduled(all);
    const parentKeys = TM.backlogParentKeys(all);
    const backlogIds = new Set(backlog.map(b => b.id));
    const rows = all.filter(b => !b.deleted_at && ['block', 'added_task', 'pending_task'].includes(b.type) && (TM.foldsIntoItinerary(b) || backlogIds.has(b.id)) &&
      !['deleted', 'archived'].includes(b.properties?.status) && !hidden.has(b.id) && !hidden.has(b.properties?.local_id));
    const pool = rows.filter(b => !TM.isWheneverPoolRow(b) && (b.date === date || (b.properties?.all_day && b.date <= date && (!b.properties.all_day_end || b.properties.all_day_end > date)) || (!b.date && !datedIds.has(b.properties?.local_id))))
      .map(b => fromBlock(b, { done }, parentKeys)).filter(e => e.date || !e.completed);
    const opts = { isDone: e => e.completed, isDeleted: () => false, trivialFlags: props._trivialFlags || {}, waitingRows: all };
    const day = TM.selectDay(pool, date, opts);
    const tree = items => TM.selectTree(items, { pool: items, isCollapsed: () => false }).map(n => ({ ...n.ev, depth: n.depth }));
    const timeZone = options.timeZone || 'UTC', now = options.now || new Date();
    const timeBlocks = TB.forDate(snapshot.dayState?.schedule?.timeBlocks || snapshot.dayState?.schedule?.blocks || [], date);
    // Keep completed children readable in place on the small display. Desktop folds
    // these into the parent detail; the same tree still owns their nesting/order.
    const unscheduled = Q.orderUnscheduled(day.unscheduled, list(props._unscheduledOrder));
    const queuedIds = new Set(day.unscheduled.map(e => e.id));
    const nodes = TM.selectTree(day.visible.filter(e => !queuedIds.has(e.id)).concat(unscheduled), { pool: day.visible, isCollapsed: () => false });
    const groups = TB.groupItineraryTree(nodes, timeBlocks);
    const completionMinutes = new Map();
    const completionMinute = ev => {
      if (completionMinutes.has(ev)) return completionMinutes.get(ev);
      const raw = props._done?.at?.[ev.id] || ev.completedAt;
      const at = raw && Number.isFinite(new Date(raw).getTime()) ? clock(timeZone, new Date(raw)) : null;
      const minute = at?.date === date ? at.minutes : null;
      completionMinutes.set(ev, minute); return minute;
    };
    for (const id of ['triage', 'unplanned']) TB.fileDoneUntimed(groups, groups.find(g => g.block.id === id), timeBlocks, { isDone: e => e.completed, completionMinute });
    const flatten = nodes => nodes.map(n => ({ ...n.ev, depth: n.depth }));
    const sections = groups.filter(g => !['triage', 'unplanned'].includes(g.block.id)).map(g => ({ block: g.block, rows: flatten(g.nodes) }));
    const itinerary = sections.flatMap(g => g.rows);
    const triage = flatten(groups.find(g => g.block.id === 'triage').nodes);
    const unplanned = flatten(groups.find(g => g.block.id === 'unplanned').nodes);
    const anytime = tree(Q.selectWhenever(TM.selectWheneverPoolBlocks(rows).map(b => fromBlock(b, {}, parentKeys))).filter(e => !e.completed));
    const earlier = tree(list(carry.rows).filter(TM.isTaskRow).sort((a,b) => String(b.date).localeCompare(String(a.date)) || order(a,b)).map(b => fromBlock(b, carry.overlays?.[b.date])).filter(e => !e.completed));
    const today = clock(timeZone, now).date;
    const rules = Q.waitingRules({ today, nowValue: new Date(today + 'T12:00:00') });
    const waitingBlocks = all.filter(b => !b.deleted_at && b.properties?.kind === 'delegated_item').sort(rules.sortByUrgency);
    const waitingItem = b => ({ taskId: 'waiting:' + b.id, kind: 'waiting', title: b.properties.myTask || b.properties.title || 'Waiting task', detail: [b.properties.delegatee?.name && 'Waiting on ' + b.properties.delegatee.name, b.properties.title, b.properties.notes].filter(Boolean).join('\n'), overdue: rules.isOverdue(b), depth: 0, untimed: true });
    const waiting = waitingBlocks.filter(rules.isOpenDelegated).map(waitingItem);
    const attention = rules.attentionItems(waitingBlocks), waitingIds = new Set(attention.map(b => b.id));
    const rawTriage = snapshot.dayState?.triage || {}, suppressed = Object.fromEntries(list(rawTriage.suppressed_items).map(i => [i.triage_id, i]));
    const review = Q.activeTriage(list(rawTriage.open_items), { dismissed: props._dismissed || {}, scheduled: Array.isArray(rawTriage.suppressed_items) ? {} : props._triageScheduled || {}, deleted: props._triageDeleted || [], suppressed })
      .filter(i => !waitingIds.has(i.waiting_item_id)).map(i => ({ taskId: 'triage:' + i.id, kind: 'review', title: i.title || i.summary || 'Review item', detail: [i.summary, i.notes].filter(Boolean).join('\n'), depth: 0, untimed: true }));
    const preparedSources = new Set(pool.map(t => 'triage:' + t.triageId));
    const unpreparedSources = review.filter(t => !preparedSources.has(t.taskId)).length;
    const looseEnds = earlier.concat(attention.map(waitingItem), review);
    const queues = [
      { id: 'triage', label: 'Triage', rows: triage },
      { id: 'loose', label: 'Loose Ends', rows: looseEnds },
      { id: 'waiting', label: 'Waiting', rows: waiting, count: waiting.filter(i => i.overdue).length },
      { id: 'unscheduled', label: 'Unscheduled', rows: unplanned },
      { id: 'whenever', label: 'Whenever', rows: anytime }
    ].map(q => ({ ...q, count: q.count ?? q.rows.filter(e => !e.depth && !e.completed).length }));
    const byId = new Map();
    const todos = itinerary.concat(triage, unplanned, anytime, earlier).filter(e => !e.completed && !byId.has(e.taskId) && byId.set(e.taskId, true));
    return { date, sections, queues, unpreparedSources, itinerary, triage, unplanned, anytime, earlier, todos, all: tree(day.visible).concat(anytime, earlier), overlays: { ...carry.overlays, [date]: { done } }, truncated: !!carry.truncated,
      // Legacy seed-only timeline entries have no safe row identity in this snapshot.
      // Do not resurrect tombstones by rendering them as actionable tasks.
      seedOnly: list(snapshot.dayState?.schedule?.timeline).filter(e => !pool.some(p => p.id === e.id || (e.source_id && p.source_id === e.source_id))).length };
  }
  function currentNext(view, nowMinutes) {
    const open = view.itinerary.filter(e => !e.completed && !e.untimed && !e.allDay);
    const current = open.find(e => TM.isInProgress(e, e.completed)) || open.find(e => minutes(e.start) <= nowMinutes && minutes(e.end) > nowMinutes) || null;
    const next = open.find(e => e !== current && minutes(e.start) > nowMinutes) || null;
    return { current, next };
  }
  return { project, fromBlock, clock, currentNext, order };
});
