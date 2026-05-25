(function(){
  let share = null;
  let sponsorships = [];

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
    const btn = document.getElementById("todo-share-open");
    if (btn) btn.addEventListener("click", openModal);
  });

  window.openTodoShareModal = openModal;
})();
