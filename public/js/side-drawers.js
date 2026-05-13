// ======== SIDE DRAWERS ========
// Right edge: Tasks drawer (Triage / Scheduled / Priority / Backlog / Side Projects)
// On desktop the drawer pushes the body padding so the Itinerary timeline
// stays visible. On tablet/mobile it overlays the content with a backdrop.

(function(){
  const TASKS_OPEN_KEY = "pa-tasks-drawer-open";
  const MOBILE_BREAKPOINT = 1023;

  function isMobile(){ return window.matchMedia("(max-width:" + MOBILE_BREAKPOINT + "px)").matches; }

  function setOpen(drawer, open){
    if(!drawer) return;
    drawer.classList.toggle("open", !!open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function syncBackdrop(){
    const bd = document.getElementById("side-drawer-backdrop");
    if(!bd) return;
    const tasksOpen = document.getElementById("tasks-drawer")?.classList.contains("open");
    bd.classList.toggle("show", isMobile() && tasksOpen);
  }

  function syncBodyClasses(){
    const tasksOpen = document.getElementById("tasks-drawer")?.classList.contains("open");
    document.body.classList.toggle("tasks-drawer-open", !!tasksOpen);
  }

  function openTasks(){
    const d = document.getElementById("tasks-drawer");
    setOpen(d, true);
    try { localStorage.setItem(TASKS_OPEN_KEY, "1"); } catch(e){}
    syncBodyClasses(); syncBackdrop();
  }
  function closeTasks(opts){
    const d = document.getElementById("tasks-drawer");
    setOpen(d, false);
    if(!(opts && opts.skipPersist)){ try { localStorage.removeItem(TASKS_OPEN_KEY); } catch(e){} }
    syncBodyClasses(); syncBackdrop();
  }

  function toggleTasks(){
    const d = document.getElementById("tasks-drawer");
    if(d?.classList.contains("open")) closeTasks(); else openTasks();
  }

  function openTasksToSection(sectionId){
    openTasks();
    const sec = document.getElementById(sectionId);
    if(sec){
      sec.open = true;
      // Scroll into view inside the drawer's scroll container after the slide animation settles.
      setTimeout(() => sec.scrollIntoView({behavior:"smooth", block:"start"}), 240);
    }
  }
  function openTasksToSideProjects(){ openTasksToSection("tm-side-projects-section"); }

  function moveDraggedTaskToSideProjects(){
    if(typeof dragId === "undefined" || !dragId) return false;

    const scheduledTask = (typeof scheduled !== "undefined" ? scheduled : []).find(ev => ev.id === dragId);
    if(scheduledTask && typeof toggleTrivialFlag === "function"){
      if(!loadTrivialFlags()[scheduledTask.id]) toggleTrivialFlag(scheduledTask.id);
      if(typeof showToast === "function") showToast("Moved to Side Projects", "success");
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
    document.getElementById("tasks-drawer-handle")?.addEventListener("click", toggleTasks);
    document.getElementById("tasks-drawer-close")?.addEventListener("click", () => closeTasks());
    document.getElementById("side-projects-tab")?.addEventListener("click", openTasksToSideProjects);
    bindSideProjectDropTarget(document.getElementById("side-projects-tab"));
    bindSideProjectDropTarget(document.getElementById("tm-side-projects-section"));

    const bd = document.getElementById("side-drawer-backdrop");
    if(bd){
      bd.addEventListener("click", () => {
        closeTasks();
      });
    }

    document.addEventListener("keydown", e => {
      if(e.key === "Escape"){
        const d = document.getElementById("tasks-drawer");
        if(d?.classList.contains("open")) closeTasks();
      }
    });

    document.addEventListener("pointerdown", e => {
      const d = document.getElementById("tasks-drawer");
      if(!d?.classList.contains("open")) return;
      if(e.target.closest("#tasks-drawer .side-drawer-body")) return;
      if(e.target.closest("#tasks-drawer-handle")) return;
      if(e.target.closest(".sidecar-tabs")) return;
      closeTasks();
    });

    window.addEventListener("resize", () => { syncBackdrop(); syncBodyClasses(); });

    // Restore open state on load (skip on mobile to avoid surprise overlays)
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
})();
