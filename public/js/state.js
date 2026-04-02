// ======== STATE ========
let scheduled=JSON.parse(JSON.stringify(INIT_SCHED));
let consider=JSON.parse(JSON.stringify(INIT_CONSIDER));
let backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));
let manualDone=new Set(), doneAt={}, actionLog=[], durChanges={}, nextId=200, schedView="plan";

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
function pushTask(id){
  pushedSet.add(id);pushedAt[id]=new Date().toISOString();
  // Also save to deferred array for scheduler pickup
  const deferred=loadDeferred();
  const ev=scheduled.find(e=>e.id===id);
  if(ev&&!deferred.find(d=>d.id===id)){
    deferred.push({...ev,deferred_from:(__state&&__state.date)||"unknown",deferred_at:new Date().toISOString()});
    saveDeferred(deferred);
  }
  savePushedState();log("pushed",id,"Pushed to tomorrow: "+(ev?ev.title:id));render();
}
function unpushTask(id){
  pushedSet.delete(id);delete pushedAt[id];
  // Remove from deferred array too
  const deferred=loadDeferred().filter(d=>d.id!==id);
  saveDeferred(deferred);
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

