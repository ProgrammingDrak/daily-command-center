// pet-nudge.js — the pet reminds you about work that has no time in it.
//
// When an anytime task's window is running down and the target is unmet, the pet
// runs in from off screen, stops at the dock, says what is outstanding, and the
// checklist opens. Modeled directly on pet-courier.js's runCourier(): detach to
// position:fixed, travel on a CSS transition with a separate steps() gait, flip
// facing with --runner-turn, deposit, leave. It reuses that module's CSS block
// (dashboard.css "PET COURIER") rather than growing a second sprite.
//
// WHY THE TICK AND NOT AN EVENT: nothing fires when a window quietly runs out.
// The only honest trigger is "look at the clock and compare", so this rides
// clock.js's once-per-minute branch, the same host meeting-alerts.js uses. There
// is no service worker, so like meeting-alerts this is in-app only, by design.
//
// THE STAMP GOES DOWN BEFORE THE PET RUNS. The tick fires every minute; a
// delivery that failed, or that Drake ignored, must not re-summon the pet sixty
// seconds later. That is pet-courier's bank-before-deliver rule, and the stamp
// lives on the day root, so a second device does not re-nudge either.
(function () {
  "use strict";

  const DCC = (window.DCC = window.DCC || {});
  const BUBBLE_ID = "pet-nudge-bubble";
  const BUBBLE_LINGER_MS = 7000;
  const MAX_LINES = 3;
  const MARGIN = 10;          // keep the bubble this far off any viewport edge
  const PET_CLEARANCE = 60;   // fallback clearance when the sprite cannot be measured
  const TAIL_GAP = 10;        // breathing room between the tail and the pet

  let _running = false;
  let _bubbleTimer = null;

  function A() { return DCC.Anytime || null; }
  function dock() { return DCC.AnytimeDock || null; }
  function esc(s) { return DCC.esc(s); }

  // Both predicates live on the DCC namespace (core-ui.js) so the courier and
  // this module cannot drift on "am I allowed to animate over Drake".
  function reducedMotion() {
    return typeof DCC.reducedMotion === "function" ? DCC.reducedMotion() : false;
  }
  function busyElsewhere() {
    return typeof DCC.busyElsewhere === "function" ? DCC.busyElsewhere() : false;
  }

  // ── the message ──

  // Pure, so the copy is testable without a DOM: what the bubble says for a
  // given set of due rows.
  function nudgeText(due) {
    const rows = (due || []).slice(0, MAX_LINES);
    const more = (due || []).length - rows.length;
    const body = rows.map(r =>
      (r.def.title || "Something") + " " + r.progress.n + "/" + r.progress.target).join(" · ");
    return body + (more > 0 ? " +" + more + " more" : "");
  }

  // ── the bubble ──

  function removeBubble() {
    if (_bubbleTimer) { clearTimeout(_bubbleTimer); _bubbleTimer = null; }
    const el = document.getElementById(BUBBLE_ID);
    if (el) el.remove();
  }

  // `petX` is where the pet is standing, which is NOT the bubble's centre once the
  // bubble has been pushed away from a viewport edge. The tail tracks the pet.
  // `petEl` is the live sprite, so the bubble can clear whatever height its
  // animation has actually given it instead of guessing from a constant.
  function showBubble(text, at, petX, petEl) {
    removeBubble();
    const el = document.createElement("button");
    el.id = BUBBLE_ID;
    el.type = "button";
    el.className = "pet-nudge-bubble";
    el.innerHTML = '<span class="pet-nudge-bubble-lead">Don’t forget</span>' +
      '<span class="pet-nudge-bubble-text">' + esc(text) + "</span>";
    el.setAttribute("aria-label", "Don't forget: " + text + ". Open the anytime list.");

    // MEASURE FAR FROM THE EDGE, THEN PIN AN EXPLICIT WIDTH. A position:fixed box
    // with only `left` set takes its shrink-to-fit width from `left` to the right
    // edge of the viewport, so a bubble placed near the dock (16px from that edge)
    // reflows into a one-word column. Measuring at a neutral x and then freezing
    // the width makes layout independent of where it ends up.
    el.style.left = "0px";
    el.style.top = "0px";
    document.body.appendChild(el);
    const w = Math.min(el.offsetWidth || 240, Math.max(120, (window.innerWidth || 1024) - 2 * MARGIN));
    el.style.width = w + "px";
    const h = el.offsetHeight || 88;

    const vw = window.innerWidth || 1024;
    const anchorX = typeof petX === "number" ? petX : at.x;
    // JS owns the true left edge, so the CSS carries no translateX centring.
    const maxLeft = Math.max(MARGIN, vw - MARGIN - w);
    const left = Math.max(MARGIN, Math.min(maxLeft, anchorX - w / 2));
    el.style.left = left + "px";

    // ABOVE the pet, never over it. The sprite's animated box is the honest
    // reference; the constant is only a fallback for a pet that is not on screen.
    let petTop = at.y - PET_CLEARANCE;
    if (petEl && typeof petEl.getBoundingClientRect === "function") {
      const r = petEl.getBoundingClientRect();
      if (r && r.height > 0) petTop = r.top;
    }
    el.style.top = Math.max(MARGIN, petTop - TAIL_GAP - h) + "px";

    // Keep the tail pointing at the pet even after the clamp moved the bubble.
    el.style.setProperty("--pet-nudge-tail",
      Math.max(14, Math.min(w - 14, anchorX - left)) + "px");

    el.addEventListener("click", () => {
      removeBubble();
      const d = dock();
      if (d) d.open();
    });
    _bubbleTimer = setTimeout(() => {
      const live = document.getElementById(BUBBLE_ID);
      if (!live) return;
      live.classList.add("leaving");
      live.addEventListener("animationend", () => live.remove(), { once: true });
      setTimeout(() => { const l = document.getElementById(BUBBLE_ID); if (l) l.remove(); }, 600);
    }, BUBBLE_LINGER_MS);
    return el;
  }

  // ── the run (pet-courier.js's technique) ──

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

  async function runNudge(text, target) {
    let ident = { color: "#f2b56b", glyph: "S", accessory: "" };
    if (window.PetHome && typeof window.PetHome.identity === "function") {
      try { ident = (await window.PetHome.identity()) || ident; } catch (e) {}
    }
    const el = document.createElement("div");
    el.className = "pet-courier pet-nudge-runner";
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("--pet-courier-color", ident.color);
    el.innerHTML =
      '<span class="pet-courier-ears"></span>' +
      "<strong>" + esc(ident.glyph) + "</strong>" +
      '<span class="pet-courier-face"></span>' +
      "<em>" + esc(ident.accessory) + "</em>";
    el.style.left = "-80px";
    el.style.top = target.y + "px";
    document.body.appendChild(el);
    try {
      await move(el, target.x - 120, target.y + 14, 440, 0);
      await move(el, target.x - 76, target.y, 200, 1);
      el.classList.add("talking");
      showBubble(text, target, target.x - 76, el);
      await new Promise(r => setTimeout(r, 620));
      el.classList.remove("talking");
      await move(el, window.innerWidth + 90, target.y + 10, 480, 2);
    } finally {
      el.remove();
    }
  }

  // ── delivery ──

  async function deliver(due) {
    const d = dock();
    const target = d ? d.anchorPoint() : { x: window.innerWidth - 90, y: window.innerHeight - 90 };
    const text = nudgeText(due);
    if (d) d.setPulse(true);

    // Mid-sentence, mid-modal, or not even looking: the dock keeps pulsing and a
    // toast carries the same message with a way in. Yanking a panel over a
    // half-typed note is the one thing that would make this a feature to turn off.
    if (reducedMotion() || busyElsewhere()) {
      if (typeof DCC.toast === "function") {
        DCC.toast("Don't forget: " + text, "info", 60000,
          { label: "Open", onClick: () => { if (d) d.open(); } });
      }
      return false;
    }

    _running = true;
    try {
      await runNudge(text, target);
      // Re-check: the run takes about 1.7s, and Drake can click into a note
      // while the pet is mid-screen. The bubble is already on screen either way.
      if (busyElsewhere()) return false;
      if (d) d.open();
      removeBubble();
      return true;
    } finally { _running = false; }
  }

  // ── the tick (clock.js, once per minute) ──

  function anytimeNudgeTick() {
    const a = A();
    if (!a || typeof a.list !== "function") return false;
    // `_bsProp`/`_bsSaveProp` address the day being VIEWED. Without this guard a
    // tick while Drake plans tomorrow stamps counters onto tomorrow's root and
    // leaves today's stale, which is the bug pet-courier.js documents at length.
    if (!a.onTodayView()) return false;
    const defs = a.list();
    if (!defs.length) return false;

    const ctx = a.context();
    // Close anything that lapsed while this tab was asleep, so a missed window
    // is recorded even if nobody was watching.
    a.settle(defs, ctx);
    const due = a.dueNudges(defs, a.readState(), ctx);

    if (typeof window.buildAnytime === "function") window.buildAnytime({ preserveFocus: true });
    if (!due.length) return false;
    if (_running) return false;
    // Already looking at the list? Then the list IS the nudge. Stamp it so the
    // cadence still advances, and skip the theatre.
    const d = dock();
    if (d && d.isOpen()) {
      a.stampNudge(due.map(r => r.def.id), new Date(ctx.nowMs).toISOString());
      return false;
    }

    a.stampNudge(due.map(r => r.def.id), new Date(ctx.nowMs).toISOString());
    deliver(due).catch(() => {});
    return true;
  }

  window.anytimeNudgeTick = anytimeNudgeTick;
  DCC.AnytimeNudge = {
    tick: anytimeNudgeTick,
    nudgeText: nudgeText,
    deliver: deliver,
    removeBubble: removeBubble
  };
})();
