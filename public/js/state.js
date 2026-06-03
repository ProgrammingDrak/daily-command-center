// ======== STATE ========
let scheduled=JSON.parse(JSON.stringify(INIT_SCHED));
let consider=JSON.parse(JSON.stringify(INIT_CONSIDER));
let backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));
let manualDone=new Set(), doneAt={}, actionLog=[], durChanges={}, commuteTimes={}, nextId=200, schedView="plan";
let dailyBounty=null;
function qaId(){return "qa-"+Date.now()+"-"+Math.random().toString(36).slice(2,7)}

// ======== UTILS ========
function pt(s){
  if(s instanceof Date)return s.getHours()*60+s.getMinutes();
  if(typeof s==="number")return s;
  const raw=String(s||"").trim();
  if(!raw)return 0;
  if(raw.includes("T")){
    const d=new Date(raw);
    if(!Number.isNaN(d.getTime()))return d.getHours()*60+d.getMinutes();
  }
  const m=raw.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
  if(!m)return 0;
  let h=parseInt(m[1],10),min=parseInt(m[2],10);
  const ap=m[3]?m[3].toUpperCase():null;
  if(ap==="AM")h=h===12?0:h;
  else if(ap==="PM")h=h===12?12:(h<12?h+12:h);
  return ((h%24)+24)%24*60+min;
}
function fmt(mins){return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0")}
function ms(m){return m>=60?Math.floor(m/60)+"h"+(m%60?" "+m%60+"m":""):m+"m"}
function f12(s){const mins=pt(s),h=Math.floor(mins/60)%24,m=mins%60,a=h>=12?"PM":"AM",h12=h%12||12;return h12+":"+String(m).padStart(2,"0")+" "+a}
function dur(ev){return pt(ev.end)-pt(ev.start)}
function origDur(id){const o=INIT_SCHED.find(e=>e.id===id);return o?dur(o):0}
function isMeeting(ev){return ev.type==="meeting"||ev.type==="oneone"}

// ======== WRAPS (v1) ========
// A "wrap" is a larger container block (a long session / focus block). Tasks
// nested inside it are "ride-alongs": concurrent work done within the wrap's
// time window. Ride-alongs carry wrapId = their parent's id; they do not push
// the cascade and render indented under their parent.
function isWrap(ev){return !!(ev&&(ev.isWrap||(Array.isArray(ev.tags)&&ev.tags.includes("wrap"))));}
function wrapParentId(ev){return ev&&ev.wrapId?ev.wrapId:null;}
function isRideAlong(ev){return !!wrapParentId(ev);}
// Reorder a flat list so each wrap is immediately followed by its ride-along
// children. Children whose parent isn't in the list keep their place.
function groupRideAlongs(items){
  const byParent={};
  items.forEach(ev=>{const pid=wrapParentId(ev);if(pid)(byParent[pid]=byParent[pid]||[]).push(ev);});
  if(!Object.keys(byParent).length)return items.slice();
  const out=[],placed=new Set();
  items.forEach(ev=>{
    if(isRideAlong(ev))return; // placed under its parent below
    out.push(ev);
    (byParent[ev.id]||[]).slice().sort((a,b)=>pt(a.start)-pt(b.start)).forEach(k=>{out.push(k);placed.add(k.id);});
  });
  items.forEach(ev=>{if(isRideAlong(ev)&&!placed.has(ev.id))out.push(ev);}); // orphans stay visible
  return out;
}
function wrapBandwidth(ev,pool){
  if(!isWrap(ev))return null;
  const kids=(pool||[]).filter(k=>wrapParentId(k)===ev.id&&relOf(k)==="ride-along");
  if(!kids.length)return null;
  return {count:kids.length,mins:kids.reduce((s,k)=>s+(dur(k)||0),0)};
}

// ======== UNIFIED TASK TREE (wraps + subtasks, infinitely nestable) ========
// Every item can have a parent via one of two edge types:
//   wrapId    -> "ride-along" (concurrent, first-class row, has its own time)
//   subtaskOf -> "subtask"    (timeless step, smaller collapsible row)
// Both nest arbitrarily and intermix. recalcTimes skips anything nested.
function parentIdOf(ev){return (ev&&(ev.wrapId||ev.subtaskOf))||null;}
function relOf(ev){return ev?(ev.wrapId?"ride-along":(ev.subtaskOf?"subtask":null)):null;}
function isSubtask(ev){return !!(ev&&ev.subtaskOf);}
function isNested(ev){return !!parentIdOf(ev);}
function childrenOf(id,pool){return (pool||[]).filter(c=>parentIdOf(c)===id);}
// Subtask completion progress for a parent (recursive over subtask descendants).
// _seen guards against accidental parent cycles in the data.
function subtaskProgress(id,pool,_seen){
  _seen=_seen||new Set();
  if(_seen.has(id))return null;
  _seen.add(id);
  const subs=(pool||scheduled).filter(c=>c.subtaskOf===id);
  if(!subs.length)return null;
  let done=0,total=0;
  subs.forEach(s=>{total++;if(isDone(s))done++;const sub=subtaskProgress(s.id,pool,_seen);if(sub){total+=sub.total;done+=sub.done;}});
  return {done,total};
}

// Collapse state for any parent row (persisted in localStorage).
let _collapsedSet=null;
function loadCollapsed(){
  if(_collapsedSet)return _collapsedSet;
  try{_collapsedSet=new Set(JSON.parse(localStorage.getItem("pa-collapsed-v1")||"[]"));}
  catch(e){_collapsedSet=new Set();}
  return _collapsedSet;
}
function isCollapsed(id){return loadCollapsed().has(id);}
function toggleCollapsed(id){
  const s=loadCollapsed();
  if(s.has(id))s.delete(id);else s.add(id);
  try{localStorage.setItem("pa-collapsed-v1",JSON.stringify([...s]));}catch(e){}
}

// Recursive flatten of a task list into render order. Returns nodes
// {ev, depth, rel, hasKids, collapsed}; descendants of a collapsed node are
// omitted. Children render ride-alongs first (by start), then subtasks.
function flattenSchedule(items){
  const byId=new Map(items.map(e=>[e.id,e]));
  const out=[],seen=new Set();
  function walk(ev,depth){
    if(seen.has(ev.id)||depth>20)return; // cycle / runaway guard
    seen.add(ev.id);
    const kids=childrenOf(ev.id,items);
    const hasKids=kids.length>0;
    const collapsed=hasKids&&isCollapsed(ev.id);
    out.push({ev,depth,rel:relOf(ev),hasKids,collapsed});
    if(hasKids&&!collapsed){
      const ride=kids.filter(k=>relOf(k)==="ride-along").sort((a,b)=>pt(a.start)-pt(b.start));
      const subs=kids.filter(k=>relOf(k)==="subtask");
      ride.concat(subs).forEach(k=>walk(k,depth+1));
    }
  }
  // Roots = items whose parent isn't in this list (top-level or orphaned).
  items.forEach(ev=>{const p=parentIdOf(ev);if(!p||!byId.has(p))walk(ev,0);});
  return out;
}
function now(){return new Date().getHours()*60+new Date().getMinutes()}
function isDone(ev){return manualDone.has(ev.id)}
function isPast(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.end)}
function isActive(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.start)&&now()<pt(ev.end)}
function log(type,id,detail){actionLog.push({type,id,detail,ts:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true})})}

// ======== SOURCE TAGS ========
const SRC_LABELS={notion:"Notion",gmail:"Gmail",delegated:"Delegated"};
const SRC_CLS={notion:"src-notion",gmail:"src-gmail",delegated:"src-delegated"};
function srcTag(sources){
  if(!sources)return'';
  const list=Array.isArray(sources)?sources:[sources];
  if(list.length>1)return'<span class="src-tag src-multi"><span class="src-icon" style="background:var(--amber)"></span>'+list.map(s=>SRC_LABELS[s]||s).join(" + ")+'</span>';
  const s=list[0];return'<span class="src-tag '+(SRC_CLS[s]||"src-multi")+'"><span class="src-icon" style="background:'+(s==="notion"?"var(--purple)":s==="gmail"?"#f87171":s==="delegated"?"var(--cyan)":"var(--amber)")+'"></span>'+(SRC_LABELS[s]||s)+'</span>';
}

// ======== DETAIL PANEL ========
function toggleDetail(itemEl){
  const panel=itemEl.querySelector(".detail-panel");
  if(!panel)return;
  panel.classList.toggle("open");
}

// ======== COMMUTE LEAVE WINDOWS ========
let COMMUTE_KEY = "pa-commute-times-" + ((__state && __state.date) ? __state.date : "unknown");
function normalizeCommuteMinutes(value){
  const n=parseInt(value,10);
  return Number.isFinite(n)&&n>0?n:0;
}
function commuteWindowBufferMinutes(commuteMinutes){
  const commute=normalizeCommuteMinutes(commuteMinutes);
  if(!commute)return 0;
  return Math.ceil(Math.max(10,commute*0.25)/5)*5;
}
function _fmtClockMinute(mins){
  const day=24*60;
  const normalized=((Math.round(mins)%day)+day)%day;
  return fmt(normalized);
}
function commuteLeaveWindow(ev){
  const commute=normalizeCommuteMinutes(ev&&(ev.commuteMinutes||ev.commute_minutes||ev.commuteTime));
  if(!ev||!commute)return null;
  const latest=pt(ev.start)-commute;
  const buffer=commuteWindowBufferMinutes(commute);
  const earliest=latest-buffer;
  return {
    commuteMinutes:commute,
    bufferMinutes:buffer,
    earliest:_fmtClockMinute(earliest),
    latest:_fmtClockMinute(latest),
    label:"Leave between "+f12(_fmtClockMinute(earliest))+" - "+f12(_fmtClockMinute(latest))
  };
}
function commuteLeaveChipHtml(ev){
  const win=commuteLeaveWindow(ev);
  if(!win)return"";
  const title=(win.commuteMinutes+"m commute, "+win.bufferMinutes+"m departure window").replace(/"/g,"&quot;");
  return '<span class="commute-chip" title="'+title+'"><span>leave between</span> '+f12(win.earliest)+' - '+f12(win.latest)+'</span>';
}
function loadCommuteTimes(){
  const bs=_bsProp("_commuteTimes",null);
  if(bs&&typeof bs==="object")return {...bs};
  try{return JSON.parse(localStorage.getItem(COMMUTE_KEY)||"{}")}catch(e){return{}}
}
function saveCommuteTimes(){
  if(_bsSaveProp("_commuteTimes",commuteTimes))return;
  try{localStorage.setItem(COMMUTE_KEY,JSON.stringify(commuteTimes));scheduleIDBSave()}catch(e){}
}
function _commuteBlockForTask(taskId){
  if(!window.blockStore||!taskId)return null;
  const blocks=(window.blockStore.getByType("added_task")||[])
    .concat(window.blockStore.getByType("schedule_item")||[])
    .concat((window.blockStore.getByType("block")||[]).filter(b=>{
      const p=b.properties||{};
      return p.local_id||p.start||p.end||p.scheduled_dates;
    }));
  return blocks.find(b=>{
    const p=b.properties||{};
    return p.local_id===taskId||b.id===taskId;
  })||null;
}
function setTaskCommuteMinutes(taskId,value){
  if(!taskId)return;
  const minutes=normalizeCommuteMinutes(value);
  if(minutes)commuteTimes[taskId]=minutes;
  else delete commuteTimes[taskId];
  const ev=scheduled.find(e=>e.id===taskId);
  if(ev){
    if(minutes)ev.commuteMinutes=minutes;
    else delete ev.commuteMinutes;
  }
  saveCommuteTimes();
  const block=_commuteBlockForTask(taskId);
  if(block&&window.blockStore){
    const props={...(block.properties||{})};
    if(minutes)props.commuteMinutes=minutes;
    else delete props.commuteMinutes;
    window.blockStore.updateBlock(block.id,props);
  }
}
function hydrateTaskCommuteTimes(){
  commuteTimes=loadCommuteTimes();
  scheduled.forEach(ev=>{
    const fromEvent=normalizeCommuteMinutes(ev.commuteMinutes||ev.commute_minutes||ev.commuteTime);
    const fromMap=normalizeCommuteMinutes(commuteTimes[ev.id]);
    const minutes=fromMap||fromEvent;
    if(minutes)ev.commuteMinutes=minutes;
    else delete ev.commuteMinutes;
  });
}

// ======== DEFERRED (push to tomorrow) ========
let DEFERRED_KEY = "pa-deferred-" + ((__state && __state.date) ? __state.date : "unknown");
function loadDeferred(){try{return JSON.parse(localStorage.getItem(DEFERRED_KEY)||"[]")}catch(e){return[]}}
function saveDeferred(arr){
  if(window.USE_BLOCKSTORE&&Object.values(window.USE_BLOCKSTORE).every(v=>v))return;
  localStorage.setItem(DEFERRED_KEY,JSON.stringify(arr));scheduleIDBSave();
}

// ======== DAILY BOUNTY ========
// One immutable "today succeeds if this gets done" marker. Completion pays 2x points and can stack with one partner bounty.
let BOUNTY_KEY = "pa-bounty-" + ((__state && __state.date) ? __state.date : "unknown");
function normalizeBountyState(value){
  if(!value||typeof value!=="object")return null;
  let state;
  if(value.self||value.partner){
    state={self:value.self||null,partner:value.partner||null};
  }else if(value.taskId){
    state={self:value,partner:null};
  }else{
    state={self:null,partner:null};
  }
  return state.self||state.partner?state:null;
}
function bountyEntryMatches(entry,id){return !!(entry&&String(entry.taskId)===String(id))}
function getBountyCountForTask(id){
  const state=normalizeBountyState(dailyBounty);
  if(!state)return 0;
  let count=0;
  if(bountyEntryMatches(state.self,id))count++;
  if(bountyEntryMatches(state.partner,id))count++;
  return Math.min(2,count);
}
// Bounty provenance for a task: count plus whether a visitor (partner) placed
// it and their name, so the itinerary can color sponsor bounties distinctly.
function getBountyMetaForTask(id){
  const state=normalizeBountyState(dailyBounty);
  const meta={count:getBountyCountForTask(id),hasSponsor:false,sponsorName:""};
  if(state&&bountyEntryMatches(state.partner,id)&&(state.partner.source==="todo-share"||state.partner.sponsorName)){
    meta.hasSponsor=true;
    meta.sponsorName=state.partner.sponsorName||"";
  }
  return meta;
}
function hasSelfBounty(){const state=normalizeBountyState(dailyBounty);return !!(state&&state.self&&state.self.taskId)}
function hasPartnerBounty(){const state=normalizeBountyState(dailyBounty);return !!(state&&state.partner&&state.partner.taskId)}
function loadBountyState(){
  if(window.USE_BLOCKSTORE&&window.blockStore){
    const v=_bsProp("_bounty",null);
    const state=normalizeBountyState(v);
    if(state)return state;
  }
  try{return normalizeBountyState(JSON.parse(localStorage.getItem(BOUNTY_KEY)||"null"))}catch(e){return null}
}
function saveBountyState(){
  dailyBounty=normalizeBountyState(dailyBounty);
  if(dailyBounty){
    ["self","partner"].forEach(kind=>{
      const entry=dailyBounty&&dailyBounty[kind];
      if(entry&&entry.taskId){
        const ev=scheduled.find(e=>String(e.id)===String(entry.taskId));
        if(ev)entry.taskTitle=ev.title;
      }
    });
  }
  if(_bsSaveProp("_bounty",dailyBounty))return;
  if(dailyBounty)localStorage.setItem(BOUNTY_KEY,JSON.stringify(dailyBounty));
  else localStorage.removeItem(BOUNTY_KEY);
  scheduleIDBSave();
}
function hydrateBountyState(){dailyBounty=loadBountyState();}
function getDailyBounty(){return dailyBounty;}
function isBountyTask(id){return getBountyCountForTask(id)>0}
function placeBounty(id){
  if(typeof viewMode!=="undefined"&&viewMode==="archive"){
    if(typeof showToast==="function")showToast("Archived days are read-only","info");
    return;
  }
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||isMeeting(ev))return;
  const state=normalizeBountyState(dailyBounty)||{self:null,partner:null};
  if(state.self&&state.self.taskId){
    const title=(scheduled.find(e=>String(e.id)===String(state.self.taskId))||state.self).title||state.self.taskTitle||"today's bounty";
    if(typeof showToast==="function")showToast("Bounty is locked on "+title,"info");
    return;
  }
  if(state.partner&&state.partner.taskId&&String(state.partner.taskId)!==String(id)){
    const title=(scheduled.find(e=>String(e.id)===String(state.partner.taskId))||state.partner).title||state.partner.taskTitle||"the sponsored bounty";
    if(typeof showToast==="function")showToast("Self bounty must stack on "+title,"info");
    return;
  }
  if(isDone(ev)){
    if(typeof showToast==="function")showToast("Pick an unfinished task for the bounty","info");
    return;
  }
  dailyBounty={...state,self:{taskId:ev.id,taskTitle:ev.title,placedAt:new Date().toISOString(),source:"self"}};
  saveBountyState();
  log("bounty",ev.id,"Bounty placed: "+ev.title);
  if(typeof showToast==="function")showToast("Bounty locked: "+ev.title+" pays 2x points","success");
  render();
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

// ======== PINNED ACTIVE TASK (PIN 1) ========
// Separate from _pinnedStart (schedule.js) — this is a *single* task id
// the user has "pinned as active" via clicking its timeline dot. It
// overrides auto-derived next-up in buildSchedule, and drives the
// .tl-node aging colors (blue within window → yellow past end → red >60m past).
let PINNED_ACTIVE_KEY = "pa-pinned-active-" + ((__state && __state.date) ? __state.date : "unknown");
let _pinnedActiveId = null;
(function loadPinnedActive(){
  try { _pinnedActiveId = JSON.parse(localStorage.getItem(PINNED_ACTIVE_KEY) || "null"); } catch(e) { _pinnedActiveId = null; }
})();
function getPinnedActiveId(){ return _pinnedActiveId; }
function setPinnedActiveId(id){
  _pinnedActiveId = id || null;
  try { localStorage.setItem(PINNED_ACTIVE_KEY, JSON.stringify(_pinnedActiveId)); } catch(e) {}
}
function clearPinnedActiveId(){ setPinnedActiveId(null); }
function togglePinnedActiveId(id){
  if (_pinnedActiveId === id) clearPinnedActiveId();
  else setPinnedActiveId(id);
  log("pin-active", id, _pinnedActiveId ? "Pinned active" : "Unpinned active");
  if (typeof render === "function") render();
}
// Aging state for the pinned task: "blue" | "yellow" | "red" | null
function getPinnedAgingState(ev){
  if (!ev || _pinnedActiveId !== ev.id) return null;
  const endMin = pt(ev.end);
  const nowMin = now();
  if (nowMin < endMin) return "blue";
  if (nowMin - endMin <= 60) return "yellow";
  return "red";
}

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
// Compute today's local-date string ("YYYY-MM-DD") based on the wall clock,
// independent of the currently-viewed date.
function _actualTodayStr(){
  const n=new Date();
  return n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0")+"-"+String(n.getDate()).padStart(2,"0");
}

// Pretty label for a date string: "today" | "tomorrow" | "Apr 22"
function _prettyDateLabel(dateStr){
  if(!dateStr)return dateStr||"";
  if(dateStr===_actualTodayStr())return"today";
  if(dateStr===__tomorrowDate)return"tomorrow";
  try{return new Date(dateStr+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})}catch(e){return dateStr}
}

function _actualDateStr(offsetDays){
  const n=new Date();
  n.setDate(n.getDate()+(offsetDays||0));
  return n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0")+"-"+String(n.getDate()).padStart(2,"0");
}

function _resolvedTodayDate(){return __todayDate||_actualDateStr(0)}
function _resolvedTomorrowDate(){return __tomorrowDate||_actualDateStr(1)}

function _rescheduledTaskId(ev,targetDate){
  const base=String((ev&&ev.sourceTaskId)||((ev&&ev.id)||qaId())).replace(/[^a-zA-Z0-9_-]/g,"-");
  const dateSlug=String(targetDate||"").replace(/[^0-9]/g,"");
  return base+"-resched-"+dateSlug;
}

function _cloneTaskForReschedule(ev,targetDate,fromDate){
  const d=dur(ev)||30;
  const tags=Array.isArray(ev.tags)?ev.tags.filter(t=>t!=="wrap"):[];
  return {
    id:_rescheduledTaskId(ev,targetDate),
    title:ev.title,
    type:ev.type||"task",
    start:"00:00",
    end:fmt(d),
    priority:ev.priority||"High",
    meta:ev.meta||"",
    detail:ev.detail||"",
    notionUrl:ev.notionUrl||"",
    calUrl:ev.calUrl||"",
    source:"rescheduled",
    tags,
    kind:ev.kind||"",
    responsibilityId:ev.responsibilityId||null,
    responsibilityTitle:ev.responsibilityTitle||null,
    capacityBucket:ev.capacityBucket||null,
    responsibilityScore:ev.responsibilityScore||null,
    alertKey:ev.alertKey||null,
    alertType:ev.alertType||null,
    publicVisibility:ev.publicVisibility||"public",
    triageId:ev.triageId||null,
    delegatedItemId:ev.delegatedItemId||null,
    linkedBlockId:ev.linkedBlockId||null,
    linkedTagId:ev.linkedTagId||null,
    ampUrl:ev.ampUrl||null,
    hubspotUrl:ev.hubspotUrl||null,
    commuteMinutes:ev.commuteMinutes||ev.commute_minutes||null,
    wrapId:null,
    isWrap:false,
    subtaskOf:null,
    reschedulePlacement:"earliest",
    rescheduledFrom:{date:fromDate||"unknown",taskId:ev.id},
    sourceTaskId:ev.sourceTaskId||ev.id
  };
}

function _clearTaskPinAndLock(ev){
  if(!ev)return;
  if(ev._pinnedStart){
    delete ev._pinnedStart;
    try{const pins=loadPinnedStarts();delete pins[ev.id];savePinnedStarts(pins)}catch(e){}
  }
  if(ev._locked){
    delete ev._locked;
    try{const locks=new Set(loadLockedSet());locks.delete(ev.id);saveLockedSet([...locks])}catch(e){}
  }
}

function _placeTaskAtNextTodaySlot(id){
  const idx=scheduled.findIndex(e=>e.id===id);
  if(idx<0)return null;
  const moved=scheduled[idx];
  const d=dur(moved)||30;
  scheduled.splice(idx,1);
  _clearTaskPinAndLock(moved);
  pushedSet.delete(id);delete pushedAt[id];
  deletedSet.delete(id);
  if(typeof savePushedState==="function")savePushedState();
  if(typeof saveDeletedState==="function")saveDeletedState();

  const roundTo15=m=>Math.ceil(m/15)*15;
  const active=scheduled.find(isActive);
  const cursor=roundTo15(active?pt(active.end):now());
  const blockers=(typeof _meetingBlocks==="function")?_meetingBlocks().slice():[];
  const startMin=(typeof _freeStart==="function")?_freeStart(cursor,d,blockers):cursor;
  const startStr=fmt(startMin);
  moved.start=startStr;
  moved.end=fmt(startMin+d);
  moved._pinnedStart=startStr;

  try{const pins=loadPinnedStarts();pins[id]=startStr;savePinnedStarts(pins)}catch(e){}

  const activeIdx=scheduled.findIndex(isActive);
  const insertAt=activeIdx!==-1?activeIdx+1:(()=>{
    const fi=scheduled.map((ev,i)=>({ev,i})).filter(({ev})=>!isDone(ev));
    return fi.length?fi[0].i:scheduled.length;
  })();
  scheduled.splice(insertAt,0,moved);
  if(typeof recalcTimes==="function")recalcTimes();
  if(typeof saveTaskOrder==="function")saveTaskOrder();
  if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
  return moved;
}

function _placeTaskAtEarliestCurrentDateSlot(id){
  const idx=scheduled.findIndex(e=>e.id===id);
  if(idx<0)return null;
  const moved=scheduled[idx];
  const d=dur(moved)||30;
  scheduled.splice(idx,1);
  _clearTaskPinAndLock(moved);
  pushedSet.delete(id);delete pushedAt[id];
  deletedSet.delete(id);
  if(typeof savePushedState==="function")savePushedState();
  if(typeof saveDeletedState==="function")saveDeletedState();

  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  const startMin=blocks.length?pt(blocks[0].start):7*60;
  moved.start=fmt(startMin);
  moved.end=fmt(startMin+d);
  scheduled.unshift(moved);
  if(typeof recalcTimes==="function")recalcTimes();
  if(typeof saveTaskOrder==="function")saveTaskOrder();
  if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
  return moved;
}

async function _hideSourceTaskForReschedule(id,fromDate,ev){
  pushedSet.delete(id);
  delete pushedAt[id];
  if(typeof savePushedState==="function")savePushedState();
  deletedSet.add(id);
  if(typeof saveDeletedState==="function")saveDeletedState();

  if(window.blockStore&&(ev.source==="manual"||ev.source==="pushed"||ev.source==="rescheduled"||ev._blockId)){
    await _removeTaskBlockFromDate(id,fromDate,ev);
  } else {
    try{
      const before=loadAddedTasks();
      const after=before.filter(t=>t.id!==id);
      if(after.length!==before.length)saveAddedTasks(after);
    }catch(e){}
  }
}

// Schedule `ev` (a task) onto an arbitrary `targetDate`. Picks a free slot from
// the day's existing meetings + already-scheduled blocks. Used by push-to-tomorrow
// and the generalized rescheduler.
async function schedulePushedOnDate(ev,targetDate,opts){
  opts=opts||{};
  if(!window.blockStore||!targetDate)return null;

  // Resolve target state (for meeting times + work-hour bounds)
  let targetState=null;
  if(targetDate===__todayDate&&window.__DCC_STATE__)targetState=window.__DCC_STATE__;
  else if(targetDate===__tomorrowDate&&window.__DCC_TOMORROW__)targetState=window.__DCC_TOMORROW__;
  if(!targetState){
    try{const r=await fetch("/api/state/day?date="+encodeURIComponent(targetDate));targetState=await r.json()}catch(e){}
  }

  const tTimeline=(targetState&&targetState.schedule&&targetState.schedule.timeline)||[];
  const tMeetings=tTimeline
    .filter(e=>e.type==="meeting"||e.type==="oneone"||e.type==="ooo"||e.type==="break")
    .map(e=>({s:pt(_toHHMM(e.start)),e:pt(_toHHMM(e.end))}))
    .sort((a,b)=>a.s-b.s);

  const tBlocks=(targetState&&targetState.schedule&&targetState.schedule.blocks)||[];
  const dayStart=tBlocks.length?pt(tBlocks[0].start):7*60;
  const dayEnd=tBlocks.length?pt(tBlocks[tBlocks.length-1].end):17*60+30;

  // Fetch existing blocks on the target date so we don't double-book
  let existingBlockers=[];
  try{
    const tBlks=await fetch("/api/blocks?date="+targetDate).then(r=>r.json());
    const existing=tBlks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===ev.id);
    if(existing){
      if(opts.useExisting)return existing;
      return null;
    }
    existingBlockers=tBlks
      .filter(b=>(b.type==="added_task"||b.type==="schedule_item"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.start&&b.properties.end)
      .map(b=>({s:pt(b.properties.start),e:pt(b.properties.end)}));
  }catch(e){}

  const allBlockers=[...tMeetings,...existingBlockers].sort((a,b)=>a.s-b.s);
  const d=dur(ev)||30;

  // When dropping onto today, anchor to "now" so we don't slot into the morning past.
  let cursor=dayStart;
  if(targetDate===_actualTodayStr()){
    const round15=m=>Math.ceil(m/15)*15;
    cursor=Math.max(dayStart,round15(now()));
  }
  const slot=_freeStart(cursor,d,allBlockers);

  if(slot+d>dayEnd+60){
    if(!opts.silent&&typeof showToast==="function")showToast("No free slot on "+_prettyDateLabel(targetDate)+"'s schedule","error");
    return null;
  }

  const startTime=fmt(slot);
  const endTime=fmt(slot+d);

  const block=await window.blockStore.createBlock("block",{
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
    commuteMinutes:ev.commuteMinutes||null,
    added_at:new Date().toISOString(),
    pushed_from:(__state&&__state.date)||"unknown"
  },{date:targetDate});

  if(!opts.silent&&typeof showToast==="function")showToast("Scheduled "+_prettyDateLabel(targetDate)+" at "+f12(startTime),"success");
  return block;
}

async function schedulePushedOnTomorrow(ev){
  if(!__tomorrowDate)return null;
  return schedulePushedOnDate(ev,__tomorrowDate);
}

async function unscheduleTaskFromDate(id,dateStr){
  if(!window.blockStore||!dateStr)return;
  try{
    const blks=await fetch("/api/blocks?date="+dateStr).then(r=>r.json());
    const match=blks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===id);
    if(match)await window.blockStore.deleteBlock(match.id);
  }catch(e){}
}

// ======== MOVE-TO MENU HELPERS ========
function _findTaskBlockForDate(id,dateStr,ev){
  if(!window.blockStore||!id)return null;
  const blocks=[...window.blockStore.getByType("added_task"),...window.blockStore.getByType("block")];
  const matches=blocks.filter(b=>{
    if(!b||b.deleted_at)return false;
    const p=b.properties||{};
    const ids=[p.local_id,b.id];
    if(ev&&ev._blockId)ids.push(ev._blockId);
    return ids.map(String).includes(String(id))||!!(ev&&ev._blockId&&String(b.id)===String(ev._blockId));
  });
  if(dateStr){
    const exact=matches.find(b=>b.date===dateStr);
    if(exact)return exact;
    const undated=matches.find(b=>!b.date);
    if(undated)return undated;
    // A specific source date was requested but the task has no block on it
    // (e.g. rescheduling a day-state task off a past day). Do NOT fall back to
    // matches[0] -- that can be a block we just created on the *target* date,
    // and deleting it would undo the move. Better to delete nothing.
    return null;
  }
  return matches[0]||null;
}

async function _removeTaskBlockFromDate(id,dateStr,ev){
  const block=_findTaskBlockForDate(id,dateStr,ev);
  if(block&&window.blockStore){
    try{await window.blockStore.deleteBlock(block.id);return true;}catch(e){}
  }
  return false;
}

// Schedule a task on an arbitrary date at the next free slot.
// Returns the start time string on success, null on failure (no slot, dedupe, or no blockstore).
async function _scheduleTaskOnDate(ev, dateStr, dayContext){
  if(!window.blockStore||!dateStr)return null;
  let tMeetings=[];
  let dayStart=8*60, dayEnd=17*60+30;
  if(dayContext){
    const tTimeline=(dayContext.schedule&&dayContext.schedule.timeline)||[];
    tMeetings=tTimeline
      .filter(e=>e.type==="meeting"||e.type==="oneone")
      .map(e=>({s:pt(_toHHMM(e.start)),e:pt(_toHHMM(e.end))}))
      .sort((a,b)=>a.s-b.s);
    const tBlocks=(dayContext.schedule&&dayContext.schedule.blocks)||[];
    if(tBlocks.length){dayStart=pt(tBlocks[0].start);dayEnd=pt(tBlocks[tBlocks.length-1].end);}
  }
  let existingBlockers=[];
  try{
    const tBlks=await fetch("/api/blocks?date="+dateStr).then(r=>r.json());
    const existing=tBlks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===ev.id);
    if(existing){
      const p=existing.properties||{};
      return p.start||null;
    }
    existingBlockers=tBlks
      .filter(b=>(b.type==="added_task"||b.type==="schedule_item"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.start&&b.properties.end)
      .map(b=>({s:pt(b.properties.start),e:pt(b.properties.end)}));
  }catch(e){}
  const allBlockers=[...tMeetings,...existingBlockers].sort((a,b)=>a.s-b.s);
  const d=dur(ev)||30;
  const slot=_freeStart(dayStart,d,allBlockers);
  if(slot+d>dayEnd+60){
    if(typeof showToast==="function")showToast("No free slot on "+dateStr,"error");
    return null;
  }
  const startTime=fmt(slot);
  await window.blockStore.createBlock("block",{
    local_id:ev.id,
    title:ev.title,
    duration:d,
    start:startTime,
    end:fmt(slot+d),
    priority:ev.priority||"Medium",
    meta:ev.meta||"",
    detail:ev.detail||"",
    notionUrl:ev.notionUrl||"",
    source:ev.source||"moved",
    tags:ev.tags||[],
    commuteMinutes:ev.commuteMinutes||null,
    added_at:new Date().toISOString(),
    moved_from:(__state&&__state.date)||"unknown"
  },{date:dateStr});
  return startTime;
}

function _nextSundayDate(){
  const now=new Date();
  const dow=now.getDay();
  const daysAhead=dow===0?7:(7-dow);
  const next=new Date(now);
  next.setDate(now.getDate()+daysAhead);
  const pad=n=>String(n).padStart(2,"0");
  return next.getFullYear()+"-"+pad(next.getMonth()+1)+"-"+pad(next.getDate());
}

function _purgeManualBlock(ev){
  if(!ev||ev.source!=="manual"||!window.blockStore)return;
  const dateStr=(__state&&__state.date)||null;
  _removeTaskBlockFromDate(ev.id,dateStr,ev);
}

async function moveTaskToToday(id){
  return rescheduleTaskToDate(id,_resolvedTodayDate());
}

function moveTaskToTomorrow(id){return rescheduleTaskToDate(id,_resolvedTomorrowDate());}

async function moveTaskToNextWeek(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  const sunday=_nextSundayDate();
  const startTime=await _scheduleTaskOnDate(ev,sunday,null);
  if(!startTime)return;
  deletedSet.add(id);saveDeletedState();
  _purgeManualBlock(ev);
  if(typeof showToast==="function")showToast("Moved to Sunday at "+f12(startTime),"success");
  render();
}

function moveTaskToTrivial(id){
  const flags=loadTrivialFlags();
  if(!flags[id]){
    flags[id]=true;
    saveTrivialFlags(flags);
  }
  if(typeof buildSchedule==='function')buildSchedule();
  if(typeof buildTrivialTasks==='function')buildTrivialTasks();
  if(typeof updateStats==='function')updateStats();
  if(typeof showToast==="function")showToast("Moved to trivial","success");
}

function moveScheduledTaskToSideProject(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return false;
  if(typeof addSideProjectTask==="function")addSideProjectTask(ev.title,dur(ev)||30);
  deletedSet.add(id);
  saveDeletedState();
  _purgeManualBlock(ev);
  log("side-project",id,"Moved to Side Projects: "+ev.title);
  if(typeof showToast==="function")showToast("Moved to Side Projects","success");
  recalcTimes();
  render();
  return true;
}

function _moveTaskToBacklogStage(id,stage,toastMsg){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  const entry={
    id:"bl-"+Date.now(),
    title:ev.title,
    type:ev.type||"task",
    durMin:dur(ev),
    meta:ms(dur(ev))+" · from schedule",
    detail:ev.detail||"",
    source:ev.source||"manual",
    notionUrl:ev.notionUrl||"",
    priority:ev.priority||(stage==="Priority"?"High":"Low"),
    stage:stage
  };
  backlog.push(entry);
  if(typeof persistBacklogItem==="function")persistBacklogItem(entry);
  deletedSet.add(id);saveDeletedState();
  _purgeManualBlock(ev);
  if(typeof showToast==="function")showToast(toastMsg,"success");
  render();
}

function moveTaskToBacklog(id){_moveTaskToBacklogStage(id,"Backlog","Moved to backlog");}
function moveTaskToPriority(id){_moveTaskToBacklogStage(id,"Priority","Moved to priority");}

async function unschedulePushedFromTomorrow(id){
  if(!__tomorrowDate)return;
  return unscheduleTaskFromDate(id,__tomorrowDate);
}

// Move a task off of the currently-viewed date and onto `targetDate`. Used by
// the reschedule popover (Today / Tomorrow / custom date) on every task card.
async function rescheduleTaskToDate(id,targetDate,opts){
  opts=opts||{};
  if(!targetDate)return;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  const fromDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  if(fromDate===targetDate){
    const isActualToday=targetDate===_resolvedTodayDate();
    const moved=isActualToday?_placeTaskAtNextTodaySlot(id):_placeTaskAtEarliestCurrentDateSlot(id);
    if(moved){
      log("rescheduled",id,"Moved within "+targetDate+": "+moved.title);
      const msg=isActualToday?"Moved to today's next free slot":"Moved to the earliest slot on "+_prettyDateLabel(targetDate);
      if(!opts.silent&&typeof showToast==="function")showToast(msg,"success");
      render();
      if(typeof checkOverflow==="function")checkOverflow();
    }
    return moved;
  }

  const movedTask=_cloneTaskForReschedule(ev,targetDate,fromDate);
  let block=null;
  try{
    block=await persistAddedTask(movedTask,targetDate);
  }catch(e){
    if(typeof showToast==="function")showToast("Could not move to "+_prettyDateLabel(targetDate),"error");
    return;
  }

  await _hideSourceTaskForReschedule(id,fromDate,ev);
  log("rescheduled",id,"Moved to "+targetDate+": "+ev.title);

  if(!opts.silent&&typeof showToast==="function")showToast("Moved to "+_prettyDateLabel(targetDate),"success");

  if(typeof recalcTimes==="function")recalcTimes();
  render();
  return block||movedTask;
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
let _deleteUndoTimers = {};
function openDeleteConfirm(id){
  deleteTaskWithUndo(id);
}
function deleteTaskWithUndo(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||deletedSet.has(id))return;
  if(_deleteUndoTimers[id]){
    clearTimeout(_deleteUndoTimers[id].timer);
    delete _deleteUndoTimers[id];
  }
  let blockId=null;
  if(ev.source==="manual"&&window.blockStore){
    const block=window.blockStore.getByType("block").find(b=>(b.properties||{}).local_id===id);
    blockId=block&&block.id;
  }
  deletedSet.add(id);
  saveDeletedState();
  log("deleted",id,"Removed from schedule: "+(ev?ev.title:id));
  recalcTimes();
  render();
  if(blockId&&window.blockStore){
    _deleteUndoTimers[id]={
      blockId,
      timer:setTimeout(()=>{
        const pending=_deleteUndoTimers[id];
        delete _deleteUndoTimers[id];
        if(pending&&deletedSet.has(id)){
          window.blockStore.deleteBlock(pending.blockId).catch(()=>{});
        }
      },8000)
    };
  }
  if(typeof showToast==="function"){
    showToast("Task deleted","success",8000,{
      label:"Undo",
      onClick:()=>undoDeleteTask(id)
    });
  }
}
function undoDeleteTask(id){
  if(_deleteUndoTimers[id]){
    clearTimeout(_deleteUndoTimers[id].timer);
    delete _deleteUndoTimers[id];
  }
  if(!deletedSet.has(id))return;
  deletedSet.delete(id);
  saveDeletedState();
  log("delete-undone",id,"Restored to schedule");
  recalcTimes();
  render();
  if(typeof showToast==="function")showToast("Task restored","success",2200);
}
function openDeleteConfirmLegacy(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  _delPendingId=id;
  document.getElementById("del-confirm-task").textContent=ev.title;
  const src=ev.source||"unknown";
  let msg="This removes the task from today's schedule.";
  if(src==="notion")msg+=" The task will remain on your Notion board and can be rescheduled.";
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
  closeDeleteConfirm();
  deleteTaskWithUndo(id);
}
document.getElementById("del-cancel").addEventListener("click",closeDeleteConfirm);
document.getElementById("del-go").addEventListener("click",confirmDeleteTask);
document.getElementById("del-confirm-overlay").addEventListener("click",function(e){if(e.target===this)closeDeleteConfirm()});

// ======== RESCHEDULE POPOVER ========
// Click the per-card "→" button to open this popover. Replaces the old
// hard-coded push-to-tomorrow with quick options for today/tomorrow/custom.
function openReschedulePopover(id,anchorEl){
  const ev=scheduled.find(e=>e.id===id);if(!ev)return;
  // Close any existing popovers
  document.querySelectorAll(".resched-popover,.dur-popover").forEach(p=>p.remove());
  document.querySelectorAll(".has-dur-popover").forEach(x=>x.classList.remove("has-dur-popover"));
  document.body.classList.remove("dur-open");

  const today=(typeof _actualTodayStr==="function")?_actualTodayStr():null;
  const currentDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);

  const pop=document.createElement("div");
  pop.className="dur-popover resched-popover";
  // Both quick buttons stay enabled. When the task is already on the day you're
  // viewing, the click handler re-slots it instead of no-opping, so the button
  // is never a dead end. (A disabled button reads as "broken".)
  pop.innerHTML=
    '<div class="resched-header">Move "'+ev.title.replace(/"/g,'&quot;')+'" to…</div>'+
    '<div class="resched-quick">'+
      '<button class="resched-btn" data-target="today">Today</button>'+
      '<button class="resched-btn" data-target="tomorrow">Tomorrow</button>'+
    '</div>'+
    '<div class="resched-custom">'+
      '<input type="date" class="resched-date-input" />'+
      '<button class="resched-go">Move</button>'+
    '</div>';

  function closePop(){
    pop.remove();
    document.removeEventListener("click",onOutside,true);
    document.removeEventListener("keydown",onKey,true);
  }
  function onOutside(e){if(!pop.contains(e.target)&&e.target!==anchorEl)closePop()}
  function onKey(e){if(e.key==="Escape")closePop()}

  // Quick buttons
  pop.querySelectorAll(".resched-btn").forEach(btn=>{
    btn.addEventListener("click",async e=>{
      e.stopPropagation();
      const target=btn.dataset.target;
      let dateStr=null;
      if(target==="today")dateStr=today;
      else if(target==="tomorrow")dateStr=__tomorrowDate;
      if(!dateStr){if(typeof showToast==="function")showToast("No date available","error");return}
      pop.querySelectorAll("button").forEach(b=>{b.disabled=true;});
      btn.textContent="Moving...";
      try{
        if(dateStr===currentDate&&target==="today"&&typeof moveTaskToToday==="function"){
          // Already viewing today: re-slot the task to the next free slot now.
          await moveTaskToToday(id);
        }else{
          // Cross-day moves create a target-day task; same-day planned views
          // re-slot within that date.
          await rescheduleTaskToDate(id,dateStr);
        }
      }finally{
        closePop();
      }
    });
  });
  // Custom date
  const dateInput=pop.querySelector(".resched-date-input");
  // Default to two days out (or tomorrow's tomorrow) so it differs from the quick buttons
  const seed=new Date();seed.setDate(seed.getDate()+2);
  const pad=n=>String(n).padStart(2,"0");
  dateInput.value=seed.getFullYear()+"-"+pad(seed.getMonth()+1)+"-"+pad(seed.getDate());
  pop.querySelector(".resched-go").addEventListener("click",e=>{
    e.stopPropagation();
    const v=dateInput.value;
    if(!v||!/^\d{4}-\d{2}-\d{2}$/.test(v)){if(typeof showToast==="function")showToast("Pick a valid date","error");return}
    closePop();
    rescheduleTaskToDate(id,v);
  });
  dateInput.addEventListener("keydown",e=>{
    if(e.key==="Enter"){e.preventDefault();pop.querySelector(".resched-go").click()}
  });

  // Position. The popover is position:fixed, so we work in viewport coords.
  // Append hidden first so we can measure its real size, then clamp it fully
  // on-screen. A naive right-align (right = innerWidth - rect.right) pushed the
  // popover -- and its left-most "Today" button -- off the left edge on narrow
  // / mobile viewports, making those buttons unclickable.
  pop.style.minWidth="220px";
  pop.style.visibility="hidden";
  document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect();
  const margin=8;
  const popW=pop.offsetWidth||220;
  const popH=pop.offsetHeight||0;
  let left=rect.right-popW; // prefer right-aligned to the button
  left=Math.max(margin,Math.min(left,window.innerWidth-popW-margin));
  let top=rect.bottom+6;
  if(top+popH>window.innerHeight-margin){
    // No room below -- prefer flipping above the anchor.
    const above=rect.top-popH-6;
    if(above>=margin)top=above;
  }
  // Final clamp so the popover is always fully within the viewport, even if the
  // anchor is partially scrolled off-screen.
  top=Math.max(margin,Math.min(top,window.innerHeight-popH-margin));
  pop.style.left=left+"px";
  pop.style.top=top+"px";
  pop.style.right="auto";
  pop.style.visibility="";
  setTimeout(()=>document.addEventListener("click",onOutside,true),0);
  document.addEventListener("keydown",onKey,true);
}

// ======== COMPLETION DATE CONFIRM ========
// Asks the user whether a completed-on-a-past-day task was actually finished today
// or back on its scheduled date. Future-date completions skip this and silently
// roll forward to today (handled in toggleDone).
let _cdcId=null,_cdcSourceDate=null,_cdcTodayStr=null;
function openCompletionDateConfirm(id,sourceDate,todayStr){
  const ev=scheduled.find(e=>e.id===id);
  const title=ev?ev.title:"this task";
  _cdcId=id;_cdcSourceDate=sourceDate;_cdcTodayStr=todayStr;

  let overlay=document.getElementById("cdc-overlay");
  if(!overlay){
    overlay=document.createElement("div");
    overlay.id="cdc-overlay";
    overlay.className="cdc-overlay";
    overlay.innerHTML=
      '<div class="cdc-box">'+
        '<div class="cdc-title" id="cdc-title">When was this completed?</div>'+
        '<div class="cdc-msg" id="cdc-msg"></div>'+
        '<div class="cdc-actions">'+
          '<button class="cdc-btn cdc-btn-source" id="cdc-source"></button>'+
          '<button class="cdc-btn cdc-btn-today" id="cdc-today">Today</button>'+
        '</div>'+
        '<button class="cdc-cancel" id="cdc-cancel">Cancel</button>'+
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click",e=>{if(e.target===overlay)closeCompletionDateConfirm()});
    document.getElementById("cdc-cancel").addEventListener("click",closeCompletionDateConfirm);
    document.getElementById("cdc-today").addEventListener("click",()=>{
      const id=_cdcId,today=_cdcTodayStr;
      closeCompletionDateConfirm();
      if(id&&today)toggleDone(id,{markOnDate:today,bringToToday:true});
    });
    document.getElementById("cdc-source").addEventListener("click",()=>{
      const id=_cdcId,src=_cdcSourceDate;
      closeCompletionDateConfirm();
      if(id&&src)toggleDone(id,{markOnDate:src});
    });
  }
  document.getElementById("cdc-title").textContent='When was "'+(title||"this task")+'" completed?';
  document.getElementById("cdc-msg").textContent="This task was scheduled for "+_prettyDateLabel(sourceDate)+". Mark it done on which date?";
  document.getElementById("cdc-source").textContent="On "+_prettyDateLabel(sourceDate);
  overlay.classList.add("open");
}
function closeCompletionDateConfirm(){
  const overlay=document.getElementById("cdc-overlay");
  if(overlay)overlay.classList.remove("open");
  _cdcId=null;_cdcSourceDate=null;_cdcTodayStr=null;
}
