// ======== RESPONSIBILITIES TAB ========
// Responsibilities are durable obligations. They become scheduled tasks only
// when their cadence/score or a trigger makes them actionable.
(function(){
  let _items = [];
  // Saved shell structure staged for the create/edit modal. The modal reads/writes
  // scalar DOM fields, so a nested template can't ride a form input — it's stashed
  // here between openResponsibilityModal and formProps/saveResponsibility.
  let _pendingTemplateTree = null;
  let _sidebarQuery = "";
  let _sidebarFilter = "active";
  let _sidebarSort = "urgency";
  let _sidebarExpanded = new Set();

  function esc(s) { return window.DCC.esc(s); } // delegates to core.js

  // Delegates to the shared urgency helper (window.urgency) so responsibilities
  // and blocked items color-code identically. See public/js/urgency.js.
  function scoreClass(score){
    return window.urgency.scoreClass(score);
  }

  function isAsNeeded(props){
    const raw=String((props&&props.cadence)||"").toLowerCase();
    return raw==="as_needed"||raw==="as-needed"||raw==="as needed"||props&&props.asNeeded;
  }

  function cadencePreset(props){
    props=props||{};
    if(isAsNeeded(props))return "as_needed";
    const days=Number(props.cadenceDays||props.cadence_days||0);
    if(days===1)return "daily";
    if(days===7)return "weekly";
    if(days===14)return "biweekly";
    if(days===30)return "monthly";
    return "custom";
  }

  function cadenceSortDays(props){
    if(isAsNeeded(props))return 9999;
    return Math.max(1,Number((props&&props.cadenceDays)||(props&&props.cadence_days)||7));
  }

  function daysAgo(iso){
    if(!iso)return "never completed";
    const d=new Date(iso);
    if(isNaN(d.getTime()))return "never completed";
    const days=Math.floor((Date.now()-d.getTime())/86400000);
    if(days<=0)return "completed today";
    if(days===1)return "completed 1d ago";
    return "completed "+days+"d ago";
  }

  const WEEKDAY_LABELS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTH_LABELS=["January","February","March","April","May","June","July","August","September","October","November","December"];

  function localDateOnly(date){
    return new Date(date.getFullYear(),date.getMonth(),date.getDate());
  }

  function daysInMonth(year,monthIndex){
    return new Date(year,monthIndex+1,0).getDate();
  }

  function preferredCompletionInfo(props,at){
    props=props||{};
    const cadence=String(props.preferredCompletionCadence||props.preferredCadence||"none").toLowerCase();
    if(!cadence||cadence==="none")return {active:false,due:false,label:""};
    const now=at instanceof Date?at:new Date();
    if(isNaN(now.getTime()))return {active:false,due:false,label:""};
    if(cadence==="weekly"){
      const day=Math.max(0,Math.min(6,Number(props.preferredDayOfWeek||0)));
      return {active:true,due:now.getDay()===day,label:WEEKDAY_LABELS[day]};
    }
    if(cadence==="monthly"){
      const target=Math.max(1,Math.min(31,Number(props.preferredDayOfMonth||1)));
      const dueDay=Math.min(target,daysInMonth(now.getFullYear(),now.getMonth()));
      return {active:true,due:now.getDate()===dueDay,label:"Day "+target};
    }
    if(cadence==="yearly"){
      const month=Math.max(1,Math.min(12,Number(props.preferredMonth||1)));
      const target=Math.max(1,Math.min(31,Number(props.preferredMonthDay||1)));
      const dueDay=Math.min(target,daysInMonth(now.getFullYear(),month-1));
      return {active:true,due:now.getMonth()+1===month&&now.getDate()===dueDay,label:MONTH_LABELS[month-1]+" "+target};
    }
    if(cadence==="custom"){
      const anchorRaw=props.preferredCustomAnchor||props.preferredDate||"";
      const every=Math.max(1,Number(props.preferredCustomDays||props.preferredEveryDays||1));
      const anchor=anchorRaw?new Date(anchorRaw+"T00:00:00"):null;
      if(!anchor||isNaN(anchor.getTime()))return {active:true,due:false,label:"Every "+every+"d"};
      const diff=Math.floor((localDateOnly(now)-localDateOnly(anchor))/86400000);
      return {active:true,due:diff>=0&&diff%every===0,label:"Every "+every+"d"};
    }
    return {active:false,due:false,label:""};
  }

  function preferredCompletionSummary(props){
    const info=preferredCompletionInfo(props);
    if(!info.active||!info.due)return "";
    return "Don't forget! This is when you like to do this.";
  }

  function responsibilityTiming(props){
    props=props||{};
    if(isAsNeeded(props))return {cadence:null,elapsed:0,remaining:null,progress:0,asNeeded:true};
    const anchor=props.lastCompletedAt||props.createdAt||props.created_at||props.added_at;
    // Shared time-decay math (public/js/urgency.js).
    return window.urgency.timing(props.cadenceDays||props.cadence_days||7, anchor);
  }

  function dueLabel(props){
    const preferred=preferredCompletionInfo(props);
    if(preferred.due)return "preferred today";
    const t=responsibilityTiming(props);
    if(t.asNeeded) return "as needed";
    if(t.remaining < 0) return Math.abs(t.remaining)+"d overdue";
    if(t.remaining === 0) return "due today";
    if(t.remaining === 1) return "1d left";
    return t.remaining+"d left";
  }

  function cadenceLabel(props){
    if(isAsNeeded(props))return "As needed";
    return "Every "+esc((props&&props.cadenceDays)||7)+"d";
  }

  // ── Due-in-triage surfacing (Part C) ──
  // Repeat responsibilities no longer live only in a drawer sidebar: as their
  // cadence makes them due they surface as cards in the Itinerary triage strip
  // ("needs attention before it disappears into the day"). These are VIRTUAL —
  // computed client-side from the responsibility rows, never written into the
  // triage store — so there's one source of truth and nothing to reconcile.
  function _respDayKey(){
    if(typeof viewDate!=="undefined"&&viewDate)return viewDate;
    if(typeof __state!=="undefined"&&__state&&__state.date)return __state.date;
    return "";
  }
  function loadRespSnoozed(){
    try{return JSON.parse(localStorage.getItem("pa-resp-snoozed-"+_respDayKey())||"{}");}catch(e){return {};}
  }
  function saveRespSnoozed(map){
    try{localStorage.setItem("pa-resp-snoozed-"+_respDayKey(),JSON.stringify(map||{}));}catch(e){}
  }
  // Already dropped onto the viewed day? (a live itinerary task links back via responsibilityId)
  function _respDroppedToday(id){
    if(typeof scheduled==="undefined")return false;
    return scheduled.some(e=>e&&e.responsibilityId===id&&!(typeof isDeleted==="function"&&isDeleted(e)));
  }
  // The "close enough to needing to be done" set: active, not as-needed, score
  // past the due line (70, same threshold the old sidebar filter used) or its
  // preferred day is today — minus anything already dropped, done, or snoozed.
  function getDueRepeatResponsibilities(){
    const snoozed=loadRespSnoozed();
    return getResponsibilities().map(item=>{
      const p=item.properties||{};
      if((p.status||"active")!=="active")return null;
      if(isAsNeeded(p))return null;
      const t=responsibilityTiming(p);
      const preferred=preferredCompletionInfo(p);
      const score=Number(p.importanceScore||t.progress||0);
      if(!(score>=70||preferred.due))return null;
      if(snoozed[item.id])return null;
      if(_respDroppedToday(item.id))return null;
      const tree=(p.templateTree&&p.templateTree.root)?p.templateTree:null;
      return {
        id:item.id,
        title:p.title||"(untitled)",
        score:Math.round(score),
        scoreClass:(typeof scoreClass==="function")?scoreClass(score):"",
        dueLabel:dueLabel(p),
        cadenceLabel:cadenceLabel(p),
        estimatedMinutes:Number(p.estimatedMinutes)||30,
        overdue:t.remaining!=null&&t.remaining<0,
        isShell:!!tree,
        childCount:tree?((tree.root.children||[]).length):0,
        preferredDue:!!preferred.due
      };
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
  }
  // Complete straight from the triage card: reset the cadence, no task added.
  async function completeRepeatResponsibility(id){
    try{
      const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({completedAt:new Date().toISOString()})});
      if(!res.ok)throw new Error(res.statusText);
      await loadResponsibilities();
      if(typeof showToast==="function")showToast("Done — clock reset","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Complete failed: "+(e.message||e),"error");
    }
  }
  // "Not now": hide from the strip for the rest of today; returns tomorrow if still due.
  function snoozeRepeatResponsibility(id){
    const map=loadRespSnoozed();map[id]=1;saveRespSnoozed(map);
    if(typeof buildScheduleTriage==="function")buildScheduleTriage();
  }

  function getResponsibilities(){
    return _items.filter(i=>(i.properties||{}).kind==="responsibility_item");
  }

  async function loadResponsibilities(){
    try{
      const res=await fetch("/api/responsibilities");
      if(!res.ok)throw new Error(res.statusText);
      const data=await res.json();
      _items=data.items||[];
      renderRepeatResponsibilitiesSidebar();
      // Due responsibilities surface in the Itinerary triage strip — repaint it
      // now that the rows (and their scores) are known.
      if(typeof buildScheduleTriage==="function")buildScheduleTriage();
      return _items;
    }catch(e){
      if(typeof showToast==="function")showToast("Could not load responsibilities: "+(e.message||e),"error");
      return [];
    }
  }

  function resetScheduleFromBase(){
    if(typeof INIT_SCHED==="undefined"||typeof scheduled==="undefined")return;
    scheduled=JSON.parse(JSON.stringify(INIT_SCHED||[]));
  }

  function repaintScheduleNow(){
    if(typeof buildSchedule==="function")buildSchedule();
    if(typeof buildScheduled==="function")buildScheduled();
    if(typeof buildScheduleSoon==="function")buildScheduleSoon();
    if(typeof buildProgress==="function")buildProgress();
    if(typeof updateStats==="function")updateStats();
    if(typeof updateSync==="function")updateSync();
    if(typeof _updateTaskMenusBadge==="function")_updateTaskMenusBadge();
    if(typeof schedView!=="undefined"&&schedView==="actual"&&typeof buildActualView==="function")buildActualView();
  }

  async function refreshScheduleAfterResponsibilityChange(){
    const date=typeof viewDate!=="undefined"&&viewDate
      ? viewDate
      : (window.__DCC_STATE__&&window.__DCC_STATE__.date);
    if(window.blockStore&&date){
      try{await window.blockStore.loadDay(date);}catch(e){console.warn("[responsibilities] schedule refresh failed",e);}
    }
    resetScheduleFromBase();
    if(typeof reloadPersistedEdits==="function")reloadPersistedEdits();
    repaintScheduleNow();
  }

  function sidebarItems(){
    const q=_sidebarQuery.trim().toLowerCase();
    let items=getResponsibilities();
    if(_sidebarFilter==="active")items=items.filter(i=>((i.properties||{}).status||"active")==="active");
    else if(_sidebarFilter==="due")items=items.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived");
    else if(_sidebarFilter==="archived")items=items.filter(i=>(i.properties||{}).status==="archived");
    else if(["green","blue","yellow","red"].includes(_sidebarFilter)){
      items=items.filter(i=>(i.properties||{}).status!=="archived" && scoreClass(Number((i.properties||{}).importanceScore||0))===_sidebarFilter);
    }
    if(q){
      items=items.filter(item=>{
        const p=item.properties||{};
        const subtasks=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks.join(" "):"";
        return [p.title,p.domain,p.area,p.capacityBucket,subtasks].join(" ").toLowerCase().includes(q);
      });
    }
    return items.sort((a,b)=>{
      const ap=a.properties||{}, bp=b.properties||{};
      if(_sidebarSort==="title")return String(ap.title||"").localeCompare(String(bp.title||""));
      if(_sidebarSort==="cadence")return cadenceSortDays(ap)-cadenceSortDays(bp);
      if(_sidebarSort==="duration")return Number(ap.estimatedMinutes||30)-Number(bp.estimatedMinutes||30);
      if(_sidebarSort==="last-completed"){
        const at=ap.lastCompletedAt?Date.parse(ap.lastCompletedAt):0;
        const bt=bp.lastCompletedAt?Date.parse(bp.lastCompletedAt):0;
        return at-bt;
      }
      return Number(bp.importanceScore||0)-Number(ap.importanceScore||0);
    });
  }

  function renderRepeatResponsibilitiesSidebar(){
    const mount=document.getElementById("repeat-responsibilities-list");
    const all=getResponsibilities();
    const due=all.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived").length;
    const badge=document.getElementById("repeat-responsibilities-section-count");
    if(badge){badge.textContent=due;badge.style.display=due?"":"none";}
    if(typeof _updateTaskMenusBadge==="function")_updateTaskMenusBadge();
    if(!mount)return;
    const items=sidebarItems();
    if(!items.length){
      mount.innerHTML='<div class="delegated-empty">'+(_sidebarQuery?'No repeat responsibilities match that search.':'No repeat responsibilities yet.')+'</div>';
      return;
    }
    mount.innerHTML=items.map(item=>{
      const p=item.properties||{};
      const score=Number(p.importanceScore||0);
      const cls=scoreClass(score);
      const timing=responsibilityTiming(p);
      const subtasks=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
      const preferred=preferredCompletionSummary(p);
      const asNeeded=isAsNeeded(p);
      const expanded=_sidebarExpanded.has(item.id);
      return '<div class="repeat-resp-card '+cls+(expanded?' expanded':'')+'" data-id="'+esc(item.id)+'">'+
        (asNeeded?'<button type="button" class="repeat-resp-score resp-score resp-score-plus" data-act="schedule-pick" title="Schedule for today" aria-label="Schedule for today">+</button>':'<button type="button" class="repeat-resp-score resp-score '+cls+'" data-act="schedule-pick" title="Schedule for today" aria-label="Schedule '+esc(p.title||"repeat responsibility")+' for today">'+score+'</button>')+
        '<div class="repeat-resp-main" role="button" tabindex="0" data-act="toggle" aria-expanded="'+(expanded?'true':'false')+'">'+
          '<div class="repeat-resp-title-row">'+
            '<div class="repeat-resp-title">'+esc(p.title||"(untitled)")+'</div>'+
          '</div>'+
          (expanded?'<div class="repeat-resp-details">'+
            '<div class="repeat-resp-meter"><span class="'+cls+'" style="width:'+timing.progress+'%"></span></div>'+
            '<div class="repeat-resp-meta">'+
              '<span>'+cadenceLabel(p)+'</span>'+
              (asNeeded?'':'<span>'+esc(dueLabel(p))+'</span>')+
              '<span>'+esc(p.estimatedMinutes||30)+'m</span>'+
              '<span>'+esc(daysAgo(p.lastCompletedAt))+'</span>'+
            '</div>'+
            (subtasks.length?'<div class="repeat-resp-subtasks">'+subtasks.slice(0,4).map(s=>'<span>'+esc(s)+'</span>').join("")+(subtasks.length>4?'<span>+'+(subtasks.length-4)+'</span>':'')+'</div>':'')+
            (preferred?'<div class="resp-preferred-nudge">'+esc(preferred)+'</div>':'')+
          '</div>':'')+
        '</div>'+
        '<div class="repeat-resp-actions">'+
          '<button type="button" data-act="complete">Complete</button>'+
          (expanded?'<button type="button" data-act="edit">Edit</button><button type="button" class="danger" data-act="remove">Remove</button>':'')+
        '</div>'+
      '</div>';
    }).join("");
    mount.querySelectorAll(".repeat-resp-card [data-act]").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.stopPropagation();
        const card=btn.closest(".repeat-resp-card");
        const id=card&&card.dataset.id;
        if(!id)return;
        if(btn.dataset.act==="toggle"){
          if(_sidebarExpanded.has(id))_sidebarExpanded.delete(id);
          else _sidebarExpanded.add(id);
          renderRepeatResponsibilitiesSidebar();
          return;
        }
        handleCardAction(id,btn.dataset.act);
      });
      if(btn.dataset.act==="toggle"){
        btn.addEventListener("keydown",e=>{
          if(e.key!=="Enter"&&e.key!==" ")return;
          e.preventDefault();
          btn.click();
        });
      }
    });
  }

  // Drop a repeat responsibility onto today via the shared time-bucket picker.
  // A SHELL responsibility (templateTree) rebuilds the whole saved shell + its
  // children through window.attachTemplateChildren; a flat one keeps the classic
  // single-task + flat-default-subtasks path. Either way the created task carries
  // responsibilityId so checking it off resets the cadence. Shared by the sidebar
  // score button, the triage "Add to day" card, and the manage-modal row.
  function scheduleRepeatResponsibility(id){
    const item=_items.find(i=>i.id===id);
    if(!item)return;
    const p=item.properties||{};
    const title=p.title||"(untitled)";
    const dur=Number(p.estimatedMinutes)||30;
    const tags=["responsibility",p.domain,p.area,p.capacityBucket].filter(Boolean);
    const tree=(p.templateTree&&p.templateTree.root)?p.templateTree:null;
    // SHELL responsibility: drop the whole saved shell onto TODAY through the one
    // shared materializer (dedup + shell root + child attach in one place). It's
    // today-scoped on purpose — the child-attach primitives write to the viewed
    // day, so routing a shell through the day-picker would orphan its children on
    // a different day. Flat single-task responsibilities keep the day/time picker.
    if(tree&&typeof window.materializeShellTemplate==="function"){
      window.materializeShellTemplate(tree,{
        responsibilityId:id,
        responsibilityTitle:title,
        source:"responsibility",
        tags:tags,
        onScheduled:function(){ loadResponsibilities(); }
      });
      return;
    }
    if(typeof openSchedulePicker!=="function"){
      if(typeof showToast==="function")showToast("Schedule picker unavailable","error");
      return;
    }
    const defaults=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
    openSchedulePicker(title,dur,{
      responsibilityId:id,
      responsibilityTitle:title,
      capacityBucket:p.capacityBucket||null,
      priority:"High",
      source:"responsibility",
      tags:tags,
      meta:"Responsibility · "+(p.area||p.domain||"general")+" · "+dur+"m",
      detail:p.description||"",
      onScheduled:function(info){
        try{
          if(typeof addSubtask==="function"&&info&&info.localId){
            defaults.forEach(function(t){if(t)addSubtask(info.localId,t);});
          }
        }catch(e){console.warn("[responsibilities] subtask attach failed",e);}
        loadResponsibilities();
      }
    });
  }

  async function handleCardAction(id,act){
    const item=_items.find(i=>i.id===id);
    if(!item)return;
    try{
      if(act==="schedule-pick"){
        // The score/"+" button: drop this responsibility onto today (shell or flat).
        scheduleRepeatResponsibility(id);
      }else if(act==="complete"){
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({completedAt:new Date().toISOString()})});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        await loadResponsibilities();
      }else if(act==="archive"||act==="activate"){
        await patchResponsibility(id,{status:act==="archive"?"archived":"active"});
        await loadResponsibilities();
      }else if(act==="remove"){
        const title=(item.properties&&item.properties.title)||"this repeat responsibility";
        if(!window.confirm('Remove "'+title+'"? This cannot be undone.'))return;
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id),{method:"DELETE"});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        _items=_items.filter(i=>i.id!==id);
        renderRepeatResponsibilitiesSidebar();
        if(typeof showToast==="function")showToast("Repeat responsibility removed","success");
      }else if(act==="edit"){
        openResponsibilityModal(id);
      }
    }catch(e){
      if(typeof showToast==="function")showToast("Responsibility action failed: "+(e.message||e),"error");
    }
  }

  function taskDurationMinutes(task){
    if(!task)return 30;
    if(task.durMin)return Number(task.durMin)||30;
    if(task.duration)return Number(task.duration)||30;
    if(task.durationMin)return Number(task.durationMin)||30;
    if(task.start&&task.end&&typeof pt==="function"){
      const mins=pt(task.end)-pt(task.start);
      if(mins>0)return mins;
    }
    return 30;
  }

  function defaultSubtasksFromTask(task){
    if(!task||!task.id||typeof loadSubtasks!=="function")return [];
    const subtasks=loadSubtasks()[task.id]||[];
    return subtasks.map(st=>st&&st.text).filter(Boolean);
  }

  function taskArea(task){
    const raw=String((task&&(task.stage||task.area||task.source||task.type))||"general").trim();
    return raw.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"")||"general";
  }

  function taskCapacityBucket(task){
    if(task&&task.capacityBucket)return task.capacityBucket;
    if(task&&task.type==="focus")return "deep_work";
    return "work_admin";
  }

  function responsibilityDefaultsFromTask(task){
    const title=String((task&&(task.title||task.text))||"").trim();
    // Saving a SHELL captures its whole subtree (the sequential container + its
    // child tasks) as a reusable templateTree, so dropping the responsibility
    // rebuilds the entire shell. A plain task keeps the flat single-task path.
    const isShell=!!(task&&window.TaskTypes&&(window.TaskTypes.isRollup(task)||window.TaskTypes.rule(task,"childLayout")==="sequential"));
    const templateTree=(isShell&&typeof captureShellTemplate==="function"&&task&&task.id&&typeof scheduled!=="undefined")
      ?captureShellTemplate(task.id,scheduled):null;
    return {
      title,
      domain:"professional",
      area:taskArea(task),
      cadence:"weekly",
      cadenceDays:7,
      asNeeded:false,
      estimatedMinutes:Math.max(1,taskDurationMinutes(task)),
      capacityBucket:taskCapacityBucket(task),
      defaultSubtasks:defaultSubtasksFromTask(task),
      status:"active",
      createdFrom:"task",
      templateTree:templateTree||undefined
    };
  }

  function getDefaultSubtasksSource(){
    return document.getElementById("resp-default-subtasks");
  }

  function readDefaultSubtasks(){
    const source=getDefaultSubtasksSource();
    return source?source.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):[];
  }

  function syncDefaultSubtasksFromRows(){
    const source=getDefaultSubtasksSource();
    if(!source)return;
    const rows=[...document.querySelectorAll("#resp-default-subtasks-list .resp-subtask-text")];
    source.value=rows.map(input=>input.value.trim()).filter(Boolean).join("\n");
  }

  function renderDefaultSubtasks(){
    const list=document.getElementById("resp-default-subtasks-list");
    if(!list)return;
    const items=readDefaultSubtasks();
    list.innerHTML="";
    if(!items.length){
      const empty=document.createElement("div");
      empty.className="resp-subtask-empty";
      empty.textContent="No default subtasks yet.";
      list.appendChild(empty);
      return;
    }
    items.forEach((text,index)=>{
      const row=document.createElement("div");
      row.className="resp-subtask-row";
      const box=document.createElement("span");
      box.className="resp-subtask-checkbox";
      box.setAttribute("aria-hidden","true");
      const input=document.createElement("input");
      input.className="resp-subtask-text";
      input.type="text";
      input.value=text;
      input.maxLength=200;
      input.setAttribute("aria-label","Default subtask");
      input.addEventListener("input",syncDefaultSubtasksFromRows);
      input.addEventListener("keydown",e=>{
        if(e.key==="Enter"){
          e.preventDefault();
          const addInput=document.getElementById("resp-default-subtask-input");
          if(addInput)addInput.focus();
        }
      });
      const remove=document.createElement("button");
      remove.type="button";
      remove.className="resp-subtask-remove";
      remove.textContent="x";
      remove.title="Remove";
      remove.setAttribute("aria-label","Remove default subtask");
      remove.addEventListener("click",()=>{
        const next=readDefaultSubtasks();
        next.splice(index,1);
        setDefaultSubtasks(next);
      });
      row.append(box,input,remove);
      list.appendChild(row);
    });
  }

  function setDefaultSubtasks(items){
    const source=getDefaultSubtasksSource();
    if(source)source.value=(items||[]).map(s=>String(s||"").trim()).filter(Boolean).join("\n");
    renderDefaultSubtasks();
  }

  function addDefaultSubtask(){
    const input=document.getElementById("resp-default-subtask-input");
    const text=String((input&&input.value)||"").trim();
    if(!text)return;
    const items=readDefaultSubtasks();
    items.push(text);
    if(input)input.value="";
    setDefaultSubtasks(items);
    if(input)input.focus();
  }

  async function responseErrorMessage(res){
    const fallback=res.statusText||("HTTP "+res.status);
    try{
      const data=await res.clone().json();
      return data.error||data.message||fallback;
    }catch(e){}
    try{
      const text=await res.text();
      return text||fallback;
    }catch(e){
      return fallback;
    }
  }

  function openResponsibilityModal(id,defaults){
    const item=id?_items.find(i=>i.id===id):null;
    const p=item?(item.properties||{}):(defaults||{});
    // Carry any saved shell structure through the modal (editing keeps the
    // existing tree; a shell-sourced create stashes the freshly captured one).
    _pendingTemplateTree=(p.templateTree&&p.templateTree.root)?p.templateTree:null;
    const today=new Date();
    const todayIso=today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
    document.getElementById("resp-id").value=id||"";
    document.getElementById("resp-title").value=p.title||"";
    document.getElementById("resp-domain").value=p.domain||"professional";
    document.getElementById("resp-area").value=p.area||"general";
    const preset=document.getElementById("resp-cadence-preset");
    if(preset)preset.value=cadencePreset(p);
    document.getElementById("resp-cadence-days").value=p.cadenceDays||7;
    syncCadencePreset();
    document.getElementById("resp-estimated-minutes").value=p.estimatedMinutes||30;
    document.getElementById("resp-preferred-cadence").value=p.preferredCompletionCadence||p.preferredCadence||"none";
    document.getElementById("resp-preferred-weekday").value=p.preferredDayOfWeek!=null?p.preferredDayOfWeek:today.getDay();
    document.getElementById("resp-preferred-month-day").value=p.preferredDayOfMonth||today.getDate();
    document.getElementById("resp-preferred-year-month").value=p.preferredMonth||today.getMonth()+1;
    document.getElementById("resp-preferred-year-day").value=p.preferredMonthDay||today.getDate();
    document.getElementById("resp-preferred-custom-anchor").value=p.preferredCustomAnchor||p.preferredDate||todayIso;
    document.getElementById("resp-preferred-custom-days").value=p.preferredCustomDays||p.cadenceDays||30;
    syncPreferredCompletion();
    document.getElementById("resp-capacity-bucket").value=p.capacityBucket||"work_admin";
    const menusMount=document.getElementById("resp-menus-list");
    if(menusMount){
      menusMount.dataset.selected=(Array.isArray(p.menus)?p.menus:[]).join(",");
      if(typeof window.renderRespMenuField==="function")window.renderRespMenuField();
    }
    const subtaskInput=document.getElementById("resp-default-subtask-input");
    if(subtaskInput)subtaskInput.value="";
    setDefaultSubtasks(Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[]);
    document.getElementById("resp-modal-title").textContent=id?"Edit repeat responsibility":(p.createdFrom==="task"?"Task to repeat responsibility":"New repeat responsibility");
    document.getElementById("responsibility-modal-overlay").classList.add("open");
    setTimeout(()=>document.getElementById("resp-title").focus(),20);
  }

  function closeResponsibilityModal(){
    const overlay=document.getElementById("responsibility-modal-overlay");
    if(overlay)overlay.classList.remove("open");
  }

  // The library lives in a dedicated modal now (the drawer just opens it). Same
  // tool/list IDs as before, so renderRepeatResponsibilitiesSidebar populates it.
  function openResponsibilityManager(){
    const overlay=document.getElementById("responsibility-manage-overlay");
    if(!overlay)return;
    overlay.classList.add("open");
    renderRepeatResponsibilitiesSidebar();
    const search=document.getElementById("repeat-responsibilities-search");
    if(search)setTimeout(()=>search.focus(),20);
  }
  function closeResponsibilityManager(){
    const overlay=document.getElementById("responsibility-manage-overlay");
    if(overlay)overlay.classList.remove("open");
  }

  function formProps(){
    const cadence=document.getElementById("resp-cadence-preset")?.value||"custom";
    const cadenceMap={daily:1,weekly:7,biweekly:14,monthly:30};
    const customDays=Math.max(1,parseInt(document.getElementById("resp-cadence-days").value,10)||7);
    const cadenceDays=cadence==="as_needed"?null:(cadenceMap[cadence]||customDays);
    const preferredCadence=document.getElementById("resp-preferred-cadence")?.value||"none";
    return {
      templateTree:(_pendingTemplateTree&&_pendingTemplateTree.root)?_pendingTemplateTree:undefined,
      title:document.getElementById("resp-title").value.trim(),
      domain:document.getElementById("resp-domain").value,
      area:document.getElementById("resp-area").value.trim()||"general",
      cadence,
      cadenceDays,
      asNeeded:cadence==="as_needed",
      estimatedMinutes:Math.max(1,parseInt(document.getElementById("resp-estimated-minutes").value,10)||30),
      preferredCompletionCadence:preferredCadence,
      preferredDayOfWeek:Math.max(0,Math.min(6,parseInt(document.getElementById("resp-preferred-weekday").value,10)||0)),
      preferredDayOfMonth:Math.max(1,Math.min(31,parseInt(document.getElementById("resp-preferred-month-day").value,10)||1)),
      preferredMonth:Math.max(1,Math.min(12,parseInt(document.getElementById("resp-preferred-year-month").value,10)||1)),
      preferredMonthDay:Math.max(1,Math.min(31,parseInt(document.getElementById("resp-preferred-year-day").value,10)||1)),
      preferredCustomAnchor:document.getElementById("resp-preferred-custom-anchor").value||"",
      preferredCustomDays:Math.max(1,parseInt(document.getElementById("resp-preferred-custom-days").value,10)||30),
      capacityBucket:document.getElementById("resp-capacity-bucket").value,
      defaultSubtasks:readDefaultSubtasks(),
      menus:readSelectedMenus(),
      status:"active"
    };
  }

  function readSelectedMenus(){
    return Array.from(document.querySelectorAll("#resp-menus-list input[type=checkbox]:checked")).map(c=>c.value);
  }

  function syncCadencePreset(){
    const preset=document.getElementById("resp-cadence-preset");
    const wrap=document.getElementById("resp-cadence-days-wrap");
    const input=document.getElementById("resp-cadence-days");
    if(!preset||!wrap||!input)return;
    const map={daily:1,weekly:7,biweekly:14,monthly:30};
    const custom=preset.value==="custom";
    wrap.style.display=custom?"":"none";
    if(map[preset.value])input.value=map[preset.value];
    input.disabled=preset.value==="as_needed";
  }

  function syncPreferredCompletion(){
    const preset=document.getElementById("resp-preferred-cadence");
    const grid=document.getElementById("resp-preferred-grid");
    if(!preset||!grid)return;
    const active=preset.value||"none";
    grid.style.display=active==="none"?"none":"grid";
    grid.querySelectorAll(".resp-preferred-field").forEach(field=>{
      field.style.display=field.dataset.preferredField===active?"":"none";
    });
  }

  async function patchResponsibility(id,props){
    const res=await fetch("/api/responsibilities/"+encodeURIComponent(id),{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({properties:props})
    });
    if(!res.ok)throw new Error(await responseErrorMessage(res));
    return res.json();
  }

  async function saveResponsibility(){
    const id=document.getElementById("resp-id").value||null;
    const props=formProps();
    if(!props.title){if(typeof showToast==="function")showToast("Title is required","error");return;}
    try{
      const res=await fetch(id?"/api/responsibilities/"+encodeURIComponent(id):"/api/responsibilities",{
        method:id?"PATCH":"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({properties:props})
      });
      if(!res.ok)throw new Error(await responseErrorMessage(res));
      closeResponsibilityModal();
      await loadResponsibilities();
      if(typeof showToast==="function")showToast("Responsibility saved","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Save failed: "+(e.message||e),"error");
    }
  }

  async function markResponsibilityTaskCompleted(ev){
    if(!ev||!ev.responsibilityId)return;
    try{
      await fetch("/api/responsibilities/"+encodeURIComponent(ev.responsibilityId)+"/complete",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({taskId:ev.id,completedAt:new Date().toISOString()})
      });
      await loadResponsibilities();
    }catch(e){console.warn("[responsibilities] completion sync failed",e);}
  }

  function bindResponsibilities(){
    const repeatSearch=document.getElementById("repeat-responsibilities-search");
    if(repeatSearch)repeatSearch.addEventListener("input",()=>{_sidebarQuery=repeatSearch.value||"";renderRepeatResponsibilitiesSidebar();});
    const repeatFilter=document.getElementById("repeat-responsibilities-filter");
    if(repeatFilter)repeatFilter.addEventListener("change",()=>{_sidebarFilter=repeatFilter.value||"active";renderRepeatResponsibilitiesSidebar();});
    const repeatSort=document.getElementById("repeat-responsibilities-sort");
    if(repeatSort)repeatSort.addEventListener("change",()=>{_sidebarSort=repeatSort.value||"urgency";renderRepeatResponsibilitiesSidebar();});
    const repeatNew=document.getElementById("repeat-responsibilities-new");
    if(repeatNew)repeatNew.addEventListener("click",()=>openResponsibilityModal(null));
    const manageOpen=document.getElementById("repeat-responsibilities-open");
    if(manageOpen)manageOpen.addEventListener("click",openResponsibilityManager);
    const manageClose=document.getElementById("responsibility-manage-close");
    if(manageClose)manageClose.addEventListener("click",closeResponsibilityManager);
    const manageOverlay=document.getElementById("responsibility-manage-overlay");
    if(manageOverlay)manageOverlay.addEventListener("click",e=>{if(e.target===manageOverlay)closeResponsibilityManager();});
    const cadencePresetEl=document.getElementById("resp-cadence-preset");
    if(cadencePresetEl)cadencePresetEl.addEventListener("change",syncCadencePreset);
    const preferredCadenceEl=document.getElementById("resp-preferred-cadence");
    if(preferredCadenceEl)preferredCadenceEl.addEventListener("change",syncPreferredCompletion);
    const subtaskAdd=document.getElementById("resp-default-subtask-add");
    if(subtaskAdd)subtaskAdd.addEventListener("click",addDefaultSubtask);
    const subtaskInput=document.getElementById("resp-default-subtask-input");
    if(subtaskInput)subtaskInput.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();addDefaultSubtask();}});
    const cancel=document.getElementById("resp-cancel");
    if(cancel)cancel.addEventListener("click",closeResponsibilityModal);
    const save=document.getElementById("resp-save");
    if(save)save.addEventListener("click",saveResponsibility);
    const overlay=document.getElementById("responsibility-modal-overlay");
    if(overlay)overlay.addEventListener("click",e=>{if(e.target===overlay)closeResponsibilityModal();});
  }

  document.addEventListener("DOMContentLoaded",bindResponsibilities);
  window.loadResponsibilities=loadResponsibilities;
  window.refreshScheduleAfterResponsibilityChange=refreshScheduleAfterResponsibilityChange;
  window.openResponsibilityModalWithMenus=function(menus){ openResponsibilityModal(null,{menus:Array.isArray(menus)?menus:[]}); };
  window.renderRepeatResponsibilitiesSidebar=renderRepeatResponsibilitiesSidebar;
  window.markResponsibilityTaskCompleted=markResponsibilityTaskCompleted;
  // Triage-strip surfacing (Part C): the itinerary triage renderer reads these.
  window.getDueRepeatResponsibilities=getDueRepeatResponsibilities;
  window.scheduleRepeatResponsibility=scheduleRepeatResponsibility;
  window.completeRepeatResponsibility=completeRepeatResponsibility;
  window.snoozeRepeatResponsibility=snoozeRepeatResponsibility;
  window.openRepeatResponsibilityManager=function(){ if(typeof openResponsibilityManager==="function")openResponsibilityManager(); };
  window.openRepeatResponsibilityFromTask=function(task){
    const defaults=responsibilityDefaultsFromTask(task||{});
    if(!defaults.title){
      if(typeof showToast==="function")showToast("Task title is required","error");
      return;
    }
    openResponsibilityModal(null,defaults);
  };
})();
