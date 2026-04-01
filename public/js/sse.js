// ======== LIVE UPDATES VIA SERVER-SENT EVENTS ========
// Replaces the 5-minute page reload with instant, targeted updates.
// When the Express server detects state file changes (from scheduled tasks or API writes),
// it broadcasts an SSE event and the dashboard re-fetches only the changed data.
(function(){
  let sse = null;
  let reconnectTimer = null;
  let indicator = null;
  let pendingUpdate = false;

  function isEditing(){
    const active = document.activeElement;
    if(!active) return false;
    if(active.tagName === "INPUT" || active.tagName === "TEXTAREA") return true;
    const textareas = document.querySelectorAll("textarea");
    for(const ta of textareas){ if(ta.value.trim()) return true; }
    return false;
  }

  function showIndicator(text, color){
    if(!indicator){
      indicator = document.createElement("div");
      indicator.style.cssText = "position:fixed;bottom:12px;right:16px;font-size:11px;padding:4px 10px;border-radius:6px;pointer-events:none;z-index:9999;transition:opacity 0.3s";
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

  async function refreshData(){
    if(isEditing()){
      pendingUpdate = true;
      showIndicator("Update pending...");
      return;
    }
    showIndicator("Updating...", "var(--accent)");
    try {
      const [dayState, upcoming, paLog] = await Promise.all([
        fetch('/api/state/day').then(r => r.json()).catch(() => null),
        fetch('/api/state/upcoming').then(r => r.json()).catch(() => []),
        fetch('/api/pa-log').then(r => r.json()).catch(() => null),
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
        if(typeof render === 'function') render();
        if(typeof buildTriage === 'function') buildTriage();
        if(typeof buildNotifications === 'function') buildNotifications();
        if(typeof updateStats === 'function') updateStats();
      }
      if(upcoming) window.__PA_UPCOMING__ = upcoming;
      if(paLog && paLog.html){
        const el = document.getElementById('pa-log-content');
        if(el) el.innerHTML = paLog.html;
      }
      showIndicator("Updated!", "var(--green)");
      setTimeout(hideIndicator, 1500);
      console.log('[SSE] Data refreshed from API');
    } catch(e) {
      console.error('[SSE] Refresh failed:', e);
      showIndicator("Update failed", "var(--red)");
      setTimeout(hideIndicator, 3000);
    }
  }

  function connect(){
    if(sse) sse.close();
    sse = new EventSource('/api/events');
    sse.onmessage = function(e){
      if(e.data === 'connected') {
        console.log('[SSE] Connected to live update stream');
        return;
      }
      try {
        const msg = JSON.parse(e.data);
        console.log('[SSE] Event:', msg.type, msg.source || msg.file || '');
        // Refresh data on any meaningful event
        if(msg.type === 'file-changed' || msg.type === 'ingest' || msg.type === 'save'){
          refreshData();
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

  // Check for pending updates when user stops editing
  document.addEventListener('focusout', function(){
    if(pendingUpdate){
      setTimeout(function(){
        if(!isEditing()){
          pendingUpdate = false;
          hideIndicator();
          refreshData();
        }
      }, 500);
    }
  });

  // Fallback: poll every 5 minutes in case SSE fails
  setInterval(function(){
    if(!sse || sse.readyState === EventSource.CLOSED) refreshData();
  }, 5 * 60 * 1000);
})();
