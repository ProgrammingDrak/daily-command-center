// ======== RESPONSIBILITIES TAB ========
// Responsibilities are durable obligations. They become scheduled tasks only
// when their cadence/score or a trigger makes them actionable.
(function(){
  let _items = [];
  // Saved shell structure staged for the create/edit modal. The modal reads/writes
  // scalar DOM fields, so a nested template can't ride a form input — it's stashed
  // here between openResponsibilityModal and formProps/saveResponsibility.
  let _pendingTemplateTree = null;
  let _seriesEditContext = null;
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

  function repeatType(props){ return props&&props.repeatType==="scheduled"?"scheduled":"readiness"; }
  function isScheduled(props){ return repeatType(props)==="scheduled"; }

  function scheduledResponsibilityLabels(props){
    props=props||{};
    const summary=String(props.recurrenceSummary||"Scheduled repeat").trim();
    let repeats=summary;
    if(/^Every\b/i.test(summary))repeats="Repeats "+summary.charAt(0).toLowerCase()+summary.slice(1);
    else if(/specific date/i.test(summary))repeats="Scheduled on "+summary;
    const first=Array.isArray(props.nextOccurrences)?props.nextOccurrences[0]:null;
    const nextDate=first&&first.instant?new Date(first.instant):null;
    const next=nextDate&&!isNaN(nextDate.getTime())
      ?"Next scheduled "+nextDate.toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})
      :"No future occurrences";
    return {repeats,next};
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
  // The due line. One constant, shared with delegated items via urgency.js; the
  // server's copy is DUE_THRESHOLD in lib/recurrence.js. Was hardcoded four
  // times (here twice more below, plus routes/blocks.js auto-schedule).
  const DUE_THRESHOLD=(window.urgency&&window.urgency.DUE_THRESHOLD)||75;

  // Delegates to the app's one "today" helper (state.js) rather than
  // re-implementing it, so a future clock-offset/viewDate nuance there applies here too.
  function _todayStr(){
    if(typeof _actualTodayStr==="function")return _actualTodayStr();
    const d=new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function _localTz(){
    try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"";}catch(e){return "";}
  }
  // Already dropped onto the viewed day? (a live itinerary task links back via responsibilityId)
  function _respDroppedToday(id){
    if(typeof scheduled==="undefined")return false;
    return DCC.TaskModel.selectNotDeleted(scheduled).some(e=>e.responsibilityId===id);
  }
  // Is an instance in flight on some OTHER day? This is the visible half of the
  // pause: instead of silently vanishing, the card says "scheduled for Thu" so
  // the quiet is explained rather than mysterious.
  function openInstanceInfo(p){
    if(!p||!(p.openInstanceBlockId||p.openInstanceLocalId))return null;
    const date=p.openInstanceDate||null;
    const today=_todayStr();
    let label="scheduled";
    if(date){
      if(date===today)label="scheduled today";
      else{
        const d=new Date(date+"T00:00:00");
        label=isNaN(d.getTime())?("scheduled "+date)
          :("scheduled "+d.toLocaleDateString(undefined,{weekday:"short"})+(date>today?"":" (past)"));
      }
    }
    return {date:date,label:label};
  }
  // A dated pause EXPIRES on its until-date, same rule as skippedInfo below and as
  // the server's recurrence.isPaused. Without the comparison a lapsed pause left
  // the server scoring the item 100 while the strip kept refusing to offer it and
  // the chip read "paused until <a date in the past>" — the item was only
  // recoverable by noticing the stale chip and clicking Resume, which is the same
  // class of stuck-quiet failure this phase exists to remove.
  function pausedInfo(p){
    if(!p)return null;
    if((p.status||"active")==="archived")return {label:"paused",indefinite:true};
    if(!p.pausedUntil)return null;
    if(p.pausedUntil==="forever")return {label:"paused",indefinite:true};
    if(String(p.pausedUntil).slice(0,10)<=_todayStr())return null;
    return {label:"paused until "+p.pausedUntil,indefinite:false};
  }
  function skippedInfo(p){
    if(!p||!p.skipUntil)return null;
    if(String(p.skipUntil).slice(0,10)<=_todayStr())return null;
    return {label:"skipped until "+p.skipUntil};
  }
  // The "close enough to needing to be done" set: active, not as-needed, score
  // past the due line or its preferred day is due — minus anything already
  // dropped, in flight on another day, paused, or skipped this cycle.
  //
  // THE SERVER DECIDES, THE CLIENT READS. `suppressed` and `preferredDue` are
  // stamped by normalizeResponsibility, computed in the user's own zone (the read
  // sends it — see loadResponsibilities). This file used to re-derive both from its
  // own copy of the date math, and the copies drifted: the client's preferred-day
  // predicate never got the completed-occurrence guard, so pressing Complete on a
  // preferred day re-offered the identical card immediately even though the
  // server-side fix was correct. preferredCompletionInfo stays, for LABELS only.
  function getDueRepeatResponsibilities(){
    return getResponsibilities().map(item=>{
      const p=item.properties||{};
      if(isScheduled(p))return null;
      if((p.status||"active")!=="active")return null;
      if(isAsNeeded(p))return null;
      // THE PAUSE (plus pause/skip). One predicate, evaluated server-side: an
      // instance in flight on ANY day, an unexpired pause, or a skipped cycle.
      // Before D1 the in-flight check existed only for the day being viewed, so
      // scheduling for tomorrow silenced nothing.
      if(p.suppressed)return null;
      // Fall back to the local gates only for a payload predating this field.
      if(p.suppressed===undefined&&(openInstanceInfo(p)||pausedInfo(p)||skippedInfo(p)))return null;
      if(_respDroppedToday(item.id))return null;
      const t=responsibilityTiming(p);
      const preferred=preferredCompletionInfo(p);
      const preferredDue=(p.preferredDue!==undefined)?!!p.preferredDue:!!preferred.due;
      // Branch on PRESENCE, not truthiness: a server score of exactly 0 is a real
      // answer ("this occurrence is already satisfied"), and `||` would have
      // discarded it and fallen back to the client's own elapsed math — re-offering
      // a card the server had just ruled done.
      const score=(p.importanceScore!==undefined)?(Number(p.importanceScore)||0):Number(t.progress||0);
      if(!(score>=DUE_THRESHOLD||preferredDue))return null;
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
        preferredDue:preferredDue
      };
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
  }
  // Complete straight from the triage card: drop the responsibility onto today's
  // itinerary as a FINISHED task and check it off through the normal completion
  // path (toggleDone), so it actually shows on the schedule, banks its slot
  // points, and — because the created task carries responsibilityId — resets the
  // cadence clock via db.js's propagateResponsibilityDone (C5b: the row write does it;
  // it used to go through the client-side markResponsibilityTaskCompleted). Mirrors
  // "Add to day" then
  // an immediate check-off; the old version only reset the clock and left the
  // itinerary untouched (nothing showed up as done on the schedule).
  function completeRepeatResponsibility(id){
    try{
      // The triage strip isn't date-gated, so this button is reachable while the
      // itinerary is navigated to another day. Completing there would mis-route
      // through toggleDone's non-today branches (past = confirm modal + no
      // completion, future = "marked done on <date>") while we still fired a
      // "logged on today" toast. "Done from triage" means "I did it now" — only
      // complete on today; otherwise send the user back to today.
      const _today=(typeof _actualTodayStr==="function")?_actualTodayStr():null;
      const _cur=(typeof viewDate!=="undefined"&&viewDate)||(window.__DCC_STATE__&&window.__DCC_STATE__.date)||null;
      if(_today&&_cur&&_cur!==_today){
        if(typeof showToast==="function")showToast("Switch to today to complete this","info");
        return;
      }
      const item=_items.find(i=>i.id===id);
      if(!item){if(typeof showToast==="function")showToast("Responsibility not found","error");return;}
      const p=item.properties||{};
      const title=p.title||"(untitled)";
      // Already materialized on the viewed day? Check that occurrence off instead
      // of minting a duplicate (also covers a rapid double-click).
      if(typeof scheduled!=="undefined"){
        const existing=DCC.TaskModel.selectNotDeleted(scheduled).find(e=>e.responsibilityId===id);
        if(existing){
          if(typeof isDone!=="function"||!isDone(existing)){
            if(window.TaskTypes&&window.TaskTypes.isRollup&&window.TaskTypes.isRollup(existing))_completeResponsibilitySubtree(existing.id);
            else if(typeof toggleDone==="function")toggleDone(existing.id);
          }
          loadResponsibilities();
          if(typeof showToast==="function")showToast("Done — logged on today","success");
          return;
        }
      }
      const dur=Number(p.estimatedMinutes)||30;
      const tags=["responsibility",p.domain,p.area,p.capacityBucket].filter(Boolean);
      const tree=(p.templateTree&&p.templateTree.root)?p.templateTree:null;
      const defaults=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
      const finish=()=>{loadResponsibilities();if(typeof showToast==="function")showToast("Done — logged on today","success");};
      // SHELL: rebuild the whole saved shell onto today (dedup-guarded), then
      // complete its subtree so the rollup banks its bonus and shows done.
      if(tree&&typeof window.materializeShellTemplate==="function"){
        window.materializeShellTemplate(tree,{
          responsibilityId:id,responsibilityTitle:title,source:"responsibility",tags:tags,
          onScheduled:function(info){if(info&&info.localId)_completeResponsibilitySubtree(info.localId);finish();}
        });
        return;
      }
      // FLAT: quick-add onto today (no picker), attach any default subtasks, then
      // check it off — toggleDone banks points, resets the clock, persists, repaints.
      if(typeof insertTaskNow!=="function"){if(typeof showToast==="function")showToast("Cannot add task","error");return;}
      const curDate=(window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||"";
      insertTaskNow(title,dur,{
        type:"task",responsibilityId:id,responsibilityTitle:title,priority:"High",
        source:"responsibility",tags:tags,detail:p.description||"",
        idempotencyKey:"resp:"+id+":"+curDate,
        onScheduled:function(info){
          try{if(typeof addSubtask==="function"&&info&&info.localId){defaults.forEach(function(t){if(t)addSubtask(info.localId,t,{date:info.dateStr,parentStart:info.start});});}}catch(e){}
          if(info&&info.localId&&typeof toggleDone==="function")toggleDone(info.localId);
          finish();
        }
      });
    }catch(e){
      if(typeof showToast==="function")showToast("Complete failed: "+(e.message||e),"error");
    }
  }
  // Complete every ride-along descendant of a materialized shell root, leaf-first,
  // so no still-open ride-along gets ejected mid-completion; the rollup ancestors
  // then auto-complete (and bank their bonus) via _autoCompleteShellAncestors.
  // Subtasks are skipped — they cascade automatically when their parent completes.
  function _completeResponsibilitySubtree(rootId){
    if(typeof scheduled==="undefined"||typeof childrenOf!=="function"||typeof toggleDone!=="function")return;
    (function walk(pid){
      childrenOf(pid,scheduled).forEach(function(c){
        if(typeof relOf==="function"&&relOf(c)==="subtask")return;
        walk(c.id);
        if(typeof isDone==="function"&&isDone(c))return;
        toggleDone(c.id);
      });
    })(rootId);
    const root=scheduled.find(function(e){return e.id===rootId;});
    if(root&&typeof isDone==="function"&&!isDone(root)&&!DCC.TaskModel.selectOpen(childrenOf(rootId,scheduled)).length){
      toggleDone(rootId);
    }
  }
  // SKIP THIS CYCLE. Replaces the old "not now" snooze, which wrote a
  // pa-resp-snoozed-<viewDate> localStorage map: one day only, one browser only,
  // never synced, never garbage-collected. This is server-side and cross-device,
  // and it is deliberately NOT Complete — it hides the item until its next
  // occurrence without claiming it was done, so urgency keeps accruing
  // underneath and it comes back louder instead of resetting.
  async function skipRepeatResponsibility(id){
    try{
      await postResponsibilityAction(id,"skip",{tz:_localTz()});
      await loadResponsibilities();
      if(typeof showToast==="function")showToast("Skipped this cycle","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Skip failed: "+(e.message||e),"error");
    }
  }
  async function pauseRepeatResponsibility(id,until){
    try{
      await postResponsibilityAction(id,"pause",until?{until:until}:{});
      await loadResponsibilities();
      if(typeof showToast==="function")showToast(until?("Paused until "+until):"Paused","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Pause failed: "+(e.message||e),"error");
    }
  }
  async function resumeRepeatResponsibility(id){
    try{
      await postResponsibilityAction(id,"resume",{});
      await loadResponsibilities();
      if(typeof showToast==="function")showToast("Resumed","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Resume failed: "+(e.message||e),"error");
    }
  }
  async function postResponsibilityAction(id,action,body){
    const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/"+action,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})
    });
    if(!res.ok)throw new Error(await responseErrorMessage(res));
    return res.json();
  }

  function getResponsibilities(){
    return _items.filter(i=>(i.properties||{}).kind==="responsibility_item");
  }

  async function loadResponsibilities(){
    try{
      // Send the browser's zone so the server evaluates the preferred-completion
      // day on the USER's calendar day, not the Node process's.
      const tz=_localTz();
      const res=await fetch("/api/responsibilities"+(tz?"?tz="+encodeURIComponent(tz):""));
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
    else if(_sidebarFilter==="due")items=items.filter(i=>Number((i.properties||{}).importanceScore||0)>=DUE_THRESHOLD && (i.properties||{}).status!=="archived");
    else if(_sidebarFilter==="readiness")items=items.filter(i=>!isScheduled(i.properties||{}));
    else if(_sidebarFilter==="scheduled")items=items.filter(i=>isScheduled(i.properties||{}));
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

  function splitRepeatResponsibilityItems(items){
    const timed=[];
    const asNeeded=[];
    for(const item of items||[]){
      const props=(item&&item.properties)||{};
      if(!isScheduled(props)&&isAsNeeded(props))asNeeded.push(item);
      else timed.push(item);
    }
    return {timed,asNeeded};
  }

  function renderRepeatResponsibilitiesSidebar(){
    const mount=document.getElementById("repeat-responsibilities-list");
    const asNeededMount=document.getElementById("repeat-responsibilities-as-needed-list");
    const all=getResponsibilities();
    const due=all.filter(i=>Number((i.properties||{}).importanceScore||0)>=DUE_THRESHOLD && (i.properties||{}).status!=="archived").length;
    const badge=document.getElementById("repeat-responsibilities-section-count");
    if(badge){badge.textContent=due;badge.style.display=due?"":"none";}
    if(typeof _updateTaskMenusBadge==="function")_updateTaskMenusBadge();
    if(!mount||!asNeededMount)return;
    const items=sidebarItems();
    const groups=splitRepeatResponsibilityItems(items);
    const cardHtml=item=>{
      const p=item.properties||{};
      const score=Number(p.importanceScore||0);
      const cls=scoreClass(score);
      const timing=responsibilityTiming(p);
      const subtasks=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
      const preferred=preferredCompletionSummary(p);
      const asNeeded=isAsNeeded(p);
      const expanded=_sidebarExpanded.has(item.id);
      // Make the three quiet states VISIBLE. A responsibility that has gone
      // silent because an instance is in flight, because it is paused, or
      // because this cycle was skipped now says so on its own card instead of
      // just not appearing.
      const inflight=openInstanceInfo(p);
      const paused=pausedInfo(p);
      const skipped=skippedInfo(p);
      const scheduledMode=isScheduled(p);
      const scheduleLabels=scheduledMode?scheduledResponsibilityLabels(p):null;
      // Pill shape is inlined rather than added to dashboard.css: that file is a
      // render surface Track C owns, and the recurring triage card already sets
      // the same precedent for inlining a chip's shape.
      const chipCss='display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;padding:2px 7px;border-radius:100px;white-space:nowrap;margin-left:6px;';
      const stateChip=inflight?'<span class="resp-state-chip inflight" style="'+chipCss+'background:rgba(59,130,246,0.18);color:var(--accent-light)">'+esc(inflight.label)+'</span>'
        :paused?'<span class="resp-state-chip paused" style="'+chipCss+'background:rgba(148,163,184,0.2);color:var(--text-muted)">'+esc(paused.label)+'</span>'
        :skipped?'<span class="resp-state-chip skipped" style="'+chipCss+'background:var(--amber-bg);color:var(--amber)">'+esc(skipped.label)+'</span>':'';
      const typeChip='<span class="resp-state-chip repeat-type" style="'+chipCss+'background:rgba(139,92,246,0.14);color:var(--purple,#a78bfa)">'+(scheduledMode?'Scheduled':'Readiness')+'</span>';
      return '<div class="repeat-resp-card '+cls+(expanded?' expanded':'')+(inflight?' inflight':'')+((paused||skipped)?' resp-quiet':'')+'" data-id="'+esc(item.id)+'">'+
        (scheduledMode?'<span class="repeat-resp-score resp-score scheduled" title="Scheduled repeat">&#8635;</span>'
          :(asNeeded?'<button type="button" class="repeat-resp-score resp-score resp-score-plus" data-act="schedule-pick" title="Schedule for today" aria-label="Schedule for today">+</button>':'<button type="button" class="repeat-resp-score resp-score '+cls+'" data-act="schedule-pick" title="Schedule for today" aria-label="Schedule '+esc(p.title||"repeat responsibility")+' for today">'+score+'</button>'))+
        '<div class="repeat-resp-main" role="button" tabindex="0" data-act="toggle" aria-expanded="'+(expanded?'true':'false')+'">'+
          '<div class="repeat-resp-title-row">'+
            '<div class="repeat-resp-title">'+esc(p.title||"(untitled)")+'</div>'+typeChip+stateChip+
          '</div>'+
          (scheduledMode?'<div class="repeat-resp-schedule-summary"><span>'+esc(scheduleLabels.repeats)+'</span><strong>'+esc(scheduleLabels.next)+'</strong></div>':'')+
          (expanded?'<div class="repeat-resp-details">'+
            (scheduledMode?'':'<div class="repeat-resp-meter"><span class="'+cls+'" style="width:'+timing.progress+'%"></span></div>')+
            '<div class="repeat-resp-meta">'+
              '<span>'+(scheduledMode?'Scheduled':'Readiness')+'</span>'+
              (scheduledMode?'':'<span>'+esc(cadenceLabel(p))+'</span>')+
              (scheduledMode?'':(asNeeded?'':'<span>'+esc(dueLabel(p))+'</span>'))+
              '<span>'+esc(p.estimatedMinutes||30)+'m</span>'+
              (scheduledMode?'':'<span>'+esc(daysAgo(p.lastCompletedAt))+'</span>')+
            '</div>'+
            (subtasks.length?'<div class="repeat-resp-subtasks">'+subtasks.slice(0,4).map(s=>'<span>'+esc(s)+'</span>').join("")+(subtasks.length>4?'<span>+'+(subtasks.length-4)+'</span>':'')+'</div>':'')+
            (!scheduledMode&&preferred?'<div class="resp-preferred-nudge">'+esc(preferred)+'</div>':'')+
          '</div>':'')+
        '</div>'+
        // Skip / Pause / Resume: the escapes that did not exist before D1. The
        // archive/activate handler had been in this file for months but NO
        // element in public/ or index.html ever carried data-act="archive" —
        // it was unreachable dead code. These buttons reach it.
        '<div class="repeat-resp-actions">'+
          (scheduledMode?'':'<button type="button" data-act="complete">Complete</button>')+
          (expanded?
            (scheduledMode?'':(inflight?'<button type="button" data-act="drop-instance" title="Forget the scheduled instance and resume the cadence">Un-schedule</button>':'<button type="button" data-act="skip" title="Skip this cycle without marking it done">Skip</button>'))+
            ((paused||(p.status||"active")!=="active")
              ?'<button type="button" data-act="activate" title="Resume this responsibility">Resume</button>'
              :'<button type="button" data-act="archive" title="Pause indefinitely">Pause</button>')+
            '<button type="button" data-act="edit">Edit</button><button type="button" class="danger" data-act="remove">Remove</button>'
          :'')+
        '</div>'+
      '</div>';
    };
    const noMatch=_sidebarQuery?'No repeat responsibilities match that search.':null;
    mount.innerHTML=groups.timed.length
      ?groups.timed.map(cardHtml).join("")
      :'<div class="delegated-empty">'+esc(noMatch||"No scheduled or cadence-based responsibilities.")+'</div>';
    asNeededMount.innerHTML=groups.asNeeded.length
      ?groups.asNeeded.map(cardHtml).join("")
      :'<div class="delegated-empty">'+esc(noMatch||"No as-needed responsibilities.")+'</div>';
    const timedCount=document.getElementById("repeat-responsibilities-timed-count");
    const asNeededCount=document.getElementById("repeat-responsibilities-as-needed-count");
    if(timedCount)timedCount.textContent=groups.timed.length;
    if(asNeededCount)asNeededCount.textContent=groups.asNeeded.length;
    [mount,asNeededMount].forEach(listMount=>listMount.querySelectorAll(".repeat-resp-card [data-act]").forEach(btn=>{
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
    }));
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
        onScheduled:function(info){ registerOpenInstance(id,info); }
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
            defaults.forEach(function(t){if(t)addSubtask(info.localId,t,{date:info.dateStr,parentStart:info.start});});
          }
        }catch(e){console.warn("[responsibilities] subtask attach failed",e);}
        registerOpenInstance(id,info);
      }
    });
  }

  // THE PAUSE, client half. The scheduling paths above mint the instance in the
  // browser (insertTaskNow / materializeShellTemplate), not through
  // POST /:id/schedule, so the server's stamp never fires for them — tell the
  // server which instance is now in flight. Whatever day it landed on: this is
  // what makes "schedule it for Thursday" silence today's strip, which the old
  // day-scoped checks structurally could not do.
  //
  // A failure here is not fatal. resolveOpenInstances settles the definition
  // from the instance's actual state on the next read, so the worst case is the
  // old behavior for one render rather than a lost pause.
  async function registerOpenInstance(id,info){
    try{
      await postResponsibilityAction(id,"instance",{
        blockId:(info&&(info.blockId||info.localId))||null,
        localId:(info&&info.localId)||null,
        date:(info&&(info.dateStr||info.date))||((window.blockStore&&window.blockStore.getCurrentDate&&window.blockStore.getCurrentDate())||null)
      });
    }catch(e){console.warn("[responsibilities] open-instance register failed",e);}
    await loadResponsibilities();
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
      }else if(act==="skip"){
        await skipRepeatResponsibility(id);
      }else if(act==="drop-instance"){
        // The in-flight instance is not coming; clear the pause. lastCompletedAt
        // is untouched, so the accrued urgency is all still there and the item
        // re-offers exactly as if it had never been scheduled.
        await postResponsibilityAction(id,"instance",{blockId:null,localId:null,date:null});
        await loadResponsibilities();
        if(typeof showToast==="function")showToast("Un-scheduled — back in rotation","success");
      }else if(act==="archive"){
        // Pause, not archive: pausedUntil is the explicit state, and status
        // stays a separate concern so Resume can restore both.
        await pauseRepeatResponsibility(id,null);
      }else if(act==="activate"){
        await resumeRepeatResponsibility(id);
      }else if(act==="remove"){
        const title=(item.properties&&item.properties.title)||"this repeat responsibility";
        if(!window.confirm('Remove "'+title+'"? This cannot be undone.'))return;
        const scheduledMode=isScheduled(item.properties||{});
        const res=await fetch(scheduledMode
          ?"/api/responsibilities/"+encodeURIComponent(id)+"/series-change"
          :"/api/responsibilities/"+encodeURIComponent(id),scheduledMode
          ?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",scope:"series"})}
          :{method:"DELETE"});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        _items=_items.filter(i=>i.id!==id);
        renderRepeatResponsibilitiesSidebar();
        if(scheduledMode)await refreshScheduleAfterResponsibilityChange();
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
    const result={
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

  function csvNumbers(value,min,max){
    return [...new Set(String(value||"").split(/[,\s]+/).map(Number).filter(n=>Number.isInteger(n)&&n>=min&&n<=max))];
  }

  function readScheduleRule(){
    const patternType=document.getElementById("resp-schedule-pattern")?.value||"calendar";
    const endType=document.getElementById("resp-schedule-end-type")?.value||"never";
    const end={type:endType};
    if(endType==="on")end.date=document.getElementById("resp-schedule-end-date")?.value||"";
    if(endType==="after")end.count=Math.max(1,Math.min(730,parseInt(document.getElementById("resp-schedule-end-count")?.value,10)||1));
    const rule={
      version:1,
      patternType,
      timeZone:document.getElementById("resp-schedule-time-zone")?.value.trim()||window.DCC_APP_TIME_ZONE||"America/New_York",
      end
    };
    if(patternType==="dates"){
      rule.dateTimes=String(document.getElementById("resp-schedule-date-times")?.value||"").split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
      return rule;
    }
    rule.startDate=document.getElementById("resp-schedule-start-date")?.value||_todayStr();
    rule.frequency=document.getElementById("resp-schedule-frequency")?.value||"weekly";
    rule.interval=Math.max(1,Math.min(365,parseInt(document.getElementById("resp-schedule-interval")?.value,10)||1));
    rule.times=String(document.getElementById("resp-schedule-times")?.value||"").split(/[,\s]+/).map(v=>v.trim()).filter(Boolean);
    rule.weekDays=Array.from(document.querySelectorAll("#resp-schedule-weekdays input:checked")).map(input=>Number(input.value));
    rule.monthMode=document.getElementById("resp-schedule-month-mode")?.value||"month_days";
    rule.monthDays=csvNumbers(document.getElementById("resp-schedule-month-days")?.value,1,31);
    rule.ordinal=parseInt(document.getElementById("resp-schedule-ordinal")?.value,10)||1;
    rule.ordinalWeekday=parseInt(document.getElementById("resp-schedule-ordinal-weekday")?.value,10)||0;
    rule.months=csvNumbers(document.getElementById("resp-schedule-months")?.value,1,12);
    return rule;
  }

  let _previewTimer=null;
  async function refreshSchedulePreview(){
    const mount=document.getElementById("resp-schedule-preview");
    if(!mount||document.getElementById("resp-repeat-type")?.value!=="scheduled")return;
    clearTimeout(_previewTimer);
    _previewTimer=setTimeout(async()=>{
      mount.textContent="Checking schedule…";
      try{
        const res=await fetch("/api/responsibilities/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scheduleRule:readScheduleRule()})});
        if(!res.ok)throw new Error(await responseErrorMessage(res));
        const data=await res.json();
        const next=(data.nextOccurrences||[]).map(item=>new Date(item.instant).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}));
        mount.innerHTML='<strong>'+esc(data.summary||"Scheduled repeat")+'</strong>'+(next.length?'<span>Next: '+next.map(esc).join(" · ")+'</span>':'<span>No future occurrences.</span>');
      }catch(error){mount.innerHTML='<span class="error">'+esc(error.message||String(error))+'</span>';}
    },180);
  }

  function syncScheduleFields(){
    const pattern=document.getElementById("resp-schedule-pattern")?.value||"calendar";
    document.querySelectorAll(".resp-schedule-calendar-field").forEach(el=>{el.style.display=pattern==="calendar"?"":"none";});
    const dates=document.getElementById("resp-schedule-dates-field");if(dates)dates.style.display=pattern==="dates"?"":"none";
    const frequency=document.getElementById("resp-schedule-frequency")?.value||"weekly";
    const weekdays=document.getElementById("resp-schedule-weekdays");if(weekdays)weekdays.style.display=frequency==="weekly"?"flex":"none";
    const monthFields=document.getElementById("resp-schedule-month-fields");if(monthFields)monthFields.style.display=(frequency==="monthly"||frequency==="yearly")?"grid":"none";
    const months=document.getElementById("resp-schedule-year-months");if(months)months.style.display=frequency==="yearly"?"":"none";
    const mode=document.getElementById("resp-schedule-month-mode")?.value||"month_days";
    document.querySelectorAll("[data-month-mode]").forEach(el=>{el.style.display=el.dataset.monthMode===mode?"":"none";});
    const endType=document.getElementById("resp-schedule-end-type")?.value||"never";
    const dateWrap=document.getElementById("resp-schedule-end-date-wrap");if(dateWrap)dateWrap.style.display=endType==="on"?"":"none";
    const countWrap=document.getElementById("resp-schedule-end-count-wrap");if(countWrap)countWrap.style.display=endType==="after"?"":"none";
    refreshSchedulePreview();
  }

  function syncRepeatType(){
    const scheduled=document.getElementById("resp-repeat-type")?.value==="scheduled";
    document.querySelectorAll(".resp-readiness-field").forEach(el=>{el.style.display=scheduled?"none":"";});
    const scheduleFields=document.getElementById("resp-scheduled-fields");if(scheduleFields)scheduleFields.style.display=scheduled?"":"none";
    if(scheduled)syncScheduleFields();
  }

  function openResponsibilityModal(id,defaults,seriesEditContext){
    const item=id?_items.find(i=>i.id===id):null;
    const p=item?(item.properties||{}):(defaults||{});
    _seriesEditContext=seriesEditContext||null;
    // Carry any saved shell structure through the modal (editing keeps the
    // existing tree; a shell-sourced create stashes the freshly captured one).
    _pendingTemplateTree=(p.templateTree&&p.templateTree.root)?p.templateTree:null;
    const today=new Date();
    const todayIso=today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
    document.getElementById("resp-id").value=id||"";
    document.getElementById("resp-title").value=p.title||"";
    document.getElementById("resp-domain").value=p.domain||"professional";
    document.getElementById("resp-area").value=p.area||"general";
    document.getElementById("resp-repeat-type").value=repeatType(p);
    const preset=document.getElementById("resp-cadence-preset");
    if(preset)preset.value=cadencePreset(p);
    document.getElementById("resp-cadence-days").value=p.cadenceDays||7;
    const anchorEl=document.getElementById("resp-anchor-mode");
    // Anything that is not literally "calendar" is completion-anchored, matching the
    // server's own test (lib/recurrence.js, responsibility-store.js).
    if(anchorEl)anchorEl.value=(p.anchorMode==="calendar")?"calendar":"completion";
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
    const schedule=p.scheduleRule||{};
    document.getElementById("resp-schedule-pattern").value=schedule.patternType||"calendar";
    document.getElementById("resp-schedule-start-date").value=schedule.startDate||todayIso;
    document.getElementById("resp-schedule-time-zone").value=schedule.timeZone||window.DCC_APP_TIME_ZONE||_localTz()||"America/New_York";
    document.getElementById("resp-schedule-frequency").value=schedule.frequency||"weekly";
    document.getElementById("resp-schedule-interval").value=schedule.interval||1;
    document.getElementById("resp-schedule-times").value=(schedule.times||["09:00"]).join(", ");
    document.querySelectorAll("#resp-schedule-weekdays input").forEach(input=>{input.checked=(schedule.weekDays||[today.getDay()]).includes(Number(input.value));});
    document.getElementById("resp-schedule-month-mode").value=schedule.monthMode||"month_days";
    document.getElementById("resp-schedule-month-days").value=(schedule.monthDays||[today.getDate()]).join(", ");
    document.getElementById("resp-schedule-ordinal").value=String(schedule.ordinal||1);
    document.getElementById("resp-schedule-ordinal-weekday").value=String(schedule.ordinalWeekday!=null?schedule.ordinalWeekday:today.getDay());
    document.getElementById("resp-schedule-months").value=(schedule.months||[today.getMonth()+1]).join(", ");
    const end=schedule.end||{type:"never"};
    document.getElementById("resp-schedule-end-type").value=end.type||"never";
    document.getElementById("resp-schedule-end-date").value=end.date||todayIso;
    document.getElementById("resp-schedule-end-count").value=end.count||10;
    document.getElementById("resp-schedule-date-times").value=(schedule.dateTimes||[]).join("\n");
    syncRepeatType();
    document.getElementById("resp-capacity-bucket").value=p.capacityBucket||"work_admin";
    const menusMount=document.getElementById("resp-menus-list");
    if(menusMount){
      menusMount.dataset.selected=(Array.isArray(p.menus)?p.menus:[]).join(",");
      if(typeof window.renderRespMenuField==="function")window.renderRespMenuField();
    }
    const subtaskInput=document.getElementById("resp-default-subtask-input");
    if(subtaskInput)subtaskInput.value="";
    setDefaultSubtasks(Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[]);
    document.getElementById("resp-modal-title").textContent=_seriesEditContext&&_seriesEditContext.scope==="following"
      ?"Edit this and following occurrences"
      :(id?"Edit repeat responsibility":(p.createdFrom==="task"?"Task to repeat responsibility":"New repeat responsibility"));
    document.getElementById("responsibility-modal-overlay").classList.add("open");
    setTimeout(()=>document.getElementById("resp-title").focus(),20);
  }

  function closeResponsibilityModal(){
    const overlay=document.getElementById("responsibility-modal-overlay");
    if(overlay)overlay.classList.remove("open");
    _seriesEditContext=null;
  }

  function closeRepeatOccurrenceModal(){
    const overlay=document.getElementById("repeat-occurrence-modal-overlay");
    if(overlay)overlay.classList.remove("open");
  }

  function syncRepeatOccurrenceScope(){
    const scope=document.getElementById("repeat-occurrence-scope")?.value||"occurrence";
    const occurrence=scope==="occurrence";
    const fields=document.getElementById("repeat-occurrence-fields");
    const hint=document.getElementById("repeat-occurrence-series-hint");
    const edit=document.getElementById("repeat-occurrence-edit");
    const remove=document.getElementById("repeat-occurrence-delete");
    if(fields)fields.style.display=occurrence?"grid":"none";
    if(hint)hint.style.display=occurrence?"none":"";
    if(edit)edit.textContent=occurrence?"Save occurrence":"Edit schedule";
    if(remove)remove.textContent=scope==="occurrence"?"Skip this occurrence":(scope==="following"?"Delete this and following":"Delete series");
  }

  async function postScheduledSeriesChange(seriesId,payload){
    const res=await fetch("/api/responsibilities/"+encodeURIComponent(seriesId)+"/series-change",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)
    });
    if(!res.ok)throw new Error(await responseErrorMessage(res));
    return res.json();
  }

  async function openScheduledOccurrenceActions(task){
    if(!task||task.repeatMode!=="scheduled"||!task.repeatSeriesId||!task.repeatOccurrenceKey)return;
    if(!_items.some(item=>item.id===task.repeatSeriesId))await loadResponsibilities();
    document.getElementById("repeat-occurrence-series-id").value=task.repeatSeriesId;
    document.getElementById("repeat-occurrence-key").value=task.repeatOccurrenceKey;
    document.getElementById("repeat-occurrence-block-id").value=task.repeatOccurrenceRootId||task._blockId||"";
    document.getElementById("repeat-occurrence-description").textContent=task.title+" · "+task.repeatOccurrenceKey.replace("T"," at ");
    document.getElementById("repeat-occurrence-scope").value="occurrence";
    document.getElementById("repeat-occurrence-title").value=task.title||"";
    const viewed=(typeof viewDate!=="undefined"&&viewDate)||(window.__DCC_STATE__&&window.__DCC_STATE__.date)||task.repeatOccurrenceKey.slice(0,10);
    document.getElementById("repeat-occurrence-date").value=viewed;
    document.getElementById("repeat-occurrence-time").value=task.start||task.repeatOccurrenceKey.slice(11);
    document.getElementById("repeat-occurrence-duration").value=taskDurationMinutes(task);
    syncRepeatOccurrenceScope();
    document.getElementById("repeat-occurrence-modal-overlay").classList.add("open");
  }

  async function editScheduledOccurrence(){
    const seriesId=document.getElementById("repeat-occurrence-series-id")?.value;
    const occurrenceKey=document.getElementById("repeat-occurrence-key")?.value;
    const blockId=document.getElementById("repeat-occurrence-block-id")?.value||null;
    const scope=document.getElementById("repeat-occurrence-scope")?.value||"occurrence";
    if(!seriesId)return;
    if(scope!=="occurrence"){
      closeRepeatOccurrenceModal();
      openResponsibilityModal(seriesId,null,scope==="following"?{scope,occurrenceKey}:null);
      return;
    }
    try{
      await postScheduledSeriesChange(seriesId,{
        action:"update",scope,occurrenceKey,blockId,
        changes:{task:{
          title:document.getElementById("repeat-occurrence-title")?.value.trim()||"",
          date:document.getElementById("repeat-occurrence-date")?.value||"",
          start:document.getElementById("repeat-occurrence-time")?.value||"",
          durationMinutes:Math.max(1,parseInt(document.getElementById("repeat-occurrence-duration")?.value,10)||30)
        }}
      });
      closeRepeatOccurrenceModal();
      await loadResponsibilities();
      await refreshScheduleAfterResponsibilityChange();
      if(typeof showToast==="function")showToast("Scheduled occurrence updated","success");
    }catch(error){if(typeof showToast==="function")showToast("Update failed: "+(error.message||error),"error");}
  }

  async function deleteScheduledOccurrence(){
    const seriesId=document.getElementById("repeat-occurrence-series-id")?.value;
    const occurrenceKey=document.getElementById("repeat-occurrence-key")?.value;
    const blockId=document.getElementById("repeat-occurrence-block-id")?.value||null;
    const scope=document.getElementById("repeat-occurrence-scope")?.value||"occurrence";
    if(!seriesId)return;
    if(scope!=="occurrence"&&!window.confirm(scope==="following"?"Delete this and every following open occurrence?":"Delete this scheduled series and every open current or future occurrence?"))return;
    try{
      await postScheduledSeriesChange(seriesId,{action:"delete",scope,occurrenceKey,blockId});
      closeRepeatOccurrenceModal();
      await loadResponsibilities();
      await refreshScheduleAfterResponsibilityChange();
      if(typeof showToast==="function")showToast(scope==="occurrence"?"Occurrence skipped":"Scheduled series updated","success");
    }catch(error){if(typeof showToast==="function")showToast("Delete failed: "+(error.message||error),"error");}
  }

  // The library lives in a dedicated modal now (the drawer just opens it). Same
  // tool/list IDs as before, so renderRepeatResponsibilitiesSidebar populates it.
  let _responsibilityManagerTrigger=null;
  const _managerFocusable='button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapResponsibilityManagerFocus(event){
    if(event.key!=="Tab")return;
    const overlay=document.getElementById("responsibility-manage-overlay");
    if(!overlay?.classList.contains("open"))return;
    const items=Array.from(overlay.querySelectorAll(_managerFocusable)).filter(el=>el.offsetParent!==null);
    if(!items.length){event.preventDefault();return;}
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  function openResponsibilityManager(){
    if(typeof window.closeTasksDrawer==="function")window.closeTasksDrawer();
    _responsibilityManagerTrigger=document.activeElement;
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
    if(_responsibilityManagerTrigger&&typeof _responsibilityManagerTrigger.focus==="function")_responsibilityManagerTrigger.focus();
    _responsibilityManagerTrigger=null;
  }

  function formProps(){
    // Editing must not silently reactivate. This used to hardcode
    // status:"active", so opening a paused or archived responsibility and
    // pressing Save quietly brought it back to life. Preserve whatever state the
    // item is already in; a new item starts active.
    const editingId=document.getElementById("resp-id")?.value||"";
    const editing=editingId?_items.find(i=>i.id===editingId):null;
    const existingStatus=((editing&&editing.properties&&editing.properties.status)||"active");
    const cadence=document.getElementById("resp-cadence-preset")?.value||"custom";
    const cadenceMap={daily:1,weekly:7,biweekly:14,monthly:30};
    const customDays=Math.max(1,parseInt(document.getElementById("resp-cadence-days").value,10)||7);
    const cadenceDays=cadence==="as_needed"?null:(cadenceMap[cadence]||customDays);
    const preferredCadence=document.getElementById("resp-preferred-cadence")?.value||"none";
    const result={
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
      status:existingStatus,
      // "completion" (default) | "calendar" — the Todoist every!/every split. The
      // picker now lives in the modal (index.html, Track C's surface); fall back to
      // the item's stored value, then the default, so an item saved before the
      // control existed keeps its mode if the field is ever missing.
      anchorMode:(document.getElementById("resp-anchor-mode")?.value
        ||(editing&&editing.properties&&editing.properties.anchorMode)
        ||"completion")
    };
    result.repeatType=document.getElementById("resp-repeat-type")?.value==="scheduled"?"scheduled":"readiness";
    if(result.repeatType==="scheduled")result.scheduleRule=readScheduleRule();
    return result;
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

  // patchResponsibility was removed with its only caller: the archive/activate
  // branch of handleCardAction, which now goes through the dedicated
  // /pause and /resume endpoints. saveResponsibility PATCHes inline.

  async function saveResponsibility(){
    const id=document.getElementById("resp-id").value||null;
    const props=formProps();
    if(!props.title){if(typeof showToast==="function")showToast("Title is required","error");return;}
    try{
      const context=_seriesEditContext;
      const scoped=!!(id&&context&&context.scope);
      const res=await fetch(scoped
        ?"/api/responsibilities/"+encodeURIComponent(id)+"/series-change"
        :(id?"/api/responsibilities/"+encodeURIComponent(id):"/api/responsibilities"),{
        method:scoped?"POST":(id?"PATCH":"POST"),
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(scoped
          ?{action:"update",scope:context.scope,occurrenceKey:context.occurrenceKey,changes:props}
          :{properties:props})
      });
      if(!res.ok)throw new Error(await responseErrorMessage(res));
      closeResponsibilityModal();
      await loadResponsibilities();
      if(scoped)await refreshScheduleAfterResponsibilityChange();
      if(typeof showToast==="function")showToast("Responsibility saved","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Save failed: "+(e.message||e),"error");
    }
  }

  // markResponsibilityTaskCompleted DELETED (C5b step 7). D1 added it as the
  // belt-and-suspenders half of the one-open-instance invariant, because the itinerary
  // persisted completion to `day_root._done` and never to the task row -- so
  // `db.js propagateResponsibilityDone`, which fires on a row flipping to done, could
  // never see a check-off. C5b makes the row the completion, so that hook now runs the
  // identical `recurrence.applyCompletion` this function POSTed for. Its other job, the
  // local sidebar refresh, moved to `_refreshResponsibilityAfterDone` in schedule.js,
  // chained on the row write. `POST /api/responsibilities/:id/complete` stays: the
  // Responsibilities surface itself still uses it.

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
    document.addEventListener("keydown",trapResponsibilityManagerFocus);
    const cadencePresetEl=document.getElementById("resp-cadence-preset");
    if(cadencePresetEl)cadencePresetEl.addEventListener("change",syncCadencePreset);
    const repeatTypeEl=document.getElementById("resp-repeat-type");
    if(repeatTypeEl)repeatTypeEl.addEventListener("change",syncRepeatType);
    document.querySelectorAll("#resp-scheduled-fields input,#resp-scheduled-fields select,#resp-scheduled-fields textarea").forEach(el=>{
      el.addEventListener(el.tagName==="SELECT"?"change":"input",syncScheduleFields);
    });
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
    const occurrenceScope=document.getElementById("repeat-occurrence-scope");
    if(occurrenceScope)occurrenceScope.addEventListener("change",syncRepeatOccurrenceScope);
    const occurrenceCancel=document.getElementById("repeat-occurrence-cancel");
    if(occurrenceCancel)occurrenceCancel.addEventListener("click",closeRepeatOccurrenceModal);
    const occurrenceEdit=document.getElementById("repeat-occurrence-edit");
    if(occurrenceEdit)occurrenceEdit.addEventListener("click",editScheduledOccurrence);
    const occurrenceDelete=document.getElementById("repeat-occurrence-delete");
    if(occurrenceDelete)occurrenceDelete.addEventListener("click",deleteScheduledOccurrence);
    const occurrenceOverlay=document.getElementById("repeat-occurrence-modal-overlay");
    if(occurrenceOverlay)occurrenceOverlay.addEventListener("click",e=>{if(e.target===occurrenceOverlay)closeRepeatOccurrenceModal();});
  }

  document.addEventListener("DOMContentLoaded",bindResponsibilities);
  window.loadResponsibilities=loadResponsibilities;
  window.refreshScheduleAfterResponsibilityChange=refreshScheduleAfterResponsibilityChange;
  window.openResponsibilityModalWithMenus=function(menus){ openResponsibilityModal(null,{menus:Array.isArray(menus)?menus:[]}); };
  window.renderRepeatResponsibilitiesSidebar=renderRepeatResponsibilitiesSidebar;
  window.scheduledResponsibilityLabels=scheduledResponsibilityLabels;
  window.splitRepeatResponsibilityItems=splitRepeatResponsibilityItems;
  // Triage-strip surfacing (Part C): the itinerary triage renderer reads these.
  window.getDueRepeatResponsibilities=getDueRepeatResponsibilities;
  window.scheduleRepeatResponsibility=scheduleRepeatResponsibility;
  window.completeRepeatResponsibility=completeRepeatResponsibility;
  // Recurrence controls (D1). snoozeRepeatResponsibility is kept as an alias so a
  // cached triage.js from a previous deploy does not throw; it now performs a real
  // server-side skip instead of writing the browser-local snooze map.
  window.skipRepeatResponsibility=skipRepeatResponsibility;
  window.snoozeRepeatResponsibility=skipRepeatResponsibility;
  window.pauseRepeatResponsibility=pauseRepeatResponsibility;
  window.resumeRepeatResponsibility=resumeRepeatResponsibility;
  window.openScheduledOccurrenceActions=openScheduledOccurrenceActions;
  window.responsibilityOpenInstanceInfo=openInstanceInfo;
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
