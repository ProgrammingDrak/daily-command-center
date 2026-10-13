(function(){
  var activityCollection = null;
  var feedbackCollection = null;
  var feedbackItems = [];
  var nextCursor = null;
  var loadingFeedback = false;
  function $(id){ return document.getElementById(id); }
  function text(id, value){ var el = $(id); if (el) el.textContent = value; }
  function fmtTime(value){
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString([], { year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  }
  async function getData(url){
    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, 15000);
    try {
      var response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      var data = await response.json().catch(function(){ return {}; });
      if (response.status === 401) throw new Error("Your session expired. Sign in again to read feedback.");
      if (response.status === 403) throw new Error("Admin access required for this inbox.");
      if (!response.ok) throw new Error("Could not load this data. Please try again.");
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Request timed out. Please try again.");
      throw err;
    } finally { clearTimeout(timeout); }
  }
  function renderActivity(items){
    var rows = items.map(function(item){ return {
      username: item.username || ("User #" + (item.userId || item.id)),
      status: item.status || "Success", timestamp: item.timestamp,
      origin: item.origin || item.ipAddress || "Unknown"
    }; });
    if (activityCollection) activityCollection.update(rows);
    else activityCollection = window.DCC.collection.mount($("activity-list"), {
      rows: rows, stateKey: "admin-activity", urlKey: "activity", emptyMessage: "No login activity yet.", label: "Login activity"
    });
    text("activity-count", items.length + " recent logins");
  }
  function renderFeedback(){
    var rows = feedbackItems.map(function(item){ return {
      author: item.display_name || item.username || (item.user_id ? "User #" + item.user_id : "Unknown author"),
      username: item.username || "—", status: item.resolved_at ? "Resolved" : "Received",
      created_at: item.created_at, message: item.message, page_path: item.page_path || "—",
      workspace_id: item.workspace_id || "—", id: item.id
    }; });
    if (feedbackCollection) feedbackCollection.update(rows);
    else feedbackCollection = window.DCC.collection.mount($("feedback-list"), {
      rows: rows, stateKey: "admin-feedback-inbox", urlKey: "feedback", defaultSortKey: "created_at", defaultSortDirection: "desc",
      columnOrder: ["message", "author", "created_at", "page_path", "status", "username", "id", "workspace_id"],
      multilineColumns: ["message", "page_path", "author"], emptyMessage: "No feedback yet. New submissions will appear here.", label: "Feedback messages"
    });
    var older = $("feedback-older");
    if (older) older.hidden = !nextCursor;
  }
  async function loadFeedback(append){
    if (loadingFeedback || (append && !nextCursor)) return;
    loadingFeedback = true;
    $("feedback-list").setAttribute("aria-busy", "true");
    $("feedback-older").disabled = true;
    text("feedback-status", append ? "Loading older feedback…" : "Loading feedback…");
    try {
      var url = "/api/admin/feedback?limit=50" + (append ? "&before=" + encodeURIComponent(nextCursor) : "");
      var data = await getData(url);
      if (!Array.isArray(data.feedback) || !data.summary) throw new Error("Could not read feedback. Please try again.");
      feedbackItems = append ? feedbackItems.concat(data.feedback).filter(function(item, index, all){
        return all.findIndex(function(other){ return other.id === item.id; }) === index;
      }) : data.feedback;
      nextCursor = data.nextCursor || null;
      renderFeedback();
      text("feedback-count", feedbackItems.length + " of " + data.summary.total + " loaded");
      text("metric-feedback", String(data.summary.total));
      text("metric-last-feedback", fmtTime(data.summary.latestFeedbackAt));
      text("feedback-status", "Updated " + new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }));
      $("feedback-status").classList.remove("admin-error");
    } catch (err) {
      // Existing rows stay readable when a refresh or next-page request fails.
      if (!feedbackCollection) $("feedback-list").innerHTML = '<div class="admin-empty">Feedback could not be loaded. Use Refresh to try again.</div>';
      text("feedback-status", err.message || "Could not load feedback. Please try again.");
      $("feedback-status").classList.add("admin-error");
    } finally {
      loadingFeedback = false;
      $("feedback-list").setAttribute("aria-busy", "false");
      $("feedback-older").disabled = false;
    }
  }
  async function loadActivity(){
    text("activity-status", "Loading login activity…");
    try {
      var data = await getData("/api/admin/activity?limit=100");
      renderActivity(data.activity || []);
      text("metric-activity", String((data.activity || []).length));
      text("metric-last-activity", fmtTime(data.summary && data.summary.latestActivityAt));
      text("activity-status", "");
    } catch (err) {
      text("activity-status", err.message || "Could not load login activity.");
      if (!activityCollection) $("activity-list").innerHTML = '<div class="admin-empty">Login activity could not be loaded.</div>';
    }
  }
  async function loadAdmin(){
    var refresh = $("admin-refresh");
    if (refresh.disabled || loadingFeedback) return;
    refresh.disabled = true;
    text("admin-refresh-status", "Loading…");
    await Promise.all([loadFeedback(false), loadActivity()]);
    text("admin-refresh-status", "");
    refresh.disabled = false;
  }
  document.addEventListener("DOMContentLoaded", function(){
    $("admin-refresh").addEventListener("click", loadAdmin);
    $("feedback-older").addEventListener("click", function(){ loadFeedback(true); });
    loadAdmin();
  });
})();
