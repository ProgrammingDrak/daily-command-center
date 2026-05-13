(function(){
  const FORMULA_VERSION = "task_points_v2";
  const POINTS_PER_SPIN = 10;
  const EFFORT = { trivial: 0.35, low: 0.75, medium: 1.15, high: 1.35, intense: 1.55 };
  const ATTENTION = { light: 0.85, normal: 1, focused: 1.15, intense: 1.3 };
  const NON_EARNING = new Set(["meeting", "break", "ooo"]);
  const FOCUSED_TAGS = new Set(["deep-work", "deep work", "build", "coding", "writing", "analysis"]);
  const LIGHT_TAGS = new Set(["admin", "email", "errand", "chore"]);

  function norm(value){ return String(value == null ? "" : value).trim().toLowerCase(); }
  function tags(value){
    if(Array.isArray(value)) return value.map(norm).filter(Boolean);
    if(typeof value === "string") return value.split(/[,|]/).map(norm).filter(Boolean);
    return [];
  }
  function num(value){
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function actualMinutes(task){
    if(!task) return 0;
    try{
      if(typeof loadSessions === "function" && task.id){
        const sessions = loadSessions();
        if(sessions && Array.isArray(sessions[task.id])){
          const min = sessions[task.id].reduce((sum, s) => sum + (Number(s.durationMin) || 0), 0);
          if(min > 0) return Math.round(min);
        }
      }
    }catch(e){}
    try{
      if(typeof pomoState !== "undefined" && pomoState.taskTime && task.title && pomoState.taskTime[task.title] > 0){
        return Math.round(pomoState.taskTime[task.title] / 60);
      }
    }catch(e){}
    return num(task.actual_minutes || task.actualMinutes);
  }
  function plannedMinutes(task){
    if(!task) return 30;
    const direct = num(task.duration_minutes || task.durationMinutes || task.durMin || task.duration);
    if(direct > 0) return Math.round(direct);
    try{
      if(typeof dur === "function"){
        const d = num(dur(task));
        if(d > 0) return Math.round(d);
      }
    }catch(e){}
    return 30;
  }
  function durationMinutes(input){
    const actual = num(input.actual_minutes || input.actualMinutes);
    if(actual > 0) return Math.round(actual);
    const planned = num(input.duration_minutes || input.durationMinutes || input.durMin || input.duration);
    return planned > 0 ? Math.round(planned) : 30;
  }
  function highPriority(input){
    const p = norm(input.priority);
    return p === "high" || p === "urgent" || p === "p1" || p === "critical";
  }
  function urgent(input){
    return input.urgent === true || norm(input.urgency) === "urgent" || highPriority(input);
  }
  function responsibility(input){
    return input.responsibility === true || input.is_responsibility === true || input.responsibility_id != null || input.responsibilityId != null || norm(input.source) === "responsibility";
  }
  function effortTier(input, duration){
    const explicit = norm(input.effort_tier || input.effortTier);
    if(EFFORT[explicit]) return explicit;
    const t = tags(input.tags || input.tag);
    if(input.trivial === true || t.includes("trivial") || (typeof loadTrivialFlags === "function" && input.id && loadTrivialFlags()[input.id])) return "trivial";
    if(highPriority(input) || urgent(input) || responsibility(input) || duration >= 90) return "high";
    return "medium";
  }
  function attentionTier(input){
    const explicit = norm(input.attention_tier || input.attentionTier);
    if(ATTENTION[explicit]) return explicit;
    const t = tags(input.tags || input.tag);
    if(t.some(tag => FOCUSED_TAGS.has(tag))) return "focused";
    if(t.some(tag => LIGHT_TAGS.has(tag))) return "light";
    return "normal";
  }
  function estimate(input){
    input = input || {};
    const duration = durationMinutes(input);
    const effort = effortTier(input, duration);
    const attention = attentionTier(input);
    const multipliers = {
      effort: EFFORT[effort] || EFFORT.medium,
      attention: ATTENTION[attention] || ATTENTION.normal,
      urgency: urgent(input) ? 1.2 : 1,
      bounty: input.bounty === true ? 2 : 1
    };
    const basePoints = duration / 5;
    if(NON_EARNING.has(norm(input.type || input.kind))){
      return { formulaVersion: FORMULA_VERSION, eligible: false, durationMinutes: duration, effortTier: effort, attentionTier: attention, multipliers, basePoints, rawPoints: 0, awardPoints: 0 };
    }
    const rawPoints = basePoints * multipliers.effort * multipliers.attention * multipliers.urgency * multipliers.bounty;
    return { formulaVersion: FORMULA_VERSION, eligible: true, durationMinutes: duration, effortTier: effort, attentionTier: attention, multipliers, basePoints, rawPoints, awardPoints: Math.max(1, Math.round(rawPoints)) };
  }
  function buildPayload(task, options){
    task = task || {};
    options = options || {};
    const actual = actualMinutes(task);
    const planned = plannedMinutes(task);
    const bounty = options.bounty === true || task.bounty === true;
    return {
      task_id: task.id,
      title: task.title || task.label || "Task completed",
      type: task.type || task.kind || "task",
      priority: task.priority || "",
      tags: task.tags || task.tag || [],
      source: task.source || "",
      responsibility: task.responsibility === true || task.is_responsibility === true || task.responsibility_id != null || task.responsibilityId != null || task.source === "responsibility",
      urgent: task.urgent === true || highPriority(task),
      bounty,
      actual_minutes: actual > 0 ? actual : undefined,
      duration_minutes: planned,
      effort_tier: task.effort_tier || task.effortTier,
      attention_tier: task.attention_tier || task.attentionTier,
      trivial: task.trivial === true || (typeof loadTrivialFlags === "function" && task.id && !!loadTrivialFlags()[task.id])
    };
  }

  window.TaskPoints = {
    formulaVersion: FORMULA_VERSION,
    pointsPerSpin: POINTS_PER_SPIN,
    estimate,
    buildPayload
  };
})();
