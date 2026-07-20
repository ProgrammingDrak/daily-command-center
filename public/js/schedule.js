// ======== OVERFLOW DETECTION ========
let EOD = (function(){
  // Prefer last work-type block end
  if(__state&&__state.schedule&&__state.schedule.blocks){
    const wb=__state.schedule.blocks.filter(b=>(b.blockType||b.type)==='work');
    if(wb.length) return pt(wb[wb.length-1].end);
  }
  if(__state&&__state.schedule&&__state.schedule.end_time){
    const t=__state.schedule.end_time;
    return pt(t.length>5?t.substring(11,16):t);
  }
  return pt("17:30");
})();


// ======== QUICK ADD (inline schedule insertion) ========
let ADDED_KEY = "pa-added-tasks-" + ((__state && __state.date) ? __state.date : "unknown");
function loadAddedTasks(){ try{return JSON.parse(localStorage.getItem(ADDED_KEY)||"[]")}catch(e){return[]} }
function saveAddedTasks(tasks){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore)return; // blockstore handles it
  localStorage.setItem(ADDED_KEY,JSON.stringify(tasks)); scheduleIDBSave();
}
function persistAddedTask(item,targetDate){
  // dur() is end-start, which is meaningless on an untimed item (no start yet,
  // e.g. a future-day create from the schedule popover) — fall back to durMin.
  const _computedDur=dur(item);
  const _itemDur=(Number.isFinite(_computedDur)&&_computedDur>0)?_computedDur:(item.durMin||30);
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
    // Write to blockstore — will be reloaded via property-based query on refresh
    const date=targetDate||((typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)?__state.date:null));
    return window.blockStore.createBlock("block",{
      kind:item.kind||undefined,
      local_id:item.id,
      type:item.type||"task",
      title:item.title,
      duration:_itemDur,
      start:item.start,
      end:item.end,
      priority:item.priority||"High",
      meta:item.meta||"",
      detail:item.detail||"",
      notionUrl:item.notionUrl||"",
      calUrl:item.calUrl||"",
      source:item.source||"manual",
      tags:item.tags||[],
      idempotency_key:item.idempotency_key||item.idempotencyKey||null,
      responsibilityId:item.responsibilityId||null,
      responsibilityTitle:item.responsibilityTitle||null,
      capacityBucket:item.capacityBucket||null,
      responsibilityScore:item.responsibilityScore||null,
      alertKey:item.alertKey||null,
      alertType:item.alertType||null,
      triageId:item.triageId||null,
      delegatedItemId:item.delegatedItemId||null,
      linkedBlockId:item.linkedBlockId||null,
      linkedTagId:item.linkedTagId||null,
      ampUrl:item.ampUrl||null,
      hubspotUrl:item.hubspotUrl||null,
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      publicVisibility:item.publicVisibility||"public",
      wrapId:item.wrapId||null,
      isWrap:!!item.isWrap,
      subtaskOf:item.subtaskOf||null,
      reschedulePlacement:item.reschedulePlacement||null,
      rescheduledFrom:item.rescheduledFrom||null,
      sourceTaskId:item.sourceTaskId||null,
      added_at:new Date().toISOString()
    },{date});
  }
  // Fallback: localStorage
  const key=targetDate?("pa-added-tasks-"+targetDate):ADDED_KEY;
  let added=[];
  try{added=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){added=[]}
  if(!added.find(t=>t.id===item.id)){
    added.push({
      id:item.id,title:item.title,type:item.type||"task",durMin:_itemDur,
      priority:item.priority||"High",source:item.source||"manual",
      meta:item.meta||"",detail:item.detail||"",notionUrl:item.notionUrl||"",
      calUrl:item.calUrl||"",tags:item.tags||[],
      triageId:item.triageId||null,delegatedItemId:item.delegatedItemId||null,
      linkedBlockId:item.linkedBlockId||null,linkedTagId:item.linkedTagId||null,
      ampUrl:item.ampUrl||null,hubspotUrl:item.hubspotUrl||null,
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      publicVisibility:item.publicVisibility||"public",
      wrapId:item.wrapId||null,isWrap:!!item.isWrap,subtaskOf:item.subtaskOf||null,
      reschedulePlacement:item.reschedulePlacement||null,
      rescheduledFrom:item.rescheduledFrom||null,
      sourceTaskId:item.sourceTaskId||null,
      addedAt:new Date().toISOString()
    });
    localStorage.setItem(key,JSON.stringify(added));scheduleIDBSave();
  }
}

// After recalcTimes changes positions (e.g. drag reorder), sync blockstore added_task blocks
function syncAddedTaskTimes(){
  if(!window.USE_BLOCKSTORE||!window.USE_BLOCKSTORE.addedTasks||!window.blockStore)return;
  // Match the date + foldability filters in reloadPersistedEdits — otherwise we'd
  // rewrite start/end on blocks from other days. Startless blocks (API inserts /
  // untimed rows) are included so a drag out of the Unscheduled section persists
  // its newly assigned time; rows still sitting in that section are skipped below.
  const currentDate=window.blockStore.getCurrentDate();
  const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(b=>{
    const p=b.properties||{};
    if(p.kind&&/^responsibility/.test(p.kind))return false;
    // Meetings are API-inserted (no local_id, kind "meeting") -> admit them so a
    // manual move (drag / start-time picker) persists to the block.
    const isMeetingBlock=p.kind==="meeting"||p.type==="meeting"||p.type==="oneone";
    if(!p.local_id&&p.kind!=="task"&&!isMeetingBlock)return false;
    return !b.date||b.date===currentDate;
  })];
  const datedLocalIds=new Set(window.blockStore.getByType("block")
    .filter(x=>x.date&&(x.properties||{}).local_id)
    .map(x=>x.properties.local_id));
  addedBlocks.forEach(block=>{
    const p=block.properties||{};
    const ev=scheduled.find(e=>e.id===(p.local_id||block.id));
    if(!ev)return;
    if(ev.untimed)return; // still unscheduled: keep the block startless
    // A dateless row whose local_id has a dated sibling is a suppressed leftover
    // copy; ev here is the SIBLING's task, so never stamp times onto the copy.
    if(!block.date&&p.local_id&&datedLocalIds.has(p.local_id))return;
    if(!block.date){
      // Dragged out of Unscheduled: the task is now scheduled for the viewed
      // day, so the date lands on the block along with its slot.
      window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end},{date:currentDate});
    } else if(p.start!==ev.start||p.end!==ev.end){
      window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end});
    }
  });
}

function insertTaskNow(titleArg, durMinArg, opts){
  opts=opts||{};
  const title=titleArg||(function(){const inp=document.getElementById("qa-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  // A shell has no length of its own — it starts zero-length and derives its
  // span from the children that get added to it (durationFromChildren).
  const durFromKids=window.TaskTypes&&window.TaskTypes.rule(opts.type,"durationFromChildren");
  const durMin=durFromKids?0:(durMinArg||30);
  const id=qaId();

  // Pin start to the next free 15-minute slot from now, stepping past any
  // meeting block. Without a pin, recalcTimes() would cascade from the first
  // undone task -- which on an empty/sparse day collapses the urgent task to
  // 00:00.
  const roundTo15=m=>Math.ceil(m/15)*15;
  const meetings=_meetingBlocks();
  const startMin=_freeStart(roundTo15(now()),durMin,meetings);
  const startStr=fmt(startMin);

  const newItem=Object.assign({id,title,type:opts.type||"task",start:startStr,end:fmt(startMin+durMin),
    // Rollup containers are wraps from birth so drag carries their children.
    isWrap:(window.TaskTypes&&window.TaskTypes.rule(opts.type,"dragMovesSubtree"))||undefined,
    _pinnedStart:startStr},schedulePickerFields(durMin,opts));

  // Calculate insertion position
  const activeIdx=scheduled.findIndex(isActive);
  const insertAt = activeIdx !== -1 ? activeIdx + 1 :
    (()=>{const fi=scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev));return fi.length?fi[0].i:scheduled.length;})();

  // Simulate placement: temporarily add, cascade, read the worst end among
  // user-controllable tasks, then remove. Checking only newItem.end would miss
  // cases where the pinned insert bumps a later task past EOD.
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const simulatedEnd=scheduled
    .filter(ev=>!isDone(ev)&&!isPushed(ev)&&!isDeleted(ev)&&pointEligible(ev))
    .reduce((max,ev)=>Math.max(max,pt(ev.end)),0);
  scheduled.splice(scheduled.indexOf(newItem), 1);
  recalcTimes(); // restore cascade without the new item

  // Always commit the task. (The old overflow-modal detour that staged a
  // "doesn't fit" task and asked you to push things to tomorrow was removed
  // 2026-07 -- tasks just get added; the day can run long.)
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const pins=loadPinnedStarts();pins[id]=startStr;savePinnedStarts(pins);
  // The dated block from persistAddedTask is the single record. The old extra
  // savePendingTasks push here minted a dateless kind:"pending_task" twin with
  // the same local_id that nothing ever deleted.
  persistAddedTask(newItem);
  log("scheduled",id,"Quick-added at "+startStr+": "+title);
  render();
  checkBlockWarnings(newItem);
  if(typeof opts.onScheduled==="function"){
    try{opts.onScheduled({localId:id,blockId:id,start:startStr,dateStr:(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||null});}catch(e){}
  }
}

function insertTaskFromDrawer(title, durMin, opts){
  opts=opts||{};
  const id=qaId();
  const newItem={id,title,type:"task",start:"00:00",end:fmt(durMin),
    meta:(opts.meta||"Action item")+" \u00b7 "+ms(durMin),detail:opts.detail||"",source:opts.source||"manual",
    notionUrl:opts.notionUrl||"",priority:opts.priority||"High",
    tags:opts.tags||[],triageId:opts.triageId||null};
  const activeIdx=scheduled.findIndex(isActive);
  const insertAt = activeIdx !== -1 ? activeIdx + 1 :
    (()=>{const fi=scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev));return fi.length?fi[0].i:scheduled.length;})();
  scheduled.splice(insertAt, 0, newItem);
  persistAddedTask(newItem);
  recalcTimes();
  
  log("scheduled",id,"Drawer-added: "+title);
  render();
  checkBlockWarnings(newItem);
  return newItem;
}

// ── SHELL TEMPLATE MATERIALIZATION ──
// Rebuild a saved shell template (root + nested children) onto the day using the
// SAME live primitives a hand-built shell uses — addStackedTask for ride-along
// children, addSubtask for timeless subtasks — so every block renders normally
// and its kind is never "responsibility_task" (which the itinerary fold in
// persistence.js rejects). Recurses into nested children. The shell root is
// created by materializeShellTemplate, which then calls this in its onScheduled.
function attachTemplateChildren(parentLocalId,children){
  if(!parentLocalId||!Array.isArray(children))return;
  children.forEach(function(node){
    if(!node||!node.title)return;
    var created=null;
    if(node.edge==="subtask"){
      if(typeof addSubtask==="function")created=addSubtask(parentLocalId,node.title);
    }else{
      var d=Math.max(1,Number(node.durationMin)||30);
      if(typeof addStackedTask==="function")created=addStackedTask(parentLocalId,node.title,d,{priority:node.priority||"Medium",type:node.type||"task",detail:node.detail||""});
    }
    if(created&&created.id&&Array.isArray(node.children)&&node.children.length){
      attachTemplateChildren(created.id,node.children);
    }
  });
}
window.attachTemplateChildren=attachTemplateChildren;

// Idempotency: is a shell for this responsibility already live on the viewed day?
function _shellAlreadyOnDay(responsibilityId){
  if(!responsibilityId||typeof scheduled==="undefined")return false;
  return scheduled.some(function(e){
    return e&&e.responsibilityId===responsibilityId&&!isDeleted(e)&&window.TaskTypes&&window.TaskTypes.isRollup(e);
  });
}
window._shellAlreadyOnDay=_shellAlreadyOnDay;

// Drop a whole shell template onto TODAY at the next free slot (no time picker).
// Creates the zero-length shell root via insertTaskNow, then attaches the saved
// children in the onScheduled callback so the sequential-shell reflow sizes it.
// Returns the shell root's local id (or null if deduped / invalid).
function materializeShellTemplate(templateTree,opts){
  opts=opts||{};
  if(!templateTree||!templateTree.root)return null;
  var root=templateTree.root;
  if(opts.responsibilityId&&_shellAlreadyOnDay(opts.responsibilityId)){
    if(typeof showToast==="function")showToast('"'+(root.title||"Shell")+'" is already on today',"info");
    return null;
  }
  var curDate=(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||"";
  var rootId=null;
  insertTaskNow(root.title,0,{
    type:root.type||"shell",
    responsibilityId:opts.responsibilityId||null,
    responsibilityTitle:opts.responsibilityTitle||root.title,
    priority:root.priority||"High",
    source:opts.source||"responsibility",
    tags:opts.tags||["responsibility"],
    detail:root.detail||"",
    idempotencyKey:opts.responsibilityId?("resp-shell:"+opts.responsibilityId+":"+curDate):null,
    onScheduled:function(info){
      rootId=info&&info.localId;
      if(rootId)attachTemplateChildren(rootId,root.children||[]);
      if(typeof opts.onScheduled==="function"){try{opts.onScheduled(info);}catch(e){}}
    }
  });
  return rootId;
}
window.materializeShellTemplate=materializeShellTemplate;

// ======== ACTIONS ========
// Day points currently earned (completed, point-eligible tasks). Used to drive
// the count-up animation when a task is checked off. Safe before schedule-tab.js
// loads -- returns 0 if the summary helper isn't available yet.
function _earnedPointsNow(){
  try { return (typeof _dayPointSummary === "function") ? (_dayPointSummary().earned || 0) : 0; }
  catch(e){ return 0; }
}
// Locate the checkbox the user just clicked so confetti can erupt from it.
// Rows carry data-id; the check button is .chk (list) or .c-check (card view).
function _completionAnchorRect(id){
  try {
    var key = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
    var row = document.querySelector('[data-id="' + key + '"]');
    var chk = row && (row.querySelector(".chk") || row.querySelector(".c-check"));
    if(chk) return chk.getBoundingClientRect();
  } catch(e){}
  return null;
}
// Snapshot taken at click time, BEFORE the task is marked done and the list
// re-renders: where the checkbox sits (confetti origin) and points earned so far.
function _beginCompletionCelebration(id){
  return { rect: _completionAnchorRect(id), prevEarned: _earnedPointsNow() };
}
// Run AFTER render(): confetti erupts from the just-checked task, whirlwinds
// together, and streams into the points counter -- which then counts up from
// the pre-completion total to the new one as the swarm pours in.
function _finishCompletionCelebration(ctx, id){
  if(!window.Celebrate || !ctx) return;
  var rect = ctx.rect || _completionAnchorRect(id);
  var x = rect ? (rect.left + rect.width / 2) : (window.innerWidth / 2);
  var y = rect ? (rect.top + rect.height / 2) : (window.innerHeight / 3);

  var summary;
  try { summary = (typeof _dayPointSummary === "function") ? _dayPointSummary() : null; }
  catch(e){ summary = null; }
  var newEarned = summary ? (summary.earned || 0) : 0;
  var pointEl = document.getElementById("s-points");
  var gained = !!(pointEl && summary && newEarned > ctx.prevEarned);

  // Target the confetti at the points counter so it flows into it.
  var target = { x: window.innerWidth - 90, y: 90 };
  if(pointEl){
    var pr = pointEl.getBoundingClientRect();
    if(pr && pr.width){ target = { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 }; }
  }

  // When the swarm reaches the counter, pulse it and tick the points up.
  var onArrive = function(){
    if(!gained) return;
    var schedTxt = summary.scheduledPoints;
    pointEl.classList.remove("points-pop");
    // Reflow so the animation restarts even if it fired moments ago.
    void pointEl.offsetWidth;
    pointEl.classList.add("points-pop");
    Celebrate.countNumber(pointEl, ctx.prevEarned, newEarned, {
      duration: 750,
      format: function(v){ return v + " / " + schedTxt; }
    });
    setTimeout(function(){ pointEl.classList.remove("points-pop"); }, 850);
  };

  Celebrate.confetti({ x: x, y: y, flowTo: target, onArrive: onArrive });
}

// Mark `id` done in a different date's persistence (not the currently-viewed day).
// Used when completing a future/past task and pinning the completion to a specific date.
async function commitDoneOnDate(id,dateStr){
  if(!id||!dateStr)return;
  const nowIso=new Date().toISOString();
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  const ev=scheduled.find(e=>e.id===id);

  // Same-day completion: take the in-memory fast path
  if(currentDate===dateStr){
    const _award=_pointAwardOverride(id);
    const _cel=_beginCompletionCelebration(id);
    manualDone.add(id);doneAt[id]=new Date();
    log("checked",id);saveDoneState();render();
    _finishCompletionCelebration(_cel,id);
    awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:dateStr,completedAt:nowIso,awardPoints:_award});
    _autoCompleteShellAncestors(id,dateStr);
    return;
  }

  // localStorage mirror so a refresh on the target date sees the completion
  try{
    const key="pa-done-"+dateStr;
    let d={};try{d=JSON.parse(localStorage.getItem(key)||"{}")}catch(e){d={}}
    if(!d.ids)d.ids=[];if(!d.at)d.at={};
    if(!d.ids.includes(id))d.ids.push(id);
    d.at[id]=nowIso;
    localStorage.setItem(key,JSON.stringify(d));
  }catch(e){}

  // Server-side: load the target day's day_root and patch its _done property.
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.done){
    try{
      const blocks=await fetch("/api/blocks?date="+dateStr).then(r=>r.json());
      const dayRoot=Array.isArray(blocks)?blocks.find(b=>b.type==="day_root"):null;
      if(dayRoot){
        const props=dayRoot.properties||{};
        const existing=props._done||{ids:[],at:{}};
        const ids=new Set(existing.ids||[]);ids.add(id);
        const at={...(existing.at||{})};at[id]=nowIso;
        await fetch("/api/blocks/"+dayRoot.id,{
          method:"PATCH",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({properties:{...props,_done:{ids:[...ids],at}}})
        });
      }
    }catch(e){}
  }
  log("checked-on",id,"Marked done on "+dateStr);
  awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:dateStr,completedAt:nowIso,awardPoints:_pointAwardOverride(id)});
  _autoCompleteShellAncestors(id,dateStr);
}

// Completion bonus for a rollup container (shell): bonusPct × the estimated
// value of its whole subtree. Each descendant that isn't a pie subtask
// contributes its own estimate (PointPlan.estimatePool — the points-chip
// number); a descendant that owns a pie contributes its pool instead (which
// already covers its subtasks). Nested rollup containers contribute nothing
// themselves (their own bonus banks when THEY complete) but their subtrees
// count. Client-computed like the PointPlan pie bonus and sent as a
// points_override — the server clamps and ledgers it idempotently.
function _shellBonusPoints(id){
  if(typeof scheduled==="undefined"||!window.TaskTypes||typeof shellRollup!=="function"||typeof shellBonus!=="function")return undefined;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||!window.TaskTypes.isRollup(ev))return undefined;
  const bonus=shellBonus(shellRollup(id,scheduled).points,Number(window.TaskTypes.rule(ev,"bonusPct"))||0);
  return bonus>0?bonus:undefined;
}

// After any completion, walk the parent chain: a rollup ancestor (shell) whose
// children are now ALL done auto-completes and banks its bonus. Completion is
// applied directly (not via toggleDone) so the manual-complete guard and the
// child cascade are skipped — every child is already done. Idempotent: the
// bonus rides the normal ledger sourceKey (<date>:<shellId>).
function _autoCompleteShellAncestors(id,sourceDate){
  if(typeof scheduled==="undefined"||!window.TaskTypes||typeof parentIdOf!=="function")return;
  const seen=new Set();
  let cur=scheduled.find(e=>e.id===id);
  while(cur){
    const pid=parentIdOf(cur);
    if(!pid||seen.has(pid))return;
    seen.add(pid);
    const parent=scheduled.find(e=>e.id===pid);
    if(!parent)return;
    if(window.TaskTypes.rule(parent,"autoCompleteWhenChildrenDone")&&!isDone(parent)){
      if(childrenOf(parent.id,scheduled).some(c=>!isDone(c)))return; // still open work inside
      const bonus=_shellBonusPoints(parent.id);
      const completedAt=new Date();
      manualDone.add(parent.id);doneAt[parent.id]=completedAt;
      log("checked",parent.id,"Auto-completed: all nested tasks done");
      saveDoneState();render();
      awardSlotTaskCredit(parent,{sourceDate:sourceDate,completedAt:completedAt.toISOString(),awardPoints:bonus});
      if(typeof showToast==="function")showToast('"'+(parent.title||"Shell")+'" complete!'+(bonus?" +"+bonus+" pt bonus":""),"success",3200);
    } else if(!isDone(parent)){
      return; // an open non-rollup ancestor blocks everything above it
    }
    cur=parent;
  }
}

// Points override for a completion, when the task participates in a parent's
// point pie or is itself a rollup container. Returns:
//   - a rollup container's completion bonus (covers the manual recheck path;
//     the normal path banks it via _autoCompleteShellAncestors);
//   - a parent's completion award (bonus + still-open subtask slices) when the
//     task has subtasks — MUST be read BEFORE _onParentCompleted cascades them;
//   - a subtask's own slice when it is a subtask of a parent;
//   - undefined for everything else (normal duration-based scoring), including
//     "stacked" (ride-along) tasks, whose points are independent.
function _pointAwardOverride(id){
  if(typeof childrenOf!=="function"||typeof relOf!=="function")return undefined;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return undefined;
  if(window.TaskTypes&&window.TaskTypes.isRollup(ev))return _shellBonusPoints(id);
  if(!window.PointPlan)return undefined;
  const hasSubKids=childrenOf(id,scheduled).some(c=>relOf(c)==="subtask");
  if(hasSubKids)return window.PointPlan.awardForParentCompletion(id);
  if(ev.subtaskOf)return window.PointPlan.shareFor(ev.subtaskOf,id);
  return undefined;
}

function awardSlotTaskCredit(ev,opts){
  if(!ev||!ev.id)return;
  opts=opts||{};
  // An explicit zero slice (e.g. a subtask allocated 0 pts) means "credit
  // nothing" — without this guard a 0 would fall through to normal scoring.
  if(opts.awardPoints!=null&&Number.isFinite(Number(opts.awardPoints))&&Number(opts.awardPoints)<=0)return;
  const fallbackDate=(typeof viewDate!=="undefined"&&viewDate)||((__state&&__state.date)||new Date().toISOString().split("T")[0]);
  const normalizedOpts={...opts,sourceDate:opts.sourceDate||opts.completionDate||fallbackDate,completedAt:opts.completedAt||new Date().toISOString()};
  // A rollup container's bonus must dedupe across calendar dates: the default
  // ledger key is <sourceDate>:<id>, so unchecking a shell and re-completing it
  // under a different completion date would mint a fresh key and double-award.
  // Pin the key to the shell instance itself (ids are unique per instance).
  if(normalizedOpts.sourceKey==null&&window.TaskTypes&&window.TaskTypes.isRollup(ev))normalizedOpts.sourceKey="shell:"+ev.id;
  if(window.PetHome&&typeof window.PetHome.awardTask==="function"){
    window.PetHome.awardTask(ev,normalizedOpts).catch(()=>{});
  }
  // A scheduled reward parked on the itinerary burns when its task is completed.
  // Safe no-op for normal tasks (the endpoint only matches scheduled rewards by
  // block id) and idempotent (redeem is status-guarded).
  if(ev.source==="reward"||(Array.isArray(ev.tags)&&ev.tags.indexOf("reward")>=0)){
    fetch("/api/social/rewards/redeem-by-block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({blockId:ev.id})})
      .then(r=>r.ok?r.json():null)
      .then(res=>{
        if(res&&res.changed){
          if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Reward enjoyed 🎉","success");
          if(typeof window.loadRewardsQueue==="function")window.loadRewardsQueue();
        }
      }).catch(()=>{});
  }
  if(window.SlotRewards&&typeof window.SlotRewards.earnTaskCredit==="function"){
    window.SlotRewards.earnTaskCredit(ev,normalizedOpts).catch(e=>{
      if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Points queued; retrying in the background","info");
      console.warn("[points] award queued:",e&&e.message?e.message:e);
    });
  } else {
    try {
      const key="pa-slot-award-queue";
      const rows=JSON.parse(localStorage.getItem(key)||"[]");
      if(Array.isArray(rows)){
        const sourceKey=(normalizedOpts.sourceKey||normalizedOpts.source_key||normalizedOpts.sourceDate||"unknown")+":"+ev.id;
        const filtered=rows.filter(row=>{
          const rowTask=row&&row.task;
          const rowOpts=(row&&row.options)||{};
          const rowKey=(rowOpts.sourceKey||rowOpts.source_key||rowOpts.sourceDate||"unknown")+":"+(rowTask&&rowTask.id);
          return rowKey!==sourceKey;
        });
        filtered.push({task:ev,options:normalizedOpts,queuedAt:new Date().toISOString()});
        localStorage.setItem(key,JSON.stringify(filtered.slice(-100)));
        if(!normalizedOpts.silent&&typeof showToast==="function")showToast("Points queued; retrying when rewards load","info");
      }
    } catch(e) {}
  }
}

// When a parent task is completed:
//   - subtasks (its steps) complete too, recursively;
//   - unfinished ride-alongs (independent concurrent work) promote out to standalone tasks.
function _onParentCompleted(id){
  if(typeof scheduled==="undefined")return;
  // 1) Complete subtask descendants recursively (steps of a finished task).
  (function completeSubs(pid){
    scheduled.filter(c=>c.subtaskOf===pid).forEach(c=>{
      if(!manualDone.has(c.id)){manualDone.add(c.id);doneAt[c.id]=new Date();}
      completeSubs(c.id);
    });
  })(id);
  // 2) Promote unfinished ride-alongs to standalone open tasks. Rollup
  // containers (shells) never eject their children — they can only complete
  // when every child is already done, so there is nothing to promote.
  const _parentEv=scheduled.find(e=>e.id===id);
  if(_parentEv&&window.TaskTypes&&window.TaskTypes.isRollup(_parentEv)){
    if(typeof recalcTimes==="function")recalcTimes();
    return;
  }
  let promoted=0;
  scheduled.filter(c=>c.wrapId===id&&!isDone(c)).forEach(c=>{
    c.wrapId=null;
    if(typeof _clearPin==="function")_clearPin(c);
    if(typeof _persistEvWrap==="function")_persistEvWrap(c);
    promoted++;
  });
  if(typeof recalcTimes==="function")recalcTimes();
  if(promoted&&typeof showToast==="function")showToast(promoted+" stacked task"+(promoted>1?"s":"")+" moved out of the completed task","info",2600);
}
function toggleDone(id,opts){
  opts=opts||{};
  if(manualDone.has(id)){
    manualDone.delete(id);delete doneAt[id];log("unchecked",id);
    saveDoneState();render();return;
  }

  // A rollup container (shell) can't be checked while children are open — its
  // bonus depends on ALL children finishing, and it auto-completes when the
  // last one does (that path bypasses this via opts._fromAutoComplete).
  if(!opts._fromAutoComplete&&window.TaskTypes&&typeof childrenOf==="function"){
    const shellEv=scheduled.find(e=>e.id===id);
    if(shellEv&&window.TaskTypes.rule(shellEv,"blockManualCompleteWithOpenChildren")){
      const open=childrenOf(id,scheduled).filter(c=>!isDone(c)).length;
      if(open){
        if(typeof showToast==="function")showToast("Finish its "+open+" remaining task"+(open>1?"s":"")+" first","info",2600);
        return;
      }
    }
  }

  // Caller forced a specific completion date (Done-on-date confirmation flow)
  if(opts.markOnDate){
    if(opts.bringToToday&&typeof rescheduleTaskToDate==="function"){
      rescheduleTaskToDate(id,opts.markOnDate,{silent:true}).then(()=>commitDoneOnDate(id,opts.markOnDate));
    } else {
      commitDoneOnDate(id,opts.markOnDate);
    }
    return;
  }

  // Smart completion-date handling for non-today views.
  if(typeof _actualTodayStr==="function"){
    const today=_actualTodayStr();
    const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
    if(currentDate&&currentDate>today){
      // Future-day plans are editable pre-plans. If the user is intentionally
      // viewing that day and checks a task off, persist the completion there.
      const ev=scheduled.find(e=>e.id===id);
      const completedAt=new Date();
      const _award=_pointAwardOverride(id); // read pie BEFORE subtasks cascade
      const _cel=_beginCompletionCelebration(id);
      manualDone.add(id);doneAt[id]=completedAt;log("checked",id);
      _onParentCompleted(id);
      if(ev&&ev.responsibilityId&&typeof window.markResponsibilityTaskCompleted==="function")window.markResponsibilityTaskCompleted(ev);
      saveDoneState();render();
      _finishCompletionCelebration(_cel,id);
      awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:currentDate,completedAt:completedAt.toISOString(),awardPoints:_award});
      _autoCompleteShellAncestors(id,currentDate);
      if(typeof showToast==="function"){
        const label=(typeof _prettyDateLabel==="function")?_prettyDateLabel(currentDate):currentDate;
        showToast("Marked done on "+label,"success");
      }
      return;
    }
    if(currentDate&&currentDate<today){
      // Past: ask the user whether they did it today or back on the original date.
      if(typeof openCompletionDateConfirm==="function"){
        openCompletionDateConfirm(id,currentDate,today);
        return;
      }
      // Without the confirm modal available, fall through to default behavior.
    }
  }

  const ev=scheduled.find(e=>e.id===id);
  const completedAt=new Date();
  const _award=_pointAwardOverride(id); // read pie BEFORE subtasks cascade
  const _cel=_beginCompletionCelebration(id);
  manualDone.add(id);doneAt[id]=completedAt;log("checked",id);
  _onParentCompleted(id);
  if(ev&&ev.responsibilityId&&typeof window.markResponsibilityTaskCompleted==="function")window.markResponsibilityTaskCompleted(ev);
  saveDoneState();render();
  _finishCompletionCelebration(_cel,id);
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  awardSlotTaskCredit(ev||{id:id,title:"Task completed",type:"task"},{sourceDate:currentDate,completedAt:completedAt.toISOString(),awardPoints:_award});
  _autoCompleteShellAncestors(id,currentDate);
}
function adjustDur(id,delta){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const c=dur(ev),n=Math.max(1,c+delta);if(n===c)return;
  const s=pt(ev.start);ev.end=String(Math.floor((s+n)/60)).padStart(2,"0")+":"+String((s+n)%60).padStart(2,"0");
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();saveDurChanges();render()
}
function setDurAbsolute(id,newMin){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const n=Math.max(1,Math.round(newMin));
  const c=dur(ev);if(n===c)return;
  const s=pt(ev.start);ev.end=fmt(s+n);
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();saveDurChanges();render()
}
// ======== START TIME ADJUSTMENT ========
function openStartTimePicker(id, anchorEl){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  // Use the same clock face picker as the complete modal
  if(typeof openClockPicker==='function'){
    openClockPicker(ev.start, anchorEl, function(timeStr){
      pinStartTime(id, timeStr);
    });
  }
}
let PINNED_KEY = "pa-pinned-starts-" + ((__state && __state.date) ? __state.date : "unknown");
function loadPinnedStarts(){
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_pinnedStarts", null);
    if (v) return v;
  }
  try{return JSON.parse(localStorage.getItem(PINNED_KEY)||"{}")}catch(e){return{}}
}
function savePinnedStarts(data){
  if (_bsSaveProp("_pinnedStarts", data)) return;
  localStorage.setItem(PINNED_KEY,JSON.stringify(data)); scheduleIDBSave();
}

function pinStartTime(id,timeStr){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const s=pt(timeStr),d=dur(ev);
  ev.start=timeStr;ev.end=fmt(s+d);
  // Meetings hold their slot via fixedTime (isFixedTimeBlock), not the pin map —
  // recording a pin for them is meaningless and would clutter it. Every other
  // task pins so recalcTimes() won't overwrite the chosen start.
  if(!(typeof isFixedTimeBlock==="function"&&isFixedTimeBlock(ev))){
    ev._pinnedStart=timeStr;
    const pins=loadPinnedStarts(); pins[id]=timeStr; savePinnedStarts(pins);
  }
  log("pin-start",id,"Pinned start to "+timeStr);
  recalcTimes();render();
}
function unpinStartTime(id){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  delete ev._pinnedStart;
  const pins=loadPinnedStarts(); delete pins[id]; savePinnedStarts(pins);
  log("unpin-start",id,"Removed start pin");
  recalcTimes();render();
}

// ======== TASK LOCK ========
// Locked tasks behave like meetings: immovable in the cascade and not draggable.
// Unlike _pinnedStart (which a drag clears), _locked is sticky -- the user
// must explicitly unlock to move the task.
let LOCKED_KEY = "pa-locked-tasks-" + ((__state && __state.date) ? __state.date : "unknown");
function loadLockedSet(){
  if(window.USE_BLOCKSTORE && window.blockStore){
    const v=_bsProp("_lockedTasks",null);
    if(v)return Array.isArray(v)?v:Object.keys(v);
  }
  try{return JSON.parse(localStorage.getItem(LOCKED_KEY)||"[]")}catch(e){return[]}
}
function saveLockedSet(ids){
  if(_bsSaveProp("_lockedTasks",ids))return;
  localStorage.setItem(LOCKED_KEY,JSON.stringify(ids));scheduleIDBSave();
}
function toggleLock(id){
  const ev=scheduled.find(e=>e.id===id);if(!ev||isMeeting(ev))return;
  const set=new Set(loadLockedSet());
  if(ev._locked){
    delete ev._locked;
    set.delete(id);
    log("unlock",id,"Unlocked: "+ev.title);
  } else {
    ev._locked=true;
    set.add(id);
    log("lock",id,"Locked at "+ev.start+": "+ev.title);
  }
  saveLockedSet([...set]);
  recalcTimes();render();
}
// Apply persisted locks to in-memory schedule items (called on boot + date switch).
function hydrateLockedTasks(){
  const ids=loadLockedSet();
  if(!ids||!ids.length)return;
  const idSet=new Set(ids);
  scheduled.forEach(ev=>{ if(idSet.has(ev.id)) ev._locked=true; });
}

// opts (drag drops): {targetId, after, orderWins} — place the new task at the
// drop position instead of the end, then chain-reflow. Button callers pass nothing.
function addToSchedule(blId,opts){
  opts=opts||{};
  let idx=consider.findIndex(b=>b.id===blId),task,fromBacklog=false;
  if(idx!==-1){task=consider.splice(idx,1)[0]}else{idx=backlog.findIndex(b=>b.id===blId);if(idx===-1)return;task=backlog.splice(idx,1)[0];fromBacklog=true}
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+task.durMin;
  const newItem={id:task.id,title:task.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:task.type,meta:task.meta,detail:task.detail||"",source:task.source||"notion",notionUrl:task.notionUrl||"",priority:task.priority,commuteMinutes:task.commuteMinutes||null,commuteToMinutes:task.commuteToMinutes||task.commuteMinutes||null,commuteBackMinutes:task.commuteBackMinutes||task.commuteReturnMinutes||null};
  scheduled.push(newItem);
  if(opts.targetId&&typeof _reorderActive==="function")_reorderActive(newItem.id,opts.targetId,opts.after);
  if(fromBacklog)deleteBacklogBlock(blId);
  // Persist as a scheduled block so the move survives reload (the backlog block is gone now).
  if(typeof persistAddedTask==="function")persistAddedTask(newItem);
  recalcTimes(opts.orderWins?{orderWins:true}:undefined);log("scheduled",task.id,"Added: "+task.title);render()
}
function addFollowupToSchedule(fu,parentId){
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+(fu.durMin||30);
  const newItem={id:fu.id||"fu-"+(nextId++),title:fu.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:"task",meta:(fu.durMin||30)+"min \u00b7 Action item from "+parentId,detail:fu.detail||"",source:fu.source||"notion",notionUrl:fu.href||"",priority:fu.priority||"Medium"};
  scheduled.push(newItem);
  // Remove from parent followups
  const parent=scheduled.find(x=>x.id===parentId);
  if(parent&&parent.followups){parent.followups=parent.followups.filter(f=>f.id!==fu.id)}
  // Persist so the followup-as-scheduled-task survives reload (parity with insertTaskNow / addToSchedule).
  if(typeof persistAddedTask==="function")persistAddedTask(newItem);
  recalcTimes();log("scheduled",fu.id,"Action item: "+fu.title);render()
}
// ======== BACKLOG PERSISTENCE ========
// Backlog items live in window.blockStore as type="block" with kind="backlog".
// Hydrated on boot via hydrateBacklogFromBlocks() (called from persistence.js).
function persistBacklogItem(item){
  if(!window.blockStore)return;
  try{
    window.blockStore.createBlock("block",{
      local_id:item.id,
      kind:"backlog",
      title:item.title,
      durMin:item.durMin,
      type:item.type||"task",
      meta:item.meta||"",
      detail:item.detail||"",
      source:item.source||"manual",
      notionUrl:item.notionUrl||"",
      priority:item.priority||"",
      stage:item.stage||"",
      commuteMinutes:item.commuteMinutes||null,
      commuteToMinutes:item.commuteToMinutes||item.commuteMinutes||null,
      commuteBackMinutes:item.commuteBackMinutes||item.commuteReturnMinutes||null,
      added_at:new Date().toISOString()
    },{date:null});
  }catch(e){console.warn("[backlog] persist failed:",e)}
}
function deleteBacklogBlock(localId){
  if(!window.blockStore)return;
  try{
    const block=window.blockStore.getByType("block").find(b=>(b.properties||{}).kind==="backlog"&&(b.properties||{}).local_id===localId);
    if(block)window.blockStore.deleteBlock(block.id).catch(()=>{});
  }catch(e){console.warn("[backlog] delete failed:",e)}
}
function hydrateBacklogFromBlocks(){
  if(!window.blockStore)return;
  let added=0;
  window.blockStore.getByType("block").forEach(b=>{
    const p=b.properties||{};
    if(p.kind!=="backlog")return;
    if(p.status==="archived"||p.status==="done")return;
    if(!p.title)return;
    const localId=p.local_id||("blk-"+b.id);
    if(backlog.find(x=>x.id===localId))return;
    backlog.push({
      id:localId,
      title:p.title,
      type:p.type||"task",
      durMin:p.durMin||30,
      meta:p.meta||("Custom task \u00b7 "+ms(p.durMin||30)),
      detail:p.detail||"",
      source:p.source||"manual",
      notionUrl:p.notionUrl||"",
      priority:p.priority||"",
      stage:p.stage||"",
      commuteMinutes:p.commuteMinutes||null,
      commuteToMinutes:p.commuteToMinutes||p.commuteMinutes||null,
      commuteBackMinutes:p.commuteBackMinutes||p.commuteReturnMinutes||null,
      createdAt:b.created_at||p.added_at||"",
      updatedAt:b.updated_at||p.updated_at||"",
      _blockId:b.id,
      sortOrder:b.sort_order
    });
    added++;
  });
  return added;
}

function addNewTask(titleArg, durMinArg){
  const title=titleArg||(function(){const inp=document.getElementById("new-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  const durMin=durMinArg||30;
  const item={id:"custom-"+(nextId++),title,type:"task",durMin,meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",notionUrl:""};
  backlog.push(item);
  persistBacklogItem(item);
  log("created","custom","New backlog: "+title);render()
}
// ======== UNIVERSAL TASK ADD BAR ========
function addTaskUniversal(barEl){
  const inp=barEl.querySelector(".tab-title");
  const title=inp.value.trim();
  if(!title){_flashBlankTitle(barEl,()=>addTaskUniversal(barEl));return}
  const durMin=parseInt(barEl.querySelector(".tab-dur").value)||30;
  const dest=barEl.querySelector(".tab-dest").value;
  // "Schedule…" defers the clear to commit time so dismissing the popover
  // doesn't eat the typed title; every other destination commits right here.
  if(dest!=="schedule")inp.value="";
  // Snap the type back to Urgent so successive adds always default to Urgent
  // rather than sticking on whatever the user last picked.
  const destSel=barEl.querySelector(".tab-dest");
  if(destSel)destSel.value="urgent";
  switch(dest){
    case"schedule":
      openSchedulePopover({mode:"create",title,durMin,
        anchorEl:barEl.querySelector(".tab-add")||barEl,
        options:{sourceBar:barEl},
        onCommitted:()=>{const i=barEl.querySelector(".tab-title");if(i&&i.value.trim()===title)i.value="";}});
      break;
    case"backlog":addNewTask(title,durMin);break;
    case"urgent":insertTaskNow(title,durMin);break;
    // Retro-logging: the task already happened — create it and check it off in
    // one gesture so points/streaks/persistence flow through the normal path.
    case"done":insertTaskNow(title,durMin,{onScheduled:r=>{if(r&&r.localId&&typeof toggleDone==="function")toggleDone(r.localId);}});break;
    case"shell":insertTaskNow(title,durMin,{type:"shell"});break;
    // Wrap: a container that earns its own points (a long focus block); children
    // ride along. insertTaskNow flags it isWrap from birth (dragMovesSubtree).
    case"wrap":insertTaskNow(title,durMin,{type:"wrap"});break;
    // Habit: recurring earn; the row grows a streak chip from prior completions.
    case"habit":insertTaskNow(title,durMin,{type:"habit"});break;
    // Manually-added meeting: no source_id, so the calendar materializer never
    // touches it. Fixed-time (reflow-exempt) but user-movable, like a synced one.
    case"meeting":insertTaskNow(title,durMin,{type:"meeting"});break;
    case"side_project":{
      if(typeof addSideProjectTask==="function")addSideProjectTask(title,durMin);
      break;
    }
    case"repeat_responsibility":{
      if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask({title,type:"task",durMin,source:"manual"});
      else if(typeof showToast==="function")showToast("Repeat responsibilities are still loading. Try again in a moment.","info");
      break;
    }
    case"delegated":{
      if(typeof openDelegatedFromTask==="function")openDelegatedFromTask({title,durMin});
      else if(typeof showToast==="function")showToast("Delegated / Blocked is still loading. Try again in a moment.","info");
      break;
    }
    case"trivial":{
      if(typeof addSideProjectTask==="function")addSideProjectTask(title,durMin);
      break;
    }
  }
}

// ======== SCHEDULE-AT PICKER (2-step) ========
// Step 1 picks a day (Today / Tomorrow / a date). Step 2 ("After…") offers the
// user's default time presets plus every task already on that day, so a new
// task can be dropped right after an existing one ends. Whatever anchor is
// chosen resolves to a concrete HH:MM start time; if that day is the one being
// viewed the task is inserted live with a pinned start, otherwise it's
// persisted to the blockstore under that date. Default time presets are
// customizable from Settings → "Schedule default times".

const SCHED_TIME_PRESETS_KEY="dcc-sched-time-presets";
const SCHED_TIME_PRESETS_DEFAULT=["08:00","12:00","17:00"];
function loadSchedTimePresets(){
  try{
    const raw=JSON.parse(localStorage.getItem(SCHED_TIME_PRESETS_KEY)||"null");
    if(Array.isArray(raw)){
      const clean=raw.filter(t=>/^\d{2}:\d{2}$/.test(t));
      if(clean.length)return clean;
    }
  }catch(e){}
  return SCHED_TIME_PRESETS_DEFAULT.slice();
}
function saveSchedTimePresets(arr){
  const clean=(arr||[]).filter(t=>/^\d{2}:\d{2}$/.test(t));
  const uniq=[...new Set(clean)].sort();
  try{localStorage.setItem(SCHED_TIME_PRESETS_KEY,JSON.stringify(uniq))}catch(e){}
  return uniq;
}
// 12-hour label for an HH:MM string (e.g. "08:00" -> "8 AM", "17:30" -> "5:30 PM")
function _schedTimeLabel(hhmm){
  const m=pt(hhmm);if(isNaN(m))return hhmm;
  let h=Math.floor(m/60);const min=m%60;const ap=h>=12?"PM":"AM";
  h=h%12;if(h===0)h=12;
  return h+(min?":"+String(min).padStart(2,"0"):"")+" "+ap;
}

let _schedPickerTitle="",_schedPickerDur=30,_schedPickerOptions={},_schedPickerDate="";
let _schedPickerOnPlace=null,_schedPickerVerb="";
function _schedSetHeader(verb){
  const overlay=document.getElementById("sched-picker-overlay");
  const hdr=overlay&&overlay.querySelector(".sched-picker-hdr h3");
  if(hdr)hdr.textContent=(verb||"Schedule")+" task";
}
function openSchedulePicker(title,durMin,options){
  _schedPickerTitle=title;
  _schedPickerDur=durMin||30;
  _schedPickerOptions=options||{};
  _schedPickerDate="";
  _schedPickerOnPlace=null;_schedPickerVerb="";
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){
    // Fallback if modal markup isn't present: schedule after current.
    insertTaskNow(title,durMin);
    return;
  }
  _schedSetHeader("Schedule");
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.value=title;
  _schedShowStep("day");
  const dateInput=document.getElementById("sched-date-input");
  if(dateInput){dateInput.style.display="none";dateInput.value="";}
  overlay.classList.add("open");
}
// Placement mode: the SAME 2-step day → "After…" UI, generalized so any mover
// (reschedule popover, move menu, drag) resolves a day + concrete start time
// through one flow. cfg: {title, durMin, verb, day, onPlace(dateStr, timeStr)}.
// timeStr null means "earliest free slot" (the old auto-slot behavior).
// Passing cfg.day skips step 1 and lands on the placement step for that day;
// Back still returns to the day step so the user can change days.
function openPlacementPicker(cfg){
  cfg=cfg||{};
  const onPlace=typeof cfg.onPlace==="function"?cfg.onPlace:null;
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){if(onPlace)onPlace(cfg.day||_resolvedTodayDate(),null);return}
  _schedPickerTitle=cfg.title||"";
  _schedPickerDur=cfg.durMin||30;
  _schedPickerOptions={};
  _schedPickerDate="";
  _schedPickerOnPlace=onPlace;
  _schedPickerVerb=cfg.verb||"Move";
  _schedSetHeader(_schedPickerVerb);
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.value=_schedPickerTitle;
  const dateInput=document.getElementById("sched-date-input");
  if(dateInput){dateInput.style.display="none";dateInput.value="";}
  if(cfg.day)_schedPickDay(cfg.day);
  else _schedShowStep("day");
  overlay.classList.add("open");
}
function closeSchedulePicker(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(overlay)overlay.classList.remove("open");
  _schedPickerTitle="";_schedPickerDur=30;_schedPickerOptions={};_schedPickerDate="";
  _schedPickerOnPlace=null;_schedPickerVerb="";
}
function _schedShowStep(step){
  const dayEl=document.getElementById("sched-step-day");
  const afterEl=document.getElementById("sched-step-after");
  if(dayEl)dayEl.style.display=step==="day"?"flex":"none";
  if(afterEl)afterEl.style.display=step==="after"?"flex":"none";
}
// Lock in a day and advance to the "After…" step.
function _schedPickDay(dateStr){
  if(!dateStr)return;
  _schedPickerDate=dateStr;
  _schedShowStep("after");
  _renderSchedAfterStep(dateStr);
}
async function _renderSchedAfterStep(dateStr){
  const label=document.getElementById("sched-after-daylabel");
  if(label)label.textContent=" "+(typeof _prettyDateLabel==="function"?_prettyDateLabel(dateStr):dateStr);
  // Default time-preset chips
  const chipWrap=document.getElementById("sched-after-chips");
  if(chipWrap){
    chipWrap.innerHTML="";
    // Placement mode gets an "Earliest free" chip: the one-tap auto-slot the
    // old quick buttons did, for when the exact time doesn't matter.
    if(_schedPickerOnPlace){
      const b=document.createElement("button");
      b.type="button";b.className="sched-chip sched-chip-earliest";b.textContent="⚡ Earliest free";
      b.addEventListener("click",()=>_schedCommit(dateStr,null));
      chipWrap.appendChild(b);
    }
    loadSchedTimePresets().forEach(t=>{
      const b=document.createElement("button");
      b.type="button";b.className="sched-chip";b.textContent=_schedTimeLabel(t);
      b.addEventListener("click",()=>_schedCommit(dateStr,t));
      chipWrap.appendChild(b);
    });
  }
  // Every task already on that day, "After <title> · ends <end>"
  const taskWrap=document.getElementById("sched-after-tasks");
  if(taskWrap){
    taskWrap.innerHTML='<div class="sched-after-empty">Loading day&hellip;</div>';
    let items=[];
    try{items=await _schedDayTasks(dateStr)}catch(e){items=[]}
    // Guard against a stale render if the user navigated away meanwhile.
    if(_schedPickerDate!==dateStr)return;
    taskWrap.innerHTML="";
    if(!items.length){
      taskWrap.innerHTML='<div class="sched-after-empty">No tasks scheduled that day yet.</div>';
    }else{
      items.forEach(it=>{
        const b=document.createElement("button");
        b.type="button";b.className="sched-after-task";
        const t=document.createElement("span");t.className="sat-title";t.textContent="After "+it.title;
        const e=document.createElement("span");e.className="sat-end";e.textContent="ends "+_schedTimeLabel(it.end);
        b.appendChild(t);b.appendChild(e);
        b.addEventListener("click",()=>_schedCommit(dateStr,it.end));
        taskWrap.appendChild(b);
      });
    }
  }
}
// Collect {title,end} for tasks already on a date, sorted by end time. Uses the
// live in-memory schedule for the day currently being viewed, otherwise reads
// the day's state + persisted blocks from the API.
async function _schedDayTasks(dateStr){
  const out=[];
  const viewing=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((typeof __state!=="undefined"&&__state&&__state.date)?__state.date:null);
  const toHHMM=(typeof _toHHMM==="function")?_toHHMM:(s=>s);
  if(dateStr===viewing&&typeof scheduled!=="undefined"&&Array.isArray(scheduled)){
    scheduled.forEach(ev=>{if(ev&&ev.title&&ev.end)out.push({title:ev.title,end:toHHMM(ev.end)})});
  }else{
    // One shared day fetch: the same {state,blocks} the earliest-free slot math
    // reads, so the "After…" anchors and the landed slot can't diverge.
    const ctx=await window.DCC.getDayContext(dateStr);
    const timeline=(ctx&&ctx.state&&ctx.state.schedule&&ctx.state.schedule.timeline)||[];
    timeline.forEach(e=>{if(e&&e.title&&e.end&&e.type!=="break"&&e.type!=="ooo")out.push({title:e.title,end:toHHMM(e.end)})});
    // Tasks persisted directly to that date (added/scheduled blocks)
    ((ctx&&ctx.blocks)||[]).forEach(b=>{
      const p=(b&&(b.properties||b.props))||{};
      if(b&&!b.deleted_at&&p.title&&p.end)out.push({title:p.title,end:toHHMM(p.end)});
    });
  }
  // Dedup by title+end, drop entries with an unparseable end, sort by end time.
  const seen=new Set();const uniq=[];
  out.forEach(it=>{
    if(isNaN(pt(it.end)))return;
    const k=it.title+"@"+it.end;
    if(!seen.has(k)){seen.add(k);uniq.push(it)}
  });
  uniq.sort((a,b)=>pt(a.end)-pt(b.end));
  return uniq;
}
// Resolve the chosen day+time: hand it to the placement callback (movers) or
// create the scheduled task (the original create flow), then close.
function _schedCommit(dateStr,timeStr){
  // The title is editable in the modal; whatever it says at commit time wins.
  const title=(_schedPickerTitle||"").trim()||"Untitled task";
  const durMin=_schedPickerDur,options=_schedPickerOptions;
  const onPlace=_schedPickerOnPlace;
  const bar=options&&options.sourceBar;
  closeSchedulePicker();
  if(onPlace){onPlace(dateStr,timeStr,title);return}
  commitScheduledTask(title,durMin,dateStr,timeStr,options);
  if(bar){const inp=bar.querySelector(".tab-title");if(inp){inp.value="";inp.classList.remove("tab-error");}}
}
function schedulePickerFields(durMin,options){
  options=options||{};
  // Shared value fields come from the one serializer (meta keeps its picker
  // default); responsibility metadata is picker-specific and layered on top.
  // IMPORTANT: this bag is merged as the SOURCE over a base that already holds
  // the positional title (Object.assign({id,title,...}, schedulePickerFields()))
  // so it must NOT carry a title key, or it would clobber the real title with
  // taskCommonProps's "" default. Drop it, matching the original behavior.
  const common=window.DCC.taskCommonProps(options,{meta:options.meta||("Custom task · "+ms(durMin))});
  delete common.title;
  return Object.assign(common,{
    responsibilityId:options.responsibilityId||null,
    responsibilityTitle:options.responsibilityTitle||null,
    capacityBucket:options.capacityBucket||null,
    idempotency_key:options.idempotencyKey||options.idempotency_key||null
  });
}
// Resolve a chosen day (dateStr) + time (HH:MM) into a real task. If that day is
// the one currently being viewed, insert it live with a pinned start; otherwise
// persist it to the blockstore (or a per-date localStorage bucket) for that day.
function commitScheduledTask(title,durMin,dateStr,timeStr,options){
  options=options||{};
  if(!title||!dateStr||!timeStr)return;
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)
    ?viewDate:((typeof __state!=="undefined"&&__state&&__state.date)?__state.date:null);
  if(dateStr===currentDate){
    // Same day: insert into schedule and pin the start time to the chosen time
    const id=qaId();
    const s=pt(timeStr);
    const _type=options.type||"task";
    const newItem=Object.assign({id,title,type:_type,start:timeStr,end:fmt(s+durMin),
      // Rollup containers are wraps from birth so drag carries their children.
      isWrap:(window.TaskTypes&&window.TaskTypes.rule(_type,"dragMovesSubtree"))||undefined,
      _pinnedStart:timeStr},schedulePickerFields(durMin,options));
    // Insert in chronological order based on pinned start
    let insertAt=scheduled.findIndex(ev=>pt(ev.start)>=s);
    if(insertAt===-1)insertAt=scheduled.length;
    scheduled.splice(insertAt,0,newItem);
    const pins=loadPinnedStarts();pins[id]=timeStr;savePinnedStarts(pins);
    recalcTimes();
    // Single record: persistAddedTask's dated block. (A savePendingTasks push
    // here used to mint an orphaned dateless pending_task twin.)
    persistAddedTask(newItem);
    log("scheduled",id,"Scheduled at "+timeStr+": "+title);
    render();
    checkBlockWarnings(newItem);
    if(typeof options.onScheduled==="function"){
      try{options.onScheduled({localId:id,blockId:id,start:timeStr,dateStr});}catch(e){}
    }
  } else {
    // Different day: persist to blockstore for that target date
    const id=qaId();
    const _type=options.type||"task";
    const newItem=Object.assign({id,title,type:_type,start:timeStr,end:fmt(pt(timeStr)+durMin),
      isWrap:(window.TaskTypes&&window.TaskTypes.rule(_type,"dragMovesSubtree"))||undefined},
      schedulePickerFields(durMin,options));
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      const bprops=Object.assign(
        window.DCC.taskBlockProps(newItem,{local_id:id,duration:durMin,start:timeStr,end:newItem.end}),
        {_pinnedStart:timeStr,added_at:new Date().toISOString()}
      );
      window.blockStore.createBlock("block",bprops,{date:dateStr});
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
      render();
    } else {
      // Fallback: store in a per-date localStorage bucket so it's not lost
      const key="pa-added-tasks-"+dateStr;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){arr=[]}
      arr.push(Object.assign(
        window.DCC.taskCommonProps(newItem),
        {id,durMin,start:timeStr,end:newItem.end,_pinnedStart:timeStr,addedAt:new Date().toISOString()}
      ));
      localStorage.setItem(key,JSON.stringify(arr));
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
    }
    if(typeof options.onScheduled==="function"){
      try{options.onScheduled({localId:id,blockId:id,start:timeStr,dateStr});}catch(e){}
    }
  }
}

// Wire up the 2-step schedule picker.
(function(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay)return;
  // The title is a live input in both modes: edits flow into the commit
  // (create) or into a rename that precedes the move (placement).
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.addEventListener("input",()=>{_schedPickerTitle=titleEl.value});
  const closeBtn=document.getElementById("sched-picker-close");
  if(closeBtn)closeBtn.addEventListener("click",closeSchedulePicker);
  overlay.addEventListener("click",e=>{if(e.target===overlay)closeSchedulePicker()});
  // Step 1: Today / Tomorrow
  overlay.querySelectorAll("[data-sched-day]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const tok=btn.getAttribute("data-sched-day");
      const d=tok==="today"?_resolvedTodayDate():tok==="tomorrow"?_resolvedTomorrowDate():null;
      if(d)_schedPickDay(d);
    });
  });
  // Step 1: pick an arbitrary date
  const pickDateBtn=document.getElementById("sched-pick-date-btn");
  const dateInput=document.getElementById("sched-date-input");
  if(pickDateBtn&&dateInput){
    // The shared picker (time-picker.js) auto-enhances #sched-date-input into a
    // hidden field; this button is its external trigger and opens the calendar.
    pickDateBtn.addEventListener("click",()=>{
      if(typeof dateInput.__twOpen==="function")dateInput.__twOpen(pickDateBtn);
      else{try{dateInput.showPicker?dateInput.showPicker():dateInput.focus()}catch(e){dateInput.focus()}}
    });
    dateInput.addEventListener("change",()=>{if(dateInput.value)_schedPickDay(dateInput.value)});
  }
  // Step 2: back + custom time
  const backBtn=document.getElementById("sched-after-back");
  if(backBtn)backBtn.addEventListener("click",()=>_schedShowStep("day"));
  const customGo=document.getElementById("sched-custom-go");
  const customTime=document.getElementById("sched-custom-time");
  const commitCustom=()=>{if(customTime&&customTime.value&&_schedPickerDate)_schedCommit(_schedPickerDate,customTime.value)};
  if(customGo)customGo.addEventListener("click",commitCustom);
  if(customTime)customTime.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();commitCustom()}});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&overlay.classList.contains("open"))closeSchedulePicker()});
})();

// Settings → "Schedule default times": customize the After-step time presets.
function _renderSchedDefaultsList(){
  const wrap=document.getElementById("sched-defaults-list");
  if(!wrap)return;
  wrap.innerHTML="";
  const presets=loadSchedTimePresets();
  if(!presets.length){wrap.innerHTML='<div class="sched-after-empty">No times yet — add one below.</div>';return}
  presets.forEach(t=>{
    const chip=document.createElement("span");chip.className="sched-default-chip";
    const lbl=document.createElement("span");lbl.textContent=_schedTimeLabel(t);
    const rm=document.createElement("button");rm.type="button";rm.textContent="×";rm.title="Remove";
    rm.addEventListener("click",()=>{saveSchedTimePresets(presets.filter(x=>x!==t));_renderSchedDefaultsList()});
    chip.appendChild(lbl);chip.appendChild(rm);wrap.appendChild(chip);
  });
}
function openSchedDefaults(){
  const ov=document.getElementById("sched-defaults-overlay");
  if(!ov)return;_renderSchedDefaultsList();ov.classList.add("open");
}
function closeSchedDefaults(){const ov=document.getElementById("sched-defaults-overlay");if(ov)ov.classList.remove("open")}
(function(){
  const menuItem=document.getElementById("dcc-schedule-defaults");
  if(menuItem)menuItem.addEventListener("click",()=>{
    const wrap=document.getElementById("dcc-settings-wrap");if(wrap)wrap.classList.remove("open");
    openSchedDefaults();
  });
  const ov=document.getElementById("sched-defaults-overlay");
  if(!ov)return;
  const closeBtn=document.getElementById("sched-defaults-close");
  if(closeBtn)closeBtn.addEventListener("click",closeSchedDefaults);
  ov.addEventListener("click",e=>{if(e.target===ov)closeSchedDefaults()});
  const addBtn=document.getElementById("sched-defaults-add");
  const addTime=document.getElementById("sched-defaults-add-time");
  const doAdd=()=>{if(!addTime||!addTime.value)return;const cur=loadSchedTimePresets();cur.push(addTime.value);saveSchedTimePresets(cur);addTime.value="";if(typeof addTime.__twRender==="function")addTime.__twRender();_renderSchedDefaultsList()};
  if(addBtn)addBtn.addEventListener("click",doAdd);
  if(addTime)addTime.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();doAdd()}});
  const resetBtn=document.getElementById("sched-defaults-reset");
  if(resetBtn)resetBtn.addEventListener("click",()=>{saveSchedTimePresets(SCHED_TIME_PRESETS_DEFAULT.slice());_renderSchedDefaultsList()});
  const saveBtn=document.getElementById("sched-defaults-save");
  if(saveBtn)saveBtn.addEventListener("click",closeSchedDefaults);
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&ov.classList.contains("open"))closeSchedDefaults()});
})();
// ======== TASK DESTINATIONS (shared registry + radial menu) ========
// One list drives every task-add bar, so new destinations (like Shell) show up
// everywhere at once instead of drifting per-bar. The old <select> stays in
// the DOM (hidden) as the value store addTaskUniversal reads; the radial menu
// just sets it.
const TASK_DESTINATIONS=[
  {value:"urgent",  icon:"⚡", label:"Urgent"},
  {value:"done",    icon:"✅", label:"Completed"},
  {value:"schedule",icon:"📅", label:"Schedule…"},
  {value:"backlog", icon:"💡", label:"Backlog / Idea"},
  {value:"shell",   icon:"🐚", label:"Shell"},
  {value:"wrap",    icon:"🎁", label:"Wrap"},
  {value:"habit",   icon:"🔁", label:"Habit"},
  {value:"meeting", icon:"👥", label:"Meeting"}
];
function _destMeta(value){return TASK_DESTINATIONS.find(d=>d.value===value)||TASK_DESTINATIONS[0]}
// Blank title isn't a silent dead end: flash the input AND offer, via a toast
// action, to proceed as an untitled task. onProceed resumes whatever the user
// was doing (opening the radial, or committing an already-picked destination).
function _flashBlankTitle(barEl,onProceed){
  const inp=barEl.querySelector(".tab-title");
  if(inp){inp.classList.add("tab-error");setTimeout(()=>inp.classList.remove("tab-error"),400);inp.focus();}
  if(typeof showToast==="function"){
    showToast("Task title is blank","error",6000,{
      label:"Create untitled task",
      onClick:()=>{
        if(inp)inp.value="Untitled task";
        if(typeof onProceed==="function")onProceed();
      }
    });
  }
}
// The fan itself lives in radial-menu.js (generic engine); these wrappers keep
// the destination semantics — map TASK_DESTINATIONS to items whose default
// pick commits the add through the hidden select + addTaskUniversal.
function _destItems(bar,sel,opts){
  return TASK_DESTINATIONS.map(d=>({icon:d.icon,label:d.label,
    onPick:()=>{
      if(opts&&typeof opts.onPick==="function"){opts.onPick(d);return}
      sel.value=d.value;
      addTaskUniversal(bar);
    }}));
}
function _closeDestRadial(){closeRadialMenu()}
function initDestRadial(bar){
  const sel=bar.querySelector(".tab-dest");
  if(!sel)return;
  // Every bar offers the full destination set, even where markup predates one.
  TASK_DESTINATIONS.forEach(d=>{
    if(!sel.querySelector('option[value="'+d.value+'"]')){
      const o=document.createElement("option");o.value=d.value;o.textContent=d.label;sel.appendChild(o);
    }
  });
  sel.style.display="none";
  // "+ Add" is the ONE button: click fans out the destinations, and picking a
  // destination commits the add in the same gesture (no separate submit).
  const addBtn=bar.querySelector(".tab-add");
  const inp=bar.querySelector(".tab-title");
  if(!addBtn)return;
  const openOrFlash=()=>{
    _hideDestPreview();
    if(document.querySelector(".dest-radial-backdrop")){_closeDestRadial();return}
    // Armed bar (FAB flow: type was chosen FIRST): + Add commits straight to
    // the armed destination, no second radial.
    const armed=bar.dataset.armedDest;
    if(armed){
      sel.value=armed;
      addTaskUniversal(bar);
      return;
    }
    const title=inp?inp.value.trim():"";
    if(!title){
      _flashBlankTitle(bar,()=>_openDestRadial(bar,sel,addBtn));
      return;
    }
    _openDestRadial(bar,sel,addBtn);
  };
  addBtn.addEventListener("click",e=>{e.stopPropagation();openOrFlash()});
  if(inp)inp.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();openOrFlash()}});
  // Hover teaser: a small radial "toast" previewing exactly what will fan out
  // on click. Hovering ONTO the teaser promotes it to the full interactive
  // radial, so both paths (click, or hover-then-hover) reach a pick.
  // Armed bars skip the teaser — + Add commits directly there.
  let hoverTimer=null;
  addBtn.addEventListener("mouseenter",()=>{
    clearTimeout(_destPreviewHideTimer);
    if(bar.dataset.armedDest)return;
    if(document.querySelector(".dest-radial-backdrop"))return;
    hoverTimer=setTimeout(()=>_showDestPreview(bar,sel,addBtn),220);
  });
  addBtn.addEventListener("mouseleave",()=>{
    clearTimeout(hoverTimer);
    // Grace window: the pointer needs time to cross the gap from the button
    // to a teaser dot without the preview vanishing underneath it.
    clearTimeout(_destPreviewHideTimer);
    _destPreviewHideTimer=setTimeout(_hideDestPreview,320);
  });
}
// The mini preview: engine-rendered dots; entering one expands to the real
// radial anchored on the same button. The grace timer lives here (shared with
// the initDestRadial mouseleave handlers).
let _destPreviewHideTimer=null;
function _showDestPreview(bar,sel,anchorBtn){
  showRadialMenuPreview(anchorBtn,_destItems(bar,sel),{
    onExpand:()=>{clearTimeout(_destPreviewHideTimer);_openDestRadial(bar,sel,anchorBtn)},
    onDotLeave:()=>{clearTimeout(_destPreviewHideTimer);_destPreviewHideTimer=setTimeout(_hideDestPreview,320)}
  });
}
function _hideDestPreview(){hideRadialMenuPreview()}
function _openDestRadial(bar,sel,trig,opts){
  opts=opts||{};
  // Picking a destination IS the submit — one gesture, committed — unless the
  // caller intercepts (e.g. the FAB arms the compose bar via opts.onPick).
  openRadialMenu(trig,_destItems(bar,sel,opts),{a0:opts.a0,a1:opts.a1});
}
// ── Armed compose (FAB choose-type-first flow) ──
// The launcher FAB fans out the destinations BEFORE the compose bar opens;
// the pick "arms" the bar: a chip shows the chosen type, and + Add / Enter
// commits straight to it. Clicking the chip re-opens the fan to switch type.
function _setDestArm(bar,destValue){
  bar.dataset.armedDest=destValue;
  const sel=bar.querySelector(".tab-dest");
  if(sel)sel.value=destValue;
  let chip=bar.querySelector(".dest-armed-chip");
  if(!chip){
    chip=document.createElement("button");
    chip.type="button";chip.className="dest-armed-chip";chip.title="Change task type";
    const inp=bar.querySelector(".tab-title");
    bar.insertBefore(chip,inp||bar.firstChild);
    chip.addEventListener("click",e=>{
      e.stopPropagation();
      _openDestRadial(bar,sel,chip,{onPick:d=>_setDestArm(bar,d.value)});
    });
  }
  const m=_destMeta(destValue);
  chip.innerHTML='<span class="dac-icon">'+m.icon+'</span><span class="dac-label">'+m.label+'</span>';
}
function _clearDestArm(bar){
  if(!bar)return;
  delete bar.dataset.armedDest;
  const chip=bar.querySelector(".dest-armed-chip");
  if(chip)chip.remove();
}
// Called by launcher.js on a quick FAB tap: destinations fan out from the FAB
// (up-left arc, it lives in the corner); the pick arms the bar then opens
// the compose. Dismissing the fan opens nothing.
function openDestRadialForLauncher(anchorBtn,onOpenCompose){
  const bar=document.getElementById("task-add-launcher");
  const sel=bar&&bar.querySelector(".tab-dest");
  if(!bar||!sel){if(typeof onOpenCompose==="function")onOpenCompose();return}
  _openDestRadial(bar,sel,anchorBtn,{a0:185,a1:268,onPick:d=>{
    _setDestArm(bar,d.value);
    if(typeof onOpenCompose==="function")onOpenCompose();
  }});
}
window.openDestRadialForLauncher=openDestRadialForLauncher;
window._clearDestArm=_clearDestArm;

// Wire up all task-add bars ("+ Add" opens the radial; Enter in the title too)
document.querySelectorAll(".task-add-bar").forEach(bar=>initDestRadial(bar));

// ======== UNIFIED BLOCK QUERY HELPERS ========
// All user data is type='block'. These helpers filter by property presence.
function _allBlocks(){
  if(!window.blockStore)return[];
  // Get from both caches — unified blocks may be in either
  const byType=window.blockStore.getByType("block");
  // Also include legacy types during migration transition
  const legacyTypes=["added_task","schedule_item","trivial_task","action_item","pending_task",
    "sticky_note","life_capture","engram","mood_entry","pomo_session","schedule_block","tag","note"];
  const legacy=legacyTypes.flatMap(t=>{try{return window.blockStore.getByType(t)}catch(e){return[]}});
  // Dedupe by id
  const seen=new Set();const result=[];
  [...byType,...legacy].forEach(b=>{if(!seen.has(b.id)){seen.add(b.id);result.push(b)}});
  return result;
}

function getScheduledBlocks(date){
  return _allBlocks().filter(b=>{
    const p=b.properties||{};
    // Unified: check scheduled_dates
    if(p.scheduled_dates&&p.scheduled_dates[date])return true;
    // Legacy: added_task/schedule_item blocks have start/end + date on the block itself
    if(b.date===date&&p.start&&p.end)return true;
    return false;
  });
}

function getBacklogBlocks(){
  return _allBlocks().filter(b=>{
    const p=b.properties||{};
    if(!p.title)return false;
    if(p.status==="archived"||p.status==="done")return false;
    // No scheduled_dates means backlog material
    if(p.scheduled_dates&&Object.keys(p.scheduled_dates).length>0)return false;
    // Legacy added_task/schedule_item blocks with start/end are scheduled, not backlog
    if(p.start&&p.end)return false;
    // Must not be trivial, action-item, pinned, or other special blocks
    const tags=p.tags||[];
    if(tags.includes("trivial")||tags.includes("side-project")||tags.includes("action-item")||tags.includes("pinned"))return false;
    // Must not be non-task blocks (notes, engrams, etc.)
    if(p.html&&!p.title)return false; // notes
    if(p.mood!==undefined&&!p.title)return false; // mood-only
    if(p.tag&&p.name&&!p.title)return false; // engram without title
    return true;
  });
}

function getBlocksByTag(tag){
  return _allBlocks().filter(b=>{
    const tags=(b.properties||{}).tags||[];
    return tags.includes(tag);
  });
}

function findBlockByTitle(title){
  if(!title)return null;
  const lower=title.toLowerCase().trim();
  return _allBlocks().find(b=>{
    const t=(b.properties||{}).title;
    return t&&t.toLowerCase().trim()===lower&&(b.properties||{}).status!=="archived";
  })||null;
}

function scheduleBlockOnDate(id, date, start, end){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(!p.scheduled_dates)p.scheduled_dates={};
  p.scheduled_dates[date]={start,end,done:false,pinned:false};
  window.blockStore.updateBlock(id,p);
}

function unscheduleBlockFromDate(id, date){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(p.scheduled_dates){
    delete p.scheduled_dates[date];
    if(Object.keys(p.scheduled_dates).length===0)delete p.scheduled_dates;
  }
  window.blockStore.updateBlock(id,p);
}

function markDoneOnDate(id, date){
  if(!window.blockStore)return;
  const block=window.blockStore.get(id);
  if(!block)return;
  const p={...(block.properties||{})};
  if(p.scheduled_dates&&p.scheduled_dates[date]){
    p.scheduled_dates[date]={...p.scheduled_dates[date],done:true,done_at:new Date().toISOString()};
    window.blockStore.updateBlock(id,p);
  }
}

// undoLast() and resetAll() removed Phase 6 -- both broken; see features.js.
// actionLog still populated by log() because updateSync() renders the header
// activity summary ("N done · N adj") from it (sync.js) -- that path is alive.
// (The Copy-for-Claude button that also read actionLog was removed 2026-07.)

// ======== TASK ORDER PERSISTENCE ========
let ORDER_KEY = "pa-task-order-" + ((__state && __state.date) ? __state.date : "unknown");
function loadTaskOrder(){
  if (window.USE_BLOCKSTORE && window.blockStore) {
    const v = _bsProp("_taskOrder", null);
    if (v && v.length) return v;
  }
  try{return JSON.parse(localStorage.getItem(ORDER_KEY)||"[]")}catch(e){return[]}
}
function saveTaskOrder(){
  const order=scheduled.filter(ev=>!isDone(ev)).map(ev=>ev.id);
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.reorder&&window.blockStore){
    // Save order to day_root for cross-device reads
    _bsSaveProp("_taskOrder", order);
    // Also update sort_order on task blocks
    const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).local_id&&(b.properties||{}).start)];
    if(addedBlocks.length){
      const orderMap={};order.forEach((id,i)=>{orderMap[id]=i});
      const items=addedBlocks
        .filter(b=>b.properties&&orderMap[b.properties.local_id]!==undefined)
        .map(b=>({id:b.id,sort_order:(orderMap[b.properties.local_id]+1)*1000}));
      if(items.length)window.blockStore.reorder(items).catch(()=>{});
    }
    return;
  }
  localStorage.setItem(ORDER_KEY,JSON.stringify(order)); scheduleIDBSave();
}

// ======== UNSCHEDULED (untimed) ORDER PERSISTENCE ========
// The Unscheduled section is drag-reorderable, but unlike the timed Work list
// its items hold no clock time — so their order can't ride the time cascade
// (recalcTimes skips untimed items). Persist an explicit id-list on the day_root
// (mirrors _subtaskOrder / _taskOrder) so a manual drag order survives reflows
// and reloads. Rendered by _orderUnscheduled (schedule-tab.js) in manual mode.
function loadUnscheduledOrder(){
  if(window.USE_BLOCKSTORE&&window.blockStore){
    const v=_bsProp("_unscheduledOrder",null);
    if(Array.isArray(v))return v;
  }
  try{return JSON.parse(localStorage.getItem("pa-unsched-order-"+((__state&&__state.date)||"unknown"))||"[]")}catch(e){return[]}
}
function saveUnscheduledOrder(){
  if(typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
  const order=scheduled
    .filter(ev=>ev&&ev.untimed&&!isDone(ev)&&!(typeof isDeleted==="function"&&isDeleted(ev)))
    .map(ev=>ev.id);
  if(!_bsSaveProp("_unscheduledOrder",order)){
    try{localStorage.setItem("pa-unsched-order-"+((__state&&__state.date)||"unknown"),JSON.stringify(order))}catch(e){}
  }
}

// ======== BLOCK BOUNDARY WARNINGS ========
function checkBlockWarnings(task){
  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  if(!blocks.length||!task) return;
  const taskStart=pt(task.start), taskEnd=pt(task.end);
  for(const b of blocks){
    const bStart=pt(b.start), bEnd=pt(b.end);
    const bt=b.blockType||b.type;
    // Protected boundary: warn if task overlaps a protected block
    if(b.protected && taskStart<bEnd && taskEnd>bStart && bt==='personal'){
      showToast("⚠ \""+task.title+"\" overlaps protected block \""+b.name+"\"","error",8000);
    }
    // Threshold warning: warn if remaining time in current block is low
    if(b.warnThreshold && b.warnThreshold>0){
      const now=new Date();
      const nowMin=now.getHours()*60+now.getMinutes();
      if(nowMin>=bStart && nowMin<bEnd){
        const remaining=bEnd-nowMin;
        if(remaining<=b.warnThreshold){
          showToast("⏱ Only "+remaining+"m left in \""+b.name+"\"","error",6000);
        }
      }
    }
  }
}
