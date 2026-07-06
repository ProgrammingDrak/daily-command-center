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
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
    // Write to blockstore — will be reloaded via property-based query on refresh
    const date=targetDate||((typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)?__state.date:null));
    return window.blockStore.createBlock("block",{
      kind:item.kind||undefined,
      local_id:item.id,
      type:item.type||"task",
      title:item.title,
      duration:dur(item),
      start:item.start,
      end:item.end,
      priority:item.priority||"High",
      meta:item.meta||"",
      detail:item.detail||"",
      notionUrl:item.notionUrl||"",
      calUrl:item.calUrl||"",
      source:item.source||"manual",
      tags:item.tags||[],
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
      id:item.id,title:item.title,type:item.type||"task",durMin:dur(item),
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
  // Match the date filter in reloadPersistedEdits — otherwise we'd rewrite start/end on blocks from other days.
  const currentDate=window.blockStore.getCurrentDate();
  const addedBlocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).local_id&&(b.properties||{}).start&&(!b.date||b.date===currentDate))];
  addedBlocks.forEach(block=>{
    const p=block.properties||{};
    const ev=scheduled.find(e=>e.id===p.local_id);
    if(!ev)return;
    if(p.start!==ev.start||p.end!==ev.end){
      window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end});
    }
  });
}

function insertTaskNow(titleArg, durMinArg, opts){
  opts=opts||{};
  const title=titleArg||(function(){const inp=document.getElementById("qa-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  const durMin=durMinArg||30;
  const id=qaId();

  // Pin start to the next free 15-minute slot from now, stepping past any
  // meeting block. Without a pin, recalcTimes() would cascade from the first
  // undone task -- which on an empty/sparse day collapses the urgent task to
  // 00:00.
  const roundTo15=m=>Math.ceil(m/15)*15;
  const meetings=_meetingBlocks();
  const startMin=_freeStart(roundTo15(now()),durMin,meetings);
  const startStr=fmt(startMin);

  const newItem=Object.assign({id,title,type:"task",start:startStr,end:fmt(startMin+durMin),
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
    .filter(ev=>!isDone(ev)&&!isPushed(ev)&&!isDeleted(ev)&&!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break")
    .reduce((max,ev)=>Math.max(max,pt(ev.end)),0);
  scheduled.splice(scheduled.indexOf(newItem), 1);
  recalcTimes(); // restore cascade without the new item

  // Always commit the task. (The old overflow-modal detour that staged a
  // "doesn't fit" task and asked you to push things to tomorrow was removed
  // 2026-07 -- tasks just get added; the day can run long.)
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const pins=loadPinnedStarts();pins[id]=startStr;savePinnedStarts(pins);
  persistAddedTask(newItem);
  const pending=loadPendingTasks();
  pending.push({id,title,priority:"High",source_task:"Task bar",
    source_task_id:"taskbar",created_at:new Date().toISOString(),status:"scheduled",_scheduled:true});
  savePendingTasks(pending);
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
}

// Points override for a completion, when the task participates in a parent's
// point pie. Returns:
//   - a parent's completion award (bonus + still-open subtask slices) when the
//     task has subtasks — MUST be read BEFORE _onParentCompleted cascades them;
//   - a subtask's own slice when it is a subtask of a parent;
//   - undefined for everything else (normal duration-based scoring), including
//     "stacked" (ride-along) tasks, whose points are independent.
function _pointAwardOverride(id){
  if(!window.PointPlan||typeof childrenOf!=="function"||typeof relOf!=="function")return undefined;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return undefined;
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
  // 2) Promote unfinished ride-alongs to standalone open tasks.
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
  ev._pinnedStart=timeStr;
  const s=pt(timeStr),d=dur(ev);
  ev.start=timeStr;ev.end=fmt(s+d);
  const pins=loadPinnedStarts(); pins[id]=timeStr; savePinnedStarts(pins);
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

function addToSchedule(blId){
  let idx=consider.findIndex(b=>b.id===blId),task,fromBacklog=false;
  if(idx!==-1){task=consider.splice(idx,1)[0]}else{idx=backlog.findIndex(b=>b.id===blId);if(idx===-1)return;task=backlog.splice(idx,1)[0];fromBacklog=true}
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+task.durMin;
  const newItem={id:task.id,title:task.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:task.type,meta:task.meta,detail:task.detail||"",source:task.source||"notion",notionUrl:task.notionUrl||"",priority:task.priority,commuteMinutes:task.commuteMinutes||null,commuteToMinutes:task.commuteToMinutes||task.commuteMinutes||null,commuteBackMinutes:task.commuteBackMinutes||task.commuteReturnMinutes||null};
  scheduled.push(newItem);
  if(fromBacklog)deleteBacklogBlock(blId);
  // Persist as a scheduled block so the move survives reload (the backlog block is gone now).
  if(typeof persistAddedTask==="function")persistAddedTask(newItem);
  recalcTimes();log("scheduled",task.id,"Added: "+task.title);render()
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
  if(!title){inp.classList.add("tab-error");setTimeout(()=>inp.classList.remove("tab-error"),400);inp.focus();return}
  const durMin=parseInt(barEl.querySelector(".tab-dur").value)||30;
  const dest=barEl.querySelector(".tab-dest").value;
  inp.value="";
  // Snap the type back to Urgent so successive adds always default to Urgent
  // rather than sticking on whatever the user last picked.
  const destSel=barEl.querySelector(".tab-dest");
  if(destSel)destSel.value="urgent";
  switch(dest){
    case"schedule":openSchedulePicker(title,durMin,{sourceBar:barEl});break;
    case"backlog":addNewTask(title,durMin);break;
    case"urgent":insertTaskNow(title,durMin);break;
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
function openSchedulePicker(title,durMin,options){
  _schedPickerTitle=title;
  _schedPickerDur=durMin||30;
  _schedPickerOptions=options||{};
  _schedPickerDate="";
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){
    // Fallback if modal markup isn't present: schedule after current.
    insertTaskNow(title,durMin);
    return;
  }
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.textContent=title;
  _schedShowStep("day");
  const dateInput=document.getElementById("sched-date-input");
  if(dateInput){dateInput.style.display="none";dateInput.value="";}
  overlay.classList.add("open");
}
function closeSchedulePicker(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(overlay)overlay.classList.remove("open");
  _schedPickerTitle="";_schedPickerDur=30;_schedPickerOptions={};_schedPickerDate="";
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
    let state=null;
    if(dateStr===__todayDate&&window.__DCC_STATE__)state=window.__DCC_STATE__;
    else if(dateStr===__tomorrowDate&&window.__DCC_TOMORROW__)state=window.__DCC_TOMORROW__;
    if(!state){try{state=await fetch("/api/state/day?date="+encodeURIComponent(dateStr)).then(r=>r.json())}catch(e){}}
    const timeline=(state&&state.schedule&&state.schedule.timeline)||[];
    timeline.forEach(e=>{if(e&&e.title&&e.end&&e.type!=="break"&&e.type!=="ooo")out.push({title:e.title,end:toHHMM(e.end)})});
    // Tasks persisted directly to that date (added/scheduled blocks)
    try{
      const blks=await fetch("/api/blocks?date="+encodeURIComponent(dateStr)).then(r=>r.json());
      (blks||[]).forEach(b=>{
        const p=(b&&(b.properties||b.props))||{};
        if(b&&!b.deleted_at&&p.title&&p.end)out.push({title:p.title,end:toHHMM(p.end)});
      });
    }catch(e){}
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
// Resolve the chosen day+time into an actual scheduled task, then close.
function _schedCommit(dateStr,timeStr){
  const title=_schedPickerTitle,durMin=_schedPickerDur,options=_schedPickerOptions;
  const bar=options&&options.sourceBar;
  closeSchedulePicker();
  commitScheduledTask(title,durMin,dateStr,timeStr,options);
  if(bar){const inp=bar.querySelector(".tab-title");if(inp){inp.value="";inp.classList.remove("tab-error");}}
}
function schedulePickerFields(durMin,options){
  options=options||{};
  return {
    meta:options.meta||("Custom task · "+ms(durMin)),
    detail:options.detail||"",
    source:options.source||"manual",
    notionUrl:options.notionUrl||"",
    priority:options.priority||"High",
    tags:Array.isArray(options.tags)?options.tags:[],
    delegatedItemId:options.delegatedItemId||null,
    linkedBlockId:options.linkedBlockId||null,
    linkedTagId:options.linkedTagId||null,
    responsibilityId:options.responsibilityId||null,
    responsibilityTitle:options.responsibilityTitle||null,
    capacityBucket:options.capacityBucket||null,
    commuteMinutes:options.commuteMinutes||options.commute_minutes||null,
    commuteToMinutes:options.commuteToMinutes||options.commute_to_minutes||options.commuteMinutes||options.commute_minutes||null,
    commuteBackMinutes:options.commuteBackMinutes||options.commute_back_minutes||options.commuteReturnMinutes||options.commute_return_minutes||null
  };
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
    const newItem=Object.assign({id,title,type:"task",start:timeStr,end:fmt(s+durMin),
      _pinnedStart:timeStr},schedulePickerFields(durMin,options));
    // Insert in chronological order based on pinned start
    let insertAt=scheduled.findIndex(ev=>pt(ev.start)>=s);
    if(insertAt===-1)insertAt=scheduled.length;
    scheduled.splice(insertAt,0,newItem);
    const pins=loadPinnedStarts();pins[id]=timeStr;savePinnedStarts(pins);
    recalcTimes();
    persistAddedTask(newItem);
    const pending=loadPendingTasks();
    pending.push({id,title,priority:"High",source_task:"Task bar",
      source_task_id:"taskbar",created_at:new Date().toISOString(),
      status:"scheduled",_scheduled:true});
    savePendingTasks(pending);
    log("scheduled",id,"Scheduled at "+timeStr+": "+title);
    render();
    checkBlockWarnings(newItem);
    if(typeof options.onScheduled==="function"){
      try{options.onScheduled({localId:id,blockId:id,start:timeStr,dateStr});}catch(e){}
    }
  } else {
    // Different day: persist to blockstore for that target date
    const id=qaId();
    const newItem=Object.assign({id,title,type:"task",start:timeStr,end:fmt(pt(timeStr)+durMin)},
      schedulePickerFields(durMin,options));
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      window.blockStore.createBlock("block",{
        local_id:id,title,duration:durMin,start:timeStr,end:newItem.end,
        priority:newItem.priority||"High",meta:newItem.meta,detail:newItem.detail||"",notionUrl:newItem.notionUrl||"",
        source:newItem.source||"manual",tags:newItem.tags||[],_pinnedStart:timeStr,
        delegatedItemId:newItem.delegatedItemId||null,
        linkedBlockId:newItem.linkedBlockId||null,
        linkedTagId:newItem.linkedTagId||null,
        commuteMinutes:newItem.commuteMinutes||null,
        commuteToMinutes:newItem.commuteToMinutes||newItem.commuteMinutes||null,
        commuteBackMinutes:newItem.commuteBackMinutes||newItem.commuteReturnMinutes||null,
        added_at:new Date().toISOString()
      },{date:dateStr});
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
      render();
    } else {
      // Fallback: store in a per-date localStorage bucket so it's not lost
      const key="pa-added-tasks-"+dateStr;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){arr=[]}
      arr.push({id,title,durMin,priority:newItem.priority||"High",source:newItem.source||"manual",meta:newItem.meta,
        detail:newItem.detail||"",notionUrl:newItem.notionUrl||"",start:timeStr,end:newItem.end,
        tags:newItem.tags||[],delegatedItemId:newItem.delegatedItemId||null,
        linkedBlockId:newItem.linkedBlockId||null,linkedTagId:newItem.linkedTagId||null,
        _pinnedStart:timeStr,commuteMinutes:newItem.commuteMinutes||null,commuteToMinutes:newItem.commuteToMinutes||newItem.commuteMinutes||null,commuteBackMinutes:newItem.commuteBackMinutes||newItem.commuteReturnMinutes||null,addedAt:new Date().toISOString()});
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
// Wire up all task-add bars
document.querySelectorAll(".task-add-bar").forEach(bar=>{
  bar.querySelector(".tab-add").addEventListener("click",()=>addTaskUniversal(bar));
  bar.querySelector(".tab-title").addEventListener("keydown",e=>{if(e.key==="Enter")addTaskUniversal(bar)});
  // Choosing "Schedule" in the priority dropdown opens the day/time picker right
  // away. The dropdown snaps back to Urgent (the picker holds the task), so the
  // bar is reset whether or not the user follows through.
  const dest=bar.querySelector(".tab-dest");
  if(dest)dest.addEventListener("change",()=>{
    if(dest.value!=="schedule")return;
    const inp=bar.querySelector(".tab-title");
    const title=inp?inp.value.trim():"";
    const durEl=bar.querySelector(".tab-dur");
    const durMin=(durEl&&parseInt(durEl.value))||30;
    dest.value="urgent";
    if(!title){
      if(inp){inp.classList.add("tab-error");setTimeout(()=>inp.classList.remove("tab-error"),400);inp.focus();}
      return;
    }
    openSchedulePicker(title,durMin,{sourceBar:bar});
  });
});

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
