// ======== WAITING SIDEBAR MANAGER ========
// Waiting items are global block rows with properties.kind="delegated_item".
// Each one captures: the task I'm working on (myTask, optionally linked to a real
// task via linkedBlockId), what I'm waiting on (title), who I'm waiting on
// (delegatee.name), and how often to check in (checkInDays). The check-in cadence
// drives a creeping urgency score (green -> blue -> yellow -> red) using the shared
// window.urgency helper, exactly like repeat responsibilities; logging a check-in
// resets lastCheckedAt and the creep starts over.
// It lives in the right-hand sidebar as a peer of Repeat Responsibilities, and is
// selectable as a task destination / convert target (see openDelegatedFromTask).

(function(){
  let _currentFilter = "all";
  // Set via openDelegatedModal's prefill when converting an existing task; on a
  // successful create the source scheduled task is removed so there's no duplicate.
  let _pendingSourceTaskId = null;
  let _pendingContactMeta = null;

  function esc(s) { return window.DCC.esc(s); } // delegates to core.js

  function getAllDelegatedItems() {
    if (!window.blockStore) return [];
    return window.blockStore.getByType("block")
      .filter(b => (b.properties || {}).kind === "delegated_item")
      .sort(sortByUrgency);
  }

  function getDelegatedItemById(id) {
    return getAllDelegatedItems().find(i => i.id === id) || null;
  }

  function isTaskDependency(item) {
    const p = (item && item.properties) || {};
    return p.blockerType === "task" && !!p.blockerBlockId && !!p.linkedBlockId;
  }

  function isActiveTaskDependency(item) {
    const p = (item && item.properties) || {};
    return isTaskDependency(item) && !item.deleted_at && ["open", "ready"].includes(p.status || "open");
  }

  function blockTitle(id, fallback) {
    const block = resolveLinkedBlock(id);
    return String((block && block.properties && block.properties.title) || fallback || "Task");
  }

  function taskIdentityIds(task) {
    const p = (task && task.properties) || {};
    return new Set([task && task.id, p.local_id].filter(Boolean).map(String));
  }

  function outgoingTaskDependencies(task) {
    const ids = taskIdentityIds(task);
    return getAllDelegatedItems().filter(item => {
      const p = item.properties || {};
      return isActiveTaskDependency(item) && ids.has(String(p.blockerBlockId || ""));
    });
  }

  function taskDependencyChipHtml(task) {
    const rows = outgoingTaskDependencies(task);
    if (!rows.length) return "";
    const titles = rows.map(row => blockTitle((row.properties || {}).linkedBlockId, (row.properties || {}).myTask));
    const label = rows.length === 1 ? "Unlocks " + truncate(titles[0], 34) : "Unlocks " + rows.length + " tasks";
    return '<button type="button" class="task-dependency-pill unlocks" data-task-dependency-open="' + esc(rows[0].id) + '" title="' + esc("Unlocks: " + titles.join(", ")) + '">&#8594; ' + esc(label) + '</button>';
  }

  // ── Urgency model ──
  // How many days between check-ins. Prefers the explicit checkInDays; falls back
  // to mapping the legacy checkInCadence so pre-existing items still render. No
  // data migration needed.
  function checkInDaysFor(props) {
    props = props || {};
    const explicit = Number(props.checkInDays);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cad = String(props.checkInCadence || "").toLowerCase();
    if (cad === "daily") return 1;
    if (cad === "weekly") return 7;
    if (cad === "monthly") return 30;
    return 7;
  }

  // Which check-in style an item uses. Explicit checkInMode wins; otherwise infer
  // from the data (a stored checkInDate means a one-time date) so legacy items
  // keep working with no migration.
  function checkInModeFor(props) {
    props = props || {};
    if (props.checkInMode === "date" || props.checkInMode === "repeat") return props.checkInMode;
    return props.checkInDate ? "date" : "repeat";
  }

  // Parse a yyyy-mm-dd string as a LOCAL calendar date (avoids the UTC shift you
  // get from new Date("2026-06-25")). Returns null if unparseable.
  function parseLocalDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // Whole-day difference (target date - today), using local midnight on both
  // sides so "today" reads 0, "tomorrow" reads 1, and past dates go negative.
  function dayDiffFromToday(targetDate, now) {
    const today0 = new Date(now || Date.now());
    today0.setHours(0, 0, 0, 0);
    const tgt0 = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    return Math.round((tgt0.getTime() - today0.getTime()) / 86400000);
  }

  // {score, cls, timing} for an item. Repeating items use the shared cadence
  // creep anchored on the last check-in; dated items creep from the anchor toward
  // the chosen calendar day, hitting 100 on that day.
  function itemUrgency(item) {
    const p = item.properties || {};
    const anchorIso = p.lastCheckedAt || item.created_at || p.createdAt || null;
    const now = new Date();
    const anchor = parseLocalDate(String(anchorIso || "").slice(0, 10)) || new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let target = parseLocalDate(p.checkInDate);
    if (!target) {
      target = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      target.setDate(target.getDate() + checkInDaysFor(p));
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cadence = Math.max(1, Math.round((target.getTime() - anchor.getTime()) / 86400000));
    const elapsed = Math.max(0, Math.round((today.getTime() - anchor.getTime()) / 86400000));
    const remaining = dayDiffFromToday(target, now);
    const progress = remaining <= 0 ? 100 : Math.max(0, Math.min(99, Math.round((elapsed / cadence) * 100)));
    const timing = { cadence, elapsed, remaining, progress };
    return { score: progress, cls: window.urgency.scoreClass(progress), timing };
  }

  function sortByUrgency(a, b) {
    const doneA = isDoneDelegated(a);
    const doneB = isDoneDelegated(b);
    if (doneA !== doneB) return doneA ? 1 : -1;
    const readyA = isTaskDependency(a) && (a.properties || {}).status === "ready";
    const readyB = isTaskDependency(b) && (b.properties || {}).status === "ready";
    if (readyA !== readyB) return readyA ? -1 : 1;
    if (isTaskDependency(a) !== isTaskDependency(b)) return isTaskDependency(a) ? -1 : 1;
    const sa = itemUrgency(a).score;
    const sb = itemUrgency(b).score;
    if (sb !== sa) return sb - sa;
    return ((a.properties || {}).title || "").localeCompare((b.properties || {}).title || "");
  }

  function isDoneDelegated(item) {
    if (!item) return false;
    const p = item.properties || {};
    return !!p.completedAt || p.status === "done" || p.status === "unblocked";
  }

  function isOpenDelegated(item) {
    return !isDoneDelegated(item);
  }

  function isOverdue(item) {
    return isOpenDelegated(item) && itemUrgency(item).timing.remaining < 0;
  }

  function collectVisibleContextIds() {
    const ids = new Set();
    const blocks = (typeof scheduled !== "undefined" && Array.isArray(scheduled)) ? scheduled : [];
    const backlogItems = (typeof backlog !== "undefined" && Array.isArray(backlog)) ? backlog : [];
    blocks.concat(backlogItems).forEach(item => {
      if (!item) return;
      [item.id, item.blockId, item.local_id, item.linkedBlockId, item.linkedTagId].forEach(v => {
        if (v) ids.add(String(v));
      });
      if (Array.isArray(item.tags)) {
        item.tags.forEach(t => { if (t) ids.add(String(t)); });
      }
    });
    return ids;
  }

  function isLinkedToVisibleContext(item) {
    const p = item.properties || {};
    const ids = collectVisibleContextIds();
    return !!((p.linkedBlockId && ids.has(String(p.linkedBlockId))) ||
      (p.linkedTagId && ids.has(String(p.linkedTagId))));
  }

  function todayStr() {
    if (typeof _resolvedTodayDate === "function") return _resolvedTodayDate();
    if (typeof __todayDate === "string" && __todayDate) return __todayDate;
    return toDateInputValue(new Date());
  }

  function isSnoozed(item) {
    const until = String(((item.properties || {}).snoozedUntil) || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(until) && until > todayStr();
  }

  // Waiting enters Loose Ends as soon as its urgency reaches 70 percent.
  function attentionItems(items) {
    return items.filter(item => {
      if (!isOpenDelegated(item) || isSnoozed(item) || isTaskDependency(item)) return false;
      const p = item.properties || {};
      // Once a real check-in task owns this cycle, Loose Ends no longer needs a
      // second decision row. The triage draft remains available for review/send.
      if (p.checkInTaskId && p.checkInScheduledFor && p.checkInScheduledFor >= todayStr()) return false;
      const u = itemUrgency(item);
      return u.score >= 70 || u.timing.remaining < 0;
    });
  }

  function blockerLabel(item) {
    const p = item.properties || {};
    const who = (p.delegatee && p.delegatee.name) || "";
    const what = String(p.title || "").trim();
    if (who && what) return "Blocked by " + who + ": " + what;
    if (who) return "Waiting on " + who;
    return what || "Waiting on an external dependency";
  }

  function cycleKey(item) {
    const p = item.properties || {};
    let due = p.checkInDate || "";
    if (!due) {
      const anchor = parseLocalDate(String(p.lastCheckedAt || item.created_at || "").slice(0, 10)) || new Date();
      anchor.setDate(anchor.getDate() + checkInDaysFor(p));
      due = toDateInputValue(anchor);
    }
    return "waiting:" + item.id + ":" + due;
  }

  function filterItems(items, filter) {
    switch (filter) {
      case "upcoming":
        return items.filter(i => isOpenDelegated(i) && (isTaskDependency(i) || itemUrgency(i).timing.remaining >= 0));
      case "overdue":
        return items.filter(isOverdue);
      case "done":
        return items.filter(isDoneDelegated);
      default:
        return items;
    }
  }

  // Human-readable countdown, mirroring responsibilities' dueLabel.
  function dueLabel(item) {
    const t = itemUrgency(item).timing;
    if (t.remaining < 0) return Math.abs(t.remaining) + "d overdue";
    if (t.remaining === 0) return "check in today";
    if (t.remaining === 1) return "1d left";
    return t.remaining + "d left";
  }

  function truncate(s, n) {
    s = String(s || "").trim();
    if (!s || s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)).trim() + "...";
  }

  function renderDelegatedSidebar() {
    const mount = document.getElementById("delegated-blocked-list");
    if (!mount) return;

    const all = getAllDelegatedItems();
    const open = all.filter(isOpenDelegated);
    updateBadge(open.length);

    const list = filterItems(all, _currentFilter);
    const rows = list.length ? list.map(renderCard).join("") : renderEmpty(true, all.length);
    mount.innerHTML =
      '<div class="delegated-sidebar-tools">' +
        '<button type="button" class="delegated-mini-btn" data-delegated-action="new">+ New</button>' +
        renderFilters() +
      '</div>' +
      '<div class="delegated-itinerary-list">' + rows + '</div>';

    wireDelegatedMount(mount);
  }

  function renderFilters() {
    const filters = [
      ["all", "All"],
      ["upcoming", "Upcoming"],
      ["overdue", "Overdue"],
      ["done", "Done"]
    ];
    return '<div class="delegated-filter-bar">' + filters.map(([id, label]) =>
      '<button type="button" class="delegated-filter-btn' + (_currentFilter === id ? ' active' : '') + '" data-filter="' + id + '">' + label + '</button>'
    ).join("") + '</div>';
  }

  function renderEmpty(managerOpen, totalCount) {
    if (managerOpen && totalCount) return '<div class="delegated-empty">No Waiting items match this filter.</div>';
    if (managerOpen) return '<div class="delegated-empty">Nothing waiting yet.</div>';
    return '<div class="delegated-empty">No check-ins need attention.</div>';
  }

  function renderTaskDependencyCard(item) {
    const p = item.properties || {};
    const closed = isDoneDelegated(item);
    const ready = p.status === "ready";
    const dependent = blockTitle(p.linkedBlockId, p.myTask);
    const blocker = blockTitle(p.blockerBlockId, p.title);
    const icon = (ready || closed) ? "&#10003;" : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    const statePill = closed
      ? '<span class="task-dependency-pill ready">&#10003; Released</span>'
      : '<button type="button" class="task-dependency-pill ' + (ready ? "ready" : "blocked") + '" data-delegated-action="dependency-edit" data-id="' + esc(item.id) + '" title="Change prerequisite">' + (ready ? "&#10003; Ready" : "&#128274; Blocked by " + esc(truncate(blocker, 44))) + "</button>";
    let actions = "";
    if (closed) {
      actions += '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>';
    } else if (ready) {
      actions += '<button type="button" data-delegated-action="unblock" data-id="' + esc(item.id) + '">Schedule task</button>';
      actions += '<button type="button" data-delegated-action="dependency-backlog" data-id="' + esc(item.id) + '">Move to Solo</button>';
    }
    if (!closed) {
      actions += '<button type="button" data-delegated-action="dependency-edit" data-id="' + esc(item.id) + '">Change prerequisite</button>';
      actions += '<button type="button" data-delegated-action="dependency-remove" data-id="' + esc(item.id) + '">' + (ready ? "Remove dependency" : "Unblock to Solo") + "</button>";
    }
    return '<div class="delegated-card delegated-itinerary-card task-dependency-card' + ((ready || closed) ? " dependency-ready" : "") + '" data-id="' + esc(item.id) + '">' +
      '<div class="delegated-card-score dependency' + ((ready || closed) ? " ready" : "") + '">' + icon + "</div>" +
      '<div class="delegated-card-body"><div class="delegated-card-title">' + esc(dependent) + '</div><div class="delegated-card-meta">' + statePill + "</div></div>" +
      '<div class="delegated-card-actions">' + actions + "</div></div>";
  }

  function renderCard(item) {
    const p = item.properties || {};
    if (isTaskDependency(item)) return renderTaskDependencyCard(item);
    const done = isDoneDelegated(item);
    const u = itemUrgency(item);
    const cls = done ? "" : u.cls;

    const who = (p.delegatee && p.delegatee.name) || "";
    const waiting = (p.title || "").trim();
    const myTask = (p.myTask || "").trim();
    const headline = myTask || waiting || "(untitled)";
    const note = truncate(p.aiSummary || p.notes || "", 120);

    // Subline: legacy items may still carry a separate what/who; surface them
    // under the headline. The due label always shows.
    const subParts = [];
    if (myTask && waiting) subParts.push('Waiting on ' + esc(waiting));
    if (who) subParts.push((myTask && waiting ? ' from ' : 'Waiting on ') + esc(who));
    const sub = subParts.map(s => '<span>' + s + '</span>').join("");

    const cardCls = [
      "delegated-card",
      "delegated-itinerary-card",
      cls,
      done ? "done" : ""
    ].filter(Boolean).join(" ");

    const badge = done
      ? '<div class="delegated-card-score done">&#10003;</div>'
      : '<div class="delegated-card-score ' + cls + '">' + u.score + '</div>';

    const linkChip = p.linkedBlockId ? '<span class="delegated-card-link">linked task</span>' : '';
    const sourceRef = (p.contact && p.contact.sourceRef) || p.source_id || "";
    const sourceLink = /^https?:\/\//.test(sourceRef)
      ? '<a class="delegated-card-source" href="' + esc(sourceRef) + '" target="_blank" rel="noopener" title="Open source" onclick="event.stopPropagation()">Source &#8599;</a>'
      : '';

    const actionButtons = done ?
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>' :
      '<button type="button" data-delegated-action="check-in" data-id="' + esc(item.id) + '">Checked in</button>' +
      '<button type="button" data-delegated-action="schedule" data-id="' + esc(item.id) + '">Schedule check-in</button>' +
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="unblock" data-id="' + esc(item.id) + '" title="The blocker is gone. Put the actual task on your schedule.">Schedule task</button>' +
      '<button type="button" data-delegated-action="complete" data-id="' + esc(item.id) + '" title="The actual task is already finished.">Complete task</button>' +
      '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>';

    return '<div class="' + cardCls + '" data-id="' + esc(item.id) + '">' +
      badge +
      '<div class="delegated-card-body">' +
        '<div class="delegated-card-title">' + esc(headline) + linkChip + sourceLink + '</div>' +
        '<div class="delegated-card-meta">' +
          sub +
          '<span class="delegated-card-when">' + esc(dueLabel(item)) + '</span>' +
        '</div>' +
        (done ? '' : '<div class="delegated-card-meter"><span class="' + u.cls + '" style="width:' + u.timing.progress + '%"></span></div>') +
        (note ? '<div class="delegated-card-note">' + esc(note) + '</div>' : '') +
      '</div>' +
      '<div class="delegated-card-actions">' + actionButtons + '</div>' +
    '</div>';
  }

  function wireDelegatedMount(mount) {
    mount.querySelectorAll("[data-delegated-action]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const action = btn.dataset.delegatedAction;
        const id = btn.dataset.id;
        if (action === "new") {
          openDelegatedModal(null);
        } else if (action === "check-in") {
          markDelegatedItemCheckedById(id);
        } else if (action === "schedule") {
          scheduleDelegatedItem(id, btn);
        } else if (action === "edit") {
          openDelegatedModal(id);
        } else if (action === "unblock") {
          unblockWaitingItem(id, btn);
        } else if (action === "complete") {
          completeWaitingItem(id);
        } else if (action === "dependency-backlog") {
          releaseTaskDependencyToBacklog(id);
        } else if (action === "dependency-edit") {
          openTaskDependencyModal(null, id);
        } else if (action === "dependency-remove") {
          removeTaskDependency(id);
        } else if (action === "delete") {
          deleteDelegatedItem(id);
        }
      });
    });
    mount.querySelectorAll(".delegated-filter-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        _currentFilter = btn.dataset.filter || "all";
        renderDelegatedSidebar();
      });
    });
    mount.querySelectorAll("[data-task-dependency-open]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        openWaitingItem(btn.dataset.taskDependencyOpen);
      });
    });
  }

  function updateBadge(openCount) {
    const countBadge = document.getElementById("delegated-blocked-count");
    if (!countBadge) return;
    if (openCount > 0) {
      countBadge.textContent = openCount;
      countBadge.style.display = "";
    } else {
      countBadge.style.display = "none";
    }
  }

  // Plain-text nudge used when scheduling a follow-up (copied to clipboard as a fallback).
  function buildDelegatedMessage(item) {
    const p = item.properties || {};
    const name = (p.delegatee && p.delegatee.name) || "";
    const greeting = name ? ("Hi " + name + ",") : "Hi,";
    const title = p.title || p.myTask || "this";
    const notes = p.notes ? ("\n\nContext: " + p.notes) : "";
    return greeting + "\n\nQuick check-in on \"" + title + "\". Could you send me a brief update when you can?" + notes + "\n\nThanks.";
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function patchDelegatedItem(id, properties, successMsg) {
    if (!id) return;
    try {
      const resp = await fetch("/api/waiting-items/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties })
      });
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Update failed");
      }
      await refreshDelegatedItems();
      if (successMsg) toast(successMsg, "success");
    } catch (e) {
      toast("Update failed: " + (e.message || e), "error");
    }
  }

  async function postWaitingAction(id, action, body) {
    const resp = await fetch("/api/waiting-items/" + encodeURIComponent(id) + "/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    if (!resp.ok) {
      let message = resp.statusText || "Action failed";
      try { message = (await resp.json()).error || message; } catch (e) {}
      throw new Error(message);
    }
    return resp.json();
  }

  async function afterWaitingAction() {
    await refreshDelegatedItems();
    if (typeof refoldTaskStateFromBlockCache === "function") refoldTaskStateFromBlockCache();
    if (typeof render === "function") render();
    if (window.DCC && window.DCC.CatchUp && typeof window.DCC.CatchUp.refresh === "function") {
      window.DCC.CatchUp.refresh();
    }
  }

  async function releaseTaskDependencyToBacklog(id, options) {
    const item = getDelegatedItemById(id);
    if (!item || !isTaskDependency(item)) return false;
    options = options || {};
    try {
      await postWaitingAction(id, "unblock", {
        destination: "backlog",
        taskBlockId: (item.properties || {}).linkedBlockId,
      });
      await afterWaitingAction();
      toast(options.removed ? "Dependency removed. Task moved to Solo." : "Task moved to Solo.", "success");
      return true;
    } catch (e) {
      toast("Could not release task: " + (e.message || e), "error");
      return false;
    }
  }

  function removeTaskDependency(id) {
    return releaseTaskDependencyToBacklog(id, { removed: true });
  }

  // Completing a check-in advances the recurring cadence exactly once.
  async function markDelegatedItemCheckedById(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    try {
      await postWaitingAction(id, "check-ins/complete", {
        cycleKey: cycleKey(item),
        completedAt: new Date().toISOString()
      });
      closeDelegatedModal();
      await afterWaitingAction();
      toast("Checked in. The next reminder is scheduled.", "success");
      return true;
    } catch (e) {
      toast("Could not complete check-in: " + (e.message || e), "error");
      return false;
    }
  }

  async function snoozeWaitingItem(id, until) {
    try {
      await postWaitingAction(id, "snooze", { until });
      await afterWaitingAction();
      toast("Waiting item snoozed until " + until, "success");
      return true;
    } catch (e) {
      toast("Could not snooze Waiting item: " + (e.message || e), "error");
      return false;
    }
  }

  // Resolve the work itself. This is intentionally separate from "Checked in",
  // which only advances the reminder cadence and leaves the work open.
  async function completeWaitingItem(id) {
    const item = getDelegatedItemById(id);
    if (!item) return false;
    if (typeof window.confirm === "function" && !window.confirm("Mark this task complete and close its Waiting item?")) return false;
    try {
      await postWaitingAction(id, "complete", { completedAt: new Date().toISOString() });
      closeDelegatedModal();
      await afterWaitingAction();
      toast("Task completed and Waiting item closed.", "success");
      return true;
    } catch (e) {
      toast("Could not complete task: " + (e.message || e), "error");
      return false;
    }
  }

  // Schedule a 15-minute check-in task, then move the Waiting due date to match.
  function scheduleDelegatedItem(id, anchorEl, onScheduled, selectedDate) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    const p = item.properties || {};
    if ((!selectedDate && typeof openDatePickPopover !== "function") || typeof scheduleTaskOnDate !== "function" || !window.blockStore) {
      copyText(buildDelegatedMessage(item));
      toast("Message copied; scheduler is unavailable.", "info");
      return;
    }
    const what = p.title || p.myTask || "blocked item";
    const who = (p.delegatee && p.delegatee.name) || "";
    const ev = {
      id: "waiting-checkin-task:" + id,
      title: "Check in: " + what,
      type: "task",
      start: "00:00",
      end: "00:15",
      priority: "Medium",
      meta: "Waiting check-in - 15m",
      detail: "Check in" + (who ? " with " + who : "") + "\n\n" + blockerLabel(item) + (p.notes ? "\n\n" + p.notes : ""),
      source: "waiting-checkin",
      tags: ["waiting", "check-in"],
      delegatedItemId: id,
      linkedBlockId: p.linkedBlockId || null,
      linkedTagId: p.linkedTagId || null
    };
    const scheduleOnDate = async (dateStr) => {
      try {
        let block = resolveLinkedBlock(p.checkInTaskId);
        if (block && block.date !== dateStr && typeof scheduleRowOnDay === "function" && window.DCC && window.DCC.getDayContext && window.DCC.findSlot) {
          const ctx = await window.DCC.getDayContext(dateStr);
          const slot = ctx && window.DCC.findSlot(ev, ctx, { anchorNow: true });
          block = slot ? await scheduleRowOnDay(block.id, dateStr, { block, start: slot.start, end: slot.end }) : null;
        }
        if (!block) block = await scheduleTaskOnDate(ev, dateStr, { useExisting: true, silent: true });
        if (!block) {
          toast("No free slot on " + dateStr, "error");
          return false;
        }
        await postWaitingAction(id, "check-ins/schedule", { date: dateStr, taskBlockId: block.id });
        await afterWaitingAction();
        const bp = block.properties || {};
        const label = (typeof _prettyDateLabel === "function") ? _prettyDateLabel(dateStr) : dateStr;
        const at = (bp.start && typeof f12 === "function") ? " at " + f12(bp.start) : "";
        toast("Check-in scheduled " + label + at, "success");
        if (typeof onScheduled === "function") onScheduled();
        return true;
      } catch (e) {
        toast("Could not schedule check-in: " + (e.message || e), "error");
        return false;
      }
    };
    if (selectedDate) return scheduleOnDate(selectedDate);
    openDatePickPopover(anchorEl, {
      header: 'Schedule "' + ev.title + '" for…',
      actionLabel: "Schedule",
      onPick: scheduleOnDate
    });
  }

  function resolveLinkedBlock(id) {
    if (!id || !window.blockStore) return null;
    const direct = window.blockStore.get(id);
    if (direct) return direct;
    return window.blockStore.getByType("block").find(block => {
      const p = block.properties || {};
      return String(p.local_id || "") === String(id);
    }) || null;
  }

  function unblockWaitingItem(id, anchorEl, selectedDate) {
    const item = getDelegatedItemById(id);
    if (!item || !window.blockStore) return false;
    const p = item.properties || {};
    const linked = resolveLinkedBlock(p.linkedBlockId);
    const scheduleOnDate = async (targetDate) => {
      try {
        let block = linked && linked.date === targetDate ? linked : null;
        if (linked && !block && typeof scheduleRowOnDay === "function" && window.DCC && window.DCC.getDayContext && window.DCC.findSlot) {
          const duration = Math.max(1, Number(linked.properties && (linked.properties.duration || linked.properties.durMin)) || 30);
          const endHour = Math.floor(duration / 60);
          const endMinute = duration % 60;
          const ev = { id: linked.id, title: p.myTask || p.title || "Unblocked task", start: "00:00", end: String(endHour).padStart(2, "0") + ":" + String(endMinute).padStart(2, "0") };
          const ctx = await window.DCC.getDayContext(targetDate);
          const slot = ctx && window.DCC.findSlot(ev, ctx, { anchorNow: true });
          if (slot) block = await scheduleRowOnDay(linked.id, targetDate, { block: linked, start: slot.start, end: slot.end });
        }
        if (linked && !block) {
          toast("No free slot on that day for the linked task. The Waiting item is still open.", "error");
          return false;
        }
        if (!linked && !block) {
          const ev = {
            id: "waiting-unblock-task:" + id,
            title: p.myTask || p.title || "Unblocked task",
            type: "task",
            start: "00:00",
            end: "00:30",
            priority: p.priority || "Medium",
            detail: blockerLabel(item) + (p.notes ? "\n\n" + p.notes : ""),
            source: "waiting-unblock",
            tags: ["waiting", "unblocked"],
            delegatedItemId: id
          };
          block = await scheduleTaskOnDate(ev, targetDate, { useExisting: true, silent: true });
        }
        if (!block) {
          toast("No free slot on that day. The Waiting item is still open.", "error");
          return false;
        }
        await postWaitingAction(id, "unblock", { taskBlockId: block.id, date: targetDate });
        await afterWaitingAction();
        const label = (typeof _prettyDateLabel === "function") ? _prettyDateLabel(targetDate) : targetDate;
        toast("Task scheduled " + label + " and Waiting item closed.", "success");
        return true;
      } catch (e) {
        toast("Could not schedule task: " + (e.message || e), "error");
        return false;
      }
    };
    if (selectedDate) return scheduleOnDate(selectedDate);
    if (typeof openDatePickPopover === "function" && anchorEl) {
      openDatePickPopover(anchorEl, {
        header: 'Schedule "' + (p.myTask || p.title || "task") + '" for…',
        actionLabel: "Schedule task",
        onPick: scheduleOnDate
      });
      return true;
    }
    return scheduleOnDate(todayStr());
  }

  function toast(message, type) { return window.DCC.toast(message, type); } // delegates to core.js

  // Generated check-in reminders call this to return to their canonical item.
  function openWaitingItem(id) {
    const item = getDelegatedItemById(id);
    if (!item) {
      toast("That Waiting item is no longer available.", "info");
      return false;
    }
    _currentFilter = "all";
    renderDelegatedSidebar();
    if (typeof window.openTasksToSection === "function") {
      window.openTasksToSection("tm-delegated-blocked-section", { solo: true });
    }
    setTimeout(() => {
      const card = Array.from(document.querySelectorAll("#delegated-blocked-list .delegated-card"))
        .find(node => node.dataset.id === String(id));
      if (!card) return;
      card.classList.add("delegated-card-target");
      card.setAttribute("tabindex", "-1");
      card.focus({ preventScroll: true });
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => card.classList.remove("delegated-card-target"), 2200);
    }, 260);
    return true;
  }

  function notifyReadyTaskDependencies(transitions) {
    const ready = (Array.isArray(transitions) ? transitions : []).filter(item => item && item.status === "ready");
    if (!ready.length) return false;
    const message = ready.length === 1
      ? (ready[0].title || "A blocked task") + " is ready"
      : ready.length + " blocked tasks are ready";
    Promise.resolve(afterWaitingAction()).catch(() => {}).finally(() => {
      window.DCC.toast(message, "success", 12000, {
        label: "Review",
        onClick: () => openWaitingItem(ready[0].id),
      });
    });
    return true;
  }

  function openDelegatedModal(idOrNull, prefill) {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (!overlay) return;
    prefill = prefill || {};
    // Authoritative reset: only set when converting an existing task (carries its id).
    _pendingSourceTaskId = prefill.sourceTaskId || null;
    const item = idOrNull ? getDelegatedItemById(idOrNull) : null;
    const p = item ? (item.properties || {}) : {};

    setVal("dm-id", idOrNull || "");
    setVal("dm-my-task", p.myTask || prefill.myTask || prefill.title || "");
    const contact = (p.contact && typeof p.contact === "object") ? p.contact : (prefill.contact || {});
    _pendingContactMeta = {
      threadTs: contact.threadTs || contact.thread_ts || "",
      messageTs: contact.messageTs || contact.message_ts || ""
    };
    setVal("dm-waiting-reason", p.waitingReason || prefill.waitingReason || "blocked");
    setVal("dm-blocker-title", p.title || prefill.blockerTitle || "");
    setVal("dm-blocker-name", (p.delegatee && p.delegatee.name) || prefill.blockerName || "");
    setVal("dm-blocker-kind", (p.delegatee && p.delegatee.kind) || "person");
    setVal("dm-contact-channel", contact.channel || "other");
    setVal("dm-contact-address", contact.address || "");
    setVal("dm-contact-source-ref", contact.sourceRef || contact.source_ref || p.source_id || "");
    setVal("dm-notes", p.notes || "");
    setVal("dm-linked-tag-id", p.linkedTagId || prefill.linkedTagId || "");
    setVal("dm-linked-block-id", p.linkedBlockId || prefill.linkedBlockId || "");

    // Task-link picker: reflect the currently linked task (if any). Editing the
    // free-text field afterward clears the link (wired in init).
    populateTaskLinkSelect(valueOf("dm-linked-block-id"));

    // Check-in controls. New items default to a one-time date; existing items
    // restore whichever style they were saved with.
    const mode = item ? checkInModeFor(p) : (prefill.checkInMode || "date");
    setVal("dm-check-in-days", item ? checkInDaysFor(p) : (prefill.checkInDays || 7));
    setVal("dm-check-in-date", (item && p.checkInDate) ? p.checkInDate : (prefill.checkInDate || ""));
    setCheckInMode(mode);

    const titleEl = document.getElementById("delegated-modal-title");
    if (titleEl) titleEl.textContent = idOrNull ? "Edit Waiting item" : "New Waiting item";
    const checkBtn = document.getElementById("dm-mark-checked");
    if (checkBtn) checkBtn.style.display = (idOrNull && item && isOpenDelegated(item)) ? "" : "none";

    overlay.classList.add("open");
    setTimeout(() => { const t = document.getElementById("dm-my-task"); if (t) t.focus(); }, 20);
  }

  // Open the modal to create a Delegated / Blocked item from a task: the add-bar
  // destination ("Delegated / Blocked") or a convert action on an existing task.
  // The typed/task text becomes "the task you're working on" (myTask). When a
  // sourceTaskId is supplied, the original scheduled task is removed once saved.
  function openDelegatedFromTask(task) {
    task = task || {};
    const title = String(task.title || task.text || "").trim();
    if (!title) { toast("Task title is required", "error"); return; }
    const sourceTaskId = task.sourceTaskId || task.linkedBlockId || null;
    const sourceBlock = resolveLinkedBlock(sourceTaskId);
    const sourceProps = sourceBlock ? (sourceBlock.properties || {}) : {};
    const slackContact = sourceProps.contact || (sourceProps.source === "slack-bookmark" || sourceProps.source === "slack-delegate" ? {
      channel: "slack",
      address: sourceProps.slack_channel || "",
      sourceRef: sourceProps.source_id || "",
      threadTs: sourceProps.slack_thread_ts || sourceProps.slack_ts || "",
      messageTs: sourceProps.slack_ts || ""
    } : null);
    openDelegatedModal(null, {
      myTask: title,
      sourceTaskId,
      linkedBlockId: sourceBlock && sourceBlock.id,
      waitingReason: slackContact ? "delegated" : "blocked",
      contact: slackContact || undefined
    });
  }

  function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value == null ? "" : value;
  }

  // Tasks the user can link "the task you're working on" to: today's itinerary
  // rows plus backlog items, deduped by id.
  function getLinkableTasks() {
    const out = [];
    const seen = new Set();
    const push = (t) => {
      if (!t) return;
      const id = t._blockId || t.blockId || t.id || t.local_id;
      const title = String(t.title || t.text || "").trim();
      if (!id || !title || seen.has(String(id))) return;
      seen.add(String(id));
      out.push({ id: String(id), title });
    };
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) scheduled.forEach(push);
    if (typeof backlog !== "undefined" && Array.isArray(backlog)) backlog.forEach(push);
    return out;
  }

  function closeTaskDependencyModal() {
    const overlay = document.getElementById("task-dependency-modal-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  function openTaskDependencyModal(blockedTaskId, waitingId) {
    const overlay = document.getElementById("task-dependency-modal-overlay");
    if (!overlay) return false;
    const item = waitingId ? getDelegatedItemById(waitingId) : null;
    const p = (item && item.properties) || {};
    const dependent = resolveLinkedBlock(p.linkedBlockId || blockedTaskId);
    if (!dependent) { toast("That task is no longer available.", "error"); return false; }
    const dependentTitle = String((dependent.properties || {}).title || p.myTask || "this task");
    setVal("td-waiting-id", item ? item.id : "");
    setVal("td-dependent-id", dependent.id);
    setVal("td-new-title", "");
    setVal("td-new-duration", "30");
    setVal("td-new-priority", "Medium");
    const label = document.getElementById("td-dependent-label");
    if (label) label.textContent = '“' + dependentTitle + '” will move to Waiting until its prerequisite is complete.';
    const select = document.getElementById("td-blocker-task");
    if (select) {
      const dependentIds = taskIdentityIds(dependent);
      const tasks = getLinkableTasks().filter(task => !dependentIds.has(String(task.id)));
      const selectedId = String(p.blockerBlockId || "");
      if (selectedId && !tasks.some(task => String(task.id) === selectedId)) {
        tasks.unshift({ id: selectedId, title: blockTitle(selectedId, p.title) });
      }
      select.innerHTML = '<option value="">Choose a task…</option>' + tasks.map(task =>
        '<option value="' + esc(task.id) + '">' + esc(truncate(task.title, 90)) + "</option>"
      ).join("");
      select.value = selectedId;
    }
    overlay.classList.add("open");
    setTimeout(() => { if (select) select.focus(); }, 20);
    return true;
  }

  async function saveTaskDependency() {
    const waitingId = valueOf("td-waiting-id");
    const dependentId = valueOf("td-dependent-id");
    const newTitle = valueOf("td-new-title").trim();
    let blockerId = valueOf("td-blocker-task");
    let blockerTitle = "";
    let newBlocker = null;
    const save = document.getElementById("td-save");
    if (save) save.disabled = true;
    try {
      if (newTitle) {
        newBlocker = {
          title: newTitle,
          duration: Math.max(1, Number(valueOf("td-new-duration")) || 30),
          priority: valueOf("td-new-priority") || "Medium",
        };
        blockerId = null;
        blockerTitle = newTitle;
      } else if (blockerId) {
        blockerTitle = blockTitle(blockerId, "Prerequisite");
      }
      if (!blockerId && !newBlocker) throw new Error("Choose an open task or create a prerequisite");
      const dependent = resolveLinkedBlock(dependentId);
      if (!dependent) throw new Error("The blocked task is no longer available");
      const prior = waitingId ? getDelegatedItemById(waitingId) : null;
      const properties = {
        blockerType: "task", blockerBlockId: blockerId, linkedBlockId: dependent.id,
        waitingReason: "blocked", title: blockerTitle,
        myTask: String((dependent.properties || {}).title || "Blocked task"),
        delegatee: { name: null, kind: "task" },
        contact: { channel: "other", address: "", sourceRef: "" },
        checkInDate: null, snoozedUntil: null,
        status: prior ? ((prior.properties || {}).status || "open") : "open",
      };
      const resp = await fetch(waitingId ? "/api/waiting-items/" + encodeURIComponent(waitingId) : "/api/waiting-items", {
        method: waitingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties, ...(newBlocker ? { newBlocker } : {}) }),
      });
      if (!resp.ok) {
        let message = resp.statusText || "Could not link tasks";
        try { message = (await resp.json()).error || message; } catch (e) {}
        throw new Error(message);
      }
      closeTaskDependencyModal();
      await afterWaitingAction();
      toast(waitingId ? "Prerequisite updated." : "Task moved to Waiting until its prerequisite is complete.", "success");
      return true;
    } catch (e) {
      toast("Could not link tasks: " + (e.message || e), "error");
      return false;
    } finally {
      if (save) save.disabled = false;
    }
  }

  function populateTaskLinkSelect(selectedId) {
    const sel = document.getElementById("dm-task-link");
    if (!sel) return;
    const tasks = getLinkableTasks();
    let html = '<option value="">— Type a new task below —</option>';
    tasks.forEach(t => {
      html += '<option value="' + esc(t.id) + '">' + esc(truncate(t.title, 80)) + '</option>';
    });
    sel.innerHTML = html;
    // Only preselect when the linked id is actually present in the current list.
    sel.value = (selectedId && tasks.some(t => t.id === String(selectedId))) ? String(selectedId) : "";
  }

  function toDateInputValue(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // Show one check-in pane (date | repeat) and sync the toggle + hidden field.
  function setCheckInMode(mode) {
    mode = mode === "repeat" ? "repeat" : "date";
    setVal("dm-check-in-mode", mode);
    const datePane = document.getElementById("dm-checkin-pane-date");
    const repeatPane = document.getElementById("dm-checkin-pane-repeat");
    if (datePane) datePane.style.display = mode === "date" ? "" : "none";
    if (repeatPane) repeatPane.style.display = mode === "repeat" ? "" : "none";
    document.querySelectorAll(".dm-checkin-tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.checkinMode === mode);
    });
  }

  function closeDelegatedModal() {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (overlay) overlay.classList.remove("open");
    _pendingContactMeta = null;
  }

  async function saveDelegatedItem() {
    const id = valueOf("dm-id") || null;
    const myTaskVal = valueOf("dm-my-task").trim();
    if (!myTaskVal) { toast("Name the task you're working on", "error"); return; }
    const blockerTitle = valueOf("dm-blocker-title").trim();
    const blockerName = valueOf("dm-blocker-name").trim();
    if (!blockerTitle && !blockerName) { toast("Name what or who is blocking the task", "error"); return; }
    const mode = valueOf("dm-check-in-mode") === "repeat" ? "repeat" : "date";
    let checkInDays = parseInt(valueOf("dm-check-in-days"), 10);
    if (!Number.isFinite(checkInDays) || checkInDays < 1) checkInDays = 7;
    const checkInDate = mode === "date" ? (valueOf("dm-check-in-date") || "") : "";
    if (mode === "date" && !checkInDate) { toast("Pick a check-in date, or use the cadence", "error"); return; }
    const cadenceDate = new Date();
    cadenceDate.setDate(cadenceDate.getDate() + checkInDays);
    const effectiveCheckInDate = mode === "date" ? checkInDate : toDateInputValue(cadenceDate);
    const existing = id ? getDelegatedItemById(id) : null;
    const existingProps = existing ? (existing.properties || {}) : {};
    const properties = {
      title: blockerTitle,
      myTask: myTaskVal,
      waitingReason: valueOf("dm-waiting-reason") || "blocked",
      delegatee: {
        name: blockerName || null,
        kind: valueOf("dm-blocker-kind") || "person"
      },
      contact: {
        ...((existingProps.contact && typeof existingProps.contact === "object") ? existingProps.contact : (_pendingContactMeta || {})),
        channel: valueOf("dm-contact-channel") || "other",
        address: valueOf("dm-contact-address").trim(),
        sourceRef: valueOf("dm-contact-source-ref").trim()
      },
      checkInMode: mode,
      checkInDays,
      checkInDate: effectiveCheckInDate,
      notes: valueOf("dm-notes").trim() || "",
      linkedTagId: valueOf("dm-linked-tag-id") || null,
      linkedBlockId: valueOf("dm-linked-block-id") || null,
      status: existing && (existing.properties || {}).status ? (existing.properties || {}).status : "open"
    };

    if (existing) {
      const p = existing.properties || {};
      if (p.lastCheckedAt) properties.lastCheckedAt = p.lastCheckedAt;
      if (p.completedAt) properties.completedAt = p.completedAt;
    }

    try {
      let resp;
      if (id) {
        resp = await fetch("/api/waiting-items/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties })
        });
      } else {
        resp = await fetch("/api/waiting-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties })
        });
      }
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Save failed");
      }
      // Capture before close (closeDelegatedModal does not clear it, but be explicit).
      const convertedFrom = id ? null : _pendingSourceTaskId;
      _pendingSourceTaskId = null;
      closeDelegatedModal();
      await refreshDelegatedItems();
      if (convertedFrom && typeof window.removeTaskForConversion === "function") {
        window.removeTaskForConversion(convertedFrom);
      }
      toast(id ? "Waiting item updated" : (convertedFrom ? "Task moved to Waiting" : "Waiting item created"), "success");
    } catch (e) {
      toast("Save failed: " + (e.message || e), "error");
    }
  }

  function valueOf(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  }

  async function deleteDelegatedItem(id) {
    if (!id) return;
    if (typeof window.confirm === "function" && !window.confirm("Delete this Waiting item? This cannot be undone.")) return;
    try {
      const resp = await fetch("/api/waiting-items/" + id, { method: "DELETE" });
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Delete failed");
      }
      await refreshDelegatedItems();
      toast("Waiting item deleted", "success");
    } catch (e) {
      toast("Delete failed: " + (e.message || e), "error");
    }
  }

  async function refreshDelegatedItems() {
    try {
      if (window.blockStore && typeof window.blockStore.loadGlobals === "function") {
        await window.blockStore.loadGlobals();
      }
      renderDelegatedSidebar();
      if (typeof buildBacklog === "function") buildBacklog();
    } catch (e) {
      console.warn("[delegated] refresh failed:", e && e.message ? e.message : e);
    }
  }

  function init() {
    const cancelBtn = document.getElementById("dm-cancel");
    const saveBtn = document.getElementById("dm-save");
    const checkBtn = document.getElementById("dm-mark-checked");
    const overlay = document.getElementById("delegated-modal-overlay");
    const dependencyOverlay = document.getElementById("task-dependency-modal-overlay");
    if (cancelBtn) cancelBtn.addEventListener("click", closeDelegatedModal);
    if (saveBtn) saveBtn.addEventListener("click", saveDelegatedItem);
    if (checkBtn) checkBtn.addEventListener("click", () => markDelegatedItemCheckedById(valueOf("dm-id")));
    if (overlay) overlay.addEventListener("click", e => {
      if (e.target === overlay) closeDelegatedModal();
    });
    const dependencyCancel = document.getElementById("td-cancel");
    const dependencySave = document.getElementById("td-save");
    const dependencySelect = document.getElementById("td-blocker-task");
    const dependencyNewTitle = document.getElementById("td-new-title");
    if (dependencyCancel) dependencyCancel.addEventListener("click", closeTaskDependencyModal);
    if (dependencySave) dependencySave.addEventListener("click", saveTaskDependency);
    if (dependencyOverlay) dependencyOverlay.addEventListener("click", e => {
      if (e.target === dependencyOverlay) closeTaskDependencyModal();
    });
    if (dependencySelect) dependencySelect.addEventListener("change", () => {
      if (dependencySelect.value) setVal("td-new-title", "");
    });
    if (dependencyNewTitle) dependencyNewTitle.addEventListener("input", () => {
      if (dependencyNewTitle.value.trim() && dependencySelect) dependencySelect.value = "";
    });
    document.addEventListener("click", e => {
      const pill = e.target.closest && e.target.closest("[data-task-dependency-open]");
      if (!pill) return;
      e.stopPropagation();
      openWaitingItem(pill.dataset.taskDependencyOpen);
    });

    // Task-link picker: selecting an existing task fills the working-task text and
    // records the link; typing into the text box afterward breaks the link.
    const taskLink = document.getElementById("dm-task-link");
    if (taskLink) taskLink.addEventListener("change", () => {
      const opt = taskLink.options[taskLink.selectedIndex];
      const id = taskLink.value;
      setVal("dm-linked-block-id", id || "");
      if (id && opt) setVal("dm-my-task", opt.textContent.trim());
    });
    const myTask = document.getElementById("dm-my-task");
    if (myTask) myTask.addEventListener("input", () => {
      if (valueOf("dm-linked-block-id")) {
        setVal("dm-linked-block-id", "");
        const sel = document.getElementById("dm-task-link");
        if (sel) sel.value = "";
      }
    });

    // Check-in mode toggle + quick-date shortcuts.
    document.querySelectorAll(".dm-checkin-tab").forEach(tab => {
      tab.addEventListener("click", () => setCheckInMode(tab.dataset.checkinMode));
    });
    document.querySelectorAll(".dm-quick-date").forEach(btn => {
      btn.addEventListener("click", () => {
        const d = new Date();
        if (btn.dataset.quickDate === "tomorrow") d.setDate(d.getDate() + 1);
        setVal("dm-check-in-date", toDateInputValue(d));
        setCheckInMode("date");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.renderDelegatedSidebar = renderDelegatedSidebar;
  // Back-compat aliases for existing callers, all now driving the sidebar render.
  window.buildDelegated = renderDelegatedSidebar;
  window.buildScheduleDelegated = renderDelegatedSidebar;
  window.renderDelegatedList = renderDelegatedSidebar;
  window.refreshDelegatedItems = refreshDelegatedItems;
  window.openDelegatedModal = openDelegatedModal;
  window.openDelegatedFromTask = openDelegatedFromTask;
  window.openTaskDependencyModal = openTaskDependencyModal;
  window.taskDependencyChipHtml = taskDependencyChipHtml;
  window.notifyReadyTaskDependencies = notifyReadyTaskDependencies;
  window.deleteDelegatedItem = deleteDelegatedItem;
  window.getAllDelegatedItems = getAllDelegatedItems;
  window.getDelegatedItemById = getDelegatedItemById;
  window.getAttentionWaitingItems = function() { return attentionItems(getAllDelegatedItems()); };
  window.snoozeWaitingItem = snoozeWaitingItem;
  window.scheduleWaitingCheckIn = scheduleDelegatedItem;
  window.unblockWaitingItem = unblockWaitingItem;
  window.completeWaitingItem = completeWaitingItem;
  window.openWaitingItem = openWaitingItem;
  window.completeWaitingCheckIn = markDelegatedItemCheckedById;
  window.DCC.Waiting = Object.assign(window.DCC.Waiting || {}, {
    all: getAllDelegatedItems,
    attentionItems,
    blockerLabel,
    cycleKey,
    dueLabel,
    itemUrgency,
    snooze: snoozeWaitingItem,
    scheduleCheckIn: scheduleDelegatedItem,
    unblock: unblockWaitingItem,
    complete: completeWaitingItem,
    open: openWaitingItem,
    completeCheckIn: markDelegatedItemCheckedById,
    copyText
  });
})();
