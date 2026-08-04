// ======== CARRYOVER: UNFINISHED PAST TASKS ========
// One collector and one action set for tasks that were scheduled on a past day
// and never finished. Two surfaces consume it:
//   • the inline "Unscheduled" lane in the itinerary (schedule-tab.js), bounded
//   • the "Catch up" modal (the add-bar button), same rows + a Show older escape
//     hatch that lifts the bound
// It reads from the durable blockStore range cache (the same source day-review.js
// uses for past days), not the in-memory `scheduled[]` array, which only holds
// today's plan.
//
// The rows this hands out are REAL evs — TaskModel.fromBlock, the same projection
// the itinerary itself uses — with an `__unf` provenance stamp for the amber chip
// and the origin-day writes. The old bespoke 15-field row shape is gone: it was
// the first of two hops that stripped source_id, tags, prep status, privacy and
// the parent edge, which is why a carryover row rendered as a stub.
(function () {
  "use strict";

  // The fixed-type skip (meeting/oneone/ooo/break, plus the raw calendar types
  // focus/focus_time/free_time/prep) moved to the server in C2 — see db.js
  // carryoverSkipTypes(), which derives the first half from the same TASK_TYPES
  // registry this file used to read via window.TaskTypes.isFixed. It is applied to
  // roots and descendants alike in SQL, so there is no client copy left to drift.
  //
  // Lookback is BOUNDED. It used to be "every archived day", and /api/state/archives
  // serves 90 — so the lane grew without limit and became the clog it was meant to
  // surface. 14 days is the review window; the modal's "Show older" toggle lifts it
  // (collect({days:null})) for the rare deep sweep.
  const SCAN_DAYS = 14;
  const MAX_ROWS = 100;           // guard against an unbounded archive

  // ── small utils ──
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayStr() {
    if (typeof __todayDate === "string" && __todayDate) return __todayDate;
    return new Date().toISOString().slice(0, 10);
  }
  function prettyDate(iso) {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function evDur(ev) { return (typeof dur === "function") ? Math.max(0, dur(ev)) : 0; }
  function fmtDur(min) { return (typeof ms === "function") ? ms(min) : (min + "m"); }
  function esc(s) { return (typeof escHtml === "function") ? escHtml(s) : String(s == null ? "" : s); }

  // Legacy per-day manual-done marks (mirrors the day_root _done overlay).
  function localDoneSet(date) {
    const out = new Set();
    try {
      const raw = localStorage.getItem("pa-done-" + date);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.ids)) obj.ids.forEach(id => out.add(id));
      }
    } catch (e) {}
    return out;
  }

  // ── collect ──
  // Returns { rows, total, scanned } where rows is capped at MAX_ROWS and each row
  // is a full ev carrying __unf provenance. opts.days bounds the lookback
  // (default SCAN_DAYS); pass {days:null} for the unbounded sweep.
  // C2: the multi-day archive scan is GONE. This used to loadDateRange() every
  // archived day, pull every block on each of them, and rebuild the task predicate
  // in JS one day at a time. GET /api/tasks/open now returns the whole pool for the
  // window in one indexed query, plus the day_root overlay slice, so the structural
  // predicate (row types, task-kind, fixed-type skip, start-or-nested) lives in SQL
  // where a caller cannot forget it.
  //
  // The endpoint returns the POOL, not the roots: a nested row whose parent is not in
  // the pool still has to render, so membership must never depend on the parent.
  // rootsOf() below is what decides rendering, and it is shared by all three surfaces.
  //
  // What deliberately did NOT move: DONE-ness. Completion still lives in the
  // day_root `_done` overlay plus the legacy localStorage mirror the server cannot
  // see, and collapsing it onto `status` is C5's job, gated on the ledger audit.
  // Measured while building this: 264 past-day rows read `status='open'` while being
  // finished in the overlay, so a server-side status filter would have resurrected
  // every one of them into this lane. One done predicate, and it is the one below.
  // One shape for every return path -- callers destructure `truncated` without having
  // to know which branch produced the payload.
  const EMPTY = () => ({ rows: [], total: 0, scanned: 0, truncated: false });
  async function collectUnfinished(opts) {
    opts = opts || {};
    const days = (opts.days === null) ? null : (opts.days || SCAN_DAYS);
    const TaskModel = window.DCC && window.DCC.TaskModel;
    const api = window.DCC && window.DCC.api;
    if (!TaskModel || typeof api !== "function") return EMPTY();

    const today = todayStr();
    let payload;
    try {
      // The unbounded sweep asks for the route's full headroom. Its LIMIT applies to
      // the raw pool BEFORE the done filter below, and since C2 that pool is roots,
      // children and done rows together — so the default 500 would quietly turn "every
      // archived day" into "the newest month or so", while the modal footer still says
      // otherwise. MAX_ROWS still caps what actually renders.
      payload = await api("/api/tasks/open?before=" + encodeURIComponent(today) +
                          "&days=" + (days === null ? "all" : String(days)) +
                          (days === null ? "&limit=2000" : ""));
    } catch (e) {
      // An empty lane, never a stale one. Every consumer is built for this shape —
      // it is what the old collector returned when the store was missing.
      return EMPTY();
    }
    const blocks = Array.isArray(payload && payload.rows) ? payload.rows : [];
    const overlays = (payload && payload.overlays) || {};

    const rows = [];
    const seen = new Set();
    // Per-DATE, and memoized. The old collector looped dates on the outside and that
    // day's blocks on the inside, so this ran once per day. Flattening to a single loop
    // over rows would otherwise do a synchronous localStorage read + JSON.parse and
    // rebuild both Sets once per ROW, and localStorage blocks paint -- the opposite of
    // what moving the scan server-side was for.
    const dayCache = new Map();
    const overlayFor = (date) => {
      let d = dayCache.get(date);
      if (d) return d;
      const ov = overlays[date] || {};
      // Done ids for THIS date: day_root._done marks + legacy localStorage marks.
      // Scoped per date and never flattened across the pool — the same id can exist
      // on two days and being done on one must not mark the other.
      const doneIds = new Set(Array.isArray(ov.done) ? ov.done : []);
      localDoneSet(date).forEach(id => doneIds.add(id));
      // Locks live on the ORIGIN day's day_root (_lockedTasks), not on the block —
      // hydrateLockedTasks only ever stamps today's scheduled[]. The endpoint reads
      // them per date so the padlock still renders on a carryover row.
      d = { doneIds, lockedIds: new Set(Array.isArray(ov.locked) ? ov.locked : []) };
      dayCache.set(date, d);
      return d;
    };

    for (const b of blocks) {
      const p = (b && b.properties) || {};
      const date = b.date;
      const { doneIds, lockedIds } = overlayFor(date);

      // A nested step (subtask / ride-along) legitimately carries no time — it lives
      // under its parent. The server keeps them, which is what lets the lane nest.
      const nested = !!(p.subtaskOf || p.wrapId);
      // A finished top-level task is simply finished. A finished CHILD still counts
      // toward its parent's progress ("2/5 subtasks"), so it stays in the pool marked
      // done; the lane renders only the open rows.
      const isDone = !!(p.done || doneIds.has(b.id) || (p.local_id && doneIds.has(p.local_id)));
      if (isDone && !nested) continue;
      if (seen.has(b.id) || (p.local_id && seen.has(p.local_id))) continue;
      seen.add(b.id);
      if (p.local_id) seen.add(p.local_id);

      // deriveEnd: a carryover row never gets a recalcTimes pass, so its `end`
      // has to be anchored to its own start (see task-model.js).
      const ev = TaskModel.fromBlock(b, { deriveEnd: true });
      ev.__unf = {
        sourceId: b.id,
        sourceLocalId: p.local_id || null,
        sourceDate: date || null,
        createdAt: b.created_at || null,
        done: isDone
      };
      if (lockedIds.has(ev.id) || lockedIds.has(b.id)) ev._locked = true;
      rows.push(ev);
    }

    // Most recent first.
    rows.sort((a, b) => (a.__unf.sourceDate < b.__unf.sourceDate ? 1 : (a.__unf.sourceDate > b.__unf.sourceDate ? -1 : 0)));
    // `total` is what the lane and the prompt count: OPEN rows. The done children
    // riding along are progress data, not work.
    const total = rows.filter(ev => !ev.__unf.done).length;
    // `scanned` is still "how many past days this pool came from", now counted by the
    // server off the dates it actually touched rather than by the client off the days
    // it walked. The modal's footer copy reads it. `truncated` says the server's LIMIT
    // clipped the raw pool, which makes `total` a floor rather than an exact count.
    return {
      rows: rows.slice(0, MAX_ROWS), total,
      scanned: Number(payload.scanned) || 0,
      truncated: !!(payload && payload.truncated)
    };
  }

  // ── shared actions ──────────────────────────────────────────────────────────
  // ONE implementation of complete / move / drop for a carryover row, used by both
  // the inline lane and the modal. A carryover is a past-day block, not a member of
  // today's scheduled[], so it can't ride toggleDone / moveTaskViaPlacement /
  // openDeleteConfirm (each of which resolves its id against scheduled[] and would
  // no-op). These route to the same underlying primitives those paths use:
  // commitDoneOnDate, blockStore.rescheduleBlock, blockStore delete.
  //
  // Each returns the ids it removed from the lane so the caller can drop the rows.

  // Every descendant of `ev` inside the carryover pool, deepest last. Depth-capped
  // and cycle-guarded, mirroring TaskModel.selectTree.
  function descendants(ev, pool) {
    const out = [];
    const seen = new Set([ev && ev.id]);
    (function walk(id, depth) {
      if (depth > 20) return;
      (pool || []).forEach(c => {
        const pid = _parentIdOf(c);
        if (pid !== id || seen.has(c.id)) return;
        seen.add(c.id);
        out.push(c);
        walk(c.id, depth + 1);
      });
    })(ev && ev.id, 0);
    return out;
  }

  function originOf(ev) { return (ev && ev.__unf) || {}; }
  function writeId(ev) { const u = originOf(ev); return u.sourceLocalId || u.sourceId; }

  // The origin row, from the cache a carryover actually lives in. _rangeCache is
  // where loadDateRange puts it; blockStore.get (_dayCache/_globalCache) is the
  // fallback for the rare row that is also in today's cache. Any write that
  // REPLACES properties must go through this, never bare get().
  // Async because it may have to REFILL the range cache. Every action below ends with
  // invalidateRangeCache(sourceDate), and the itinerary lane's _unfSettle only drops
  // the settled rows and re-renders -- it never calls invalidateUnfinishedSection, so
  // _ensureUnfinished short-circuits on _unfinishedFetchedFor and nothing re-collects.
  // Without the refill, the FIRST action on a given origin day evicted that day and
  // every later resolution for it returned null, so Backlog on a second row from the
  // same day refused until a page reload. Two unfinished tasks from yesterday is the
  // common case, so this path is hit constantly.
  async function _originBlock(id, date) {
    const bs = window.blockStore;
    if (!bs) return null;
    const find = () => {
      const day = (date && typeof bs.getRangeCache === "function") ? bs.getRangeCache(date) : null;
      return (day && Array.isArray(day.blocks)) ? (day.blocks.find(b => b && b.id === id) || null) : null;
    };
    let hit = find();
    if (!hit && date && typeof bs.loadDateRange === "function") {
      try { await bs.loadDateRange(date, date); } catch (e) {}
      hit = find();
    }
    return hit || ((typeof bs.get === "function") ? bs.get(id) : null);
  }

  // state.js owns the canonical parent-edge precedence (wrapId before subtaskOf) and
  // documents it as a live divergence with the server twin (lib/reschedule.js
  // collectSubtreeBlockIds is subtaskOf-first) that has to be kept in step. Prefer
  // the global so there is ONE spelling to reconcile; the local fallback exists only
  // so this module stays require()able under node. Same idiom as fmtDur below.
  function _parentIdOf(ev) {
    if (typeof parentIdOf === "function") return parentIdOf(ev);
    return (ev && (ev.wrapId || ev.subtaskOf)) || null;
  }

  // ONE definition of "rows that are still work" and "roots of the pool", shared by
  // every surface that reads a carryover pool: the itinerary lane (schedule-tab.js),
  // the Catch up modal below, and the morning prompt (catch-up.js). The collector
  // deliberately KEEPS done children in the pool so a parent's "2/5 subtasks" can
  // count them, which means every consumer has to filter them the same way -- and
  // three hand-rolled copies is how they end up disagreeing. They already had:
  // the lane used parentIdOf, the prompt inlined wrapId||subtaskOf.
  // C6a: the predicate itself lives in TaskModel.selectCarryover. This name stays
  // because DCC.Carryover is the carryover lane's published API (the itinerary lane,
  // the Catch up modal and the morning prompt all call it), but there is one body.
  function openRows(pool) { return DCC.TaskModel.selectCarryover(pool); }
  function rootsOf(pool) {
    const open = openRows(pool);
    return open.filter(ev => { const p = _parentIdOf(ev); return !p || !open.some(x => x.id === p); });
  }

  // Complete on the ORIGIN day, subtree included. The old handler completed only
  // the parent, so a carryover parent's children stayed unfinished forever and the
  // lane re-offered them the next day.
  //
  // This loop OWNS the walk, so it passes `cascade:false` (C5b). commitDoneOnDate got its
  // own subtree cascade in C5b, and the two walks multiply: the parent's call would write
  // the whole subtree, then each child's call would re-fetch the same day and write its own
  // subtree again (a 6-node chain: 6 queued writes becomes 21, all serialized behind one
  // global chain, each PATCH preceded by a row GET because origin-day rows are not in
  // `_dayCache`). Keeping the loop rather than deferring to the cascade is deliberate: each
  // call credits its own node, so folding them together would change what a carryover
  // completion pays. Children can also sit on a different day than their parent, which one
  // date-scoped walk cannot see.
  //
  // Sequential await is no longer about clobbering -- per-row writes go through
  // `enqueueRowPropsWrite`, which serializes them -- but it keeps the ledger calls ordered.
  async function complete(ev, pool) {
    const u = originOf(ev);
    const kids = descendants(ev, pool);
    const removed = [];
    for (const t of [ev].concat(kids)) {
      const tu = originOf(t);
      const date = tu.sourceDate || u.sourceDate;
      try { if (typeof commitDoneOnDate === "function") await commitDoneOnDate(writeId(t) || t.id, date, { cascade: false }); } catch (e) {}
      removed.push(t.id);
    }
    if (window.blockStore && typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache(u.sourceDate);
    if (typeof window.invalidateHabitStreaks === "function") window.invalidateHabitStreaks();
    if (typeof log === "function") log("checked-on", u.sourceId, "Done on " + u.sourceDate + ": " + ev.title);
    if (typeof showToast === "function") showToast("Done on " + prettyDate(u.sourceDate) + ": " + ev.title + (kids.length ? " (+" + kids.length + " nested)" : ""), "success");
    return { removed };
  }

  // True cross-day move: POST /reschedule moves the block AND its subtree in one
  // server transaction and leaves the amber "Rescheduled away" tombstone on the
  // origin day. opts.slot = {start,end} pins the landing time.
  async function moveTo(ev, targetDate, opts) {
    opts = opts || {};
    const u = originOf(ev);
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      if (typeof showToast === "function") showToast("Pick a valid date", "error");
      return null;
    }
    if (!window.blockStore || typeof window.blockStore.rescheduleBlock !== "function") return null;
    let slot = opts.slot || null;
    if (!slot && typeof _computeRescheduleSlot === "function") {
      try { slot = await _computeRescheduleSlot({ id: writeId(ev) || ev.id, title: ev.title, start: ev.start, end: ev.end }, targetDate); } catch (e) {}
    }
    window.__RESCHEDULE_IN_FLIGHT__ = true;
    try {
      await window.blockStore.rescheduleBlock(u.sourceId, targetDate, slot ? { parentStart: slot.start, parentEnd: slot.end } : {});
    } catch (e) {
      if (typeof showToast === "function") showToast("Could not move " + ev.title, "error");
      return null;
    } finally {
      window.__RESCHEDULE_IN_FLIGHT__ = false;
    }
    // The server moved the whole subtree; drop the children from the lane too.
    const removed = [ev.id].concat(descendants(ev, opts.pool).map(t => t.id));
    if (typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache(u.sourceDate);
    if (typeof window.invalidateHabitStreaks === "function") window.invalidateHabitStreaks();
    if (typeof log === "function") log("rescheduled", u.sourceId, "Unfinished moved to " + targetDate + ": " + ev.title);
    if (typeof showToast === "function") showToast("Moved to " + prettyDate(targetDate) + ": " + ev.title, "success");
    // Landing on the day we're looking at: refold so it appears immediately.
    // opts.deferRefold lets a BULK caller skip it per row and refold once at the end
    // ("Move all to today" always targets the viewed day, so this fired on every
    // iteration and only the last one was ever seen -- N-1 wasted loadDay round trips
    // plus a full scheduled[] rebuild and recalcTimes cascade each). Safe to defer:
    // findSlot reads the target day from the server via getDayContext, not from the
    // local scheduled[], so skipping the local rebuild cannot change the next slot.
    const viewing = (typeof viewDate !== "undefined" && viewDate) ? viewDate : todayStr();
    if (targetDate === viewing && !opts.deferRefold) await refoldViewedDay(viewing);
    return { removed };
  }

  // Drop = a real soft-delete of the origin block AND its subtree, in one atomic
  // batch. (carryover-review.js's Drop was a log line that deleted nothing, so the
  // task came straight back the next morning.)
  async function drop(ev, pool) {
    const u = originOf(ev);
    const kids = descendants(ev, pool);
    const ids = [u.sourceId].concat(kids.map(t => originOf(t).sourceId).filter(Boolean));
    try {
      if (ids.length > 1 && window.blockStore && typeof window.blockStore.batchOp === "function") {
        await window.blockStore.batchOp(ids.map(id => ({ op: "delete", id })));
      } else {
        await window.blockStore.deleteBlock(u.sourceId);
      }
    } catch (e) {}
    if (window.blockStore && typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache(u.sourceDate);
    if (typeof window.invalidateHabitStreaks === "function") window.invalidateHabitStreaks();
    if (typeof log === "function") log("dropped", u.sourceId, "Dropped unfinished: " + ev.title);
    if (typeof showToast === "function") showToast("Dropped: " + ev.title + (kids.length ? " (+" + kids.length + " nested)" : ""), "info");
    return { removed: [ev.id].concat(kids.map(t => t.id)) };
  }

  // Unschedule to the backlog: an in-place date=null UPDATE, no new id, no delete.
  // (The old "To Backlog" minted a fresh copy and left the origin behind, so the
  // task lived in two places and came back the next day.)
  //
  // C4: the write itself is `state.js unscheduleRow` now — this was one of THREE
  // hand-rolled copies of "set date to null", and it was the only one that got it
  // right, so it is the one the shared primitive was modelled on. Two things it used
  // to do here and no longer needs to:
  //   • re-state the durMin/duration drift (hydrateBacklogFromBlocks reads durMin, not
  //     duration). The primitive carries it.
  //   • decide what happens to a stale `start`. The primitive strips it.
  // What it deliberately still does itself is RESOLVE the row, through _originBlock, and
  // hand it to the primitive as opts.block. Letting unscheduleRow resolve it instead
  // would have swapped a range-cache read for an HTTP GET on every carryover → backlog
  // action, because a carryover block is loaded by loadDateRange into _rangeCache ONLY
  // and blockStore.get() reads _dayCache/_globalCache. _originBlock also owns the
  // one-day refill C1 added after its first fix died on the second invocation. Same
  // mechanic for the write, the right resolver for this cache.
  //
  // The load-bearing guard is unchanged and now lives in one place: refuse BEFORE
  // writing if the row cannot be resolved, because updateBlock REPLACES properties
  // wholesale (db.js: newProps = parsed) and spreading a null block wiped title,
  // local_id, duration, subtaskOf, notes, tags and source_id behind a success toast.
  async function toBacklog(ev, pool) {
    const u = originOf(ev);
    const block = await _originBlock(u.sourceId, u.sourceDate);
    if (!block || !block.properties || typeof unscheduleRow !== "function") {
      if (typeof showToast === "function") showToast("Could not move " + ev.title + " to the backlog", "error");
      return null;
    }
    // NO durMin override here, deliberately, and the asymmetry with
    // _moveTaskToBacklogStage is the point. That path passes dur(ev) because a row on
    // TODAY has been through recalcTimes and adjustDur, which move `ev.end` and never write
    // `properties.duration` back — so end-start is live and the stored duration is stale.
    // A carryover ev is the other way round: it never gets a recalcTimes pass, and
    // fromBlock DERIVES its end from `duration` when the row has no end, so the row's own
    // duration is the authority and end-start is the derived value. Passing dur(ev) here
    // inverted that and reported 30m for a row storing 45 (pinned in
    // carryover-actions.test.js). Let the primitive read the row.
    const updated = await unscheduleRow(u.sourceId, { block: block });
    if (!updated) {
      if (typeof showToast === "function") showToast("Could not move " + ev.title + " to the backlog", "error");
      return null;
    }
    if (window.blockStore && typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache(u.sourceDate);
    if (typeof log === "function") log("created", u.sourceId, "Unfinished to backlog: " + ev.title);
    if (typeof showToast === "function") showToast("Moved to the backlog: " + ev.title, "success");
    // Children keep their parent edge and follow it as nested backlog rows.
    return { removed: [ev.id].concat(descendants(ev, pool).map(t => t.id)) };
  }

  // Re-collect the lane after a write ADDED a row to one of its origin days (C4).
  //
  // Both halves are needed and neither is sufficient: invalidateRangeCache alone leaves
  // _unfinishedCache holding the pre-write answer, and invalidateUnfinishedSection alone
  // leaves the range cache holding the pre-write day. The four actions above inline only
  // the range half because they REMOVE rows and _unfDropRows handles the section locally;
  // an add needs both. Lives here rather than in the caller so the next verb that adds to
  // an origin day (a drag onto a carryover parent, the bounty once its scoring is settled)
  // finds it instead of hand-rolling a fifth copy.
  function recollect(sourceDate) {
    const bs = window.blockStore;
    if (bs && typeof bs.invalidateRangeCache === "function" && sourceDate) bs.invalidateRangeCache(sourceDate);
    if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
  }

  // Re-read a day and rebuild the in-memory plan from it. Shared so the bulk path
  // can run it exactly once after its queue drains.
  async function refoldViewedDay(date) {
    try { await window.blockStore.loadDay(date); } catch (e) {}
    if (typeof reloadPersistedEdits === "function") reloadPersistedEdits();
    if (typeof recalcTimes === "function") recalcTimes();
  }

  // ── modal (reuses the .carryover-* CSS) ──
  let _modalDays = SCAN_DAYS;      // null once "Show older" is toggled on

  function ensureModal() {
    let overlay = document.getElementById("unfinished-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "carryover-overlay";
    overlay.id = "unfinished-overlay";
    overlay.innerHTML =
      '<div class="carryover">' +
        '<div class="carryover-hdr">' +
          '<h3 id="unfinished-title">Catch up</h3>' +
          '<button class="pvb-close" id="unfinished-close">&times;</button>' +
        '</div>' +
        '<div class="carryover-body">' +
          '<div class="carryover-hint" id="unfinished-hint"></div>' +
          '<div class="carryover-list" id="unfinished-list"></div>' +
        '</div>' +
        '<div class="carryover-footer">' +
          '<button class="carryover-btn" id="unfinished-older"></button>' +
          '<button class="carryover-skip" id="unfinished-close-2">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    overlay.querySelector("#unfinished-close").addEventListener("click", closeModal);
    overlay.querySelector("#unfinished-close-2").addEventListener("click", closeModal);
    overlay.querySelector("#unfinished-older").addEventListener("click", () => {
      _modalDays = (_modalDays === null) ? SCAN_DAYS : null;
      refresh(overlay);
    });
    return overlay;
  }

  function closeModal() {
    const overlay = document.getElementById("unfinished-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  function renderRows(overlay, rows, total, pool, truncated) {
    pool = pool || rows;
    const hintEl = overlay.querySelector("#unfinished-hint");
    const listEl = overlay.querySelector("#unfinished-list");
    const olderEl = overlay.querySelector("#unfinished-older");
    listEl.innerHTML = "";
    olderEl.textContent = (_modalDays === null) ? ("Last " + SCAN_DAYS + " days only") : "Show older";

    const scope = (_modalDays === null) ? "every archived day" : ("the last " + SCAN_DAYS + " days");
    if (!rows.length) {
      hintEl.textContent = "Nothing to catch up on — no unfinished tasks in " + scope + ".";
      return;
    }
    // `rows` is roots-only now, so comparing it to `total` (every OPEN row) made the
    // MAX_ROWS cap message fire for ordinary nesting: one parent with two open
    // subtasks read "Showing 1 of 3". Compare against the open count, same as the
    // morning prompt, so the message means only what it says: rows were truncated.
    const openCount = openRows(pool).length;
    // `truncated` means the SERVER's limit clipped the raw pool before we ever filtered
    // it, so `total` is a floor. Never print a bare exact count in that case: the rows
    // dropped are the OLDEST ones, on the one surface that exists to reach old work.
    const totalStr = truncated ? (total + "+") : String(total);
    hintEl.textContent = rows.length + " unfinished task" + (rows.length === 1 ? "" : "s") +
      (total > openCount || truncated ? " (showing " + openCount + " of " + totalStr + ")" : "") +
      " from " + scope + " — choose what to do with each.";

    // Default custom date: two days out (distinct from Today/Tomorrow).
    const seed = new Date(); seed.setDate(seed.getDate() + 2);
    const seedStr = ymd(seed);

    rows.forEach(ev => {
      const el = document.createElement("div");
      el.className = "carryover-row";
      const d = evDur(ev);
      // The list is roots-only, so say what rides along on each one. Without this a
      // parent with two open subtasks looks like a single task, and its Drop appears
      // to remove one row when it removes three. Same chip the morning prompt shows.
      const kids = descendants(ev, pool).length;
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="carryover-row-title"></div>' +
          '<div class="carryover-row-meta">' + (d > 0 ? esc(fmtDur(d)) : "step") +
            (kids ? " · +" + kids + " nested" : "") +
            (ev.priority ? " · " + esc(ev.priority) : "") +
            ' · from ' + esc(prettyDate(originOf(ev).sourceDate)) +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          '<button class="carryover-btn carryover-btn-schedule unf-today">Today</button>' +
          '<button class="carryover-btn carryover-btn-schedule unf-tomorrow">Tomorrow</button>' +
          '<input type="date" class="resched-date-input unf-date" value="' + seedStr + '" />' +
          '<button class="carryover-btn unf-move">Move</button>' +
          '<button class="carryover-btn unf-backlog">Backlog</button>' +
          '<button class="carryover-btn carryover-btn-drop unf-drop">Drop</button>' +
        '</div>';
      el.querySelector(".carryover-row-title").textContent = ev.title;

      const done = (res) => {
        if (!res) { el.querySelectorAll("button").forEach(b => { b.disabled = false; }); return; }
        const gone = new Set(res.removed || []);
        [...listEl.children].forEach(child => { if (gone.has(child._unfEvId)) child.remove(); });
        el.remove();
        if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
        if (typeof render === "function") render();
        if (!listEl.children.length) closeModal();
      };
      const busy = () => el.querySelectorAll("button").forEach(b => { b.disabled = true; });
      el._unfEvId = ev.id;

      el.querySelector(".unf-today").addEventListener("click", async () => { busy(); done(await moveTo(ev, todayStr(), { pool: pool })); });
      el.querySelector(".unf-tomorrow").addEventListener("click", async () => {
        const tmr = (typeof __tomorrowDate !== "undefined" && __tomorrowDate) ? __tomorrowDate : ymd(new Date(Date.now() + 86400000));
        busy(); done(await moveTo(ev, tmr, { pool: pool }));
      });
      el.querySelector(".unf-move").addEventListener("click", async () => {
        const v = el.querySelector(".unf-date").value;
        if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) { if (typeof showToast === "function") showToast("Pick a valid date", "error"); return; }
        busy(); done(await moveTo(ev, v, { pool: pool }));
      });
      el.querySelector(".unf-backlog").addEventListener("click", async () => { busy(); done(await toBacklog(ev, pool)); });
      el.querySelector(".unf-drop").addEventListener("click", async () => { busy(); done(await drop(ev, pool)); });

      listEl.appendChild(el);
    });
  }

  async function refresh(overlay) {
    const hintEl = overlay.querySelector("#unfinished-hint");
    overlay.querySelector("#unfinished-list").innerHTML = "";
    hintEl.textContent = "Scanning past days…";
    let result = { rows: [], total: 0 };
    try { result = await collectUnfinished({ days: _modalDays }); } catch (e) { result = { rows: [], total: 0 }; }
    // Done children ride along in the pool for progress counting only.
    // Roots only, same rule as the lane and the prompt. Listing a child as its own
    // row gave it its own Today/Tomorrow/Backlog/Drop, so rescheduling the child
    // alone stranded the parent on the origin day and landed the child as an
    // orphan -- reintroducing the standalone-subtask bug this phase removes.
    // The FULL pool still goes to renderRows so subtree actions carry descendants.
    renderRows(overlay, rootsOf(result.rows), result.total, result.rows, result.truncated);
  }

  // ── entry point ──
  async function openUnfinishedTasks() {
    const overlay = ensureModal();
    overlay.classList.add("open");
    await refresh(overlay);
  }

  function wire() {
    const btn = document.getElementById("unfinished-tasks-btn");
    if (btn && !btn._unfWired) {
      btn._unfWired = true;
      btn.addEventListener("click", openUnfinishedTasks);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  window.openUnfinishedTasks = openUnfinishedTasks;
  // Shared with the itinerary's inline "Unscheduled" lane (schedule-tab.js) and
  // the morning catch-up prompt (catch-up.js).
  window.collectUnfinishedTasks = collectUnfinished;
  const DCC = (window.DCC = window.DCC || {});
  DCC.Carryover = {
    SCAN_DAYS: SCAN_DAYS,
    collect: collectUnfinished,
    descendants: descendants,
    openRows: openRows,
    rootsOf: rootsOf,
    recollect: recollect,
    refoldViewedDay: refoldViewedDay,
    complete: complete,
    moveTo: moveTo,
    drop: drop,
    toBacklog: toBacklog,
    prettyDate: prettyDate
  };
})();
