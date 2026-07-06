// core-ui.js — shared overlay primitives on window.DCC. Loaded right after
// core.js. Two factories that replace the ~5 hand-rolled overlay builders
// (carryover-review, delegated, responsibilities, features, mobile-shell),
// each of which reinvented backdrop + open animation + close wiring.
//
//   DCC.modal({ title, body, actions?, onClose? })  -> centered dialog
//   DCC.sheet({ title, body, onClose? })            -> bottom sheet (mobile)
//
// `body` is an HTML string OR a DOM node. `actions` is [{label, kind, onClick}]
// (kind: "primary" | "secondary", default secondary). Both return a handle
// { el, close }. Both close on: the close button, backdrop click, and Escape.
// Focus moves into the panel on open and the opener is restored on close.
(function () {
  "use strict";
  const DCC = (window.DCC = window.DCC || {});

  function buildOverlay(kind, opts) {
    const esc = DCC.esc;
    const prevFocus = document.activeElement;

    const backdrop = document.createElement("div");
    backdrop.className = "dcc-overlay dcc-overlay--" + kind;

    const panel = document.createElement("div");
    panel.className = "dcc-" + kind;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;

    const handle = kind === "sheet"
      ? '<div class="dcc-sheet-handle" aria-hidden="true"></div>' : "";
    const titleHTML = opts.title
      ? '<div class="dcc-overlay-head"><span class="dcc-overlay-title">' + esc(opts.title)
        + '</span><button class="dcc-overlay-close" aria-label="Close">×</button></div>'
      : '<button class="dcc-overlay-close dcc-overlay-close--floating" aria-label="Close">×</button>';
    panel.innerHTML = handle + titleHTML + '<div class="dcc-overlay-body"></div>';

    const bodyEl = panel.querySelector(".dcc-overlay-body");
    if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
    else if (typeof opts.body === "string") bodyEl.innerHTML = opts.body;

    if (Array.isArray(opts.actions) && opts.actions.length) {
      const foot = document.createElement("div");
      foot.className = "dcc-overlay-actions";
      opts.actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.className = "dcc-overlay-btn dcc-overlay-btn--" + (a.kind === "primary" ? "primary" : "secondary");
        btn.textContent = a.label || "OK";
        btn.addEventListener("click", () => { if (!a.onClick || a.onClick() !== false) close(); });
        foot.appendChild(btn);
      });
      panel.appendChild(foot);
    }

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    // next frame -> trigger the CSS open transition
    requestAnimationFrame(() => backdrop.classList.add("open"));

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      backdrop.classList.remove("open");
      document.removeEventListener("keydown", onKey);
      const done = () => { backdrop.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
      // wait out the transition, with a fallback if none fires
      let fired = false;
      backdrop.addEventListener("transitionend", () => { if (!fired) { fired = true; done(); } }, { once: true });
      setTimeout(() => { if (!fired) { fired = true; done(); } }, 280);
      if (typeof opts.onClose === "function") opts.onClose();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    panel.querySelector(".dcc-overlay-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    panel.focus();

    return { el: panel, close };
  }

  DCC.modal = function modal(opts) { return buildOverlay("modal", opts || {}); };
  DCC.sheet = function sheet(opts) { return buildOverlay("sheet", opts || {}); };
})();
