(function(){
  var TOUR_KEY = "dailyCommandCenterTour";
  var TOUR_VERSION = 2;
  var hasAutoChecked = false;
  var settingsBound = false;
  var active = false;
  var currentIndex = 0;
  var els = {};

  var steps = [
    {
      title: "Welcome",
      body: "Quick tour of the parts that aren't obvious."
    },
    {
      title: "Earn Points",
      body: "Finishing tasks earns points.",
      selector: ".stats"
    },
    {
      title: "Feed Your Pet",
      body: "Spend points to keep your pet fed.",
      selector: "#pet-home-tab-btn"
    },
    {
      title: "Spin For Rewards",
      body: "Spend points to spin the slot machine.",
      selector: "#slots-tab-btn"
    },
    {
      title: "Set Up Rewards",
      body: "Free self-care rewards, or paid ones capped by a monthly budget. Pin one as a goal.",
      selector: "#slots-tab-btn"
    },
    {
      title: "Share Your List",
      body: "Invite people to a live view of your day. On a task they can react, comment, or hit the bounty button to make it pay 2x points. In Offer a Reward they can fund an existing reward or add a new one (even a private surprise) to a task or straight to the slot machine.",
      selector: "#todo-share-open"
    },
    {
      title: "Replay Anytime",
      body: "Reopen this tour from Settings.",
      selector: "#dcc-settings-button"
    }
  ];

  function $(id){ return document.getElementById(id); }

  function closeSettingsMenu(){
    var wrap = $("dcc-settings-wrap");
    var btn = $("dcc-settings-button");
    var menu = $("dcc-settings-menu");
    if (wrap) wrap.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (menu) menu.setAttribute("aria-hidden", "true");
  }

  function toggleSettingsMenu(){
    var wrap = $("dcc-settings-wrap");
    var btn = $("dcc-settings-button");
    var menu = $("dcc-settings-menu");
    if (!wrap || !btn || !menu) return;
    var open = !wrap.classList.contains("open");
    wrap.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-hidden", String(!open));
  }

  function ensureElements(){
    if (els.root) return;
    var root = document.createElement("div");
    root.className = "dcc-tour-root";
    root.innerHTML =
      '<div class="dcc-tour-scrim"></div>' +
      '<div class="dcc-tour-highlight" aria-hidden="true"></div>' +
      '<section class="dcc-tour-card" role="dialog" aria-modal="true" aria-live="polite">' +
        '<button class="dcc-tour-close" type="button" aria-label="Dismiss tutorial">&times;</button>' +
        '<div class="dcc-tour-kicker"></div>' +
        '<h2 class="dcc-tour-title"></h2>' +
        '<p class="dcc-tour-body"></p>' +
        '<div class="dcc-tour-progress"></div>' +
        '<div class="dcc-tour-actions">' +
          '<button class="dcc-tour-skip" type="button">Skip</button>' +
          '<div class="dcc-tour-step-actions">' +
            '<button class="dcc-tour-back" type="button">Back</button>' +
            '<button class="dcc-tour-next" type="button">Next</button>' +
          '</div>' +
        '</div>' +
      '</section>';
    document.body.appendChild(root);
    els = {
      root: root,
      highlight: root.querySelector(".dcc-tour-highlight"),
      card: root.querySelector(".dcc-tour-card"),
      close: root.querySelector(".dcc-tour-close"),
      kicker: root.querySelector(".dcc-tour-kicker"),
      title: root.querySelector(".dcc-tour-title"),
      body: root.querySelector(".dcc-tour-body"),
      progress: root.querySelector(".dcc-tour-progress"),
      skip: root.querySelector(".dcc-tour-skip"),
      back: root.querySelector(".dcc-tour-back"),
      next: root.querySelector(".dcc-tour-next")
    };
    els.close.addEventListener("click", function(){ dismissTour("dismissedAt"); });
    els.skip.addEventListener("click", function(){ dismissTour("dismissedAt"); });
    els.back.addEventListener("click", previousStep);
    els.next.addEventListener("click", nextStep);
  }

  function targetForStep(step){
    if (!step.selector) return null;
    var target = document.querySelector(step.selector);
    if (!target) return null;
    var rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      try { target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); } catch(e) {}
    }
    rect = target.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
    return { el: target, rect: rect };
  }

  function clamp(value, min, max){
    return Math.max(min, Math.min(max, value));
  }

  function placeCard(target){
    var card = els.card;
    var margin = 14;
    card.classList.toggle("dcc-tour-card-centered", !target);
    els.root.classList.toggle("dcc-tour-has-target", !!target);
    if (!target) {
      els.highlight.style.display = "none";
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    var rect = target.rect;
    var pad = 8;
    els.highlight.style.display = "block";
    els.highlight.style.left = clamp(rect.left - pad, margin, window.innerWidth - margin) + "px";
    els.highlight.style.top = clamp(rect.top - pad, margin, window.innerHeight - margin) + "px";
    els.highlight.style.width = Math.max(0, Math.min(rect.width + pad * 2, window.innerWidth - margin * 2)) + "px";
    els.highlight.style.height = Math.max(0, Math.min(rect.height + pad * 2, window.innerHeight - margin * 2)) + "px";

    card.style.transform = "none";
    var cardRect = card.getBoundingClientRect();
    var width = cardRect.width || 340;
    var height = cardRect.height || 220;
    var left = rect.left;
    var top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) top = rect.top - height - margin;
    if (top < margin) top = margin;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function renderStep(){
    if (!active) return;
    ensureElements();
    var step = steps[currentIndex];
    els.kicker.textContent = "Step " + (currentIndex + 1) + " of " + steps.length;
    els.title.textContent = step.title;
    els.body.textContent = step.body;
    els.progress.textContent = "";
    for (var i = 0; i < steps.length; i++) {
      var dot = document.createElement("span");
      dot.className = "dcc-tour-dot" + (i === currentIndex ? " active" : "");
      els.progress.appendChild(dot);
    }
    els.back.disabled = currentIndex === 0;
    els.next.textContent = currentIndex === steps.length - 1 ? "Done" : "Next";
    var target = targetForStep(step);
    setTimeout(function(){ placeCard(targetForStep(step) || target); }, target ? 180 : 0);
  }

  function startTour(options){
    options = options || {};
    closeSettingsMenu();
    ensureElements();
    active = true;
    currentIndex = 0;
    els.root.classList.add("open");
    document.body.classList.add("dcc-tour-active");
    renderStep();
    if (options.replay && typeof showToast === "function") showToast("Tutorial restarted");
  }

  function stopTour(){
    active = false;
    if (els.root) els.root.classList.remove("open");
    document.body.classList.remove("dcc-tour-active");
  }

  function previousStep(){
    if (currentIndex <= 0) return;
    currentIndex -= 1;
    renderStep();
  }

  function nextStep(){
    if (currentIndex >= steps.length - 1) {
      dismissTour("completedAt");
      return;
    }
    currentIndex += 1;
    renderStep();
  }

  async function saveTourState(field){
    var stamp = new Date().toISOString();
    var tourState = { version: TOUR_VERSION };
    tourState[field] = stamp;
    var payload = {};
    payload[TOUR_KEY] = tourState;
    var res = await fetch("/api/me/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      var data = await res.json().catch(function(){ return {}; });
      throw new Error(data.error || "Could not save tutorial preference");
    }
  }

  async function dismissTour(field){
    stopTour();
    try {
      await saveTourState(field);
    } catch (err) {
      if (typeof showToast === "function") showToast(err.message || "Could not save tutorial preference", "error");
    }
  }

  function shouldAutoStart(me){
    var state = (me && me.onboardingState && me.onboardingState[TOUR_KEY]) || {};
    if (state.version && state.version !== TOUR_VERSION) return true;
    return !state.completedAt && !state.dismissedAt;
  }

  async function maybeAutoStart(){
    if (hasAutoChecked) return;
    hasAutoChecked = true;
    try {
      var res = await fetch("/api/me");
      if (!res.ok) return;
      var me = await res.json();
      if (shouldAutoStart(me)) setTimeout(function(){ startTour(); }, 650);
    } catch(e) {}
  }

  function bindSettings(){
    if (settingsBound) return;
    settingsBound = true;
    var btn = $("dcc-settings-button");
    var replay = $("dcc-replay-tutorial");
    var signOut = $("dcc-sign-out");
    if (btn) btn.addEventListener("click", function(e){ e.stopPropagation(); toggleSettingsMenu(); });
    if (replay) replay.addEventListener("click", function(){ startTour({ replay: true }); });
    if (signOut) signOut.addEventListener("click", async function(){
      closeSettingsMenu();
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch(e) {}
      window.location.href = "/login";
    });
    document.addEventListener("click", function(e){
      var wrap = $("dcc-settings-wrap");
      if (wrap && !wrap.contains(e.target)) closeSettingsMenu();
    });
  }

  document.addEventListener("keydown", function(e){
    if (e.key === "Escape") {
      if (active) dismissTour("dismissedAt");
      else closeSettingsMenu();
    }
  });
  window.addEventListener("resize", function(){ if (active) renderStep(); });
  window.addEventListener("scroll", function(){ if (active) renderStep(); }, true);
  window.addEventListener("dcc:data-ready", maybeAutoStart);
  document.addEventListener("DOMContentLoaded", bindSettings);
  if (document.readyState !== "loading") bindSettings();

  window.DCCOnboardingTour = { start: startTour };
})();
