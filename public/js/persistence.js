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

// C6b: derived from the children's own `sort_order`, not the `_subtaskOrder` overlay map
// (3 day_roots; migration 001 applied 7 entries). A parent's step order is a fact about the
// steps, so it belongs on them -- the overlay keyed it under the parent on the viewed day,
// which is why moving a parent to another date left its step order behind.
function loadSubtaskOrder(){
  if(window.blockStore&&typeof _orderableRows==="function"){
    const byParent={};
    _orderableRows().forEach(b=>{
      const pid=b.properties.subtaskOf;
      if(!pid)return;
      (byParent[pid]=byParent[pid]||[]).push(b);
    });
    const out={};
    Object.keys(byParent).forEach(pid=>{
      out[pid]=byParent[pid]
        .sort((a,b)=>{
          const ao=(a.sort_order==null)?Number.MAX_SAFE_INTEGER:a.sort_order;
          const bo=(b.sort_order==null)?Number.MAX_SAFE_INTEGER:b.sort_order;
          return ao-bo;
        })
        .map(_evIdOfRow);
    });
    if(Object.keys(out).length)return out;
    const fromBlocks=_bsProp("_subtaskOrder",null);
    if(fromBlocks&&typeof fromBlocks==="object"&&Object.keys(fromBlocks).length){
      if(typeof _c6bFallback==="function")_c6bFallback("subtaskOrder",Object.keys(fromBlocks).length);
      return fromBlocks;
    }
  }
  try{return JSON.parse(localStorage.getItem(SUBTASK_ORDER_KEY)||"{}")}catch(e){return{}}
}

function saveSubtaskOrder(parentId){
  if(!parentId||typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
  const order=DCC.TaskModel.selectNotDeleted(DCC.TaskModel.subtasksOf(parentId,scheduled))
    .map(ev=>ev.id);
  // C6b: `sort_order` on the children only. The overlay write is gone, and the reorder is keyed
  // on the EV ID (`_writeRowOrder`) rather than `local_id`, which is what let a step with no
  // local_id keep its position silently unpersisted.
  if(window.USE_BLOCKSTORE&&window.blockStore&&window.blockStore.reorder&&typeof _writeRowOrder==="function"){
    _writeRowOrder(order);
  }else{
    const all=loadSubtaskOrder();
    all[parentId]=order;
    try{localStorage.setItem(SUBTASK_ORDER_KEY,JSON.stringify(all))}catch(e){}
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

// Read a day_root's completion + hide overlays into the live registries.
//
// Hoisted out of reloadPersistedEdits so it can be tested: reloadPersistedEdits itself is
// too entangled with module state to exercise, and the legacy `_pushed` branch below is a
// real invariant about real historical data that would otherwise be guarded by nothing.
// (itinerary-fold.test.js hoisted isFoldableTask out of this same file for the same reason.)
//
// LEGACY `_done` (C5b): nothing WRITES this key any more either — completion goes to the
// task row's `properties.status`, and the fold seeds `manualDone` from the row (see
// reloadPersistedEdits below). The read stays for the same reason `_pushed`'s does, and it
// was measured before deciding rather than assumed: of the 401 entries on prod
// 2026-08-04, migration 002 carried 316 onto rows, 67 point at nothing that renders on
// any surface, and **23 are still the only representation of a real completion** — 12
// whose local_id is shared by 2+ rows (002's resolver refused to guess, so every
// candidate row still reads `status:'open'`: "1:1 with Mike", "Go over Metrics", "Get
// stuff from my House"…) and 11 that render from `schedule.timeline` on an archive day
// with no row at all. Dropping this read flips those 23 finished tasks back to open. A4
// removes the keys.
//
// LEGACY `_pushed` (C3): the pushed subsystem is deleted and nothing writes this key any
// more, but old day_roots still carry it, and a pushed row was never REMOVED from its origin
// day — only hidden by this overlay. Folding it into deletedSet keeps those days rendering as
// they always have; dropping the read would resurface the origin copy alongside the duplicate
// that push created on the next day. Measured on the prod restore before deciding: 4 day_roots
// carry it, 10 ids total, and 9 of the 10 no longer resolve to a live row at all — so this
// honors history for exactly one row, on 2026-04-06. A pushed row IS a row that left this day,
// which is what `_deleted` means here, and routes/social-todo.js already treats the two keys
// identically when building a public share's hide set.
function applyDayRootOverlays(props, { manualDone, doneAt, deletedSet }) {
  props = props || {};
  // Normalized, not just null-guarded. These properties are user-writable JSON on a row
  // anything can PATCH, so a type-wrong half-written overlay is reachable — and
  // `if (done.ids) done.ids.forEach(...)` throws on `{_done:{ids:"t1"}}`, taking the whole
  // boot-time hydration with it. A wrong-typed overlay should contribute nothing, not
  // break the day.
  const list = (v) => (Array.isArray(v) ? v : []);
  const done = props._done || {};
  list(done.ids).forEach(id => manualDone.add(id));
  if (done.at && typeof done.at === "object") Object.assign(doneAt, done.at);
  list(props._deleted).forEach(id => deletedSet.add(id));
  list((props._pushed || {}).ids).forEach(id => deletedSet.add(id));
}

function reloadPersistedEdits() {
  // Reset mutable UI state
  manualDone = new Set();
  doneAt = {};
  actionLog = [];
  durChanges = {};
  commuteTimes = {};
  deletedSet = new Set();
  dailyBounty = null;

  // Reload from blockStore day_root (primary) or localStorage (fallback)
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const dayRoot = window.blockStore.get(window.blockStore.getDayRootId());
    if (dayRoot && dayRoot.properties) {
      applyDayRootOverlays(dayRoot.properties, { manualDone, doneAt, deletedSet });
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
    try { const d = JSON.parse(localStorage.getItem(DELETED_KEY) || "[]");
      d.forEach(id => deletedSet.add(id));
    } catch(e) {}
    // Same legacy read as the blockStore branch above, for a browser holding stale
    // pa-pushed-<date> keys from before C3.
    try { const d = JSON.parse(localStorage.getItem("pa-pushed-" + ((__state && __state.date) || "unknown")) || "{}");
      if (d.ids) d.ids.forEach(id => deletedSet.add(id));
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
      // Day-scoping rules:
      //  - dated row: folds only on its own date.
      //  - dateless row: genuinely unscheduled work -> folds as untimed (the
      //    Unscheduled section) on whatever day is viewed, UNLESS a dated
      //    sibling shares its local_id. C4 KEPT that suppression and stopped
      //    calling it scaffolding: under "date IS NULL is the definition of
      //    unscheduled", a task is either scheduled or unscheduled and never
      //    both, so when two rows claim one local_id the DATED row wins. That
      //    is the rule, not a workaround for the retired quick-add dual-write.
      //    No title fallback here: recurring titles ("Coffee") would
      //    false-suppress real work.
      //  - pending rows already closed in the Action Items tab stay out.
      //
      // The phase plan said to DELETE this computation. Measured before deciding, on
      // the prod restore with 001 applied: it suppresses 0 rows in Drake's ws-1 and
      // **2 in ws-3** — two dateless `pending_task` copies that are exactly the
      // leftovers itinerary-fold.test.js's header documents the prod incident for.
      // Migration 001 does NOT clean them up (its own counters read
      // backlog_targets_deleted: 0), so the plan's premise that it would was wrong,
      // and deleting this line would fold both onto every day a ws-3 session views.
      // The rows want a migration; that is Track A's file and is flagged to them.
      const datedLocalIds=new Set(window.blockStore.getByType("block")
        .filter(x=>x.date&&(x.properties||{}).local_id)
        .map(x=>x.properties.local_id));
      // Fail LOUDLY if task-model.js did not load. This is the one cross-module call
      // in here without a typeof guard, and it sits inside a try whose catch discards
      // the error — so a stale cached index.html (no <script> tag) or a parse error
      // would throw on the first block and hand the user a silently EMPTY itinerary,
      // skipping hydrateBacklogFromBlocks/hydrateLockedTasks too, with nothing in the
      // console. Every sibling call here (hydrateBacklogFromBlocks, commitDoneOnDate)
      // is typeof-guarded; unfinished-tasks.js guards TaskModel the same way.
      // Deliberately NOT an early return out of reloadPersistedEdits: the fold loop
      // sits in its own try, and bailing from the function would also skip
      // hydrateTaskCommuteTimes / hydrateBacklogFromBlocks / hydrateLockedTasks /
      // recalcTimes further down. Skip only the loop that needs the module.
      //
      // C4 hoisted this ABOVE the fold predicate, because isFoldableTask now calls
      // TM.foldsIntoItinerary. Declared after it, the const would have been in scope
      // but uninitialized when .filter() ran, so a missing module would throw a
      // ReferenceError into the discarding catch instead of logging this line — the
      // silent-empty-itinerary failure the guard exists to prevent, reintroduced by
      // the refactor that shares the predicate.
      const TM=window.DCC&&window.DCC.TaskModel;
      const _tmReady=!!(TM&&typeof TM.fromBlock==="function"&&typeof TM.foldsIntoItinerary==="function");
      if(!_tmReady)console.error("[persistence] task-model.js missing or stale — task blocks cannot fold into the itinerary");
      // C4: the kind + addressability halves are TaskModel.foldsIntoItinerary, shared
      // with syncAddedTaskTimes (which had drifted — it lacked the shell branch). What
      // stays here is what is genuinely per-view: the status tests and the day scoping.
      const isFoldableTask=b=>{
        const p=b.properties||{};
        if(!TM.foldsIntoItinerary(b))return false;
        // C5b was told to DROP these two branches and deliberately did not, on the strength
        // of the measurement plus what the rest of the codebase still believes.
        //
        // Measured on prod 2026-08-04, every workspace, live rows and tombstones alike: ZERO
        // rows carry `status:"deleted"` or `"archived"`, so removing them changes no
        // behavior today — a tombstone is the `deleted_at` COLUMN, which the blockStore
        // filters upstream of this fold. But FOUR other readers still treat the value as
        // live: `TaskModel.selectUnscheduled` excludes it (and one-unscheduled-home.test.js
        // pins that), `schedule.js syncAddedTaskTimes` skips it, and routes/blocks.js reads
        // it. Dropping it HERE alone would mean a dateless row with that status folds into
        // the itinerary while being excluded from the Backlog that is supposed to be the same
        // list — one row, two answers, which is the divergence this whole project exists to
        // remove. Retiring the vocabulary belongs in one change across all five readers (A4,
        // with the overlay), not in one reader here.
        //
        // status==="done" was ALSO in this list once, which meant a task completed by any
        // server path (Day in Review's Approve, the MCP tools, the Slack ✅, the
        // responsibility hook) silently VANISHED from the itinerary instead of checking off.
        // C0 removed THAT one; a done task is still a task, so it is admitted and the fold
        // below seeds the done registry from it.
        if(p.status==="deleted"||p.status==="archived")return false;
        // A completion belongs to a DAY. A dateless row has none, so admitting a
        // done one would fold it onto every day you look at (there are real ones:
        // closed side-project rows) — keep those out, exactly as before.
        if((p.status==="done"||p.done===true)&&!b.date)return false;
        if(b.date)return b.date===currentDate;
        return !(p.local_id&&datedLocalIds.has(p.local_id));
      };
      const addedBlocks=_tmReady?[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(isFoldableTask)]:[];
      if(_tmReady)addedBlocks.forEach(block=>{
        const p=block.properties||{};
        const taskId=p.local_id||block.id;   // API task blocks have no local_id; key on the row id
        // Safety net: a stale cached day file can still carry the synthesized
        // meeting ghost (id "mtg-<sourceId>") for this same event. The real
        // block wins -> drop the ghost so it can't double-render before the next
        // server read suppresses it by source_id.
        if((p.type==="meeting"||p.kind==="meeting"||p.type==="oneone")&&p.source_id){
          const sid=String(p.source_id);
          for(let i=scheduled.length-1;i>=0;i--){
            const e=scheduled[i];
            if(e&&e.id!==taskId&&(e.type==="meeting"||e.type==="oneone")&&String(e.source_id||"")===sid)scheduled.splice(i,1);
          }
        }
        if(!taskId||scheduled.find(e=>e.id===taskId))return;
        // ★ THIS IS THE DONE REGISTRY'S SOURCE NOW (C5b), not a bridge to one.
        //
        // C0 added this as a temporary second read, and both the C5 plan and the C5b
        // brief said to DELETE it here "because it dies with the overlay". That is
        // backwards: `_done` is what died (as a write — see sync.js), and this is what
        // replaced it. Delete this loop and `manualDone` is empty on every load, so
        // nothing renders as done at all.
        //
        // `manualDone`/`doneAt` therefore survive as the in-memory PROJECTION of row
        // status; what C5b removed is their PERSISTENCE. Keeping the projection is what
        // makes this phase tractable: `isDone(ev)` reads `manualDone` and roughly ten
        // files consume `isDone` (state.js, sidebar.js, day-review.js, schedule-tab.js,
        // point-plan.js, prep.js, triage.js, tabs.js, slots.js), so retiring the
        // registry itself means rewriting the done predicate across all of them, which
        // is its own phase.
        //
        // Stays in the CALLER rather than moving into fromBlock, for the reason C0 gave
        // and C5b keeps: manualDone/doneAt are reloadPersistedEdits' own locals, and
        // fromBlock is contractually pure (mutates no globals, reads nothing off the
        // page). The carryover lane does not need it either — collectUnfinished admits
        // only *unfinished* rows.
        if(p.done===true||p.status==="done"){
          manualDone.add(taskId);
          if(!doneAt[taskId])doneAt[taskId]=p.completedAt||p.doneAt||null;
        }
        // The block -> ev projection lives in task-model.js now: ONE shape shared
        // with the carryover lane (schedule-tab.js), which used to hand-roll a
        // narrower bag and drop half the fields the row builder reads.
        const task=TM.fromBlock(block);
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
      const done = DCC.TaskModel.selectDone(scheduled);
      const active = DCC.TaskModel.selectOpen(scheduled);
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
