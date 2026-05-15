// ======== SIDE DRAWERS ========
// Right edge: one tab rail. "Tasks" is permanent; individual sections can be
// dragged onto the same rail as solo tabs.

(function(){
  const TASKS_OPEN_KEY = "pa-tasks-drawer-open";
  const PINNED_SECTIONS_KEY = "pa-sidecar-sections";
  const MOBILE_BREAKPOINT = 1023;
  const DEFAULT_SECTIONS = ["tm-side-projects-section", "tm-repeat-responsibilities-section"];

  function isMobile(){ return window.matchMedia("(max-width:" + MOBILE_BREAKPOINT + "px)").matches; }

  function setOpen(drawer, open){
    if(!drawer) return;
    drawer.classList.toggle("open", !!open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function drawer(){ return document.getElementById("tasks-drawer"); }
  function sectionById(id){ return id ? document.getElementById(id) : null; }

  function sectionLabel(section){
    if(!section) return "";
    if(section.dataset.sidecarLabel) return section.dataset.sidecarLabel;
    const summary = section.querySelector(":scope > summary");
    if(!summary) return section.id || "Section";
    const clone = summary.cloneNode(true);
    clone.querySelectorAll(".badge,.tm-chevron,.tm-section-pin,.tm-section-unpin").forEach(n => n.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim() || section.id || "Section";
  }

  function sectionBadge(section){
    const badge = section && section.querySelector(":scope > summary .badge");
    if(!badge) return { text: "", show: false };
    const text = (badge.textContent || "").trim();
    return { text, show: badge.style.display !== "none" && !!text && text !== "0" };
  }

  function loadPinnedSections(){
    try {
      const raw = JSON.parse(localStorage.getItem(PINNED_SECTIONS_KEY) || "null");
      if(Array.isArray(raw)) return raw.filter(id => sectionById(id));
    } catch(e){}
    return DEFAULT_SECTIONS.filter(id => sectionById(id));
  }

  function savePinnedSections(ids){
    try { localStorage.setItem(PINNED_SECTIONS_KEY, JSON.stringify(ids)); } catch(e){}
  }

  function currentPinnedSections(){
    return Array.from(document.querySelectorAll("#sidecar-tabs .sidecar-tab[data-section-id]")).map(btn => btn.dataset.sectionId);
  }

  function updateRailActiveState(){
    const d = drawer();
    const open = !!d?.classList.contains("open");
    const soloId = d?.dataset.soloSection || "";
    document.querySelectorAll("#sidecar-tabs .sidecar-tab[data-section-id]").forEach(btn => {
      btn.classList.toggle("active", open && soloId === btn.dataset.sectionId);
    });
    document.getElementById("sidecar-tasks-tab")?.classList.toggle("active", open && !soloId);
  }

  function syncBackdrop(){
    const bd = document.getElementById("side-drawer-backdrop");
    if(!bd) return;
    const tasksOpen = drawer()?.classList.contains("open");
    bd.classList.toggle("show", isMobile() && tasksOpen);
  }

  function syncBodyClasses(){
    const tasksOpen = drawer()?.classList.contains("open");
    document.body.classList.toggle("tasks-drawer-open", !!tasksOpen);
  }

  function setSoloSection(sectionId){
    const d = drawer();
    if(!d) return;
    const solo = !!sectionId;
    d.classList.toggle("solo", solo);
    d.dataset.soloSection = sectionId || "";
    document.getElementById("tasks-drawer-title").textContent = solo ? sectionLabel(sectionById(sectionId)) : "Tasks";
    const allBtn = document.getElementById("tasks-drawer-all");
    if(allBtn) allBtn.style.display = solo ? "" : "none";
    document.querySelectorAll("#tasks-drawer details.tm-section").forEach(sec => {
      const hidden = solo && sec.id !== sectionId;
      sec.classList.toggle("solo-hidden", hidden);
      if(solo && !hidden) sec.open = true;
    });
    document.querySelectorAll("#sidecar-tabs .sidecar-tab[data-section-id]").forEach(btn => {
      btn.classList.toggle("active", solo && btn.dataset.sectionId === sectionId);
    });
    updateRailActiveState();
  }

  function openTasks(opts){
    const d = drawer();
    setOpen(d, true);
    if(!(opts && opts.solo)) setSoloSection(null);
    try { localStorage.setItem(TASKS_OPEN_KEY, "1"); } catch(e){}
    syncBodyClasses(); syncBackdrop();
    updateRailActiveState();
  }

  function closeTasks(opts){
    const d = drawer();
    setOpen(d, false);
    if(!(opts && opts.keepSolo)) setSoloSection(null);
    if(!(opts && opts.skipPersist)){ try { localStorage.removeItem(TASKS_OPEN_KEY); } catch(e){} }
    syncBodyClasses(); syncBackdrop();
    updateRailActiveState();
  }

  function toggleTasks(){
    const d = drawer();
    if(d?.classList.contains("open") && !d?.dataset.soloSection) closeTasks();
    else openTasks();
  }

  function openTasksToSection(sectionId, opts){
    openTasks({ solo: opts && opts.solo });
    if(opts && opts.solo) setSoloSection(sectionId);
    const sec = sectionById(sectionId);
    if(sec){
      sec.open = true;
      setTimeout(() => sec.scrollIntoView({behavior:"smooth", block:"start"}), 240);
    }
  }

  function openTasksToSideProjects(){ openTasksToSection("tm-side-projects-section", { solo: true }); }
  function openTasksToRepeatResponsibilities(){ openTasksToSection("tm-repeat-responsibilities-section", { solo: true }); }

  function pinSection(sectionId, opts){
    const sec = sectionById(sectionId);
    if(!sec) return;
    const ids = currentPinnedSections().length ? currentPinnedSections() : loadPinnedSections();
    const existing = ids.filter(id => id !== sectionId);
    const next = opts && opts.prepend ? [sectionId, ...existing] : [...existing, sectionId];
    savePinnedSections(next);
    renderSidecarTabs(next);
    if(typeof showToast === "function") showToast(sectionLabel(sec) + " tab added", "success");
  }

  function unpinSection(sectionId){
    const next = currentPinnedSections().filter(id => id !== sectionId);
    savePinnedSections(next);
    renderSidecarTabs(next);
    if(drawer()?.dataset.soloSection === sectionId) setSoloSection(null);
  }

  function renderSidecarTabs(ids){
    const rail = document.getElementById("sidecar-tabs");
    if(!rail) return;
    const clean = (ids || loadPinnedSections()).filter((id, idx, arr) => sectionById(id) && arr.indexOf(id) === idx);
    rail.innerHTML = '<div class="sidecar-drop-hint" id="sidecar-drop-hint">Drop section</div>';
    const tasksBtn = document.createElement("button");
    tasksBtn.className = "sidecar-tab sidecar-tab-permanent";
    tasksBtn.id = "sidecar-tasks-tab";
    tasksBtn.type = "button";
    tasksBtn.innerHTML = '<span>Tasks</span><span class="badge" id="tasks-count" style="display:none">0</span>';
    tasksBtn.addEventListener("click", toggleTasks);
    rail.appendChild(tasksBtn);
    clean.forEach(id => {
      const sec = sectionById(id);
      const badge = sectionBadge(sec);
      const btn = document.createElement("button");
      btn.className = "sidecar-tab";
      btn.type = "button";
      btn.dataset.sectionId = id;
      btn.draggable = true;
      btn.innerHTML =
        '<span>' + escAttr(sectionLabel(sec)) + '</span>' +
        '<span class="badge" style="' + (badge.show ? "" : "display:none") + '">' + escAttr(badge.text) + '</span>' +
        '<span class="sidecar-remove" title="Remove tab" aria-label="Remove tab">&times;</span>';
      btn.addEventListener("click", e => {
        if(e.target.closest(".sidecar-remove")){ unpinSection(id); return; }
        openTasksToSection(id, { solo: true });
      });
      btn.addEventListener("dragstart", e => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.setData("application/x-dcc-sidecar-tab", id);
      });
      btn.addEventListener("dragover", e => {
        const draggedSectionId = e.dataTransfer.getData("application/x-dcc-section") || e.dataTransfer.getData("application/x-dcc-sidecar-tab");
        if(draggedSectionId || (id === "tm-side-projects-section" && typeof dragId !== "undefined" && dragId)){
          e.preventDefault();
          btn.classList.add("drag-over");
        }
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("drag-over"));
      btn.addEventListener("drop", e => {
        const draggedSectionId = e.dataTransfer.getData("application/x-dcc-section") || e.dataTransfer.getData("application/x-dcc-sidecar-tab");
        if(!draggedSectionId && id === "tm-side-projects-section" && moveDraggedTaskToSideProjects()){
          e.preventDefault();
          btn.classList.remove("drag-over");
          dragId = null;
          document.querySelectorAll(".dragging").forEach(node => node.classList.remove("dragging"));
          if(typeof render === "function") render();
          openTasksToSideProjects();
          return;
        }
        if(!draggedSectionId || !sectionById(draggedSectionId)) return;
        e.preventDefault();
        btn.classList.remove("drag-over");
        const without = currentPinnedSections().filter(x => x !== draggedSectionId);
        const at = without.indexOf(id);
        without.splice(at < 0 ? without.length : at, 0, draggedSectionId);
        savePinnedSections(without);
        renderSidecarTabs(without);
      });
      rail.appendChild(btn);
    });
    setSoloSection(drawer()?.dataset.soloSection || null);
  }

  function escAttr(s){
    return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function refreshSidecarBadges(){
    document.querySelectorAll("#sidecar-tabs .sidecar-tab[data-section-id]").forEach(btn => {
      const badge = sectionBadge(sectionById(btn.dataset.sectionId));
      const el = btn.querySelector(".badge");
      if(el){ el.textContent = badge.text; el.style.display = badge.show ? "" : "none"; }
    });
    const taskBadge = document.getElementById("tasks-count");
    if(taskBadge){
      const count = parseInt(taskBadge.textContent || "0", 10) || 0;
      taskBadge.style.display = count ? "" : "none";
    }
    updateRailActiveState();
  }

  function bindSectionDragging(){
    document.querySelectorAll("#tasks-drawer details.tm-section").forEach(sec => {
      const summary = sec.querySelector(":scope > summary");
      if(!summary || summary.dataset.sidecarDragBound) return;
      summary.dataset.sidecarDragBound = "1";
      summary.draggable = true;
      summary.title = "Drag to the right rail to make this a tab";
      if(!summary.querySelector(".tm-section-pin")){
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "tm-section-pin";
        pin.title = "Add this section as a side tab";
        pin.textContent = "Tab";
        pin.addEventListener("click", e => {
          e.preventDefault();
          e.stopPropagation();
          pinSection(sec.id);
        });
        summary.appendChild(pin);
      }
      summary.addEventListener("dragstart", e => {
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/plain", sec.id);
        e.dataTransfer.setData("application/x-dcc-section", sec.id);
      });
    });
  }

  function bindRailDrop(){
    const rail = document.getElementById("sidecar-tabs");
    if(!rail) return;
    rail.addEventListener("dragover", e => {
      const dragId = e.dataTransfer.getData("application/x-dcc-section") || e.dataTransfer.getData("application/x-dcc-sidecar-tab");
      if(dragId && sectionById(dragId)){
        e.preventDefault();
        rail.classList.add("drag-over");
      }
    });
    rail.addEventListener("dragleave", e => {
      if(!rail.contains(e.relatedTarget)) rail.classList.remove("drag-over");
    });
    rail.addEventListener("drop", e => {
      const dragId = e.dataTransfer.getData("application/x-dcc-section") || e.dataTransfer.getData("application/x-dcc-sidecar-tab");
      if(dragId && sectionById(dragId)){
        e.preventDefault();
        rail.classList.remove("drag-over");
        pinSection(dragId);
      }
    });
  }

  function moveDraggedTaskToSideProjects(){
    if(typeof dragId === "undefined" || !dragId) return false;

    const scheduledTask = (typeof scheduled !== "undefined" ? scheduled : []).find(ev => ev.id === dragId);
    if(scheduledTask && typeof moveScheduledTaskToSideProject === "function"){
      moveScheduledTaskToSideProject(scheduledTask.id);
      return true;
    }

    const backlogTask = (typeof backlog !== "undefined" ? backlog : []).find(t => t.id === dragId);
    if(backlogTask && typeof addSideProjectTask === "function"){
      addSideProjectTask(backlogTask.title, backlogTask.durMin || 30);
      if(typeof deleteTaskBankBacklogTask === "function") deleteTaskBankBacklogTask(backlogTask.id);
      window._dragFromBacklog = false;
      if(typeof showToast === "function") showToast("Moved to Side Projects", "success");
      return true;
    }

    const priorityTask = (typeof consider !== "undefined" ? consider : []).find(t => t.id === dragId);
    if(priorityTask && typeof addSideProjectTask === "function"){
      addSideProjectTask(priorityTask.title, priorityTask.durMin || 30);
      if(typeof showToast === "function") showToast("Added to Side Projects", "success");
      return true;
    }

    return false;
  }

  function bindSideProjectDropTarget(el){
    if(!el) return;
    el.addEventListener("dragover", e => {
      if(typeof dragId !== "undefined" && dragId){
        e.preventDefault();
        el.classList.add("drag-over");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");
      if(moveDraggedTaskToSideProjects()){
        dragId = null;
        document.querySelectorAll(".dragging").forEach(node => node.classList.remove("dragging"));
        if(typeof render === "function") render();
        openTasksToSideProjects();
      }
    });
  }

  function init(){
    document.getElementById("tasks-drawer-close")?.addEventListener("click", () => closeTasks());
    document.getElementById("tasks-drawer-all")?.addEventListener("click", () => { setSoloSection(null); openTasks(); });
    bindSectionDragging();
    bindRailDrop();
    renderSidecarTabs(loadPinnedSections());
    bindSideProjectDropTarget(document.getElementById("tm-side-projects-section"));

    const bd = document.getElementById("side-drawer-backdrop");
    if(bd){
      bd.addEventListener("click", () => {
        closeTasks();
      });
    }

    document.addEventListener("keydown", e => {
      if(e.key === "Escape"){
        const d = drawer();
        if(d?.classList.contains("open")) closeTasks();
      }
    });

    document.addEventListener("pointerdown", e => {
      const d = drawer();
      if(!d?.classList.contains("open")) return;
      if(e.target.closest("#tasks-drawer .side-drawer-body")) return;
      if(e.target.closest(".sidecar-tabs")) return;
      closeTasks();
    });

    window.addEventListener("resize", () => { syncBackdrop(); syncBodyClasses(); });

    try {
      if(!isMobile()){
        if(localStorage.getItem(TASKS_OPEN_KEY)) openTasks();
      }
    } catch(e){}
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.openTasksDrawer = openTasks;
  window.closeTasksDrawer = closeTasks;
  window.openTasksToSection = openTasksToSection;
  window.openTasksToRepeatResponsibilities = openTasksToRepeatResponsibilities;
  window.refreshSidecarTabs = function(){
    bindSectionDragging();
    refreshSidecarBadges();
  };
})();
