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
  function unpack(markdown) {
    const start = markdown.lastIndexOf(MARKER);
    if (start < 0 || !markdown.endsWith("\n-->")) return { text: markdown, pages: [[]] };
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
    return { text: markdown.slice(0, start), pages: data.pages };
  }
  function pack(text, pages) {
    return pages.some(page => page.length) || pages.length > 1
      ? text + MARKER + JSON.stringify({ pages }) + "\n-->" : text;
  }
  function mount(host, pages, { readOnly = false } = {}) {
    let index = 0, tool = "pen", color = "#292722", size = 3;
    let active = null, pointer = null, swipe = null, before = null, frame = null;
    const undo = pages.map(() => []), redo = pages.map(() => []);
    host.classList.add("journal-notebook");
    host.innerHTML = `<div class="journal-ink-tools" role="group" aria-label="Drawing tools">
      <span class="journal-ink-label">Sketchbook</span>
      ${readOnly ? "" : `<button type="button" data-tool="pen" aria-pressed="true">Pen</button>
      <button type="button" data-tool="eraser" aria-pressed="false">Eraser</button>
      <button type="button" data-tool="turn" aria-pressed="false">Turn pages</button>
      <label>Ink <input type="color" value="#292722" aria-label="Ink color"></label>
      <label>Width <select aria-label="Pen width"><option value="3">Fine</option><option value="6">Medium</option><option value="12">Broad</option></select></label>
      <button type="button" data-undo>Undo</button><button type="button" data-redo>Redo</button>`}
      </div><div class="journal-paper"><canvas width="1000" height="1200" aria-label="Hand drawing page" ${readOnly ? 'role="img"' : 'tabindex="0"'}></canvas></div>
      <div class="journal-page-turn" aria-label="Notebook page navigation">
      <button type="button" data-previous aria-label="Previous drawing page">←</button>
      <span data-page role="status" aria-live="polite"></span>
      <button type="button" data-next aria-label="Next drawing page">→</button>
      ${readOnly ? "" : '<button type="button" data-add>+ Page</button>'}</div>
      <p class="journal-ink-hint">${readOnly ? "Swipe the page to turn." : "Draw with a pen, mouse or finger. Swipe the page footer to turn. Saved with your journal."}</p>`;
    const canvas = host.querySelector("canvas"), context = canvas.getContext("2d");
    const q = selector => host.querySelector(selector);
    const histories = () => { undo[index] ||= []; redo[index] ||= []; };
    function paint() {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.lineCap = "round"; context.lineJoin = "round";
      for (const stroke of pages[index]) {
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
      histories();
      q("[data-page]").textContent = `Page ${index + 1} / ${pages.length}`;
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
    function turn(delta) {
      finish();
      const next = Math.max(0, Math.min(pages.length - 1, index + delta));
      if (next === index) return;
      index = next; paint();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        q(".journal-paper").animate([{ transform: `perspective(1000px) rotateY(${delta > 0 ? -12 : 12}deg)`, opacity: .6 }, { transform: "none", opacity: 1 }], { duration: 240 });
      }
    }
    q("[data-previous]").onclick = () => turn(-1);
    q("[data-next]").onclick = () => turn(1);
    const footer = q(".journal-page-turn");
    function beginSwipe(event) {
      if (!event.isPrimary || event.target.closest("button")) return;
      swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    function endSwipe(event) {
      if (!swipe || event.pointerId !== swipe.id) return;
      const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
    }
    footer.addEventListener("pointerdown", beginSwipe);
    footer.addEventListener("pointerup", endSwipe);
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
    canvas.style.touchAction = readOnly ? "pan-y" : "none";
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
      q("[data-add]").onclick = () => { finish(); if (pages.length < 100) { pages.push([]); index = pages.length - 1; paint(); } };
      q("input").oninput = event => { color = event.target.value; };
      q("select").onchange = event => { size = Number(event.target.value); };
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
    return { read() { finish(); return pages; }, destroy() { finish(); host.remove(); } };
  }
  return { unpack, pack, mount };
});
