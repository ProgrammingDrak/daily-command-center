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

  // ── Stubs replaced in commit 3 ──
  function openDelegatedModal(idOrNull) {
    if (typeof showToast === "function") showToast("Delegated modal coming in next commit", "info");
  }

  function deleteDelegatedItem(id) {
    if (typeof showToast === "function") showToast("Delete coming in next commit", "info");
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
