// ======== MOBILE SHELL ========
// Phone-only (<=760px) app shell layered on top of the desktop dashboard.
//
// Everything in here is additive and gated so the desktop experience is never
// touched:
//   * All DOM created here is `display:none` in the base (desktop) cascade and
//     only revealed inside `@media (max-width:760px)` (see dashboard.css).
//   * All behaviour reuses existing globals exported by side-drawers.js / tabs.js
//     (openTasksDrawer, closeTasksDrawer, openTasksToSection, the .tab click path).
//
// Components: a fixed bottom navigation bar, a "More" action sheet that houses the
// overflow content tabs + owner buttons, and segmented section pills inside the
// Tasks sheet.
(function(){
  "use strict";

  const MOBILE_QUERY = "(max-width:760px)";
  const mq = window.matchMedia(MOBILE_QUERY);

  // Shared mobile gate. Other modules may read window.DCC_MOBILE.is().
  window.DCC_MOBILE = { mq: mq, is(){ return mq.matches; } };

  // ---- helpers ---------------------------------------------------------------

  function $(sel){ return document.querySelector(sel); }
  function byId(id){ return document.getElementById(id); }

  function tasksDrawer(){ return byId("tasks-drawer"); }
  function drawerOpen(){ const d = tasksDrawer(); return !!(d && d.classList.contains("open")); }

  function toggleTasksDrawer(){
    if(drawerOpen()){ if(typeof window.closeTasksDrawer === "function") window.closeTasksDrawer(); }
    else { if(typeof window.openTasksDrawer === "function") window.openTasksDrawer(); }
  }

  // Reuse the existing top-tab click path so all per-tab init in tabs.js runs.
  function activateTab(name){
    const btn = document.querySelector('.tab[data-tab="' + name + '"]');
    if(btn) btn.click();
  }

  // ---- bottom navigation bar -------------------------------------------------

  const NAV_ITEMS = [
    { key:"schedule",   label:"Today", icon:"🗓", action(){ activateTab("schedule"); } },
    { key:"glymphatic", label:"Brief", icon:"📋", action(){ activateTab("glymphatic"); }, badge:"glymphatic-count" },
    { key:"__tasks",    label:"Tasks", icon:"☑",        action(){ closeMoreSheet(); toggleTasksDrawer(); }, center:true },
    { key:"slots",      label:"Slots", icon:"🎰", action(){ activateTab("slots"); }, badge:"slots-credit-badge" },
    { key:"__more",     label:"More",  icon:"⋯",        action(){ toggleMoreSheet(); } }
  ];

  function buildTabbar(){
    if(byId("mobile-tabbar")) return;
    const bar = document.createElement("nav");
    bar.id = "mobile-tabbar";
    bar.setAttribute("aria-label", "Primary navigation");
    NAV_ITEMS.forEach(item => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mtab" + (item.center ? " mtab-center" : "");
      b.dataset.navKey = item.key;
      b.innerHTML =
        '<span class="mtab-icon" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="mtab-label">' + item.label + '</span>' +
        (item.badge ? '<span class="mtab-badge" data-badge-src="' + item.badge + '" style="display:none"></span>' : '');
      b.addEventListener("click", item.action);
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
  }

  // ---- "More" action sheet ---------------------------------------------------

  // Overflow content tabs (not surfaced directly in the bottom bar).
  const MORE_TABS = [
    { label:"Delegated", tab:"delegated", badge:"delegated-count" },
    { label:"Pet Home",  tab:"pet-home", badge:"pet-home-badge" },
    { label:"Runway",    tab:"runway" }
  ];

  // Owner actions: each row triggers the existing header element's own handler,
  // so there is no duplicated logic. `find` returns the live source element.
  const MORE_ACTIONS = [
    { label:"Admin",            icon:"⚙", find(){ return document.querySelector('a.admin-link[href="/admin"]'); } },
    { label:"Share list",       icon:"🔗", find(){ return byId("todo-share-open"); } },
    { label:"Refresh reactions",icon:"🔄", find(){ return byId("todo-reactions-toggle"); } },
    { label:"Sticky Notes",     icon:"📌", find(){ return byId("sn-open-btn"); } },
    { label:"Copy for Claude",  icon:"📋", find(){ return byId("btn-copy"); } },
    { label:"Replay tutorial",  icon:"🎓", find(){ return byId("dcc-replay-tutorial"); } },
    { label:"Sign out",         icon:"⏻", find(){ return byId("dcc-sign-out"); } }
  ];

  function moreSheetOpen(){ const s = byId("mobile-more-sheet"); return !!(s && s.classList.contains("open")); }

  function openMoreSheet(){
    buildMoreSheet();
    byId("mobile-more-sheet")?.classList.add("open");
    byId("mobile-more-backdrop")?.classList.add("open");
    syncActiveNav();
  }
  function closeMoreSheet(){
    byId("mobile-more-sheet")?.classList.remove("open");
    byId("mobile-more-backdrop")?.classList.remove("open");
    syncActiveNav();
  }
  function toggleMoreSheet(){ moreSheetOpen() ? closeMoreSheet() : openMoreSheet(); }

  function makeMoreRow(label, icon, onClick){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mmore-row";
    b.innerHTML = '<span class="mmore-icon" aria-hidden="true">' + (icon || "") + '</span>' +
                  '<span class="mmore-text">' + label + '</span>';
    b.addEventListener("click", () => { closeMoreSheet(); onClick(); });
    return b;
  }

  function buildMoreSheet(){
    if(byId("mobile-more-sheet")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "mobile-more-backdrop";
    backdrop.addEventListener("click", closeMoreSheet);
    document.body.appendChild(backdrop);

    const sheet = document.createElement("div");
    sheet.id = "mobile-more-sheet";
    sheet.setAttribute("role", "menu");
    sheet.innerHTML = '<div class="mmore-handle" aria-hidden="true"></div>';

    // Overflow tabs
    const navTitle = document.createElement("div");
    navTitle.className = "mmore-title";
    navTitle.textContent = "Views";
    sheet.appendChild(navTitle);
    MORE_TABS.forEach(t => {
      sheet.appendChild(makeMoreRow(t.label, "📄", () => activateTab(t.tab)));
    });

    const divider = document.createElement("div");
    divider.className = "mmore-divider";
    sheet.appendChild(divider);

    const actTitle = document.createElement("div");
    actTitle.className = "mmore-title";
    actTitle.textContent = "Actions";
    sheet.appendChild(actTitle);
    MORE_ACTIONS.forEach(a => {
      sheet.appendChild(makeMoreRow(a.label, a.icon, () => {
        const el = a.find();
        if(el) el.click();
      }));
    });

    document.body.appendChild(sheet);
  }

  // ---- active-state + badge sync --------------------------------------------

  function syncActiveNav(){
    const active = document.querySelector(".tab.active");
    const key = active ? active.dataset.tab : null;
    const overflow = ["delegated", "pet-home", "runway"];
    document.querySelectorAll("#mobile-tabbar .mtab").forEach(b => {
      const navKey = b.dataset.navKey;
      let on = false;
      if(navKey === "__tasks") on = drawerOpen();
      else if(navKey === "__more") on = moreSheetOpen() || overflow.indexOf(key) !== -1;
      else on = navKey === key && !drawerOpen() && !moreSheetOpen();
      b.classList.toggle("active", on);
    });
  }

  function syncBadges(){
    document.querySelectorAll("#mobile-tabbar .mtab-badge[data-badge-src]").forEach(badge => {
      const src = byId(badge.dataset.badgeSrc);
      if(!src){ badge.style.display = "none"; return; }
      const text = (src.textContent || "").trim();
      const visible = src.style.display !== "none" && !!text && text !== "0";
      badge.textContent = text;
      badge.style.display = visible ? "" : "none";
    });
  }

  // ---- Tasks-sheet section pills (Phase 3) -----------------------------------

  const SHEET_SECTIONS = [
    { id:"tm-triage-section",                 label:"Triage" },
    { id:"tm-scheduled-section",              label:"Scheduled" },
    { id:"tm-soon-section",                   label:"Priority" },
    { id:"tm-backlog-section",                label:"Backlog and Ideas" },
    { id:"tm-side-projects-section",          label:"Side Projects" },
    { id:"tm-repeat-responsibilities-section",label:"Repeat" }
  ];

  function buildSheetSegments(){
    if(byId("mobile-sheet-segments")) return;
    const header = document.querySelector("#tasks-drawer .side-drawer-header");
    if(!header) return;

    const wrap = document.createElement("div");
    wrap.id = "mobile-sheet-segments";

    const all = document.createElement("button");
    all.type = "button";
    all.className = "msheet-seg";
    all.dataset.segAll = "1";
    all.textContent = "All";
    all.addEventListener("click", () => { if(typeof window.openTasksDrawer === "function") window.openTasksDrawer(); });
    wrap.appendChild(all);

    SHEET_SECTIONS.forEach(s => {
      if(!byId(s.id)) return;
      const p = document.createElement("button");
      p.type = "button";
      p.className = "msheet-seg";
      p.dataset.segId = s.id;
      p.textContent = s.label;
      p.addEventListener("click", () => {
        if(typeof window.openTasksToSection === "function") window.openTasksToSection(s.id, { solo:true });
      });
      wrap.appendChild(p);
    });

    header.insertAdjacentElement("afterend", wrap);
  }

  function syncSegments(){
    const d = tasksDrawer();
    const solo = d ? (d.dataset.soloSection || "") : "";
    document.querySelectorAll("#mobile-sheet-segments .msheet-seg").forEach(p => {
      if(p.dataset.segAll) p.classList.toggle("active", !solo);
      else p.classList.toggle("active", p.dataset.segId === solo);
    });
  }

  // ---- wiring ----------------------------------------------------------------

  function init(){
    buildTabbar();
    buildMoreSheet();
    buildSheetSegments();

    // Keep nav active-state + badges in sync with the existing top tab strip.
    const tabBar = byId("tab-bar");
    if(tabBar){
      tabBar.addEventListener("click", () => { closeMoreSheet(); setTimeout(() => { syncActiveNav(); syncBadges(); }, 0); });
      new MutationObserver(() => { syncActiveNav(); syncBadges(); })
        .observe(tabBar, { subtree:true, childList:true, attributes:true, characterData:true });
    }

    // React to drawer open/close + solo-section changes.
    const d = tasksDrawer();
    if(d){
      new MutationObserver(() => { syncActiveNav(); syncSegments(); })
        .observe(d, { attributes:true, attributeFilter:["class", "data-solo-section"] });
    }

    // Close the More sheet on Escape.
    document.addEventListener("keydown", e => { if(e.key === "Escape" && moreSheetOpen()) closeMoreSheet(); });

    // Re-sync when crossing the mobile breakpoint (rotation / resize / devtools).
    const onChange = () => { syncActiveNav(); syncBadges(); syncSegments(); if(!mq.matches) closeMoreSheet(); };
    if(typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if(typeof mq.addListener === "function") mq.addListener(onChange);

    window.addEventListener("dcc:data-ready", () => { syncBadges(); syncActiveNav(); });

    syncActiveNav();
    syncBadges();
    syncSegments();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // Expose a couple of hooks for debugging / external callers.
  window.DCC_MOBILE.openMore = openMoreSheet;
  window.DCC_MOBILE.closeMore = closeMoreSheet;
})();
