// ======== CALENDAR DRAG & DROP ========
// Sidebar→Calendar drops, event time drag, event resize

(function () {
  "use strict";

  let dragState = null;
  let ghostEl = null;
  let dropIndicator = null;

  function initCalendarDrag() {
    // Sidebar task card drag start
    const taskCards = document.querySelectorAll(".cal-task-card[draggable]");
    for (const card of taskCards) {
      card.addEventListener("dragstart", onSidebarDragStart);
      card.addEventListener("dragend", onDragEnd);
    }

    // Calendar columns as drop targets
    const columns = document.querySelectorAll(".cal-column");
    for (const col of columns) {
      col.addEventListener("dragover", onColumnDragOver);
      col.addEventListener("dragleave", onColumnDragLeave);
      col.addEventListener("drop", onColumnDrop);
    }

    // Month cells as drop targets
    const monthCells = document.querySelectorAll(".cal-month-cell");
    for (const cell of monthCells) {
      cell.addEventListener("dragover", onMonthDragOver);
      cell.addEventListener("dragleave", onMonthDragLeave);
      cell.addEventListener("drop", onMonthDrop);
    }

    // Existing event drag (time change)
    const events = document.querySelectorAll(".cal-event");
    for (const ev of events) {
      ev.addEventListener("mousedown", onEventMouseDown);
    }

    // Resize handles
    const resizeHandles = document.querySelectorAll(".cal-event-resize");
    for (const handle of resizeHandles) {
      handle.addEventListener("mousedown", onResizeMouseDown);
    }
  }

  // ── Sidebar → Calendar Drop ──

  function onSidebarDragStart(e) {
    const card = e.currentTarget;
    dragState = {
      type: "sidebar",
      taskId: card.dataset.taskId,
      taskTitle: card.dataset.taskTitle,
      taskType: card.dataset.taskType,
      taskDur: parseInt(card.dataset.taskDur) || 30,
      taskSource: card.dataset.taskSource,
      taskPriority: card.dataset.taskPriority,
    };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.taskTitle);
    card.style.opacity = "0.4";
  }

  function onColumnDragOver(e) {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const col = e.currentTarget;
    const rect = col.getBoundingClientRect();
    const gridWrap = document.getElementById("cal-grid-wrap");
    const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
    const y = e.clientY - rect.top + scrollTop;
    const mins = window.calHelpers.yToMins(y);
    const durMins = dragState.type === "sidebar" ? dragState.taskDur : (dragState.durMins || 30);
    const height = (durMins / 60) * window.CAL.hourHeight;

    // Show drop indicator
    if (!dropIndicator) {
      dropIndicator = document.createElement("div");
      dropIndicator.className = "cal-drop-indicator";
    }
    dropIndicator.style.top = window.calHelpers.minsToY(mins) + "px";
    dropIndicator.style.height = height + "px";
    dropIndicator.innerHTML = `<div class="cal-drop-time-label">${window.calHelpers.fmtTime12(mins)}</div>`;
    if (!col.contains(dropIndicator)) col.appendChild(dropIndicator);
  }

  function onColumnDragLeave(e) {
    if (dropIndicator && e.currentTarget.contains(dropIndicator)) {
      dropIndicator.remove();
    }
  }

  function onColumnDrop(e) {
    e.preventDefault();
    if (!dragState) return;

    const col = e.currentTarget;
    const date = col.dataset.date;
    const rect = col.getBoundingClientRect();
    const gridWrap = document.getElementById("cal-grid-wrap");
    const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
    const y = e.clientY - rect.top + scrollTop;
    const startMins = window.calHelpers.yToMins(y);
    const durMins = dragState.type === "sidebar" ? dragState.taskDur : (dragState.durMins || 30);
    const endMins = startMins + durMins;

    const startStr = String(Math.floor(startMins / 60)).padStart(2, "0") + ":" + String(startMins % 60).padStart(2, "0");
    const endStr = String(Math.floor(endMins / 60)).padStart(2, "0") + ":" + String(endMins % 60).padStart(2, "0");

    if (dragState.type === "sidebar") {
      // Create a new scheduled item
      handleSidebarDrop(date, startStr, endStr, durMins);
    } else if (dragState.type === "event-move") {
      // Move existing event
      handleEventMove(dragState.eventId, dragState.originalDate, date, startStr, endStr);
    }

    cleanup();
    if (typeof buildCalendar === "function") buildCalendar();
  }

  async function handleSidebarDrop(date, startStr, endStr, durMins) {
    const today = new Date().toISOString().slice(0, 10);

    if (date === today && typeof addToSchedule === "function") {
      // Use existing schedule system for today
      // Create a task-like object and add it
      const newTask = {
        id: dragState.taskId || crypto.randomUUID(),
        title: dragState.taskTitle,
        type: dragState.taskType || "task",
        start: startStr,
        end: endStr,
        priority: dragState.taskPriority || "Medium",
        source: "manual",
        meta: dragState.taskPriority + " priority \u00b7 " + durMins + "min",
      };
      if (typeof scheduled !== "undefined") {
        scheduled.push(newTask);
        if (typeof pinStartTime === "function") pinStartTime(newTask.id, startStr);
        if (typeof saveTaskOrder === "function") saveTaskOrder();
        if (typeof buildSchedule === "function") buildSchedule();
      }
    }

    // Also create a block for persistence
    if (window.blockStore) {
      await window.blockStore.createBlock("schedule_item", {
        title: dragState.taskTitle,
        type: dragState.taskType || "task",
        start: startStr,
        end: endStr,
        priority: dragState.taskPriority || "Medium",
        source: "manual",
        durOriginal: durMins,
        durCurrent: durMins,
      }, { date });
    }
  }

  async function handleEventMove(eventId, originalDate, newDate, startStr, endStr) {
    const today = new Date().toISOString().slice(0, 10);

    if (originalDate === today && typeof pinStartTime === "function") {
      pinStartTime(eventId, startStr);
      if (typeof buildSchedule === "function") buildSchedule();
    }

    // Update block if exists
    if (window.blockStore) {
      const block = window.blockStore.get(eventId);
      if (block) {
        const props = { ...block.properties, start: startStr, end: endStr };
        await window.blockStore.updateBlock(eventId, props);
      }
    }
  }

  // ── Event Time Drag ──

  function onEventMouseDown(e) {
    // Skip if clicking resize handle
    if (e.target.classList.contains("cal-event-resize")) return;

    const eventEl = e.currentTarget;
    const eventId = eventEl.dataset.eventId;
    const date = eventEl.dataset.date;
    if (!eventId) return;

    // Don't start drag on click (only on sustained press)
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    function onMouseMove(me) {
      if (!moved && (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5)) {
        moved = true;
        // Start event drag
        eventEl.style.opacity = "0.3";
        dragState = {
          type: "event-move",
          eventId,
          originalDate: date,
          durMins: getDurFromEl(eventEl),
        };

        // Create ghost
        ghostEl = document.createElement("div");
        ghostEl.className = "cal-drag-ghost";
        ghostEl.style.background = getComputedStyle(eventEl).backgroundColor || "var(--accent)";
        ghostEl.textContent = eventEl.querySelector(".cal-event-title")?.textContent || "";
        document.body.appendChild(ghostEl);
      }
      if (moved && ghostEl) {
        ghostEl.style.left = (me.clientX + 12) + "px";
        ghostEl.style.top = (me.clientY - 10) + "px";

        // Find column under cursor and show drop indicator
        const col = findColumnAt(me.clientX, me.clientY);
        if (col) {
          const rect = col.getBoundingClientRect();
          const gridWrap = document.getElementById("cal-grid-wrap");
          const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
          const y = me.clientY - rect.top + scrollTop;
          const mins = window.calHelpers.yToMins(y);
          const height = (dragState.durMins / 60) * window.CAL.hourHeight;

          if (!dropIndicator) {
            dropIndicator = document.createElement("div");
            dropIndicator.className = "cal-drop-indicator";
          }
          dropIndicator.style.top = window.calHelpers.minsToY(mins) + "px";
          dropIndicator.style.height = height + "px";
          dropIndicator.innerHTML = `<div class="cal-drop-time-label">${window.calHelpers.fmtTime12(mins)}</div>`;
          if (!col.contains(dropIndicator)) {
            // Remove from old column
            if (dropIndicator.parentNode) dropIndicator.remove();
            col.appendChild(dropIndicator);
          }
        }
      }
    }

    function onMouseUp(me) {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      if (moved && dragState) {
        const col = findColumnAt(me.clientX, me.clientY);
        if (col) {
          const date = col.dataset.date;
          const rect = col.getBoundingClientRect();
          const gridWrap = document.getElementById("cal-grid-wrap");
          const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
          const y = me.clientY - rect.top + scrollTop;
          const startMins = window.calHelpers.yToMins(y);
          const endMins = startMins + dragState.durMins;
          const startStr = String(Math.floor(startMins / 60)).padStart(2, "0") + ":" + String(startMins % 60).padStart(2, "0");
          const endStr = String(Math.floor(endMins / 60)).padStart(2, "0") + ":" + String(endMins % 60).padStart(2, "0");
          handleEventMove(dragState.eventId, dragState.originalDate, date, startStr, endStr);
        }
        cleanup();
        if (typeof buildCalendar === "function") buildCalendar();
      } else {
        cleanup();
      }

      eventEl.style.opacity = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // ── Resize ──

  function onResizeMouseDown(e) {
    e.stopPropagation();
    e.preventDefault();

    const handle = e.currentTarget;
    const eventEl = handle.closest(".cal-event");
    const eventId = handle.dataset.eventId;
    const date = handle.dataset.date;
    if (!eventEl || !eventId) return;

    const startTop = parseFloat(eventEl.style.top);
    const startMins = window.calHelpers.yToMins(startTop) || 0;
    const origHeight = parseFloat(eventEl.style.height);

    function onMouseMove(me) {
      const col = eventEl.parentElement;
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const gridWrap = document.getElementById("cal-grid-wrap");
      const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
      const y = me.clientY - rect.top + scrollTop;
      const endMins = window.calHelpers.yToMins(y);
      const newHeight = Math.max(window.calHelpers.minsToY(endMins) - startTop, 15);
      eventEl.style.height = newHeight + "px";
    }

    function onMouseUp(me) {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      const col = eventEl.parentElement;
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const gridWrap = document.getElementById("cal-grid-wrap");
      const scrollTop = gridWrap ? gridWrap.scrollTop : 0;
      const y = me.clientY - rect.top + scrollTop;
      const endMins = Math.max(window.calHelpers.yToMins(y), startMins + 15);
      const durMins = endMins - startMins;

      const startStr = String(Math.floor(startMins / 60)).padStart(2, "0") + ":" + String(startMins % 60).padStart(2, "0");
      const endStr = String(Math.floor(endMins / 60)).padStart(2, "0") + ":" + String(endMins % 60).padStart(2, "0");

      // Update duration
      const today = new Date().toISOString().slice(0, 10);
      if (date === today && typeof setDurAbsolute === "function") {
        setDurAbsolute(eventId, durMins);
        if (typeof buildSchedule === "function") buildSchedule();
      }

      if (window.blockStore) {
        const block = window.blockStore.get(eventId);
        if (block) {
          const props = { ...block.properties, start: startStr, end: endStr, durCurrent: durMins };
          window.blockStore.updateBlock(eventId, props);
        }
      }

      if (typeof buildCalendar === "function") buildCalendar();
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // ── Month Drop ──

  function onMonthDragOver(e) {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.style.background = "rgba(59,130,246,0.1)";
  }

  function onMonthDragLeave(e) {
    e.currentTarget.style.background = "";
  }

  function onMonthDrop(e) {
    e.preventDefault();
    e.currentTarget.style.background = "";
    if (!dragState || dragState.type !== "sidebar") return;

    // Get date from cell's day number + current month context
    // The cell's onclick has the date, we need to extract it differently
    // Use the first child .cal-month-day-num text as day, combined with anchor month
    const dayNum = e.currentTarget.querySelector(".cal-month-day-num")?.textContent;
    if (!dayNum) return;

    // This is approximate — for a proper implementation we'd store data-date on month cells
    // For now, default to 9:00 AM start
    const durMins = dragState.taskDur || 30;
    handleSidebarDrop(
      figureMonthCellDate(e.currentTarget, parseInt(dayNum)),
      "09:00",
      String(Math.floor((540 + durMins) / 60)).padStart(2, "0") + ":" + String((540 + durMins) % 60).padStart(2, "0"),
      durMins
    );

    cleanup();
    if (typeof buildCalendar === "function") buildCalendar();
  }

  function figureMonthCellDate(cell, dayNum) {
    // Best effort: use anchor date's month/year
    const isOther = cell.classList.contains("other-month");
    const anchor = window.CAL.anchorDate;
    let month = anchor.getMonth();
    let year = anchor.getFullYear();
    if (isOther) {
      if (dayNum > 15) { month--; } else { month++; }
      if (month < 0) { month = 11; year--; }
      if (month > 11) { month = 0; year++; }
    }
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
  }

  // ── Helpers ──

  function getDurFromEl(el) {
    const h = parseFloat(el.style.height);
    return Math.round((h / window.CAL.hourHeight) * 60);
  }

  function findColumnAt(x, y) {
    const columns = document.querySelectorAll(".cal-column");
    for (const col of columns) {
      const rect = col.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return col;
      }
    }
    return null;
  }

  function cleanup() {
    dragState = null;
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    if (dropIndicator) { dropIndicator.remove(); dropIndicator = null; }
    // Reset sidebar card opacity
    document.querySelectorAll(".cal-task-card").forEach(c => c.style.opacity = "");
  }

  function onDragEnd() {
    cleanup();
  }

  // Expose
  window.initCalendarDrag = initCalendarDrag;

})();
