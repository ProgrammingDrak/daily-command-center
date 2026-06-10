(function(){
  const FORMULA_VERSION = "task_points_v3";
  const POINTS_PER_SPIN = 25;
  const EFFORT = { trivial: 0.25, low: 0.75, medium: 1, high: 1.2, intense: 1.4 };
  const ATTENTION = { light: 0.9, normal: 1, focused: 1.1, intense: 1.2 };
  const IMPORTANCE = { low: 0.9, normal: 1, important: 1.15, high: 1.25, critical: 1.4 };
  const NON_EARNING = new Set(["meeting", "break", "ooo"]);
  const GENERIC_TYPES = new Set(["", "task", "added_task", "pending_task", "trivial_task", "chat_action", "sweep_suite_task", "meeting_action", "backlog"]);
  const FOCUSED_TAGS = new Set(["deep-work", "deep work", "build", "coding", "writing", "analysis"]);
  const LIGHT_TAGS = new Set(["admin", "email", "errand", "chore"]);
  const BREAK_PATTERNS = [/\blunch\b/, /\bbreak\b/, /\bbreakfast\b/, /\bdinner\b/, /\bsnack\b/, /\bcoffee\b/, /\brest\b/, /\bnap\b/];
  const MAINTENANCE_PATTERNS = [/\broutine\b/, /\bchores?\b/, /\blaundry\b/, /\bdishes\b/, /\bclean(?:ing)?\b/, /\btidy(?:ing)?\b/, /\bgrocer(?:y|ies)\b/, /\berrands?\b/, /\btrash\b/, /\brecycling\b/, /\bmeal prep\b/, /\badmin\b/];

  function norm(value){ return String(value == null ? "" : value).trim().toLowerCase(); }
  function tags(value){
    if(Array.isArray(value)) return value.map(norm).filter(Boolean);
    if(typeof value === "string") return value.split(/[,|]/).map(norm).filter(Boolean);
    return [];
  }
  function taskText(input){
    input = input || {};
    return [input.title,input.label,input.description,input.detail,input.notes,input.category,tags(input.tags||input.tag).join(" ")]
      .map(norm).filter(Boolean).join(" ");
  }
  function classify(input){
    input = input || {};
    const explicit = norm(input.type || input.kind);
    const type = explicit || "task";
    const text = taskText(input);
    if(type === "ooo") return { type:"ooo", pointTier:"none", pointMultiplier:0, reason:"ooo" };
    if(GENERIC_TYPES.has(type) && BREAK_PATTERNS.some(p=>p.test(text))) return { type:"break", pointTier:"none", pointMultiplier:0, reason:"break_keyword" };
    if(GENERIC_TYPES.has(type) && MAINTENANCE_PATTERNS.some(p=>p.test(text))) return { type:type||"task", pointTier:"half", pointMultiplier:0.5, reason:"maintenance_keyword" };
    return { type, pointTier:null, pointMultiplier:null, reason:null };
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
    const u = norm(input.urgency);
    const p = norm(input.priority);
    return input.urgent === true || u === "urgent" || u === "now" || u === "today" || p === "urgent" || p === "p1" || p === "critical";
  }
  function responsibility(input){
    return input.responsibility === true || input.is_responsibility === true || input.responsibility_id != null || input.responsibilityId != null || norm(input.source) === "responsibility";
  }
  function effortTier(input, duration){
    const explicit = norm(input.effort_tier || input.effortTier);
    if(EFFORT[explicit]) return explicit;
    const t = tags(input.tags || input.tag);
    if(input.trivial === true || t.includes("trivial") || (typeof loadTrivialFlags === "function" && input.id && loadTrivialFlags()[input.id])) return "trivial";
    if(t.includes("hard") || t.includes("difficult") || t.includes("heavy")) return "high";
    if(t.includes("intense")) return "intense";
    if(duration <= 10 && t.some(tag => LIGHT_TAGS.has(tag))) return "low";
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
  function importanceTier(input){
    const explicit = norm(input.importance_tier || input.importanceTier || input.importance);
    if(IMPORTANCE[explicit]) return explicit;
    const p = norm(input.priority);
    if(p === "critical" || p === "p1") return "critical";
    if(p === "urgent" || p === "high") return "high";
    if(p === "medium" || p === "normal") return "normal";
    if(p === "low") return "low";
    if(responsibility(input)) return "important";
    return "normal";
  }
  function bountyCount(input){
    const explicit = Number(input.bounty_count != null ? input.bounty_count : input.bountyCount);
    if(Number.isFinite(explicit)) return Math.max(0, Math.min(2, Math.round(explicit)));
    let count = input.bounty === true ? 1 : 0;
    if(input.partner_bounty === true || input.partnerBounty === true || input.shared_bounty === true || input.sharedBounty === true) count += 1;
    return Math.max(0, Math.min(2, count));
  }
  function estimate(input){
    input = input || {};
    const classification = classify(input);
    const duration = durationMinutes(input);
    const effort = effortTier(input, duration);
    const attention = attentionTier(input);
    const importance = importanceTier(input);
    const bounties = bountyCount(input);
    const multipliers = {
      effort: EFFORT[effort] || EFFORT.medium,
      attention: ATTENTION[attention] || ATTENTION.normal,
      importance: IMPORTANCE[importance] || IMPORTANCE.normal,
      urgency: urgent(input) ? 1.15 : 1,
      bounty: Math.pow(2, bounties)
    };
    const requested = Number(input.point_multiplier != null ? input.point_multiplier : input.pointMultiplier);
    const pointMultiplier = classification.type === "break" || classification.type === "ooo"
      ? 0
      : Number.isFinite(requested)
        ? Math.max(0, Math.min(1, requested))
        : Number.isFinite(classification.pointMultiplier)
          ? Math.max(0, Math.min(1, classification.pointMultiplier))
          : 1;
    multipliers.points = pointMultiplier;
    const pointTier = input.point_tier || input.pointTier || classification.pointTier || null;
    const basePoints = duration * pointMultiplier;
    if(NON_EARNING.has(classification.type) && pointMultiplier <= 0){
      return { formulaVersion: FORMULA_VERSION, eligible: false, durationMinutes: duration, effortTier: effort, attentionTier: attention, importanceTier: importance, bountyCount: bounties, pointMultiplier, pointTier, classifiedType: classification.type, classificationReason: classification.reason, multipliers, basePoints, rawPoints: 0, awardPoints: 0 };
    }
    const rawPoints = basePoints * multipliers.effort * multipliers.attention * multipliers.importance * multipliers.urgency * multipliers.bounty;
    return { formulaVersion: FORMULA_VERSION, eligible: rawPoints > 0, durationMinutes: duration, effortTier: effort, attentionTier: attention, importanceTier: importance, bountyCount: bounties, pointMultiplier, pointTier, classifiedType: classification.type, classificationReason: classification.reason, multipliers, basePoints, rawPoints, awardPoints: rawPoints > 0 ? Math.max(1, Math.round(rawPoints)) : 0 };
  }
  function buildPayload(task, options){
    task = task || {};
    options = options || {};
    const classification = classify(task);
    const actual = actualMinutes(task);
    const planned = plannedMinutes(task);
    const bounty = options.bounty === true || task.bounty === true;
    const optionBountyCount = Number(options.bounty_count != null ? options.bounty_count : options.bountyCount);
    const resolvedBountyCount = Number.isFinite(optionBountyCount) ? Math.max(0, Math.min(2, Math.round(optionBountyCount))) : (task.bounty_count || task.bountyCount);
    const partnerBounty = options.partner_bounty === true || options.partnerBounty === true || options.shared_bounty === true || options.sharedBounty === true ||
      task.partner_bounty === true || task.partnerBounty === true || task.shared_bounty === true || task.sharedBounty === true;
    return {
      task_id: task.id,
      title: task.title || task.label || "Task completed",
      type: classification.type || task.type || task.kind || "task",
      priority: task.priority || "",
      importance: task.importance || task.importance_tier || task.importanceTier || "",
      urgency: task.urgency || "",
      tags: task.tags || task.tag || [],
      source: task.source || "",
      responsibility: task.responsibility === true || task.is_responsibility === true || task.responsibility_id != null || task.responsibilityId != null || task.source === "responsibility",
      urgent: urgent(task),
      bounty,
      bounty_count: resolvedBountyCount,
      partner_bounty: partnerBounty || resolvedBountyCount > 1,
      actual_minutes: actual > 0 ? actual : undefined,
      duration_minutes: planned,
      effort_tier: task.effort_tier || task.effortTier,
      attention_tier: task.attention_tier || task.attentionTier,
      point_tier: task.point_tier || task.pointTier || classification.pointTier,
      point_multiplier: task.point_multiplier != null ? task.point_multiplier : (task.pointMultiplier != null ? task.pointMultiplier : classification.pointMultiplier),
      classification_reason: classification.reason,
      trivial: task.trivial === true || (typeof loadTrivialFlags === "function" && task.id && !!loadTrivialFlags()[task.id])
    };
  }

  window.TaskPoints = {
    formulaVersion: FORMULA_VERSION,
    pointsPerSpin: POINTS_PER_SPIN,
    estimate,
    classify,
    buildPayload
  };
})();
