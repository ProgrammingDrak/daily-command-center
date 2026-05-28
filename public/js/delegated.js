// ======== DELEGATED ITINERARY MANAGER ========
// Delegated items are global block rows with properties.kind="delegated_item".
// The itinerary page is the primary surface; the top-level tab has been removed.

(function(){
  let _currentFilter = "all";
  let _managerOpen = false;

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
      .sort(sortByCheckIn);
  }

  function getDelegatedItemById(id) {
    return getAllDelegatedItems().find(i => i.id === id) || null;
  }

  function sortByCheckIn(a, b) {
    const pa = a.properties || {};
    const pb = b.properties || {};
    const doneA = isDoneDelegated(a);
    const doneB = isDoneDelegated(b);
    if (doneA !== doneB) return doneA ? 1 : -1;
    const ca = pa.checkInAt || "";
    const cb = pb.checkInAt || "";
    if (!ca && !cb) return (pa.title || "").localeCompare(pb.title || "");
    if (!ca) return -1;
    if (!cb) return 1;
    return ca.localeCompare(cb);
  }

  function isDoneDelegated(item) {
    if (!item) return false;
    const p = item.properties || {};
    return !!p.completedAt || p.status === "done" || (!!p.lastCheckedAt && p.checkInCadence === "once" && !p.checkInAt);
  }

  function isOpenDelegated(item) {
    return !isDoneDelegated(item);
  }

  function dateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function checkInDate(item) {
    const iso = (item.properties || {}).checkInAt;
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function isOverdue(item) {
    const d = checkInDate(item);
    if (!d) return false;
    return dateOnly(d) < dateOnly(new Date());
  }

  function isDueToday(item) {
    const d = checkInDate(item);
    if (!d) return false;
    return dateOnly(d).getTime() === dateOnly(new Date()).getTime();
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

  function attentionItems(items) {
    return items.filter(item => {
      if (!isOpenDelegated(item)) return false;
      const p = item.properties || {};
      return !p.checkInAt || isOverdue(item) || isDueToday(item) || isLinkedToVisibleContext(item);
    });
  }

  function filterItems(items, filter) {
    const now = new Date();
    switch (filter) {
      case "upcoming":
        return items.filter(i => {
          const at = checkInDate(i);
          return isOpenDelegated(i) && at && at > now && !isOverdue(i) && !isDueToday(i);
        });
      case "overdue":
        return items.filter(i => isOpenDelegated(i) && isOverdue(i));
      case "done":
        return items.filter(isDoneDelegated);
      default:
        return items;
    }
  }

  function formatRelative(iso) {
    if (!iso) return "No check-in";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Invalid date";
    const diffMs = d - new Date();
    const diffMin = Math.round(diffMs / 60000);
    if (Math.abs(diffMin) < 60) return diffMin >= 0 ? ("in " + Math.max(1, diffMin) + "m") : ((-diffMin) + "m overdue");
    const diffHr = Math.round(diffMin / 60);
    if (Math.abs(diffHr) < 24) return diffHr >= 0 ? ("in " + diffHr + "h") : ((-diffHr) + "h overdue");
    const diffDay = Math.round(diffHr / 24);
    if (Math.abs(diffDay) < 30) return diffDay >= 0 ? ("in " + diffDay + "d") : ((-diffDay) + "d overdue");
    return d.toLocaleDateString();
  }

  function channelIcon(channel) {
    if (channel === "email") return "@";
    if (channel === "slack") return "#";
    return "o";
  }

  function statusLabel(item) {
    if (isDoneDelegated(item)) return "Done";
    const p = item.properties || {};
    if (!p.checkInAt) return "Missing check-in";
    if (isOverdue(item)) return "Overdue";
    if (isDueToday(item)) return "Due today";
    return formatRelative(p.checkInAt);
  }

  function truncate(s, n) {
    s = String(s || "").trim();
    if (!s || s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)).trim() + "...";
  }

  function renderScheduleDelegated() {
    const mount = document.getElementById("schedule-delegated-section");
    if (!mount) return;

    const all = getAllDelegatedItems();
    const open = all.filter(isOpenDelegated);
    const attention = attentionItems(all);
    const overdue = all.filter(i => isOpenDelegated(i) && isOverdue(i));
    const list = _managerOpen ? filterItems(all, _currentFilter) : attention;

    updateBadge(open.length);
    if (!attention.length && !all.length && !_managerOpen) {
      mount.style.display = "none";
      mount.innerHTML = "";
      return;
    }

    mount.style.display = "";
    mount.classList.toggle("manager-open", _managerOpen);
    const filterBar = _managerOpen ? renderFilters() : "";
    const rows = list.length ? list.map(renderCard).join("") : renderEmpty(_managerOpen, all.length);
    mount.innerHTML =
      '<div class="delegated-strip-header">' +
        '<button type="button" class="delegated-strip-toggle" data-delegated-action="toggle-manager" aria-expanded="' + (_managerOpen ? "true" : "false") + '">' +
          '<span class="delegated-strip-kicker">Delegated</span>' +
          '<span class="delegated-strip-count">' + attention.length + '</span>' +
          '<span class="delegated-strip-summary">' + open.length + ' open' + (overdue.length ? ' / ' + overdue.length + ' overdue' : '') + '</span>' +
        '</button>' +
        '<div class="delegated-strip-actions">' +
          '<button type="button" class="delegated-mini-btn" data-delegated-action="new">+ New</button>' +
        '</div>' +
      '</div>' +
      filterBar +
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
    if (managerOpen && totalCount) return '<div class="delegated-empty">No delegated items match this filter.</div>';
    if (managerOpen) return '<div class="delegated-empty">No delegated items yet.</div>';
    return '<div class="delegated-empty">No delegated check-ins need attention.</div>';
  }

  function renderCard(item) {
    const p = item.properties || {};
    const delegatee = (p.delegatee && p.delegatee.name) || "No delegatee";
    const note = truncate(p.notes || p.detail || "", 120);
    const done = isDoneDelegated(item);
    const cls = [
      "delegated-card",
      "delegated-itinerary-card",
      isOverdue(item) ? "overdue" : "",
      isDueToday(item) ? "due-today" : "",
      done ? "done" : ""
    ].filter(Boolean).join(" ");
    const actionButtons = done ?
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>' :
      '<button type="button" data-delegated-action="contact" data-id="' + esc(item.id) + '">Contact</button>' +
      '<button type="button" data-delegated-action="check-in" data-id="' + esc(item.id) + '">Check in</button>' +
      '<button type="button" data-delegated-action="snooze" data-id="' + esc(item.id) + '">Snooze</button>' +
      '<button type="button" data-delegated-action="schedule" data-id="' + esc(item.id) + '">Schedule</button>' +
      '<button type="button" data-delegated-action="edit" data-id="' + esc(item.id) + '">Edit</button>' +
      '<button type="button" data-delegated-action="done" data-id="' + esc(item.id) + '">Done</button>' +
      (_managerOpen ? '<button type="button" data-delegated-action="delete" data-id="' + esc(item.id) + '">Delete</button>' : '');

    return '<div class="' + cls + '" data-id="' + esc(item.id) + '">' +
      '<div class="delegated-card-icon">' + esc(channelIcon(p.channel)) + '</div>' +
      '<div class="delegated-card-body">' +
        '<div class="delegated-card-title">' + esc(p.title || "(untitled)") + '</div>' +
        '<div class="delegated-card-meta">' +
          '<span>' + esc(delegatee) + '</span>' +
          '<span class="delegated-card-when">' + esc(statusLabel(item)) + '</span>' +
          (p.channel ? '<span class="delegated-card-channel">' + esc(p.channel) + '</span>' : '') +
        '</div>' +
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
        if (action === "toggle-manager") {
          _managerOpen = !_managerOpen;
          renderScheduleDelegated();
        } else if (action === "new") {
          openDelegatedModal(null);
        } else if (action === "contact") {
          contactDelegatedItem(id);
        } else if (action === "check-in") {
          markDelegatedItemCheckedById(id);
        } else if (action === "snooze") {
          snoozeDelegatedItem(id);
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
        renderScheduleDelegated();
      });
    });
  }

  function updateBadge(openCount) {
    const countBadge = document.getElementById("delegated-count");
    if (!countBadge) return;
    if (openCount > 0) {
      countBadge.textContent = openCount;
      countBadge.style.display = "";
    } else {
      countBadge.style.display = "none";
    }
  }

  function buildDelegatedMessage(item) {
    const p = item.properties || {};
    const name = (p.delegatee && p.delegatee.name) || "";
    const greeting = name ? ("Hi " + name + ",") : "Hi,";
    const title = p.title || "this";
    const notes = p.notes ? ("\n\nContext: " + p.notes) : "";
    return greeting + "\n\nQuick check-in on \"" + title + "\". Could you send me a brief update when you can?" + notes + "\n\nThanks.";
  }

  function contactSubject(item) {
    const p = item.properties || {};
    return "Checking in: " + (p.title || "delegated item");
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

  async function contactDelegatedItem(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    const p = item.properties || {};
    const delegatee = p.delegatee || {};
    const msg = buildDelegatedMessage(item);
    const copied = copyText(msg);

    if (p.channel === "email" && delegatee.email) {
      const href = "mailto:" + encodeURIComponent(delegatee.email) +
        "?subject=" + encodeURIComponent(contactSubject(item)) +
        "&body=" + encodeURIComponent(msg);
      window.open(href, "_blank");
      await copied;
      toast("Email compose opened; message copied.", "success");
      return;
    }

    const slackTarget = delegatee.slackUrl || delegatee.slackUserId || "";
    if (p.channel === "slack" && isOpenableSlackTarget(slackTarget)) {
      window.open(slackTarget, "_blank");
      await copied;
      toast("Slack target opened; message copied.", "success");
      return;
    }

    await copied;
    toast("Message copied and ready to paste.", "success");
  }

  function isOpenableSlackTarget(target) {
    if (!target) return false;
    return /^https?:\/\//i.test(target) || /^slack:\/\//i.test(target);
  }

  function nextCadenceDate(item, now) {
    const p = item.properties || {};
    const cadence = p.checkInCadence || "once";
    if (cadence === "once") return null;
    const base = p.checkInAt ? new Date(p.checkInAt) : new Date(now);
    const next = isNaN(base.getTime()) || base < now ? new Date(now) : base;
    if (cadence === "daily") next.setDate(next.getDate() + 1);
    else if (cadence === "weekly") next.setDate(next.getDate() + 7);
    else if (cadence === "monthly") next.setMonth(next.getMonth() + 1);
    else return null;
    return next.toISOString();
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

  async function markDelegatedItemCheckedById(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    const now = new Date();
    const next = nextCadenceDate(item, now);
    await patchDelegatedItem(id, {
      lastCheckedAt: now.toISOString(),
      checkInAt: next,
      status: "open"
    }, next ? "Checked in; next follow-up advanced." : "Marked as checked in.");
    closeDelegatedModal();
  }

  function snoozeDelegatedItem(id) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    patchDelegatedItem(id, { checkInAt: d.toISOString(), status: "open" }, "Snoozed to tomorrow morning.");
  }

  function completeDelegatedItem(id) {
    patchDelegatedItem(id, {
      completedAt: new Date().toISOString(),
      status: "done"
    }, "Delegated item closed.");
  }

  function scheduleDelegatedItem(id) {
    const item = getDelegatedItemById(id);
    if (!item) return;
    const p = item.properties || {};
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled) && scheduled.some(ev => ev && ev.delegatedItemId === id)) {
      toast("A linked itinerary row already exists.", "info");
      return;
    }
    const title = "Follow up: " + (p.title || "delegated item");
    const delegatee = (p.delegatee && p.delegatee.name) || "delegatee";
    const detail = "Delegated follow-up with " + delegatee + (p.notes ? "\n\n" + p.notes : "");
    if (typeof openSchedulePicker === "function") {
      openSchedulePicker(title, 15, {
        source: "delegated",
        delegatedItemId: id,
        linkedBlockId: p.linkedBlockId || null,
        linkedTagId: p.linkedTagId || null,
        meta: "Delegated - 15m",
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
    const item = idOrNull ? getDelegatedItemById(idOrNull) : null;
    const p = item ? (item.properties || {}) : {};
    const delegatee = p.delegatee || {};

    setVal("dm-id", idOrNull || "");
    setVal("dm-title", p.title || prefill.title || "");
    setVal("dm-delegatee-name", delegatee.name || "");
    setVal("dm-delegatee-email", delegatee.email || "");
    setVal("dm-delegatee-slack-url", delegatee.slackUrl || "");
    setVal("dm-channel", p.channel || "manual");
    setVal("dm-check-in-at", isoToDatetimeLocal(p.checkInAt));
    setVal("dm-cadence", p.checkInCadence || "once");
    setVal("dm-notes", p.notes || "");
    setVal("dm-linked-tag-id", p.linkedTagId || prefill.linkedTagId || "");
    setVal("dm-linked-block-id", p.linkedBlockId || prefill.linkedBlockId || "");

    const titleEl = document.getElementById("delegated-modal-title");
    if (titleEl) titleEl.textContent = idOrNull ? "Edit delegated item" : "New delegated item";
    const checkBtn = document.getElementById("dm-mark-checked");
    if (checkBtn) checkBtn.style.display = (idOrNull && item && isOpenDelegated(item)) ? "" : "none";

    overlay.classList.add("open");
    setTimeout(() => { const t = document.getElementById("dm-title"); if (t) t.focus(); }, 20);
  }

  function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value == null ? "" : value;
  }

  function closeDelegatedModal() {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  function isoToDatetimeLocal(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  async function saveDelegatedItem() {
    const id = valueOf("dm-id") || null;
    const title = valueOf("dm-title").trim();
    if (!title) { toast("Title is required", "error"); return; }
    const checkInAtLocal = valueOf("dm-check-in-at");
    const checkInAt = checkInAtLocal ? new Date(checkInAtLocal).toISOString() : null;
    const existing = id ? getDelegatedItemById(id) : null;
    const existingDelegatee = existing ? ((existing.properties || {}).delegatee || {}) : {};
    const nameVal = valueOf("dm-delegatee-name").trim();
    const emailVal = valueOf("dm-delegatee-email").trim();
    const slackUrlVal = valueOf("dm-delegatee-slack-url").trim();
    const properties = {
      title,
      delegatee: {
        name: nameVal || null,
        email: emailVal || null,
        slackUrl: slackUrlVal || null,
        slackUserId: existingDelegatee.slackUserId || null
      },
      channel: valueOf("dm-channel") || "manual",
      checkInAt,
      checkInCadence: valueOf("dm-cadence") || "once",
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
      closeDelegatedModal();
      await refreshDelegatedItems();
      toast(id ? "Delegated item updated" : "Delegated item created", "success");
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
    if (typeof window.confirm === "function" && !window.confirm("Delete this delegated item? This cannot be undone.")) return;
    try {
      const resp = await fetch("/api/delegated-items/" + id, { method: "DELETE" });
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Delete failed");
      }
      await refreshDelegatedItems();
      toast("Delegated item deleted", "success");
    } catch (e) {
      toast("Delete failed: " + (e.message || e), "error");
    }
  }

  async function refreshDelegatedItems() {
    try {
      if (window.blockStore && typeof window.blockStore.loadGlobals === "function") {
        await window.blockStore.loadGlobals();
      }
      renderScheduleDelegated();
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

  window.buildDelegated = renderScheduleDelegated;
  window.buildScheduleDelegated = renderScheduleDelegated;
  window.renderDelegatedList = renderScheduleDelegated;
  window.refreshDelegatedItems = refreshDelegatedItems;
  window.openDelegatedModal = openDelegatedModal;
  window.deleteDelegatedItem = deleteDelegatedItem;
  window.getAllDelegatedItems = getAllDelegatedItems;
  window.getDelegatedItemById = getDelegatedItemById;
})();
