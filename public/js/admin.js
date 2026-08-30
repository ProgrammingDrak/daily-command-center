(function(){
  var activityCollection = null;
  var feedbackCollection = null;
  function $(id){ return document.getElementById(id); }
  function text(id, value){ var el = $(id); if (el) el.textContent = value; }
  function esc(value) { return window.DCC.esc(value); } // delegates to core.js
  function fmtTime(value){
    if (!value) return "--";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  }
  function renderActivity(items){
    var list = $("activity-list");
    text("activity-count", items.length + " shown");
    if (!list) return;
    var rows = items.map(function(item){ return {
      username: item.username || ("User #" + (item.userId || item.id)),
      status: item.status || "Success",
      timestamp: item.timestamp,
      origin: item.origin || item.ipAddress || "Unknown"
    }; });
    if (activityCollection) activityCollection.update(rows);
    else activityCollection = window.DCC.collection.mount(list, { rows: rows, stateKey: "admin-activity", urlKey: "activity" });
  }
  function renderFeedback(items){
    var list = $("feedback-list");
    text("feedback-count", items.length + " shown");
    if (!list) return;
    var rows = items.map(function(item){ return {
      status: item.status || "Received",
      created_at: item.created_at,
      message: item.message,
      page_path: item.page_path || "—",
      id: item.id
    }; });
    if (feedbackCollection) feedbackCollection.update(rows);
    else feedbackCollection = window.DCC.collection.mount(list, { rows: rows, stateKey: "admin-feedback", urlKey: "feedback" });
  }
  async function loadAdmin(){
    var refresh = $("admin-refresh");
    if (refresh) refresh.disabled = true;
    text("admin-refresh-status", "Loading…");
    try {
      var response = await fetch("/api/admin/activity?limit=100");
      var data = await response.json().catch(function(){ return {}; });
      if (!response.ok) throw new Error(data.error || "Could not load admin data");
      renderActivity(data.activity || []);
      renderFeedback(data.feedback || []);
      text("metric-activity", String((data.activity || []).length));
      text("metric-feedback", String((data.feedback || []).length));
      text("metric-last-activity", fmtTime(data.summary && data.summary.latestActivityAt));
      text("metric-last-feedback", fmtTime(data.summary && data.summary.latestFeedbackAt));
      text("admin-refresh-status", "Updated " + new Date().toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }));
    } catch (err) {
      var msg = esc(err.message || "Could not load admin data");
      var activity = $("activity-list");
      var feedback = $("feedback-list");
      if (activity) activity.innerHTML = '<div class="admin-error">' + msg + '</div>';
      if (feedback) feedback.innerHTML = '<div class="admin-error">' + msg + '</div>';
      activityCollection = null;
      feedbackCollection = null;
      text("admin-refresh-status", "Refresh failed");
    } finally {
      if (refresh) refresh.disabled = false;
    }
  }
  document.addEventListener("DOMContentLoaded", function(){
    var refresh = $("admin-refresh");
    if (refresh) refresh.addEventListener("click", loadAdmin);
    loadAdmin();
  });
})();
