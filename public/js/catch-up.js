// ======== MORNING CATCH-UP ========
// One prompt, on the first load of a new day: here's what slipped, clear it in a
// single pass. Move each row to today or tomorrow, send it to the backlog, or drop
// it — and "Move all to today" for the whole list at once.
//
// Replaces carryover-review.js, which looked like this feature and wasn't:
//   • "For Today" minted a brand-new task id and never touched the origin, so the
//     task existed twice and came back the next morning
//   • "To Backlog" did the same into the backlog
//   • Drop (actDrop) was a single log line — it deleted NOTHING
//   • it read one day (the most recent archive) off /api/state/day's timeline
//   • "reviewed" lived in localStorage, so a second device re-prompted
// Every action here is a real write through DCC.Carryover (unfinished-tasks.js) —
// the same implementation the itinerary's Unfinished lane and the Catch up modal
// use, subtree included. The reviewed flag lives on today's day_root, so the
// prompt is once per DAY, not once per browser.
//
// Rows left un-actioned are left ALONE: they stay on their origin date and remain
// in the bounded Unfinished lane. Nothing is rewritten behind the user's back.
(function () {
  "use strict";

  const FLAG = "_catchUpReviewed";

  function reviewed() {
    if (typeof _bsProp !== "function") return true;   // no day_root yet: don't prompt blind
    return !!_bsProp(FLAG, null);
  }
  function markReviewed() {
    if (typeof _bsSaveProp === "function") _bsSaveProp(FLAG, new Date().toISOString());
  }

  function esc(s) { return (typeof escHtml === "function") ? escHtml(s) : String(s == null ? "" : s); }
  function prettyDate(iso) {
    const CO = window.DCC && window.DCC.Carryover;
    if (CO && typeof CO.prettyDate === "function") return CO.prettyDate(iso);
    return iso;
  }
  // state.js owns these two (_resolvedTodayDate / _resolvedTomorrowDate) with exactly
  // these semantics, and every other "move it to today / tomorrow" affordance in the
  // app resolves through them. state.js loads well before this file, so prefer the
  // canonical pair; the inline fallbacks only exist if load order ever changes. Note
  // the local fallback below is UTC while the canonical helper is local-time, so a
  // copy could disagree by a day in the evening -- another reason to defer.
  function todayStr() {
    if (typeof _resolvedTodayDate === "function") return _resolvedTodayDate();
    if (typeof __todayDate === "string" && __todayDate) return __todayDate;
    return new Date().toISOString().slice(0, 10);
  }
  function tomorrowStr() {
    if (typeof _resolvedTomorrowDate === "function") return _resolvedTomorrowDate();
    if (typeof __tomorrowDate !== "undefined" && __tomorrowDate) return __tomorrowDate;
    const d = new Date(Date.now() + 86400000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Both predicates come from DCC.Carryover, the same place the projection and the
  // actions do. They used to be local copies here, which is how "this prompt has to
  // agree with the lane" became a comment instead of an invariant: the lane spelled
  // the parent edge with state.js's canonical parentIdOf and this file inlined
  // wrapId||subtaskOf. Two spellings of one rule, disagreeing on day one.
  //   openRows -> drop rows already finished on their origin day. The collector keeps
  //     done CHILDREN in the pool so a parent's "2/5 subtasks" can count them, so
  //     every surface that offers WORK has to filter them or it offers a task you
  //     already finished.
  //   rootsOf  -> only roots get a row; a child follows its parent through every
  //     action, so listing both double-counts. Computed over the open rows, so a
  //     child orphaned by a finished parent stays actionable.
  function openOf(pool) { return window.DCC.Carryover.openRows(pool); }
  function rootsOf(pool) { return window.DCC.Carryover.rootsOf(pool); }

  // ── modal (reuses the .carryover-* CSS) ──
  function ensureModal() {
    let overlay = document.getElementById("catchup-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "carryover-overlay";
    overlay.id = "catchup-overlay";
    overlay.innerHTML =
      '<div class="carryover">' +
        '<div class="carryover-hdr">' +
          '<h3 id="catchup-title">Catch up</h3>' +
          '<button class="pvb-close" id="catchup-close">&times;</button>' +
        '</div>' +
        '<div class="carryover-body">' +
          '<div class="carryover-hint" id="catchup-hint"></div>' +
          '<div class="carryover-list" id="catchup-list"></div>' +
        '</div>' +
        '<div class="carryover-footer">' +
          '<button class="carryover-btn carryover-btn-schedule" id="catchup-all">Move all to today</button>' +
          '<button class="carryover-skip" id="catchup-skip">Leave them</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#catchup-close").addEventListener("click", close);
    overlay.querySelector("#catchup-skip").addEventListener("click", close);
    return overlay;
  }

  // Closing IS the answer "leave the rest where they are" — mark the day reviewed
  // so the prompt doesn't nag twice, and let the lane carry the remainder.
  function close() {
    const overlay = document.getElementById("catchup-overlay");
    if (overlay) overlay.classList.remove("open");
    markReviewed();
    if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
    if (typeof render === "function") render();
  }

  function openPrompt(pool, total) {
    const CO = window.DCC.Carryover;
    const overlay = ensureModal();
    const roots = rootsOf(pool);
    const hintEl = overlay.querySelector("#catchup-hint");
    const listEl = overlay.querySelector("#catchup-list");
    const allBtn = overlay.querySelector("#catchup-all");
    overlay.querySelector("#catchup-title").textContent = "Here's what slipped";
    // `total` is the collector's count of OPEN rows before the MAX_ROWS cap, so it
    // has to be compared against the open rows we actually have — not the whole
    // pool, which carries done children too and made this branch unreachable.
    const openCount = openOf(pool).length;
    hintEl.textContent = roots.length + " unfinished task" + (roots.length === 1 ? "" : "s") +
      " from the last two weeks" + (total > openCount ? " (showing " + openCount + " of " + total + ")" : "") +
      " — move what still matters, drop what doesn't. Anything you leave stays on its own day in the Unfinished lane.";
    listEl.innerHTML = "";

    const rowEls = new Map();
    const settle = (res) => {
      if (!res) return false;
      (res.removed || []).forEach(id => { const el = rowEls.get(id); if (el) { el.remove(); rowEls.delete(id); } });
      if (!listEl.children.length) close();
      return true;
    };

    roots.forEach(ev => {
      const el = document.createElement("div");
      const kids = CO.descendants(ev, pool).length;
      const d = (typeof dur === "function") ? Math.max(0, dur(ev)) : 0;
      const durLabel = d > 0 ? ((typeof ms === "function") ? ms(d) : d + "m") : "step";
      el.className = "carryover-row";
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="carryover-row-title"></div>' +
          '<div class="carryover-row-meta">' + esc(durLabel) +
            (kids ? " · +" + kids + " nested" : "") +
            ' · from ' + esc(prettyDate((ev.__unf || {}).sourceDate)) +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          '<button class="carryover-btn carryover-btn-schedule cu-today">Today</button>' +
          '<button class="carryover-btn carryover-btn-schedule cu-tomorrow">Tomorrow</button>' +
          '<button class="carryover-btn cu-backlog">Backlog</button>' +
          '<button class="carryover-btn carryover-btn-drop cu-drop">Drop</button>' +
        '</div>';
      el.querySelector(".carryover-row-title").textContent = ev.title || "Untitled";
      const busy = (on) => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const run = async (fn) => { busy(true); if (!settle(await fn())) busy(false); };
      el.querySelector(".cu-today").addEventListener("click", () => run(() => CO.moveTo(ev, todayStr(), { pool })));
      el.querySelector(".cu-tomorrow").addEventListener("click", () => run(() => CO.moveTo(ev, tomorrowStr(), { pool })));
      el.querySelector(".cu-backlog").addEventListener("click", () => run(() => CO.toBacklog(ev, pool)));
      el.querySelector(".cu-drop").addEventListener("click", () => run(() => CO.drop(ev, pool)));
      rowEls.set(ev.id, el);
      listEl.appendChild(el);
    });

    // Move all: one row at a time on purpose. Each move is a server transaction and
    // the placement engine has to see the previous landing to pick the next slot.
    allBtn.addEventListener("click", async () => {
      allBtn.disabled = true;
      const original = allBtn.textContent;
      const queue = [...rowEls.keys()];
      let moved = 0;
      const target = todayStr();
      for (const id of queue) {
        const ev = pool.find(x => x.id === id);
        if (!ev) continue;
        allBtn.textContent = "Moving " + (moved + 1) + " of " + queue.length + "…";
        // deferRefold: every row here lands on the day being viewed, so the per-row
        // refold fired N times and only the last was observable. One at the end.
        if (settle(await CO.moveTo(ev, target, { pool, deferRefold: true }))) moved++;
      }
      if (moved) await CO.refoldViewedDay(target);
      allBtn.textContent = original;
      allBtn.disabled = false;
      close();
      if (typeof showToast === "function" && moved) showToast("Moved " + moved + " unfinished task" + (moved === 1 ? "" : "s") + " to today", "success");
    }, { once: true });

    overlay.classList.add("open");
  }

  // ── entry point ──
  async function initCatchUp() {
    if (typeof __todayDate === "undefined" || !__todayDate) return;
    if (typeof viewMode !== "undefined" && viewMode && viewMode !== "today") return;
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO || reviewed()) return;
    let res = { rows: [], total: 0 };
    try { res = await CO.collect(); } catch (e) { return; }
    // Gate on OPEN rows, not raw rows: a pool made up entirely of done children is
    // nothing to catch up on, and prompting on it opened an empty-feeling modal.
    if (!rootsOf(res.rows).length) { markReviewed(); return; }
    openPrompt(res.rows, res.total);
  }

  window.initCatchUp = initCatchUp;
})();
