// ======== MORNING CATCH-UP ========
// One prompt, on the first load of a new day: here's what slipped, clear it in a
// single pass. Move each row to today or tomorrow, send it to the backlog, or drop
// it — and "Move all to today" for the whole list at once.
//
// Replaces carryover-review.js, which looked like this feature and wasn't:
//   • "For Today" minted a brand-new task id and never touched the origin, so the
//     task existed twice and came back the next morning
//   • "To Backlog" did the same into the backlog
//   • Drop (actDrop) was a single log line — it deleted NOTHING
//   • it read one day (the most recent archive) off /api/state/day's timeline
//   • "reviewed" lived in localStorage, so a second device re-prompted
// Every action here is a real write through DCC.Carryover (unfinished-tasks.js) —
// the same implementation the itinerary's Unfinished lane and the Catch up modal
// use, subtree included. The reviewed flag lives on today's day_root, so the
// prompt is once per DAY, not once per browser.
//
// Rows left un-actioned are left ALONE: they stay on their origin date and remain
// in the bounded Unfinished lane. Nothing is rewritten behind the user's back.
(function () {
  "use strict";

  const FLAG = "_catchUpReviewed";
  // The footer's "Move all" handler, held so a second open can unbind the first.
  // ensureModal() reuses one overlay forever and close() only drops the `open` class,
  // so every openPrompt call re-binds this button. {once:true} de-registers a handler
  // only after it FIRES, so an unclicked one stays live: morning prompt, close it,
  // sweep arrives, click "Move all" -> both handlers run over their own captured pools,
  // double-moving rows and fighting over the button's label. Harmless while openPrompt
  // ran once per load; openArrivals is the second entry that made it reachable.
  let _allHandler = null;

  function reviewed() {
    if (typeof _bsProp !== "function") return true;   // no day_root yet: don't prompt blind
    return !!_bsProp(FLAG, null);
  }
  function markReviewed() {
    if (typeof _bsSaveProp === "function") _bsSaveProp(FLAG, new Date().toISOString());
  }

  function esc(s) { return (typeof escHtml === "function") ? escHtml(s) : String(s == null ? "" : s); }
  function prettyDate(iso) {
    const CO = window.DCC && window.DCC.Carryover;
    if (CO && typeof CO.prettyDate === "function") return CO.prettyDate(iso);
    return iso;
  }
  // state.js owns these two (_resolvedTodayDate / _resolvedTomorrowDate) with exactly
  // these semantics, and every other "move it to today / tomorrow" affordance in the
  // app resolves through them. state.js loads well before this file, so prefer the
  // canonical pair; the inline fallbacks only exist if load order ever changes. Note
  // the local fallback below is UTC while the canonical helper is local-time, so a
  // copy could disagree by a day in the evening -- another reason to defer.
  function todayStr() {
    if (typeof _resolvedTodayDate === "function") return _resolvedTodayDate();
    if (typeof __todayDate === "string" && __todayDate) return __todayDate;
    return new Date().toISOString().slice(0, 10);
  }
  function tomorrowStr() {
    if (typeof _resolvedTomorrowDate === "function") return _resolvedTomorrowDate();
    if (typeof __tomorrowDate !== "undefined" && __tomorrowDate) return __tomorrowDate;
    const d = new Date(Date.now() + 86400000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Both predicates come from DCC.Carryover, the same place the projection and the
  // actions do. They used to be local copies here, which is how "this prompt has to
  // agree with the lane" became a comment instead of an invariant: the lane spelled
  // the parent edge with state.js's canonical parentIdOf and this file inlined
  // wrapId||subtaskOf. Two spellings of one rule, disagreeing on day one.
  //   openRows -> drop rows already finished on their origin day. The collector keeps
  //     done CHILDREN in the pool so a parent's "2/5 subtasks" can count them, so
  //     every surface that offers WORK has to filter them or it offers a task you
  //     already finished.
  //   rootsOf  -> only roots get a row; a child follows its parent through every
  //     action, so listing both double-counts. Computed over the open rows, so a
  //     child orphaned by a finished parent stays actionable.
  function openOf(pool) { return window.DCC.Carryover.openRows(pool); }
  function rootsOf(pool) { return window.DCC.Carryover.rootsOf(pool); }

  // ── the row-level calendar button ──
  // Same glyph and same class as the itinerary rows' reschedule control, wired to
  // the same anchored day picker. The big Today / Tomorrow / Drop buttons stay;
  // this reaches any OTHER day without leaving the modal. Rows here aren't entries
  // in scheduled[], so the picker runs in its date-only "pick" mode and the caller
  // owns the write (see DCC.wireDateButton in core.js).
  function calBtn(cls, label) { return window.DCC.dateButtonHtml(cls, label); }
  function wireCal(btn, title, onPick) {
    // Raw title: the popover escapes the whole header itself (schedule-popover.js), so
    // escaping here too renders a literal &#39; for any apostrophe.
    window.DCC.wireDateButton(btn, { header: 'Move "' + title + '" to…', actionLabel: "Move", onPick: onPick });
  }

  // ── triage rows ──
  // Swept items (Slack mentions, mail needing a reply) ride in this same modal:
  // the morning recap covers everything waiting on Drake, whether it slipped off
  // yesterday or arrived thirty seconds ago. They are NOT blocks, so none of the
  // DCC.Carryover actions apply — scheduling one CREATES a task on the chosen day
  // (triage.js scheduleTriageOnDate, which routes through the app's canonical
  // scheduleTaskOnDate) and dropping one deletes the triage item itself
  // (deleteTriageItem: durable day-state write, with Undo).
  // No Backlog spoke: a triage item has no dateless block form to become.
  function activeTriage() {
    if (typeof activeTriageItems !== "function") return [];
    try { return activeTriageItems() || []; } catch (e) { return []; }
  }
  function triageAge(item) {
    const iso = item && (item.first_seen_at || item.created_at);
    if (!iso) return "";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!isFinite(days)) return "";
    return days < 1 ? "today" : (days + "d old");
  }
  function triageMeta(item) {
    return [
      item.source || item.type || "triage",
      (typeof triagePriorityLabel === "function") ? triagePriorityLabel(item.priority) : item.priority,
      triageAge(item)
    ].filter(Boolean).join(" · ");
  }

  // ── meeting follow-ups ──
  // Recap actions are durable child blocks, intentionally excluded from ordinary
  // task and carryover queries until Drake approves one. This read model keeps
  // that approval boundary while making the proposals visible beside Sweep triage.
  async function loadMeetingActions() {
    if (typeof fetch !== "function") return [];
    try {
      const res = await fetch("/api/meetings/actions/proposed");
      const body = await res.json();
      return res.ok && Array.isArray(body.items) ? body.items : [];
    } catch (e) { return []; }
  }
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }
  async function placeMeetingAction(item, date) {
    try {
      const url = "/api/meetings/" + encodeURIComponent(item.meetingId) + "/actions/" +
        encodeURIComponent(item.id) + "/schedule";
      await postJson(url, { date: date });
      return true;
    } catch (e) {
      if (typeof showToast === "function") showToast(e.message || "Could not schedule meeting follow-up", "error");
      return false;
    }
  }
  async function dismissMeetingAction(item) {
    try {
      await postJson(
        "/api/meetings/" + encodeURIComponent(item.meetingId) + "/actions/" + encodeURIComponent(item.id) + "/dismiss",
        {}
      );
      return true;
    } catch (e) {
      if (typeof showToast === "function") showToast(e.message || "Could not dismiss meeting follow-up", "error");
      return false;
    }
  }

  // ── modal (reuses the .carryover-* CSS) ──
  function ensureModal() {
    let overlay = document.getElementById("catchup-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "carryover-overlay";
    overlay.id = "catchup-overlay";
    overlay.innerHTML =
      '<div class="carryover">' +
        '<div class="carryover-hdr">' +
          '<h3 id="catchup-title">Catch up</h3>' +
          '<button class="pvb-close" id="catchup-close">&times;</button>' +
        '</div>' +
        '<div class="carryover-body">' +
          '<div class="carryover-hint" id="catchup-hint"></div>' +
          '<div class="carryover-list" id="catchup-list"></div>' +
        '</div>' +
        '<div class="carryover-footer">' +
          '<button class="carryover-btn carryover-btn-schedule" id="catchup-all">Move all to today</button>' +
          '<button class="carryover-skip" id="catchup-skip">Leave them</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#catchup-close").addEventListener("click", close);
    overlay.querySelector("#catchup-skip").addEventListener("click", close);
    return overlay;
  }

  // Closing IS the answer "leave the rest where they are" — mark the day reviewed
  // so the prompt doesn't nag twice, and let the lane carry the remainder.
  function close() {
    const overlay = document.getElementById("catchup-overlay");
    if (overlay) overlay.classList.remove("open");
    markReviewed();
    if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
    if (typeof render === "function") render();
  }

  function openPrompt(pool, total, cfg) {
    cfg = cfg || {};
    const CO = window.DCC.Carryover;
    const overlay = ensureModal();
    const roots = rootsOf(pool);
    const triage = cfg.triage || [];
    const olderTriage = cfg.olderTriage || [];
    const meetingActions = cfg.meetingActions || [];
    const hintEl = overlay.querySelector("#catchup-hint");
    const listEl = overlay.querySelector("#catchup-list");
    const allBtn = overlay.querySelector("#catchup-all");
    overlay.querySelector("#catchup-title").textContent = cfg.title || "Here's what slipped";
    // `total` is the collector's count of OPEN rows before the MAX_ROWS cap, so it
    // has to be compared against the open rows we actually have — not the whole
    // pool, which carries done children too and made this branch unreachable.
    const openCount = openOf(pool).length;
    const taskPhrase = roots.length + " unfinished task" + (roots.length === 1 ? "" : "s") +
      " from the last two weeks" + (total > openCount ? " (showing " + openCount + " of " + total + ")" : "");
    const triagePhrase = triage.length + " Sweep item" + (triage.length === 1 ? "" : "s") + " waiting";
    const meetingPhrase = meetingActions.length + " meeting follow-up" + (meetingActions.length === 1 ? "" : "s");
    const phrases = [];
    if (triage.length) phrases.push(triagePhrase);
    if (meetingActions.length) phrases.push(meetingPhrase);
    if (roots.length) phrases.push(taskPhrase);
    hintEl.textContent = phrases.join(phrases.length > 2 ? ", " : " and ") +
      " — move what still matters, drop what doesn't. Anything you leave stays where it is.";
    listEl.innerHTML = "";

    const rowEls = new Map();   // unfinished rows, keyed by ev.id
    const triEls = new Map();   // triage rows, keyed by triage item id
    const meetingEls = new Map(); // recap proposals, keyed by proposed-action id
    let detailSeq = 0;
    // Closing on the last row is the same courtesy either list gives: once there is
    // nothing left to answer, the modal has no reason to sit there. An unexpanded
    // "older waiting" line still counts as something to answer — closing over it
    // would hide the queue it exists to advertise.
    let olderPending = olderTriage.length > 0;
    const closeIfDrained = () => { if (!rowEls.size && !triEls.size && !meetingEls.size && !olderPending) close(); };
    const settle = (res, focusRow) => {
      if (!res) return false;
      const orderedRows = Array.from(rowEls.values());
      const restoreIndex = focusRow ? orderedRows.indexOf(focusRow) : -1;
      (res.removed || []).forEach(id => {
        const el = rowEls.get(id);
        if (!el) return;
        el.remove();
        rowEls.delete(id);
      });
      closeIfDrained();
      // Removing the focused completion button otherwise drops keyboard users back
      // onto the document. Keep their place in the review whenever another row remains.
      if (restoreIndex >= 0) {
        const remaining = new Set(rowEls.values());
        const next = orderedRows.slice(restoreIndex + 1).find(row => remaining.has(row));
        const previous = orderedRows.slice(0, restoreIndex).reverse().find(row => remaining.has(row));
        const target = (next || previous)?.querySelector(".cu-complete")
          || document.getElementById("dcc-launcher-btn");
        if (target && typeof target.focus === "function") target.focus();
      }
      return true;
    };
    // Labels appear when more than one source is present. That preserves the compact
    // one-lane prompt while giving Sweep triage, meeting actions, and slipped tasks
    // their own sections whenever they share the modal.
    const sectionCount = Number(!!triage.length) + Number(!!meetingActions.length) + Number(!!roots.length);
    const label = (text) => {
      if (sectionCount < 2) return;
      const el = document.createElement("div");
      el.className = "cu-section-label";
      el.textContent = text;
      listEl.appendChild(el);
    };

    if (triage.length) label("Email and Slack");
    const addTriageRow = (item, before) => {
      const el = document.createElement("div");
      el.className = "carryover-row";
      const safe = (window.DCC && window.DCC.safeUrl) || (u => "");
      const href = safe(item.draft_link || item.draft_url) || safe(item.link || item.source_url);
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<div class="carryover-row-title"></div>' +
            calBtn("cu-cal", "Schedule on a day") +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(triageMeta(item)) +
            (href ? ' · <a class="cu-tri-link" href="' + esc(href) + '" target="_blank" rel="noopener">Open</a>' : '') +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          '<button class="carryover-btn carryover-btn-schedule cu-tri-today">Today</button>' +
          '<button class="carryover-btn carryover-btn-schedule cu-tri-tomorrow">Tomorrow</button>' +
          '<button class="carryover-btn carryover-btn-drop cu-tri-drop">Drop</button>' +
        '</div>';
      el.querySelector(".carryover-row-title").textContent = item.title || "Untitled";
      const busy = (on) => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const forget = () => { el.remove(); triEls.delete(item.id); closeIfDrained(); };
      // A refused schedule (no free slot, already on the day) leaves the row alone
      // and re-enables it, same contract the task rows use.
      const runTri = async (fn) => { busy(true); if (await fn()) forget(); else busy(false); };
      const place = (d2) => runTri(async () => {
        if (typeof scheduleTriageOnDate !== "function") return false;
        return !!(await scheduleTriageOnDate(item.id, d2));
      });
      el.querySelector(".cu-tri-today").addEventListener("click", () => place(todayStr()));
      el.querySelector(".cu-tri-tomorrow").addEventListener("click", () => place(tomorrowStr()));
      el.querySelector(".cu-tri-drop").addEventListener("click", () => {
        if (typeof deleteTriageItem !== "function") return;
        deleteTriageItem(item.id);   // durable + its own 8s Undo toast
        forget();
      });
      wireCal(el.querySelector(".cu-cal"), item.title || "Untitled", place);
      triEls.set(item.id, el);
      // `before` keeps expanded older items INSIDE the triage group. Appending them
      // instead dropped them below the Slipped section, orphaned from their heading.
      if (before && typeof listEl.insertBefore === "function") listEl.insertBefore(el, before);
      else listEl.appendChild(el);
    };
    triage.forEach(i => addTriageRow(i));

    // Older triage is deliberately not listed when the pet just delivered: the
    // envelope holds what arrived, not the whole queue. One line says the rest
    // exists, and clicking it appends them in place — re-opening the modal would
    // re-bind the footer's "Move all" and run it twice per click.
    if (olderTriage.length) {
      const more = document.createElement("button");
      more.className = "carryover-skip cu-tri-older";
      more.textContent = "…and " + olderTriage.length + " older waiting";
      more.addEventListener("click", () => {
        olderPending = false;
        olderTriage.forEach(i => addTriageRow(i, more));   // above the line, then drop it
        more.remove();
      });
      listEl.appendChild(more);
    }

    if (meetingActions.length) label("Meeting follow-ups");
    meetingActions.forEach(item => {
      const el = document.createElement("div");
      const mine = item.owner !== "other";
      el.className = "carryover-row cu-meeting-row";
      el.innerHTML =
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<div class="carryover-row-title"></div>' +
            (mine ? calBtn("cu-cal", "Schedule on a day") : "") +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(item.meetingTitle || "Meeting") +
            (item.meetingDate ? " · " + esc(prettyDate(item.meetingDate)) : "") +
            " · " + esc(item.priority || "Medium") +
            (mine ? "" : " · delegated") +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          (mine ? '<button class="carryover-btn carryover-btn-schedule cu-mtg-today">Today</button>' +
            '<button class="carryover-btn carryover-btn-schedule cu-mtg-tomorrow">Tomorrow</button>' : "") +
          '<button class="carryover-btn cu-mtg-recap">Recap</button>' +
          '<button class="carryover-btn carryover-btn-drop cu-mtg-drop">Dismiss</button>' +
        '</div>';
      el.querySelector(".carryover-row-title").textContent = item.title || "Meeting follow-up";
      const busy = on => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const forget = () => { el.remove(); meetingEls.delete(item.id); closeIfDrained(); };
      const runMeeting = async fn => { busy(true); if (await fn()) forget(); else busy(false); };
      const place = date => runMeeting(() => placeMeetingAction(item, date));
      if (mine) {
        el.querySelector(".cu-mtg-today").addEventListener("click", () => place(todayStr()));
        el.querySelector(".cu-mtg-tomorrow").addEventListener("click", () => place(tomorrowStr()));
        wireCal(el.querySelector(".cu-cal"), item.title || "Meeting follow-up", place);
      }
      el.querySelector(".cu-mtg-recap").addEventListener("click", () => {
        if (typeof openPrepModal === "function") openPrepModal({
          id: item.meetingId, meetingBlockId: item.meetingId,
          title: item.meetingTitle || "Meeting", start: item.meetingStart, end: item.meetingEnd
        }, { defaultTab: "recap" });
      });
      el.querySelector(".cu-mtg-drop").addEventListener("click", () => runMeeting(() => dismissMeetingAction(item)));
      meetingEls.set(item.id, el);
      listEl.appendChild(el);
    });

    if (roots.length) label("Slipped");
    roots.forEach(ev => {
      const el = document.createElement("div");
      const kids = CO.descendants(ev, pool).length;
      const d = (typeof dur === "function") ? Math.max(0, dur(ev)) : 0;
      const durLabel = d > 0 ? ((typeof ms === "function") ? ms(d) : d + "m") : "step";
      const title = ev.title || "Untitled";
      const detailId = "cu-task-details-" + (++detailSeq);
      el.className = "carryover-row cu-task-row";
      el.innerHTML =
        '<button type="button" class="cu-complete" aria-label="' + esc("Mark complete: " + title) + '" title="Mark complete">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>' +
        '</button>' +
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<button type="button" class="cu-details-toggle" aria-expanded="false" aria-controls="' + detailId + '">' +
              '<span class="carryover-row-title"></span>' +
              '<svg class="cu-details-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' +
            '</button>' +
            calBtn("cu-cal", "Move to a day") +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(durLabel) +
            (kids ? " · +" + kids + " nested" : "") +
            ' · from ' + esc(prettyDate((ev.__unf || {}).sourceDate)) +
          '</div>' +
        '</div>' +
        '<div class="carryover-row-actions">' +
          '<button class="carryover-btn carryover-btn-schedule cu-today">Today</button>' +
          '<button class="carryover-btn carryover-btn-schedule cu-tomorrow">Tomorrow</button>' +
          '<button class="carryover-btn cu-backlog">Backlog</button>' +
          '<button class="carryover-btn carryover-btn-drop cu-drop">Drop</button>' +
        '</div>' +
        '<div class="cu-details" id="' + detailId + '" role="region" aria-label="Task notes and details" hidden>' +
          '<div class="cu-details-full-title"></div>' +
          '<div class="cu-details-body" aria-live="polite">Loading details…</div>' +
        '</div>';
      const titleEl = el.querySelector(".carryover-row-title");
      const toggleEl = el.querySelector(".cu-details-toggle");
      const detailEl = el.querySelector(".cu-details");
      const detailBody = el.querySelector(".cu-details-body");
      detailEl.hidden = true;
      titleEl.textContent = title;
      titleEl.title = title;
      toggleEl.setAttribute("aria-label", "Show notes and details for " + title);
      el.querySelector(".cu-details-full-title").textContent = title;

      let detailLoaded = false;
      const renderDetailSection = (labelText, values) => {
        const section = document.createElement("div");
        section.className = "cu-details-section";
        const labelEl = document.createElement("div");
        labelEl.className = "cu-details-label";
        labelEl.textContent = labelText;
        const textEl = document.createElement("div");
        textEl.className = "cu-details-text";
        textEl.textContent = values.join("\n\n");
        section.appendChild(labelEl);
        section.appendChild(textEl);
        detailBody.appendChild(section);
      };
      const openDetails = async (opening) => {
        detailEl.hidden = !opening;
        toggleEl.setAttribute("aria-expanded", opening ? "true" : "false");
        toggleEl.setAttribute("aria-label", (opening ? "Hide" : "Show") + " notes and details for " + title);
        el.classList[opening ? "add" : "remove"]("details-open");
        if (!opening || detailLoaded) return;
        detailLoaded = true;
        detailBody.textContent = "Loading details…";
        try {
          const payload = (typeof CO.loadDetails === "function")
            ? await CO.loadDetails(ev)
            : { details: [ev.detail].filter(Boolean), notes: [ev.notes].filter(Boolean) };
          detailBody.textContent = "";
          detailBody.innerHTML = "";
          const details = (payload && Array.isArray(payload.details)) ? payload.details : [];
          const notes = (payload && Array.isArray(payload.notes)) ? payload.notes : [];
          if (details.length) renderDetailSection("Details", details);
          if (notes.length) renderDetailSection("Notes", notes);
          if (!details.length && !notes.length) detailBody.textContent = "No notes or details on this task.";
        } catch (e) {
          detailBody.textContent = "Could not load this task's details.";
          detailLoaded = false;
        }
      };
      const toggleDetails = () => openDetails(detailEl.hidden);
      toggleEl.addEventListener("click", toggleDetails);

      const busy = (on) => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      // Capture this row BEFORE disabling its buttons. Browsers move focus off a
      // disabled control immediately, so inspecting document.activeElement after
      // the async write returns is already too late to restore keyboard position.
      const run = async (fn) => { busy(true); if (!settle(await fn(), el)) busy(false); };
      el.querySelector(".cu-complete").addEventListener("click", e => {
        e.stopPropagation();
        run(() => CO.complete(ev, pool));
      });
      el.querySelector(".cu-today").addEventListener("click", () => run(() => CO.moveTo(ev, todayStr(), { pool })));
      el.querySelector(".cu-tomorrow").addEventListener("click", () => run(() => CO.moveTo(ev, tomorrowStr(), { pool })));
      el.querySelector(".cu-backlog").addEventListener("click", () => run(() => CO.toBacklog(ev, pool)));
      el.querySelector(".cu-drop").addEventListener("click", () => run(() => CO.drop(ev, pool)));
      // The calendar pick lands in the SAME mover the day buttons use — one write
      // path, so an arbitrary day can't behave differently from Today.
      wireCal(el.querySelector(".cu-cal"), title, (d2) => run(() => CO.moveTo(ev, d2, { pool })));
      rowEls.set(ev.id, el);
      listEl.appendChild(el);
    });


    // Move all: one row at a time on purpose. Each move is a server transaction and
    // the placement engine has to see the previous landing to pick the next slot.
    // Triage rows come along — the button says "all", and a swept item that needs a
    // reply today is exactly the kind of thing this button is for.
    if (_allHandler && typeof allBtn.removeEventListener === "function") {
      allBtn.removeEventListener("click", _allHandler);
    }
    _allHandler = async () => {
      _allHandler = null;                 // {once:true} already unbound it
      allBtn.disabled = true;
      const original = allBtn.textContent;
      const queue = [...rowEls.keys()];
      const triQueue = [...triEls.keys()];
      const meetingQueue = meetingActions.filter(item => item.owner !== "other" && meetingEls.has(item.id));
      const step = (n) => { allBtn.textContent = "Moving " + n + " of " + (queue.length + triQueue.length + meetingQueue.length) + "…"; };
      let moved = 0;
      const target = todayStr();
      for (const id of queue) {
        const ev = pool.find(x => x.id === id);
        if (!ev) continue;
        step(moved + 1);
        // deferRefold: every row here lands on the day being viewed, so the per-row
        // refold fired N times and only the last was observable. One at the end.
        if (settle(await CO.moveTo(ev, target, { pool, deferRefold: true }))) moved++;
      }
      let placed = 0;
      for (const id of triQueue) {
        step(moved + placed + 1);
        if (typeof scheduleTriageOnDate !== "function") break;
        // Same deferral the task loop above gets, for the same reason: each call
        // otherwise re-fetches the day context, re-loads the day, and runs a full
        // unscoped render, undoing the one batched refold N times over. silent so the
        // per-item toasts don't bury the summary one.
        if (await scheduleTriageOnDate(id, target, { deferRefold: true, silent: true })) placed++;
      }
      let meetingPlaced = 0;
      for (const item of meetingQueue) {
        step(moved + placed + meetingPlaced + 1);
        if (await placeMeetingAction(item, target)) meetingPlaced++;
      }
      // One refold for the whole batch, after BOTH loops have written.
      if (moved || placed || meetingPlaced) await CO.refoldViewedDay(target);
      if (placed) {
        if (typeof buildScheduleTriage === "function") buildScheduleTriage();
        if (typeof buildTriage === "function") buildTriage();
      }
      allBtn.textContent = original;
      allBtn.disabled = false;
      close();
      const parts = [];
      if (moved) parts.push(moved + " unfinished task" + (moved === 1 ? "" : "s"));
      if (placed) parts.push(placed + " triage item" + (placed === 1 ? "" : "s"));
      if (meetingPlaced) parts.push(meetingPlaced + " meeting follow-up" + (meetingPlaced === 1 ? "" : "s"));
      if (typeof showToast === "function" && parts.length) showToast("Moved " + parts.join(" and ") + " to today", "success");
    };
    allBtn.addEventListener("click", _allHandler, { once: true });

    overlay.classList.add("open");
  }

  // ── entry points ──
  // The morning prompt. Gated once per DAY on today's day_root, so a second device
  // doesn't re-ask. Everything waiting rides in one pass: what slipped off the last
  // two weeks, plus every triage item still needing a reply.
  async function initCatchUp() {
    if (typeof __todayDate === "undefined" || !__todayDate) return;
    if (typeof viewMode !== "undefined" && viewMode && viewMode !== "today") return;
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO || reviewed()) return;
    let res = { rows: [], total: 0 };
    let meetingActions = [];
    try { [res, meetingActions] = await Promise.all([CO.collect(), loadMeetingActions()]); } catch (e) { return; }
    const triage = activeTriage();
    // Everything already waiting at boot is "the morning recap", not "an arrival" —
    // banking it here is what stops the courier from running the pet at page load
    // for mail Drake has already been shown.
    const courier = window.DCC && window.DCC.TriageCourier;
    if (courier && typeof courier.markSeen === "function") courier.markSeen(triage.map(i => i.id));
    // Gate on OPEN rows, not raw rows: a pool made up entirely of done children is
    // nothing to catch up on, and prompting on it opened an empty-feeling modal.
    if (!rootsOf(res.rows).length && !triage.length && !meetingActions.length) { markReviewed(); return; }
    openPrompt(res.rows, res.total, { triage: triage, meetingActions: meetingActions });
  }

  // The courier's prompt: the pet just delivered, so lead with what arrived. Older
  // triage stays folded behind one line, and the day's unfinished tasks ride along
  // exactly as they do in the morning. Deliberately NOT gated on the reviewed flag —
  // new mail is new, whether or not the morning pass already happened.
  async function openArrivals(newIds) {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return false;
    const ids = new Set(newIds || []);
    const all = activeTriage();
    const fresh = all.filter(i => ids.has(i.id));
    if (!fresh.length) return false;
    let res = { rows: [], total: 0 };
    try { res = await CO.collect(); } catch (e) { res = { rows: [], total: 0 }; }
    openPrompt(res.rows, res.total, {
      title: "Fresh from the sweep",
      triage: fresh,
      olderTriage: all.filter(i => !ids.has(i.id)),
      meetingActions: await loadMeetingActions()
    });
    return true;
  }

  // A recap can land at either scheduled sweep, after the once-per-day morning
  // flag has already been set. The SSE handler calls this entry point so newly
  // extracted meeting actions are elevated immediately instead of waiting for a
  // manual trip back to the meeting card.
  async function openMeetingActions() {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return false;
    const meetingActions = await loadMeetingActions();
    if (!meetingActions.length) return false;
    let res = { rows: [], total: 0 };
    try { res = await CO.collect(); } catch (e) {}
    openPrompt(res.rows, res.total, {
      title: "Fresh meeting follow-ups",
      triage: activeTriage(),
      meetingActions: meetingActions
    });
    return true;
  }

  window.initCatchUp = initCatchUp;
  const DCC = (window.DCC = window.DCC || {});
  DCC.CatchUp = { openArrivals: openArrivals, openMeetingActions: openMeetingActions };
})();
