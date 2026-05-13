// ======== LIVE UPDATES VIA SERVER-SENT EVENTS ========
// Reworked for block-based persistence (Phase 3).
// Separates PA-state events (schedule/triage from scheduled tasks) from
// block events (user data changes from other tabs).
// User blocks are NEVER overwritten by SSE — only PA-owned state refreshes.
(function(){
  let sse = null;
  let reconnectTimer = null;
  let indicator = null;
  let pendingPaUpdate = false;

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

  // Refresh PA-owned state only (schedule, triage, meetings)
  // Does NOT touch user blocks — those are in SQLite and never overwritten.
  // Also reloads BlockStore cache so cross-tab edits are picked up.
  async function refreshPaState(){
    if(isEditing()){
      pendingPaUpdate = true;
      showIndicator("Update pending...");
      return;
    }
    showIndicator("Updating...", "var(--accent)");
    try {
      const [dayState, upcoming] = await Promise.all([
        fetch('/api/state/day').then(r => r.json()).catch(() => null),
        fetch('/api/state/upcoming').then(r => r.json()).catch(() => []),
      ]);
      if(dayState){
        window.__PA_STATE__ = dayState;
        __state = dayState;
        __data = transformState(__state);
        INIT_SCHED = __data.sched;
        INIT_CONSIDER = __data.consider;
        INIT_BACKLOG = __data.bklog;
        INIT_TRIAGE = __data.triageItems;
        INIT_NOTIFICATIONS = __data.notifications;

        // Reset working arrays from fresh server data (same as switchToDate)
        scheduled = JSON.parse(JSON.stringify(INIT_SCHED));
        consider = JSON.parse(JSON.stringify(INIT_CONSIDER));
        backlog = JSON.parse(JSON.stringify(INIT_BACKLOG));

        // Reload BlockStore cache so reloadPersistedEdits() reads fresh cross-tab data
        if(window.blockStore && viewDate) {
          try { await window.blockStore.loadDay(viewDate); } catch(e) {}
        }

        // Re-apply user edits from blocks (Phase 4+) or localStorage (Phase 0-3)
        if(typeof reloadPersistedEdits === 'function') reloadPersistedEdits();

        if(typeof render === 'function') render();
        if(typeof buildTriage === 'function') buildTriage();
        if(typeof buildNotifications === 'function') buildNotifications();
        if(typeof updateStats === 'function') updateStats();
      }
      if(upcoming) window.__PA_UPCOMING__ = upcoming;
      showIndicator("Updated!", "var(--green)");
      setTimeout(hideIndicator, 1500);
      console.log('[SSE] PA state refreshed');
    } catch(e) {
      console.error('[SSE] PA refresh failed:', e);
      showIndicator("Update failed", "var(--red)");
      setTimeout(hideIndicator, 3000);
    }
  }

  window.refreshPaStateFromServer = refreshPaState;

  // Handle block changes from another tab
  async function handleBlockEvent(msg){
    if(!window.blockStore) return;
    // Let BlockStore handle cross-tab sync (updates in-memory cache)
    await window.blockStore.handleBlocksChanged(msg);
    console.log('[SSE] Block update from another source:', msg.action, msg.blockIds?.length || 0, 'blocks');
    // Re-apply persisted edits from updated cache and re-render UI
    if(typeof reloadPersistedEdits === 'function') reloadPersistedEdits();
    if(typeof render === 'function') render();
    if(typeof updateStats === 'function') updateStats();
  }

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
          // PA-owned state changed (scheduled task ran, file watcher triggered)
          case 'file-changed':
          case 'ingest':
            refreshPaState();
            break;

          // PA state updated via new block API
          case 'pa-state-changed':
            refreshPaState();
            // Also notify BlockStore if it's tracking PA state
            if(window.blockStore) {
              window.blockStore.handlePaStateChanged(msg);
            }
            break;

          // Block data changed (from another tab or API call)
          case 'blocks-changed':
            handleBlockEvent(msg);
            break;

          // Google Calendar sync completed
          case 'gcal-sync':
            console.log('[SSE] GCal sync:', msg.action || 'refresh', msg.changed || '');
            // Clear gcal client cache
            if(window.gcal && typeof window.gcal.clearCache === 'function') window.gcal.clearCache();
            if(window.blockStore && typeof window.blockStore.invalidateRangeCache === 'function') {
              window.blockStore.invalidateRangeCache();
            }
            await refreshPaState();
            // Rebuild calendar if visible
            if(typeof buildCalendar === 'function') {
              const calTab = document.getElementById('tab-calendar');
              if(calTab && calTab.style.display !== 'none') buildCalendar();
            }
            showIndicator("Calendar synced", "var(--green)");
            setTimeout(hideIndicator, 1500);
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

  // Check for pending PA updates when user stops editing
  document.addEventListener('focusout', function(){
    if(pendingPaUpdate){
      setTimeout(function(){
        if(!isEditing()){
          pendingPaUpdate = false;
          hideIndicator();
          refreshPaState();
        }
      }, 500);
    }
  });

  // Fallback: poll every 5 minutes in case SSE fails
  setInterval(function(){
    if(!sse || sse.readyState === EventSource.CLOSED) refreshPaState();
  }, 5 * 60 * 1000);
})();
