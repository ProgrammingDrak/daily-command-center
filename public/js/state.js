// ======== STATE ========
let scheduled=JSON.parse(JSON.stringify(INIT_SCHED));
let consider=JSON.parse(JSON.stringify(INIT_CONSIDER));
let backlog=JSON.parse(JSON.stringify(INIT_BACKLOG));
let manualDone=new Set(), doneAt={}, actionLog=[], durChanges={}, commuteTimes={}, nextId=200, schedView="list";
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
// Canonical money formatter. Single source for every "$x.xx" in the client.
//   fmtMoney(1234)                -> "$12.34"
//   fmtMoney(0, {blankZero:true}) -> ""        (reward-queue style)
//   fmtMoney(-500, {abs:true})    -> "$5.00"   (punishment cost style)
function fmtMoney(cents, opts){
  opts = opts || {};
  let n = Number(cents) || 0;
  if(opts.abs) n = Math.abs(n);
  if(opts.blankZero && n === 0) return "";
  return "$" + (n / 100).toFixed(2);
}
function dur(ev){return pt(ev.end)-pt(ev.start)}
function origDur(id){const o=INIT_SCHED.find(e=>e.id===id);return o?dur(o):0}
function isMeeting(ev){return ev.type==="meeting"||ev.type==="oneone"}
// Registry-backed shims for the combined `isMeeting(ev)||ooo||break` predicate
// that used to be copy-pasted at ~a dozen call sites. Bare globals so call sites
// read like isMeeting(). Fall back to the historical inline literal only if the
// registry hasn't loaded (task-types.js loads first, so this is belt-and-braces).
function isFixed(ev){
  if(window.TaskTypes&&typeof window.TaskTypes.isFixed==="function")return window.TaskTypes.isFixed(ev);
  return !!ev&&(isMeeting(ev)||ev.type==="ooo"||ev.type==="break");
}
function pointEligible(ev){
  if(window.TaskTypes&&typeof window.TaskTypes.pointEligible==="function")return window.TaskTypes.pointEligible(ev);
  return !isFixed(ev);
}
// Two independent axes for a fixed-time block:
//  - reflow-exempt (fixedTime): recalcTimes never bumps it (isFixedTimeBlock).
//  - user-movable: the user can still drag / re-time it by hand.
// A DCC-owned meeting can hold its slot and still be moved manually. Imported
// calendar meetings remain source-owned. OOO and break rows are fixed too.
function userMovable(ev){
  const calendarOwned=ev&&(["calendar","gcal"].includes(String(ev.source||"").toLowerCase())||!!ev.calendarId||String(ev.sourceKey||"").startsWith("calendar:"));
  if(calendarOwned&&(ev.type==="meeting"||ev.kind==="meeting"||ev.type==="oneone"))return false;
  if(ev&&window.TaskTypes&&typeof window.TaskTypes.rule==="function")return window.TaskTypes.rule(ev,"movable")!==false;
  return !isMeeting(ev)&&(!ev||(ev.type!=="ooo"&&ev.type!=="break"));
}

// ======== WRAPS (v1) ========
// A "wrap" is a larger container block (a long session / focus block). Tasks
// nested inside it are "ride-alongs": concurrent work done within the wrap's
// time window. Ride-alongs carry wrapId = their parent's id; they do not push
// the cascade and render indented under their parent.
function isWrap(ev){return !!(ev&&(ev.isWrap||ev.type==="wrap"||(Array.isArray(ev.tags)&&ev.tags.includes("wrap"))));}
function wrapParentId(ev){return ev&&ev.wrapId?ev.wrapId:null;}
function isRideAlong(ev){return _TM().isRideAlong(ev);}
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
  const kids=_TM().ridersOf(ev.id,pool);
  if(!kids.length)return null;
  return {count:kids.length,mins:kids.reduce((s,k)=>s+(dur(k)||0),0)};
}

// ======== UNIFIED TASK TREE (wraps + subtasks, infinitely nestable) ========
// Every item can have a parent via one of two edge types:
//   wrapId    -> "ride-along" (concurrent, first-class row, has its own time)
//   subtaskOf -> "subtask"    (timeless step, smaller collapsible row)
// Both nest arbitrarily and intermix. recalcTimes skips anything nested.
//
// SUBTASK PARITY CONTRACT: a subtask is a FULL task — same blocks row, same
// creation serializer, same row builders (renderItineraryCard variant:"sub" /
// row() with node.rel==="subtask"), same wiring (details modal, radial, drag,
// checkbox). So the ONLY places allowed to branch on subtaskOf/isSubtask are the
// documented, minimal set below; anything else is a regression:
//   • these helpers + TaskModel.selectTree tree ordering
//   • recalcTimes isNested skips (drag.js) — nested rows take no cascade slot
//   • hydrate no-pin for subtasks (persistence.js)
//   • done-subtask fold filters (schedule-tab.js: fold under a visible parent)
//   • default focus-pill skip (schedule-tab.js)
//   • the points pipeline (point-plan.js, schedule.js award override, _onParentCompleted)
//   • create / reparent / promote (tabs.js addSubtask + addStackedTask, both via
//     the shared taskCommonProps/taskBlockProps serializer; drag.js _promoteMutate)
//   • subtask sibling-order persistence (persistence.js saveSubtaskOrder)
//   • the single variant:"sub" block inside each row builder
// C6a: these five are BARE GLOBALS with one definition each, in
// public/js/task-model.js. ~100 call sites read them by these names, so the names
// stay here and the bodies delegate — no second copy to drift. There is
// deliberately NO local fallback: task-model.js loads before this file in
// index.html, so a missing TaskModel is a load-order bug that should be loud, not a
// silently-divergent duplicate of the thing this phase exists to delete.
function _TM(){return DCC.TaskModel;}
function parentIdOf(ev){return _TM().parentIdOf(ev);}
function relOf(ev){return _TM().relOf(ev);}
function isSubtask(ev){return _TM().isSubtask(ev);}
function isNested(ev){return _TM().isNested(ev);}
function childrenOf(id,pool){return _TM().childrenOf(id,pool);}
// Subtask completion progress for a parent (recursive over subtask descendants).
// _seen guards against accidental parent cycles in the data.
//
// `doneFn` exists so the carryover lane can share this walk. A past-day row's
// completion is NOT isDone() (which reads today's manualDone registry) but the origin
// day's overlay, stamped on the row as `__unf.done` by the collector. schedule-tab.js
// used to carry a line-for-line copy of this function differing only in that predicate,
// so every fix to the walk had to be made twice; C1 flagged the duplication and left it
// because state.js was not Track C's file until C3.
function subtaskProgress(id,pool,doneFn,_seen){
  const isRowDone=doneFn||(s=>isDone(s));
  _seen=_seen||new Set();
  if(_seen.has(id))return null;
  _seen.add(id);
  const subs=_TM().subtasksOf(id,pool||scheduled);
  if(!subs.length)return null;
  let done=0,total=0;
  subs.forEach(s=>{total++;if(isRowDone(s))done++;const sub=subtaskProgress(s.id,pool,doneFn,_seen);if(sub){total+=sub.total;done+=sub.done;}});
  return {done,total};
}

// Rollup summary for a container type (shell): estimated points of the whole
// subtree — every descendant that isn't a pie subtask contributes its own
// estimate (PointPlan.estimatePool); a descendant owning a pie contributes its
// pool, which already covers its subtasks; nested rollup containers contribute
// only their subtrees. done/total counts direct children. This walker is the
// single source for both the card chip and _shellBonusPoints in schedule.js.
function shellRollup(id,pool){
  pool=pool||((typeof scheduled!=="undefined")?scheduled:[]);
  let points=0;
  const seen=new Set();
  (function walk(pid){
    if(seen.has(pid))return;
    seen.add(pid);
    childrenOf(pid,pool).forEach(c=>{
      if(relOf(c)==="subtask")return; // pie slices are covered by their parent's pool
      if(!(window.TaskTypes&&window.TaskTypes.isRollup(c))&&window.PointPlan){
        const hasPie=childrenOf(c.id,pool).some(k=>relOf(k)==="subtask");
        if(hasPie&&typeof window.PointPlan.compute==="function"){
          const plan=window.PointPlan.compute(c.id);
          points+=(plan&&plan.pool)||0;
        } else if(typeof window.PointPlan.estimatePool==="function"){
          points+=window.PointPlan.estimatePool(c.id)||0;
        }
      }
      walk(c.id);
    });
  })(id);
  const kids=childrenOf(id,pool);
  return {points:Math.round(points),done:_TM().selectDone(kids).length,total:kids.length};
}

// Capture a shell's subtree as a reusable, nesting-aware template — the saved
// structure a repeat responsibility drops back onto a day. Recurses via
// childrenOf/relOf; each node carries its own duration/priority/type/edge so
// materializeShellTemplate (schedule.js) can rebuild it exactly. Cycle- and
// depth-guarded. The root carries NO duration — a shell derives its length from
// its children (see _layoutShellChildren in drag.js).
function captureShellTemplate(shellId,pool){
  pool=pool||((typeof scheduled!=="undefined")?scheduled:[]);
  const root=pool.find(e=>e.id===shellId);
  if(!root)return null;
  const seen=new Set();
  function node(ev,depth,isRoot){
    seen.add(ev.id);
    const out={title:ev.title||"",type:ev.type||"task",priority:ev.priority||"Medium",detail:ev.detail||""};
    if(!isRoot){
      out.edge=(relOf(ev)==="subtask")?"subtask":"wrap";
      out.durationMin=Math.max(1,dur(ev)||0)||30;
    }
    const kids=(depth<20)?_TM().selectNotDeleted(childrenOf(ev.id,pool)).filter(c=>!seen.has(c.id)):[];
    out.children=kids.map(k=>node(k,depth+1,false));
    return out;
  }
  return {version:1,root:node(root,0,true)};
}

// Completion bonus for a rollup container: bonusPct × the subtree's estimated
// points, clamped to the ledger's 1..500 override range. THE single formula —
// the preview chip (shellRollupChip) and the awarded points_override
// (_shellBonusPoints in schedule.js) must both call this so they can't drift.
function shellBonus(points,pct){
  return (points>0&&pct>0)?Math.max(1,Math.min(500,Math.round(points*pct))):0;
}

// True when a rollup container still has open children — its checkbox is
// display-only until they finish (toggleDone enforces the same rule).
function shellCompleteBlocked(ev){
  return !!(ev&&window.TaskTypes&&window.TaskTypes.rule(ev,"blockManualCompleteWithOpenChildren")&&
    typeof scheduled!=="undefined"&&_TM().selectOpen(childrenOf(ev.id,scheduled)).length>0);
}

// Meta chip for a rollup container: children's points, progress, bonus preview.
function shellRollupChip(ev){
  if(!(ev&&window.TaskTypes&&window.TaskTypes.isRollup(ev)))return "";
  const r=shellRollup(ev.id);
  if(!r.total)return "";
  const pct=Number(window.TaskTypes.rule(ev,"bonusPct"))||0;
  const bonus=shellBonus(r.points,pct);
  const title=(r.points+" pts across nested tasks · "+r.done+"/"+r.total+" done"+(bonus?" · +"+bonus+" pt bonus when all finish":"")).replace(/"/g,"&quot;");
  return '<span class="points-chip shell-chip" title="'+title+'">&Sigma; '+r.points+' pts · '+r.done+'/'+r.total+(bonus?' · +'+bonus+' bonus':'')+'</span>';
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
// Collapse or expand a batch of parent rows at once (used by the itinerary's
// Collapse all / Expand all controls).
function setCollapsedAll(ids,collapsed){
  const s=loadCollapsed();
  (ids||[]).forEach(id=>{if(collapsed)s.add(id);else s.delete(id);});
  try{localStorage.setItem("pa-collapsed-v1",JSON.stringify([...s]));}catch(e){}
}

// C6a: `flattenSchedule` MOVED to TaskModel.selectTree. It is gone, not wrapped —
// the point of the move is that roots resolve against a POOL rather than the input
// array, and a compatibility shim taking only `items` would have kept every caller
// on the orphan-promoting behaviour while looking fixed. Call sites name their pool.
function now(){return new Date().getHours()*60+new Date().getMinutes()}
function isDone(ev){return manualDone.has(ev.id)}
function isPast(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.end)}
function isActive(ev){return!manualDone.has(ev.id)&&now()>=pt(ev.start)&&now()<pt(ev.end)}
function log(type,id,detail){actionLog.push({type,id,detail,ts:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true})})}

// ======== SOURCE TAGS ========
// Source chips ("slack-bookmark", "quick-task", …) were dropped from rows as
// noise; call sites remain so the chips can come back by reviving this body.
// sourceJumpLink still deep-links back to the source where a URL exists.
function srcTag(){return ''}

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
function normalizeCommutePair(value){
  if(value&&typeof value==="object"){
    const to=normalizeCommuteMinutes(value.to||value.there||value.outbound||value.commuteToMinutes||value.commute_to_minutes||value.commuteMinutes||value.commute_minutes||value.commuteTime);
    const back=normalizeCommuteMinutes(value.back||value.return||value.inbound||value.commuteBackMinutes||value.commute_back_minutes||value.commuteReturnMinutes||value.commute_return_minutes||value.returnCommuteMinutes);
    return {to,back,total:to+back};
  }
  const to=normalizeCommuteMinutes(value);
  return {to,back:0,total:to};
}
function commutePairForTask(ev){
  if(!ev)return {to:0,back:0,total:0};
  return normalizeCommutePair({
    commuteToMinutes:ev.commuteToMinutes||ev.commute_to_minutes||ev.commuteMinutes||ev.commute_minutes||ev.commuteTime,
    commuteBackMinutes:ev.commuteBackMinutes||ev.commute_back_minutes||ev.commuteReturnMinutes||ev.commute_return_minutes||ev.returnCommuteMinutes
  });
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
  const commute=commutePairForTask(ev).to;
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
  const pair=commutePairForTask(ev);
  const returnPart=pair.back?(", "+pair.back+"m back"):"";
  const title=(win.commuteMinutes+"m there"+returnPart+", "+win.bufferMinutes+"m departure window").replace(/"/g,"&quot;");
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
function _applyCommutePairToEvent(ev,pair){
  if(!ev)return;
  if(pair.to){
    ev.commuteMinutes=pair.to;
    ev.commuteToMinutes=pair.to;
  }else{
    delete ev.commuteMinutes;
    delete ev.commuteToMinutes;
  }
  if(pair.back)ev.commuteBackMinutes=pair.back;
  else delete ev.commuteBackMinutes;
}
// opts.blockId: address the row directly (C4). `_commuteBlockForTask` searches
// _dayCache/_globalCache, which never hold a past-day carryover row, so commute minutes
// set from the details modal on a carryover landed only in the day-scoped `commuteTimes`
// map -- recorded against the wrong day and never on the row. Now that the modal opens on
// carryover rows, the caller passes the row id it already has.
function setTaskCommuteTimes(taskId,value,opts){
  if(!taskId)return;
  opts=opts||{};
  const pair=normalizeCommutePair(value);
  if(pair.total)commuteTimes[taskId]=pair.back?{to:pair.to,back:pair.back}:pair.to;
  else delete commuteTimes[taskId];
  // BOTH pools, via the shared anchor. A carryover ev is not in `scheduled[]` -- it lives in
  // the lane's cache, and taskAnchorById hands the details modal that exact object. Reaching
  // the ROW but not the EV was a live data-loss loop, because the modal seeds its commute
  // inputs from the ev and closeAddModal persists them on EVERY close:
  //   1. open a carryover row, type 20, close -> the ROW gets commuteToMinutes:20
  //   2. reopen -> commutePairForTask reads the STALE ev -> both inputs render empty
  //   3. close -> persistAddModalCommute writes {to:0,back:0} -> _commuteProps DELETES the
  //      keys, destroying what step 1 saved, with no toast and no reload needed.
  // For a row in scheduled[] the anchor returns that same ev, so nothing changes there.
  const anchor=(typeof taskAnchorById==="function")?taskAnchorById(taskId):null;
  const ev=(anchor&&anchor.ev)||scheduled.find(e=>e.id===taskId);
  _applyCommutePairToEvent(ev,pair);
  saveCommuteTimes();
  // With a row id, go through the SHARED serialized queue. Two reasons, and the second is
  // the one that bit: (a) blockStore.get and _commuteBlockForTask both read
  // _dayCache/_globalCache only, and the row this path exists for -- a past-day carryover --
  // is in _rangeCache or nowhere, so the id alone was not enough and resolving with `get()`
  // fell through to the same no-op it was meant to remove; (b) this is a read-modify-write
  // on the same properties bag the details modal's title/tag/flag writes touch, and
  // closeAddModal calls persistAddModalCommute on EVERY close -- so an unserialized write
  // here clobbers a rename made moments earlier in the same modal.
  if(opts.blockId&&window.blockStore){
    enqueueRowPropsWrite(opts.blockId,props=>_commuteProps(props,pair));
    return;
  }
  const block=_commuteBlockForTask(taskId);
  if(block&&window.blockStore)window.blockStore.updateBlock(block.id,_commuteProps(block.properties,pair));
}

// The commute half of a properties bag, shared by both resolution paths above so they
// cannot drift on which keys get written and which get deleted.
function _commuteProps(properties,pair){
  const props={...(properties||{})};
  if(pair.to){
    props.commuteMinutes=pair.to;
    props.commuteToMinutes=pair.to;
  }else{
    delete props.commuteMinutes;
    delete props.commuteToMinutes;
  }
  if(pair.back)props.commuteBackMinutes=pair.back;
  else delete props.commuteBackMinutes;
  return props;
}
function setTaskCommuteMinutes(taskId,value){
  setTaskCommuteTimes(taskId,{to:value,back:0});
}
function hydrateTaskCommuteTimes(){
  commuteTimes=loadCommuteTimes();
  scheduled.forEach(ev=>{
    const fromEvent=commutePairForTask(ev);
    const fromMap=normalizeCommutePair(commuteTimes[ev.id]);
    const pair=fromMap.total?fromMap:fromEvent;
    _applyCommutePairToEvent(ev,pair);
  });
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

// ======== PUSHED TO TOMORROW — DELETED (C3) ========
// "Pushed" was never a state, only a duplicate wearing one. pushTask used to add the
// id to `pushedSet`, leave the row sitting on today under a greyed "Pushed to Tomorrow"
// divider, AND create a second block on tomorrow carrying the same local_id — so the
// task existed on both days and neither copy was authoritative. Push is now a real
// move through the one mover (see pushTask), so there is no flag to keep: the row is on
// exactly one day, and the origin day shows the amber "Rescheduled away" entry whose
// Restore button brings it back.
//
// Retired with it: PUSHED_KEY / pushedSet / pushedAt / savePushedState / isPushed, the
// `_pushed` day_root write, unpushTask, unschedulePushedFromTomorrow, and the
// pa-deferred-* mirror (whose "for scheduler pickup" comment was stale — nothing read it).
// Legacy `_pushed` overlays on old day_roots are handled at hydration; see persistence.js.

// ======== PINNED ACTIVE TASK (PIN 1) ========
// Separate from _pinnedStart (schedule.js) — this is a *single* task id
// the user has "pinned as active" by dragging the now-pill onto it (or
// clicking its timeline dot). It drives the .tl-node "how far behind" gradient (see
// getPinnedOverdueStyle: blue at +1 min overdue → flashing red at +6 h,
// measured from the task's scheduled START).
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
// "How far behind" gradient for the pinned task. The pill walks a fixed set of
// color stops as the task slips further past its scheduled start: the gradient
// starts at +1 min overdue (blue) and ends at +6 h overdue (a flashing,
// pulsating red). Returns null when this task isn't pinned or isn't overdue yet
// (the pill stays its normal active blue for the first minute).
const PINNED_OVERDUE_START_MIN = 1;     // +1 min overdue → start of gradient
const PINNED_OVERDUE_END_MIN = 360;     // +6 h overdue → end of gradient (flashing red)
const PINNED_AGING_STOPS = [
  [59,130,246],   // blue
  [30,58,138],    // dark blue
  [22,101,52],    // dark green
  [34,197,94],    // green
  [134,239,172],  // light green
  [250,204,21],   // yellow
  [202,138,4],    // dark yellow
  [249,115,22],   // orange
  [194,65,12],    // burnt orange
  [239,68,68],    // red
  [220,38,38],    // deep red (flashing + pulsating at the end)
];
function _mixRgb(a,b,t){
  return [Math.round(a[0]+(b[0]-a[0])*t),Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t)];
}
function getPinnedOverdueStyle(ev){
  if (!ev || _pinnedActiveId !== ev.id) return null;
  const overdue = now() - pt(ev.start);
  if (overdue < PINNED_OVERDUE_START_MIN) return null;   // not behind yet → normal blue pill
  const span = PINNED_OVERDUE_END_MIN - PINNED_OVERDUE_START_MIN;
  const t = Math.max(0, Math.min(1, (overdue - PINNED_OVERDUE_START_MIN) / span));
  const stops = PINNED_AGING_STOPS, segs = stops.length - 1;
  const pos = t * segs, i = Math.min(segs - 1, Math.floor(pos));
  const rgb = _mixRgb(stops[i], stops[i+1], pos - i);
  const lum = 0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2];
  return {
    bg: "rgb("+rgb[0]+","+rgb[1]+","+rgb[2]+")",
    fg: lum > 150 ? "#0b1220" : "#ffffff",   // dark text on the light-green/yellow band, white elsewhere
    pulse: overdue >= PINNED_OVERDUE_END_MIN,
    minutes: overdue,
  };
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

// _rescheduledTaskId / _cloneTaskForReschedule DELETED (C3). A move that mints a new
// id (`<id>-resched-<date>`) is not a move: it left the origin row in place, produced a
// second identity for one task, and — because the clone's tombstone omitted
// movedBlockId, which restoreRescheduledAway requires — its amber Restore button could
// never work. Date changes go through POST /api/blocks/:id/reschedule, which re-dates
// the row and keeps its id. See rescheduleTaskToDate.

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
  deletedSet.delete(id);
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
    const firstOpen=_TM().selectOpen(scheduled)[0];
    const fi=firstOpen?scheduled.indexOf(firstOpen):-1;
    return fi===-1?scheduled.length:fi;
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
  deletedSet.delete(id);
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

// _hideSourceTaskForReschedule / _rescheduleSubtaskSubtree DELETED (C3). They existed
// to clean up after the clone move: hide the row the clone left behind, and re-clone
// the subtask subtree under the clone's new parent id. A move that re-dates the row in
// place leaves nothing to hide and nothing to re-parent. What replaces them for the one
// remaining non-row case is _materializeTaskOnDate below.

// The ONE case that is not a re-date: `ev` has no backing row on the origin day, so
// there is no `:id` for POST /api/blocks/:id/reschedule to move. That is a day-state-only
// task (a Notion/DCC-ingested item the fold renders straight from the day's JSON).
// Give it a row on the TARGET date under its EXISTING id — same identity, not a clone —
// and hide the day-state copy on the origin day.
//
// Its subtasks are a real case, and the plan said they were not: BOTH subtask creation
// paths (tabs.js addSubtask + the legacy-store migration) create a block for the subtask
// whether or not the PARENT has one, so a day-state-only parent can absolutely own
// block-backed subtasks. Those are rows, so they move through the real mover — one call
// per direct child, each of which carries its own nested subtree server-side. Dropping
// them here would strand them on the origin day under a parent that is gone, which is
// the exact bug this phase exists to delete.
async function _materializeTaskOnDate(ev,id,targetDate,fromDate,pinned,opts){
  opts=opts||{};
  const item=Object.assign({},ev);
  if(pinned){
    item.start=pinned;
    item.end=fmt(pt(pinned)+(dur(ev)||30));
    item._pinnedStart=pinned;
  }
  let block=null;
  try{
    block=await persistAddedTask(item,targetDate);
  }catch(e){
    if(!opts.silent&&typeof showToast==="function")showToast("Could not move to "+_prettyDateLabel(targetDate)+(e&&e.message?" — "+e.message:""),"error");
    // FALSE, not null: callers must be able to tell "the task did not move" from
    // "queued, it will land" — toggleDone commits a completion on the strength of it.
    return false;
  }
  // Children BEFORE the view cleanup: the lookups below read `scheduled`, so removing
  // rows from it first would hide the very children that need moving.
  const childMove=await _moveOriginDayChildrenTo(id,targetDate,fromDate);
  // A child that did NOT move is still on this day, so it must stay in the view. Captured
  // before the removal below, which walks the whole subtree and would splice it out — hiding
  // it for one render and then resurrecting it as an orphaned root on the next reload, which
  // is the stranding this phase exists to delete, just deferred.
  const keepVisible=childMove.failed.map(fid=>scheduled.find(e=>e.id===fid)).filter(Boolean);
  // Snapshot pin/lock for those rows. _removeSubtreeFromScheduled runs _clearTaskPinAndLock on
  // everything it splices, which deletes the ev fields AND the entries in the persisted
  // pinned-starts / locked maps — so a task that never left the day would silently lose a
  // start the user pinned, permanently, since persistence.js rehydrates from those maps.
  const keptPins=keepVisible.map(e=>({id:e.id,pinnedStart:e._pinnedStart,locked:e._locked}));
  // Same optimistic cleanup the true move does. Without it the children whose rows were
  // just re-dated stay in `scheduled` on this day, and because their parent is now
  // filtered out they would render as top-level OPEN roots AND keep counting toward the
  // day's scheduled points. (C6a: TaskModel.selectTree now HIDES a child whose parent is
  // in the pool but filtered from the input, so the promotion only happens when the
  // parent is genuinely gone -- but this cleanup is still what stops the points count.)
  _removeSubtreeFromScheduled(id);
  for(const back of keepVisible)if(!scheduled.find(e=>e.id===back.id))scheduled.push(back);
  // Put back what the removal wiped off the rows that stayed.
  if(keptPins.some(k=>k.pinnedStart||k.locked)){
    try{
      const pins=loadPinnedStarts();
      const locks=new Set(loadLockedSet());
      for(const k of keptPins){
        const ev2=scheduled.find(e=>e.id===k.id);
        if(k.pinnedStart){pins[k.id]=k.pinnedStart;if(ev2)ev2._pinnedStart=k.pinnedStart;}
        if(k.locked){locks.add(k.id);if(ev2)ev2._locked=k.locked;}
      }
      savePinnedStarts(pins);
      saveLockedSet([...locks]);
    }catch(e){}
  }
  // The optimistic removal is per-render; the overlay is what survives a reload, because
  // the day-state JSON still lists the parent. Both are needed.
  deletedSet.add(id);
  for(const rowlessId of childMove.hidden)deletedSet.add(rowlessId);
  if(typeof saveDeletedState==="function")saveDeletedState();
  try{
    const before=loadAddedTasks();
    const after=before.filter(t=>t.id!==id);
    if(after.length!==before.length)saveAddedTasks(after);
  }catch(e){}
  await _writeRescheduleTombstone(ev,fromDate,targetDate,block&&block.id,childMove.hidden);
  log("rescheduled",id,"Moved to "+targetDate+": "+ev.title);
  // A half-move must not report as a clean one — and unlike the success toast, this one is
  // NOT suppressed by opts.silent. The silent caller is toggleDone's done-on-date flow, which
  // goes on to mark the task complete; "some of this task stayed on another day" is exactly
  // what that caller must not swallow.
  if(typeof showToast==="function"){
    if(childMove.failed.length){
      showToast("Moved to "+_prettyDateLabel(targetDate)+" — "+childMove.failed.length+" subtask"+(childMove.failed.length>1?"s":"")+" stayed behind","info",4200);
    } else if(!opts.silent){
      showToast("Moved to "+_prettyDateLabel(targetDate),"success");
    }
  }
  if(typeof recalcTimes==="function")recalcTimes();
  render();
  return block||item;
}

// Re-date the block-backed direct children of `parentId` onto `targetDate` through the
// real mover. Only reachable from _materializeTaskOnDate: when the parent IS a row the
// server walks the whole subtree itself in one transaction, and this would be a second,
// weaker copy of that walk.
//
// Returns { hidden, failed }: ids with no row of their own (which can only be hidden, not
// moved) and children whose move was permanently rejected. Both are cases where a child
// would otherwise be left on the origin day under a parent that is gone — the stranding
// this phase exists to delete — so neither may be swallowed.
// `_seen` guards the recursion: `scheduled` carries real parent cycles (see _subtreeIdsOf).
async function _moveOriginDayChildrenTo(parentId,targetDate,fromDate,_seen){
  const out={hidden:[],failed:[]};
  if(!window.blockStore||typeof window.blockStore.rescheduleBlock!=="function")return out;
  _seen=_seen||new Set();
  if(_seen.has(parentId))return out;
  _seen.add(parentId);
  const kids=childrenOf(parentId,scheduled);
  for(const kid of kids){
    const kidBlock=_findTaskBlockForDate(kid.id,fromDate,kid);
    if(!kidBlock){
      // Day-state-only child: there is no row to re-date, so MATERIALIZE it on the target
      // date exactly as its parent is materialized, then hide the origin day's day-state
      // copy. Hiding without creating is what the first cut of this did, and it deleted the
      // subtask outright: the day-state entry was its only representation, so once it was in
      // the origin day's `_deleted` overlay the task existed on no day at all — and
      // unrecoverably, because Restore un-hides the parent's id and nothing else ever
      // removes an id from `_deleted` for a task with no visible row.
      // persistAddedTask carries subtaskOf/wrapId through, so the nesting edge survives.
      //
      // `_seen` gates the CREATE, not just the recursion below. A parent cycle (A->B->A, and
      // this repo's data really carries them — see _subtreeIdsOf) walks back onto an id this
      // same move already materialized: the row is on the TARGET date by then, so
      // _findTaskBlockForDate refuses it (it will not return a row from another date) and
      // this branch would mint a SECOND row with the same local_id. The fold dedupes by ev id,
      // so the twin renders nowhere while both rows exist — one task, two rows, neither
      // authoritative, which is the exact failure the pushed subsystem was deleted over.
      // Skipping is safe: the recursion would have returned immediately on `_seen`, and the
      // root is already hidden by _materializeTaskOnDate.
      if(_seen.has(kid.id))continue;
      let kidBlk=null;
      try{kidBlk=await persistAddedTask(Object.assign({},kid),targetDate);}catch(e){
        console.warn("[reschedule] subtask "+kid.id+" could not be materialized: "+(e&&e.message));
      }
      if(!kidBlk){
        // The create was refused, so this child stays on the origin day — and so must its
        // WHOLE subtree. Descending anyway would materialize its children on the target date
        // under a parent that is not there, and `subtaskOf` pointing at nothing renders them
        // at depth 0: a subtask silently promoted to a top-level task on another day.
        for(const sid of _subtreeIdsOf(kid.id))out.failed.push(sid);
        continue;
      }
      out.hidden.push(kid.id);
      const nested=await _moveOriginDayChildrenTo(kid.id,targetDate,fromDate,_seen);
      out.hidden.push(...nested.hidden);
      out.failed.push(...nested.failed);
      continue;
    }
    try{
      await window.blockStore.rescheduleBlock(kidBlock.id,targetDate,{fromDate});
    }catch(e){
      // Permanent means it will never land; transient stays in the WAL and still will.
      // The whole subtree stays, not just this row: the server walks a subtree in ONE
      // transaction, so a permanent rejection here means nothing under `kid` moved either.
      // Recording only `kid` left its descendants spliced out of the view and in neither
      // `hidden` nor `failed` — gone from the origin day until the next fold.
      if(e&&e.permanent){for(const sid of _subtreeIdsOf(kid.id))out.failed.push(sid);}
      console.warn("[reschedule] subtask "+kid.id+" did not follow its parent: "+(e&&(e.message||e.status)));
    }
  }
  return out;
}

// Schedule `ev` (a task) onto an arbitrary `targetDate` at a free slot, picked from
// that day's meetings + already-scheduled blocks by the shared engine.
//
// This CREATES a block; it does not move one. Its only caller now is delegated.js
// (scheduling a Delegated / Blocked item onto a day it isn't on yet) — the push flow
// that named it is gone, so the name is too. Anything that needs to change an existing
// task's date wants rescheduleTaskToDate, not this.
async function scheduleTaskOnDate(ev,targetDate,opts){
  opts=opts||{};
  if(!window.blockStore||!targetDate)return null;

  // Day context (state + blocks) and the free slot both come from the shared
  // engine now, so this create path can never disagree with the picker preview
  // or the reschedule compute. See day-context.js for the canonical rule set.
  const ctx=await window.DCC.getDayContext(targetDate);
  if(!ctx)return null;

  // Dedupe: if this task already has a block on the target day, don't double-book.
  const existing=(ctx.blocks||[]).find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===ev.id);
  if(existing){
    if(opts.useExisting)return existing;
    return null;
  }

  const slot=window.DCC.findSlot(ev,ctx,{anchorNow:true});
  if(!slot){
    if(!opts.silent&&typeof showToast==="function")showToast("No free slot on "+_prettyDateLabel(targetDate)+"'s schedule","error");
    return null;
  }

  // No `<verb>_from` provenance key here. The old one (`pushed_from`) had no readers, and
  // renaming it would just add a third dead spelling beside it and `moved_from` (written by
  // the deleted _scheduleTaskOnDate) — none of which TaskModel.fromBlock models, so none of
  // which can ever reach an ev. The repo's real provenance key is `rescheduledFrom`, which
  // fromBlock does model, and it means "this row was moved here", which is not what this
  // create-on-a-target-date path does. `added_at` already records when.
  const block=await window.blockStore.createBlock("block",Object.assign(
    window.DCC.taskBlockProps(ev,{local_id:ev.id,duration:slot.duration,start:slot.start,end:slot.end,source:ev.source||"manual"}),
    {added_at:new Date().toISOString()}
  ),{date:targetDate});

  if(!opts.silent&&typeof showToast==="function")showToast("Scheduled "+_prettyDateLabel(targetDate)+" at "+f12(slot.start),"success");
  return block;
}

async function unscheduleTaskFromDate(id,dateStr){
  if(!window.blockStore||!dateStr)return;
  try{
    const blks=await fetch("/api/blocks?date="+dateStr).then(r=>r.json());
    const match=blks.find(b=>(b.type==="added_task"||b.type==="block")&&!b.deleted_at&&b.properties&&b.properties.local_id===id);
    if(match)await window.blockStore.deleteBlock(match.id);
  }catch(e){}
}

// ======== C4: THE DATE FIELD, IN PLACE ========
// Two primitives, and they are the fourth and fifth verbs in this file that change a
// task's date. The other three, for whoever adds a sixth:
//   scheduleTaskOnDate(ev,date)     CREATES a new block on a date (delegated.js)
//   unscheduleTaskFromDate(id,date) DELETES the block on a date (rewards-queue.js)
//   rescheduleTaskToDate(id,date)   MOVES a row + its subtree, server transaction (C3)
// These two do neither: they UPDATE `date` on a row that already exists, keeping its
// id, its local_id, its notes, its points and its parent edges. That is the whole
// point of C4 -- the old paths delete-and-recreate, so a round trip minted a new id
// and orphaned everything keyed to the old one.
//
// They take a BLOCK id, not an ev/local id. The three verbs above take ev ids, and
// conflating the two id spaces is this repo's most expensive recurring bug (C3's
// subtree walk, E1's dual-identity _done overlay). The `Row` in the name is the
// reminder. Callers holding an ev use ev._blockId, which TaskModel.fromBlock sets.
//
// Reuse, not a new mechanic: `blockStore.updateBlock(id, props, {date})` is the exact
// call `syncAddedTaskTimes` (schedule.js) already used to promote a dateless row onto
// today, and `_unfToBacklog` (unfinished-tasks.js, C1) already used with {date:null}
// to send a carryover the other way. block-store.js documents `extra.date` for this.
// Both of those now route through here so there is one mechanic, not three.

// Give an existing row a date. opts.start/opts.end stamp a slot at the same time
// (one write, not two). Returns the updated block, or null if it could not be found.
//
// opts.block: a caller that has ALREADY resolved the row passes it here, and that is
// the preferred form. Blocks live in three different caches and no single resolver
// reaches all of them — a backlog row is in _globalCache, today's rows in _dayCache, a
// past-day carryover ONLY in _rangeCache — so each caller knows something this function
// cannot. `_rowForDateWrite` is the fallback for callers holding nothing but an id, and
// it costs an HTTP GET whenever the row is not in the two caches blockStore.get() reads.
async function scheduleRowOnDay(blockId,dateStr,opts){
  opts=opts||{};
  if(!window.blockStore||!blockId||!dateStr)return null;
  // Read the row BEFORE writing. updateBlock REPLACES properties wholesale
  // (db.js: newProps = parsed) rather than merging, so spreading a missing block
  // writes {start,end} over the row and destroys title/local_id/subtaskOf/notes.
  // That is exactly the data loss pre-review found in C1's toBacklog; the guard is
  // the same one, and it must refuse BEFORE the write because updateBlock swallows
  // its own errors and returns.
  const block=(opts.block&&opts.block.properties)?opts.block:await _rowForDateWrite(blockId);
  if(!block||!block.properties)return null;
  const props=Object.assign({},block.properties);
  if(opts.start)props.start=opts.start;
  if(opts.end)props.end=opts.end;
  // A row arriving from the backlog carries kind:"backlog" (and legacy dated ones
  // carry it too). It is scheduled work now, so the marker goes -- otherwise it
  // renders in the Backlog drawer AND on its day, which is the double home C4 exists
  // to close. `stage` stays: it is a real user field (Backlog / Priority), not state.
  if(props.kind==="backlog")delete props.kind;
  return _writeRowDate(blockId,block,props,dateStr);
}

// Take an existing row's date away: it becomes unscheduled, which is the Backlog.
// opts.stage sets the Backlog/Priority drawer it lands in.
// opts.block: the already-resolved row — see scheduleRowOnDay for why that matters.
// opts.durMin: the row's REAL duration, from the caller that knows it. Required for
//   correctness, not a convenience — see below.
async function unscheduleRow(blockId,opts){
  opts=opts||{};
  if(!window.blockStore||!blockId)return null;
  const block=(opts.block&&opts.block.properties)?opts.block:await _rowForDateWrite(blockId);
  if(!block||!block.properties)return null;
  const props=Object.assign({},block.properties,{kind:"backlog"});
  // hydrateBacklogFromBlocks reads durMin, not duration (C1 hit this exact drift).
  //
  // opts.durMin comes FIRST because `properties.duration` is written once at create time
  // and never updated by a duration change: adjustDur / setDurAbsolute (schedule.js) only
  // move `ev.end` and record `durChanges` on the day_root overlay. So a task created at
  // 30m and adjusted to 90m still has duration:30 on the row while the itinerary shows 90.
  // Deriving from the row alone (which the first cut did) silently reset an adjusted
  // duration on the way to the backlog, and deleting start/end below destroyed the only
  // other record of it. The ev is the one thing that knows, so the caller passes it.
  // Validated, not trusted. The caller passes dur(ev) = pt(end) - pt(start), which is
  // NEGATIVE whenever an ev's end wrapped past midnight: recalcTimes writes ev.end without
  // a day clamp, so a 23:00 task with 90m gets "24:30", and pt() wraps the hour, making
  // dur(ev) -1350. The row's stored duration used to act as a floor; writing an unvalidated
  // value into BOTH spellings removes that floor, and every downstream reader filters only
  // falsy, not negative (fromBlock's `p.duration || 30`, hydrateBacklogFromBlocks'
  // `p.durMin || 30`). That is the negative-duration -> findSlot -> "end like -22:00" -> 400
  // chain task-model.js documents as a real incident that left rows stuck on every surface.
  props.durMin=_positiveDuration(opts.durMin,props.durMin||props.duration);
  // Keep the two spellings together: fromBlock reads `duration`, the backlog projection
  // reads `durMin`, and letting them disagree is how the 30-vs-90 drift got in.
  props.duration=props.durMin;
  if(opts.stage)props.stage=opts.stage;
  // A stored start is meaningless on a dateless row -- TaskModel.fromBlock ignores it
  // and renders the row untimed either way, so leaving it behind just means the next
  // reader has to know to ignore it. _pinnedStart would additionally survive a round
  // trip and pin the task to a stale slot the moment it is scheduled again.
  delete props.start;delete props.end;delete props._pinnedStart;
  return _writeRowDate(blockId,block,props,null);
}

// The one write both primitives issue, and the one place that knows what
// blockStore.updateBlock's return value is worth.
//
// A falsy return does NOT mean the write failed. updateBlock answers the server row on
// success and `optimistic || existing` on a buffered failure — and `existing` is
// cacheGet(id), which is NULL for any row outside _dayCache/_globalCache. A past-day
// carryover row is precisely that, so the one caller most likely to hit a hiccup is the
// one whose "failure" value is null. The mutation is in the WAL regardless (updateBlock
// pre-writes it and never throws), so it WILL land on reconnect. Reporting failure there
// would toast "Could not move…" over a move that then quietly happened — worse than
// saying nothing, because the user re-does it.
//
// So: resolve to the row we know we wrote. The honest refusal is the resolve-the-row
// guard in the callers above, which runs BEFORE anything is written.
async function _writeRowDate(blockId,block,props,dateStr){
  let written;
  try{
    written=await window.blockStore.updateBlock(blockId,props,{date:dateStr});
  }catch(e){
    // updateBlock does not throw today. If it ever starts, a thrown write is NOT in the
    // WAL and really did fail, so this stays a refusal rather than a synthesized success.
    console.warn("[date] write threw for "+blockId+":",e);
    return null;
  }
  // Deliberately OUTSIDE the write's try. Keeping the projection refresh inside it meant a
  // throw in the refresh returned null — reporting a failure for a write that had already
  // landed, and toasting "Could not move…" over a completed move. A bookkeeping problem
  // must never change the verdict on the write.
  //
  // The key comes from TaskModel.backlogKey, the SAME function the projection stores under.
  // Deriving it here as `local_id || blockId` (which the first cut did) missed by the
  // "blk-" prefix for every row without a local_id, so the removal silently no-opped and
  // the task rendered on its day AND in the drawer.
  try{
    const TM=window.DCC&&window.DCC.TaskModel;
    const key=(TM&&typeof TM.backlogKey==="function")
      ? TM.backlogKey({id:blockId,properties:props})
      : (props.local_id||blockId);
    _syncBacklogProjection(key,dateStr);
  }catch(e){ console.warn("[date] backlog projection refresh failed:",e); }
  return written||Object.assign({},block,{date:dateStr,properties:props});
}

// Keep `backlog[]` honest the instant a row's date changes, because "one list, one badge"
// has to hold between the write and the next reload, not just after it.
//
// Caught in live QA rather than by a test: after a Move-to-backlog the row correctly
// appeared in the Unscheduled section, and the Backlog badge still read the OLD count —
// the projection only re-runs inside reloadPersistedEdits. One surface said the task was
// unscheduled while the other did not, which is the exact disagreement this phase exists
// to remove, just moved from "two predicates" to "two moments".
//
// It lives HERE, at the one point both primitives converge, rather than in each caller:
// an invariant enforced at one call site and merely assumed at the other is this project's
// most repeated bug shape. Scoped to the row that just changed — a full re-derive would
// drop a backlog item added in this session whose row has not been cached yet.
function _syncBacklogProjection(evId,dateStr){
  if(typeof backlog==="undefined"||!Array.isArray(backlog))return;
  if(dateStr){
    // It has a date now: it is scheduled work, so it leaves the backlog.
    const i=backlog.findIndex(b=>b.id===evId);
    if(i!==-1)backlog.splice(i,1);
  }else if(typeof hydrateBacklogFromBlocks==="function"){
    // It is unscheduled now. The projection is additive (it skips ids already present),
    // and blockStore.updateBlock has already written the dateless row into the cache
    // optimistically, so this picks it up without waiting for the server.
    hydrateBacklogFromBlocks();
  }
}

// Resolve a block for a date write, from the cache when it is there and from the
// server when it is not. A backlog row lives in _globalCache (loadGlobals), a
// carryover row only in _rangeCache, and blockStore.get() reads neither of the
// latter -- C1's second-order bug was a fix that depended on a cache the action
// itself then invalidated. One await, and the miss path is a real fetch.
async function _rowForDateWrite(blockId){
  const cached=window.blockStore.get(blockId);
  if(cached&&cached.properties)return cached;
  try{
    const r=await fetch("/api/blocks/"+encodeURIComponent(blockId));
    if(!r.ok)return null;
    return await r.json();
  }catch(e){return null;}
}

// ONE serialized read-modify-write for a row's properties, for every caller (C4).
//
// `db.updateBlock` REPLACES properties wholesale, so two concurrent read-modify-writes both
// read the pre-write bag and whichever PATCH lands second drops the other's field. For a
// row in the cache the first write's synchronous cacheSet saves you; for a row that is NOT
// cached — a past-day carryover, which is exactly what these paths exist to reach —
// `existing` is null, no optimistic cacheSet happens, and both reads are stale.
//
// This is shared rather than per-caller because the first cut serialized the details-modal
// writes inside features.js and then added a FOURTH writer (the commute path) outside that
// chain in the same change. Four writers on one row with the chain in one of them is the
// "invariant enforced at one call site and merely assumed at the other" shape this project
// has been bitten by every phase. One queue, so a new writer inherits it.
//
// `merge(properties) -> properties` runs AFTER the read, so each caller composes against
// whatever the previous link actually wrote.
//
// C5b: a merge returning NULL means "nothing to change, skip the write". It exists so a
// caller whose decision depends on the row's CURRENT contents can make that decision
// against the row the queue just read, instead of pre-deciding from the cache and
// handing in a finished object — which is the stale read this queue exists to prevent.
// `_patchOverlayDone` (schedule.js) needs exactly that: "remove this id from `_done` if
// it is in there" must not PATCH the day_root on every un-check of an id that never was.
// `extra` carries the top-level COLUMN changes `blockStore.updateBlock` accepts beyond
// properties — today just `{date}`, used when a completion has to promote a dateless
// (Unscheduled / backlog) row onto the day it was finished on. Same parameter
// `scheduleRowOnDay` uses for the same reason.
let _rowPropsChain=Promise.resolve();
function enqueueRowPropsWrite(blockId,merge,extra){
  if(!window.blockStore||!blockId||typeof merge!=="function")return null;
  _rowPropsChain=_rowPropsChain
    .then(()=>_rowForDateWrite(blockId))
    .then(b=>{
      // Refuse on an unresolvable row: spreading nothing over `properties` is a wipe.
      if(!b||!b.properties)return;
      const next=merge(b.properties);
      if(next)return window.blockStore.updateBlock(b.id,next,extra||undefined);
    })
    // Per-link, so one failure cannot wedge the queue for the rest of the session.
    .catch(e=>{console.warn("[row] properties write failed for "+blockId+":",e);});
  return _rowPropsChain;
}

// ── C6b: the ONE writer for a per-row order-axis property (pin, lock) ──
//
// Pins and locks were `day_root` overlay maps keyed by ev id (`_pinnedStarts`, `_lockedTasks`).
// An overlay keyed by ev id on the VIEWED day cannot describe a row that moved days, which is
// why the carryover lane had to read locks back out of the server (`db.js`, the open-tasks
// query) instead of off the row it was rendering. On the row, the fact travels with the task.
//
// Routed through `enqueueRowPropsWrite` rather than calling `updateBlock` directly, because
// that queue is what serializes read-modify-write against the four other writers of the same
// bag. Returning `null` from the merge is the queue's documented "skip the write", so a no-op
// pin/unlock does not PATCH the row.
//
// `undefined | null | false` clears the key rather than storing a falsy value: a reader that
// tests `p.locked` and a reader that tests `"locked" in p` must not disagree, and 001 wrote
// nothing for locks at all, so absence is the only value that has ever meant "not locked".
// `opts.row` hands in the row the CALLER already inspected. Without it this resolves the ev id
// itself, and `_findTaskBlockForDate` prefers the viewed day's row then a dateless twin -- so a
// caller sweeping rows (the pin/lock diffs below) could decide "row B must change" and have the
// write land on row A, because both carry the same ev id. Passing the row makes the decision and
// the write the same row, and removes the silent no-op the unresolvable case used to produce.
function persistRowProp(id,key,value,ev,opts){
  if(!window.blockStore)return null;
  let row=(opts&&opts.row)||null;
  if(!row){
    if(!id)return null;
    const source=ev||((typeof scheduled!=="undefined"&&Array.isArray(scheduled))?scheduled.find(e=>e&&e.id===id):null);
    row=_findTaskBlockForDate(id,(typeof __state!=="undefined"&&__state&&__state.date)||null,source);
  }
  if(!row)return null;
  const want=(value===undefined||value===null||value===false)?undefined:value;
  return enqueueRowPropsWrite(row.id,props=>{
    const cur=props[key];
    if(cur===want)return null;                       // no change: skip the write entirely
    if(cur===undefined&&want===undefined)return null;
    const next=Object.assign({},props);
    if(want===undefined)delete next[key];else next[key]=want;
    return next;
  });
}

// A duration is a POSITIVE number of minutes. `dur(ev)` is pt(end) - pt(start), which goes
// negative two different ways: recalcTimes writes an unclamped end past midnight (23:00 +
// 90m -> "24:30", and pt() wraps the hour), and data.js's timeline items are built from two
// separate Date objects, so anything crossing midnight is born with end < start.
//
// Shared because the first cut validated this in `unscheduleRow` and left the sibling
// mint branch of `_moveTaskToBacklogStage` writing dur(ev) raw — and the mint branch is the
// one that only ever runs on timeline rows, i.e. the shape where a negative value is born
// rather than derived. Downstream readers filter falsy, not negative
// (`p.duration || 30`, `p.durMin || 30`), so a negative reaches findSlot and produces the
// rejected write that leaves a row stuck on every surface.
function _positiveDuration(candidate,fallback){
  const n=Number(candidate);
  if(Number.isFinite(n)&&n>0)return n;
  const f=Number(fallback);
  return (Number.isFinite(f)&&f>0)?f:30;
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

// _scheduleTaskOnDate DELETED (C3): a second, near-identical copy of scheduleTaskOnDate
// (same getDayContext → dedupe-by-local_id → findSlot → createBlock, differing only in
// its return value and two property defaults) whose own comment said it had no live call
// sites. Two creators for one job is how they drift; scheduleTaskOnDate is the one.

function _nextSundayDate(){
  const now=new Date();
  const dow=now.getDay();
  const daysAhead=dow===0?7:(7-dow);
  const next=new Date(now);
  next.setDate(now.getDate()+daysAhead);
  const pad=n=>String(n).padStart(2,"0");
  return next.getFullYear()+"-"+pad(next.getMonth()+1)+"-"+pad(next.getDate());
}

// The date the user is looking at -- the day a delete or purge must act on. Falls
// back to the loaded day state for surfaces that render without a viewDate.
function _viewedDateStr(){
  return (typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
}

async function moveTaskToToday(id){
  return rescheduleTaskToDate(id,_resolvedTodayDate());
}

// THE standard mover: every "send this task to day X" action funnels through
// the shared placement picker (day → "After…" step with time presets, every
// task on that day as an anchor, and Earliest free), so placement is chosen
// the same way app-wide. Falls back to a direct auto-slot move when the picker
// isn't available (e.g. embeds without the overlay markup).
function moveTaskViaPlacement(id,dateStr){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||typeof openPlacementPicker!=="function")return rescheduleTaskToDate(id,dateStr);
  openPlacementPicker({
    title:ev.title,durMin:dur(ev)||30,verb:"Move",day:dateStr||null,
    onPlace:async(dStr,timeStr,editedTitle)=>{
      // The picker's title is editable: persist a rename BEFORE the move so
      // the true move carries the new title with it.
      if(editedTitle&&editedTitle!==ev.title)await _renameTaskForMove(ev,editedTitle);
      rescheduleTaskToDate(id,dStr,{pinnedStart:timeStr||null});
    }
  });
}

// Rename a task in place: the live row plus its backing block.
async function _renameTaskForMove(ev,newTitle){
  ev.title=newTitle;
  const dateStr=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  const b=_findTaskBlockForDate(ev.id,dateStr,ev);
  if(b&&window.blockStore){
    try{await window.blockStore.updateBlock(b.id,{...(b.properties||{}),title:newTitle})}catch(e){}
  }
  render();
}

function moveTaskToTomorrow(id){return rescheduleTaskToDate(id,_resolvedTomorrowDate());}

async function moveTaskToNextWeek(id){
  // Route through the generalized rescheduler so the task's subtask subtree is
  // carried to next Sunday too, instead of being orphaned on the source day.
  return rescheduleTaskToDate(id,_nextSundayDate());
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
  _removeTaskBlockFromDate(ev.id,_viewedDateStr(),ev);
  log("side-project",id,"Moved to Side Projects: "+ev.title);
  if(typeof showToast==="function")showToast("Moved to Side Projects","success");
  recalcTimes();
  render();
  return true;
}

// Send a scheduled task to the Backlog / Priority drawer.
//
// C4: this is an in-place `date = null` UPDATE now. It used to mint a brand-new
// `bl-<timestamp>` row and DELETE the original, so the task came back with a different
// block id, a different local_id, and none of its notes, points, tags or child edges.
// A backlog → schedule → backlog round trip produced three rows and two tombstones for
// one piece of work. Now it produces one row that changes its `date` twice.
//
// The identity that survives is the point: `local_id` is what the ledger's client-side
// credit key and every `subtaskOf` link is written against, and the block id is what
// `parent_id` and the server-side credit key use. Minting a new id orphaned both.
async function _moveTaskToBacklogStage(id,stage,toastMsg){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  // The block id, not the ev id: unscheduleRow re-dates a ROW. _findTaskBlockForDate
  // resolves it the same way the mover does, including its ev._blockId branch, so a
  // task whose local_id is ambiguous (the prod restore has 28 such collision groups)
  // still resolves to the row this ev actually came from.
  const block=_findTaskBlockForDate(ev.id,_viewedDateStr(),ev);
  if(!block){
    // No row to re-date, so there is nothing to move — MINT the dateless row instead.
    //
    // This branch is not a nicety: block-less scheduled rows are a live shape. data.js
    // transformState builds INIT_SCHED from `state.schedule.timeline` with ids like
    // `tl-<n>` and no backing block, which is exactly why deletedSet + the day-scoped hide
    // is still the removal mechanic for moveScheduledTaskToSideProject and
    // removeTaskForConversion. My first cut refused here on the theory that the old path
    // "silently succeeded"; it did not — it called persistBacklogItem, which CREATED a
    // row. Refusing turned a working action into an error toast for every Notion/PA
    // timeline task, reachable from both the radial and the triage tab's Backlog button.
    // A FRESH id, not ev.id. The minted row's projection key is its local_id, and this
    // branch also has to day-hide the origin ev — so reusing ev.id would put the same id in
    // `deletedSet` AND in `backlog[]`. buildBacklog does not filter deletedSet but
    // buildListView does, so the task would show in the drawer and be missing from the
    // Unscheduled section: the precise split the re-date branch below refuses to create.
    // Worse, promoting it back out of the drawer would land it in `scheduled[]` under a
    // still-hidden id, so it would render nowhere until that day's `_deleted` overlay was
    // cleared by hand. There is no row identity to preserve here by definition — this is
    // the branch where no row exists — which is why the pre-C4 code minted an id too.
    const mintedId="bl-"+Date.now();
    // Validated through the SAME helper the re-date branch uses. This branch only runs for
    // block-less rows, i.e. data.js timeline items, whose start/end come from two separate
    // Date objects -- so one crossing midnight is born with dur(ev) negative, no reflow
    // overflow required. meta is derived from the validated value so the drawer text cannot
    // disagree with the stored duration.
    const mintedDur=_positiveDuration(dur(ev),null);
    const entry=Object.assign(
      window.DCC.taskCommonProps(ev,{
        meta:ms(mintedDur)+" · from schedule",
        priority:ev.priority||(stage==="Priority"?"High":"Low"),
        source:ev.source||"manual"
      }),
      {id:mintedId,type:ev.type||"task",durMin:mintedDur,stage:stage}
    );
    if(typeof persistBacklogItem==="function")persistBacklogItem(entry);
    // A row that never existed on this day has to be hidden the way delete does it; there
    // is no date to clear. This is the one case where deletedSet is still correct.
    deletedSet.add(id);saveDeletedState();
    if(typeof hydrateBacklogFromBlocks==="function")hydrateBacklogFromBlocks();
    if(typeof showToast==="function")showToast(toastMsg,"success");
    if(typeof recalcTimes==="function")recalcTimes();
    render();
    return;
  }
  // dur(ev) is the row's REAL duration; properties.duration is the stale create-time
  // value (adjustDur never writes it back). Passed RAW on purpose: unscheduleRow validates
  // it, and when it rejects a bad value it falls back to the row's own duration -- which is
  // better than pre-validating here and handing it a hardcoded 30 it cannot tell from a
  // real measurement.
  const updated=await unscheduleRow(block.id,{stage:stage,block:block,durMin:dur(ev)});
  if(!updated){
    if(typeof showToast==="function")showToast("Could not move "+ev.title+" to the backlog","error");
    return;
  }
  // It stays on screen and MOVES to the Unscheduled section, because under C4 that
  // section IS the backlog. The old path added the id to `deletedSet` — the day-scoped
  // hide — which was right when the row was being destroyed and a copy created
  // elsewhere, and is wrong now: the row still exists, it is simply dateless, so hiding
  // it would leave the task in the drawer but missing from the list that is supposed to
  // be the same list.
  //
  // Mirror in memory exactly what unscheduleRow wrote, rather than re-folding: a
  // dateless row is untimed by definition (TaskModel.fromBlock ignores any stored
  // start), and _clearTaskPinAndLock has to run or the client keeps a pinned start the
  // row no longer has — the two would disagree until the next reload, and the pin would
  // win the moment the task was scheduled again.
  ev.untimed=true;ev._dateless=true;ev.stage=stage;
  _clearTaskPinAndLock(ev);
  if(typeof showToast==="function")showToast(toastMsg,"success");
  if(typeof recalcTimes==="function")recalcTimes();
  render();
}

function moveTaskToBacklog(id){_moveTaskToBacklogStage(id,"Backlog","Moved to backlog");}
function moveTaskToPriority(id){_moveTaskToBacklogStage(id,"Priority","Moved to priority");}

// Convert an existing scheduled task into a Delegated / Blocked item: open the
// delegated modal prefilled with this task as "what you're working on". The
// original scheduled task is removed only once the blocked item is saved (see
// removeTaskForConversion, called from delegated.js saveDelegatedItem) so a
// cancelled convert leaves the task untouched.
function convertTaskToDelegated(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  if(typeof openDelegatedFromTask==="function")openDelegatedFromTask({title:ev.title,durMin:dur(ev)||30,sourceTaskId:id});
  else if(typeof showToast==="function")showToast("Delegated / Blocked is still loading. Try again in a moment.","info");
}

// Remove a scheduled task after it's been converted to another type (mirrors the
// purge tail of _moveTaskToBacklogStage). Exposed for delegated.js's deferred convert.
function removeTaskForConversion(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  deletedSet.add(id);
  saveDeletedState();
  _removeTaskBlockFromDate(ev.id,_viewedDateStr(),ev);
  if(typeof recalcTimes==="function")recalcTimes();
  render();
}
window.removeTaskForConversion=removeTaskForConversion;

// Find a free slot on `targetDate` for a true move WITHOUT creating a block
// (scheduleTaskOnDate creates one from the same engine; this one just computes).
// Excludes ev's own block so a re-slot ignores where it currently sits.
// Returns {start,end,duration} or null when the day has no room.
async function _computeRescheduleSlot(ev,targetDate){
  const ctx=await window.DCC.getDayContext(targetDate);
  if(!ctx)return null;
  return window.DCC.findSlot(ev,ctx,{excludeSelf:true,anchorNow:true});
}

// Every ev id in the visible subtree rooted at rootId, walking the subtaskOf /
// wrapId edges on `scheduled`. Root first, then children, then grandchildren, so
// callers can act on a parent before the rows that point at it. An id is added at
// most once, so a descendant claiming an ancestor as its parent terminates instead
// of looping -- real data carries such cycles (reschedule-subtree.test.js).
//
// SERVER TWIN: lib/reschedule.js `collectSubtreeBlockIds` walks the same logical
// graph over block ROWS (returning block ids) for POST /api/blocks/:id/reschedule.
// Keep the two in step. They already differ on which edge wins when a row carries
// both: `parentIdOf` here is wrapId-first, that one is subtaskOf-first.
function _subtreeIdsOf(rootId){
  const ids=new Set([rootId]);
  let changed=true;
  while(changed){
    changed=false;
    for(const e of scheduled){
      const pid=parentIdOf(e);
      if(pid&&ids.has(pid)&&!ids.has(e.id)){ids.add(e.id);changed=true;}
    }
  }
  return ids;
}

// Optimistically drop a task and its whole nested subtree (subtaskOf/wrapId) from
// the current day's `scheduled` view after a true move. Returns the removed ids.
function _removeSubtreeFromScheduled(rootId){
  const ids=_subtreeIdsOf(rootId);
  for(let i=scheduled.length-1;i>=0;i--){
    if(ids.has(scheduled[i].id)){
      _clearTaskPinAndLock(scheduled[i]);
      scheduled.splice(i,1);
    }
  }
  return ids;
}

// Leave a tombstone on the origin day so the moved task shows in the amber
// "Rescheduled away" list. Only the materialize path needs this — a block-backed move
// gets its tombstone written server-side, inside the same transaction as the move.
//
// `movedBlockId` is the point of this function now. The old clone-move tombstone omitted
// it, and restoreRescheduledAway REQUIRES it, which is why the amber Restore button had
// never once worked from this path. The materialized row is a real block with a real id,
// so recording it makes Restore work here exactly as it does for a true move. Keep the
// payload shape in step with the server's (routes/blocks.js, POST /:id/reschedule).
//
// The dedupe keys on (origin day, sourceLocalId), NOT on movedBlockId the way the server's
// does, and the difference is forced: the server moves an EXISTING row, so movedBlockId is
// stable across repeat reschedules, while every materialize mints a fresh row through
// persistAddedTask -> createBlock. Keyed on movedBlockId this guard could never match its
// own second run — dead code behind a comment claiming one tombstone per origin day. The
// task's local_id is what is actually stable here.
async function _writeRescheduleTombstone(ev,fromDate,targetDate,movedBlockId,hiddenLocalIds){
  if(!window.blockStore||!fromDate||!movedBlockId)return;
  const already=window.blockStore.getByType("block").find(b=>{
    const p=(b&&b.properties)||{};
    return !b.deleted_at&&b.date===fromDate&&p.kind==="reschedule_tombstone"&&p.sourceLocalId===ev.id;
  });
  if(already){
    // Reuse, but REFRESH the destination. `sourceLocalId` is the right stable key for a
    // repeat materialize, and it is also the key the SERVER writes (routes/blocks.js
    // `sourceLocalId: parentLocalId`), so this guard can match a tombstone left by a true
    // move of the same task off the same day. Returning blind then leaves the amber row
    // naming an older destination and its Restore pointing at the wrong row — the exact
    // failure the movedBlockId work in this phase exists to remove.
    const ap=already.properties||{};
    const nextHidden=Array.from(new Set([...(Array.isArray(ap.hiddenLocalIds)?ap.hiddenLocalIds:[]),...(hiddenLocalIds||[])]));
    if(ap.rescheduledTo!==targetDate||ap.movedBlockId!==movedBlockId||nextHidden.length!==(ap.hiddenLocalIds||[]).length){
      try{await window.blockStore.updateBlock(already.id,{...ap,movedBlockId:movedBlockId,rescheduledTo:targetDate,hiddenLocalIds:nextHidden,at:new Date().toISOString()});}catch(e){}
    }
    return;
  }
  try{
    await window.blockStore.createBlock("block",{
      local_id:"resched-tomb-"+movedBlockId,
      kind:"reschedule_tombstone",
      title:ev.title||"Task",
      priority:ev.priority||"Medium",
      movedBlockId:movedBlockId,
      sourceLocalId:ev.id,
      // Every id this move hid on the origin day, so Restore can reverse ALL of it. The
      // parent is `sourceLocalId`; these are the row-less children that were materialized on
      // the target date and hidden here. Nothing else can un-hide them.
      hiddenLocalIds:(hiddenLocalIds||[]).slice(),
      rescheduledFrom:{date:fromDate},
      rescheduledTo:targetDate,
      at:new Date().toISOString()
    },{date:fromDate});
  }catch(e){}
}

// Move a task off of the currently-viewed date and onto `targetDate`. Used by
// the reschedule popover (Today / Tomorrow / custom date) on every task card.
async function rescheduleTaskToDate(id,targetDate,opts){
  opts=opts||{};
  if(!targetDate)return;
  const ev=scheduled.find(e=>e.id===id);
  if(!ev)return;
  const fromDate=(typeof viewDate!=="undefined"&&viewDate)?viewDate:((__state&&__state.date)||null);
  const pinned=(opts.pinnedStart&&/^\d{2}:\d{2}$/.test(opts.pinnedStart))?opts.pinnedStart:null;
  if(fromDate===targetDate){
    // Same-day with a chosen time: that's a start pin, not a re-slot.
    if(pinned){
      if(typeof pinStartTime==="function")pinStartTime(id,pinned);
      if(typeof syncAddedTaskTimes==="function")syncAddedTaskTimes();
      log("rescheduled",id,"Pinned to "+pinned+" on "+targetDate+": "+ev.title);
      if(!opts.silent&&typeof showToast==="function")showToast("Start pinned to "+(typeof f12==="function"?f12(pinned):pinned),"success");
      render();
      return ev;
    }
    const isActualToday=targetDate===_resolvedTodayDate();
    const moved=isActualToday?_placeTaskAtNextTodaySlot(id):_placeTaskAtEarliestCurrentDateSlot(id);
    if(moved){
      log("rescheduled",id,"Moved within "+targetDate+": "+moved.title);
      const msg=isActualToday?"Moved to today's next free slot":"Moved to the earliest slot on "+_prettyDateLabel(targetDate);
      if(!opts.silent&&typeof showToast==="function")showToast(msg,"success");
      render();
    }
    return moved;
  }

  // Cross-date move. ONE mover: POST /api/blocks/:id/reschedule re-dates the origin row
  // (keeping its id) plus its whole subtree, in ONE transaction with ONE broadcast we
  // ignore as our own — so no snap-back, no duplication, no stranded children.
  //
  // There is no clone fallback any more, and its absence is the point. Every permanent
  // rejection the server can give is a case where cloning is WRONG: "Already on that
  // date", "Invalid targetDate", "Block has no source date", "Block is deleted",
  // "Block not found". Cloning through those produced a second task with a new id and a
  // tombstone that could not be restored. The user now gets the server's own reason.
  window.__RESCHEDULE_IN_FLIGHT__=true;
  try{
    const srcBlock=_findTaskBlockForDate(id,fromDate,ev);
    if(srcBlock&&window.blockStore&&typeof window.blockStore.rescheduleBlock==="function"){
      // A full target day is no reason to refuse the move: with no free slot the
      // block keeps its own times and re-slots when that day gets planned.
      // A pinned start from the placement picker wins over the auto-slot.
      const slot=pinned
        ?{start:pinned,end:fmt(pt(pinned)+(dur(ev)||30)),duration:dur(ev)||30}
        :await _computeRescheduleSlot(ev,targetDate);
      let result=null;
      try{
        result=await window.blockStore.rescheduleBlock(srcBlock.id,targetDate,{parentStart:slot&&slot.start,parentEnd:slot&&slot.end,fromDate});
      }catch(e){
        // blockStore stamps e.permanent using its single permanence rule
        // (400/404 final; 401/403 auth blips and 5xx/network stay buffered).
        if(!(e&&e.permanent)){
          // Transient/network failure: the blockstore WAL replays it on reconnect, so
          // the move still happens. Doing anything else here would race that replay.
          if(!opts.silent&&typeof showToast==="function")showToast("Connection hiccup — move queued, will retry","info");
          return;
        }
        // Permanent: report what the server said rather than inventing a second task.
        console.warn("[reschedule] move rejected: "+(e.message||e.status));
        if(!opts.silent&&typeof showToast==="function")showToast("Could not move to "+_prettyDateLabel(targetDate)+(e.message?" — "+e.message:""),"error");
        // FALSE means "this task did not move and never will". Distinct from the
        // transient `undefined` above, which means "queued, the WAL will land it".
        // toggleDone's done-on-date flow commits a completion after this resolves, and
        // committing on a date the task is not on credits the wrong day.
        return false;
      }
      _removeSubtreeFromScheduled(id);
      log("rescheduled",id,"Moved to "+targetDate+": "+ev.title);
      if(!opts.silent&&typeof showToast==="function")showToast("Moved to "+_prettyDateLabel(targetDate),"success");
      if(typeof recalcTimes==="function")recalcTimes();
      render();
      return result;
    }

    // No row on the origin day, so there is no :id to move: materialize this task on the
    // target date under its own id. The one honest non-re-date case.
    return await _materializeTaskOnDate(ev,id,targetDate,fromDate,pinned,opts);
  }finally{
    window.__RESCHEDULE_IN_FLIGHT__=false;
  }
}

// Restore a task from the amber "Rescheduled away" list: move its block back onto
// the currently-viewed day and clear the tombstone. Symmetric with the true move.
async function restoreRescheduledAway(tombBlockId){
  if(!window.blockStore||!tombBlockId)return;
  const tomb=window.blockStore.get(tombBlockId);
  if(!tomb)return;
  const p=tomb.properties||{};
  const viewDate=(typeof __state!=="undefined"&&__state&&__state.date)||_resolvedTodayDate();
  window.__RESCHEDULE_IN_FLIGHT__=true;
  try{
    if(p.movedBlockId){
      // Fetch the moved block so we slot it back with its real duration.
      let moved=null;
      try{moved=await fetch("/api/blocks/"+p.movedBlockId).then(r=>r.ok?r.json():null)}catch(e){}
      const mp=(moved&&moved.properties)||{};
      const ev={id:mp.local_id||p.sourceLocalId||p.movedBlockId,title:mp.title||p.title,priority:mp.priority||p.priority,start:mp.start||"00:00",end:mp.end||fmt(mp.duration||30)};
      const slot=await _computeRescheduleSlot(ev,viewDate);
      try{
        await window.blockStore.rescheduleBlock(p.movedBlockId,viewDate,slot?{parentStart:slot.start,parentEnd:slot.end}:{});
      }catch(e){
        if(typeof showToast==="function")showToast("Could not restore","error");
        return;
      }
    }
    try{await window.blockStore.deleteBlock(tombBlockId);}catch(e){}
    try{await window.blockStore.loadDay(viewDate);}catch(e){}
    log("rescheduled",tombBlockId,"Restored to "+viewDate);
    if(typeof showToast==="function")showToast("Restored to "+_prettyDateLabel(viewDate),"success");
    if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
    // Un-hide everything the move hid on this day. Without this, restoring a materialized
    // move puts the row back here and then `isDeleted` filters it out of every view, so the
    // task is on one day and visible on none.
    //
    // Only the MATERIALIZE path hides anything: a true move re-dates the row, so there is
    // nothing on this day to hide and deleting an absent id is a no-op — which is why this
    // runs unconditionally rather than branching on how the task left.
    //
    // `hiddenLocalIds` matters as much as `sourceLocalId`: a day-state-only child has no row
    // of its own, so the move materializes it on the target date and hides the origin copy.
    // Un-hiding only the parent would leave those children in `_deleted` forever — nothing
    // else ever removes an id from that overlay for a task with no visible row.
    //
    // Surgical on purpose. `deletedSet.clear()` would read the same in the happy case and
    // resurrect every task the user genuinely deleted on this day.
    //
    // (Ordering versus reloadPersistedEdits above is not load-bearing either way:
    // saveDeletedState -> blockStore.updateBlock does an optimistic cacheSet BEFORE its
    // await, so the reload sees the corrected overlay. Kept after it because reading the
    // rebuilt set and then correcting it is the easier order to reason about.)
    const unhide=[p.sourceLocalId,...(Array.isArray(p.hiddenLocalIds)?p.hiddenLocalIds:[])].filter(Boolean);
    let unhid=false;
    if(typeof deletedSet!=="undefined"){
      for(const rid of unhide){
        if(deletedSet.has(rid)){deletedSet.delete(rid);unhid=true;}
      }
    }
    if(unhid&&typeof saveDeletedState==="function")saveDeletedState();
    if(typeof recalcTimes==="function")recalcTimes();
    render();
  }finally{
    window.__RESCHEDULE_IN_FLIGHT__=false;
  }
}

// "Push to tomorrow" is just a move to tomorrow, so it is literally that now — one
// mover, one code path, and the task ends up on exactly one day.
//
// What this used to do, and why Drake killed it (2026-07-31): it flagged the id in
// `pushedSet`, left the row on today under a greyed "Pushed to Tomorrow" divider, and
// created a SECOND block on tomorrow carrying the same local_id. Two rows, one task,
// neither authoritative — and un-pushing had to guess which to remove. His call: knowing
// what day something was originally scheduled for is not worth a duplicate.
//
// unpushTask went with it. The inverse of a move is a move back, which is what the amber
// "Rescheduled away" entry's Restore button on the origin day already does.
function pushTask(id){return moveTaskToTomorrow(id);}

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
// What a delete removed, keyed by the ev id the user deleted, so Undo can put the whole
// subtree back. Two facts per entry, both captured AT DELETE TIME because neither can be
// re-derived afterwards: which overlay ids the subtree covered, and which row ids they
// resolved to. Plus the in-flight delete's promise, which Undo awaits (see undoDeleteTask).
//
// B2 note: this deliberately still exists. The brief expected /undelete to retire the Map
// outright, but /undelete only removes the need to remember a row's CONTENTS -- the
// subtree's membership and its resolved row ids are still client-side facts, and
// re-deriving them after the rows are tombstoned is exactly the guesswork that produces
// half-restored trees. What did go is every column copy: entries are now id lists.
//
// A Map, not an object: Map is the only thing that gives a reliable oldest-first eviction
// order here. Plain-object key order puts integer-like keys first in numeric order, and
// legacy task ids are Date.now()-based, so `1753812345678` would sort ahead of every
// prefixed id and get evicted out of turn. Re-stashing deletes first so a re-deleted id
// moves to the back instead of keeping its old position.
const _deleteUndoSnapshots=new Map();
const _UNDO_SNAPSHOT_CAP=10;
function _stashUndoSnapshot(id,snap){
  _deleteUndoSnapshots.delete(id);
  _deleteUndoSnapshots.set(id,snap);
  while(_deleteUndoSnapshots.size>_UNDO_SNAPSHOT_CAP){
    _deleteUndoSnapshots.delete(_deleteUndoSnapshots.keys().next().value);
  }
}
function openDeleteConfirm(id){
  deleteTaskWithUndo(id);
}
// THE single client entry point for "delete this task", and it fires the real
// soft-delete IMMEDIATELY. The 8-second deferral this replaces was the resurrection
// bug: navigate away or reload inside that window and only the per-day overlay
// survived, so the task came back on the next fold. Going immediate loses nothing --
// rows keep their deleted_at for 30 days server-side (purgeSoftDeleted, server.js)
// and Undo revives those exact rows through /undelete.
async function deleteTaskWithUndo(id){
  const ev=scheduled.find(e=>e.id===id);
  if(!ev||deletedSet.has(id))return;
  const dateStr=_viewedDateStr();
  // The whole visible subtree goes with the parent. A subtask left behind is what
  // resurfaces later as a standalone unfinished task. Anything already deleted
  // separately is left out so Undo can't resurrect it.
  const ids=[..._subtreeIdsOf(id)].filter(sid=>sid===id||!deletedSet.has(sid));
  const evById=new Map(scheduled.map(e=>[e.id,e]));
  // Hide first. Row resolution below scans the whole block cache once per subtree
  // node, and none of it changes what the user sees -- doing it before the render
  // would just delay the optimistic hide this rewrite exists to make instant.
  ids.forEach(sid=>deletedSet.add(sid));
  saveDeletedState();
  log("deleted",id,"Removed from schedule: "+(ev.title||id));
  recalcTimes();
  render();
  // Resolve every backing row through the one resolver that handles
  // _blockId / local_id / b.id and refuses a cross-date delete. A pure timeline-JSON
  // item has no row, so it gets no op and the overlay is the only (correct) record --
  // nothing server-side exists to delete.
  // Only the row IDS now. B1 had to capture every column here because Undo re-created
  // the rows from scratch; /undelete revives the originals in place, so their contents
  // are never the client's to remember. That also retires a whole bug class: a snapshot's
  // hand-maintained field list silently drifting from the schema, which is exactly why
  // B1 rejected persistAddedTask's ~35-field allowlist in the first place.
  const blockIds=[];
  for(const sid of ids){
    const block=_findTaskBlockForDate(sid,dateStr,evById.get(sid));
    if(block)blockIds.push(block.id);
  }
  // One transactional batch, so the subtree is deleted all-or-nothing instead of
  // half-deleted with stranded children. Deletes are idempotent server-side
  // (db.deleteBlock just re-stamps deleted_at), so a WAL replay is harmless.
  //
  // Started here but awaited at the bottom, and the promise goes into the snapshot,
  // because Undo has to be able to wait for it. See undoDeleteTask: /undelete is NOT
  // commutative with this delete the way B1's re-create was.
  let deletePromise=Promise.resolve(null);
  if(blockIds.length&&window.blockStore){
    // Resolve to a buffered-shaped result rather than undefined if this ever rejects:
    // batchOp does not reject today, but undoDeleteTask decides what to do from this
    // value, and "undefined" would read as "landed fine".
    deletePromise=window.blockStore.batchOp(blockIds.map(bid=>({op:"delete",id:bid})))
      .catch(()=>({blocks:[],buffered:true}));
  }
  _stashUndoSnapshot(id,{ids,blockIds,deletePromise});
  // Offer Undo without waiting for the round-trip, so the affordance is as instant as
  // the hide.
  if(typeof showToast==="function"){
    showToast("Task deleted","success",8000,{
      label:"Undo",
      onClick:()=>undoDeleteTask(id)
    });
  }
  await deletePromise;
}
// Revive the ORIGINAL rows through A2's POST /:id/undelete, so notes, tags, source
// links, prep state, privacy and the subtask/ride-along edges all come back because they
// never went anywhere -- the row is the same row. B1 re-created verbatim copies under NEW
// ids, which meant Undo could not survive a reload (the snapshot was in memory), left the
// old rows tombstoned, and broke every id anything else still held.
async function undoDeleteTask(id){
  if(!deletedSet.has(id))return;
  const snap=_deleteUndoSnapshots.get(id)||{ids:[id],blockIds:[]};
  _deleteUndoSnapshots.delete(id);
  snap.ids.forEach(sid=>deletedSet.delete(sid));
  saveDeletedState();
  log("delete-undone",id,"Restored to schedule");
  recalcTimes();
  render();
  // WAIT FOR THE DELETE TO LAND FIRST. This is the one thing /undelete does not inherit
  // for free from B1's design: the two operations are not commutative. Undo can be
  // clicked while the delete batch is still in flight, and if the undelete wins the race
  // it clears a deleted_at that is not set yet -- then the delete lands, and the task is
  // gone server-side while the UI shows it restored, until the next reload proves the UI
  // wrong. B1 did not have this race because a create and a delete of two different rows
  // commute; reviving the SAME row does not.
  let deleteResult=null;
  if(snap.deletePromise){try{deleteResult=await snap.deletePromise;}catch(e){}}
  // AND awaiting is not enough on its own, because batchOp swallows its own failure: it
  // resolves either way, so a delete that never reached the server looks identical to one
  // that did. If it is still buffered there is nothing to undelete, and the queued batch
  // MUST be cancelled -- otherwise the next replay (boot, `online`, visibilitychange, SSE
  // reconnect) deletes the row the user just restored, silently. Reachable inside the 8s
  // toast: delete while offline, reconnect, click Undo.
  // ...and `buffered` is only a SNAPSHOT of the moment the batch failed. replayWAL fires
  // on the `online` event with no delay, so in the up-to-8s gap before the user clicks Undo
  // the queued delete can land after all. So trust the cancel's return value, not the flag:
  // true means it really was still pending and is now dropped (nothing was ever deleted, so
  // there is nothing to revive), false means it already replayed and we must undo for real.
  if(deleteResult&&deleteResult.buffered){
    const cancelled=!!(window.blockStore&&window.blockStore.cancelBufferedWrite
      &&window.blockStore.cancelBufferedWrite(deleteResult.walId,snap.blockIds||[]));
    if(cancelled){
      if(typeof showToast==="function")showToast("Task restored","success",2200);
      return;
    }
    // Fall through to the real undelete. Safe on a row that was never deleted:
    // db.undeleteBlock just clears a deleted_at that is already NULL.
  }
  if(snap.blockIds&&snap.blockIds.length&&window.blockStore&&window.blockStore.undeleteBlock){
    // Per row, because /undelete is single-id. Sequential rather than Promise.all: these
    // are parent-and-children in one subtree, and a burst of concurrent writes to the
    // same tree is how sort_order rebalances start fighting each other.
    //
    // ACCEPTED LIMITATION, called out because the delete side promises the opposite: this
    // is N requests, not one transaction, so a permanent rejection partway through leaves
    // the subtree half-revived server-side. The all-or-nothing version needs an
    // `undelete` case in db.batchOp, which is Track A's file and out of this phase's
    // scope; it is handed off in the Coordination log. Until then the overlay below is
    // restored wholesale so at least the UI does not claim a partial success.
    let rejected=false;
    for(const bid of snap.blockIds){
      const r=await window.blockStore.undeleteBlock(bid);
      if(r&&r.ok===false&&r.permanent)rejected=true;
    }
    render();
    if(rejected){
      // The server refused: a live row already holds this tombstone's idempotency key, or
      // the row is past the 30-day purge. Put the hide back rather than leaving the
      // itinerary showing a task the server still considers deleted.
      snap.ids.forEach(sid=>deletedSet.add(sid));
      saveDeletedState();
      recalcTimes();
      render();
      if(typeof showToast==="function")showToast("Could not restore that task","error",3200);
      return;
    }
  }
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
// Moved to schedule-popover.js: openSchedulePopover unifies the reschedule
// popover, the create-flow "Schedule…" destination, and the date-pick popover
// (openReschedulePopover / openDatePickPopover wrappers live there too).

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
