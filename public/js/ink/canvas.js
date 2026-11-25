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

  // Shared input ownership for every Ink host. Storage and rendering stay in
  // host callbacks; capture, palm rejection, and navigation have one owner.
  function createPointerInput(opts) {
    const base = opts.base, wrap = opts.wrap;
    const state = opts.state || { activePointer: null, activePointerType: null,
      penSeen: false, fingerDraw: opts.fingerDraw || "off" };
    const touches = new Set();
    let navigation = null, lastPen = -Infinity;
    function release(id) { try { base.releasePointerCapture(id); } catch { /* already released */ } }
    function finish(ev, cancel = false) {
      touches.delete(ev.pointerId);
      if (navigation?.id === ev.pointerId) {
        const g = navigation;
        navigation = null;
        release(ev.pointerId);
        if (!cancel && Math.abs(g.dx) > 80 && Math.abs(g.dx) > Math.abs(g.dy) * 2 &&
            Date.now() - g.start < 1200 && Date.now() - lastPen > 800)
          opts.onNavigate?.(g.dx < 0 ? 1 : -1);
        return;
      }
      if (ev.pointerId !== state.activePointer) return;
      if (state.activePointerType === "pen") lastPen = Date.now();
      state.activePointer = null;
      state.activePointerType = null;
      release(ev.pointerId);
      if (cancel) opts.onCancel?.(ev);
      else opts.onFinish?.(ev);
    }
    function down(ev) {
      if (opts.enabled && !opts.enabled()) return;
      ev.preventDefault();
      if (ev.pointerType === "pen") {
        state.penSeen = true;
        lastPen = Date.now();
        navigation = null;
        if (state.activePointerType === "touch") finish({ pointerId: state.activePointer }, true);
      }
      if (ev.pointerType === "touch") {
        touches.add(ev.pointerId);
        if (touches.size > 1) {
          navigation = null;
          if (state.activePointerType === "touch") finish({ pointerId: state.activePointer }, true);
          return;
        }
      }
      const draws = ev.pointerType === "pen" || ev.pointerType === "mouse" ||
        state.fingerDraw === "on" || (state.fingerDraw === "auto" && !state.penSeen);
      if (!draws) {
        if (ev.pointerType === "touch" && opts.onNavigate && state.activePointer === null && Date.now() - lastPen > 800) {
          navigation = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, dx: 0, dy: 0, start: Date.now() };
          try { base.setPointerCapture(ev.pointerId); } catch { navigation = null; }
        }
        return;
      }
      if (state.activePointer !== null || (ev.pointerType !== "pen" && ev.button !== 0)) return;
      state.activePointer = ev.pointerId;
      state.activePointerType = ev.pointerType;
      try { base.setPointerCapture(ev.pointerId); }
      catch { state.activePointer = null; state.activePointerType = null; return; }
      opts.onStart?.(ev);
    }
    function move(ev) {
      if (navigation?.id === ev.pointerId) {
        ev.preventDefault();
        navigation.dx = ev.clientX - navigation.x;
        navigation.dy = ev.clientY - navigation.y;
      } else if (ev.pointerId === state.activePointer) opts.onMove?.(ev);
    }
    const handlers = { pointerdown: down, pointermove: move, pointerup: ev => finish(ev),
      pointercancel: ev => finish(ev, true), lostpointercapture: ev => finish(ev),
      pointerleave: ev => { if (!base.hasPointerCapture(ev.pointerId)) finish(ev); },
      contextmenu: ev => ev.preventDefault() };
    for (const [type, handler] of Object.entries(handlers)) base.addEventListener(type, handler);
    const preventTouch = ev => { if (ev.cancelable) ev.preventDefault(); };
    wrap.addEventListener("touchstart", preventTouch, { passive: false });
    wrap.addEventListener("touchmove", preventTouch, { passive: false });
    return { state, isBusy: () => state.activePointer !== null,
      setFingerDraw(value) { state.fingerDraw = value === "on" ? "on" : value === "auto" ? "auto" : "off"; },
      finishActive(extra = {}) { if (state.activePointer !== null) finish({ ...extra, pointerId: state.activePointer }); },
      cancelActive() { if (state.activePointer !== null) finish({ pointerId: state.activePointer }, true); },
      destroy() {
        this.cancelActive();
        if (navigation) release(navigation.id);
        navigation = null;
        for (const [type, handler] of Object.entries(handlers)) base.removeEventListener?.(type, handler);
        wrap.removeEventListener("touchstart", preventTouch);
        wrap.removeEventListener("touchmove", preventTouch);
      }
    };
  }

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
    const renderer = S.createLiveRenderer(live, prefix);

    const state = {
      page: S.emptyPage(),
      tool: "pen",
      color: "#1b1b2f",
      size: 2.6,
      eraserRadius: 12,
      scale: 1,
      penSeen: false,
      fingerDraw: opts.fingerDraw || "auto",
      style: null,
      revision: 0,
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
      S.drawPage(baseCtx, state.page, { scale: 1 });
    }

    // A new stroke or layout invalidates both live pixels and the stable prefix.
    function clearLive() { renderer.clear(); }
    function redrawLive(append) { renderer.draw(state.current, append); }

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
      } else if (entry.type === "paper") {
        if (entry.before) state.page.paper = entry.before;
        else delete state.page.paper;
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
      else if (entry.type === "paper") state.page.paper = entry.after;
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
      state.revision++;
      onChange(state.page);
    }

    // ── input ────────────────────────────────────────────────────────────────

    // A finger is only allowed to draw until the first time a pen is used. After
    // that this canvas belongs to the pen and touch is for panning, which is what
    // lets you rest your hand while writing.
    function onDown(ev) {
      const erasing = state.tool === "eraser" || ev.button === 5 || ev.buttons === 32;
      const p = toPage(ev);
      if (erasing) {
        state.current = null;
        state.erasing = { removed: [], original: state.page.strokes.slice() };
        eraseAt(p.x, p.y);
      } else {
        state.erasing = null;
        state.current = S.newStroke(state.tool, state.color, state.size, state.style);
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
      renderer.commit(baseCtx, stroke);
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

    const input = createPointerInput({ base, wrap, state, onStart: onDown,
      onMove, onFinish: onUp, onCancel, onNavigate: opts.onNavigate });

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 120);
    };
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (resizeObserver) resizeObserver.observe(wrap);
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
      setTool(tool) { if (state.activePointer === null) state.tool = tool; },
      setStyle(style) { state.style = style ? { ...style } : null; },
      setFingerDraw(value) { state.fingerDraw = value === "on" ? "on" : value === "auto" ? "auto" : "off"; },
      // opts.history === false applies paper without an undo entry, for a
      // page's initial state.
      setPaper(paper, opts) {
        if (state.activePointer !== null) return false;
        const before = state.page.paper;
        const after = S.normalizePaper(paper);
        if (JSON.stringify(before) === JSON.stringify(after)) return false;
        state.page.paper = after;
        if (!(opts && opts.history === false)) pushUndo({ type: "paper", before, after });
        redraw(); changed();
        return true;
      },
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
        S.drawPage(ctx, state.page, { scale });
        return c;
      },
      destroy() {
        clearTimeout(resizeTimer);
        if (resizeObserver) resizeObserver.disconnect();
        input.destroy();
        window.removeEventListener("resize", onResize);
        window.removeEventListener("orientationchange", onResize);
      },
    };
  }

  return { create, createPointerInput };
});
