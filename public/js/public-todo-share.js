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
  const CK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';

  // Guest type config — mirrors the owner TC table so the shared renderer's
  // type tag / bar color match the real itinerary.
  const GUEST_TC = {
    task:    {tag:"Task",    cls:"tag-task",    color:"#a78bfa"},
    repeat:  {tag:"Repeat",  cls:"tag-task",    color:"#a78bfa"},
    calendar:{tag:"Calendar",cls:"tag-meeting", color:"#f97316"},
    meeting: {tag:"Meeting", cls:"tag-meeting", color:"#f97316"},
    oneone:  {tag:"1:1",     cls:"tag-oneone",  color:"#f59e0b"},
    break:   {tag:"Break",   cls:"tag-break",   color:"#22c55e"},
    ooo:     {tag:"OOO",     cls:"tag-ooo",     color:"#64748b"}
  };

  // Capability gate, mirroring the server. Reads the resolved capability map off
  // the share payload's viewer; defaults keep the page usable if it is absent.
  function can(cap){
    const viewer = (current && current.viewer) || {};
    const caps = viewer.capabilities || {};
    if (Object.prototype.hasOwnProperty.call(caps, cap)) return !!caps[cap];
    if (cap === "place_bounty") return !!viewer.loggedIn;
    return true;
  }

  function esc(value) { return window.DCC.esc(value); } // delegates to core.js

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

  function guestMs(m){ m = Number(m) || 0; return m >= 60 ? Math.floor(m/60) + "h" + (m%60 ? " " + (m%60) + "m" : "") : m + "m"; }

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

  // ---- Sponsorship / bounty / reward helpers (shared across cards) ----
  function sponsorChips(task){
    const offers = (task.sponsorships || []).filter(s => s.status !== "dismissed");
    if (!offers.length) return "";
    return '<div class="todo-public-sponsors">' + offers.slice(0, 3).map(s => {
      const label = s.kind === "reward" ? "Reward" : "Bounty";
      const amount = money(s.valueCents);
      return '<span>' + esc(label) + ': ' + esc(s.rewardTitle || (s.kind === "reward" ? "a reward" : "2x points")) + (amount ? " " + esc(amount) : "") + '</span>';
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
    return '<button class="todo-bounty-btn" type="button" data-bounty-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" title="Put 2x points on this task">💎 2× points</button>';
  }

  function rewardButtonHtml(task){
    if (!can("sponsor_reward")) return "";
    return '<button class="todo-reward-btn" type="button" data-reward-toggle="' + esc(task.id) + '" title="Offer a reward for finishing this">🎁 Offer reward</button>';
  }

  function rewardFormHtml(task){
    if (!can("sponsor_reward")) return "";
    return '<form class="todo-reward-form" hidden data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '">' +
        '<input type="text" class="todo-reward-title" maxlength="160" placeholder="Reward if completed (e.g. coffee on me)">' +
        '<div class="todo-reward-row">' +
          '<input type="text" class="todo-reward-name" maxlength="80" placeholder="Your name">' +
          '<input type="number" class="todo-reward-value" min="0" step="0.01" placeholder="$ optional">' +
          '<button type="submit" class="todo-public-btn primary">Send</button>' +
        '</div>' +
      '</form>';
  }

  function reactionBar(task){
    const counts = task.reactions || {};
    return '<div class="todo-public-reactions itinerary-reactions" aria-label="Task reactions">' + COMMON_REACTIONS.map(emoji => {
      const count = Number(counts[emoji]) || 0;
      const active = (task.viewerReactions || []).includes(emoji);
      return '<button class="todo-reaction-btn' + (active ? ' active' : '') + '" type="button" data-reaction-emoji="' + esc(emoji) + '" data-task-id="' + esc(task.id) + '" data-task-block-id="' + esc(task.blockId || "") + '" title="React ' + esc(emoji) + '">' +
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
          '<input type="text" class="todo-public-comment-input" maxlength="1000" placeholder="Add a comment...">' +
          '<button type="submit" class="todo-public-comment-send">Send</button>' +
        '</form>'
      : '';
    if (!list && !form) return '';
    return '<div class="todo-public-comments">' + list + form + '</div>';
  }

  // ---- Guest -> owner-ev adapter + helper shims for the shared renderer ----
  function guestTaskToEv(task){
    const type = itemType(task);
    return {
      id: task.id,
      title: task.redacted ? "🔒 Private task" : task.title,
      start: task.start || "",
      end: task.end || "",
      type: type,
      itemType: type,
      itemTypeLabel: itemTypeLabel(task),
      source: "",
      priority: task.redacted ? "" : (task.priority || ""),
      durationMinutes: task.durationMinutes || 0,
      status: task.status,
      points: task.redacted ? null : (task.points != null ? task.points : null),
      tags: task.redacted ? [] : (task.tags || []),
      createdByGuest: !!task.createdByGuest,
      redacted: !!task.redacted
    };
  }
  function guestCfg(type){ return GUEST_TC[type] || GUEST_TC.task; }
  function guestTagColor(ev){ return (ev && ev.tags && ev.tags[0] && ev.tags[0].color) || null; }
  function guestTagChipsHtml(ev){
    const tags = (ev && ev.tags) || [];
    if (!tags.length) return "";
    return tags.slice(0, 8).map(t =>
      '<span class="tag-chip card-tag-chip" style="--chip-color:' + esc(t.color || "var(--accent)") + '">' + esc(t.name || "") + '</span>'
    ).join("");
  }
  function guestColorMeta(ev){
    if (!ev.priority) return "";
    const cls = ev.priority === "High" ? "pri-hi" : ev.priority === "Medium" ? "pri-med" : "pri-lo";
    return '<span class="' + cls + '">' + esc(ev.priority) + '</span>';
  }
  function guestPoints(ev){
    if (ev.points == null || ev.points <= 0) return "";
    return '<span class="points-chip' + (ev.points >= 20 ? ' bonus' : '') + '">' + esc(ev.points) + ' pts</span>';
  }
  function guestFooterHtml(task){
    return '<div class="todo-guest-footer">' +
        '<div class="todo-guest-actions">' + bountyButtonHtml(task) + rewardButtonHtml(task) + '</div>' +
        sponsorChips(task) +
        rewardFormHtml(task) +
        commentsHtml(task) +
      '</div>';
  }

  const noop = () => "";
  function renderGuestCard(task){
    const ev = guestTaskToEv(task);
    if (typeof window.renderItineraryCard !== "function") {
      const fallback = document.createElement("div");
      fallback.className = "tl-item";
      fallback.textContent = ev.title;
      return fallback;
    }
    const el = window.renderItineraryCard(ev, {
      guest: true,
      cfg: guestCfg, srcTag: noop, colorMeta: guestColorMeta,
      taskTagColor: guestTagColor, taskTagChipsHtml: guestTagChipsHtml,
      f12: fmtTime, ms: guestMs,
      dur: (e) => e.durationMinutes || 0, origDur: () => 0,
      isMeeting: (e) => e.type === "calendar" || e.type === "meeting" || e.type === "oneone",
      isWrap: () => false, isRideAlong: () => false,
      escHtml: esc, notesButton: noop,
      pointsChip: guestPoints, petPrivacyChip: noop,
      reactionChipsHtml: reactionBar,
      bountyCount: taskBountied(task) ? 1 : 0,
      bountyMeta: { count: taskBountied(task) ? 1 : 0, hasSponsor: false, sponsorName: "" },
      footerHtml: guestFooterHtml(task)
    });
    if (task.createdByGuest) el.classList.add("guest-submitted");
    return el;
  }

  // Compact one-liner for completed tasks — mirrors the owner's done rows.
  function compactRowEl(task){
    const ev = guestTaskToEv(task);
    const color = guestTagColor(ev) || guestCfg(ev.type).color;
    const t1 = fmtTime(task.start);
    const el = document.createElement("div");
    el.className = "tl-compact" + (task.createdByGuest ? " guest-submitted" : "");
    el.innerHTML =
      '<div class="tl-time">' + esc(t1.replace(/ (AM|PM)/, "")) + '</div>' +
      '<div class="tl-node"></div>' +
      '<div class="compact-row">' +
        '<div class="c-check" title="Done">' + CK_SVG + '</div>' +
        '<div class="bar" style="background:' + esc(color) + '"></div>' +
        '<span class="c-title">' + (ev.redacted ? "🔒 Private task" : esc(task.title)) + '</span>' +
        '<span class="c-time">' + esc(t1) + (task.end ? ' - ' + esc(fmtTime(task.end)) : '') + '</span>' +
      '</div>';
    return el;
  }

  function blockHeaderEl(blk){
    const dot = blk.blockType === 'work' ? 'var(--accent-light)' : blk.blockType === 'personal' ? 'var(--purple,#a78bfa)' : 'var(--text-muted)';
    const el = document.createElement("div");
    el.className = "tl-block-header";
    el.innerHTML =
      '<span class="block-hdr-dot" style="background:' + dot + '"></span>' +
      '<span class="block-hdr-name">' + esc(blk.name) + '</span>' +
      '<span class="block-hdr-time">' + esc(fmtTime(blk.start)) + ' – ' + esc(fmtTime(blk.end)) + '</span>';
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

  function renderTasks(tasks){
    const list = document.getElementById("todo-public-list");
    if (!list) return;
    const visible = visibleTasks(tasks);
    const active = visible.filter(task => task.status !== "done");
    const completed = visible.filter(task => task.status === "done");
    updateStats(tasks);
    list.innerHTML = "";
    if (!active.length && !completed.length) {
      list.innerHTML = '<div class="todo-public-empty">No matching items are active right now.</div>';
      return;
    }
    const frag = document.createDocumentFragment();

    // Mirror the owner order: completed one-liners first, "Up Next" divider, then
    // active full cards (with work/personal block headers in time order).
    completed.forEach(task => frag.appendChild(compactRowEl(task)));
    if (completed.length && active.length) {
      const d = document.createElement("div");
      d.className = "divider";
      d.innerHTML = '<span>Up Next</span>';
      frag.appendChild(d);
    }

    const useHeaders = filters.sort === "time";
    const blocks = useHeaders
      ? (current && current.blocks || []).slice().filter(b => b.start).sort((a, b) => String(a.start).localeCompare(String(b.start)))
      : [];
    let bptr = 0;
    function injectHeaders(beforeStart){
      while (bptr < blocks.length && String(blocks[bptr].start) <= beforeStart) {
        frag.appendChild(blockHeaderEl(blocks[bptr]));
        bptr++;
      }
    }
    active.forEach(task => {
      if (useHeaders && task.start) injectHeaders(task.start);
      frag.appendChild(renderGuestCard(task));
    });
    if (useHeaders) injectHeaders("99:99");

    list.appendChild(frag);
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
    try {
      render(await api("/api/public/todo-share/" + encodeURIComponent(token)));
    } catch (e) {
      showError(e.message);
    }
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
      if (status) status.textContent = "Added.";
      if (titleEl) titleEl.value = "";
      if (noteEl) noteEl.value = "";
      await load();
    } catch (e) {
      if (status) status.textContent = e.message;
    }
  }

  async function toggleReaction(button){
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
      /* transient; next poll reconciles */
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
  load();
  setInterval(load, 15000);
})();
