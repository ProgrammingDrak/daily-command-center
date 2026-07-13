// ======== CATCH UP: UNFINISHED PAST TASKS ========
// On demand (the "Catch up" button in the Schedule tab add-bar), scan recent
// past days for tasks that were scheduled but never completed, and let the user
// reschedule each for Today / Tomorrow / a specific date, or Drop it.
//
// Unlike carryover-review.js (which runs automatically once per new day against
// only the single most-recent prior day), this is user-triggered and sweeps a
// rolling window of past days. It reads from the durable blockStore range cache
// (the same source day-review.js uses for past days), not the in-memory
// `scheduled[]` array, which only holds today's plan.
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
  // Lookback is unlimited (every archived day) — an unfinished task stays
  // visible until completed, rescheduled, or dropped. MAX_ROWS only caps how
  // many render at once; `total` still reports the full count.
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
  function fmtDur(min) { return (typeof ms === "function") ? ms(min) : (min + "m"); }
  function esc(s) { return (typeof escHtml === "function") ? escHtml(s) : String(s == null ? "" : s); }

  // Legacy per-day manual-done marks (mirrors carryover-review.js priorDoneSet).
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
  // Returns { rows, total } where rows is capped at MAX_ROWS.
  async function collectUnfinished() {
    const bs = window.blockStore;
    if (!bs || typeof bs.loadDateRange !== "function") return { rows: [], total: 0 };

    const today = todayStr();
    const archive = (typeof __archiveDates !== "undefined" && Array.isArray(__archiveDates)) ? __archiveDates : [];
    const todayD = new Date(today + "T00:00:00");

    // Every archived day strictly before today — no lookback cap.
    const scanDates = archive.filter(d => d < today).sort();
    if (!scanDates.length) return { rows: [], total: 0 };

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
      const rd = root && root.properties && root.properties._done && root.properties._done.ids;
      if (Array.isArray(rd)) rd.forEach(id => doneIds.add(id));
      localDoneSet(date).forEach(id => doneIds.add(id));

      for (const b of day.blocks) {
        if (!(b.type === "block" || b.type === "schedule_item" || b.type === "added_task")) continue;
        const p = b.properties || {};
        if (!p.start) continue;                       // not actually scheduled
        if (skipType(p.type)) continue;                // meetings / breaks / etc.
        if (p.done || doneIds.has(b.id) || (p.local_id && doneIds.has(p.local_id))) continue;
        if (seen.has(b.id) || (p.local_id && seen.has(p.local_id))) continue;
        seen.add(b.id);
        if (p.local_id) seen.add(p.local_id);

        let durMin = parseInt(p.duration, 10);
        if (!(durMin > 0)) {
          durMin = (p.end && typeof pt === "function") ? Math.max(1, pt(p.end) - pt(p.start)) : 30;
        }
        rows.push({
          sourceId: b.id,
          sourceLocalId: p.local_id || null,
          sourceDate: date,
          createdAt: b.created_at || null,
          title: p.title || "Untitled",
          durMin: durMin || 30,
          priority: p.priority || "",
          type: p.type || "task",
          start: p.start,
          end: p.end || "",
          source: p.source || "manual",
          detail: p.detail || "",
          tags: Array.isArray(p.tags) ? p.tags : [],
          notionUrl: p.notionUrl || ""
        });
      }
    }

    // Most recent first.
    rows.sort((a, b) => (a.sourceDate < b.sourceDate ? 1 : (a.sourceDate > b.sourceDate ? -1 : 0)));
    const total = rows.length;
    return { rows: rows.slice(0, MAX_ROWS), total };
  }

  // ── actions (operate on the raw past block, then retire the source) ──
  async function retireSource(row) {
    const bs = window.blockStore;
    if (!bs) return;
    try { await bs.deleteBlock(row.sourceId); } catch (e) {}
    if (typeof bs.invalidateRangeCache === "function") bs.invalidateRangeCache(row.sourceDate);
    // Keep the inline Unfinished section (schedule-tab.js) in step with the modal.
    if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
    // Retiring/rescheduling a past block changes prior-day state the streak chip
    // reads from the same range cache; drop it so the count isn't stale.
    if (typeof window.invalidateHabitStreaks === "function") window.invalidateHabitStreaks();
  }

  function cloneForDate(row) {
    const id = (typeof qaId === "function") ? qaId() : ("unf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
    const start = row.start;
    const end = row.end || ((typeof fmt === "function" && typeof pt === "function") ? fmt(pt(start) + row.durMin) : start);
    return Object.assign(
      window.DCC.taskCommonProps(row, {
        priority: row.priority || "High",
        meta: "Caught up · " + fmtDur(row.durMin),
        source: row.source || "manual"
      }),
      { id, type: row.type || "task", start, end, rescheduledFrom: row.sourceDate }
    );
  }

  async function actToday(row) {
    if (typeof insertTaskNow === "function") {
      insertTaskNow(row.title, row.durMin, {
        priority: row.priority || "High", detail: row.detail,
        source: row.source, tags: row.tags, notionUrl: row.notionUrl
      });
    }
    await retireSource(row);
    if (typeof log === "function") log("rescheduled", row.sourceId, "Caught up to today: " + row.title);
    if (typeof showToast === "function") showToast("Scheduled for today: " + row.title, "success");
  }

  async function actDate(row, targetDate) {
    // Today is handled by the live-schedule path so it appears immediately.
    if (targetDate === todayStr()) return actToday(row);
    if (typeof persistAddedTask === "function") {
      try { await persistAddedTask(cloneForDate(row), targetDate); }
      catch (e) {
        if (typeof showToast === "function") showToast("Could not move " + row.title, "error");
        return;
      }
    }
    await retireSource(row);
    if (typeof log === "function") log("rescheduled", row.sourceId, "Caught up to " + targetDate + ": " + row.title);
    if (typeof showToast === "function") showToast("Moved to " + prettyDate(targetDate) + ": " + row.title, "success");
  }

  async function actDrop(row) {
    await retireSource(row);
    if (typeof log === "function") log("dropped", row.sourceId, "Dropped unfinished: " + row.title);
    if (typeof showToast === "function") showToast("Dropped: " + row.title, "info");
  }

  // ── modal (mirrors carryover-review.js, reuses its CSS classes) ──
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
          '<button class="carryover-skip" id="unfinished-close-2">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    overlay.querySelector("#unfinished-close").addEventListener("click", closeModal);
    overlay.querySelector("#unfinished-close-2").addEventListener("click", closeModal);
    return overlay;
  }

  function closeModal() {
    const overlay = document.getElementById("unfinished-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  function renderRows(overlay, rows, total) {
    const hintEl = overlay.querySelector("#unfinished-hint");
    const listEl = overlay.querySelector("#unfinished-list");
    listEl.innerHTML = "";

    if (!rows.length) {
      hintEl.textContent = "Nothing to catch up on — no unfinished past tasks.";
      return;
    }
    hintEl.textContent = total > rows.length
      ? ("Showing " + rows.length + " of " + total + " unfinished tasks — choose what to do with each.")
      : (total + " unfinished task" + (total === 1 ? "" : "s") + " — choose what to do with each.");

    // Default custom date: two days out (distinct from Today/Tomorrow).
    const seed = new Date(); seed.setDate(seed.getDate() + 2);
    const seedStr = ymd(seed);

    rows.forEach(row => {
      const el = document.createElement("div");
      el.className = "carryover-row";
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="carryover-row-title"></div>' +
          '<div class="carryover-row-meta">' + esc(fmtDur(row.durMin)) +
            (row.priority ? " · " + esc(row.priority) : "") +
            ' · from ' + esc(prettyDate(row.sourceDate)) +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          '<button class="carryover-btn carryover-btn-schedule unf-today">Today</button>' +
          '<button class="carryover-btn carryover-btn-schedule unf-tomorrow">Tomorrow</button>' +
          '<input type="date" class="resched-date-input unf-date" value="' + seedStr + '" />' +
          '<button class="carryover-btn unf-move">Move</button>' +
          '<button class="carryover-btn carryover-btn-drop unf-drop">Drop</button>' +
        '</div>';
      el.querySelector(".carryover-row-title").textContent = row.title;

      const removeRow = () => { el.remove(); if (!listEl.children.length) closeModal(); };
      const busy = () => el.querySelectorAll("button").forEach(b => { b.disabled = true; });

      el.querySelector(".unf-today").addEventListener("click", async () => { busy(); await actToday(row); removeRow(); });
      el.querySelector(".unf-tomorrow").addEventListener("click", async () => {
        const tmr = (typeof __tomorrowDate !== "undefined" && __tomorrowDate) ? __tomorrowDate : ymd(new Date(Date.now() + 86400000));
        busy(); await actDate(row, tmr); removeRow();
      });
      el.querySelector(".unf-move").addEventListener("click", async () => {
        const v = el.querySelector(".unf-date").value;
        if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) { if (typeof showToast === "function") showToast("Pick a valid date", "error"); return; }
        busy(); await actDate(row, v); removeRow();
      });
      el.querySelector(".unf-drop").addEventListener("click", async () => { busy(); await actDrop(row); removeRow(); });

      listEl.appendChild(el);
    });
  }

  // ── entry point ──
  async function openUnfinishedTasks() {
    const overlay = ensureModal();
    const hintEl = overlay.querySelector("#unfinished-hint");
    overlay.querySelector("#unfinished-list").innerHTML = "";
    hintEl.textContent = "Scanning past days…";
    overlay.classList.add("open");
    let result = { rows: [], total: 0 };
    try { result = await collectUnfinished(); } catch (e) { result = { rows: [], total: 0 }; }
    renderRows(overlay, result.rows, result.total);
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
  // Shared with the itinerary's inline "Unfinished" section (schedule-tab.js).
  window.collectUnfinishedTasks = collectUnfinished;
})();
