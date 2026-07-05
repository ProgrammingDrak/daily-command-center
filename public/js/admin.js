(function(){
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
    if (!items.length) {
      list.innerHTML = '<div class="admin-empty">No logins found yet.</div>';
      return;
    }
    var header = '<div class="admin-login-head">' +
      '<span>User</span>' +
      '<span>Logged in</span>' +
      '<span>From</span>' +
    '</div>';
    list.innerHTML = header + items.map(function(item){
      return '<article class="admin-login-row">' +
        '<div class="admin-login-user">' + esc(item.username || ("User #" + (item.userId || item.id))) + '</div>' +
        '<div class="admin-login-time">' + esc(fmtTime(item.timestamp)) + '</div>' +
        '<div class="admin-login-origin">' + esc(item.origin || item.ipAddress || "Unknown") + '</div>' +
      '</article>';
    }).join("");
  }
  function renderFeedback(items){
    var list = $("feedback-list");
    text("feedback-count", items.length + " shown");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="admin-empty">No feedback messages yet.</div>';
      return;
    }
    list.innerHTML = items.map(function(item){
      return '<article class="admin-row">' +
        '<div class="admin-time">' + esc(fmtTime(item.created_at)) + '</div>' +
        '<div>' +
          '<div class="admin-message">' + esc(item.message) + '</div>' +
          '<div class="admin-meta">' +
            (item.page_path ? '<span>' + esc(item.page_path) + '</span>' : '') +
            '<span>#' + esc(item.id) + '</span>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join("");
  }
  async function loadAdmin(){
    var refresh = $("admin-refresh");
    if (refresh) refresh.disabled = true;
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
    } catch (err) {
      var msg = esc(err.message || "Could not load admin data");
      var activity = $("activity-list");
      var feedback = $("feedback-list");
      if (activity) activity.innerHTML = '<div class="admin-error">' + msg + '</div>';
      if (feedback) feedback.innerHTML = '<div class="admin-error">' + msg + '</div>';
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
