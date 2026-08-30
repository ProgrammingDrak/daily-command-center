// Responsive application shell, utilities, per-workspace scroll, and save truth.
(function () {
  "use strict";

  const DCC = (window.DCC = window.DCC || {});
  const modes = new Map([
    ["schedule", "dashboard"],
    ["pet-home", "dashboard"],
    ["budget", "full-width"],
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

  function renderSaveStatus(detail) {
    saveDetail = normalizeSaveDetail(detail);
    const button = document.getElementById("save-status");
    if (!button) return;
    const local = button.querySelector("[data-save-local]");
    const remote = button.querySelector("[data-save-remote]");
    if (local) local.textContent = saveDetail.local;
    if (remote) remote.textContent = saveDetail.remote;
    button.dataset.remoteState = String(saveDetail.remote || "").toLowerCase().replace(/\s+/g, "-");
    button.setAttribute("aria-label", saveDetail.local + ". " + saveDetail.remote + ".");
    button.title = saveDetail.message || "";
  }

  function saveStatusBody() {
    const wrap = document.createElement("div");
    wrap.className = "dcc-save-detail";
    const exact = saveDetail.timestamp ? new Date(saveDetail.timestamp).toLocaleString() : "No save timestamp yet";
    wrap.innerHTML =
      '<div class="dcc-save-row"><span>On this device</span><strong>' + DCC.esc(saveDetail.local) + '</strong></div>' +
      '<div class="dcc-save-row"><span>Across devices</span><strong>' + DCC.esc(saveDetail.remote) + '</strong></div>' +
      '<div class="dcc-save-row"><span>Waiting changes</span><strong>' + saveDetail.pending + '</strong></div>' +
      '<p>' + DCC.esc(saveDetail.message || "") + '</p>' +
      '<time>' + DCC.esc(exact) + '</time>' +
      '<div class="dcc-save-brief">' +
        '<div><strong>Daily Brief</strong><span>Review today’s generated packet.</span></div>' +
        '<button type="button" data-open-brief>Open Brief</button>' +
      '</div>';
    return wrap;
  }

  function wireSaveStatus() {
    const button = document.getElementById("save-status");
    if (!button) return;
    const headerActions = document.querySelector(".header > div:last-child");
    if (headerActions && button.parentElement !== headerActions) headerActions.insertBefore(button, headerActions.firstChild);
    button.addEventListener("click", () => {
      const details = saveStatusBody();
      const statusOverlay = DCC.overlay.open({
        kind: "popover",
        title: "Save status",
        body: details,
        anchor: button,
        onClose: () => button.setAttribute("aria-expanded", "false")
      });
      button.setAttribute("aria-expanded", "true");
      const openBrief = details.querySelector("[data-open-brief]");
      if (openBrief) openBrief.addEventListener("click", () => {
        statusOverlay.close("open-brief");
        window.setTimeout(() => DCC.brief && DCC.brief.open(button), 0);
      });
    });
    document.addEventListener("dcc:save-status", (event) => renderSaveStatus(event.detail));
    renderSaveStatus(saveDetail);
  }

  function moveUtilities() {
    const button = document.getElementById("dcc-settings-button");
    const menu = document.getElementById("dcc-settings-menu");
    if (!button || !menu) return;
    button.textContent = "Utilities";
    button.title = "Open utilities";
    const items = [
      document.querySelector(".admin-link[href='/admin']"),
      document.getElementById("todo-share-open"),
      document.getElementById("todo-reactions-toggle"),
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
    const loose = document.createElement("button");
    loose.type = "button";
    loose.textContent = "Open Loose Ends";
    loose.addEventListener("click", () => window.DCC.CatchUp && window.DCC.CatchUp.open());
    const feedback = document.createElement("button");
    feedback.type = "button";
    feedback.textContent = "Send feedback";
    feedback.addEventListener("click", () => typeof window.dccOpenFeedback === "function" && window.dccOpenFeedback());
    [work, loose, feedback].forEach((item) => menu.appendChild(item));
  }

  function wireTabs() {
    const bar = document.getElementById("tab-bar");
    if (!bar) return;
    bar.addEventListener("click", (event) => {
      const tab = event.target.closest(".tab[data-tab]");
      if (!tab) return;
      scrollPositions.set(activeSurface, window.scrollY);
      persistScrollPositions();
      const target = tab.dataset.tab;
      setTimeout(() => {
        activate(target);
        window.scrollTo({ top: scrollPositions.get(target) || 0, behavior: "auto" });
      }, 0);
    }, true);
    document.querySelectorAll(".svt-btn[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        const full = button.dataset.view === "calendar" || button.dataset.view === "actual";
        document.body.classList.toggle("dcc-schedule-full", full);
      });
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
    try { saveDetail = normalizeSaveDetail(JSON.parse(localStorage.getItem("dcc:save-status") || "{}")); }
    catch (_) {}
    moveUtilities();
    wireSaveStatus();
    wireTabs();
    wireScrollCollapse();
    wireStickyOffsets();
    watchLegacyOverlays();
    const current = document.querySelector(".tab.active[data-tab]");
    activate(current ? current.dataset.tab : "schedule");
  }

  DCC.shell = { activate, register, modes, get activeSurface() { return activeSurface; } };
  DCC.saveStatus = { update: renderSaveStatus, get detail() { return Object.assign({}, saveDetail); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
