// ======== SAVE STATUS + TOAST ========
function updateSaveStatus(state, text) {
  const el = document.getElementById("save-status");
  if (!el) return;
  el.className = "save-status save-status--" + state;
  const textEl = el.querySelector(".save-status-text");
  if (textEl) textEl.textContent = text || "";
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
  // Recalculate EOD from loaded state (prefer last work block end)
  if(__state && __state.schedule && __state.schedule.blocks){
    const wb=__state.schedule.blocks.filter(b=>b.type==='work');
    if(wb.length){ EOD = pt(wb[wb.length-1].end); }
  } else if (__state && __state.schedule && __state.schedule.end_time) {
    EOD = pt(__state.schedule.end_time);
  }
}

// ======== INDEXEDDB PERSISTENCE LAYER (The Second Brain - Tier 2) ========
// Mirrors localStorage to IndexedDB for durable persistence across sessions.
// IndexedDB survives browser restarts and most cache clears.
const PaDB = {
  _db: null,
  _pending: null,
  DB_NAME: 'pa-second-brain',
  DB_VERSION: 1,

  open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._pending) return this._pending;
    this._pending = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('day-state')) {
            db.createObjectStore('day-state');
          }
          if (!db.objectStoreNames.contains('global-state')) {
            db.createObjectStore('global-state');
          }
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = (e) => { console.warn('PaDB open error:', e); reject(e); };
      } catch(e) { console.warn('IndexedDB not available:', e); reject(e); }
    });
    return this._pending;
  },

  async saveDate(dateStr, stateObj) {
    try {
      const db = await this.open();
      const tx = db.transaction('day-state', 'readwrite');
      tx.objectStore('day-state').put({ ...stateObj, savedAt: new Date().toISOString() }, dateStr);
    } catch(e) { console.warn('PaDB saveDate error:', e); }
  },

  async loadDate(dateStr) {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction('day-state', 'readonly');
        const req = tx.objectStore('day-state').get(dateStr);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch(e) { return null; }
  },

  async saveGlobal(key, value) {
    try {
      const db = await this.open();
      const tx = db.transaction('global-state', 'readwrite');
      tx.objectStore('global-state').put(value, key);
    } catch(e) { console.warn('PaDB saveGlobal error:', e); }
  },

  async loadGlobal(key) {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction('global-state', 'readonly');
        const req = tx.objectStore('global-state').get(key);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
        req.onerror = () => resolve(null);
      });
    } catch(e) { return null; }
  },

  async listDates() {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction('day-state', 'readonly');
        const req = tx.objectStore('day-state').getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch(e) { return []; }
  },

  async exportAll() {
    try {
      const db = await this.open();
      const days = {};
      const globals = {};
      await new Promise((resolve) => {
        const tx = db.transaction(['day-state', 'global-state'], 'readonly');
        const dayReq = tx.objectStore('day-state').openCursor();
        dayReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { days[cursor.key] = cursor.value; cursor.continue(); }
        };
        const globalReq = tx.objectStore('global-state').openCursor();
        globalReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { globals[cursor.key] = cursor.value; cursor.continue(); }
        };
        tx.oncomplete = () => resolve();
      });
      return { days, globals, exportedAt: new Date().toISOString() };
    } catch(e) { return { days: {}, globals: {} }; }
  }
};

// Collect all localStorage state for current date into a single object
function collectAllState() {
  const date = (__state && __state.date) ? __state.date : "unknown";
  const d = date;
  try {
    return {
      date: d,
      done: JSON.parse(localStorage.getItem("pa-done-" + d) || "{}"),
      pushed: JSON.parse(localStorage.getItem("pa-pushed-" + d) || "{}"),
      deleted: JSON.parse(localStorage.getItem("pa-deleted-" + d) || "[]"),
      durChanges: JSON.parse(localStorage.getItem("pa-dur-" + d) || "{}"),
      notes: JSON.parse(localStorage.getItem("pa-notes-" + d) || "{}"),
      actions: JSON.parse(localStorage.getItem("pa-actions-" + d) || "{}"),
      dismissed: JSON.parse(localStorage.getItem("pa-dismissed-" + d) || "{}"),
      sessions: JSON.parse(localStorage.getItem("pa-sessions-" + d) || "{}"),
      deferred: JSON.parse(localStorage.getItem("pa-deferred-" + d) || "[]"),
      pomo: JSON.parse(localStorage.getItem("pa-pomo-state-" + d) || "{}"),
      reviewed: JSON.parse(localStorage.getItem("pa-reviewed-" + d) || "[]"),
      subtasks: JSON.parse(localStorage.getItem("pa-subtasks-" + d) || "{}"),
      trivialFlags: JSON.parse(localStorage.getItem("pa-trivial-flags-" + d) || "{}"),
      engrams: JSON.parse(localStorage.getItem("pa-engrams-" + d) || "[]"),
      mood: JSON.parse(localStorage.getItem("pa-mood-" + d) || "{}"),
      pendingTasks: JSON.parse(localStorage.getItem(PENDING_TASKS_KEY) || "[]"),
      addedTasks: loadAddedTasks(),
      collectedAt: new Date().toISOString()
    };
  } catch(e) { return { date: d }; }
}

// Collect global (non-date-specific) state
function collectGlobalState() {
  try {
    return {
      stickyNotes: JSON.parse(localStorage.getItem("pa-sticky-notes") || "[]"),
      lifeCaptures: JSON.parse(localStorage.getItem("pa-life-captures") || "[]"),
      trivialTasks: JSON.parse(localStorage.getItem("pa-trivial-tasks") || "[]"),
      upcomingNotes: JSON.parse(localStorage.getItem("pa-upcoming-notes") || "{}"),
      upcomingActions: JSON.parse(localStorage.getItem("pa-upcoming-actions") || "{}"),
      pushedDocs: JSON.parse(localStorage.getItem("pa-pushed-docs") || "{}"),
      morning: JSON.parse(localStorage.getItem("pa-morning") || "{}"),
      collectedAt: new Date().toISOString()
    };
  } catch(e) { return {}; }
}

// ======== PERSISTENCE TIMERS ========
// Phase 0 quick fix: reduced debounce for critical state + heartbeat + flush on unload
let _idbTimer = null;
let _expressTimer = null;
let _heartbeatTimer = null;
let _hasPendingChanges = false;

function scheduleIDBSave() {
  // Phase 6: Skip localStorage/IDB/Express sync entirely when all BlockStore flags are ON
  // BlockStore writes directly to SQLite — no need for the old 3-tier system
  if (window.USE_BLOCKSTORE && Object.values(window.USE_BLOCKSTORE).every(v => v)) {
    return; // BlockStore handles all persistence now
  }
  _hasPendingChanges = true;
  updateSaveStatus("saving", "Saving...");
  clearTimeout(_idbTimer);
  _idbTimer = setTimeout(() => {
    const date = (__state && __state.date) ? __state.date : "unknown";
    PaDB.saveDate(date, collectAllState());
    PaDB.saveGlobal('globals', collectGlobalState());
  }, 500);
  scheduleExpressSave();
}

// Durable persistence via Express server at :8090
function scheduleExpressSave() {
  clearTimeout(_expressTimer);
  _expressTimer = setTimeout(() => {
    flushToExpress();
  }, 2000); // Reduced from 15000ms to 2000ms
}

// Synchronous-ish Express flush — used by both debounce and beforeunload
function flushToExpress() {
  const date = (__state && __state.date) ? __state.date : "unknown";
  if (date === "unknown") return;
  _hasPendingChanges = false;
  try {
    // Use keepalive: true so fetch survives page unload
    fetch("/api/save-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectAllState()),
      keepalive: true
    }).then(() => {
      updateSaveStatus("ok", "All changes saved");
    }).catch((e) => {
      updateSaveStatus("error", "Save failed — retrying...");
      console.warn("[Express Sync] save-day failed:", e.message);
    });
    fetch("/api/save-globals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectGlobalState()),
      keepalive: true
    }).catch(() => {});
  } catch(e) {
    updateSaveStatus("error", "Save failed");
    console.warn("[Express Sync] Save failed:", e.message);
  }
}

// Heartbeat: save every 2s while there are pending changes
function startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    if (_hasPendingChanges) {
      const date = (__state && __state.date) ? __state.date : "unknown";
      PaDB.saveDate(date, collectAllState());
      PaDB.saveGlobal('globals', collectGlobalState());
      flushToExpress();
    }
  }, 2000);
}
startHeartbeat();

// Write a state object back into localStorage for a given date
function writeToLocalStorage(date, state) {
  if (!state || !date) return;
  const writes = {
    ["pa-done-" + date]: state.done,
    ["pa-pushed-" + date]: state.pushed,
    ["pa-deleted-" + date]: state.deleted,
    ["pa-dur-" + date]: state.durChanges,
    ["pa-notes-" + date]: state.notes,
    ["pa-actions-" + date]: state.actions,
    ["pa-dismissed-" + date]: state.dismissed,
    ["pa-sessions-" + date]: state.sessions,
    ["pa-deferred-" + date]: state.deferred,
    ["pa-pomo-state-" + date]: state.pomo,
    ["pa-reviewed-" + date]: state.reviewed,
    ["pa-subtasks-" + date]: state.subtasks,
    ["pa-trivial-flags-" + date]: state.trivialFlags,
    ["pa-engrams-" + date]: state.engrams,
    ["pa-mood-" + date]: state.mood,
  };
  for (const [key, val] of Object.entries(writes)) {
    if (val !== undefined && val !== null) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch(e) {
        // Phase 0 fix: warn on quota exceeded instead of silent failure
        if (e.name === 'QuotaExceededError') {
          console.error("[Persistence] localStorage quota exceeded for key:", key);
          // Force an immediate Express save as fallback
          if (typeof flushToExpress === "function") flushToExpress();
        }
      }
    }
  }
}

// Write global state back into localStorage
function writeGlobalsToLocalStorage(globals) {
  if (!globals) return;
  const writes = {
    "pa-sticky-notes": globals.stickyNotes,
    "pa-life-captures": globals.lifeCaptures,
    "pa-trivial-tasks": globals.trivialTasks,
    "pa-upcoming-notes": globals.upcomingNotes,
    "pa-upcoming-actions": globals.upcomingActions,
    "pa-pushed-docs": globals.pushedDocs,
    "pa-morning": globals.morning,
  };
  for (const [key, val] of Object.entries(writes)) {
    if (val !== undefined && val !== null) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch(e) {
        if (e.name === 'QuotaExceededError') {
          console.error("[Persistence] localStorage quota exceeded for global key:", key);
          if (typeof flushToExpress === "function") flushToExpress();
        }
      }
    }
  }
}

// ======== WATERFALL COLD-START RESTORATION ========
// Priority: localStorage → IndexedDB → Express API → Second Brain (injected) → __PA_LOCAL__ (legacy)

async function fetchExpressDate(date) {
  try {
    const res = await fetch("/api/brain/recent", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data[date]) ? data[date] : null;
  } catch { return null; }
}

async function hydrateFromStorage() {
  const date = (__state && __state.date) || "unknown";
  if (date === "unknown") return;

  // Tier 1: localStorage already has data? Use it.
  if (localStorage.getItem("pa-done-" + date)) return;

  console.log("[Second Brain] localStorage empty for " + date + ", attempting restoration...");

  // Tier 2: Try IndexedDB
  try {
    const idbState = await PaDB.loadDate(date);
    if (idbState && idbState.done) {
      console.log("[Second Brain] Restoring from IndexedDB for " + date);
      writeToLocalStorage(date, idbState);
      return;
    }
  } catch(e) { console.warn("[Second Brain] IndexedDB read failed:", e); }

  // Tier 3: Try Express API (replaces old File DB at :8091)
  const expressState = await fetchExpressDate(date);
  if (expressState) {
    console.log("[Second Brain] Restoring from Express API for " + date);
    writeToLocalStorage(date, expressState);
    return;
  }

  // Tier 4: Try Second Brain (injected at boot from Express API)
  if (window.__SECOND_BRAIN__ && window.__SECOND_BRAIN__[date]) {
    console.log("[Second Brain] Restoring from injected state for " + date);
    writeToLocalStorage(date, window.__SECOND_BRAIN__[date]);
    return;
  }

  // Legacy fallback: Try __PA_LOCAL__
  const local = window.__PA_LOCAL__;
  if (local && local.date === date) {
    console.log("[Second Brain] Restoring from __PA_LOCAL__ sidecar for " + date);
    writeToLocalStorage(date, local);
    return;
  }

  console.log("[Second Brain] No stored state found for " + date);
}

// Hydrate globals from IndexedDB / Express API / Second Brain if localStorage is empty
async function hydrateGlobals() {
  if (localStorage.getItem("pa-sticky-notes")) return; // already populated

  // Try IndexedDB
  try {
    const globals = await PaDB.loadGlobal('globals');
    if (globals && globals.stickyNotes) {
      console.log("[Second Brain] Restoring globals from IndexedDB");
      writeGlobalsToLocalStorage(globals);
      return;
    }
  } catch(e) {}

  // Try Express API globals (already fetched at boot into __SECOND_BRAIN_GLOBALS__)
  if (window.__SECOND_BRAIN_GLOBALS__ && window.__SECOND_BRAIN_GLOBALS__.stickyNotes) {
    console.log("[Second Brain] Restoring globals from Express API");
    writeGlobalsToLocalStorage(window.__SECOND_BRAIN_GLOBALS__);
  }
}

// Initialize IndexedDB and open connection early
PaDB.open().catch(() => {});

function reloadPersistedEdits() {
  // Reset mutable UI state
  manualDone = new Set();
  doneAt = {};
  actionLog = [];
  durChanges = {};
  pushedSet = new Set();
  pushedAt = {};
  deletedSet = new Set();

  // Reload from localStorage for the (now current) date keys
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
  // Restore user-added tasks (quick-add, drawer-add)
  try {
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      // Load from SQLite via blockstore cache (loadDay() already ran before this point)
      const addedBlocks=window.blockStore.getByType("added_task");
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
  // Restore pinned start times
  try {
    const pins = loadPinnedStarts();
    Object.entries(pins).forEach(([id, timeStr]) => {
      const ev = scheduled.find(e => e.id === id); if (!ev) return;
      ev._pinnedStart = timeStr;
    });
  } catch(e) {}
  // Restore duration changes
  try {
    const raw = localStorage.getItem(DUR_KEY); if (!raw) { recalcTimes(); return; }
    const saved = JSON.parse(raw);
    Object.entries(saved).forEach(([id, ch]) => {
      const ev = scheduled.find(e => e.id === id); if (!ev) return;
      const s = pt(ev.start);
      ev.end = fmt(s + ch.current);
      durChanges[id] = ch;
    });
    recalcTimes();
  } catch(e) {}
}

async function switchToDate(dateStr) {
  if (!dateStr) return;

  // Save current day's state to IndexedDB before switching away
  if (viewDate && viewDate !== dateStr) {
    const prevDate = (__state && __state.date) ? __state.date : null;
    if (prevDate) PaDB.saveDate(prevDate, collectAllState());
  }

  let newState = null;
  if (dateStr === __todayDate) {
    newState = window.__PA_STATE__;
    viewMode = "today";
  } else if (dateStr === __tomorrowDate && window.__PA_TOMORROW__) {
    // Build a synthetic state from the tomorrow pre-plan
    newState = { date: __tomorrowDate, schedule: window.__PA_TOMORROW__.schedule };
    viewMode = "tomorrow";
  } else if (window.__PA_ARCHIVES__ && window.__PA_ARCHIVES__[dateStr]) {
    newState = window.__PA_ARCHIVES__[dateStr];
    viewMode = "archive";
  } else {
    // No injected archive — try Express API for this date
    const expressState = await fetchExpressDate(dateStr);
    if (expressState) {
      newState = { date: dateStr, schedule: [], meetings: [], triage: {} };
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

  // Seed localStorage from Express API or Second Brain for this date if localStorage is empty
  if (!localStorage.getItem("pa-done-" + dateStr)) {
    const expressState = await fetchExpressDate(dateStr);
    if (expressState) {
      writeToLocalStorage(dateStr, expressState);
    } else {
      const sbState = window.__SECOND_BRAIN__ && window.__SECOND_BRAIN__[dateStr];
      if (sbState) {
        writeToLocalStorage(dateStr, sbState);
      }
    }
  }

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

