(function(){
  let share = null;
  let sponsorships = [];
  let taskReactions = {};
  let taskReactionsByTitle = {};
  let taskComments = {};
  let taskCommentsByTitle = {};
  const reactionOrder = ["👍", "🙌", "🔥", "💪", "🎉", "❤️"];
  let reactionsDate = "";
  let reactionsLoading = null;
  let commentsDate = "";
  let commentsLoading = null;
  let activity = { items: [], seenAt: null, latestAt: null, unreadCount: 0 };

  function esc(value) { return window.DCC.esc(value); } // delegates to core.js

  function money(cents){
    const n = Number(cents) || 0;
    if (!n) return "";
    return "$" + (n / 100).toFixed(n % 100 ? 2 : 0);
  }

  function api(path, options) { return window.DCC.api(path, { ...(options||{}), errorLabel: "Todo share request failed" }); } // delegates to core.js

  function toast(message, type) { return window.DCC.toast(message, type); } // delegates to core.js

  function reactionTitleKey(value){
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function currentItineraryDate(){
    if (typeof __state !== "undefined" && __state && __state.date) return __state.date;
    if (window.__DCC_STATE__ && window.__DCC_STATE__.date) return window.__DCC_STATE__.date;
    return new Date().toISOString().split("T")[0];
  }

  function updateReactionToggle(){
    const btn = document.getElementById("todo-reactions-toggle");
    if (!btn) return;
    btn.classList.remove("active");
    btn.removeAttribute("aria-pressed");
    btn.textContent = reactionsLoading ? "Refreshing..." : "Refresh reactions";
    btn.title = "Refresh guest reactions on itinerary tasks";
  }

  function taskIdentityKeys(task){
    if (!task) return [];
    const keys = [
      task.id,
      task.local_id,
      task.localId,
      task.task_id,
      task.taskId,
      task._blockId,
      task.blockId,
      task.block_id,
      task.meetingBlockId,
      task.triageId,
      task.sourceId,
      task.source_id,
      task.gcal_event_id,
      task.alertKey,
      task.responsibilityId
    ];
    return [...new Set(keys.map(key => String(key || "").trim()).filter(Boolean))];
  }

  function ensureModal(){
    let modal = document.getElementById("todo-share-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "todo-share-modal";
    modal.className = "todo-share-modal";
    modal.innerHTML =
      '<div class="todo-share-card">' +
        '<div class="todo-share-head">' +
          '<div><h2>Share Live To-Do List</h2><p>Guests can view an active list from the link and offer bounties or rewards.</p></div>' +
          '<button id="todo-share-close" class="todo-share-x" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="todo-share-linkbox">' +
          '<input id="todo-share-url" readonly placeholder="No share link enabled">' +
          '<button id="todo-share-enable" type="button">Enable</button>' +
          '<button id="todo-share-copy" type="button">Copy</button>' +
          '<button id="todo-share-rotate" type="button">Rotate</button>' +
        '</div>' +
        '<div class="todo-share-note">The link grants guest access to this shared view only. Private tasks stay hidden when their public visibility is set to private.</div>' +
        '<div class="todo-share-section">' +
          '<div class="todo-share-section-head"><h3>Sponsored Offers</h3><span id="todo-share-pending">0 pending</span></div>' +
          '<div id="todo-share-sponsorships" class="todo-share-sponsorships"></div>' +
        '</div>' +
        // Guest Activity: the answer to "what did people say today". The chips on
        // the itinerary rows only help once you know WHICH row to look at, which
        // is the thing the owner doesn't know.
        '<div class="todo-share-section">' +
          '<div class="todo-share-section-head"><h3>Guest Activity</h3>' +
            '<span id="todo-share-activity-count">0 new</span>' +
            '<button id="todo-share-activity-seen" class="todo-share-mark-read" type="button" hidden>Mark all read</button>' +
          '</div>' +
          '<div id="todo-share-activity" class="todo-share-activity"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
    modal.querySelector("#todo-share-close").addEventListener("click", closeModal);
    modal.querySelector("#todo-share-enable").addEventListener("click", enableShare);
    modal.querySelector("#todo-share-copy").addEventListener("click", copyShare);
    modal.querySelector("#todo-share-rotate").addEventListener("click", rotateShare);
    modal.querySelector("#todo-share-activity-seen").addEventListener("click", markActivitySeen);
    modal.addEventListener("click", e => {
      const btn = e.target.closest("[data-todo-sponsor-status]");
      if (!btn) return;
      updateSponsorshipStatus(btn.dataset.todoSponsorId, btn.dataset.todoSponsorStatus);
    });
    return modal;
  }

  function render(){
    const modal = ensureModal();
    const url = modal.querySelector("#todo-share-url");
    const enable = modal.querySelector("#todo-share-enable");
    const copy = modal.querySelector("#todo-share-copy");
    const rotate = modal.querySelector("#todo-share-rotate");
    if (url) url.value = share && share.shareUrl ? share.shareUrl : "";
    if (enable) enable.textContent = share ? "Enabled" : "Enable";
    if (copy) copy.disabled = !share;
    if (rotate) rotate.disabled = !share;

    const pending = sponsorships.filter(s => s.status === "pending").length;
    const pendingEl = modal.querySelector("#todo-share-pending");
    if (pendingEl) pendingEl.textContent = pending + " pending";
    const list = modal.querySelector("#todo-share-sponsorships");
    if (!list) return;
    if (!sponsorships.length) {
      list.innerHTML = '<div class="todo-share-empty">No guest offers yet.</div>';
      return;
    }
    list.innerHTML = sponsorships.map(s => {
      const amount = money(s.value_cents);
      return '<div class="todo-share-offer ' + esc(s.status) + '">' +
        '<div>' +
          '<strong>' + esc(s.reward_title) + (amount ? " " + esc(amount) : "") + '</strong>' +
          '<span>' + esc(s.kind) + ' for "' + esc(s.task_title) + '" from ' + esc(s.sponsor_name) + '</span>' +
          (s.note ? '<p>' + esc(s.note) + '</p>' : '') +
        '</div>' +
        '<div class="todo-share-offer-actions">' +
          '<em>' + esc(s.status) + '</em>' +
          (s.status === "pending" ? '<button data-todo-sponsor-id="' + s.id + '" data-todo-sponsor-status="approved">Approve</button>' : '') +
          (s.status !== "dismissed" ? '<button data-todo-sponsor-id="' + s.id + '" data-todo-sponsor-status="dismissed">' + (s.status === "pending" ? "Dismiss" : "Remove") + '</button>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function load(){
    const status = await api("/api/todo-share");
    share = status.share || null;
    sponsorships = await api("/api/todo-share/sponsorships");
    render();
    // Activity loads after the first render rather than blocking it: the link
    // box and the offers are what the modal is opened for, and a slow inbox
    // query should not hold them back.
    //
    // A failure here is NOT the same as the silent one on page load. There, the
    // only casualty is a missing badge. Here the modal is OPEN and this panel is
    // what the owner came to read, and `loadActivity` assigns before it renders,
    // so a 500 left the panel blank under a header reading "0 new" -- identical
    // to a genuinely quiet day, which is the one thing this feature exists to
    // rule out. Draw whatever the page-load fetch already got, and say so when
    // there is nothing to draw.
    loadActivity().catch(() => {
      renderActivity();
      const el = document.getElementById("todo-share-activity");
      if (el && !el.innerHTML) {
        el.innerHTML = '<div class="todo-share-empty">Could not load guest activity. Close and reopen to retry.</div>';
      }
    });
  }

  // ── Guest activity inbox ───────────────────────────────────────────────────
  function activityIcon(item){
    if (item.kind === "reaction") return item.emoji || "✦";
    if (item.kind === "sponsorship") return "🎁";
    return "💬";
  }

  function activityLine(item){
    const task = item.taskTitle ? esc(item.taskTitle) : "a task";
    if (item.kind === "reaction") return "reacted to <b>" + task + "</b>";
    if (item.kind === "sponsorship") {
      const amount = money(item.valueCents);
      return "offered <b>" + esc(item.rewardTitle || "a reward") + "</b>"
        + (amount ? " (" + esc(amount) + ")" : "") + " on <b>" + task + "</b>";
    }
    return "commented on <b>" + task + "</b>";
  }

  function renderActivity(){
    const modal = document.getElementById("todo-share-modal");
    if (!modal) return;
    const list = modal.querySelector("#todo-share-activity");
    const count = modal.querySelector("#todo-share-activity-count");
    const markBtn = modal.querySelector("#todo-share-activity-seen");
    if (!list) return;

    const unread = activity.unreadCount || 0;
    if (count) count.textContent = unread ? unread + " new" : "All caught up";
    if (markBtn) markBtn.hidden = !unread;

    const items = activity.items || [];
    if (!items.length) {
      list.innerHTML = '<div class="todo-share-empty">Nobody has reacted, commented, or offered anything yet.</div>';
      return;
    }
    const seenAt = activity.seenAt ? new Date(activity.seenAt) : null;
    list.innerHTML = items.map(item => {
      const isNew = !seenAt || new Date(item.at) > seenAt;
      return '<div class="todo-share-activity-item' + (isNew ? " unread" : "") + '">' +
        '<span class="todo-share-activity-icon">' + esc(activityIcon(item)) + '</span>' +
        '<div class="todo-share-activity-body">' +
          '<div class="todo-share-activity-head"><b>' + esc(item.actorName || "Someone") + '</b> ' +
            activityLine(item) +
            '<span class="todo-share-activity-when">' + esc(relTime(item.at)) + '</span>' +
          '</div>' +
          (item.body ? '<p>' + esc(item.body) + '</p>' : '') +
          (item.note ? '<p>' + esc(item.note) + '</p>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function loadActivity(){
    activity = await api("/api/todo-share/activity");
    renderActivity();
    updateActivityBadge();
  }

  // The badge rides the existing "Share list" header button, so a comment left
  // while the modal is closed is still visible without opening anything.
  function updateActivityBadge(){
    const btn = document.getElementById("todo-share-open");
    if (!btn) return;
    const unread = (activity && activity.unreadCount) || 0;
    let dot = btn.querySelector(".todo-share-badge");
    if (!unread) { if (dot) dot.remove(); return; }
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "todo-share-badge";
      btn.appendChild(dot);
    }
    dot.textContent = unread > 9 ? "9+" : String(unread);
    btn.title = unread + " new guest " + (unread === 1 ? "item" : "items");
  }

  async function markActivitySeen(){
    // Stamp the newest item the list actually RENDERED. Using "now" would mark
    // an item that arrived between the read and the click as seen.
    const seenAt = activity.latestAt;
    if (!seenAt) return;
    try {
      const result = await api("/api/todo-share/activity/seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenAt })
      });
      activity.seenAt = (result && result.seenAt) || seenAt;
      activity.unreadCount = 0;
      renderActivity();
      updateActivityBadge();
    } catch (e) { toast("Could not mark those read", "error"); }
  }

  async function loadReactions(date, options){
    const targetDate = date || currentItineraryDate();
    const force = !!(options && options.force);
    if (!force && reactionsDate === targetDate) return taskReactions;
    if (!force && reactionsLoading && reactionsLoading.date === targetDate) return reactionsLoading.promise;
    const promise = (async () => {
      updateReactionToggle();
      const data = await api("/api/todo-share/reactions?date=" + encodeURIComponent(targetDate));
      taskReactions = data.reactions || {};
      taskReactionsByTitle = {};
      const seen = new Set();
      Object.values(taskReactions).forEach(reaction => {
        if (!reaction || seen.has(reaction)) return;
        seen.add(reaction);
        if (reaction.legacy) {
          const key = reactionTitleKey(reaction && reaction.taskTitle);
          if (key && !taskReactionsByTitle[key]) taskReactionsByTitle[key] = reaction;
        }
        (reaction.identityIds || []).forEach(id => {
          const normalized = String(id || "").trim();
          if (normalized && !taskReactions[normalized]) taskReactions[normalized] = reaction;
        });
      });
      reactionsDate = targetDate;
      if (typeof window.render === "function") window.render();
      return taskReactions;
    })();
    reactionsLoading = { date: targetDate, promise };
    try {
      return await promise;
    } finally {
      if (reactionsLoading && reactionsLoading.promise === promise) reactionsLoading = null;
      updateReactionToggle();
    }
  }

  async function loadComments(date, options){
    const targetDate = date || currentItineraryDate();
    const force = !!(options && options.force);
    if (!force && commentsDate === targetDate) return taskComments;
    if (!force && commentsLoading && commentsLoading.date === targetDate) return commentsLoading.promise;
    const promise = (async () => {
      const data = await api("/api/todo-share/comments?date=" + encodeURIComponent(targetDate));
      taskComments = data.comments || {};
      taskCommentsByTitle = {};
      const seen = new Set();
      Object.values(taskComments).forEach(comment => {
        if (!comment || seen.has(comment)) return;
        seen.add(comment);
        if (comment.legacy) {
          const key = reactionTitleKey(comment && comment.taskTitle);
          if (key && !taskCommentsByTitle[key]) taskCommentsByTitle[key] = comment;
        }
        (comment.identityIds || []).forEach(id => {
          const normalized = String(id || "").trim();
          if (normalized && !taskComments[normalized]) taskComments[normalized] = comment;
        });
      });
      commentsDate = targetDate;
      if (typeof window.render === "function") window.render();
      return taskComments;
    })();
    commentsLoading = { date: targetDate, promise };
    try {
      return await promise;
    } finally {
      if (commentsLoading && commentsLoading.promise === promise) commentsLoading = null;
    }
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

  async function refreshItineraryReactions(){
    try {
      await Promise.all([
        loadReactions(currentItineraryDate(), { force: true }),
        loadComments(currentItineraryDate(), { force: true })
      ]);
      toast("Guest feedback refreshed");
    } catch (e) { toast(e.message, "error"); }
  }

  function ensureReactionsForDate(date){
    const target = date || currentItineraryDate();
    loadReactions(target).catch(() => {});
    loadComments(target).catch(() => {});
  }

  function resolveTaskComments(task){
    const keys = taskIdentityKeys(task);
    let comment = keys.map(key => taskComments[key]).find(Boolean);
    if (!comment) comment = taskCommentsByTitle[reactionTitleKey(task.title || task.label)];
    return comment && comment.items ? comment.items : [];
  }

  // Combined feedback bubble: guest reactions + comments behind one chip in the
  // top-right corner. Collapsed count is reactions + comments; expanding shows
  // reaction chips and the comment list together.
  function reactionChipsHtml(task){
    if (!task) return "";
    const keys = taskIdentityKeys(task);
    let reaction = keys.map(key => taskReactions[key]).find(Boolean);
    if (!reaction) reaction = taskReactionsByTitle[reactionTitleKey(task.title || task.label)];
    const counts = reaction && reaction.counts ? reaction.counts : {};
    const entries = reactionOrder
      .map(emoji => ({ emoji, count: Number(counts[emoji]) || 0 }))
      .filter(entry => entry.count > 0);
    const comments = resolveTaskComments(task);
    const reactionTotal = entries.reduce((sum, entry) => sum + entry.count, 0);
    const combinedTotal = reactionTotal + comments.length;
    if (!combinedTotal) return "";
    const stack = entries.length
      ? entries.slice(0, 3)
          .map((entry, index) => '<span class="itinerary-reaction-face" style="z-index:' + (4 - index) + '">' + esc(entry.emoji) + '</span>')
          .join("") + (entries.length > 3 ? '<span class="itinerary-reaction-more">+' + esc(entries.length - 3) + '</span>' : "")
      : '<span class="itinerary-reaction-face itinerary-feedback-comment-face">&#128172;</span>';
    const chips = entries
      .map(entry => '<span class="itinerary-reaction-chip"><span>' + esc(entry.emoji) + '</span><b>' + esc(entry.count) + '</b></span>')
      .join("");
    const commentList = comments.length
      ? '<div class="itinerary-comment-list" role="list">' + comments.map(c =>
          '<div class="itinerary-comment" role="listitem">' +
            '<div class="itinerary-comment-head"><span class="itinerary-comment-author">' + esc(c.authorName || "Guest") + '</span><span class="itinerary-comment-time">' + esc(relTime(c.createdAt)) + '</span></div>' +
            '<div class="itinerary-comment-body">' + esc(c.body || "") + '</div>' +
          '</div>'
        ).join("") + '</div>'
      : "";
    return '<div class="itinerary-reactions" aria-label="Guest reactions and comments">' +
      '<button class="itinerary-reactions-toggle" type="button" aria-expanded="false" title="Show guest reactions and comments">' +
        '<span class="itinerary-reaction-stack">' + stack + '</span>' +
        '<b class="itinerary-reaction-total">' + esc(combinedTotal) + '</b>' +
      '</button>' +
      '<div class="itinerary-reaction-tray" role="list">' +
        (chips ? '<div class="itinerary-reaction-chips">' + chips + '</div>' : "") +
        commentList +
      '</div>' +
    '</div>';
  }

  // Always-visible compact feedback card for completed tasks, shown in the dead
  // space beside the one-line row (reactions stay glanceable after a task is done).
  function compactFeedbackHtml(task){
    if (!task) return "";
    const keys = taskIdentityKeys(task);
    let reaction = keys.map(key => taskReactions[key]).find(Boolean);
    if (!reaction) reaction = taskReactionsByTitle[reactionTitleKey(task.title || task.label)];
    const counts = reaction && reaction.counts ? reaction.counts : {};
    const entries = reactionOrder
      .map(emoji => ({ emoji, count: Number(counts[emoji]) || 0 }))
      .filter(entry => entry.count > 0);
    const comments = resolveTaskComments(task);
    if (!entries.length && !comments.length) return "";
    const chips = entries
      .map(entry => '<span class="itinerary-feedback-chip"><span>' + esc(entry.emoji) + '</span><b>' + esc(entry.count) + '</b></span>')
      .join("");
    const commentChip = comments.length
      ? '<span class="itinerary-feedback-chip" title="' + esc((comments[comments.length - 1].authorName || "Guest") + ': ' + (comments[comments.length - 1].body || "")) + '">&#128172;<b>' + esc(comments.length) + '</b></span>'
      : "";
    return '<div class="itinerary-feedback-card" title="Guest reactions and comments">' + chips + commentChip + '</div>';
  }

  function toggleReactionTray(event){
    const btn = event.target.closest(".itinerary-reactions-toggle");
    if (!btn) {
      if (!event.target.closest(".itinerary-reactions")) {
        document.querySelectorAll(".itinerary-reactions.expanded").forEach(el => {
          el.classList.remove("expanded");
          const toggle = el.querySelector(".itinerary-reactions-toggle");
          if (toggle) toggle.setAttribute("aria-expanded", "false");
        });
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const wrap = btn.closest(".itinerary-reactions");
    if (!wrap) return;
    const next = !wrap.classList.contains("expanded");
    document.querySelectorAll(".itinerary-reactions.expanded").forEach(el => {
      if (el === wrap) return;
      el.classList.remove("expanded");
      const toggle = el.querySelector(".itinerary-reactions-toggle");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
    wrap.classList.toggle("expanded", next);
    btn.setAttribute("aria-expanded", next ? "true" : "false");
  }

  async function enableShare(){
    try {
      const result = await api("/api/todo-share", { method: "POST" });
      share = result.share;
      await load();
      toast("Live share link enabled");
    } catch (e) { toast(e.message, "error"); }
  }

  async function rotateShare(){
    if (!share) return;
    if (!confirm("Rotate this link? The old guest link will stop working.")) return;
    try {
      const result = await api("/api/todo-share/rotate", { method: "POST" });
      share = result.share;
      render();
      toast("Share link rotated");
    } catch (e) { toast(e.message, "error"); }
  }

  async function copyShare(){
    if (!share || !share.shareUrl) return;
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      toast("Share link copied");
    } catch (e) {
      const input = document.getElementById("todo-share-url");
      if (input) input.select();
      toast("Copy failed. The link is selected.", "error");
    }
  }

  async function updateSponsorshipStatus(id, status){
    try {
      await api("/api/todo-share/sponsorships/" + encodeURIComponent(id) + "/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      await load();
      toast(status === "approved" ? "Offer approved" : "Offer dismissed");
    } catch (e) { toast(e.message, "error"); }
  }

  function openModal(){
    ensureModal().classList.add("open");
    load().catch(e => toast(e.message, "error"));
  }

  function closeModal(){
    const modal = document.getElementById("todo-share-modal");
    if (modal) modal.classList.remove("open");
  }

  document.addEventListener("DOMContentLoaded", () => {
    updateReactionToggle();
    document.addEventListener("click", toggleReactionTray, true);
    const reactionsBtn = document.getElementById("todo-reactions-toggle");
    if (reactionsBtn) reactionsBtn.addEventListener("click", refreshItineraryReactions);
    const btn = document.getElementById("todo-share-open");
    if (btn) btn.addEventListener("click", openModal);
    ensureReactionsForDate(currentItineraryDate());
    // Badge on load, without opening the modal: a guest comment left overnight
    // should be visible from the header the moment the page comes up. Silent on
    // failure — an unreachable inbox must not break the dashboard boot.
    loadActivity().catch(() => {});
  });

  window.openTodoShareModal = openModal;
  window.todoShareReactionChipsHtml = reactionChipsHtml;
  window.todoShareCompactFeedbackHtml = compactFeedbackHtml;
  window.todoShareReactionsVisible = () => true;
  window.ensureTodoShareReactionsForDate = ensureReactionsForDate;
  window.toggleTodoShareReactions = refreshItineraryReactions;
  window.reloadTodoShareReactions = (date) => Promise.all([
    loadReactions(date || currentItineraryDate(), { force: true }),
    loadComments(date || currentItineraryDate(), { force: true })
  ]);
})();
