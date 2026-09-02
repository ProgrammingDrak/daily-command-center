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
//   { v: 1, w: <page width>, h: <page height>, strokes: [Stroke] }
//   Stroke = { tool, color, size, pts: [x, y, pressure, x, y, pressure, ...] }
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

  const TOOLS = {
    pen: { minRatio: 0.35, alpha: 1, cap: "round", composite: "source-over" },
    // A highlighter keeps one width and multiplies, so overlaps darken the way
    // a real one does instead of building up opaque bands.
    highlighter: { minRatio: 1, alpha: 0.32, cap: "butt", composite: "multiply" },
  };

  function toolSpec(tool) {
    return TOOLS[tool] || TOOLS.pen;
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
    return size * (spec.minRatio + (1 - spec.minRatio) * normalizePressure(pressure));
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

  function newStroke(tool, color, size) {
    return { tool: tool || "pen", color: color || "#1b1b2f", size: Number(size) || 2.5, pts: [] };
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

  function drawStroke(ctx, stroke, opts) {
    const n = pointCount(stroke);
    if (!n) return;
    const spec = toolSpec(stroke.tool);
    const scale = (opts && opts.scale) || 1;

    ctx.save();
    ctx.globalAlpha = spec.alpha;
    ctx.globalCompositeOperation = spec.composite;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = spec.cap;
    ctx.lineJoin = "round";

    // A single tap is a dot, not a line. Without this a quick period or the dot
    // on an "i" leaves nothing behind.
    if (n === 1) {
      const p = pointAt(stroke, 0);
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, (widthAt(stroke, p.p) * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (n === 2) {
      const a = pointAt(stroke, 0);
      const b = pointAt(stroke, 1);
      ctx.lineWidth = widthAt(stroke, b.p) * scale;
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
      ctx.restore();
      return;
    }

    let prev = pointAt(stroke, 0);
    let mid = midpoint(prev, pointAt(stroke, 1));
    for (let i = 1; i < n; i++) {
      const cur = pointAt(stroke, i);
      const nextMid = i + 1 < n ? midpoint(cur, pointAt(stroke, i + 1)) : cur;
      ctx.lineWidth = widthAt(stroke, cur.p) * scale;
      ctx.beginPath();
      ctx.moveTo(mid.x * scale, mid.y * scale);
      ctx.quadraticCurveTo(cur.x * scale, cur.y * scale, nextMid.x * scale, nextMid.y * scale);
      ctx.stroke();
      mid = nextMid;
      prev = cur;
    }
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
      ctx.fillStyle = o.background || "#ffffff";
      ctx.fillRect(0, 0, page.w * scale, page.h * scale);
      ctx.restore();
    }
    const strokes = page.strokes || [];
    for (let i = 0; i < strokes.length; i++) drawStroke(ctx, strokes[i], { scale });
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
    return JSON.stringify({ v: FORMAT_VERSION, w: page.w, h: page.h, strokes: page.strokes || [] });
  }

  // Total by design: anything unreadable becomes a blank page rather than an
  // exception. A corrupt local record must never make the notebook unopenable.
  function deserialize(text, fallbackW, fallbackH) {
    try {
      const raw = typeof text === "string" ? JSON.parse(text) : text;
      if (!raw || typeof raw !== "object") return emptyPage(fallbackW, fallbackH);
      const strokes = Array.isArray(raw.strokes) ? raw.strokes.filter(validStroke) : [];
      return { v: FORMAT_VERSION, w: Number(raw.w) || fallbackW || PAGE_W, h: Number(raw.h) || fallbackH || PAGE_H, strokes };
    } catch {
      return emptyPage(fallbackW, fallbackH);
    }
  }

  function validStroke(s) {
    return !!s && Array.isArray(s.pts) && s.pts.length >= 3 && s.pts.length % 3 === 0
      && s.pts.every((n) => typeof n === "number" && isFinite(n));
  }

  return {
    FORMAT_VERSION, PAGE_W, PAGE_H, TOOLS,
    emptyPage, newStroke, addPoint, pointCount, pointAt,
    normalizePressure, widthAt, toolSpec,
    drawStroke, drawPage,
    eraseAt, strokeHit, distanceToSegment,
    pageBounds, isBlank,
    serialize, deserialize, validStroke,
  };
});
