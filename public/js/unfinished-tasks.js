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

  // The fixed-time set (meeting/oneone/ooo/break) is owned by the TASK_TYPES
  // registry now — skipType() defers to TaskTypes.isFixed so this list can't
  // drift from it. The residual literals are raw calendar block types that never
  // became first-class registry types.
  const SKIP_RAW = new Set(["focus", "focus_time", "free_time", "prep"]);
  const SKIP_FIXED_FALLBACK = new Set(["meeting", "oneone", "ooo", "break"]);
  function skipType(type){
    if (window.TaskTypes && typeof window.TaskTypes.isFixed === "function") return window.TaskTypes.isFixed(type) || SKIP_RAW.has(type);
    return SKIP_FIXED_FALLBACK.has(type) || SKIP_RAW.has(type); // registry not loaded yet
  }
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
  async function collectUnfinished(opts) {
    opts = opts || {};
    const days = (opts.days === null) ? null : (opts.days || SCAN_DAYS);
    const bs = window.blockStore;
    const TaskModel = window.DCC && window.DCC.TaskModel;
    if (!bs || typeof bs.loadDateRange !== "function" || !TaskModel) return { rows: [], total: 0, scanned: 0 };

    const today = todayStr();
    const archive = (typeof __archiveDates !== "undefined" && Array.isArray(__archiveDates)) ? __archiveDates : [];
    const todayD = new Date(today + "T00:00:00");

    let scanDates = archive.filter(d => d < today).sort();
    if (days) {
      const floor = ymd(new Date(todayD.getTime() - days * 86400000));
      scanDates = scanDates.filter(d => d >= floor);
    }
    if (!scanDates.length) return { rows: [], total: 0, scanned: 0 };

    const start = scanDates[0];
    const end = ymd(new Date(todayD.getTime() - 86400000)); // yesterday
    await bs.loadDateRange(start, end < start ? start : end);

    const rows = [];
    const seen = new Set();
    for (const date of scanDates) {
      const day = bs.getRangeCache(date);
      if (!day || !Array.isArray(day.blocks)) continue;

      // done ids for this date: day_root._done marks + legacy localStorage marks
      const doneIds = new Set();
      const root = day.blocks.find(b => b.type === "day_root");
      const rp = (root && root.properties) || {};
      const rd = rp._done && rp._done.ids;
      if (Array.isArray(rd)) rd.forEach(id => doneIds.add(id));
      localDoneSet(date).forEach(id => doneIds.add(id));
      // Locks live on the ORIGIN day's day_root (_lockedTasks), not on the block —
      // hydrateLockedTasks only ever stamps today's scheduled[]. Read them here so
      // the padlock renders on a carryover row too.
      const lockedIds = new Set(Array.isArray(rp._lockedTasks) ? rp._lockedTasks : (rp._lockedTasks ? Object.keys(rp._lockedTasks) : []));

      for (const b of day.blocks) {
        if (!(b.type === "block" || b.type === "schedule_item" || b.type === "added_task")) continue;
        const p = b.properties || {};
        // A nested step (subtask / ride-along) legitimately carries no time — it
        // lives under its parent. Keeping them is what lets the lane nest instead
        // of dropping the timeless ones and promoting the timed ones to top level.
        const nested = !!(p.subtaskOf || p.wrapId);
        if (!p.start && !nested) continue;              // not actually scheduled
        if (skipType(p.type)) continue;                 // meetings / breaks / etc.
        // A finished top-level task is simply finished. A finished CHILD still
        // counts toward its parent's progress ("2/5 subtasks"), so it stays in the
        // pool marked done; the lane renders only the open rows.
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
          sourceDate: b.date || date,
          createdAt: b.created_at || null,
          done: isDone
        };
        if (lockedIds.has(ev.id) || lockedIds.has(b.id)) ev._locked = true;
        rows.push(ev);
      }
    }

    // Most recent first.
    rows.sort((a, b) => (a.__unf.sourceDate < b.__unf.sourceDate ? 1 : (a.__unf.sourceDate > b.__unf.sourceDate ? -1 : 0)));
    // `total` is what the lane and the prompt count: OPEN rows. The done children
    // riding along are progress data, not work.
    const total = rows.filter(ev => !ev.__unf.done).length;
    return { rows: rows.slice(0, MAX_ROWS), total, scanned: scanDates.length };
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
  // and cycle-guarded, mirroring flattenSchedule.
  function descendants(ev, pool) {
    const out = [];
    const seen = new Set([ev && ev.id]);
    (function walk(id, depth) {
      if (depth > 20) return;
      (pool || []).forEach(c => {
        const pid = (c.wrapId || c.subtaskOf) || null;
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

  // Complete on the ORIGIN day, subtree included. The old handler completed only
  // the parent, so a carryover parent's children stayed unfinished forever and the
  // lane re-offered them the next day. Sequential await is deliberate:
  // commitDoneOnDate re-reads and patches the same day_root._done overlay each
  // call, so parallel writes would clobber each other.
  async function complete(ev, pool) {
    const u = originOf(ev);
    const kids = descendants(ev, pool);
    const removed = [];
    for (const t of [ev].concat(kids)) {
      const tu = originOf(t);
      const date = tu.sourceDate || u.sourceDate;
      try { if (typeof commitDoneOnDate === "function") await commitDoneOnDate(writeId(t) || t.id, date); } catch (e) {}
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
    const viewing = (typeof viewDate !== "undefined" && viewDate) ? viewDate : todayStr();
    if (targetDate === viewing) {
      try { await window.blockStore.loadDay(viewing); } catch (e) {}
      if (typeof reloadPersistedEdits === "function") reloadPersistedEdits();
      if (typeof recalcTimes === "function") recalcTimes();
    }
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
  async function toBacklog(ev, pool) {
    const u = originOf(ev);
    const block = (window.blockStore && typeof window.blockStore.get === "function") ? window.blockStore.get(u.sourceId) : null;
    const props = Object.assign({}, (block && block.properties) || {}, { kind: "backlog" });
    try {
      await window.blockStore.updateBlock(u.sourceId, props, { date: null });
    } catch (e) {
      if (typeof showToast === "function") showToast("Could not move " + ev.title + " to the backlog", "error");
      return null;
    }
    if (window.blockStore && typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache(u.sourceDate);
    if (typeof log === "function") log("created", u.sourceId, "Unfinished to backlog: " + ev.title);
    if (typeof showToast === "function") showToast("Moved to the backlog: " + ev.title, "success");
    // Children keep their parent edge and follow it as nested backlog rows.
    return { removed: [ev.id].concat(descendants(ev, pool).map(t => t.id)) };
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

  function renderRows(overlay, rows, total, pool) {
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
    hintEl.textContent = (total > rows.length
      ? ("Showing " + rows.length + " of " + total + " unfinished tasks")
      : (total + " unfinished task" + (total === 1 ? "" : "s"))) + " from " + scope + " — choose what to do with each.";

    // Default custom date: two days out (distinct from Today/Tomorrow).
    const seed = new Date(); seed.setDate(seed.getDate() + 2);
    const seedStr = ymd(seed);

    rows.forEach(ev => {
      const el = document.createElement("div");
      el.className = "carryover-row";
      const d = evDur(ev);
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="carryover-row-title"></div>' +
          '<div class="carryover-row-meta">' + (d > 0 ? esc(fmtDur(d)) : "step") +
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
    renderRows(overlay, result.rows.filter(ev => !ev.__unf.done), result.total, result.rows);
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
    complete: complete,
    moveTo: moveTo,
    drop: drop,
    toBacklog: toBacklog,
    prettyDate: prettyDate
  };
})();
