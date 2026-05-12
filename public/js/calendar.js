// ======== CALENDAR VIEW ========
// Core engine: grid rendering, view switching, event positioning, date navigation

(function () {
  "use strict";

  // ── State ──
  const CAL = {
    view: "week",         // day | week | 3day | month
    anchorDate: new Date(),
    hourStart: 6,
    hourEnd: 22,
    hourHeight: 60,       // px per hour
    hiddenTypes: new Set(),
    selectedDate: null,
    _nowInterval: null,
  };

  window.CAL = CAL;

  const VIEWS = ["day", "week", "3day", "month"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  // ── Helpers ──
  function dateStr(d) {
    return d.toISOString().slice(0, 10);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function toMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(":").map(Number);
    return h * 60 + (m || 0);
  }

  function fmtTime12(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return h12 + ":" + String(m).padStart(2, "0") + " " + suffix;
  }

  function minsToY(mins) {
    return ((mins - CAL.hourStart * 60) / 60) * CAL.hourHeight;
  }

  function yToMins(y) {
    return Math.round(((y / CAL.hourHeight) * 60 + CAL.hourStart * 60) / 15) * 15;
  }

  // ── Visible Date Range ──
  function getVisibleRange() {
    const anchor = CAL.anchorDate;
    let start, end;
    switch (CAL.view) {
      case "day":
        start = new Date(anchor);
        end = new Date(anchor);
        break;
      case "week": {
        const dow = anchor.getDay();
        start = addDays(anchor, -dow);
        end = addDays(start, 6);
        break;
      }
      case "3day":
        start = new Date(anchor);
        end = addDays(anchor, 2);
        break;
      case "month": {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        start = addDays(first, -first.getDay());
        const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
        end = addDays(last, 6 - last.getDay());
        break;
      }
    }
    return { start, end, days: getDaysArray(start, end) };
  }

  function getDaysArray(start, end) {
    const days = [];
    const d = new Date(start);
    while (d <= end) {
      days.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  // ── Data Merging ──
  // Merge PA state schedule items with block overrides for a given date
  function filterByCal(events) {
    const calState = window._gcalSidebarState;
    if (!calState || !calState.calendars || !calState.calendars.length) return events;
    return events.filter(ev => {
      if (!ev.gcal_calendar_id) return true; // not a GCal event — always show
      const accountKey = ev.gcal_account_key || "default";
      const cal = calState.calendars.find(c => c.id === ev.gcal_calendar_id && (c.account_key || "default") === accountKey);
      return !cal || !!cal.selected; // show if calendar not found in list, or is selected
    });
  }

  function dedupeGcalEvents(events) {
    const seen = new Set();
    return events.filter(ev => {
      if (ev.source !== "gcal" && ev.source !== "calendar" && !ev.gcal_calendar_id) return true;
      const key = [
        String(ev.title || "Untitled").trim().toLowerCase().replace(/\s+/g, " "),
        ev.date || "",
        ev.start || "",
        ev.end || "",
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getEventsForDate(ds) {
    const today = dateStr(new Date());
    const events = [];

    // For today, use the live scheduled array if available
    if (ds === today && typeof scheduled !== "undefined" && scheduled.length) {
      for (const ev of scheduled) {
        if (typeof isDeleted === "function" && isDeleted(ev)) continue;
        events.push({
          id: ev.id || ev.title,
          title: ev.title,
          type: ev.type || "task",
          start: ev.start,
          end: ev.end,
          priority: ev.priority,
          source: ev.source,
          detail: ev.detail,
          gcal_calendar_id: ev.gcal_calendar_id,
          gcal_calendar_name: ev.gcal_calendar_name,
          gcal_account_key: ev.gcal_account_key,
          calUrl: ev.calUrl,
          notionUrl: ev.notionUrl,
          meta: ev.meta,
          prep: ev.prep,
          done: typeof isDone === "function" ? isDone(ev) : false,
          pushed: typeof isPushed === "function" ? isPushed(ev) : false,
          date: ds,
          _raw: ev,
        });
      }
      return filterByCal(dedupeGcalEvents(events));
    }

    // For other dates, use range cache
    const cached = window.blockStore ? window.blockStore.getRangeCache(ds) : null;
    if (cached && cached.paState && cached.paState.schedule && cached.paState.schedule.timeline) {
      for (const item of cached.paState.schedule.timeline) {
        const start = item.start ? new Date(item.start) : null;
        const end = item.end ? new Date(item.end) : null;
        if (!start || !end) continue;
        const startStr = String(start.getHours()).padStart(2, "0") + ":" + String(start.getMinutes()).padStart(2, "0");
        const endStr = String(end.getHours()).padStart(2, "0") + ":" + String(end.getMinutes()).padStart(2, "0");
        const typeMap = { meeting: "meeting", task: "task", prep: "task", time_block: "triage", focus_time: "focus", free_time: "break", ooo: "ooo" };
        const itemTitle = item.title || item.label || "Untitled";
        events.push({
          id: item.id || itemTitle,
          title: itemTitle,
          type: typeMap[item.type] || "task",
          start: startStr,
          end: endStr,
          priority: item.priority,
          source: item.source,
          detail: item.detail || item.description,
          calUrl: item.calendar_link,
          notionUrl: item.notion_url,
          gcal_calendar_id: item.gcal_calendar_id,
          gcal_calendar_name: item.gcal_calendar_name,
          gcal_account_key: item.gcal_account_key,
          date: ds,
          done: !!item.completed,
          pushed: false,
        });
      }
    }

    // Also load schedule_item blocks from the block store
    if (cached && cached.blocks) {
      for (const b of cached.blocks) {
        if ((b.type === "schedule_item" || b.type === "block") && b.properties && (b.properties.start || b.properties.scheduled_dates)) {
          const p = b.properties;
          // Don't duplicate if already from PA state
          if (events.some(e => e.id === b.id)) continue;
          events.push({
            id: b.id,
            title: p.title,
            type: p.type || "task",
            start: p.start,
            end: p.end,
            priority: p.priority,
            source: p.source || "manual",
            detail: p.detail,
            calUrl: p.calUrl,
            notionUrl: p.notionUrl,
            date: ds,
            done: !!p.done,
            pushed: !!p.pushed,
            // GCal fields
            hangout_link: p.hangout_link,
            location: p.location,
            rsvp_status: p.rsvp_status,
            attendee_count: p.attendee_count,
            is_recurring: p.is_recurring,
            all_day: p.all_day,
            gcal_event_id: p.gcal_event_id,
            gcal_calendar_id: p.gcal_calendar_id,
            gcal_calendar_name: p.gcal_calendar_name,
            gcal_account_key: p.gcal_account_key,
          });
        }
      }
    }

    return filterByCal(dedupeGcalEvents(events));
  }

  // ── Overlap Resolution ──
  // Greedy column assignment for overlapping events
  function resolveOverlaps(events) {
    if (!events.length) return [];
    const sorted = [...events].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    const columns = [];

    for (const ev of sorted) {
      const evStart = toMinutes(ev.start);
      const evEnd = toMinutes(ev.end);
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        const lastInCol = columns[c][columns[c].length - 1];
        if (toMinutes(lastInCol.end) <= evStart) {
          columns[c].push(ev);
          ev._col = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev._col = columns.length;
        columns.push([ev]);
      }
    }

    const numCols = columns.length;
    for (const ev of sorted) {
      ev._totalCols = numCols;
    }
    return sorted;
  }

  // ── Render: Toolbar ──
  function renderToolbar() {
    const range = getVisibleRange();
    let title;
    if (CAL.view === "day") {
      const d = CAL.anchorDate;
      title = DOW[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
    } else if (CAL.view === "month") {
      title = MONTHS[CAL.anchorDate.getMonth()] + " " + CAL.anchorDate.getFullYear();
    } else {
      const s = range.start, e = range.end;
      if (s.getMonth() === e.getMonth()) {
        title = MONTHS[s.getMonth()] + " " + s.getDate() + "\u2013" + e.getDate() + ", " + s.getFullYear();
      } else {
        title = MONTHS[s.getMonth()] + " " + s.getDate() + " \u2013 " + MONTHS[e.getMonth()] + " " + e.getDate();
      }
    }

    return `<div class="cal-toolbar">
      <div class="cal-toolbar-nav">
        <button class="cal-today-btn" onclick="calGoToday()">Today</button>
        <button onclick="calNav(-1)">\u2039</button>
        <button onclick="calNav(1)">\u203a</button>
      </div>
      <div class="cal-toolbar-title">${title}</div>
    </div>`;
  }

  // ── Render: Day Headers (week/3day) ──
  function renderDayHeaders(days) {
    const today = dateStr(new Date());
    return `<div class="cal-day-headers">${days.map(d => {
      const cls = dateStr(d) === today ? " today" : "";
      return `<div class="cal-day-header${cls}">
        ${DOW[d.getDay()]}
        <span class="cal-day-num">${d.getDate()}</span>
      </div>`;
    }).join("")}</div>`;
  }

  // ── Render: Time Grid (day/week/3day) ──
  function renderTimeGrid(days) {
    const totalHours = CAL.hourEnd - CAL.hourStart;
    const gridHeight = totalHours * CAL.hourHeight;
    const today = dateStr(new Date());

    // Gutter labels
    let gutterHTML = "";
    for (let h = CAL.hourStart; h <= CAL.hourEnd; h++) {
      const y = (h - CAL.hourStart) * CAL.hourHeight;
      const label = h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : (h - 12) + " PM";
      gutterHTML += `<div class="cal-gutter-label" style="top:${y}px">${label}</div>`;
    }

    // Columns with events
    let columnsHTML = "";
    for (const day of days) {
      const ds = dateStr(day);
      let events = getEventsForDate(ds);

      // Filter hidden types
      events = events.filter(e => !CAL.hiddenTypes.has(e.type));

      const resolved = resolveOverlaps(events);

      // Hour lines
      let linesHTML = "";
      for (let h = CAL.hourStart; h <= CAL.hourEnd; h++) {
        const y = (h - CAL.hourStart) * CAL.hourHeight;
        linesHTML += `<div class="cal-hour-line" style="top:${y}px"></div>`;
        if (h < CAL.hourEnd) {
          linesHTML += `<div class="cal-half-hour-line" style="top:${y + CAL.hourHeight / 2}px"></div>`;
        }
      }

      // Event blocks
      let eventsHTML = "";
      for (const ev of resolved) {
        const startMins = toMinutes(ev.start);
        const endMins = toMinutes(ev.end);
        const top = minsToY(startMins);
        const height = Math.max(((endMins - startMins) / 60) * CAL.hourHeight, 18);
        const left = ev._col ? (ev._col / ev._totalCols * 100) : 0;
        const width = ev._totalCols ? (1 / ev._totalCols * 100) : 100;
        const typeCls = "cal-event-" + (ev.type || "task");
        const stateCls = (ev.done ? " done" : "") + (ev.pushed ? " pushed" : "");
        const timeStr = fmtTime12(startMins) + " \u2013 " + fmtTime12(endMins);
        const tc = typeof cfg === "function" ? cfg(ev.type) : { tag: ev.type, color: "#a78bfa" };

        const isGcal = ev.source === "gcal";
        const meetIcon = (isGcal && ev.hangout_link) ? '<span class="cal-event-meet-icon" title="Google Meet">&#x1F4F9;</span>' : "";
        const gcalBadge = isGcal ? '<span class="cal-event-gcal-badge" title="Google Calendar"></span>' : "";
        const attendeeInfo = (isGcal && ev.attendee_count > 1) ? `<span class="cal-event-attendees">${ev.attendee_count}</span>` : "";

        eventsHTML += `<div class="cal-event ${typeCls}${stateCls}${isGcal ? " gcal-event" : ""}"
          style="top:${top}px;height:${height}px;left:${left}%;width:${width}%"
          data-event-id="${ev.id}" data-date="${ds}"
          onclick="calOpenOverlay('${ev.id}','${ds}')">
          <div class="cal-event-title">${gcalBadge}${ev.title || "Untitled"}${meetIcon}</div>
          ${height > 30 ? `<div class="cal-event-time">${timeStr}${attendeeInfo}</div>` : ""}
          <div class="cal-event-resize" data-event-id="${ev.id}" data-date="${ds}"></div>
        </div>`;
      }

      // Now-line for today
      let nowLineHTML = "";
      if (ds === today) {
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (nowMins >= CAL.hourStart * 60 && nowMins <= CAL.hourEnd * 60) {
          nowLineHTML = `<div class="cal-now-line" style="top:${minsToY(nowMins)}px"></div>`;
        }
      }

      columnsHTML += `<div class="cal-column" data-date="${ds}">
        ${linesHTML}${eventsHTML}${nowLineHTML}
      </div>`;
    }

    return `<div class="cal-grid-wrap" id="cal-grid-wrap">
      <div class="cal-grid" style="height:${gridHeight}px">
        <div class="cal-gutter" style="height:${gridHeight}px">${gutterHTML}</div>
        <div class="cal-columns">${columnsHTML}</div>
      </div>
    </div>`;
  }

  // ── Render: Month Grid ──
  function renderMonthGrid(days) {
    const today = dateStr(new Date());
    const currentMonth = CAL.anchorDate.getMonth();

    let headerHTML = DOW.map(d => `<div class="cal-month-header">${d}</div>`).join("");

    let cellsHTML = "";
    for (const day of days) {
      const ds = dateStr(day);
      const isOther = day.getMonth() !== currentMonth;
      const isToday = ds === today;
      const cls = (isOther ? " other-month" : "") + (isToday ? " today" : "");

      let events = getEventsForDate(ds).filter(e => !CAL.hiddenTypes.has(e.type));
      const maxShow = 3;

      let evHTML = "";
      const shown = events.slice(0, maxShow);
      for (const ev of shown) {
        const tc = typeof cfg === "function" ? cfg(ev.type) : { color: "#a78bfa" };
        const bg = ev.type === "meeting" || ev.type === "oneone"
          ? tc.color
          : tc.color + "20";
        const color = ev.type === "meeting" || ev.type === "oneone" ? "white" : "var(--text)";
        evHTML += `<div class="cal-month-event" style="background:${bg};color:${color}"
          onclick="event.stopPropagation();calOpenOverlay('${ev.id}','${ds}')"
          title="${ev.title}">${ev.start ? fmtTime12(toMinutes(ev.start)).replace(/ (AM|PM)/, "") : ""} ${ev.title}</div>`;
      }
      if (events.length > maxShow) {
        evHTML += `<div class="cal-month-more" onclick="event.stopPropagation();calSwitchToDay('${ds}')">+${events.length - maxShow} more</div>`;
      }

      cellsHTML += `<div class="cal-month-cell${cls}" onclick="calSwitchToDay('${ds}')">
        <div class="cal-month-day-num">${day.getDate()}</div>
        ${evHTML}
      </div>`;
    }

    return `<div class="cal-month-grid">${headerHTML}${cellsHTML}</div>`;
  }

  // ── Main Build ──
  async function buildCalendar() {
    const container = document.getElementById("tab-calendar");
    if (!container) return;

    const range = getVisibleRange();

    // Load data for visible range
    if (window.blockStore) {
      await window.blockStore.loadDateRange(dateStr(range.start), dateStr(range.end));
    }

    let html = '<div class="cal-container">';

    // Sidebar
    html += renderCalendarSidebar();

    // Main area
    html += '<div class="cal-main">';
    html += renderToolbar();

    if (CAL.view === "month") {
      html += renderMonthGrid(range.days);
    } else {
      if (CAL.view !== "day") {
        html += renderDayHeaders(range.days);
      } else {
        html += renderDayHeaders([CAL.anchorDate]);
      }
      const days = CAL.view === "day" ? [CAL.anchorDate] : range.days;
      html += renderTimeGrid(days);
    }

    html += "</div>"; // .cal-main
    html += "</div>"; // .cal-container

    // Overlay (outside container so it covers everything)
    html += renderOverlayShell();

    container.innerHTML = html;

    // Scroll to now
    scrollToNow();

    // Start now-line updater
    clearInterval(CAL._nowInterval);
    CAL._nowInterval = setInterval(updateNowLine, 60000);

    // Wire drag events
    if (typeof initCalendarDrag === "function") initCalendarDrag();
  }

  function scrollToNow() {
    const wrap = document.getElementById("cal-grid-wrap");
    if (!wrap) return;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const y = minsToY(nowMins);
    wrap.scrollTop = Math.max(0, y - 200);
  }

  function updateNowLine() {
    const lines = document.querySelectorAll(".cal-now-line");
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    for (const line of lines) {
      line.style.top = minsToY(nowMins) + "px";
    }
  }

  // ── Navigation ──
  window.calGoToday = function () {
    CAL.anchorDate = new Date();
    buildCalendar();
  };

  window.calNav = function (dir) {
    switch (CAL.view) {
      case "day":
        CAL.anchorDate = addDays(CAL.anchorDate, dir);
        break;
      case "week":
        CAL.anchorDate = addDays(CAL.anchorDate, dir * 7);
        break;
      case "3day":
        CAL.anchorDate = addDays(CAL.anchorDate, dir * 3);
        break;
      case "month":
        CAL.anchorDate = new Date(
          CAL.anchorDate.getFullYear(),
          CAL.anchorDate.getMonth() + dir,
          1
        );
        break;
    }
    buildCalendar();
  };

  window.calSetView = function (view) {
    if (VIEWS.includes(view)) {
      CAL.view = view;
      buildCalendar();
    }
  };

  window.calSwitchToDay = function (ds) {
    CAL.view = "day";
    CAL.anchorDate = new Date(ds + "T12:00:00");
    buildCalendar();
  };

  window.calToggleType = function (type) {
    if (CAL.hiddenTypes.has(type)) {
      CAL.hiddenTypes.delete(type);
    } else {
      CAL.hiddenTypes.add(type);
    }
    buildCalendar();
  };

  // Expose for tabs.js
  window.buildCalendar = buildCalendar;

  // Expose helpers for other calendar modules
  window.calHelpers = {
    dateStr, sameDay, addDays, toMinutes, fmtTime12, minsToY, yToMins,
    getEventsForDate, getVisibleRange, resolveOverlaps
  };

})();
