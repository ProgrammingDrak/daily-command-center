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

  // Refresh DCC-owned state only (schedule, triage, meetings)
  // Does NOT touch user blocks — those are in SQLite and never overwritten.
  // Also reloads BlockStore cache so cross-tab edits are picked up.
  async function refreshDccState(){
    if(isEditing()){
      pendingDccUpdate = true;
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
        window.__DCC_STATE__ = dayState;
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
        if(typeof normalizePomoStateRefs === 'function') normalizePomoStateRefs();

        if(typeof render === 'function') render();
        if(typeof paintPivotTasks === 'function') paintPivotTasks();
        if(typeof buildTriage === 'function') buildTriage();
        if(typeof buildNotifications === 'function') buildNotifications();
        if(typeof updateStats === 'function') updateStats();
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
    if(window.__RESCHEDULE_IN_FLIGHT__) return;
    // Let BlockStore handle cross-tab sync (updates in-memory cache)
    await window.blockStore.handleBlocksChanged(msg);
    console.log('[SSE] Block update from another source:', msg.action, msg.blockIds?.length || 0, 'blocks');
    // Re-apply persisted edits from updated cache and re-render UI
    if(typeof reloadPersistedEdits === 'function') reloadPersistedEdits();
    if(typeof normalizePomoStateRefs === 'function') normalizePomoStateRefs();
    if(typeof render === 'function') render();
    if(typeof paintPivotTasks === 'function') paintPivotTasks();
    if(typeof updateStats === 'function') updateStats();
    if(typeof loadResponsibilities === 'function') loadResponsibilities();
    if(typeof loadTaskMenus === 'function') loadTaskMenus();
    if(typeof loadTaskGroups === 'function') loadTaskGroups();
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
          // DCC-owned state changed (scheduled task ran, file watcher triggered)
          case 'file-changed':
          case 'ingest':
            refreshDccState();
            break;

          // DCC state updated via refresh/state APIs
          case 'dcc-state-changed':
            refreshDccState();
            // Also notify BlockStore if it's tracking DCC state
            if(window.blockStore) {
              window.blockStore.handleDccStateChanged(msg);
            }
            break;

          // Block data changed (from another tab or API call)
          case 'blocks-changed':
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
  });

  // Fallback: poll every 5 minutes in case SSE fails
  setInterval(function(){
    if(!sse || sse.readyState === EventSource.CLOSED) refreshDccState();
  }, 5 * 60 * 1000);
})();
