// ======== DELEGATED TAB (PIN 10.A) ========
// Delegated items tracker. Data model: type:"block" rows with date=null
// and properties.kind="delegated_item". Loaded by blockStore.loadGlobals()
// on boot alongside tags and other global blocks.
//
// This module (commit 2) provides the list view + filter bar + tab wiring.
// The create/edit/delete modal ships in commit 3. The mark-as-delegated
// affordances on tag-manager and backlog cards ship in commit 4.

(function(){
  let _currentFilter = "all";
  // Local cache refreshed after mutations. On initial load we read from
  // blockStore.getByType("block"); after any create/update/delete we
  // refetch /api/delegated-items and cache the list here to avoid a
  // stale blockStore read path.
  let _cachedDelegatedItems = null;

  // ── Data access ──
  function getAllDelegatedItems() {
    if (_cachedDelegatedItems) return _cachedDelegatedItems.slice().sort(sortByCheckIn);
    if (!window.blockStore) return [];
    return window.blockStore.getByType("block")
      .filter(b => (b.properties || {}).kind === "delegated_item")
      .sort(sortByCheckIn);
  }

  function sortByCheckIn(a, b) {
    const ca = (a.properties || {}).checkInAt || "";
    const cb = (b.properties || {}).checkInAt || "";
    if (!ca && !cb) return 0;
    if (!ca) return 1;   // nulls last
    if (!cb) return -1;
    return ca.localeCompare(cb);
  }

  function filterItems(items, filter) {
    const now = new Date();
    switch (filter) {
      case "upcoming":
        return items.filter(i => {
          const p = i.properties || {};
          if (p.lastCheckedAt) return false;
          const at = p.checkInAt ? new Date(p.checkInAt) : null;
          return !at || at >= now;
        });
      case "overdue":
        return items.filter(i => {
          const p = i.properties || {};
          if (p.lastCheckedAt) return false;
          const at = p.checkInAt ? new Date(p.checkInAt) : null;
          return at && at < now;
        });
      case "done":
        return items.filter(i => (i.properties || {}).lastCheckedAt);
      default:
        return items;
    }
  }

  // ── Rendering helpers ──
  function formatRelative(iso) {
    if (!iso) return "(no check-in)";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "(invalid date)";
    const diffMs = d - new Date();
    const diffMin = Math.round(diffMs / 60000);
    if (Math.abs(diffMin) < 60) return diffMin >= 0 ? ("in " + diffMin + " min") : ((-diffMin) + " min ago");
    const diffHr = Math.round(diffMin / 60);
    if (Math.abs(diffHr) < 24) return diffHr >= 0 ? ("in " + diffHr + " h") : ((-diffHr) + " h ago");
    const diffDay = Math.round(diffHr / 24);
    if (Math.abs(diffDay) < 30) return diffDay >= 0 ? ("in " + diffDay + " d") : ((-diffDay) + " d ago");
    return d.toLocaleDateString();
  }

  function channelIcon(channel) {
    if (channel === "email") return "\u2709";  // envelope
    if (channel === "slack") return "#";
    return "\u25CB";  // open circle for manual
  }

  function esc(s) {
    if (s == null) return "";
    return (typeof escHtml === "function") ? escHtml(String(s)) : String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── List view ──
  function renderDelegatedList() {
    const mount = document.getElementById("delegated-list");
    if (!mount) return;
    const all = getAllDelegatedItems();
    const filtered = filterItems(all, _currentFilter);

    // Update count badge (open items only: no lastCheckedAt)
    const countBadge = document.getElementById("delegated-count");
    if (countBadge) {
      const openCount = all.filter(i => !(i.properties || {}).lastCheckedAt).length;
      if (openCount > 0) { countBadge.textContent = openCount; countBadge.style.display = ""; }
      else { countBadge.style.display = "none"; }
    }

    if (!filtered.length) {
      mount.innerHTML = '<div class="delegated-empty">' + (all.length ? "No items match this filter." : "No delegated items yet. Click \"+ New delegated item\" to create one.") + '</div>';
      return;
    }

    mount.innerHTML = filtered.map(item => {
      const p = item.properties || {};
      const delegatee = (p.delegatee && p.delegatee.name) ? p.delegatee.name : "(no delegatee)";
      const rel = formatRelative(p.checkInAt);
      const icon = channelIcon(p.channel);
      const done = !!p.lastCheckedAt;
      return (
        '<div class="delegated-card' + (done ? " done" : "") + '" data-id="' + esc(item.id) + '">' +
          '<div class="delegated-card-icon">' + icon + '</div>' +
          '<div class="delegated-card-body">' +
            '<div class="delegated-card-title">' + esc(p.title || "(untitled)") + '</div>' +
            '<div class="delegated-card-meta">' +
              '<span>' + esc(delegatee) + '</span>' +
              '<span class="delegated-card-when">' + esc(rel) + '</span>' +
              (p.channel ? '<span class="delegated-card-channel">' + esc(p.channel) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="delegated-card-actions">' +
            '<button class="delegated-edit" data-id="' + esc(item.id) + '">Edit</button>' +
            '<button class="delegated-delete" data-id="' + esc(item.id) + '">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");

    // Wire card actions
    mount.querySelectorAll(".delegated-edit").forEach(btn => {
      btn.addEventListener("click", e => { e.stopPropagation(); openDelegatedModal(btn.dataset.id); });
    });
    mount.querySelectorAll(".delegated-delete").forEach(btn => {
      btn.addEventListener("click", e => { e.stopPropagation(); deleteDelegatedItem(btn.dataset.id); });
    });
  }

  // ── Modal (commit 3) ──
  // openDelegatedModal(idOrNull, prefill)
  //   idOrNull: string block id to edit, or null to create a new item
  //   prefill: optional object with {title, linkedTagId, linkedBlockId}
  //     used by commit 4's mark-as-delegated affordances to seed the form
  function openDelegatedModal(idOrNull, prefill) {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (!overlay) return;
    prefill = prefill || {};
    const item = idOrNull ? getAllDelegatedItems().find(i => i.id === idOrNull) : null;
    const p = item ? (item.properties || {}) : {};

    document.getElementById("dm-id").value = idOrNull || "";
    document.getElementById("dm-title").value = p.title || prefill.title || "";
    document.getElementById("dm-delegatee-name").value = (p.delegatee && p.delegatee.name) || "";
    document.getElementById("dm-delegatee-email").value = (p.delegatee && p.delegatee.email) || "";
    document.getElementById("dm-channel").value = p.channel || "manual";
    // datetime-local wants "YYYY-MM-DDTHH:MM" in local time. If we stored an
    // ISO string with timezone info, convert by subtracting tz offset so the
    // input displays the same wall-clock time the user originally picked.
    document.getElementById("dm-check-in-at").value = isoToDatetimeLocal(p.checkInAt);
    document.getElementById("dm-cadence").value = p.checkInCadence || "once";
    document.getElementById("dm-notes").value = p.notes || "";
    document.getElementById("dm-linked-tag-id").value = p.linkedTagId || prefill.linkedTagId || "";
    document.getElementById("dm-linked-block-id").value = p.linkedBlockId || prefill.linkedBlockId || "";
    document.getElementById("delegated-modal-title").textContent = idOrNull ? "Edit delegated item" : "New delegated item";
    document.getElementById("dm-mark-checked").style.display = (idOrNull && !p.lastCheckedAt) ? "" : "none";

    overlay.classList.add("open");
    // Focus the title field for quick create
    setTimeout(() => { const t = document.getElementById("dm-title"); if (t) t.focus(); }, 20);
  }

  function closeDelegatedModal() {
    const overlay = document.getElementById("delegated-modal-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  // Convert an ISO string (possibly with offset) to the YYYY-MM-DDTHH:MM
  // form that <input type="datetime-local"> expects, using LOCAL time.
  function isoToDatetimeLocal(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  async function saveDelegatedItem() {
    const id = document.getElementById("dm-id").value || null;
    const title = document.getElementById("dm-title").value.trim();
    if (!title) { if (typeof showToast === "function") showToast("Title is required", "error"); return; }
    const checkInAtLocal = document.getElementById("dm-check-in-at").value;
    // datetime-local gives "YYYY-MM-DDTHH:MM" in local time — convert to ISO
    // (UTC) via the Date constructor which interprets it as local.
    const checkInAt = checkInAtLocal ? new Date(checkInAtLocal).toISOString() : null;

    const nameVal = document.getElementById("dm-delegatee-name").value.trim();
    const emailVal = document.getElementById("dm-delegatee-email").value.trim();
    const properties = {
      title,
      delegatee: {
        name: nameVal || null,
        email: emailVal || null,
        slackUserId: null
      },
      channel: document.getElementById("dm-channel").value || "manual",
      checkInAt,
      checkInCadence: document.getElementById("dm-cadence").value || "once",
      notes: document.getElementById("dm-notes").value.trim() || "",
      linkedTagId: document.getElementById("dm-linked-tag-id").value || null,
      linkedBlockId: document.getElementById("dm-linked-block-id").value || null
    };

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
      if (typeof showToast === "function") showToast(id ? "Delegated item updated" : "Delegated item created", "success");
    } catch (e) {
      if (typeof showToast === "function") showToast("Save failed: " + (e.message || e), "error");
    }
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
      if (typeof showToast === "function") showToast("Delegated item deleted", "success");
    } catch (e) {
      if (typeof showToast === "function") showToast("Delete failed: " + (e.message || e), "error");
    }
  }

  async function markDelegatedItemChecked() {
    const id = document.getElementById("dm-id").value;
    if (!id) return;
    try {
      const resp = await fetch("/api/delegated-items/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { lastCheckedAt: new Date().toISOString() } })
      });
      if (!resp.ok) {
        let err;
        try { err = (await resp.json()).error; } catch(e) { err = resp.statusText; }
        throw new Error(err || "Update failed");
      }
      closeDelegatedModal();
      await refreshDelegatedItems();
      if (typeof showToast === "function") showToast("Marked as checked-in", "success");
    } catch (e) {
      if (typeof showToast === "function") showToast("Update failed: " + (e.message || e), "error");
    }
  }

  // ── Refresh helper exposed for commit 3/4 + SSE listeners ──
  async function refreshDelegatedItems() {
    try {
      const resp = await fetch("/api/delegated-items");
      if (!resp.ok) throw new Error("fetch failed");
      _cachedDelegatedItems = await resp.json();
      renderDelegatedList();
    } catch (e) {
      console.warn("[delegated] refresh failed:", e && e.message ? e.message : e);
    }
  }

  // ── Init (wire once DOM is ready) ──
  function init() {
    const newBtn = document.getElementById("delegated-new-btn");
    if (newBtn) newBtn.addEventListener("click", () => openDelegatedModal(null));

    document.querySelectorAll(".delegated-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".delegated-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _currentFilter = btn.dataset.filter || "all";
        renderDelegatedList();
      });
    });

    // Modal wiring (PIN 10.A commit 3)
    const cancelBtn = document.getElementById("dm-cancel");
    const saveBtn = document.getElementById("dm-save");
    const checkBtn = document.getElementById("dm-mark-checked");
    const overlay = document.getElementById("delegated-modal-overlay");
    if (cancelBtn) cancelBtn.addEventListener("click", closeDelegatedModal);
    if (saveBtn) saveBtn.addEventListener("click", saveDelegatedItem);
    if (checkBtn) checkBtn.addEventListener("click", markDelegatedItemChecked);
    if (overlay) overlay.addEventListener("click", e => {
      if (e.target === overlay) closeDelegatedModal();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for boot.js + tabs.js + commit 3 handlers
  window.buildDelegated = function buildDelegated() { renderDelegatedList(); };
  window.renderDelegatedList = renderDelegatedList;
  window.refreshDelegatedItems = refreshDelegatedItems;
  window.openDelegatedModal = openDelegatedModal;
  window.deleteDelegatedItem = deleteDelegatedItem;
  // Internal caches exposed so commit 3 handlers can update them after mutations
  window._delegatedSetCache = function(list) { _cachedDelegatedItems = list; };
})();
