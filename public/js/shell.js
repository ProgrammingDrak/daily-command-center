// Responsive application shell, utilities, per-workspace scroll, and save truth.
(function () {
  "use strict";

  const DCC = (window.DCC = window.DCC || {});
  const modes = new Map([
    ["schedule", "dashboard"],
    ["working-queue", "dashboard"],
    ["pet-home", "dashboard"],
    ["budget", "full-width"],
    ["activity", "full-width"],
    ["social", "full-width"],
    ["vault", "full-width"],
    ["tasks", "sidebar"]
  ]);
  const scrollPositions = new Map();
  const SCROLL_KEY = "dcc:shell-scroll";
  let activeSurface = "schedule";
  let saveDetail = {
    local: "Saved locally",
    remote: "Checking sync",
    pending: 0,
    timestamp: null,
    message: "Local work remains available while sync reconnects."
  };

  function loadScrollPositions() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || "{}");
      Object.keys(value).forEach((key) => scrollPositions.set(key, Number(value[key]) || 0));
    } catch (_) {}
  }

  function persistScrollPositions() {
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(scrollPositions))); }
    catch (_) {}
  }

  function activate(surfaceId) {
    const id = modes.has(surfaceId) ? surfaceId : "schedule";
    activeSurface = id;
    const mode = modes.get(id);
    document.body.dataset.shellSurface = id;
    document.body.dataset.shellMode = mode;
    document.body.classList.toggle("dcc-shell-focused", mode === "focused");
    document.body.classList.toggle("dcc-shell-full", mode === "full-width");
    document.body.classList.toggle("dcc-shell-sidebar", mode === "sidebar");
    document.dispatchEvent(new CustomEvent("dcc:shell-activated", { detail: { surfaceId: id, mode } }));
    return mode;
  }

  function register(surfaceId, mode) {
    if (!surfaceId || !["dashboard", "focused", "full-width", "sidebar"].includes(mode)) return false;
    modes.set(surfaceId, mode);
    return true;
  }

  function normalizeSaveDetail(detail) {
    const next = Object.assign({}, saveDetail, detail || {});
    next.pending = Math.max(0, Number(next.pending) || 0);
    if (next.remote === "Offline" && next.local !== "Local save failed") {
      next.message = next.pending
        ? next.pending + " safe local change" + (next.pending === 1 ? " is" : "s are") + " waiting to sync."
        : "Local work is safe. Reconnection restarts syncing automatically.";
    }
    return next;
  }

  // Working Queue keeps its own saved-but-unconfirmed update and conflict in
  // account-keyed storage. The dot only reports them; it never resolves them.
  function queueSync() {
    const value = window.DCCWorkingQueue && typeof window.DCCWorkingQueue.syncState === "function"
      ? window.DCCWorkingQueue.syncState() : null;
    return { pending: !!(value && value.pending), conflict: value && value.conflict ? value.conflict : null };
  }

  let lastAnnounced = "";
  function renderSaveStatus(detail) {
    saveDetail = normalizeSaveDetail(detail);
    const button = document.getElementById("save-status");
    if (!button) return;
    const queue = queueSync();
    const local = button.querySelector("[data-save-local]");
    const remote = button.querySelector("[data-save-remote]");
    if (local) local.textContent = saveDetail.local;
    if (remote) remote.textContent = saveDetail.remote;
    let state = String(saveDetail.remote || "").toLowerCase().replace(/\s+/g, "-");
    const extra = [];
    if (queue.conflict) { state = "needs-attention"; extra.push("Queue update needs review"); }
    else if (queue.pending && state === "synced") { state = "waiting-to-sync"; extra.push("Queue update waiting"); }
    button.dataset.remoteState = state;
    const summary = saveDetail.local + ". " + saveDetail.remote + "." + (extra.length ? " " + extra.join(". ") + "." : "");
    button.setAttribute("aria-label", "Sync status: " + summary);
    button.removeAttribute("title");
    const tooltip = document.getElementById("save-status-tooltip");
    if (tooltip) tooltip.textContent = summary + (saveDetail.pending ? " " + saveDetail.pending + " waiting." : "") + " Select for details.";
    // Announce only moves into trouble, not every routine save.
    const trouble = /attention|offline|failed/.test(state) ? summary : "";
    const live = document.getElementById("save-status-live");
    if (live && trouble && trouble !== lastAnnounced) live.textContent = trouble;
    lastAnnounced = trouble;
  }

  function queueRecoveryRows(wrap, close) {
    const queue = queueSync();
    if (!queue.pending && !queue.conflict) return;
    const row = document.createElement("div");
    row.className = "dcc-save-repair dcc-save-queue";
    const text = document.createElement("p");
    text.textContent = queue.conflict
      ? "A Working Queue change was not applied: " + (queue.conflict.message || "it conflicted with newer work") + ". Your attempted change is kept for review."
      : "A Working Queue update is saved on this device and waiting for confirmation.";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = queue.conflict ? "Review queue update" : "Open Working Queue";
    open.addEventListener("click", () => {
      close("queue-review");
      if (DCC.nav) DCC.nav.go({ page: "tasks", view: "queue" });
      if (queue.conflict) setTimeout(() => document.querySelector('[data-queue-action="conflict"]')?.click(), 0);
    });
    row.append(text, open);
    wrap.append(row);
  }

  // Commitment changes used to be recoverable only inside Social. The same
  // retry, export and discard actions stay reachable here; discard asks first.
  async function commitmentRecoveryRows(wrap, close) {
    const sync = window.DCCCommitmentSync;
    if (!sync || typeof sync.pending !== "function") return;
    let pending = [];
    try { pending = await sync.pending() || []; } catch (_) { return; }
    if (!pending.length) return;
    const section = document.createElement("div");
    section.className = "dcc-save-repair dcc-save-commitments";
    const head = document.createElement("p");
    head.textContent = pending.length + " commitment change" + (pending.length === 1 ? " is" : "s are") + " saved on this device. Export before discarding anything you need.";
    section.append(head);
    pending.forEach((item) => {
      const row = document.createElement("div");
      row.className = "dcc-save-commitment";
      const label = document.createElement("p");
      label.textContent = (item.body && (item.body.kind || item.body.title)) || "Commitment change";
      const status = document.createElement("span");
      status.textContent = item.error || "Waiting to sync";
      row.append(label, status);
      if (item.error && typeof sync.retry === "function") {
        const retry = document.createElement("button");
        retry.type = "button"; retry.textContent = "Retry same change";
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          try { await sync.retry(item.actionId); close("commitment-retry"); }
          catch (error) { DCC.toast(error.message, "error"); retry.disabled = false; }
        });
        row.append(retry);
      }
      if (typeof sync.discard === "function") {
        const discard = document.createElement("button");
        discard.type = "button"; discard.textContent = "Discard…";
        discard.addEventListener("click", () => {
          if (discard.dataset.confirm !== "1") {
            discard.dataset.confirm = "1";
            discard.textContent = "Confirm discard";
            status.textContent = "This removes the saved change from this device. Export first if you need it.";
            return;
          }
          discard.disabled = true;
          Promise.resolve(sync.discard(item.actionId)).then(() => close("commitment-discard"))
            .catch((error) => { DCC.toast(error.message, "error"); discard.disabled = false; });
        });
        row.append(discard);
      }
      section.append(row);
    });
    wrap.append(section);
  }

  function saveStatusBody(onRepaired) {
    const wrap = document.createElement("div");
    wrap.className = "dcc-save-detail";
    const exact = saveDetail.timestamp ? new Date(saveDetail.timestamp).toLocaleString() : "No save timestamp yet";
    wrap.innerHTML =
      '<div class="dcc-save-row"><span>On this device</span><strong>' + DCC.esc(saveDetail.local) + '</strong></div>' +
      '<div class="dcc-save-row"><span>Across devices</span><strong>' + DCC.esc(saveDetail.remote) + '</strong></div>' +
      '<div class="dcc-save-row"><span>Waiting changes</span><strong>' + saveDetail.pending + '</strong></div>' +
      '<p>' + DCC.esc(saveDetail.message || "") + '</p>' +
      '<time>' + DCC.esc(exact) + '</time>' +
      '<div class="dcc-save-actions"><button type="button" data-sync-now>Sync now</button><button type="button" data-export-pending>Export pending changes</button></div>' +
      '<div class="dcc-save-brief">' +
        '<div><strong>Daily Brief</strong><span>Review today’s calendar and suggested tasks.</span></div>' +
        '<button type="button" data-open-brief>Open Brief</button>' +
      '</div>';
    const pending = window.blockStore?.pendingSubtaskCreates?.() || [];
    for (const item of pending) {
      const row = document.createElement("div");
      row.className = "dcc-save-repair";
      const label = document.createElement("p"); label.textContent = item.title;
      const review = document.createElement("button"); review.type = "button"; review.textContent = "Review subtask repair";
      row.append(label, review); wrap.append(row);
      review.addEventListener("click", async () => {
        review.disabled = true;
        try {
          const preview = await window.blockStore.previewPendingSubtask(item.walId);
          const summary = document.createElement("p");
          summary.textContent = 'Keep this task and its contents under “' + preview.parentTitle + '”. Placement: '
            + (preview.originalDate || "Unscheduled") + ' → ' + (preview.expected.date || "Unscheduled") + '. No timer will start.';
          const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Repair this pending subtask";
          const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Back";
          row.append(summary, apply, cancel); review.hidden = true;
          cancel.onclick = () => { summary.remove(); apply.remove(); cancel.remove(); review.hidden = false; review.disabled = false; };
          apply.onclick = async () => {
            apply.disabled = true; cancel.disabled = true;
            try {
              await window.blockStore.repairPendingSubtask(preview);
              row.replaceChildren(document.createTextNode("Subtask saved. Its original ID and content were preserved."));
              if (onRepaired) onRepaired();
              DCC.toast("Pending subtask repaired", "success");
            } catch (error) { DCC.toast(error.message, "error"); apply.disabled = false; cancel.disabled = false; }
          };
        } catch (error) { DCC.toast(error.message, "error"); review.disabled = false; }
      });
    }
    return wrap;
  }

  function wireSaveStatus() {
    const button = document.getElementById("save-status");
    if (!button) return;
    const cluster = document.getElementById("dcc-cluster");
    if (cluster && button.parentElement !== cluster) cluster.appendChild(button);
    button.addEventListener("click", () => {
      const details = saveStatusBody(() => statusOverlay.close("repaired"));
      const close = (reason) => statusOverlay.close(reason);
      queueRecoveryRows(details, close);
      commitmentRecoveryRows(details, close);
      const statusOverlay = DCC.overlay.open({
        kind: "popover",
        title: "Save status",
        body: details,
        anchor: button,
        onClose: () => button.setAttribute("aria-expanded", "false")
      });
      button.setAttribute("aria-expanded", "true");
      details.querySelector("[data-sync-now]").addEventListener("click", async e => {
        e.target.disabled = true;
        try {
          await window.blockStore?.replayWAL();
          await window.DCCCommitmentSync?.flush();
          await window.DCCCommitmentSync?.refresh();
          statusOverlay.close("sync-now");
        } catch (err) { DCC.toast(err.message, "error"); }
        finally { e.target.disabled = false; }
      });
      details.querySelector("[data-export-pending]").addEventListener("click", async () => {
        const payload = { account: window.DCC_ACCOUNT_CONTEXT, tasks: window.blockStore?.exportPending(),
          commitments: await window.DCCCommitmentSync?.pending() || [] };
        const href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
        const a = document.createElement("a"); a.href = href; a.download = "dcc-pending-changes.json"; a.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      });
      const openBrief = details.querySelector("[data-open-brief]");
      if (openBrief) openBrief.addEventListener("click", () => {
        statusOverlay.close("open-brief");
        window.setTimeout(() => DCC.brief && DCC.brief.open(button), 0);
      });
    });
    document.addEventListener("dcc:save-status", (event) => renderSaveStatus(event.detail));
    document.addEventListener("dcc:working-queue-sync", () => renderSaveStatus(saveDetail));
    window.addEventListener("storage", (event) => { if (String(event.key || "").startsWith("dcc-working-queue:")) renderSaveStatus(saveDetail); });
    // Escape hides the tooltip without moving focus, whether it is showing for
    // focus or for a pointer resting on the dot or on the tooltip itself.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || button.getAttribute("aria-expanded") === "true") return;
      if (document.activeElement === button || button.matches(":hover")) button.classList.add("tooltip-dismissed");
    });
    button.addEventListener("blur", () => button.classList.remove("tooltip-dismissed"));
    button.addEventListener("mouseleave", () => button.classList.remove("tooltip-dismissed"));
    renderSaveStatus(saveDetail);
  }

  function moveUtilities() {
    const button = document.getElementById("dcc-settings-button");
    const menu = document.getElementById("dcc-settings-menu");
    if (!button || !menu) return;
    // The cog keeps its icon and accessible name; every utility moves into its menu.
    const items = [
      document.querySelector(".admin-link[href='/admin']"),
      document.getElementById("sn-open-btn")
    ].filter(Boolean);
    items.reverse().forEach((item) => {
      item.classList.add("dcc-utility-item");
      item.setAttribute("role", "menuitem");
      menu.insertBefore(item, menu.firstChild);
    });
    const work = document.createElement("button");
    work.type = "button";
    work.textContent = "Start work";
    work.addEventListener("click", () => window.DCCWorkSessions && window.DCCWorkSessions.openPicker());
    const feedback = document.createElement("button");
    feedback.type = "button";
    feedback.textContent = "Send feedback";
    feedback.addEventListener("click", () => typeof window.dccOpenFeedback === "function" && window.dccOpenFeedback());
    [work, feedback].forEach((item) => menu.appendChild(item));
    // The day's activity summary (sync.js) rides at the bottom of the menu.
    const summary = document.getElementById("sync-section");
    if (summary) menu.appendChild(summary);
  }

  // DCC.nav announces every page/view change; the shell only follows it with
  // its layout mode and per-panel scroll. It never owns navigation state.
  function wireTabs() {
    document.addEventListener("dcc:nav-changed", (event) => {
      const detail = event.detail || {};
      if (!detail.panel || detail.panel === detail.prevPanel) return;
      if (detail.prevPanel) scrollPositions.set(detail.prevPanel, window.scrollY);
      persistScrollPositions();
      activate(detail.panel);
      if (detail.source !== "code") window.scrollTo({ top: scrollPositions.get(detail.panel) || 0, behavior: "auto" });
    });
  }

  function wireScrollCollapse() {
    let queued = false;
    window.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        document.body.classList.toggle("dcc-shell-scrolled", window.scrollY > 96);
        queued = false;
      });
    }, { passive: true });
  }

  function wireStickyOffsets() {
    const header = document.querySelector(".header");
    if (!header) return;
    const update = () => {
      const height = Math.ceil(header.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--dcc-header-height", height + "px");
    };
    update();
    if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(header);
    else window.addEventListener("resize", update, { passive: true });
  }

  function watchLegacyOverlays() {
    const refresh = () => {
      const selector = [
        ".side-drawer.open",
        ".done-modal-overlay.open", ".add-modal-overlay.open", ".delegated-modal-overlay.open",
        ".sched-picker-overlay.open", ".sn-overlay.open", ".notes-drawer-overlay.open",
        ".carryover-overlay.open", ".coach-modal:not([hidden])", ".vault-review-overlay:not([hidden])",
        ".rv-backdrop", ".bt-modal-backdrop"
      ].join(",");
      const legacyOpen = Array.from(document.querySelectorAll(selector)).some((node) => {
        if (node.closest(".dcc-overlay")) return false;
        const parentDrawer = node.closest(".side-drawer");
        if (parentDrawer && !parentDrawer.classList.contains("open")) return false;
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
      });
      document.body.classList.toggle("dcc-legacy-overlay-open", legacyOpen);
    };
    new MutationObserver(refresh).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "aria-hidden"] });
    refresh();
  }

  function init() {
    loadScrollPositions();
    try { saveDetail = normalizeSaveDetail(JSON.parse(localStorage.getItem("dcc:save-status:" + (window.DCC_ACCOUNT_CONTEXT?.userId || "unverified")) || "{}")); }
    catch (_) {}
    moveUtilities();
    wireSaveStatus();
    wireTabs();
    wireScrollCollapse();
    wireStickyOffsets();
    watchLegacyOverlays();
    const nav = DCC.nav && DCC.nav.get();
    activate(nav && DCC.NavState ? DCC.NavState.panelFor(nav) : "working-queue");
  }

  DCC.shell = { activate, register, modes, get activeSurface() { return activeSurface; } };
  DCC.saveStatus = { update: renderSaveStatus, get detail() { return Object.assign({}, saveDetail); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
