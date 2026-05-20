(function(){
  let share = null;
  let sponsorships = [];
  let taskReactions = {};
  let taskReactionsByTitle = {};
  const reactionOrder = ["👍", "🙌", "🔥", "💪", "🎉", "❤️"];
  let reactionsDate = "";
  let reactionsLoading = null;

  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[ch]));
  }

  function money(cents){
    const n = Number(cents) || 0;
    if (!n) return "";
    return "$" + (n / 100).toFixed(n % 100 ? 2 : 0);
  }

  async function api(path, options){
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Todo share request failed");
    return data;
  }

  function toast(message, type){
    if (typeof showToast === "function") showToast(message, type || "success", 2600);
  }

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
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
    modal.querySelector("#todo-share-close").addEventListener("click", closeModal);
    modal.querySelector("#todo-share-enable").addEventListener("click", enableShare);
    modal.querySelector("#todo-share-copy").addEventListener("click", copyShare);
    modal.querySelector("#todo-share-rotate").addEventListener("click", rotateShare);
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
          (s.status === "pending" ? '<button data-todo-sponsor-id="' + s.id + '" data-todo-sponsor-status="approved">Approve</button><button data-todo-sponsor-id="' + s.id + '" data-todo-sponsor-status="dismissed">Dismiss</button>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function load(){
    const status = await api("/api/todo-share");
    share = status.share || null;
    sponsorships = await api("/api/todo-share/sponsorships");
    render();
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

  async function refreshItineraryReactions(){
    try {
      await loadReactions(currentItineraryDate(), { force: true });
      toast("Guest reactions refreshed");
    } catch (e) { toast(e.message, "error"); }
  }

  function ensureReactionsForDate(date){
    loadReactions(date || currentItineraryDate()).catch(() => {});
  }

  function reactionChipsHtml(task){
    if (!task) return "";
    const keys = taskIdentityKeys(task);
    let reaction = keys.map(key => taskReactions[key]).find(Boolean);
    if (!reaction) reaction = taskReactionsByTitle[reactionTitleKey(task.title || task.label)];
    const counts = reaction && reaction.counts ? reaction.counts : {};
    const entries = reactionOrder
      .map(emoji => ({ emoji, count: Number(counts[emoji]) || 0 }))
      .filter(entry => entry.count > 0);
    if (!entries.length) return "";
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const stack = entries.slice(0, 3)
      .map((entry, index) => '<span class="itinerary-reaction-face" style="z-index:' + (4 - index) + '">' + esc(entry.emoji) + '</span>')
      .join("") + (entries.length > 3 ? '<span class="itinerary-reaction-more">+' + esc(entries.length - 3) + '</span>' : "");
    const chips = entries
      .map(entry => '<span class="itinerary-reaction-chip"><span>' + esc(entry.emoji) + '</span><b>' + esc(entry.count) + '</b></span>')
      .join("");
    return '<div class="itinerary-reactions" aria-label="Guest reactions">' +
      '<button class="itinerary-reactions-toggle" type="button" aria-expanded="false" title="Show guest reactions">' +
        '<span class="itinerary-reaction-stack">' + stack + '</span>' +
        '<b class="itinerary-reaction-total">' + esc(total) + '</b>' +
      '</button>' +
      '<div class="itinerary-reaction-tray" role="list">' + chips + '</div>' +
    '</div>';
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
  });

  window.openTodoShareModal = openModal;
  window.todoShareReactionChipsHtml = reactionChipsHtml;
  window.todoShareReactionsVisible = () => true;
  window.ensureTodoShareReactionsForDate = ensureReactionsForDate;
  window.toggleTodoShareReactions = refreshItineraryReactions;
  window.reloadTodoShareReactions = (date) => loadReactions(date || currentItineraryDate(), { force: true });
})();
