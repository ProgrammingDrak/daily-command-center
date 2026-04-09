// ======== CALENDAR SIDEBAR ========
// Mini-month navigator, view switcher, type filters, draggable task lists

(function () {
  "use strict";

  let sidebarTaskTab = "consider";

  function renderCalendarSidebar() {
    return `<div class="cal-sidebar">
      ${renderMiniMonth()}
      ${renderViewSwitcher()}
      ${renderGcalSection()}
      ${renderTypeFilters()}
      ${renderTaskPanel()}
    </div>`;
  }

  // ── Google Calendar Section ──
  function renderGcalSection() {
    // Check cached status (async check happens on load)
    const cached = window._gcalSidebarState || { connected: false, calendars: [], loading: true };

    if (!cached.connected) {
      return `<div class="cal-sidebar-section gcal-sidebar-section">
        <h4>Google Calendar</h4>
        <a href="/api/gcal/auth" class="gcal-connect-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Connect Google Calendar
        </a>
      </div>`;
    }

    // Connected: show calendar checkboxes and sync status
    let calListHTML = "";
    if (cached.calendars && cached.calendars.length) {
      for (const cal of cached.calendars) {
        calListHTML += `<label class="gcal-cal-item">
          <input type="checkbox" ${cal.selected ? "checked" : ""} onchange="gcalToggleCal('${cal.id}', this.checked)">
          <span class="gcal-cal-dot" style="background:${cal.background_color || "#4285f4"}"></span>
          <span class="gcal-cal-name">${cal.summary}${cal.is_primary ? " (primary)" : ""}</span>
        </label>`;
      }
    }

    const syncInfo = cached.lastSync ? `<span style="font-size:9px;color:var(--text-muted)">Synced ${formatAgo(cached.lastSync)}</span>` : "";

    return `<div class="cal-sidebar-section gcal-sidebar-section">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h4 style="margin:0">Calendars</h4>
        <button class="gcal-sync-btn" onclick="gcalManualSync()" title="Sync now">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
      ${syncInfo}
      <div class="gcal-cal-list">${calListHTML}</div>
    </div>`;
  }

  function formatAgo(isoStr) {
    if (!isoStr) return "";
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    return hours + "h ago";
  }

  // Load GCal status asynchronously on sidebar render
  (async function loadGcalState() {
    if (!window.gcal) {
      window._gcalSidebarState = { connected: false, calendars: [], loading: false };
      return;
    }
    try {
      const [status, calendars] = await Promise.all([
        window.gcal.status(),
        window.gcal.getCalendars().catch(() => []),
      ]);
      const lastSync = status.calendars && status.calendars[0] ? status.calendars[0].lastSyncAt : null;
      window._gcalSidebarState = {
        connected: status.connected,
        calendars: calendars,
        lastSync,
        loading: false,
      };
      // Re-render sidebar if calendar tab is active
      const calTab = document.getElementById("tab-calendar");
      if (calTab && calTab.style.display !== "none") {
        const sidebar = calTab.querySelector(".gcal-sidebar-section");
        if (sidebar) {
          sidebar.outerHTML = renderGcalSection();
        }
      }
    } catch {
      window._gcalSidebarState = { connected: false, calendars: [], loading: false };
    }
  })();

  window.gcalToggleCal = async function (calId, selected) {
    if (!window.gcal) return;
    await window.gcal.toggleCalendar(calId, selected);
    // Update cached state
    if (window._gcalSidebarState && window._gcalSidebarState.calendars) {
      const cal = window._gcalSidebarState.calendars.find(c => c.id === calId);
      if (cal) cal.selected = selected ? 1 : 0;
    }
    if (typeof buildCalendar === "function") buildCalendar();
  };

  window.gcalManualSync = async function () {
    if (!window.gcal) return;
    const btn = document.querySelector(".gcal-sync-btn");
    if (btn) btn.classList.add("spinning");
    try {
      await window.gcal.triggerSync();
      // Reload sidebar state
      const cals = await window.gcal.getCalendars();
      if (window._gcalSidebarState) {
        window._gcalSidebarState.calendars = cals;
        window._gcalSidebarState.lastSync = new Date().toISOString();
      }
      if (typeof buildCalendar === "function") buildCalendar();
    } finally {
      if (btn) btn.classList.remove("spinning");
    }
  };

  // ── Mini Month ──
  function renderMiniMonth() {
    const CAL = window.CAL;
    const anchor = CAL.anchorDate;
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const MONTHS = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const DOW = ["S", "M", "T", "W", "T", "F", "S"];

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const selectedStr = anchor.toISOString().slice(0, 10);

    let grid = DOW.map(d => `<div class="cal-mini-dow">${d}</div>`).join("");

    // Leading blanks from previous month
    const prevMonth = new Date(year, month, 0);
    for (let i = startDow - 1; i >= 0; i--) {
      const d = prevMonth.getDate() - i;
      grid += `<div class="cal-mini-day other-month" onclick="calMiniClick(${year},${month - 1},${d})">${d}</div>`;
    }

    // Current month days
    for (let d = 1; d <= totalDays; d++) {
      const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cls = [];
      if (ds === todayStr) cls.push("today");
      if (ds === selectedStr) cls.push("selected");
      // Check if date has events in range cache
      if (window.blockStore && window.blockStore.getRangeCache(ds)) {
        const cached = window.blockStore.getRangeCache(ds);
        if ((cached.paState && cached.paState.schedule && cached.paState.schedule.timeline && cached.paState.schedule.timeline.length) ||
          (cached.blocks && cached.blocks.some(b => b.type === "schedule_item" || (b.type === "block" && ((b.properties||{}).start || (b.properties||{}).scheduled_dates))))) {
          cls.push("has-events");
        }
      }
      grid += `<div class="cal-mini-day ${cls.join(" ")}" onclick="calMiniClick(${year},${month},${d})">${d}</div>`;
    }

    // Trailing blanks from next month
    const endDow = lastDay.getDay();
    for (let d = 1; d <= 6 - endDow; d++) {
      grid += `<div class="cal-mini-day other-month" onclick="calMiniClick(${year},${month + 1},${d})">${d}</div>`;
    }

    return `<div class="cal-sidebar-section cal-mini">
      <div class="cal-mini-header">
        <div class="cal-mini-nav">
          <button onclick="calMiniNav(-1)">\u2039</button>
        </div>
        <div class="cal-mini-title">${MONTHS[month]} ${year}</div>
        <div class="cal-mini-nav">
          <button onclick="calMiniNav(1)">\u203a</button>
        </div>
      </div>
      <div class="cal-mini-grid">${grid}</div>
    </div>`;
  }

  window.calMiniClick = function (y, m, d) {
    window.CAL.anchorDate = new Date(y, m, d);
    if (typeof buildCalendar === "function") buildCalendar();
  };

  window.calMiniNav = function (dir) {
    const a = window.CAL.anchorDate;
    window.CAL.anchorDate = new Date(a.getFullYear(), a.getMonth() + dir, 1);
    if (typeof buildCalendar === "function") buildCalendar();
  };

  // ── View Switcher ──
  function renderViewSwitcher() {
    const views = [
      { id: "day", label: "Day" },
      { id: "week", label: "Week" },
      { id: "3day", label: "3 Day" },
      { id: "month", label: "Month" },
    ];
    return `<div class="cal-sidebar-section">
      <div class="cal-view-switcher">
        ${views.map(v => `<button class="cal-view-btn${window.CAL.view === v.id ? " active" : ""}"
          onclick="calSetView('${v.id}')">${v.label}</button>`).join("")}
      </div>
    </div>`;
  }

  // ── Type Filters ──
  function renderTypeFilters() {
    const types = typeof TC !== "undefined" ? TC : {};
    let html = "";
    for (const [key, val] of Object.entries(types)) {
      const hidden = window.CAL.hiddenTypes.has(key);
      html += `<div class="cal-type-filter${hidden ? " hidden" : ""}" onclick="calToggleType('${key}')">
        <div class="cal-type-swatch" style="background:${val.color}"></div>
        <span>${val.tag}</span>
      </div>`;
    }
    return `<div class="cal-sidebar-section">
      <h4>Categories</h4>
      <div class="cal-type-filters">${html}</div>
    </div>`;
  }

  // ── Task Panel (Draggable lists) ──
  function renderTaskPanel() {
    const tabs = [
      { id: "consider", label: "Consider", items: getConsiderItems() },
      { id: "backlog", label: "Backlog", items: getBacklogItems() },
      { id: "triage", label: "Triage", items: getTriageItems() },
    ];

    const tabsHTML = tabs.map(t => {
      const count = t.items.length;
      const active = sidebarTaskTab === t.id;
      return `<button class="cal-task-tab${active ? " active" : ""}" onclick="calSetTaskTab('${t.id}')">
        ${t.label}${count ? `<span class="cal-tab-count">${count}</span>` : ""}
      </button>`;
    }).join("");

    const activeTab = tabs.find(t => t.id === sidebarTaskTab) || tabs[0];
    const items = activeTab.items;

    let listHTML = "";
    if (!items.length) {
      listHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0">No items</div>';
    } else {
      for (const item of items) {
        const tc = typeof cfg === "function" ? cfg(item.type || "task") : { color: "#a78bfa", tag: "Task" };
        const dur = item.durMin ? item.durMin + "m" : item.dur ? item.dur : "";
        listHTML += `<div class="cal-task-card" draggable="true"
          data-task-id="${item.id || ""}" data-task-title="${(item.title || "").replace(/"/g, "&quot;")}"
          data-task-type="${item.type || "task"}" data-task-dur="${item.durMin || 30}"
          data-task-source="${sidebarTaskTab}"
          data-task-priority="${item.priority || "Medium"}">
          <div class="cal-task-bar" style="background:${tc.color}"></div>
          <div class="cal-task-info">
            <div class="cal-task-title">${item.title || "Untitled"}</div>
            <div class="cal-task-meta">
              <span style="color:${tc.color}">${tc.tag}</span>
              ${dur ? `<span>${dur}</span>` : ""}
              ${item.priority ? `<span>${item.priority}</span>` : ""}
            </div>
          </div>
        </div>`;
      }
    }

    return `<div class="cal-sidebar-section" style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <h4>Tasks</h4>
      <div class="cal-task-tabs">${tabsHTML}</div>
      <div class="cal-task-list" id="cal-task-list">${listHTML}</div>
    </div>`;
  }

  window.calSetTaskTab = function (tab) {
    sidebarTaskTab = tab;
    if (typeof buildCalendar === "function") buildCalendar();
  };

  // ── Data Accessors ──
  function getConsiderItems() {
    if (typeof consider !== "undefined" && Array.isArray(consider)) {
      return consider.map(c => ({
        id: c.id || c.task_id || c.title,
        title: c.title,
        type: c.type || "task",
        durMin: c.durMin || c.estimated_minutes || 30,
        priority: c.priority,
      }));
    }
    return [];
  }

  function getBacklogItems() {
    if (typeof backlog !== "undefined" && Array.isArray(backlog)) {
      return backlog.map(b => ({
        id: b.id || b.task_id || b.title,
        title: b.title,
        type: b.type || "task",
        durMin: b.durMin || b.estimated_minutes || 30,
        priority: b.priority,
      }));
    }
    return [];
  }

  function getTriageItems() {
    // Global is INIT_TRIAGE, not triageItems
    const items = typeof INIT_TRIAGE !== "undefined" ? INIT_TRIAGE : (typeof triageItems !== "undefined" ? triageItems : null);
    if (items && Array.isArray(items)) {
      return items.filter(t => !t.dismissed).map(t => ({
        id: t.id || t.title,
        title: t.title,
        type: t.type || "triage",
        durMin: 30,
        priority: t.priority || t.escalation_level,
      }));
    }
    return [];
  }

  // Expose
  window.renderCalendarSidebar = renderCalendarSidebar;

})();
