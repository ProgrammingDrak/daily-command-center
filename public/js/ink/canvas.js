// Mycelium Ink — the writing surface.
//
// This file decides whether the app feels like a notebook or like a toy. Four
// things carry that weight, and all four are easy to leave out:
//
//  1. TWO CANVASES. Committed strokes live on a base canvas; the stroke under
//     the pen lives on a transparent one above it. Redrawing a full page on
//     every pointermove is what makes web ink lag once a page has real writing
//     on it. Here the live layer only ever holds one stroke.
//
//  2. COALESCED EVENTS. A pen samples far faster than the browser fires
//     pointermove. getCoalescedEvents() hands back the samples that were
//     dropped between frames; without it, fast strokes come out as visible
//     polygons instead of curves.
//
//  3. desynchronized: true. Lets the compositor skip a frame of latency.
//
//  4. PALM REJECTION. Once a pen has touched this canvas, touch stops drawing.
//     Without it you rest your hand and get a stripe across the page.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(null);
  else root.InkCanvas = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const S = (typeof module === "object" && module.exports)
    ? require("./strokes.js")
    : root.InkStrokes;

  const MAX_UNDO = 60;

  function create(opts) {
    const base = opts.base;
    const live = opts.live;
    const wrap = opts.wrap;
    const onChange = opts.onChange || function () {};

    // `desynchronized` is a hint, not a guarantee, and Safari ignores it on some
    // versions. Requesting it costs nothing where it is unsupported.
    const baseCtx = base.getContext("2d", { desynchronized: true });
    const liveCtx = live.getContext("2d", { desynchronized: true });

    const state = {
      page: S.emptyPage(),
      tool: "pen",
      color: "#1b1b2f",
      size: 2.6,
      eraserRadius: 12,
      scale: 1,
      penSeen: false,
      activePointer: null,
      current: null,
      undo: [],
      redo: [],
      dirty: false,
    };

    // ── geometry ─────────────────────────────────────────────────────────────

    function layout() {
      const rect = wrap.getBoundingClientRect();
      if (!rect.width) return;
      // Fit the page inside the viewport, never upscaling past 1:1 device pixels
      // so ink stays crisp instead of soft.
      const scale = Math.min(rect.width / state.page.w, rect.height / state.page.h);
      state.scale = scale;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cssW = state.page.w * scale;
      const cssH = state.page.h * scale;
      for (const c of [base, live]) {
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
      }
      // One transform means the rest of the code works in PAGE units and never
      // has to think about dpr or zoom again.
      const k = scale * dpr;
      baseCtx.setTransform(k, 0, 0, k, 0, 0);
      liveCtx.setTransform(k, 0, 0, k, 0, 0);
      redraw();
    }

    function toPage(ev) {
      const rect = base.getBoundingClientRect();
      return {
        x: (ev.clientX - rect.left) / state.scale,
        y: (ev.clientY - rect.top) / state.scale,
      };
    }

    // ── rendering ────────────────────────────────────────────────────────────

    function clear(ctx, canvas) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    function redraw() {
      clear(baseCtx, base);
      baseCtx.fillStyle = "#ffffff";
      baseCtx.fillRect(0, 0, state.page.w, state.page.h);
      for (const s of state.page.strokes) S.drawStroke(baseCtx, s, { scale: 1 });
    }

    function redrawLive() {
      clear(liveCtx, live);
      if (state.current) S.drawStroke(liveCtx, state.current, { scale: 1 });
    }

    // ── history ──────────────────────────────────────────────────────────────

    function pushUndo(entry) {
      state.undo.push(entry);
      if (state.undo.length > MAX_UNDO) state.undo.shift();
      state.redo.length = 0;
    }

    function undo() {
      const entry = state.undo.pop();
      if (!entry) return;
      if (entry.type === "add") {
        const i = state.page.strokes.indexOf(entry.stroke);
        if (i >= 0) state.page.strokes.splice(i, 1);
      } else if (entry.type === "erase") {
        // Reinsert at the original indices, ascending, so z-order is restored
        // exactly rather than the erased strokes jumping to the top.
        for (const item of entry.removed.slice().sort((a, b) => a.index - b.index)) {
          state.page.strokes.splice(Math.min(item.index, state.page.strokes.length), 0, item.stroke);
        }
      }
      state.redo.push(entry);
      redraw();
      changed();
    }

    function redo() {
      const entry = state.redo.pop();
      if (!entry) return;
      if (entry.type === "add") state.page.strokes.push(entry.stroke);
      else if (entry.type === "erase") {
        for (const item of entry.removed) {
          const i = state.page.strokes.indexOf(item.stroke);
          if (i >= 0) state.page.strokes.splice(i, 1);
        }
      }
      state.undo.push(entry);
      redraw();
      changed();
    }

    function changed() {
      state.dirty = true;
      onChange(state.page);
    }

    // ── input ────────────────────────────────────────────────────────────────

    // A finger is only allowed to draw until the first time a pen is used. After
    // that this canvas belongs to the pen and touch is for panning, which is what
    // lets you rest your hand while writing.
    function pointerDraws(ev) {
      if (ev.pointerType === "pen") return true;
      if (ev.pointerType === "mouse") return true;
      return !state.penSeen;
    }

    function onDown(ev) {
      if (ev.pointerType === "pen") state.penSeen = true;
      if (!pointerDraws(ev)) return;
      if (state.activePointer !== null) return;
      // A pen's barrel button and an inverted stylus both mean erase.
      const erasing = state.tool === "eraser" || ev.button === 5 || ev.buttons === 32;

      state.activePointer = ev.pointerId;
      base.setPointerCapture(ev.pointerId);
      ev.preventDefault();

      const p = toPage(ev);
      if (erasing) {
        state.current = null;
        state.erasing = { removed: [] };
        eraseAt(p.x, p.y);
      } else {
        state.erasing = null;
        state.current = S.newStroke(state.tool, state.color, state.size);
        S.addPoint(state.current, p.x, p.y, ev.pressure, 0);
        redrawLive();
      }
    }

    function onMove(ev) {
      if (ev.pointerId !== state.activePointer) return;
      ev.preventDefault();

      // Coalesced events are the difference between a curve and a polygon.
      const events = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [ev];
      const samples = events.length ? events : [ev];

      if (state.erasing) {
        for (const e of samples) {
          const p = toPage(e);
          eraseAt(p.x, p.y);
        }
        return;
      }
      if (!state.current) return;
      let added = false;
      for (const e of samples) {
        const p = toPage(e);
        if (S.addPoint(state.current, p.x, p.y, e.pressure)) added = true;
      }
      if (added) redrawLive();
    }

    function onUp(ev) {
      if (ev.pointerId !== state.activePointer) return;
      state.activePointer = null;
      try { base.releasePointerCapture(ev.pointerId); } catch { /* already released */ }

      if (state.erasing) {
        if (state.erasing.removed.length) {
          pushUndo({ type: "erase", removed: state.erasing.removed });
          changed();
        }
        state.erasing = null;
        return;
      }
      if (!state.current) return;
      const stroke = state.current;
      state.current = null;
      clear(liveCtx, live);
      if (S.pointCount(stroke) === 0) return;

      state.page.strokes.push(stroke);
      pushUndo({ type: "add", stroke });
      // Only the new stroke is painted onto the base layer. A full redraw here
      // would stall for a moment on a dense page, right as you lift the pen.
      S.drawStroke(baseCtx, stroke, { scale: 1 });
      changed();
    }

    function eraseAt(x, y) {
      const out = S.eraseAt(state.page.strokes, x, y, state.eraserRadius);
      if (!out.removed.length) return;
      state.page.strokes = out.strokes;
      state.erasing.removed.push(...out.removed);
      redraw();
    }

    function onCancel(ev) {
      if (ev.pointerId !== state.activePointer) return;
      // A cancelled pointer (a system gesture, a call coming in) must not leave
      // half a stroke behind.
      state.activePointer = null;
      state.current = null;
      state.erasing = null;
      clear(liveCtx, live);
    }

    base.addEventListener("pointerdown", onDown);
    base.addEventListener("pointermove", onMove);
    base.addEventListener("pointerup", onUp);
    base.addEventListener("pointercancel", onCancel);
    base.addEventListener("pointerleave", onUp);
    base.addEventListener("contextmenu", (e) => e.preventDefault());

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 120);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    // ── public ───────────────────────────────────────────────────────────────

    return {
      state,
      layout,
      redraw,
      undo,
      redo,
      canUndo: () => state.undo.length > 0,
      canRedo: () => state.redo.length > 0,
      setTool(tool) { state.tool = tool; },
      setColor(color) { state.color = color; },
      setSize(size) { state.size = Number(size) || 2.6; },
      getPage: () => state.page,
      isDirty: () => state.dirty,
      clearDirty() { state.dirty = false; },
      loadPage(page) {
        state.page = page || S.emptyPage();
        state.undo.length = 0;
        state.redo.length = 0;
        state.current = null;
        state.dirty = false;
        clear(liveCtx, live);
        layout();
      },
      // Full-resolution render for upload and OCR, independent of how the page
      // happens to be displayed right now.
      renderToCanvas(targetScale) {
        const scale = targetScale || 1;
        const c = document.createElement("canvas");
        c.width = Math.round(state.page.w * scale);
        c.height = Math.round(state.page.h * scale);
        const ctx = c.getContext("2d");
        S.drawPage(ctx, state.page, { scale, background: "#ffffff" });
        return c;
      },
      destroy() {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
      },
    };
  }

  return { create };
});
