(function(){
  const token = location.pathname.split("/").filter(Boolean).pop();
  let current = null;
  // Adapted from PR421's composer lifecycle: scoped page-memory drafts and
  // pending actions survive filtering/refresh, without its unmerged reward model.
  const cardDrafts = new Map(), pendingActions = new Set();
  let viewerScope = '', viewerEpoch = 0;
  function cardFor(id) { return Array.from(document.querySelectorAll('[data-shared-task]')).find(el => el.dataset.sharedTask === String(id)); }
  function beginAction(kind, id) {
    const key = kind + ':' + id;
    if (pendingActions.has(key)) return null;
    pendingActions.add(key); renderTasks(current.tasks || []);
    return { key, epoch: viewerEpoch };
  }
  function endAction(action) {
    if (action?.epoch !== viewerEpoch) return;
    pendingActions.delete(action.key); renderTasks(current.tasks || []);
  }
  function clearDraft(id, classes) {
    const saved = cardDrafts.get(String(id));
    if (saved) saved.values = saved.values.filter(([cls]) => !classes.includes(cls));
    for (const input of cardFor(id)?.querySelectorAll('input') || []) if (classes.includes(input.className)) input.value = '';
  }
  // Social writes re-read through the live coordinator (single-flight, trailing).
  function reloadAfterMutation() { return load(); }

  const filters = {
    types: new Set(["task", "repeat", "calendar", "time"]),
    status: "all"
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
    if (!res.ok) { const error = new Error(data.error || data.message || "Request failed"); error.status = res.status; throw error; }
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
      if (!(task.sponsorships || []).some(s => s.kind === "bounty" && s.status === "approved"))
        return '<button class="todo-bounty-btn bountied" type="button" disabled title="This offer activates after owner approval">💎 Offer pending</button>';
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
    return '<div class="todo-public-reactions" aria-label="Task reactions">' + COMMON_REACTIONS.map(emoji => {
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

  // Viewer lanes. Needs You and snoozes are the owner's inbox, so they read as Up next.
  const LANES = [
    ["now", "Now", "The one task in focus right now.", "Not sharing a focus right now."],
    ["running", "Running in background", "Work an assistant or process is actively running, confirmed in the last 15 minutes.", "Nothing running in the background."],
    ["next", "Up next", "Queued work, in priority order.", "Nothing queued up next."],
    ["later", "Later today", "Scheduled for later today.", "Nothing else scheduled today."],
    ["done", "Done today", "Finished today.", "Nothing finished yet today."]
  ];
  // Mirrors working-queue.js: two independent columns, stacked on narrow screens.
  const narrow = window.matchMedia("(max-width: 700px)");
  // Same two-column shape as the owner Working Queue (queue-layout.js moves lanes
  // on a breakpoint change). Under 700px the grid is one column, so stacked order
  // reads Now, Running, Up next, Later today.
  const LAYOUT = { columns: [["now", "next"], ["running", "later"]], stacked: [["now", "running"], ["next", "later"]] };
  const layout = () => LAYOUT[narrow.matches ? "stacked" : "columns"];
  function arrangeLanes(){
    const list = document.getElementById("todo-public-list");
    if (list) window.DCCQueueLayout.arrange(list, layout(), name => list.querySelector('.wq-grid [data-shared-lane="' + name + '"]'));
  }
  const V1_LANES = { foreground: "now", background: "running", "needs-you": "next", priority: "next", completed: "done" };
  function laneOf(task){ return task.activity?.lane || V1_LANES[task.queue?.lane] || "next"; }
  function orderOf(task){ return task.activity?.order ?? task.queue?.order ?? 0; }

  function clockLabel(hhmm){
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
    if (!m) return "";
    const h = Number(m[1]), suffix = h >= 12 ? "PM" : "AM";
    return ((h % 12) || 12) + ":" + m[2] + " " + suffix;
  }
  function instantLabel(iso){
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    try { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: current?.timeZone || undefined }).format(ms); }
    catch { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  }
  function sinceLabel(iso){
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (min < 1) return "just now";
    if (min < 60) return min + "m";
    if (min < 24 * 60) return Math.floor(min / 60) + "h " + (min % 60) + "m";
    return Math.floor(min / 1440) + "d";
  }
  // Text that ages in place, so the clock ticks without rebuilding cards.
  function liveText(kind, iso){
    return '<span data-age-kind="' + kind + '" data-age-from="' + esc(iso) + '">' + esc(ageText(kind, iso)) + '</span>';
  }
  function ageText(kind, iso){
    const since = sinceLabel(iso);
    if (kind === "started") return "Started " + instantLabel(iso) + (since ? " · " + since : "");
    return "Confirmed " + (since === "just now" ? since : since + " ago");
  }
  function cardMeta(task, lane){
    const a = task.activity || {};
    const range = task.start ? clockLabel(task.start) + (task.end ? " – " + clockLabel(task.end) : "") : "";
    if (lane === "now") return a.onBreak ? "On a break · Work timer paused" : a.startedAt ? liveText("started", a.startedAt) : "In focus";
    if (lane === "running") return a.confirmedAt ? liveText("confirmed", a.confirmedAt) : "Running";
    if (lane === "next") return [a.priority ? a.priority + " priority" : "", range].filter(Boolean).map(esc).join(" · ");
    if (lane === "later") return esc([range, itemType(task) !== "task" ? itemTypeLabel(task) : ""].filter(Boolean).join(" · "));
    if (lane === "done") return a.completedAt ? esc("Completed " + instantLabel(a.completedAt)) : "Done";
    return "";
  }
  const CHIPS = { now: "Now", running: "Running", next: "Up next", later: "Planned", done: "Done" };
  // The owner's Working Queue row (itinerary-card.js), read-only: no callbacks are
  // passed, so no complete, schedule, open, drag or priority control renders. The
  // title is the task's own (never a parent path). The share-only social footer
  // (reactions, bounty, reward, discussion) is appended under the row.
  function renderGuestCard(task){
    const lane = laneOf(task);
    const context = (task.tags || []).slice(0, 2).map(t => t.name).filter(Boolean).join(" · ");
    const meta = cardMeta(task, lane);
    const el = window.renderItineraryListRow({ id: task.id, title: task.title }, {
      escHtml: esc,
      done: lane === "done",
      extraClass: "wq-card shared-queue-card shared-card-" + lane + (lane === "now" ? " wq-focus" : "") + (task.activity?.onBreak ? " wq-on-break" : ""),
      dataset: { sharedTask: task.id },
      titleExtrasHtml: '<span class="wq-status">' + esc(task.activity?.onBreak ? "On a break" : CHIPS[lane]) + '</span>',
      metaHtml: (meta ? '<p class="wq-time shared-card-meta">' + meta + '</p>' : '') +
        (context ? '<p class="wq-time shared-card-context">' + esc(context) + '</p>' : '')
    });
    el.querySelector(".it-list-main").insertAdjacentHTML("beforeend",
      '<div class="shared-card-social">' + reactionBar(task) +
        (lane !== "done" ? '<div class="todo-guest-actions">' + bountyButtonHtml(task) + rewardButtonHtml(task) + '</div>' : '') + '</div>' +
      sponsorChips(task) + rewardFormHtml(task) +
      '<details class="shared-card-details"><summary>Discussion' + ((task.comments || []).length ? ' (' + task.comments.length + ')' : '') + '</summary>' + commentsHtml(task) + '</details>');
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
      return true;
    });
    items.sort((a, b) => {
      const rank = task => LANES.findIndex(lane => lane[0] === laneOf(task));
      return rank(a) - rank(b) || orderOf(a) - orderOf(b);
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
    const completedOpen = !!list.querySelector('.shared-queue-done')?.open;
    const disclosures = new Map(Array.from(list.querySelectorAll('[data-shared-task]')).map(card =>
      [card.dataset.sharedTask, { open: card.querySelector('details')?.open,
        rewardOpen: !card.querySelector('.todo-reward-form')?.hidden,
        values: Array.from(card.querySelectorAll('input')).map(input => [input.className, input.value]) }]));
    for (const [id, draft] of disclosures) cardDrafts.set(id, draft);
    const focused = document.activeElement;
    const focusTask = focused?.closest('[data-shared-task]')?.dataset.sharedTask;
    const focusClass = focused?.className, focusEmoji = focused?.dataset.reactionEmoji;
    const selection = typeof focused?.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const visible = visibleTasks(tasks);
    updateStats(tasks);
    list.innerHTML = "";
    const sections = {};
    for (const [key, title, description, emptyText] of LANES) {
      const rows = visible.filter(task => laneOf(task) === key);
      const done = key === 'done';
      // Owner Working Queue lane markup (.wq-lane / .wq-completed), viewer copy.
      const section = document.createElement(done ? 'details' : 'section');
      section.className = (done ? 'wq-completed' : 'wq-lane') + ' shared-queue-lane shared-queue-' + key;
      section.dataset.sharedLane = key;
      if (done) section.open = completedOpen;
      section.innerHTML = done
        ? '<summary>' + esc(title) + ' · ' + rows.length + '</summary><p class="wq-time">' + esc(description) + '</p>'
        : '<div class="wq-heading"><h2>' + esc(title) + ' <small>' + rows.length + '</small></h2></div><p class="wq-time shared-lane-help">' + esc(description) + '</p>';
      if (!rows.length) {
        const empty = document.createElement('p'); empty.className = 'wq-empty shared-queue-empty';
        empty.textContent = emptyText;
        section.appendChild(empty);
      }
      for (const task of rows) {
        const card = renderGuestCard(task), saved = cardDrafts.get(String(task.id));
        if (saved) {
          card.querySelector('details').open = saved.open;
          const form = card.querySelector('.todo-reward-form'); if (form) form.hidden = !saved.rewardOpen;
          for (const input of card.querySelectorAll('input')) input.value = saved.values.find(([cls]) => cls === input.className)?.[1] || '';
        }
        for (const [kind, selector] of [['react', '.todo-reaction-btn'], ['comment', '.todo-public-comment-form input,.todo-public-comment-form button'], ['reward', '.todo-reward-form input,.todo-reward-form button'], ['bounty', '[data-bounty-task-id]']]) {
          if (pendingActions.has(kind + ':' + task.id)) card.querySelectorAll(selector).forEach(el => { el.disabled = true; });
        }
        section.appendChild(card);
      }
      sections[key] = section;
    }
    const grid = document.createElement('div');
    grid.className = 'wq-grid';
    for (const names of layout()) {
      const col = document.createElement('div'); col.className = 'wq-col';
      names.forEach(name => col.appendChild(sections[name]));
      grid.appendChild(col);
    }
    list.appendChild(grid);
    list.appendChild(sections.done);
    if (focusTask) {
      const card = Array.from(list.querySelectorAll('[data-shared-task]')).find(el => el.dataset.sharedTask === focusTask);
      const target = card && Array.from(card.querySelectorAll('button,input,summary')).find(el => focusEmoji ? el.dataset.reactionEmoji === focusEmoji : el.className === focusClass);
      target?.focus({preventScroll:true});
      if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
    }
  }

  function render(data){
    const scope = JSON.stringify([token, data.date, data.viewer?.loggedIn, data.viewer?.username]);
    if (scope !== viewerScope) {
      viewerEpoch++; cardDrafts.clear(); pendingActions.clear();
      document.getElementById('todo-public-list').replaceChildren(); viewerScope = scope;
    }
    const allowed = new Set((data.tasks || []).map(task => String(task.id)));
    for (const id of cardDrafts.keys()) if (!allowed.has(id)) cardDrafts.delete(id);
    // Remove stale private/deleted cards before the draft collector runs.
    for (const card of document.querySelectorAll('[data-shared-task]')) if (!allowed.has(card.dataset.sharedTask)) card.remove();
    current = data;
    document.getElementById("todo-public-content").hidden = false;
    document.getElementById("todo-public-error").hidden = true;
    const status = document.getElementById("todo-public-status");
    if (status) status.hidden = true;
    document.getElementById("todo-public-title").textContent = data.workspaceName || "Shared Todo List";
    document.getElementById("todo-public-subtitle").textContent = (data.ownerUsername ? data.ownerUsername + "'s" : "Shared") + " focus, background work and plan for the day.";
    document.getElementById("todo-public-date").textContent = data.date || "Today";
    // Printed copies carry the live URL (see the @media print block): a sheet of
    // paper with no way back to the list is a dead end.
    const hero = document.querySelector(".todo-public-hero");
    if (hero) hero.setAttribute("data-print-url", location.href.split("?")[0]);
    document.getElementById("todo-public-updated").textContent = "Updated " + new Date(data.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

  // ── Live updates ──
  // Shared lifecycle modules (also used by the owner app): live-channel.js owns
  // the EventSource (pings, heartbeat watchdog, capacity, revoke, reconnect) and
  // the pill state; refresh-coordinator.js owns single-flight reads, a trailing
  // re-read for pings that land mid-read, the 30s safety poll, retry backoff and
  // the timed re-read when a worker lease is known to lapse.
  const POLL_MS = 30000, TICK_MS = 20000;
  let lastOk = 0, liveState = "connecting", lastStatus = null;
  function setLive(state){
    liveState = state;
    const pill = document.getElementById("todo-public-live");
    if (!pill) return;
    const updated = lastOk ? new Date(lastOk).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    pill.dataset.state = state;
    pill.textContent = { live: "Live", polling: "Live (polling)", reconnecting: "Reconnecting…",
      offline: "Offline" + (updated ? " · updated " + updated : ""), revoked: "Link no longer active", connecting: "Connecting…" }[state] || "Live";
  }
  function showRevoked(){
    coordinator.stop();
    current = null; cardDrafts.clear(); pendingActions.clear(); viewerScope = "";
    document.getElementById("todo-public-list")?.replaceChildren();
    setLive("revoked");
    showError("This shared link is no longer active.");
  }
  const coordinator = window.DCCRefreshCoordinator.createTaskRefreshCoordinator({
    intervalMs: POLL_MS,
    trailing: true,
    refreshOnVisible: true,
    retryDelaysMs: [5000, 10000, 20000, 40000, 60000],
    isVisible: () => document.visibilityState === "visible",
    canRefresh: () => liveState !== "revoked",
    getDate: () => token,
    isLoaded: data => !!data && typeof data === "object",
    loadDay: () => api("/api/public/todo-share/" + encodeURIComponent(token)),
    apply: (_token, _reason, data) => {
      lastOk = Date.now(); lastStatus = 200;
      render(data);
      const at = Date.parse(data.nextChangeAt), serverNow = Date.parse(data.serverNow);
      // Re-read just after a shown worker lease lapses (clock skew corrected, jittered, capped).
      if (Number.isFinite(at)) coordinator.runAt(Math.min(at + (Number.isFinite(serverNow) ? Date.now() - serverNow : 0) + 500 + Math.random() * 1000, Date.now() + 15 * 60000), "lease");
      channel.report(200);
    },
    onError: error => {
      lastStatus = error.status || 0;
      channel.report(lastStatus);
      if (!current && liveState !== "revoked") showError(error.message);
    },
    setIntervalFn: (fn, ms) => setInterval(fn, ms),
    clearIntervalFn: id => clearInterval(id),
    addVisibilityListener: fn => document.addEventListener("visibilitychange", fn),
    removeVisibilityListener: fn => document.removeEventListener("visibilitychange", fn)
  });
  const channel = window.DCCLiveChannel.createLiveChannel({
    url: "/api/public/todo-share/" + encodeURIComponent(token) + "/events",
    isVisible: () => document.visibilityState === "visible",
    onPing: reason => coordinator.refresh(reason),
    onState: state => { if (state === "revoked") showRevoked(); else setLive(state); },
    // The stream closed and EventSource cannot say why: one feed read can.
    probe: async () => { lastStatus = null; await coordinator.refresh("probe"); return lastStatus ?? 200; }
  });
  function load(){
    if (!token) { showError("Missing share token."); return Promise.resolve(false); }
    return coordinator.refresh("manual");
  }
  function tickAges(){
    document.querySelectorAll("[data-age-kind]").forEach(el => { el.textContent = ageText(el.dataset.ageKind, el.dataset.ageFrom); });
    if (liveState === "offline") setLive("offline");
  }
  // Test and support hook: no data beyond what the page already shows.
  window.DCCShareLive = { refresh: reason => coordinator.refresh(reason || "manual"), state: () => liveState };

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
    const action = beginAction('react', button.dataset.taskId);
    if (!action) return;
    document.getElementById("todo-action-status").textContent = "";
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
      if (action.epoch !== viewerEpoch) return;
      const latest = (current.tasks || []).find(t => String(t.id) === String(button.dataset.taskId));
      if (latest) {
        latest.reactions = data.counts || {};
        latest.viewerReactions = data.viewerReactions || [];
        renderTasks(current.tasks || []);
      } else {
        await load();
      }
    } catch (e) {
      if (action.epoch === viewerEpoch) document.getElementById("todo-action-status").textContent = e.message;
    } finally {
      endAction(action);
    }
  }

  async function submitComment(form){
    const input = form.querySelector(".todo-public-comment-input");
    const body = input ? input.value.trim() : "";
    if (!body) return;
    const taskId = form.dataset.taskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    const action = beginAction('comment', taskId); if (!action) return;
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
      if (action.epoch !== viewerEpoch) return;
      clearDraft(taskId, ['todo-public-comment-input']);
      const latest = (current.tasks || []).find(t => String(t.id) === String(taskId));
      if (latest) {
        latest.comments = data.comments || [];
        renderTasks(current.tasks || []);
      } else {
        await load();
      }
    } catch (e) {
      if (action.epoch === viewerEpoch) alert(e.message);
    } finally { endAction(action); }
  }

  async function placeTaskBounty(button){
    if (button.disabled) return;
    const taskId = button.dataset.bountyTaskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    const action = beginAction('bounty', taskId); if (!action) return;
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
      if (action.epoch !== viewerEpoch) return;
      await reloadAfterMutation();
      alert("Offer sent. It activates after the owner approves it.");
    } catch (e) {
      if (action.epoch === viewerEpoch) alert(e.message);
    } finally { endAction(action); }
  }

  async function placeTaskReward(form){
    const titleEl = form.querySelector(".todo-reward-title");
    const title = titleEl ? titleEl.value.trim() : "";
    if (!title) { if (titleEl) titleEl.focus(); return; }
    const taskId = form.dataset.taskId;
    const task = (current && current.tasks || []).find(t => String(t.id) === String(taskId));
    const action = beginAction('reward', taskId); if (!action) return;
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
      if (action.epoch !== viewerEpoch) return;
      clearDraft(taskId, ['todo-reward-title', 'todo-reward-name', 'todo-reward-value']);
      const latestForm = cardFor(taskId)?.querySelector('.todo-reward-form'); if (latestForm) latestForm.hidden = true;
      const saved = cardDrafts.get(String(taskId)); if (saved) saved.rewardOpen = false;
      document.getElementById("todo-action-status").textContent = "Reward offered. It activates after the owner approves it.";
      await reloadAfterMutation();
    } catch (e) {
      if (action.epoch === viewerEpoch) alert(e.message);
    } finally { endAction(action); }
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
      ["todo-filter-status", "status"]
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
          const card = rewardToggle.closest("[data-shared-task]");
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
  if (token) { load(); channel.open(); coordinator.start(); } else load();
  setInterval(tickAges, TICK_MS);
  document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") channel.resume(); });
  window.addEventListener("online", function(){ channel.resume(); coordinator.refresh("online"); });
  narrow.addEventListener?.("change", arrangeLanes);
})();
