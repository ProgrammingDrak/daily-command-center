// ======== ACTUAL TIME HELPERS ========
// Shared rules for matching recorded time (`time_entry` blocks, with a read-only
// fallback to legacy `_sessions`) to planned items, plus the manual Actual-time
// editor the List and Calendar Actual toggle open (window.editTimeEntries).
//
// This file used to also render the "Day review" planned-vs-actual panel. That
// panel was removed on 2026-11-27; the filename is kept because
// actual-projection.js and its tests load these helpers from here.
(function () {
  "use strict";

  function esc(s) { return escHtml(s); } // shared escaper in tag-manager.js
  function toMin(v) { return (typeof pt === "function") ? pt(v) : 0; }            // "HH:MM" / ISO / "9:00 AM" -> minutes
  function normTitle(t) { return String(t || "").trim().toLowerCase(); }

  // ── match a time_entry to a planned event ──
  function entryMatchesEvent(entryProps, ev) {
    if (!entryProps) return false;
    if (entryProps.allocationKind === "unknown") return false;
    if (entryProps.calendarEventId) return [ev.source_id, ev.gcal_event_id].includes(entryProps.calendarEventId);
    if (entryProps.source === "conversation-correction") return !!entryProps.blockId && [ev.id, ev._blockId, ev.meetingBlockId].includes(entryProps.blockId);
    if (entryProps.blockId) {
      if (entryProps.blockId === ev.id) return true;
      if (ev.meetingBlockId && entryProps.blockId === ev.meetingBlockId) return true;
    }
    if (entryProps.taskTitle && normTitle(entryProps.taskTitle) === normTitle(ev.title)) return true;
    return false;
  }

  // segments [{startMin|null, durMin, source}] for an event, from time_entry blocks
  // (preferred) with fallback to legacy _sessions.
  function actualSegmentsFor(ev, ctx) {
    const segs = [];
    for (const te of ctx.timeEntries) {
      const p = te.properties || {};
      if (!entryMatchesEvent(p, ev)) continue;
      const durMin = (p.durSec || 0) / 60;
      const startMin = p.start ? toMin(p.start) : null;
      segs.push({ startMin, durMin, source: p.source || "manual", _id: te.id, _entry: te });
    }
    if (segs.length) return segs;
    // Legacy fallbacks (read-only, no ids — not editable as time_entry)
    if (ev.actualMinutesFrom === "reallocated" || ev.actualTimeUnknown) return [];
    const sess = ctx.sessions[ev.id];
    if (Array.isArray(sess) && sess.length) {
      return sess.map(s => ({ startMin: s.start ? toMin(s.start) : null, durMin: s.durationMin || 0, source: "legacy", _id: null }));
    }
    return [];
  }

  function knownActualMinutes(model) {
    return model.rows.reduce((s, r) => s + r.actualMin, 0) + model.extras.filter(x => x.allocationKind !== "unknown").reduce((s, x) => s + x.min, 0);
  }

  // ── manual / retroactive time entry editor ──
  // Opens a small inline panel listing actual-time segments for a task on a date.
  // Add / edit / delete segments; saves them as source:"manual" time_entry blocks.
  function editTimeEntries(blockId, taskTitle, dateStr, anchorEl) {
    closeEditor();
    const bs = window.blockStore;
    if (!bs || !bs.getTimeEntries) { if (typeof showToast === "function") showToast("Time tracking unavailable", "error"); return; }
    const existing = bs.getTimeEntries(dateStr)
      .filter(te => {
        const p = te.properties || {};
        return p.source === "manual" && (p.blockId === blockId || (taskTitle && normTitle(p.taskTitle) === normTitle(taskTitle)));
      })
      .sort((a, b) => toMin((a.properties || {}).start) - toMin((b.properties || {}).start));

    const panel = document.createElement("div");
    panel.className = "dr-editor";
    panel.id = "dr-editor";

    function rowHtml(startHHMM, endHHMM, id) {
      return '<div class="dr-ed-row" data-id="' + esc(id || "") + '">' +
        '<input type="time" class="dr-ed-start" value="' + esc(startHHMM || "") + '">' +
        '<span class="dr-ed-dash">to</span>' +
        '<input type="time" class="dr-ed-end" value="' + esc(endHHMM || "") + '">' +
        '<button class="dr-ed-del" title="Remove segment">&times;</button>' +
      '</div>';
    }
    function isoToHHMM(iso) {
      if (!iso) return "";
      const m = toMin(iso);
      return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
    }

    const rowsHtml = existing.length
      ? existing.map(te => { const p = te.properties || {}; return rowHtml(isoToHHMM(p.start), isoToHHMM(p.end), te.id); }).join("")
      : rowHtml("", "", "");

    panel.innerHTML =
      '<div class="dr-ed-title">Actual time · ' + esc(taskTitle) + '</div>' +
      '<div class="dr-ed-rows">' + rowsHtml + '</div>' +
      '<button class="dr-ed-add">+ add segment</button>' +
      '<div class="dr-ed-actions">' +
        '<button class="dr-ed-cancel">Cancel</button>' +
        '<button class="dr-ed-save">Save</button>' +
      '</div>';

    panel.querySelector(".dr-ed-add").addEventListener("click", () => {
      const rows = panel.querySelector(".dr-ed-rows");
      const tmp = document.createElement("div"); tmp.innerHTML = rowHtml("", "", "");
      rows.appendChild(tmp.firstChild);
      bindDelButtons(panel);
    });
    bindDelButtons(panel);
    panel.querySelector(".dr-ed-cancel").addEventListener("click", closeEditor);
    panel.querySelector(".dr-ed-save").addEventListener("click", async () => {
      await saveSegments(panel, blockId, taskTitle, dateStr, existing);
      closeEditor(); // saveSegments fires dcc:actual-time-saved; the List/Calendar repaint on it
    });
    if (window.DCC && window.DCC.overlay) {
      _timeEditorHandle = window.DCC.overlay.open({
        kind: window.innerWidth <= 760 ? "sheet" : "drawer",
        title: "Actual time · " + taskTitle,
        body: panel,
        onClose: function() { _timeEditorHandle = null; }
      });
    } else {
      document.body.appendChild(panel);
      positionEditor(panel, anchorEl);
    }
  }

  function bindDelButtons(panel) {
    panel.querySelectorAll(".dr-ed-del").forEach(b => {
      b.onclick = () => { const row = b.closest(".dr-ed-row"); if (row) row.remove(); };
    });
  }
  let _timeEditorHandle = null;
  function closeEditor() {
    const handle = _timeEditorHandle;
    _timeEditorHandle = null;
    if (handle) handle.close("time-editor");
    const p = document.getElementById("dr-editor");
    if (p) p.remove();
  }
  function positionEditor(panel, anchorEl) {
    if (!anchorEl) { panel.style.cssText += "left:50%;top:120px;transform:translateX(-50%);"; return; }
    const r = anchorEl.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 240, r.bottom + 6);
    const left = Math.min(window.innerWidth - 280, Math.max(8, r.left));
    panel.style.left = left + "px";
    panel.style.top = (top + window.scrollY) + "px";
  }

  async function saveSegments(panel, blockId, taskTitle, dateStr, existing) {
    const bs = window.blockStore;
    const rows = [...panel.querySelectorAll(".dr-ed-row")];
    const kept = new Set();
    const ops = [];
    for (const row of rows) {
      const s = row.querySelector(".dr-ed-start").value;
      const en = row.querySelector(".dr-ed-end").value;
      const id = row.dataset.id;
      if (!s || !en) continue;
      let sMin = toMin(s), eMin = toMin(en);
      if (eMin <= sMin) eMin += 1440; // past-midnight
      const durSec = (eMin - sMin) * 60;
      const startIso = dateStr + "T" + s + ":00";
      const endIso = dateStr + "T" + en + ":00";
      if (id) {
        kept.add(id);
        const block = bs.get(id);
        const props = { ...(block ? block.properties : {}), blockId, taskTitle, start: startIso, end: endIso, durSec, source: "manual" };
        ops.push(bs.updateBlock(id, props));
      } else {
        ops.push(bs.logTimeEntry({ blockId, taskTitle, start: startIso, end: endIso, durSec, source: "manual", date: dateStr }));
      }
    }
    // delete removed
    for (const te of existing) { if (!kept.has(te.id)) ops.push(bs.deleteBlock(te.id)); }
    await Promise.all(ops);
    if (typeof showToast === "function") showToast("Actual time saved", "ok");
    // The List and Calendar Actual toggle re-read their evidence on this.
    document.dispatchEvent(new CustomEvent("dcc:actual-time-saved", { detail: { date: dateStr, blockId } }));
  }

  // expose
  if (typeof module === "object" && module.exports) module.exports = { entryMatchesEvent, actualSegmentsFor, knownActualMinutes };
  if (typeof window !== "undefined") {
    window.editTimeEntries = editTimeEntries;
    // The List and Calendar Actual toggle (actual-projection.js) reuses this rule.
    window.DCCDayReviewModel = { entryMatchesEvent, actualSegmentsFor, knownActualMinutes };
  }
})();
