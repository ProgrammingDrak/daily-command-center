(function(){
  "use strict";

  const BONUS_LABELS = {
    hard_thing: "Hard Thing",
    right_bet: "Right Bet",
    beat_odds: "Beat the Odds",
    protected_priority: "Protected Priority",
    unblocked: "Unblocked",
    recovered_momentum: "Recovered Momentum",
    learned_from_bad_outcome: "Learned From It"
  };

  function api(url, options){
    return fetch(url, options).then(async res => {
      if(!res.ok){
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    });
  }

  function currentDate(){
    return (window.__state && window.__state.date) || (typeof viewDate !== "undefined" && viewDate) || new Date().toISOString().slice(0,10);
  }

  function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

  function eventDuration(task){
    if(!task) return null;
    if(typeof dur === "function" && task.start && task.end) return dur(task);
    if(task.duration_minutes) return task.duration_minutes;
    if(task.duration) return task.duration;
    if(task.durMin) return task.durMin;
    return null;
  }

  function collectDoneModalOptions(){
    const overlay = document.getElementById("done-modal-overlay");
    if(!overlay || !overlay.classList.contains("open")){
      return { quality: "done", bonus: null };
    }
    const pick = name => {
      const active = document.querySelector('.tp-chip.active[data-tp-group="'+name+'"]');
      return active ? active.dataset.value : null;
    };
    const bonusChip = document.querySelector('.tp-bonus-chip.active');
    const oddsChip = document.querySelector('.tp-chip.active[data-tp-group="odds"]');
    return {
      effort_size: pick("effort") || undefined,
      importance: pick("importance") || undefined,
      quality: pick("quality") || "done",
      predicted_success_probability: oddsChip && oddsChip.dataset.value ? num(oddsChip.dataset.value) : undefined,
      bonus: bonusChip ? {
        type: bonusChip.dataset.value,
        intensity: document.getElementById("tp-bonus-intensity") ? document.getElementById("tp-bonus-intensity").value : "normal",
        reflection: document.getElementById("tp-bonus-reflection") ? document.getElementById("tp-bonus-reflection").value.trim() : ""
      } : null
    };
  }

  function setActiveChip(btn){
    const group = btn.dataset.tpGroup;
    if(group){
      document.querySelectorAll('.tp-chip[data-tp-group="'+group+'"]').forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    } else if(btn.classList.contains("tp-bonus-chip")){
      const wasActive = btn.classList.contains("active");
      document.querySelectorAll(".tp-bonus-chip").forEach(b => b.classList.remove("active"));
      if(!wasActive) btn.classList.add("active");
      const detail = document.getElementById("tp-bonus-detail");
      if(detail) detail.style.display = wasActive ? "none" : "";
    }
  }

  function defaultEffort(task){
    const minutes = eventDuration(task) || 30;
    if(minutes <= 15) return "tiny";
    if(minutes <= 45) return "small";
    if(minutes <= 90) return "medium";
    if(minutes <= 180) return "large";
    return "major";
  }

  function defaultImportance(task){
    const p = String((task && task.priority) || "").toLowerCase();
    if(p.includes("critical") || p.includes("mission")) return "mission_critical";
    if(p.includes("urgent") || p.includes("highest")) return "high_leverage";
    if(p.includes("high")) return "important";
    if(p.includes("low") || p.includes("trivial")) return "low";
    return "normal";
  }

  function prepareDoneModal(task){
    document.querySelectorAll(".tp-chip,.tp-bonus-chip").forEach(b => b.classList.remove("active"));
    const effort = document.querySelector('.tp-chip[data-tp-group="effort"][data-value="'+defaultEffort(task)+'"]');
    const importance = document.querySelector('.tp-chip[data-tp-group="importance"][data-value="'+defaultImportance(task)+'"]');
    const quality = document.querySelector('.tp-chip[data-tp-group="quality"][data-value="done"]');
    if(effort) effort.classList.add("active");
    if(importance) importance.classList.add("active");
    if(quality) quality.classList.add("active");
    const bonusDetail = document.getElementById("tp-bonus-detail");
    if(bonusDetail) bonusDetail.style.display = "none";
    const reflection = document.getElementById("tp-bonus-reflection");
    if(reflection) reflection.value = "";
    const intensity = document.getElementById("tp-bonus-intensity");
    if(intensity) intensity.value = "normal";
  }

  async function awardTaskCompletion(task){
    if(!task || !task.id) return null;
    const opts = collectDoneModalOptions();
    const completedAt = new Date().toISOString();
    const payload = {
      date: currentDate(),
      task_id: task.id,
      title: task.title || task.label || "Task completed",
      start: task.start || null,
      end: task.end || null,
      completed_at: completedAt,
      duration_minutes: eventDuration(task),
      priority: task.priority || null,
      effort_size: opts.effort_size,
      importance: opts.importance,
      quality: opts.quality,
      predicted_success_probability: opts.predicted_success_probability
    };
    const result = await api("/api/points/task-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if(result.awarded && typeof showToast === "function") showToast("+" + result.points + " points");
    if(opts.bonus && opts.bonus.type){
      try {
        if(!opts.bonus.reflection) throw new Error("Bonus needs a short reflection.");
        const bonus = await awardBonus({ ...payload, ...opts.bonus });
        if(bonus.awarded && typeof showToast === "function") showToast("Bonus +" + bonus.points + " points");
      } catch(e) {
        if(typeof showToast === "function") showToast(e.message, "error");
      }
    }
    document.dispatchEvent(new CustomEvent("slot-changed"));
    return result;
  }

  async function awardBonus(payload){
    return api("/api/points/bonus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: currentDate(), ...payload })
    });
  }

  function recentTaskOptions(){
    const globalScheduled = typeof scheduled !== "undefined" ? scheduled : window.scheduled;
    const list = Array.isArray(globalScheduled) ? globalScheduled : [];
    return list.filter(t => !((typeof isMeeting === "function" && isMeeting(t)) || t.type === "ooo" || t.type === "break")).slice(0, 20);
  }

  function openHardThingModal(){
    const overlay = document.getElementById("hard-thing-overlay");
    if(!overlay) return;
    const sel = document.getElementById("ht-task");
    if(sel){
      const tasks = recentTaskOptions();
      sel.innerHTML = '<option value="">Standalone win</option>' + tasks.map(t => '<option value="'+String(t.id).replace(/"/g,"&quot;")+'">'+String(t.title || t.label || "Task").replace(/</g,"&lt;")+'</option>').join('');
    }
    document.getElementById("ht-reflection").value = "";
    overlay.classList.add("open");
  }

  function closeHardThingModal(){
    const overlay = document.getElementById("hard-thing-overlay");
    if(overlay) overlay.classList.remove("open");
  }

  async function submitHardThing(){
    const type = document.getElementById("ht-type").value;
    const intensity = document.getElementById("ht-intensity").value;
    const reflection = document.getElementById("ht-reflection").value.trim();
    const taskId = document.getElementById("ht-task").value;
    const task = taskId ? recentTaskOptions().find(t => String(t.id) === String(taskId)) : null;
    try {
      const result = await awardBonus({
        type,
        intensity,
        reflection,
        task_id: task ? task.id : undefined,
        title: task ? task.title : undefined,
        duration_minutes: task ? eventDuration(task) : undefined,
        priority: task ? task.priority : undefined,
        start: task ? task.start : undefined,
        end: task ? task.end : undefined,
        predicted_success_probability: type === "beat_odds" ? 0.25 : undefined
      });
      if(result.awarded && typeof showToast === "function") showToast("Bonus +" + result.points + " points");
      document.dispatchEvent(new CustomEvent("slot-changed"));
      closeHardThingModal();
    } catch(e) {
      if(typeof showToast === "function") showToast(e.message, "error");
    }
  }

  function bonusLabel(type){ return BONUS_LABELS[type] || type || "Bonus"; }

  function init(){
    document.querySelectorAll(".tp-chip,.tp-bonus-chip").forEach(btn => {
      btn.addEventListener("click", () => setActiveChip(btn));
    });
    const htOpen = document.getElementById("hard-thing-btn");
    if(htOpen) htOpen.addEventListener("click", openHardThingModal);
    const htClose = document.getElementById("hard-thing-close");
    if(htClose) htClose.addEventListener("click", closeHardThingModal);
    const htCancel = document.getElementById("hard-thing-cancel");
    if(htCancel) htCancel.addEventListener("click", closeHardThingModal);
    const htSave = document.getElementById("hard-thing-save");
    if(htSave) htSave.addEventListener("click", submitHardThing);
    const overlay = document.getElementById("hard-thing-overlay");
    if(overlay) overlay.addEventListener("click", e => { if(e.target === e.currentTarget) closeHardThingModal(); });
  }

  window.TaskPoints = { awardTaskCompletion, awardBonus, prepareDoneModal, collectDoneModalOptions, openHardThingModal, closeHardThingModal, bonusLabel };
  document.addEventListener("DOMContentLoaded", init);
})();
