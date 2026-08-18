// ======== MORNING CATCH-UP ========
// One prompt, on the first load of a new day: here's what slipped, clear it in a
// single pass. Move each row to today or another calendar day, drop it, inspect
// details, or use "Move all to today" for the whole list at once.
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
  let _lastSnapshot = null;
  let _lastCount = 0;
  let _returnFocus = null;
  let _openHasLoadFailure = false;
  let _retryTimer = null;
  let _activeCarryoverSettlement = null;

  function pruneSettledCarryover(ids) {
    if (!_lastSnapshot || !_lastSnapshot.res || !Array.isArray(_lastSnapshot.res.rows)) return;
    const gone = new Set(ids || []);
    if (!gone.size) return;
    const rows = _lastSnapshot.res.rows;
    const removedOpen = rows.filter(row => gone.has(row.id) && !(row.__unf && row.__unf.done)).length;
    _lastSnapshot.res = Object.assign({}, _lastSnapshot.res, {
      rows: rows.filter(row => !gone.has(row.id)),
      total: Math.max(0, (_lastSnapshot.res.total || 0) - removedOpen)
    });
  }

  function handleCarryoverSettlement(event) {
    const ids = event && event.detail && event.detail.removed;
    if (!Array.isArray(ids) || !ids.length) return;
    pruneSettledCarryover(ids);
    if (typeof _activeCarryoverSettlement === "function") _activeCarryoverSettlement(ids);
    if (_lastSnapshot) setIndicatorCount(snapshotCount(_lastSnapshot));
  }
  if (typeof window.addEventListener === "function") window.addEventListener("dcc:carryover-settled", handleCarryoverSettlement);

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
  // state.js owns _resolvedTodayDate with the same semantics as every other "move it
  // to today" affordance in the app. state.js loads well before this file, so prefer
  // the canonical helper; the inline fallback only exists if load order ever changes. Note
  // the local fallback below is UTC while the canonical helper is local-time, so a
  // copy could disagree by a day in the evening -- another reason to defer.
  function todayStr() {
    if (typeof _resolvedTodayDate === "function") return _resolvedTodayDate();
    if (typeof __todayDate === "string" && __todayDate) return __todayDate;
    return new Date().toISOString().slice(0, 10);
  }
  function nextDayStr() {
    const date = new Date(todayStr() + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
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
  // the same anchored day picker. The Today / Drop / Details actions stay identical
  // across row types; the calendar reaches any other day without leaving the modal. Rows here aren't entries
  // in scheduled[], so the picker runs in its date-only "pick" mode and the caller
  // owns the write (see DCC.wireDateButton in core.js).
  function calBtn(cls, label, disabled) {
    const html = window.DCC.dateButtonHtml(cls, label);
    return disabled ? html.replace("<button ", '<button disabled title="Delegated items stay with their owner" ') : html;
  }
  function completeBtn(title) {
    return '<button type="button" class="cu-complete" aria-label="' + esc("Mark done: " + title) + '" title="Already done">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>' +
    '</button>';
  }
  function rowActions(scope, detailsClass, title, opts) {
    opts = opts || {};
    const todayDisabled = opts.todayDisabled ? ' disabled title="Delegated items stay with their owner"' : "";
    return '<div class="carryover-row-actions">' +
      '<button type="button" class="carryover-btn carryover-btn-schedule cu-today ' + scope + '-today" aria-label="' + esc("Schedule today: " + title) + '"' + todayDisabled + '>Today</button>' +
      '<button type="button" class="carryover-btn carryover-btn-drop cu-drop ' + scope + '-drop" aria-label="' + esc("Drop: " + title) + '">Drop</button>' +
      '<button type="button" class="carryover-btn cu-details-action ' + detailsClass + '" aria-label="' + esc("Show details for " + title) + '">Details</button>' +
    '</div>';
  }
  function detailShell(id, label) {
    return '<div class="cu-details" id="' + id + '" role="region" aria-label="' + esc(label) + '" hidden>' +
      '<div class="cu-details-full-title"></div>' +
      '<div class="cu-details-body" aria-live="polite"></div>' +
    '</div>';
  }
  function appendDetailSection(container, labelText, values) {
    const clean = (values || []).filter(Boolean);
    if (!clean.length) return false;
    const section = document.createElement("div");
    section.className = "cu-details-section";
    const labelEl = document.createElement("div");
    labelEl.className = "cu-details-label";
    labelEl.textContent = labelText;
    const textEl = document.createElement("div");
    textEl.className = "cu-details-text";
    textEl.textContent = clean.join("\n\n");
    section.appendChild(labelEl);
    section.appendChild(textEl);
    container.appendChild(section);
    return true;
  }
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
  function triageLane(item) {
    const haystack = [item && item.source, item && item.type, item && item.channel, item && item.link, item && item.source_url]
      .filter(Boolean).join(" ").toLowerCase();
    if (haystack.includes("slack")) return "slack";
    if (haystack.includes("gmail") || haystack.includes("email") || haystack.includes("mail.google.com")) return "gmail";
    return "other";
  }

  function syncIndicator() {
    const pill = document.getElementById("loose-ends-pill");
    const count = document.getElementById("loose-ends-pill-count");
    if (!pill || !count) return;
    const onToday = typeof viewMode === "undefined" || !viewMode || viewMode === "today";
    count.textContent = String(_lastCount);
    pill.hidden = !onToday || _lastCount < 1;
    pill.setAttribute("aria-label", "Open " + _lastCount + " Loose End" + (_lastCount === 1 ? "" : "s"));
  }

  function setIndicatorCount(count) {
    _lastCount = Math.max(0, Number(count) || 0);
    syncIndicator();
  }

  // ── meeting follow-ups ──
  // Recap actions are durable child blocks, intentionally excluded from ordinary
  // task and carryover queries until Drake approves one. This read model keeps
  // that approval boundary while making the proposals visible beside Sweep triage.
  async function loadMeetingActions() {
    if (typeof fetch !== "function") return [];
    const res = await fetch("/api/meetings/actions/proposed");
    const body = await res.json();
    if (!res.ok || !Array.isArray(body.items)) throw new Error("Meeting follow-ups unavailable");
    return body.items;
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
  async function completeMeetingAction(item) {
    try {
      let actionBlockId = item.approvedBlockId || null;
      if (!actionBlockId) {
        const approved = await postJson(
          "/api/meetings/" + encodeURIComponent(item.meetingId) + "/actions/approve",
          { actionIds: [item.id] }
        );
        const block = (approved.approvedBlocks || [])[0];
        const proposal = (approved.proposedActions || []).find(action => action.id === item.id);
        actionBlockId = (block && block.id) || (proposal && proposal.approvedBlockId) || null;
      }
      if (!actionBlockId) return false;
      if (!window.blockStore || typeof window.blockStore.setTaskCompletion !== "function") {
        throw new Error("Completion writer unavailable");
      }
      const result = await window.blockStore.setTaskCompletion(actionBlockId, true, {
        completedAt: new Date().toISOString(), taskDate: item.meetingDate || null
      });
      return !!(result && result.ok === true);
    } catch (e) {
      if (typeof showToast === "function") showToast(e.message || "Could not complete meeting follow-up", "error");
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
      '<div class="carryover" role="dialog" aria-modal="true" aria-labelledby="catchup-title">' +
        '<div class="carryover-hdr">' +
          '<h3 id="catchup-title">Loose Ends</h3>' +
          '<button class="pvb-close" id="catchup-close" aria-label="Close Loose Ends">&times;</button>' +
        '</div>' +
        '<div class="carryover-body">' +
          '<div class="carryover-hint" id="catchup-hint"></div>' +
          '<div class="carryover-list" id="catchup-list"></div>' +
        '</div>' +
        '<div class="carryover-footer">' +
          '<button class="carryover-btn carryover-btn-schedule" id="catchup-all">Move schedulable items to today</button>' +
          '<button class="carryover-skip" id="catchup-skip">Leave them</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const focusable = [...overlay.querySelectorAll("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])")]
        .filter(el => !el.hidden && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    overlay.querySelector("#catchup-close").addEventListener("click", close);
    overlay.querySelector("#catchup-skip").addEventListener("click", close);
    return overlay;
  }

  // Closing IS the answer "leave the rest where they are" — mark the day reviewed
  // so the prompt doesn't nag twice, and let the lane carry the remainder.
  function close() {
    const overlay = document.getElementById("catchup-overlay");
    if (overlay) overlay.classList.remove("open");
    if (!_openHasLoadFailure) markReviewed();
    if (typeof invalidateUnfinishedSection === "function") invalidateUnfinishedSection();
    if (typeof render === "function") render();
    if (_returnFocus && typeof _returnFocus.focus === "function") _returnFocus.focus();
    _returnFocus = null;
  }

  function openPrompt(pool, total, cfg) {
    cfg = cfg || {};
    _openHasLoadFailure = !!cfg.loadFailed;
    const CO = window.DCC.Carryover;
    const overlay = ensureModal();
    const roots = rootsOf(pool);
    const triage = cfg.triage || [];
    const waiting = cfg.waiting || [];
    const waitingTriage = cfg.waitingTriage || [];
    const waitingDraftById = new Map(waitingTriage.map(item => [String(item.waiting_item_id || ""), item]));
    const slack = triage.filter(item => triageLane(item) === "slack");
    const gmail = triage.filter(item => triageLane(item) === "gmail");
    const otherTriage = triage.filter(item => triageLane(item) === "other");
    const olderTriage = cfg.olderTriage || [];
    const meetingActions = cfg.meetingActions || [];
    const dayReview = cfg.dayReview || null;
    const reviewApi = window.DCC && window.DCC.DayReview;
    const reviewCount = dayReview && reviewApi ? reviewApi.pendingCount(dayReview) : 0;
    const hintEl = overlay.querySelector("#catchup-hint");
    const listEl = overlay.querySelector("#catchup-list");
    const allBtn = overlay.querySelector("#catchup-all");
    overlay.querySelector("#catchup-title").textContent = cfg.title || "Loose Ends";
    // `total` is the collector's count of OPEN rows before the MAX_ROWS cap, so it
    // has to be compared against the open rows we actually have — not the whole
    // pool, which carries done children too and made this branch unreachable.
    const openCount = openOf(pool).length;
    const taskPhrase = roots.length + " unfinished task" + (roots.length === 1 ? "" : "s") +
      " from the last two weeks" + (total > openCount ? " (showing " + openCount + " of " + total + ")" : "");
    const triagePhrase = triage.length + " Sweep item" + (triage.length === 1 ? "" : "s") + " waiting";
    const waitingPhrase = waiting.length + " Waiting item" + (waiting.length === 1 ? "" : "s") + " due for a decision";
    const meetingPhrase = meetingActions.length + " meeting follow-up" + (meetingActions.length === 1 ? "" : "s");
    const reviewPhrase = reviewCount + " Day in Review decision" + (reviewCount === 1 ? "" : "s");
    const phrases = [];
    if (roots.length) phrases.push(taskPhrase);
    if (waiting.length) phrases.push(waitingPhrase);
    if (triage.length) phrases.push(triagePhrase);
    if (meetingActions.length) phrases.push(meetingPhrase);
    if (reviewCount) phrases.push(reviewPhrase);
    hintEl.textContent = phrases.join(phrases.length > 2 ? ", " : " and ") +
      ". Handle what matters now, or close this and come back from the reminder above.";
    listEl.innerHTML = "";

    const rowEls = new Map();   // unfinished rows, keyed by ev.id
    const triEls = new Map();   // triage rows, keyed by triage item id
    const meetingEls = new Map(); // recap proposals, keyed by proposed-action id
    const waitingEls = new Map(); // Waiting rows, keyed by global item id
    const activeReviewRows = new Set();
    const taskRows = [];
    const waitingRows = [];
    const slackRows = [];
    const gmailRows = [];
    const otherRows = [];
    const signaledMeetingRows = [];
    const automatedMeetingRows = [];
    let detailSeq = 0;
    // Closing on the last row is the same courtesy either list gives: once there is
    // nothing left to answer, the modal has no reason to sit there. An unexpanded
    // "older waiting" line still counts as something to answer — closing over it
    // would hide the queue it exists to advertise.
    let olderPending = olderTriage.length > 0;
    const pendingDomCount = () => rowEls.size + waitingEls.size + triEls.size + meetingEls.size + reviewCount + (olderPending ? olderTriage.length : 0);
    const updateCount = () => setIndicatorCount(pendingDomCount());
    const closeIfDrained = () => {
      updateCount();
      if (!pendingDomCount() && !dayReview) close();
    };
    const focusAfterRemoval = (orderedRows, removedIndex) => {
      const next = orderedRows.slice(removedIndex + 1).find(row => activeReviewRows.has(row));
      const previous = orderedRows.slice(0, removedIndex).reverse().find(row => activeReviewRows.has(row));
      const fallback = overlay.classList.contains("open")
        ? overlay.querySelector("#catchup-skip")
        : document.getElementById("dcc-launcher-btn");
      const target = (next || previous)?.querySelector(".cu-complete") || fallback;
      if (target && typeof target.focus === "function") target.focus();
    };
    const forgetRow = (el, map, id) => {
      const orderedRows = Array.from(listEl.children).filter(row => activeReviewRows.has(row));
      const restoreIndex = orderedRows.indexOf(el);
      el.remove();
      map.delete(id);
      activeReviewRows.delete(el);
      closeIfDrained();
      if (restoreIndex >= 0) focusAfterRemoval(orderedRows, restoreIndex);
    };
    const settle = (res, focusRow) => {
      if (!res) return false;
      const orderedRows = Array.from(listEl.children).filter(row => activeReviewRows.has(row));
      const restoreIndex = focusRow ? orderedRows.indexOf(focusRow) : -1;
      (res.removed || []).forEach(id => {
        const el = rowEls.get(id);
        if (!el) return;
        el.remove();
        rowEls.delete(id);
        activeReviewRows.delete(el);
      });
      closeIfDrained();
      // Removing the focused completion button otherwise drops keyboard users back
      // onto the document. Keep their place in the review whenever another row remains.
      if (restoreIndex >= 0) {
        focusAfterRemoval(orderedRows, restoreIndex);
      }
      return true;
    };
    _activeCarryoverSettlement = ids => settle({ removed: ids });
    const label = (text) => {
      const el = document.createElement("h4");
      el.className = "cu-section-label";
      el.textContent = text;
      listEl.appendChild(el);
    };

    const addTriageRow = (item, before) => {
      const el = document.createElement("div");
      const title = item.title || "Untitled";
      const detailId = "cu-triage-details-" + (++detailSeq);
      // Delegated check-ins wear the shared --waiting look here too: the recap envelope
      // lists the same reminders the itinerary strip does, and "Drop" on one of them
      // drops the REMINDER, never the delegated task (triage.js isWaitingCheckIn).
      const isCheckIn = typeof isWaitingCheckIn === "function" && isWaitingCheckIn(item);
      const checkInPill = isCheckIn
        ? '<span class="waiting-pill checkin" title="Check-in reminder: this handles the reminder only. The delegated task stays open in Waiting.">&#128276; Check-in</span>'
        : "";
      el.className = "carryover-row cu-unified-row cu-triage-row" + (isCheckIn ? " cu-waiting-checkin" : "");
      const safe = (window.DCC && window.DCC.safeUrl) || (u => "");
      const href = safe(item.draft_link || item.draft_url) || safe(item.link || item.source_url);
      el.innerHTML =
        completeBtn(title) +
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<div class="carryover-row-title"></div>' +
            checkInPill +
            calBtn("cu-cal", "Schedule on a day: " + title) +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(triageMeta(item)) +
            (href ? ' · <a class="cu-tri-link" href="' + esc(href) + '" target="_blank" rel="noopener">Open</a>' : '') +
          '</div>' +
        '</div>' +
        rowActions("cu-tri", "cu-details-toggle cu-tri-details", title) +
        detailShell(detailId, "Details for " + title);
      const titleEl = el.querySelector(".carryover-row-title");
      const toggleEl = el.querySelector(".cu-tri-details");
      const detailEl = el.querySelector(".cu-details");
      const detailBody = el.querySelector(".cu-details-body");
      detailEl.hidden = true;
      titleEl.textContent = title;
      titleEl.title = title;
      toggleEl.setAttribute("aria-expanded", "false");
      toggleEl.setAttribute("aria-controls", detailId);
      toggleEl.setAttribute("aria-label", "Show details for " + title);
      el.querySelector(".cu-details-full-title").textContent = title;
      const hasDetails = [
        appendDetailSection(detailBody, "Summary", [item.summary, item.snippet, item.excerpt]),
        appendDetailSection(detailBody, "Draft preview", [item.draft_preview]),
        appendDetailSection(detailBody, "Details", [item.detail, item.description, item.notes])
      ].some(Boolean);
      if (!hasDetails) detailBody.textContent = "No additional details on this item.";
      toggleEl.addEventListener("click", () => {
        const opening = detailEl.hidden;
        detailEl.hidden = !opening;
        toggleEl.setAttribute("aria-expanded", opening ? "true" : "false");
        toggleEl.setAttribute("aria-label", (opening ? "Hide" : "Show") + " details for " + title);
        el.classList[opening ? "add" : "remove"]("details-open");
      });
      const busy = (on) => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const forget = () => forgetRow(el, triEls, item.id);
      // A refused schedule (no free slot, already on the day) leaves the row alone
      // and re-enables it, same contract the task rows use.
      const runTri = async (fn) => {
        const focused = document.activeElement && el.contains(document.activeElement)
          ? document.activeElement : el.querySelector(".cu-complete");
        busy(true);
        if (await fn()) forget();
        else {
          busy(false);
          if (focused && typeof focused.focus === "function") focused.focus();
        }
      };
      el.querySelector(".cu-complete").addEventListener("click", e => {
        e.stopPropagation();
        runTri(async () => {
          if (typeof dismissTriage !== "function") return false;
          return !!(await dismissTriage(item.id, "Already done", false));
        });
      });
      const place = (d2) => runTri(async () => {
        if (typeof scheduleTriageOnDate !== "function") return false;
        return !!(await scheduleTriageOnDate(item.id, d2));
      });
      el.querySelector(".cu-tri-today").addEventListener("click", () => place(todayStr()));
      el.querySelector(".cu-tri-drop").addEventListener("click", () => {
        if (typeof deleteTriageItem !== "function") return;
        deleteTriageItem(item.id);   // durable + its own 8s Undo toast
        forget();
      });
      wireCal(el.querySelector(".cu-cal"), item.title || "Untitled", place);
      triEls.set(item.id, el);
      activeReviewRows.add(el);
      // `before` keeps expanded older items INSIDE the triage group. Appending them
      // instead dropped them below the Slipped section, orphaned from their heading.
      if (before && typeof listEl.insertBefore === "function") listEl.insertBefore(el, before);
      else {
        const lane = triageLane(item);
        (lane === "slack" ? slackRows : (lane === "gmail" ? gmailRows : otherRows)).push(el);
      }
    };
    slack.forEach(i => addTriageRow(i));
    gmail.forEach(i => addTriageRow(i));
    otherTriage.forEach(i => addTriageRow(i));

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
      cfg._olderButton = more;
    }

    waiting.forEach(item => {
      const api = window.DCC && window.DCC.Waiting;
      if (!api) return;
      const p = item.properties || {};
      const task = p.myTask || p.title || "Waiting task";
      const detailId = "cu-waiting-details-" + (++detailSeq);
      const draft = waitingDraftById.get(String(item.id));
      const safe = (window.DCC && window.DCC.safeUrl) || (() => "");
      const draftHref = draft && safe(draft.draft_link || draft.draft_url);
      const sourceHref = draft && safe(draft.link || draft.source_url);
      const reviewHref = draftHref || sourceHref;
      const shouldCopyDraft = !!(draft && draft.draft_preview && !draftHref);
      const urgency = api.itemUrgency(item);
      const blocker = api.blockerLabel(item);
      const el = document.createElement("div");
      el.className = "carryover-row cu-unified-row cu-waiting-row";
      el.innerHTML =
        completeBtn(task) +
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line"><div class="carryover-row-title"></div>' +
            calBtn("cu-cal", "Snooze until another day: " + task) +
          '</div>' +
          '<div class="carryover-row-meta"></div>' +
        '</div>' +
        rowActions("cu-wait", "cu-wait-details", task) +
        detailShell(detailId, "Waiting details for " + task);
      const titleEl = el.querySelector(".carryover-row-title");
      const detailsToggle = el.querySelector(".cu-wait-details");
      const details = el.querySelector(".cu-details");
      const detailBody = el.querySelector(".cu-details-body");
      titleEl.textContent = task;
      titleEl.title = task;
      el.querySelector(".carryover-row-meta").textContent = blocker + " · " + api.dueLabel(item) + " · urgency " + urgency.score;
      details.hidden = true;
      detailsToggle.setAttribute("aria-expanded", "false");
      detailsToggle.setAttribute("aria-controls", detailId);
      el.querySelector(".cu-details-full-title").textContent = task;
      appendDetailSection(detailBody, "Waiting on", [blocker]);
      appendDetailSection(detailBody, "Context", [p.notes]);
      appendDetailSection(detailBody, "Check-in draft", [draft && draft.draft_preview]);
      const detailActions = document.createElement("div");
      detailActions.className = "carryover-row-actions cu-wait-detail-actions";
      detailActions.innerHTML =
        (reviewHref ? '<a class="carryover-btn carryover-btn-schedule cu-wait-draft' + (shouldCopyDraft ? ' cu-wait-copy' : '') + '" target="_blank" rel="noopener">Review and Send</a>' :
          (draft && draft.draft_preview ? '<button class="carryover-btn carryover-btn-schedule cu-wait-copy">Copy Draft</button>' : '')) +
        '<button class="carryover-btn cu-wait-schedule">Schedule check-in</button>' +
        '<button class="carryover-btn carryover-btn-schedule cu-wait-unblock">Unblock</button>';
      detailBody.appendChild(detailActions);
      detailsToggle.addEventListener("click", () => {
        const opening = details.hidden;
        details.hidden = !opening;
        detailsToggle.setAttribute("aria-expanded", opening ? "true" : "false");
        detailsToggle.setAttribute("aria-label", (opening ? "Hide" : "Show") + " details for " + task);
        el.classList[opening ? "add" : "remove"]("details-open");
      });
      const busy = on => el.querySelectorAll("button").forEach(button => { button.disabled = !!on; });
      const forget = () => forgetRow(el, waitingEls, item.id);
      const runWaiting = async fn => { busy(true); if (await fn()) forget(); else busy(false); };
      el.querySelector(".cu-complete").addEventListener("click", e => {
        e.stopPropagation();
        runWaiting(() => api.completeCheckIn(item.id));
      });
      el.querySelector(".cu-wait-drop").setAttribute("title", "Dismiss until tomorrow");
      el.querySelector(".cu-wait-drop").addEventListener("click", () => {
        runWaiting(() => api.snooze(item.id, nextDayStr()));
      });
      el.querySelector(".cu-wait-today").addEventListener("click", event => api.scheduleCheckIn(item.id, event.currentTarget, forget, todayStr()));
      window.DCC.wireDateButton(el.querySelector(".cu-cal"), {
        header: 'Snooze "' + task + '" until…',
        actionLabel: "Snooze",
        onPick: date => runWaiting(() => api.snooze(item.id, date))
      });
      el.querySelector(".cu-wait-schedule").addEventListener("click", event => api.scheduleCheckIn(item.id, event.currentTarget, forget));
      el.querySelector(".cu-wait-unblock").addEventListener("click", () => runWaiting(() => api.unblock(item.id)));
      const draftLink = el.querySelector(".cu-wait-draft");
      if (draftLink) draftLink.href = reviewHref;
      const copy = el.querySelector(".cu-wait-copy");
      if (copy) copy.addEventListener("click", async event => {
        const sourceToOpen = sourceHref && !draftHref ? sourceHref : "";
        if (sourceToOpen && event && typeof event.preventDefault === "function") event.preventDefault();
        const pending = sourceToOpen && typeof window.open === "function" ? window.open("about:blank", "_blank") : null;
        if (pending) pending.opener = null;
        const copied = await api.copyText(draft.draft_preview);
        if (typeof showToast === "function") showToast(copied ? "Check-in draft copied" : "Could not copy draft", copied ? "success" : "error");
        if (!copied) {
          if (pending && typeof pending.close === "function") pending.close();
          return;
        }
        if (pending) pending.location.href = sourceToOpen;
        else if (sourceToOpen && typeof window.open === "function") {
          const opened = window.open(sourceToOpen, "_blank", "noopener");
          if (!opened && typeof showToast === "function") showToast("Draft copied, but the source could not be opened. Allow popups and try again.", "info");
        }
      });
      waitingEls.set(item.id, el);
      activeReviewRows.add(el);
      waitingRows.push(el);
    });

    meetingActions.forEach(item => {
      const el = document.createElement("div");
      const mine = item.owner !== "other";
      el.className = "carryover-row cu-unified-row cu-meeting-row";
      el.innerHTML =
        completeBtn(item.title || "Meeting follow-up") +
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<div class="carryover-row-title"></div>' +
            calBtn("cu-cal", "Schedule on a day: " + (item.title || "Meeting follow-up"), !mine) +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(item.meetingTitle || "Meeting") +
            (item.meetingDate ? " · " + esc(prettyDate(item.meetingDate)) : "") +
            " · " + esc(item.priority || "Medium") +
            (mine ? "" : " · delegated") +
          '</div>' +
        '</div>' +
        rowActions("cu-mtg", "cu-mtg-details", item.title || "Meeting follow-up", { todayDisabled: !mine });
      const meetingTitleEl = el.querySelector(".carryover-row-title");
      meetingTitleEl.textContent = item.title || "Meeting follow-up";
      meetingTitleEl.title = item.title || "Meeting follow-up";
      el.querySelector(".cu-mtg-details").setAttribute("aria-label", "Open recap for " + (item.title || "Meeting follow-up"));
      const busy = on => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const forget = () => forgetRow(el, meetingEls, item.id);
      const runMeeting = async fn => {
        const focused = document.activeElement && el.contains(document.activeElement)
          ? document.activeElement : el.querySelector(".cu-complete");
        busy(true);
        if (await fn()) forget();
        else {
          busy(false);
          if (focused && typeof focused.focus === "function") focused.focus();
        }
      };
      const place = date => runMeeting(() => placeMeetingAction(item, date));
      el.querySelector(".cu-complete").addEventListener("click", e => {
        e.stopPropagation();
        runMeeting(() => completeMeetingAction(item));
      });
      if (mine) {
        el.querySelector(".cu-mtg-today").addEventListener("click", () => place(todayStr()));
        wireCal(el.querySelector(".cu-cal"), item.title || "Meeting follow-up", place);
      }
      el.querySelector(".cu-mtg-details").addEventListener("click", () => {
        if (typeof openPrepModal === "function") openPrepModal({
          id: item.meetingId, meetingBlockId: item.meetingId,
          title: item.meetingTitle || "Meeting", start: item.meetingStart, end: item.meetingEnd
        }, { defaultTab: "recap" });
      });
      el.querySelector(".cu-mtg-drop").addEventListener("click", () => runMeeting(() => dismissMeetingAction(item)));
      meetingEls.set(item.id, el);
      activeReviewRows.add(el);
      (item.origin === "signaled" ? signaledMeetingRows : automatedMeetingRows).push(el);
    });

    roots.forEach(ev => {
      const el = document.createElement("div");
      const kids = CO.descendants(ev, pool).length;
      const d = (typeof dur === "function") ? Math.max(0, dur(ev)) : 0;
      const durLabel = d > 0 ? ((typeof ms === "function") ? ms(d) : d + "m") : "step";
      const title = ev.title || "Untitled";
      const detailId = "cu-task-details-" + (++detailSeq);
      el.className = "carryover-row cu-unified-row cu-task-row";
      el.innerHTML =
        completeBtn(title) +
        '<div class="carryover-row-info">' +
          '<div class="cu-title-line">' +
            '<div class="carryover-row-title"></div>' +
            calBtn("cu-cal", "Move to a day: " + title) +
          '</div>' +
          '<div class="carryover-row-meta">' + esc(durLabel) +
            (kids ? " · +" + kids + " nested" : "") +
            ' · from ' + esc(prettyDate((ev.__unf || {}).sourceDate)) +
          '</div>' +
        '</div>' +
        rowActions("cu-task", "cu-details-toggle", title) +
        detailShell(detailId, "Notes and details for " + title);
      const titleEl = el.querySelector(".carryover-row-title");
      const toggleEl = el.querySelector(".cu-details-toggle");
      const detailEl = el.querySelector(".cu-details");
      const detailBody = el.querySelector(".cu-details-body");
      detailEl.hidden = true;
      titleEl.textContent = title;
      titleEl.title = title;
      toggleEl.setAttribute("aria-expanded", "false");
      toggleEl.setAttribute("aria-controls", detailId);
      toggleEl.setAttribute("aria-label", "Show notes and details for " + title);
      el.querySelector(".cu-details-full-title").textContent = title;

      let detailLoaded = false;
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
          if (details.length) appendDetailSection(detailBody, "Details", details);
          if (notes.length) appendDetailSection(detailBody, "Notes", notes);
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
      const run = async (fn) => {
        const focused = document.activeElement && el.contains(document.activeElement)
          ? document.activeElement : el.querySelector(".cu-complete");
        busy(true);
        if (!settle(await fn(), el)) {
          busy(false);
          if (focused && typeof focused.focus === "function") focused.focus();
        }
      };
      el.querySelector(".cu-complete").addEventListener("click", e => {
        e.stopPropagation();
        run(() => CO.complete(ev, pool));
      });
      el.querySelector(".cu-today").addEventListener("click", () => run(() => CO.moveTo(ev, todayStr(), { pool })));
      el.querySelector(".cu-drop").addEventListener("click", () => run(() => CO.drop(ev, pool)));
      // The calendar pick lands in the SAME mover the day buttons use — one write
      // path, so an arbitrary day can't behave differently from Today.
      wireCal(el.querySelector(".cu-cal"), title, (d2) => run(() => CO.moveTo(ev, d2, { pool })));
      rowEls.set(ev.id, el);
      activeReviewRows.add(el);
      taskRows.push(el);
    });

    const appendRows = (title, rows) => {
      if (!rows.length) return;
      label(title);
      rows.forEach(row => listEl.appendChild(row));
    };
    appendRows("Slipped tasks", taskRows);
    appendRows("Waiting", waitingRows);
    appendRows("Slack", slackRows);
    appendRows("Gmail", gmailRows);
    appendRows("Other", otherRows);
    if (cfg._olderButton) listEl.appendChild(cfg._olderButton);
    appendRows("Signaled Action Items from Meetings", signaledMeetingRows);
    appendRows("Automated Action Items from Meetings", automatedMeetingRows);
    if (dayReview && reviewApi) {
      label("Day in Review");
      const reviewWrap = document.createElement("div");
      reviewWrap.className = "cu-review-wrap";
      reviewWrap.innerHTML = reviewApi.renderPending(dayReview);
      listEl.appendChild(reviewWrap);
      const journalWrap = document.createElement("div");
      journalWrap.className = "cu-journal-wrap";
      journalWrap.innerHTML = reviewApi.renderJournal(dayReview);
      listEl.appendChild(journalWrap);
    }
    updateCount();
    const schedulableCount = rowEls.size + triEls.size + meetingActions.filter(item => item.owner !== "other").length;
    allBtn.style.display = schedulableCount ? "" : "none";


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
      if (reviewCount) await refreshReminder({ open: true });
      else close();
      const parts = [];
      if (moved) parts.push(moved + " unfinished task" + (moved === 1 ? "" : "s"));
      if (placed) parts.push(placed + " triage item" + (placed === 1 ? "" : "s"));
      if (meetingPlaced) parts.push(meetingPlaced + " meeting follow-up" + (meetingPlaced === 1 ? "" : "s"));
      if (typeof showToast === "function" && parts.length) showToast("Moved " + parts.join(" and ") + " to today", "success");
    };
    allBtn.addEventListener("click", _allHandler, { once: true });

    if (!overlay.classList.contains("open")) _returnFocus = document.activeElement;
    overlay.classList.add("open");
    if (cfg.focus !== false) {
      const first = overlay.querySelector(".cu-complete, [data-gb-approve], #catchup-close");
      if (first && typeof first.focus === "function") first.focus();
    }
  }

  // ── entry points ──
  function snapshotCount(snapshot) {
    if (!snapshot) return 0;
    const reviewApi = window.DCC && window.DCC.DayReview;
    return rootsOf(snapshot.res.rows).length + snapshot.waiting.length + snapshot.triage.length + snapshot.meetingActions.length +
      (snapshot.dayReview && reviewApi ? reviewApi.pendingCount(snapshot.dayReview) : 0);
  }

  async function collectSnapshot() {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return null;
    const reviewApi = window.DCC && window.DCC.DayReview;
    const results = await Promise.allSettled([
      CO.collect(),
      loadMeetingActions(),
      reviewApi && typeof reviewApi.load === "function" ? reviewApi.load() : Promise.resolve(null)
    ]);
    const failed = results.some(result => result.status === "rejected");
    const waiting = typeof window.getAttentionWaitingItems === "function" ? window.getAttentionWaitingItems() : [];
    const waitingIds = new Set(waiting.map(item => String(item.id)));
    const allTriage = activeTriage();
    const waitingTriage = allTriage.filter(item => waitingIds.has(String(item.waiting_item_id || "")));
    const snapshot = {
      res: results[0].status === "fulfilled" ? results[0].value : (_lastSnapshot ? _lastSnapshot.res : { rows: [], total: 0 }),
      meetingActions: results[1].status === "fulfilled" ? results[1].value : (_lastSnapshot ? _lastSnapshot.meetingActions : []),
      dayReview: results[2].status === "fulfilled" ? results[2].value : (_lastSnapshot ? _lastSnapshot.dayReview : null),
      waiting,
      waitingTriage,
      triage: allTriage.filter(item => !waitingIds.has(String(item.waiting_item_id || ""))),
      failed: failed
    };
    _lastSnapshot = snapshot;
    setIndicatorCount(snapshotCount(snapshot));
    return snapshot;
  }

  async function refreshReminder(opts) {
    opts = opts || {};
    const wasOpen = !!document.getElementById("catchup-overlay") && document.getElementById("catchup-overlay").classList.contains("open");
    const preservedFocus = opts.preserveMoodFocus && document.activeElement &&
      document.activeElement.closest && document.activeElement.closest("[data-gb-open-mood]")
      ? document.activeElement : null;
    const snapshot = await collectSnapshot();
    if (!snapshot) return null;
    const restoreMoodFocus = !!preservedFocus && document.activeElement === preservedFocus;
    if ((opts.open || wasOpen) && snapshotCount(snapshot)) {
      openPrompt(snapshot.res.rows, snapshot.res.total, {
        triage: snapshot.triage,
        waiting: snapshot.waiting,
        waitingTriage: snapshot.waitingTriage,
        meetingActions: snapshot.meetingActions,
        dayReview: snapshot.dayReview,
        loadFailed: snapshot.failed,
        focus: opts.focus
      });
    } else if (wasOpen && !snapshotCount(snapshot) && snapshot.dayReview) {
      openPrompt([], 0, { dayReview: snapshot.dayReview, focus: opts.focus });
    }
    if (restoreMoodFocus) {
      const activeOverlay = document.getElementById("catchup-overlay");
      const replacement = activeOverlay && activeOverlay.querySelector("[data-gb-open-mood]");
      if (replacement && typeof replacement.focus === "function") replacement.focus();
    }
    return snapshot;
  }

  async function openReminder() {
    const snapshot = await refreshReminder({ open: true });
    if (snapshot && !snapshotCount(snapshot) && typeof showToast === "function") showToast("No Loose Ends waiting", "success");
    return !!(snapshot && snapshotCount(snapshot));
  }

  // The morning prompt. Gated once per DAY on today's day_root, so a second device
  // doesn't re-ask. Everything waiting rides in one pass: what slipped off the last
  // two weeks, plus every triage item still needing a reply.
  async function initCatchUp() {
    if (typeof __todayDate === "undefined" || !__todayDate) return;
    if (typeof viewMode !== "undefined" && viewMode && viewMode !== "today") return;
    const snapshot = await collectSnapshot();
    if (!snapshot) return;
    if (snapshot.failed) {
      if (!_retryTimer && typeof setTimeout === "function") {
        _retryTimer = setTimeout(() => { _retryTimer = null; initCatchUp(); }, 30000);
      }
      return;
    }
    const triage = snapshot.triage;
    // Everything already waiting at boot is "the morning recap", not "an arrival" —
    // banking it here is what stops the courier from running the pet at page load
    // for mail Drake has already been shown.
    const courier = window.DCC && window.DCC.TriageCourier;
    if (courier && typeof courier.markSeen === "function") courier.markSeen(triage.concat(snapshot.waitingTriage).map(i => i.id));
    // Gate on OPEN rows, not raw rows: a pool made up entirely of done children is
    // nothing to catch up on, and prompting on it opened an empty-feeling modal.
    if (!snapshotCount(snapshot) && !snapshot.dayReview) {
      if (!snapshot.failed) markReviewed();
      return;
    }
    if (reviewed()) return;
    openPrompt(snapshot.res.rows, snapshot.res.total, {
      triage: triage,
      waiting: snapshot.waiting,
      waitingTriage: snapshot.waitingTriage,
      meetingActions: snapshot.meetingActions,
      dayReview: snapshot.dayReview
    });
  }

  // The courier's prompt: the pet just delivered, so lead with what arrived. Older
  // triage stays folded behind one line, and the day's unfinished tasks ride along
  // exactly as they do in the morning. Deliberately NOT gated on the reviewed flag —
  // new mail is new, whether or not the morning pass already happened.
  async function openArrivals(newIds) {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return false;
    const ids = new Set(newIds || []);
    const waiting = typeof window.getAttentionWaitingItems === "function" ? window.getAttentionWaitingItems() : [];
    const waitingIds = new Set(waiting.map(item => String(item.id)));
    const rawTriage = activeTriage();
    const waitingTriage = rawTriage.filter(item => waitingIds.has(String(item.waiting_item_id || "")));
    const all = rawTriage.filter(item => !waitingIds.has(String(item.waiting_item_id || "")));
    const fresh = all.filter(i => ids.has(i.id));
    if (!fresh.length) return false;
    let res = { rows: [], total: 0 };
    let loadFailed = false;
    try { res = await CO.collect(); } catch (e) { loadFailed = true; }
    let meetingActions = [];
    try { meetingActions = await loadMeetingActions(); } catch (e) { loadFailed = true; }
    let dayReview = null;
    try { dayReview = window.DCC.DayReview ? await window.DCC.DayReview.load() : null; }
    catch (e) { loadFailed = true; }
    openPrompt(res.rows, res.total, {
      title: "Fresh from the sweep",
      triage: fresh,
      olderTriage: all.filter(i => !ids.has(i.id)),
      waiting,
      waitingTriage,
      meetingActions: meetingActions,
      dayReview: dayReview,
      loadFailed: loadFailed
    });
    _lastSnapshot = { res, triage: all, waiting, waitingTriage, meetingActions, dayReview, failed: loadFailed };
    setIndicatorCount(snapshotCount(_lastSnapshot));
    return true;
  }

  // A recap can land at either scheduled sweep, after the once-per-day morning
  // flag has already been set. The SSE handler calls this entry point so newly
  // extracted meeting actions are elevated immediately instead of waiting for a
  // manual trip back to the meeting card.
  async function openMeetingActions() {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return false;
    let meetingActions = [];
    try { meetingActions = await loadMeetingActions(); } catch (e) { return false; }
    if (!meetingActions.length) return false;
    let res = { rows: [], total: 0 };
    let loadFailed = false;
    try { res = await CO.collect(); } catch (e) { loadFailed = true; }
    let dayReview = null;
    try { dayReview = window.DCC.DayReview ? await window.DCC.DayReview.load() : null; }
    catch (e) { loadFailed = true; }
    const waiting = typeof window.getAttentionWaitingItems === "function" ? window.getAttentionWaitingItems() : [];
    const waitingIds = new Set(waiting.map(item => String(item.id)));
    const rawTriage = activeTriage();
    const waitingTriage = rawTriage.filter(item => waitingIds.has(String(item.waiting_item_id || "")));
    const triage = rawTriage.filter(item => !waitingIds.has(String(item.waiting_item_id || "")));
    openPrompt(res.rows, res.total, {
      title: "Fresh meeting follow-ups",
      triage: triage,
      waiting,
      waitingTriage,
      meetingActions: meetingActions,
      dayReview: dayReview,
      loadFailed: loadFailed
    });
    _lastSnapshot = { res, triage, waiting, waitingTriage, meetingActions, dayReview, failed: loadFailed };
    setIndicatorCount(snapshotCount(_lastSnapshot));
    return true;
  }

  window.initCatchUp = initCatchUp;
  const DCC = (window.DCC = window.DCC || {});
  DCC.CatchUp = {
    open: openReminder,
    refresh: refreshReminder,
    syncIndicator: syncIndicator,
    openArrivals: openArrivals,
    openMeetingActions: openMeetingActions
  };
  const pill = document.getElementById("loose-ends-pill");
  if (pill) pill.addEventListener("click", openReminder);
  if (typeof window.addEventListener === "function") {
    window.addEventListener("dcc:day-review-changed", () => refreshReminder({ focus: false, preserveMoodFocus: true }));
  }
})();
