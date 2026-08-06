// Mycelium vault tab — the GLOBAL GRAPH view.
//
// The one thing the tab was missing. It was cut at B4a QA on the reasoning that
// "Obsidian already gives a local graph over this same repo"; that reasoning
// expired on 2026-08-06 when Drake's call became "we are not using Obsidian", so
// the graph has to live here or nowhere.
//
// Force-directed, d3-force out of the SAME vendored d3 bundle the timeline uses
// (it is the full build — forceSimulation/forceLink/forceManyBody/forceCollide
// were already sitting in there unused, so this view adds no dependency).
//
// Two things this graph does that Obsidian's cannot, both free from the vault's
// own contract:
//   • TYPED EDGES. A frontmatter link is typed by its field name (`players:`
//     yields a `players` edge), body links are typed `body`. Body links draw as
//     hairlines, typed ones accented and thicker, so declared relationships are
//     visually distinct from prose mentions. Obsidian has no notion of this.
//   • ONTOLOGY COLOR. Node hue is the circular mean of its tag categories,
//     computed server-side by the one parse.js colorForTags() the timeline also
//     uses — never re-implemented here.
//
// Layout follows vault-timeline.js's discipline rather than inventing its own:
// vendored d3-zoom driving a transform on one <g>, rAF-throttled redraws, and an
// honest cap that REPORTS what it dropped instead of silently truncating.
//
// Deliberate difference from the canvas (B4b): node positions are NOT persisted.
// The canvas is a workspace you arrange; the graph is a lens you look through. A
// drag pins a node for the current session so you can pull a cluster apart;
// double-click unpins it, and leaving the view forgets all of it.

window.VaultGraph = (function () {
  // ── Tunables ──
  // Sized so a lone note is still legible after the fit scales the world down.
  // At the first pass (3.5 world units) a settled 182-node layout fit to k=0.74,
  // leaving ~2.5px dots that were nearly invisible against the dark pane -- the
  // graph looked half-empty when every node was in fact on screen.
  const R_MIN = 5;              // radius of a zero-degree node
  const R_SCALE = 2;            // radius growth per sqrt(degree)
  const R_MAX = 18;
  const LABEL_MAX = 90;         // draw labels only when this few nodes are visible
  const LABEL_DEG = 4;          // ...or when a node has at least this many edges
  const SIM_CAP = 2500;         // simulation budget; above this we keep the most
                                // connected nodes and SAY how many were dropped
  const CHARGE = -170;
  const LINK_DIST = 46;
  const ALPHA_STOP = 0.008;     // settle threshold — stop ticking below this

  // Bridge from vault-tab (same idiom as the timeline/canvas: no-op stubs merged
  // with the real thing in init(), so call sites stay unguarded).
  let bridge = {
    onSelect() {}, esc(s) { return String(s == null ? "" : s); },
    emojiFor() { return "📄"; },
  };

  let data = null;              // last /api/vault/graph payload (cached)
  let sim = null;
  let svg = null, world = null, zoomBehavior = null;
  let els = {};
  let simNodes = [], simLinks = [];
  let selected = null;          // focused slug
  let hovered = null;
  let dropped = 0;              // nodes omitted by SIM_CAP
  let showGhosts = false;       // dangling link targets (off: the journal import
                                // carries ~50, which drowns a first look)
  let showGenerated = false;    // weekly-review notes: generated hubs, see F2
  let localHops = 0;            // 0 = whole vault; 1..3 = n-hop around `selected`
  let rafPending = false;
  let fitPending = false;      // fit ONCE when the layout settles, not on a timer

  const d3ok = () => typeof window.d3 !== "undefined" && !!window.d3.forceSimulation;

  // ── Data ──

  async function load() {
    if (data) return data;
    const res = await fetch("/api/vault/graph", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`graph ${res.status}`);
    data = await res.json();
    return data;
  }

  function invalidate() { data = null; }

  // Build the node/link arrays for the current toggles. Runs on every toggle, so
  // it stays O(n+e) and allocates fresh objects — d3-force mutates what it is
  // given (x/y/vx/vy), and reusing filtered-out objects across rebuilds would
  // carry stale velocities back in.
  function build() {
    const nodes = [];
    const keep = new Set();

    let pool = data.nodes.filter((n) => showGenerated || !n.generated);

    // Honest cap: keep the most connected, and remember how many we dropped so
    // the legend can say so. A graph cannot be thinned uniformly the way the
    // timeline thins dots — removing arbitrary nodes rewrites the structure — so
    // degree order is the least-wrong ordering when a corpus outgrows the budget.
    dropped = 0;
    if (pool.length > SIM_CAP) {
      pool = pool.slice().sort((a, b) => b.deg - a.deg);
      dropped = pool.length - SIM_CAP;
      pool = pool.slice(0, SIM_CAP);
    }
    for (const n of pool) { keep.add(n.slug); }

    // Local mode: BFS out from the selected node over the UNDIRECTED adjacency of
    // whatever survived the filters above.
    if (localHops > 0 && selected && keep.has(selected)) {
      const adj = new Map();
      for (const e of data.edges) {
        if (!keep.has(e.s) || !keep.has(e.t)) continue;
        if (!adj.has(e.s)) adj.set(e.s, []);
        if (!adj.has(e.t)) adj.set(e.t, []);
        adj.get(e.s).push(e.t);
        adj.get(e.t).push(e.s);
      }
      const seen = new Set([selected]);
      let frontier = [selected];
      for (let h = 0; h < localHops; h++) {
        const next = [];
        for (const s of frontier) {
          for (const nb of adj.get(s) || []) {
            if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
      for (const s of Array.from(keep)) if (!seen.has(s)) keep.delete(s);
    }

    const byId = new Map();
    for (const n of data.nodes) {
      if (!keep.has(n.slug)) continue;
      const o = { ...n, r: nodeRadius(n.deg) };
      byId.set(n.slug, o);
      nodes.push(o);
    }

    const links = [];
    for (const e of data.edges) {
      if (!byId.has(e.s) || !byId.has(e.t)) continue;
      links.push({ source: byId.get(e.s), target: byId.get(e.t), type: e.type });
    }

    // Ghosts (dangling targets) are synthesized here, never sent as nodes by the
    // server — they have no file, so no type/date/tags. One ghost node per unique
    // target, with an edge from each note that points at it.
    if (showGhosts) {
      for (const g of data.ghosts) {
        const id = `ghost:${g.target}`;
        const o = {
          id, slug: null, ghost: true, target: g.target,
          title: g.target, type: "dangling", deg: g.inbound,
          color: data.unmapped, r: Math.min(R_MAX, R_MIN + Math.sqrt(g.inbound)),
        };
        byId.set(id, o);
        nodes.push(o);
      }
      // Wire each ghost to the notes that point at it, so a dangling target is
      // actionable ("these 24 notes have rot in them") rather than a floating dot.
      for (const g of data.ghosts) {
        const gid = `ghost:${g.target}`;
        for (const src of g.sources || []) {
          if (byId.has(src)) {
            links.push({ source: byId.get(src), target: byId.get(gid), dangling: true, type: "body" });
          }
        }
      }
    }

    simNodes = nodes;
    simLinks = links;
  }

  // Reverse the five entities escHtml produces. Only ever applied to text that is
  // then set via textContent, so this cannot reintroduce markup.
  function unescapeEntities(s) {
    return String(s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function nodeRadius(deg) {
    return Math.max(R_MIN, Math.min(R_MAX, R_MIN + Math.sqrt(Math.max(0, deg)) * R_SCALE));
  }

  // ── Simulation ──

  // Centering forces, shaped to the container's ASPECT RATIO.
  //
  // Two problems solved at once. First, charge repulsion throws unlinked notes
  // toward infinity — nothing pulls them back, which is what being an orphan
  // means — so the bounding box inflates and a fit that must include them shrinks
  // the connected core to specks. This corpus is 168 orphans out of 182, so that
  // is the common case, not an edge case.
  //
  // Second, a symmetric pull settles into a roughly SQUARE cloud, and the graph
  // pane is a wide letterbox (~1370x515, 2.7:1). Fitting a square into that wastes
  // about 60% of the width — measured: a 1113x1002 layout fit to k=0.48 and used
  // 530 of 1370 available pixels. So the pull is asymmetric by the aspect ratio:
  // weaker on the long axis (let it spread), stronger on the short one (compress),
  // which lands a cloud shaped like the box holding it.
  function applyCenteringForces(s, width, height) {
    const d3 = window.d3;
    const BASE = 0.05;
    const aspect = Math.max(0.2, Math.min(5, (width || 1) / (height || 1)));
    const sx = Math.max(0.008, Math.min(0.3, BASE / aspect));
    const sy = Math.max(0.008, Math.min(0.3, BASE * aspect));
    s.force("x", d3.forceX(width / 2).strength(sx));
    s.force("y", d3.forceY(height / 2).strength(sy));
  }

  // The graph SNAPS to a settled layout instead of animating into one.
  //
  // Letting it animate meant the first few seconds showed an unsettled cloud that
  // had not been fitted yet — nodes bunched in a corner, most of the pane empty —
  // because the fit can only run once positions stop moving. A lens should be
  // readable the instant you open it, and it made every screenshot a race.
  //
  // So: build the simulation stopped, tick it to convergence synchronously, then
  // draw and fit once. d3 is happy to be driven by hand; `stop()` only cancels the
  // internal timer, and tick() applies the same forces. Cost is bounded by a tick
  // budget that shrinks as the corpus grows (~165 ticks at 182 nodes, 60 at 2500),
  // so a big vault trades some layout quality for the same snap.
  //
  // The sim stays alive afterwards: dragging a node restarts it with a low alpha
  // so the neighbourhood gives way, which is the one place animation earns itself.
  function startSim(width, height) {
    const d3 = window.d3;
    if (sim) sim.stop();
    sim = d3.forceSimulation(simNodes)
      .force("link", d3.forceLink(simLinks).distance(LINK_DIST).strength(0.55))
      .force("charge", d3.forceManyBody().strength(CHARGE).distanceMax(420))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius((d) => d.r + 2.5))
      .alphaDecay(0.035)
      .stop();
    applyCenteringForces(sim, width, height);

    const n = Math.max(1, simNodes.length);
    const ticks = Math.max(60, Math.min(300, Math.round(30000 / n)));
    for (let i = 0; i < ticks; i++) sim.tick();

    // Only NOW start listening, so the pre-tick loop does not schedule 165 draws.
    sim.on("tick", scheduleDraw)
       .on("end", () => { draw(); if (fitPending) { fitPending = false; fit(); } });

    fitPending = false;
    draw();
    fit();
  }

  // rAF-throttled: a force tick fires far faster than the display refreshes, and
  // redrawing per tick is how a graph this size starts dropping frames.
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
      // Stopping here means d3 never fires "end", so the one-shot fit has to be
      // triggered from the same place the sim is stopped.
      if (sim && sim.alpha() < ALPHA_STOP) {
        sim.stop();
        if (fitPending) { fitPending = false; fit(); }
      }
    });
  }

  // ── Rendering ──

  function edgeClass(l) {
    if (l.dangling) return "vault-gr-link dangling";
    return "vault-gr-link" + (l.type && l.type !== "body" ? " typed" : "");
  }

  function labelsOn() { return simNodes.length <= LABEL_MAX; }

  function draw() {
    if (!world) return;
    const d3 = window.d3;

    const link = world.select(".vault-gr-links").selectAll("line")
      .data(simLinks, (l) => `${l.source.id || l.source}|${l.target.id || l.target}|${l.type}`);
    link.exit().remove();
    link.enter().append("line").attr("class", edgeClass)
      .merge(link)
      .attr("class", edgeClass)
      .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
      .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y)
      .classed("hot", (l) => isHot(l.source) || isHot(l.target));

    const node = world.select(".vault-gr-nodes").selectAll("g.vault-gr-node")
      .data(simNodes, (n) => n.id);
    node.exit().remove();

    const enter = node.enter().append("g").attr("class", "vault-gr-node");
    enter.append("circle");
    // Native SVG <title> = a free browser tooltip carrying the node's summary.
    // At this density most labels are hidden (hubs only), so hovering a bare dot
    // is the main way to find out what it is without clicking through.
    enter.append("title");
    enter.append("text");
    enter
      .on("click", (ev, d) => onClick(d))
      .on("mouseenter", (ev, d) => { hovered = d.id; draw(); })
      .on("mouseleave", () => { hovered = null; draw(); })
      .on("dblclick", (ev, d) => { d.fx = null; d.fy = null; if (sim) sim.alpha(0.25).restart(); })
      .call(d3.drag()
        .on("start", (ev, d) => { if (sim) sim.alphaTarget(0.18).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end", (ev, d) => { if (sim) sim.alphaTarget(0); }));

    const all = enter.merge(node);
    all.attr("transform", (d) => `translate(${d.x || 0},${d.y || 0})`)
      .classed("selected", (d) => d.slug && d.slug === selected)
      .classed("ghost", (d) => !!d.ghost)
      .classed("generated", (d) => !!d.generated)
      .classed("dimmed", (d) => !!(hovered && !isHot(d)));
    all.select("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => (d.ghost ? "none" : d.color || data.unmapped))
      .attr("stroke", (d) => (d.ghost ? d.color || data.unmapped : null));
    // The summary arrives HTML-escaped from the route; <title> takes TEXT, so
    // decode the few entities escHtml introduces rather than showing &amp;#39; in a
    // tooltip. textContent means there is no injection path either way.
    all.select("title").text((d) => {
      const bits = [d.ghost ? `[[${d.target}]] — dangling` : d.title];
      if (d.summary) bits.push(unescapeEntities(d.summary));
      if (!d.ghost) bits.push(`${d.type}${d.date ? ` · ${d.date}` : ""} · ${d.deg} link${d.deg === 1 ? "" : "s"}`);
      return bits.filter(Boolean).join("\n");
    });
    all.select("text")
      .attr("x", (d) => d.r + 4).attr("y", 3.5)
      .text((d) => (labelsOn() || d.deg >= LABEL_DEG || isHot(d) ? d.title : ""));

    renderLegend();
  }

  // "Hot" = the hovered node, or a direct neighbour of it. Drives the dim/undim
  // pass, which is the single most useful reading affordance in a dense graph.
  function isHot(n) {
    if (!hovered) return false;
    const id = n.id || n;
    if (id === hovered) return true;
    for (const l of simLinks) {
      const s = l.source.id || l.source, t = l.target.id || l.target;
      if (s === hovered && t === id) return true;
      if (t === hovered && s === id) return true;
    }
    return false;
  }

  function onClick(d) {
    if (d.ghost) {
      toast(`Dangling target "${d.target}" — ${d.deg} note${d.deg === 1 ? "" : "s"} link to a node that does not exist`);
      return;
    }
    if (!d.slug) return;
    selected = d.slug;
    bridge.onSelect(d.slug);
    draw();
  }

  function toast(msg) {
    if (window.DCC && typeof window.DCC.toast === "function") window.DCC.toast(msg);
  }

  // The legend reports what is ACTUALLY DRAWN, and labels corpus-level facts as
  // such. Reporting the server's corpus totals here was wrong and briefly shipped:
  // with the generated reviews hidden it read "40 shown · 43 links" while only 35
  // lines were on screen. A legend that disagrees with the picture is worse than
  // no legend, so any filter that removes something has to say what it removed.
  function renderLegend() {
    const el = els.legend;
    if (!el || !data) return;
    const c = data.counts;
    const shownNodes = simNodes.length;
    const shownLinks = simLinks.length;
    const ghostNodes = simNodes.filter((n) => n.ghost).length;
    const realShown = shownNodes - ghostNodes;
    const bits = [];
    bits.push(`<div class="vault-gr-legend-h">Graph</div>`);
    bits.push(`<div class="vault-gr-stat">${realShown}${realShown < c.nodes ? ` of ${c.nodes}` : ""} note${realShown === 1 ? "" : "s"} · ${shownLinks} link${shownLinks === 1 ? "" : "s"}</div>`);
    if (ghostNodes) bits.push(`<div class="vault-gr-stat">👻 ${ghostNodes} dangling target${ghostNodes === 1 ? "" : "s"} (${c.danglingLinks} link${c.danglingLinks === 1 ? "" : "s"})</div>`);
    // Say WHY the drawn count is short of the corpus, or the gap looks like a bug.
    if (localHops > 0 && selected) bits.push(`<div class="vault-gr-stat">◉ local: ${localHops} hop${localHops === 1 ? "" : "s"} from the open note</div>`);
    if (!showGenerated) {
      const gen = data.nodes.filter((n) => n.generated).length;
      if (gen) bits.push(`<div class="vault-gr-stat">🔮 ${gen} generated review${gen === 1 ? "" : "s"} hidden</div>`);
    }
    if (c.orphans) bits.push(`<div class="vault-gr-stat">${c.orphans} orphan${c.orphans === 1 ? "" : "s"} in the vault</div>`);
    if (c.hidden) bits.push(`<div class="vault-gr-stat locked">🔒 ${c.hidden} sensitive hidden</div>`);
    // Never let a cap be invisible: if the budget dropped nodes, say how many.
    if (dropped) bits.push(`<div class="vault-gr-stat warn">⚠ ${dropped} least-connected node${dropped === 1 ? "" : "s"} omitted (budget ${SIM_CAP})</div>`);
    if (!labelsOn()) bits.push(`<div class="vault-gr-stat">labels: hubs only (${LABEL_DEG}+ links)</div>`);
    bits.push(`<div class="vault-gr-key"><span class="k-line typed"></span> typed link (frontmatter field)</div>`);
    bits.push(`<div class="vault-gr-key"><span class="k-line"></span> body link</div>`);
    if (!data.ontologyAvailable) bits.push(`<div class="vault-gr-stat warn">ontology unavailable — all grey</div>`);
    el.innerHTML = bits.join("");
  }

  function syncControls() {
    if (els.ghostBtn) {
      els.ghostBtn.classList.toggle("on", showGhosts);
      const n = data ? data.counts.ghosts : 0;
      els.ghostBtn.textContent = `👻 Dangling (${n})`;
      els.ghostBtn.hidden = !n;
    }
    if (els.genBtn) els.genBtn.classList.toggle("on", showGenerated);
    if (els.localBtn) {
      els.localBtn.classList.toggle("on", localHops > 0);
      els.localBtn.textContent = localHops > 0 ? `◉ Local ${localHops} hop${localHops === 1 ? "" : "s"}` : "◉ Local";
      els.localBtn.disabled = !selected && localHops === 0;
      els.localBtn.title = selected
        ? "Show only the neighbourhood around the open note (click to widen, cycles 1→2→3→off)"
        : "Open a note first, then this narrows the graph to its neighbourhood";
    }
  }

  // ── Mount ──

  function ensureMounted() {
    const host = document.getElementById("vault-graph");
    if (!host) return false;
    if (svg) return true;
    const d3 = window.d3;

    host.innerHTML = `
      <div class="vault-gr-bar">
        <button id="vault-gr-local" class="vault-gr-btn" type="button">◉ Local</button>
        <button id="vault-gr-ghosts" class="vault-gr-btn" type="button" title="Links pointing at notes that do not exist">👻 Dangling</button>
        <button id="vault-gr-generated" class="vault-gr-btn" type="button" title="Weekly-review notes are generated and link everything they surface, so they read as hubs they did not earn">🔮 Reviews</button>
        <span class="vault-gr-spacer"></span>
        <button id="vault-gr-refit" class="vault-gr-btn" type="button" title="Re-centre and fit">⤢ Fit</button>
      </div>
      <div class="vault-gr-surface">
        <svg class="vault-gr-svg"><g class="vault-gr-world">
          <g class="vault-gr-links"></g><g class="vault-gr-nodes"></g>
        </g></svg>
        <div id="vault-gr-legend" class="vault-gr-legend"></div>
      </div>`;

    els = {
      host,
      surface: host.querySelector(".vault-gr-surface"),
      legend: host.querySelector("#vault-gr-legend"),
      ghostBtn: host.querySelector("#vault-gr-ghosts"),
      genBtn: host.querySelector("#vault-gr-generated"),
      localBtn: host.querySelector("#vault-gr-local"),
      refitBtn: host.querySelector("#vault-gr-refit"),
    };

    svg = d3.select(host).select("svg.vault-gr-svg");
    world = svg.select("g.vault-gr-world");

    // Pan/zoom on the world <g>. The drag behaviour on nodes stops propagation
    // itself, so the zoom filter only has to reject the secondary button.
    zoomBehavior = d3.zoom().scaleExtent([0.12, 6])
      .filter((ev) => !ev.button)
      .on("zoom", (ev) => world.attr("transform", ev.transform));
    svg.call(zoomBehavior).on("dblclick.zoom", null);

    // Re-centre and re-fit whenever the surface actually changes size. This is not
    // belt-and-braces: in gr-mode the graph shares #vault-body with the reading
    // pane, so opening a note takes up to 38vh away and the graph's height can
    // HALVE after the layout has already been fitted. Fitting against the old
    // height parked the whole graph in the top half of the surface with dead space
    // below. A resize observer is the only thing that catches every cause (reading
    // pane appearing, window resize, tab switch, mobile breakpoint).
    if (typeof ResizeObserver !== "undefined") {
      let last = { w: 0, h: 0 }, t = null;
      new ResizeObserver(() => {
        const { w, h } = size();
        // Ignore sub-pixel churn and the 0x0 an off-screen tab reports, or the
        // observer would fight the fit it just triggered.
        if (!w || !h) return;
        if (Math.abs(w - last.w) < 8 && Math.abs(h - last.h) < 8) return;
        last = { w, h };
        clearTimeout(t);
        t = setTimeout(() => {
          if (!simNodes.length) return;
          const d3 = window.d3;
          if (sim) {
            sim.force("center", d3.forceCenter(w / 2, h / 2));
            applyCenteringForces(sim, w, h);   // re-shape to the NEW aspect ratio
            fitPending = true;
            sim.alpha(0.3).restart();
          } else { fit(); }
        }, 140);
      }).observe(els.surface);
    }

    els.ghostBtn.addEventListener("click", () => { showGhosts = !showGhosts; rebuild(); });
    els.genBtn.addEventListener("click", () => { showGenerated = !showGenerated; rebuild(); });
    els.localBtn.addEventListener("click", () => {
      localHops = localHops >= 3 ? 0 : localHops + 1;
      rebuild();
    });
    els.refitBtn.addEventListener("click", fit);
    return true;
  }

  function size() {
    const s = els.surface;
    const w = (s && s.clientWidth) || 800;
    const h = (s && s.clientHeight) || 460;
    return { w, h };
  }

  function fit() {
    if (!svg || !simNodes.length) return;
    const d3 = window.d3;
    const { w, h } = size();
    const xs = simNodes.map((n) => n.x || 0), ys = simNodes.map((n) => n.y || 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 40;
    const k = Math.min(3, Math.max(0.12,
      Math.min(w / (maxX - minX + pad * 2 || 1), h / (maxY - minY + pad * 2 || 1))));
    const tx = w / 2 - k * (minX + maxX) / 2;
    const ty = h / 2 - k * (minY + maxY) / 2;
    svg.transition().duration(280)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  function rebuild() {
    if (!data) return;
    build();
    const { w, h } = size();
    startSim(w, h);
    syncControls();
    draw();
  }

  async function render() {
    if (!ensureMounted()) return;
    if (!d3ok()) {
      els.surface.innerHTML = `<div class="vault-gr-empty">Graph needs d3 — the vendored bundle did not load.</div>`;
      return;
    }
    try {
      await load();
    } catch (e) {
      els.surface.innerHTML = `<div class="vault-gr-empty">Could not load the graph (${bridge.esc(e.message)}).</div>`;
      return;
    }
    if (!data.nodes.length) {
      els.legend.innerHTML = "";
      world.selectAll("*").remove();
      els.surface.insertAdjacentHTML("beforeend", `<div class="vault-gr-empty">No notes yet — the vault is still young.</div>`);
      return;
    }
    const empty = els.surface.querySelector(".vault-gr-empty");
    if (empty) empty.remove();
    rebuild();   // startSim arms fitPending; the fit runs when the layout settles
  }

  // Called by the tab when a note is opened elsewhere, so local mode and the
  // selected ring follow the reading pane instead of drifting out of sync.
  function setSelected(slug) {
    selected = slug || null;
    if (!svg) return;
    syncControls();
    if (localHops > 0) rebuild(); else draw();
  }

  function init(b) {
    bridge = Object.assign(bridge, b || {});
    window.addEventListener("resize", () => {
      if (!svg || !simNodes.length) return;
      const { w, h } = size();
      if (sim) { sim.force("center", window.d3.forceCenter(w / 2, h / 2)); sim.alpha(0.15).restart(); }
    });
  }

  return { init, invalidate, render, setSelected };
})();
