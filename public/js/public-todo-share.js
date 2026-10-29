(function(){
  const token = location.pathname.split("/").filter(Boolean).pop();
  let current = null;
  let loadPromise = null;
  const filters = {
    types: new Set(["task", "repeat", "calendar", "time"]),
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
    return false;
  }

  function esc(value) { return window.DCC.esc(value); } // delegates to core.js

  function money(cents){
    const n = Number(cents) || 0;
    if (!n) return "";
    return "$" + (n / 100).toFixed(n % 100 ? 2 : 0);
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
    const status = document.getElementById("todo-public-status");
    if (status) status.hidden = true;
    if (error) {
      error.hidden = false;
      error.textContent = message;
    }
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

  // ---- Sponsorship / bounty / reward helpers (shared across cards) ----
  function sponsorChips(task){
    const offers = (task.sponsorships || []).filter(s => s.status !== "dismissed");
    if (!offers.length) return "";
    return '<div class="todo-public-sponsors">' + offers.slice(0, 3).map(s => {
      const label = s.kind === "reward" ? "Reward" : "Bounty";
      const amount = money(s.valueCents);
      return '<span>' + esc(label) + ': ' + esc(s.rewardTitle || (s.kind === "reward" ? "a reward" : "2x points")) + (amount ? " " + esc(amount) : "") + ' · ' + esc(s.status === 'pending' ? 'Awaiting approval' : s.status) + '</span>';
    }).join("") + '</div>';
  }

  function taskBountied(task){
    return (task.sponsorships || []).some(s => s.kind === "bounty" && s.status !== "dismissed");
  }

  // Only one visitor points-bounty per day per workspace (single partner slot), so
  // once any task is bountied the rest lock until it clears. Rewards are unlimited.
  function anyTaskBountied(){
    return (current && current.tasks || []).some(taskBountied);
  }

  // Unified bounty/reward chooser: a "2x points" bounty (one per visitor, sign-in
  // required) OR a custom reward (anyone). Both POST to /sponsorships.
  function bountyButtonHtml(task){
    const bountied = taskBountied(task);
    const allowed = can("place_bounty");
    if (bountied) {
      return '<button class="todo-bounty-btn bountied" type="button" disabled title="This task is bountied - completing it pays 2x">💎 2× points</button>';
    }
    if (!allowed) {
      return '<button class="todo-bounty-btn locked" type="button" disabled title="Sign in to put 2x points on a task">💎 2× points</button>';
    }
    if (anyTaskBountied()) {
      return '<button class="todo-bounty-btn locked" type="button" disabled title="One points-bounty per day - clear the current one first">💎 2× points</button>';
    }
    return '<button class="todo-bounty-btn" type="button" data-bounty-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" title="Offer 2x points, subject to owner approval">💎 2× points</button>';
  }

  function rewardButtonHtml(task){
    if (!can("sponsor_reward")) return "";
    return '<button class="todo-reward-btn" type="button" data-reward-toggle="' + esc(task.id) + '" title="Offer a reward for finishing this">🎁 Offer reward</button>';
  }

  function rewardFormHtml(task){
    if (!can("sponsor_reward")) return "";
    return '<form class="todo-reward-form" hidden data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '">' +
        '<input type="text" class="todo-reward-title" maxlength="160" aria-label="Reward offered" required placeholder="Reward if completed (e.g. coffee on me)">' +
        '<div class="todo-reward-row">' +
          '<input type="text" class="todo-reward-name" maxlength="80" aria-label="Your name" required placeholder="Your name">' +
          '<input type="number" class="todo-reward-value" min="0" step="0.01" aria-label="Optional reward value in dollars" placeholder="$ optional">' +
          '<button type="submit" class="todo-public-btn primary">Send</button>' +
        '</div>' +
      '</form>';
  }

  function reactionBar(task){
    if (!can("react")) return "";
    const counts = task.reactions || {};
    return '<div class="todo-public-reactions itinerary-reactions" aria-label="Task reactions">' + COMMON_REACTIONS.map(emoji => {
      const count = Number(counts[emoji]) || 0;
      const active = (task.viewerReactions || []).includes(emoji);
      return '<button class="todo-reaction-btn' + (active ? ' active' : '') + '" type="button" data-reaction-emoji="' + esc(emoji) + '" data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" aria-pressed="' + active + '" aria-label="React ' + esc(emoji) + '" title="React ' + esc(emoji) + '">' +
        '<span>' + esc(emoji) + '</span>' +
        '<b>' + (count ? esc(count) : '') + '</b>' +
      '</button>';
    }).join("") + '</div>';
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
          '<input type="text" class="todo-public-comment-input" maxlength="1000" aria-label="Comment" placeholder="Add a comment...">' +
          '<button type="submit" class="todo-public-comment-send">Send</button>' +
        '</form>'
      : '';
    if (!list && !form) return '';
    return '<div class="todo-public-comments">' + list + form + '</div>';
  }

  const LANES = [
    ["foreground", "Foreground", "Current focus"],
    ["needs-you", "Needs You", "Waiting for attention"],
    ["priority", "Priority Queue", "Selected work that has never started"],
    ["background", "Background", "Started, paused or blocked work"],
    ["completed", "Completed", "Finished queue tasks"]
  ];
  function renderGuestCard(task){
    const el = document.createElement("article");
    el.className = "shared-queue-card";
    el.dataset.sharedTask = task.id;
    const q = task.queue || {};
    const state = q.lane === "priority" ? (q.priority || "medium") + " priority" : q.status;
    const context = (task.tags || []).slice(0, 2).map(t => t.name).filter(Boolean).join(" · ");
    el.innerHTML = '<div class="shared-card-heading"><h3>' + esc(task.title) + '</h3>' +
      '<span class="shared-card-state">' + esc(state || "") + '</span></div>' +
      (context ? '<p class="shared-card-context">' + esc(context) + '</p>' : '') +
      '<div class="shared-card-social">' + reactionBar(task) +
        (q.lane !== "completed" ? '<div class="todo-guest-actions">' + bountyButtonHtml(task) + rewardButtonHtml(task) + '</div>' : '') + '</div>' +
      sponsorChips(task) + rewardFormHtml(task) +
      '<details class="shared-card-details"><summary>Discussion' + ((task.comments || []).length ? ' (' + task.comments.length + ')' : '') + '</summary>' + commentsHtml(task) + '</details>';
    return el;
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
      const rank = task => LANES.findIndex(lane => lane[0] === task.queue?.lane);
      return rank(a) - rank(b) || (a.queue?.order || 0) - (b.queue?.order || 0);
    });
    return items;
  }

  function updateStats(tasks){
    const visible = visibleTasks(tasks || []);
    document.getElementById("todo-stat-open").textContent = String(visible.filter(t => t.status !== "done").length);
    document.getElementById("todo-stat-done").textContent = String(visible.filter(t => t.status === "done").length);
    document.getElementById("todo-stat-sponsored").textContent = String(visible.filter(t => (t.sponsorships || []).some(s => s.status !== "dismissed")).length);
  }

  function renderTasks(tasks){
    const list = document.getElementById("todo-public-list");
    if (!list) return;
    // Preserve disclosure and draft state across polling and social mutations.
    const completedOpen = !!list.querySelector('.shared-queue-completed')?.open;
    const disclosures = new Map(Array.from(list.querySelectorAll('[data-shared-task]')).map(card =>
      [card.dataset.sharedTask, { open: card.querySelector('details')?.open,
        rewardOpen: !card.querySelector('.todo-reward-form')?.hidden,
        values: Array.from(card.querySelectorAll('input')).map(input => [input.className, input.value]) }]));
    const focused = document.activeElement;
    const focusTask = focused?.closest('[data-shared-task]')?.dataset.sharedTask;
    const focusClass = focused?.className, focusEmoji = focused?.dataset.reactionEmoji;
    const visible = visibleTasks(tasks);
    updateStats(tasks);
    list.innerHTML = "";
    for (const [key, title, description] of LANES) {
      const rows = visible.filter(task => task.queue?.lane === key);
      const section = document.createElement(key === 'completed' ? 'details' : 'section');
      section.className = 'shared-queue-lane shared-queue-' + key;
      if (key === 'completed') section.open = completedOpen;
      section.innerHTML = '<' + (key === 'completed' ? 'summary' : 'h2') + '>' + title + ' <span>' + rows.length + '</span></' + (key === 'completed' ? 'summary' : 'h2') + '><p>' + description + '</p>';
      if (!rows.length) {
        const empty = document.createElement('p'); empty.className = 'shared-queue-empty';
        empty.textContent = key === 'foreground' ? 'No shared foreground task.' : 'No shared tasks in this section.';
        section.appendChild(empty);
      }
      for (const task of rows) {
        const card = renderGuestCard(task), saved = disclosures.get(String(task.id));
        if (saved) {
          card.querySelector('details').open = saved.open;
          const form = card.querySelector('.todo-reward-form'); if (form) form.hidden = !saved.rewardOpen;
          for (const input of card.querySelectorAll('input')) input.value = saved.values.find(([cls]) => cls === input.className)?.[1] || '';
        }
        section.appendChild(card);
      }
      list.appendChild(section);
    }
    if (focusTask) {
      const card = Array.from(list.querySelectorAll('[data-shared-task]')).find(el => el.dataset.sharedTask === focusTask);
      const target = card && Array.from(card.querySelectorAll('button,input,summary')).find(el => focusEmoji ? el.dataset.reactionEmoji === focusEmoji : el.className === focusClass);
      target?.focus({preventScroll:true});
    }
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
    const status = document.getElementById("todo-public-status");
    if (status) status.hidden = true;
    document.getElementById("todo-public-title").textContent = data.workspaceName || "Shared Todo List";
    document.getElementById("todo-public-subtitle").textContent = data.ownerUsername ? "Activity queue for " + data.ownerUsername : "Shared activity queue";
    document.getElementById("todo-public-date").textContent = data.date || "Today";
    // Printed copies carry the live URL (see the @media print block): a sheet of
    // paper with no way back to the list is a dead end.
    const hero = document.querySelector(".todo-public-hero");
    if (hero) hero.setAttribute("data-print-url", location.href.split("?")[0]);
    document.getElementById("todo-public-updated").textContent = "Updated " + new Date(data.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    renderCalendarOptions(data);
    renderTasks(data.tasks || []);
    applyCapabilities();
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
    if (loadPromise) return loadPromise;
    loadPromise = (async function(){
      try {
        render(await api("/api/public/todo-share/" + encodeURIComponent(token)));
      } catch (e) {
        showError(e.message);
      }
    })().finally(function(){loadPromise=null;});
    return loadPromise;
  }

  async function submitCreateTask(){
    const status = document.getElementById("todo-create-status");
    const titleEl = document.getElementById("todo-create-title");
    const nameEl = document.getElementById("todo-create-name");
    const emailEl = document.getElementById("todo-create-email");
    const durEl = document.getElementById("todo-create-duration");
    const noteEl = document.getElementById("todo-create-note");
    const payload = {
      visitorName: nameEl ? nameEl.value.trim() : "",
      visitorEmail: emailEl ? emailEl.value.trim() : "",
      title: titleEl ? titleEl.value.trim() : "",
      durationMinutes: durEl ? durEl.value : "30",
      note: noteEl ? noteEl.value.trim() : ""
    };
    if (!payload.title) return;
    if (status) status.textContent = "Adding...";
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (status) status.textContent = "Sent to the owner for triage. They can add it to the queue.";
      if (titleEl) titleEl.value = "";
      if (noteEl) noteEl.value = "";
      await load();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  async function toggleReaction(button){
    if (button.disabled) return;
    button.disabled = true;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(button.dataset.taskId));
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
      document.getElementById("todo-action-status").textContent = e.message;
    } finally {
      button.disabled = false;
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
        if (input) input.value = "";
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
      alert("Offer sent. It activates after the owner approves it.");
    } catch (e) {
      button.disabled = false;
      alert(e.message);
    }
  }

  async function placeTaskReward(form){
    const titleEl = form.querySelector(".todo-reward-title");
    const title = titleEl ? titleEl.value.trim() : "";
    if (!title) { if (titleEl) titleEl.focus(); return; }
    const taskId = form.dataset.taskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await api("/api/public/todo-share/" + encodeURIComponent(token) + "/sponsorships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "reward",
          target: "task",
          taskId,
          taskBlockId: form.dataset.taskBlockId,
          taskTitle: task ? task.title : "",
          date: current ? current.date : "",
          rewardTitle: title,
          value: (form.querySelector(".todo-reward-value") || {}).value || "",
          sponsorName: (form.querySelector(".todo-reward-name") || {}).value ? form.querySelector(".todo-reward-name").value.trim() : ""
        })
      });
      form.reset();
      form.hidden = true;
      document.getElementById("todo-action-status").textContent = "Reward offered. It activates after the owner approves it.";
      await load();
    } catch (e) {
      if (submit) submit.disabled = false;
      alert(e.message);
    }
  }

  // Gate the auth hint to the viewer's capabilities. Re-run on every render so
  // the 15s poll never transiently unlocks a guest.
  function applyCapabilities(){
    const viewer = (current && current.viewer) || {};
    const loggedIn = !!viewer.loggedIn;
    const note = document.getElementById("todo-encourage-auth-note");
    if (note) {
      note.innerHTML = loggedIn
        ? "Signed in as " + esc(viewer.username || "your account") + "."
        : 'React, comment, and offer rewards freely. <a href="/login">Sign in</a> to put 2x points on a task.';
    }
    const name = document.getElementById("todo-create-name");
    if (name && loggedIn && viewer.username && !name.value) name.value = viewer.username;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  // Serialization is window.DCC.ShareExport, the same module the server route
  // requires, so the download and the link produce byte-identical files for the
  // same rows. What differs is WHICH rows: a single-day export runs through
  // `visibleTasks`, so the file matches the filters and sort on screen rather
  // than silently handing over rows the viewer had filtered away. A range has no
  // on-screen equivalent to match, so it goes to the server unfiltered and the
  // menu says so.
  function exportMeta(){
    return {
      workspaceName: (current && current.workspaceName) || "",
      owner: (current && current.ownerUsername) || "",
      date: (current && current.date) || "",
      url: location.href.split("?")[0]
    };
  }

  function downloadBlob(text, filename, mime){
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick, not synchronously: Safari cancels an in-flight
    // download when the object URL disappears out from under it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportRangeDays(){
    const select = document.getElementById("todo-export-range");
    const value = select ? select.value : "day";
    return value === "day" ? 0 : (parseInt(value, 10) || 0);
  }

  function runExport(format){
    const ShareExport = (window.DCC && window.DCC.ShareExport) || null;
    if (format === "pdf") {
      // Print rather than generating a PDF: the browser's own print-to-PDF
      // renders the page the viewer is actually looking at, needs no library,
      // and stays inside the CSP a public page runs under.
      window.print();
      return;
    }
    if (!ShareExport) { alert("Export is unavailable on this page right now."); return; }
    const days = exportRangeDays();
    const meta = exportMeta();

    if (days > 0) {
      // Range: the server owns multi-day assembly (it has to read each day).
      const from = meta.date || new Date().toISOString().slice(0, 10);
      // window.DCC.dates.addDays, not a local copy: core.js already ships this
      // exact helper (same UTC-noon anchor) and this page now loads core.js.
      const params = new URLSearchParams({
        format: format, from: from, to: window.DCC.dates.addDays(from, days - 1)
      });
      window.location.href = "/api/public/todo-share/" + encodeURIComponent(token)
        + "/export?" + params.toString();
      return;
    }

    if (!current) { alert("The list is still loading."); return; }
    const rows = visibleTasks(current.tasks || []).map(task =>
      Object.assign({}, task, { date: current.date || meta.date }));
    if (!rows.length && !confirm("Nothing matches the current filters. Export an empty file anyway?")) return;
    downloadBlob(
      ShareExport.serialize(format, rows, meta),
      ShareExport.filenameFor(meta, format),
      ShareExport.mimeFor(format)
    );
  }

  function bindExport(){
    const button = document.getElementById("todo-export-button");
    const menu = document.getElementById("todo-export-menu");
    if (!button || !menu) return;
    button.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
    menu.addEventListener("click", e => {
      const item = e.target.closest("[data-export]");
      if (!item) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      runExport(item.dataset.export);
    });
    const range = document.getElementById("todo-export-range");
    const note = document.getElementById("todo-export-range-note");
    if (range && note) {
      // PDF prints the page on screen, so it can only ever be one day. Disable
      // it while a range is selected rather than silently printing today: the
      // range picker sits in the same menu, so it reads as applying to all four.
      const syncRange = () => {
        const isRange = range.value !== "day";
        const pdf = menu.querySelector('[data-export="pdf"]');
        if (pdf) {
          pdf.disabled = isRange;
          pdf.title = isRange ? "PDF prints the day on screen. Pick This day." : "";
        }
        note.textContent = isRange
          ? "Multi-day exports include every task, ignoring the filters above. PDF prints this day only."
          : "Exports exactly the rows shown above.";
      };
      range.addEventListener("change", syncRange);
      syncRange();
    }
    document.addEventListener("click", e => {
      if (menu.hidden || e.target.closest("#todo-export")) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    });
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
        if (current) renderTasks(current.tasks || []);
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
        if (current) renderTasks(current.tasks || []);
      });
      document.addEventListener("click", e => {
        if (typeMenu.hidden || e.target.closest("#todo-type-filter")) return;
        typeMenu.hidden = true;
        typeButton.setAttribute("aria-expanded", "false");
      });
      syncTypeFilterButton();
    }

    // Inline guest add-task toggle.
    const addToggle = document.getElementById("todo-guest-add-toggle");
    const addForm = document.getElementById("todo-guest-add-form");
    if (addToggle && addForm) {
      addToggle.addEventListener("click", () => {
        const open = addForm.hidden;
        addForm.hidden = !open;
        addToggle.setAttribute("aria-expanded", String(open));
        if (open) { const t = document.getElementById("todo-create-title"); if (t) t.focus(); }
      });
    }
    const createBtn = document.getElementById("todo-create-task");
    if (createBtn) createBtn.addEventListener("click", submitCreateTask);
    const createTitle = document.getElementById("todo-create-title");
    if (createTitle) createTitle.addEventListener("keydown", e => { if (e.key === "Enter") submitCreateTask(); });

    const list = document.getElementById("todo-public-list");
    if (list) {
      list.addEventListener("click", e => {
        const rewardToggle = e.target.closest("[data-reward-toggle]");
        if (rewardToggle) {
          e.preventDefault();
          e.stopPropagation();
          const card = rewardToggle.closest(".tl-item");
          const form = card ? card.querySelector(".todo-reward-form") : null;
          if (form) {
            form.hidden = !form.hidden;
            if (!form.hidden) { const t = form.querySelector(".todo-reward-title"); if (t) t.focus(); }
          }
          return;
        }
        const bountyBtn = e.target.closest("[data-bounty-task-id]");
        if (bountyBtn) {
          e.preventDefault();
          e.stopPropagation();
          placeTaskBounty(bountyBtn);
          return;
        }
        const reactBtn = e.target.closest("[data-reaction-emoji]");
        if (!reactBtn) return;
        e.preventDefault();
        e.stopPropagation();
        toggleReaction(reactBtn);
      });
      list.addEventListener("submit", e => {
        const rewardForm = e.target.closest(".todo-reward-form");
        if (rewardForm) { e.preventDefault(); placeTaskReward(rewardForm); return; }
        const commentForm = e.target.closest(".todo-public-comment-form");
        if (commentForm) { e.preventDefault(); submitComment(commentForm); }
      });
    }
  }

  bindControls();
  bindExport();
  load();
  if(token&&typeof EventSource!=="undefined"){
    const events=new EventSource("/api/public/todo-share/"+encodeURIComponent(token)+"/events");
    events.onmessage=function(event){if(event.data==="changed")load();};
  }
  setInterval(load, 5*60*1000);
})();
