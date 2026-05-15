// ======== RESPONSIBILITIES TAB ========
// Responsibilities are durable obligations. They become scheduled tasks only
// when their cadence/score or a trigger makes them actionable.
(function(){
  let _items = [];
  let _filter = "active";
  let _sidebarQuery = "";
  let _sidebarFilter = "active";
  let _sidebarSort = "urgency";
  let _captureEditor = null;

  function esc(s){
    if(s==null)return "";
    return (typeof escHtml==="function"?escHtml(String(s)):String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"));
  }

  function scoreClass(score){
    if(score >= 85) return "red";
    if(score >= 70) return "yellow";
    if(score >= 35) return "blue";
    return "green";
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

  function responsibilityTiming(props){
    props=props||{};
    if(isAsNeeded(props))return {cadence:null,elapsed:0,remaining:null,progress:0,asNeeded:true};
    const cadence=Math.max(1,Number(props.cadenceDays||props.cadence_days||7));
    const anchor=props.lastCompletedAt||props.createdAt||props.created_at||props.added_at;
    const start=anchor?new Date(anchor):new Date();
    const elapsed=isNaN(start.getTime())?0:Math.max(0,(Date.now()-start.getTime())/86400000);
    const remaining=Math.ceil(cadence-elapsed);
    const progress=Math.max(0,Math.min(100,Math.round((elapsed/cadence)*100)));
    return {cadence,elapsed,remaining,progress};
  }

  function dueLabel(props){
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

  function getResponsibilities(){
    return _items.filter(i=>(i.properties||{}).kind==="responsibility_item");
  }

  function applyFilter(items){
    if(_filter==="all")return items;
    if(_filter==="due")return items.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived");
    return items.filter(i=>((i.properties||{}).status||"active")===_filter);
  }

  async function loadResponsibilities(){
    try{
      const res=await fetch("/api/responsibilities");
      if(!res.ok)throw new Error(res.statusText);
      const data=await res.json();
      _items=data.items||[];
      renderResponsibilities();
      renderRepeatResponsibilitiesSidebar();
      return _items;
    }catch(e){
      if(typeof showToast==="function")showToast("Could not load responsibilities: "+(e.message||e),"error");
      return [];
    }
  }

  function renderResponsibilities(){
    const mount=document.getElementById("responsibilities-list");
    if(!mount){renderRepeatResponsibilitiesSidebar();return;}
    const all=getResponsibilities().sort((a,b)=>Number((b.properties||{}).importanceScore||0)-Number((a.properties||{}).importanceScore||0));
    const visible=applyFilter(all);
    const badge=document.getElementById("responsibilities-count");
    if(badge){
      const due=all.filter(i=>Number((i.properties||{}).importanceScore||0)>=70 && (i.properties||{}).status!=="archived").length;
      badge.textContent=due;
      badge.style.display=due?"":"none";
    }
    if(!visible.length){
      mount.innerHTML='<div class="delegated-empty">No responsibilities match this view.</div>';
      return;
    }
    mount.innerHTML=visible.map(item=>{
      const p=item.properties||{};
      const score=Number(p.importanceScore||0);
      const subtasks=Array.isArray(p.defaultSubtasks)?p.defaultSubtasks:[];
      return '<div class="resp-card" data-id="'+esc(item.id)+'">'+
        '<div class="resp-score '+scoreClass(score)+'">'+score+'</div>'+
        '<div class="resp-body">'+
          '<div class="resp-title-row">'+
            '<div class="resp-title">'+esc(p.title||"(untitled)")+'</div>'+
            '<span class="resp-chip domain">'+esc(p.domain||"other")+'</span>'+
            '<span class="resp-chip">'+esc(p.status||"active")+'</span>'+
          '</div>'+
          '<div class="resp-meta">'+
            '<span>'+esc(p.area||"general")+'</span>'+
            '<span>'+esc(p.capacityBucket||"work_admin")+'</span>'+
            '<span>'+cadenceLabel(p)+'</span>'+
            '<span>'+esc(p.estimatedMinutes||30)+'m</span>'+
            '<span>'+esc(daysAgo(p.lastCompletedAt))+'</span>'+
          '</div>'+
          (subtasks.length?'<div class="resp-subtasks">'+esc(subtasks.slice(0,3).join(" · "))+(subtasks.length>3?" · ...":"")+'</div>':'')+
        '</div>'+
        '<div class="resp-card-actions">'+
          '<button data-act="schedule">Schedule</button>'+
          '<button data-act="complete">Complete</button>'+
          '<button data-act="edit">Edit</button>'+
          '<button class="danger" data-act="'+(p.status==="archived"?"activate":"archive")+'">'+(p.status==="archived"?"Activate":"Archive")+'</button>'+
        '</div>'+
      '</div>';
    }).join("");
    mount.querySelectorAll(".resp-card-actions button").forEach(btn=>{
      btn.addEventListener("click",()=>handleCardAction(btn.closest(".resp-card").dataset.id,btn.dataset.act));
    });
    renderRepeatResponsibilitiesSidebar();
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
    ["repeat-responsibilities-count","repeat-responsibilities-section-count"].forEach(id=>{
      const badge=document.getElementById(id);
      if(badge){badge.textContent=due;badge.style.display=due?"":"none";}
    });
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
      return '<div class="repeat-resp-card '+cls+'" data-id="'+esc(item.id)+'">'+
        '<div class="repeat-resp-score resp-score '+cls+'">'+score+'</div>'+
        '<div class="repeat-resp-main">'+
          '<div class="repeat-resp-title-row">'+
            '<div class="repeat-resp-title">'+esc(p.title||"(untitled)")+'</div>'+
            '<span class="resp-chip domain">'+esc(p.domain||"other")+'</span>'+
          '</div>'+
          '<div class="repeat-resp-meter"><span class="'+cls+'" style="width:'+timing.progress+'%"></span></div>'+
          '<div class="repeat-resp-meta">'+
            '<span>'+cadenceLabel(p)+'</span>'+
            '<span>'+esc(dueLabel(p))+'</span>'+
            '<span>'+esc(p.estimatedMinutes||30)+'m</span>'+
            '<span>'+esc(daysAgo(p.lastCompletedAt))+'</span>'+
          '</div>'+
          (subtasks.length?'<div class="repeat-resp-subtasks">'+subtasks.slice(0,4).map(s=>'<span>'+esc(s)+'</span>').join("")+(subtasks.length>4?'<span>+'+(subtasks.length-4)+'</span>':'')+'</div>':'')+
        '</div>'+
        '<div class="repeat-resp-actions">'+
          '<button type="button" data-act="schedule">Schedule</button>'+
          '<button type="button" data-act="complete">Complete</button>'+
          '<button type="button" data-act="edit">Edit</button>'+
        '</div>'+
      '</div>';
    }).join("");
    mount.querySelectorAll(".repeat-resp-actions button").forEach(btn=>{
      btn.addEventListener("click",()=>handleCardAction(btn.closest(".repeat-resp-card").dataset.id,btn.dataset.act));
    });
  }

  async function handleCardAction(id,act){
    const item=_items.find(i=>i.id===id);
    if(!item)return;
    try{
      if(act==="schedule"){
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        if(typeof showToast==="function")showToast("Responsibility scheduled","success");
        location.reload();
      }else if(act==="complete"){
        const res=await fetch("/api/responsibilities/"+encodeURIComponent(id)+"/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({completedAt:new Date().toISOString()})});
        if(!res.ok)throw new Error((await res.json()).error||res.statusText);
        await loadResponsibilities();
      }else if(act==="archive"||act==="activate"){
        await patchResponsibility(id,{status:act==="archive"?"archived":"active"});
        await loadResponsibilities();
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
    return {
      title,
      domain:"professional",
      area:taskArea(task),
      cadence:"weekly",
      cadenceDays:7,
      asNeeded:false,
      estimatedMinutes:Math.max(15,taskDurationMinutes(task)),
      capacityBucket:taskCapacityBucket(task),
      defaultSubtasks:defaultSubtasksFromTask(task),
      status:"active",
      createdFrom:"task"
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
    document.getElementById("resp-id").value=id||"";
    document.getElementById("resp-title").value=p.title||"";
    document.getElementById("resp-domain").value=p.domain||"professional";
    document.getElementById("resp-area").value=p.area||"general";
    const preset=document.getElementById("resp-cadence-preset");
    if(preset)preset.value=cadencePreset(p);
    document.getElementById("resp-cadence-days").value=p.cadenceDays||7;
    syncCadencePreset();
    document.getElementById("resp-estimated-minutes").value=p.estimatedMinutes||30;
    document.getElementById("resp-capacity-bucket").value=p.capacityBucket||"work_admin";
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

  function formProps(){
    const cadence=document.getElementById("resp-cadence-preset")?.value||"custom";
    const cadenceMap={daily:1,weekly:7,biweekly:14,monthly:30};
    const customDays=Math.max(1,parseInt(document.getElementById("resp-cadence-days").value,10)||7);
    const cadenceDays=cadence==="as_needed"?null:(cadenceMap[cadence]||customDays);
    return {
      title:document.getElementById("resp-title").value.trim(),
      domain:document.getElementById("resp-domain").value,
      area:document.getElementById("resp-area").value.trim()||"general",
      cadence,
      cadenceDays,
      asNeeded:cadence==="as_needed",
      estimatedMinutes:Math.max(15,parseInt(document.getElementById("resp-estimated-minutes").value,10)||30),
      capacityBucket:document.getElementById("resp-capacity-bucket").value,
      defaultSubtasks:readDefaultSubtasks(),
      status:"active"
    };
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

  async function captureResponsibility(){
    const el=document.getElementById("resp-capture-text");
    const editor=_captureEditor || window._respCaptureBlockEditor;
    const text=editor?editor.toMarkdown().trim():(el&&"value" in el?el.value.trim():"");
    if(!text){if(typeof showToast==="function")showToast("Paste something to capture first","error");return;}
    try{
      const res=await fetch("/api/responsibilities/capture",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
      if(!res.ok)throw new Error(await responseErrorMessage(res));
      const data=await res.json();
      if(editor)editor.setBlocks(null);
      else if(el&&"value" in el)el.value="";
      await loadResponsibilities();
      if(data.task&&data.task.properties&&data.task.properties.local_id){
        if(typeof showToast==="function")showToast(data.duplicate?"Alert already captured":"Alert captured and scheduled","success");
        location.reload();
      }else if(typeof showToast==="function")showToast("Responsibility captured","success");
    }catch(e){
      if(typeof showToast==="function")showToast("Capture failed: "+(e.message||e),"error");
    }
  }

  async function autoScheduleDue(){
    try{
      const res=await fetch("/api/responsibilities/auto-schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threshold:70,limit:3})});
      if(!res.ok)throw new Error(await responseErrorMessage(res));
      const data=await res.json();
      const count=(data.scheduled||[]).filter(x=>x.created).length;
      if(typeof showToast==="function")showToast(count?("Scheduled "+count+" due responsibilities"):"No new due responsibilities to schedule",count?"success":"info");
      if(count)location.reload();
    }catch(e){
      if(typeof showToast==="function")showToast("Auto-schedule failed: "+(e.message||e),"error");
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
    const captureMount=document.getElementById("resp-capture-text");
    if(captureMount && typeof createBlockEditor==="function"){
      if(window._respCaptureBlockEditor)window._respCaptureBlockEditor.destroy();
      _captureEditor=createBlockEditor(captureMount,null,{
        placeholder:captureMount.dataset.placeholder||"Paste a responsibility, Slack alert text, or screenshot OCR here..."
      });
      window._respCaptureBlockEditor=_captureEditor;
    }
    document.querySelectorAll(".resp-filter-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll(".resp-filter-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        _filter=btn.dataset.filter||"active";
        renderResponsibilities();
      });
    });
    const repeatSearch=document.getElementById("repeat-responsibilities-search");
    if(repeatSearch)repeatSearch.addEventListener("input",()=>{_sidebarQuery=repeatSearch.value||"";renderRepeatResponsibilitiesSidebar();});
    const repeatFilter=document.getElementById("repeat-responsibilities-filter");
    if(repeatFilter)repeatFilter.addEventListener("change",()=>{_sidebarFilter=repeatFilter.value||"active";renderRepeatResponsibilitiesSidebar();});
    const repeatSort=document.getElementById("repeat-responsibilities-sort");
    if(repeatSort)repeatSort.addEventListener("change",()=>{_sidebarSort=repeatSort.value||"urgency";renderRepeatResponsibilitiesSidebar();});
    const repeatNew=document.getElementById("repeat-responsibilities-new");
    if(repeatNew)repeatNew.addEventListener("click",()=>openResponsibilityModal(null));
    const cadencePresetEl=document.getElementById("resp-cadence-preset");
    if(cadencePresetEl)cadencePresetEl.addEventListener("change",syncCadencePreset);
    const newBtn=document.getElementById("resp-new-btn");
    if(newBtn)newBtn.addEventListener("click",()=>openResponsibilityModal(null));
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
    const capture=document.getElementById("resp-capture-btn");
    if(capture)capture.addEventListener("click",captureResponsibility);
    const auto=document.getElementById("resp-auto-schedule-btn");
    if(auto)auto.addEventListener("click",autoScheduleDue);
  }

  document.addEventListener("DOMContentLoaded",bindResponsibilities);
  window.loadResponsibilities=loadResponsibilities;
  window.renderResponsibilities=renderResponsibilities;
  window.renderRepeatResponsibilitiesSidebar=renderRepeatResponsibilitiesSidebar;
  window.markResponsibilityTaskCompleted=markResponsibilityTaskCompleted;
  window.openRepeatResponsibilityFromTask=function(task){
    const defaults=responsibilityDefaultsFromTask(task||{});
    if(!defaults.title){
      if(typeof showToast==="function")showToast("Task title is required","error");
      return;
    }
    openResponsibilityModal(null,defaults);
  };
})();
