(function(){
  const token = location.pathname.split("/").filter(Boolean).pop();
  let current = null;
  const filters = {
    types: new Set(["task", "repeat"]),
    status: "all",
    calendar: "all",
    sort: "time"
  };
  const COMMON_REACTIONS = ["👍", "🙌", "🔥", "💪", "🎉", "❤️"];

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
    const contentType = res.headers.get("content-type") || "";
    const cleanError = (value) => String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const data = contentType.includes("application/json")
      ? await res.json().catch(() => ({}))
      : { error: cleanError(await res.text().catch(() => "")) };
    if (!res.ok) throw new Error(data.error || data.message || "Request failed");
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

  function reactionBar(task){
    const counts = task.reactions || {};
    return '<div class="todo-public-reactions" aria-label="Task reactions">' + COMMON_REACTIONS.map(emoji => {
      const count = Number(counts[emoji]) || 0;
      const active = (task.viewerReactions || []).includes(emoji);
      return '<button class="todo-reaction-btn' + (active ? ' active' : '') + '" type="button" data-reaction-emoji="' + esc(emoji) + '" data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" title="React ' + esc(emoji) + '">' +
        '<span>' + esc(emoji) + '</span>' +
        '<b>' + (count ? esc(count) : '') + '</b>' +
      '</button>';
    }).join("") + '</div>';
  }

  function itemType(task){
    const type = String(task.itemType || "").toLowerCase();
    if (type) return type;
    const kind = String(task.kind || "").toLowerCase();
    const source = String(task.source || "").toLowerCase();
    if (source === "calendar" || source === "gcal" || task.gcalCalendarId || kind === "meeting" || kind === "oneone") return "calendar";
    if (kind === "responsibility_trigger" || kind === "repeat_responsibility" || task.is_recurring) return "repeat";
    if (kind === "break" || kind === "free_time") return "break";
    if (kind === "ooo") return "ooo";
    return "task";
  }

  function itemTypeLabel(task){
    return task.itemTypeLabel || ({
      task: "Task",
      repeat: "Repeat",
      calendar: "Calendar",
      break: "Break",
      ooo: "OOO"
    }[itemType(task)] || "Task");
  }

  function calendarId(task){
    return task.calendar && task.calendar.id ? String(task.calendar.id) : String(task.gcalCalendarId || "");
  }

  function calendarName(task){
    return task.calendar && task.calendar.name ? task.calendar.name : calendarId(task);
  }

  function timeKey(task){
    return task.start || "99:99";
  }

  function visibleTasks(tasks){
    let items = (tasks || []).slice();
    items = items.filter(task => {
      const type = itemType(task);
      const typeKey = (type === "break" || type === "ooo") ? "time" : type;
      if (!filters.types.has(typeKey)) return false;
      if (filters.status === "open" && task.status === "done") return false;
      if (filters.status === "done" && task.status !== "done") return false;
      if (filters.status === "sponsored" && !(task.sponsorships || []).some(s => s.status !== "dismissed")) return false;
      if (filters.calendar !== "all" && type === "calendar" && calendarId(task) !== filters.calendar) return false;
      return true;
    });
    items.sort((a, b) => {
      if (filters.sort === "type") return itemTypeLabel(a).localeCompare(itemTypeLabel(b)) || timeKey(a).localeCompare(timeKey(b));
      if (filters.sort === "status") return String(a.status || "").localeCompare(String(b.status || "")) || timeKey(a).localeCompare(timeKey(b));
      if (filters.sort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
      if (filters.sort === "duration") return (Number(a.durationMinutes) || 0) - (Number(b.durationMinutes) || 0) || timeKey(a).localeCompare(timeKey(b));
      return (a.status === "done") - (b.status === "done") || timeKey(a).localeCompare(timeKey(b));
    });
    return items;
  }

  function updateStats(tasks){
    const visible = visibleTasks(tasks || []);
    document.getElementById("todo-stat-open").textContent = String(visible.filter(t => t.status !== "done").length);
    document.getElementById("todo-stat-done").textContent = String(visible.filter(t => t.status === "done").length);
    document.getElementById("todo-stat-sponsored").textContent = String(visible.filter(t => (t.sponsorships || []).some(s => s.status !== "dismissed")).length);
  }

  function taskCardHtml(task){
      const time = task.start ? fmtTime(task.start) + (task.end ? " - " + fmtTime(task.end) : "") : "Unscheduled";
      const type = itemType(task);
      const cal = type === "calendar" && calendarName(task)
        ? '<span class="todo-public-calendar">' + esc(calendarName(task)) + '</span>'
        : '';
      return '<article class="todo-public-task ' + esc(task.status) + ' type-' + esc(type) + '" data-task-id="' + esc(task.id) + '" data-item-type="' + esc(type) + '">' +
        '<div class="todo-public-task-status"></div>' +
        '<div class="todo-public-task-body">' +
          reactionBar(task) +
          '<div class="todo-public-task-top"><strong>' + esc(task.title) + '</strong><span>' + esc(time) + '</span></div>' +
          (task.detail ? '<p>' + esc(task.detail) + '</p>' : '') +
          '<div class="todo-public-task-meta">' +
            '<span class="todo-public-type">' + esc(itemTypeLabel(task)) + '</span>' +
            cal +
            (task.priority ? '<span>' + esc(task.priority) + '</span>' : '') +
            '<span>' + esc(task.durationMinutes || 30) + 'm</span>' +
            '<span>' + esc(task.status) + '</span>' +
          '</div>' +
          sponsorChips(task) +
        '</div>' +
      '</article>';
  }

  function renderTasks(tasks){
    const list = document.getElementById("todo-public-list");
    if (!list) return;
    const visible = visibleTasks(tasks);
    const active = visible.filter(task => task.status !== "done");
    const completed = visible.filter(task => task.status === "done");
    updateStats(tasks);
    if (!active.length && !completed.length) {
      list.innerHTML = '<div class="todo-public-empty">No matching public items are active right now.</div>';
      return;
    }
    const activeHtml = active.map(taskCardHtml).join("");
    const completedHtml = completed.length
      ? '<section class="todo-public-completed" aria-label="Completed tasks">' +
          '<div class="todo-public-completed-head"><strong>Completed</strong><span>' + esc(completed.length) + ' done</span></div>' +
          '<div class="todo-public-completed-list">' + completed.map(taskCardHtml).join("") + '</div>' +
        '</section>'
      : '';
    list.innerHTML = activeHtml + completedHtml;
  }

  function renderSponsorSelect(tasks){
    const select = document.getElementById("todo-sponsor-task");
    if (!select) return;
    const open = tasks.filter(t => t.status !== "done" && ["task", "repeat"].includes(itemType(t)));
    select.innerHTML = open.length
      ? open.map(t => '<option value="' + esc(t.id) + '" data-title="' + esc(t.title) + '" data-block-id="' + esc(t.blockId || "") + '">' + esc(t.title) + '</option>').join("")
      : '<option value="">No open tasks</option>';
  }

  function renderCalendarOptions(data){
    const select = document.getElementById("todo-filter-calendar");
    if (!select) return;
    const selected = filters.calendar;
    const byId = new Map();
    (data.calendars || []).forEach(cal => {
      if (cal && cal.id) byId.set(String(cal.id), cal.name || cal.summary || cal.id);
    });
    (data.tasks || []).forEach(task => {
      const id = calendarId(task);
      if (id && !byId.has(id)) byId.set(id, calendarName(task) || id);
    });
    const options = ['<option value="all">All calendars</option>'];
    Array.from(byId.entries())
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .forEach(([id, name]) => options.push('<option value="' + esc(id) + '">' + esc(name) + '</option>'));
    select.innerHTML = options.join("");
    select.value = byId.has(selected) ? selected : "all";
    filters.calendar = select.value;
  }

  function render(data){
    current = data;
    document.getElementById("todo-public-content").hidden = false;
    document.getElementById("todo-public-error").hidden = true;
    document.getElementById("todo-public-title").textContent = data.workspaceName || "Shared Todo List";
    document.getElementById("todo-public-subtitle").textContent = data.ownerUsername ? "Live guest view for " + data.ownerUsername : "Live guest view";
    document.getElementById("todo-public-date").textContent = data.date || "Today";
    document.getElementById("todo-public-updated").textContent = "Updated " + new Date(data.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    renderCalendarOptions(data);
    renderTasks(data.tasks || []);
    renderSponsorSelect(data.tasks || []);
    renderAuthState(data.viewer || {});
  }

  function typeFilterLabel(){
    const labels = [
      ["task", "Tasks"],
      ["repeat", "Repeat"],
      ["calendar", "Calendar"],
      ["time", "Breaks / OOO"]
    ].filter(([key]) => filters.types.has(key)).map(([, label]) => label);
    if (labels.length === 4) return "Everything";
    if (!labels.length) return "Nothing";
    if (labels.length <= 2) return labels.join(", ");
    return labels.slice(0, 2).join(", ") + " +" + (labels.length - 2);
  }

  function syncTypeFilterButton(){
    const button = document.getElementById("todo-filter-type-button");
    if (button) button.textContent = typeFilterLabel();
    document.querySelectorAll("[data-type-filter]").forEach(input => {
      input.checked = filters.types.has(input.dataset.typeFilter);
    });
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
    const kind = document.getElementById("todo-sponsor-kind").value;
    const payload = {
      sponsorName: document.getElementById("todo-sponsor-name").value.trim(),
      sponsorEmail: document.getElementById("todo-sponsor-email").value.trim(),
      taskId: select ? select.value : "",
      taskTitle: option ? option.dataset.title : "",
      taskBlockId: option ? option.dataset.blockId : "",
      date: data.date,
      kind,
      rewardTitle: kind === "reward" ? document.getElementById("todo-sponsor-title").value.trim() : "Double points bounty",
      value: kind === "reward" ? document.getElementById("todo-sponsor-value").value : "",
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

  async function submitCreateTask(){
    const status = document.getElementById("todo-create-status");
    const payload = {
      visitorName: document.getElementById("todo-create-name").value.trim(),
      visitorEmail: document.getElementById("todo-create-email").value.trim(),
      title: document.getElementById("todo-create-title").value.trim(),
      durationMinutes: document.getElementById("todo-create-duration").value,
      note: document.getElementById("todo-create-note").value.trim()
    };
    if (status) status.textContent = "Creating...";
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (status) status.textContent = "Added to triage.";
      document.getElementById("todo-create-title").value = "";
      document.getElementById("todo-create-note").value = "";
      await load();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  async function toggleReaction(button){
    const task = (current && current.tasks || []).find(t => String(t.id) === String(button.dataset.taskId));
    const status = document.getElementById("todo-create-status");
    try {
      const data = await api("/api/public/todo-share/" + encodeURIComponent(token) + "/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: button.dataset.taskId,
          taskBlockId: button.dataset.taskBlockId,
          taskTitle: task ? task.title : "",
          date: current ? current.date : "",
          emoji: button.dataset.reactionEmoji
        })
      });
      if (task) {
        task.reactions = data.counts || {};
        task.viewerReactions = data.viewerReactions || [];
        renderTasks(current.tasks || []);
      } else {
        await load();
      }
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  function renderAuthState(viewer){
    const loggedIn = !!viewer.loggedIn;
    const note = document.getElementById("todo-encourage-auth-note");
    const send = document.getElementById("todo-send-sponsorship");
    const name = document.getElementById("todo-sponsor-name");
    if (note) note.textContent = loggedIn
      ? "Signed in as " + (viewer.username || "your account") + ". Bounties are limited to one per day."
      : "Sign in to send a reward or bounty. Bounties are limited to one per day.";
    if (send) {
      send.disabled = !loggedIn;
      send.title = loggedIn ? "" : "Sign in to send rewards and bounties";
    }
    if (name && loggedIn && viewer.username && !name.value) name.value = viewer.username;
  }

  function switchPanel(name){
    document.querySelectorAll(".todo-public-tab").forEach(btn => {
      const active = btn.dataset.todoPanel === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".todo-public-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === "todo-panel-" + name);
    });
  }

  function syncOfferFields(){
    const kind = document.getElementById("todo-sponsor-kind");
    const fields = document.getElementById("todo-reward-fields");
    const button = document.getElementById("todo-send-sponsorship");
    if (!kind || !fields) return;
    const isReward = kind.value === "reward";
    fields.hidden = !isReward;
    if (button) button.textContent = isReward ? "Send reward" : "Send bounty";
  }

  function bindControls(){
    [
      ["todo-filter-status", "status"],
      ["todo-filter-calendar", "calendar"],
      ["todo-sort", "sort"]
    ].forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = filters[key];
      el.addEventListener("change", () => {
        filters[key] = el.value;
        if (current) {
          renderTasks(current.tasks || []);
          renderSponsorSelect(current.tasks || []);
        }
      });
    });
    const typeButton = document.getElementById("todo-filter-type-button");
    const typeMenu = document.getElementById("todo-filter-type-menu");
    if (typeButton && typeMenu) {
      typeButton.addEventListener("click", () => {
        const nextOpen = typeMenu.hidden;
        typeMenu.hidden = !nextOpen;
        typeButton.setAttribute("aria-expanded", String(nextOpen));
      });
      typeMenu.addEventListener("change", e => {
        const input = e.target.closest("[data-type-filter]");
        if (!input) return;
        const key = input.dataset.typeFilter;
        if (input.checked) filters.types.add(key);
        else filters.types.delete(key);
        syncTypeFilterButton();
        if (current) {
          renderTasks(current.tasks || []);
          renderSponsorSelect(current.tasks || []);
        }
      });
      document.addEventListener("click", e => {
        if (typeMenu.hidden || e.target.closest("#todo-type-filter")) return;
        typeMenu.hidden = true;
        typeButton.setAttribute("aria-expanded", "false");
      });
      syncTypeFilterButton();
    }
    document.querySelectorAll("[data-todo-panel]").forEach(btn => {
      btn.addEventListener("click", () => switchPanel(btn.dataset.todoPanel));
    });
    const createBtn = document.getElementById("todo-create-task");
    if (createBtn) createBtn.addEventListener("click", submitCreateTask);
    const createTitle = document.getElementById("todo-create-title");
    if (createTitle) createTitle.addEventListener("keydown", e => {
      if (e.key === "Enter") submitCreateTask();
    });
    const list = document.getElementById("todo-public-list");
    if (list) list.addEventListener("click", e => {
      const btn = e.target.closest("[data-reaction-emoji]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      toggleReaction(btn);
    });
    const kind = document.getElementById("todo-sponsor-kind");
    if (kind) {
      kind.addEventListener("change", syncOfferFields);
      syncOfferFields();
    }
  }

  document.getElementById("todo-send-sponsorship").addEventListener("click", submitSponsorship);
  bindControls();
  load();
  setInterval(load, 15000);
})();
