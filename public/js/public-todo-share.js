(function(){
  const token = location.pathname.split("/").filter(Boolean).pop();
  let current = null;

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[ch]));
  }

  function money(cents){
    const n = Number(cents) || 0;
    if (!n) return "";
    return "$" + (n / 100).toFixed(n % 100 ? 2 : 0);
  }

  function fmtTime(value){
    if (!value) return "";
    const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return value;
    let h = Number(m[1]);
    const min = m[2];
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + min + " " + ap;
  }

  async function api(path, options){
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function showError(message){
    const error = document.getElementById("todo-public-error");
    const content = document.getElementById("todo-public-content");
    if (content) content.hidden = true;
    if (error) {
      error.hidden = false;
      error.textContent = message;
    }
  }

  function sponsorChips(task){
    const offers = (task.sponsorships || []).filter(s => s.status !== "dismissed");
    if (!offers.length) return "";
    return '<div class="todo-public-sponsors">' + offers.slice(0, 3).map(s => {
      const label = s.kind === "reward" ? "Reward" : "Bounty";
      const amount = money(s.valueCents);
      return '<span>' + esc(label) + ': ' + esc(s.rewardTitle) + (amount ? " " + esc(amount) : "") + '</span>';
    }).join("") + '</div>';
  }

  function renderTasks(tasks){
    const list = document.getElementById("todo-public-list");
    if (!list) return;
    if (!tasks.length) {
      list.innerHTML = '<div class="todo-public-empty">No public tasks are active right now.</div>';
      return;
    }
    list.innerHTML = tasks.map(task => {
      const time = task.start ? fmtTime(task.start) + (task.end ? " - " + fmtTime(task.end) : "") : "Unscheduled";
      return '<article class="todo-public-task ' + esc(task.status) + '" data-task-id="' + esc(task.id) + '">' +
        '<div class="todo-public-task-status"></div>' +
        '<div class="todo-public-task-body">' +
          '<div class="todo-public-task-top"><strong>' + esc(task.title) + '</strong><span>' + esc(time) + '</span></div>' +
          (task.detail ? '<p>' + esc(task.detail) + '</p>' : '') +
          '<div class="todo-public-task-meta">' +
            (task.priority ? '<span>' + esc(task.priority) + '</span>' : '') +
            '<span>' + esc(task.durationMinutes || 30) + 'm</span>' +
            '<span>' + esc(task.status) + '</span>' +
          '</div>' +
          sponsorChips(task) +
        '</div>' +
      '</article>';
    }).join("");
  }

  function renderSponsorSelect(tasks){
    const select = document.getElementById("todo-sponsor-task");
    if (!select) return;
    const open = tasks.filter(t => t.status !== "done");
    select.innerHTML = open.length
      ? open.map(t => '<option value="' + esc(t.id) + '" data-title="' + esc(t.title) + '" data-block-id="' + esc(t.blockId || "") + '">' + esc(t.title) + '</option>').join("")
      : '<option value="">No open tasks</option>';
  }

  function render(data){
    current = data;
    document.getElementById("todo-public-content").hidden = false;
    document.getElementById("todo-public-error").hidden = true;
    document.getElementById("todo-public-title").textContent = data.workspaceName || "Shared Todo List";
    document.getElementById("todo-public-subtitle").textContent = data.ownerUsername ? "Live guest view for " + data.ownerUsername : "Live guest view";
    document.getElementById("todo-public-date").textContent = data.date || "Today";
    document.getElementById("todo-public-updated").textContent = "Updated " + new Date(data.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    document.getElementById("todo-stat-open").textContent = String(data.stats && data.stats.open || 0);
    document.getElementById("todo-stat-done").textContent = String(data.stats && data.stats.done || 0);
    document.getElementById("todo-stat-sponsored").textContent = String(data.stats && data.stats.sponsored || 0);
    renderTasks(data.tasks || []);
    renderSponsorSelect(data.tasks || []);
  }

  async function load(){
    if (!token) return showError("Missing share token.");
    try {
      render(await api("/api/public/todo-share/" + encodeURIComponent(token)));
    } catch (e) {
      showError(e.message);
    }
  }

  async function submitSponsorship(){
    const status = document.getElementById("todo-sponsor-status");
    const select = document.getElementById("todo-sponsor-task");
    const option = select && select.options[select.selectedIndex];
    const payload = {
      sponsorName: document.getElementById("todo-sponsor-name").value.trim(),
      sponsorEmail: document.getElementById("todo-sponsor-email").value.trim(),
      taskId: select ? select.value : "",
      taskTitle: option ? option.dataset.title : "",
      taskBlockId: option ? option.dataset.blockId : "",
      kind: document.getElementById("todo-sponsor-kind").value,
      rewardTitle: document.getElementById("todo-sponsor-title").value.trim(),
      value: document.getElementById("todo-sponsor-value").value,
      note: document.getElementById("todo-sponsor-note").value.trim()
    };
    if (status) status.textContent = "Sending...";
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/sponsorships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (status) status.textContent = "Offer sent for review.";
      document.getElementById("todo-sponsor-title").value = "";
      document.getElementById("todo-sponsor-value").value = "";
      document.getElementById("todo-sponsor-note").value = "";
      await load();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  document.getElementById("todo-send-sponsorship").addEventListener("click", submitSponsorship);
  load();
  setInterval(load, 15000);
})();
