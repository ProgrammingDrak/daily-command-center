// ======== SAVE STATUS + TOAST ========
function updateSaveStatus(state, text) {
  const el = document.getElementById("save-status");
  if (!el) return;
  el.className = "save-status save-status--" + state;
  el.title = text || "";
  const tooltip = document.getElementById("save-status-tooltip");
  if (tooltip) tooltip.textContent = text || "";
}

// showToast moved to core.js (DCC.toast) 2026-07-04 \u2014 this shim keeps the
// legacy global working until consumer-migration PRs retire it.
function showToast(message, type = "error", duration = 5000, action = null) {
  return window.DCC.toast(message, type, duration, action);
}

async function checkServerHealthForSaveStatus() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.database === "ok") return true;
    const msg = data.databaseConfigured === false
      ? "Database not configured - edits queued locally"
      : "Database unavailable - edits queued locally";
    window.__DCC_HEALTH_ERROR = msg;
    updateSaveStatus("error", msg);
    return false;
  } catch {
    window.__DCC_HEALTH_ERROR = "Server unreachable - edits queued locally";
    updateSaveStatus("error", window.__DCC_HEALTH_ERROR);
    return false;
  }
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
// viewMode: "today" (editable, live) | "tomorrow" (editable, pre-plan) | "future" (editable, planned) | "archive" (read-only)
let viewMode = "today";
let viewDate = __state ? __state.date : null;
let SUBTASK_ORDER_KEY = "pa-subtask-order-" + ((__state && __state.date) ? __state.date : "unknown");

// Compute the "today" date string from injected state
let __todayDate = (window.__DCC_STATE__ && window.__DCC_STATE__.date) || null;
let __tomorrowDate = (window.__DCC_TOMORROW__ && window.__DCC_TOMORROW__.date) || null;

// Available archive dates (for date picker dots)
let __archiveDates = window.__DCC_ARCHIVES__ ? Object.keys(window.__DCC_ARCHIVES__).sort() : [];

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
  COMMUTE_KEY = "pa-commute-times-" + d;
  LOCKED_KEY = "pa-locked-tasks-" + d;
  ORDER_KEY = "pa-task-order-" + d;
  SUBTASK_KEY = "pa-subtasks-" + d;
  SUBTASK_ORDER_KEY = "pa-subtask-order-" + d;
  TRIV_FLAGS_KEY = "pa-trivial-flags-" + d;
  TRIAGE_PARENTS_KEY = "pa-triage-parents-" + d;
  if (typeof TRIAGE_SCHEDULED_KEY !== "undefined") TRIAGE_SCHEDULED_KEY = "pa-triage-scheduled-" + d;
  if (typeof TRIAGE_DELETED_KEY !== "undefined") TRIAGE_DELETED_KEY = "pa-triage-deleted-" + d;
  BOUNTY_KEY = "pa-bounty-" + d;
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

function loadSubtaskOrder(){
  const fromBlocks=_bsProp("_subtaskOrder", null);
  if(fromBlocks&&typeof fromBlocks==="object")return fromBlocks;
  try{return JSON.parse(localStorage.getItem(SUBTASK_ORDER_KEY)||"{}")}catch(e){return{}}
}

function saveSubtaskOrder(parentId){
  if(!parentId||typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
  const order=scheduled
    .filter(ev=>ev&&ev.subtaskOf===parentId&&!(typeof isDeleted==="function"&&isDeleted(ev)))
    .map(ev=>ev.id);
  const all=loadSubtaskOrder();
  all[parentId]=order;
  if(!_bsSaveProp("_subtaskOrder",all)){
    try{localStorage.setItem(SUBTASK_ORDER_KEY,JSON.stringify(all))}catch(e){}
  }
  if(window.USE_BLOCKSTORE&&window.blockStore&&window.blockStore.reorder){
    const orderMap={};order.forEach((id,i)=>{orderMap[id]=i});
    const blocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block")]
      .filter(b=>b.properties&&orderMap[b.properties.local_id]!==undefined)
      .map(b=>({id:b.id,sort_order:(orderMap[b.properties.local_id]+1)*1000}));
    if(blocks.length)window.blockStore.reorder(blocks).catch(()=>{});
  }
  if(typeof scheduleIDBSave==="function")scheduleIDBSave();
}

function applySubtaskOrder(){
  if(typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
  const saved=loadSubtaskOrder();
  Object.entries(saved).forEach(([parentId,order])=>{
    if(!Array.isArray(order)||!order.length)return;
    const positions=[];
    const kids=[];
    scheduled.forEach((ev,i)=>{if(ev&&ev.subtaskOf===parentId){positions.push(i);kids.push(ev);}});
    if(kids.length<2)return;
    const orderMap={};order.forEach((id,i)=>{orderMap[id]=i});
    const sorted=kids.slice().sort((a,b)=>{
      const ai=orderMap[a.id]!==undefined?orderMap[a.id]:9999;
      const bi=orderMap[b.id]!==undefined?orderMap[b.id]:9999;
      return ai-bi;
    });
    positions.forEach((pos,i)=>{scheduled[pos]=sorted[i]});
  });
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
  commuteTimes = {};
  pushedSet = new Set();
  pushedAt = {};
  deletedSet = new Set();
  dailyBounty = null;

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
      dailyBounty = typeof normalizeBountyState === "function" ? normalizeBountyState(dayRoot.properties._bounty) : (dayRoot.properties._bounty || null);
      Object.assign(durChanges, dayRoot.properties._durChanges || {});
      commuteTimes = { ...(dayRoot.properties._commuteTimes || {}) };
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
    try { dailyBounty = JSON.parse(localStorage.getItem(BOUNTY_KEY) || "null"); } catch(e) { dailyBounty = null; }
    try { commuteTimes = JSON.parse(localStorage.getItem(COMMUTE_KEY) || "{}"); } catch(e) { commuteTimes = {}; }
  }
  // Restore user-added tasks (quick-add, drawer-add)
  try {
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      // Load from SQLite via blockstore cache (loadDay() already ran before this point).
      // Filter by date: loadGlobals() pulls every type="block" row regardless of date,
      // so without this check manual tasks from other days bleed onto today's schedule.
      const currentDate=window.blockStore.getCurrentDate();
      // Fold task-shaped "block" rows into the itinerary. Admit a row with a
      // local_id (UI quick-add / proposals) OR kind==="task" (API inserts like
      // the Slack-bookmark poller, which have no local_id). Never fold
      // responsibility scaffolding. Startless tasks are admitted too -> they land
      // in the Unscheduled section instead of being dropped. (Previously required
      // local_id AND start, which silently dropped every API-inserted task.)
      const isFoldableTask=b=>{
        const p=b.properties||{};
        if(p.kind&&/^responsibility/.test(p.kind))return false;
        // API-inserted shells carry kind or type "shell" and no local_id.
        if(!p.local_id&&p.kind!=="task"&&p.kind!=="shell"&&p.type!=="shell")return false;
        return (!b.date||b.date===currentDate);
      };
      const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(isFoldableTask)];
      addedBlocks.forEach(block=>{
        const p=block.properties||{};
        const taskId=p.local_id||block.id;   // API task blocks have no local_id; key on the row id
        if(!taskId||scheduled.find(e=>e.id===taskId))return;
        const d=p.duration||p.estimatedMinutes||30;
        const hasStoredTime=p.start&&p.start!=="00:00";
        const untimed=!p.start;              // no scheduled time -> Unscheduled section
        const task={
          id:taskId,title:p.title,type:p.type||"task",
          _blockId:block.id,
          start:p.start||"00:00",
          end:p.end||fmt(d),
          meta:p.meta||("Custom task \u00b7 "+ms(d)),
          detail:p.detail||"",source:p.source||"manual",
          source_id:p.source_id||"",notes:p.notes||"",untimed:untimed,
          notionUrl:p.notionUrl||"",calUrl:p.calUrl||"",priority:p.priority||"High",
          tags:Array.isArray(p.tags)?p.tags:[],
          kind:p.kind||"",
          isPlaceholder:p.isPlaceholder||false,
          placeholderMenus:Array.isArray(p.placeholderMenus)?p.placeholderMenus:[],
          taskGroupId:p.taskGroupId||null,
          responsibilityId:p.responsibilityId||null,
          responsibilityTitle:p.responsibilityTitle||"",
          capacityBucket:p.capacityBucket||"",
          responsibilityScore:p.responsibilityScore||null,
          alertKey:p.alertKey||null,
          alertType:p.alertType||null,
          publicVisibility:p.publicVisibility||"public",
          triageId:p.triageId||null,
          delegatedItemId:p.delegatedItemId||null,
          linkedBlockId:p.linkedBlockId||null,
          linkedTagId:p.linkedTagId||null,
          ampUrl:p.ampUrl||"",
          hubspotUrl:p.hubspotUrl||"",
          wrapId:p.wrapId||null,
          isWrap:!!p.isWrap,
          subtaskOf:p.subtaskOf||null,
          reschedulePlacement:p.reschedulePlacement||null,
          rescheduledFrom:p.rescheduledFrom||null,
          sourceTaskId:p.sourceTaskId||null
        };
        if(p.commuteMinutes||p.commute_minutes)task.commuteMinutes=p.commuteMinutes||p.commute_minutes;
        if(p.commuteToMinutes||p.commute_to_minutes)task.commuteToMinutes=p.commuteToMinutes||p.commute_to_minutes;
        if(p.commuteBackMinutes||p.commute_back_minutes||p.commuteReturnMinutes||p.commute_return_minutes)task.commuteBackMinutes=p.commuteBackMinutes||p.commute_back_minutes||p.commuteReturnMinutes||p.commute_return_minutes;
        // Pin the start time so recalcTimes() doesn't overwrite it (skip nested
        // items: ride-alongs/subtasks live under their parent, never cascaded).
        if(hasStoredTime&&!task.subtaskOf)task._pinnedStart=p.start;
        if(task.reschedulePlacement==="earliest"&&!task.subtaskOf)scheduled.unshift(task);
        else scheduled.push(task);
      });
    } else {
      const added = loadAddedTasks();
      added.forEach(t => {
        if (scheduled.find(e => e.id === t.id)) return; // already in schedule
        const d = t.durMin || 30;
        const task={
          id: t.id, title: t.title, type: t.type || "task",
          start: "00:00", end: fmt(d),
          meta: t.meta || ("Custom task \u00b7 " + ms(d)),
          detail: t.detail || "", source: t.source || "manual",
          notionUrl: t.notionUrl || "", calUrl: t.calUrl || "", priority: t.priority || "High",
          tags: Array.isArray(t.tags) ? t.tags : [],
          triageId: t.triageId || null,
          delegatedItemId: t.delegatedItemId || null,
          linkedBlockId: t.linkedBlockId || null,
          linkedTagId: t.linkedTagId || null,
          ampUrl:t.ampUrl||null,
          hubspotUrl:t.hubspotUrl||null,
          commuteMinutes: t.commuteMinutes || t.commute_minutes || null,
          commuteToMinutes: t.commuteToMinutes || t.commute_to_minutes || t.commuteMinutes || t.commute_minutes || null,
          commuteBackMinutes: t.commuteBackMinutes || t.commute_back_minutes || t.commuteReturnMinutes || t.commute_return_minutes || null,
          publicVisibility:t.publicVisibility||"public",
          wrapId:t.wrapId||null,
          isWrap:!!t.isWrap,
          subtaskOf:t.subtaskOf||null,
          reschedulePlacement:t.reschedulePlacement||null,
          rescheduledFrom:t.rescheduledFrom||null,
          sourceTaskId:t.sourceTaskId||null
        };
        if(task.reschedulePlacement==="earliest"&&!task.subtaskOf)scheduled.unshift(task);
        else scheduled.push(task);
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
        const ai = orderMap[a.id] !== undefined ? orderMap[a.id] : (a.reschedulePlacement === "earliest" ? -1 : 9999);
        const bi = orderMap[b.id] !== undefined ? orderMap[b.id] : (b.reschedulePlacement === "earliest" ? -1 : 9999);
        return ai - bi;
      });
      scheduled = [...done, ...active];
    }
  } catch(e) {}
  try {
    if (typeof applySubtaskOrder === "function") applySubtaskOrder();
  } catch(e) {}
  // Restore pinned start times (from day_root._pinnedStarts or localStorage)
  try {
    const pins = loadPinnedStarts();
    Object.entries(pins).forEach(([id, timeStr]) => {
      const ev = scheduled.find(e => e.id === id); if (!ev) return;
      ev._pinnedStart = timeStr;
    });
  } catch(e) {}
  try {
    if (typeof hydrateTaskCommuteTimes === "function") hydrateTaskCommuteTimes();
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
    // Hydrate the backlog from blockstore -- it's not date-scoped, lives in
    // type="block" with kind="backlog" and persists across reloads.
    if (typeof hydrateBacklogFromBlocks === "function") hydrateBacklogFromBlocks();
    // Hydrate per-day lock flags onto in-memory scheduled items.
    if (typeof hydrateLockedTasks === "function") hydrateLockedTasks();
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
    newState = window.__DCC_STATE__;
    viewMode = "today";
  } else if (dateStr === __tomorrowDate && window.__DCC_TOMORROW__) {
    // Build a synthetic state from the tomorrow pre-plan
    newState = { date: __tomorrowDate, schedule: window.__DCC_TOMORROW__.schedule };
    viewMode = "tomorrow";
  } else if (window.__DCC_ARCHIVES__ && window.__DCC_ARCHIVES__[dateStr]) {
    const cached = window.__DCC_ARCHIVES__[dateStr];
    // If the archive entry has full schedule data, use it directly;
    // otherwise treat it as a navigation stub and fetch from the server
    if (cached.schedule && cached.schedule.timeline && cached.schedule.timeline.length > 0) {
      newState = cached;
    } else {
      const expressState = await fetchExpressDate(dateStr);
      if (expressState) {
        window.__DCC_ARCHIVES__[dateStr] = expressState; // cache for next time
        newState = expressState;
      } else {
        newState = cached; // fall back to whatever we have
      }
    }
    viewMode = (__todayDate && dateStr > __todayDate) ? "future" : "archive";
  } else {
    // No injected archive — try Express API for this date
    const expressState = await fetchExpressDate(dateStr);
    if (expressState) {
      newState = expressState;
      viewMode = (__todayDate && dateStr > __todayDate) ? "future" : "archive";
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
  if (typeof normalizePomoStateRefs === "function") normalizePomoStateRefs();

  // Toggle readonly mode for archives
  document.body.classList.toggle("view-readonly", viewMode === "archive");
  // Toggle tomorrow indicator
  document.body.classList.toggle("view-tomorrow", viewMode === "tomorrow");

  // Default to Actual tab for archives, List otherwise (Blocks view removed 2026-07)
  const targetView = (viewMode === "archive") ? "actual" : "list";
  const toggleBtns = document.querySelectorAll("#sched-view-toggle .svt-btn");
  toggleBtns.forEach(b => {
    b.classList.toggle("active", b.dataset.view === targetView);
  });
  schedView = targetView;
  const timelineEl = document.getElementById("timeline");
  const listViewEl = document.getElementById("list-view");
  const actualViewEl = document.getElementById("actual-view");
  if (timelineEl) timelineEl.style.display = schedView === "plan" ? "block" : "none";
  if (listViewEl) listViewEl.style.display = schedView === "list" ? "flex" : "none";
  if (actualViewEl) actualViewEl.style.display = schedView === "actual" ? "block" : "none";

  // Update date nav display
  updateDateNav();

  // Migrate any legacy modal subtasks into the unified tree (once per day) before render.
  if (typeof migrateLegacySubtasks === "function") migrateLegacySubtasks();
  // Re-render all tabs
  if (typeof buildSchedule === "function") buildSchedule();
  if (typeof paintPivotTasks === "function") paintPivotTasks();
  if (schedView === "actual") { if (typeof buildDayReview === "function") buildDayReview(viewDate); else if (typeof buildActualView === "function") buildActualView(); }
  else if (schedView === "list" && typeof buildListView === "function") buildListView();
  if (typeof buildTriage === "function") buildTriage();
  if (typeof buildNotifications === "function") buildNotifications();
}

setTimeout(checkServerHealthForSaveStatus, 1000);
