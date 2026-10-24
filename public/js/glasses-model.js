// Compact display adapter. Task identity, hierarchy and section membership stay in TaskModel.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./task-model'));
  else root.GlassesModel = factory(root.DCC.TaskModel);
})(typeof self !== 'undefined' ? self : this, function (TM) {
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
    return Object.assign(ev, { taskId: block.id, date: block.date || null, completed: p.done === true || p.status === 'done' || !!p.completedAt || list(overlay.done).includes(ev.id), completionRevision: p._completionRevision || null });
  }
  function project(snapshot, carry = { rows: [], overlays: {} }) {
    const date = snapshot.date, all = [...new Map(list(snapshot.blocks).concat(list(snapshot.globals)).map(b => [b.id, b])).values()].sort(order);
    const props = all.find(b => b.type === 'day_root' && b.date === date)?.properties || {};
    const done = list(props._done?.ids), hidden = new Set(list(props._deleted).concat(list(props._pushed?.ids)));
    const datedIds = new Set(all.filter(b => b.date).map(b => b.properties?.local_id).filter(Boolean));
    const backlog = TM.selectUnscheduled(all);
    const parentKeys = TM.backlogParentKeys(all);
    const backlogIds = new Set(backlog.map(b => b.id));
    const rows = all.filter(b => !b.deleted_at && ['block', 'added_task', 'pending_task'].includes(b.type) && (TM.foldsIntoItinerary(b) || backlogIds.has(b.id)) &&
      !['deleted', 'archived'].includes(b.properties?.status) && !hidden.has(b.id) && !hidden.has(b.properties?.local_id));
    const pool = rows.filter(b => !TM.isWheneverPoolRow(b) && (b.date === date || (!b.date && !datedIds.has(b.properties?.local_id))))
      .map(b => fromBlock(b, { done }, parentKeys)).filter(e => e.date || !e.completed);
    const opts = { isDone: e => e.completed, isDeleted: () => false, trivialFlags: props._trivialFlags || {}, waitingRows: all };
    const day = TM.selectDay(pool, date, opts);
    const tree = items => TM.selectTree(items, { pool: items, isCollapsed: () => false }).map(n => ({ ...n.ev, depth: n.depth }));
    const itinerary = tree(day.timed);
    const unplanned = tree(day.unscheduled);
    const anytime = tree(TM.selectWheneverPoolBlocks(rows).map(b => fromBlock(b, {}, parentKeys)).filter(e => !e.completed));
    const earlier = tree(list(carry.rows).sort(order).map(b => fromBlock(b, carry.overlays?.[b.date])).filter(e => !e.completed));
    const byId = new Map();
    const todos = itinerary.concat(unplanned, anytime, earlier).filter(e => !e.completed && !byId.has(e.taskId) && byId.set(e.taskId, true));
    return { date, itinerary, unplanned, anytime, earlier, todos, all: tree(day.visible).concat(anytime, earlier), overlays: { ...carry.overlays, [date]: { done } }, truncated: !!carry.truncated,
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
