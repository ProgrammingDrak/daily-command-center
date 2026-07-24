// Mycelium vault tab (Phase B4b) — the focused THREAD CANVAS.
//
// Reachable from the timeline: select a thread, hit "Open N notes as canvas",
// and every note in that thread lands on one pannable/zoomable whiteboard, all
// spread out so you can read the whole thread at once. Cards render the REAL note
// (title, tag pills, the markdown body via the tab's shared render path, so
// wikilinks + media thumbnails work). Cards are draggable; an auto-layout on open
// places them left-to-right by date, wrapping into rows (timeline-flavored).
// Clicking a card's title pops the full note into the reading drawer.
//
// Performance, same discipline as the timeline:
//   • ONE batch request (POST /api/vault/nodes/bodies) fetches every body, not N.
//   • VIEWPORT WINDOWING — only cards whose world-rect intersects the viewport
//     mount to the DOM; panning/zooming mounts+unmounts via a keyed pass, so a
//     huge thread stays smooth. Card footprint is FIXED (width + capped height),
//     which makes the intersection test cheap and exact.
//   • Redraws are rAF-throttled, so a continuous zoom/pan is one redraw per frame.
//
// Pan/zoom reuse the vendored d3-zoom (a CSS transform on .vault-cv-world);
// dragging a card is handled separately (the zoom filter ignores gestures that
// start on a card). Card positions persist per thread in localStorage.

window.VaultCanvas = (function () {
  // ── Layout constants ──
  const CARD_W = 320;          // fixed card width (world px)
  const CARD_H = 300;          // fixed card footprint height (body scroll-capped inside)
  const GAP_X = 28, GAP_Y = 28;
  const PAD = 20;              // outer margin of the auto-layout grid
  const WINDOW_PAD = 420;      // mount cards a little past the viewport (world px)
  const DRAG_THRESH = 4;       // px of movement before a header press counts as a drag, not a click

  let bridge = {};
  let thread = null;           // { key, kind, label, color, count, nodes:[...] }
  let cards = [];              // [{ slug, title, type, tags, date, locked, x, y, el, dragging }]
  let bodies = {};             // slug -> batch payload { renderedBody, media, ... } | { locked } | { missing }
  let bodiesLoaded = false;
  let bodiesError = null;

  let host = null, surface = null, world = null, barLabel = null;
  let zoomBehavior = null;
  let transform = window.d3 ? window.d3.zoomIdentity : { x: 0, y: 0, k: 1 };
  let rafPending = false;
  let built = false;

  const d3ok = () => !!window.d3;
  const esc = (s) => (bridge.esc ? bridge.esc(s) : String(s == null ? "" : s));

  function init(b) { bridge = Object.assign({}, b || {}); }

  // ── Shell (built once) ──
  function ensureShell() {
    host = document.getElementById("vault-canvas");
    if (!host) return false;
    if (built && host.querySelector(".vault-cv-surface")) return true;
    host.innerHTML = `
      <div class="vault-cv-bar">
        <button class="vault-cv-back" id="vault-cv-back" type="button">← Back to timeline</button>
        <span class="vault-cv-label" id="vault-cv-label"></span>
        <span class="vault-cv-spacer"></span>
        <span class="vault-cv-hint">scroll to zoom · drag a card's title to move</span>
        <button class="vault-cv-btn" id="vault-cv-arrange" type="button" title="Re-tidy left-to-right by date">Auto-arrange</button>
        <button class="vault-cv-btn" id="vault-cv-fit" type="button" title="Fit the whole thread to view">Fit</button>
      </div>
      <div class="vault-cv-surface" id="vault-cv-surface"><div class="vault-cv-world" id="vault-cv-world"></div></div>`;
    surface = host.querySelector("#vault-cv-surface");
    world = host.querySelector("#vault-cv-world");
    barLabel = host.querySelector("#vault-cv-label");
    host.querySelector("#vault-cv-back").addEventListener("click", () => bridge.onExit && bridge.onExit());
    host.querySelector("#vault-cv-arrange").addEventListener("click", autoArrange);
    host.querySelector("#vault-cv-fit").addEventListener("click", () => fitView(true));

    if (d3ok()) {
      zoomBehavior = window.d3.zoom()
        .scaleExtent([0.12, 3])
        .filter(zoomFilter)
        .on("zoom", (e) => { transform = e.transform; scheduleDraw(); });
      window.d3.select(surface).call(zoomBehavior).on("dblclick.zoom", null);
    }
    if (window.ResizeObserver && !surface._ro) {
      surface._ro = new ResizeObserver(() => scheduleDraw());
      surface._ro.observe(surface);
    }
    built = true;
    return true;
  }

  // Pan only from empty surface (a gesture that starts on a card is a card-drag,
  // handled by the card). Wheel zooms everywhere EXCEPT over a card body, where it
  // scrolls the (scroll-capped) body natively.
  function zoomFilter(e) {
    if (e.type === "wheel") return !e.target.closest(".vault-cv-body");
    if (e.button) return false;
    return !e.target.closest(".vault-cv-card");
  }

  // ── Public entry ──
  async function open(payload) {
    if (!ensureShell() || !payload) return;
    thread = payload;
    if (barLabel) barLabel.textContent = `${payload.label} · ${payload.count} note${payload.count === 1 ? "" : "s"}`;
    cards = payload.nodes.map((n) => ({
      slug: n.slug, title: n.title, type: n.type, tags: n.tags || [], date: n.date || "",
      locked: !!n.locked, x: 0, y: 0, el: null, dragging: false,
    }));
    bodies = {}; bodiesLoaded = false; bodiesError = null;
    layout();
    if (world) world.innerHTML = "";
    draw();
    fitView(false);
    await fetchBodies();
    // Bodies are in — remount the visible frames so real content renders.
    for (const c of cards) if (c.el) unmountCard(c);
    scheduleDraw();
  }

  function close() {
    thread = null; cards = []; bodies = {}; bodiesLoaded = false;
    if (world) world.innerHTML = "";
  }

  // One request for the whole thread's bodies. Locked slugs are omitted from the
  // request (nothing to fetch); the server may STILL gate a slug (unlock expired
  // between timeline load and here) — such slugs come back {locked:true} and the
  // card flips to a locked card.
  async function fetchBodies() {
    const slugs = cards.filter((c) => !c.locked).map((c) => c.slug);
    if (!slugs.length) { bodiesLoaded = true; return; }
    try {
      const r = await fetch("/api/vault/nodes/bodies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slugs }),
      });
      if (!r.ok) throw new Error("bodies " + r.status);
      const data = await r.json();
      bodies = data.bodies || {};
      for (const c of cards) { const b = bodies[c.slug]; if (b && b.locked) c.locked = true; }
    } catch (e) { bodiesError = e.message; }
    bodiesLoaded = true;
  }

  // ── Layout + persistence ──
  function posKey() { return "vault-cv-pos:" + (thread && thread.key); }
  function colsFor() {
    const w = surface ? surface.clientWidth : 1000;
    return Math.max(1, Math.floor((w - PAD * 2 + GAP_X) / (CARD_W + GAP_X))) || 4;
  }
  function gridPlace(cols) {
    cards.forEach((c, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      c.x = PAD + col * (CARD_W + GAP_X);
      c.y = PAD + row * (CARD_H + GAP_Y);
    });
  }
  function layout() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(posKey()) || "null"); } catch { /* ignore */ }
    const cols = colsFor();
    gridPlace(cols); // baseline positions (date order — payload.nodes is date-sorted)
    if (saved) for (const c of cards) if (saved[c.slug]) { c.x = saved[c.slug].x; c.y = saved[c.slug].y; }
  }
  function persistPositions() {
    try {
      const map = {};
      for (const c of cards) map[c.slug] = { x: Math.round(c.x), y: Math.round(c.y) };
      localStorage.setItem(posKey(), JSON.stringify(map));
    } catch { /* localStorage full/blocked — positions just won't persist */ }
  }
  function autoArrange() {
    try { localStorage.removeItem(posKey()); } catch { /* ignore */ }
    gridPlace(colsFor());
    persistPositions();
    for (const c of cards) if (c.el) { c.el.style.left = c.x + "px"; c.el.style.top = c.y + "px"; }
    fitView(true);
  }

  // ── Fit / zoom ──
  function contentBounds() {
    let maxX = CARD_W, maxY = CARD_H;
    for (const c of cards) { maxX = Math.max(maxX, c.x + CARD_W); maxY = Math.max(maxY, c.y + CARD_H); }
    return { maxX: maxX + PAD, maxY: maxY + PAD };
  }
  function fitView(animate) {
    if (!surface) return;
    const W = surface.clientWidth, H = surface.clientHeight;
    const { maxX, maxY } = contentBounds();
    const k = Math.max(0.12, Math.min(1, (W - 8) / maxX, (H - 8) / maxY));
    const tx = Math.max(8, (W - k * maxX) / 2);
    const ty = 12;
    if (!d3ok()) { transform = { x: tx, y: ty, k }; draw(); return; }
    const t = window.d3.zoomIdentity.translate(tx, ty).scale(k);
    const sel = window.d3.select(surface);
    if (animate) sel.transition().duration(320).call(zoomBehavior.transform, t);
    else sel.call(zoomBehavior.transform, t);
  }

  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }

  // ── The windowed draw pass ──
  function draw() {
    if (!world || !surface) return;
    const t = transform;
    world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    world.style.transformOrigin = "0 0";
    const W = surface.clientWidth, H = surface.clientHeight;
    // Visible world rect = the screen box inverse-transformed, padded.
    const x0 = (0 - t.x) / t.k - WINDOW_PAD, x1 = (W - t.x) / t.k + WINDOW_PAD;
    const y0 = (0 - t.y) / t.k - WINDOW_PAD, y1 = (H - t.y) / t.k + WINDOW_PAD;
    for (const c of cards) {
      const vis = c.x + CARD_W >= x0 && c.x <= x1 && c.y + CARD_H >= y0 && c.y <= y1;
      if (vis && !c.el) mountCard(c);
      else if (!vis && c.el && !c.dragging) unmountCard(c);
      if (c.el) { c.el.style.left = c.x + "px"; c.el.style.top = c.y + "px"; }
    }
  }

  function unmountCard(c) { if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el); c.el = null; }

  function mountCard(c) {
    const el = document.createElement("div");
    el.className = "vault-cv-card" + (c.locked ? " locked" : "");
    el.style.left = c.x + "px";
    el.style.top = c.y + "px";
    el.dataset.slug = c.slug;
    const emoji = bridge.emojiFor ? bridge.emojiFor({ slug: c.slug, frontmatter: { type: c.type } }) : "📄";
    const head = `
      <div class="vault-cv-card-head" title="${c.locked ? "Sensitive note" : "Open note · drag to move"}">
        <span class="vault-cv-emoji">${c.locked ? "🔒" : emoji}</span>
        <span class="vault-cv-title">${esc(c.locked ? "Sensitive note" : c.title)}</span>
        <span class="vault-cv-date">${esc(c.date)}</span>
      </div>`;

    if (c.locked) {
      el.innerHTML = head +
        `<div class="vault-cv-body vault-cv-locked">🔒 Unlock a sensitive note from the reading pane to view it here.</div>`;
    } else {
      const b = bodies[c.slug];
      const tags = bridge.tagPills ? bridge.tagPills(c.tags) : "";
      el.innerHTML = head + tags + `<div class="vault-cv-body"><div class="vault-body-md"></div></div>`;
      if (b && b.missing) {
        el.querySelector(".vault-body-md").innerHTML = '<div class="vault-cv-note">(note not found)</div>';
      } else if (b) {
        const node = { slug: c.slug, frontmatter: { type: c.type, title: c.title, tags: c.tags }, renderedBody: b.renderedBody, media: b.media };
        if (bridge.renderBody) bridge.renderBody(el, node);
      } else {
        el.querySelector(".vault-body-md").innerHTML = bodiesError
          ? `<div class="vault-cv-note">Couldn't load: ${esc(bodiesError)}</div>`
          : '<div class="vault-cv-note">Loading…</div>';
      }
    }
    wireCard(el, c);
    world.appendChild(el);
    c.el = el;
  }

  // The card HEADER is the drag handle AND the open-on-click target: dragging it
  // moves the card, a clean click (no movement) opens the note in the reading
  // drawer. The body is left as a pure reading surface (scroll + wikilinks + media
  // lightbox all work there) — so a wikilink click never fights "open the card".
  function wireCard(el, c) {
    const head = el.querySelector(".vault-cv-card-head");
    if (!head) return;
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    const onMove = (e) => {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > DRAG_THRESH) moved = true;
      const k = transform.k || 1;
      c.x = ox + (e.clientX - sx) / k;
      c.y = oy + (e.clientY - sy) / k;
      el.style.left = c.x + "px";
      el.style.top = c.y + "px";
    };
    const onUp = () => {
      dragging = false; c.dragging = false;
      el.classList.remove("dragging");
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
      head.removeEventListener("pointercancel", onUp);
      if (moved) persistPositions();
      else if (!c.locked && bridge.onSelect) bridge.onSelect(c.slug);
    };
    head.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      moved = false; dragging = true; c.dragging = true;
      sx = e.clientX; sy = e.clientY; ox = c.x; oy = c.y;
      el.classList.add("dragging");
      try { head.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      head.addEventListener("pointermove", onMove);
      head.addEventListener("pointerup", onUp);
      head.addEventListener("pointercancel", onUp);
      e.preventDefault();
    });
  }

  return { init, open, close };
})();
