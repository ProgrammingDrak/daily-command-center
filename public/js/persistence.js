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
  // Recalculate EOD from loaded state
  if (__state && __state.schedule && __state.schedule.end_time) {
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

// Debounced IndexedDB save — mirrors localStorage writes with 2s delay
let _idbTimer = null;
function scheduleIDBSave() {
  clearTimeout(_idbTimer);
  _idbTimer = setTimeout(() => {
    const date = (__state && __state.date) ? __state.date : "unknown";
    PaDB.saveDate(date, collectAllState());
    PaDB.saveGlobal('globals', collectGlobalState());
  }, 2000);
  scheduleFileDBSave();
}

// ======== FILE DB PERSISTENCE (The Second Brain - Tier 3) ========
const FILE_DB_SYNC_URL = "http://localhost:8091";
let _fileDBTimer = null;
let _fileDBAvailable = null; // null = unknown, true/false after first check

async function checkFileDBHealth() {
  try {
    const res = await fetch(FILE_DB_SYNC_URL + "/api/health", { signal: AbortSignal.timeout(1000) });
    _fileDBAvailable = res.ok;
  } catch { _fileDBAvailable = false; }
  return _fileDBAvailable;
}

function scheduleFileDBSave() {
  clearTimeout(_fileDBTimer);
  _fileDBTimer = setTimeout(async () => {
    if (_fileDBAvailable === false) return; // skip if known down
    if (_fileDBAvailable === null) await checkFileDBHealth();
    if (!_fileDBAvailable) return;

    const date = (__state && __state.date) ? __state.date : "unknown";
    if (date === "unknown") return;

    try {
      // Save day-state
      await fetch(FILE_DB_SYNC_URL + "/api/save-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectAllState()),
        signal: AbortSignal.timeout(3000)
      });
      // Save globals
      await fetch(FILE_DB_SYNC_URL + "/api/save-globals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectGlobalState()),
        signal: AbortSignal.timeout(3000)
      });
    } catch(e) {
      console.warn("[File DB] Sync failed:", e.message);
      _fileDBAvailable = false;
      // Retry health check in 30s
      setTimeout(() => { _fileDBAvailable = null; }, 30000);
    }
  }, 5000); // 5s debounce (longer than IDB to reduce disk writes)
}

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
      try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
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
      try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
    }
  }
}

// ======== WATERFALL COLD-START RESTORATION ========
// Priority: localStorage → IndexedDB → File DB (HTTP) → Second Brain (injected) → __PA_LOCAL__ (legacy)

async function fetchFileDBDate(date) {
  try {
    const res = await fetch("/The Second Brain/recent/" + date + ".json", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.date) ? data : null;
  } catch { return null; }
}

async function fetchFileDBGlobals() {
  try {
    const res = await fetch("/The Second Brain/globals.json", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.savedAt) ? data : null;
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

  // Tier 3: Try File DB (HTTP fetch from The Second Brain/recent/)
  const fileState = await fetchFileDBDate(date);
  if (fileState) {
    console.log("[Second Brain] Restoring from File DB for " + date);
    writeToLocalStorage(date, fileState);
    return;
  }

  // Tier 4: Try Second Brain (injected by render script from file DB)
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

// Hydrate globals from IndexedDB / File DB / Second Brain if localStorage is empty
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

  // Try File DB (HTTP)
  const fileGlobals = await fetchFileDBGlobals();
  if (fileGlobals && fileGlobals.stickyNotes) {
    console.log("[Second Brain] Restoring globals from File DB");
    writeGlobalsToLocalStorage(fileGlobals);
    return;
  }

  // Try Second Brain globals (injected by render script)
  if (window.__SECOND_BRAIN_GLOBALS__) {
    console.log("[Second Brain] Restoring globals from injected state");
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
    // No injected archive — try File DB for this date
    const fileState = await fetchFileDBDate(dateStr);
    if (fileState) {
      // File DB has edit data but may not have schedule/meetings.
      // Build a minimal archive state so the view can render.
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

  // Seed localStorage from File DB or Second Brain for this date if localStorage is empty
  if (!localStorage.getItem("pa-done-" + dateStr)) {
    // Try File DB first (HTTP fetch)
    const fileState = await fetchFileDBDate(dateStr);
    if (fileState) {
      writeToLocalStorage(dateStr, fileState);
    } else {
      // Fall back to injected Second Brain
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

