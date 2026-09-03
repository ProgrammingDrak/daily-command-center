// ======== TOUCH DRAG-TO-REORDER (itinerary List view) ========
// Native HTML5 drag never fires on touch, so on a phone the itinerary was
// un-reorderable. This adapter turns a long-press into the SAME reorder/nest/
// promote the desktop drag does, by driving the drag.js resolver through the
// window.DCC_DRAG facade (dOver/dDrop reused untouched — no logic duplicated).
//
// Gate: non-mouse pointers only. A mouse always early-returns, so it keeps the
// native HTML5 drag path and the two systems never collide.
//
// Gesture: press-and-hold ~300ms to lift a row → drag up/down to reorder, drag
// RIGHT to nest. Sideways offset picks the mode, vertical position picks the
// slot. The thresholds are NOT duplicated here: DCC_DRAG.modeForDx (drag.js) is
// the one answer, and a mouse drag now derives its mode from the same call, so
// web and mobile share one gesture. A plain tap falls through to the row's
// open-space click (open details); a vertical swipe before the hold scrolls the
// page as usual.
(function () {
  "use strict";

  var HOLD_MS = 300;      // press duration that promotes a touch to a lift
  var MOVE_CANCEL = 10;   // px of pre-lift movement that reads as a scroll, not a hold
  var EDGE = 64;          // px from viewport edge that triggers auto-scroll
  var EDGE_STEP = 12;     // px per frame auto-scroll speed
  var SUPPRESS_CLICK_MS = 450;

  // Never lift when the press lands on a real control. Mirrors the row's
  // open-space click exclusion (schedule-tab.js row()) MINUS .grip: the grip is
  // labeled "Drag to reorder" and IS the drag handle, so a long-press on it must
  // lift (a quick tap on it still no-ops — onUp resets before the hold fires).
  var LIFT_EXCLUDE = "button,a,input,textarea,.chk,.chk-quick,.start-time,.wrap-collapse,.pet-privacy-toggle,.prep-flag";

  var listView = null;
  var state = null;           // active gesture, or null
  var suppressClickUntil = 0;
  var rafId = 0;

  function reset() {
    if (!state) return;
    if (state.holdTimer) clearTimeout(state.holdTimer);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (state.lifted) {
      try { listView.releasePointerCapture(state.pointerId); } catch (e) { /* noop */ }
      if (state.ghost && state.ghost.parentNode) state.ghost.parentNode.removeChild(state.ghost);
      listView.classList.remove("it-drag-lifting");
      if (window.DCC_DRAG) DCC_DRAG.end();   // clears dragId + all drag-over highlights
    }
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    state = null;
  }

  function onDown(e) {
    if (state) return;                         // one pointer at a time
    // pointerType is the whole gate. A viewport-width test used to sit here too,
    // which silently killed finger reorder on every touch laptop and on a tablet
    // wider than 540px: those pass this line, failed that one, and native HTML5
    // drag never fires for touch input either. Mouse keeps native drag; any
    // finger or pen gets the press-and-hold path.
    if (e.pointerType === "mouse") return;
    suppressClickUntil = 0;                    // a fresh press clears any stale drop-suppress window
    var row = e.target.closest(".it-list-item.movable");
    if (!row || !listView.contains(row)) return;
    if (e.target.closest(LIFT_EXCLUDE)) return; // let taps on real controls behave normally

    state = {
      pointerId: e.pointerId,
      row: row,
      id: row.dataset.id,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lifted: false,
      ghost: null,
      offsetY: 0,
      prevTargetId: null,
      prevMode: null,
      holdTimer: setTimeout(lift, HOLD_MS)
    };
    // Listen in capture phase so we see moves even after pointer capture.
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    // Do NOT preventDefault or capture yet — the page must still scroll if this
    // turns out to be a swipe rather than a hold.
  }

  function lift() {
    if (!state || state.lifted) return;
    state.lifted = true;
    var r = state.row.getBoundingClientRect();
    state.offsetY = state.lastY - r.top;
    try { listView.setPointerCapture(state.pointerId); } catch (e) { /* noop */ }
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* noop */ } }

    // Floating clone that tracks the finger. pointer-events:none is MANDATORY so
    // elementFromPoint sees the row beneath it, not the ghost.
    var ghost = state.row.cloneNode(true);
    ghost.classList.add("it-drag-ghost");
    ghost.style.left = r.left + "px";
    ghost.style.top = r.top + "px";
    ghost.style.width = r.width + "px";
    ghost.style.marginLeft = "0";   // nested rows carry an inline depth indent; the ghost is viewport-positioned
    document.body.appendChild(ghost);
    state.ghost = ghost;

    listView.classList.add("it-drag-lifting");
    if (window.DCC_DRAG) DCC_DRAG.begin(state.id, state.row);  // dims the source row
    startAutoScroll();
  }

  // Sideways offset from the lift point picks the drop mode. The thresholds live
  // in drag.js (DRAG_NEST_PX / DRAG_SUB_PX) so the mouse path and this one cannot
  // disagree. With the facade missing, reorder: never silently re-parent.
  function modeFor(x) {
    if (!window.DCC_DRAG || typeof DCC_DRAG.modeForDx !== "function") return "reorder";
    return DCC_DRAG.modeForDx(x - state.startX);
  }

  function onMove(e) {
    if (!state || e.pointerId !== state.pointerId) return;
    state.lastX = e.clientX;
    state.lastY = e.clientY;

    if (!state.lifted) {
      // Pre-lift: any real movement means the finger is scrolling, not holding.
      var dx = e.clientX - state.startX, dy = e.clientY - state.startY;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL) reset();
      return;
    }

    e.preventDefault();                        // now we own the gesture — block scroll
    // Move the clone.
    state.ghost.style.transform =
      "translate(" + (e.clientX - state.startX) + "px," + (e.clientY - state.startY) + "px)";

    var mode = modeFor(e.clientX);
    var tgt = targetUnder(e.clientX, e.clientY);
    var tgtId = tgt ? tgt.dataset.id : null;

    if (tgtId !== state.prevTargetId || mode !== state.prevMode) {
      if (state.prevTargetId && state.prevTargetEl && window.DCC_DRAG) DCC_DRAG.leave(state.prevTargetEl);
      if (tgt && tgtId !== state.id && window.DCC_DRAG) DCC_DRAG.over(tgt, tgtId, e.clientY, mode);
      state.prevTargetId = tgtId;
      state.prevTargetEl = tgt;
      state.prevMode = mode;
    }
  }

  function onUp(e) {
    if (!state || e.pointerId !== state.pointerId) return;
    if (!state.lifted) { reset(); return; }    // tap — let the click open details

    e.preventDefault();
    var mode = modeFor(e.clientX);
    var tgt = targetUnder(e.clientX, e.clientY);
    // drop() runs the mutation + recalcTimes + render() through the shared resolver.
    if (tgt && tgt.dataset.id !== state.id && window.DCC_DRAG) {
      DCC_DRAG.drop(tgt, tgt.dataset.id, e.clientY, mode);
    }
    suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;  // swallow the trailing click
    reset();
  }

  function onCancel(e) {
    if (!state || e.pointerId !== state.pointerId) return;
    reset();
  }

  // Topmost list row under the point. Done rows and the amber "Rescheduled away" entries
  // are not drop targets. The list view marks the latter `.resched-away-row`; `.pushed` is
  // the TIMELINE view's class for the same treatment and never lands on an .it-list-item,
  // so testing for it here would be testing for something that cannot occur.
  function targetUnder(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    var row = el.closest(".it-list-item");
    if (!row || !listView.contains(row)) return null;
    if (row.classList.contains("done") || row.classList.contains("resched-away-row")) return null;
    return row;
  }

  // Auto-scroll the page while the finger hovers near a viewport edge.
  function startAutoScroll() {
    function tick() {
      if (!state || !state.lifted) { rafId = 0; return; }
      var y = state.lastY;
      if (y < EDGE) window.scrollBy(0, -EDGE_STEP);
      else if (y > window.innerHeight - EDGE) window.scrollBy(0, EDGE_STEP);
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  // A drag ends with a synthesized click on the lifted row; swallow it so the
  // row's open-space handler doesn't also open the details modal.
  function onClickCapture(e) {
    if (Date.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
      suppressClickUntil = 0;
    }
  }

  // Suppress the iOS long-press callout / context menu during a lift.
  function onContextMenu(e) {
    if (state && state.lifted) e.preventDefault();
  }

  function init() {
    listView = document.getElementById("list-view");
    if (!listView) return;
    // Delegated: buildListView() only replaces innerHTML, so #list-view (and these
    // listeners) survive every re-render.
    listView.addEventListener("pointerdown", onDown, true);
    listView.addEventListener("click", onClickCapture, true);
    listView.addEventListener("contextmenu", onContextMenu, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
