// Mycelium vault tab (Phase B4a) — the SIGNATURE timeline visualization.
//
// A linear-date axis; every dated node branches off it on a lane-packed stem
// (dot color = its dominant ontology category); and below the axis, hand-built
// bezier "relevance arcs" thread through the nodes that share a tag, a person,
// or an event across time. Zoom/pan via vendored d3 (scaleTime + zoom); the arcs
// are the one genuinely hand-drawn part.
//
// Performance is by VIEWPORT WINDOWING, not luck: the endpoint returns the whole
// corpus once, but only the nodes/threads inside the current x-domain ever touch
// the DOM (a keyed d3 join adds/removes as you pan). Redraws are rAF-throttled so
// a continuous zoom gesture stays one redraw per frame. Target: 60fps at ~200
// visible on the real corpus, no jank at 5k.
//
// Data: GET /api/vault/timeline (nodes already colored; sensitive nodes on a
// locked session arrive as date-only "locked" dots and are never thread members).

window.VaultTimeline = (function () {
  // ── Layout constants ──
  const M = { top: 14, right: 26, bottom: 30, left: 26 };
  const DOT_R = 5;              // dot radius
  const LANE_GAP = 15;          // vertical px between stem lanes
  const STEM_BASE = 12;         // gap from axis to the first lane's dot
  const AXIS_FRAC = 0.56;       // axis y as a fraction of the plot height
  const MIN_DOT_GAP = DOT_R * 2 + 3; // horizontal px two dots need before sharing a lane
  const SHOW_ICONS_MAX = 90;    // draw per-dot type glyphs only when this few are visible
  const WINDOW_PAD_PX = 60;     // render a little past the viewport so pans reveal, not pop
  const MAX_RENDER = 700;       // hard DOM budget: past this, dots are uniformly thinned
                                // (they overlap at that density anyway) — zoom in to see all
  const MAX_ARC_HOPS = 48;      // per-thread bezier hop cap: a thread with more visible
                                // members than this samples them down (the arc spans the
                                // same range; you can't see the dropped control points)

  let bridge = { onSelect() {}, onOpenCanvas() {} };
  let data = null;            // { nodes, threads, counts, ... }
  let nodeById = new Map();   // id -> node (with .dt Date)
  let threadByKey = new Map();
  let x = null;               // base d3 scaleTime (identity transform)
  let transform = null;       // current d3 zoom transform
  let zoomBehavior = null;
  let W = 0, H = 0, axisY = 0, plotBottom = 0;
  let selectedThread = null;  // key of a legend/arc-selected thread (dims others)
  let els = {};               // cached DOM refs
  let rafPending = false;
  let shellBuilt = false;

  const d3ok = () => !!window.d3;
  const esc = (s) => (window.DCC && DCC.esc ? DCC.esc(s) : String(s == null ? "" : s));
  const toast = (m) => (window.DCC && window.DCC.toast ? window.DCC.toast(m) : void 0);
  // One source of truth for the per-type icon: the tab publishes window.DCC.vaultTypeEmoji
  // so the timeline and the explorer never drift as new node types land.
  const emojiFor = (n) => {
    if (n.sensitive && !n.slug) return "🔒";
    const map = (window.DCC && window.DCC.vaultTypeEmoji) || {};
    return map[n.type] || "📄";
  };
  // Local-midnight Date from a YYYY-MM-DD string (avoids UTC day-shift).
  const toDate = (s) => new Date(s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

  function init(b) { bridge = Object.assign(bridge, b || {}); }
  function invalidate() { data = null; _legendSig = null; }

  // ── Shell (built once) ──
  function ensureShell(host) {
    if (shellBuilt && host.querySelector(".vault-tl-svg")) return;
    host.innerHTML = `
      <div class="vault-tl-toolbar">
        <span class="vault-tl-count" id="vault-tl-count"></span>
        <span class="vault-tl-hint">scroll / pinch to zoom · drag to pan</span>
        <span class="vault-tl-spacer"></span>
        <button class="vault-tl-btn" id="vault-tl-reset" type="button" title="Reset zoom">Reset view</button>
      </div>
      <div class="vault-tl-onthisday" id="vault-tl-onthisday"></div>
      <div class="vault-tl-canvas" id="vault-tl-canvas">
        <svg class="vault-tl-svg" id="vault-tl-svg">
          <g class="vault-tl-arcs" id="vault-tl-arcs"></g>
          <g class="vault-tl-axis" id="vault-tl-axis"></g>
          <g class="vault-tl-nodes" id="vault-tl-nodes"></g>
        </svg>
        <div class="vault-tl-legend" id="vault-tl-legend"></div>
        <div class="vault-tl-hovercard" id="vault-tl-hovercard" hidden></div>
        <button class="vault-tl-open-canvas" id="vault-tl-open-canvas" type="button" hidden></button>
      </div>`;
    els = {
      count: host.querySelector("#vault-tl-count"),
      onthisday: host.querySelector("#vault-tl-onthisday"),
      canvas: host.querySelector("#vault-tl-canvas"),
      svg: host.querySelector("#vault-tl-svg"),
      gArcs: host.querySelector("#vault-tl-arcs"),
      gAxis: host.querySelector("#vault-tl-axis"),
      gNodes: host.querySelector("#vault-tl-nodes"),
      legend: host.querySelector("#vault-tl-legend"),
      hovercard: host.querySelector("#vault-tl-hovercard"),
      openCanvas: host.querySelector("#vault-tl-open-canvas"),
    };
    host.querySelector("#vault-tl-reset").addEventListener("click", resetZoom);
    els.openCanvas.addEventListener("click", () => openCanvas());

    zoomBehavior = window.d3.zoom()
      .scaleExtent([1, 4000])
      .filter((e) => !e.button && e.type !== "dblclick") // wheel/drag/touch; no dblclick jump
      .on("zoom", (e) => { transform = e.transform; scheduleDraw(); });
    window.d3.select(els.svg).call(zoomBehavior).on("dblclick.zoom", null);

    // Clicking empty canvas clears any thread selection (node/arc clicks
    // stopPropagation, so a click that reaches the svg is genuine empty space).
    els.svg.addEventListener("click", () => {
      if (selectedThread) { selectedThread = null; draw(); }
    });

    if (window.ResizeObserver && !els.canvas._ro) {
      els.canvas._ro = new ResizeObserver(() => scheduleDraw());
      els.canvas._ro.observe(els.canvas);
    }
    shellBuilt = true;
  }

  // ── Data prep ──
  function prepare() {
    nodeById = new Map();
    for (const n of data.nodes) { n.dt = toDate(n.date); nodeById.set(n.id, n); }
    threadByKey = new Map();
    for (const t of data.threads) threadByKey.set(t.key, t);
    // Base scale over the full date domain, with a few days of padding so the
    // first/last dots aren't glued to the edges.
    const dts = data.nodes.map((n) => n.dt);
    let lo = dts.length ? new Date(Math.min(...dts)) : new Date();
    let hi = dts.length ? new Date(Math.max(...dts)) : new Date();
    if (+lo === +hi) { lo = new Date(+lo - 15 * 864e5); hi = new Date(+hi + 15 * 864e5); }
    const pad = Math.max(864e5, (hi - lo) * 0.02);
    x = window.d3.scaleTime().domain([new Date(+lo - pad), new Date(+hi + pad)]);
    transform = window.d3.zoomIdentity;
  }

  // ── Public entry: show/refresh the timeline ──
  async function render() {
    const host = document.getElementById("vault-timeline");
    if (!host) return;
    if (!d3ok()) { host.innerHTML = `<div class="vault-tl-msg">Timeline needs d3 (vendored asset failed to load).</div>`; return; }
    ensureShell(host);
    if (!data) {
      setCount("Loading timeline…");
      try { data = await fetch("/api/vault/timeline").then((r) => { if (!r.ok) throw new Error("timeline " + r.status); return r.json(); }); }
      catch (e) { setCount("Error: " + e.message); return; }
      prepare();
    }
    draw();
    drawOnThisDay(); // window-independent — draw once per data load, not per frame
  }

  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }

  function setCount(txt) { if (els.count) els.count.textContent = txt; }

  function resetZoom() {
    if (!zoomBehavior) return;
    window.d3.select(els.svg).transition().duration(350).call(zoomBehavior.transform, window.d3.zoomIdentity);
  }

  // ── The draw pass (windowed) ──
  function draw() {
    if (!data || !x) return;
    const rect = els.canvas.getBoundingClientRect();
    W = Math.max(320, rect.width);
    H = Math.max(300, rect.height);
    els.svg.setAttribute("width", W);
    els.svg.setAttribute("height", H);
    els.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    axisY = Math.round((H - M.bottom) * AXIS_FRAC + M.top * 0.5);
    plotBottom = H - M.bottom;

    x.range([M.left, W - M.right]);
    const zx = transform.rescaleX(x);

    drawAxis(zx);

    // Visible window (a little past the edges so pans reveal rather than pop).
    const d0 = zx.invert(M.left - WINDOW_PAD_PX);
    const d1 = zx.invert(W - M.right + WINDOW_PAD_PX);
    const visible = [];
    for (const n of data.nodes) if (n.dt >= d0 && n.dt <= d1) visible.push(n);
    // DOM budget: past MAX_RENDER, thin the dots uniformly (date-sorted, so this
    // keeps the temporal spread). Arcs are unaffected — they're drawn from the
    // data's positions, not the DOM — so no thread visually breaks. Zooming in
    // drops the count below the budget and every dot returns.
    let drawn = visible, sampled = false;
    if (visible.length > MAX_RENDER) {
      const stride = Math.ceil(visible.length / MAX_RENDER);
      drawn = visible.filter((_, i) => i % stride === 0);
      sampled = true;
    }
    // Nodes come date-sorted from the endpoint, so this stays x-sorted -> greedy
    // lane packing works in one pass.
    packLanes(drawn, zx);
    drawNodes(drawn, zx);
    drawArcs(zx, d0, d1);
    drawLegend(zx, d0, d1);
    // drawOnThisDay() is NOT here: its output depends only on data + today, never
    // the viewport, so it is drawn once per data load in render(), not per frame.

    const c = data.counts || {};
    const trunc = c.threads > c.threadsShown ? ` · top ${c.threadsShown} of ${c.threads} threads` : "";
    const locked = c.locked ? ` · ${c.locked} locked` : "";
    const inView = sampled ? `${visible.length} in view (showing ${drawn.length})` : `${visible.length} in view`;
    setCount(`${data.nodes.length} dated notes · ${inView}${trunc}${locked}`);
    updateOpenCanvasBtn();
  }

  function drawAxis(zx) {
    const g = window.d3.select(els.gAxis);
    // Baseline.
    let base = g.select("line.vault-tl-axisline");
    if (base.empty()) base = g.append("line").attr("class", "vault-tl-axisline");
    base.attr("x1", M.left).attr("x2", W - M.right).attr("y1", axisY).attr("y2", axisY);
    // Ticks + labels (d3's multi-scale time format adapts to the zoom span).
    const ticks = zx.ticks(Math.min(14, Math.max(4, Math.round(W / 92))));
    const fmt = zx.tickFormat();
    const t = g.selectAll("g.vault-tl-tick").data(ticks, (d) => +d);
    t.exit().remove();
    const tEnter = t.enter().append("g").attr("class", "vault-tl-tick");
    tEnter.append("line");
    tEnter.append("text");
    const tAll = tEnter.merge(t).attr("transform", (d) => `translate(${zx(d)},0)`);
    tAll.select("line").attr("y1", M.top).attr("y2", plotBottom);
    tAll.select("text").attr("y", plotBottom + 16).attr("text-anchor", "middle").text(fmt);
  }

  // Greedy interval packing: each visible node takes the lowest lane whose last
  // dot is >= MIN_DOT_GAP to the left; if all lanes are too close and we've hit
  // the ceiling, it shares the roomiest lane (rare at any sane zoom).
  function packLanes(visible, zx) {
    const maxLanes = Math.max(1, Math.floor((axisY - M.top - DOT_R) / LANE_GAP));
    const laneLastX = [];
    for (const n of visible) {
      const px = zx(n.dt);
      let lane = -1;
      for (let i = 0; i < laneLastX.length; i++) { if (px - laneLastX[i] >= MIN_DOT_GAP) { lane = i; break; } }
      if (lane < 0) {
        if (laneLastX.length < maxLanes) { lane = laneLastX.length; laneLastX.push(-Infinity); }
        else { // pick the lane with the smallest lastX (most room), accept overlap
          lane = 0;
          for (let i = 1; i < laneLastX.length; i++) if (laneLastX[i] < laneLastX[lane]) lane = i;
        }
      }
      laneLastX[lane] = px;
      n._px = px;
      n._cy = axisY - (STEM_BASE + lane * LANE_GAP);
    }
  }

  function drawNodes(visible, zx) {
    const showIcons = visible.length <= SHOW_ICONS_MAX;
    // Membership test as an O(1) Set built ONCE per draw — not an O(members) scan
    // per visible dot per frame (a popular thread's member list can be thousands).
    const selMembers = selectedThread ? new Set((threadByKey.get(selectedThread) || {}).members || []) : null;
    const sel = window.d3.select(els.gNodes).selectAll("g.vault-tl-node").data(visible, (d) => d.id);
    sel.exit().remove();
    const enter = sel.enter().append("g").attr("class", "vault-tl-node");
    enter.append("line").attr("class", "vault-tl-stem");
    enter.append("circle").attr("class", "vault-tl-dot").attr("r", DOT_R);
    enter.append("text").attr("class", "vault-tl-glyph").attr("text-anchor", "middle").attr("dy", "0.35em");
    enter
      .on("mouseenter", (e, d) => showHover(e, d))
      .on("mousemove", (e) => positionHover(e))
      .on("mouseleave", hideHover)
      .on("click", (e, d) => { e.stopPropagation(); onNodeClick(d); });

    const all = enter.merge(sel);
    all.select(".vault-tl-stem").attr("x1", (d) => d._px).attr("x2", (d) => d._px).attr("y1", axisY).attr("y2", (d) => d._cy);
    all.select(".vault-tl-dot")
      .attr("cx", (d) => d._px).attr("cy", (d) => d._cy)
      .attr("fill", (d) => d.color || "#9ca3af")
      .classed("locked", (d) => !!d.sensitive && !d.slug)
      .classed("in-thread", (d) => !!selMembers && selMembers.has(d.id))
      .classed("dimmed", (d) => !!selMembers && !selMembers.has(d.id));
    all.select(".vault-tl-glyph")
      .attr("x", (d) => d._px).attr("y", (d) => d._cy - DOT_R - 7)
      .style("display", showIcons ? null : "none")
      .text((d) => (showIcons ? emojiFor(d) : ""));
  }

  // Bezier arc for one hop x1->x2 along the axis, arching BELOW it. Wider hops
  // dip deeper (the arc-diagram look), clamped to the space under the axis.
  function arcHop(x1, x2) {
    const maxDip = Math.max(16, plotBottom - axisY - 6);
    const dip = Math.min(maxDip, 16 + Math.abs(x2 - x1) * 0.32);
    return `M${x1},${axisY} C${x1},${axisY + dip} ${x2},${axisY + dip} ${x2},${axisY}`;
  }

  function drawArcs(zx, d0, d1) {
    // A thread contributes an arc only where >=2 of its members are in (or just
    // past) the window; we include one neighbor beyond each edge so a hop that
    // spans the viewport boundary still draws.
    const arcs = [];
    for (const t of data.threads) {
      const inWin = [];
      const mem = t.members;
      for (let i = 0; i < mem.length; i++) {
        const n = nodeById.get(mem[i]);
        if (!n) continue;
        if (n.dt >= d0 && n.dt <= d1) {
          if (inWin.length === 0 && i > 0) { const p = nodeById.get(mem[i - 1]); if (p) inWin.push(p); }
          inWin.push(n);
        } else if (inWin.length && inWin[inWin.length - 1] !== n && n.dt > d1) {
          inWin.push(n); break; // one neighbor past the right edge, then stop
        }
      }
      if (inWin.length < 2) continue;
      // Cap hops: a densely-populated thread at low zoom samples its members
      // (keeping first + last so the arc still spans its true range) — the shape
      // is indistinguishable but the path string is a fraction of the size.
      let pts = inWin;
      if (inWin.length > MAX_ARC_HOPS) {
        const stride = Math.ceil(inWin.length / MAX_ARC_HOPS);
        pts = inWin.filter((_, i) => i % stride === 0);
        if (pts[pts.length - 1] !== inWin[inWin.length - 1]) pts.push(inWin[inWin.length - 1]);
      }
      let dstr = "";
      for (let i = 1; i < pts.length; i++) dstr += arcHop(zx(pts[i - 1].dt), zx(pts[i].dt));
      arcs.push({ key: t.key, color: t.color, d: dstr });
    }
    const sel = window.d3.select(els.gArcs).selectAll("path.vault-tl-arc").data(arcs, (a) => a.key);
    sel.exit().remove();
    const enter = sel.enter().append("path").attr("class", "vault-tl-arc").attr("fill", "none")
      .on("mouseenter", (e, a) => { hoverThread = a.key; applyThreadEmphasis(); })
      .on("mouseleave", () => { hoverThread = null; applyThreadEmphasis(); })
      .on("click", (e, a) => { e.stopPropagation(); selectedThread = selectedThread === a.key ? null : a.key; draw(); });
    enter.merge(sel).attr("d", (a) => a.d).attr("stroke", (a) => a.color);
    applyThreadEmphasis();
  }

  let hoverThread = null;
  let _legendSig = null; // skip the legend innerHTML rebuild when the in-view chip set is unchanged
  function applyThreadEmphasis() {
    const active = hoverThread || selectedThread;
    window.d3.select(els.gArcs).selectAll("path.vault-tl-arc")
      .classed("active", (a) => active && a.key === active)
      .classed("dimmed", (a) => active && a.key !== active);
  }

  function drawLegend(zx, d0, d1) {
    // Top threads whose members intersect the current window, most-connected first.
    const inView = [];
    for (const t of data.threads) {
      let c = 0;
      for (const id of t.members) { const n = nodeById.get(id); if (n && n.dt >= d0 && n.dt <= d1) c++; }
      if (c >= 2) inView.push({ t, c });
    }
    inView.sort((a, b) => b.c - a.c);
    const top = inView.slice(0, 12);
    // Skip the innerHTML rebuild + listener re-bind when the visible chip set and
    // counts (and the selection) are identical to the last frame — during a pure
    // zoom or a pan that doesn't shift the top-12, this is a no-op.
    const sig = (selectedThread || "") + "|" + top.map(({ t, c }) => t.key + ":" + c).join(",");
    if (sig === _legendSig) return;
    _legendSig = sig;
    els.legend.innerHTML = top.length
      ? `<div class="vault-tl-legend-h">Threads in view</div>` + top.map(({ t, c }) =>
          `<button class="vault-tl-chip${selectedThread === t.key ? " sel" : ""}" data-key="${esc(t.key)}" title="${esc(t.kind)}: ${esc(t.value)} — double-click to open as canvas">
             <span class="sw" style="background:${esc(t.color)}"></span>
             <span class="lb">${esc(t.label)}</span><span class="ct">${c}</span>
             ${selectedThread === t.key ? `<span class="vault-tl-chip-open" title="Open as canvas">⤢</span>` : ""}
           </button>`).join("")
      : `<div class="vault-tl-legend-h">No threads in view</div>`;
    els.legend.querySelectorAll(".vault-tl-chip").forEach((b) => {
      b.addEventListener("click", (e) => {
        // The ⤢ badge on the selected chip opens the canvas; the chip body toggles.
        if (e.target.closest(".vault-tl-chip-open")) { openCanvas(b.dataset.key); return; }
        const k = b.dataset.key; selectedThread = selectedThread === k ? null : k; draw();
      });
      b.addEventListener("dblclick", (e) => { e.preventDefault(); openCanvas(b.dataset.key); });
      b.addEventListener("mouseenter", () => { hoverThread = b.dataset.key; applyThreadEmphasis(); });
      b.addEventListener("mouseleave", () => { hoverThread = null; applyThreadEmphasis(); });
    });
  }

  function drawOnThisDay() {
    const now = new Date();
    const mmdd = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    const hits = data.nodes.filter((n) => n.date.slice(5) === mmdd)
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest year first
    if (!hits.length) { els.onthisday.innerHTML = ""; els.onthisday.style.display = "none"; return; }
    els.onthisday.style.display = "";
    els.onthisday.innerHTML = `<span class="vault-tl-otd-h">📅 On this day</span>` + hits.slice(0, 16).map((n) => {
      const yr = n.date.slice(0, 4);
      if (n.sensitive && !n.slug) return `<span class="vault-tl-otd-chip locked">🔒 ${yr}</span>`;
      return `<button class="vault-tl-otd-chip" data-slug="${esc(n.slug)}"><span class="yr">${yr}</span> ${esc(n.title)}</button>`;
    }).join("");
    els.onthisday.querySelectorAll(".vault-tl-otd-chip[data-slug]").forEach((b) =>
      b.addEventListener("click", () => bridge.onSelect(b.dataset.slug)));
  }

  // ── Open-as-canvas (B4b) ──
  // Build the canvas payload for a thread: its member nodes (already date-sorted
  // by the endpoint) enriched with the fields the canvas needs for card headers +
  // date auto-layout. Locked members never reach here (the endpoint drops them
  // from threads on a locked session), so every member has a real slug.
  function threadCanvasPayload(key) {
    const t = threadByKey.get(key);
    if (!t) return null;
    const nodes = [];
    for (const id of t.members) {
      const n = nodeById.get(id);
      if (!n || !n.slug) continue;
      nodes.push({ slug: n.slug, date: n.date, title: n.title, type: n.type, tags: n.tags || [], color: n.color });
    }
    return { key: t.key, kind: t.kind, label: t.label, color: t.color, count: nodes.length, nodes };
  }
  function openCanvas(key) {
    const payload = threadCanvasPayload(key || selectedThread);
    if (payload && payload.nodes.length) bridge.onOpenCanvas(payload);
  }
  // Show the floating "Open N notes as canvas" button whenever a thread is
  // selected; hide it otherwise. Called at the end of each draw (selection
  // changes always trigger a draw).
  function updateOpenCanvasBtn() {
    const btn = els.openCanvas;
    if (!btn) return;
    const t = selectedThread && threadByKey.get(selectedThread);
    if (!t) { btn.hidden = true; return; }
    const n = t.members.length;
    btn.textContent = `🎴 Open ${n} note${n === 1 ? "" : "s"} as canvas`;
    btn.hidden = false;
  }

  function onNodeClick(d) {
    if (d.sensitive && !d.slug) { toast("🔒 Sensitive note — unlock from a note to view it here"); return; }
    if (d.slug) bridge.onSelect(d.slug);
  }

  // ── Hover card ──
  function showHover(e, d) {
    const card = els.hovercard;
    if (!card) return;
    if (d.sensitive && !d.slug) {
      card.innerHTML = `<div class="hc-title">🔒 Sensitive note</div><div class="hc-meta">${esc(d.date)} · locked</div>`;
    } else {
      const tags = (d.tags || []).slice(0, 6).map((t) => `<span class="hc-tag">${esc(t)}</span>`).join("");
      const people = (d.people || []).map((p) => p.split("/").pop());
      const ppl = people.length ? `<div class="hc-people">👤 ${esc(people.slice(0, 4).join(", "))}</div>` : "";
      card.innerHTML =
        `<div class="hc-title">${emojiFor(d)} ${esc(d.title)}</div>
         <div class="hc-meta">${esc(d.date)} · ${esc(d.type)}</div>
         ${ppl}${tags ? `<div class="hc-tags">${tags}</div>` : ""}`;
    }
    card.hidden = false;
    positionHover(e);
  }
  function positionHover(e) {
    const card = els.hovercard;
    if (!card || card.hidden) return;
    const r = els.canvas.getBoundingClientRect();
    let left = e.clientX - r.left + 14;
    let top = e.clientY - r.top + 14;
    const cw = card.offsetWidth || 220, ch = card.offsetHeight || 80;
    if (left + cw > r.width) left = e.clientX - r.left - cw - 14;
    if (top + ch > r.height) top = e.clientY - r.top - ch - 14;
    card.style.left = Math.max(4, left) + "px";
    card.style.top = Math.max(4, top) + "px";
  }
  function hideHover() { if (els.hovercard) els.hovercard.hidden = true; }

  return { init, invalidate, render };
})();
