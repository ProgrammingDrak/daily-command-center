// ======== PET COURIER ========
// When a sweep drops new triage items, the pet runs in with an envelope in its
// mouth, leaves it, and the catch-up modal opens on what just arrived.
//
// WHY AN ID DIFF AND NOT THE SSE SOURCE STRING: arrivals reach the client as
// `dcc-state-changed` with source "triage-check-ingest", but sse.js DEFERS a
// refresh while Drake is typing (isEditing -> pendingDccUpdate) and its retry on
// focusout calls refreshDccState() with no event at all. Gating on the source
// would silently skip exactly the case the deferral exists for. So the trigger is
// "which active triage ids have I never shown?", banked on today's day_root as
// _triageCourierSeen — server-side and per-day, the same place catch-up.js keeps
// its reviewed flag, so a second device doesn't re-deliver the same mail.
//
// The morning prompt banks everything waiting at boot (catch-up.js initCatchUp),
// so page load is never an "arrival".
//
// The animation is modeled on slots.js's slot-bank-pet-runner, which already does
// this trick — detach to position:fixed, travel on a CSS transition with a separate
// steps() gait, carry a glowing token, deposit, leave. That one is hard-gated to the
// Slots tab (isSlotsPageActive) and its DOM lives inside tab content, so this is the
// same technique with its own body-level element rather than a call into it.
(function () {
  "use strict";

  const SEEN = "_triageCourierSeen";
  let _running = false;      // a courier run is in flight
  let _pending = [];         // delivered-but-not-yet-shown ids (Drake was busy)
  let _retryWired = false;

  function esc(s) { return window.DCC.esc(s); }
  function activeTriage() {
    if (typeof activeTriageItems !== "function") return [];
    try { return activeTriageItems() || []; } catch (e) { return []; }
  }

  // ── the seen set (today's day_root) ──
  // _bsProp returns null for BOTH "there is no day_root yet" and "the day_root has
  // no seen list yet", which are different situations — the first cannot tell new
  // from old, the second is simply the first look of the day. Neither may be read as
  // "everything is new", or the pet sprints in on a cold load carrying the whole
  // queue. So a null read means "no baseline yet" (see notifyTriageArrivals, which
  // establishes one instead of delivering), and _seenMemo keeps the baseline for the
  // session even when there is no day_root to persist it to.
  let _seenMemo = null;
  function seenIds() {
    const v = (typeof _bsProp === "function") ? _bsProp(SEEN, null) : null;
    return Array.isArray(v) ? v : _seenMemo;
  }
  function markSeen(ids) {
    if (!ids) return;
    const seen = seenIds() || [];
    const next = seen.concat(ids.filter(id => seen.indexOf(id) === -1));
    _seenMemo = next;
    if (typeof _bsSaveProp === "function") _bsSaveProp(SEEN, next);
  }

  // Pure, so the "does the pet run?" rule is testable without a DOM: which of the
  // currently-active ids has never been shown. A null seen set (no day_root yet)
  // means we cannot tell new from old, so nothing is new — better a missed delivery
  // than the pet sprinting in at every page load.
  function _newTriageIds(seen, activeIds) {
    if (!Array.isArray(seen) || !Array.isArray(activeIds)) return [];
    return activeIds.filter(id => seen.indexOf(id) === -1);
  }

  // ── when NOT to interrupt ──
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (e) { return false; }
  }
  // _bsProp/_bsSaveProp address the day being VIEWED, not today: they resolve through
  // blockStore.getDayRootId(), which follows whatever day was last loaded. catch-up.js
  // guards on viewMode before it so much as reads _catchUpReviewed, and every entry
  // that can reach the prompt needs the same guard, not just the SSE one.
  function onTodayView() {
    return !(typeof viewMode !== "undefined" && viewMode && viewMode !== "today");
  }
  function catchUpOpen() {
    const o = document.getElementById("catchup-overlay") || document.getElementById("unfinished-overlay");
    return !!(o && o.classList && o.classList.contains("open"));
  }
  // Mid-sentence, mid-modal, or not even looking: deliver the envelope as a chip and
  // let Drake open it. Yanking a modal over a half-typed note is the one way this
  // feature becomes something to turn off.
  function busyElsewhere() {
    if (typeof document.hidden === "boolean" && document.hidden) return true;
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.contentEditable === "true")) return true;
    if (typeof _anyModalOpen === "function" && _anyModalOpen()) return true;
    if (catchUpOpen()) return true;
    return false;
  }

  // ── the waiting envelope ──
  function chip() { return document.getElementById("pet-courier-chip"); }
  function showChip(count) {
    let el = chip();
    if (!el) {
      el = document.createElement("button");
      el.id = "pet-courier-chip";
      el.className = "pet-courier-chip";
      el.type = "button";
      el.title = "New from the sweep";
      el.innerHTML = '<span class="pet-courier-chip-glyph">&#9993;</span><span class="pet-courier-chip-count"></span>';
      el.addEventListener("click", () => { flushPending(true); });
      document.body.appendChild(el);
    }
    const c = el.querySelector(".pet-courier-chip-count");
    if (c) c.textContent = String(count);
    el.setAttribute("aria-label", count + " new item" + (count === 1 ? "" : "s") + " from the sweep");
  }
  function hideChip() { const el = chip(); if (el) el.remove(); }

  // Show what's waiting. `force` means Drake clicked the chip, so skip the
  // are-you-busy check — he just answered it.
  async function flushPending(force) {
    // The run owns its own delivery. Without this, a focusout 300ms into the 1.4s
    // animation delivers the ids and empties _pending, and the run then opens on an
    // empty list and leaves a chip reading "0".
    if (_running) return false;
    // Same guard notifyTriageArrivals uses, because this path reaches the same prompt
    // and closing it calls markReviewed() -> the VIEWED day's root. Without it, a
    // visibilitychange retry while Drake is planning tomorrow opens a today-oriented
    // prompt over tomorrow and stamps _catchUpReviewed on tomorrow's root, so
    // tomorrow's morning catch-up never opens. Keep the chip: the envelope stays
    // reachable for when he is back on today.
    if (!onTodayView()) { if (_pending.length) showChip(_pending.length); return false; }
    // Reconcile first: an item handled from the triage strip instead of the chip is
    // no longer active, so openArrivals returns false for it forever. Without this
    // the chip sits there all session claiming N and doing nothing when clicked.
    if (_pending.length) {
      const live = new Set(activeTriage().map(i => i.id));
      _pending = _pending.filter(id => live.has(id));
    }
    if (!_pending.length) { hideChip(); return false; }
    if (!force && busyElsewhere()) { showChip(_pending.length); return false; }
    const batch = _pending.slice();
    _running = true;                     // hold it: an SSE tick can land inside this await
    let shown = false;
    try { shown = await open(batch); } finally { _running = false; }
    if (shown) _pending = _pending.filter(id => batch.indexOf(id) === -1);
    if (_pending.length) showChip(_pending.length); else hideChip();
    return shown;
  }
  function wireRetry() {
    if (_retryWired) return;
    _retryWired = true;
    // Same two moments sse.js uses to decide Drake is available again.
    document.addEventListener("focusout", () => { setTimeout(() => flushPending(false), 250); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) flushPending(false); });
  }

  async function open(ids) {
    const CU = window.DCC && window.DCC.CatchUp;
    if (!CU || typeof CU.openArrivals !== "function") return false;
    try { return !!(await CU.openArrivals(ids)); } catch (e) { return false; }
  }

  // ── the run ──
  function anchorPoint() {
    const sec = document.getElementById("schedule-triage-section");
    if (sec && typeof sec.getBoundingClientRect === "function") {
      const r = sec.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
        return { x: r.left + Math.min(120, r.width / 2), y: r.top + Math.min(40, r.height / 2) };
      }
    }
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.62 };
  }
  function move(el, x, y, ms, step) {
    return new Promise(resolve => {
      const fromX = parseFloat(el.style.left || "0");
      el.style.setProperty("--runner-turn", (x - fromX) < 0 ? "-1" : "1");
      el.classList.remove("running");
      void el.offsetWidth;                       // reflow flush: re-trigger the gait
      el.classList.add("running");
      dust(fromX, parseFloat(el.style.top || "0"), step);
      el.style.transitionDuration = ms + "ms";
      el.style.left = x + "px";
      el.style.top = y + "px";
      setTimeout(resolve, ms + 20);
    });
  }
  function dust(x, y, step) {
    for (let i = 0; i < 3; i++) {
      const d = document.createElement("span");
      d.className = "pet-courier-dust";
      d.style.left = (x - 14 + i * 8) + "px";
      d.style.top = (y + 20 + (step % 2) * 3) + "px";
      d.style.animationDelay = (i * 38) + "ms";
      document.body.appendChild(d);
      d.addEventListener("animationend", () => d.remove(), { once: true });
    }
  }
  function dropEnvelope(x, y) {
    const e = document.createElement("span");
    e.className = "pet-courier-drop";
    e.textContent = "✉";
    e.style.left = x + "px";
    e.style.top = y + "px";
    e.setAttribute("aria-hidden", "true");
    document.body.appendChild(e);
    e.addEventListener("animationend", () => e.remove(), { once: true });
  }
  async function runCourier() {
    const target = anchorPoint();
    let ident = { color: "#f2b56b", glyph: "S", accessory: "" };
    if (window.PetHome && typeof window.PetHome.identity === "function") {
      try { ident = (await window.PetHome.identity()) || ident; } catch (e) {}
    }
    const el = document.createElement("div");
    el.className = "pet-courier carrying";
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("--pet-courier-color", ident.color);
    el.innerHTML =
      '<span class="pet-courier-ears"></span>' +
      '<strong>' + esc(ident.glyph) + '</strong>' +
      '<span class="pet-courier-face"></span>' +
      '<em>' + esc(ident.accessory) + '</em>' +
      '<span class="pet-courier-envelope">&#9993;</span>';
    el.style.left = "-80px";
    el.style.top = target.y + "px";
    document.body.appendChild(el);
    try {
      await move(el, target.x - 60, target.y + 14, 420, 0);
      await move(el, target.x, target.y, 200, 1);
      el.classList.add("depositing");
      dropEnvelope(target.x, target.y);
      await new Promise(r => setTimeout(r, 260));
      el.classList.remove("carrying", "depositing");
      await move(el, window.innerWidth + 90, target.y + 10, 460, 2);
    } finally {
      el.remove();
    }
  }

  // ── entry point (called by sse.js after a state refresh commits) ──
  async function notifyTriageArrivals() {
    wireRetry();
    if (_running) return false;
    // _bsProp/_bsSaveProp address the day being VIEWED, not today: they resolve through
    // blockStore.getDayRootId(), which follows whatever day was last loaded. catch-up.js
    // guards on viewMode before it so much as reads _catchUpReviewed, for exactly this
    // reason. Without the same guard, a refresh that lands while Drake is planning
    // tomorrow reads tomorrow's root (no baseline), writes the seen list onto it, and
    // today's root keeps a stale list -- so the same mail re-delivers after a reload,
    // and an archive day (read-only everywhere else) gets written to.
    if (!onTodayView()) return false;
    const active = activeTriage().map(i => i.id);
    const seen = seenIds();
    // First look with no baseline anywhere (initCatchUp normally sets it at boot, but
    // a refresh can land before that): establish it, deliver nothing. Whatever is
    // already sitting there is not an arrival — it is just the state of the mailbox.
    if (seen === null) { markSeen(active); return false; }
    const fresh = _newTriageIds(seen, active);
    if (!fresh.length) return flushPending(false);
    // Bank them BEFORE delivering: the pet runs once per arrival, and a failed or
    // ignored delivery must not re-summon it on the next SSE tick. The ids stay in
    // _pending so the envelope is still reachable.
    markSeen(fresh);
    _pending = _pending.concat(fresh.filter(id => _pending.indexOf(id) === -1));
    if (busyElsewhere()) { showChip(_pending.length); return false; }
    _running = true;
    try {
      if (!reducedMotion()) await runCourier();
      // Re-check: the run takes ~1.4s, and Drake can click into a note or open a modal
      // while the pet is mid-screen. Opening over that is the one behavior that would
      // make this feature something to turn off.
      if (busyElsewhere()) { showChip(_pending.length); return false; }
      if (!_pending.length) return false;
      const batch = _pending.slice();
      const shown = await open(batch);
      if (shown) _pending = _pending.filter(id => batch.indexOf(id) === -1);
      if (_pending.length) showChip(_pending.length); else hideChip();
      return shown;
    } finally { _running = false; }
  }

  window.notifyTriageArrivals = notifyTriageArrivals;
  const DCC = (window.DCC = window.DCC || {});
  DCC.TriageCourier = {
    notify: notifyTriageArrivals,
    markSeen: markSeen,
    seenIds: seenIds,
    _newTriageIds: _newTriageIds
  };
})();
