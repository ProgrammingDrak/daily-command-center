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
  const _busy = new Set();

  function esc(s) { return escHtml(s); } // shared escaper in tag-manager.js
  function toast(msg, kind) { return window.DCC.toast(msg, kind); } // delegates to core.js

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
    return fmtMoney(cents, { blankZero: true }); // shared formatter in state.js
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
      const busy = _busy.has(String(q.id));
      const val = money(q.value_snapshot);
      // Left circle: schedulable -> a clickable "schedule" button; scheduled ->
      // a greyed, non-clickable marker (can't double-book); done -> a check.
      const left = schedulable
        ? '<button type="button" class="repeat-resp-score resp-score reward-q-schedule" data-act="schedule" title="Schedule this reward" aria-label="Schedule ' + esc(q.title_snapshot || "reward") + '"' + (busy ? " disabled" : "") + '>🗓</button>'
        : scheduled
          ? '<span class="repeat-resp-score resp-score reward-q-parked" title="Scheduled — use Change time to move it" aria-hidden="true">🗓</span>'
          : '<span class="repeat-resp-score resp-score reward-q-done" title="' + esc(q.status) + '" aria-hidden="true">✓</span>';
      const cardCls = "repeat-resp-card reward-q-card" + (expanded ? " expanded" : "") +
        (scheduled ? " reward-q-scheduled" : "") + (!schedulable && !scheduled ? " reward-q-burned" : "") +
        (busy ? " reward-q-busy" : "");
      const doneAction = '<button type="button" data-act="done"' + (busy ? " disabled" : "") + '>' + (busy ? "Logging…" : "Done") + "</button>";
      const actions = schedulable
        ? doneAction +
          '<button type="button" data-act="schedule"' + (busy ? " disabled" : "") + '>Schedule</button>' +
          (expanded ? '<button type="button" class="danger" data-act="remove"' + (busy ? " disabled" : "") + '>Remove</button>' : "")
        : scheduled
          ? doneAction +
            '<button type="button" data-act="reschedule"' + (busy ? " disabled" : "") + '>Change time</button>' +
            (expanded ? '<button type="button" class="danger" data-act="remove"' + (busy ? " disabled" : "") + '>Remove</button>' : "")
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

  // Delete the durable row and its optimistic itinerary entry. New quick-adds
  // provide their row id directly; older queue rows only retain local_id, so
  // those are resolved against the date before deletion.
  async function removeItineraryTask(localId, dateStr, rowId) {
    if (!localId || !window.blockStore || typeof window.blockStore.deleteBlock !== "function") {
      throw new Error("The itinerary task could not be removed");
    }
    let durableId = rowId || null;
    if (!durableId) {
      // Legacy untimed scheduled rewards have a block id but no scheduled_for,
      // so fall back to the existing type query and resolve by local_id.
      const query = dateStr ? ("date=" + encodeURIComponent(dateStr)) : "type=block";
      const res = await fetch("/api/blocks?" + query);
      if (!res.ok) throw new Error(res.statusText || "The itinerary could not be checked");
      const rows = await res.json();
      const match = Array.isArray(rows) && rows.find(block => block && !block.deleted_at &&
        (String(block.id) === String(localId) || (block.properties && String(block.properties.local_id) === String(localId))));
      durableId = match && match.id;
    }
    if (durableId) await window.blockStore.deleteBlock(durableId);
    if (typeof scheduled !== "undefined" && Array.isArray(scheduled)) {
      const index = scheduled.findIndex(ev => ev && String(ev.id) === String(localId));
      if (index >= 0) scheduled.splice(index, 1);
      if (typeof recalcTimes === "function") recalcTimes();
      if (typeof render === "function") render();
    }
    return true;
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

  function actualTodayStr() {
    if (typeof _actualTodayStr === "function") return _actualTodayStr();
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function currentItineraryDate() {
    if (typeof viewDate !== "undefined" && viewDate) return viewDate;
    if (window.blockStore && typeof window.blockStore.getCurrentDate === "function") return window.blockStore.getCurrentDate();
    return (typeof __state !== "undefined" && __state && __state.date) || null;
  }

  function loadedTask(blockId) {
    if (!blockId || typeof scheduled === "undefined" || !Array.isArray(scheduled)) return null;
    return scheduled.find(ev => ev && String(ev.id) === String(blockId)) || null;
  }

  function taskIsDone(ev) {
    if (!ev) return false;
    if (typeof isDone === "function") return !!isDone(ev);
    return ev.done === true || ev.status === "done" || !!ev.completedAt;
  }

  async function linkRewardToBlock(item, info, today) {
    const scheduledFor = info.start ? (today + "T" + info.start) : null;
    const res = await fetch("/api/social/rewards/queue/" + encodeURIComponent(item.id) + "/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledFor, blockId: info.blockId, expectedBlockId: item.scheduled_block_id || null })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || res.statusText);
    if (!result.changed) throw new Error("This reward changed in another window");
    return result;
  }

  async function redeemLinkedReward(blockId) {
    const res = await fetch("/api/social/rewards/redeem-by-block", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockId })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || res.statusText);
    return result;
  }

  async function rewardIsRedeemed(queueId) {
    const res = await fetch("/api/social/rewards/queue");
    if (!res.ok) throw new Error(res.statusText);
    const items = await res.json();
    const item = Array.isArray(items) && items.find(row => row && String(row.id) === String(queueId));
    return !!item && item.status === "redeemed";
  }

  async function redeemAndConfirm(item, blockId) {
    const result = await redeemLinkedReward(blockId);
    if (result.changed || (result.item && result.item.status === "redeemed")) return true;
    if (await rewardIsRedeemed(item.id)) return true;
    throw new Error("This reward is no longer linked to that task");
  }

  async function completeTask(localId) {
    const result = await toggleDone(localId, { silent: true });
    if (result === false) throw new Error("The task completion was not saved");
    if (result && result.pending) throw new Error("The task completion is still syncing");
    return result;
  }

  async function taskIsDurablyDone(localId, dateStr) {
    const res = await fetch("/api/blocks?date=" + encodeURIComponent(dateStr));
    if (!res.ok) throw new Error(res.statusText);
    const rows = await res.json();
    const row = Array.isArray(rows) && rows.find(block => block && !block.deleted_at &&
      (String(block.id) === String(localId) || (block.properties && String(block.properties.local_id) === String(localId))));
    const props = row && row.properties;
    return !!props && (props.status === "done" || !!props.completedAt);
  }

  // Create a reward task on today's itinerary, bind the queue row to it, then
  // complete it through the same lifecycle as a checked itinerary task. The
  // queue link is written before the check-off so the standard completion hook
  // can redeem by block id. If linking fails, the newly-created task is removed
  // and any prior scheduled placement remains untouched.
  function insertCompletedReward(item, today) {
    return new Promise((resolve, reject) => {
      const task = buildRewardTask(item);
      const oldBlockId = item.scheduled_block_id || null;
      const oldDate = item.scheduled_for ? String(item.scheduled_for).slice(0, 10) : null;
      let callbackStarted = false;
      try {
        insertTaskNow(task.title, task.minutes, Object.assign({}, task.options, {
          onScheduled: (info) => {
            callbackStarted = true;
            (async () => {
              info = info || {};
              if (!info.localId || !info.blockId) throw new Error("The itinerary task could not be created");
              let persisted = null;
              try {
                persisted = info.persisted ? await info.persisted : null;
                await linkRewardToBlock(item, info, today);
              } catch (e) {
                await removeItineraryTask(info.localId, today, persisted && persisted.id);
                throw e;
              }
              if (oldBlockId && String(oldBlockId) !== String(info.blockId)) {
                await removeItineraryTask(oldBlockId, oldDate);
              }
              await completeTask(info.localId);
              await redeemAndConfirm(item, info.blockId);
            })().then(resolve, reject);
          }
        }));
      } catch (e) {
        reject(e);
        return;
      }
      if (!callbackStarted) reject(new Error("The itinerary task could not be created"));
    });
  }

  async function completeRewardUnlocked(item) {
    if (!item || item.id == null) return false;
    const id = String(item.id);
    if (_busy.has(id)) return false;
    const today = actualTodayStr();
    if (currentItineraryDate() !== today) {
      toast("Switch to today to complete this", "info");
      return false;
    }
    if (typeof toggleDone !== "function") {
      toast("Task completion is unavailable here", "error");
      return false;
    }

    _busy.add(id);
    renderRewardsQueue();
    try {
      const scheduledDate = item.scheduled_for ? String(item.scheduled_for).slice(0, 10) : null;
      const existing = isScheduled(item) && scheduledDate === today ? loadedTask(item.scheduled_block_id) : null;
      if (existing) {
        if (!taskIsDone(existing)) await completeTask(existing.id);
        else if (!await taskIsDurablyDone(existing.id, today)) throw new Error("The task completion is still syncing");
        await redeemAndConfirm(item, item.scheduled_block_id);
      } else {
        if (typeof insertTaskNow !== "function") throw new Error("Task creation is unavailable here");
        await insertCompletedReward(item, today);
      }
      await loadRewardsQueue();
      toast("Done, logged on today", "success");
      return true;
    } catch (e) {
      toast("Could not mark reward done: " + (e.message || e), "error");
      return false;
    } finally {
      _busy.delete(id);
      renderRewardsQueue();
    }
  }

  async function completeRewardNow(item) {
    if (!item || item.id == null) return false;
    const locks = typeof navigator !== "undefined" && navigator.locks;
    if (!locks || typeof locks.request !== "function") return completeRewardUnlocked(item);
    return locks.request("dcc-reward-done:" + item.id, async () => {
      const res = await fetch("/api/social/rewards/queue");
      if (!res.ok) throw new Error(res.statusText);
      const items = await res.json();
      const fresh = Array.isArray(items) && items.find(row => row && String(row.id) === String(item.id));
      if (!fresh || !isActive(fresh)) {
        await loadRewardsQueue();
        toast("This reward was already handled", "info");
        return false;
      }
      return completeRewardUnlocked(fresh);
    }).catch(e => {
      toast("Could not mark reward done: " + (e.message || e), "error");
      return false;
    });
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
      } else if (act === "done") {
        await completeRewardNow(item);
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
