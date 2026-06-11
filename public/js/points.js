(function(){
  const FORMULA_VERSION = "task_points_v3";
  const POINTS_PER_SPIN = 25;
  const EFFORT = { trivial: 0.25, low: 0.75, medium: 1, high: 1.2, intense: 1.4 };
  const ATTENTION = { light: 0.9, normal: 1, focused: 1.1, intense: 1.2 };
  const IMPORTANCE = { low: 0.9, normal: 1, important: 1.15, high: 1.25, critical: 1.4 };
  const NON_EARNING = new Set(["meeting", "break", "ooo"]);
  const FOCUSED_TAGS = new Set(["deep-work", "deep work", "build", "coding", "writing", "analysis"]);
  const LIGHT_TAGS = new Set(["admin", "email", "errand", "chore"]);

  // Tag-bucket point tiers. Source of truth: slot-store.js taskPointTier() +
  // POINT_TAG_TIER_MULTIPLIERS. Kept in sync manually (same FE/BE duplication as
  // the EFFORT/ATTENTION tables above; the browser has no module system here).
  const POINT_TAG_TIER_MULTIPLIERS = { none: 0, quarter: 0.25, half: 0.5, full: 1 };
  // Bucket config (tag-id arrays per tier). Pushed in by slots.js loadSlots();
  // null until loaded -> multiplier defaults to 1 (no behavior change).
  let pointTagTiers = null;

  function tierTags(value){
    // Mirror backend normalizeTaskTags: trim only, case-PRESERVING. Tag ids are
    // UUID/server ids and case-sensitive, so do NOT lowercase via norm() here.
    if(Array.isArray(value)) return value.map(t => (t && typeof t === "object") ? String(t.id || t.name || t.label || "").trim() : String(t == null ? "" : t).trim()).filter(Boolean);
    if(typeof value === "string") return value.split(/[,·|]/).map(t => t.trim()).filter(Boolean);
    return [];
  }
  function tagPointMultiplier(input){
    // Mirrors slot-store.js taskPointTier(): highest multiplier among matched
    // buckets; no config or no match -> full (unsorted tags earn full points).
    if(!pointTagTiers) return { tier: "full", multiplier: 1 };
    const tagSet = new Set(tierTags(input.tags != null ? input.tags : input.tag));
    let bestTier = null, bestMult = -1;
    for(const tier in POINT_TAG_TIER_MULTIPLIERS){
      const mult = POINT_TAG_TIER_MULTIPLIERS[tier];
      const ids = pointTagTiers[tier] || [];
      if(mult > bestMult && ids.some(id => tagSet.has(String(id)))){ bestTier = tier; bestMult = mult; }
    }
    return bestTier ? { tier: bestTier, multiplier: POINT_TAG_TIER_MULTIPLIERS[bestTier] } : { tier: "full", multiplier: 1 };
  }
  function setPointTagTiers(tiers){
    if(tiers && typeof tiers === "object" && !Array.isArray(tiers)){
      const next = {};
      for(const tier in POINT_TAG_TIER_MULTIPLIERS){
        next[tier] = Array.isArray(tiers[tier]) ? tiers[tier].map(id => String(id)) : [];
      }
      pointTagTiers = next;
    } else {
      pointTagTiers = null;
    }
  }

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
    const duration = durationMinutes(input);
    const effort = effortTier(input, duration);
    const attention = attentionTier(input);
    const importance = importanceTier(input);
    const bounties = bountyCount(input);
    const tier = tagPointMultiplier(input);
    const pointMultiplier = tier.multiplier;
    const multipliers = {
      effort: EFFORT[effort] || EFFORT.medium,
      attention: ATTENTION[attention] || ATTENTION.normal,
      importance: IMPORTANCE[importance] || IMPORTANCE.normal,
      urgency: urgent(input) ? 1.15 : 1,
      bounty: Math.pow(2, bounties),
      points: pointMultiplier
    };
    const basePoints = duration * pointMultiplier;
    // Non-earning task type, or a 0x ("No points") tag bucket -> not eligible
    // (mirrors backend point_tier_zero in slot-scoring.js).
    if(NON_EARNING.has(norm(input.type || input.kind)) || pointMultiplier <= 0){
      return { formulaVersion: FORMULA_VERSION, eligible: false, durationMinutes: duration, effortTier: effort, attentionTier: attention, importanceTier: importance, bountyCount: bounties, pointTier: tier.tier, pointMultiplier, multipliers, basePoints, rawPoints: 0, awardPoints: 0 };
    }
    const rawPoints = basePoints * multipliers.effort * multipliers.attention * multipliers.importance * multipliers.urgency * multipliers.bounty;
    return { formulaVersion: FORMULA_VERSION, eligible: true, durationMinutes: duration, effortTier: effort, attentionTier: attention, importanceTier: importance, bountyCount: bounties, pointTier: tier.tier, pointMultiplier, multipliers, basePoints, rawPoints, awardPoints: Math.max(1, Math.round(rawPoints)) };
  }
  function buildPayload(task, options){
    task = task || {};
    options = options || {};
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
      type: task.type || task.kind || "task",
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
      trivial: task.trivial === true || (typeof loadTrivialFlags === "function" && task.id && !!loadTrivialFlags()[task.id])
    };
  }

  window.TaskPoints = {
    formulaVersion: FORMULA_VERSION,
    pointsPerSpin: POINTS_PER_SPIN,
    estimate,
    buildPayload,
    setPointTagTiers
  };
})();
