// ======== REUSABLE RADIAL FAN-OUT (anchored to any button) ========
// Same fan-out mechanic + CSS classes as the bottom-right "+" launcher HUD,
// but anchored to an arbitrary button (e.g. a task card's "more" trigger) and
// fed a custom set of {label, icon, action} items. Items reuse .dcc-radial /
// .dcc-radial-item so the geometry and animation stay identical.
window.dccOpenCardRadial = function(anchorEl, items){
  if(!anchorEl || !Array.isArray(items) || !items.length) return;
  const esc = (typeof window.escHtml === "function") ? window.escHtml : (s=>String(s==null?"":s));
  // Toggle: clicking the same trigger again closes the open menu.
  const already = document.querySelector(".dcc-card-radial-host");
  if(already){ const sameAnchor = already.__anchor === anchorEl; already.__close && already.__close(); if(sameAnchor) return; }

  const host = document.createElement("div");
  host.className = "dcc-card-radial-host";
  host.__anchor = anchorEl;
  const radial = document.createElement("div");
  radial.className = "dcc-radial";          // .open added next frame so it animates
  radial.setAttribute("aria-hidden", "false");
  items.forEach(function(it, i){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dcc-radial-item";
    b.style.setProperty("--i", i);
    b.title = it.label || "";
    b.setAttribute("aria-label", it.label || "");
    b.innerHTML = (it.icon || "") + '<span class="dcc-radial-label">' + esc(it.label || "") + '</span>';
    b.addEventListener("click", function(e){ e.stopPropagation(); close(); if(typeof it.action === "function") it.action(); });
    radial.appendChild(b);
  });
  host.appendChild(radial);

  const scrim = document.createElement("div");
  scrim.className = "dcc-scrim dcc-card-radial-scrim open";

  function close(){
    radial.classList.remove("open");
    host.remove();
    scrim.remove();
    document.removeEventListener("keydown", onEsc, true);
  }
  function onEsc(e){ if(e.key === "Escape") close(); }
  host.__close = close;

  scrim.addEventListener("click", close);
  document.body.appendChild(scrim);
  document.body.appendChild(host);

  // Center the 48x48 host on the trigger so items fan out from its center
  // (matches the launcher, whose radial items rest at the button and project out).
  const r = anchorEl.getBoundingClientRect();
  host.style.left = (r.left + r.width/2 - 24) + "px";
  host.style.top  = (r.top  + r.height/2 - 24) + "px";

  requestAnimationFrame(function(){ radial.classList.add("open"); });
  setTimeout(function(){ document.addEventListener("keydown", onEsc, true); }, 0);
};

// ======== UNIVERSAL "+" LAUNCHER ========
// The bottom-right "+" circle has two gestures:
//   - quick tap        -> open the compose popover (add a task)
//   - press-and-hold   -> open the semicircle radial HUD (Start timer / Add task / Give feedback)
// Radial actions delegate to window.dccOpenTimer (timer.js) and window.dccOpenFeedback (feedback.js).
(function(){
  const HOLD_MS = 450;     // how long a press must last to count as a hold
  const MOVE_CANCEL = 6;   // px of movement that cancels the hold (treated as a stray drag)

  const launcher = document.getElementById("dcc-launcher");
  if (!launcher) return;
  const btn     = document.getElementById("dcc-launcher-btn");
  const radial  = document.getElementById("dcc-radial");
  const compose = document.getElementById("dcc-compose");
  const scrim   = document.getElementById("dcc-scrim");
  const bar     = document.getElementById("task-add-launcher");

  let radialOpen = false, composeOpen = false;

  // ---- radial ----
  function openRadial(){
    if (radialOpen) return;
    closeCompose();
    radialOpen = true;
    radial.classList.add("open");
    radial.setAttribute("aria-hidden", "false");
    btn.classList.add("radial-open");
    showScrim();
  }
  function closeRadial(){
    if (!radialOpen) return;
    radialOpen = false;
    radial.classList.remove("open");
    radial.setAttribute("aria-hidden", "true");
    btn.classList.remove("radial-open");
    maybeHideScrim();
  }

  // ---- compose ----
  function openCompose(){
    if (composeOpen) return;
    closeRadial();
    composeOpen = true;
    compose.classList.add("open");
    compose.setAttribute("aria-hidden", "false");
    showScrim();
    const input = bar && bar.querySelector(".tab-title");
    if (input) setTimeout(function(){ input.focus(); }, 0);
  }
  function closeCompose(){
    if (!composeOpen) return;
    composeOpen = false;
    compose.classList.remove("open");
    compose.setAttribute("aria-hidden", "true");
    maybeHideScrim();
  }

  // ---- shared scrim ----
  function showScrim(){ if (scrim) scrim.classList.add("open"); }
  function maybeHideScrim(){ if (scrim && !radialOpen && !composeOpen) scrim.classList.remove("open"); }
  function closeAll(){ closeRadial(); closeCompose(); }

  // ---- gesture detection on the "+" circle ----
  let holdTimer = null, startX = 0, startY = 0, didHold = false, activePointer = null;

  btn.addEventListener("pointerdown", function(e){
    if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
    activePointer = e.pointerId;
    didHold = false;
    startX = e.clientX; startY = e.clientY;
    try { btn.setPointerCapture(activePointer); } catch(_){}
    holdTimer = setTimeout(function(){
      holdTimer = null;
      didHold = true;
      openRadial();
    }, HOLD_MS);
  });

  btn.addEventListener("pointermove", function(e){
    if (!holdTimer) return;
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL || Math.abs(e.clientY - startY) > MOVE_CANCEL){
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  });

  btn.addEventListener("pointerup", function(e){
    const wasHold = didHold;
    if (holdTimer){ clearTimeout(holdTimer); holdTimer = null; }
    try { if (btn.hasPointerCapture && btn.hasPointerCapture(activePointer)) btn.releasePointerCapture(activePointer); } catch(_){}
    activePointer = null;
    if (wasHold) return;        // hold already opened the radial; do nothing on release
    // short tap: toggle compose (and close radial if it somehow stayed open)
    if (radialOpen) { closeRadial(); return; }
    if (composeOpen) closeCompose(); else openCompose();
  });

  btn.addEventListener("pointercancel", function(){
    if (holdTimer){ clearTimeout(holdTimer); holdTimer = null; }
    activePointer = null;
  });

  // Long-press on touch would otherwise raise the OS context menu / text callout.
  btn.addEventListener("contextmenu", function(e){ e.preventDefault(); });

  // ---- radial item actions ----
  radial.addEventListener("click", function(e){
    const item = e.target.closest(".dcc-radial-item");
    if (!item) return;
    const action = item.dataset.action;
    closeRadial();
    if (action === "timer")    { if (typeof window.dccOpenTimer === "function") window.dccOpenTimer(); }
    else if (action === "task"){ openCompose(); }
    else if (action === "feedback"){ if (typeof window.dccOpenFeedback === "function") window.dccOpenFeedback(); }
    else if (action === "catchup"){ if (typeof window.openUnfinishedTasks === "function") window.openUnfinishedTasks(); }
  });

  // ---- dismissal ----
  if (scrim) scrim.addEventListener("click", closeAll);
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape") closeAll();
  });

  // ---- compose: close after a successful add ----
  // schedule.js already binds every .task-add-bar's "+ Add" click and Enter key to
  // addTaskUniversal(), which clears .tab-title on success and keeps it (+ .tab-error)
  // on an empty submit. We ride on top: close only if the input ended up empty.
  if (bar){
    const closeIfAdded = function(){
      setTimeout(function(){
        const input = bar.querySelector(".tab-title");
        if (input && !input.value) closeCompose();
      }, 0);
    };
    const addBtn = bar.querySelector(".tab-add");
    const titleInput = bar.querySelector(".tab-title");
    if (addBtn) addBtn.addEventListener("click", closeIfAdded);
    if (titleInput) titleInput.addEventListener("keydown", function(e){
      if (e.key === "Enter") closeIfAdded();
      if (e.key === "Escape") closeCompose();
    });
  }
})();
