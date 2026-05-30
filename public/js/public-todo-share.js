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

  // Capability gate, mirroring the server. Reads the resolved capability map off
  // the share payload's viewer; defaults keep the page usable if it is absent.
  function can(cap){
    const viewer = (current && current.viewer) || {};
    const caps = viewer.capabilities || {};
    if (Object.prototype.hasOwnProperty.call(caps, cap)) return !!caps[cap];
    if (cap === "place_bounty") return !!viewer.loggedIn;
    return true;
  }

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

  function taskBountied(task){
    return (task.sponsorships || []).some(s => s.kind === "bounty" && s.status !== "dismissed");
  }

  // Only one visitor bounty per day per workspace (single partner slot), so once
  // any task is bountied, the rest are locked until it's cleared.
  function anyTaskBountied(){
    return (current && current.tasks || []).some(taskBountied);
  }

  function bountyButtonHtml(task){
    if (task.redacted) {
      // private task: still bountyable, label stays generic
    }
    const bountied = taskBountied(task);
    const allowed = can("place_bounty");
    if (bountied) {
      return '<button class="todo-bounty-btn bountied" type="button" disabled title="This task is bountied - completing it pays 2x">💎 Bountied</button>';
    }
    if (!allowed) {
      return '<button class="todo-bounty-btn locked" type="button" disabled title="Sign in to place a bounty">💎 Bounty</button>';
    }
    if (anyTaskBountied()) {
      return '<button class="todo-bounty-btn locked" type="button" disabled title="One bounty per day - clear the current one first">💎 Bounty</button>';
    }
    return '<button class="todo-bounty-btn" type="button" data-bounty-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" title="Place a bounty - completing this pays 2x points">💎 Place bounty</button>';
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

  function pointsChip(task){
    if (task.points == null) return "";
    return '<span class="todo-public-points">' + esc(task.points) + ' pts</span>';
  }

  function relTime(value){
    if (!value) return "";
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Math.max(0, Date.now() - then);
    const min = Math.round(diff / 60000);
    if (min < 1) return "now";
    if (min < 60) return min + "m";
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + "h";
    return Math.round(hr / 24) + "d";
  }

  function commentsHtml(task){
    const items = task.comments || [];
    const list = items.length
      ? '<div class="todo-public-comment-list">' + items.map(c =>
          '<div class="todo-public-comment">' +
            '<div class="todo-public-comment-head"><b>' + esc(c.authorName || "Guest") + '</b><span>' + esc(relTime(c.createdAt)) + '</span></div>' +
            '<div class="todo-public-comment-body">' + esc(c.body || "") + '</div>' +
          '</div>'
        ).join("") + '</div>'
      : '';
    const form = can("comment")
      ? '<form class="todo-public-comment-form" data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '">' +
          '<input type="text" class="todo-public-comment-input" maxlength="1000" placeholder="Add a comment...">' +
          '<button type="submit" class="todo-public-comment-send">Send</button>' +
        '</form>'
      : '';
    if (!list && !form) return '';
    return '<div class="todo-public-comments">' + list + form + '</div>';
  }

  function taskCardHtml(task){
      const time = task.start ? fmtTime(task.start) + (task.end ? " - " + fmtTime(task.end) : "") : "Unscheduled";
      const type = itemType(task);
      const redacted = !!task.redacted;
      const cal = !redacted && type === "calendar" && calendarName(task)
        ? '<span class="todo-public-calendar">' + esc(calendarName(task)) + '</span>'
        : '';
      const title = redacted ? "🔒 Private task" : esc(task.title);
      return '<article class="todo-public-task ' + esc(task.status) + ' type-' + esc(type) + (redacted ? ' todo-public-task-private' : '') + '" data-task-id="' + esc(task.id) + '" data-item-type="' + esc(type) + '">' +
        '<div class="todo-public-task-status"></div>' +
        '<div class="todo-public-task-body">' +
          reactionBar(task) +
          '<div class="todo-public-task-top"><strong>' + title + '</strong><span>' + esc(time) + '</span></div>' +
          (!redacted && task.detail ? '<p>' + esc(task.detail) + '</p>' : '') +
          '<div class="todo-public-task-meta">' +
            (redacted ? '<span class="todo-public-type">Private</span>' : '<span class="todo-public-type">' + esc(itemTypeLabel(task)) + '</span>') +
            cal +
            (!redacted && task.priority ? '<span>' + esc(task.priority) + '</span>' : '') +
            (!redacted ? '<span>' + esc(task.durationMinutes || 30) + 'm</span>' : '') +
            pointsChip(task) +
            '<span>' + esc(task.status) + '</span>' +
          '</div>' +
          (task.status !== "done" ? '<div class="todo-public-task-actions">' + bountyButtonHtml(task) + '</div>' : '') +
          sponsorChips(task) +
          commentsHtml(task) +
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
    renderRewards(data);
    applyCapabilities();
  }

  function renderRewards(data){
    const rewards = (data && data.rewards) || [];
    const panel = document.getElementById("todo-rewards-rotation");
    if (panel) {
      panel.innerHTML = rewards.length
        ? rewards.map(r => '<div class="todo-reward-card"><strong>' + esc(r.title) + '</strong>' +
            (r.value ? '<span>' + esc(money(r.value)) + '</span>' : '') + '</div>').join("")
        : '<div class="todo-public-empty">No rewards in rotation yet.</div>';
    }
    const select = document.getElementById("todo-sponsor-reward-id");
    if (select) {
      select.innerHTML = rewards.length
        ? rewards.map(r => '<option value="' + esc(r.id) + '" data-title="' + esc(r.title) + '">' + esc(r.title) + (r.value ? ' (' + esc(money(r.value)) + ')' : '') + '</option>').join("")
        : '<option value="">No rewards in rotation</option>';
    }
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
    const targetEl = document.getElementById("todo-sponsor-target");
    const target = targetEl ? targetEl.value : "task";
    const rewardSourceEl = document.getElementById("todo-sponsor-reward-source");
    const rewardSource = rewardSourceEl ? rewardSourceEl.value : "new";
    const rewardSelect = document.getElementById("todo-sponsor-reward-id");
    const rewardOption = rewardSelect && rewardSelect.options[rewardSelect.selectedIndex];
    const useExisting = rewardSource === "existing" && rewardSelect && rewardSelect.value;
    const lifespanMode = (document.getElementById("todo-sponsor-lifespan-mode") || {}).value || "forever";
    const payload = {
      sponsorName: document.getElementById("todo-sponsor-name").value.trim(),
      sponsorEmail: document.getElementById("todo-sponsor-email").value.trim(),
      kind: "reward",
      target,
      date: current ? current.date : "",
      taskId: target === "task" && select ? select.value : "",
      taskTitle: target === "task" && option ? option.dataset.title : "",
      taskBlockId: target === "task" && option ? option.dataset.blockId : "",
      slotRewardId: useExisting ? rewardSelect.value : "",
      rewardTitle: useExisting ? (rewardOption ? rewardOption.dataset.title : "") : document.getElementById("todo-sponsor-title").value.trim(),
      value: document.getElementById("todo-sponsor-value").value,
      private: document.getElementById("todo-sponsor-private").checked,
      note: document.getElementById("todo-sponsor-note").value.trim()
    };
    if (target === "slot" && lifespanMode === "uses") payload.uses = document.getElementById("todo-sponsor-uses").value;
    if (target === "slot" && lifespanMode === "until") payload.expiresAt = document.getElementById("todo-sponsor-until").value;
    if (status) status.textContent = "Sending...";
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/sponsorships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (status) status.textContent = "Reward added!";
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

  async function submitComment(form){
    const input = form.querySelector(".todo-public-comment-input");
    const body = input ? input.value.trim() : "";
    if (!body) return;
    const taskId = form.dataset.taskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    if (input) input.disabled = true;
    try {
      const data = await api("/api/public/todo-share/" + encodeURIComponent(token) + "/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          taskBlockId: form.dataset.taskBlockId,
          taskTitle: task ? task.title : "",
          date: current ? current.date : "",
          body
        })
      });
      if (task) {
        task.comments = data.comments || [];
        renderTasks(current.tasks || []);
      } else {
        await load();
      }
    } catch (e) {
      if (input) { input.disabled = false; }
      alert(e.message);
    }
  }

  async function placeTaskBounty(button){
    if (button.disabled) return;
    const taskId = button.dataset.bountyTaskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    button.disabled = true;
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/sponsorships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "bounty",
          taskId,
          taskBlockId: button.dataset.taskBlockId,
          taskTitle: task ? task.title : "",
          date: current ? current.date : ""
        })
      });
      await load();
    } catch (e) {
      button.disabled = false;
      alert(e.message);
    }
  }

  // Gate the encouragement form to the viewer's capabilities. Re-run on every
  // render so the 15s poll never transiently unlocks a guest.
  function applyCapabilities(){
    const viewer = (current && current.viewer) || {};
    const loggedIn = !!viewer.loggedIn;
    const note = document.getElementById("todo-encourage-auth-note");
    const name = document.getElementById("todo-sponsor-name");
    if (note) {
      note.innerHTML = loggedIn
        ? "Signed in as " + esc(viewer.username || "your account") + ". Use the bounty button on a task to place a bounty."
        : 'Rewards and comments are open to everyone. <a href="/login">Sign in</a> to place bounties on tasks.';
    }
    if (name && loggedIn && viewer.username && !name.value) name.value = viewer.username;
    syncOfferFields();
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
    const button = document.getElementById("todo-send-sponsorship");
    // The offer form is reward-only now (bounties are per-task buttons).
    const targetEl = document.getElementById("todo-sponsor-target");
    const target = targetEl ? targetEl.value : "task";
    const taskWrap = document.getElementById("todo-sponsor-task-wrap");
    const lifespan = document.getElementById("todo-sponsor-lifespan");
    if (taskWrap) taskWrap.hidden = target !== "task";
    if (lifespan) lifespan.hidden = target !== "slot";
    // Toggle existing-reward picker vs new-reward description.
    const sourceEl = document.getElementById("todo-sponsor-reward-source");
    const existingWrap = document.getElementById("todo-sponsor-reward-existing-wrap");
    const newWrap = document.getElementById("todo-sponsor-reward-new-wrap");
    const useExisting = sourceEl && sourceEl.value === "existing";
    if (existingWrap) existingWrap.hidden = !useExisting;
    if (newWrap) newWrap.hidden = useExisting;
    // Lifespan sub-fields (slot machine only).
    const modeEl = document.getElementById("todo-sponsor-lifespan-mode");
    const mode = modeEl ? modeEl.value : "forever";
    const usesWrap = document.getElementById("todo-sponsor-uses-wrap");
    const untilWrap = document.getElementById("todo-sponsor-until-wrap");
    if (usesWrap) usesWrap.hidden = !(target === "slot" && mode === "uses");
    if (untilWrap) untilWrap.hidden = !(target === "slot" && mode === "until");
    const allowed = can("sponsor_reward");
    if (button) {
      button.disabled = !allowed;
      button.textContent = "Send reward";
      button.title = allowed ? "" : "You can not sponsor rewards";
    }
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
    if (list) {
      list.addEventListener("click", e => {
        const bountyBtn = e.target.closest("[data-bounty-task-id]");
        if (bountyBtn) {
          e.preventDefault();
          e.stopPropagation();
          placeTaskBounty(bountyBtn);
          return;
        }
        const btn = e.target.closest("[data-reaction-emoji]");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        toggleReaction(btn);
      });
      list.addEventListener("submit", e => {
        const form = e.target.closest(".todo-public-comment-form");
        if (!form) return;
        e.preventDefault();
        submitComment(form);
      });
    }
    ["todo-sponsor-target", "todo-sponsor-reward-source", "todo-sponsor-lifespan-mode"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", syncOfferFields);
    });
    syncOfferFields();
  }

  document.getElementById("todo-send-sponsorship").addEventListener("click", submitSponsorship);
  bindControls();
  load();
  setInterval(load, 15000);
})();
