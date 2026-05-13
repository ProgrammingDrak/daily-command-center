// ======== UNLOAD SAFETY (pomodoro state only) ========
// Phase 6 cleanup: this file used to mirror localStorage to a hidden DOM element
// for an external "batch-review" skill, flush a legacy /api/save-day, and
// snapshot to IndexedDB on unload. All three paths are retired -- BlockStore
// writes immediately and durably (with WAL) on every mutation. The only thing
// worth doing on unload is flushing a running pomodoro: the timer no longer
// saves on every tick, so a tab close mid-session would otherwise lose seconds.
window.addEventListener("beforeunload", () => {
  if (typeof savePomoState === "function" && typeof pomoState !== "undefined" && pomoState.running) {
    pomoState.running = false;
    clearInterval(pomoState.iv);
    savePomoState();
  }
});

// Save pomo state when tab becomes hidden (safety net -- timer no longer saves every tick)
document.addEventListener("visibilitychange", () => {
  if (document.hidden && typeof savePomoState === "function" && typeof pomoState !== "undefined" && pomoState.running) {
    savePomoState();
  }
});
