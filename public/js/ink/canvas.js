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
    // versions. Keep the live layer synchronized: it is a drawImage source, and
    // desynchronized buffers can expose stale pixels during rapid copy/clear.
    const baseCtx = base.getContext("2d", { desynchronized: true });
    const liveCtx = live.getContext("2d");
    // Finalized segments of the current pen stroke. Only its last segment can
    // still change shape; keeping that tail separate avoids painting over stale
    // endpoints and makes the live pixels match the durable vector rendering.
    const prefix = document.createElement("canvas");
    const prefixCtx = prefix.getContext("2d");
    let finalized = 0;

    const state = {
      page: S.emptyPage(),
      tool: "pen",
      color: "#1b1b2f",
      size: 2.6,
      eraserRadius: 12,
      scale: 1,
      penSeen: false,
      activePointer: null,
      activePointerType: null,
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
      for (const c of [base, live, prefix]) {
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
      prefixCtx.setTransform(k, 0, 0, k, 0, 0);
      finalized = 0;
      redraw();
      redrawLive();
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

    // A new stroke or layout invalidates both live pixels and the stable prefix.
    function clearLive() {
      clear(liveCtx, live);
      clear(prefixCtx, prefix);
      finalized = 0;
    }

    function redrawLive(append) {
      const spec = state.current ? S.toolSpec(state.current.tool) : null;
      if (!append) clearLive();
      else clear(liveCtx, live);
      if (!state.current) return;
      const n = S.pointCount(state.current);
      if (spec.alpha >= 1 && n >= 3) {
        if (finalized < n - 2) {
          S.drawStroke(prefixCtx, state.current, { scale: 1, from: finalized + 1, to: n - 1 });
          finalized = n - 2;
        }
        liveCtx.save();
        liveCtx.setTransform(1, 0, 0, 1, 0, 0);
        liveCtx.drawImage(prefix, 0, 0);
        liveCtx.restore();
        S.drawStroke(liveCtx, state.current, { scale: 1, from: n - 1 });
      } else {
        S.drawStroke(liveCtx, state.current, { scale: 1 });
      }
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
      // Even rejected palm contacts must not start a native selection gesture.
      ev.preventDefault();
      if (ev.pointerType === "pen") state.penSeen = true;
      // A resting palm can arrive before the first Pencil event. Let the pen
      // take over that provisional touch rather than waiting for the palm up.
      if (ev.pointerType === "pen" && state.activePointerType === "touch") {
        onCancel({ pointerId: state.activePointer });
      }
      if (!pointerDraws(ev)) return;
      if (state.activePointer !== null) return;
      // A pen's barrel button and an inverted stylus both mean erase.
      const erasing = state.tool === "eraser" || ev.button === 5 || ev.buttons === 32;

      state.activePointer = ev.pointerId;
      state.activePointerType = ev.pointerType;
      try { base.setPointerCapture(ev.pointerId); }
      catch {
        state.activePointer = null;
        state.activePointerType = null;
        return;
      }

      const p = toPage(ev);
      if (erasing) {
        state.current = null;
        state.erasing = { removed: [], original: state.page.strokes.slice() };
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
      if (added) redrawLive(true);
    }

    function onUp(ev) {
      if (ev.pointerId !== state.activePointer) return;
      state.activePointer = null;
      state.activePointerType = null;
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
      if (S.pointCount(stroke) === 0) { clearLive(); return; }

      state.page.strokes.push(stroke);
      pushUndo({ type: "add", stroke });
      // The opaque ink is already rasterized. Replaying every pressure segment
      // here blocks the next pointerdown, especially after a long Pencil stroke.
      // Copy in device pixels, without applying the page transform a second time.
      // Highlighter segments multiply individually, so keep their vector replay:
      // flattening them first would change overlaps on existing colored ink.
      if (S.toolSpec(stroke.tool).alpha >= 1) {
        baseCtx.save();
        baseCtx.setTransform(1, 0, 0, 1, 0, 0);
        baseCtx.globalAlpha = 1;
        baseCtx.globalCompositeOperation = "source-over";
        baseCtx.drawImage(live, 0, 0);
        baseCtx.restore();
      } else {
        S.drawStroke(baseCtx, stroke, { scale: 1 });
      }
      clearLive();
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
      state.activePointerType = null;
      try { base.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      state.current = null;
      // Erasing updates the base immediately. Roll those provisional removals
      // back if a palm is preempted or the browser cancels the gesture.
      if (state.erasing && state.erasing.removed.length) {
        state.page.strokes = state.erasing.original;
        redraw();
      }
      state.erasing = null;
      clearLive();
    }

    base.addEventListener("pointerdown", onDown);
    base.addEventListener("pointermove", onMove);
    base.addEventListener("pointerup", onUp);
    base.addEventListener("pointercancel", onCancel);
    // Leaving the canvas while captured is still the same stroke. An unexpected
    // capture loss must finish it, however, or activePointer blocks the next one.
    base.addEventListener("pointerleave", (ev) => {
      if (!base.hasPointerCapture(ev.pointerId)) onUp(ev);
    });
    base.addEventListener("lostpointercapture", onUp);
    base.addEventListener("contextmenu", (e) => e.preventDefault());

    // Safari's native touch/selection recognizers are separate from pointer
    // drawing. Cancel their defaults on the paper only, including ignored palms;
    // do not draw from touch events (that would duplicate Pencil strokes).
    const preventTouch = (ev) => { if (ev.cancelable) ev.preventDefault(); };
    wrap.addEventListener("touchstart", preventTouch, { passive: false });
    wrap.addEventListener("touchmove", preventTouch, { passive: false });

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
      // A pending save from the previous stroke may fire during erasing. Only
      // expose committed ink, so a cancelled palm cannot persist deletions.
      getPage: () => state.erasing ? { ...state.page, strokes: state.erasing.original } : state.page,
      // True while a stroke is actually under the pen. Sync asks this before
      // taking the main thread for a full-page render, so a background upload
      // can never stall the stroke someone is in the middle of drawing.
      isPenDown: () => state.activePointer !== null,
      isDirty: () => state.dirty,
      clearDirty() { state.dirty = false; },
      loadPage(page) {
        state.page = page || S.emptyPage();
        state.undo.length = 0;
        state.redo.length = 0;
        state.current = null;
        state.dirty = false;
        clearLive();
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
        wrap.removeEventListener("touchstart", preventTouch);
        wrap.removeEventListener("touchmove", preventTouch);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
      },
    };
  }

  return { create };
});
