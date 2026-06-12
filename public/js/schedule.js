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

let _overflowDeficit = 0;
let _overflowItems = [];
let _pendingNewTask = null; // task staged for add but not yet committed to scheduled

function checkOverflow(){
  // Only show overflow for today and tomorrow — archives are read-only, no point alerting
  if(typeof viewMode !== "undefined" && viewMode === "archive") return;

  // Find the last scheduled end time among non-done, non-pushed TASK items only.
  // Meetings are immovable — their end times should never count as user-controllable overflow.
  const active = scheduled.filter(ev=>!isDone(ev)&&!isPushed(ev)&&!isDeleted(ev));
  const taskActive = active.filter(ev=>!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break");
  const lastEnd = taskActive.reduce((max,ev)=>Math.max(max,pt(ev.end)),0);
  const overflow = lastEnd - EOD;
  if(overflow <= 0){
    const ov=document.getElementById("overflow-modal-overlay");
    if(ov&&ov.classList.contains("open"))closeOverflowModal();
    return;
  }
  openOverflowModal(overflow);
}

function openOverflowModal(deficitMinutes){
  _overflowDeficit = deficitMinutes;
  // Show ALL remaining tasks (not meetings/ooo), excluding any pending task (shown separately)
  _overflowItems = scheduled.filter(ev=>!isDone(ev)&&!isPushed(ev)&&!isDeleted(ev)&&!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break"
    &&(!_pendingNewTask||ev.id!==_pendingNewTask.id));

  const _overflowLabel = (typeof viewMode === "undefined" || viewMode === "today")
    ? "today's schedule"
    : (typeof dateToDisplay === "function" && typeof viewDate !== "undefined")
      ? dateToDisplay(viewDate) + "'s schedule"
      : "this day's schedule";
  const _overflowSub = (typeof viewMode !== "undefined" && viewMode === "tomorrow")
    ? "Check tasks to push out until you've freed enough time."
    : "Check tasks to push to tomorrow until you've freed enough time.";
  document.getElementById("overflow-new-task").textContent = "Need to free " + ms(deficitMinutes) + " to fit " + _overflowLabel;

  // Show or hide the pending new task section
  const pendingSection = document.getElementById("overflow-pending-section");
  if(_pendingNewTask && pendingSection){
    pendingSection.style.display = "";
    document.getElementById("overflow-pending-title").textContent = _pendingNewTask.title;
    document.getElementById("overflow-pending-dur").textContent = ms(dur(_pendingNewTask));
    const chk = document.getElementById("overflow-pending-chk");
    chk.dataset.id = _pendingNewTask.id;
    chk.dataset.dur = String(dur(_pendingNewTask));
    chk.checked = false;
    // Hide the generic sub-text when pending section has its own explanation
    document.getElementById("overflow-modal-sub").style.display = "none";
  } else {
    if(pendingSection) pendingSection.style.display = "none";
    document.getElementById("overflow-modal-sub").textContent = _overflowSub;
    document.getElementById("overflow-modal-sub").style.display = "";
  }

  const list=document.getElementById("overflow-task-list");
  list.innerHTML=_overflowItems.map(ev=>
    '<div class="overflow-task-row" data-row-id="'+ev.id+'">'+
      '<input type="checkbox" class="overflow-task-chk" data-id="'+ev.id+'" data-dur="'+dur(ev)+'" onchange="updateOverflowDeficit();this.closest(\'.overflow-task-row\').classList.toggle(\'checked\',this.checked)" />'+
      '<span class="overflow-task-title">'+ev.title+'</span>'+
      '<span class="overflow-task-dur">'+ms(dur(ev))+'</span>'+
      '<span class="overflow-task-time">'+f12(ev.start).replace(" ","").toLowerCase()+'</span>'+
    '</div>'
  ).join('');

  document.getElementById("overflow-push-btn").disabled = true;
  updateOverflowDeficit();
  document.getElementById("overflow-modal-overlay").classList.add("open");
}

function updateOverflowDeficit(){
  const checked=[...document.querySelectorAll(".overflow-task-chk:checked")];
  const freed=checked.reduce((sum,el)=>sum+parseInt(el.dataset.dur||"0"),0);
  const remaining=Math.max(0,_overflowDeficit-freed);
  const el=document.getElementById("overflow-deficit");
  if(remaining===0){
    el.textContent="\u2714 Ready \u2014 all time accounted for";
    el.className="overflow-deficit satisfied";
  } else {
    el.textContent=remaining+" min still needed";
    el.className="overflow-deficit";
  }
  document.getElementById("overflow-push-btn").disabled=(remaining>0);
}

function closeOverflowModal(){
  document.getElementById("overflow-modal-overlay").classList.remove("open");
  _overflowDeficit=0;
  _overflowItems=[];
  _pendingNewTask=null; // discard any uncommitted task — nothing added to schedule
  // A task committed by a non-urgent path (e.g. the Schedule picker) before the
  // overflow check triggered would have queued a deferred render while this
  // modal was open. Flush it now that the modal is closed so the task actually
  // appears on the timeline.
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
}

function pushSelectedToTomorrow(){
  const pendingChk = document.getElementById("overflow-pending-chk");
  const pushPendingTask = pendingChk && pendingChk.checked;

  // IDs of checked existing tasks (exclude the pending task checkbox — handled separately)
  const pendingId = _pendingNewTask ? _pendingNewTask.id : null;
  const checked = [...document.querySelectorAll(".overflow-task-chk:checked")]
    .map(el=>el.dataset.id)
    .filter(id=>id!==pendingId);

  if(!checked.length && !pushPendingTask && !_pendingNewTask){ closeOverflowModal(); return; }

  if(_pendingNewTask && !pushPendingTask){
    // User didn't push the new task -- commit it (they freed up enough room via other pushes)
    const item = (({_insertAt,...rest})=>rest)(_pendingNewTask);
    const insertAt = _pendingNewTask._insertAt;
    scheduled.splice(insertAt, 0, item);
    recalcTimes();
    if(item._pinnedStart){const pins=loadPinnedStarts();pins[item.id]=item._pinnedStart;savePinnedStarts(pins);}
    persistAddedTask(item);
    const pending=loadPendingTasks();
    pending.push({id:item.id,title:item.title,priority:"High",source_task:"Urgent bar",
      source_task_id:"urgent",created_at:new Date().toISOString(),status:"scheduled",_scheduled:true});
    savePendingTasks(pending);
    log("scheduled",item.id,"Quick-added: "+item.title);
  }
  // Push selected existing tasks
  checked.forEach(id=>pushTask(id));
  closeOverflowModal();
  recalcTimes();
  render();
}

function workLateOverflow(){
  // Commit the pending new task first (working late means we want it today)
  if(_pendingNewTask){
    const item = (({_insertAt,...rest})=>rest)(_pendingNewTask);
    const insertAt = _pendingNewTask._insertAt;
    scheduled.splice(insertAt, 0, item);
    recalcTimes();
    if(item._pinnedStart){const pins=loadPinnedStarts();pins[item.id]=item._pinnedStart;savePinnedStarts(pins);}
    persistAddedTask(item);
    const pending=loadPendingTasks();
    pending.push({id:item.id,title:item.title,priority:"High",source_task:"Urgent bar",
      source_task_id:"urgent",created_at:new Date().toISOString(),status:"scheduled",_scheduled:true});
    savePendingTasks(pending);
    log("scheduled",item.id,"Quick-added (late): "+item.title);
  }
  // Push any checked existing items
  const pendingId = _pendingNewTask ? _pendingNewTask.id : null;
  [...document.querySelectorAll(".overflow-task-chk:checked")]
    .filter(el=>el.dataset.id!==pendingId)
    .forEach(el=>pushTask(el.dataset.id));
  // Extend EOD by remaining deficit
  const freed=[...document.querySelectorAll(".overflow-task-chk:checked")]
    .filter(el=>el.dataset.id!==pendingId)
    .reduce((sum,el)=>sum+parseInt(el.dataset.dur||"0"),0);
  const remaining=_overflowDeficit-freed;
  if(remaining>0){ EOD += remaining; }
  closeOverflowModal();
  recalcTimes();
  render();
}

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

  if(simulatedEnd <= EOD){
    // Fits -- commit for real
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
  } else {
    // Doesn't fit -- stage as pending and open overflow modal (task NOT in scheduled yet)
    _pendingNewTask = {...newItem, _insertAt: insertAt};
    const deficit = simulatedEnd - EOD;
    openOverflowModal(deficit);
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
  checkOverflow();
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
  recalcTimes();checkOverflow();saveDurChanges();render()
}
function setDurAbsolute(id,newMin){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const n=Math.max(1,Math.round(newMin));
  const c=dur(ev);if(n===c)return;
  const s=pt(ev.start);ev.end=fmt(s+n);
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();checkOverflow();saveDurChanges();render()
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
  recalcTimes();checkOverflow();render();
}
function unpinStartTime(id){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  delete ev._pinnedStart;
  const pins=loadPinnedStarts(); delete pins[id]; savePinnedStarts(pins);
  log("unpin-start",id,"Removed start pin");
  recalcTimes();checkOverflow();render();
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
  recalcTimes();checkOverflow();render();
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
  recalcTimes();checkOverflow();log("scheduled",task.id,"Added: "+task.title);render()
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
  recalcTimes();checkOverflow();log("scheduled",fu.id,"Action item: "+fu.title);render()
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
    case"schedule":openSchedulePicker(title,durMin);break;
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
    case"trivial":{
      if(typeof addSideProjectTask==="function")addSideProjectTask(title,durMin);
      break;
    }
  }
}

// ======== SCHEDULE-AT PICKER ========
// Opens a small modal to pick a date+time for a new task. If the date is today,
// the task is inserted into the live schedule with a pinned start time. If the
// date is different, the task is persisted to the blockstore under that date so
// it appears when navigating to that day.
let _schedPickerTitle="",_schedPickerDur=30,_schedPickerOptions={};
function openSchedulePicker(title,durMin,options){
  _schedPickerTitle=title;
  _schedPickerDur=durMin||30;
  _schedPickerOptions=options||{};
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay){
    // Fallback if modal markup isn't present: schedule after current.
    insertTaskNow(title,durMin);
    return;
  }
  const titleEl=document.getElementById("sched-picker-title");
  if(titleEl)titleEl.textContent=title;
  const input=document.getElementById("sched-picker-when");
  if(input){
    // Default to the next round half-hour today
    const now=new Date();
    const base=new Date(now.getTime()+30*60000);
    base.setSeconds(0,0);
    const rounded=new Date(Math.ceil(base.getTime()/(15*60000))*(15*60000));
    const pad=n=>String(n).padStart(2,"0");
    input.value=rounded.getFullYear()+"-"+pad(rounded.getMonth()+1)+"-"+pad(rounded.getDate())
      +"T"+pad(rounded.getHours())+":"+pad(rounded.getMinutes());
  }
  overlay.classList.add("open");
  setTimeout(()=>{if(input)input.focus()},0);
}
function closeSchedulePicker(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(overlay)overlay.classList.remove("open");
  _schedPickerTitle="";_schedPickerDur=30;_schedPickerOptions={};
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
function confirmSchedulePicker(){
  const input=document.getElementById("sched-picker-when");
  if(!input||!input.value||!_schedPickerTitle){closeSchedulePicker();return}
  const when=new Date(input.value);
  if(isNaN(when.getTime())){closeSchedulePicker();return}
  const pad=n=>String(n).padStart(2,"0");
  const dateStr=when.getFullYear()+"-"+pad(when.getMonth()+1)+"-"+pad(when.getDate());
  const timeStr=pad(when.getHours())+":"+pad(when.getMinutes());
  const title=_schedPickerTitle,durMin=_schedPickerDur,options=_schedPickerOptions;
  closeSchedulePicker();
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)
    ?viewDate:((__state&&__state.date)?__state.date:null);
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
    checkOverflow();render();
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

// Wire up schedule-picker controls (buttons + Enter/Escape keys)
(function(){
  const overlay=document.getElementById("sched-picker-overlay");
  if(!overlay)return;
  const closeBtn=document.getElementById("sched-picker-close");
  const cancelBtn=document.getElementById("sched-picker-cancel");
  const confirmBtn=document.getElementById("sched-picker-confirm");
  const input=document.getElementById("sched-picker-when");
  if(closeBtn)closeBtn.addEventListener("click",closeSchedulePicker);
  if(cancelBtn)cancelBtn.addEventListener("click",closeSchedulePicker);
  if(confirmBtn)confirmBtn.addEventListener("click",confirmSchedulePicker);
  overlay.addEventListener("click",e=>{if(e.target===overlay)closeSchedulePicker()});
  if(input)input.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();confirmSchedulePicker()}
    else if(e.key==="Escape"){e.preventDefault();closeSchedulePicker()}
  });
})();
// Wire up all task-add bars
document.querySelectorAll(".task-add-bar").forEach(bar=>{
  bar.querySelector(".tab-add").addEventListener("click",()=>addTaskUniversal(bar));
  bar.querySelector(".tab-title").addEventListener("keydown",e=>{if(e.key==="Enter")addTaskUniversal(bar)});
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
// actionLog still populated by log() because sync.js builds the "Copy for Claude"
// activity report from it (sync.js:5-15) -- that path is alive.

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
