// ======== PLAN / ACTUAL TOGGLE ========
document.querySelectorAll(".svt-btn").forEach(btn=>{
  btn.addEventListener("click",()=>{
    schedView=btn.dataset.view;
    document.querySelectorAll(".svt-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===schedView));
    document.getElementById("timeline").style.display=schedView==="plan"?"block":"none";
    const listView=document.getElementById("list-view");
    if(listView)listView.style.display=schedView==="list"?"flex":"none";
    document.getElementById("actual-view").style.display=schedView==="actual"?"block":"none";
    if(typeof buildScheduleDelegated==="function")buildScheduleDelegated();
    if(typeof buildScheduleTriage==="function")buildScheduleTriage();
    if(schedView==="list")buildListView();
    if(schedView==="actual"){if(typeof buildDayReview==="function")buildDayReview(typeof viewDate!=="undefined"?viewDate:null);else buildActualView();}
  });
});
// The "Actual" tab is rendered by buildDayReview (day-review.js): one
// blockStore-backed scheduled-vs-actual view that also supports past days and
// time_entry editing. This shim keeps the legacy entry point working for the
// callers that still invoke buildActualView() directly (features._doRender,
// responsibilities refresh) so every path funnels through the one renderer
// instead of the old scheduled[]-based duplicate that lived here.
function buildActualView(dateStr){
  if(typeof buildDayReview==="function") buildDayReview(dateStr);
}

function subtaskMoveState(id){
  const ev=(typeof scheduled!=="undefined"&&Array.isArray(scheduled))?scheduled.find(x=>x.id===id):null;
  if(!ev||!ev.subtaskOf)return {canUp:false,canDown:false};
  const siblings=scheduled.filter(x=>x.subtaskOf===ev.subtaskOf&&!(typeof isDeleted==="function"&&isDeleted(x)));
  const idx=siblings.findIndex(x=>x.id===id);
  return {canUp:idx>0,canDown:idx>=0&&idx<siblings.length-1};
}

function moveSubtaskSibling(id,direction){
  if(typeof scheduled==="undefined"||!Array.isArray(scheduled))return;
  const ev=scheduled.find(x=>x.id===id);
  if(!ev||!ev.subtaskOf)return;
  const siblings=scheduled.filter(x=>x.subtaskOf===ev.subtaskOf&&!(typeof isDeleted==="function"&&isDeleted(x)));
  const idx=siblings.findIndex(x=>x.id===id);
  const to=idx+direction;
  if(idx<0||to<0||to>=siblings.length)return;
  const target=siblings[to];
  const fromIndex=scheduled.findIndex(x=>x.id===ev.id);
  const toIndex=scheduled.findIndex(x=>x.id===target.id);
  if(fromIndex<0||toIndex<0)return;
  const tmp=scheduled[fromIndex];
  scheduled[fromIndex]=scheduled[toIndex];
  scheduled[toIndex]=tmp;
  if(typeof saveTaskOrder==="function")saveTaskOrder();
  if(typeof saveSubtaskOrder==="function")saveSubtaskOrder(ev.subtaskOf);
  if(typeof log==="function")log("reorder",id,"Moved subtask "+(direction<0?"up":"down"));
  if(typeof render==="function")render();
}

function startSubtaskTitleEdit(id,titleEl){
  if(!titleEl||titleEl.querySelector("input"))return;
  const ev=(typeof scheduled!=="undefined"&&Array.isArray(scheduled))?scheduled.find(x=>x.id===id):null;
  if(!ev)return;
  const input=document.createElement("input");
  input.type="text";
  input.className="sub-ttl-edit";
  input.value=ev.title||"";
  input.setAttribute("aria-label","Subtask title");
  input.style.width=Math.max(90,(titleEl.offsetWidth||80)+24)+"px";
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let finished=false;
  function finish(save){
    if(finished)return;
    finished=true;
    const next=input.value.trim();
    if(save&&next&&next!==ev.title){
      ev.title=next;
      if(typeof _persistTaskTitle==="function")_persistTaskTitle(id,next);
      if(typeof showToast==="function")showToast("Subtask updated","success",2200);
    }
    if(typeof render==="function")render();
  }
  input.addEventListener("click",e=>e.stopPropagation());
  input.addEventListener("keydown",e=>{
    e.stopPropagation();
    if(e.key==="Enter"){e.preventDefault();finish(true);}
    if(e.key==="Escape"){e.preventDefault();finish(false);}
  });
  input.addEventListener("blur",()=>finish(true));
}

function subtaskActionsHtml(ev){
  const move=subtaskMoveState(ev.id);
  const disabledUp=move.canUp?"":' disabled aria-disabled="true"';
  const disabledDown=move.canDown?"":' disabled aria-disabled="true"';
  return '<div class="sub-actions" aria-label="Subtask actions">'+
    '<button type="button" class="sub-action-btn sub-edit" data-sub-edit-id="'+ev.id+'" title="Edit subtask" aria-label="Edit subtask">&#9998;</button>'+
    '<button type="button" class="sub-action-btn sub-move" data-sub-move-id="'+ev.id+'" data-dir="-1" title="Move subtask up" aria-label="Move subtask up"'+disabledUp+'>&#8593;</button>'+
    '<button type="button" class="sub-action-btn sub-move" data-sub-move-id="'+ev.id+'" data-dir="1" title="Move subtask down" aria-label="Move subtask down"'+disabledDown+'>&#8595;</button>'+
    '<button type="button" class="btn-add-menu sub-action-btn sub-add" title="Add child subtask" aria-label="Add child subtask" data-add-id="'+ev.id+'">+</button>'+
    '<button type="button" class="btn-del-task sub-action-btn sub-delete" data-del-id="'+ev.id+'" title="Delete subtask" aria-label="Delete subtask"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
  '</div>';
}

function bindSubtaskActions(el,ev){
  const title=el.querySelector(".sub-ttl");
  if(title){
    title.setAttribute("tabindex","0");
    title.setAttribute("role","button");
    title.setAttribute("aria-label","Edit subtask title");
    title.addEventListener("click",e=>{e.stopPropagation();startSubtaskTitleEdit(ev.id,title);});
    title.addEventListener("keydown",e=>{
      if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();startSubtaskTitleEdit(ev.id,title);}
    });
  }
  const edit=el.querySelector(".sub-edit");
  if(edit)edit.addEventListener("click",e=>{e.stopPropagation();startSubtaskTitleEdit(ev.id,el.querySelector(".sub-ttl"));});
  el.querySelectorAll(".sub-move").forEach(btn=>btn.addEventListener("click",e=>{
    e.stopPropagation();
    if(btn.disabled)return;
    moveSubtaskSibling(btn.dataset.subMoveId,parseInt(btn.dataset.dir,10));
  }));
  const add=el.querySelector(".btn-add-menu");
  if(add)add.addEventListener("click",e=>{e.stopPropagation();if(typeof openSubtaskAdd==="function")openSubtaskAdd(ev.id,add);else if(typeof openAddModal==="function")openAddModal(ev.id,ev.title);});
  const del=el.querySelector(".btn-del-task");
  if(del)del.addEventListener("click",e=>{e.stopPropagation();openDeleteConfirm(del.dataset.delId);});
}

// ── Task-row radial: every task-level action fans out from the row's arrow ──
// The row itself keeps only done / notes / delete visible; everything else
// (schedule, duration, pomodoro, lock, add, subtask, delegate, repeat,
// backlog, bounty) is a spoke here. Items are built fresh per open so dynamic
// state — the lock flag, bounty availability — is read at fan time.
// Duration presets: popover on desktop, bottom sheet on touch/narrow. Shared
// by the radial's "Duration…" spoke and the meeting card's duration badge.
function openDurPopover(ev,anchorEl){
  if(isCoarseOrNarrowViewport()){ openDurationSheet(ev); return; }
  document.querySelectorAll(".dur-popover").forEach(p=>p.remove());
  const curMin=dur(ev);
  const pages=[[15,30,45,60,90,120],[150,180,210,240,300,360]];
  let page=pages.findIndex(pg=>pg.includes(curMin));if(page===-1)page=0;
  const pop=document.createElement("div");pop.className="dur-popover";
  function closePop(){
    pop.remove();
    document.removeEventListener("click",onOutside,true);
  }
  function renderPage(){
    pop.innerHTML="";
    const grid=document.createElement("div");grid.className="dur-presets";
    pages[page].forEach(m=>{
      const btn=document.createElement("button");
      btn.className="dur-preset"+(m===curMin?" dur-current":"");
      btn.textContent=ms(m);
      btn.addEventListener("click",e2=>{e2.stopPropagation();closePop();setDurAbsolute(ev.id,m);});
      grid.appendChild(btn);
    });
    pop.appendChild(grid);
    const nav=document.createElement("div");nav.className="dur-nav";
    const prev=document.createElement("button");prev.className="dur-nav-btn";prev.innerHTML="&#8592;";prev.disabled=page===0;
    prev.addEventListener("click",e2=>{e2.stopPropagation();if(page>0){page--;renderPage();}});
    const dots=document.createElement("div");dots.className="dur-nav-dots";
    pages.forEach((_,i)=>{const d=document.createElement("span");d.className="dur-nav-dot"+(i===page?" active":"");dots.appendChild(d);});
    const next=document.createElement("button");next.className="dur-nav-btn";next.innerHTML="&#8594;";next.disabled=page===pages.length-1;
    next.addEventListener("click",e2=>{e2.stopPropagation();if(page<pages.length-1){page++;renderPage();}});
    nav.appendChild(prev);nav.appendChild(dots);nav.appendChild(next);
    pop.appendChild(nav);
    // Custom granular duration: any whole-minute value, not snapped to the 15m presets
    const custom=document.createElement("div");custom.className="dur-custom";
    const cInput=document.createElement("input");cInput.type="number";cInput.className="dur-custom-input";
    cInput.min="1";cInput.step="1";cInput.value=String(curMin);cInput.setAttribute("aria-label","Custom minutes");
    const cBtn=document.createElement("button");cBtn.className="dur-custom-btn";cBtn.textContent="Set";
    const applyCustom=()=>{const v=Math.max(1,Math.round(parseInt(cInput.value,10)||0));if(v){closePop();setDurAbsolute(ev.id,v);}};
    cBtn.addEventListener("click",e2=>{e2.stopPropagation();applyCustom();});
    cInput.addEventListener("click",e2=>e2.stopPropagation());
    cInput.addEventListener("keydown",e2=>{e2.stopPropagation();if(e2.key==="Enter"){e2.preventDefault();applyCustom();}});
    custom.appendChild(cInput);custom.appendChild(cBtn);
    pop.appendChild(custom);
  }
  renderPage();
  // Position relative to the anchor using fixed coords (escapes stacking
  // context). Append hidden first so we can measure the popover's real size,
  // then clamp it fully on-screen.
  pop.style.visibility="hidden";
  document.body.appendChild(pop);
  const rect=anchorEl.getBoundingClientRect();
  const margin=8;
  const popW=pop.offsetWidth||148;
  const popH=pop.offsetHeight||0;
  let left=rect.right-popW; // prefer right-aligned to the anchor
  left=Math.max(margin,Math.min(left,window.innerWidth-popW-margin));
  let top=rect.bottom+6;
  if(top+popH>window.innerHeight-margin){
    // No room below -- prefer flipping above the anchor.
    const above=rect.top-popH-6;
    if(above>=margin)top=above;
  }
  top=Math.max(margin,Math.min(top,window.innerHeight-popH-margin));
  pop.style.left=left+"px";
  pop.style.top=top+"px";
  pop.style.right="auto";
  pop.style.visibility="";
  function onOutside(e2){if(!pop.contains(e2.target)&&e2.target!==anchorEl){closePop();}}
  setTimeout(()=>document.addEventListener("click",onOutside,true),0);
}
// The bounty button lives ON the row (not in the radial): it shows on every
// eligible row while the day's self bounty is unplaced; placing it re-renders,
// every button vanishes, and the chosen task glows gold. placeBounty itself
// toasts the finer denials (locked bounty, partner stacking, done task).
function _canPlaceBounty(ev,isDoneRow){
  if(isMeeting(ev)||isDoneRow)return false;
  if(typeof viewMode!=="undefined"&&viewMode==="archive")return false;
  if(typeof hasSelfBounty==="function"&&hasSelfBounty())return false;
  return true;
}
const _bountyBtnSvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
function buildTaskRadialItems(ev,trig){
  return [
    // Move/convert actions live one level down: this spoke chains into the
    // "Change task" sub-fan (openRadialMenu closes the current fan first).
    {icon:"🔀", label:"Change task…", onPick:()=>openTaskChangeRadial(ev,trig)},
    {icon:"⏱", label:"Duration…", onPick:()=>openDurPopover(ev,trig)},
    {icon:"🍅", label:"Pomodoro",  onPick:()=>{if(typeof openPomodoro==="function")openPomodoro(ev.title,dur(ev),{id:ev.id,source:"schedule",title:ev.title});}},
    {icon:ev._locked?"🔓":"🔒", label:ev._locked?"Unlock":"Lock", onPick:()=>{if(typeof toggleLock==="function")toggleLock(ev.id);}},
    {icon:"➕", label:"Add task…", onPick:()=>{if(typeof openSubtaskAdd==="function")openSubtaskAdd(ev.id,trig);else if(typeof openAddModal==="function")openAddModal(ev.id,ev.title);}}
  ];
}
// Sub-fan: everything that moves or converts the task, grouped so the top
// fan stays scannable. Back returns to the top fan on the same trigger.
function buildTaskChangeItems(ev,trig){
  return [
    {icon:"←", label:"Back",       onPick:()=>openTaskRadial(ev,trig)},
    {icon:"📅", label:"Schedule…", onPick:()=>{if(typeof openSchedulePopover==="function")openSchedulePopover({mode:"reschedule",id:ev.id,anchorEl:trig});}},
    {icon:"🪜", label:"Subtask…",  onPick:()=>{if(typeof openMakeSubtaskOf==="function")openMakeSubtaskOf(ev.id,trig);}},
    {icon:"🤝", label:"Delegate",  onPick:()=>{if(typeof convertTaskToDelegated==="function")convertTaskToDelegated(ev.id);}},
    {icon:"🔁", label:"Repeat",    onPick:()=>{if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask(ev);}},
    {icon:"💡", label:"Backlog",   onPick:()=>{if(typeof moveTaskToBacklog==="function")moveTaskToBacklog(ev.id);}}
  ];
}
const _TASK_RADIAL_OPTS={a0:90,a1:270,r:140,labelStagger:true,clampY:true};
function openTaskRadial(ev,trig){
  // 180° left-opening fan: the trigger lives at the row's right edge, so the
  // spokes sweep bottom → left → top. Staggered label radii keep the pills
  // from colliding near the vertical apexes; clampY keeps edge rows on-screen.
  openRadialMenu(trig,buildTaskRadialItems(ev,trig),_TASK_RADIAL_OPTS);
}
function openTaskChangeRadial(ev,trig){
  openRadialMenu(trig,buildTaskChangeItems(ev,trig),_TASK_RADIAL_OPTS);
}

// ── Section sorting (Unscheduled / Unfinished): A→Z or time-of-creation ──
function _sectionSort(key){ try{return localStorage.getItem("pa-sort-"+key)||"created"}catch(e){return "created"} }
function _setSectionSort(key,mode){ try{localStorage.setItem("pa-sort-"+key,mode==="alpha"?"alpha":"created")}catch(e){} }
function _applySectionSort(items,mode,getTitle,getCreated){
  const arr=items.slice();
  if(mode==="alpha")arr.sort((a,b)=>String(getTitle(a)||"").localeCompare(String(getTitle(b)||"")));
  else arr.sort((a,b)=>String(getCreated(b)||"").localeCompare(String(getCreated(a)||""))); // newest first
  return arr;
}

// ── Unfinished (past-dated, never completed) — inline section state ──
// collectUnfinishedTasks (unfinished-tasks.js) is async; buildListView is sync.
// Cache one collection per rendered today-date and re-render when it lands.
let _unfinishedCache=null;      // {rows,total}
let _unfinishedFetchedFor=null; // the today-date the cache was collected for
let _unfinishedLoading=false;
function invalidateUnfinishedSection(){ _unfinishedCache=null; _unfinishedFetchedFor=null; }
function _ensureUnfinished(today){
  if(_unfinishedFetchedFor===today||_unfinishedLoading)return;
  if(typeof window.collectUnfinishedTasks!=="function")return;
  _unfinishedLoading=true;
  window.collectUnfinishedTasks()
    .then(res=>{ _unfinishedCache=res||{rows:[],total:0}; _unfinishedFetchedFor=today; })
    .catch(()=>{ _unfinishedCache={rows:[],total:0}; _unfinishedFetchedFor=today; })
    .finally(()=>{ _unfinishedLoading=false; buildListView(); });
}
function _unfRemoveRow(r){
  if(!_unfinishedCache)return;
  _unfinishedCache.rows=_unfinishedCache.rows.filter(x=>x!==r);
  _unfinishedCache.total=Math.max(0,(_unfinishedCache.total||1)-1);
}
function _unfPrettyDate(iso){
  const d=new Date(iso+"T00:00:00");
  if(isNaN(d.getTime()))return iso;
  return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
}

function buildListView(){
  const wrap=document.getElementById("list-view");
  if(!wrap)return;
  wrap.innerHTML="";
  const viewDate=(__state&&__state.date)||new Date().toISOString().split("T")[0];
  const trivFlags=loadTrivialFlags();
  const visible=scheduled.filter(ev=>!isDeleted(ev)&&!trivFlags[ev.id]);
  // Completed subtasks live inside their parent's detail panel (shown there as
  // done), not as standalone rows in the Done section -- so long as the parent
  // is still visible to open. Orphaned done subtasks stay listed so they aren't lost.
  const doneItems=visible.filter(ev=>isDone(ev)&&!(isSubtask(ev)&&visible.some(p=>p.id===ev.subtaskOf)));
  const openItems=visible.filter(ev=>!isDone(ev)&&!isPushed(ev));
  const pushedItems=visible.filter(ev=>!isDone(ev)&&isPushed(ev));
  const activeIds=new Set(openItems.filter(ev=>!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break").map(ev=>ev.id));
  const ckSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
  const gripSvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

  function section(title,count,sortKey){
    const el=document.createElement("div");
    el.className="it-list-section";
    let html='<span>'+title+'</span>'+(count?'<b>'+count+'</b>':'');
    if(sortKey){
      const mode=_sectionSort(sortKey);
      html+='<span class="it-sort-toggle">'+
        '<button class="it-sort-btn'+(mode==="alpha"?' on':'')+'" data-mode="alpha" title="Sort A to Z">A–Z</button>'+
        '<button class="it-sort-btn'+(mode!=="alpha"?' on':'')+'" data-mode="created" title="Sort by time of creation (newest first)">New</button>'+
      '</span>';
    }
    el.innerHTML=html;
    if(sortKey)el.querySelectorAll(".it-sort-btn").forEach(b=>b.addEventListener("click",e=>{
      e.stopPropagation();_setSectionSort(sortKey,b.dataset.mode);buildListView();
    }));
    wrap.appendChild(el);
  }

  function listPrivacyChip(ev){
    if(!ev||isMeeting(ev)||ev.type==="break"||ev.type==="ooo")return "";
    const visibility=ev.publicVisibility==="private"?"private":"public";
    const label=visibility==="private"?"Private":"Public";
    return '<button class="pet-privacy-toggle '+visibility+'" type="button" data-pet-privacy-id="'+String(ev.id).replace(/"/g,'&quot;')+'" title="Toggle Pet Home sharing">'+label+'</button>';
  }

  // Jump-to-source link for API-inserted tasks whose source_id is a URL (e.g.
  // the Slack-bookmark poller stores the message permalink). Opens in a new tab.
  function sourceJumpLink(ev){
    const url=ev&&ev.source_id;
    if(!url||!/^https?:\/\//.test(url))return "";
    const label=/slack\.com/.test(url)?"Slack":"Source";
    return '<a class="src-jump" href="'+escHtml(url)+'" target="_blank" rel="noopener" title="Open source ('+label+')" onclick="event.stopPropagation()">'+label+' ↗</a>';
  }

  function row(ev,idx,mode,node){
    const isDoneRow=mode==="done";
    const isPushedRow=mode==="pushed";
    const movable=!isDoneRow&&!isPushedRow&&!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break"&&!ev._locked;
    const c=cfg(ev.type);
    const original=origDur(ev.id);
    const changed=original&&dur(ev)!==original;
    const bw=(typeof wrapBandwidth==="function")?wrapBandwidth(ev,scheduled):null;
    const prog=(typeof subtaskProgress==="function")?subtaskProgress(ev.id,scheduled):null;
    // Always emit a leading cell (button when expandable, else a spacer) so every
    // row has the same child count and lands in the same grid columns. Without the
    // spacer, expandable rows had one extra leading child that overflowed the
    // fixed-column grid -- shoving the title right and wrapping actions to a 2nd line.
    const chev=(node&&node.hasKids)?'<button class="wrap-collapse'+(node.collapsed?' collapsed':'')+'" title="Collapse / expand">'+(node.collapsed?'▸':'▾')+'</button>':'<span class="wrap-collapse-spacer"></span>';
    const el=document.createElement("div");
    const tt=window.TaskTypes?window.TaskTypes.get(ev):null;
    const chkBlocked=(typeof shellCompleteBlocked==="function")&&shellCompleteBlocked(ev);
    el.className="it-list-item"+(isDoneRow?" done":"")+(isPushedRow?" pushed":"")+(isActive(ev)?" active":"")+(movable?" movable":"")+(isRideAlong(ev)?" ride-along":"")+(isWrap(ev)?" wrap-parent":"")+(tt&&tt.cardClass?" "+tt.cardClass:"")+(typeof isBountyTask==="function"&&isBountyTask(ev.id)?" row-bounty":"");
    if(node&&node.depth)el.style.marginLeft=(node.depth*22)+"px";
    el.dataset.id=ev.id;
    if(movable){el.draggable=true;el.addEventListener("dragstart",e=>dStart(e,ev.id));el.addEventListener("dragend",dEnd);}
    if(!isDoneRow&&!isPushedRow){el.addEventListener("dragover",e=>dOver(e,ev.id));el.addEventListener("dragleave",dLeave);el.addEventListener("drop",e=>dDrop(e,ev.id));}
    el.innerHTML=
      chev+
      '<div class="it-list-rank">'+(idx+1)+'</div>'+
      '<div class="grip it-list-grip" title="'+(movable?'Drag to reorder':'Fixed item')+'">'+gripSvg+'</div>'+
      '<div class="it-list-check-col">'+
        '<button class="chk it-list-check'+(isDoneRow?' on':'')+(chkBlocked?' chk-blocked':'')+'" title="'+(isDoneRow?'Uncheck':(chkBlocked?'Completes automatically when all nested tasks are done':'Mark done'))+'">'+ckSvg+'</button>'+
        (!isMeeting(ev)&&!isDoneRow&&!(tt&&tt.rollupMode)?'<button class="chk-quick" title="Quick complete">&#9889;</button>':'')+
      '</div>'+
      '<div class="bar" style="background:'+((tt&&tt.barColor)||taskTagColor(ev)||c.color)+'"></div>'+
      '<div class="it-list-main">'+
        '<div class="it-list-title-row"><span class="ttl" title="'+escHtml(ev.title)+'">'+escHtml(ev.title)+'</span>'+srcTag(ev.source)+sourceJumpLink(ev)+listPrivacyChip(ev)+taskTagChipsHtml(ev)+'</div>'+
        '<div class="it-list-meta">'+
          '<span class="tag '+c.cls+'">'+c.tag+'</span>'+
          '<span>'+ms(dur(ev))+'</span>'+
          (tt&&tt.rollupMode&&typeof shellRollupChip==="function"?shellRollupChip(ev):'')+
          (ev.untimed?'<span class="it-list-untimed">Unscheduled</span>':(!isMeeting(ev)&&!isDoneRow?'<span class="start-time'+(ev._pinnedStart?' pinned':'')+'" data-start-id="'+ev.id+'" title="Click to adjust start time">'+f12(ev.start)+' - '+f12(ev.end)+'</span>':'<span>'+f12(ev.start)+' - '+f12(ev.end)+'</span>'))+
          (ev._locked?'<span class="it-list-lock" title="Locked — holds its time when tasks reflow"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>':'')+
          (changed?'<span class="it-list-changed">Duration adjusted</span>':'')+
          (bw?'<span class="wrap-bw">'+bw.count+' ride-along'+(bw.count>1?'s':'')+' · ~'+ms(bw.mins)+' inside</span>':'')+
          (prog?'<span class="subtask-prog">'+prog.done+'/'+prog.total+' subtasks</span>':'')+
        '</div>'+
      '</div>'+
      '<div class="it-list-actions">'+
        // Row keeps done / notes / bounty / delete visible; every other task
        // action rides the radial behind the arrow trigger.
        notesButton(ev)+
        (_canPlaceBounty(ev,isDoneRow)?'<button class="btn-bounty" data-bounty-id="'+ev.id+'" data-tooltip="Set bounty - 2x points" aria-label="Set bounty">'+_bountyBtnSvg+'</button>':'')+
        (!isMeeting(ev)&&!isDoneRow?'<button class="btn-task-radial" data-radial-id="'+ev.id+'" data-tooltip="Task actions…"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>':'')+
        (!isMeeting(ev)&&!isDoneRow?'<button class="btn-del-task" data-del-id="'+ev.id+'" data-tooltip="Remove from schedule"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>':'')+
      '</div>';

    el.querySelector(".it-list-check").addEventListener("click",e=>{
      e.stopPropagation();
      // Blocked rollup container: skip the notes modal, let toggleDone toast why.
      if(isDoneRow||chkBlocked)toggleDone(ev.id);
      else openDoneModal(ev.id,ev.title,()=>toggleDone(ev.id),ev);
    });
    const quick=el.querySelector(".chk-quick");
    if(quick)quick.addEventListener("click",e=>{e.stopPropagation();quick.classList.add("flash");toggleDone(ev.id);});
    const stSpan=el.querySelector(".start-time");if(stSpan)stSpan.addEventListener("click",e=>{e.stopPropagation();if(typeof openStartTimePicker==="function")openStartTimePicker(ev.id,stSpan);});
    const nb=el.querySelector(".notes-btn");
    if(nb)nb.addEventListener("click",e=>{e.stopPropagation();if(typeof openAddModal==='function')openAddModal(nb.dataset.notesId,nb.dataset.notesTitle);else openNotesDrawer(nb.dataset.notesId,nb.dataset.notesTitle);});
    const pb=el.querySelector(".btn-task-radial");
    if(pb)pb.addEventListener("click",e=>{e.stopPropagation();openTaskRadial(ev,pb);});
    const bb=el.querySelector(".btn-bounty");
    if(bb)bb.addEventListener("click",e=>{e.stopPropagation();if(typeof placeBounty==="function")placeBounty(bb.dataset.bountyId);});
    const del=el.querySelector(".btn-del-task");
    if(del)del.addEventListener("click",e=>{e.stopPropagation();openDeleteConfirm(del.dataset.delId);});
    const cc=el.querySelector(".wrap-collapse");
    if(cc)cc.addEventListener("click",e=>{e.stopPropagation();if(typeof toggleCollapsed==="function"){toggleCollapsed(ev.id);render();}});
    return el;
  }

  // Compact row for a subtask (a timeless step under its parent). Smaller than a
  // first-class row; collapsible when it has its own subtasks.
  function subRow(ev,idx,mode,node){
    const doneRow=mode==="done"||isDone(ev);
    const movable=!isMeeting(ev)&&!ev._locked&&!doneRow;
    const prog=(typeof subtaskProgress==="function")?subtaskProgress(ev.id,scheduled):null;
    const chev=(node&&node.hasKids)?'<button class="wrap-collapse'+(node.collapsed?' collapsed':'')+'" title="Collapse / expand">'+(node.collapsed?'▸':'▾')+'</button>':'<span class="wrap-collapse-spacer"></span>';
    const el=document.createElement("div");
    el.className="it-list-item subtask-row"+(doneRow?" done":"")+(isActive(ev)?" active":"")+(movable?" movable":"");
    if(node&&node.depth)el.style.marginLeft=(node.depth*22)+"px";
    el.dataset.id=ev.id;
    if(movable){el.draggable=true;el.addEventListener("dragstart",e=>dStart(e,ev.id));el.addEventListener("dragend",dEnd);}
    el.addEventListener("dragover",e=>dOver(e,ev.id));el.addEventListener("dragleave",dLeave);el.addEventListener("drop",e=>dDrop(e,ev.id));
    el.innerHTML=
      chev+
      '<button class="chk sub-check'+(doneRow?' on':'')+'" title="'+(doneRow?'Uncheck':'Mark done')+'">'+ckSvg+'</button>'+
      '<span class="sub-ttl" title="'+escHtml(ev.title)+'">'+ev.title+'</span>'+
      (prog?'<span class="subtask-prog">'+prog.done+'/'+prog.total+'</span>':'')+
      subtaskActionsHtml(ev);
    el.querySelector(".sub-check").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id);});
    const cc=el.querySelector(".wrap-collapse");
    if(cc)cc.addEventListener("click",e=>{e.stopPropagation();if(typeof toggleCollapsed==="function"){toggleCollapsed(ev.id);render();}});
    bindSubtaskActions(el,ev);
    return el;
  }
  function emitNode(node,idx,mode){return node.rel==="subtask"?subRow(node.ev,idx,mode,node):row(node.ev,idx,mode,node);}

  // Parents with at least one child anywhere in the visible list -- these are the
  // rows the Collapse all / Expand all controls act on.
  const parentIds=visible.filter(ev=>childrenOf(ev.id,visible).length>0).map(ev=>ev.id);
  if(parentIds.length){
    const controls=document.createElement("div");
    controls.className="it-list-controls";
    controls.innerHTML=
      '<button class="it-list-ctrl-btn" data-collapse-action="expand">Expand all</button>'+
      '<button class="it-list-ctrl-btn" data-collapse-action="collapse">Collapse all</button>';
    controls.querySelectorAll(".it-list-ctrl-btn").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        if(typeof setCollapsedAll==="function"){setCollapsedAll(parentIds,btn.dataset.collapseAction==="collapse");render();}
      });
    });
    wrap.appendChild(controls);
  }

  // One unified list in schedule order: open AND done inline (done rows shrink
  // + grey in place, staying in their time slot -- not yanked to a bottom
  // "Done" section). Pushed stays its own section. Numbering counts only
  // top-level rows (subtasks render under their parent and take no number), so
  // the ranks read 1,2,3,4 with no gaps.
  // Untimed tasks (no start -- e.g. API/Slack inserts with no scheduled time)
  // get their own section at the bottom instead of being dropped or forced to
  // 00:00 in the timeline.
  const untimedItems=visible.filter(ev=>ev.untimed&&!isPushed(ev)&&!isDone(ev)&&!isSubtask(ev));
  const untimedIds=new Set(untimedItems.map(e=>e.id));
  const mainItems=visible.filter(ev=>!isPushed(ev)&&!untimedIds.has(ev.id)&&!(isDone(ev)&&isSubtask(ev)&&visible.some(p=>p.id===ev.subtaskOf)));
  section("Work list",activeIds.size);
  if(!mainItems.length){
    const empty=document.createElement("div");
    empty.className="it-list-empty";
    empty.textContent=viewDate===((typeof _actualTodayStr==="function")?_actualTodayStr():viewDate)?"Nothing scheduled for today.":"Nothing scheduled on this day.";
    wrap.appendChild(empty);
  }else{
    let rank=0;
    flattenSchedule(mainItems).forEach(node=>{
      const isSub=node.rel==="subtask";
      const displayIdx=isSub?0:rank++;            // only non-subtasks consume a number
      wrap.appendChild(emitNode(node,displayIdx,isDone(node.ev)?"done":"open"));
    });
  }
  if(untimedItems.length){
    section("Unscheduled",untimedItems.length,"unscheduled");
    _applySectionSort(untimedItems,_sectionSort("unscheduled"),ev=>ev.title,ev=>ev.createdAt||"")
      .forEach((ev,idx)=>wrap.appendChild(row(ev,idx,"open")));
  }

  // Unfinished: tasks dated in the PAST that were never completed. Shown only on
  // the actual today view; complete lands on the origin day, reschedule is a
  // true move (server tombstone -> the origin day shows it amber).
  const actualToday=(typeof _actualTodayStr==="function")?_actualTodayStr():viewDate;
  if(viewDate===actualToday){
    _ensureUnfinished(actualToday);
    const unf=_unfinishedCache;
    if(unf&&unf.rows.length){
      section("Unfinished",unf.total,"unfinished");
      _applySectionSort(unf.rows,_sectionSort("unfinished"),r=>r.title,r=>r.createdAt||r.sourceDate||"")
        .forEach(r=>wrap.appendChild(unfinishedRow(r)));
      if(unf.total>unf.rows.length){
        const more=document.createElement("div");
        more.className="it-list-empty";
        more.textContent="+"+(unf.total-unf.rows.length)+" more unfinished — complete or reschedule some to see the rest.";
        wrap.appendChild(more);
      }
    }
  }

  if(pushedItems.length){
    section("Pushed",pushedItems.length);
    pushedItems.forEach((ev,idx)=>wrap.appendChild(row(ev,idx,"pushed")));
  }

  // Rescheduled away (amber) — parity with the timeline view's bottom section.
  const rescheduledAwayItems=(window.blockStore&&typeof window.blockStore.getByType==="function")
    ? window.blockStore.getByType("block")
        .filter(b=>b&&!b.deleted_at&&(b.properties||{}).kind==="reschedule_tombstone"&&(b.date===viewDate||!b.date))
        .sort((a,b)=>String((a.properties||{}).title||"").localeCompare(String((b.properties||{}).title||"")))
    : [];
  if(rescheduledAwayItems.length){
    section("Rescheduled away",rescheduledAwayItems.length);
    rescheduledAwayItems.forEach(b=>{
      const p=b.properties||{};
      const el=document.createElement("div");
      el.className="it-list-item resched-away-row";
      el.innerHTML=
        '<span class="wrap-collapse-spacer"></span>'+
        '<div class="it-list-rank">·</div>'+
        '<div class="grip it-list-grip" title="Fixed item">'+gripSvg+'</div>'+
        '<div class="it-list-check-col"><button class="chk it-list-check" title="Restore to this day">'+ckSvg+'</button></div>'+
        '<div class="bar" style="background:var(--amber,#f59e0b)"></div>'+
        '<div class="it-list-main">'+
          '<div class="it-list-title-row"><span class="ttl" title="'+escHtml(p.title||"Task")+'">'+escHtml(p.title||"Task")+'</span></div>'+
          '<div class="it-list-meta"><span class="it-list-resched-away">Rescheduled to '+escHtml(p.rescheduledTo||"another day")+'</span></div>'+
        '</div>'+
        '<div class="it-list-actions"></div>';
      el.querySelector(".it-list-check").addEventListener("click",e=>{
        e.stopPropagation();
        if(typeof restoreRescheduledAway==="function")restoreRescheduledAway(b.id);
      });
      wrap.appendChild(el);
    });
  }

  // Compact row + actions for an Unfinished entry (a raw past-day block, NOT a
  // scheduled[] task — so no drag/duration/lock; just resolve-or-move actions).
  function unfinishedRow(r){
    const el=document.createElement("div");
    el.className="it-list-item unfinished-row";
    const c=cfg(r.type||"task");
    el.innerHTML=
      '<span class="wrap-collapse-spacer"></span>'+
      '<div class="it-list-rank">·</div>'+
      '<div class="grip it-list-grip" title="Fixed item">'+gripSvg+'</div>'+
      '<div class="it-list-check-col"><button class="chk it-list-check" title="Mark done on '+escHtml(_unfPrettyDate(r.sourceDate))+'">'+ckSvg+'</button></div>'+
      '<div class="bar" style="background:var(--amber,#f59e0b)"></div>'+
      '<div class="it-list-main">'+
        '<div class="it-list-title-row"><span class="ttl" title="'+escHtml(r.title)+'">'+escHtml(r.title)+'</span>'+srcTag(r.source)+'</div>'+
        '<div class="it-list-meta">'+
          '<span class="tag '+c.cls+'">'+c.tag+'</span>'+
          '<span>'+ms(r.durMin)+'</span>'+
          '<span class="it-list-unfinished">Unfinished · from '+escHtml(_unfPrettyDate(r.sourceDate))+'</span>'+
        '</div>'+
      '</div>'+
      '<div class="it-list-actions unfinished-actions">'+
        '<button class="carryover-btn unf-il-today">Today</button>'+
        '<button class="carryover-btn unf-il-tmr">Tomorrow</button>'+
        '<input type="date" class="resched-date-input unf-il-date"/>'+
        '<button class="carryover-btn unf-il-move">Move</button>'+
        '<button class="btn-del-task unf-il-drop" data-tooltip="Drop for good"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>'+
      '</div>';
    const busy=()=>el.querySelectorAll("button,input").forEach(x=>{x.disabled=true;});
    async function moveTo(targetDate){
      if(!targetDate||!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)){if(typeof showToast==="function")showToast("Pick a valid date","error");return;}
      if(!window.blockStore||typeof window.blockStore.rescheduleBlock!=="function")return;
      busy();
      let slot=null;
      try{
        if(typeof _computeRescheduleSlot==="function")
          slot=await _computeRescheduleSlot({id:r.sourceLocalId||r.sourceId,title:r.title,start:r.start||"00:00",end:r.end||fmt(pt(r.start||"00:00")+r.durMin)},targetDate);
      }catch(e){}
      window.__RESCHEDULE_IN_FLIGHT__=true;
      try{
        await window.blockStore.rescheduleBlock(r.sourceId,targetDate,slot?{parentStart:slot.start,parentEnd:slot.end}:{});
      }catch(e){
        if(typeof showToast==="function")showToast("Could not move "+r.title,"error");
        el.querySelectorAll("button,input").forEach(x=>{x.disabled=false;});
        return;
      }finally{
        window.__RESCHEDULE_IN_FLIGHT__=false;
      }
      _unfRemoveRow(r);
      if(typeof window.blockStore.invalidateRangeCache==="function")window.blockStore.invalidateRangeCache(r.sourceDate);
      if(typeof log==="function")log("rescheduled",r.sourceId,"Unfinished moved to "+targetDate+": "+r.title);
      if(typeof showToast==="function")showToast("Moved to "+_unfPrettyDate(targetDate)+": "+r.title,"success");
      if(targetDate===viewDate){
        try{await window.blockStore.loadDay(viewDate);}catch(e){}
        if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
        if(typeof recalcTimes==="function")recalcTimes();
      }
      render();
    }
    el.querySelector(".it-list-check").addEventListener("click",async e=>{
      e.stopPropagation();busy();
      try{if(typeof commitDoneOnDate==="function")await commitDoneOnDate(r.sourceLocalId||r.sourceId,r.sourceDate);}catch(e2){}
      _unfRemoveRow(r);
      if(window.blockStore&&typeof window.blockStore.invalidateRangeCache==="function")window.blockStore.invalidateRangeCache(r.sourceDate);
      if(typeof showToast==="function")showToast("Done on "+_unfPrettyDate(r.sourceDate)+": "+r.title,"success");
      render();
    });
    el.querySelector(".unf-il-today").addEventListener("click",e=>{e.stopPropagation();moveTo(actualToday);});
    el.querySelector(".unf-il-tmr").addEventListener("click",e=>{
      e.stopPropagation();
      const tmr=(typeof __tomorrowDate!=="undefined"&&__tomorrowDate)?__tomorrowDate:new Date(Date.now()+86400000).toISOString().slice(0,10);
      moveTo(tmr);
    });
    el.querySelector(".unf-il-move").addEventListener("click",e=>{e.stopPropagation();moveTo(el.querySelector(".unf-il-date").value);});
    el.querySelector(".unf-il-drop").addEventListener("click",async e=>{
      e.stopPropagation();busy();
      try{await window.blockStore.deleteBlock(r.sourceId);}catch(e2){}
      _unfRemoveRow(r);
      if(window.blockStore&&typeof window.blockStore.invalidateRangeCache==="function")window.blockStore.invalidateRangeCache(r.sourceDate);
      if(typeof log==="function")log("dropped",r.sourceId,"Dropped unfinished: "+r.title);
      if(typeof showToast==="function")showToast("Dropped: "+r.title,"info");
      render();
    });
    return el;
  }
}

// ======== SCHEDULE TAB ========
function buildSchedule(){
  const tl=document.getElementById("timeline");
  // One-time: accept drops of a preset task group onto empty timeline space.
  if(!tl._groupDropWired){
    tl._groupDropWired=true;
    tl.addEventListener("dragover",e=>{ if(window._dragFromTaskGroup){e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect="copy";} });
    tl.addEventListener("drop",e=>{ const gid=window._dragFromTaskGroup; if(!gid)return; e.preventDefault(); window._dragFromTaskGroup=null; if(typeof window.addTaskGroupToDay==="function")window.addTaskGroupToDay(gid); });
  }
  tl.innerHTML="";
  const listView=document.getElementById("list-view");if(listView)listView.innerHTML="";
  if(typeof buildScheduleDelegated==="function")buildScheduleDelegated();
  if(typeof buildScheduleTriage==="function")buildScheduleTriage();
  const viewDate=(__state&&__state.date)||new Date().toISOString().split("T")[0];
  if(typeof window.ensureTodoShareReactionsForDate==="function")window.ensureTodoShareReactionsForDate(viewDate);
  // Separate done vs pushed vs active vs deleted vs side-project-marked
  const trivFlags=loadTrivialFlags();
  const vis=scheduled.filter(ev=>!isDeleted(ev)&&!trivFlags[ev.id]); // Hide side-project-marked items from the schedule
  // Completed subtasks live inside their parent's detail panel (shown there as
  // done), not as standalone done one-liners -- so long as the parent is still
  // visible to open. Orphaned done subtasks stay listed so they aren't lost.
  const doneItems=vis.filter(ev=>isDone(ev)&&!(isSubtask(ev)&&vis.some(p=>p.id===ev.subtaskOf)));
  const triageDoneItems=typeof completedTriageTasksForDate==="function"?completedTriageTasksForDate(viewDate):[];
  const pushedItems=vis.filter(ev=>!isDone(ev)&&isPushed(ev));
  const activeItems=vis.filter(ev=>!isDone(ev)&&!isPushed(ev));
  // Tasks originally on this day that were rescheduled AWAY to another date. The
  // move leaves a "reschedule_tombstone" block on this day carrying the
  // destination; we render it amber at the bottom (mirror of Pushed to Tomorrow).
  const rescheduledAwayItems=(window.blockStore&&typeof window.blockStore.getByType==="function")
    ? window.blockStore.getByType("block")
        .filter(b=>b&&!b.deleted_at&&(b.properties||{}).kind==="reschedule_tombstone"&&(b.date===viewDate||!b.date))
        .sort((a,b)=>String((a.properties||{}).title||"").localeCompare(String((b.properties||{}).title||"")))
    : [];

  // Schedule block section headers
  const schedBlocks=((__state&&__state.schedule&&__state.schedule.blocks)||[]).slice().sort((a,b)=>a.start.localeCompare(b.start));
  let blockPtr=0;
  function parseHHMM(t){const[h,m]=t.split(':').map(Number);return h*60+m;}
  function fmtBlk12(hhmm){const[h,m]=hhmm.split(':').map(Number);const a=h>=12?'PM':'AM',h12=h%12||12;return h12+':'+(m<10?'0':'')+m+' '+a;}
  function injectBlockHeaders(beforeMin){
    while(blockPtr<schedBlocks.length&&parseHHMM(schedBlocks[blockPtr].start)<=beforeMin){
      const blk=schedBlocks[blockPtr];
      const dot=blk.blockType==='work'?'var(--accent-light)':blk.blockType==='personal'?'var(--purple,#a78bfa)':'var(--text-muted)';
      const hdr=document.createElement('div');hdr.className='tl-block-header';hdr.dataset.blockId=blk.id||'';
      hdr.innerHTML='<span class="block-hdr-dot" style="background:'+dot+'"></span>'+'<span class="block-hdr-name">'+blk.name+'</span>'+'<span class="block-hdr-time">'+fmtBlk12(blk.start)+' \u2013 '+fmtBlk12(blk.end)+'</span>'+'<button class="block-hdr-edit" onclick="event.stopPropagation();openBlockEditor(\''+(blk.id||'')+'\''+')" title="Edit time blocks">\u270E</button>';
      tl.appendChild(hdr);blockPtr++;
    }
  }

  const ckSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
  const gripSvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
  const bountySvg='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
  const petPrivacyChip=ev=>{
    if(!ev||isMeeting(ev)||ev.type==="break"||ev.type==="ooo")return "";
    const visibility=ev.publicVisibility==="private"?"private":"public";
    const label=visibility==="private"?"Private":"Public";
    return '<button class="pet-privacy-toggle '+visibility+'" type="button" data-pet-privacy-id="'+String(ev.id).replace(/"/g,'&quot;')+'" title="Toggle Pet Home sharing">'+label+'</button>';
  };
  const pointsChip=ev=>{
    const bountyCount=typeof getBountyCountForTask==="function"?getBountyCountForTask(ev.id):((typeof isBountyTask==="function"&&isBountyTask(ev.id))?1:0);
    const bounty=bountyCount>0;
    const payload=window.TaskPoints&&typeof window.TaskPoints.buildPayload==="function"
      ? window.TaskPoints.buildPayload(ev,{bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1})
      : {type:ev.type,duration_minutes:typeof dur==="function"?dur(ev):(ev.durMin||30),priority:ev.priority,bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1};
    const scoring=window.TaskPoints&&typeof window.TaskPoints.estimate==="function"
      ? window.TaskPoints.estimate(payload)
      : {eligible:!isMeeting(ev)&&ev.type!=="ooo"&&ev.type!=="break",awardPoints:bounty?28:14,durationMinutes:60,effortTier:"medium",attentionTier:"normal"};
    if(!scoring.eligible||scoring.awardPoints<=0)return "";
    const pts=scoring.awardPoints;
    const title="Completing this task earns about "+pts+" points. "+scoring.durationMinutes+"m, "+scoring.effortTier+" effort, "+scoring.attentionTier+" attention"+(bounty?", bounty x"+Math.pow(2,bountyCount):"")+".";
    return '<span class="points-chip'+(bounty||pts>=20?' bonus':'')+'" title="'+title.replace(/"/g,'&quot;')+'">'+pts+' pts</span>';
  };

  // Render done items as compact one-liners
  const completionsData = (__state && __state.completions && __state.completions.tasks) || [];
  const reviewedState = loadReviewed();
  doneItems.forEach(ev=>{
    const c=cfg(ev.type);const evSrcTag=srcTag(ev.source);
    const bountyDoneCount=typeof getBountyCountForTask==="function"?getBountyCountForTask(ev.id):((typeof isBountyTask==="function"&&isBountyTask(ev.id))?1:0);
    const bountyDoneMeta=typeof getBountyMetaForTask==="function"?getBountyMetaForTask(ev.id):{hasSponsor:false,sponsorName:""};
    // Check if this task was auto-completed and needs review
    const comp = completionsData.find(t => t.task_id === ev.id);
    const needsReview = comp && comp.needs_review && !reviewedState[ev.id];
    const reviewBadgeHtml = needsReview ?
      '<span class="review-badge" data-review-id="'+ev.id+'" data-review-type="task" data-evidence="'+(comp.evidence_summary||'Auto-detected by sweep').replace(/"/g,'&quot;')+'" data-evidence-link="'+(comp.evidence_link||'').replace(/"/g,'&quot;')+'" title="Auto-completed -- click to review">Needs Review</span>' : '';
    const el=document.createElement("div");el.className="tl-compact";el.dataset.id=ev.id;
    el.innerHTML=
      '<div class="tl-time">'+f12(ev.start).replace(/ (AM|PM)/,"")+'</div>'+
      '<div class="tl-node"></div>'+
      '<div class="compact-row">'+
        '<div class="c-check" title="Uncheck">'+ckSvg+'</div>'+
        '<div class="bar" style="background:'+(taskTagColor(ev)||c.color)+'"></div>'+
        '<span class="c-title">'+ev.title+'</span>'+
        (bountyDoneCount?'<span class="bounty-chip done'+(bountyDoneMeta.hasSponsor?' bounty-chip-sponsor':'')+'"'+(bountyDoneMeta.hasSponsor?' title="'+("Bounty from "+(bountyDoneMeta.sponsorName||"a visitor")).replace(/"/g,'&quot;')+'"':'')+'>Bounty x'+Math.pow(2,bountyDoneCount)+'</span>':'')+
        reviewBadgeHtml+
        evSrcTag+
        petPrivacyChip(ev)+
        '<span class="c-time">'+f12(ev.start)+' - '+f12(ev.end)+'</span>'+
        (window.todoShareCompactFeedbackHtml?window.todoShareCompactFeedbackHtml(ev):'')+
      '</div>';
    el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id)});
    const rb=el.querySelector(".review-badge");if(rb)rb.addEventListener("click",e=>{e.stopPropagation();openReviewPopover(rb)});
    tl.appendChild(el);
  });

  // Render triage items completed on the viewed date as compact rows
  triageDoneItems.forEach(ev=>{
    const dt=new Date(ev.completedAt);
    const hhmm=!isNaN(dt)?String(dt.getHours()).padStart(2,"0")+":"+String(dt.getMinutes()).padStart(2,"0"):"";
    const timeStr=hhmm?f12(hhmm):"Done";
    const el=document.createElement("div");el.className="tl-compact";el.dataset.triageDoneId=ev.triageId;
    el.innerHTML=
      '<div class="tl-time">'+timeStr.replace(/ (AM|PM)/,"")+'</div>'+
      '<div class="tl-node"></div>'+
      '<div class="compact-row">'+
        '<div class="c-check" title="Completed triage">'+ckSvg+'</div>'+
        '<div class="bar" style="background:var(--purple,#a78bfa)"></div>'+
        '<span class="c-title">'+ev.title+'</span>'+
        '<span class="tag tag-task" style="background:var(--purple-bg,rgba(168,85,247,0.1));color:var(--purple,#a78bfa)">Triage</span>'+
        '<span class="c-time">'+timeStr+'</span>'+
      '</div>';
    tl.appendChild(el);
  });

  // Render side projects completed on the viewed date as compact rows
  const doneTrivials=(typeof loadTrivialTasks==='function'?loadTrivialTasks():[])
    .filter(t=>t.done&&t.doneAt&&new Date(t.doneAt).toISOString().split("T")[0]===viewDate);
  doneTrivials.forEach(t=>{
    const dt=new Date(t.doneAt);
    const hhmm=String(dt.getHours()).padStart(2,"0")+":"+String(dt.getMinutes()).padStart(2,"0");
    const timeStr=f12(hhmm);
    const el=document.createElement("div");el.className="tl-compact";el.dataset.trivId=t.id;
    el.innerHTML=
      '<div class="tl-time">'+timeStr.replace(/ (AM|PM)/,"")+'</div>'+
      '<div class="tl-node"></div>'+
      '<div class="compact-row">'+
        '<div class="c-check" title="Uncheck">'+ckSvg+'</div>'+
        '<div class="bar" style="background:var(--cyan,#22d3ee)"></div>'+
        '<span class="c-title">'+t.text+'</span>'+
        '<span class="tag tag-task" style="background:rgba(34,211,238,0.15);color:var(--cyan,#22d3ee)">Side Project</span>'+
        '<span class="c-time">'+timeStr+'</span>'+
      '</div>';
    el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();toggleTrivialTask(t.id)});
    tl.appendChild(el);
  });

  // Divider between done and active
  if((doneItems.length||triageDoneItems.length||doneTrivials.length)&&activeItems.length){
    const d=document.createElement("div");d.className="divider";d.innerHTML='<span>Up Next</span>';tl.appendChild(d);
  }

  // Icon maps for edge items
  const eiIcons={task:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',doc:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',dash:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',action:'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>'};
  const eiBadge={ready:'<span class="ei-badge eib-ready">Ready</span>',todo:'<span class="ei-badge eib-todo">To-do</span>',ref:'<span class="ei-badge eib-ref">Ref</span>',new:'<span class="ei-badge eib-new">New</span>'};
  const chevSm='<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>';

  // The timeline pill is a focus marker, not a clock marker. Prefer the explicit
  // pinned task, then the loaded pomodoro task, then the first open itinerary item.
  const isToday = __state && __state.date === new Date().toISOString().split("T")[0];
  const _pinnedActiveId = (typeof getPinnedActiveId === "function") ? getPinnedActiveId() : null;
  const _pinnedActiveExists = !!(_pinnedActiveId && activeItems.some(ev => ev.id === _pinnedActiveId));
  const _pomoFocusId = (typeof pomoState !== "undefined" && pomoState && pomoState.currentTaskRef && pomoState.currentTaskRef.id)
    ? String(pomoState.currentTaskRef.id)
    : null;
  const _pomoFocusExists = !!(_pomoFocusId && activeItems.some(ev => String(ev.id) === _pomoFocusId));
  const _defaultFocusId = (activeItems.find(ev => !ev.subtaskOf && !isMeeting(ev) && ev.type !== "ooo" && ev.type !== "break") || activeItems[0] || {}).id;
  const _focusActiveId = _pinnedActiveExists ? String(_pinnedActiveId) : (_pomoFocusExists ? _pomoFocusId : (_defaultFocusId ? String(_defaultFocusId) : null));

  // Compact timeline row for a subtask (timeless step under its parent).
  function buildTimelineSub(node){
    const ev=node.ev,doneRow=isDone(ev);
    const prog=(typeof subtaskProgress==="function")?subtaskProgress(ev.id,scheduled):null;
    // This subtask's slice of its parent's point pie.
    const slice=(ev.subtaskOf&&window.PointPlan&&typeof window.PointPlan.shareFor==="function")?window.PointPlan.shareFor(ev.subtaskOf,ev.id):null;
    const el=document.createElement("div");
    el.className="tl-item tl-sub"+(doneRow?" done":"");
    if(node.depth)el.style.marginLeft=(node.depth*22)+"px";
    el.dataset.id=ev.id;
    const movable=!ev._locked&&!doneRow;
    if(movable){el.draggable=true;el.addEventListener("dragstart",e=>dStart(e,ev.id));el.addEventListener("dragend",dEnd);}
    el.addEventListener("dragover",e=>dOver(e,ev.id));el.addEventListener("dragleave",dLeave);el.addEventListener("drop",e=>dDrop(e,ev.id));
    el.innerHTML=
      (node.hasKids?'<button class="wrap-collapse'+(node.collapsed?' collapsed':'')+'" title="Collapse / expand">'+(node.collapsed?'▸':'▾')+'</button>':'<span class="wrap-collapse-spacer"></span>')+
      '<button class="chk sub-check'+(doneRow?' on':'')+'" title="'+(doneRow?'Uncheck':'Mark done')+'">'+ckSvg+'</button>'+
      '<span class="sub-ttl" title="'+escHtml(ev.title)+'">'+ev.title+'</span>'+
      (slice!=null?'<span class="sub-share'+(doneRow?' earned':'')+'" title="'+(doneRow?'Earned ':'Worth ')+slice+' pts of the parent’s pie">'+slice+' pts</span>':'')+
      (prog?'<span class="subtask-prog">'+prog.done+'/'+prog.total+'</span>':'')+
      subtaskActionsHtml(ev);
    el.querySelector(".sub-check").addEventListener("click",e=>{e.stopPropagation();toggleDone(ev.id);});
    bindSubtaskActions(el,ev);
    return el;
  }
  // Delegated collapse toggle: one listener handles every wrap/subtask chevron.
  if(!tl._collapseWired){tl._collapseWired=true;tl.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest(".wrap-collapse");if(!b)return;e.stopPropagation();const item=b.closest("[data-id]");if(item&&typeof toggleCollapsed==="function"){toggleCollapsed(item.dataset.id);render();}});}

  // Render active/upcoming items as full cards; subtasks as compact rows (recursion + collapse).
  flattenSchedule(activeItems).forEach(node=>{
    const ev=node.ev;
    if(node.rel==="subtask"){tl.appendChild(buildTimelineSub(node));return;}
    injectBlockHeaders(pt(ev.start));
    const isFocusActive = isToday && _focusActiveId && String(ev.id) === _focusActiveId;
    const isPinnedActive = isToday && _pinnedActiveExists && String(_pinnedActiveId) === String(ev.id);
    const pinnedStyle = isPinnedActive && typeof getPinnedOverdueStyle === "function" ? getPinnedOverdueStyle(ev) : null;
    const active=!!isFocusActive;
    const el=renderItineraryCard(ev,{
      node:node,active:active,isPinnedActive:isPinnedActive,pinnedStyle:pinnedStyle,isToday:isToday,
      canEditBounty:(typeof viewMode==="undefined"||viewMode!=="archive"),
      bw:(typeof wrapBandwidth==="function")?wrapBandwidth(ev,scheduled):null
    });
    // Placeholder task (from a preset group): distinct look + click opens the swap menu.
    if(ev.isPlaceholder){
      el.classList.add("placeholder-task");
      el.addEventListener("click",e=>{
        if(e.target.closest("button,input,.chk,.chk-quick,.dbtn,.dbadge,.start-time,.btn-add-menu,.card-tags-toggle"))return;
        e.stopPropagation();
        if(typeof window.openPlaceholderSwap==="function")window.openPlaceholderSwap(ev);
      });
    }
    // Meetings and locked tasks are fixed anchors -- no drag, but still valid drop targets so other tasks can be positioned around them.
    if(!isMeeting(ev)&&!ev._locked){el.draggable=true;el.addEventListener("dragstart",e=>dStart(e,ev.id));el.addEventListener("dragend",dEnd);}
    el.addEventListener("dragover",e=>dOver(e,ev.id));el.addEventListener("dragleave",dLeave);el.addEventListener("drop",e=>dDrop(e,ev.id));

    // Event listeners
    el.querySelector(".chk").addEventListener("click",e=>{
      e.stopPropagation();
      // Blocked rollup container: skip the notes modal, let toggleDone toast why.
      if(typeof shellCompleteBlocked==="function"&&shellCompleteBlocked(ev))toggleDone(ev.id);
      else openDoneModal(ev.id,ev.title,()=>toggleDone(ev.id),ev);
    });
    const _q=el.querySelector(".chk-quick"); // absent on rollup containers
    if(_q)_q.addEventListener("click",e=>{e.stopPropagation();e.currentTarget.classList.add("flash");toggleDone(ev.id);});
    const tagToggle=el.querySelector(".card-tags-toggle");
    if(tagToggle)tagToggle.addEventListener("click",e=>{e.stopPropagation();toggleTagsExpanded(ev.id);if(typeof render==='function')render();});
    el.querySelectorAll(".dbtn").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();adjustDur(b.dataset.id,parseInt(b.dataset.d))}));
    const stSpan=el.querySelector(".start-time");if(stSpan&&!isMeeting(ev)){stSpan.addEventListener("click",e=>{e.stopPropagation();openStartTimePicker(ev.id,stSpan);});}
    // Duration presets: only the meeting card keeps the interactive badge —
    // task cards show a read-only badge and adjust duration via the radial.
    const dbadge=el.querySelector(".dbadge");
    if(dbadge&&isMeeting(ev))dbadge.addEventListener("click",e=>{e.stopPropagation();openDurPopover(ev,dbadge);});
    const pomo=el.querySelector(".pomo-btn");
    if(pomo)pomo.addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur),{id:b.dataset.pomoId,source:b.dataset.pomoSource,title:b.dataset.pomoTitle})});
    const nb=el.querySelector(".notes-btn");if(nb)nb.addEventListener("click",e=>{e.stopPropagation();if(typeof openAddModal==='function')openAddModal(nb.dataset.notesId,nb.dataset.notesTitle);else openNotesDrawer(nb.dataset.notesId,nb.dataset.notesTitle);});
    const pb=el.querySelector(".btn-task-radial");if(pb)pb.addEventListener("click",e=>{e.stopPropagation();openTaskRadial(ev,pb)});
    const bb=el.querySelector(".btn-bounty");if(bb)bb.addEventListener("click",e=>{e.stopPropagation();if(typeof placeBounty==="function")placeBounty(bb.dataset.bountyId)});
    // PIN 1: click the timeline dot to pin this task as "active"
    const tnode=el.querySelector(".tl-node");
    if(tnode&&!isMeeting(ev)){
      tnode.style.cursor="pointer";
      tnode.title="Click to pin as your active task";
      tnode.addEventListener("click",e=>{e.stopPropagation();if(typeof togglePinnedActiveId==="function")togglePinnedActiveId(ev.id);});
    }
    // Drag the live now-pill onto any task to make that task your pinned-active
    // one. The pill is the .tl-node.active that carries the time text; dragging
    // it sets _dragNowPill so dDrop pins instead of reordering (see drag.js).
    const nowPill=el.querySelector(".tl-node.active");
    if(nowPill&&nowPill.querySelector(".tl-now-time")&&isToday){
      nowPill.draggable=true;
      nowPill.style.cursor="grab";
      nowPill.title="Drag onto the task you're working on, or click to pin/unpin";
      nowPill.addEventListener("dragstart",e=>{
        e.stopPropagation();
        window._dragNowPill=true;
        e.dataTransfer.effectAllowed="move";
        try{e.dataTransfer.setData("text/plain","__nowpill__");}catch(_){}
      });
      nowPill.addEventListener("dragend",e=>{
        window._dragNowPill=false;
        document.querySelectorAll(".pin-drop-target").forEach(x=>x.classList.remove("pin-drop-target"));
      });
    }
    const db=el.querySelector(".btn-del-task");if(db)db.addEventListener("click",e=>{e.stopPropagation();openDeleteConfirm(db.dataset.delId)});
    // Subtask and trivial task management moved to Add Items modal (openAddModal)
    el.querySelector(".card").addEventListener("click",e=>{if(e.target.closest(".chk")||e.target.closest(".chk-quick")||e.target.closest(".dbtn")||e.target.closest(".dbadge")||e.target.closest(".dur-popover")||e.target.closest(".grip")||e.target.closest(".pomo-btn")||e.target.closest(".notes-btn")||e.target.closest(".btn-meeting-auto")||e.target.closest(".btn-repeat-resp")||e.target.closest(".btn-move-menu")||e.target.closest(".move-menu-popup")||e.target.closest(".btn-del-task")||e.target.closest(".btn-lock")||e.target.closest(".btn-bounty")||e.target.closest(".btn-add-menu")||e.target.closest(".add-menu-popup")||e.target.closest(".itinerary-reactions")||e.target.closest(".card-triv-section")||e.target.closest(".start-time")||e.target.closest(".ttl"))return;if(typeof openAddModal==="function")openAddModal(ev.id,ev.title);});

    // Inline title edit — click title to rename, blur/Enter to save
    if(!isMeeting(ev)){
      const ttlSpan=el.querySelector(".ttl");
      if(ttlSpan){
        ttlSpan.style.cursor="text";
        ttlSpan.setAttribute("title","Click to rename");
        ttlSpan.addEventListener("click",e=>{
          e.stopPropagation();
          const inp=document.createElement("input");
          inp.type="text";
          inp.className="ttl-edit";
          inp.value=ev.title;
          inp.style.cssText="background:transparent;border:none;border-bottom:1px solid var(--accent);color:inherit;font:inherit;font-size:inherit;outline:none;padding:0 2px;min-width:60px;max-width:260px;width:"+(Math.max(60,ttlSpan.offsetWidth+20))+"px";
          ttlSpan.replaceWith(inp);
          inp.focus();inp.select();
          let saved=false;
          function save(){
            if(saved)return;saved=true;
            const newTitle=inp.value.trim();
            if(newTitle&&newTitle!==ev.title){
              const task=scheduled.find(s=>s.id===ev.id);
              if(task){
                task.title=newTitle;
                if(typeof _persistTaskTitle==="function")_persistTaskTitle(ev.id,newTitle);
                if(typeof isBountyTask==="function"&&isBountyTask(ev.id)&&typeof saveBountyState==="function")saveBountyState();
                if(typeof showToast==="function")showToast("Title updated","success");
              }
            }
            render();
          }
          inp.addEventListener("keydown",e2=>{
            if(e2.key==="Enter"){e2.preventDefault();save();}
            if(e2.key==="Escape"){saved=true;render();}
          });
          inp.addEventListener("blur",save);
        });
      }
    }

    // Edge tab toggle listeners
    el.querySelectorAll(".edge-tab").forEach(tab=>{
      tab.addEventListener("click",e=>{
        e.stopPropagation();
        const edgeType=tab.dataset.edge;
        const panel=el.querySelector('.edge-panel[data-panel="'+edgeType+'"]');
        if(!panel)return;
        tab.classList.toggle("open");panel.classList.toggle("open");
      });
    });

    // Schedule buttons on followup items
    el.querySelectorAll(".ei-sched").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        const fuId=btn.dataset.fuid;
        const fu=ev.followups.find(f=>f.id===fuId);
        if(!fu)return;
        addFollowupToSchedule(fu,ev.id);
      });
    });

    // Floating prep tooltip on hover
    const tlTime=el.querySelector(".tl-time.has-prep");
    if(tlTime){
      const phIcons={task:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',doc:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',dash:'<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>'};
      let floatHtml='<div class="prep-hover-label">Prep work</div>';
      ev.prep.forEach(p=>{
        const pCls=p.type==="task"?"phi-task":p.type==="dash"?"phi-dash":"phi-doc";
        const isLocal=p.href&&!p.href.startsWith("http");
        if(isLocal){
          floatHtml+='<div class="prep-hover-item" style="cursor:pointer" onclick="openPrepViewer(\''+p.href.replace(/'/g,"\\'")+'\',\''+p.title.replace(/'/g,"\\'")+'\')"><div class="phi '+pCls+'">'+(phIcons[p.type]||phIcons.doc)+'</div><span>'+p.title+'</span></div>';
        } else {
          floatHtml+='<div class="prep-hover-item"><div class="phi '+pCls+'">'+(phIcons[p.type]||phIcons.doc)+'</div><a href="'+p.href+'" target="_blank">'+p.title+'</a></div>';
        }
      });
      tlTime.addEventListener("mouseenter",()=>{
        const fl=document.getElementById("prep-float");
        fl.innerHTML=floatHtml;
        fl.style.display="block";
        fl.style.pointerEvents="auto";
        const r=tlTime.getBoundingClientRect();
        fl.style.left=r.left+"px";
        fl.style.top=(r.bottom+6)+"px";
      });
      tlTime.addEventListener("mouseleave",()=>{
        const fl=document.getElementById("prep-float");
        fl.style.display="none";
      });
    }

    tl.appendChild(el);
  });

  // Flush any remaining block headers after last active item
  injectBlockHeaders(24*60);

  // Render pushed-to-tomorrow items at the bottom
  if(pushedItems.length){
    const pd=document.createElement("div");pd.className="pushed-divider";pd.innerHTML='<span>Pushed to Tomorrow</span>';tl.appendChild(pd);
    const pushArrowSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    pushedItems.forEach(ev=>{
      const c=cfg(ev.type);const evSrcTag=srcTag(ev.source);
      const el=document.createElement("div");el.className="tl-compact pushed";el.dataset.id=ev.id;
      el.innerHTML=
        '<div class="tl-time">'+f12(ev.start).replace(/ (AM|PM)/,"")+'</div>'+
        '<div class="tl-node"></div>'+
        '<div class="compact-row">'+
          '<div class="c-check" title="Restore to schedule">'+pushArrowSvg+'</div>'+
          '<div class="bar" style="background:'+c.color+'"></div>'+
          '<span class="c-title">'+ev.title+'</span>'+
          evSrcTag+
          '<span class="c-time">'+f12(ev.start)+' - '+f12(ev.end)+'</span>'+
        '</div>';
      el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();unpushTask(ev.id)});
      tl.appendChild(el);
    });
  }

  // Rescheduled-away items at the bottom, in amber (reuse the pushed styling).
  if(rescheduledAwayItems.length){
    const rd=document.createElement("div");rd.className="pushed-divider";rd.innerHTML='<span>Rescheduled away</span>';tl.appendChild(rd);
    const restoreArrowSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
    rescheduledAwayItems.forEach(b=>{
      const p=b.properties||{};
      const dest=p.rescheduledTo?_prettyDateLabel(p.rescheduledTo):"another day";
      const el=document.createElement("div");el.className="tl-compact pushed";el.dataset.id=b.id;
      el.innerHTML=
        '<div class="tl-time"></div>'+
        '<div class="tl-node"></div>'+
        '<div class="compact-row">'+
          '<div class="c-check" title="Restore to this day">'+restoreArrowSvg+'</div>'+
          '<div class="bar" style="background:var(--amber,#f59e0b)"></div>'+
          '<span class="c-title">'+(p.title||"Task")+'</span>'+
          '<span class="c-time">→ '+dest+'</span>'+
        '</div>';
      el.querySelector(".c-check").addEventListener("click",e=>{e.stopPropagation();if(typeof restoreRescheduledAway==="function")restoreRescheduledAway(b.id)});
      tl.appendChild(el);
    });
  }
  if(schedView==="list")buildListView();
  if(typeof refreshMeetingAutomationPanels==="function")refreshMeetingAutomationPanels();
}

// ======== MOVE-TO POPOVER ========
function openMoveMenu(id, anchorEl){
  document.querySelectorAll(".move-menu-popup").forEach(p=>p.remove());
  // Day moves route through the shared placement picker (moveTaskViaPlacement)
  // so the drop time is chosen the same way everywhere.
  const _mv=(dateStr,fallback)=>typeof moveTaskViaPlacement==="function"?moveTaskViaPlacement(id,dateStr):fallback(id);
  const items=[
    {label:"Tomorrow",  action:()=>_mv(_resolvedTomorrowDate(),moveTaskToTomorrow)},
    {label:"Today",     action:()=>_mv(_resolvedTodayDate(),moveTaskToToday)},
    {label:"Next week", action:()=>_mv(_nextSundayDate(),moveTaskToNextWeek)},
    {label:"Trivial",   action:()=>moveTaskToTrivial(id)},
    {label:"Backlog and Ideas",   action:()=>moveTaskToBacklog(id)},
    {label:"Priority",  action:()=>moveTaskToPriority(id)}
  ];
  const pop=document.createElement("div");
  pop.className="move-menu-popup";
  items.forEach(it=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="move-menu-item";
    b.textContent=it.label;
    b.addEventListener("click",e=>{e.stopPropagation();closePop();it.action();});
    pop.appendChild(b);
  });
  function closePop(){
    pop.remove();
    document.removeEventListener("click",onOutside,true);
    document.removeEventListener("keydown",onEsc,true);
  }
  function onOutside(e){if(!pop.contains(e.target)&&e.target!==anchorEl)closePop();}
  function onEsc(e){if(e.key==="Escape")closePop();}
  const rect=anchorEl.getBoundingClientRect();
  pop.style.top=(rect.bottom+6)+"px";
  pop.style.right=(window.innerWidth-rect.right)+"px";
  document.body.appendChild(pop);
  setTimeout(()=>{
    document.addEventListener("click",onOutside,true);
    document.addEventListener("keydown",onEsc,true);
  },0);
}

// ======== CONSIDER FOR TODAY TAB ========
function buildConsider(){
  const board=document.getElementById("consider-board");board.innerHTML="";
  // Surface backlog items flagged Priority alongside Notion-driven consider items.
  const fromBacklog=backlog.filter(t=>t.stage==="Priority").map(t=>Object.assign({_pomoSource:"backlog"},t));
  const merged=consider.concat(fromBacklog);
  const ccBadge=document.getElementById("consider-count");if(ccBadge)ccBadge.textContent=merged.length;
  if(!merged.length){board.innerHTML='<div class="board-empty">Nothing flagged for today. Nice work, or add tasks via Notion.</div>';return}
  const priOrder={High:0,Medium:1,Low:2,undefined:3};
  const sorted=[...merged].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
  sorted.forEach(t=>{
    const c=cfg(t.type);
    const stageClass=t.stage==="Backlog"?"stage-backlog":t.stage==="Next Sprint"?"stage-next":t.stage==="Tasks for Today"?"stage-today":"stage-scheduled";
    const tSrcTag=srcTag(t.source);
    const dParts=[];
    if(t.detail)dParts.push('<div class="detail-summary">'+t.detail+'</div>');
    const dLinks=[];
    if(t.notionUrl)dLinks.push('<a href="'+t.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
    if(dLinks.length)dParts.push('<div class="detail-links">'+dLinks.join('')+'</div>');
    const dMeta=[];
    if(t.priority)dMeta.push('<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">Priority: '+t.priority+'</span>');
    if(t.stage)dMeta.push('<span>Stage: '+t.stage+'</span>');
    dMeta.push('<span>Est: '+ms(t.durMin)+'</span>');
    if(dMeta.length)dParts.push('<div class="detail-meta">'+dMeta.join('')+'</div>');
    const hasD=dParts.length>0;
    const chev='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.2s;flex-shrink:0;opacity:0.4"><path d="M6 9l6 6 6-6"/></svg>';

    const el=document.createElement("div");el.className="board-card";el.style.cssText="flex-wrap:wrap;cursor:pointer";
    el.innerHTML=
      '<div class="bar" style="background:'+c.color+'"></div>'+
      '<div class="body">'+
        '<div class="title-row"><span class="ttl">'+t.title+'</span>'+tSrcTag+'</div>'+
        '<div class="meta">'+
          '<span class="tag '+c.cls+'">'+c.tag+'</span>'+
          (t.stage?'<span class="stage-badge '+stageClass+'">'+t.stage+'</span>':'')+
          '<span>'+ms(t.durMin)+'</span>'+
          (t.priority?'<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>':'')+
        '</div>'+
      '</div>'+
      (hasD?chev:'')+
      notesButton({id: t.id, title: t.title})+
      '<button class="pomo-btn" data-pomo-id="'+t.id+'" data-pomo-source="'+(t._pomoSource||"consider")+'" data-pomo-title="'+t.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+t.durMin+'" title="Start pomodoro timer">'+pomoSvg+'</button>'+
      '<button class="add-btn" data-id="'+t.id+'"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Schedule</button>'+
      '<button class="add-btn repeat-resp-btn" data-id="'+t.id+'" title="Turn into a repeat responsibility">Repeat</button>'+
      (hasD?'<div class="detail-panel" style="width:100%;padding-left:14px"><div class="detail-inner">'+dParts.join('')+'</div></div>':'');
    const cnb=el.querySelector(".notes-btn");if(cnb)cnb.addEventListener("click",e=>{e.stopPropagation();openNotesDrawer(cnb.dataset.notesId,cnb.dataset.notesTitle)});
    el.querySelector(".pomo-btn").addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur),{id:b.dataset.pomoId,source:b.dataset.pomoSource,title:b.dataset.pomoTitle})});
    el.querySelector(".add-btn").addEventListener("click",e=>{e.stopPropagation();addToSchedule(t.id)});
    const repeatBtn=el.querySelector(".repeat-resp-btn");
    if(repeatBtn)repeatBtn.addEventListener("click",e=>{e.stopPropagation();if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask(t)});
    el.addEventListener("click",e=>{if(e.target.closest(".add-btn")||e.target.closest(".pomo-btn")||e.target.closest(".notes-btn"))return;const panel=el.querySelector(".detail-panel");if(panel){panel.classList.toggle("open");const cv=el.querySelector(":scope > svg");if(cv)cv.style.transform=panel.classList.contains("open")?"rotate(180deg)":""}});
    board.appendChild(el);
  });
}

// ======== BACKLOG TAB ========
function buildBacklog(){
  const board=document.getElementById("backlog-board");board.innerHTML="";
  // Priority-stage items are surfaced in the Priority drawer via buildConsider, not here.
  const items=backlog.filter(t=>t.stage!=="Priority");
  document.getElementById("backlog-count").textContent=items.length;
  if(!items.length){board.innerHTML='<div class="board-empty">Nothing in Backlog and Ideas yet. Add tasks above or check your Notion board.</div>';return}
  // Sort: High > Medium > Low
  const priOrder={High:0,Medium:1,Low:2,undefined:3};
  const sorted=[...items].sort((a,b)=>(priOrder[a.priority]||3)-(priOrder[b.priority]||3));
  sorted.forEach(t=>{
    const c=cfg(t.type);
    const stageClass=t.stage==="Backlog"?"stage-backlog":t.stage==="Next Sprint"?"stage-next":t.stage==="Tasks for Today"?"stage-today":"stage-scheduled";
    const tSrcTag=srcTag(t.source);

    // Expandable detail content (description + links + meta line) + delegate state for the chip below.
    const detailParts=[];
    if(t.detail)detailParts.push('<div class="detail-summary">'+t.detail+'</div>');
    const links=[];
    if(t.notionUrl)links.push('<a href="'+t.notionUrl+'" target="_blank" onclick="event.stopPropagation()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>Open in Notion</a>');
    if(links.length)detailParts.push('<div class="detail-links">'+links.join('')+'</div>');
    const metaParts=[];
    metaParts.push('<span class="tag '+c.cls+'">'+c.tag+'</span>');
    if(t.priority)metaParts.push('<span class="pri-'+(t.priority==="High"?"hi":t.priority==="Medium"?"med":"lo")+'">'+t.priority+'</span>');
    if(t.stage)metaParts.push('<span class="stage-badge '+stageClass+'">'+t.stage+'</span>');
    if(tSrcTag)metaParts.push(tSrcTag);
    detailParts.push('<div class="detail-meta">'+metaParts.join('')+'</div>');

    const isDelegated=_scheduleTaskHasDelegate(t.id);

    const el=document.createElement("div");el.className="board-card bc-card";el.draggable=true;
    el.addEventListener("dragstart",e=>{
      dragId=t.id;
      window._dragFromBacklog=true;
      try{e.dataTransfer.setData("text/plain",t.id);e.dataTransfer.effectAllowed="move"}catch(_){}
      el.classList.add("dragging");
    });
    el.addEventListener("dragend",()=>{
      window._dragFromBacklog=false;
      el.classList.remove("dragging");
    });

    el.innerHTML=
      '<div class="bc-row">'+
        '<div class="bar" style="background:'+c.color+'"></div>'+
        '<div class="bc-title" title="'+t.title.replace(/"/g,'&quot;')+'">'+t.title+'</div>'+
        '<span class="bc-dur">'+ms(t.durMin)+'</span>'+
        '<svg class="bc-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'+
      '</div>'+
      '<div class="bc-expand">'+
        '<div class="detail-inner">'+detailParts.join('')+'</div>'+
        '<div class="bc-actions">'+
          '<button class="add-btn bc-act bc-act-today" data-id="'+t.id+'" title="Add to today\u2019s schedule"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg> Today</button>'+
          '<button class="bc-act bc-act-side" data-id="'+t.id+'" title="Move to side projects">Side Project</button>'+
          '<button class="bc-act bc-act-later" data-id="'+t.id+'" title="Schedule for a later date">Later\u2026</button>'+
          '<button class="bc-act bc-act-repeat" data-id="'+t.id+'" title="Turn into a repeat responsibility">Repeat</button>'+
          notesButton({id: t.id, title: t.title})+
          '<button class="pomo-btn bc-act-icon" data-pomo-id="'+t.id+'" data-pomo-source="backlog" data-pomo-title="'+t.title.replace(/"/g,'&quot;')+'" data-pomo-dur="'+t.durMin+'" title="Start pomodoro timer">'+pomoSvg+'</button>'+
          '<button class="delegate-btn bc-act-icon" data-id="'+t.id+'" data-title="'+t.title.replace(/"/g,'&quot;')+'" title="'+(isDelegated?'Edit delegated item linked to this task':'Delegate this task')+'">'+(isDelegated?'\u2713':'\u2191')+'</button>'+
          '<button class="task-bank-icon-btn bank-edit-btn" data-id="'+t.id+'" title="Edit task"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>'+
          '<button class="task-bank-icon-btn danger bank-delete-btn" data-id="'+t.id+'" title="Delete task"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>'+
        '</div>'+
        (typeof renderTaskBankBacklogEditForm==="function"?renderTaskBankBacklogEditForm(t):"")+
      '</div>';

    if(el.querySelector("[data-bank-edit-id]"))el.classList.add("expanded");
    const bnb=el.querySelector(".notes-btn");if(bnb)bnb.addEventListener("click",e=>{e.stopPropagation();openNotesDrawer(bnb.dataset.notesId,bnb.dataset.notesTitle)});
    el.querySelector(".pomo-btn").addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;openPomodoro(b.dataset.pomoTitle,parseInt(b.dataset.pomoDur),{id:b.dataset.pomoId,source:b.dataset.pomoSource,title:b.dataset.pomoTitle})});
    el.querySelector(".delegate-btn").addEventListener("click",e=>{
      e.stopPropagation();
      const btn=e.currentTarget;
      const taskId=btn.dataset.id;
      const taskTitle=btn.dataset.title;
      const existing=window.blockStore
        ? window.blockStore.getByType("block").find(b=>(b.properties||{}).kind==="delegated_item"&&(b.properties||{}).linkedBlockId===taskId)
        : null;
      if(existing && typeof openDelegatedModal==="function"){
        openDelegatedModal(existing.id);
      } else if(typeof openDelegatedModal==="function"){
        openDelegatedModal(null,{title:"Follow up: "+taskTitle,linkedBlockId:taskId});
      }
    });
    el.querySelector(".bc-act-today").addEventListener("click",e=>{e.stopPropagation();addToSchedule(t.id)});
    el.querySelector(".bc-act-side").addEventListener("click",e=>{
      e.stopPropagation();
      if(typeof addSideProjectTask==="function")addSideProjectTask(t.title,t.durMin||30);
      if(typeof deleteTaskBankBacklogTask==="function")deleteTaskBankBacklogTask(t.id);
      if(typeof showToast==="function")showToast("Moved to Side Projects","success");
    });
    el.querySelector(".bc-act-later").addEventListener("click",e=>{
      e.stopPropagation();
      if(typeof openSchedulePicker==="function") openSchedulePicker(t.title, t.durMin);
    });
    const repeatBtn=el.querySelector(".bc-act-repeat");
    if(repeatBtn)repeatBtn.addEventListener("click",e=>{
      e.stopPropagation();
      if(typeof openRepeatResponsibilityFromTask==="function")openRepeatResponsibilityFromTask(t);
    });
    const editBtn=el.querySelector(".bank-edit-btn");
    if(editBtn)editBtn.addEventListener("click",e=>{e.stopPropagation();if(typeof startTaskBankBacklogEdit==="function")startTaskBankBacklogEdit(t.id)});
    const deleteBtn=el.querySelector(".bank-delete-btn");
    if(deleteBtn)deleteBtn.addEventListener("click",e=>{
      e.stopPropagation();
      if(confirm("Delete this task from this account's bank?")&&typeof deleteTaskBankBacklogTask==="function")deleteTaskBankBacklogTask(t.id);
    });
    if(typeof bindTaskBankBacklogEditForm==="function")bindTaskBankBacklogEditForm(el,t);
    // Click anywhere on the title row toggles the expanded panel.
    el.querySelector(".bc-row").addEventListener("click",e=>{
      if(e.target.closest("button")||e.target.closest("a"))return;
      el.classList.toggle("expanded");
    });
    board.appendChild(el);
  });
}

// PIN 10.A: returns true if any delegated_item is linked to this backlog task id.
function _scheduleTaskHasDelegate(taskId){
  if(!window.blockStore) return false;
  return window.blockStore.getByType("block")
    .some(b=>(b.properties||{}).kind==="delegated_item" && (b.properties||{}).linkedBlockId===taskId);
}

// ======== PROGRESS ========
function buildProgress(){
  const track=document.getElementById("ptrack"),ds=pt("08:45"),de=pt("17:30"),tot=de-ds;
  track.innerHTML="";let cursor=ds;
  const dayItems=scheduled.filter(ev=>!ev._dateless); // Unscheduled-everywhere rows aren't today's plan
  dayItems.forEach(ev=>{
    const s=pt(ev.start),e=pt(ev.end);
    if(s>cursor)addPS(track,cursor,s,"Free","rgba(255,255,255,0.08)",false,tot);
    addPS(track,s,e,ev.title,cfg(ev.type).color,isDone(ev),tot);cursor=e;
  });
  if(cursor<de)addPS(track,cursor,de,"Free","rgba(255,255,255,0.08)",false,tot);
  const dc=dayItems.filter(isDone).length;
  document.getElementById("ppct").textContent=dc+"/"+dayItems.length+" done ("+Math.round(dc/(dayItems.length||1)*100)+"%)";
}
function addPS(track,s,e,title,color,done,tot){
  const w=((e-s)/tot)*100,seg=document.createElement("div");seg.className="pseg";
  seg.style.cssText="width:"+w+"%;background:"+color+";opacity:"+(done?0.4:1);
  seg.innerHTML='<div class="tip">'+title+' ('+ms(e-s)+')'+(done?' \u2713':'')+'</div>';track.appendChild(seg);
}

// ======== STATS ========
function _actualMin(ev){
  // Get actual time worked: timer > saved sessions > planned duration
  if(typeof pomoState!=="undefined" && pomoState.taskTime && pomoState.taskTime[ev.title]>0)
    return Math.round(pomoState.taskTime[ev.title]/60);
  try{const s=loadSessions();if(s[ev.id]&&s[ev.id].length)return s[ev.id].reduce((a,x)=>a+x.durationMin,0);}catch(e){}
  return dur(ev);
}
const REMAINING_STAT_SCOPE_KEY="pa-remaining-stat-scope";
// Time-block containers removed 2026-07 -> remaining stats are always day-scoped.
// (Kept the fn so its many call sites are untouched; toggle is now a no-op.)
function _remainingStatScope(){ return "day"; }
function _setRemainingStatScope(scope){
  try{localStorage.setItem(REMAINING_STAT_SCOPE_KEY,scope==="block"?"block":"day");}catch(e){}
}
function _currentBlockWindow(){
  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  if(!blocks.length)return null;
  const now=new Date();
  const nowMin=now.getHours()*60+now.getMinutes();
  for(const b of blocks){
    const bStart=pt(b.start),bEnd=pt(b.end);
    if(nowMin>=bStart&&nowMin<bEnd)return {block:b,start:bStart,end:bEnd};
  }
  return null;
}
function _remainingForScope(scope){
  // _dateless rows (Unscheduled-everywhere) aren't part of this day's plan.
  const rem=scheduled.filter(ev=>!isDone(ev)&&!ev._dateless);
  if(scope!=="block")return rem;
  const win=_currentBlockWindow();
  if(!win)return [];
  return rem.filter(ev=>pt(ev.start)<win.end&&pt(ev.end)>win.start);
}
function _remainingEmptyMessage(scope){
  return scope==="block"&&!_currentBlockWindow()?"No active block.":"Nothing left!";
}
function _remainingScopeLabel(scope){
  return scope==="block"?"Block":"Day";
}
function _updateRemainingStatLabels(scope){
  const scopeLabel=_remainingScopeLabel(scope);
  const timeLabel=document.getElementById("s-time-label");
  const tasksLabel=document.getElementById("s-tasks-label");
  const hint="Click to show "+(scope==="block"?"day":"block")+" remaining";
  if(timeLabel)timeLabel.textContent=scopeLabel+" Time Left";
  if(tasksLabel)tasksLabel.textContent=scopeLabel+" Tasks Left";
  document.querySelectorAll(".stat-combined .stat-half").forEach(el=>{el.title=hint;});
}
const DAY_POINT_GOALS_KEY="pa-day-point-goals-v1";
function _statEsc(value){
  return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
}
function _currentViewDateKey(){
  return (__state&&__state.date)||new Date().toISOString().split("T")[0];
}
function _roundGoal(value){
  return Math.max(0, Math.round((Number(value)||0)/5)*5);
}
function _defaultDayPointGoals(){
  const blocks=(__state&&__state.schedule&&__state.schedule.blocks)||[];
  const workMinutes=blocks
    .filter(b=>(b.blockType||b.type||"work")==="work")
    .reduce((sum,b)=>sum+Math.max(0,pt(b.end||"00:00")-pt(b.start||"00:00")),0);
  const fallbackMin=300, fallbackMax=480;
  const min=workMinutes>0?_roundGoal(workMinutes*0.65):fallbackMin;
  const max=workMinutes>0?_roundGoal(workMinutes):fallbackMax;
  return {min:Math.max(60,min),max:Math.max(Math.max(60,min),max)};
}
function _storedDayPointGoals(){
  try{
    const parsed=JSON.parse(localStorage.getItem(DAY_POINT_GOALS_KEY)||"{}");
    return parsed&&typeof parsed==="object"?parsed:{};
  }catch(e){return{};}
}
function getDayPointGoals(){
  const dateKey=_currentViewDateKey();
  const all=_storedDayPointGoals();
  const defaults=_defaultDayPointGoals();
  const saved=all[dateKey]||{};
  const min=_roundGoal(saved.min!=null?saved.min:defaults.min);
  const max=_roundGoal(saved.max!=null?saved.max:defaults.max);
  return {min, max:Math.max(min,max)};
}
function setDayPointGoal(field,value){
  const dateKey=_currentViewDateKey();
  const all=_storedDayPointGoals();
  const current=getDayPointGoals();
  current[field]=_roundGoal(value);
  if(field==="min"&&current.max<current.min) current.max=current.min;
  if(field==="max"&&current.max<current.min) current.min=current.max;
  all[dateKey]=current;
  try{localStorage.setItem(DAY_POINT_GOALS_KEY,JSON.stringify(all));}catch(e){}
  updateStats();
  const popover=document.getElementById("stat-popover");
  if(popover&&popover.dataset.openFor==="s-points"){
    const card=document.querySelector(".stat-points");
    popover.dataset.openFor="";
    if(card) showStatPopover("s-points",{stopPropagation:function(){},currentTarget:card});
  }
}
function _estimatedTaskPoints(ev){
  if(!ev)return 0;
  const bountyCount=typeof getBountyCountForTask==="function"?getBountyCountForTask(ev.id):((typeof isBountyTask==="function"&&isBountyTask(ev.id))?1:0);
  const bounty=bountyCount>0;
  const payload=window.TaskPoints&&typeof window.TaskPoints.buildPayload==="function"
    ? window.TaskPoints.buildPayload(ev,{bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1})
    : {type:ev.type,duration_minutes:typeof dur==="function"?dur(ev):(ev.durMin||30),priority:ev.priority,bounty,bounty_count:bountyCount,partner_bounty:bountyCount>1};
  const scoring=window.TaskPoints&&typeof window.TaskPoints.estimate==="function"
    ? window.TaskPoints.estimate(payload)
    : {eligible:(typeof isMeeting!=="function"||!isMeeting(ev))&&ev.type!=="ooo"&&ev.type!=="break",awardPoints:Math.max(1,Math.round(typeof dur==="function"?dur(ev):(ev.durMin||30)))};
  return scoring&&scoring.eligible?Math.max(0,Number(scoring.awardPoints)||0):0;
}
function _pointEligibleScheduleItems(){
  const trivFlags=typeof loadTrivialFlags==="function"?loadTrivialFlags():{};
  return scheduled.filter(ev=>{
    if(!ev||trivFlags[ev.id])return false;
    if(ev._dateless)return false; // day-agnostic Unscheduled rows earn nothing here
    if(typeof isDeleted==="function"&&isDeleted(ev))return false;
    if(typeof isPushed==="function"&&isPushed(ev))return false;
    return true;
  });
}
function _dayPointSummary(){
  const items=_pointEligibleScheduleItems();
  const done=items.filter(isDone);
  const remaining=items.filter(ev=>!isDone(ev));
  const earned=done.reduce((sum,ev)=>sum+_estimatedTaskPoints(ev),0);
  const remainingPoints=remaining.reduce((sum,ev)=>sum+_estimatedTaskPoints(ev),0);
  const scheduledPoints=earned+remainingPoints;
  const goals=getDayPointGoals();
  return {
    items,done,remaining,earned,remainingPoints,scheduledPoints,
    minGoal:goals.min,
    maxGoal:goals.max,
    neededToMin:Math.max(0,goals.min-scheduledPoints),
    availableToMax:Math.max(0,goals.max-scheduledPoints)
  };
}
function toggleRemainingStatScope(event){
  // No-op since time-block containers were removed (stats are day-scoped).
  if(event)event.stopPropagation();
}
function updateStats(){
  const done=scheduled.filter(isDone), scope=_remainingStatScope(), rem=_remainingForScope(scope);
  const remMin=rem.reduce((a,ev)=>a+dur(ev),0);
  const doneMin=done.reduce((a,ev)=>a+_actualMin(ev),0);
  document.getElementById("s-time").textContent=remMin>0?ms(remMin):"0m";
  document.getElementById("s-tasks").textContent=rem.length;
  document.getElementById("s-done").textContent=done.length+" / "+ms(doneMin);
  const pointSummary=_dayPointSummary();
  const pointEl=document.getElementById("s-points");
  const pointAvailEl=document.getElementById("s-points-available");
  if(pointEl)pointEl.textContent=pointSummary.earned+" / "+pointSummary.scheduledPoints;
  if(pointAvailEl)pointAvailEl.textContent="Available: "+pointSummary.availableToMax+" pts";
  const sBlock=document.getElementById("s-block");
  if(sBlock)sBlock.textContent=getCurrentBlockEnd();
  _updateRemainingStatLabels(scope);
}
// Block Ends stat tile removed 2026-07 (time-block containers gone). Kept the
// fn as a guarded no-op in case a stale reference calls it.
function getCurrentBlockEnd(){ return "--"; }

// ======== STAT POPOVERS ========
function showStatPopover(statId, event) {
  event.stopPropagation();
  const popover = document.getElementById('stat-popover');
  const wasOpen = popover.dataset.openFor === statId;
  // Close any open card highlight
  document.querySelectorAll('.stat.sp-open').forEach(el => el.classList.remove('sp-open'));
  if (wasOpen) { popover.style.display = 'none'; popover.dataset.openFor = ''; return; }
  let html = '';
  switch(statId) {
    case 's-time': {
      const scope = _remainingStatScope();
      const rem = _remainingForScope(scope);
      html = '<div class="sp-title">'+_remainingScopeLabel(scope)+' Time Remaining</div>';
      if (!rem.length) { html += '<div class="sp-empty">'+_remainingEmptyMessage(scope)+'</div>'; break; }
      html += rem.map(ev => '<div class="sp-row"><span class="sp-time">'+f12(ev.start).replace(' ','')+'</span><span class="sp-label">'+ev.title+'</span><span class="sp-dur">'+ms(dur(ev))+'</span></div>').join('');
      const total = rem.reduce((a,ev) => a+dur(ev), 0);
      html += '<div class="sp-note">Total: '+ms(total)+'</div>';
      break;
    }
    case 's-tasks': {
      const scope = _remainingStatScope();
      const rem = _remainingForScope(scope);
      html = '<div class="sp-title">'+_remainingScopeLabel(scope)+' Remaining Tasks</div>';
      if (!rem.length) { html += '<div class="sp-empty">'+_remainingEmptyMessage(scope)+'</div>'; break; }
      html += rem.map(ev => '<div class="sp-row"><span class="sp-time">'+f12(ev.start).replace(' ','')+'</span><span class="sp-label">'+ev.title+'</span></div>').join('');
      break;
    }
    case 's-done': {
      const done = scheduled.filter(isDone);
      const viewDate=(__state&&__state.date)||new Date().toISOString().split("T")[0];
      const triageDone=typeof completedTriageTasksForDate==="function"?completedTriageTasksForDate(viewDate):[];
      html = '<div class="sp-title">Completed Today</div>';
      if (!done.length&&!triageDone.length) { html += '<div class="sp-empty">Nothing checked off yet.</div>'; break; }
      html += done.map(ev => {
        const t = doneAt[ev.id] ? new Date(doneAt[ev.id]).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '—';
        const actual=_actualMin(ev), planned=dur(ev);
        const diff=actual-planned, diffLabel=diff>0?'+'+ms(diff):diff<0?'-'+ms(-diff):'';
        return '<div class="sp-row"><span class="sp-time">'+t+'</span><span class="sp-label">'+ev.title+'</span><span class="sp-dur">'+ms(actual)+(diffLabel?' <span style="font-size:10px;opacity:0.6">('+diffLabel+')</span>':'')+'</span></div>';
      }).join('');
      html += triageDone.map(ev => {
        const t = ev.completedAt ? new Date(ev.completedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '—';
        const planned=ev.durMin||30;
        return '<div class="sp-row"><span class="sp-time">'+t+'</span><span class="sp-label">'+ev.title+'</span><span class="sp-dur">'+ms(planned)+' <span style="font-size:10px;opacity:0.6">(triage)</span></span></div>';
      }).join('');
      const totalActual=done.reduce((a,ev)=>a+_actualMin(ev),0)+triageDone.reduce((a,ev)=>a+(ev.durMin||30),0), totalPlanned=done.reduce((a,ev)=>a+dur(ev),0)+triageDone.reduce((a,ev)=>a+(ev.durMin||30),0);
      html+='<div class="sp-note">Actual: '+ms(totalActual)+' / Planned: '+ms(totalPlanned)+'</div>';
      break;
    }
    case 's-points': {
      const summary=_dayPointSummary();
      const maxForMeter=Math.max(1,summary.maxGoal);
      const scheduledPct=Math.max(0,Math.min(100,Math.round((summary.scheduledPoints/maxForMeter)*100)));
      html = '<div class="sp-title">Day Point Budget</div>';
      html += '<div class="sp-row"><span class="sp-label">Earned from completed tasks</span><span class="sp-dur">'+summary.earned+' pts</span></div>';
      html += '<div class="sp-row"><span class="sp-label">Still scheduled</span><span class="sp-dur">'+summary.remainingPoints+' pts</span></div>';
      html += '<div class="sp-row"><span class="sp-label">Planned total</span><span class="sp-dur">'+summary.scheduledPoints+' pts</span></div>';
      html += '<div class="sp-point-meter" title="'+summary.scheduledPoints+' of '+summary.maxGoal+' max points allocated"><div class="sp-point-meter-fill" style="width:'+scheduledPct+'%"></div></div>';
      html += '<div class="sp-row"><span class="sp-label">Needed to minimum</span><span class="sp-dur">'+summary.neededToMin+' pts</span></div>';
      html += '<div class="sp-row"><span class="sp-label">Available to allocate</span><span class="sp-dur">'+summary.availableToMax+' pts</span></div>';
      html += '<div class="sp-point-goals">'
        +'<label class="sp-point-goal">Minimum goal<input type="number" min="0" step="5" value="'+summary.minGoal+'" onchange="setDayPointGoal(&apos;min&apos;,this.value)"></label>'
        +'<label class="sp-point-goal">Maximum goal<input type="number" min="0" step="5" value="'+summary.maxGoal+'" onchange="setDayPointGoal(&apos;max&apos;,this.value)"></label>'
        +'</div>';
      if(summary.remaining.length){
        html += '<div class="sp-title" style="margin-top:12px">Scheduled Points</div>';
        html += summary.remaining.map(ev => '<div class="sp-row"><span class="sp-time">'+f12(ev.start).replace(' ','')+'</span><span class="sp-label">'+_statEsc(ev.title)+'</span><span class="sp-dur">'+_estimatedTaskPoints(ev)+' pts</span></div>').join('');
      }
      html += '<div class="sp-point-note">This is display-only for now. The over-allocation warning can plug into these same totals later.</div>';
      break;
    }
    case 's-block': {
      const blocks = (__state&&__state.schedule&&__state.schedule.blocks)||[];
      if (!blocks.length) {
        const last = scheduled.length ? scheduled[scheduled.length-1] : null;
        html = '<div class="sp-title">Day Ends</div>';
        if (!last) { html += '<div class="sp-empty">No tasks scheduled.</div>'; break; }
        html += '<div class="sp-row"><span class="sp-label">'+last.title+'</span><span class="sp-dur">ends '+f12(last.end).replace(' ','')+'</span></div>';
        break;
      }
      html = '<div class="sp-title">Time Blocks</div>';
      const now = new Date();
      const nowMin = now.getHours()*60+now.getMinutes();
      html += blocks.map(b => {
        const bStart=pt(b.start),bEnd=pt(b.end);
        const isCurrent=nowMin>=bStart&&nowMin<bEnd;
        const isPast=nowMin>=bEnd;
        return '<div class="sp-row'+(isCurrent?' sp-active':'')+'" style="opacity:'+(isPast?'0.4':'1')+'">'
          +'<span class="sp-time">'+f12(b.start).replace(' ','')+'–'+f12(b.end).replace(' ','')+'</span>'
          +'<span class="sp-label">'+b.name+'</span>'
          +'<span class="sp-dur">'+(b.blockType||b.type)+(isCurrent?' (now)':'')+'</span></div>';
      }).join('');
      html += '<div class="sp-note" style="display:flex;justify-content:flex-end"><button class="sp-edit-btn" onclick="openBlockEditor()">✎ Edit Blocks</button></div>';
      break;
    }
  }
  popover.innerHTML = html;
  const rect = event.currentTarget.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 328));
  popover.style.top = (rect.bottom + 8) + 'px';
  popover.style.left = left + 'px';
  popover.style.display = 'block';
  popover.dataset.openFor = statId;
  event.currentTarget.classList.add('sp-open');
}
document.addEventListener('click', function(e) {
  const popover = document.getElementById('stat-popover');
  if (!popover) return;
  if (!e.target.closest('.stat') && !e.target.closest('#stat-popover')) {
    popover.style.display = 'none';
    popover.dataset.openFor = '';
    document.querySelectorAll('.stat.sp-open').forEach(el => el.classList.remove('sp-open'));
  }
});

// ======== BLOCK EDITOR ========
let _beBlocks = []; // working copy
let _beOriginal = []; // PIN 3: pristine snapshot captured at open(), used for diff on save

function _isDefaultScheduleBlock(b){
  return !!(b && (b.type === 'schedule_block' || b._blockType === 'schedule_block'));
}

function _isDatedBlockEditorBlock(b){
  return !!(b && b._date);
}

function openBlockEditor(blockId){
  // Close popover
  const popover = document.getElementById('stat-popover');
  if(popover){ popover.style.display='none'; popover.dataset.openFor=''; }
  document.querySelectorAll('.stat.sp-open').forEach(el=>el.classList.remove('sp-open'));

  // Read blocks from blockStore (has full props incl. acceptedTags), fall back to state
  const raw = (window.blockStore && [...window.blockStore.getByType('schedule_block'),...window.blockStore.getByType('block').filter(b=>(b.properties||{}).blockType&&(b.properties||{}).start&&(b.properties||{}).end&&(b.properties||{}).name)]) || [];
  if(raw.length) {
    _beBlocks = raw.map(b => ({
      id: b.id,
      type: b.type,
      _blockType: b.type,
      _date: b.date || null,
      parent_id: b.parent_id || null,
      sort_order: b.sort_order || 0,
      _isNew: false,
      ...(b.properties || {})
    }));
  } else {
    const src = (__state&&__state.schedule&&__state.schedule.blocks)||[];
    _beBlocks = JSON.parse(JSON.stringify(src));
  }

  // PIN 3: capture pristine snapshot for diff-on-save copy-forward flow
  _beOriginal = JSON.parse(JSON.stringify(_beBlocks));

  renderBlockEditor();
  document.getElementById("block-editor-overlay").classList.add("open");

  // Scroll to and briefly highlight the clicked block
  if(blockId) {
    const idx = _beBlocks.findIndex(b => b.id === blockId);
    if(idx !== -1) {
      setTimeout(() => {
        const row = document.querySelector('.be-card[data-idx="'+idx+'"]');
        if(row) {
          row.scrollIntoView({ behavior:'smooth', block:'nearest' });
          row.classList.add('be-row-highlight');
          setTimeout(() => row.classList.remove('be-row-highlight'), 1500);
        }
      }, 60);
    }
  }
}

function closeBlockEditor(){
  document.getElementById("block-editor-overlay").classList.remove("open");
  _beBlocks = [];
  _beOriginal = []; // PIN 3: drop snapshot
}

function renderBlockEditor(){
  const body = document.getElementById("block-editor-body");
  // Separate top-level and nested
  const topLevel = _beBlocks.filter(b=>!b.parent_id);
  let html = '';
  topLevel.forEach((b,i) => {
    const idx = _beBlocks.indexOf(b);
    html += renderBlockRow(b, idx, false);
    // Render children
    const children = _beBlocks.filter(c=>c.parent_id===b.id);
    children.forEach(c => {
      const cidx = _beBlocks.indexOf(c);
      html += renderBlockRow(c, cidx, true);
    });
    html += '<div class="be-card-add-sub"><button onclick="beAddChild('+idx+')">+ Add sub-block</button></div>';
  });
  html += '<div class="be-add-root"><button onclick="beAddBlock()">+ Add Block</button></div>';
  body.innerHTML = html;
  mountBlockEditorTagPickers();
  beCheckOverlaps();
}

function mountBlockEditorTagPickers(){
  document.querySelectorAll('.be-tag-picker').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const b = _beBlocks[idx];
    if(!b) return;
    if(typeof createTagPicker === 'function') {
      createTagPicker(el, b.acceptedTags || [], ids => {
        if(_beBlocks[idx]) _beBlocks[idx].acceptedTags = ids;
      });
    }
  });
}

function beDuration(start, end){
  // Returns a "1h 30m" style string from two HH:MM values
  if(!start||!end) return '';
  const s = start.split(':').map(Number), e = end.split(':').map(Number);
  const mins = (e[0]*60+e[1]) - (s[0]*60+s[1]);
  if(mins <= 0) return '';
  const h = Math.floor(mins/60), m = mins%60;
  return h && m ? h+'h '+m+'m' : h ? h+'h' : m+'m';
}

function renderBlockRow(b, idx, nested){
  const bt = b.blockType||b.type||'work';
  const prot = b.protected;
  const warn = b.warnThreshold||0;
  const dur = beDuration(b.start||'09:00', b.end||'17:00');
  const barClass = bt === 'personal' ? 'personal' : bt === 'break' ? 'break' : 'work';
  // PIN 6: only top-level blocks are draggable (nested children stay grouped under their parent)
  const dragAttrs = nested ? '' : (
    ' draggable="true"'
    +' ondragstart="beDragStart(event,'+idx+')"'
    +' ondragover="beDragOver(event,'+idx+')"'
    +' ondragleave="beDragLeave(event,'+idx+')"'
    +' ondrop="beDragDrop(event,'+idx+')"'
    +' ondragend="beDragEnd(event)"'
  );

  return '<div class="be-card'+(nested?' nested':'')+'" data-idx="'+idx+'"'+dragAttrs+'>'
    +'<div class="be-card-inner">'
      +'<div class="be-bar '+barClass+'"></div>'
      +'<div class="be-card-content">'
        // ── Row 1: name ──
        +'<div class="be-row-name">'
          +'<input class="be-card-name" value="'+esc(b.name||'')+'" placeholder="Block name" title="Block name" onchange="beUpdate('+idx+',&apos;name&apos;,this.value)">'
          +'<button class="be-card-delete" onclick="beDelete('+idx+')" title="Delete block">\u00d7</button>'
        +'</div>'
        // ── Row 2: times + duration — PIN 6: clock-face picker instead of native time inputs ──
        +'<div class="be-row-time">'
          +'<button type="button" class="be-card-time" title="Start time" id="be-start-'+idx+'" onclick="beOpenTimePicker('+idx+',&apos;start&apos;,this)">'+f12(b.start||'09:00')+'</button>'
          +'<span class="be-time-arrow">\u2192</span>'
          +'<button type="button" class="be-card-time" title="End time" id="be-end-'+idx+'" onclick="beOpenTimePicker('+idx+',&apos;end&apos;,this)">'+f12(b.end||'17:00')+'</button>'
          +'<input class="be-dur-input" value="'+dur+'" title="Duration \u2014 edit to adjust end time" id="be-dur-'+idx+'" onchange="beDurChanged('+idx+',this.value)" placeholder="0m">'
          +'<button class="be-dur-preset-btn" title="Duration presets" onclick="beOpenDurPresets('+idx+',this)">&#9662;</button>'
        +'</div>'
        // ── Row 3: type, protected, warn ──
        +'<div class="be-row-settings">'
          +'<select class="be-type-select" title="Block category" onchange="beUpdate('+idx+',&apos;blockType&apos;,this.value);beUpdateBar('+idx+',this.value)">'
            +'<option value="work"'+(bt==='work'?' selected':'')+'>Work</option>'
            +'<option value="personal"'+(bt==='personal'?' selected':'')+'>Personal</option>'
          +'</select>'
          +'<button class="be-pill'+(prot?' active':'')+'" title="Protected boundary \u2014 tasks cannot overflow past the end of this block" onclick="beToggleProtected('+idx+')">'
            +'<span class="be-pill-icon">\ud83d\udee1</span>'
            +'<span class="be-pill-label">Protected</span>'
          +'</button>'
          +'<div class="be-warn-pill" title="Warn you this many minutes before the block ends (0 = off)">'
            +'<span class="be-warn-icon">\u26a0\ufe0f</span>'
            +'<span class="be-warn-label">Warn</span>'
            +'<input type="number" class="be-warn-num" value="'+warn+'" min="0" max="120" placeholder="0" onchange="beUpdate('+idx+',&apos;warnThreshold&apos;,parseInt(this.value)||0)">'
            +'<span class="be-warn-label">min</span>'
          +'</div>'
        +'</div>'
        // ── Row 4: accepts tags (full width) ──
        +'<div class="be-row-tags">'
          +'<span class="be-tags-label">Accepts</span>'
          +'<div class="be-tag-picker" data-idx="'+idx+'"></div>'
        +'</div>'
      +'</div>'
    +'</div>'
  +'</div>';
}

function beRefreshDur(idx){
  const b = _beBlocks[idx];
  if(!b) return;
  const el = document.getElementById('be-dur-'+idx);
  if(el) el.value = beDuration(b.start||'09:00', b.end||'17:00');
}

// Parse a duration string like "2h", "30m", "1h 30m", "1.5h" → total minutes
function beParseDur(str){
  if(!str) return 0;
  str = str.trim().toLowerCase();
  let mins = 0;
  // "1.5h" style
  const decMatch = str.match(/^(\d+\.?\d*)\s*h$/);
  if(decMatch) return Math.round(parseFloat(decMatch[1]) * 60);
  // "1h 30m" or "1h30m"
  const hm = str.match(/(\d+)\s*h\s*(\d+)\s*m?/);
  if(hm) return parseInt(hm[1])*60 + parseInt(hm[2]);
  // "2h"
  const hOnly = str.match(/^(\d+)\s*h$/);
  if(hOnly) return parseInt(hOnly[1])*60;
  // "45m" or just "45"
  const mOnly = str.match(/^(\d+)\s*m?$/);
  if(mOnly) return parseInt(mOnly[1]);
  return 0;
}

// When duration input changes, update end time
function beDurChanged(idx, val){
  const b = _beBlocks[idx];
  if(!b) return;
  const mins = beParseDur(val);
  if(mins <= 0) return;
  const s = (b.start||'09:00').split(':').map(Number);
  const endMins = s[0]*60 + s[1] + mins;
  const eh = Math.floor(endMins/60), em = endMins%60;
  const endStr = String(eh).padStart(2,'0')+':'+String(em).padStart(2,'0');
  b.end = endStr;
  const endEl = document.getElementById('be-end-'+idx);
  if(endEl) endEl.value = endStr;
  // Refresh the duration display to normalized format
  const durEl = document.getElementById('be-dur-'+idx);
  if(durEl) durEl.value = beDuration(b.start, b.end);
  beCheckOverlaps();
}

// Duration preset popover for block editor
function beOpenDurPresets(idx, btn){
  // Close any existing preset popover
  document.querySelectorAll('.be-dur-popover').forEach(p=>p.remove());
  const presets = [30, 60, 90, 120, 180, 240];
  const b = _beBlocks[idx];
  if(!b) return;
  // Current duration in minutes
  const curMins = beParseDur(beDuration(b.start||'09:00', b.end||'17:00'));
  const pop = document.createElement('div');
  pop.className = 'be-dur-popover';
  const grid = document.createElement('div');
  grid.className = 'dur-presets';
  presets.forEach(m => {
    const pbtn = document.createElement('button');
    pbtn.className = 'dur-preset' + (m === curMins ? ' dur-current' : '');
    pbtn.textContent = ms(m);
    pbtn.addEventListener('click', e => { e.stopPropagation(); pop.remove(); beSetDurPreset(idx, m); });
    grid.appendChild(pbtn);
  });
  pop.appendChild(grid);
  // Position relative to button
  const rect = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = rect.left + 'px';
  pop.style.zIndex = '9999';
  document.body.appendChild(pop);
  function onOutside(e){ if(!pop.contains(e.target) && e.target !== btn){ pop.remove(); document.removeEventListener('click', onOutside, true); } }
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

function beSetDurPreset(idx, mins){
  const b = _beBlocks[idx];
  if(!b) return;
  const s = (b.start||'09:00').split(':').map(Number);
  const endMins = s[0]*60 + s[1] + mins;
  const eh = Math.floor(endMins/60), em = endMins%60;
  b.end = String(eh).padStart(2,'0') + ':' + String(em).padStart(2,'0');
  const endEl = document.getElementById('be-end-'+idx);
  if(endEl) endEl.value = b.end;
  const durEl = document.getElementById('be-dur-'+idx);
  if(durEl) durEl.value = beDuration(b.start, b.end);
  beCheckOverlaps();
}

// Check for overlapping blocks and show/hide warnings
function beCheckOverlaps(){
  // Sort top-level blocks by start time for comparison
  const topLevel = _beBlocks.filter(b => !b.parent_id);
  topLevel.sort((a,b) => (a.start||'').localeCompare(b.start||''));

  // Clear all existing overlap warnings
  document.querySelectorAll('.be-card').forEach(c => c.classList.remove('be-overlap'));
  document.querySelectorAll('.be-overlap-warn').forEach(w => w.remove());

  let hasOverlap = false;
  for(let i = 0; i < topLevel.length - 1; i++){
    const curr = topLevel[i], next = topLevel[i+1];
    if(!curr.end || !next.start) continue;
    if(curr.end > next.start){
      hasOverlap = true;
      // Mark both cards
      const currIdx = _beBlocks.indexOf(curr);
      const nextIdx = _beBlocks.indexOf(next);
      const currCard = document.querySelector('.be-card[data-idx="'+currIdx+'"]');
      const nextCard = document.querySelector('.be-card[data-idx="'+nextIdx+'"]');
      if(currCard){
        currCard.classList.add('be-overlap');
        if(!currCard.querySelector('.be-overlap-warn')){
          const w = document.createElement('div');
          w.className = 'be-overlap-warn';
          w.textContent = 'Overlaps with '+esc(next.name||'next block')+' (starts '+f12(next.start)+')';
          currCard.querySelector('.be-card-content').appendChild(w);
        }
      }
      if(nextCard) nextCard.classList.add('be-overlap');
    }
  }

  // Toggle save button
  const saveBtn = document.getElementById('block-editor-save');
  if(saveBtn){
    saveBtn.disabled = hasOverlap;
    saveBtn.title = hasOverlap ? 'Fix overlapping blocks before saving' : '';
  }
}

function esc(s){ return window.DCC.esc(s); } // was a 2-entity escaper; DCC.esc covers all five

function beUpdate(idx, field, value){
  if(_beBlocks[idx]) _beBlocks[idx][field] = value;
}

// ─── PIN 6: Clock-face picker + auto-reflow ─────────────────────────────────
function beOpenTimePicker(idx, field, anchorEl){
  const b = _beBlocks[idx];
  if(!b) return;
  const current = (field === 'start' ? b.start : b.end) || '09:00';
  if(typeof openClockPicker !== 'function') return;
  openClockPicker(current, anchorEl, function(timeStr){
    if(!_beBlocks[idx]) return;
    _beBlocks[idx][field] = timeStr;
    beSortBlocks();
    renderBlockEditor(); // full rebuild — mounts pickers fresh, checks overlaps
  });
}

// Sort top-level blocks by start time in place. Children remain grouped under
// their parent because renderBlockEditor iterates top-level first, then attaches
// each parent's children immediately after it.
function beSortBlocks(){
  const top = _beBlocks.filter(b => !b.parent_id);
  top.sort((a,b) => (a.start || '').localeCompare(b.start || ''));
  const children = _beBlocks.filter(b => b.parent_id);
  _beBlocks = [...top, ...children];
}

// ─── PIN 6: Drag-and-drop top-level blocks ──────────────────────────────────
let _beDragIdx = null;
function beDragStart(e, idx){
  _beDragIdx = idx;
  if(e.dataTransfer){ e.dataTransfer.effectAllowed = 'move'; }
  if(e.currentTarget) e.currentTarget.classList.add('be-dragging');
}
function beDragOver(e, idx){
  if(_beDragIdx === null || _beDragIdx === idx) return;
  e.preventDefault();
  if(e.dataTransfer){ e.dataTransfer.dropEffect = 'move'; }
  if(e.currentTarget) e.currentTarget.classList.add('be-drag-over');
}
function beDragLeave(e){
  if(e.currentTarget) e.currentTarget.classList.remove('be-drag-over');
}
function beDragDrop(e, targetIdx){
  e.preventDefault();
  if(e.currentTarget) e.currentTarget.classList.remove('be-drag-over');
  if(_beDragIdx === null || _beDragIdx === targetIdx) return;
  const dragged = _beBlocks[_beDragIdx];
  const target = _beBlocks[targetIdx];
  _beDragIdx = null;
  if(!dragged || !target) return;
  // Only top-level blocks can be reordered via drag (children stay grouped)
  if(dragged.parent_id || target.parent_id) return;
  // Snap dragged block's start to the target's end; preserve dragged duration
  const duration = pt(dragged.end) - pt(dragged.start);
  dragged.start = target.end;
  dragged.end = fmt(pt(target.end) + duration);
  beSortBlocks();
  renderBlockEditor();
}
function beDragEnd(e){
  _beDragIdx = null;
  document.querySelectorAll('.be-card.be-dragging').forEach(el => el.classList.remove('be-dragging'));
  document.querySelectorAll('.be-card.be-drag-over').forEach(el => el.classList.remove('be-drag-over'));
}

function beToggleProtected(idx){
  if(!_beBlocks[idx]) return;
  _beBlocks[idx].protected = !_beBlocks[idx].protected;
  renderBlockEditor();
}

function beUpdateBar(idx, type){
  const card = document.querySelector('.be-card[data-idx="'+idx+'"]');
  if(!card) return;
  const bar = card.querySelector('.be-bar');
  if(!bar) return;
  bar.className = 'be-bar ' + (type === 'personal' ? 'personal' : type === 'break' ? 'break' : 'work');
}

function beDelete(idx){
  const b = _beBlocks[idx];
  if(!b) return;
  // Delete children too
  _beBlocks = _beBlocks.filter(c => c.parent_id !== b.id);
  _beBlocks.splice(_beBlocks.indexOf(b), 1);
  renderBlockEditor();
}

function beClearAll(){
  if(!_beBlocks.length) return;
  if(!confirm('Remove all '+_beBlocks.length+' time block'+(_beBlocks.length===1?'':'s')+'? This takes effect when you click Save.')) return;
  _beBlocks = [];
  renderBlockEditor();
}

function beAddBlock(){
  _beBlocks.push({
    id: '_new_'+Date.now()+'_'+Math.random().toString(36).substr(2,4),
    parent_id: null, name:'', blockType:'work', start:'09:00', end:'17:00',
    protected:false, warnThreshold:0, sort_order:_beBlocks.length, _isNew:true
  });
  renderBlockEditor();
}

function beAddChild(parentIdx){
  const parent = _beBlocks[parentIdx];
  if(!parent) return;
  _beBlocks.push({
    id: '_new_'+Date.now()+'_'+Math.random().toString(36).substr(2,4),
    parent_id: parent.id, name:'', blockType:parent.blockType||'work',
    start:parent.start, end:parent.end,
    protected:false, warnThreshold:0, sort_order:_beBlocks.length, _isNew:true
  });
  renderBlockEditor();
}

// PIN 3: deep-compare _beBlocks vs _beOriginal for "no net change" early-exit.
// Sort by id so children reorder doesn't create false diffs.
function _beBlocksEqual(a, b){
  if (a.length !== b.length) return false;
  var sa = [...a].sort(function(x,y){return (x.id||'').localeCompare(y.id||'');});
  var sb = [...b].sort(function(x,y){return (x.id||'').localeCompare(y.id||'');});
  return JSON.stringify(sa) === JSON.stringify(sb);
}

// PIN 3: build the update/create/delete diff between _beOriginal and _beBlocks.
// Top-level blocks only. Nested children are NOT propagated forward in v1.
function _computeBlockDiff(){
  var origTop = _beOriginal.filter(function(b){return !b.parent_id;});
  var curTop  = _beBlocks.filter(function(b){return !b.parent_id;});
  var origById = {};
  origTop.forEach(function(b){origById[b.id]=b;});
  var curById = {};
  curTop.forEach(function(b){curById[b.id]=b;});

  var PROP_KEYS = ['name','blockType','start','end','protected','warnThreshold','acceptedTags'];
  function props(b){
    return {
      name: b.name || '',
      blockType: b.blockType || 'work',
      start: b.start || '',
      end: b.end || '',
      protected: !!b.protected,
      warnThreshold: b.warnThreshold || 0,
      acceptedTags: b.acceptedTags || []
    };
  }

  var updates = [], creates = [], deletes = [];

  // Updates: same id, any changed prop
  curTop.forEach(function(c){
    if (c._isNew || (typeof c.id === 'string' && c.id.indexOf('_new_') === 0)) return;
    var o = origById[c.id];
    if (!o) return;
    var cp = props(c), op = props(o);
    var changed = false;
    for (var k = 0; k < PROP_KEYS.length; k++){
      var key = PROP_KEYS[k];
      if (JSON.stringify(cp[key]) !== JSON.stringify(op[key])){ changed = true; break; }
    }
    if (changed){
      updates.push({
        id: c.id,
        match: { name: op.name, blockType: op.blockType, sort_order: o.sort_order || 0 },
        originalValues: op,
        newValues: cp
      });
    }
  });

  // Creates: in current, not in original
  curTop.forEach(function(c){
    if (!origById[c.id]){
      creates.push({
        block: {
          type: 'block',
          properties: props(c),
          sort_order: c.sort_order || 0
        }
      });
    }
  });

  // Deletes: in original, not in current
  origTop.forEach(function(o){
    if (!curById[o.id]){
      deletes.push({
        match: { name: o.name || '', blockType: o.blockType || 'work', sort_order: o.sort_order || 0 },
        originalValues: props(o)
      });
    }
  });

  return { updates: updates, creates: creates, deletes: deletes };
}

// PIN 3: the existing single-day write flow, extracted so both "today only"
// and "today + future" confirm-modal paths can reuse it.
async function _applyBlocksToday(){
  var current = (__state && __state.schedule && __state.schedule.blocks) || [];
  var newIds = new Set(_beBlocks.map(function(b){return b.id;}));
  for (var i = 0; i < current.length; i++){
    var old = current[i];
    if (!newIds.has(old.id)) await blockStore.deleteBlock(old.id);
  }
  for (var j = 0; j < _beBlocks.length; j++){
    var b = _beBlocks[j];
    var bProps = {
      name: (b.name || '').trim(),
      blockType: b.blockType || 'work',
      start: b.start,
      end: b.end,
      protected: !!b.protected,
      warnThreshold: b.warnThreshold || 0,
      acceptedTags: b.acceptedTags || []
    };
    if (b._isNew || (typeof b.id === 'string' && b.id.indexOf('_new_') === 0)){
      const createType = b._createAsScheduleBlock ? 'schedule_block' : 'block';
      const createDate = createType === 'schedule_block' ? null : undefined;
      await blockStore.createBlock(createType, bProps, { parentId: b.parent_id, date: createDate, sortOrder: j });
    } else {
      await blockStore.updateBlock(b.id, bProps);
    }
  }
  // Refresh state
  try {
    var resp = await fetch('/api/state/day');
    var state = await resp.json();
    if (state.schedule) __state.schedule = state.schedule;
  } catch(e){}
  // Schedule blocks are global (stored date-less), so a save here changes the
  // blocks rendered on every day. switchToDate() builds the "tomorrow" view from
  // the boot-cached window.__DCC_TOMORROW__ snapshot, so refresh it too —
  // otherwise the tomorrow view shows stale blocks after an edit/Clear All.
  try {
    if (typeof window !== 'undefined' && window.__DCC_TOMORROW__) {
      var tResp = await fetch('/api/state/tomorrow');
      var tState = await tResp.json();
      if (tState && tState.schedule) window.__DCC_TOMORROW__ = tState;
    }
  } catch(e){}
  var blocks = (__state && __state.schedule && __state.schedule.blocks) || [];
  var wb = blocks.filter(function(b){return (b.blockType||b.type)==='work';});
  if (wb.length) EOD = pt(wb[wb.length-1].end);
  updateStats();
}

async function saveBlockEditor(){
  // Check overlaps first
  const topLevel = _beBlocks.filter(b => !b.parent_id);
  topLevel.sort((a,b) => (a.start||'').localeCompare(b.start||''));
  for(let i = 0; i < topLevel.length - 1; i++){
    if(topLevel[i].end > topLevel[i+1].start){
      showToast(topLevel[i].name+" overlaps with "+topLevel[i+1].name+" \u2014 fix before saving","error");
      return;
    }
  }
  // Validate
  for(const b of _beBlocks){
    if(!b.name||!b.name.trim()){ showToast("Block name is required","error"); return; }
    if(!b.start||!b.end){ showToast("Start and end times are required","error"); return; }
    if(b.start>=b.end){ showToast(b.name+": start must be before end","error"); return; }
    // Validate children fit within parent
    if(b.parent_id){
      const parent = _beBlocks.find(p=>p.id===b.parent_id);
      if(parent && (b.start<parent.start||b.end>parent.end)){
        showToast(b.name+" must fit within "+parent.name,"error"); return;
      }
    }
  }

  // PIN 3: no net change -> close silently without prompting
  if (_beBlocksEqual(_beBlocks, _beOriginal)){
    closeBlockEditor();
    showToast("No changes","success");
    return;
  }

  // PIN 3: prompt for scope (today only vs today + future days)
  _openBsConfirm();
}

// PIN 3: confirm-modal open/close helpers
function _openBsConfirm(){
  var overlay = document.getElementById('bs-confirm-overlay');
  if (overlay) overlay.classList.add('open');
}
function _closeBsConfirm(){
  var overlay = document.getElementById('bs-confirm-overlay');
  if (overlay) overlay.classList.remove('open');
}

// PIN 3: "Today only" path — existing single-day write flow.
async function _onBsConfirmTodayOnly(){
  _closeBsConfirm();
  try {
    await _applyBlocksToday();
    closeBlockEditor();
    render();
    showToast("Time blocks saved","success");
  } catch(e){
    showToast("Save failed: "+(e&&e.message||e),"error");
  }
}

// PIN 3: "Today + future days" path — apply to today, then POST the diff to
// /api/blocks/apply-forward so the server can ripple the changes to every
// future day that still matches the original values.
async function _onBsConfirmTodayAndFuture(){
  _closeBsConfirm();
  var diff;
  try { diff = _computeBlockDiff(); }
  catch(e){ showToast("Could not compute diff: "+(e&&e.message||e),"error"); return; }

  try {
    var topBlocks = _beBlocks.filter(function(b){return !b.parent_id;});
    var topOriginals = _beOriginal.filter(function(b){return !b.parent_id;});
    var usesDefaultScheduleBlocks = topBlocks.some(_isDefaultScheduleBlock) || topOriginals.some(_isDefaultScheduleBlock);
    var usesDatedBlocks = topBlocks.some(_isDatedBlockEditorBlock) || topOriginals.some(_isDatedBlockEditorBlock);
    if (usesDefaultScheduleBlocks){
      _beBlocks.forEach(function(b){
        if (b._isNew || (typeof b.id === 'string' && b.id.indexOf('_new_') === 0)) b._createAsScheduleBlock = true;
      });
    }
    await _applyBlocksToday();

    var fromDate = (typeof __state !== 'undefined' && __state && __state.date) ? __state.date : null;
    if (usesDefaultScheduleBlocks && !usesDatedBlocks){
      closeBlockEditor();
      render();
      showToast("Updated default time blocks for today + future days","success");
      return;
    }
    if (!fromDate){
      closeBlockEditor();
      render();
      showToast("Saved today, but could not propagate: unknown current date","error");
      return;
    }
    var resp = await fetch('/api/blocks/apply-forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDate: fromDate, diff: diff })
    });
    if (!resp.ok){
      var msg = 'HTTP '+resp.status;
      try { var j = await resp.json(); msg = j.error || msg; } catch(e){}
      closeBlockEditor();
      render();
      showToast("Saved today; propagate failed: "+msg,"error");
      return;
    }
    var res = await resp.json();
    closeBlockEditor();
    render();
    var summary = "Updated today + "+(res.daysUpdated||0)+" future day"+
      ((res.daysUpdated||0)===1?"":"s");
    if (res.skippedCount && res.skippedCount > 0){
      summary += " ("+res.skippedCount+" customized block"+
        (res.skippedCount===1?"":"s")+" skipped)";
    }
    showToast(summary,"success");
  } catch(e){
    showToast("Save failed: "+(e&&e.message||e),"error");
  }
}

// Wire editor modal controls
document.getElementById("block-editor-close").addEventListener("click",closeBlockEditor);
document.getElementById("block-editor-cancel").addEventListener("click",closeBlockEditor);
document.getElementById("block-editor-save").addEventListener("click",saveBlockEditor);
document.getElementById("block-editor-clear")?.addEventListener("click",beClearAll);
document.getElementById("block-editor-overlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeBlockEditor()});
document.getElementById("block-editor-manage-tags")?.addEventListener("click",()=>{ if(typeof openTagManager==='function') openTagManager(); });
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&document.getElementById("block-editor-overlay").classList.contains("open"))closeBlockEditor()});

// PIN 3: wire the copy-forward confirm modal buttons
document.getElementById("bs-confirm-cancel")?.addEventListener("click", _closeBsConfirm);
document.getElementById("bs-confirm-today")?.addEventListener("click", _onBsConfirmTodayOnly);
document.getElementById("bs-confirm-future")?.addEventListener("click", _onBsConfirmTodayAndFuture);
document.getElementById("bs-confirm-overlay")?.addEventListener("click", e=>{ if(e.target===e.currentTarget) _closeBsConfirm(); });


// ======== MOBILE DURATION BOTTOM SHEET ========
// Touch / narrow viewports get a slide-up sheet instead of the fixed duration
// popover (which was easy to mis-place and hard to tap on a phone). Composes a
// local value via big steppers / preset chips / a number field, then commits
// once via setDurAbsolute. Desktop is unchanged.
function isCoarseOrNarrowViewport(){
  try{
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches || window.innerWidth <= 540;
  }catch(_){ return window.innerWidth <= 540; }
}

function openDurationSheet(ev){
  document.querySelectorAll(".dur-sheet-backdrop").forEach(s=>s.remove());
  const DUR_PRESETS=[15,30,45,60,90,120,150,180,210,240,300,360];
  let val=Math.max(1,dur(ev)||30);

  const backdrop=document.createElement("div");
  backdrop.className="dur-sheet-backdrop";
  const sheet=document.createElement("div");
  sheet.className="dur-sheet";
  sheet.innerHTML=
    '<div class="dur-sheet-handle"></div>'+
    '<div class="dur-sheet-head">Duration<span class="dur-sheet-task"></span></div>'+
    '<div class="dur-sheet-stepper">'+
      '<button class="dur-sheet-step" data-d="-15" type="button" aria-label="Minus 15 minutes">&minus;15</button>'+
      '<div class="dur-sheet-val" id="dur-sheet-val"></div>'+
      '<button class="dur-sheet-step" data-d="15" type="button" aria-label="Plus 15 minutes">+15</button>'+
    '</div>'+
    '<div class="dur-sheet-presets"></div>'+
    '<div class="dur-sheet-custom"><input type="number" min="1" step="1" inputmode="numeric" class="dur-sheet-input" aria-label="Custom minutes"><span class="dur-sheet-unit">min</span></div>'+
    '<div class="dur-sheet-actions"><button class="dur-sheet-cancel" type="button">Cancel</button><button class="dur-sheet-done" type="button">Done</button></div>';
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);

  sheet.querySelector(".dur-sheet-task").textContent=ev.title||"";
  const valEl=sheet.querySelector("#dur-sheet-val");
  const input=sheet.querySelector(".dur-sheet-input");
  const presetWrap=sheet.querySelector(".dur-sheet-presets");
  DUR_PRESETS.forEach(m=>{
    const b=document.createElement("button");
    b.type="button";b.className="dur-sheet-preset";b.dataset.m=String(m);b.textContent=ms(m);
    b.addEventListener("click",e=>{e.stopPropagation();setVal(m);});
    presetWrap.appendChild(b);
  });

  function setVal(n){
    val=Math.max(1,Math.round(n||0));
    valEl.textContent=ms(val);
    if(document.activeElement!==input)input.value=String(val);
    presetWrap.querySelectorAll(".dur-sheet-preset").forEach(p=>{
      p.classList.toggle("active",parseInt(p.dataset.m,10)===val);
    });
  }
  function close(){
    backdrop.classList.remove("open");
    setTimeout(()=>backdrop.remove(),200);
    document.removeEventListener("keydown",onKey,true);
  }
  function commit(){ const v=val; close(); setDurAbsolute(ev.id,v); }
  function onKey(e){ if(e.key==="Escape"){e.preventDefault();close();} }

  sheet.querySelectorAll(".dur-sheet-step").forEach(s=>s.addEventListener("click",e=>{e.stopPropagation();setVal(val+parseInt(s.dataset.d,10));}));
  input.addEventListener("input",e=>{e.stopPropagation();const v=parseInt(input.value,10);if(v>0)setVal(v);});
  input.addEventListener("keydown",e=>{e.stopPropagation();if(e.key==="Enter"){e.preventDefault();commit();}});
  input.addEventListener("click",e=>e.stopPropagation());
  sheet.querySelector(".dur-sheet-done").addEventListener("click",e=>{e.stopPropagation();commit();});
  sheet.querySelector(".dur-sheet-cancel").addEventListener("click",e=>{e.stopPropagation();close();});
  sheet.addEventListener("click",e=>e.stopPropagation());
  backdrop.addEventListener("click",()=>close());
  document.addEventListener("keydown",onKey,true);

  setVal(val);
  // next frame: trigger slide-up transition
  requestAnimationFrame(()=>backdrop.classList.add("open"));
}

