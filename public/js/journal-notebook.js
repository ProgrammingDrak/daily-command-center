// Editable ink lives in the journal Markdown, so its normal save, conflict
// detection, export and access controls apply to drawings as well as text.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.JournalNotebook = api;
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  const MARKER = "\n\n<!-- dcc-journal-ink:v1\n";
  const WIDTH = 1000, HEIGHT = 1200;
  const PAPER_TYPES = Object.freeze([
    { id: "blank", label: "Blank / sketchbook" },
    { id: "college-ruled", label: "College ruled" },
    { id: "wide-ruled", label: "Wide ruled" },
    { id: "standard-ruled", label: "Standard ruled" },
    { id: "narrow-ruled", label: "Narrow ruled" },
    { id: "dotted", label: "Dotted / bullet journal" },
    { id: "graph", label: "Square grid / graph" },
    { id: "isometric", label: "Isometric grid" },
    { id: "cornell", label: "Cornell notes" },
    { id: "music", label: "Music staff" },
  ]);
  const paperName = id => PAPER_TYPES.find(type => type.id === id)?.label;
  function pageTemplates(pages, templates) {
    if (templates !== undefined && (!Array.isArray(templates) || templates.length !== pages.length || templates.some(id => !paperName(id)))) throw new Error("Invalid journal paper templates");
    return templates ? templates.slice() : pages.map(() => "dotted");
  }
  function unpack(markdown) {
    const start = markdown.lastIndexOf(MARKER);
    if (start < 0 || !markdown.endsWith("\n-->")) return { text: markdown, pages: [[]], templates: ["dotted"] };
    const data = JSON.parse(markdown.slice(start + MARKER.length, -4));
    if (!Array.isArray(data.pages) || !data.pages.length || data.pages.length > 100) throw new Error("Invalid journal drawing pages");
    for (const page of data.pages) {
      if (!Array.isArray(page)) throw new Error("Invalid journal drawing page");
      for (const stroke of page) {
        if (!/^#[a-f0-9]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.size) || stroke.size < 1 || stroke.size > 20 || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error("Invalid journal stroke");
        for (const point of stroke.points) {
          if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isFinite(n)) || point[0] < 0 || point[0] > WIDTH || point[1] < 0 || point[1] > HEIGHT) throw new Error("Invalid journal stroke point");
        }
      }
    }
    return { text: markdown.slice(0, start), pages: data.pages, templates: pageTemplates(data.pages, data.templates) };
  }
  function pack(text, pages, templates) {
    const paper = pageTemplates(pages, templates);
    const customPaper = paper.some(id => id !== "dotted");
    return pages.some(page => page.length) || pages.length > 1 || customPaper
      ? text + MARKER + JSON.stringify(customPaper ? { pages, templates: paper } : { pages }) + "\n-->" : text;
  }
  // Patterns share the ink's document coordinates, so lines stay aligned with
  // handwriting when the notebook resizes or a neighboring page is previewed.
  function drawPaper(context, template) {
    context.save();
    context.strokeStyle = "#b4a38580"; context.fillStyle = "#b4a385b0"; context.lineWidth = 1.3;
    const line = (x, y, endX, endY) => { context.moveTo(x, y); context.lineTo(endX, endY); };
    context.beginPath();
    const gap = { "college-ruled": 34, "wide-ruled": 52, "standard-ruled": 42, "narrow-ruled": 26 }[template];
    if (gap) {
      for (let y = 120; y < HEIGHT - 35; y += gap) line(30, y, WIDTH - 30, y);
      context.stroke(); context.beginPath(); context.strokeStyle = "#b76f6f70"; line(110, 45, 110, HEIGHT - 25);
    } else if (template === "dotted") {
      for (let y = 40; y < HEIGHT; y += 40) for (let x = 40; x < WIDTH; x += 40) {
        context.moveTo(x + 1.6, y); context.arc(x, y, 1.6, 0, Math.PI * 2);
      }
      context.fill(); context.beginPath();
    } else if (template === "graph") {
      for (let x = 0; x < WIDTH; x += 36) line(x, 0, x, HEIGHT);
      for (let y = 0; y < HEIGHT; y += 36) line(0, y, WIDTH, y);
    } else if (template === "isometric") {
      const offset = HEIGHT / Math.sqrt(3);
      for (let x = -offset; x < WIDTH + offset; x += 48) {
        line(x, 0, x + offset, HEIGHT); line(x, 0, x - offset, HEIGHT);
      }
      for (let y = 0; y < HEIGHT; y += 24 * Math.sqrt(3)) line(0, y, WIDTH, y);
    } else if (template === "cornell") {
      line(45, 145, WIDTH - 45, 145); line(260, 145, 260, HEIGHT - 230); line(45, HEIGHT - 230, WIDTH - 45, HEIGHT - 230);
      context.font = "22px sans-serif"; context.fillStyle = "#8a7b62";
      context.fillText("Cues", 65, 185); context.fillText("Notes", 285, 185); context.fillText("Summary", 65, HEIGHT - 185);
    } else if (template === "music") {
      for (let y = 150; y < HEIGHT - 100; y += 155) for (let n = 0; n < 5; n++) line(65, y + n * 14, WIDTH - 65, y + n * 14);
    }
    context.stroke(); context.restore();
  }
  function drawStrokes(context, strokes) {
    context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.size;
      const [first, ...rest] = stroke.points;
      if (!rest.length) {
        context.beginPath(); context.arc(first[0], first[1], stroke.size / 2, 0, Math.PI * 2); context.fill();
      } else {
        context.beginPath(); context.moveTo(...first);
        for (const point of rest) context.lineTo(...point);
        context.stroke();
      }
    }
  }
  function mount(host, pages, { readOnly = false, templates, initialPage = 0 } = {}) {
    const paper = pageTemplates(pages, templates);
    let index = Math.max(0, Math.min(pages.length - 1, Number.isInteger(initialPage) ? initialPage : 0));
    let tool = "turn", color = "#292722", size = 3;
    let active = null, pointer = null, swipe = null, before = null, frame = null;
    const undo = pages.map(() => []), redo = pages.map(() => []);
    host.classList.add("journal-notebook");
    host.innerHTML = `<details class="journal-drawer">
      <summary><span class="journal-drawer-title">Sketchbook</span><span data-notebook-summary></span><span class="journal-drawer-chevron" aria-hidden="true">›</span></summary>
      <div class="journal-drawer-content"><div class="journal-page-settings">
      ${readOnly ? '<span data-template-name></span>' : `<label>Paper for this page <select data-template aria-label="Paper for this page">${PAPER_TYPES.map(type => `<option value="${type.id}">${type.label}</option>`).join("")}</select></label>`}
      <span data-template-status></span></div>
      <div class="journal-ink-tools" role="group" aria-label="Drawing tools">
      <span class="journal-ink-label">Sketchbook</span>
      ${readOnly ? "" : `<button type="button" data-tool="pen" aria-pressed="false">Pen</button>
      <button type="button" data-tool="eraser" aria-pressed="false">Eraser</button>
      <button type="button" data-tool="turn" aria-pressed="true">Turn pages</button>
      <label>Ink <input type="color" value="#292722" aria-label="Ink color"></label>
      <label>Width <select data-pen-width aria-label="Pen width"><option value="3">Fine</option><option value="6">Medium</option><option value="12">Broad</option></select></label>
      <button type="button" data-undo>Undo</button><button type="button" data-redo>Redo</button>`}
      </div><div class="journal-page-gallery" aria-label="Drawing page gallery">
      <button type="button" class="journal-neighbor journal-neighbor-previous" data-neighbor="-1"><span class="journal-sheet journal-peek-paper"><canvas width="1000" height="1200" aria-hidden="true"></canvas></span><span class="journal-peek-label"></span></button>
      <div class="journal-paper journal-sheet journal-current-paper"><canvas data-drawing width="1000" height="1200" aria-label="Hand drawing page" ${readOnly ? 'role="img"' : 'tabindex="0"'}></canvas></div>
      <button type="button" class="journal-neighbor journal-neighbor-next" data-neighbor="1"><span class="journal-sheet journal-peek-paper"><canvas width="1000" height="1200" aria-hidden="true"></canvas></span><span class="journal-peek-label"></span></button>
      </div><div class="journal-page-dots" role="group" aria-label="Drawing pages"></div>
      <div class="journal-page-turn" aria-label="Notebook page navigation">
      <button type="button" data-previous aria-label="Previous drawing page">←</button>
      <span data-page role="status" aria-live="polite"></span>
      <button type="button" data-next aria-label="Next drawing page">→</button>
      ${readOnly ? "" : '<button type="button" data-add>+ Page</button>'}</div>
      <p class="journal-ink-hint">${readOnly ? "Swipe, tap a dot, or select a neighboring page." : "Swipe to turn. Choose Pen or Eraser to draw. Paper changes apply to this page only."}</p></div></details>`;
    const canvas = host.querySelector("[data-drawing]"), context = canvas.getContext("2d");
    const q = selector => host.querySelector(selector);
    const histories = () => { undo[index] ||= []; redo[index] ||= []; };
    function paint() {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      context.clearRect(0, 0, WIDTH, HEIGHT);
      drawPaper(context, paper[index]); drawStrokes(context, pages[index]);
      q(".journal-current-paper").dataset.paperType = paper[index];
      const dots = q(".journal-page-dots");
      if (dots.children.length !== pages.length) {
        dots.innerHTML = pages.map((_, n) => `<button type="button" data-page-index="${n}"><span></span></button>`).join("");
      }
      Array.from(dots.children).forEach((dot, n) => {
        dot.setAttribute("aria-label", `Page ${n + 1}, ${paperName(paper[n])}`);
        if (n === index) dot.setAttribute("aria-current", "page"); else dot.removeAttribute("aria-current");
      });
      q("[data-template-status]").textContent = readOnly ? `Page ${index + 1}` : `Applies to page ${index + 1} only`;
      if (readOnly) q("[data-template-name]").textContent = paperName(paper[index]);
      else q("[data-template]").value = paper[index];
      host.querySelectorAll("[data-neighbor]").forEach(neighbor => {
        const n = index + Number(neighbor.dataset.neighbor);
        neighbor.disabled = n < 0 || n >= pages.length;
        neighbor.style.visibility = neighbor.disabled ? "hidden" : "visible";
        if (neighbor.disabled) return;
        neighbor.setAttribute("aria-label", `Open page ${n + 1}, ${paperName(paper[n])}`);
        neighbor.querySelector(".journal-peek-label").textContent = `${n + 1} · ${paperName(paper[n])}`;
        const ctx = neighbor.querySelector("canvas").getContext("2d");
        ctx.clearRect(0, 0, WIDTH, HEIGHT); drawPaper(ctx, paper[n]); drawStrokes(ctx, pages[n]);
      });
      histories();
      const pageLabel = `Page ${index + 1} / ${pages.length}`;
      if (q("[data-page]").textContent !== pageLabel) q("[data-page]").textContent = pageLabel;
      q("[data-notebook-summary]").textContent = `${pageLabel} · ${paperName(paper[index])}`;
      canvas.setAttribute("aria-label", `Hand drawing page ${index + 1} of ${pages.length}`);
      q("[data-previous]").disabled = index === 0;
      q("[data-next]").disabled = index === pages.length - 1;
      if (!readOnly) {
        q("[data-undo]").disabled = !undo[index].length;
        q("[data-redo]").disabled = !redo[index].length;
        q("[data-add]").disabled = pages.length >= 100;
      }
    }
    function finish(cancel = false) {
      if (pointer === null) return;
      if (cancel && before) pages[index] = before;
      else if (before && JSON.stringify(before) !== JSON.stringify(pages[index])) {
        undo[index].push(before); if (undo[index].length > 30) undo[index].shift(); redo[index] = [];
      }
      active = null; pointer = null; before = null; paint();
    }
    function goTo(next) {
      finish();
      next = Math.max(0, Math.min(pages.length - 1, next));
      if (next === index) return;
      const direction = next > index ? 1 : -1;
      index = next; paint();
      q(".journal-current-paper").getAnimations().forEach(animation => animation.cancel());
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        q(".journal-current-paper").animate([{ transform: `translateX(${direction * 40}px)` }, { transform: "none" }], { duration: 220, easing: "ease-out" });
      }
    }
    function turn(delta) { goTo(index + delta); }
    q("[data-previous]").onclick = () => turn(-1);
    q("[data-next]").onclick = () => turn(1);
    const footer = q(".journal-page-turn");
    const gallery = q(".journal-page-gallery");
    q(".journal-drawer").addEventListener("toggle", () => {
      finish();
      swipe = null;
      q(".journal-current-paper").style.transform = "";
      q(".journal-current-paper").getAnimations().forEach(animation => animation.cancel());
      if (q(".journal-drawer").open) paint();
    });
    let suppressNeighborClick = false;
    function beginSwipe(event) {
      if (!event.isPrimary || event.button !== 0 || (event.currentTarget === footer && event.target.closest("button"))) return;
      swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
      // Capturing a neighbor-button press on the gallery would retarget its
      // click to the gallery, preventing a simple tap from opening that page.
      if (!event.target.closest("[data-neighbor]")) event.currentTarget.setPointerCapture(event.pointerId);
    }
    function endSwipe(event) {
      if (!swipe || event.pointerId !== swipe.id) return;
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      swipe = null;
      q(".journal-current-paper").style.transform = "";
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { suppressNeighborClick = true; turn(dx < 0 ? 1 : -1); }
    }
    footer.addEventListener("pointerdown", beginSwipe);
    footer.addEventListener("pointerup", endSwipe);
    gallery.addEventListener("pointerdown", event => {
      suppressNeighborClick = false;
      if (!event.target.closest("[data-drawing]")) beginSwipe(event);
    });
    gallery.addEventListener("pointermove", event => {
      if (!swipe || swipe.id !== event.pointerId) return;
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      if (Math.abs(dx) > Math.abs(dy)) q(".journal-current-paper").style.transform = `translateX(${Math.max(-45, Math.min(45, dx / 4))}px)`;
    });
    gallery.addEventListener("pointerup", endSwipe);
    gallery.addEventListener("pointercancel", () => { swipe = null; q(".journal-current-paper").style.transform = ""; });
    host.querySelectorAll("[data-neighbor]").forEach(neighbor => { neighbor.onclick = () => {
      if (!suppressNeighborClick) turn(Number(neighbor.dataset.neighbor));
      suppressNeighborClick = false;
    }; });
    q(".journal-page-dots").addEventListener("click", event => {
      const dot = event.target.closest("[data-page-index]");
      if (dot) goTo(Number(dot.dataset.pageIndex));
    });
    const point = event => {
      const rect = canvas.getBoundingClientRect();
      return [Math.round(Math.max(0, Math.min(WIDTH, (event.clientX - rect.left) / rect.width * WIDTH))), Math.round(Math.max(0, Math.min(HEIGHT, (event.clientY - rect.top) / rect.height * HEIGHT)))];
    };
    function ink(event) {
      const p = point(event);
      if (tool === "eraser") {
        pages[index] = pages[index].filter(stroke => !stroke.points.some((a, i) => {
          const b = stroke.points[i + 1] || a;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 18 + stroke.size / 2;
        }));
      } else if (active) {
        const last = active.points[active.points.length - 1];
        if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) >= 2) active.points.push(p);
      }
      if (frame === null) frame = requestAnimationFrame(paint);
    }
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", event => {
      if (readOnly || tool === "turn") return beginSwipe(event);
      if (!event.isPrimary || event.button !== 0 || pointer !== null) return;
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      pointer = event.pointerId; before = pages[index].slice();
      if (tool === "pen") { active = { color, size, points: [] }; pages[index].push(active); }
      ink(event);
    });
    canvas.addEventListener("pointermove", event => {
      if (event.pointerId !== pointer) return;
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) ink(sample);
    });
    canvas.addEventListener("pointerup", event => {
      endSwipe(event);
      if (event.pointerId === pointer) finish();
    });
    canvas.addEventListener("pointercancel", event => { swipe = null; if (event.pointerId === pointer) finish(true); });
    canvas.addEventListener("lostpointercapture", event => { if (event.pointerId === pointer) finish(); });
    if (!readOnly) {
      q("[data-add]").onclick = () => { finish(); if (pages.length < 100) { pages.push([]); paper.push(paper[index]); goTo(pages.length - 1); } };
      q("input").oninput = event => { color = event.target.value; };
      q("[data-pen-width]").onchange = event => { size = Number(event.target.value); };
      q("[data-template]").onchange = event => { finish(); paper[index] = event.target.value; paint(); };
      host.querySelectorAll("[data-tool]").forEach(control => { control.onclick = () => {
        finish(); tool = control.dataset.tool;
        canvas.style.touchAction = tool === "turn" ? "pan-y" : "none";
        canvas.style.cursor = tool === "turn" ? "grab" : "crosshair";
        host.querySelectorAll("[data-tool]").forEach(item => item.setAttribute("aria-pressed", String(item === control)));
      }; });
      function history(back) {
        finish(); const from = back ? undo[index] : redo[index], to = back ? redo[index] : undo[index];
        if (from.length) { to.push(pages[index]); pages[index] = from.pop(); paint(); }
      }
      q("[data-undo]").onclick = () => history(true);
      q("[data-redo]").onclick = () => history(false);
      canvas.addEventListener("keydown", event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); history(!event.shiftKey); }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); turn(event.key === "ArrowLeft" ? -1 : 1); }
      });
    }
    paint();
    const observer = window.ResizeObserver ? new ResizeObserver(() => {
      host.style.setProperty("--journal-preview-width", `${q(".journal-current-paper").getBoundingClientRect().width}px`);
    }) : null;
    observer?.observe(q(".journal-current-paper"));
    return { read() { finish(); return pages; }, readTemplates() { return paper.slice(); }, destroy() { finish(); if (frame !== null) cancelAnimationFrame(frame); observer?.disconnect(); host.remove(); } };
  }
  return { PAPER_TYPES, unpack, pack, mount };
});
