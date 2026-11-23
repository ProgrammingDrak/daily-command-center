// ======== MORNING CATCH-UP ========
// One user-opened workspace for what slipped. Move each row to today or another
// calendar day, drop it, inspect
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
  let _activeTaskActionCount = null;
  window.addEventListener('dcc:task-action',()=>{
    if(_lastSnapshot)setIndicatorCount(snapshotCount(_lastSnapshot));
    if(_activeTaskActionCount)_activeTaskActionCount();
  });

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

  // All row markup, controls, and interaction wiring belong to the itinerary.
  // Loose Ends supplies only metadata and the durable actions for each source.
  function reviewRow(ev, opts) {
    const schedule = opts.onDate ? trigger => window.openDatePickPopover(trigger, {
      header: opts.dateHeader || 'Move "' + ev.title + '" to…',
      actionLabel: opts.dateAction || "Move",
      onPick: opts.onDate
    }) : undefined;
    const el = ev.__unf
      ? window.createTaskListRowRenderer({pool:opts.pool,expandAll:true,onSettle:opts.onSettle,onOpen:opts.onDetails})(ev,opts.index||0,"unfinished",opts.node)
      : window.renderItineraryListRow(ev, {
      extraClass: opts.extraClass,
      barColor: opts.barColor || "var(--accent-light)",
      metaHtml: opts.metaHtml,
      titleExtrasHtml: opts.titleExtrasHtml,
      onComplete: opts.onComplete,
      onCompleteWithNotes: opts.onCompleteWithNotes || opts.onComplete,
      completionTitle: opts.onCompleteWithNotes ? undefined : "Mark done: " + ev.title,
      onSchedule: schedule,
      onDelete: opts.onDelete,
      deleteLabel: opts.deleteLabel || "Drop task",
      deleteTitle: opts.deleteLabel || "Drop task",
      onOpen: opts.onDetails,
      onRadial: opts.onTaskActions || (trigger => window.openTaskRadial(ev, trigger, {
        unavailableReason: "Schedule this incoming item before changing its task settings."
      }))
    });
    const title = el.querySelector(".ttl");
    title.textContent = ev.title;
    if (opts.detailId) {
      const host = document.createElement("div");
      host.innerHTML = detailShell(opts.detailId, "Details for " + ev.title);
      host.addEventListener("click", event => event.stopPropagation());
      el.querySelector(".it-list-main").appendChild(host);
    }
    if (ev.__unf && opts.extraClass) el.classList.add(opts.extraClass);
    return el;
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
    pill.setAttribute("aria-label",
      "Open " + _lastCount + " Loose End" + (_lastCount === 1 ? "" : "s"));
  }

  function setIndicatorCount(count) {
    _lastCount = Math.max(0, Number(count) || 0);
    syncIndicator();
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
          '<label class="cu-bulk-select"><input type="checkbox" id="catchup-select-all"> Select schedulable</label>' +
          '<button class="carryover-btn carryover-btn-schedule" id="catchup-all">Move to today</button>' +
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
    _activeTaskActionCount=null;
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
    const slack = triage.filter(item => triageLane(item) === "slack");
    const gmail = triage.filter(item => triageLane(item) === "gmail");
    const otherTriage = triage.filter(item => triageLane(item) === "other");
    const olderTriage = cfg.olderTriage || [];
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
    const phrases = [];
    if (roots.length) phrases.push(taskPhrase);
    if (triage.length) phrases.push(triagePhrase);
    hintEl.textContent = phrases.join(phrases.length > 2 ? ", " : " and ") +
      ". Handle what matters now, or close this and come back from the reminder above.";
    listEl.innerHTML = "";

    const rowEls = new Map();   // unfinished rows, keyed by ev.id
    const triEls = new Map();   // triage rows, keyed by triage item id
    const activeReviewRows = new Set();
    const taskRows = [];
    const slackRows = [];
    const gmailRows = [];
    const otherRows = [];
    let detailSeq = 0;
    // Closing on the last row is the same courtesy either list gives: once there is
    // nothing left to answer, the modal has no reason to sit there. An unexpanded
    // "older waiting" line still counts as something to answer — closing over it
    // would hide the queue it exists to advertise.
    let olderPending = olderTriage.length > 0;
    const pendingDomCount = () => rootsOf(pool.filter(ev=>rowEls.has(ev.id))).length + triEls.size + (olderPending ? olderTriage.length : 0);
    const updateCount = () => setIndicatorCount(pendingDomCount());
    _activeTaskActionCount=updateCount;
    const closeIfDrained = () => {
      updateCount();
      if (!pendingDomCount()) close();
    };
    const focusAfterRemoval = (orderedRows, removedIndex) => {
      const next = orderedRows.slice(removedIndex + 1).find(row => activeReviewRows.has(row));
      const previous = orderedRows.slice(0, removedIndex).reverse().find(row => activeReviewRows.has(row));
      const fallback = overlay.classList.contains("open")
        ? overlay.querySelector("#catchup-skip")
        : document.getElementById("dcc-launcher-btn");
      const target = (next || previous)?.querySelector(".it-list-check") || fallback;
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
    const settledIds=new Set();
    const settle = (res, focusRow) => {
      if (!res) return false;
      const orderedRows = Array.from(listEl.children).filter(row => activeReviewRows.has(row));
      const restoreIndex = focusRow ? orderedRows.indexOf(focusRow) : -1;
      (res.removed || []).forEach(id=>settledIds.add(id));
      const retained=new Set(openOf(pool.filter(ev=>!settledIds.has(ev.id))).map(ev=>ev.id));
      const gone=[...(res.removed||[]),...pool.filter(ev=>ev._contextOnly&&!retained.has(ev.id)).map(ev=>ev.id)];
      gone.forEach(id => {
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

    const addBulkSelect = (el, kind, id) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "cu-select";
      input.dataset.bulkKind = kind;
      input.dataset.bulkId = String(id);
      input.setAttribute("aria-label", "Select for bulk scheduling");
      input.hidden = true;
      el.querySelector(".it-list-utility").appendChild(input);
    };

    const addTriageRow = (item, before) => {
      const title = item.title || "Untitled";
      const detailId = "cu-triage-details-" + (++detailSeq);
      const safe = (window.DCC && window.DCC.safeUrl) || (() => "");
      const href = safe(item.draft_link || item.draft_url) || safe(item.link || item.source_url);
      const ev = window.DCC.TaskModel.fromTriageItem(item);
      const el = reviewRow(ev, {
        extraClass: "cu-triage-row",
        barColor: "var(--amber)",
        metaHtml: '<span class="it-list-context">' + esc(triageMeta(item)) +
          (href ? ' · <a class="cu-tri-link" href="' + esc(href) + '" target="_blank" rel="noopener">Open</a>' : '') + '</span>',
        detailId,
        onComplete: () => runTri(async () => typeof dismissTriage === "function" && !!(await dismissTriage(item.id, "Already done", false))),
        onDate: date => place(date),
        onToday: () => place(todayStr()),
        onDelete: () => {
          if (typeof deleteTriageItem !== "function") return;
          deleteTriageItem(item.id);
          forget();
        },
        onDetails: () => toggleDetails()
      });
      const titleEl = el.querySelector(".ttl");
      const toggleEl = titleEl;
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
      const toggleDetails = () => {
        const opening = detailEl.hidden;
        detailEl.hidden = !opening;
        toggleEl.setAttribute("aria-expanded", opening ? "true" : "false");
        toggleEl.setAttribute("aria-label", (opening ? "Hide" : "Show") + " details for " + title);
        el.classList[opening ? "add" : "remove"]("details-open");
      };
      const busy = (on) => el.querySelectorAll("button").forEach(b => { b.disabled = !!on; });
      const forget = () => forgetRow(el, triEls, item.id);
      // A refused schedule (no free slot, already on the day) leaves the row alone
      // and re-enables it, same contract the task rows use.
      const runTri = async (fn) => {
        const focused = document.activeElement && el.contains(document.activeElement)
          ? document.activeElement : el.querySelector(".it-list-check");
        busy(true);
        if (await fn()) forget();
        else {
          busy(false);
          if (focused && typeof focused.focus === "function") focused.focus();
        }
      };
      const place = (d2) => runTri(async () => {
        if (typeof scheduleTriageOnDate !== "function") return false;
        return !!(await scheduleTriageOnDate(item.id, d2));
      });
      triEls.set(item.id, el);
      addBulkSelect(el, "triage", item.id);
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

    const taskNodes=window.DCC.TaskModel.selectTree(openOf(pool),{isCollapsed:()=>false});
    taskNodes.forEach((node, index) => {
      const ev=node.ev;
      const title = ev.title || "Untitled";
      const detailId = "cu-task-details-" + (++detailSeq);
      const el = reviewRow(ev, {
        extraClass: "cu-task-row",
        detailId,
        pool,
        index,
        node,
        onSettle: (el, res) => settle(res, el),
        onDetails: () => toggleDetails()
      });
      const titleEl = el.querySelector(".ttl");
      const toggleEl = titleEl;
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

      rowEls.set(ev.id, el);
      if(!ev._contextOnly&&!node.depth)addBulkSelect(el, "task", ev.id);
      activeReviewRows.add(el);
      taskRows.push(el);
    });

    const appendRows = (title, rows) => {
      if (!rows.length) return;
      label(title);
      rows.forEach(row => listEl.appendChild(row));
    };
    appendRows("Slipped tasks", taskRows);
    appendRows("Slack", slackRows);
    appendRows("Gmail", gmailRows);
    appendRows("Other", otherRows);
    if (cfg._olderButton) listEl.appendChild(cfg._olderButton);
    updateCount();
    const schedulableCount = rowEls.size + triEls.size;
    allBtn.style.display = schedulableCount ? "" : "none";
    const selectAll = overlay.querySelector("#catchup-select-all");
    if (selectAll) {
      selectAll.checked = false;
      selectAll.onchange = () => overlay.querySelectorAll(".cu-select").forEach(input => {
        input.hidden = !selectAll.checked;
        input.checked = selectAll.checked;
      });
    }


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
      const selected = Array.from(overlay.querySelectorAll(".cu-select:checked"));
      const selectedIds = kind => new Set(selected.filter(input => input.dataset.bulkKind === kind).map(input => input.dataset.bulkId));
      const taskSelection = selectedIds("task");
      const triageSelection = selectedIds("triage");
      const queue = [...rowEls.keys()].filter(id => !selected.length || taskSelection.has(String(id)));
      const triQueue = [...triEls.keys()].filter(id => !selected.length || triageSelection.has(String(id)));
      const step = (n) => { allBtn.textContent = "Moving " + n + " of " + (queue.length + triQueue.length) + "…"; };
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
      // One refold for the whole batch, after both loops have written.
      if (moved || placed) await CO.refoldViewedDay(target);
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
      if (typeof showToast === "function" && parts.length) showToast("Moved " + parts.join(" and ") + " to today", "success");
    };
    allBtn.addEventListener("click", _allHandler, { once: true });

    if (!overlay.classList.contains("open")) _returnFocus = document.activeElement;
    overlay.classList.add("open");
    if (cfg.focus !== false) {
      const first = overlay.querySelector(".it-list-check, #catchup-close");
      if (first && typeof first.focus === "function") first.focus();
    }
  }

  // ── entry points ──
  // Only actionable work contributes to this queue.
  function snapshotCount(snapshot) {
    if (!snapshot) return 0;
    return rootsOf(snapshot.res.rows).length + snapshot.triage.length;
  }

  async function collectSnapshot() {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return null;
    const results = await Promise.allSettled([CO.collect()]);
    const failed = results.some(result => result.status === "rejected" || result.value?.failed === true);
    const snapshot = {
      res: results[0].status === "fulfilled" ? results[0].value : (_lastSnapshot ? _lastSnapshot.res : { rows: [], total: 0 }),
      triage: window.DCC.TaskModel.selectLooseEndsTriage(activeTriage()),
      failed: failed
    };
    _lastSnapshot = snapshot;
    setIndicatorCount(snapshotCount(snapshot));
    return snapshot;
  }

  // Read-only owner projection. Retain each source's kind and action identity.
  async function glassesTasks() {
    const snapshot=await collectSnapshot();
    if(!snapshot||snapshot.failed)throw new Error('Loose Ends could not be refreshed');
    const describe=(kind,actionId,ev,row,extra={})=>({kind,id:kind+':'+actionId,actionId,ev,row,title:ev.title,...extra});
    const tasks=rootsOf(snapshot.res.rows).map(ev=>describe('task',ev.__unf?.sourceId||ev._blockId||ev.id,ev,ev.__unf?.sourceBlock||null,{pool:snapshot.res.rows}));
    const triage=['slack','gmail','other'].flatMap(lane=>snapshot.triage.filter(row=>triageLane(row)===lane))
      .map(row=>describe('triage',row.id,window.DCC.TaskModel.fromTriageItem(row),row));
    const rows=tasks.concat(triage);
    // Preserve the owner's bounded-lookback metadata instead of implying that
    // the current Loose Ends scan is the entire historical task universe.
    rows.truncated=!!snapshot.res.truncated;
    rows.total=snapshot.res.total;
    return rows;
  }

  async function refreshReminder(opts) {
    opts = opts || {};
    const wasOpen = !!document.getElementById("catchup-overlay") && document.getElementById("catchup-overlay").classList.contains("open");
    const snapshot = await collectSnapshot();
    if (!snapshot) return null;
    if ((opts.open || wasOpen) && snapshotCount(snapshot)) {
      openPrompt(snapshot.res.rows, snapshot.res.total, {
        triage: snapshot.triage,
        loadFailed: snapshot.failed,
        focus: opts.focus
      });
    } else if (wasOpen && !snapshotCount(snapshot) && !snapshot.failed) {
      close();
    }
    return snapshot;
  }

  async function openReminder() {
    const snapshot = await refreshReminder({ open: true });
    if (snapshot && !snapshotCount(snapshot) && typeof showToast === "function") showToast("No Loose Ends waiting", "success");
    return !!(snapshot && snapshotCount(snapshot));
  }

  // Boot refreshes the user-opened workspace. Everything waiting rides in one pass:
  // what slipped off the last two weeks, plus every triage item needing a reply.
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
    if (courier && typeof courier.markSeen === "function") courier.markSeen(activeTriage().map(i => i.id));
    // Gate on OPEN rows, not raw rows: a pool made up entirely of done children is
    // nothing to catch up on, and prompting on it opened an empty-feeling modal.
    if (!snapshotCount(snapshot)) {
      if (!snapshot.failed) markReviewed();
      return;
    }
    // Loose Ends is user-opened. Boot only updates its truthful reminder count.
    // Do not mark it reviewed until the person closes the workspace.
    if (reviewed()) setIndicatorCount(0);
  }

  // The courier's prompt: the pet just delivered, so lead with what arrived. Older
  // triage stays folded behind one line, and the day's unfinished tasks ride along
  // exactly as they do in the morning. Deliberately NOT gated on the reviewed flag —
  // new mail is new, whether or not the morning pass already happened.
  async function openArrivals(newIds) {
    const CO = window.DCC && window.DCC.Carryover;
    if (!CO) return false;
    const ids = new Set(newIds || []);
    const all = window.DCC.TaskModel.selectLooseEndsTriage(activeTriage());
    const fresh = all.filter(i => ids.has(i.id));
    if (!fresh.length) return false;
    let res = { rows: [], total: 0 };
    let loadFailed = false;
    try { res = await CO.collect(); } catch (e) { loadFailed = true; }
    _lastSnapshot = { res, triage: all, failed: loadFailed };
    setIndicatorCount(snapshotCount(_lastSnapshot));
    if (typeof showToast === "function") showToast(fresh.length + " new Loose End" + (fresh.length === 1 ? "" : "s"), "info");
    return true;
  }

  window.addEventListener("dcc:work-session-changed", () => refreshReminder({ focus: false }));
  window.initCatchUp = initCatchUp;
  const DCC = (window.DCC = window.DCC || {});
  DCC.CatchUp = {
    glassesTasks,
    open: openReminder,
    refresh: refreshReminder,
    syncIndicator: syncIndicator,
    openArrivals: openArrivals
  };
  const pill = document.getElementById("loose-ends-pill");
  if (pill) pill.addEventListener("click", openReminder);
})();
