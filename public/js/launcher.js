// ======== UNIVERSAL "+" LAUNCHER ========
// The bottom-right "+" circle has two gestures:
//   - quick tap        -> open an Urgent-first compose + three-type quick fan
//   - press-and-hold   -> open the radial HUD (Add task / Start work / Feedback / Catch up)
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
    const typeSelect = bar && bar.querySelector(".tab-dest");
    if (typeSelect) typeSelect.value = "urgent";
    composeOpen = true;
    compose.classList.add("open");
    compose.setAttribute("aria-hidden", "false");
    showScrim();
    if (typeof window.openLauncherTaskTypeRadial === "function") window.openLauncherTaskTypeRadial(btn);
    const input = bar && bar.querySelector(".tab-title");
    if (input) setTimeout(function(){ input.focus(); }, 0);
  }
  function closeCompose(){
    if (!composeOpen) return;
    composeOpen = false;
    compose.classList.remove("open");
    compose.setAttribute("aria-hidden", "true");
    if (typeof window.closeRadialMenu === "function") window.closeRadialMenu();
    maybeHideScrim();
  }

  // ---- shared scrim ----
  function showScrim(){ if (scrim) scrim.classList.add("open"); }
  function maybeHideScrim(){ if (scrim && !radialOpen && !composeOpen) scrim.classList.remove("open"); }
  function closeAll(restoreFocus){
    const wasOpen = radialOpen || composeOpen;
    closeRadial();
    closeCompose();
    if (restoreFocus && wasOpen) btn.focus();
  }

  function toggleQuickCompose(){
    if (radialOpen) { closeRadial(); return; }
    if (composeOpen) { closeCompose(); btn.focus(); return; }
    openCompose();
  }

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
    // Short tap opens the Urgent-first form and its three quick alternatives.
    toggleQuickCompose();
  });

  // Handle the native keyboard path explicitly. Preventing the button's default
  // activation stops a second synthetic click, while assistive activation can
  // still use the independent detail=0 click path below.
  btn.addEventListener("keydown", function(e){
    if ((e.key === "Enter" || e.key === " ") && !e.repeat){
      e.preventDefault();
      toggleQuickCompose();
    }
  });
  btn.addEventListener("click", function(e){
    if (e.detail === 0) toggleQuickCompose();
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
    if (action === "task"){ openCompose(); }
    else if (action === "work" && window.DCCWorkSessions){ window.DCCWorkSessions.openPicker(); }
    else if (action === "feedback"){ if (typeof window.dccOpenFeedback === "function") window.dccOpenFeedback(); }
    else if (action === "catchup"){ if (typeof window.openUnfinishedTasks === "function") window.openUnfinishedTasks(); }
  });

  // ---- dismissal ----
  if (scrim) scrim.addEventListener("click", function(){ closeAll(true); });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape") closeAll(true);
  });

  // ---- compose: close after a successful add ----
  // schedule.js emits this only after a non-empty launcher submission, including
  // the deferred Schedule path. Blank validation therefore keeps the form open.
  if (bar){
    const titleInput = bar.querySelector(".tab-title");
    bar.addEventListener("dcc:launcher-submit-success", closeCompose);
    if (titleInput) titleInput.addEventListener("keydown", function(e){
      if (e.key === "Escape") { closeCompose(); btn.focus(); }
    });
  }
})();
