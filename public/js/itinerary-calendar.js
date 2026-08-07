/* DCC Itinerary week calendar. Pure date and overlap helpers are exported for tests. */
(function(root,factory){
  const api=factory(root||null);
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root){
    root.ItineraryCalendar=api;
    root.buildItineraryCalendar=api.build;
  }
})(typeof window!=="undefined"?window:null,function(root){
  "use strict";

  const DAY_MS=86400000;
  const HOUR_PX=48;
  const PREF_KEY="dcc-calendar-week-prefs";
  const SHORT_DAYS=["SUN","MON","TUE","WED","THU","FRI","SAT"];
  const DEFAULT_COLORS={dcc:"#00B373",notion:"#8B5CF6",slack:"#0075EB",calendar:"#D97706",other:"#6B7280"};
  let renderToken=0;
  let state={anchor:null,syncedViewDate:null,hidden:new Set(),colors:{},railCollapsed:false,openSource:null,selectedId:null,loaded:[],initialScroll:true};

  function parseDate(ds){
    const p=String(ds||"").split("-").map(Number);
    return new Date(p[0],(p[1]||1)-1,p[2]||1,12,0,0,0);
  }
  function dateString(date){
    return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");
  }
  function easternNow(date){
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date||new Date());
    const get=type=>Number((parts.find(p=>p.type===type)||{}).value||0);
    let hour=get("hour");if(hour===24)hour=0;
    return {date:String(get("year")).padStart(4,"0")+"-"+String(get("month")).padStart(2,"0")+"-"+String(get("day")).padStart(2,"0"),minute:hour*60+get("minute")};
  }
  function addDays(ds,n){const d=parseDate(ds);d.setDate(d.getDate()+n);return dateString(d);}
  function weekStart(ds){const d=parseDate(ds);d.setDate(d.getDate()-d.getDay());return dateString(d);}
  function minuteOf(time){const m=/^(\d{1,2}):(\d{2})/.exec(String(time||""));return m?Number(m[1])*60+Number(m[2]):0;}
  function clock(minute){const m=Math.max(0,Math.min(1439,Math.round(minute)));return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");}
  function snap(minute){return Math.max(0,Math.min(1425,Math.round(minute/15)*15));}
  function spansDate(ev,ds){return !!ev.allDay&&String(ev.allDayStart||ev._block.date)<=ds&&String(ev.allDayEnd||addDays(ev.allDayStart||ev._block.date,1))>ds;}
  function isMeeting(ev){return ev&&(["meeting","oneone"].includes(ev.type)||ev.kind==="meeting");}
  function isComplete(ev){return !!(ev&&(ev.status==="done"||ev.completedAt));}
  function importedMeeting(ev){return isMeeting(ev)&&(["calendar","gcal"].includes(String(ev.source||"").toLowerCase())||!!ev.calendarId||String(ev.sourceKey||"").startsWith("calendar:"));}
  function stableId(ev){return String(ev._blockId||ev.id||"");}

  // Pack only within connected overlap groups. A later disjoint group starts over at one lane.
  function packOverlaps(items){
    const sorted=(items||[]).slice().sort((a,b)=>a.startMinute-b.startMinute||b.endMinute-a.endMinute||stableId(a).localeCompare(stableId(b)));
    const out=[];
    let group=[];
    let groupEnd=-1;
    function finish(){
      if(!group.length)return;
      const laneEnds=[];
      group.forEach(ev=>{
        let lane=laneEnds.findIndex(end=>end<=ev.startMinute);
        if(lane<0)lane=laneEnds.length;
        laneEnds[lane]=ev.endMinute;
        ev.lane=lane;
      });
      const lanes=Math.max(1,laneEnds.length);
      group.forEach(ev=>out.push({...ev,laneCount:lanes,leftPct:(ev.lane/lanes)*100,widthPct:100/lanes}));
      group=[];groupEnd=-1;
    }
    sorted.forEach(ev=>{
      if(group.length&&ev.startMinute>=groupEnd)finish();
      group.push({...ev});
      groupEnd=Math.max(groupEnd,ev.endMinute);
    });
    finish();
    return out;
  }

  function loadPrefs(){
    if(!root)return;
    try{
      const p=JSON.parse(root.localStorage.getItem(PREF_KEY)||"{}");
      state.hidden=new Set(Array.isArray(p.hidden)?p.hidden:[]);
      state.colors=p.colors&&typeof p.colors==="object"?p.colors:{};
      state.railCollapsed=!!p.railCollapsed;
    }catch(e){}
  }
  function savePrefs(){
    if(!root)return;
    try{root.localStorage.setItem(PREF_KEY,JSON.stringify({hidden:[...state.hidden],colors:state.colors,railCollapsed:state.railCollapsed}));}catch(e){}
  }
  function escapeHtml(v){return String(v==null?"":v).replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function formatRange(start,end){
    const a=parseDate(start),b=parseDate(end);
    const opts={month:"short",day:"numeric"};
    if(a.getFullYear()!==b.getFullYear())return a.toLocaleDateString(undefined,{...opts,year:"numeric"})+" - "+b.toLocaleDateString(undefined,{...opts,year:"numeric"});
    return a.toLocaleDateString(undefined,opts)+" - "+b.toLocaleDateString(undefined,{...opts,year:"numeric"});
  }
  function safeColor(value,fallback){return /^#[0-9a-f]{6}$/i.test(String(value||""))?String(value):fallback;}
  function sourceColor(ev){
    const fallback=(ev.sourceKey&&ev.sourceKey.startsWith("calendar:")?DEFAULT_COLORS.calendar:DEFAULT_COLORS[ev.sourceKey])||DEFAULT_COLORS.other;
    return safeColor(state.colors[ev.sourceKey]||ev.calendarColor,fallback);
  }
  function safeExternalUrl(value,base){
    try{const url=new URL(String(value||""),base||(root&&root.location&&root.location.href));return ["http:","https:"].includes(url.protocol)?url.href:"";}catch(e){return "";}
  }
  function icon(name){
    const path={menu:'<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/>',chevleft:'<polyline points="15 18 9 12 15 6"/>',chevright:'<polyline points="9 18 15 12 9 6"/>',eye:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',eyeoff:'<path d="M3 3l18 18"/><path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-2.1 2.8M6.7 6.7C3.7 8.4 2 12 2 12s3.5 6 10 6a10.8 10.8 0 0 0 3.3-.5"/>',external:'<path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',pin:'<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2"/>'}[name]||"";
    return '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+path+'</svg>';
  }

  function projectedBlocks(blocks){
    const TM=root.DCC&&root.DCC.TaskModel;
    if(!TM)return [];
    const seen=new Set();
    return (blocks||[]).filter(b=>b&&!b.deleted_at&&b.type==="block"&&TM.foldsIntoItinerary(b)).filter(b=>{if(seen.has(b.id))return false;seen.add(b.id);return true;}).map(b=>{const ev=TM.fromBlock(b,{deriveEnd:true});ev._block=b;return ev;});
  }
  function rootItems(items){return items.filter(ev=>!ev.subtaskOf&&!ev.wrapId);}
  function childrenOf(ev,items){return items.filter(c=>c.subtaskOf===ev.id||c.wrapId===ev.id||c._block.parent_id===ev._blockId);}
  function editableDate(ds){return ds>=easternNow().date;}
  function movable(ev,ds){return editableDate(ds)&&!isComplete(ev)&&!importedMeeting(ev);}
  function resizable(ev,ds){return movable(ev,ds)&&!(ev.type==="shell"&&childrenOf(ev,state.loaded).length);}

  async function readWeek(){
    const start=state.anchor,end=addDays(start,6);
    const result=await root.blockStore.loadDateRange(start,end);
    state.loaded=projectedBlocks(result.blocks||[]);
    return state.loaded;
  }

  function sourceMap(items){
    const map=new Map();
    items.forEach(ev=>{if(!map.has(ev.sourceKey))map.set(ev.sourceKey,{key:ev.sourceKey,label:ev.sourceLabel,color:sourceColor(ev),calendar:ev.sourceKey.startsWith("calendar:")});});
    projectedBlocks(root.blockStore.getByType("block")).forEach(ev=>{if(!map.has(ev.sourceKey))map.set(ev.sourceKey,{key:ev.sourceKey,label:ev.sourceLabel,color:sourceColor(ev),calendar:ev.sourceKey.startsWith("calendar:")});});
    return [...map.values()].sort((a,b)=>Number(a.calendar)-Number(b.calendar)||a.label.localeCompare(b.label));
  }
  function unscheduledFor(key){
    return rootItems(projectedBlocks(root.blockStore.getByType("block"))).filter(ev=>ev.sourceKey===key&&ev.untimed&&!isComplete(ev));
  }
  function renderRail(items){
    const sources=sourceMap(items);
    const groups=[{label:"Calendars",rows:sources.filter(s=>s.calendar)},{label:"Tasks",rows:sources.filter(s=>!s.calendar)}];
    let html='<aside class="iwc-rail" aria-label="Calendar sources"><button class="iwc-rail-toggle" type="button" aria-label="Toggle source rail">'+icon("menu")+'</button>';
    groups.forEach(group=>{if(!group.rows.length)return;html+='<div class="iwc-rail-title">'+group.label+'</div>';group.rows.forEach(s=>{
      const hidden=state.hidden.has(s.key),active=state.openSource===s.key;
      html+='<div class="iwc-source '+(hidden?'hidden ':'')+(active?'active':'')+'" data-source="'+escapeHtml(s.key)+'"><button class="iwc-source-eye" type="button" aria-label="'+(hidden?'Show ':'Hide ')+escapeHtml(s.label)+'">'+icon(hidden?"eyeoff":"eye")+'</button><input class="iwc-source-color" type="color" value="'+escapeHtml(s.color)+'" aria-label="Color for '+escapeHtml(s.label)+'"><button class="iwc-source-name" type="button">'+escapeHtml(s.label)+'</button></div>';
    });});
    if(state.openSource){
      const rows=unscheduledFor(state.openSource);
      html+='<section class="iwc-unscheduled"><h4>Unscheduled · '+rows.length+'</h4>'+(rows.length?rows.map(ev=>'<div class="iwc-unscheduled-item" draggable="true" data-drag-id="'+escapeHtml(ev._blockId)+'" title="Drag into the week">'+escapeHtml(ev.title||"Untitled task")+'</div>').join(""):'<p class="iwc-empty">Nothing waiting.</p>')+'</section>';
    }
    return html+'</aside>';
  }

  function eventMarkup(ev,day,packed){
    const start=minuteOf(ev.start),end=Math.max(start+15,minuteOf(ev.end));
    const childCount=childrenOf(ev,state.loaded).length;
    const meeting=isMeeting(ev),done=isComplete(ev),readonly=!movable(ev,day);
    const width=packed?packed.widthPct:100,left=packed?packed.leftPct:0;
    const style='top:'+(start/60*HOUR_PX)+'px;height:'+Math.max(18,(end-start)/60*HOUR_PX)+'px;left:calc('+left+'% + 2px);width:calc('+width+'% - 4px);--iwc-color:'+sourceColor(ev);
    const indicators=[ev.location?icon("pin"):"",ev.hangout_link?"↗":"",ev.rsvp_status?icon("users"):""].filter(Boolean).join("");
    return '<article class="iwc-event '+(meeting?'meeting ':'task ')+(done?'done ':'')+(readonly?'readonly':'')+'" data-event-id="'+escapeHtml(ev._blockId)+'" draggable="'+(!readonly)+'" style="'+style+'" tabindex="0" aria-label="'+escapeHtml(ev.title||"Untitled")+'">'+(meeting?icon("calendar"):'<input class="iwc-event-check" type="checkbox" '+(done?'checked':'')+' aria-label="Complete task">')+'<div class="iwc-event-title">'+escapeHtml(ev.title||"Untitled")+'</div><div class="iwc-event-meta">'+escapeHtml(ev.start)+' · '+Math.max(15,end-start)+'m '+(childCount?' · '+childCount+' child'+(childCount===1?'':'ren'):'')+' '+indicators+'</div>'+(resizable(ev,day)?'<span class="iwc-resize" aria-label="Resize"></span>':'')+'</article>';
  }
  function renderWeek(items){
    const eastern=easternNow(),today=eastern.date;
    const days=Array.from({length:7},(_,i)=>addDays(state.anchor,i));
    let html='<div class="iwc-week-scroll"><div class="iwc-week"><div class="iwc-corner"></div>';
    days.forEach((ds,i)=>{html+='<div class="iwc-day-head '+(ds===today?'today':'')+'"><span>'+SHORT_DAYS[i]+'</span><strong>'+parseDate(ds).getDate()+'</strong></div>';});
    html+='<div class="iwc-all-label">all-day</div>';
    days.forEach(ds=>{
      const evs=rootItems(items).filter(ev=>spansDate(ev,ds)&&!state.hidden.has(ev.sourceKey));
      html+='<div class="iwc-all-day '+(!editableDate(ds)?'past':'')+'" data-day="'+ds+'">'+evs.map(ev=>'<div class="iwc-all-event '+(isComplete(ev)?'done':'')+'" draggable="'+movable(ev,ds)+'" data-event-id="'+escapeHtml(ev._blockId)+'" style="--iwc-color:'+sourceColor(ev)+';background:'+sourceColor(ev)+'" title="'+escapeHtml((ev.allDayStart||ds)+' through '+addDays(ev.allDayEnd||addDays(ds,1),-1))+'">'+escapeHtml(ev.title||"Untitled")+(resizable(ev,ds)&&!importedMeeting(ev)?'<span class="iwc-all-resize" aria-label="Resize all-day task">↔</span>':'')+'</div>').join("")+'</div>';
    });
    html+='<div class="iwc-time-gutter">';
    for(let h=0;h<24;h++)html+='<span class="iwc-time-label" style="top:'+(h*HOUR_PX)+'px">'+(h===0?'12 AM':h<12?h+' AM':h===12?'12 PM':(h-12)+' PM')+'</span>';
    html+='</div>';
    days.forEach(ds=>{
      const dayItems=rootItems(items).filter(ev=>!ev.allDay&&ev._block.date===ds&&!ev.untimed&&!state.hidden.has(ev.sourceKey)).map(ev=>({...ev,startMinute:minuteOf(ev.start),endMinute:Math.max(minuteOf(ev.start)+15,minuteOf(ev.end))}));
      const packed=packOverlaps(dayItems);
      html+='<div class="iwc-day-col '+(!editableDate(ds)?'past':'')+'" data-day="'+ds+'">'+packed.map(p=>eventMarkup(p,ds,p)).join("");
      if(ds===today)html+='<div class="iwc-now" style="top:'+(eastern.minute/60*HOUR_PX)+'px"></div>';
      html+='</div>';
    });
    return html+'</div></div>';
  }
  function renderShell(items){
    const end=addDays(state.anchor,6);
    return '<div class="iwc-shell '+(state.railCollapsed?'rail-collapsed':'')+'">'+renderRail(items)+'<main class="iwc-main"><header class="iwc-toolbar"><button class="iwc-icon-btn iwc-mobile-sources" type="button" aria-label="Sources">'+icon("menu")+'</button><button class="iwc-today" type="button">Today</button><button class="iwc-icon-btn iwc-prev" type="button" aria-label="Previous week">'+icon("chevleft")+'</button><button class="iwc-icon-btn iwc-next" type="button" aria-label="Next week">'+icon("chevright")+'</button><strong class="iwc-range-title">'+escapeHtml(formatRange(state.anchor,end))+'</strong><input class="iwc-date-jump" type="date" value="'+state.anchor+'" aria-label="Jump to date"><span class="iwc-toolbar-spacer"></span><span class="iwc-legend">15-minute snap · Eastern time</span></header>'+renderWeek(items)+'</main><aside class="iwc-inspector" hidden></aside></div>';
  }

  function findEvent(id){return state.loaded.find(ev=>String(ev._blockId)===String(id)||String(ev.id)===String(id));}
  function toast(message,type){if(root.showToast)root.showToast(message,type||"info",2800);}
  async function place(id,day,kind,start,end){
    const ev=findEvent(id)||projectedBlocks(root.blockStore.getByType("block")).find(x=>x._blockId===id);
    if(!ev)return;
    if(importedMeeting(ev)){toast("This meeting is owned by Google Calendar. Open it there to change the time.","info");openInspector(id);return;}
    if(isComplete(ev)||!editableDate(day)){toast("Completed work and past dates are read-only.","info");return;}
    const placement=kind==="all_day"?{kind:"all_day",endDate:end}:{kind:"timed",start:clock(start),end:clock(end)};
    try{await root.blockStore.rescheduleBlock(ev._blockId,day,{fromDate:ev._block.date||day,placement});await build({keepScroll:true});}
    catch(e){toast(e.message||"Could not move this item.","error");}
  }
  async function createDraft(day,start,end){
    if(!editableDate(day))return;
    const nowIso=new Date().toISOString();
    const block=await root.blockStore.createBlock("block",{local_id:"calendar-task-"+(root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():Date.now()),title:"New task",type:"task",kind:"task",source:"manual",status:"open",start:clock(start),end:clock(end),duration:Math.max(15,end-start),estimatedMinutes:Math.max(15,end-start),priority:"Medium",tags:[],added_at:nowIso},{date:day});
    await build({keepScroll:true});
    if(block&&block.id)openInspector(block.id,true);
  }
  async function toggleComplete(ev,checked){
    try{
      if(checked&&typeof root.commitDoneOnDate==="function"){
        await root.commitDoneOnDate(ev.id,ev._block.date,{ev});
      }else if(!checked&&typeof root._persistDone==="function"){
        await Promise.resolve(root._persistDone(ev.id,false,{ev,dateStr:ev._block.date}));
      }else{
        const p={...ev._block.properties,status:checked?"done":"open",completedAt:checked?new Date().toISOString():null};
        await root.blockStore.updateBlock(ev._blockId,p);
      }
    }catch(e){toast(e.message||"Could not update completion.","error");return;}
    root.blockStore.invalidateRangeCache(ev._block.date);
    await build({keepScroll:true});
  }

  function inspectorField(label,name,value,opts){
    opts=opts||{};
    if(opts.type==="textarea")return '<label class="iwc-field">'+label+'<textarea name="'+name+'" '+(opts.readonly?'readonly':'')+'>'+escapeHtml(value||"")+'</textarea></label>';
    if(opts.options)return '<label class="iwc-field">'+label+'<select name="'+name+'" '+(opts.disabled?'disabled':'')+'>'+opts.options.map(o=>'<option '+(o===value?'selected':'')+'>'+escapeHtml(o)+'</option>').join("")+'</select></label>';
    return '<label class="iwc-field">'+label+'<input name="'+name+'" type="'+(opts.type||"text")+'" value="'+escapeHtml(value||"")+'" '+(opts.readonly?'readonly':'')+'></label>';
  }
  function openInspector(id,focusTitle){
    const panel=document.querySelector("#calendar-view .iwc-inspector"),ev=findEvent(id)||projectedBlocks(root.blockStore.getByType("block")).find(x=>x._blockId===id);
    if(!panel||!ev)return;
    state.selectedId=ev._blockId;
    const meeting=isMeeting(ev),sourceOwned=importedMeeting(ev),past=!editableDate(ev._block.date||state.anchor);
    const timeReadonly=sourceOwned||past||isComplete(ev);
    const kids=childrenOf(ev,state.loaded);
    const p=ev._block.properties||{};
    let actions="";
    const calendarUrl=safeExternalUrl(ev.calUrl),joinUrl=safeExternalUrl(ev.hangout_link),sourceUrl=safeExternalUrl(p.source_ref||ev.notionUrl);
    if(calendarUrl)actions+='<a href="'+escapeHtml(calendarUrl)+'" target="_blank" rel="noopener">Open in Google Calendar '+icon("external")+'</a>';
    if(joinUrl)actions+='<a href="'+escapeHtml(joinUrl)+'" target="_blank" rel="noopener">Join '+icon("external")+'</a>';
    if(meeting)actions+='<button type="button" class="iwc-prep">'+((ev.recapStatus||new Date()>=new Date((ev._block.date||"")+"T"+ev.start))?'Recap':'Prep')+'</button>';
    panel.innerHTML='<div class="iwc-inspector-head"><span class="iwc-type-mark">'+(meeting?icon("calendar"):'☐')+'</span><h3>'+(meeting?'Meeting':'Task')+'</h3><button class="iwc-close" type="button" aria-label="Close">×</button></div>'+
      (sourceOwned?'<p class="iwc-authority">Time and title are managed by Google Calendar.</p>':'')+
      inspectorField("Title","title",ev.title,{readonly:sourceOwned||past})+
      inspectorField("Status","status",ev.status||"open",{options:["open","in_progress","done"],disabled:past})+
      (!meeting?inspectorField("Priority","priority",ev.priority||"Medium",{options:["Low","Medium","High","Critical"],disabled:past}):'')+
      inspectorField("Date","date",ev._block.date,{type:"date",readonly:timeReadonly})+
      (ev.allDay?'<label class="iwc-field">All day through<input name="allDayEnd" type="date" value="'+escapeHtml(ev.allDayEnd||addDays(ev._block.date,1))+'" '+(timeReadonly?'readonly':'')+'></label>':inspectorField("Start","start",ev.start,{type:"time",readonly:timeReadonly})+inspectorField("End","end",ev.end,{type:"time",readonly:timeReadonly}))+
      (!meeting?inspectorField("Tags","tags",ev.tags.join(", "),{readonly:past}):'')+
      (ev.location?'<div class="iwc-detail-row">'+icon("pin")+' '+escapeHtml(ev.location)+'</div>':'')+
      (ev.rsvp_status?'<div class="iwc-detail-row">RSVP · '+escapeHtml(ev.rsvp_status)+'</div>':'')+
      '<div class="iwc-actions">'+actions+'<button type="button" class="iwc-complete" '+(past?'disabled':'')+'>'+(isComplete(ev)?'Mark open':'Complete')+'</button></div>'+
      inspectorField("Notes","notes",ev.notes||ev.detail||"",{type:"textarea",readonly:past})+
      (sourceUrl?'<a class="iwc-source-link" href="'+escapeHtml(sourceUrl)+'" target="_blank" rel="noopener">Open source '+icon("external")+'</a>':'')+
      '<section class="iwc-children"><h4>Children · '+kids.length+'</h4>'+(kids.length?kids.map(c=>'<div class="iwc-child">'+(isComplete(c)?'✓ ':'○ ')+escapeHtml(c.title||"Untitled")+'</div>').join(""):'<p class="iwc-empty">No nested work.</p>')+'</section>';
    panel.hidden=false;
    panel.querySelector(".iwc-close").onclick=()=>{panel.hidden=true;state.selectedId=null;};
    panel.querySelector(".iwc-complete").onclick=()=>toggleComplete(ev,!isComplete(ev));
    const prep=panel.querySelector(".iwc-prep");if(prep)prep.onclick=()=>{if(root.openMeetingPanel)root.openMeetingPanel(ev,{defaultTab:ev.recapStatus?"recap":"prep"});};
    panel.querySelectorAll("input,select,textarea").forEach(input=>input.addEventListener("change",async()=>{
      if(input.readOnly||input.disabled)return;
      if(["date","start","end","allDayEnd"].includes(input.name)){
        const form=panel;
        const day=(form.querySelector('[name="date"]')||{}).value||ev._block.date;
        if(ev.allDay){const endDate=(form.querySelector('[name="allDayEnd"]')||{}).value||addDays(day,1);await place(ev._blockId,day,"all_day",null,endDate);}
        else{const s=minuteOf((form.querySelector('[name="start"]')||{}).value||ev.start),e=minuteOf((form.querySelector('[name="end"]')||{}).value||ev.end);await place(ev._blockId,day,"timed",s,Math.max(s+15,e));}
        return;
      }
      const next={...ev._block.properties};
      next[input.name]=input.name==="tags"?input.value.split(",").map(x=>x.trim()).filter(Boolean):input.value;
      if(input.name==="notes"&&next.detail&&!next.notes)next.detail=input.value;
      await root.blockStore.updateBlock(ev._blockId,next);await build({keepScroll:true});openInspector(ev._blockId);
    }));
    if(focusTitle){const title=panel.querySelector('[name="title"]');if(title&&!title.readOnly){title.focus();title.select();}}
  }

  function bind(rootEl){
    const shell=rootEl.querySelector(".iwc-shell");
    rootEl.querySelector(".iwc-rail-toggle").onclick=()=>{state.railCollapsed=!state.railCollapsed;savePrefs();build({keepScroll:true});};
    rootEl.querySelector(".iwc-mobile-sources").onclick=()=>shell.classList.toggle("rail-open-mobile");
    rootEl.querySelector(".iwc-today").onclick=()=>{state.anchor=weekStart(easternNow().date);state.initialScroll=true;build();};
    rootEl.querySelector(".iwc-prev").onclick=()=>{state.anchor=addDays(state.anchor,-7);build();};
    rootEl.querySelector(".iwc-next").onclick=()=>{state.anchor=addDays(state.anchor,7);build();};
    rootEl.querySelector(".iwc-date-jump").onchange=e=>{if(e.target.value){state.anchor=weekStart(e.target.value);state.initialScroll=true;build();}};
    rootEl.querySelectorAll(".iwc-source").forEach(row=>{
      const key=row.dataset.source;
      row.querySelector(".iwc-source-eye").onclick=e=>{e.stopPropagation();state.hidden.has(key)?state.hidden.delete(key):state.hidden.add(key);savePrefs();build({keepScroll:true});};
      row.querySelector(".iwc-source-name").onclick=()=>{state.openSource=state.openSource===key?null:key;build({keepScroll:true});};
      row.querySelector(".iwc-source-color").onchange=e=>{state.colors[key]=e.target.value;savePrefs();build({keepScroll:true});};
    });
    rootEl.querySelectorAll("[data-event-id]").forEach(el=>{
      el.onclick=e=>{if(el.dataset.justDragged){delete el.dataset.justDragged;return;}if(e.target.classList.contains("iwc-event-check")||e.target.classList.contains("iwc-resize")||e.target.classList.contains("iwc-all-resize"))return;openInspector(el.dataset.eventId);};
      el.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openInspector(el.dataset.eventId);}};
      el.ondragstart=e=>{const ev=findEvent(el.dataset.eventId);if(!ev||!movable(ev,ev._block.date))return e.preventDefault();e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("application/x-dcc-calendar",JSON.stringify({id:ev._blockId,kind:ev.allDay?"all_day":"timed",duration:Math.max(15,minuteOf(ev.end)-minuteOf(ev.start)),days:Math.max(1,Math.round((parseDate(ev.allDayEnd||addDays(ev._block.date,1))-parseDate(ev.allDayStart||ev._block.date))/DAY_MS))}));};
      if(el.classList.contains("iwc-event"))el.onpointerdown=e=>{
        if(e.button!==0||e.target.closest("input,.iwc-resize"))return;
        const ev=findEvent(el.dataset.eventId),origin=el.closest(".iwc-day-col");
        if(!ev||!origin||!movable(ev,origin.dataset.day))return;
        const gesture={x:e.clientX,y:e.clientY,moved:false,duration:Math.max(15,minuteOf(ev.end)-minuteOf(ev.start))};
        el.setPointerCapture(e.pointerId);
        const move=pe=>{if(Math.hypot(pe.clientX-gesture.x,pe.clientY-gesture.y)>6){gesture.moved=true;el.classList.add("dragging");}};
        const up=pe=>{
          el.removeEventListener("pointermove",move);el.removeEventListener("pointerup",up);el.classList.remove("dragging");
          if(!gesture.moved)return;
          el.dataset.justDragged="1";
          const target=root.document.elementFromPoint(pe.clientX,pe.clientY);
          const all=target&&target.closest(".iwc-all-day"),col=target&&target.closest(".iwc-day-col");
          if(all){place(ev._blockId,all.dataset.day,"all_day",null,addDays(all.dataset.day,1));return;}
          if(col){const rect=col.getBoundingClientRect(),m=snap((pe.clientY-rect.top)/HOUR_PX*60);place(ev._blockId,col.dataset.day,"timed",m,Math.min(1439,m+gesture.duration));}
        };
        el.addEventListener("pointermove",move);el.addEventListener("pointerup",up);
      };
    });
    rootEl.querySelectorAll(".iwc-unscheduled-item").forEach(el=>el.ondragstart=e=>{e.dataTransfer.setData("application/x-dcc-calendar",JSON.stringify({id:el.dataset.dragId,kind:"timed",duration:30,days:1}));});
    rootEl.querySelectorAll(".iwc-event-check").forEach(check=>check.onchange=e=>{e.stopPropagation();toggleComplete(findEvent(check.closest(".iwc-event").dataset.eventId),check.checked);});
    rootEl.querySelectorAll(".iwc-day-col,.iwc-all-day").forEach(col=>{
      col.ondragover=e=>{if(editableDate(col.dataset.day)){e.preventDefault();e.dataTransfer.dropEffect="move";}};
      col.ondrop=e=>{e.preventDefault();let data;try{data=JSON.parse(e.dataTransfer.getData("application/x-dcc-calendar"));}catch(err){return;}if(col.classList.contains("iwc-all-day"))place(data.id,col.dataset.day,"all_day",null,addDays(col.dataset.day,data.days||1));else{const rect=col.getBoundingClientRect(),m=snap((e.clientY-rect.top)/HOUR_PX*60);place(data.id,col.dataset.day,"timed",m,Math.min(1439,m+(data.duration||30)));}};
    });
    rootEl.querySelectorAll(".iwc-day-col").forEach(col=>{
      let draft=null;
      col.onpointerdown=e=>{if(e.button!==0||e.target.closest(".iwc-event")||!editableDate(col.dataset.day))return;const rect=col.getBoundingClientRect(),m=snap((e.clientY-rect.top)/HOUR_PX*60);draft={start:m,end:m+30,y:e.clientY};col.setPointerCapture(e.pointerId);};
      col.onpointermove=e=>{if(!draft)return;const rect=col.getBoundingClientRect(),m=snap((e.clientY-rect.top)/HOUR_PX*60);draft.end=Math.max(draft.start+15,m);};
      col.onpointerup=e=>{if(!draft)return;const d=draft;draft=null;createDraft(col.dataset.day,d.start,Math.min(1439,d.end));};
    });
    rootEl.querySelectorAll(".iwc-resize").forEach(handle=>{
      handle.onpointerdown=e=>{e.stopPropagation();e.preventDefault();const el=handle.closest(".iwc-event"),ev=findEvent(el.dataset.eventId),col=el.closest(".iwc-day-col");if(!ev||!movable(ev,col.dataset.day))return;const start=minuteOf(ev.start),rect=col.getBoundingClientRect();handle.setPointerCapture(e.pointerId);const move=pe=>{const end=Math.max(start+15,snap((pe.clientY-rect.top)/HOUR_PX*60));el.style.height=Math.max(18,(end-start)/60*HOUR_PX)+"px";handle.dataset.end=end;};const up=async()=>{handle.removeEventListener("pointermove",move);handle.removeEventListener("pointerup",up);const end=Number(handle.dataset.end)||minuteOf(ev.end);await place(ev._blockId,col.dataset.day,"timed",start,end);};handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",up);};
    });
    rootEl.querySelectorAll(".iwc-all-resize").forEach(handle=>{
      handle.onpointerdown=e=>{
        e.stopPropagation();e.preventDefault();
        const el=handle.closest(".iwc-all-event"),ev=findEvent(el.dataset.eventId);
        if(!ev||!movable(ev,ev._block.date))return;
        handle.setPointerCapture(e.pointerId);
        const up=pe=>{
          handle.removeEventListener("pointerup",up);
          const target=root.document.elementFromPoint(pe.clientX,pe.clientY),cell=target&&target.closest(".iwc-all-day");
          if(!cell)return;
          const start=ev.allDayStart||ev._block.date,end=addDays(cell.dataset.day,1);
          if(end>start)place(ev._blockId,start,"all_day",null,end);
        };
        handle.addEventListener("pointerup",up);
      };
    });
    if(state.selectedId)openInspector(state.selectedId);
  }

  async function build(opts){
    if(!root||!root.document||!root.blockStore)return;
    const el=root.document.getElementById("calendar-view");if(!el)return;
    const currentViewDate=typeof root.viewDate==="string"?root.viewDate:null;
    if(!state.anchor){loadPrefs();state.syncedViewDate=currentViewDate;state.anchor=weekStart(currentViewDate||easternNow().date);}
    else if(currentViewDate&&currentViewDate!==state.syncedViewDate){state.syncedViewDate=currentViewDate;state.anchor=weekStart(currentViewDate);state.initialScroll=true;}
    const token=++renderToken;
    const prior=el.querySelector(".iwc-week-scroll");
    const scrollTop=opts&&opts.keepScroll&&prior?prior.scrollTop:null,scrollLeft=opts&&opts.keepScroll&&prior?prior.scrollLeft:null;
    el.innerHTML='<div class="iwc-loading">Loading week…</div>';
    const items=await readWeek();if(token!==renderToken)return;
    el.innerHTML=renderShell(items);bind(el);
    const scroller=el.querySelector(".iwc-week-scroll");
    if(scrollTop!=null){scroller.scrollTop=scrollTop;scroller.scrollLeft=scrollLeft||0;}
    else if(state.initialScroll){const now=easternNow(),inWeek=now.date>=state.anchor&&now.date<=addDays(state.anchor,6);scroller.scrollTop=Math.max(0,((inWeek?now.minute/60:8)*HOUR_PX)-140);if(root.innerWidth<=760&&inWeek)scroller.scrollLeft=Math.max(0,(parseDate(now.date).getDay()*132)-50);state.initialScroll=false;}
  }

  return {build,packOverlaps,weekStart,addDays,dateString,minuteOf,clock,snap,spansDate,rootItems,safeColor,safeExternalUrl,_resetForTests:function(){state={anchor:null,syncedViewDate:null,hidden:new Set(),colors:{},railCollapsed:false,openSource:null,selectedId:null,loaded:[],initialScroll:true};}};
});
