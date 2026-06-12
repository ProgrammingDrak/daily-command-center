// ======== DELEGATED / BLOCKED SIDEBAR MANAGER ========
// "Delegated / Blocked" items are global block rows with properties.kind="delegated_item".
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

  function esc(s) {
    if (s == null) return "";
    if (typeof escHtml === "function") return escHtml(String(s));
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function getAllDelegatedItems() {
    if (!window.blockStore) return [];
    return window.blockStore.getByType("block")
      .filter(b => (b.properties || {}).kind === "delegated_item")
      .sort(sortByUrgency);
  }

  function getDelegatedItemById(id) {
    return getAllDelegatedItems().find(i => i.id === id) || null;
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

  // {score, cls, timing} for an item, anchored on the last check-in (or creation).
  function itemUrgency(item) {
    const p = item.properties || {};
    const anchor = p.lastCheckedAt || item.created_at || p.createdAt || null;
    const timing = window.urgency.timing(checkInDaysFor(p), anchor);
    const score = timing.progress;
    return { score, cls: window.urgency.scoreClass(score), timing };
  }

  function sortByUrgency(a, b) {
    const doneA = isDoneDelegated(a);
    const doneB = isDoneDelegated(b);
    if (doneA !== doneB) return doneA ? 1 : -1;
    const sa = itemUrgency(a).score;
    const sb = itemUrgency(b).score;
    if (sb !== sa) return sb - sa;
    return ((a.properties || {}).title || "").localeCompare((b.properties || {}).title || "");
  }

  function isDoneDelegated(item) {
    if (!item) return false;
    const p = item.properties || {};
    return !!p.completedAt || p.status === "done";
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

  // Items that need attention now: yellow+ urgency, overdue, or tied to something
  // visible on today's itinerary.
  function attentionItems(items) {
    return items.filter(item => {
      if (!isOpenDelegated(item)) return false;
      const u = itemUrgency(item);
      return u.score >= 70 || u.timing.remaining < 0 || isLinkedToVisibleContext(item);
    });
  }

  function filterItems(items, filter) {
    switch (filter) {
      case "upcoming":
        return items.filter(i => isOpenDelegated(i) && itemUrgency(i).timing.remaining >= 0);
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
    if (managerOpen && totalCount) return '<div class="delegated-empty">No blocked items match this filter.</div>';
    if (managerOpen) return '<div class="delegated-empty">Nothing blocked yet.</div>';
    return '<div class="delegated-empty">No check-ins need attention.</div>';
  }

  function renderCard(item) {
    const p = item.properties || {};
    const done = isDoneDelegated(item);
    const u = itemUrgency(item);
    const cls = done ? "" : u.cls;

    const who = (p.delegatee && p.delegatee.name) || "";
    const waiting = p.title || "(unspecified)";
    const myTask = (p.myTask || "").trim();
    const headline = myTask || waiting;
    const note = truncate(p.notes || "", 120);

    // Subline: when myTask is the headline, surface what/who underneath; the
    // due label always shows.
    const subParts = [];
    if (myTask) subParts.push('Waiting on ' + esc(waiting));
    if (who) subParts.push((myTask ? 'from ' : 'Waiting on ') + esc(who));
    else if (!myTask) subParts.push('No one assigned');
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

    const actionButtons = done ?
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>' :
      '<button type="button" data-delegated-action="check-in" data-id="' + esc(item.id) + '">Check in</button>' +
      '<button type="button" data-delegated-action="schedule" data-id="' + esc(item.id) + '">Schedule</button>' +
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="done" data-id="' + esc(item.id) + '">Done</button>' +
      '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>';

    return '<div class="' + cardCls + '" data-id="' + esc(item.id) + '">' +
      badge +
      '<div class="delegated-card-body">' +
        '<div class="delegated-card-title">' + esc(headline) + linkChip + '</div>' +
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
          scheduleDelegatedItem(id);
        } else if (action === "edit") {
          openDelegatedModal(id);
        } else if (action === "done") {
          completeDelegatedItem(id);
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
    const title = p.title || "this";
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
      const resp = await fetch("/api/delegated-items/" + id, {
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

  // Logging a check-in resets the urgency anchor so the creep starts over.
  async function markDelegatedItemCheckedById(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    await patchDelegatedItem(id, {
      lastCheckedAt: new Date().toISOString(),
      status: "open"
    }, "Checked in; urgency reset.");
    closeDelegatedModal();
  }

  function completeDelegatedItem(id) {
    patchDelegatedItem(id, {
      completedAt: new Date().toISOString(),
      status: "done"
    }, "Blocked item closed.");
  }

  function scheduleDelegatedItem(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    const p = item.properties || {};
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled) && scheduled.some(ev => ev && ev.delegatedItemId === id)) {
      toast("A linked itinerary row already exists.", "info");
      return;
    }
    const title = "Follow up: " + (p.title || "blocked item");
    const who = (p.delegatee && p.delegatee.name) || "someone";
    const detail = "Follow-up with " + who + (p.myTask ? "\n\nBlocking: " + p.myTask : "") + (p.notes ? "\n\n" + p.notes : "");
    if (typeof openSchedulePicker === "function") {
      openSchedulePicker(title, 15, {
        source: "delegated",
        delegatedItemId: id,
        linkedBlockId: p.linkedBlockId || null,
        linkedTagId: p.linkedTagId || null,
        meta: "Follow-up - 15m",
        detail,
        priority: "Medium",
        tags: ["delegated"]
      });
      return;
    }
    copyText(buildDelegatedMessage(item));
    toast("Message copied; schedule picker is unavailable.", "info");
  }

  function toast(message, type) {
    if (typeof showToast === "function") showToast(message, type || "info");
  }

  function openDelegatedModal(idOrNull, prefill) {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (!overlay) return;
    prefill = prefill || {};
    // Authoritative reset: only set when converting an existing task (carries its id).
    _pendingSourceTaskId = prefill.sourceTaskId || null;
    const item = idOrNull ? getDelegatedItemById(idOrNull) : null;
    const p = item ? (item.properties || {}) : {};
    const delegatee = p.delegatee || {};

    setVal("dm-id", idOrNull || "");
    setVal("dm-my-task", p.myTask || prefill.myTask || "");
    setVal("dm-title", p.title || prefill.title || "");
    setVal("dm-delegatee-name", delegatee.name || "");
    setVal("dm-check-in-days", item ? checkInDaysFor(p) : (prefill.checkInDays || 7));
    setVal("dm-notes", p.notes || "");
    setVal("dm-linked-tag-id", p.linkedTagId || prefill.linkedTagId || "");
    setVal("dm-linked-block-id", p.linkedBlockId || prefill.linkedBlockId || "");

    const titleEl = document.getElementById("delegated-modal-title");
    if (titleEl) titleEl.textContent = idOrNull ? "Edit delegated / blocked item" : "New delegated / blocked item";
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
    openDelegatedModal(null, { myTask: title, sourceTaskId: task.sourceTaskId || null });
  }

  function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value == null ? "" : value;
  }

  function closeDelegatedModal() {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  async function saveDelegatedItem() {
    const id = valueOf("dm-id") || null;
    const title = valueOf("dm-title").trim();
    if (!title) { toast("Tell me what you're waiting on", "error"); return; }
    let checkInDays = parseInt(valueOf("dm-check-in-days"), 10);
    if (!Number.isFinite(checkInDays) || checkInDays < 1) checkInDays = 7;
    const existing = id ? getDelegatedItemById(id) : null;
    const nameVal = valueOf("dm-delegatee-name").trim();
    const properties = {
      title,
      myTask: valueOf("dm-my-task").trim() || "",
      delegatee: { name: nameVal || null },
      checkInDays,
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
        resp = await fetch("/api/delegated-items/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ properties })
        });
      } else {
        resp = await fetch("/api/delegated-items", {
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
      toast(id ? "Updated" : (convertedFrom ? "Task moved to Delegated / Blocked" : "Created"), "success");
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
    if (typeof window.confirm === "function" && !window.confirm("Delete this blocked item? This cannot be undone.")) return;
    try {
      const resp = await fetch("/api/delegated-items/" + id, { method: "DELETE" });
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Delete failed");
      }
      await refreshDelegatedItems();
      toast("Blocked item deleted", "success");
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
    if (cancelBtn) cancelBtn.addEventListener("click", closeDelegatedModal);
    if (saveBtn) saveBtn.addEventListener("click", saveDelegatedItem);
    if (checkBtn) checkBtn.addEventListener("click", () => markDelegatedItemCheckedById(valueOf("dm-id")));
    if (overlay) overlay.addEventListener("click", e => {
      if (e.target === overlay) closeDelegatedModal();
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
  window.deleteDelegatedItem = deleteDelegatedItem;
  window.getAllDelegatedItems = getAllDelegatedItems;
  window.getDelegatedItemById = getDelegatedItemById;
})();
