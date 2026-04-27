// ======== SIDE DRAWERS ========
// Right edge: Tasks drawer (Triage / Scheduled / Priority / Backlog / Trivial)
// Left edge:  Calendar drawer (mini-month + GCal + task panel)
// On desktop both drawers can be open at once and push the body padding so
// the Itinerary timeline stays visible. On tablet/mobile they overlay the
// content with a backdrop and only one drawer can be open at a time.

(function(){
  const TASKS_OPEN_KEY = "pa-tasks-drawer-open";
  const CAL_OPEN_KEY = "pa-cal-drawer-open";
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
    const calOpen = document.getElementById("calendar-drawer")?.classList.contains("open");
    bd.classList.toggle("show", isMobile() && (tasksOpen || calOpen));
  }

  function syncBodyClasses(){
    const tasksOpen = document.getElementById("tasks-drawer")?.classList.contains("open");
    const calOpen = document.getElementById("calendar-drawer")?.classList.contains("open");
    document.body.classList.toggle("tasks-drawer-open", !!tasksOpen);
    document.body.classList.toggle("cal-drawer-open", !!calOpen);
  }

  function openTasks(){
    if(isMobile()) closeCal({skipPersist:true});
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
  function openCal(){
    if(isMobile()) closeTasks({skipPersist:true});
    const d = document.getElementById("calendar-drawer");
    setOpen(d, true);
    // Re-render the calendar sidebar each time it opens so GCal/task lists are fresh.
    if(typeof renderCalendarSidebar === "function"){
      const mount = document.getElementById("tm-cal-mount");
      if(mount) mount.innerHTML = renderCalendarSidebar();
    }
    try { localStorage.setItem(CAL_OPEN_KEY, "1"); } catch(e){}
    syncBodyClasses(); syncBackdrop();
  }
  function closeCal(opts){
    const d = document.getElementById("calendar-drawer");
    setOpen(d, false);
    if(!(opts && opts.skipPersist)){ try { localStorage.removeItem(CAL_OPEN_KEY); } catch(e){} }
    syncBodyClasses(); syncBackdrop();
  }

  function toggleTasks(){
    const d = document.getElementById("tasks-drawer");
    if(d?.classList.contains("open")) closeTasks(); else openTasks();
  }
  function toggleCal(){
    const d = document.getElementById("calendar-drawer");
    if(d?.classList.contains("open")) closeCal(); else openCal();
  }

  function openTasksToTrivial(){
    openTasks();
    const sec = document.getElementById("tm-trivial-section");
    if(sec){
      sec.open = true;
      // Scroll into view inside the drawer's scroll container after the slide animation settles.
      setTimeout(() => sec.scrollIntoView({behavior:"smooth", block:"start"}), 240);
    }
  }

  function init(){
    document.getElementById("tasks-drawer-handle")?.addEventListener("click", toggleTasks);
    document.getElementById("tasks-drawer-close")?.addEventListener("click", () => closeTasks());
    document.getElementById("calendar-drawer-handle")?.addEventListener("click", toggleCal);
    document.getElementById("calendar-drawer-close")?.addEventListener("click", () => closeCal());
    document.getElementById("float-trivial")?.addEventListener("click", openTasksToTrivial);

    const bd = document.getElementById("side-drawer-backdrop");
    if(bd){
      bd.addEventListener("click", () => {
        closeTasks(); closeCal();
      });
    }

    document.addEventListener("keydown", e => {
      if(e.key === "Escape"){
        const d = document.getElementById("tasks-drawer");
        const c = document.getElementById("calendar-drawer");
        if(d?.classList.contains("open")) closeTasks();
        if(c?.classList.contains("open")) closeCal();
      }
    });

    window.addEventListener("resize", () => { syncBackdrop(); syncBodyClasses(); });

    // Restore open state on load (skip on mobile to avoid surprise overlays)
    try {
      if(!isMobile()){
        if(localStorage.getItem(TASKS_OPEN_KEY)) openTasks();
        if(localStorage.getItem(CAL_OPEN_KEY)) openCal();
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
  window.openCalendarDrawer = openCal;
  window.closeCalendarDrawer = closeCal;
})();
