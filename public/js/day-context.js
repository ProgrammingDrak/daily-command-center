// ======== DAY CONTEXT + SLOT ENGINE ========
// One place that answers "what is on day X, and where does a task fit on it?",
// replacing the four copy-pasted free-slot pipelines that had quietly drifted
// (schedulePushedOnDate / _scheduleTaskOnDate / _computeRescheduleSlot in
// state.js, and _schedDayTasks in schedule.js). Those four each re-fetched
// /api/state/day + /api/blocks and each applied their own blocker-type and
// day-start rules, so the picker preview and the actual move could disagree and
// a single placement fetched the same day 2-3 times.
//
// Browser: loaded after task-serialize.js and before state.js/schedule.js,
// exposing window.DCC.getDayContext / findSlot / invalidateDayContext /
// buildDayContext. Node: require()d by tests (findSlot + buildDayContext are
// pure). UMD wrapper matches task-serialize.js / task-types.js.
//
//   getDayContext(dateStr) -> Promise<{dateStr,state,blocks,meetings,dayStart,
//     dayEnd}>. Memoized per date (the in-flight promise is cached, so two
//     callers in one interaction share ONE state+blocks fetch). Today/tomorrow
//     reuse the in-memory __DCC_STATE__/__DCC_TOMORROW__ instead of refetching.
//     Invalidated on block writes, on blockStore.invalidateRangeCache (drag /
//     unfinished reschedules), and on cross-tab SSE block events.
//
//   findSlot(ev, ctx, {excludeSelf, anchorNow, nowMinutes, todayStr}) -> the
//     single earliest-free algorithm. {start,end,duration} or null when the day
//     has no room. Pure given ctx + an (optionally injected) clock.
//
// CANONICAL RULE SET (deliberate reconciliation of the four copies):
//   - Blockers = ooo/break pseudo-blocks (from state.timeline) + persisted
//     added_task/schedule_item/block rows (from /api/blocks). ooo/break are
//     ALWAYS blockers. (_scheduleTaskOnDate used to ignore them.)
//   - anchorNow (default true): when placing on the actual today, start the
//     search at the next quarter-hour >= now, not the day's start.
//     (_scheduleTaskOnDate used to always start at the day's start.)
//   - Day bounds: first/last of state.schedule.blocks, falling back to
//     07:00-17:30 when the day has no plan. (_scheduleTaskOnDate fell back to
//     08:00.) A task may run up to 60 min past dayEnd before "no slot" fires.
//   - excludeSelf: drop ev's own persisted block from the blockers (moves want
//     to reslot around everything BUT themselves). The create paths dedupe on
//     ev.id in their wrapper instead and never pass excludeSelf.
// Of the three live consumers, schedulePushedOnDate and _computeRescheduleSlot
// already matched this set, so only the (currently call-site-less)
// _scheduleTaskOnDate changes behavior.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.getDayContext = api.getDayContext;
    DCC.findSlot = api.findSlot;
    DCC.invalidateDayContext = api.invalidateDayContext;
    DCC.buildDayContext = api.buildDayContext;
  }
})(typeof self !== "undefined" ? self : this, function () {
  const _root =
    typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : {});

  // ---- pure helpers (mirror state.js pt/fmt/dur + drag.js _freeStart) ----
  // Kept in-module so findSlot/buildDayContext are node-testable without a DOM.
  function _pt(s) {
    if (s instanceof Date) return s.getHours() * 60 + s.getMinutes();
    if (typeof s === "number") return s;
    const raw = String(s || "").trim();
    if (!raw) return 0;
    if (raw.includes("T")) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
    }
    const m = raw.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
    if (!m) return 0;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = m[3] ? m[3].toUpperCase() : null;
    if (ap === "AM") h = h === 12 ? 0 : h;
    else if (ap === "PM") h = h === 12 ? 12 : h < 12 ? h + 12 : h;
    return (((h % 24) + 24) % 24) * 60 + min;
  }
  function _fmt(mins) {
    return (
      String(Math.floor(mins / 60)).padStart(2, "0") +
      ":" +
      String(mins % 60).padStart(2, "0")
    );
  }
  function _dur(ev) {
    return _pt(ev.end) - _pt(ev.start);
  }
  // Earliest start >= cursor where duration d fits without overlapping a blocker.
  function _freeStart(cursor, d, blockers) {
    let s = cursor,
      changed = true;
    while (changed) {
      changed = false;
      for (const b of blockers) {
        if (s < b.e && s + d > b.s) {
          s = b.e;
          changed = true;
        }
      }
    }
    return s;
  }
  function _actualTodayStr() {
    const n = new Date();
    return (
      n.getFullYear() +
      "-" +
      String(n.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(n.getDate()).padStart(2, "0")
    );
  }
  function _nowMinutes() {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }

  // Which persisted block types occupy time (i.e. block a new task's slot).
  const BLOCKER_TYPES = { added_task: 1, schedule_item: 1, block: 1 };

  function _taskDuration(ev) {
    if (!ev) return 30;
    if (ev.duration != null) return ev.duration || 30;
    if (ev.durMin != null) return ev.durMin || 30;
    if (ev.start && ev.end) return _dur(ev) || 30;
    return 30;
  }

  // ---- pure context builder (no fetch, no globals) ----
  // Shape the {meetings, blocks, dayStart, dayEnd} a slot search needs from a
  // day-state object + its /api/blocks array. Split out so tests can build a
  // context without the network and callers can reuse a state they already hold.
  function buildDayContext(dateStr, state, blocks) {
    const sched = (state && state.schedule) || {};
    const timeline = sched.timeline || [];
    const meetings = timeline
      .filter((e) => e && (e.type === "ooo" || e.type === "break"))
      .map((e) => ({ s: _pt(e.start), e: _pt(e.end) }))
      .sort((a, b) => a.s - b.s);
    const stBlocks = sched.blocks || [];
    const dayStart = stBlocks.length ? _pt(stBlocks[0].start) : 7 * 60;
    const dayEnd = stBlocks.length
      ? _pt(stBlocks[stBlocks.length - 1].end)
      : 17 * 60 + 30;
    return {
      dateStr: dateStr,
      state: state || null,
      blocks: Array.isArray(blocks) ? blocks : [],
      meetings: meetings,
      dayStart: dayStart,
      dayEnd: dayEnd,
    };
  }

  // ---- THE earliest-free-slot algorithm (pure) ----
  function findSlot(ev, ctx, opts) {
    opts = opts || {};
    if (!ctx) return null;
    const d = _taskDuration(ev);
    const selfId = ev && ev.id;
    const taskBlockers = (ctx.blocks || [])
      .filter(
        (b) =>
          b &&
          !b.deleted_at &&
          BLOCKER_TYPES[b.type] &&
          b.properties &&
          b.properties.start &&
          b.properties.end &&
          !(opts.excludeSelf && selfId != null && b.properties.local_id === selfId)
      )
      .map((b) => ({ s: _pt(b.properties.start), e: _pt(b.properties.end) }));
    const blockers = (ctx.meetings || []).concat(taskBlockers).sort((a, b) => a.s - b.s);

    let cursor = ctx.dayStart;
    if (opts.anchorNow !== false) {
      const todayStr = opts.todayStr != null ? opts.todayStr : _actualTodayStr();
      if (ctx.dateStr === todayStr) {
        const nowMin = opts.nowMinutes != null ? opts.nowMinutes : _nowMinutes();
        cursor = Math.max(ctx.dayStart, Math.ceil(nowMin / 15) * 15);
      }
    }
    const slot = _freeStart(cursor, d, blockers);
    if (slot + d > ctx.dayEnd + 60) return null;
    return { start: _fmt(slot), end: _fmt(slot + d), duration: d };
  }

  // ---- browser-side memoized fetcher ----
  const _cache = new Map(); // dateStr -> Promise<ctx>

  function _resolveKnownState(dateStr) {
    // Today/tomorrow already live in memory; reuse instead of refetching.
    if (dateStr === _root.__todayDate && _root.__DCC_STATE__) return _root.__DCC_STATE__;
    if (dateStr === _root.__tomorrowDate && _root.__DCC_TOMORROW__)
      return _root.__DCC_TOMORROW__;
    return null;
  }

  async function _loadDayContext(dateStr) {
    let state = _resolveKnownState(dateStr);
    if (!state) {
      try {
        state = await _root
          .fetch("/api/state/day?date=" + encodeURIComponent(dateStr))
          .then((r) => r.json());
      } catch (e) {
        state = null;
      }
    }
    let blocks = [];
    try {
      blocks = await _root
        .fetch("/api/blocks?date=" + encodeURIComponent(dateStr))
        .then((r) => r.json());
    } catch (e) {
      blocks = [];
    }
    return buildDayContext(dateStr, state, Array.isArray(blocks) ? blocks : []);
  }

  function getDayContext(dateStr, opts) {
    opts = opts || {};
    _ensureHooks();
    if (!dateStr) return Promise.resolve(null);
    if (!opts.force && _cache.has(dateStr)) return _cache.get(dateStr);
    const p = _loadDayContext(dateStr);
    _cache.set(dateStr, p);
    // Drop a failed load so the next call retries instead of caching a reject.
    p.catch(() => {
      if (_cache.get(dateStr) === p) _cache.delete(dateStr);
    });
    return p;
  }

  function invalidateDayContext(dateStr) {
    if (dateStr) _cache.delete(dateStr);
    else _cache.clear();
  }

  // ---- invalidation hooks ----
  // blockStore loads AFTER this module, so wrap its methods lazily (idempotent,
  // first getDayContext call installs them, before it ever populates the cache).
  // This keeps the invalidation LOGIC in one file and, more importantly, makes
  // the cache contract explicit: the old pipelines refetched /api/blocks on every
  // slot computation and so could never read a stale day, so the memoized cache
  // must drop after every block write or it could double-book. One uniform
  // strategy — wrapping blockStore's mutators — rather than sprinkling
  // invalidate() calls at each write site. The wrapped set below is the COMPLETE
  // list of blockStore write methods (a matching pointer note in block-store.js
  // reminds a maintainer to add any new mutator here too):
  //   - createBlock/updateBlock/deleteBlock/rescheduleBlock/batchOp: every local
  //     write (push, reschedule, restore, commit, quick-add, unschedule, drag,
  //     clone, tombstone, batch) clears the affected date(s) after it settles.
  //   - invalidateRangeCache(date): drag + unfinished reschedules already fire
  //     it; piggyback per-date day-context invalidation.
  //   - handleBlocksChanged(event): cross-tab SSE block changes; clear all
  //     (we don't get a clean date), skipping our own echo by clientId.
  let _hooksInstalled = false;
  function _ensureHooks() {
    if (_hooksInstalled) return;
    const bs = _root.blockStore;
    if (!bs) return; // not loaded yet; a later call retries
    _hooksInstalled = true;
    if (typeof bs.invalidateRangeCache === "function") {
      const orig = bs.invalidateRangeCache.bind(bs);
      bs.invalidateRangeCache = function (dateStr) {
        invalidateDayContext(dateStr);
        return orig(dateStr);
      };
    }
    if (typeof bs.handleBlocksChanged === "function") {
      const orig = bs.handleBlocksChanged.bind(bs);
      bs.handleBlocksChanged = function (event) {
        if (!event || event.clientId !== bs.CLIENT_ID) invalidateDayContext();
        return orig(event);
      };
    }
    // Write methods carry (or imply) affected date(s); invalidate them after the
    // write resolves. A failed write leaves the server unchanged, so we do NOT
    // invalidate on rejection. Where a date can't be resolved (batchOp, an undated
    // block), clear all (invalidateDayContext(undefined) === clear all).
    _wrapWrite(bs, "createBlock", (a) => (a[2] && a[2].date ? [a[2].date] : null));
    _wrapWrite(bs, "rescheduleBlock", (a) => {
      const ds = [];
      if (a[1]) ds.push(a[1]); // targetDate
      if (a[2] && a[2].fromDate) ds.push(a[2].fromDate);
      return ds.length ? ds : null;
    });
    // update/delete take an id, not a date: resolve the block's CURRENT date from
    // the store BEFORE the write (a delete would remove it). updateBlock can also
    // MOVE a block via extra.date (an Unscheduled row promoted onto a day), so
    // invalidate that destination date too or the new day is left stale.
    _wrapWrite(bs, "updateBlock", (a) => {
      const ds = _dateOfBlock(bs, a[0]) || [];
      if (a[2] && a[2].date) ds.push(a[2].date);
      return ds.length ? ds : null;
    });
    _wrapWrite(bs, "deleteBlock", (a) => _dateOfBlock(bs, a[0]));
    // batchOp mutates an arbitrary set of blocks/dates server-side with no cheap
    // way to know which, so clear all. Dormant today (no callers) but wrapped so
    // a future caller can't silently leave the cache stale.
    _wrapWrite(bs, "batchOp", () => null);
  }
  function _dateOfBlock(bs, id) {
    const b = typeof bs.get === "function" ? bs.get(id) : null;
    return b && b.date ? [b.date] : null;
  }
  function _wrapWrite(bs, name, dateOf) {
    if (typeof bs[name] !== "function") return;
    const orig = bs[name].bind(bs);
    bs[name] = async function () {
      const dates = dateOf(arguments); // capture before the write settles
      const r = await orig.apply(bs, arguments);
      if (dates && dates.length) dates.forEach((d) => invalidateDayContext(d));
      else invalidateDayContext();
      return r;
    };
  }

  return {
    getDayContext: getDayContext,
    findSlot: findSlot,
    invalidateDayContext: invalidateDayContext,
    buildDayContext: buildDayContext,
  };
});
