// Rewards queue — earned rewards rendered as a Task Menu section in the
// Repeat-Responsibilities card style. Scheduling a reward places it on the
// itinerary as a task (status -> "scheduled") and removes it from the to-do
// list; the real redeem ("burn") happens when that itinerary task is done.
// A scheduled reward can't be scheduled again (no double-booking) but its time
// can be changed. Source of truth is /api/social/rewards/queue; this is a view
// plus the schedule/reschedule/remove actions over it.
(function () {
  "use strict";

  const REWARD_TASK_MINUTES = 15;
  let _items = [];
  let _filter = "active";              // active (to-do + scheduled) | redeemed (done) | all
  const _expanded = new Set();

  function esc(s) {
    if (typeof window.escHtml === "function") return window.escHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, kind) { if (typeof window.showToast === "function") window.showToast(msg, kind); }

  function fmtDate(v) { return v ? String(v).slice(0, 10) : ""; }
  function fmtDateTime(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return fmtDate(v);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return sameDay ? time : (fmtDate(v) + " " + time);
  }
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

  const isSchedulable = q => q.status === "queued" || q.status === "claimed";
  const isScheduled = q => q.status === "scheduled";
  const isActive = q => isSchedulable(q) || isScheduled(q);

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

    // Badge tracks rewards still needing action (to-do + scheduled, not yet done).
    const activeCount = _items.filter(isActive).length;
    const badge = document.getElementById("rewards-section-count");
    if (badge) {
      badge.textContent = activeCount;
      badge.style.display = activeCount > 0 ? "" : "none";
    }

    const list = filterItems(_items);
    if (!list.length) {
      const msg = _filter === "redeemed" ? "No used rewards yet."
        : _filter === "all" ? "No rewards yet."
        : "No rewards to schedule. Win one at the slot machine.";
      mount.innerHTML = '<div class="delegated-empty">' + msg + "</div>";
      return;
    }

    mount.innerHTML = list.map(q => {
      const expanded = _expanded.has(String(q.id));
      const schedulable = isSchedulable(q);
      const scheduled = isScheduled(q);
      const val = money(q.value_snapshot);
      // Left circle: schedulable -> a clickable "schedule" button; scheduled ->
      // a greyed, non-clickable marker (can't double-book); done -> a check.
      const left = schedulable
        ? '<button type="button" class="repeat-resp-score resp-score reward-q-schedule" data-act="schedule" title="Schedule this reward" aria-label="Schedule ' + esc(q.title_snapshot || "reward") + '">🗓</button>'
        : scheduled
          ? '<span class="repeat-resp-score resp-score reward-q-parked" title="Scheduled — use Change time to move it" aria-hidden="true">🗓</span>'
          : '<span class="repeat-resp-score resp-score reward-q-done" title="' + esc(q.status) + '" aria-hidden="true">✓</span>';
      const cardCls = "repeat-resp-card reward-q-card" + (expanded ? " expanded" : "") +
        (scheduled ? " reward-q-scheduled" : "") + (!schedulable && !scheduled ? " reward-q-burned" : "");
      const actions = schedulable
        ? '<button type="button" data-act="schedule">Schedule</button>' +
          (expanded ? '<button type="button" class="danger" data-act="remove">Remove</button>' : "")
        : scheduled
          ? '<button type="button" data-act="reschedule">Change time</button>' +
            (expanded ? '<button type="button" class="danger" data-act="remove">Remove</button>' : "")
          : "";
      return '<div class="' + cardCls + '" data-id="' + esc(q.id) + '">' +
        left +
        '<div class="repeat-resp-main" role="button" tabindex="0" data-act="toggle" aria-expanded="' + (expanded ? "true" : "false") + '">' +
          '<div class="repeat-resp-title-row">' +
            '<div class="repeat-resp-title">' + esc(q.title_snapshot || "Reward") + "</div>" +
            (scheduled && q.scheduled_for ? '<span class="reward-q-sched-pill">🗓 ' + esc(fmtDateTime(q.scheduled_for)) + "</span>" : "") +
          "</div>" +
          (expanded
            ? '<div class="repeat-resp-details">' +
                '<div class="repeat-resp-meta">' +
                  "<span>" + esc(sourceLabel(q)) + "</span>" +
                  "<span>won " + esc(fmtDate(q.won_date || q.won_at)) + "</span>" +
                  (val ? "<span>" + esc(val) + "</span>" : "") +
                  (scheduled && q.scheduled_for ? "<span>scheduled for " + esc(fmtDateTime(q.scheduled_for)) + "</span>" : "") +
                  (q.redeemed_date ? "<span>used " + esc(fmtDate(q.redeemed_date)) + "</span>" : "") +
                "</div>" +
              "</div>"
            : "") +
        "</div>" +
        '<div class="repeat-resp-actions">' + actions + "</div>" +
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

  // Remove an itinerary task that was placed for a reward (best-effort).
  async function removeItineraryTask(blockId, dateStr) {
    if (blockId && typeof window.unscheduleTaskFromDate === "function") {
      try { await window.unscheduleTaskFromDate(blockId, dateStr); } catch (e) { /* non-fatal */ }
    }
  }

  // Canonical itinerary task for a reward. SINGLE source so every scheduler (this
  // queue tab AND the post-win decision modal in slots.js) places an IDENTICAL
  // task: 🎁 title, the reward's real duration (snapshotted at win time; falls
  // back to the default block for legacy rows that predate the column), High
  // priority. tags/source let the completion hook burn the reward.
  function buildRewardTask(item) {
    const title = (item && (item.title_snapshot || item.title)) || "Reward";
    const realMins = Math.max(0, parseInt(item && (item.duration_minutes_snapshot ?? item.duration_minutes), 10) || 0);
    return {
      title: "🎁 " + title,
      minutes: realMins || REWARD_TASK_MINUTES,
      options: { source: "reward", tags: ["reward"], meta: "Reward · enjoy it", priority: "High" },
    };
  }

  // Open the standard schedule picker, place a reward task on the itinerary, and
  // park it on the queue row (status -> scheduled). On a fresh schedule, offer
  // Undo. On reschedule, remove the previous itinerary task so it isn't doubled.
  function scheduleFlow(item, isReschedule) {
    const id = item.id;
    const title = item.title_snapshot || "Reward";
    if (typeof window.openSchedulePicker !== "function") { toast("Scheduler is unavailable here", "error"); return; }
    const oldBlockId = item.scheduled_block_id || null;
    const oldDate = item.scheduled_for ? String(item.scheduled_for).slice(0, 10) : null;
    const task = buildRewardTask(item);
    window.openSchedulePicker(task.title, task.minutes, Object.assign({}, task.options, {
      onScheduled: async (info) => {
        info = info || {};
        const dateStr = info.dateStr || new Date().toISOString().slice(0, 10);
        const scheduledFor = info.start ? (dateStr + "T" + info.start) : null;
        try {
          const r = await fetch("/api/social/rewards/queue/" + encodeURIComponent(id) + "/schedule", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledFor, blockId: info.blockId })
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
          if (isReschedule && oldBlockId) await removeItineraryTask(oldBlockId, oldDate);
          await loadRewardsQueue();
          if (isReschedule) {
            toast("Moved “" + title + "” to " + fmtDateTime(scheduledFor), "success");
          } else if (typeof window.showToast === "function") {
            window.showToast("Scheduled “" + title + "”", "success", 7000, {
              label: "Undo",
              onClick: async () => {
                try {
                  await removeItineraryTask(info.blockId, dateStr);
                  await fetch("/api/social/rewards/queue/" + encodeURIComponent(id) + "/unschedule", { method: "POST" });
                  await loadRewardsQueue();
                  toast("Schedule undone — “" + title + "” is back in your rewards", "success");
                } catch (e) { toast("Undo failed: " + (e.message || e), "error"); }
              }
            });
          }
        } catch (e) { toast("Could not schedule: " + (e.message || e), "error"); }
      }
    }));
  }

  async function handleAction(id, act) {
    const item = _items.find(i => String(i.id) === String(id));
    if (!item) return;
    try {
      if (act === "schedule") {
        scheduleFlow(item, false);
      } else if (act === "reschedule") {
        scheduleFlow(item, true);
      } else if (act === "remove") {
        if (isScheduled(item)) {
          await removeItineraryTask(item.scheduled_block_id, item.scheduled_for ? String(item.scheduled_for).slice(0, 10) : null);
        }
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
  // Single scheduling entry point, used by the post-win decision modal in
  // slots.js so reward scheduling lives in exactly one place (this queue owner).
  //   scheduleRewardQueueItem(queueItem, { reschedule })
  window.scheduleRewardQueueItem = (item, opts) => { if (item) scheduleFlow(item, !!(opts && opts.reschedule)); };
})();
