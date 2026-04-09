// ======== CALENDAR OVERLAY ========
// Notion-like detail panel for events

(function () {
  "use strict";

  let currentOverlayId = null;
  let currentOverlayDate = null;

  function renderOverlayShell() {
    return `<div class="cal-overlay-bg" id="cal-overlay-bg" onclick="calCloseOverlay(event)">
      <div class="cal-overlay" onclick="event.stopPropagation()">
        <div class="cal-overlay-header">
          <button class="cal-overlay-close" onclick="calCloseOverlay()">&times;</button>
          <div class="cal-overlay-title" id="cal-overlay-title"></div>
        </div>
        <div class="cal-overlay-body" id="cal-overlay-body"></div>
      </div>
    </div>`;
  }

  async function calOpenOverlay(eventId, dateStr) {
    currentOverlayId = eventId;
    currentOverlayDate = dateStr;

    const overlay = document.getElementById("cal-overlay-bg");
    if (!overlay) return;

    const ev = findEvent(eventId, dateStr);
    if (!ev) return;

    overlay.classList.add("open");

    const titleEl = document.getElementById("cal-overlay-title");
    titleEl.textContent = ev.title || "Untitled";

    // Make title editable for GCal events
    if (ev.source === "gcal" && window.gcal) {
      titleEl.contentEditable = "true";
      titleEl.classList.add("gcal-editable");
      titleEl.addEventListener("blur", function () {
        const newTitle = this.textContent.trim();
        if (newTitle && newTitle !== ev.title) {
          window.gcal.updateEvent(ev.id, { title: newTitle }).then(() => {
            window.gcal.clearCache(ev.id);
          });
        }
      });
      titleEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); this.blur(); }
      });
    } else {
      titleEl.contentEditable = "false";
      titleEl.classList.remove("gcal-editable");
    }

    const body = document.getElementById("cal-overlay-body");
    body.innerHTML = renderOverlayContent(ev, dateStr);

    // Load GCal details asynchronously
    if (ev.source === "gcal" && window.gcal) {
      const details = await window.gcal.getCachedDetails(ev.id);
      if (details && currentOverlayId === eventId) {
        renderGcalSections(ev, dateStr, details);
      }
    }

    // Wire up notes editing
    const notesEl = document.getElementById("cal-overlay-notes-editor");
    if (notesEl) {
      notesEl.addEventListener("input", function () {
        saveOverlayNotes(eventId, dateStr, this.innerHTML, this.innerText);
      });
    }
  }

  function calCloseOverlay(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById("cal-overlay-bg");
    if (overlay) overlay.classList.remove("open");
    currentOverlayId = null;
    currentOverlayDate = null;
  }

  function findEvent(eventId, dateStr) {
    const events = window.calHelpers.getEventsForDate(dateStr);
    return events.find(e => e.id === eventId) || null;
  }

  function renderOverlayContent(ev, dateStr) {
    const tc = typeof cfg === "function" ? cfg(ev.type) : { tag: ev.type || "Task", color: "#a78bfa" };
    const startMins = window.calHelpers.toMinutes(ev.start);
    const endMins = window.calHelpers.toMinutes(ev.end);
    const durMins = endMins - startMins;

    // Properties
    let propsHTML = `<div class="cal-overlay-props">
      <div class="cal-prop-row">
        <div class="cal-prop-label">Type</div>
        <div class="cal-prop-value">
          <span class="tag ${tc.cls || ""}" style="background:${tc.color}20;color:${tc.color}">${tc.tag}</span>
        </div>
      </div>
      <div class="cal-prop-row">
        <div class="cal-prop-label">Time</div>
        <div class="cal-prop-value">${window.calHelpers.fmtTime12(startMins)} \u2013 ${window.calHelpers.fmtTime12(endMins)}</div>
      </div>
      <div class="cal-prop-row">
        <div class="cal-prop-label">Duration</div>
        <div class="cal-prop-value">${durMins >= 60 ? Math.floor(durMins / 60) + "h " : ""}${durMins % 60 ? (durMins % 60) + "m" : ""}</div>
      </div>
      <div class="cal-prop-row">
        <div class="cal-prop-label">Date</div>
        <div class="cal-prop-value">${formatDateLong(dateStr)}</div>
      </div>`;

    if (ev.priority) {
      const priColor = ev.priority === "High" ? "var(--red)" : ev.priority === "Medium" ? "var(--amber)" : "var(--green)";
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Priority</div>
        <div class="cal-prop-value" style="color:${priColor}">${ev.priority}</div>
      </div>`;
    }

    if (ev.source) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Source</div>
        <div class="cal-prop-value">${ev.source}</div>
      </div>`;
    }

    // GCal: Location
    if (ev.location) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Location</div>
        <div class="cal-prop-value">
          <a href="https://www.google.com/maps/search/${encodeURIComponent(ev.location)}" target="_blank" class="cal-prop-link">${ev.location}</a>
        </div>
      </div>`;
    }

    // GCal: Meet link — prominent button
    if (ev.hangout_link) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Meeting</div>
        <div class="cal-prop-value">
          <a href="${ev.hangout_link}" target="_blank" class="gcal-meet-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            Join Google Meet
          </a>
        </div>
      </div>`;
    }

    // GCal: RSVP status
    if (ev.source === "gcal" && ev.rsvp_status) {
      const rsvpColors = { accepted: "var(--green)", declined: "var(--red)", tentative: "var(--amber)", needsAction: "var(--text-muted)" };
      const rsvpLabels = { accepted: "Accepted", declined: "Declined", tentative: "Maybe", needsAction: "No response" };
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">RSVP</div>
        <div class="cal-prop-value" style="color:${rsvpColors[ev.rsvp_status] || "var(--text)"}">${rsvpLabels[ev.rsvp_status] || ev.rsvp_status}</div>
      </div>`;
    }

    // GCal: Recurring indicator
    if (ev.is_recurring) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Recurrence</div>
        <div class="cal-prop-value" style="color:var(--text-muted)">Recurring event</div>
      </div>`;
    }

    // Links section
    if (ev.calUrl) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Links</div>
        <div class="cal-prop-value">
          <a href="${ev.calUrl}" target="_blank" class="cal-prop-link">Google Calendar \u2197</a>
        </div>
      </div>`;
    }

    if (ev.notionUrl) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label"></div>
        <div class="cal-prop-value">
          <a href="${ev.notionUrl}" target="_blank" class="cal-prop-link">Notion \u2197</a>
        </div>
      </div>`;
    }

    if (ev.done) {
      propsHTML += `<div class="cal-prop-row">
        <div class="cal-prop-label">Status</div>
        <div class="cal-prop-value" style="color:var(--green)">Completed</div>
      </div>`;
    }

    propsHTML += "</div>";

    // GCal: RSVP Buttons (for GCal events)
    let rsvpButtonsHTML = "";
    if (ev.source === "gcal" && window.gcal) {
      rsvpButtonsHTML = `<div class="cal-overlay-section gcal-rsvp-section">
        <div class="cal-overlay-section-title">Your Response</div>
        <div class="gcal-rsvp-buttons">
          <button class="gcal-rsvp-btn${ev.rsvp_status === "accepted" ? " active" : ""}" data-response="accepted"
            onclick="gcalRSVP('${ev.id}','accepted')">Accept</button>
          <button class="gcal-rsvp-btn tentative${ev.rsvp_status === "tentative" ? " active" : ""}" data-response="tentative"
            onclick="gcalRSVP('${ev.id}','tentative')">Maybe</button>
          <button class="gcal-rsvp-btn decline${ev.rsvp_status === "declined" ? " active" : ""}" data-response="declined"
            onclick="gcalRSVP('${ev.id}','declined')">Decline</button>
        </div>
      </div>`;
    }

    // GCal: Attendees placeholder (filled asynchronously)
    let attendeesHTML = "";
    if (ev.source === "gcal") {
      attendeesHTML = `<div class="cal-overlay-section" id="gcal-attendees-section">
        <div class="cal-overlay-section-title">Attendees ${ev.attendee_count ? "(" + ev.attendee_count + ")" : ""}</div>
        <div id="gcal-attendees-list" class="gcal-attendees-list">
          <div style="font-size:11px;color:var(--text-muted)">Loading...</div>
        </div>
        <div class="gcal-add-attendee">
          <input type="email" id="gcal-add-attendee-input" placeholder="Add attendee email..."
            onkeydown="if(event.key==='Enter')gcalAddAttendee('${ev.id}')">
          <button onclick="gcalAddAttendee('${ev.id}')">Add</button>
        </div>
      </div>`;
    }

    // Detail / Description
    let detailHTML = "";
    if (ev.detail) {
      detailHTML = `<div class="cal-overlay-section">
        <div class="cal-overlay-section-title">Description</div>
        <div style="font-size:12px;color:var(--text);line-height:1.5">${ev.detail}</div>
      </div>`;
    }

    // Notes
    const notes = loadNotesForEvent(ev.id, dateStr);
    const notesContent = notes ? notes.html || "" : "";
    let notesHTML = `<div class="cal-overlay-section">
      <div class="cal-overlay-section-title">Notes</div>
      <div class="cal-overlay-toolbar">
        <button onmousedown="event.preventDefault();document.execCommand('bold')"><b>B</b></button>
        <button onmousedown="event.preventDefault();document.execCommand('italic')"><i>I</i></button>
        <button onmousedown="event.preventDefault();document.execCommand('underline')"><u>U</u></button>
        <button onmousedown="event.preventDefault();document.execCommand('insertUnorderedList')">&bull; List</button>
      </div>
      <div class="cal-overlay-notes" id="cal-overlay-notes-editor" contenteditable="true"
        data-placeholder="Add notes...">${notesContent}</div>
    </div>`;

    // Action Items
    const actions = loadActionsForEvent(ev.id, dateStr);
    let actionsHTML = `<div class="cal-overlay-section">
      <div class="cal-overlay-section-title">Action Items (${actions.length})</div>`;
    if (actions.length) {
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        actionsHTML += `<div class="cal-overlay-action-item">
          <div class="cal-overlay-ai-check${a.done ? " done" : ""}"
            onclick="calToggleAction('${ev.id}','${dateStr}',${i})">\u2713</div>
          <span class="cal-overlay-ai-text${a.done ? " done" : ""}">${a.text}</span>
          <span class="cal-overlay-ai-pri ${a.priority || "Medium"}">${a.priority || "Medium"}</span>
          <span style="cursor:pointer;color:var(--text-muted);font-size:14px" onclick="calDeleteAction('${ev.id}','${dateStr}',${i})">&times;</span>
        </div>`;
      }
    } else {
      actionsHTML += '<div style="font-size:11px;color:var(--text-muted)">No action items yet.</div>';
    }
    actionsHTML += `<button class="cal-overlay-add-btn" onclick="calAddAction('${ev.id}','${dateStr}')">
      + Add Action Item
    </button></div>`;

    // Subtasks
    const subtasks = loadSubtasksForEvent(ev.id, dateStr);
    let subtasksHTML = `<div class="cal-overlay-section">
      <div class="cal-overlay-section-title">Subtasks (${subtasks.length})</div>`;
    if (subtasks.length) {
      for (let i = 0; i < subtasks.length; i++) {
        const st = subtasks[i];
        subtasksHTML += `<div class="cal-overlay-subtask">
          <div class="cal-overlay-st-check${st.done ? " done" : ""}"
            onclick="calToggleSubtask('${ev.id}','${dateStr}',${i})">\u2713</div>
          <span class="cal-overlay-st-text${st.done ? " done" : ""}">${st.text}</span>
          <span style="cursor:pointer;color:var(--text-muted);font-size:12px" onclick="calDeleteSubtask('${ev.id}','${dateStr}',${i})">&times;</span>
        </div>`;
      }
    } else {
      subtasksHTML += '<div style="font-size:11px;color:var(--text-muted)">No subtasks.</div>';
    }
    subtasksHTML += `<button class="cal-overlay-add-btn" onclick="calAddSubtask('${ev.id}','${dateStr}')">
      + Add Subtask
    </button></div>`;

    // Comments
    const comments = loadCommentsForEvent(ev.id, dateStr);
    let commentsHTML = `<div class="cal-overlay-section">
      <div class="cal-overlay-section-title">Comments (${comments.length})</div>`;
    for (const c of comments) {
      commentsHTML += `<div class="cal-overlay-comment">
        <div class="cal-overlay-comment-meta">${formatRelativeTime(c.timestamp)}</div>
        <div class="cal-overlay-comment-text">${c.text}</div>
      </div>`;
    }
    commentsHTML += `<div class="cal-overlay-comment-input">
      <input type="text" id="cal-comment-input" placeholder="Add a comment..." onkeydown="if(event.key==='Enter')calSubmitComment('${ev.id}','${dateStr}')">
      <button onclick="calSubmitComment('${ev.id}','${dateStr}')">Post</button>
    </div></div>`;

    return propsHTML + rsvpButtonsHTML + attendeesHTML + detailHTML + notesHTML + actionsHTML + subtasksHTML + commentsHTML;
  }

  // ── Data Access (notes, actions, subtasks, comments) ──

  function loadNotesForEvent(eventId, dateStr) {
    // Try block store first
    if (window.blockStore) {
      const blocks = [...(window.blockStore._rangeCache.get(dateStr)?.blocks || [])];
      const note = blocks.find(b => b.type === "note" && b.parent_id === eventId);
      if (note) return note.properties;
    }
    // Fall back to localStorage
    try {
      const notes = JSON.parse(localStorage.getItem("pa-notes-" + dateStr) || "{}");
      return notes[eventId] || null;
    } catch { return null; }
  }

  function loadActionsForEvent(eventId, dateStr) {
    if (window.blockStore) {
      const blocks = window.blockStore._rangeCache.get(dateStr)?.blocks || [];
      return blocks
        .filter(b => ((b.type==="action_item"||b.type==="block")&&((b.properties||{}).tags||[]).includes("action-item")) && b.parent_id === eventId)
        .map(b => b.properties);
    }
    try {
      const actions = JSON.parse(localStorage.getItem("pa-actions-" + dateStr) || "{}");
      return actions[eventId] || [];
    } catch { return []; }
  }

  function loadSubtasksForEvent(eventId, dateStr) {
    if (window.blockStore) {
      const blocks = window.blockStore._rangeCache.get(dateStr)?.blocks || [];
      return blocks
        .filter(b => b.type === "subtask" && b.parent_id === eventId)
        .map(b => b.properties);
    }
    try {
      const subtasks = JSON.parse(localStorage.getItem("pa-subtasks-" + dateStr) || "{}");
      return subtasks[eventId] || [];
    } catch { return []; }
  }

  function loadCommentsForEvent(eventId, dateStr) {
    // Comments are stored in localStorage for now
    try {
      const comments = JSON.parse(localStorage.getItem("pa-comments-" + dateStr) || "{}");
      return comments[eventId] || [];
    } catch { return []; }
  }

  // ── Save Operations ──

  function saveOverlayNotes(eventId, dateStr, html, text) {
    if (window.blockStore) {
      const blocks = window.blockStore._rangeCache.get(dateStr)?.blocks || [];
      const existing = blocks.find(b => b.type === "note" && b.parent_id === eventId);
      if (existing) {
        window.blockStore.updateBlockDebounced(existing.id, { html, text, updatedAt: new Date().toISOString() });
      } else {
        window.blockStore.createBlock("block", { html, text, updatedAt: new Date().toISOString() }, { parentId: eventId, date: dateStr });
      }
    }
    // Also save to localStorage as fallback
    try {
      const notes = JSON.parse(localStorage.getItem("pa-notes-" + dateStr) || "{}");
      notes[eventId] = { html, text };
      localStorage.setItem("pa-notes-" + dateStr, JSON.stringify(notes));
    } catch {}
  }

  // ── Action Item Operations ──

  window.calToggleAction = function (eventId, dateStr, idx) {
    const actions = loadActionsForEvent(eventId, dateStr);
    if (actions[idx]) {
      actions[idx].done = !actions[idx].done;
      saveActions(eventId, dateStr, actions);
      refreshOverlay();
    }
  };

  window.calDeleteAction = function (eventId, dateStr, idx) {
    const actions = loadActionsForEvent(eventId, dateStr);
    actions.splice(idx, 1);
    saveActions(eventId, dateStr, actions);
    refreshOverlay();
  };

  window.calAddAction = function (eventId, dateStr) {
    const text = prompt("Action item text:");
    if (!text) return;
    const actions = loadActionsForEvent(eventId, dateStr);
    actions.push({ text, priority: "Medium", done: false, created: new Date().toISOString() });
    saveActions(eventId, dateStr, actions);
    refreshOverlay();
  };

  function saveActions(eventId, dateStr, actions) {
    try {
      const all = JSON.parse(localStorage.getItem("pa-actions-" + dateStr) || "{}");
      all[eventId] = actions;
      localStorage.setItem("pa-actions-" + dateStr, JSON.stringify(all));
    } catch {}
  }

  // ── Subtask Operations ──

  window.calToggleSubtask = function (eventId, dateStr, idx) {
    const subtasks = loadSubtasksForEvent(eventId, dateStr);
    if (subtasks[idx]) {
      subtasks[idx].done = !subtasks[idx].done;
      saveSubtasks(eventId, dateStr, subtasks);
      refreshOverlay();
    }
  };

  window.calDeleteSubtask = function (eventId, dateStr, idx) {
    const subtasks = loadSubtasksForEvent(eventId, dateStr);
    subtasks.splice(idx, 1);
    saveSubtasks(eventId, dateStr, subtasks);
    refreshOverlay();
  };

  window.calAddSubtask = function (eventId, dateStr) {
    const text = prompt("Subtask text:");
    if (!text) return;
    const subtasks = loadSubtasksForEvent(eventId, dateStr);
    subtasks.push({ text, done: false });
    saveSubtasks(eventId, dateStr, subtasks);
    refreshOverlay();
  };

  function saveSubtasks(eventId, dateStr, subtasks) {
    try {
      const all = JSON.parse(localStorage.getItem("pa-subtasks-" + dateStr) || "{}");
      all[eventId] = subtasks;
      localStorage.setItem("pa-subtasks-" + dateStr, JSON.stringify(all));
    } catch {}
  }

  // ── Comment Operations ──

  window.calSubmitComment = function (eventId, dateStr) {
    const input = document.getElementById("cal-comment-input");
    if (!input || !input.value.trim()) return;
    const comments = loadCommentsForEvent(eventId, dateStr);
    comments.push({ text: input.value.trim(), timestamp: new Date().toISOString() });
    try {
      const all = JSON.parse(localStorage.getItem("pa-comments-" + dateStr) || "{}");
      all[eventId] = comments;
      localStorage.setItem("pa-comments-" + dateStr, JSON.stringify(all));
    } catch {}
    refreshOverlay();
  };

  function refreshOverlay() {
    if (currentOverlayId && currentOverlayDate) {
      const ev = findEvent(currentOverlayId, currentOverlayDate);
      if (ev) {
        const body = document.getElementById("cal-overlay-body");
        if (body) body.innerHTML = renderOverlayContent(ev, currentOverlayDate);
        // Re-wire notes
        const notesEl = document.getElementById("cal-overlay-notes-editor");
        if (notesEl) {
          notesEl.addEventListener("input", function () {
            saveOverlayNotes(currentOverlayId, currentOverlayDate, this.innerHTML, this.innerText);
          });
        }
      }
    }
  }

  // ── Helpers ──

  function formatDateLong(ds) {
    const d = new Date(ds + "T12:00:00");
    const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    return DOW[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    const days = Math.floor(hours / 24);
    return days + "d ago";
  }

  // ── GCal: Render Attendees (async, after initial render) ──

  function renderGcalSections(ev, dateStr, details) {
    const listEl = document.getElementById("gcal-attendees-list");
    if (!listEl || !details || !details.gcal) return;

    const attendees = details.gcal.attendees || [];
    const organizer = details.gcal.organizer;

    if (!attendees.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No attendees</div>';
      return;
    }

    let html = "";
    for (const a of attendees) {
      const rsvpDot = {
        accepted: "var(--green)",
        declined: "var(--red)",
        tentative: "var(--amber)",
        needsAction: "var(--text-muted)",
      };
      const dotColor = rsvpDot[a.responseStatus] || "var(--text-muted)";
      const isOrg = organizer && a.email === organizer.email;
      const displayName = a.displayName || a.email.split("@")[0];
      const selfBadge = a.self ? ' <span style="font-size:9px;color:var(--accent)">(you)</span>' : "";
      const orgBadge = isOrg ? ' <span style="font-size:9px;color:var(--text-muted)">(organizer)</span>' : "";

      html += `<div class="gcal-attendee">
        <span class="gcal-attendee-dot" style="background:${dotColor}"></span>
        <span class="gcal-attendee-name">${displayName}${selfBadge}${orgBadge}</span>
        <span class="gcal-attendee-email">${a.email}</span>
        ${!a.self && !a.organizer ? `<span class="gcal-attendee-remove" onclick="gcalRemoveAttendee('${ev.id}','${a.email}')" title="Remove">&times;</span>` : ""}
      </div>`;
    }

    listEl.innerHTML = html;

    // Update attendee count in section title
    const section = document.getElementById("gcal-attendees-section");
    if (section) {
      const titleEl = section.querySelector(".cal-overlay-section-title");
      if (titleEl) titleEl.textContent = `Attendees (${attendees.length})`;
    }
  }

  // ── GCal Actions (global handlers) ──

  window.gcalRSVP = async function (blockId, response) {
    if (!window.gcal) return;
    // Optimistic UI update
    document.querySelectorAll(".gcal-rsvp-btn").forEach((btn) => btn.classList.remove("active"));
    const activeBtn = document.querySelector(`.gcal-rsvp-btn[data-response="${response}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    await window.gcal.rsvp(blockId, response);
    window.gcal.clearCache(blockId);
    // Refresh overlay
    if (currentOverlayId === blockId) {
      calOpenOverlay(blockId, currentOverlayDate);
    }
  };

  window.gcalAddAttendee = async function (blockId) {
    const input = document.getElementById("gcal-add-attendee-input");
    if (!input || !input.value.trim()) return;
    const email = input.value.trim();
    input.value = "";
    input.disabled = true;

    try {
      await window.gcal.addAttendee(blockId, email);
      window.gcal.clearCache(blockId);
      if (currentOverlayId === blockId) {
        const details = await window.gcal.getCachedDetails(blockId);
        const ev = findEvent(blockId, currentOverlayDate);
        if (details && ev) renderGcalSections(ev, currentOverlayDate, details);
      }
    } catch (e) {
      console.error("Failed to add attendee:", e);
    } finally {
      input.disabled = false;
    }
  };

  window.gcalRemoveAttendee = async function (blockId, email) {
    if (!confirm(`Remove ${email} from this event?`)) return;
    try {
      await window.gcal.removeAttendee(blockId, email);
      window.gcal.clearCache(blockId);
      if (currentOverlayId === blockId) {
        const details = await window.gcal.getCachedDetails(blockId);
        const ev = findEvent(blockId, currentOverlayDate);
        if (details && ev) renderGcalSections(ev, currentOverlayDate, details);
      }
    } catch (e) {
      console.error("Failed to remove attendee:", e);
    }
  };

  // ── GCal: Create Event from Calendar ──

  window.gcalCreateEventPrompt = async function (dateStr, startTime) {
    if (!window.gcal) return;
    const status = await window.gcal.status();
    if (!status.connected) {
      alert("Connect Google Calendar first (visit Settings)");
      return;
    }

    const title = prompt("Event title:");
    if (!title) return;

    const calendars = await window.gcal.getCalendars();
    const selected = calendars.filter(c => c.selected);
    const calendarId = selected.length === 1
      ? selected[0].id
      : (selected.find(c => c.is_primary) || selected[0])?.id;

    if (!calendarId) {
      alert("No calendar selected");
      return;
    }

    const endMins = (parseInt(startTime.split(":")[0]) * 60 + parseInt(startTime.split(":")[1] || 0)) + 30;
    const endTime = String(Math.floor(endMins / 60)).padStart(2, "0") + ":" + String(endMins % 60).padStart(2, "0");

    await window.gcal.createEvent({
      calendarId,
      title,
      date: dateStr,
      start: startTime,
      end: endTime,
    });

    // Rebuild calendar
    if (typeof buildCalendar === "function") buildCalendar();
  };

  // Expose
  window.renderOverlayShell = renderOverlayShell;
  window.calOpenOverlay = calOpenOverlay;
  window.calCloseOverlay = calCloseOverlay;

})();
