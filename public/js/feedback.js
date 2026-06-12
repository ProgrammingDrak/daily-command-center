(function(){
  function $(id){ return document.getElementById(id); }

  function setOpen(open){
    var panel = $("feedback-panel");
    if (!panel) return;
    panel.classList.toggle("open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    if (open) {
      var input = $("feedback-message");
      if (input) setTimeout(function(){ input.focus(); }, 0);
    }
  }

  async function submitFeedback(){
    var input = $("feedback-message");
    var status = $("feedback-status");
    var button = $("feedback-submit");
    if (!input || !button) return;
    var message = input.value.trim();
    if (!message) {
      if (status) status.textContent = "Write a note first.";
      input.focus();
      return;
    }
    button.disabled = true;
    if (status) status.textContent = "Sending...";
    try {
      var response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message, pagePath: location.pathname + location.search })
      });
      var data = await response.json().catch(function(){ return {}; });
      if (!response.ok) throw new Error(data.error || "Feedback failed");
      input.value = "";
      if (status) status.textContent = "Sent. Thank you.";
      if (typeof showToast === "function") showToast("Feedback sent", "success");
      setTimeout(function(){ setOpen(false); if (status) status.textContent = ""; }, 900);
    } catch (err) {
      if (status) status.textContent = err.message || "Could not send.";
      if (typeof showToast === "function") showToast(err.message || "Could not send feedback", "error");
    } finally {
      button.disabled = false;
    }
  }

  // Opened from the launcher radial menu's "Give feedback" option (the old standalone
  // #feedback-fab is gone; this is the single entry point now).
  window.dccOpenFeedback = function(){ setOpen(true); };

  document.addEventListener("DOMContentLoaded", function(){
    var close = $("feedback-close");
    var submit = $("feedback-submit");
    var input = $("feedback-message");
    if (close) close.addEventListener("click", function(){ setOpen(false); });
    if (submit) submit.addEventListener("click", submitFeedback);
    if (input) input.addEventListener("keydown", function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submitFeedback();
      if (e.key === "Escape") setOpen(false);
    });
  });
})();
