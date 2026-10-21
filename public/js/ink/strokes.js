// Mycelium Ink — the stroke format and how it draws.
//
// This file is the durable artifact of the whole project. A page is a list of
// strokes, and this is the ONE place that defines what a stroke is and how it
// becomes ink on a canvas. Both the live canvas and the render-for-upload path
// call these functions, so a page can never look one way while you draw it and
// another way in the vault.
//
// WHY OUR OWN FORMAT. The Apple-only version of this stored PKDrawing blobs, an
// undocumented format that only Apple can read and only on Apple hardware. For
// a vault meant to outlive the app, an open format you can read in a text editor
// twenty years from now is worth more than a few saved kilobytes.
//
// SHAPE (v1):
//   { v: 1, w: <page width>, h: <page height>, strokes: [Stroke], paper?: {...} }
//   Stroke = { tool, color, size, pts: [x, y, pressure, ...], style?: {v:2,angle} }
//
// Points are FLAT, not objects. A dense page runs to a few thousand points, and
// [x,y,p,x,y,p] costs a fraction of [{x,y,p},{x,y,p}] in JSON and gzips better.
// Coordinates are page units, never device pixels, so a page drawn on a phone
// renders identically on a desktop.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkStrokes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT_VERSION = 1;

  // US Letter at 150dpi. Fixed pages, deliberately: a page with edges renders
  // predictably for OCR and maps to exactly one section in the markdown note.
  const PAGE_W = 1275;
  const PAGE_H = 1650;

  // Shared limits. The vault validator and the toolbar read these, so a range
  // widened here cannot produce pages the server then rejects.
  const PAPER_SPACING = { min: 4, max: 12 };
  const NIB_ANGLE = { min: 0, max: 170, default: 45 };

  const TOOLS = {
    ballpoint: { label: "Ballpoint", sizes: [1.8, 3, 5], minRatio: 0.8, alpha: 1, cap: "round", composite: "source-over" },
    fineliner: { label: "Fineliner", sizes: [1, 2, 3.5], minRatio: 1, alpha: 1, cap: "round", composite: "source-over" },
    fountain: { label: "Fountain pen", sizes: [2.5, 5, 8], minRatio: 0.35, nib: true, alpha: 1, cap: "round", composite: "source-over" },
    pencil: { label: "Graphite pencil", sizes: [2.5, 5, 10], minRatio: 0.3, graphite: true, alpha: 1, cap: "round", composite: "source-over" },
    mechanical: { label: "Mechanical pencil", sizes: [1, 1.8, 2.8], minRatio: 1, graphite: true, alpha: 1, cap: "round", composite: "source-over" },
    marker: { label: "Marker", sizes: [8, 16, 28], minRatio: 0.9, nib: true, alpha: 1, cap: "square", composite: "source-over" },
    brush: { label: "Brush pen", sizes: [5, 12, 24], minRatio: 0.08, curve: 1.8, alpha: 1, cap: "round", composite: "source-over" },
    calligraphy: { label: "Calligraphy", sizes: [4, 8, 14], minRatio: 1, nib: true, alpha: 1, cap: "round", composite: "source-over" },
    pen: { minRatio: 0.35, alpha: 1, cap: "round", composite: "source-over" },
    // A highlighter keeps one width and multiplies, so overlaps darken the way
    // a real one does instead of building up opaque bands.
    highlighter: { label: "Highlighter", sizes: [14, 24, 38], minRatio: 1, alpha: 0.32, cap: "butt", composite: "multiply" },
  };

  function toolSpec(tool) {
    return Object.prototype.hasOwnProperty.call(TOOLS, tool) ? TOOLS[tool] : TOOLS.pen;
  }

  function emptyPage(w, h) {
    return { v: FORMAT_VERSION, w: w || PAGE_W, h: h || PAGE_H, strokes: [] };
  }

  // Devices disagree about pressure. A mouse reports 0, a finger usually 0, and
  // pens report 0..1. Treating a real 0 as "no pressure" would make finger and
  // mouse ink vanish, so anything non-positive becomes a neutral mid-pressure.
  function normalizePressure(raw) {
    const p = Number(raw);
    if (!isFinite(p) || p <= 0) return 0.5;
    return p > 1 ? 1 : p;
  }

  // Width from pressure. A pen tapers toward its minRatio at the lightest touch;
  // a highlighter ignores pressure entirely.
  function widthAt(stroke, pressure) {
    const spec = toolSpec(stroke.tool);
    const size = Number(stroke.size) || 2.5;
    if (spec.minRatio >= 1) return size;
    return size * (spec.minRatio + (1 - spec.minRatio) * Math.pow(normalizePressure(pressure), spec.curve || 1));
  }

  function pointCount(stroke) {
    return stroke && stroke.pts ? Math.floor(stroke.pts.length / 3) : 0;
  }

  function pointAt(stroke, i) {
    const k = i * 3;
    return { x: stroke.pts[k], y: stroke.pts[k + 1], p: stroke.pts[k + 2] };
  }

  // Keep the file small without visibly degrading the line. Two decimals is
  // sub-pixel at any sane zoom.
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function newStroke(tool, color, size, style) {
    const stroke = { tool: tool || "pen", color: color || "#1b1b2f", size: Number(size) || 2.5, pts: [] };
    // Optional appearance settings are captured once, never borrowed from UI state.
    // Legacy strokes without this field keep their original rendering.
    if (style) stroke.style = { v: 2, angle: Number.isFinite(Number(style.angle)) ? Math.max(NIB_ANGLE.min, Math.min(NIB_ANGLE.max, Number(style.angle))) : NIB_ANGLE.default };
    return stroke;
  }

  // Drop points that land essentially on top of the previous one. Pointer events
  // fire far faster than a hand moves, and the duplicates cost bytes while adding
  // nothing. The threshold is deliberately small so genuine slow, deliberate
  // strokes keep their detail.
  function addPoint(stroke, x, y, pressure, minDist) {
    const gap = minDist == null ? 0.6 : minDist;
    const n = pointCount(stroke);
    if (n > 0) {
      const last = pointAt(stroke, n - 1);
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < gap * gap) return false;
    }
    stroke.pts.push(round2(x), round2(y), Math.round(normalizePressure(pressure) * 100) / 100);
    return true;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  //
  // Smoothing uses the midpoint technique: each segment is a quadratic curve
  // from the midpoint of the previous pair to the midpoint of the next, with the
  // shared point as the control. That turns a polyline of sampled points into a
  // continuous curve with no corner artifacts.
  //
  // Each segment is stroked SEPARATELY so its width can follow pressure. One
  // long path with a single lineWidth would be cheaper but would draw dead,
  // uniform ink, which is the main thing that makes web ink feel like a toy.

  // `opts.from` resumes partway through a stroke, so a caller that has already
  // painted the first N points can append only what is new. Redrawing a whole
  // stroke on every pointer sample is O(n^2) over the stroke -- a 900-point
  // stroke costs 101,700 segment draws -- and it gets slower the longer the
  // stroke gets, which is exactly backwards.
  // opts.to is an exclusive segment boundary for a finalized prefix; omitting
  // it draws through the provisional endpoint, as before.
  const masks = new WeakMap();
  function modernStroke(stroke) { return !!(stroke.style && stroke.style.v === 2); }
  function modernHighlight(stroke) { return stroke.tool === "highlighter" && stroke.style && stroke.style.v === 2; }
  // Device-pixel box the stroke can touch, so the scratch layer is cleared and
  // composited only there instead of across the whole canvas. Every modern
  // stroke keeps the layer, even opaque ones: it matches the raster copied at
  // lift, so a later redraw cannot shift antialiased edges.
  function strokeBounds(stroke, scale, m, width, height) {
    const n = pointCount(stroke);
    if (!n) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = stroke.pts[i * 3], y = stroke.pts[i * 3 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // Widths never exceed the stroke size; graphite grain stays within 0.6x.
    const pad = (Number(stroke.size) || 2.5) + 2;
    x0 = (x0 - pad) * scale; y0 = (y0 - pad) * scale; x1 = (x1 + pad) * scale; y1 = (y1 + pad) * scale;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const dx = m.a * x + m.c * y + m.e, dy = m.b * x + m.d * y + m.f;
      if (dx < bx0) bx0 = dx; if (dx > bx1) bx1 = dx;
      if (dy < by0) by0 = dy; if (dy > by1) by1 = dy;
    }
    bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0));
    bx1 = Math.min(width, Math.ceil(bx1)); by1 = Math.min(height, Math.ceil(by1));
    if (bx1 <= bx0 || by1 <= by0) return null;
    return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  }
  function drawStroke(ctx, stroke, opts) {
    // New styles share the transparent-layer rendering used during input.
    // Highlighter gets one translucent multiply composite per coverage mask,
    // so overlapping samples cannot leave dark dots. Graphite opacity is also
    // applied once. Reuse scratch canvases; input uses its existing prefix.
    if (modernStroke(stroke) && !(opts && opts.mask)) {
      let mask = masks.get(ctx);
      if (!mask) {
        const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
        mask = { canvas, ctx: canvas.getContext("2d") };
        masks.set(ctx, mask);
      }
      const c = mask.canvas;
      if (c.width !== ctx.canvas.width || c.height !== ctx.canvas.height) {
        c.width = ctx.canvas.width; c.height = ctx.canvas.height;
      }
      const m = ctx.getTransform();
      const box = strokeBounds(stroke, (opts && opts.scale) || 1, m, c.width, c.height);
      if (!box) return;
      mask.ctx.setTransform(1, 0, 0, 1, 0, 0);
      mask.ctx.clearRect(box.x, box.y, box.w, box.h);
      mask.ctx.setTransform(m);
      drawStroke(mask.ctx, stroke, { ...opts, mask: true });
      compositeStroke(ctx, c, stroke, box);
      return;
    }
    const n = pointCount(stroke);
    if (!n) return;
    const spec = toolSpec(stroke.tool);
    const scale = (opts && opts.scale) || 1;
    const from = Math.max(1, Math.min((opts && opts.from) || 1, Math.max(1, n - 1)));
    const to = Math.min(n, opts && opts.to != null ? opts.to : n);

    ctx.save();
    ctx.globalAlpha = opts && opts.mask ? 1 : spec.alpha;
    ctx.globalCompositeOperation = opts && opts.mask ? "source-over" : spec.composite;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = modernHighlight(stroke) ? "round" : spec.cap;
    ctx.lineJoin = "round";

    // A single tap is a dot, not a line. Without this a quick period or the dot
    // on an "i" leaves nothing behind.
    if (n === 1) {
      const p = pointAt(stroke, 0);
      if (spec.graphite) ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, (widthAt(stroke, p.p) * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (n === 2) {
      const a = pointAt(stroke, 0);
      const b = pointAt(stroke, 1);
      ctx.lineWidth = segmentWidth(stroke, b.p, a, b) * scale;
      if (spec.graphite) ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // The incoming midpoint for segment `from` is the one between it and the
    // point before it, which is what makes a resumed draw join seamlessly onto
    // what is already on the canvas.
    let prev = pointAt(stroke, from - 1);
    let mid = midpoint(prev, pointAt(stroke, from));
    for (let i = from; i < to; i++) {
      const cur = pointAt(stroke, i);
      const nextMid = i + 1 < n ? midpoint(cur, pointAt(stroke, i + 1)) : cur;
      ctx.lineWidth = segmentWidth(stroke, cur.p, mid, nextMid) * scale;
      if (spec.graphite) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; }
      ctx.beginPath();
      ctx.moveTo(mid.x * scale, mid.y * scale);
      ctx.quadraticCurveTo(cur.x * scale, cur.y * scale, nextMid.x * scale, nextMid.y * scale);
      ctx.stroke();
      if (spec.graphite) {
        // Deterministic graphite flecks, derived from point coordinates rather
        // than random state. Reload, incremental rendering and export agree.
        ctx.globalAlpha = 0.15 + (1 - cur.p) * 0.65;
        ctx.globalCompositeOperation = "destination-out";
        for (let grain = 0; grain < 3; grain++) {
          const seed = Math.sin(cur.x * 12.9898 + cur.y * 78.233 + grain * 23.1) * 43758.5453;
          const fraction = seed - Math.floor(seed);
          const radius = widthAt(stroke, cur.p) * 0.6;
          ctx.beginPath();
          ctx.arc((cur.x + (fraction - 0.5) * radius) * scale,
            (cur.y + (grain - 1) * radius * 0.35) * scale, Math.max(0.15, radius * 0.09) * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      mid = nextMid;
      prev = cur;
    }
    ctx.restore();
  }

  function segmentWidth(stroke, pressure, a, b) {
    const spec = toolSpec(stroke.tool);
    const width = widthAt(stroke, pressure);
    if (!spec.nib) return width;
    const angle = (stroke.style && Number.isFinite(stroke.style.angle) ? stroke.style.angle : 45) * Math.PI / 180;
    const direction = Math.atan2(b.y - a.y, b.x - a.x);
    const minimum = stroke.tool === "marker" ? 0.65 : 0.3;
    return width * (minimum + (1 - minimum) * Math.abs(Math.sin(direction - angle)));
  }

  // `box` limits the copy to a device-pixel region; omit it to copy everything.
  function compositeStroke(ctx, canvas, stroke, box) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = modernHighlight(stroke) ? toolSpec(stroke.tool).alpha : toolSpec(stroke.tool).graphite ? 0.7 : 1;
    ctx.globalCompositeOperation = modernHighlight(stroke) ? "multiply" : "source-over";
    if (box) ctx.drawImage(canvas, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
    else ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function drawPage(ctx, page, opts) {
    const o = opts || {};
    const scale = o.scale || 1;
    if (o.background !== false) {
      ctx.save();
      drawPaper(ctx, page, { scale, background: o.background });
      ctx.restore();
    }
    const strokes = page.strokes || [];
    for (let i = 0; i < strokes.length; i++) drawStroke(ctx, strokes[i], { scale });
  }

  const PAPERS = [
    { id: "blank", label: "Blank", spacing: 7 },
    { id: "ruled-narrow", label: "Narrow ruled", spacing: 6, usesSpacing: true },
    { id: "ruled", label: "College ruled", spacing: 7, usesSpacing: true },
    { id: "ruled-wide", label: "Wide ruled", spacing: 9, usesSpacing: true },
    { id: "dots", label: "Dot grid", spacing: 5, usesSpacing: true },
    { id: "grid", label: "Square grid", spacing: 5, usesSpacing: true },
    { id: "engineering", label: "Engineering grid", spacing: 5, usesSpacing: true },
    { id: "cornell", label: "Cornell notes", spacing: 7, usesSpacing: true },
    { id: "music", label: "Music staff", spacing: 7, usesSpacing: true },
    { id: "checklist", label: "Checklist", spacing: 9, usesSpacing: true },
    { id: "daily", label: "Daily planner", spacing: 7 },
    { id: "weekly", label: "Weekly planner", spacing: 7 },
    { id: "monthly", label: "Monthly planner", spacing: 7 },
    { id: "handwriting", label: "Handwriting practice", spacing: 9, usesSpacing: true },
    { id: "isometric", label: "Isometric grid", spacing: 5, usesSpacing: true },
  ];
  const TINTS = { white: "#ffffff", cream: "#fff9eb", gray: "#f0f2f4" };
  function normalizePaper(raw) {
    const r = raw || {};
    const preset = PAPERS.find(p => p.id === r.type) || PAPERS[0];
    return { type: preset.id, tint: Object.prototype.hasOwnProperty.call(TINTS, r.tint) ? r.tint : "white",
      spacing: Math.min(PAPER_SPACING.max, Math.max(PAPER_SPACING.min, Number(r.spacing) || preset.spacing)), margin: r.margin !== false };
  }

  // One procedural renderer for actual paper, picker thumbnails and vault images.
  // Paper remains metadata beneath editable ink; it never becomes erasable strokes.
  function drawPaper(ctx, page, opts) {
    const o = opts || {}, k = o.scale || 1;
    const p = normalizePaper(page.paper), w = page.w, h = page.h;
    const gap = p.spacing * 150 / 25.4, m = w * 0.075, top = h * 0.075;
    ctx.save();
    ctx.fillStyle = page.paper ? TINTS[p.tint] : o.background || "#ffffff";
    ctx.fillRect(0, 0, w * k, h * k);
    if (p.type === "blank") { ctx.restore(); return; }
    ctx.strokeStyle = "#b6c3cf"; ctx.fillStyle = "#6d7f90"; ctx.lineWidth = 0.9 * k;
    ctx.globalAlpha = 0.65;
    function line(x, y, x2, y2) {
      ctx.beginPath(); ctx.moveTo(x * k, y * k); ctx.lineTo(x2 * k, y2 * k); ctx.stroke();
    }
    function box(x, y, bw, bh) {
      line(x, y, x + bw, y); line(x + bw, y, x + bw, y + bh);
      line(x + bw, y + bh, x, y + bh); line(x, y + bh, x, y);
    }
    function label(text, x, y, size = 18) {
      ctx.font = `${size * k}px system-ui, sans-serif`; ctx.globalAlpha = 0.8;
      ctx.fillText(text, x * k, y * k); ctx.globalAlpha = 0.65;
    }
    function ruled(left = m, right = w - m, start = top, end = h - m) {
      for (let y = start; y < end; y += gap) line(left, y, right, y);
    }
    if (p.type.startsWith("ruled")) {
      ruled();
      if (p.margin) { ctx.strokeStyle = "#dca5aa"; line(w * 0.15, top / 2, w * 0.15, h - m); }
    } else if (["grid", "engineering", "dots", "isometric"].includes(p.type)) {
      if (p.type === "dots" || p.type === "isometric") {
        const rowGap = p.type === "isometric" ? gap * Math.sqrt(3) / 2 : gap;
        let row = 0;
        for (let y = top; y < h - m; y += rowGap, row++) {
          for (let x = m + (p.type === "isometric" && row % 2 ? gap / 2 : 0); x < w - m; x += gap) {
            ctx.beginPath(); ctx.arc(x * k, y * k, 1.25 * k, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else {
        let i = 0;
        for (let x = m; x < w - m; x += gap, i++) {
          ctx.globalAlpha = p.type === "engineering" && i % 5 === 0 ? 0.8 : 0.4; line(x, top, x, h - m);
        }
        i = 0;
        for (let y = top; y < h - m; y += gap, i++) {
          ctx.globalAlpha = p.type === "engineering" && i % 5 === 0 ? 0.8 : 0.4; line(m, y, w - m, y);
        }
      }
    } else if (p.type === "cornell") {
      label("TOPIC / DATE", m, top * 0.7);
      const split = w * 0.3, summary = h * 0.8;
      line(m, top, w - m, top); line(split, top, split, summary); line(m, summary, w - m, summary);
      ruled(split + gap / 2, w - m, top + gap, summary - gap / 2);
      label("CUES", m, top + gap); label("SUMMARY", m, summary + gap);
    } else if (p.type === "music") {
      for (let y = top; y < h - m - gap * 2; y += gap * 5) {
        for (let i = 0; i < 5; i++) line(m, y + i * gap / 4, w - m, y + i * gap / 4);
      }
    } else if (p.type === "checklist") {
      label("TO DO", m, top * 0.7);
      for (let y = top + gap; y < h - m; y += gap) { box(m, y - gap * 0.35, gap * 0.28, gap * 0.28); line(m + gap * 0.7, y, w - m, y); }
    } else if (p.type === "handwriting") {
      for (let y = top; y < h - m - gap; y += gap * 1.8) {
        line(m, y, w - m, y); line(m, y + gap, w - m, y + gap);
        ctx.setLineDash([5 * k, 6 * k]); line(m, y + gap / 2, w - m, y + gap / 2); ctx.setLineDash([]);
      }
    } else if (p.type === "daily") {
      label("DATE", m, top * 0.7);
      label("SCHEDULE", m, top + gap); label("PRIORITIES / NOTES", w * 0.55, top + gap);
      const row = (h * 0.8 - top) / 13;
      for (let i = 0; i <= 12; i++) {
        const y = top + gap * 2 + i * row;
        label(`${String(i + 7).padStart(2, "0")}:00`, m, y - 8, 16);
        line(m + 65, y, w * 0.48, y); line(w * 0.55, y, w - m, y);
      }
      label("TODAY'S REFLECTION", m, h * 0.9);
    } else if (p.type === "weekly") {
      label("WEEK OF", m, top * 0.7);
      const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY", "NOTES"];
      const bw = (w - 2 * m) / 2, bh = (h - top - m) / 4;
      days.forEach((day, i) => { const x = m + (i % 2) * bw, y = top + Math.floor(i / 2) * bh;
        box(x, y, bw, bh); label(day, x + 18, y + 30); });
    } else if (p.type === "monthly") {
      label("MONTH / YEAR", m, top * 0.7);
      const bw = (w - 2 * m) / 7, bh = (h * 0.72 - top) / 6;
      ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].forEach((day, i) => label(day, m + i * bw + 12, top + 24, 16));
      for (let row = 0; row < 6; row++) for (let col = 0; col < 7; col++) box(m + col * bw, top + 40 + row * bh, bw, bh);
      label("NOTES", m, h * 0.82); ruled(m, w - m, h * 0.85, h - m);
    }
    ctx.restore();
  }

  // ── Erasing ────────────────────────────────────────────────────────────────
  //
  // Whole-stroke erase, not pixel erase. It keeps the format vector-clean (a
  // pixel eraser would force us to store a raster mask and lose the ability to
  // re-render at any size), and it matches how erasing a pen line actually
  // behaves: the line goes, not a bite out of it.

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + t * vx);
    const dy = py - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // True when the eraser circle touches the stroke's ink, accounting for the
  // stroke's own half-width so a fat line is hit as easily as it looks.
  function strokeHit(stroke, x, y, radius) {
    const n = pointCount(stroke);
    if (!n) return false;
    const half = (Number(stroke.size) || 2.5) / 2;
    if (n === 1) {
      const p = pointAt(stroke, 0);
      return Math.hypot(p.x - x, p.y - y) <= radius + half;
    }
    for (let i = 1; i < n; i++) {
      const a = pointAt(stroke, i - 1);
      const b = pointAt(stroke, i);
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= radius + half) return true;
    }
    return false;
  }

  // Returns a NEW strokes array plus what was removed, so undo can put them back
  // without the caller tracking indices.
  function eraseAt(strokes, x, y, radius) {
    const kept = [];
    const removed = [];
    for (let i = 0; i < strokes.length; i++) {
      if (strokeHit(strokes[i], x, y, radius)) removed.push({ index: i, stroke: strokes[i] });
      else kept.push(strokes[i]);
    }
    return { strokes: kept, removed };
  }

  // ── Bounds, for the OCR ink-coverage check and for trimming ─────────────────

  function pageBounds(page) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const strokes = page.strokes || [];
    for (const stroke of strokes) {
      const n = pointCount(stroke);
      const half = (Number(stroke.size) || 2.5) / 2;
      for (let i = 0; i < n; i++) {
        const p = pointAt(stroke, i);
        if (p.x - half < minX) minX = p.x - half;
        if (p.y - half < minY) minY = p.y - half;
        if (p.x + half > maxX) maxX = p.x + half;
        if (p.y + half > maxY) maxY = p.y + half;
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function isBlank(page) {
    return !page || !page.strokes || page.strokes.length === 0;
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  function serialize(page) {
    return JSON.stringify({ v: FORMAT_VERSION, w: page.w, h: page.h, ...(page.paper ? { paper: normalizePaper(page.paper) } : {}), strokes: page.strokes || [] });
  }

  // Total by design: anything unreadable becomes a blank page rather than an
  // exception. A corrupt local record must never make the notebook unopenable.
  function deserialize(text, fallbackW, fallbackH) {
    try {
      const raw = typeof text === "string" ? JSON.parse(text) : text;
      if (!raw || typeof raw !== "object") return emptyPage(fallbackW, fallbackH);
      const strokes = Array.isArray(raw.strokes) ? raw.strokes.filter(validStroke) : [];
      return { v: FORMAT_VERSION, w: Number(raw.w) || fallbackW || PAGE_W, h: Number(raw.h) || fallbackH || PAGE_H, ...(raw.paper ? { paper: normalizePaper(raw.paper) } : {}), strokes };
    } catch {
      return emptyPage(fallbackW, fallbackH);
    }
  }

  function validStroke(s) {
    return !!s && Array.isArray(s.pts) && s.pts.length >= 3 && s.pts.length % 3 === 0
      && s.pts.every((n) => typeof n === "number" && isFinite(n));
  }

  return {
    FORMAT_VERSION, PAGE_W, PAGE_H, PAPER_SPACING, NIB_ANGLE, TOOLS, PAPERS, TINTS, normalizePaper, drawPaper, modernStroke, modernHighlight, compositeStroke,
    emptyPage, newStroke, addPoint, pointCount, pointAt,
    normalizePressure, widthAt, toolSpec,
    drawStroke, drawPage,
    eraseAt, strokeHit, distanceToSegment,
    pageBounds, isBlank,
    serialize, deserialize, validStroke,
  };
});
