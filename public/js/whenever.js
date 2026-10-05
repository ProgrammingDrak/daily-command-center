// whenever.js — the header pill for work with no time on it, in two kinds:
//
//   Unscheduled  has to happen, just is not on the schedule yet. This is the
//                itinerary's old "Unplanned" group, moved here. The rows, their
//                derivation and their controls all still belong to the itinerary
//                (schedule-tab.js renderUnscheduledInto); this file only hosts them.
//   Whenever     no set time at all. Laundry, grabbing the mail, anything you knock
//                out whenever a free minute shows up. Everything below is about this
//                half unless it says otherwise.
//
// NOT Anytime (anytime-store.js). Anytime is a target COUNT inside a repeating
// window ("water, 3 times today"). A Whenever task is one-off work with no window
// at all. It sits in a pool until you pull it into your day.
//
// THE MODEL IS AN EXISTING FIELD. A Whenever task is an ordinary dateless Task
// Library row (kind:"backlog") whose `stage` is "Whenever". `stage` is the field that
// already routes a backlog row to the Priority drawer (buildConsider), so this adds a
// value, not a column: no migration, no new row kind, and every backlog path (edit,
// delete, the Task Library, the schedule round trip) keeps working on these rows.
//
// This file owns NO mover. Every action routes through the canonical one:
//   add        addWheneverTask (schedule.js) -> persistBacklogItem
//   Do it now  addToSchedule re-dates the row IN PLACE onto today, then
//              rescheduleTaskToDate's same-day arm puts it at the next free slot
//              after whatever you are doing now (the "Move to Today" placement)
//   Done       Do it now, then toggleDone, so points, streaks and the completion
//              row all flow through the normal check-off
//   Not this   persistRowProp(stage:"Backlog") (state.js), back to the Library
//   in         moveTaskToWhenever (state.js), from Change task... on any row
//
// Browser: loaded right after task-model.js (schedule.js reads LABEL at load for the
// add-bar destination). Node: require()d by whenever.test.js for the pure half.
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./task-model.js")
    : root && root.DCC && root.DCC.TaskModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.Whenever = api;
  }
})(typeof self !== "undefined" ? self : this, function (TaskModel) {
  "use strict";

  // The stored value. Rows carry it, so it never changes with the label below. It is
  // defined in task-model.js, beside the fold rule that keeps these rows off the day.
  const STAGE = (TaskModel && TaskModel.WHENEVER_STAGE) || "Whenever";

  // ── the design knobs ── display only, safe to swap without touching data.
  // LABEL names the Whenever half everywhere: pill segment, drawer half, add-bar
  // type and the Change task item.
  //   "Whenever" | "Free Time" | "Background" | "Odd Jobs" | "Side Quests"
  // "Whenever" won: it is the word you use for these ("whenever I have a minute"),
  // and it cannot be confused with the Anytime dock's "anytime".
  const LABEL = "Whenever";
  // UNSCHEDULED_LABEL names the other half the same way.
  //   "Unscheduled" | "Needs a time" | "To schedule" | "Unplanned"
  const UNSCHEDULED_LABEL = "Unscheduled";
  // Color themes, one per half. Each half (its pill segment and its drawer half)
  // wears `whenever-theme--<style>`; dashboard.css defines one var set per value.
  //   "sage" | "teal" | "amber" | "violet"
  // Sage for Whenever: calm, and green reads "free". Amber for Unscheduled: it is
  // the half that wants action. Both stay clear of Loose Ends blue and Waiting plum.
  const PILL_STYLE = "sage";
  const UNSCHEDULED_STYLE = "amber";

  // ── pure half (node-testable) ──

  function isWhenever(item) { return !!item && item.stage === STAGE; }

  function durationOf(item) {
    const n = Number(item && (item.durMin || item.duration));
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  function createdMs(item) {
    const t = new Date((item && (item.createdAt || item.addedAt || item.added_at)) || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // The pool, in pick order. Quick wins first, because a free minute is usually a
  // small one. Equal lengths go oldest first, so nothing sinks to the bottom forever.
  function selectWhenever(items) {
    return (Array.isArray(items) ? items : [])
      .filter(isWhenever)
      .slice()
      .sort((a, b) => durationOf(a) - durationOf(b) ||
        createdMs(a) - createdMs(b) ||
        String(a.title || "").localeCompare(String(b.title || "")));
  }

  // "Surprise me" never picks the same row twice in a row when there is a choice.
  function pickIndex(count, lastIndex, rand) {
    if (!(count > 0)) return -1;
    if (count === 1) return 0;
    const r = typeof rand === "function" ? rand() : Math.random();
    let i = Math.floor(r * count) % count;
    if (i === lastIndex) i = (i + 1) % count;
    return i;
  }

  // ── browser half ──

  const busy = new Set();
  let lastPicked = -1;

  function esc(value) {
    const DCC = typeof window !== "undefined" && window.DCC;
    if (DCC && typeof DCC.esc === "function") return DCC.esc(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function toast(message, type, duration, action) {
    if (typeof showToast === "function") showToast(message, type || "success", duration, action);
  }
  function fmtDur(mins) { return typeof ms === "function" ? ms(mins) : mins + "m"; }
  function pool() { return typeof backlog !== "undefined" && Array.isArray(backlog) ? backlog : []; }
  function findItem(id) { return pool().find(t => t.id === id && isWhenever(t)) || null; }

  // The row behind a pool item. A row added this session has no _blockId until the
  // next hydrate, and without one addToSchedule CREATES a dated copy while the
  // dateless original stays in the pool, so it would come back on reload. The
  // optimistic cache already holds the row (createBlock mints the id up front), so
  // resolve it by local_id the way task-bank.js getBacklogBlock does.
  function rowFor(item) {
    if (!item || !window.blockStore) return null;
    const rows = window.blockStore.getByType("block");
    let row = item._blockId ? rows.find(b => b && b.id === item._blockId && !b.deleted_at) : null;
    if (!row) row = rows.find(b => {
      const p = b && b.properties;
      return p && !b.deleted_at && !b.date && p.kind === "backlog" && (p.local_id === item.id || b.id === item.id);
    });
    if (row) item._blockId = row.id;
    return row || null;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function syncCounts(unscheduled, whenever) {
    setText("unscheduled-pill-nav-count", unscheduled);
    setText("unscheduled-count", unscheduled);
    setText("whenever-pill-nav-count", whenever);
    setText("whenever-count", whenever);
    const total = document.getElementById("untimed-count");
    if (total) { total.textContent = String(unscheduled + whenever); total.style.display = unscheduled + whenever ? "" : "none"; }
    const u = document.getElementById("unscheduled-pill-nav");
    if (u) u.setAttribute("aria-label", "Open " + UNSCHEDULED_LABEL + " tasks, " + unscheduled + " need a time");
    const w = document.getElementById("whenever-pill-nav");
    if (w) w.setAttribute("aria-label", "Open " + LABEL + " tasks, " + whenever + " open");
    const pick = document.getElementById("whenever-pick");
    if (pick) pick.disabled = whenever < 1;
  }

  // Rebuilding a list under the cursor would drop keyboard focus mid-tab. Remember
  // the focused control by its row id and first class, and land back on its twin.
  function keepFocus(list, rebuild) {
    const active = document.activeElement;
    const inside = active && list.contains(active);
    const rowEl = inside ? active.closest("[data-id],[data-whenever-id]") : null;
    const rowId = rowEl ? (rowEl.dataset.id || rowEl.dataset.wheneverId) : null;
    const cls = inside && active.classList.length ? active.classList[0] : null;
    rebuild();
    if (!rowId || !cls) return;
    const sel = '[data-id="' + CSS.escape(rowId) + '"] .' + CSS.escape(cls) + ', [data-whenever-id="' + CSS.escape(rowId) + '"].' + CSS.escape(cls);
    const again = list.querySelector(sel);
    if (again) again.focus({ preventScroll: true });
  }

  // The Unscheduled half: the itinerary renders its own rows into our list.
  function buildUnscheduled() {
    const list = document.getElementById("unscheduled-list");
    if (!list || typeof window.renderUnscheduledInto !== "function") return 0;
    let counts = { open: 0, total: 0 };
    keepFocus(list, () => { counts = window.renderUnscheduledInto(list) || counts; });
    if (!counts.total) list.innerHTML = '<div class="delegated-empty">Nothing waiting for a time slot.</div>';
    const mode = typeof _sectionSort === "function" ? _sectionSort("unscheduled") : "manual";
    document.querySelectorAll("[data-unscheduled-sort]").forEach(b => {
      const on = b.dataset.unscheduledSort === (mode === "alpha" || mode === "created" ? mode : "manual");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    return counts.open;
  }

  const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

  function rowHtml(t) {
    const title = esc(t.title || "Untitled task");
    const id = esc(t.id);
    const pending = busy.has(t.id);
    return '<div class="whenever-row' + (pending ? " is-busy" : "") + '" data-whenever-id="' + id + '">' +
      '<button type="button" class="whenever-check" data-whenever-action="done" data-whenever-id="' + id + '"' +
        ' aria-label="Mark ' + title + ' done" title="Done, log it on today"' + (pending ? " disabled" : "") + '>' + CHECK_SVG + '</button>' +
      '<div class="whenever-main">' +
        '<span class="whenever-title">' + title + '</span>' +
        '<span class="whenever-dur">' + esc(fmtDur(durationOf(t))) + '</span>' +
      '</div>' +
      '<button type="button" class="whenever-now" data-whenever-action="now" data-whenever-id="' + id + '"' +
        ' title="Put it on today at your next free slot"' + (pending ? " disabled" : "") + '>Do it now</button>' +
      '<button type="button" class="whenever-release" data-whenever-action="release" data-whenever-id="' + id + '"' +
        ' aria-label="Move ' + title + ' back to the Task Library" title="Not a ' + esc(LABEL) + ' task">&times;</button>' +
    '</div>';
  }

  function build() {
    if (typeof document === "undefined") return;
    const unscheduled = buildUnscheduled();
    const items = selectWhenever(pool());
    syncCounts(unscheduled, items.length);
    const list = document.getElementById("whenever-list");
    if (!list) return;
    keepFocus(list, () => {
      list.innerHTML = items.length
        ? items.map(rowHtml).join("")
        : '<div class="delegated-empty whenever-empty">Nothing here. Add the chores with no set time, like laundry or the mail.</div>';
    });
  }

  function refresh() {
    build();
    if (typeof render === "function") render();
  }

  function add(title, durMin) {
    title = String(title || "").trim();
    if (!title) return null;
    if (typeof addWheneverTask !== "function") {
      toast("The Task Library is still loading. Try again in a moment.", "info");
      return null;
    }
    const item = addWheneverTask(title, durMin);
    build();
    return item;
  }

  // Pull a Whenever task onto TODAY at the next free slot. Returns today's ev, or null.
  async function doNow(id, opts) {
    opts = opts || {};
    if (busy.has(id)) return null;
    busy.add(id);
    build();
    try {
      const today = typeof _resolvedTodayDate === "function" ? _resolvedTodayDate() : null;
      if (!today || typeof addToSchedule !== "function" || typeof rescheduleTaskToDate !== "function") {
        toast("Scheduling is still loading. Try again in a moment.", "info");
        return null;
      }
      // addToSchedule writes to the VIEWED day, and "now" only means something on today.
      if (typeof viewDate !== "undefined" && viewDate !== today && typeof switchToDate === "function") {
        await switchToDate(today);
      }
      const item = findItem(id);
      if (!item) { toast("That task already left " + LABEL, "info"); return null; }
      rowFor(item);
      // AWAIT the date write before placing. The placement pins the start through
      // savePinnedStarts, which only writes rows already on the viewed day; run it
      // first and the pin is refused, the end-of-day slot persists, and the task
      // jumps back there on reload. Same-row writes queue in order after this.
      await Promise.resolve(addToSchedule(item.id));
      await rescheduleTaskToDate(item.id, today, { silent: true });
      const ev = typeof scheduled !== "undefined" ? scheduled.find(e => e.id === item.id) : null;
      if (!ev) return null;
      if (!opts.silent) {
        const at = typeof f12 === "function" && ev.start ? " at " + f12(ev.start) : "";
        toast("Up next: " + (ev.title || item.title) + at, "success");
      }
      return ev;
    } finally {
      busy.delete(id);
      refresh();
    }
  }

  // Did it already. Land it on today first so the check-off is the normal one:
  // points, streaks and the completion row, with no Whenever-only completion path.
  // No toast of its own: toggleDone already says "+N points", and a second one stacked
  // on top of it in the same corner.
  async function markDone(id) {
    const ev = await doNow(id, { silent: true });
    if (!ev || typeof toggleDone !== "function") return false;
    toggleDone(ev.id);
    refresh();
    return true;
  }

  // Through state.js persistRowProp, the canonical one-field writer: it queues a
  // read-modify-write on the row, so a stage flip cannot clobber an edit in flight.
  // (task-bank.js has a backlog updater too, but index.html does not load it.)
  function setStage(id, stage) {
    const item = pool().find(t => t.id === id);
    const row = rowFor(item);
    if (!item || !row || typeof persistRowProp !== "function") {
      toast("Could not update that task. Try again in a moment.", "error");
      return false;
    }
    item.stage = stage;
    // Refold once the write lands. Leaving the pool puts the row in the Unscheduled
    // half and returning takes it out (TaskModel.isWheneverPoolRow); the
    // fold reads the block cache, so refolding before the queued write would not see it.
    Promise.resolve(persistRowProp(item.id, "stage", stage, null, { row })).then(() => {
      if (typeof refoldTaskStateFromBlockCache === "function") refoldTaskStateFromBlockCache();
      refresh();
    }).catch(() => {});
    return true;
  }

  function release(id) {
    const item = findItem(id);
    if (!item || !setStage(id, "Backlog")) return;
    build();
    toast("Moved to the Task Library", "success", 5000, {
      label: "Undo",
      onClick: () => { if (setStage(id, STAGE)) build(); }
    });
  }

  function surprise() {
    const list = document.getElementById("whenever-list");
    const rows = list ? Array.from(list.querySelectorAll(".whenever-row")) : [];
    const i = pickIndex(rows.length, lastPicked);
    if (i < 0) return;
    lastPicked = i;
    rows.forEach(r => r.classList.remove("is-picked"));
    const row = rows[i];
    row.classList.add("is-picked");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const now = row.querySelector(".whenever-now");
    if (now) now.focus({ preventScroll: true });
  }

  // Both segments open the same drawer section; each lands on its own half.
  function open(half) {
    half = half === "unscheduled" ? "unscheduled" : "whenever";
    if (typeof window.openTasksToSection === "function") {
      window.openTasksToSection("tm-whenever-section", { solo: true });
    }
    build();
    // After openTasksToSection's own scroll-to-section (240ms), so ours wins.
    setTimeout(() => {
      const sub = document.getElementById(half + "-sub");
      if (sub) sub.scrollIntoView({ block: "start", behavior: "smooth" });
      const input = document.getElementById("whenever-add-title");
      // Phones get the list first; a focused input would pop the keyboard over it.
      if (half === "whenever" && input && !(window.matchMedia && window.matchMedia("(max-width:760px)").matches)) {
        input.focus({ preventScroll: true });
      }
    }, 280);
  }

  function setTheme(el, style) {
    if (!el) return;
    Array.from(el.classList).filter(c => c.indexOf("whenever-theme--") === 0).forEach(c => el.classList.remove(c));
    el.classList.add("whenever-theme--" + style);
  }

  function applyDesign() {
    document.querySelectorAll("[data-whenever-label]").forEach(el => { el.textContent = LABEL; });
    document.querySelectorAll("[data-unscheduled-label]").forEach(el => { el.textContent = UNSCHEDULED_LABEL; });
    const both = UNSCHEDULED_LABEL + " \u00b7 " + LABEL;
    document.querySelectorAll("[data-untimed-label]").forEach(el => { el.textContent = both; });
    // Each half's pill segment and drawer half wear one theme, so they swap together.
    setTheme(document.getElementById("whenever-pill-nav"), PILL_STYLE);
    setTheme(document.getElementById("whenever-sub"), PILL_STYLE);
    setTheme(document.getElementById("unscheduled-pill-nav"), UNSCHEDULED_STYLE);
    setTheme(document.getElementById("unscheduled-sub"), UNSCHEDULED_STYLE);
    const section = document.getElementById("tm-whenever-section");
    if (section) section.dataset.sidecarLabel = both;
    // Label-bearing aria text and tooltips follow the knobs too, so a swap never
    // leaves the old word behind for screen readers or on hover.
    const attr = (sel, name, value) => document.querySelectorAll(sel).forEach(el => el.setAttribute(name, value));
    attr("#unscheduled-sub .untimed-tip", "aria-label", "What goes in " + UNSCHEDULED_LABEL + "?");
    attr("#whenever-sub .untimed-tip", "aria-label", "What goes in " + LABEL + "?");
    attr("#unscheduled-sort", "aria-label", "Sort " + UNSCHEDULED_LABEL);
    attr("#unscheduled-pill-nav", "title", UNSCHEDULED_LABEL + ": has to happen, but is not on your schedule yet. Drop a task here to take its time off.");
    attr("#whenever-pill-nav", "title", LABEL + ": no set time. Knock one out when you have a free minute.");
  }

  // The "i" tooltips. Hover and keyboard focus show them through CSS; a tap toggles
  // aria-expanded, because a phone has neither.
  function closeTips(except) {
    document.querySelectorAll(".untimed-tip[aria-expanded='true']").forEach(b => {
      if (b !== except) b.setAttribute("aria-expanded", "false");
    });
  }
  function wireTips() {
    document.querySelectorAll(".untimed-tip").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const next = btn.getAttribute("aria-expanded") !== "true";
      closeTips(btn);
      btn.setAttribute("aria-expanded", next ? "true" : "false");
    }));
    document.addEventListener("click", e => { if (!e.target.closest(".untimed-tip-wrap")) closeTips(null); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeTips(null); });
  }

  // The Unscheduled segment is the drop target the itinerary's Unplanned zone used to
  // be: drop a timed task on it and moveTaskToUnplanned takes its time off. The zone's
  // own handlers (drag.js) do the work, reading data-placement="unplanned" off the pill.
  function wireDrop(seg) {
    if (!seg || typeof dBlockOver !== "function" || typeof dBlockDrop !== "function") return;
    seg.addEventListener("dragover", dBlockOver);
    seg.addEventListener("dragleave", () => seg.classList.remove("drag-over-block"));
    seg.addEventListener("drop", e => { seg.classList.remove("drag-over-block"); return dBlockDrop(e); });
  }

  function init() {
    applyDesign();
    const wheneverSeg = document.getElementById("whenever-pill-nav");
    if (wheneverSeg) wheneverSeg.addEventListener("click", () => open("whenever"));
    const unscheduledSeg = document.getElementById("unscheduled-pill-nav");
    if (unscheduledSeg) unscheduledSeg.addEventListener("click", () => open("unscheduled"));
    wireDrop(unscheduledSeg);
    wireTips();

    // Same three orders the old Unplanned header offered, same persisted setting.
    document.querySelectorAll("[data-unscheduled-sort]").forEach(btn => btn.addEventListener("click", () => {
      if (typeof _setSectionSort === "function") _setSectionSort("unscheduled", btn.dataset.unscheduledSort);
      build();
    }));

    const form = document.getElementById("whenever-add");
    if (form) form.addEventListener("submit", e => {
      e.preventDefault();
      const input = document.getElementById("whenever-add-title");
      const dur = document.getElementById("whenever-add-dur");
      const created = add(input && input.value, dur ? parseInt(dur.value, 10) || 15 : 15);
      if (created && input) { input.value = ""; input.focus(); }
      else if (input && !input.value.trim()) input.focus();
    });

    const pick = document.getElementById("whenever-pick");
    if (pick) pick.addEventListener("click", surprise);

    const list = document.getElementById("whenever-list");
    if (list) list.addEventListener("click", e => {
      const btn = e.target.closest("[data-whenever-action]");
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      const id = btn.dataset.wheneverId;
      const action = btn.dataset.wheneverAction;
      if (action === "now") doNow(id);
      else if (action === "done") markDone(id);
      else if (action === "release") release(id);
    });

    build();
  }

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    // features.js SURFACES calls this every render: it owns the always-visible pill
    // counts, and the Unscheduled half re-renders the itinerary's rows with it.
    window.buildWhenever = build;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  return {
    STAGE, LABEL, PILL_STYLE, UNSCHEDULED_LABEL, UNSCHEDULED_STYLE,
    isWhenever, durationOf, selectWhenever, pickIndex,
    build, add, doNow, markDone, release, open
  };
});
