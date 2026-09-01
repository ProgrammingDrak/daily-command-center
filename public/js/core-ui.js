// Shared overlay controller. One controller owns modal, drawer, sheet, and popover.
(function () {
  "use strict";

  const DCC = (window.DCC = window.DCC || {});
  const FOCUSABLE = [
    "a[href]", "button:not([disabled])", "input:not([disabled])",
    "select:not([disabled])", "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  const BLOCKING = new Set(["modal", "drawer", "sheet"]);
  let activeBlocking = null;

  function visibleFocusable(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((node) =>
      !node.hidden && node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length
    );
  }

  function setPageInert(overlay, on) {
    Array.from(document.body.children).forEach((node) => {
      if (node === overlay || node.tagName === "SCRIPT" || node.classList.contains("toast-container")) return;
      if (on) {
        node.dataset.dccWasInert = node.inert ? "1" : "0";
        node.inert = true;
      } else if (node.dataset.dccWasInert !== undefined) {
        node.inert = node.dataset.dccWasInert === "1";
        delete node.dataset.dccWasInert;
      }
    });
  }

  function placePopover(panel, anchor) {
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    requestAnimationFrame(() => {
      const width = panel.offsetWidth || 320;
      const height = panel.offsetHeight || 240;
      const left = Math.max(gap, Math.min(window.innerWidth - width - gap, rect.left));
      const below = rect.bottom + gap;
      const top = below + height <= window.innerHeight
        ? below
        : Math.max(gap, rect.top - height - gap);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });
  }

  function normalizeActions(actions) {
    return Array.isArray(actions) ? actions.filter(Boolean) : [];
  }

  function open(options) {
    const opts = options || {};
    const kind = ["popover", "modal", "drawer", "sheet"].includes(opts.kind) ? opts.kind : "modal";
    const blocking = BLOCKING.has(kind);
    if (blocking && activeBlocking) activeBlocking.close("replaced");

    const opener = opts.anchor || document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "dcc-overlay dcc-overlay--" + kind;
    overlay.dataset.overlayKind = kind;

    const panel = document.createElement("section");
    panel.className = "dcc-" + kind;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", blocking ? "true" : "false");
    panel.tabIndex = -1;

    const titleId = "dcc-overlay-title-" + Math.random().toString(36).slice(2);
    panel.innerHTML =
      (kind === "sheet" ? '<div class="dcc-sheet-handle" aria-hidden="true"></div>' : "") +
      '<header class="dcc-overlay-head">' +
        '<button class="dcc-overlay-back" type="button" aria-label="Back" hidden>‹</button>' +
        '<h2 class="dcc-overlay-title" id="' + titleId + '"></h2>' +
        '<button class="dcc-overlay-close" type="button" aria-label="Close">×</button>' +
      '</header>' +
      '<div class="dcc-overlay-body"></div>' +
      '<footer class="dcc-overlay-actions" hidden></footer>';
    panel.setAttribute("aria-labelledby", titleId);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const title = panel.querySelector(".dcc-overlay-title");
    const body = panel.querySelector(".dcc-overlay-body");
    const footer = panel.querySelector(".dcc-overlay-actions");
    const back = panel.querySelector(".dcc-overlay-back");
    const stack = [];
    let closed = false;

    function render(view) {
      const state = view || opts;
      title.textContent = state.title || "";
      body.replaceChildren();
      if (state.body instanceof Node) body.appendChild(state.body);
      else if (typeof state.body === "string") body.innerHTML = state.body;
      footer.replaceChildren();
      const actions = normalizeActions(state.actions);
      footer.hidden = actions.length === 0;
      actions.forEach((action) => {
        const button = document.createElement("button");
        const tone = action.destructive || state.destructive
          ? "danger"
          : action.kind === "primary" ? "primary" : "secondary";
        button.type = "button";
        button.className = "dcc-overlay-btn dcc-overlay-btn--" + tone;
        button.textContent = action.label || "OK";
        button.addEventListener("click", async () => {
          const result = typeof action.onClick === "function" ? await action.onClick(handle) : undefined;
          if (result !== false && action.keepOpen !== true) close("action");
        });
        footer.appendChild(button);
      });
      back.hidden = stack.length === 0;
      if (kind === "popover") placePopover(panel, opts.anchor);
    }

    function push(view) {
      stack.push({ title: title.textContent, body: body.cloneNode(true), actions: [] });
      render(view);
      panel.focus();
    }

    function goBack() {
      const previous = stack.pop();
      if (!previous) return false;
      title.textContent = previous.title;
      body.replaceChildren(...Array.from(previous.body.childNodes));
      footer.hidden = true;
      back.hidden = stack.length === 0;
      panel.focus();
      return true;
    }

    function finishClose(reason) {
      overlay.remove();
      if (blocking) setPageInert(overlay, false);
      if (activeBlocking === handle) activeBlocking = null;
      document.body.classList.toggle("dcc-overlay-open", !!activeBlocking);
      if (reason !== "replaced" && opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    }

    function close(reason) {
      if (closed) return;
      closed = true;
      overlay.classList.remove("open");
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside, true);
      let finished = false;
      const done = () => { if (!finished) { finished = true; finishClose(reason); } };
      if (reason === "replaced") done();
      else {
        overlay.addEventListener("transitionend", done, { once: true });
        window.setTimeout(done, 280);
      }
      if (typeof opts.onClose === "function") opts.onClose(reason || "close");
    }

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!goBack()) close("escape");
        return;
      }
      if (event.key !== "Tab" || !blocking) return;
      const items = visibleFocusable(panel);
      if (!items.length) { event.preventDefault(); panel.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    function onOutside(event) {
      if (kind !== "popover" || panel.contains(event.target) || (opts.anchor && opts.anchor.contains(event.target))) return;
      close("outside");
    }

    const handle = { el: panel, overlay, close, push, back: goBack, update: render };
    panel.querySelector(".dcc-overlay-close").addEventListener("click", () => close("close-button"));
    back.addEventListener("click", goBack);
    if (blocking) {
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close("backdrop"); });
      setPageInert(overlay, true);
      activeBlocking = handle;
      document.body.classList.add("dcc-overlay-open");
    } else {
      document.addEventListener("pointerdown", onOutside, true);
    }
    document.addEventListener("keydown", onKey, true);
    render(opts);
    requestAnimationFrame(() => {
      overlay.classList.add("open");
      const first = visibleFocusable(panel)[0];
      (first || panel).focus({ preventScroll: true });
    });
    return handle;
  }

  DCC.overlay = { open, get activeBlocking() { return activeBlocking; } };

  DCC.reducedMotion = function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (error) { return false; }
  };

  // Interruptions degrade to quiet UI while another interaction owns attention.
  DCC.busyElsewhere = function busyElsewhere() {
    if (typeof document.hidden === "boolean" && document.hidden) return true;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.contentEditable === "true")) return true;
    if (DCC.overlay.activeBlocking) return true;
    if (typeof window._anyModalOpen === "function" && window._anyModalOpen()) return true;
    const catchup = document.getElementById("catchup-overlay") || document.getElementById("unfinished-overlay");
    return !!(catchup && catchup.classList && catchup.classList.contains("open"));
  };

  DCC.modal = function modal(opts) { return open(Object.assign({}, opts || {}, { kind: "modal" })); };
  DCC.sheet = function sheet(opts) { return open(Object.assign({}, opts || {}, { kind: "sheet" })); };
})();
