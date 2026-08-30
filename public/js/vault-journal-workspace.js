// Adaptive Mycelium journal reader and writer workspace.
//
// One #vault-reading instance serves every journal entry. It can focus, float,
// dock, or minimize without losing the active entry or its scroll position.
// Layout preferences stay on this device. Journal content still uses the vault's
// normal read and optimistic-lock write paths.

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VaultJournalWorkspace = api;
})(typeof globalThis !== "undefined" && globalThis.document ? globalThis : null, function (root) {
  "use strict";

  const STORAGE_KEY = "dcc:mycelium-journal-workspace";
  const TRAY_KEY = "dcc:mycelium-journal-references";
  const POSITION_KEY = "dcc:mycelium-journal-positions";
  const TRAY_LIMIT = 6;
  const POSITION_LIMIT = 20;
  const DOCK_MIN_VIEWPORT = 900;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 240;
  const FOCUS_MARGIN = 24;
  const DOCK_MIN = 320;
  const MODES = ["focus", "float", "dock-left", "dock-right"];
  const DEFAULT_PREFERENCES = Object.freeze({
    mode: "focus",
    x: 0,
    y: 0,
    width: 760,
    height: 900,
    dockWidth: 480,
    collapsed: false,
  });

  const finite = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const viewportNow = () => root ? { width: root.innerWidth, height: root.innerHeight } : { width: 1280, height: 900 };
  const isDocked = (mode) => mode === "dock-left" || mode === "dock-right";
  const canDock = (viewport) => viewport.width >= DOCK_MIN_VIEWPORT;

  function fitToViewport(viewport) {
    const width = Math.max(Math.min(900, viewport.width - FOCUS_MARGIN * 2), Math.min(MIN_WIDTH, viewport.width));
    const height = Math.max(viewport.height - FOCUS_MARGIN * 2, Math.min(MIN_HEIGHT, viewport.height));
    return {
      width,
      height,
      x: Math.max(0, Math.round((viewport.width - width) / 2)),
      y: Math.max(0, Math.round((viewport.height - height) / 2)),
    };
  }

  function clampToViewport(geometry, viewport) {
    const width = clamp(finite(geometry.width, DEFAULT_PREFERENCES.width), Math.min(MIN_WIDTH, viewport.width), viewport.width);
    const height = clamp(finite(geometry.height, DEFAULT_PREFERENCES.height), Math.min(MIN_HEIGHT, viewport.height), viewport.height);
    return {
      width,
      height,
      x: Math.round(clamp(finite(geometry.x, 0), 0, viewport.width - width)),
      y: Math.round(clamp(finite(geometry.y, 0), 0, viewport.height - height)),
    };
  }

  function clampDockWidth(value, viewport) {
    const ceiling = Math.max(DOCK_MIN, Math.floor(viewport.width / 2));
    return Math.round(clamp(finite(value, DEFAULT_PREFERENCES.dockWidth), Math.min(DOCK_MIN, ceiling), ceiling));
  }

  function settle(preferences, viewport) {
    const requested = MODES.includes(preferences.mode) ? preferences.mode : "focus";
    const mode = isDocked(requested) && !canDock(viewport) ? "focus" : requested;
    const dockWidth = clampDockWidth(preferences.dockWidth, viewport);
    if (mode === "focus") return Object.assign({}, preferences, fitToViewport(viewport), { mode, dockWidth });
    if (isDocked(mode)) return Object.assign({}, preferences, { mode, dockWidth });
    return Object.assign({}, preferences, clampToViewport(preferences, viewport), { mode, dockWidth });
  }

  function afterClose(preferences) {
    return Object.assign({}, preferences, { mode: "focus", collapsed: false });
  }

  function parsePreferences(raw) {
    if (!raw) return Object.assign({}, DEFAULT_PREFERENCES);
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object") return Object.assign({}, DEFAULT_PREFERENCES);
      return {
        mode: MODES.includes(value.mode) ? value.mode : DEFAULT_PREFERENCES.mode,
        x: finite(value.x, DEFAULT_PREFERENCES.x),
        y: finite(value.y, DEFAULT_PREFERENCES.y),
        width: finite(value.width, DEFAULT_PREFERENCES.width),
        height: finite(value.height, DEFAULT_PREFERENCES.height),
        dockWidth: finite(value.dockWidth, DEFAULT_PREFERENCES.dockWidth),
        collapsed: value.collapsed === true,
      };
    } catch {
      return Object.assign({}, DEFAULT_PREFERENCES);
    }
  }

  function outlineId(text, seen) {
    const base = String(text || "section").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "section";
    const count = (seen[base] || 0) + 1;
    seen[base] = count;
    return `journal-section-${base}${count > 1 ? `-${count}` : ""}`;
  }

  function projectOutline(markdown) {
    const seen = {};
    const entries = [];
    let fenced = false;
    for (const line of String(markdown || "").split("\n")) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      const label = match[2].replace(/[*_`]/g, "").trim();
      entries.push({ id: outlineId(label, seen), label, level: match[1].length });
    }
    return entries;
  }

  if (!root || !root.document) {
    return {
      DEFAULT_PREFERENCES, DOCK_MIN_VIEWPORT, fitToViewport, clampToViewport,
      clampDockWidth, canDock, settle, afterClose, parsePreferences, projectOutline,
    };
  }

  const doc = root.document;
  let ctx = { openSlug() {}, editNode() {}, onClose() {} };
  let prefs = parsePreferences(readStorage(STORAGE_KEY));
  let tray = parseList(readStorage(TRAY_KEY), TRAY_LIMIT);
  let positions = parseObject(readStorage(POSITION_KEY));
  let current = null;
  let active = false;
  let pinned = false;
  let outline = [];
  let scrollTimer = null;
  let resizeTimer = null;
  let resizeObserver = null;

  function readStorage(key) {
    try { return root.localStorage.getItem(key); } catch { return null; }
  }

  function writeStorage(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function parseList(raw, limit) {
    try { const value = JSON.parse(raw || "[]"); return Array.isArray(value) ? value.filter(Boolean).slice(0, limit) : []; }
    catch { return []; }
  }

  function parseObject(raw) {
    try { const value = JSON.parse(raw || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  }

  function persistPreferences() { writeStorage(STORAGE_KEY, prefs); }

  function reading() { return doc.getElementById("vault-reading"); }
  function detail() { return doc.getElementById("vault-detail"); }

  function ensureShell() {
    const pane = reading();
    if (!pane) return null;
    let backdrop = doc.getElementById("vault-journal-backdrop");
    if (!backdrop) {
      backdrop = doc.createElement("div");
      backdrop.id = "vault-journal-backdrop";
      backdrop.addEventListener("click", () => close());
      doc.body.appendChild(backdrop);
    }
    let restore = doc.getElementById("vault-journal-restore");
    if (!restore) {
      restore = doc.createElement("button");
      restore.id = "vault-journal-restore";
      restore.type = "button";
      restore.addEventListener("click", restoreWorkspace);
      doc.body.appendChild(restore);
    }
    let zone = pane.querySelector(".vault-journal-hotbar-zone");
    if (!zone) {
      zone = doc.createElement("div");
      zone.className = "vault-journal-hotbar-zone";
      zone.innerHTML = `
        <div class="vault-journal-hotbar" role="toolbar" aria-label="Journal reader and writer controls">
          <div class="vault-journal-identity"><strong data-journal-title></strong><span>Journal</span></div>
          <div class="vault-journal-menu-wrap">
            <button type="button" class="vault-journal-ctl wide" data-journal-menu="contents" data-short="☰" aria-expanded="false">Contents</button>
            <button type="button" class="vault-journal-ctl wide" data-journal-menu="sources" data-short="↺" aria-expanded="false">Entries</button>
          </div>
          <div class="vault-journal-layout" role="group" aria-label="Reader layout">
            <button type="button" class="vault-journal-ctl" data-journal-mode="focus" title="Focus" aria-label="Focus">◻</button>
            <button type="button" class="vault-journal-ctl" data-journal-mode="float" title="Float" aria-label="Float">❐</button>
            <button type="button" class="vault-journal-ctl" data-journal-mode="dock-left" title="Dock left" aria-label="Dock left">◧</button>
            <button type="button" class="vault-journal-ctl" data-journal-mode="dock-right" title="Dock right" aria-label="Dock right">◨</button>
          </div>
          <button type="button" class="vault-journal-ctl write" data-journal-edit>✎ Write</button>
          <button type="button" class="vault-journal-ctl" data-journal-minimize title="Minimize" aria-label="Minimize">−</button>
          <button type="button" class="vault-journal-ctl" data-journal-close title="Close" aria-label="Close">×</button>
        </div>
        <button class="vault-journal-sensor" type="button" aria-label="Pin journal controls" aria-expanded="false"></button>
        <div class="vault-journal-sheet" hidden></div>`;
      pane.insertBefore(zone, pane.firstChild);
      wireShell(zone);
    }
    return { pane, backdrop, restore, zone };
  }

  function wireShell(zone) {
    zone.querySelectorAll("[data-journal-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.journalMode));
    });
    zone.querySelector("[data-journal-edit]").addEventListener("click", () => {
      if (current && current.editable !== false) ctx.editNode(current.node);
    });
    zone.querySelector("[data-journal-minimize]").addEventListener("click", minimize);
    zone.querySelector("[data-journal-close]").addEventListener("click", close);
    zone.querySelector(".vault-journal-sensor").addEventListener("click", () => {
      pinned = !pinned;
      zone.classList.toggle("pinned", pinned);
      zone.querySelector(".vault-journal-sensor").setAttribute("aria-expanded", String(pinned));
    });
    zone.querySelectorAll("[data-journal-menu]").forEach((button) => {
      button.addEventListener("click", () => toggleMenu(button.dataset.journalMenu, button));
    });
    zone.querySelector(".vault-journal-hotbar").addEventListener("pointerdown", startDrag);
  }

  function remember(node) {
    const fm = node.frontmatter || {};
    const entry = { slug: node.slug, title: fm.title || node.slug.split("/").pop() };
    tray = [entry, ...tray.filter((item) => item.slug !== entry.slug)].slice(0, TRAY_LIMIT);
    writeStorage(TRAY_KEY, tray);
  }

  function rememberScroll() {
    if (!current || !reading()) return;
    positions[current.slug] = reading().scrollTop || 0;
    const recent = Object.entries(positions).slice(-POSITION_LIMIT);
    positions = Object.fromEntries(recent);
    writeStorage(POSITION_KEY, positions);
  }

  function prepare(nextSlug) {
    if (active && current && current.slug !== nextSlug) rememberScroll();
  }

  function restoreScroll(slug) {
    root.requestAnimationFrame(() => {
      const pane = reading();
      if (pane && current && current.slug === slug) pane.scrollTop = finite(positions[slug], 0);
    });
  }

  function wireScroll() {
    const pane = reading();
    if (!pane || pane.dataset.journalScrollWired) return;
    pane.dataset.journalScrollWired = "true";
    pane.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(rememberScroll, 120);
    }, { passive: true });
  }

  function wireOutline(node) {
    outline = projectOutline(node.body || "");
    const headings = detail() ? detail().querySelectorAll(".vault-body-md h1,.vault-body-md h2,.vault-body-md h3") : [];
    outline.forEach((entry, index) => { if (headings[index]) headings[index].id = entry.id; });
  }

  function toggleMenu(kind, button) {
    const shell = ensureShell();
    if (!shell) return;
    const sheet = shell.zone.querySelector(".vault-journal-sheet");
    const already = !sheet.hidden && sheet.dataset.kind === kind;
    shell.zone.querySelectorAll("[data-journal-menu]").forEach((item) => item.setAttribute("aria-expanded", "false"));
    if (already) { sheet.hidden = true; delete sheet.dataset.kind; return; }
    sheet.dataset.kind = kind;
    sheet.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (kind === "contents") {
      sheet.innerHTML = outline.length
        ? `<div class="vault-journal-sheet-title">Contents</div>${outline.map((entry) => `<button type="button" data-outline="${entry.id}" class="level-${entry.level}">${escapeHtml(entry.label)}</button>`).join("")}`
        : '<div class="vault-journal-sheet-empty">This entry has no headings.</div>';
      sheet.querySelectorAll("[data-outline]").forEach((item) => item.addEventListener("click", () => {
        const target = doc.getElementById(item.dataset.outline);
        if (target) target.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
        sheet.hidden = true;
      }));
    } else {
      sheet.innerHTML = `<div class="vault-journal-sheet-title">Recent entries</div>${tray.map((entry) => `<button type="button" data-source="${escapeHtml(entry.slug)}"><span>${escapeHtml(entry.title)}</span><small>${escapeHtml(entry.slug)}</small></button>`).join("")}`;
      sheet.querySelectorAll("[data-source]").forEach((item) => item.addEventListener("click", () => {
        sheet.hidden = true;
        ctx.openSlug(item.dataset.source);
      }));
    }
  }

  function reducedMotion() { return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function open(node, options) {
    if (!node || !node.slug) return;
    const sameSource = active && current && current.slug === node.slug;
    if (!sameSource) prepare(node.slug);
    current = {
      slug: node.slug,
      node,
      editable: !(options && options.editable === false),
      title: (node.frontmatter && node.frontmatter.title) || node.slug.split("/").pop(),
    };
    active = true;
    if (!sameSource) prefs = settle(Object.assign({}, prefs, { collapsed: false }), viewportNow());
    remember(node);
    wireScroll();
    wireOutline(node);
    renderChrome();
    applyLayout();
    restoreScroll(node.slug);
  }

  function renderChrome() {
    const shell = ensureShell();
    if (!shell || !current) return;
    shell.zone.querySelector("[data-journal-title]").textContent = current.title;
    const edit = shell.zone.querySelector("[data-journal-edit]");
    edit.hidden = !current.editable;
    shell.restore.textContent = `📔 ${current.title}`;
    shell.restore.setAttribute("aria-label", `Restore ${current.title}`);
    shell.zone.querySelectorAll("[data-journal-mode]").forEach((button) => {
      const mode = button.dataset.journalMode;
      button.classList.toggle("active", prefs.mode === mode);
      button.setAttribute("aria-pressed", String(prefs.mode === mode));
      button.disabled = mode.startsWith("dock") && !canDock(viewportNow());
    });
  }

  function clearBodyClasses() {
    doc.body.classList.remove("vault-journal-focus", "vault-journal-float", "vault-journal-dock-left", "vault-journal-dock-right", "vault-journal-collapsed");
    doc.body.style.removeProperty("--vault-journal-dock-width");
  }

  function clearPaneStyle() {
    const pane = reading();
    if (!pane) return;
    ["left", "top", "right", "bottom", "width", "height"].forEach((name) => pane.style.removeProperty(name));
    pane.removeAttribute("role");
    pane.removeAttribute("aria-modal");
    pane.removeAttribute("aria-label");
    pane.removeAttribute("tabindex");
  }

  function applyLayout() {
    const shell = ensureShell();
    if (!shell || !active) return;
    prefs = settle(prefs, viewportNow());
    clearBodyClasses();
    clearPaneStyle();
    const pane = shell.pane;
    doc.body.classList.add(`vault-journal-${prefs.mode}`);
    doc.body.classList.toggle("vault-journal-collapsed", prefs.collapsed);
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-label", `${current.title} journal workspace`);
    pane.setAttribute("tabindex", "-1");
    if (prefs.mode === "focus") pane.setAttribute("aria-modal", "true");
    if (prefs.mode === "focus" || prefs.mode === "float") {
      pane.style.left = `${prefs.x}px`;
      pane.style.top = `${prefs.y}px`;
      pane.style.width = `${prefs.width}px`;
      pane.style.height = `${prefs.height}px`;
    } else {
      pane.style[prefs.mode === "dock-left" ? "left" : "right"] = "0px";
      pane.style.top = "0px";
      pane.style.width = `${prefs.dockWidth}px`;
      pane.style.height = `${viewportNow().height}px`;
      doc.body.style.setProperty("--vault-journal-dock-width", `${prefs.dockWidth}px`);
    }
    renderChrome();
    observeResize();
    persistPreferences();
  }

  function setMode(mode) {
    if (!active || !MODES.includes(mode)) return;
    if (mode.startsWith("dock") && !canDock(viewportNow())) mode = "focus";
    prefs = settle(Object.assign({}, prefs, { mode, collapsed: false }), viewportNow());
    applyLayout();
  }

  function minimize() {
    if (!active) return;
    rememberScroll();
    prefs = Object.assign({}, prefs, { collapsed: true });
    applyLayout();
  }

  function restoreWorkspace() {
    if (!active) return;
    prefs = settle(Object.assign({}, prefs, { collapsed: false }), viewportNow());
    applyLayout();
    restoreScroll(current.slug);
    const pane = reading();
    if (pane) pane.focus({ preventScroll: true });
  }

  function deactivate(reset) {
    if (active) rememberScroll();
    active = false;
    current = null;
    outline = [];
    if (reset !== false) prefs = afterClose(prefs);
    clearBodyClasses();
    clearPaneStyle();
    const shell = ensureShell();
    if (shell) {
      shell.zone.classList.remove("pinned");
      shell.zone.querySelector(".vault-journal-sheet").hidden = true;
    }
    pinned = false;
    persistPreferences();
    if (resizeObserver) resizeObserver.disconnect();
  }

  function close() {
    if (!active) return;
    deactivate(true);
    ctx.onClose();
  }

  function observeResize() {
    if (!root.ResizeObserver) return;
    if (resizeObserver) resizeObserver.disconnect();
    const pane = reading();
    if (!pane || prefs.mode === "focus") return;
    resizeObserver = new root.ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!active || !reading()) return;
        const rect = reading().getBoundingClientRect();
        if (prefs.mode === "float") prefs = Object.assign({}, prefs, clampToViewport({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, viewportNow()));
        else if (isDocked(prefs.mode)) prefs = Object.assign({}, prefs, { dockWidth: clampDockWidth(rect.width, viewportNow()) });
        persistPreferences();
      }, 120);
    });
    resizeObserver.observe(pane);
  }

  function startDrag(event) {
    if (!active || prefs.mode !== "float" || event.button !== 0) return;
    if (event.target.closest("button,input,select,a")) return;
    const start = { x: event.clientX, y: event.clientY, left: prefs.x, top: prefs.y };
    const move = (e) => {
      prefs = Object.assign({}, prefs, clampToViewport(Object.assign({}, prefs, {
        x: start.left + e.clientX - start.x,
        y: start.top + e.clientY - start.y,
      }), viewportNow()));
      const pane = reading();
      if (pane) { pane.style.left = `${prefs.x}px`; pane.style.top = `${prefs.y}px`; }
    };
    const stop = () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", stop);
      persistPreferences();
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", stop, { once: true });
  }

  function reflow() {
    if (!active) return;
    prefs = settle(prefs, viewportNow());
    applyLayout();
  }

  function init(config) {
    ctx = Object.assign(ctx, config || {});
    ensureShell();
    root.addEventListener("resize", reflow, { passive: true });
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !active || prefs.collapsed) return;
      const editor = doc.getElementById("vault-editor-overlay");
      const lightbox = doc.getElementById("vault-lightbox");
      if ((editor && editor.classList.contains("open")) || (lightbox && lightbox.style.display === "flex")) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }, true);
  }

  return {
    DEFAULT_PREFERENCES, DOCK_MIN_VIEWPORT, fitToViewport, clampToViewport,
    clampDockWidth, canDock, settle, afterClose, parsePreferences, projectOutline,
    init, prepare, open, deactivate, close, minimize, restore: restoreWorkspace, setMode,
  };
});
