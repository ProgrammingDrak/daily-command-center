// ======== OVERFLOW DETECTION ========
let EOD = (function(){
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
    // User didn't push the new task — commit it (they freed up enough room via other pushes)
    const item = (({_insertAt,...rest})=>rest)(_pendingNewTask);
    const insertAt = _pendingNewTask._insertAt;
    scheduled.splice(insertAt, 0, item);
    recalcTimes();
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
    // Write to SQLite via blockstore — will be reloaded via getByType("added_task") on refresh
    const date=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)?__state.date:null);
    window.blockStore.createBlock("added_task",{
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
  const addedBlocks=window.blockStore.getByType("added_task");
  addedBlocks.forEach(block=>{
    const p=block.properties||{};
    const ev=scheduled.find(e=>e.id===p.local_id);
    if(!ev)return;
    if(p.start!==ev.start||p.end!==ev.end){
      window.blockStore.updateBlock(block.id,{...p,start:ev.start,end:ev.end});
    }
  });
}

function insertTaskNow(){
  const inp=document.getElementById("qa-title");
  const title=inp.value.trim();
  if(!title){
    inp.classList.add("qa-error");
    setTimeout(()=>inp.classList.remove("qa-error"),400);
    inp.focus();
    return;
  }
  const durMin=parseInt(document.getElementById("qa-dur").value);
  const id=qaId();
  const newItem={id,title,type:"task",start:"00:00",end:fmt(durMin),
    meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",
    notionUrl:"",priority:"High"};

  // Calculate insertion position
  const activeIdx=scheduled.findIndex(isActive);
  const insertAt = activeIdx !== -1 ? activeIdx + 1 :
    (()=>{const fi=scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev));return fi.length?fi[0].i:scheduled.length;})();

  // Simulate placement: temporarily add, cascade, read result, then remove
  scheduled.splice(insertAt, 0, newItem);
  recalcTimes();
  const simulatedEnd = pt(newItem.end);
  scheduled.splice(scheduled.indexOf(newItem), 1);
  recalcTimes(); // restore cascade without the new item

  inp.value="";

  if(simulatedEnd <= EOD){
    // Fits — commit for real
    scheduled.splice(insertAt, 0, newItem);
    recalcTimes();
    persistAddedTask(newItem);
    const pending=loadPendingTasks();
    pending.push({id,title,priority:"High",source_task:"Urgent bar",
      source_task_id:"urgent",created_at:new Date().toISOString(),status:"scheduled",_scheduled:true});
    savePendingTasks(pending);
    log("scheduled",id,"Quick-added: "+title);
    render();
  } else {
    // Doesn't fit — stage as pending and open overflow modal (task NOT in scheduled yet)
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
  document.querySelectorAll(".start-time-popover").forEach(p=>p.remove());
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  const pop=document.createElement("div");pop.className="start-time-popover";
  const curHH=ev.start.substring(0,2),curMM=ev.start.substring(3,5);
  pop.innerHTML=
    '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:2px">Start Time</div>'+
    '<input type="time" id="stp-input" value="'+curHH+':'+curMM+'">'+
    '<div class="stp-btns">'+
      '<button class="stp-btn stp-clear" id="stp-clear">Auto</button>'+
      '<button class="stp-btn stp-set" id="stp-set">Set</button>'+
    '</div>';
  document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect();
  pop.style.top=Math.min(rect.bottom+4,window.innerHeight-pop.offsetHeight-8)+"px";
  pop.style.left=Math.min(rect.left,window.innerWidth-pop.offsetWidth-8)+"px";
  pop.querySelector("#stp-set").addEventListener("click",()=>{
    const val=pop.querySelector("#stp-input").value;
    if(!val)return;
    pinStartTime(id,val);
    pop.remove();
  });
  pop.querySelector("#stp-clear").addEventListener("click",()=>{
    unpinStartTime(id);
    pop.remove();
  });
  pop.querySelector("#stp-input").addEventListener("keydown",e=>{
    if(e.key==="Enter"){pop.querySelector("#stp-set").click();}
    if(e.key==="Escape"){pop.remove();}
  });
  setTimeout(()=>{
    function onOutside(e){if(!pop.contains(e.target)&&e.target!==anchorEl){pop.remove();document.removeEventListener("click",onOutside,true);}}
    document.addEventListener("click",onOutside,true);
  },10);
  pop.querySelector("#stp-input").focus();
}
let PINNED_KEY = "pa-pinned-starts-" + ((__state && __state.date) ? __state.date : "unknown");
function loadPinnedStarts(){ try{return JSON.parse(localStorage.getItem(PINNED_KEY)||"{}")}catch(e){return{}} }
function savePinnedStarts(data){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v))return;
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
function addNewTask(){
  const title=document.getElementById("new-title").value.trim();if(!title)return;
  const type=document.getElementById("new-type").value,durMin=parseInt(document.getElementById("new-dur").value);
  backlog.push({id:"custom-"+(nextId++),title,type,durMin,meta:"Custom task \u00b7 "+ms(durMin),detail:"",source:"manual",notionUrl:""});
  log("created","custom","New: "+title);document.getElementById("new-title").value="";render()
}
function undoLast(){if(!actionLog.length)return;const a=actionLog.pop();if(a.type==="checked")manualDone.delete(a.id);else if(a.type==="unchecked")manualDone.add(a.id);else if(a.type==="reorder"&&a.detail)scheduled=JSON.parse(a.detail);render()}
function resetAll(){scheduled=JSON.parse(JSON.stringify(INIT_SCHED));consider=JSON.parse(JSON.stringify(INIT_CONSIDER));backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));manualDone.clear();doneAt={};actionLog=[];durChanges={};render()}

// ======== TASK ORDER PERSISTENCE ========
let ORDER_KEY = "pa-task-order-" + ((__state && __state.date) ? __state.date : "unknown");
function loadTaskOrder(){ try{return JSON.parse(localStorage.getItem(ORDER_KEY)||"[]")}catch(e){return[]} }
function saveTaskOrder(){
  const order=scheduled.filter(ev=>!isDone(ev)).map(ev=>ev.id);
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.reorder&&window.blockStore){
    const items=order.map((id,i)=>({id,sort_order:(i+1)*1000}));
    window.blockStore.reorder(items).catch(()=>{});
    return;
  }
  localStorage.setItem(ORDER_KEY,JSON.stringify(order)); scheduleIDBSave();
}

