// ======== STATE ========
let scheduled=JSON.parse(JSON.stringify(INIT_SCHED));
let consider=JSON.parse(JSON.stringify(INIT_CONSIDER));
let backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));
let manualDone=new Set(), doneAt={}, actionLog=[], durChanges={}, nextId=200, schedView="plan";
function qaId(){return "qa-"+Date.now()+"-"+Math.random().toString(36).slice(2,7)}

// ======== UTILS ========
function pt(s){const[h,m]=s.split(":").map(Number);return h*60+m}
function fmt(mins){return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0")}
function ms(m){return m>=60?Math.floor(m/60)+"h"+(m%60?" "+m%60+"m":""):m+"m"}
function f12(s){const[h,m]=s.split(":").map(Number);const a=h>=12?"PM":"AM";return(h>12?h-12:h||12)+":"+String(m).padStart(2,"0")+" "+a}
function dur(ev){return pt(ev.end)-pt(ev.start)}
function origDur(id){const o=INIT_SCHED.find(e=>e.id===id);return o?dur(o):0}
function isMeeting(ev){return ev.type==="meeting"||ev.type==="oneone"}
function now(){return new Date().getHours()*60+new Date().getMinutes()}
function isDone(ev){return manualDone.has(ev.id)}
function isPast(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.end)}
function isActive(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.start)&&now()<pt(ev.end)}
function log(type,id,detail){actionLog.push({type,id,detail,ts:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true})})}

// ======== SOURCE TAGS ========
const SRC_LABELS={gcal:"Calendar",notion:"Notion",gmail:"Gmail"};
const SRC_CLS={gcal:"src-gcal",notion:"src-notion",gmail:"src-gmail"};
function srcTag(sources){
  if(!sources)return'';
  const list=Array.isArray(sources)?sources:[sources];
  if(list.length>1)return'<span class="src-tag src-multi"><span class="src-icon" style="background:var(--amber)"></span>'+list.map(s=>SRC_LABELS[s]||s).join(" + ")+'</span>';
  const s=list[0];return'<span class="src-tag '+(SRC_CLS[s]||"src-gcal")+'"><span class="src-icon" style="background:'+(s==="notion"?"var(--purple)":s==="gmail"?"#f87171":"var(--accent-light)")+'"></span>'+(SRC_LABELS[s]||s)+'</span>';
}

// ======== DETAIL PANEL ========
function toggleDetail(itemEl){
  const panel=itemEl.querySelector(".detail-panel");
  if(!panel)return;
  panel.classList.toggle("open");
}

// ======== DEFERRED (push to tomorrow) ========
let DEFERRED_KEY = "pa-deferred-" + ((__state && __state.date) ? __state.date : "unknown");
function loadDeferred(){try{return JSON.parse(localStorage.getItem(DEFERRED_KEY)||"[]")}catch(e){return[]}}
function saveDeferred(arr){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v))return;
  localStorage.setItem(DEFERRED_KEY,JSON.stringify(arr));scheduleIDBSave();
}

// ======== PUSHED TO TOMORROW (UI state) ========
let PUSHED_KEY = "pa-pushed-" + ((__state && __state.date) ? __state.date : "unknown");
let pushedSet = new Set();
let pushedAt = {};
(function loadPushedState(){
  try{const d=JSON.parse(localStorage.getItem(PUSHED_KEY)||"{}");
  if(d.ids)d.ids.forEach(id=>pushedSet.add(id));
  if(d.at)Object.assign(pushedAt,d.at);}catch(e){}
})();
function savePushedState(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.pushed&&window.blockStore){
    const dayRoot=window.blockStore.getDayRootId();
    const root=window.blockStore.get(dayRoot);
    if(root){window.blockStore.updateBlock(dayRoot,{...root.properties,_pushed:{ids:[...pushedSet],at:pushedAt}})}
    return;
  }
  localStorage.setItem(PUSHED_KEY,JSON.stringify({ids:[...pushedSet],at:pushedAt}));scheduleIDBSave();
}
function isPushed(ev){return pushedSet.has(ev.id)}

// ======== DURATION CHANGES PERSISTENCE ========
let DUR_KEY = "pa-dur-" + ((__state && __state.date) ? __state.date : "unknown");
function saveDurChanges(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.duration&&window.blockStore){
    const dayRoot=window.blockStore.getDayRootId();
    const root=window.blockStore.get(dayRoot);
    if(root){window.blockStore.updateBlock(dayRoot,{...root.properties,_durChanges:durChanges})}
    return;
  }
  try{localStorage.setItem(DUR_KEY,JSON.stringify(durChanges));scheduleIDBSave()}catch(e){}
}
function restoreDurChanges(){
  try{
    const raw=localStorage.getItem(DUR_KEY);if(!raw)return;
    const saved=JSON.parse(raw);
    Object.entries(saved).forEach(([id,ch])=>{
      const ev=scheduled.find(e=>e.id===id);if(!ev)return;
      const s=pt(ev.start);
      ev.end=fmt(s+ch.current);
      durChanges[id]=ch;
    });
    recalcTimes();
  }catch(e){}
}
// restoreDurChanges() is called by reloadPersistedEdits() during boot — no inline call needed
// ======== SCHEDULE PUSHED TASK ON TOMORROW ========
// Normalize time: handles both "HH:MM" and ISO "2026-04-10T18:00:00-04:00" formats
function _toHHMM(s){
  if(!s)return"00:00";
  if(s.includes("T")){const d=new Date(s);return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
  return s;
}
async function schedulePushedOnTomorrow(ev){
  if(!window.blockStore||!window.__PA_TOMORROW__||!__tomorrowDate)return;
  const tomorrow=window.__PA_TOMORROW__;
  const tDate=__tomorrowDate;

  // Get tomorrow's meetings as blocker intervals
  const tTimeline=(tomorrow.schedule&&tomorrow.schedule.timeline)||[];
  const tMeetings=tTimeline
    .filter(e=>e.type==="meeting"||e.type==="oneone")
    .map(e=>({s:pt(_toHHMM(e.start)),e:pt(_toHHMM(e.end))}))
    .sort((a,b)=>a.s-b.s);

  // Work hours from schedule blocks
  const tBlocks=(tomorrow.schedule&&tomorrow.schedule.blocks)||[];
  const dayStart=tBlocks.length?pt(tBlocks[0].start):7*60;
  const dayEnd=tBlocks.length?pt(tBlocks[tBlocks.length-1].end):17*60+30;

  // Fetch existing tasks on tomorrow to avoid double-booking
  let existingBlockers=[];
  try{
    const tBlks=await fetch("/api/blocks?date="+tDate).then(r=>r.json());
    // Duplicate check — skip if already pushed this task
    if(tBlks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===ev.id))return;
    existingBlockers=tBlks
      .filter(b=>(b.type==="added_task"||b.type==="schedule_item"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.start&&b.properties.end)
      .map(b=>({s:pt(b.properties.start),e:pt(b.properties.end)}));
  }catch(e){}

  const allBlockers=[...tMeetings,...existingBlockers].sort((a,b)=>a.s-b.s);
  const d=dur(ev)||30;
  const slot=_freeStart(dayStart,d,allBlockers);

  // Don't schedule past end of day + 1hr buffer
  if(slot+d>dayEnd+60){
    if(typeof showToast==="function")showToast("No free slot on tomorrow's schedule","error");
    return;
  }

  const startTime=fmt(slot);
  const endTime=fmt(slot+d);

  await window.blockStore.createBlock("block",{
    local_id:ev.id,
    title:ev.title,
    duration:d,
    start:startTime,
    end:endTime,
    priority:ev.priority||"High",
    meta:ev.meta||"",
    detail:ev.detail||"",
    notionUrl:ev.notionUrl||"",
    source:ev.source||"pushed",
    tags:ev.tags||[],
    added_at:new Date().toISOString(),
    pushed_from:(__state&&__state.date)||"unknown"
  },{date:tDate});

  if(typeof showToast==="function")showToast("Scheduled tomorrow at "+f12(startTime),"success");
}

async function unschedulePushedFromTomorrow(id){
  if(!window.blockStore||!__tomorrowDate)return;
  try{
    const tBlks=await fetch("/api/blocks?date="+__tomorrowDate).then(r=>r.json());
    const match=tBlks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===id);
    if(match)await window.blockStore.deleteBlock(match.id);
  }catch(e){}
}

function pushTask(id){
  pushedSet.add(id);pushedAt[id]=new Date().toISOString();
  // Also save to deferred array for scheduler pickup
  const deferred=loadDeferred();
  const ev=scheduled.find(e=>e.id===id);
  if(ev&&!deferred.find(d=>d.id===id)){
    deferred.push({...ev,deferred_from:(__state&&__state.date)||"unknown",deferred_at:new Date().toISOString()});
    saveDeferred(deferred);
  }
  // Actually schedule the task on tomorrow
  if(ev)schedulePushedOnTomorrow(ev);
  savePushedState();log("pushed",id,"Pushed to tomorrow: "+(ev?ev.title:id));render();
}
function unpushTask(id){
  pushedSet.delete(id);delete pushedAt[id];
  // Remove from deferred array too
  const deferred=loadDeferred().filter(d=>d.id!==id);
  saveDeferred(deferred);
  // Remove from tomorrow's schedule
  unschedulePushedFromTomorrow(id);
  savePushedState();render();
}

// ======== DELETE FROM SCHEDULE ========
let DELETED_KEY = "pa-deleted-" + ((__state && __state.date) ? __state.date : "unknown");
let deletedSet = new Set();
(function loadDeletedState(){
  try{const d=JSON.parse(localStorage.getItem(DELETED_KEY)||"[]");
  d.forEach(id=>deletedSet.add(id));}catch(e){}
})();
function saveDeletedState(){
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.deleted&&window.blockStore){
    const dayRoot=window.blockStore.getDayRootId();
    const root=window.blockStore.get(dayRoot);
    if(root){window.blockStore.updateBlock(dayRoot,{...root.properties,_deleted:[...deletedSet]})}
    return;
  }
  localStorage.setItem(DELETED_KEY,JSON.stringify([...deletedSet]));scheduleIDBSave();
}
function isDeleted(ev){return deletedSet.has(ev.id)}

let _delPendingId=null;
function openDeleteConfirm(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  _delPendingId=id;
  document.getElementById("del-confirm-task").textContent=ev.title;
  const src=ev.source||"unknown";
  let msg="This removes the task from today's schedule.";
  if(src==="notion")msg+=" The task will remain on your Notion board and can be rescheduled.";
  else if(src==="gcal"||src==="calendar")msg+=" The calendar event still exists in Google Calendar.";
  else msg+=" This task only exists in today's schedule and will be permanently removed.";
  document.getElementById("del-confirm-msg").textContent=msg;
  document.getElementById("del-confirm-overlay").classList.add("open");
}
function closeDeleteConfirm(){
  document.getElementById("del-confirm-overlay").classList.remove("open");
  _delPendingId=null;
  if(typeof _flushDeferredRender==='function')_flushDeferredRender();
}
function confirmDeleteTask(){
  if(!_delPendingId)return;
  const id=_delPendingId;
  const ev=scheduled.find(e=>e.id===id);
  deletedSet.add(id);
  saveDeletedState();
  log("deleted",id,"Removed from schedule: "+(ev?ev.title:id));
  closeDeleteConfirm();
  recalcTimes();
  render();
}
document.getElementById("del-cancel").addEventListener("click",closeDeleteConfirm);
document.getElementById("del-go").addEventListener("click",confirmDeleteTask);
document.getElementById("del-confirm-overlay").addEventListener("click",function(e){if(e.target===this)closeDeleteConfirm()});

