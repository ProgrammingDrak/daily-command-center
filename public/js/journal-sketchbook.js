// Goodnotes-style journal tools. Uses the vault editor's save, conflict, and
// attachment paths; localStorage only holds pen preferences, and there are no
// external recognition services.
(function () {
  "use strict";
  const W = 1000,
    H = 1200;
  let sequence = 0;
  // The paper a fresh journal starts on is an account preference
  // (/api/journal/preferences), fetched once per page load and shared by every
  // sketchbook so it follows the user across browsers and devices.
  let paperPreference = null;
  function loadPaperPreference() {
    paperPreference ||= fetch("/api/journal/preferences", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body?.lastPaper || null)
      .catch(() => null);
    return paperPreference;
  }
  function savePaperPreference(lastPaper) {
    paperPreference = Promise.resolve(lastPaper);
    fetch("/api/journal/preferences", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastPaper })
    }).catch(() => { /* the preference is optional; the journal still saves its own paper */ });
  }
  const glyphs = {
    hand: "↔",
    pen: "✎",
    pencil: "✎",
    highlighter: "▰",
    eraser: "⌫",
    lasso: "◌",
    text: "T",
    shape: "◇",
    image: "▧",
    elements: "✧",
    sticky: "▤",
    laser: "•",
    ruler: "╱",
    zoom: "⊕",
    tape: "▱"
  };
  const clone = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "image" ? undefined : item)));
  function fromStored(stroke) {
    return {
      color: stroke.color,
      size: stroke.size,
      tool: stroke.tool || "fineliner",
      pts: stroke.points.flatMap((point) => [point[0], point[1], point[2] ?? 0.5]),
      ...(stroke.style ? { style: stroke.style } : {}),
      ...(!stroke.tool ? { legacy: true } : {})
    };
  }
  function toStored(stroke) {
    const points = [];
    for (let n = 0; n < stroke.pts.length; n += 3)
      points.push(
        stroke.legacy ? [stroke.pts[n], stroke.pts[n + 1]] : [stroke.pts[n], stroke.pts[n + 1], stroke.pts[n + 2]]
      );
    return {
      color: stroke.color,
      size: stroke.size,
      points,
      ...(!stroke.legacy ? { tool: stroke.tool, ...(stroke.style ? { style: stroke.style } : {}) } : {})
    };
  }
  const toolInfo = {
    hand: ["hand", "Hand"],
    pen: ["pen-tool", "Pen"],
    pencil: ["pencil", "Pencil"],
    highlighter: ["highlighter", "Highlight"],
    eraser: ["eraser", "Eraser"],
    lasso: ["lasso-select", "Lasso"],
    text: ["type", "Text"],
    shape: ["shapes", "Shapes"],
    image: ["image", "Image"],
    elements: ["sticker", "Elements"],
    sticky: ["sticky-note", "Sticky"],
    laser: ["mouse-pointer-2", "Laser"],
    ruler: ["ruler", "Ruler"],
    zoom: ["zoom-in", "Zoom"],
    tape: ["rectangle-horizontal", "Tape"]
  };
  function mount(stage, storedPages, { readOnly = false, templates, objects, papers, initialPage = 0, onAttachImage, onChange: notifyChange = () => {}, onMinimize = () => {} } = {}) {
    const panelId = `journal-sketchbook-${++sequence}`;
    stage.classList.add("journal-notebook", "journal-sketchbook");
    let disposed = false;
    const images = new Map();
    let pages = storedPages.map((strokes, n) => ({
      paper: templates?.[n] || "dotted",
      paperSettings: papers?.[n] || null,
      strokes: strokes.map(fromStored),
      objects: clone(objects?.[n] || [])
    }));
    let index = Math.max(0, Math.min(pages.length - 1, Number.isInteger(initialPage) ? initialPage : 0)),
      open = false,
      tool = "hand",
      penType = "fineliner",
      color = "#292722",
      width = 4,
      angle = 45,
      eraserRadius = 24,
      shape = "rectangle",
      eraseMode = "whole",
      zoom = 1,
      pan = { x: 0, y: 0 },
      draftText = "A note to remember",
      pendingImage = null,
      selection = [],
      gesture = null,
      laser = null,
      laserTimer = null;
    const styles = {
      pen: { color: "#292722", width: 4 },
      pencil: { color: "#56534d", width: 4 },
      highlighter: { color: "#e7c840", width: 30 },
      shape: { color: "#315fa8", width: 4 },
      ruler: { color: "#292722", width: 4 }
    };

    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem("mycelium-ink-tools") || "{}"); } catch { /* optional preferences */ }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    // A fresh journal (one untouched blank page, no stored paper) starts on
    // college ruled, or on the paper last chosen on this account once that
    // preference loads. Journals with saved ink keep their paper. The stored
    // format's implicit default stays dotted, so older dotted journals are unchanged.
    const DEFAULT_PAPER = "college-ruled";
    let paperTouched = false;
    function rememberPaper() {
      if (readOnly) return;
      paperTouched = true;
      const page = activePage();
      savePaperPreference({ paper: page.paper, paperSettings: clone(page.paperSettings) });
    }
    const blank = () => !paperTouched && pages.length === 1 && !pages[0].strokes.length && !pages[0].objects.length;
    if (!readOnly && blank() && pages[0].paper === "dotted" && !pages[0].paperSettings) {
      pages[0].paper = DEFAULT_PAPER;
      loadPaperPreference().then((saved) => {
        if (disposed || !saved || !blank()) return;
        try {
          if (saved.paperSettings) pages[0].paperSettings = InkStrokes.normalizePaper(saved.paperSettings);
          else if (JournalNotebook.PAPER_TYPES.some((type) => type.id === saved.paper)) pages[0].paper = saved.paper;
          else return;
          paint();
        } catch { /* keep the default paper */ }
      });
    }
    function writing() { return ["pen", "pencil", "highlighter"].includes(tool); }
    function rememberTool() {
      if (!writing()) return;
      preferences[strokeKind()] = { color, size:width, angle };
      try { localStorage.setItem("mycelium-ink-tools", JSON.stringify(preferences)); } catch { /* ink remains editable */ }
    }
    function restoreTool() {
      const saved = preferences[strokeKind()] || {}, spec = InkStrokes.toolSpec(strokeKind());
      if (/^#[a-f0-9]{6}$/i.test(saved.color)) color = saved.color;
      width = Math.max(0.6, Math.min(48, Number(saved.size) || spec.sizes?.[1] || width));
      angle = Math.max(0, Math.min(170, Number.isFinite(saved.angle) ? saved.angle : 45));
    }
    // Track edits made while full screen so minimize autosaves only real changes.
    function onChange() {
      if (full) full.changed = true;
      notifyChange();
    }
    const undo = [],
      redo = [];
    // Full-screen bar: hidden inline, one slim row (two on phones) in full screen.
    const fsTools = ["pen", "pencil", "highlighter", "eraser", "lasso", "shape", "text", "image", "elements"];
    const fsGlyph = { ...glyphs, pen: "✒" };
    const fsBar = `<div class="jsk-fsbar" role="toolbar" aria-label="Sketchbook tools">
      <div class="jsk-fs-group jsk-fs-pages">
        <button type="button" data-fs-prev aria-label="Previous page">‹</button><span class="jsk-fs-page" data-fs-page></span><button type="button" data-fs-next aria-label="Next page">›</button><button type="button" data-fs-add aria-label="Add page" ${readOnly ? "hidden" : ""}>+</button>
      </div>
      <div class="jsk-fs-group jsk-fs-tools" ${readOnly ? "hidden" : ""}>
        ${fsTools.map(key => `<button type="button" data-fs-tool="${key}" aria-pressed="false" aria-label="${toolInfo[key][1]}" title="${toolInfo[key][1]}">${fsGlyph[key] || "◇"}</button>`).join("")}
        <span class="jsk-fs-group" data-fs-ink><span class="jsk-fs-sep" aria-hidden="true"></span>
          ${["#292722", "#315fa8", "#ba5268", "#43896e", "#e7c840"].map(c => `<button type="button" class="jsk-fs-swatch" data-fs-color="${c}" aria-pressed="false" aria-label="Ink color ${c}" style="--swatch:${c}"></button>`).join("")}
          <input type="color" data-fs-custom aria-label="Custom ink color">
          ${[0, 1, 2].map(n => `<button type="button" class="jsk-fs-width" data-fs-width="${n}" aria-pressed="false"><span style="width:${4 + n * 4}px;height:${4 + n * 4}px"></span></button>`).join("")}
        </span>
      </div>
      <div class="jsk-fs-group jsk-fs-actions">
        <button type="button" data-fs-undo aria-label="Undo drawing" ${readOnly ? "hidden" : ""}>↶</button><button type="button" data-fs-redo aria-label="Redo drawing" ${readOnly ? "hidden" : ""}>↷</button><button type="button" data-fs-more aria-label="More options">⋯</button><button type="button" data-fs-hide aria-label="Hide tools" title="Hide tools">⌃</button><button type="button" class="jsk-minimize" data-fs-minimize aria-label="Minimize sketchbook">Minimize</button>
      </div>
    </div>
    <div class="jsk-fs-float"><button type="button" data-fs-show aria-label="Show tools">⌄ Tools</button><button type="button" data-fs-minimize aria-label="Minimize sketchbook">Minimize</button></div>`;
    stage.innerHTML = fsBar + `<div class="jsk-menu" role="group" aria-label="Sketchbook menu">
      <button type="button" class="jsk-collapse" data-collapse data-notebook-toggle aria-expanded="false" aria-controls="${panelId}">Sketchbook <span data-chevron aria-hidden="true">›</span></button>
      <button type="button" class="jsk-fullscreen-button" data-expand aria-haspopup="dialog" aria-label="Open sketchbook full screen"><span aria-hidden="true">⤢</span> Full screen</button>
      <label data-paper-label>Paper <select data-paper data-template aria-label="Paper for this page" ${readOnly ? "disabled" : ""}>${JournalNotebook.PAPER_TYPES.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}<optgroup label="Ink paper library">${InkStrokes.PAPERS.map(p => `<option value="ink:${p.id}">${p.label}</option>`).join("")}</optgroup></select></label>
      <button type="button" data-paper-settings ${readOnly ? "hidden" : ""}>Paper options</button>
      <button type="button" data-finger aria-pressed="false" ${readOnly ? "hidden" : ""}>Finger draw: off</button>
      <button type="button" data-export>Export drawing</button>
      <button type="button" data-import ${readOnly ? "hidden" : ""}>Import drawing</button>
      <span class="jsk-page-label" data-page-label></span><span class="jsk-spacer"></span><button type="button" data-undo aria-label="Undo drawing" ${readOnly ? "hidden" : ""}>↶</button><button type="button" data-redo aria-label="Redo drawing" ${readOnly ? "hidden" : ""}>↷</button></div>
      <div data-sketch class="journal-drawer-content" id="${panelId}" hidden>
        <div class="jsk-toolbox" role="group" aria-label="Drawing tools"></div><div class="jsk-context" data-context></div>
        <div class="jsk-popup" data-popup hidden><div class="jsk-popup-head"><strong data-popup-title></strong><button type="button" data-close-popup aria-label="Close tool options">Close</button></div><div class="jsk-popup-content"></div></div>
        <div class="jsk-selection-actions" data-selection hidden><button type="button" data-select-action="duplicate">Duplicate</button><button type="button" data-select-action="delete">Delete</button><button type="button" data-select-action="recolor">Recolor</button><button type="button" disabled title="Requires a handwriting-recognition service">Convert handwriting</button></div>
        <div class="jsk-gallery journal-page-gallery" aria-label="Drawing page gallery">
          <button type="button" data-neighbor="-1" class="jsk-peek jsk-peek-prev" aria-label="Previous drawing page"><canvas width="1000" height="1200" aria-hidden="true"></canvas></button>
          <div class="jsk-paper journal-paper journal-current-paper" data-hand="true"><canvas data-canvas data-drawing width="1000" height="1200" ${readOnly ? 'role="img"' : 'tabindex="0"'} aria-label="Hand drawing page"></canvas><span class="jsk-canvas-text" data-canvas-hint>Swipe to turn pages</span></div>
          <button type="button" data-neighbor="1" class="jsk-peek jsk-peek-next" aria-label="Next drawing page"><canvas width="1000" height="1200" aria-hidden="true"></canvas></button>
        </div>
        <div class="jsk-pages journal-page-turn"><button type="button" class="jsk-previous" data-previous aria-label="Previous drawing page">←</button><span data-dots class="jsk-pages journal-page-dots" role="group" aria-label="Drawing pages"></span><span data-page-status class="jsk-page-label" role="status" aria-live="polite"></span><button type="button" class="jsk-next" data-next aria-label="Next drawing page">→</button><button type="button" data-add-page data-add ${readOnly ? "hidden" : ""}>+ Page</button></div>
      </div>
      <input type="file" data-ink-file accept="application/json,.json" hidden>
      <input type="file" data-image-file accept="image/*" hidden>
      <p class="jsk-status" role="status" aria-live="polite"></p>`;

    const q = (selector) => stage.querySelector(selector),
      canvas = q("[data-canvas]"),
      ctx = canvas.getContext("2d");

    // Paper/committed ink stays cached while only the current stroke changes.
    const committed = document.createElement("canvas"), prefix = document.createElement("canvas");
    const live = document.createElement("canvas");
    for (const layer of [committed, prefix, live]) { layer.width = W; layer.height = H; }
    live.className = "jsk-live";
    live.setAttribute("aria-hidden", "true");
    canvas.after(live);
    const committedCtx = committed.getContext("2d");
    const renderer = InkStrokes.createLiveRenderer(live, prefix);
    const paperBox = q(".jsk-paper");

    // Fit the page inside its box without stretching, and back every layer with
    // device pixels. Drawing code stays in page units through one transform.
    // Strokes are vector data, so a resize only re-renders; nothing is lost.
    function layout() {
      if (disposed) return;
      const boxW = paperBox.clientWidth, boxH = paperBox.clientHeight;
      if (!boxW || !boxH) return;
      // A small inset keeps the page edge and shadow inside the clipped box.
      const inset = 4;
      const fit = Math.max(0.01, Math.min((boxW - inset * 2) / W, (boxH - inset * 2) / H));
      const cssW = W * fit, cssH = H * fit;
      // Cap each of the four layers near 6 MP so a page-filling canvas stays within
      // iOS Safari's page-wide canvas memory budget.
      const dpr = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(6e6 / Math.max(1, cssW * cssH)));
      for (const layer of [canvas, live]) {
        layer.style.width = `${cssW}px`;
        layer.style.height = `${cssH}px`;
        layer.style.left = `${(boxW - cssW) / 2}px`;
        layer.style.top = `${(boxH - cssH) / 2}px`;
      }
      // Keep the hint on the page itself, not across the empty box.
      const hint = q("[data-canvas-hint]"), sideGap = (boxW - cssW) / 2 + 8;
      hint.style.left = hint.style.right = `${sideGap}px`;
      hint.style.bottom = `${(boxH - cssH) / 2 + 8}px`;
      const pxW = Math.max(1, Math.round(cssW * dpr)), pxH = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width === pxW && canvas.height === pxH) return;
      for (const layer of [canvas, live, committed, prefix]) { layer.width = pxW; layer.height = pxH; }
      for (const layer of [canvas, live, committed, prefix])
        layer.getContext("2d").setTransform(pxW / W, 0, 0, pxH / H, 0, 0);
      paint();
      if (gesture?.stroke) renderer.draw(gesture.stroke);
    }
    const resizer = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout()) : null;
    resizer?.observe(paperBox);
    // Browser zoom and moving to another display change devicePixelRatio.
    window.addEventListener("resize", layout);


    let statusTimer = null;
    function status(text) {
      if (disposed) return;
      q(".jsk-status").textContent = text;
      // Full screen shows status as a brief pill over the page.
      clearTimeout(statusTimer);
      if (stage.classList.contains("is-fullscreen"))
        statusTimer = setTimeout(() => { if (!disposed) q(".jsk-status").textContent = ""; }, 2500);
    }
    function activePage() {
      return pages[index];
    }
    function checkpoint(before) {
      if (JSON.stringify(before) === JSON.stringify(activePage())) return;
      undo[index] ||= [];
      redo[index] = [];
      undo[index].push(before);
      if (undo[index].length > 30) undo[index].shift();
      onChange();
    }
    function edit(operation) {
      if (readOnly) return;
      const before = clone(activePage());
      operation();
      checkpoint(before);
      paint();
    }
    function setOpen(value) {
      open = value;
      stage.classList.toggle("is-open", open);
      q("[data-sketch]").hidden = !open;
      q("[data-collapse]").setAttribute("aria-expanded", String(open));
      q("[data-chevron]").textContent = open ? "⌄" : "›";
      if (!open) q("[data-popup]").hidden = true;
      paint();
    }
    q("[data-collapse]").onclick = () => setOpen(!open);

    // ── Full screen ──
    // The same stage moves into DCC's shared blocking overlay (core-ui.js), so
    // the canvas and its in-memory pages are never remounted. Every dismissal
    // (button, Escape, Back) routes through minimize(); a backdrop click does not.
    let full = null;
    const prefersMotion = () => !window.DCC?.reducedMotion?.();
    function clipTo(rect) {
      const top = Math.max(0, rect.top), left = Math.max(0, rect.left);
      const right = Math.max(0, window.innerWidth - rect.right), bottom = Math.max(0, window.innerHeight - rect.bottom);
      return `inset(${top}px ${right}px ${bottom}px ${left}px round 14px)`;
    }
    const FULL_CLIP = "inset(0px 0px 0px 0px round 0px)";
    function restoreInline() {
      if (!full || full.restored) return;
      full.restored = true;
      full.placeholder.replaceWith(stage);
      stage.classList.remove("is-fullscreen", "tools-hidden");
      document.documentElement.style.overflow = full.rootOverflow;
      document.body.style.overflow = full.bodyOverflow;
    }
    function enterFullscreen() {
      if (full || disposed) return;
      if (!window.DCC?.overlay) { setOpen(true); return; }
      finishPending();
      const from = stage.getBoundingClientRect();
      const placeholder = document.createElement("div");
      placeholder.className = "jsk-placeholder";
      placeholder.style.height = `${from.height}px`;
      stage.before(placeholder);
      const card = q("[data-expand]");
      const token = `${panelId}-${Date.now()}`;
      full = { placeholder, token, changed: false, restored: false, closing: false,
        rootOverflow: document.documentElement.style.overflow, bodyOverflow: document.body.style.overflow };
      const session = full;
      stage.classList.add("is-fullscreen");
      full.handle = window.DCC.overlay.open({
        kind: "modal", title: "Sketchbook", body: stage, anchor: card,
        returnFocus: () => q("[data-expand]"),
        canClose(reason) {
          if (reason === "minimize") return true;
          // Another blocking overlay is replacing this one: keep the stage.
          if (reason === "replaced") { if (full === session) { restoreInline(); full = null; } return true; }
          if (reason !== "backdrop") minimize(reason);
          return false;
        }
      });
      const { overlay, el } = full.handle;
      overlay.classList.add("jsk-overlay");
      // The sketchbook bar carries its own Minimize; the shared header is hidden.
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      history.pushState(Object.assign({}, history.state, { jskSketch: token }), "");
      setOpen(true);
      // Full screen is for writing: start with the pen, like a notes app.
      if (!readOnly && tool === "hand") choose("pen");
      syncBar();
      if (prefersMotion() && el.animate)
        el.animate([{ clipPath: clipTo(from) }, { clipPath: FULL_CLIP }], { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
    async function minimize(reason = "minimize") {
      if (!full || full.closing) return;
      const session = full;
      session.closing = true;
      finishPending();
      if (session.changed) {
        session.changed = false;
        try { onMinimize(); } catch (error) { status(error.message || "Autosave failed. Your drawing is still open."); }
      }
      const { el } = session.handle;
      if (prefersMotion() && el.animate) {
        const to = clipTo(session.placeholder.getBoundingClientRect());
        await el.animate([{ clipPath: FULL_CLIP, opacity: 1 }, { clipPath: to, opacity: 1, offset: 0.85 }, { clipPath: to, opacity: 0 }],
          { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }).finished.catch(() => {});
      }
      restoreInline();
      full = null;
      session.handle.close("minimize");
      // Drop the history entry this open pushed, unless Back already did.
      if (reason !== "back" && history.state?.jskSketch === session.token) history.back();
    }
    q("[data-expand]").onclick = enterFullscreen;
    function onPopState() {
      if (full && history.state?.jskSketch !== full.token) minimize("back");
    }
    // Window capture runs before document listeners, including the journal
    // editor's own Escape handler, so Escape only minimizes the sketchbook.
    function onEscape(event) {
      if (!full || event.key !== "Escape" || window.DCC?.overlay?.layerAboveOpen?.()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!q("[data-popup]").hidden) q("[data-popup]").hidden = true;
      else minimize("escape");
    }
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onEscape, true);

    // ── Full-screen bar ──
    function widthPresets() {
      return (writing() && InkStrokes.toolSpec(strokeKind()).sizes) || [2, 4, 8];
    }
    function syncBar() {
      const bar = q(".jsk-fsbar");
      if (!bar) return;
      bar.querySelectorAll("[data-fs-tool]").forEach(button =>
        button.setAttribute("aria-pressed", String(button.dataset.fsTool === tool)));
      q("[data-fs-ink]").hidden = !(writing() || tool === "shape" || tool === "ruler");
      bar.querySelectorAll("[data-fs-color]").forEach(button =>
        button.setAttribute("aria-pressed", String(button.dataset.fsColor.toLowerCase() === String(color).toLowerCase())));
      q("[data-fs-custom]").value = /^#[a-f0-9]{6}$/i.test(color) ? color : "#292722";
      const sizes = widthPresets();
      bar.querySelectorAll("[data-fs-width]").forEach((button, n) => {
        button.setAttribute("aria-label", `Stroke width ${sizes[n]}`);
        button.setAttribute("aria-pressed", String(Math.abs(width - sizes[n]) < 0.01));
      });
      q("[data-fs-page]").textContent = `${index + 1} / ${pages.length}`;
      q("[data-fs-prev]").disabled = index === 0;
      q("[data-fs-next]").disabled = index === pages.length - 1;
      q("[data-fs-undo]").disabled = !undo[index]?.length;
      q("[data-fs-redo]").disabled = !redo[index]?.length;
    }
    function setInk(next) {
      if (next.color) color = next.color;
      if (next.width) width = next.width;
      if (styles[tool]) styles[tool] = { color, width };
      rememberTool();
      syncBar();
    }
    q(".jsk-fsbar").querySelectorAll("[data-fs-tool]").forEach(button => (button.onclick = () => {
      const target = button.dataset.fsTool;
      if (target === "text") showText();
      else if (target === "elements") showElements();
      else if (target === "image") choose("image");
      else if (target === tool) showToolOptions(target);
      else choose(target);
      syncBar();
    }));
    stage.querySelectorAll("[data-fs-color]").forEach(button => (button.onclick = () => setInk({ color: button.dataset.fsColor })));
    q("[data-fs-custom]").oninput = event => setInk({ color: event.target.value });
    stage.querySelectorAll("[data-fs-width]").forEach((button, n) => (button.onclick = () => setInk({ width: widthPresets()[n] })));
    q("[data-fs-prev]").onclick = () => turn(index - 1);
    q("[data-fs-next]").onclick = () => turn(index + 1);
    q("[data-fs-add]").onclick = () => q("[data-add-page]").click();
    q("[data-fs-undo]").onclick = () => q("[data-undo]").click();
    q("[data-fs-redo]").onclick = () => q("[data-redo]").click();
    q("[data-fs-more]").onclick = () => showMore();
    q("[data-fs-hide]").onclick = () => { stage.classList.add("tools-hidden"); q("[data-popup]").hidden = true; q("[data-fs-show]").focus(); };
    q("[data-fs-show]").onclick = () => { stage.classList.remove("tools-hidden"); q("[data-fs-hide]").focus(); };
    stage.querySelectorAll("[data-fs-minimize]").forEach(button => (button.onclick = () => minimize("close-button")));
    function showMore() {
      popup("More", content => {
        const label = document.createElement("label");
        label.textContent = "Paper ";
        const select = q("[data-paper]").cloneNode(true);
        select.removeAttribute("data-paper");
        select.removeAttribute("data-template");
        select.value = q("[data-paper]").value;
        select.onchange = () => {
          const real = q("[data-paper]");
          real.value = select.value;
          real.dispatchEvent(new Event("change"));
        };
        label.append(select);
        content.append(label);
        const finger = input.state.fingerDraw === "on";
        const items = [
          ["Paper options", () => q("[data-paper-settings]").click(), !readOnly],
          [`Finger draw: ${finger ? "on" : "off"}`, () => q("[data-finger]").click(), !readOnly],
          ["Export drawing", () => q("[data-export]").click(), true],
          ["Import drawing", () => q("[data-import]").click(), !readOnly],
          ["Hand", () => choose("hand"), !readOnly],
          ["Zoom", () => showZoom(), true],
          ["Sticky note", () => showText(true), !readOnly],
          ["Tape", () => choose("tape"), !readOnly],
          ["Ruler", () => choose("ruler"), !readOnly],
          ["Laser", () => choose("laser"), !readOnly]
        ];
        for (const [text, action, shown] of items) {
          if (!shown) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = text;
          button.onclick = () => { q("[data-popup]").hidden = true; action(); syncBar(); };
          content.append(button);
        }
      });
    }
    // The shared pointer input blocks native touch scrolling over the page, so
    // full screen scrolls it here: fingers scroll unless finger drawing is on,
    // two fingers always scroll, and a stylus never does.
    let touchScroll = null;
    const averageY = touches => [...touches].reduce((sum, t) => sum + t.clientY, 0) / touches.length;
    paperBox.addEventListener("touchstart", event => {
      touchScroll = null;
      if (!full) return;
      const touches = [...event.touches];
      const penActive = () => input.state.activePointerType === "pen";
      if (touches.some(t => t.touchType === "stylus") || penActive()) return;
      const fingersDraw = input.state.fingerDraw === "on" || (input.state.fingerDraw === "auto" && !input.state.penSeen);
      if (touches.length >= 2 || !fingersDraw)
        touchScroll = { y: averageY(event.touches), top: q(".jsk-gallery").scrollTop };
    }, { passive: true });
    paperBox.addEventListener("touchmove", event => {
      // A pen stroke started on this contact (pen pointer events arrive first).
      if (input.state.activePointerType === "pen") touchScroll = null;
      if (touchScroll && full) q(".jsk-gallery").scrollTop = touchScroll.top - (averageY(event.touches) - touchScroll.y);
    }, { passive: true });
    paperBox.addEventListener("touchend", event => { if (!event.touches.length) touchScroll = null; }, { passive: true });
    function iconButton(key, labelOverride) {
      const info = toolInfo[key];
      return `<button type="button" data-tool="${key}" aria-pressed="false" data-tooltip="${info[1]}"><span class="jsk-icon" aria-hidden="true">${glyphs[key] || "◇"}</span><span>${labelOverride || info[1]}</span></button>`;
    }
    const goodKeys = ["lasso", "pen", "eraser", "text", "shape", "image", "elements"];
    function paintTools() {
      if (readOnly) {
        q(".jsk-toolbox").hidden = true;
        return;
      }
      const keys = goodKeys;
      const visible = keys;
      q(".jsk-toolbox").innerHTML =
        visible.map((key) => iconButton(key, key === "pen" ? "Writing" : null)).join("") +
        `<button type="button" data-more><span class="jsk-icon" aria-hidden="true">⋯</span><span>Accessories</span></button>`;
      q("[data-more]").onclick = () => showExtras();
      q(".jsk-toolbox")
        .querySelectorAll("[data-tool]")
        .forEach(
          (button) =>
            (button.onclick = () => {
              const target = button.dataset.tool;
              if (target === "text") showText();
              else if (target === tool || target === "pen") showToolOptions(target);
              else choose(target);
            })
        );

      markTool();
    }
    function markTool() {
      stage
        .querySelectorAll(".jsk-toolbox [data-tool]")
        .forEach((button) =>
          button.setAttribute(
            "aria-pressed",
            String(
              button.dataset.tool === tool ||
                (button.dataset.tool === "pen" && ["pen", "pencil", "highlighter"].includes(tool))
            )
          )
        );
      if (q("[data-pin-style]"))
        q("[data-pin-style]").disabled = !["pen", "pencil", "highlighter", "eraser"].includes(tool);
      q(".jsk-paper").dataset.hand = String(tool === "hand");
      canvas.style.cursor = tool === "hand" ? "grab" : tool === "text" ? "text" : "crosshair";
      q("[data-canvas-hint]").textContent =
        tool === "hand"
          ? zoom > 1
            ? "Drag to pan; tap tape to reveal"
            : "Swipe to turn pages · tap tape to reveal"
          : tool === "lasso"
            ? "Drag a selection, then drag it to move"
            : tool === "image"
              ? "Choose an image, then tap to place"
              : tool === "text" || tool === "sticky"
                ? "Tap the paper to place your text"
                : tool === "laser"
                  ? "Temporary pointer · fades automatically"
                  : `${toolInfo[tool]?.[1] || "Pen"} active`;
    }
    function choose(next) {
      if (readOnly) return;
      if (["image", "elements", "zoom"].includes(next)) {
        if (next === "image") {
          q("[data-image-file]").click();
          return;
        }
        if (next === "elements") {
          showElements();
          return;
        }
        showZoom();
        return;
      }
      if (next === "text") {
        showText();
        return;
      }
      rememberTool();
      if (styles[tool]) styles[tool] = { color, width };
      tool = next;
      if (styles[next]) {
        color = styles[next].color;
        width = styles[next].width;
      }
      if (writing()) restoreTool();
      setOpen(true);
      markTool();
      paintContext();
      status(`${toolInfo[next]?.[1] || next} selected.`);
      paint();
    }
    function palette(container) {
      container.innerHTML +=
        ["#292722", "#315fa8", "#ba5268", "#43896e", "#e7c840"]
          .map(
            (c) =>
              `<button type="button" class="jsk-color" data-color="${c}" aria-label="Ink color ${c}" style="--swatch:${c}"><span></span></button>`
          )
          .join("") + `<label>Color <input type="color" value="${color}" aria-label="Custom ink color"></label>`;
      container.querySelectorAll("[data-color]").forEach(
        (button) =>
          (button.onclick = () => {
            color = button.dataset.color;
            container.querySelector("input[type=color]").value = color;
          })
      );
      container.querySelector("input[type=color]").oninput = (event) => {
        color = event.target.value;
      };
    }
    function settings(container) {
      container.replaceChildren();
      const title = document.createElement("strong");
      title.textContent = toolInfo[tool]?.[1] || "Writing";
      container.append(title);
      if (["pen", "pencil", "highlighter"].includes(tool)) {
        container.innerHTML +=
          '<label>Tool <select data-writing><option value="pen">Pen</option><option value="pencil">Pencil</option><option value="highlighter">Highlighter</option></select></label>';
        if (tool === "pen")
          container.innerHTML +=
            '<label>Style <select data-pen-style><option value="fineliner">Felt / fineliner</option><option value="fountain">Fountain</option><option value="brush">Brush</option><option value="ballpoint">Ballpoint</option><option value="mechanical">Mechanical pencil</option><option value="marker">Marker</option><option value="calligraphy">Calligraphy</option></select></label>';
        palette(container);
        container.innerHTML +=
          `<label>Width <input data-width type="range" min="0.6" max="48" step="0.2" aria-label="Stroke width"><output data-width-value>${width}</output></label>${InkStrokes.toolSpec(strokeKind()).nib ? '<label>Nib angle <input data-angle type="range" min="0" max="170" step="5" aria-label="Nib angle"></label>' : ''}`;
        const type = container.querySelector("[data-writing]");
        if (type) {
          type.value = tool;
          type.onchange = (event) => {
            choose(event.target.value);
          };
        }
        const pen = container.querySelector("[data-pen-style]");
        if (pen) {
          pen.value = penType;
          pen.onchange = (event) => {
            rememberTool();
            penType = event.target.value;
            restoreTool();
            paintContext();
          };
        }
        container.querySelector("[data-width]").value = String(width);
        container.querySelector("[data-width]").onchange = (event) => {
          width = Number(event.target.value);
          container.querySelector("[data-width-value]").textContent = width;
          rememberTool();
        };
        const nib = container.querySelector("[data-angle]");
        if (nib) { nib.value = angle; nib.oninput = event => { angle = Number(event.target.value); rememberTool(); }; }
        // innerHTML additions replace descendants; bind palette after all fields exist.
        container.querySelectorAll("[data-color]").forEach(
          (button) =>
            (button.onclick = () => {
              color = button.dataset.color;
              container.querySelector("input[type=color]").value = color;
              rememberTool();
            })
        );
        container.querySelector("input[type=color]").oninput = (event) => {
          color = event.target.value;
          rememberTool();
        };
      } else if (tool === "eraser") {
        container.innerHTML +=
          '<label>Erase <select data-erase-mode><option value="whole">Whole stroke</option><option value="partial">Partial stroke</option></select></label>';
        container.innerHTML += '<label>Radius <input data-radius type="range" min="4" max="100" step="1" aria-label="Eraser radius"></label>';
        container.querySelector("[data-radius]").value = eraserRadius;
        container.querySelector("[data-radius]").oninput = event => { eraserRadius = Number(event.target.value); };
        container.querySelector("select").value = eraseMode;
        container.querySelector("select").onchange = (event) => {
          eraseMode = event.target.value;
        };
      } else if (tool === "shape" || tool === "ruler") {
        container.innerHTML +=
          '<label>Shape <select data-shape><option value="line">Line</option><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="arrow">Arrow</option></select></label>';
        palette(container);
        const select = container.querySelector("[data-shape]");
        select.value = tool === "ruler" ? "line" : shape;
        select.disabled = tool === "ruler";
        select.onchange = (event) => {
          shape = event.target.value;
        };
      } else if (tool === "lasso")
        container.innerHTML +=
          '<span class="jsk-page-label">Rectangle selection · drag selected content to move</span>';
      else if (tool === "laser")
        container.innerHTML +=
          '<span class="jsk-page-label">Fades after 0.8 seconds · excluded from saved pages</span>';
      else if (tool === "tape")
        container.innerHTML += '<span class="jsk-page-label">Drag a cover strip · tap it with Hand to reveal</span>';
      else if (tool === "image")
        container.innerHTML += '<span class="jsk-page-label">Tap the paper to place the selected image</span>';
      else if (tool === "text" || tool === "sticky")
        container.innerHTML += '<span class="jsk-page-label">Tap the paper to place your text</span>';
      else container.innerHTML += '<span class="jsk-page-label">Use Hand to browse or pan a zoomed page.</span>';
    }
    function paintContext() {
      if (readOnly) {
        q("[data-context]").hidden = true;
        return;
      }
      const context = q("[data-context]");
      context.hidden = false;
      settings(context);
    }
    function popup(title, draw) {
      q("[data-popup]").hidden = false;
      q("[data-popup-title]").textContent = title;
      const content = q(".jsk-popup-content");
      content.replaceChildren();
      draw(content);
    }
    q("[data-close-popup]").onclick = () => {
      q("[data-popup]").hidden = true;
    };
    function showToolOptions(next) {
      if (full) {
        if (next !== tool) choose(next);
        popup(toolInfo[tool]?.[1] || "Tool options", settings);
        return;
      }
      if (next !== tool) choose(next);
      tool = next;
      setOpen(true);
      markTool();
      {
        paintContext();
        if (next === "pen")
          popup("Writing tools", (content) => {
            ["pen", "pencil", "highlighter"].forEach((key) => {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = toolInfo[key][1];
              button.onclick = () => {
                q("[data-popup]").hidden = true;
                choose(key);
              };
              content.append(button);
            });
          });
      }
      paint();
    }
    function showText(sticky = false) {
      setOpen(true);
      popup(sticky ? "Sticky note" : "Text box", (content) => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = draftText;
        input.setAttribute("aria-label", "Text to place");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Place on page";
        button.onclick = () => {
          draftText = (input.value || "Note").slice(0, 2000);
          tool = sticky ? "sticky" : "text";
          color = "#292722";
          q("[data-popup]").hidden = true;
          markTool();
          paintContext();
          status("Tap anywhere on the paper to place your text.");
        };
        content.append(input, button);
        input.focus();
      });
    }
    function showElements() {
      setOpen(true);
      popup("Elements", (content) => {
        [
          ["star", "Star"],
          ["checkbox", "Checkbox"],
          ["sticky", "Sticky note"]
        ].forEach(([kind, label]) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.onclick = () => {
            if (kind === "sticky") {
              showText(true);
              return;
            }
            edit(() => activePage().objects.push({ kind, x: 360, y: 350, w: 130, h: 130, color }));
            q("[data-popup]").hidden = true;
          };
          content.append(button);
        });
      });
    }
    function showZoom() {
      setOpen(true);
      popup("Zoom", (content) => {
        [1, 1.5, 2].forEach((value) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = Math.round(value * 100) + "%";
          button.onclick = () => {
            zoom = value;
            pan = { x: 0, y: 0 };
            tool = "hand";
            markTool();
            paintContext();
            transform();
            status(`Zoom ${Math.round(value * 100)}%. Drag with Hand to pan.`);
          };
          content.append(button);
        });
      });
    }
    function showExtras() {
      setOpen(true);
      popup("Accessories", (content) => {
        [
          "hand",
          "pencil",
          "highlighter",
          "shape",
          "image",
          "elements",
          "sticky",
          "zoom",
          "tape",
          "ruler",
          "laser"
        ].forEach((key) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = toolInfo[key][1];
          button.onclick = () => {
            q("[data-popup]").hidden = true;
            if (key === "sticky") showText(true);
            else if (key === "shape") showToolOptions(key);
            else choose(key);
          };
          content.append(button);
        });
        const integration = document.createElement("div");
        integration.className = "jsk-integration";
        integration.innerHTML =
          '<button type="button" disabled>Audio recording / replay</button> <button type="button" disabled>Handwriting conversion</button>';
        content.append(integration);
      });
    }
    function transform() {
      for (const layer of [canvas, live])
        layer.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
    }
    function objectBounds(object) {
      return object.kind === "shape"
        ? InkShapes.bounds(object)
        : { x: object.x, y: object.y, w: object.w || 260, h: object.h || 90 };
    }
    function drawObjects(context, objects) {
      for (const object of objects) {
        context.save();
        context.fillStyle = object.color || "#292722";
        context.strokeStyle = object.color || "#292722";
        context.lineWidth = 3;
        if (object.kind === "shape") InkShapes.draw(context, object);
        else if (object.kind === "image") {
          const match = /^!\[Sketchbook image\]\(media:sha256:([a-f0-9]{64})\)$/.exec(object.media || "");
          if (match) {
            let image = images.get(match[1]);
            if (!image) {
              image = new Image();
              images.set(match[1], image);
              image.onload = () => {
                if (!disposed) paint();
              };
              image.onerror = () => status("An image could not be loaded. Your saved reference is preserved.");
              image.src = "/api/vault/media/" + match[1] + "?variant=auto";
            }
            if (image.complete && image.naturalWidth) context.drawImage(image, object.x, object.y, object.w, object.h);
          }
        } else if (object.kind === "text" || object.kind === "sticky") {
          if (object.kind === "sticky") {
            context.fillStyle = "#efdaa0";
            context.fillRect(object.x, object.y, object.w, object.h);
            context.fillStyle = "#292722";
          }
          const rect = canvas.getBoundingClientRect();
          const textScale = rect.width && rect.height ? rect.width / W / (rect.height / H) : 2;
          context.translate(object.x + 10, object.y + 10);
          context.scale(1, textScale);
          context.font = "24px sans-serif";
          const words = String(object.text || "").split(" ");
          let line = "",
            y = 28;
          for (const word of words) {
            if (context.measureText(line + word).width > object.w - 20 && line) {
              context.fillText(line, 0, y);
              line = "";
              y += 32;
            }
            line += word + " ";
          }
          context.fillText(line, 0, y);
        } else if (object.kind === "tape") {
          context.fillStyle = object.revealed ? "#d9bc6b22" : "#e6cd89";
          context.fillRect(object.x, object.y, object.w, object.h);
          if (!object.revealed) {
            context.fillStyle = "#685f4e";
            context.font = "20px sans-serif";
            context.fillText("Tap with Hand to reveal", object.x + 12, object.y + Math.min(30, object.h - 4));
          }
        } else if (object.kind === "checkbox") {
          context.strokeRect(object.x, object.y, object.w, object.h);
        } else if (object.kind === "star") {
          context.beginPath();
          for (let n = 0; n < 10; n++) {
            const radius = n % 2 ? object.w * 0.22 : object.w * 0.48;
            const angle = -Math.PI / 2 + (n * Math.PI) / 5;
            const x = object.x + object.w / 2 + Math.cos(angle) * radius,
              y = object.y + object.h / 2 + Math.sin(angle) * radius;
            n ? context.lineTo(x, y) : context.moveTo(x, y);
          }
          context.closePath();
          context.stroke();
        }
        context.restore();
      }
    }
    function paintPage(context, page, objects = true) {
      context.clearRect(0, 0, W, H);
      if (page.paperSettings) InkStrokes.drawPaper(context, {w:W,h:H,paper:page.paperSettings});
      else JournalNotebook.drawPaper(context, page.paper);
      for (const stroke of page.strokes) {
        if (stroke.legacy) JournalNotebook.drawLegacy(context, [toStored(stroke)]);
        else InkStrokes.drawStroke(context, stroke);
      }
      if (objects) drawObjects(context, page.objects);
    }
    function bounds(item) {
      if (item.kind) return objectBounds(item);
      let x = Infinity,
        y = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (let n = 0; n < item.pts.length; n += 3) {
        x = Math.min(x, item.pts[n]);
        y = Math.min(y, item.pts[n + 1]);
        right = Math.max(right, item.pts[n]);
        bottom = Math.max(bottom, item.pts[n + 1]);
      }
      return { x, y, w: right - x, h: bottom - y };
    }
    function selectionBounds() {
      if (!selection.length) return null;
      const items = [...activePage().strokes, ...activePage().objects];
      const boxes = selection
        .map((n) => items[n])
        .filter(Boolean)
        .map(bounds);
      if (!boxes.length) return null;
      const x = Math.min(...boxes.map((b) => b.x)),
        y = Math.min(...boxes.map((b) => b.y));
      return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
    }
    function paint(refresh = true) {
      if (disposed) return;
      if (refresh) paintPage(committedCtx, activePage(), false);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(committed, 0, 0);
      ctx.restore();
      drawObjects(ctx, activePage().objects);
      const selected = selectionBounds();
      if (selected) {
        ctx.save();
        ctx.strokeStyle = "#0075eb";
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 8]);
        ctx.strokeRect(selected.x - 8, selected.y - 8, selected.w + 16, selected.h + 16);
        ctx.restore();
      }
      if (!readOnly && gesture?.kind === "lasso") {
        ctx.save();
        ctx.strokeStyle = "#0075eb";
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 8]);
        ctx.strokeRect(
          gesture.start.x,
          gesture.start.y,
          gesture.end.x - gesture.start.x,
          gesture.end.y - gesture.start.y
        );
        ctx.restore();
      }
      if (laser) {
        ctx.save();
        ctx.strokeStyle = "#db3f5e";
        ctx.fillStyle = "#db3f5e";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(laser.start.x, laser.start.y);
        ctx.lineTo(laser.end.x, laser.end.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(laser.end.x, laser.end.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      const pageLabel = `Page ${index + 1} / ${pages.length}`;
      q("[data-page-label]").textContent = pageLabel;
      if (q("[data-page-status]").textContent !== pageLabel) q("[data-page-status]").textContent = pageLabel;
      canvas.setAttribute("aria-label", `Hand drawing page ${index + 1} of ${pages.length}`);
      q(".journal-current-paper").dataset.paperType = activePage().paper;
      q("[data-paper]").value = activePage().paperSettings ? "ink:" + activePage().paperSettings.type : activePage().paper;
      q("[data-undo]").disabled = !undo[index]?.length;
      q("[data-redo]").disabled = !redo[index]?.length;
      q("[data-selection]").hidden = readOnly || !selection.length;
      const dots = q("[data-dots]");
      if (dots.children.length !== pages.length)
        dots.innerHTML = pages
          .map(
            (_, n) =>
              `<button type="button" class="jsk-dot" data-page="${n}" data-page-index="${n}" aria-label="Page ${n + 1}"><span></span></button>`
          )
          .join("");
      dots.querySelectorAll("button").forEach((button, n) => {
        if (n === index) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      syncBar();
      q(".jsk-previous").disabled = index === 0;
      q(".jsk-next").disabled = index === pages.length - 1;
      for (const [selector, n] of [
        [".jsk-peek-prev", index - 1],
        [".jsk-peek-next", index + 1]
      ]) {
        const button = q(selector);
        button.disabled = !pages[n];
        button.style.visibility = pages[n] ? "visible" : "hidden";
        if (refresh && pages[n]) paintPage(button.querySelector("canvas").getContext("2d"), pages[n]);
      }
    }
    function turn(target) {
      finishPending();
      clearTimeout(laserTimer);
      laser = null;
      index = Math.max(0, Math.min(pages.length - 1, target));
      if (full) q(".jsk-gallery").scrollTop = 0;
      selection = [];
      zoom = 1;
      pan = { x: 0, y: 0 };
      transform();
      paint();
    }
    q("[data-dots]").onclick = (event) => {
      const button = event.target.closest("[data-page]");
      if (button) turn(Number(button.dataset.page));
    };
    q(".jsk-previous").onclick = q(".jsk-peek-prev").onclick = () => turn(index - 1);
    q(".jsk-next").onclick = q(".jsk-peek-next").onclick = () => turn(index + 1);
    q("[data-add-page]").onclick = () => {
      if (readOnly || pages.length >= 100) return;
      pages.push({ paper: activePage().paper, paperSettings: clone(activePage().paperSettings), strokes: [], objects: [] });
      onChange();
      turn(pages.length - 1);
    };
    q("[data-paper]").onchange = (event) => {
      const paper = event.target.value;
      edit(() => {
        if (paper.startsWith("ink:")) activePage().paperSettings = InkStrokes.normalizePaper({ ...activePage().paperSettings, type:paper.slice(4) });
        else { activePage().paper = paper; activePage().paperSettings = null; }
      });
      rememberPaper();
    };
    q("[data-undo]").onclick = () => {
      if (readOnly) return;
      if (undo[index]?.length) {
        redo[index] ||= [];
        const entry = undo[index].pop();
        if (entry.addedStroke) {
          activePage().strokes.pop();
          redo[index].push(entry);
        } else {
          redo[index].push(clone(activePage()));
          pages[index] = entry;
        }
        selection = [];
        paint();
        onChange();
      }
    };
    q("[data-redo]").onclick = () => {
      if (readOnly) return;
      if (redo[index]?.length) {
        undo[index] ||= [];
        const entry = redo[index].pop();
        if (entry.addedStroke) {
          activePage().strokes.push(entry.addedStroke);
          undo[index].push(entry);
        } else {
          undo[index].push(clone(activePage()));
          pages[index] = entry;
        }
        selection = [];
        paint();
        onChange();
      }
    };
    function cleanPage(page) {
      return { paper: page.paper, paperSettings: page.paperSettings, strokes: page.strokes, objects: page.objects.map(({ image, ...object }) => object) };
    }
    function point(event) {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(W, ((event.clientX - r.left) / r.width) * W)),
        y: Math.max(0, Math.min(H, ((event.clientY - r.top) / r.height) * H)),
        p: event.pressure || 0.5
      };
    }
    function strokeKind() {
      return tool === "pencil" ? "pencil" : tool === "highlighter" ? "highlighter" : penType;
    }
    function erase(p) {
      const page = activePage();
      page.objects = page.objects.filter((object) => object.kind !== "shape" || !InkShapes.hit(object, p.x, p.y, eraserRadius));
      if (eraseMode === "whole") page.strokes = InkStrokes.eraseAt(page.strokes, p.x, p.y, eraserRadius).strokes;
      else {
        const kept = [];
        for (const stroke of page.strokes) {
          if (!InkStrokes.strokeHit(stroke, p.x, p.y, eraserRadius)) {
            kept.push(stroke);
            continue;
          }
          let run = [];
          const flush = () => {
            if (run.length >= 3) kept.push({ ...stroke, pts: run });
            run = [];
          };
          for (let n = 0; n < stroke.pts.length; n += 3) {
            const a = { x: stroke.pts[n], y: stroke.pts[n + 1], p: stroke.pts[n + 2] },
              b = n + 3 < stroke.pts.length ? { x: stroke.pts[n + 3], y: stroke.pts[n + 4], p: stroke.pts[n + 5] } : a;
            const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
            for (let k = 0; k < steps; k++) {
              const x = a.x + ((b.x - a.x) * k) / steps,
                y = a.y + ((b.y - a.y) * k) / steps;
              if (Math.hypot(x - p.x, y - p.y) < eraserRadius + stroke.size / 2) flush();
              else run.push(x, y, a.p);
            }
          }
          flush();
        }
        page.strokes = kept;
      }
    }
    function shapeRecord(a, b) {
      return InkShapes.create(tool === "ruler" ? "line" : shape, a, b, { color, size: width });
    }
    function startGesture(event) {
      if (event.pointerType === "pen" && tool === "hand") choose("pen");
      const gestureTool = event.button === 5 || event.buttons === 32 ? "eraser" : tool;
      const p = point(event);
      gesture = {
        id: event.pointerId,
        pointerType: event.pointerType,
        start: p,
        end: p,
        before: ["pen", "pencil", "highlighter"].includes(gestureTool) ? null : clone(cleanPage(activePage())),
        client: { x: event.clientX, y: event.clientY },
        pan: { ...pan },
        kind: gestureTool
      };
      if (["pen", "pencil", "highlighter"].includes(gestureTool)) {
        const stroke = InkStrokes.newStroke(strokeKind(), color, width, { v: 2, angle });
        InkStrokes.addPoint(stroke, p.x, p.y, p.p);
        gesture.stroke = stroke;
        renderer.draw(stroke);
      } else if (gestureTool === "eraser") erase(p);
      else if (tool === "shape" || tool === "ruler") {
        gesture.object = shapeRecord(p, p);
        activePage().objects.push(gesture.object);
      } else if (tool === "tape") {
        const object = { kind: "tape", x: p.x, y: p.y, w: 1, h: 1 };
        activePage().objects.push(object);
        gesture.object = object;
      } else if (tool === "text" || tool === "sticky") {
        activePage().objects.push({
          kind: tool,
          x: p.x,
          y: p.y,
          w: 300,
          h: tool === "sticky" ? 200 : 90,
          text: draftText,
          color
        });
      } else if (tool === "image" && pendingImage) {
        const imageHeight = Math.min(1200, (300 * pendingImage.height) / pendingImage.width);
        activePage().objects.push({
          kind: "image",
          x: p.x,
          y: p.y,
          w: (imageHeight * pendingImage.width) / pendingImage.height,
          h: imageHeight,
          media: pendingImage.media
        });
      } else if (tool === "lasso") {
        const box = selectionBounds();
        if (box && p.x >= box.x - 12 && p.x <= box.x + box.w + 12 && p.y >= box.y - 12 && p.y <= box.y + box.h + 12)
          gesture.kind = "move";
        else selection = [];
      } else if (tool === "laser") {
        laser = { start: p, end: p };
        clearTimeout(laserTimer);
      }
      if (!gesture.stroke) paint();
    }
    function moveGesture(event) {
      if (!gesture || event.pointerId !== gesture.id) return;
      event.preventDefault();
      const p = point(event);
      gesture.end = p;
      if (gesture.stroke) {
        const coalesced = event.getCoalescedEvents?.();
        for (const sample of coalesced?.length ? coalesced : [event]) {
          const next = point(sample);
          InkStrokes.addPoint(gesture.stroke, next.x, next.y, next.p);
        }
        renderer.draw(gesture.stroke, true);
        return;
      }
      if (gesture.kind === "eraser") erase(p);
      else if (gesture.kind === "shape" || gesture.kind === "ruler")
        Object.assign(gesture.object, shapeRecord(gesture.start, p));
      else if (gesture.kind === "tape") {
        gesture.object.x = Math.min(gesture.start.x, p.x);
        gesture.object.y = Math.min(gesture.start.y, p.y);
        gesture.object.w = Math.max(1, Math.abs(p.x - gesture.start.x));
        gesture.object.h = Math.max(1, Math.abs(p.y - gesture.start.y));
      } else if (gesture.kind === "hand" && zoom > 1) {
        pan = {
          x: gesture.pan.x + event.clientX - gesture.client.x,
          y: gesture.pan.y + event.clientY - gesture.client.y
        };
        transform();
      } else if (gesture.kind === "move") {
        const dx = p.x - gesture.start.x,
          dy = p.y - gesture.start.y,
          before = [...gesture.before.strokes, ...gesture.before.objects];
        const items = [...activePage().strokes, ...activePage().objects];
        selection.forEach((n) => {
          const item = items[n],
            original = before[n];
          if (item.kind === "shape") Object.assign(item, InkShapes.translate(original, dx, dy));
          else if (item.pts)
            item.pts = original.pts.map((value, k) => (k % 3 === 0 ? value + dx : k % 3 === 1 ? value + dy : value));
          else {
            item.x = original.x + dx;
            item.y = original.y + dy;
          }
        });
      } else if (gesture.kind === "laser") laser.end = p;
      paint();
    }
    function finish(event, cancel = false) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const g = gesture;
      gesture = null;
      if (g.stroke) {
        if (cancel) renderer.clear();
        else {
          activePage().strokes.push(g.stroke);
          undo[index] ||= [];
          undo[index].push({ addedStroke: g.stroke });
          if (undo[index].length > 30) undo[index].shift();
          redo[index] = [];
          renderer.commit(committedCtx, g.stroke);
          onChange();
        }
        paint(false);
        return;
      }
      if (cancel) {
        pages[index] = g.before;
        paint();
        return;
      }
      const p = Number.isFinite(event.clientX) ? point(event) : g.end;
      if (g.kind === "lasso") {
        const r = {
          x: Math.min(g.start.x, p.x),
          y: Math.min(g.start.y, p.y),
          right: Math.max(g.start.x, p.x),
          bottom: Math.max(g.start.y, p.y)
        };
        selection = [...activePage().strokes, ...activePage().objects]
          .map((item, n) => ({ b: bounds(item), n }))
          .filter(({ b }) => b.x <= r.right && b.x + b.w >= r.x && b.y <= r.bottom && b.y + b.h >= r.y)
          .map(({ n }) => n);
      } else if (g.kind === "hand" && zoom === 1) {
        const dx = event.clientX - g.client.x,
          dy = event.clientY - g.client.y;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(index + (dx < 0 ? 1 : -1));
        else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
          const tape = activePage().objects.find(
            (object) =>
              object.kind === "tape" &&
              p.x >= object.x &&
              p.x <= object.x + object.w &&
              p.y >= object.y &&
              p.y <= object.y + object.h
          );
          if (tape) tape.revealed = !tape.revealed;
        }
      } else if (g.kind === "laser") {
        laserTimer = setTimeout(() => {
          laser = null;
          paint();
        }, 800);
      }
      if (!["hand", "lasso", "laser"].includes(g.kind)) checkpoint(g.before);
      paint();
    }
    function finishPending() {
      if (gesture) {
        const r = canvas.getBoundingClientRect();
        input.finishActive({
          clientX: r.left + gesture.end.x / W * r.width,
          clientY: r.top + gesture.end.y / H * r.height });
      }
    }
    const input = InkCanvas.createPointerInput({ base: canvas, wrap: q(".jsk-paper"),
      fingerDraw: "off", enabled: () => !readOnly,
      onStart: startGesture, onMove: moveGesture,
      onFinish: event => finish(event), onCancel: event => finish(event, true),
      onNavigate: delta => { if (!readOnly || open) turn(index + delta); }
    });
    q("[data-finger]").onclick = () => {
      const on = input.state.fingerDraw !== "on";
      input.setFingerDraw(on ? "on" : "off");
      q("[data-finger]").textContent = `Finger draw: ${on ? "on" : "off"}`;
      q("[data-finger]").setAttribute("aria-pressed", String(on));
    };
    q("[data-paper-settings]").onclick = () => {
      if (readOnly || input.isBusy()) return;
      popup("Paper options", content => {
        const paper = InkStrokes.normalizePaper(activePage().paperSettings || {type:"dots",tint:"cream"});
        content.innerHTML = `<label>Layout <select data-layout>${InkStrokes.PAPERS.map(p => `<option value="${p.id}">${p.label}</option>`).join("")}</select></label>
          <label>Tone <select data-tone>${Object.keys(InkStrokes.TINTS).map(t => `<option>${t}</option>`).join("")}</select></label>
          <label>Spacing <input data-spacing type="number" min="4" max="12" step="1" aria-label="Paper spacing"></label>
          <label><input data-margin type="checkbox"> Ruled margin</label><button type="button" data-apply>Apply paper</button>`;
        const layout = content.querySelector("[data-layout]"), tone = content.querySelector("[data-tone]"), spacing = content.querySelector("[data-spacing]"), margin = content.querySelector("[data-margin]");
        layout.value = paper.type; tone.value = paper.tint; spacing.value = paper.spacing; margin.checked = paper.margin;
        const update = () => { const spec = InkStrokes.PAPERS.find(p => p.id === layout.value); spacing.disabled = !spec.usesSpacing; margin.disabled = !layout.value.startsWith("ruled"); };
        layout.onchange = update; update();
        content.querySelector("[data-apply]").onclick = () => {
          edit(() => { activePage().paperSettings = InkStrokes.normalizePaper({type:layout.value,tint:tone.value,spacing:Number(spacing.value),margin:margin.checked}); });
          rememberPaper();
          q("[data-popup]").hidden = true;
        };
      });
    };
    q("[data-export]").onclick = () => {
      finishPending();
      const exported = { format:"dcc-journal-drawing", v:1, markdown:JournalNotebook.pack("", pages.map(p => p.strokes.map(toStored)), pages.map(p => p.paper), pages.map(p => clone(p.objects)), pages.map(p => p.paperSettings)) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported)], {type:"application/json"}));
      const link = document.createElement("a"); link.href = url; link.download = "journal-drawing.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    q("[data-import]").onclick = () => q("[data-ink-file]").click();
    q("[data-ink-file]").onchange = async event => {
      const file = event.target.files[0]; event.target.value = "";
      if (!file || readOnly || input.isBusy()) return;
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("Drawing archive is too large.");
        const raw = JSON.parse(await file.text());
        if (disposed || input.isBusy()) throw new Error("Finish the current stroke before importing.");
        if (raw.format !== "dcc-journal-drawing" || raw.v !== 1 || typeof raw.markdown !== "string") throw new Error("Choose a journal drawing export.");
        const restored = JournalNotebook.unpack(raw.markdown);
        if (pages.length + restored.pages.length > 100) throw new Error("A journal supports up to 100 drawing pages.");
        if (disposed) return;
        pages.push(...restored.pages.map((strokes,n) => ({paper:restored.templates[n],paperSettings:restored.papers?.[n] || null,strokes:strokes.map(fromStored),objects:restored.objects[n]})));
        turn(pages.length - restored.pages.length); onChange();
        status("Imported as new pages. Existing pages are preserved.");
      } catch (error) { status(error.message); }
    };
    stage.querySelectorAll("[data-select-action]").forEach(
      (button) =>
        (button.onclick = () =>
          edit(() => {
            const all = [...activePage().strokes, ...activePage().objects],
              selected = new Set(selection);
            if (button.dataset.selectAction === "delete") {
              activePage().strokes = activePage().strokes.filter((_, n) => !selected.has(n));
              activePage().objects = activePage().objects.filter(
                (_, n) => !selected.has(n + all.length - activePage().objects.length)
              );
              selection = [];
            } else if (button.dataset.selectAction === "duplicate") {
              selection.forEach((n) => {
                const item = clone(all[n]);
                if (item.pts) {
                  item.pts = item.pts.map((v, k) => (k % 3 === 2 ? v : v + 30));
                  activePage().strokes.push(item);
                } else {
                  if (item.kind === "shape") Object.assign(item, InkShapes.translate(item, 30, 30));
                  else {
                    item.x = Math.min(3970, item.x) + 30;
                    item.y = Math.min(3970, item.y) + 30;
                  }
                  activePage().objects.push(item);
                }
              });
              selection = [];
            } else selection.forEach((n) => (all[n].color = color));
          }))
    );
    q("[data-image-file]").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file || readOnly) return;
      try {
        if (!onAttachImage) throw new Error("Open this journal in Write mode to attach an image.");
        status("Uploading image…");
        const attachment = await onAttachImage(file);
        if (disposed) return;
        if (!/^media:sha256:[a-f0-9]{64}$/.test(attachment?.ref || ""))
          throw new Error("The image upload returned an invalid reference.");
        const image = new Image();
        image.onload = () => {
          if (disposed) return;
          pendingImage = {
            width: image.naturalWidth,
            height: image.naturalHeight,
            media: "![Sketchbook image](" + attachment.ref + ")"
          };
          tool = "image";
          setOpen(true);
          markTool();
          paintContext();
          status("Tap on the paper to place the image.");
        };
        image.onerror = () => status("The uploaded image could not be displayed. Please retry.");
        image.src = "/api/vault/media/" + attachment.ref.slice(13) + "?variant=auto";
      } catch (error) {
        status(error.message);
      }
    };
    paintTools();
    paintContext();
    setOpen(false);
    layout();
    return {
      read() {
        finishPending();
        return pages.map((page) => page.strokes.map(toStored));
      },
      isBusy() { return input.isBusy(); },
      readPapers() { return pages.map(page => clone(page.paperSettings)); },
      readCommitted() { return pages.map(page => page.strokes.map(toStored)); },
      readTemplates() {
        return pages.map((page) => page.paper);
      },
      readObjects() {
        return pages.map((page) => clone(page.objects));
      },
      destroy() {
        if (full) {
          const session = full;
          restoreInline();
          full = null;
          session.handle.close("minimize");
        }
        window.removeEventListener("popstate", onPopState);
        window.removeEventListener("keydown", onEscape, true);
        disposed = true;
        clearTimeout(statusTimer);
        resizer?.disconnect();
        window.removeEventListener("resize", layout);
        clearTimeout(laserTimer);
        renderer.clear();
        input.destroy();
        for (const image of images.values()) {
          image.onload = null;
          image.onerror = null;
        }
        images.clear();
        // Safari is slow to reclaim dropped canvases; release backing stores now.
        for (const layer of [canvas, live, committed, prefix]) { layer.width = 0; layer.height = 0; }
        stage.remove();
      }
    };
  }
  window.JournalSketchbook = { mount };
})();
