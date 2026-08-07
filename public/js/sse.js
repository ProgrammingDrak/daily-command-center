// ======== LIVE UPDATES VIA SERVER-SENT EVENTS ========
// Reworked for block-based persistence (Phase 3).
// Separates DCC-state events (schedule/triage from scheduled tasks) from
// block events (user data changes from other tabs).
// User blocks are NEVER overwritten by SSE — only DCC-owned state refreshes.
(function(){
  let sse = null;
  let reconnectTimer = null;
  let indicator = null;
  let pendingDccUpdate = false;
  let pendingCalendarBlockUpdate = false;
  let deferredBlockEvent = false;
  let deferredBlockTimer = null;
  let deferredBlockRetryMs = 500;
  let deferredBlockOverflow = false;
  const deferredBlockIds = new Set();
  const deferredUndeletedIds = new Set();
  const MAX_DEFERRED_BLOCK_IDS = 500;
  const TASK_REFRESH_INTERVAL_MS = 60 * 1000;

  function isEditing(){
    const active = document.activeElement;
    if(!active) return false;
    if(active.tagName === "INPUT" || active.tagName === "TEXTAREA") return true;
    if(active.contentEditable === "true") return true;
    // Check for open drawers or in-progress drags
    const drawer = document.querySelector(".notes-drawer-overlay.active, .notes-drawer-overlay.open");
    if(drawer) return true;
    return false;
  }

  function showIndicator(text, color){
    if(!indicator){
      indicator = document.createElement("div");
      indicator.style.cssText = "position:fixed;bottom:32px;right:16px;font-size:11px;padding:4px 10px;border-radius:6px;pointer-events:none;z-index:9999;transition:opacity 0.3s";
      document.body.appendChild(indicator);
    }
    indicator.textContent = text;
    indicator.style.background = color || "rgba(59,130,246,0.18)";
    indicator.style.color = color ? "white" : "var(--accent-light,#93c5fd)";
    indicator.style.opacity = "1";
  }

  function hideIndicator(){
    if(indicator){ indicator.style.opacity = "0"; setTimeout(() => { if(indicator) indicator.remove(); indicator = null; }, 300); }
  }

  // One bounded consistency loop for task rows. SSE remains the immediate update path;
  // this catches missed broadcasts and suspended connections without retaining snapshots
  // or starting one timer per task. Dependencies are injected so timing, visibility and
  // overlap behavior stay directly testable.
  function createTaskRefreshCoordinator(opts){
    opts=opts||{};
    const intervalMs=opts.intervalMs||TASK_REFRESH_INTERVAL_MS;
    const now=opts.now||(()=>Date.now());
    let lastSuccessAt=now();
    let inFlight=null;
    let timer=null;
    let listening=false;

    async function refresh(reason){
      if(!opts.isVisible()||!opts.canRefresh())return false;
      if(inFlight)return inFlight;
      const date=opts.getDate();
      if(!date)return false;
      const mutationGeneration=opts.getMutationGeneration?opts.getMutationGeneration():null;
      inFlight=(async()=>{
        const loaded=await opts.loadDay(date);
        if(!Array.isArray(loaded)||opts.getDate()!==date||!opts.canRefresh())return false;
        if(opts.getMutationGeneration&&opts.getMutationGeneration()!==mutationGeneration)return false;
        await opts.apply(date,reason||"timer");
        lastSuccessAt=now();
        return true;
      })().catch(e=>{
        if(opts.onError)opts.onError(e);
        return false;
      }).finally(()=>{inFlight=null;});
      return inFlight;
    }

    function tick(){
      if(now()-lastSuccessAt>=intervalMs)refresh("timer");
    }

    function onVisibilityChange(){
      if(opts.isVisible()&&now()-lastSuccessAt>=intervalMs)refresh("visible");
    }

    function start(){
      if(timer==null)timer=opts.setIntervalFn(tick,intervalMs);
      if(!listening){opts.addVisibilityListener(onVisibilityChange);listening=true;}
    }

    return {refresh,start,tick,onVisibilityChange,isInFlight:()=>!!inFlight,lastSuccessAt:()=>lastSuccessAt};
  }
  window.createTaskRefreshCoordinator=createTaskRefreshCoordinator;

  function taskRefreshSafe(){
    if(isEditing())return false;
    if(window.__RESCHEDULE_IN_FLIGHT__)return false;
    if(typeof dragId!=="undefined"&&dragId)return false;
    if(typeof _anyModalOpen==="function"&&_anyModalOpen())return false;
    if(window.blockStore&&typeof window.blockStore.hasPendingWrites==="function"&&window.blockStore.hasPendingWrites())return false;
    return true;
  }

  function applyTaskSnapshot(){
    if(typeof refoldTaskStateFromBlockCache==="function")refoldTaskStateFromBlockCache();
    else if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
    if(typeof render==="function")render();
  }

  // Pure predicate: is this dcc-state-changed event for a day OTHER than the one
  // on screen? Extracted so the scoping decision is unit-testable without the
  // fetch machinery around it. viewDate is passed in (the caller guards the
  // module global with typeof) so a missing viewDate degrades to false = full
  // refresh, the safe default. Only events that carry a clean date can be off-view.
  function _dccEventOffView(evt, viewDate){
    return !!(evt && evt.date && viewDate && evt.date !== viewDate);
  }
  window._dccEventOffView = _dccEventOffView;

  // Refresh DCC-owned state only (schedule, triage, meetings)
  // Does NOT touch user blocks — those are in SQLite and never overwritten.
  // Also reloads BlockStore cache so cross-tab edits are picked up.
  async function refreshDccState(evt){
    if(isEditing()){
      pendingDccUpdate = true;
      showIndicator("Update pending...");
      return;
    }
    // Scope by event date: an SSE refresh only ever re-renders the day currently
    // in view (viewDate), so a dcc-state-changed for some OTHER day can't affect
    // what's on screen — skip the heavy day-state fetch+transform+clone+render for
    // it. __DCC_UPCOMING__ spans several days (it feeds the triage "upcoming meeting
    // actions" titles), so we still refresh that cheap sidecar regardless of date.
    // Only dcc-state-changed carries a clean date; file-changed/ingest/interval
    // pass none -> full refresh (the safe default).
    const offView = _dccEventOffView(evt, typeof viewDate !== "undefined" ? viewDate : null);
    showIndicator("Updating...", "var(--accent)");
    try {
      if(offView){
        const upcoming = await fetch('/api/state/upcoming').then(r => r.json()).catch(() => null);
        if(upcoming) window.__DCC_UPCOMING__ = upcoming;
        // The visible day's state is untouched, so skip the heavy day-state
        // fetch+transform. But __DCC_UPCOMING__ just changed and it feeds two
        // ALWAYS-VISIBLE surfaces — the Action Items list + its count badge
        // (triage.js getAllActionItems/buildActionItemsTab) and the Upcoming
        // board (tabs.js buildUpcoming). Repaint exactly those so a cross-day
        // change doesn't leave them stale (the very thing this phase kills).
        if(upcoming && typeof render === "function") render(["actionItems","upcoming"]);
        console.log("[SSE] Off-view date " + evt.date + " (viewing " + viewDate + "): refreshed upcoming + its surfaces, skipped day-state");
        showIndicator("Updated!", "var(--green)");
        setTimeout(hideIndicator, 1500);
        return;
      }
      const [dayState, upcoming] = await Promise.all([
        fetch('/api/state/day').then(r => r.json()).catch(() => null),
        fetch('/api/state/upcoming').then(r => r.json()).catch(() => []),
      ]);
      if(dayState){
        window.__DCC_STATE__ = dayState;
        __state = dayState;
        __data = transformState(__state);
        INIT_SCHED = __data.sched;
        INIT_CONSIDER = __data.consider;
        INIT_BACKLOG = __data.bklog;
        INIT_TRIAGE = __data.triageItems;
        INIT_NOTIFICATIONS = __data.notifications;

        // Reload BlockStore cache so reloadPersistedEdits() reads fresh cross-tab data
        if(window.blockStore && viewDate) {
          try { await window.blockStore.loadDay(viewDate); } catch(e) {}
        }

        // Re-apply user edits from blocks (Phase 4+) or localStorage (Phase 0-3)
        if(typeof refoldTaskStateFromBlockCache === 'function') refoldTaskStateFromBlockCache();
        else {
          scheduled = JSON.parse(JSON.stringify(INIT_SCHED));
          consider = JSON.parse(JSON.stringify(INIT_CONSIDER));
          backlog = JSON.parse(JSON.stringify(INIT_BACKLOG));
          if(typeof reloadPersistedEdits === 'function') reloadPersistedEdits();
          if(typeof normalizePomoStateRefs === 'function') normalizePomoStateRefs();
        }

        if(typeof render === 'function') render();
        if(typeof paintPivotTasks === 'function') paintPivotTasks();
        if(typeof buildTriage === 'function') buildTriage();
        if(typeof buildNotifications === 'function') buildNotifications();
        if(typeof updateStats === 'function') updateStats();
        // INIT_TRIAGE is committed and painted by here, so the courier can diff the
        // active items against what Drake has already been shown. It decides for
        // itself whether anything is new — this fires on every refresh, not just a
        // sweep, because a deferred refresh (isEditing above) retries with no event
        // and would lose the "triage-check-ingest" source.
        if(typeof window.notifyTriageArrivals === 'function') window.notifyTriageArrivals();
      }
      if(upcoming) window.__DCC_UPCOMING__ = upcoming;
      showIndicator("Updated!", "var(--green)");
      setTimeout(hideIndicator, 1500);
      console.log('[SSE] DCC state refreshed');
    } catch(e) {
      console.error('[SSE] DCC refresh failed:', e);
      showIndicator("Update failed", "var(--red)");
      setTimeout(hideIndicator, 3000);
    }
  }

  window.refreshPaStateFromServer = refreshDccState;
  window.refreshDccStateFromServer = refreshDccState;

  function scheduleDeferredBlockFlush(){
    if(deferredBlockTimer==null){
      deferredBlockTimer=setTimeout(flushQueuedBlockEvents,deferredBlockRetryMs);
    }
  }

  function queueBlockEvent(msg){
    deferredBlockEvent=true;
    if(!deferredBlockOverflow){
      (msg.blockIds||[]).forEach(id=>deferredBlockIds.add(id));
      (msg.undeletedIds||[]).forEach(id=>deferredUndeletedIds.add(id));
      if(deferredBlockIds.size+deferredUndeletedIds.size>MAX_DEFERRED_BLOCK_IDS){
        deferredBlockOverflow=true;
        deferredBlockIds.clear();
        deferredUndeletedIds.clear();
      }
    }
    scheduleDeferredBlockFlush();
  }

  async function flushQueuedBlockEvents(){
    deferredBlockTimer=null;
    if(!deferredBlockEvent)return;
    if(window.__RESCHEDULE_IN_FLIGHT__||(window.blockStore&&window.blockStore.hasPendingWrites())){
      deferredBlockRetryMs=Math.min(deferredBlockRetryMs*2,5000);
      scheduleDeferredBlockFlush();
      return;
    }
    if(deferredBlockOverflow){
      deferredBlockEvent=false;
      deferredBlockOverflow=false;
      deferredBlockRetryMs=500;
      if(window.location&&typeof window.location.reload==="function")window.location.reload();
      return;
    }
    const msg={
      type:"blocks-changed",
      action:"deferred-refresh",
      blockIds:[...deferredBlockIds],
      undeletedIds:[...deferredUndeletedIds],
    };
    deferredBlockEvent=false;
    deferredBlockRetryMs=500;
    deferredBlockIds.clear();
    deferredUndeletedIds.clear();
    await handleBlockEvent(msg);
    if(deferredBlockEvent&&deferredBlockTimer==null){
      scheduleDeferredBlockFlush();
    }
  }

  // Handle block changes from another tab
  async function handleBlockEvent(msg){
    if(!window.blockStore) return;
    // Ignore the echo of our OWN writes. The server broadcasts every
    // create/update/delete/reschedule back to all clients, including the one that
    // made it. Reacting to our own echo mid-operation (reloadPersistedEdits +
    // render before the local mutation settled) was the reschedule "snap-back".
    // handleBlocksChanged already dedupes cache by clientId; the render side must too.
    if(msg.clientId && window.blockStore.CLIENT_ID && msg.clientId===window.blockStore.CLIENT_ID) return;
    // Belt-and-suspenders: never reload/re-render mid-reschedule, so a scheduled
    // server-task broadcast racing our multi-write move can't yank state out from
    // under it.
    if(window.__RESCHEDULE_IN_FLIGHT__){queueBlockEvent(msg);return;}
    // Keep the affected ids, then replay them once the local write drains. A constant
    // retry timer plus de-duplicated id sets avoids retaining response snapshots while
    // ensuring global and dateless changes are not lost.
    if(typeof window.blockStore.hasPendingWrites==="function"&&window.blockStore.hasPendingWrites()){queueBlockEvent(msg);return;}
    const mutationGeneration=typeof window.blockStore.getMutationGeneration==="function"
      ?window.blockStore.getMutationGeneration():null;
    // Let BlockStore handle cross-tab sync (updates in-memory cache)
    const handling=window.blockStore.handleBlocksChanged(msg);
    // handleBlocksChanged invalidates older full-day reads synchronously before its
    // first fetch. Treat that bump as part of this event, then detect only a later write.
    const reconciliationGeneration=typeof window.blockStore.getMutationGeneration==="function"
      ?window.blockStore.getMutationGeneration():mutationGeneration;
    await handling;
    if((typeof window.blockStore.hasPendingWrites==="function"&&window.blockStore.hasPendingWrites())||
       (reconciliationGeneration!==null&&window.blockStore.getMutationGeneration()!==reconciliationGeneration)){
      queueBlockEvent(msg);
      return;
    }
    if(typeof window.blockStore.invalidateRangeCache === "function") window.blockStore.invalidateRangeCache();
    console.log('[SSE] Block update from another source:', msg.action, msg.blockIds?.length || 0, 'blocks');
    // Re-apply persisted edits from updated cache and re-render UI
    if(typeof refoldTaskStateFromBlockCache === 'function') refoldTaskStateFromBlockCache();
    else if(typeof reloadPersistedEdits === 'function') {
      reloadPersistedEdits();
      if(typeof normalizePomoStateRefs === 'function') normalizePomoStateRefs();
    }
    if(typeof refreshOpenAddModalDetails === 'function') refreshOpenAddModalDetails({fromBlockStore:true});
    if(typeof render === 'function') render();
    if(typeof paintPivotTasks === 'function') paintPivotTasks();
    if(typeof updateStats === 'function') updateStats();
    if(typeof loadResponsibilities === 'function') loadResponsibilities();
    if(typeof loadTaskMenus === 'function') loadTaskMenus();
    if(typeof loadTaskGroups === 'function') loadTaskGroups();
    if(typeof schedView !== 'undefined' && schedView === 'calendar' && typeof buildItineraryCalendar === 'function'){
      if(isEditing()){
        pendingCalendarBlockUpdate = true;
        showIndicator("Calendar update pending...");
      }else{
        await buildItineraryCalendar();
      }
    }
  }

  const taskRefresh=createTaskRefreshCoordinator({
    intervalMs:TASK_REFRESH_INTERVAL_MS,
    now:()=>Date.now(),
    isVisible:()=>document.visibilityState==="visible",
    canRefresh:taskRefreshSafe,
    getDate:()=>typeof viewDate!=="undefined"?viewDate:null,
    loadDay:date=>window.blockStore?window.blockStore.loadDay(date):Promise.resolve(null),
    getMutationGeneration:()=>window.blockStore&&typeof window.blockStore.getMutationGeneration==="function"?window.blockStore.getMutationGeneration():null,
    apply:()=>applyTaskSnapshot(),
    onError:e=>console.warn("[task-refresh] passive refresh failed:",e),
    setIntervalFn:(fn,ms)=>setInterval(fn,ms),
    addVisibilityListener:fn=>document.addEventListener("visibilitychange",fn),
  });
  window.DCC_TASK_REFRESH=taskRefresh;
  taskRefresh.start();
  window.addEventListener("blockstore-wal-drained",()=>taskRefresh.refresh("wal-drained"));

  function connect(){
    if(sse) sse.close();
    sse = new EventSource('/api/events');
    sse.onmessage = async function(e){
      if(e.data === 'connected') {
        console.log('[SSE] Connected to live update stream');
        // Replay any buffered writes from when server was down
        if(window.blockStore && typeof window.blockStore.replayWAL === 'function') {
          window.blockStore.replayWAL();
        }
        return;
      }
      try {
        const msg = JSON.parse(e.data);
        console.log('[SSE] Event:', msg.type, msg.source || msg.file || '');

        switch(msg.type) {
          // DCC-owned state changed (scheduled task ran, file watcher triggered)
          case 'file-changed':
          case 'ingest':
            refreshDccState();
            break;

          // DCC state updated via refresh/state APIs. Carries msg.date -> scoped.
          case 'dcc-state-changed':
            refreshDccState(msg);
            // Also notify BlockStore if it's tracking DCC state
            if(window.blockStore) {
              window.blockStore.handleDccStateChanged(msg);
            }
            break;

          // Block data changed (from another tab or API call)
          case 'blocks-changed':
            // A meeting recap just landed (async sweep) — toast once so Drake knows
            // to open it even after he marked the meeting done. Fires independently
            // of the re-render below (which handleBlockEvent may skip mid-reschedule).
            if(msg.recapArrived){
              try{ if(window.DCC&&typeof window.DCC.toast==="function")window.DCC.toast('Recap ready'+(msg.meetingTitle?': '+msg.meetingTitle:''),'success'); }catch(e){}
            }
            handleBlockEvent(msg);
            break;

          // Old-style save event (from current persistence layer)
          case 'save':
            // During Phase 3-4 coexistence, still handle old saves
            // Once Phase 5 removes old persistence, this case goes away
            break;

          // Vault (markdown-on-disk) events — forwarded to listeners via document events
          case 'vault-changed':
          case 'vault-sync-status':
            document.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
            break;

          case 'slot-changed':
          case 'punishment-changed':
            document.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
            break;

          case 'todo-share-changed':
            if (typeof window.reloadTodoShareReactions === 'function') {
              window.reloadTodoShareReactions().catch(() => {});
            }
            document.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
            break;
        }
      } catch(err) { /* ignore parse errors */ }
    };
    sse.onerror = function(){
      console.warn('[SSE] Connection lost, reconnecting in 5s...');
      sse.close();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  // Check for pending DCC updates when user stops editing
  document.addEventListener('focusout', function(){
    if(pendingDccUpdate){
      setTimeout(function(){
        if(!isEditing()){
          pendingDccUpdate = false;
          hideIndicator();
          refreshDccState();
        }
      }, 500);
    }
    if(pendingCalendarBlockUpdate){
      setTimeout(function(){
        if(!isEditing()){
          pendingCalendarBlockUpdate = false;
          hideIndicator();
          if(typeof schedView !== 'undefined' && schedView === 'calendar' && typeof buildItineraryCalendar === 'function') buildItineraryCalendar();
        }
      }, 500);
    }
  });

  // Fallback: poll every 5 minutes in case SSE fails
  setInterval(function(){
    if(!sse || sse.readyState === EventSource.CLOSED) refreshDccState();
  }, 5 * 60 * 1000);
})();
