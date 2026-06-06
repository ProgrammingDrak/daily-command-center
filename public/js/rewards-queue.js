// Rewards queue — earned rewards rendered as a Task Menu section in the
// Repeat-Responsibilities card style. Each reward is one-time: hit the green
// "+" and it's burned (redeemed once), then it drops off the unburned list.
// Source of truth is the relational reward queue (/api/social/rewards/queue);
// this is purely a view + the burn/remove actions over it.
(function () {
  "use strict";

  let _items = [];
  let _filter = "active";              // active (unburned) | redeemed (burned) | all
  const _expanded = new Set();

  function esc(s) {
    if (typeof window.escHtml === "function") return window.escHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, kind) { if (typeof window.showToast === "function") window.showToast(msg, kind); }

  function fmtDate(v) { return v ? String(v).slice(0, 10) : ""; }
  function money(cents) {
    const n = Number(cents || 0);
    return n ? "$" + (n / 100).toFixed(2) : "";
  }
  function sourceLabel(q) {
    if (q.sponsor_user_id) return "sponsored";
    const t = q.source_type || "";
    if (t === "slot_spin") return "from a spin";
    if (t === "sponsor_task") return "sponsored task";
    if (t === "task_completion") return "task reward";
    if (t === "self_care") return "self-care";
    if (t === "manual_self_reward") return "self-awarded";
    return t ? t.replace(/_/g, " ") : "earned";
  }

  const isActive = q => q.status === "queued" || q.status === "claimed";

  function filterItems(items) {
    if (_filter === "active") return items.filter(isActive);
    if (_filter === "redeemed") return items.filter(q => q.status === "redeemed");
    return items.filter(q => q.status !== "dismissed" && q.status !== "expired");
  }

  async function loadRewardsQueue() {
    try {
      const res = await fetch("/api/social/rewards/queue");
      if (!res.ok) throw new Error(res.statusText);
      _items = await res.json();
    } catch (e) {
      _items = [];
    }
    renderRewardsQueue();
    return _items;
  }

  function renderRewardsQueue() {
    const mount = document.getElementById("rewards-queue-list");
    if (!mount) return;

    // Count badge tracks unburned (active) rewards.
    const activeCount = _items.filter(isActive).length;
    const badge = document.getElementById("rewards-section-count");
    if (badge) {
      badge.textContent = activeCount;
      badge.style.display = activeCount > 0 ? "" : "none";
    }

    const list = filterItems(_items);
    if (!list.length) {
      const msg = _filter === "redeemed" ? "No burned rewards yet."
        : _filter === "all" ? "No rewards yet."
        : "No rewards to burn. Win one at the slot machine.";
      mount.innerHTML = '<div class="delegated-empty">' + msg + "</div>";
      return;
    }

    mount.innerHTML = list.map(q => {
      const expanded = _expanded.has(String(q.id));
      const active = isActive(q);
      const val = money(q.value_snapshot);
      const left = active
        ? '<button type="button" class="repeat-resp-score resp-score resp-score-plus reward-q-burn" data-act="burn" title="Burn this reward (redeem)" aria-label="Burn ' + esc(q.title_snapshot || "reward") + '">+</button>'
        : '<span class="repeat-resp-score resp-score reward-q-done" title="' + esc(q.status) + '" aria-hidden="true">✓</span>';
      return '<div class="repeat-resp-card reward-q-card' + (expanded ? " expanded" : "") + (active ? "" : " reward-q-burned") + '" data-id="' + esc(q.id) + '">' +
        left +
        '<div class="repeat-resp-main" role="button" tabindex="0" data-act="toggle" aria-expanded="' + (expanded ? "true" : "false") + '">' +
          '<div class="repeat-resp-title-row">' +
            '<div class="repeat-resp-title">' + esc(q.title_snapshot || "Reward") + "</div>" +
          "</div>" +
          (expanded
            ? '<div class="repeat-resp-details">' +
                '<div class="repeat-resp-meta">' +
                  "<span>" + esc(sourceLabel(q)) + "</span>" +
                  "<span>won " + esc(fmtDate(q.won_date || q.won_at)) + "</span>" +
                  (val ? "<span>" + esc(val) + "</span>" : "") +
                  (q.redeemed_date ? "<span>burned " + esc(fmtDate(q.redeemed_date)) + "</span>" : "") +
                "</div>" +
              "</div>"
            : "") +
        "</div>" +
        '<div class="repeat-resp-actions">' +
          (active ? '<button type="button" data-act="burn">Burn</button>' : "") +
          (expanded && active ? '<button type="button" class="danger" data-act="remove">Remove</button>' : "") +
        "</div>" +
      "</div>";
    }).join("");

    mount.querySelectorAll(".reward-q-card [data-act]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const card = btn.closest(".reward-q-card");
        const id = card && card.dataset.id;
        if (!id) return;
        const act = btn.dataset.act;
        if (act === "toggle") {
          if (_expanded.has(id)) _expanded.delete(id); else _expanded.add(id);
          renderRewardsQueue();
          return;
        }
        handleAction(id, act);
      });
      if (btn.dataset.act === "toggle") {
        btn.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); btn.click(); }
        });
      }
    });
  }

  async function handleAction(id, act) {
    const item = _items.find(i => String(i.id) === String(id));
    if (!item) return;
    try {
      if (act === "burn") {
        const res = await fetch("/api/social/rewards/queue/" + encodeURIComponent(id) + "/redeem", { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        toast("Burned: " + (item.title_snapshot || "reward"), "success");
        await loadRewardsQueue();
      } else if (act === "remove") {
        const res = await fetch("/api/social/rewards/queue/" + encodeURIComponent(id) + "/discard", { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        await loadRewardsQueue();
      }
    } catch (e) {
      toast("Reward action failed: " + (e.message || e), "error");
    }
  }

  function bind() {
    const filter = document.getElementById("rewards-queue-filter");
    if (filter) filter.addEventListener("change", () => { _filter = filter.value || "active"; renderRewardsQueue(); });
    // A fresh slot win (or any reward change) broadcasts slot-changed over SSE.
    document.addEventListener("slot-changed", () => { loadRewardsQueue(); });
    loadRewardsQueue();
  }

  document.addEventListener("DOMContentLoaded", bind);
  window.loadRewardsQueue = loadRewardsQueue;
  window.renderRewardsQueue = renderRewardsQueue;
})();
