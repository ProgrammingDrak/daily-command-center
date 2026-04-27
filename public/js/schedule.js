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
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks)return; // blockstore handles it
  localStorage.setItem(ADDED_KEY,JSON.stringify(tasks)); scheduleIDBSave();
}
function persistAddedTask(item){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
    // Write to blockstore — will be reloaded via property-based query on refresh
    const date=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)?__state.date:null);
    window.blockStore.createBlock("block",{
      local_id:item.id,
      title:item.title,
      duration:dur(item),
      start:item.start,
      end:item.end,
      priority:item.priority||"High",
      meta:item.meta||"",
      detail:item.detail||"",
      notionUrl:item.notionUrl||"",
      source:item.source||"manual",
      tags:item.tags||[],
      added_at:new Date().toISOString()
    },{date});
    return;
  }
  // Fallback: localStorage
  const added=loadAddedTasks();
  if(!added.find(t=>t.id===item.id)){
    added.push({id:item.id,title:item.title,durMin:dur(item),priority:item.priority||"High",source:item.source||"manual",meta:item.meta||"",detail:item.detail||"",notionUrl:item.notionUrl||"",addedAt:new Date().toISOString()});
    saveAddedTasks(added);
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

function insertTaskNow(titleArg, durMinArg){
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

  const newItem={id,title,type:"task",start:startStr,end:fmt(startMin+durMin),
    meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",
    notionUrl:"",priority:"High",tags:[],_pinnedStart:startStr};

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
  } else {
    // Doesn't fit -- stage as pending and open overflow modal (task NOT in scheduled yet)
    _pendingNewTask = {...newItem, _insertAt: insertAt};
    const deficit = simulatedEnd - EOD;
    openOverflowModal(deficit);
  }
}

function insertTaskFromDrawer(title, durMin){
  const id=qaId();
  const newItem={id,title,type:"task",start:"00:00",end:fmt(durMin),
    meta:"Action item \u00b7 "+ms(durMin),detail:"",source:"manual",
    notionUrl:"",priority:"High"};
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
}

// ======== ACTIONS ========
function toggleDone(id){if(manualDone.has(id)){manualDone.delete(id);delete doneAt[id];log("unchecked",id)}else{manualDone.add(id);doneAt[id]=new Date();log("checked",id)};saveDoneState();render()}
function adjustDur(id,delta){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const c=dur(ev),n=Math.max(15,c+delta);if(n===c)return;
  const s=pt(ev.start);ev.end=String(Math.floor((s+n)/60)).padStart(2,"0")+":"+String((s+n)%60).padStart(2,"0");
  if(ev.meta)ev.meta=ev.meta.replace(/·\s*\d+h?\s*\d*m?/,"· "+ms(n));
  durChanges[id]={original:origDur(id)||c,current:n};log("duration",id,c+"->"+n);
  recalcTimes();checkOverflow();saveDurChanges();render()
}
function setDurAbsolute(id,newMin){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const n=Math.max(15,newMin);
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

function addToSchedule(blId){
  let idx=consider.findIndex(b=>b.id===blId),task;
  if(idx!==-1){task=consider.splice(idx,1)[0]}else{idx=backlog.findIndex(b=>b.id===blId);if(idx===-1)return;task=backlog.splice(idx,1)[0]}
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+task.durMin;
  scheduled.push({id:task.id,title:task.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:task.type,meta:task.meta,detail:task.detail||"",source:task.source||"notion",notionUrl:task.notionUrl||"",priority:task.priority});
  recalcTimes();checkOverflow();log("scheduled",task.id,"Added: "+task.title);render()
}
function addFollowupToSchedule(fu,parentId){
  let lastEnd="16:00";if(scheduled.length){lastEnd=scheduled[scheduled.length-1].end}
  const s=pt(lastEnd),e=s+(fu.durMin||30);
  scheduled.push({id:fu.id||"fu-"+(nextId++),title:fu.title,start:String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0"),end:String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),type:"task",meta:(fu.durMin||30)+"min \u00b7 Action item from "+parentId,detail:fu.detail||"",source:fu.source||"notion",notionUrl:fu.href||"",priority:fu.priority||"Medium"});
  // Remove from parent followups
  const parent=scheduled.find(x=>x.id===parentId);
  if(parent&&parent.followups){parent.followups=parent.followups.filter(f=>f.id!==fu.id)}
  recalcTimes();checkOverflow();log("scheduled",fu.id,"Action item: "+fu.title);render()
}
function addNewTask(titleArg, durMinArg){
  const title=titleArg||(function(){const inp=document.getElementById("new-title");const v=inp?inp.value.trim():"";if(inp)inp.value="";return v})();
  if(!title)return;
  const durMin=durMinArg||30;
  backlog.push({id:"custom-"+(nextId++),title,type:"task",durMin,meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",notionUrl:""});
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
    case"trivial":{
      if(typeof addTrivialTask==="function")addTrivialTask(title);
      break;
    }
  }
}

// ======== SCHEDULE-AT PICKER ========
// Opens a small modal to pick a date+time for a new task. If the date is today,
// the task is inserted into the live schedule with a pinned start time. If the
// date is different, the task is persisted to the blockstore under that date so
// it appears when navigating to that day.
let _schedPickerTitle="",_schedPickerDur=30;
function openSchedulePicker(title,durMin){
  _schedPickerTitle=title;
  _schedPickerDur=durMin||30;
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
  _schedPickerTitle="";_schedPickerDur=30;
}
function confirmSchedulePicker(){
  const input=document.getElementById("sched-picker-when");
  if(!input||!input.value||!_schedPickerTitle){closeSchedulePicker();return}
  const when=new Date(input.value);
  if(isNaN(when.getTime())){closeSchedulePicker();return}
  const pad=n=>String(n).padStart(2,"0");
  const dateStr=when.getFullYear()+"-"+pad(when.getMonth()+1)+"-"+pad(when.getDate());
  const timeStr=pad(when.getHours())+":"+pad(when.getMinutes());
  const title=_schedPickerTitle,durMin=_schedPickerDur;
  closeSchedulePicker();
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)
    ?viewDate:((__state&&__state.date)?__state.date:null);
  if(dateStr===currentDate){
    // Same day: insert into schedule and pin the start time to the chosen time
    const id=qaId();
    const s=pt(timeStr);
    const newItem={id,title,type:"task",start:timeStr,end:fmt(s+durMin),
      meta:"Custom task · "+ms(durMin),detail:"",source:"manual",
      notionUrl:"",priority:"High",tags:[],_pinnedStart:timeStr};
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
  } else {
    // Different day: persist to blockstore for that target date
    const id=qaId();
    const newItem={id,title,type:"task",start:timeStr,end:fmt(pt(timeStr)+durMin),
      meta:"Custom task · "+ms(durMin),detail:"",source:"manual",
      notionUrl:"",priority:"High",tags:[]};
    if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.addedTasks&&window.blockStore){
      window.blockStore.createBlock("block",{
        local_id:id,title,duration:durMin,start:timeStr,end:newItem.end,
        priority:"High",meta:newItem.meta,detail:"",notionUrl:"",
        source:"manual",tags:[],_pinnedStart:timeStr,
        added_at:new Date().toISOString()
      },{date:dateStr});
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
      render();
    } else {
      // Fallback: store in a per-date localStorage bucket so it's not lost
      const key="pa-added-tasks-"+dateStr;
      let arr=[];try{arr=JSON.parse(localStorage.getItem(key)||"[]")}catch(e){arr=[]}
      arr.push({id,title,durMin,priority:"High",source:"manual",meta:newItem.meta,
        detail:"",notionUrl:"",start:timeStr,end:newItem.end,
        _pinnedStart:timeStr,addedAt:new Date().toISOString()});
      localStorage.setItem(key,JSON.stringify(arr));
      log("scheduled",id,"Scheduled for "+dateStr+" "+timeStr+": "+title);
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
    if(tags.includes("trivial")||tags.includes("action-item")||tags.includes("pinned"))return false;
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

function undoLast(){if(!actionLog.length)return;const a=actionLog.pop();if(a.type==="checked")manualDone.delete(a.id);else if(a.type==="unchecked")manualDone.add(a.id);else if(a.type==="reorder"&&a.detail)scheduled=JSON.parse(a.detail);render()}
function resetAll(){scheduled=JSON.parse(JSON.stringify(INIT_SCHED));consider=JSON.parse(JSON.stringify(INIT_CONSIDER));backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));manualDone.clear();doneAt={};actionLog=[];durChanges={};render()}

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

