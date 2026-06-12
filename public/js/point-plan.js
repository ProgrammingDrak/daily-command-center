// ======== SUBTASK POINT ALLOCATION ("the pie") ========
// A parent task owns a point "pool". A slice is set aside as a "completion
// bonus" — awarded only when the parent itself is checked done — and the
// remainder is divided among the parent's subtasks (subtaskOf === parent id).
// Slices are equal by default; the user can lock individual slices (or the
// bonus/pool) and the unlocked slices rebalance to fill what's left.
//
// Subtasks draw their points FROM the parent (shared pie). This is distinct from
// "stacked" tasks (the wrapId / ride-along edge), whose time and points are
// independent of the parent and keep the normal duration-based scoring.
//
// Plans persist on the day_root block under properties._pointPlans, keyed by
// parent task id — same pattern as _durChanges / _commuteTimes (see
// _bsProp / _bsSaveProp in persistence.js), with a localStorage fallback. We do
// NOT store per-subtask points on the ev objects, so parents of any origin
// (responsibility, calendar, quick-add) are supported uniformly.
(function () {
  "use strict";

  const DEFAULT_BONUS_PCT = 0.25; // share of the pool reserved for finishing the whole thing
  const MAX_POINTS = 500;
  const LS_KEY = "pa-point-plans-v1";

  function _round(n) { return Math.max(0, Math.round(Number(n) || 0)); }
  function _clamp(n) { return Math.max(0, Math.min(MAX_POINTS, _round(n))); }

  // ---- storage (day_root.properties._pointPlans), with localStorage fallback ----
  function _loadAll() {
    try {
      if (typeof _bsProp === "function") {
        const v = _bsProp("_pointPlans", null);
        if (v && typeof v === "object") return v;
      }
    } catch (e) {}
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function _saveAll(plans) {
    try {
      if (typeof _bsSaveProp === "function" && _bsSaveProp("_pointPlans", plans)) return;
    } catch (e) {}
    try { localStorage.setItem(LS_KEY, JSON.stringify(plans)); } catch (e) {}
  }

  function _pool() { return (typeof scheduled !== "undefined" && scheduled) ? scheduled : []; }
  function _findEv(id) { return _pool().find(e => e && e.id === id) || null; }
  function _subsOf(parentId) { return _pool().filter(c => c && c.subtaskOf === parentId); }
  function _isDone(id) {
    try { return typeof manualDone !== "undefined" && manualDone.has(id); } catch (e) { return false; }
  }

  // Estimate a parent's natural point value — the default pool. Mirrors the
  // points chip: TaskPoints.estimate over the parent's payload.
  function estimatePool(parentId) {
    const ev = _findEv(parentId);
    if (ev && window.TaskPoints && typeof window.TaskPoints.estimate === "function") {
      try {
        const payload = typeof window.TaskPoints.buildPayload === "function"
          ? window.TaskPoints.buildPayload(ev, {})
          : ev;
        const s = window.TaskPoints.estimate(payload);
        if (s && s.eligible && s.awardPoints > 0) return _round(s.awardPoints);
      } catch (e) {}
    }
    const mins = ev ? Number(ev.durMin || ev.duration || (typeof dur === "function" ? dur(ev) : 0)) : 0;
    return _round(mins > 0 ? mins : 14);
  }

  // Normalized, reconciled view of a parent's plan. Does NOT persist. Returns
  // null when the parent has no subtasks (no pie to divide).
  //   { parentId, pool, bonus, shares:{id:{pts,locked}}, order:[id],
  //     allocated, discrepancy, sumShares, earned, parentDone, doneCount, total }
  // discrepancy = pool - allocated  (>0 under-allocated, <0 over-allocated)
  function compute(parentId) {
    const subs = _subsOf(parentId);
    if (!subs.length) return null;

    const raw = _loadAll()[parentId] || {};
    let pool = _round(raw.pool != null ? raw.pool : estimatePool(parentId));
    if (pool < 1) pool = 1;
    let bonus = raw.bonus != null ? _round(raw.bonus) : _round(pool * DEFAULT_BONUS_PCT);
    if (bonus > pool) bonus = pool;

    const rawShares = raw.shares || {};
    const shares = {};
    const order = [];
    subs.forEach(s => {
      order.push(s.id);
      const r = rawShares[s.id];
      shares[s.id] = { pts: r ? _round(r.pts) : 0, locked: !!(r && r.locked) };
    });

    // Rebalance unlocked shares to split (pool - bonus - lockedSum) equally.
    const lockedSum = order.reduce((sum, id) => sum + (shares[id].locked ? shares[id].pts : 0), 0);
    const unlocked = order.filter(id => !shares[id].locked);
    let distributable = pool - bonus - lockedSum;
    if (distributable < 0) distributable = 0;
    if (unlocked.length) {
      const base = Math.floor(distributable / unlocked.length);
      const rem = distributable - base * unlocked.length;
      unlocked.forEach((id, i) => { shares[id].pts = base + (i < rem ? 1 : 0); });
    }

    const sumShares = order.reduce((s, id) => s + shares[id].pts, 0);
    const allocated = bonus + sumShares;
    const discrepancy = pool - allocated;

    let earned = 0;
    order.forEach(id => { if (_isDone(id)) earned += shares[id].pts; });
    const parentDone = _isDone(parentId);
    if (parentDone) earned += bonus;

    return {
      parentId, pool, bonus, shares, order,
      allocated, discrepancy, sumShares,
      earned: Math.min(earned, pool), parentDone,
      doneCount: order.filter(id => _isDone(id)).length, total: order.length,
    };
  }

  // Persist a normalized plan so future loads are stable (snapshots the pool).
  function _persist(plan) {
    if (!plan) return;
    const all = _loadAll();
    const shares = {};
    plan.order.forEach(id => { shares[id] = { pts: plan.shares[id].pts, locked: !!plan.shares[id].locked }; });
    all[plan.parentId] = { pool: plan.pool, bonus: plan.bonus, shares };
    _saveAll(all);
  }

  // Reconcile + persist a parent's plan (call after add/remove of a subtask).
  function ensure(parentId) {
    const plan = compute(parentId);
    if (plan) _persist(plan);
    return plan;
  }
  function reconcile(parentId) { return ensure(parentId); }

  function shareFor(parentId, subId) {
    const plan = compute(parentId);
    return (plan && plan.shares[subId]) ? plan.shares[subId].pts : 0;
  }

  // Points due when the PARENT itself is completed: the completion bonus plus
  // the slices of any subtasks still open (already-completed subtasks were
  // credited individually). MUST be called BEFORE cascading subtask completion.
  function awardForParentCompletion(parentId) {
    const plan = compute(parentId);
    if (!plan) return 0;
    let pts = plan.bonus;
    plan.order.forEach(id => { if (!_isDone(id)) pts += plan.shares[id].pts; });
    return _round(pts);
  }

  // ---- mutators (used by the allocation editor) ----
  function _editable(parentId) {
    const all = _loadAll();
    const plan = compute(parentId);
    const cur = all[parentId] || (plan ? { pool: plan.pool, bonus: plan.bonus, shares: {} } : null);
    return { all, cur };
  }
  function setPool(parentId, pts) {
    const { all, cur } = _editable(parentId);
    if (!cur) return null;
    cur.pool = Math.max(1, _clamp(pts));
    all[parentId] = cur; _saveAll(all);
    return ensure(parentId);
  }
  function setBonus(parentId, pts) {
    const { all, cur } = _editable(parentId);
    if (!cur) return null;
    cur.bonus = _clamp(pts);
    all[parentId] = cur; _saveAll(all);
    return ensure(parentId);
  }
  // Lock a subtask's slice at an explicit value; unlocked siblings rebalance.
  function setShare(parentId, subId, pts) {
    const plan = compute(parentId);
    if (!plan) return null;
    const all = _loadAll();
    const cur = all[parentId] || { pool: plan.pool, bonus: plan.bonus, shares: {} };
    cur.pool = cur.pool != null ? cur.pool : plan.pool;
    cur.bonus = cur.bonus != null ? cur.bonus : plan.bonus;
    cur.shares = cur.shares || {};
    cur.shares[subId] = { pts: _clamp(pts), locked: true };
    all[parentId] = cur; _saveAll(all);
    return ensure(parentId);
  }
  function unlockShare(parentId, subId) {
    const all = _loadAll();
    const cur = all[parentId];
    if (cur && cur.shares && cur.shares[subId]) { cur.shares[subId].locked = false; _saveAll(all); }
    return ensure(parentId);
  }
  // Reset a parent's plan back to defaults (equal split, 25% bonus, fresh pool).
  function reset(parentId) {
    const all = _loadAll();
    delete all[parentId];
    _saveAll(all);
    return ensure(parentId);
  }

  window.PointPlan = {
    compute, ensure, reconcile, shareFor, awardForParentCompletion, estimatePool,
    setPool, setBonus, setShare, unlockShare, reset,
    DEFAULT_BONUS_PCT, MAX_POINTS,
  };
})();
