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
  document.getElementById("local-state-export").textContent = JSON.stringify(data);
  // Also trigger IndexedDB save on export
  scheduleIDBSave();
}
// Export every 30 seconds and on unload
setInterval(exportLocalState, 30000);
window.addEventListener("beforeunload", exportLocalState);
exportLocalState();

