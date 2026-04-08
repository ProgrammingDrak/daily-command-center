// ======== LOCAL STATE EXPORT ========
// Periodically export localStorage data to a hidden element so the batch-review
// skill can read it. Also export on page unload.
function exportLocalState() {
  const date = (__state && __state.date) || "unknown";
  const d = date;
  const captures = JSON.parse(localStorage.getItem("pa-life-captures") || "[]");
  const data = {
    date: d,
    notes: loadNotes(),
    actions: loadActions(),
    dismissed: loadDismissed(),
    done: { ids: [...manualDone], at: doneAt },
    sessions: loadSessions(),
    deferred: loadDeferred(),
    pushed: { ids: [...pushedSet], at: pushedAt },
    deleted: [...deletedSet],
    durChanges: durChanges,
    pomo: loadPomoState(),
    reviewed: JSON.parse(localStorage.getItem("pa-reviewed-" + d) || "[]"),
    subtasks: JSON.parse(localStorage.getItem("pa-subtasks-" + d) || "{}"),
    trivialFlags: JSON.parse(localStorage.getItem("pa-trivial-flags-" + d) || "{}"),
    engrams: JSON.parse(localStorage.getItem("pa-engrams-" + d) || "[]"),
    mood: JSON.parse(localStorage.getItem("pa-mood-" + d) || "{}"),
    // Global keys (non-date-specific)
    "pa-life-captures": captures,
    stickyNotes: JSON.parse(localStorage.getItem("pa-sticky-notes") || "[]"),
    trivialTasks: JSON.parse(localStorage.getItem("pa-trivial-tasks") || "[]"),
    upcomingNotes: JSON.parse(localStorage.getItem("pa-upcoming-notes") || "{}"),
    upcomingActions: JSON.parse(localStorage.getItem("pa-upcoming-actions") || "{}"),
    pushedDocs: JSON.parse(localStorage.getItem("pa-pushed-docs") || "{}"),
    morning: JSON.parse(localStorage.getItem("pa-morning") || "{}"),
    pendingTasks: loadPendingTasks(),
    exported_at: new Date().toISOString()
  };
  const el = document.getElementById("local-state-export");
  if (el) el.textContent = JSON.stringify(data);
  // Also trigger IndexedDB save on export
  scheduleIDBSave();
}
// Export on tab close — flush all pending state immediately
window.addEventListener("beforeunload", () => {
  // Save timer state on tab close (crash safety — timer no longer saves every tick)
  if (typeof savePomoState === "function" && typeof pomoState !== "undefined" && pomoState.running) {
    pomoState.running = false;
    clearInterval(pomoState.iv);
    savePomoState();
  }
  exportLocalState();
  // Phase 0 fix: flush pending changes to Express with keepalive
  // (keepalive requests survive page unload)
  if (typeof flushToExpress === "function") {
    flushToExpress();
  }
  // Also force an immediate IDB save (may or may not complete before unload)
  const date = (__state && __state.date) ? __state.date : "unknown";
  if (typeof PaDB !== "undefined" && date !== "unknown") {
    try {
      PaDB.saveDate(date, collectAllState());
      PaDB.saveGlobal('globals', collectGlobalState());
    } catch(e) {}
  }
});

// Save pomo state when tab becomes hidden (safety net — timer no longer saves every tick)
document.addEventListener("visibilitychange", () => {
  if (document.hidden && typeof savePomoState === "function" && typeof pomoState !== "undefined" && pomoState.running) {
    savePomoState();
  }
});

