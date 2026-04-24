// ======== SAVE STATUS + TOAST ========
function updateSaveStatus(state, text) {
  const el = document.getElementById("save-status");
  if (!el) return;
  el.className = "save-status save-status--" + state;
  el.title = text || "";
  const tooltip = document.getElementById("save-status-tooltip");
  if (tooltip) tooltip.textContent = text || "";
}

function showToast(message, type = "error", duration = 5000) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast toast--" + type;
  toast.innerHTML = `<span>${message}</span><button class="toast-close" onclick="this.parentElement.remove()">&times;</button>`;
  container.appendChild(toast);
  if (duration > 0) setTimeout(() => toast.remove(), duration);
}

// ── BlockStore day-root property helpers ──
// Read a property from the current day's root block (returns def if unavailable)
function _bsProp(key, def) {
  if (!window.USE_BLOCKSTORE || !window.blockStore) return def;
  const root = window.blockStore.get(window.blockStore.getDayRootId());
  const v = root && root.properties[key];
  return (v !== undefined && v !== null) ? v : def;
}
// Write a property to the current day's root block; returns false if blockStore unavailable
function _bsSaveProp(key, value) {
  if (!window.USE_BLOCKSTORE || !window.blockStore) return false;
  const id = window.blockStore.getDayRootId();
  const root = window.blockStore.get(id);
  if (!root) return false;
  window.blockStore.updateBlock(id, { ...root.properties, [key]: value });
  return true;
}

// ======== DATE NAVIGATION ========
// viewMode: "today" (editable, live) | "tomorrow" (editable, pre-plan) | "archive" (read-only)
let viewMode = "today";
let viewDate = __state ? __state.date : null;

// Compute the "today" date string from injected state
let __todayDate = (window.__PA_STATE__ && window.__PA_STATE__.date) || null;
let __tomorrowDate = (window.__PA_TOMORROW__ && window.__PA_TOMORROW__.date) || null;

// Available archive dates (for date picker dots)
let __archiveDates = window.__PA_ARCHIVES__ ? Object.keys(window.__PA_ARCHIVES__).sort() : [];

function initKeys() {
  const d = (__state && __state.date) ? __state.date : "unknown";
  DEFERRED_KEY = "pa-deferred-" + d;
  PUSHED_KEY = "pa-pushed-" + d;
  DUR_KEY = "pa-dur-" + d;
  DELETED_KEY = "pa-deleted-" + d;
  NOTES_KEY = "pa-notes-" + d;
  ACTIONS_KEY = "pa-actions-" + d;
  DISMISS_KEY = "pa-dismissed-" + d;
  DONE_KEY = "pa-done-" + d;
  SESSIONS_KEY = "pa-sessions-" + d;
  POMO_STATE_KEY = "pa-pomo-state-" + d;
  REVIEWED_KEY = "pa-reviewed-" + d;
  ADDED_KEY = "pa-added-tasks-" + d;
  PINNED_KEY = "pa-pinned-starts-" + d;
  ORDER_KEY = "pa-task-order-" + d;
  SUBTASK_KEY = "pa-subtasks-" + d;
  TRIV_FLAGS_KEY = "pa-trivial-flags-" + d;
  ENGRAM_KEY = "pa-engrams-" + d;
  MOOD_KEY = "pa-mood-" + d;
  TRIAGE_PARENTS_KEY = "pa-triage-parents-" + d;
  // PIN 1: rebind the pinned-active-task key and reload state on date change
  PINNED_ACTIVE_KEY = "pa-pinned-active-" + d;
  try { _pinnedActiveId = JSON.parse(localStorage.getItem(PINNED_ACTIVE_KEY) || "null"); } catch(e) { _pinnedActiveId = null; }
  // Recalculate EOD from loaded state (prefer last work block end)
  if(__state && __state.schedule && __state.schedule.blocks){
    const wb=__state.schedule.blocks.filter(b=>(b.blockType||b.type)==='work');
    if(wb.length){ EOD = pt(wb[wb.length-1].end); }
  } else if (__state && __state.schedule && __state.schedule.end_time) {
    EOD = pt(__state.schedule.end_time);
  }
}

// ======== (Phase 6 cleanup) RETIRED PERSISTENCE TIERS ========
// This region used to host the legacy 3-tier persistence stack:
//   1. PaDB (IndexedDB mirror, ~106 lines)
//   2. scheduleIDBSave / scheduleExpressSave / flushToExpress / startHeartbeat
//   3. collectAllState / collectGlobalState (state -> JSON serializers)
//   4. writeToLocalStorage / writeGlobalsToLocalStorage (state importers)
//   5. hydrateFromStorage / hydrateGlobals (boot-time tier-fallback waterfall)
//
// Every path was guarded behind window.USE_BLOCKSTORE.* flags that have been
// unconditionally true in production for months. With BlockStore writing
// straight to Postgres on every mutation (and the durable WAL added in
// commit 082d839 covering offline durability), the IDB mirror, the Express
// /api/save-day fan-out, and the localStorage importers were all dead. Their
// only remaining callers were each other, the boot-time hydration gate at
// boot.js:157 (also retired), and the Second Brain backup feature in
// engrams.js (also retired -- it was silently broken).
//
// fetchExpressDate() survives because switchToDate() still uses it to fetch
// archive-day snapshots from /api/state/day. Its dead /api/brain/recent
// fallback has been removed.

// Stub kept for any straggler callers; treats every call as a no-op.
function scheduleIDBSave() {}

async function fetchExpressDate(date) {
  try {
    const dayRes = await fetch("/api/state/day?date=" + encodeURIComponent(date), { signal: AbortSignal.timeout(4000) });
    if (dayRes.ok) {
      const dayData = await dayRes.json();
      if (dayData && dayData.date) return dayData;
    }
  } catch {}
  return null;
}

function reloadPersistedEdits() {
  // Reset mutable UI state
  manualDone = new Set();
  doneAt = {};
  actionLog = [];
  durChanges = {};
  pushedSet = new Set();
  pushedAt = {};
  deletedSet = new Set();

  // Reload from blockStore day_root (primary) or localStorage (fallback)
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const dayRoot = window.blockStore.get(window.blockStore.getDayRootId());
    if (dayRoot && dayRoot.properties) {
      const done = dayRoot.properties._done || {};
      if (done.ids) done.ids.forEach(id => manualDone.add(id));
      if (done.at) Object.assign(doneAt, done.at);
      const pushed = dayRoot.properties._pushed || {};
      if (pushed.ids) pushed.ids.forEach(id => pushedSet.add(id));
      if (pushed.at) Object.assign(pushedAt, pushed.at);
      const deleted = dayRoot.properties._deleted || [];
      deleted.forEach(id => deletedSet.add(id));
      Object.assign(durChanges, dayRoot.properties._durChanges || {});
    }
    // (Phase 6 cleanup) Removed one-shot localStorage->blockStore migration shim.
    // Every active workspace has _done populated on day_root for months; the shim
    // had no remaining work to do and added 40 lines of conditional reads.
  } else {
    // Fallback: localStorage
    try { const d = JSON.parse(localStorage.getItem(DONE_KEY) || "{}");
      if (d.ids) d.ids.forEach(id => manualDone.add(id));
      if (d.at) Object.assign(doneAt, d.at);
    } catch(e) {}
    try { const d = JSON.parse(localStorage.getItem(PUSHED_KEY) || "{}");
      if (d.ids) d.ids.forEach(id => pushedSet.add(id));
      if (d.at) Object.assign(pushedAt, d.at);
    } catch(e) {}
    try { const d = JSON.parse(localStorage.getItem(DELETED_KEY) || "[]");
      d.forEach(id => deletedSet.add(id));
    } catch(e) {}
  }
  // Restore user-added tasks (quick-add, drawer-add)
  try {
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      // Load from SQLite via blockstore cache (loadDay() already ran before this point).
      // Filter by date: loadGlobals() pulls every type="block" row regardless of date,
      // so without this check manual tasks from other days bleed onto today's schedule.
      const currentDate=window.blockStore.getCurrentDate();
      const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).local_id&&(b.properties||{}).start&&(!b.date||b.date===currentDate))];
      addedBlocks.forEach(block=>{
        const p=block.properties||{};
        const taskId=p.local_id;
        if(!taskId||scheduled.find(e=>e.id===taskId))return;
        const d=p.duration||30;
        const hasStoredTime=p.start&&p.start!=="00:00";
        const task={
          id:taskId,title:p.title,type:"task",
          start:p.start||"00:00",
          end:p.end||fmt(d),
          meta:p.meta||("Custom task \u00b7 "+ms(d)),
          detail:p.detail||"",source:p.source||"manual",
          notionUrl:p.notionUrl||"",priority:p.priority||"High"
        };
        // Pin the start time so recalcTimes() doesn't overwrite it
        if(hasStoredTime)task._pinnedStart=p.start;
        scheduled.push(task);
      });
    } else {
      const added = loadAddedTasks();
      added.forEach(t => {
        if (scheduled.find(e => e.id === t.id)) return; // already in schedule
        const d = t.durMin || 30;
        scheduled.push({
          id: t.id, title: t.title, type: "task",
          start: "00:00", end: fmt(d),
          meta: t.meta || ("Custom task \u00b7 " + ms(d)),
          detail: t.detail || "", source: t.source || "manual",
          notionUrl: t.notionUrl || "", priority: t.priority || "High"
        });
      });
    }
  } catch(e) {}
  // Restore saved task order (from drag reorder)
  try {
    const order = loadTaskOrder();
    if (order.length) {
      const done = scheduled.filter(ev => isDone(ev));
      const active = scheduled.filter(ev => !isDone(ev));
      // Sort active items by saved order; items not in order go to end
      const orderMap = {};
      order.forEach((id, i) => { orderMap[id] = i; });
      active.sort((a, b) => {
        const ai = orderMap[a.id] !== undefined ? orderMap[a.id] : 9999;
        const bi = orderMap[b.id] !== undefined ? orderMap[b.id] : 9999;
        return ai - bi;
      });
      scheduled = [...done, ...active];
    }
  } catch(e) {}
  // Restore pinned start times (from day_root._pinnedStarts or localStorage)
  try {
    const pins = loadPinnedStarts();
    Object.entries(pins).forEach(([id, timeStr]) => {
      const ev = scheduled.find(e => e.id === id); if (!ev) return;
      ev._pinnedStart = timeStr;
    });
  } catch(e) {}
  // Apply duration changes to scheduled array
  // durChanges already populated above from day_root or localStorage
  try {
    if (Object.keys(durChanges).length) {
      Object.entries(durChanges).forEach(([id, ch]) => {
        const ev = scheduled.find(e => e.id === id); if (!ev) return;
        const s = pt(ev.start);
        ev.end = fmt(s + ch.current);
      });
    } else if (!window.USE_BLOCKSTORE || !window.blockStore) {
      // Legacy localStorage path when blockStore not available
      const raw = localStorage.getItem(DUR_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        Object.entries(saved).forEach(([id, ch]) => {
          const ev = scheduled.find(e => e.id === id); if (!ev) return;
          const s = pt(ev.start);
          ev.end = fmt(s + ch.current);
          durChanges[id] = ch;
        });
      }
    }
    recalcTimes();
  } catch(e) { recalcTimes(); }
}

async function switchToDate(dateStr) {
  if (!dateStr) return;

  // (Phase 6 cleanup) Removed PaDB.saveDate(prevDate, ...) snapshot --
  // BlockStore writes every mutation through to Postgres immediately, so the
  // outgoing day is already durable. No explicit save-on-switch needed.

  let newState = null;
  if (dateStr === __todayDate) {
    newState = window.__PA_STATE__;
    viewMode = "today";
  } else if (dateStr === __tomorrowDate && window.__PA_TOMORROW__) {
    // Build a synthetic state from the tomorrow pre-plan
    newState = { date: __tomorrowDate, schedule: window.__PA_TOMORROW__.schedule };
    viewMode = "tomorrow";
  } else if (window.__PA_ARCHIVES__ && window.__PA_ARCHIVES__[dateStr]) {
    const cached = window.__PA_ARCHIVES__[dateStr];
    // If the archive entry has full schedule data, use it directly;
    // otherwise treat it as a navigation stub and fetch from the server
    if (cached.schedule && cached.schedule.timeline && cached.schedule.timeline.length > 0) {
      newState = cached;
    } else {
      const expressState = await fetchExpressDate(dateStr);
      if (expressState) {
        window.__PA_ARCHIVES__[dateStr] = expressState; // cache for next time
        newState = expressState;
      } else {
        newState = cached; // fall back to whatever we have
      }
    }
    viewMode = "archive";
  } else {
    // No injected archive — try Express API for this date
    const expressState = await fetchExpressDate(dateStr);
    if (expressState) {
      newState = expressState;
      viewMode = "archive";
    } else {
      return; // no data for this date anywhere
    }
  }

  viewDate = dateStr;
  __state = newState;
  __data = transformState(__state);
  INIT_SCHED = __data.sched;
  INIT_CONSIDER = __data.consider;
  INIT_BACKLOG = __data.bklog;
  INIT_TRIAGE = __data.triageItems;
  INIT_NOTIFICATIONS = __data.notifications;

  scheduled = JSON.parse(JSON.stringify(INIT_SCHED));
  consider = JSON.parse(JSON.stringify(INIT_CONSIDER));
  backlog = JSON.parse(JSON.stringify(INIT_BACKLOG));

  initKeys();

  // Load BlockStore data for the new date
  if (window.blockStore) {
    try {
      await window.blockStore.loadDay(dateStr);
    } catch(e) { console.warn("[BlockStore] loadDay failed for", dateStr, e); }
  }

  // (Phase 6 cleanup) Removed legacy localStorage seeding from Express /
  // __SECOND_BRAIN__. reloadPersistedEdits() reads from BlockStore now, not
  // localStorage; the seed had no effect. fetchExpressDate is still called
  // earlier in this function for archive snapshots that arrive as nav stubs.

  reloadPersistedEdits();

  // Toggle readonly mode for archives
  document.body.classList.toggle("view-readonly", viewMode === "archive");
  // Toggle tomorrow indicator
  document.body.classList.toggle("view-tomorrow", viewMode === "tomorrow");

  // Default to Actual tab for archives, Plan tab otherwise
  const targetView = (viewMode === "archive") ? "actual" : "plan";
  const toggleBtns = document.querySelectorAll("#sched-view-toggle .svt-btn");
  toggleBtns.forEach(b => {
    b.classList.toggle("active", b.dataset.view === targetView);
  });
  schedView = targetView;

  // Update date nav display
  updateDateNav();

  // Re-render all tabs
  if (typeof buildSchedule === "function") buildSchedule();
  if (typeof buildActualView === "function" && schedView === "actual") buildActualView();
  if (typeof buildTriage === "function") buildTriage();
  if (typeof buildNotifications === "function") buildNotifications();
}

